const { startServer, connectClient } = require("./protocol");
const { createClipboardSync, electronClipboardIO } = require("./clipboard");

// Both roles expose the same tiny contract so the GUI can drive either one:
//   start() / stop() / getStatus()
// status = { running, role, peer, mode, detail }
//   peer: stopped | listening | connecting | connected | reconnecting | error
//   mode: local | remote

function makeStatus(role) {
  return { running: false, role, peer: "stopped", mode: "local", detail: "" };
}

// Clipboard sharing is optional and Electron-only; returns null when disabled
// or when there is no clipboard backend (headless CLI).
//
// `peerCaps` comes from the handshake. Images are only enabled when BOTH the
// user asked for them AND the peer said it understands them -- sending a
// multi-megabyte PNG to a build that predates the feature would waste the
// transfer and be dropped on arrival with no way to tell why.
function makeClipboard(cfg, log, send, peerCaps) {
  if (cfg.clipboard?.enabled === false) return null;
  const io = electronClipboardIO();
  if (!io) return null;
  const caps = Array.isArray(peerCaps) ? peerCaps : [];
  const wantImages = cfg.clipboard?.images !== false;
  const images = wantImages && caps.includes("img");
  // JPEG is a *fallback encoder*, not a separate feature: it only decides what a
  // too-large PNG becomes. A 0.2.8..0.2.11 peer understands images but not JPEG,
  // so it keeps getting PNG-only behaviour (oversized images are dropped with a
  // message that says why) instead of receiving a payload it cannot decode.
  const jpeg = images && caps.includes("jpg");
  if (wantImages && !images) {
    log?.debug("对端未声明图片剪贴板能力（旧版本），本次只同步文本");
  } else if (images && !jpeg) {
    log?.debug("对端未声明 JPEG 能力（0.2.11 或更早），图片只走 PNG，超限则丢弃");
  }
  const clip = createClipboardSync({
    io,
    send,
    log,
    images,
    jpeg,
    maxImageBytes: cfg.clipboard?.maxImageBytes,
  });
  if (images && !clip.imagesEnabled()) {
    log?.warn("已开启图片剪贴板，但本机剪贴板后端读不到图片（后端不支持），将只同步文本");
  }
  return clip;
}

// Environment problems that make this machine unable to do its job (Wayland
// without DISPLAY, a missing xdotool where it is needed, ...). The settings
// window shows these, but a headless run -- or a log someone sends on -- never
// sees the window, so they have to reach the log as well. This is exactly the
// class of problem that makes "the mouse doesn't move on the Ubuntu box"
// impossible to diagnose from a log alone.
function logEnvironment(log) {
  try {
    const { platformInfo } = require("./platform");
    const info = platformInfo();
    for (const w of info.warnings || []) log.warn(`环境: ${w}`);
    return info;
  } catch {
    return null;
  }
}

// Server role: owns the physical input. When the local cursor reaches the
// shared edge, capture starts and events stream to the peer. A "release" from
// the peer returns control.
function createServer({ cfg, log, onStatus, blocker, onPanic }) {
  let peerSend = null;
  let input = null;
  let clip = null;

  const status = makeStatus("server");
  const emit = (patch) => {
    Object.assign(status, patch);
    onStatus?.({ ...status });
  };

  const serverHandle = startServer(
    {
      port: cfg.listenPort,
      password: cfg.peer.password,
      log,
      onError: (e) => emit({ peer: "error", detail: e.message }),
    },
    {
      onPeer(send, peer) {
        peerSend = send;
        emit({ peer: "connected", detail: "" });
        log.info("remote client connected");
        clip = makeClipboard(cfg, log, send, peer.caps);
        clip?.start();
        peer.onMessage((msg) => {
          if (msg.t === "release") input?.release();
          else clip?.onMessage(msg);
        });
      },
      onClose() {
        peerSend = null;
        input?.release();
        clip?.stop();
        clip = null;
        emit({ peer: "listening", detail: "" });
      },
    }
  );

  const { startServerInput } = require("./server-input");
  input = startServerInput({
    cfg,
    log,
    send: (msg) => peerSend?.(msg),
    // Only engage capture when somebody is actually listening on the other end,
    // otherwise the node would latch into "remote" with nowhere to send.
    hasPeer: () => !!peerSend,
    onStateChange: (captured) => emit({ mode: captured ? "remote" : "local" }),
    blocker,
    onPanic,
  });

  return {
    start() {
      logEnvironment(log);
      input.start();
      emit({ running: true, peer: "listening", mode: "local", detail: "" });
      log.info(`server ready, edge=${cfg.layout.edge}, port=${cfg.listenPort}`);
    },
    stop() {
      input.stop();
      serverHandle?.close();
      clip?.stop();
      clip = null;
      peerSend = null;
      emit({ running: false, peer: "stopped", mode: "local", detail: "" });
    },
    getStatus: () => ({ ...status }),
    // Panic / manual escape: drop remote control immediately.
    release: () => input?.release(),
    getGeometry: () => input?.getGeometry?.(),
    // Live edge switch (tray menu). Keeps cfg in sync so the settings window
    // shows the new value without a reload.
    setEdge: (e) => {
      const ok = input?.setEdge?.(e);
      if (ok) cfg.layout.edge = e;
      return !!ok;
    },
    getEdge: () => input?.getEdge?.() ?? cfg.layout.edge,
  };
}

// Client role: receives events and injects them. When the injected cursor
// reaches the far edge (the one facing the server), send "release" so the
// server can resume local control.
function createClient({ cfg, log, onStatus }) {
  let send = null;
  let watching = false;
  let conn = null;
  let inject = null;
  let clip = null;

  const status = makeStatus("client");
  const emit = (patch) => {
    Object.assign(status, patch);
    onStatus?.({ ...status });
  };

  // Which local edge faces the server and therefore returns control. The
  // server tells us its shared edge in the `enter` message (so the two configs
  // no longer have to be kept in sync by hand); the local config is only the
  // fallback for a peer that predates that field.
  let homeEdge = oppositeOf(cfg.layout.edge);

  // Injection failures counted at the moment control arrived, so a session can
  // report its own failures rather than a process-lifetime total.
  let errorsAtEnter = 0;

  async function watchCursor() {
    const { screen } = require("@nut-tree-fork/nut-js");
    // Judge "return home" from the position WE inject to, not from the live
    // cursor: this machine's own physical mouse keeps moving the real cursor,
    // so reading it back is unreliable and caused control to bounce home
    // immediately. getTrackedPosition is the authoritative injected position.
    let armed = false;
    const EDGE = 2; // px band that counts as touching the home edge
    const LEAVE = 8; // px the cursor must move inward before arming

    while (watching && send) {
      try {
        const pos = inject.getTrackedPosition();
        if (pos.x === null || pos.x === undefined) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        let box = inject.getLocalBox();
        if (!box || !box.width) {
          const [w, h] = await Promise.all([screen.width(), screen.height()]);
          box = { x: 0, y: 0, width: w, height: h };
        }

        const dist =
          homeEdge === "left"
            ? pos.x - box.x
            : homeEdge === "right"
            ? box.x + box.width - 1 - pos.x
            : homeEdge === "top"
            ? pos.y - box.y
            : box.y + box.height - 1 - pos.y;

        if (!armed && dist > LEAVE) armed = true;

        if (armed && dist <= EDGE) {
          watching = false;
          // Let go of anything still held BEFORE handing control back: if the
          // user drags across the boundary and releases on the server, the
          // button-up never reaches us and this machine would keep the button
          // pressed forever (a stuck drag / selection).
          await inject.releaseAll?.();
          // The tracked position is pure arithmetic -- it reaches the home edge
          // whether or not a single injection ever made it to the OS. So a
          // cheerful "returning control to server" says nothing about whether
          // the session actually worked. Check what the injector really did.
          const health = inject.getInjectionHealth?.() || { errors: 0 };
          const failed = health.errors - errorsAtEnter;
          if (failed > 0) {
            log.warn(
              `本次远程控制期间有 ${failed} 次注入失败（最近：${health.lastError}）——` +
                "对端光标很可能根本没动过。"
            );
            log.warn(
              "  请在本机运行「本机注入自检」定位：NetMouse --injecttest" +
                "（或 npm run injecttest）"
            );
            emit({ mode: "local", detail: `注入失败 ${failed} 次` });
          } else {
            log.info("returning control to server");
            emit({ mode: "local", detail: "" });
          }
          send({ t: "release" });
          return;
        }
      } catch (e) {
        log.debug("cursor watch error:", e.message);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  return {
    start() {
      logEnvironment(log);
      const { createInjector } = require("./client-input");
      inject = createInjector({ cfg, log });
      emit({ running: true, peer: "connecting", mode: "local", detail: "" });

      conn = connectClient(
        { host: cfg.peer.host, port: cfg.peer.port, password: cfg.peer.password, log },
        {
          onConnected(s, peer) {
            send = s;
            clip = makeClipboard(cfg, log, s, peer?.caps);
            clip?.start();
            emit({ peer: "connected", detail: "" });
            log.info("client ready, waiting for control");
          },
          onMessage(msg) {
            if (clip?.onMessage(msg)) return; // clipboard traffic handled here
            if (msg.t === "enter") {
              // Adopt the server's shared edge: the home edge is its opposite.
              if (msg.edge) homeEdge = oppositeOf(msg.edge);
              // Baseline for this session's injection-failure count.
              errorsAtEnter = inject?.getInjectionHealth?.().errors ?? 0;
              if (!watching) {
                watching = true;
                emit({ mode: "remote" });
                watchCursor();
              }
            } else if (msg.t === "edge") {
              // The server switched its shared edge mid-session. Update where
              // "home" is without re-seeding the remote cursor (a second
              // "enter" would teleport it back to the centre).
              if (msg.edge) homeEdge = oppositeOf(msg.edge);
            }
            inject.handle(msg);
          },
          onClose() {
            send = null;
            watching = false;
            clip?.stop();
            clip = null;
            // Losing the link mid-drag must not leave a button held down here.
            inject?.releaseAll?.().catch(() => {});
            emit({ peer: "reconnecting", mode: "local" });
            log.warn("lost server, reconnecting…");
          },
        }
      );
    },
    stop() {
      watching = false;
      conn?.close();
      conn = null;
      send = null;
      clip?.stop();
      clip = null;
      emit({ running: false, peer: "stopped", mode: "local", detail: "" });
    },
    getStatus: () => ({ ...status }),
  };
}

function oppositeOf(edge) {
  return { left: "right", right: "left", top: "bottom", bottom: "top" }[edge] || "left";
}

module.exports = { createServer, createClient };

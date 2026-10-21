"use strict";
// ---------------------------------------------------------------------------
// Hardware loopback self-test.
//
// Answers, on THIS machine and with the REAL global mouse hook, the REAL
// physical cursor and a REAL TCP socket:
//
//   1. what geometry the program detects, and which screen owns each edge;
//   2. whether the physical cursor can actually REACH the configured edge;
//   3. whether edge detection fires exactly there;
//   4. whether a peer receives "enter" over the wire;
//   5. whether "release" hands control back.
//
// It needs no second machine: it listens on 127.0.0.1 and connects to itself.
// That is the point. When "the mouse doesn't cross" is reported, there are two
// very different possibilities -- the server side of this box is broken, or the
// other machine / the network is. A two-machine symptom cannot tell them apart;
// this can.
//
// The physical cursor is moved by the test and restored before it returns.
//
// Run:  electron src/hwtest.js            (all four edges)
//       electron src/hwtest.js --edge left
//       electron src/hwtest.js --out report.txt
//
// Electron is REQUIRED for correct numbers: in plain Node there is no
// `screen` module, the fallback is a PowerShell call that is not DPI aware, and
// under per-monitor scaling it would report the wrong geometry -- which is
// exactly the thing under test. The run aborts rather than mislead.
// ---------------------------------------------------------------------------
const net = require("net");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config");
const { startServer, hashPwd } = require("./protocol");
const platform = require("./platform");
const { startServerInput, stopHook } = require("./server-input");
// The client's button/wheel mapping. Imported so the self-test can check the
// REAL captured values against the REAL mapping on the user's own machine —
// the mapping is where a falsy Button.LEFT silently ate every left click.
const { buttonFor, wheelAction } = require("./client-input");

const DIRS = ["left", "right", "top", "bottom"];
const LABEL = { left: "左", right: "右", top: "上", bottom: "下" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to wait for a capture after the cursor is already sitting on the
// edge. The hook delivers asynchronously; 2s is generous.
const CAPTURE_WAIT_MS = 2000;

// ---------------------------------------------------------------------------
// tiny logger: collects lines so the report can quote the real capture logs
// ---------------------------------------------------------------------------
function makeLog() {
  const lines = [];
  const fmt = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.message;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const add = (lvl) => (...args) => lines.push({ lvl, text: args.map(fmt).join(" ") });
  return { lines, info: add("info"), warn: add("warn"), error: add("error"), debug: () => {} };
}

// ---------------------------------------------------------------------------
// A raw protocol peer. Deliberately not the full client role: this test is
// about the SERVER's behaviour, and a full client would fight it for the
// cursor. All it needs to do is authenticate and record what it is sent.
// ---------------------------------------------------------------------------
function connectPeer(port, password, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const received = [];
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error("对端握手超时"));
      }
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(JSON.stringify({ t: "hello", pwd: hashPwd(password) }) + "\n");
    });
    sock.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === "ok") {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({
              sock,
              received,
              send: (o) => {
                if (!sock.destroyed) sock.write(JSON.stringify(o) + "\n");
              },
              close: () => {
                try {
                  sock.destroy();
                } catch {
                  /* ignore */
                }
              },
            });
          }
        } else {
          received.push(m);
        }
      }
    });
  });
}

// The point to aim at: on the edge, at the middle of the perpendicular span.
function edgePoint(box, dir) {
  const cx = box.x + Math.floor(box.width / 2);
  const cy = box.y + Math.floor(box.height / 2);
  switch (dir) {
    case "left":
      return { x: box.x, y: cy };
    case "right":
      return { x: box.x + box.width - 1, y: cy };
    case "top":
      return { x: cx, y: box.y };
    default:
      return { x: cx, y: box.y + box.height - 1 };
  }
}

// How far the cursor still is from `dir`, given where it ended up.
function remaining(box, dir, p) {
  switch (dir) {
    case "left":
      return p.x - box.x;
    case "right":
      return box.x + box.width - 1 - p.x;
    case "top":
      return p.y - box.y;
    default:
      return box.y + box.height - 1 - p.y;
  }
}

// ---------------------------------------------------------------------------
// Drive the REAL cursor to the edge in small steps, so the hook sees a genuine
// approach rather than a single teleport, and stop the moment capture fires.
// ---------------------------------------------------------------------------
async function driveToEdge({ mouse, Point, from, target, input }) {
  const STEPS = 14;
  const STEP_MS = 30;
  let last = { ...from };
  for (let i = 1; i <= STEPS; i += 1) {
    const t = i / STEPS;
    const x = Math.round(from.x + (target.x - from.x) * t);
    const y = Math.round(from.y + (target.y - from.y) * t);
    try {
      await mouse.setPosition(new Point(x, y));
    } catch (e) {
      return { ok: false, at: last, error: e.message };
    }
    last = { x, y };
    await sleep(STEP_MS);
    if (input.isCaptured()) return { ok: true, at: { x, y }, captured: true };
  }
  // Sit exactly on the edge and give the hook a moment to deliver it.
  try {
    await mouse.setPosition(new Point(target.x, target.y));
  } catch (e) {
    return { ok: false, at: last, error: e.message };
  }
  const t0 = Date.now();
  while (Date.now() - t0 < CAPTURE_WAIT_MS) {
    if (input.isCaptured()) return { ok: true, at: { ...target }, captured: true };
    await sleep(40);
  }
  return { ok: true, at: { ...target }, captured: false };
}

// ---------------------------------------------------------------------------
// Buttons and wheel: the part of the chain that movement does not exercise.
//
// A low-level hook cannot tell a physical click from an injected one, so
// pressing buttons with nut-js makes the REAL hook report exactly what a real
// mouse would. That gives us the ground truth for this machine, and we then
// check the client's mapping against it. Both halves are covered: the values
// printed here are what this machine puts on the wire, and the mapping is the
// code that consumes them on the far side.
//
// This exists because "the pointer moves but clicking does nothing" is
// invisible to every test that stubs the native layer.
// ---------------------------------------------------------------------------
async function buttonWheelContract({ mouse, Button, uIOhook, unit, say }) {
  const seen = [];
  const onDown = (e) => seen.push({ k: "down", b: e.button });
  const onUp = (e) => seen.push({ k: "up", b: e.button });
  const onWheel = (e) => seen.push({ k: "wheel", r: e.rotation, d: e.direction });

  uIOhook.on("mousedown", onDown);
  uIOhook.on("mouseup", onUp);
  uIOhook.on("wheel", onWheel);

  const cases = [];
  const settle = () => sleep(140);

  try {
    // --- buttons ----------------------------------------------------------
    // uiohook numbers: 1 left, 2 right, 3 middle. nut-js's enum is different:
    // LEFT = 0 (falsy!), MIDDLE = 1, RIGHT = 2.
    const btnCases = [
      { code: 1, label: "左键", btn: Button.LEFT, name: "LEFT" },
      { code: 2, label: "右键", btn: Button.RIGHT, name: "RIGHT" },
      { code: 3, label: "中键", btn: Button.MIDDLE, name: "MIDDLE" },
    ];
    for (const c of btnCases) {
      seen.length = 0;
      let err = null;
      try {
        await mouse.pressButton(c.btn);
        await sleep(60);
        await mouse.releaseButton(c.btn);
        await settle();
      } catch (e) {
        err = e.message;
      }
      const down = seen.find((s) => s.k === "down");
      const up = seen.find((s) => s.k === "up");
      const mapped = buttonFor(c.code);
      // `mapped !== null` matters: Button.LEFT is 0, so a truthiness check here
      // would call a working left button broken.
      const ok =
        !err &&
        !!down &&
        down.b === c.code &&
        !!up &&
        mapped !== null &&
        mapped === c.btn;
      cases.push({ kind: "button", label: c.label, code: c.code, mapped, ok, err });
      say(
        `  ${c.label}   真实钩子报 button=${down ? down.b : "—"}` +
          `   映射 → pressButton(${mapped === null ? "无" : mapped} = ${c.name})  ${
            ok ? "✓" : "✗"
          }`
      );
      if (err) say(`         ✗ 注入失败：${err}`);
      else if (down && down.b !== c.code) {
        say(`         ! 钩子报的按键号是 ${down.b}，与预期 ${c.code} 不一致`);
      }
      if (!down) say("         ! 钩子没看到这次按下（本机注入可能被安全软件拦截）");
    }

    // --- wheel ------------------------------------------------------------
    // nut-js's `amount` is not portable: it is the raw wheel delta on Windows
    // (120 = one notch) and a notch count on X11/macOS. `unit` is this
    // platform's value, so `mouse.scrollUp(unit)` is exactly one notch.
    const wheelCases = [
      { label: "滚轮上", expect: -1, op: "scrollUp", inject: () => mouse.scrollUp(unit) },
      { label: "滚轮下", expect: 1, op: "scrollDown", inject: () => mouse.scrollDown(unit) },
    ];
    for (const c of wheelCases) {
      seen.length = 0;
      let err = null;
      try {
        await c.inject();
        await sleep(160);
      } catch (e) {
        err = e.message;
      }
      const w = seen.find((s) => s.k === "wheel");
      const action = w ? wheelAction(w.r, w.d, unit) : null;
      const ok = !err && !!w && w.r === c.expect && !!action && action.op === c.op;
      cases.push({ kind: "wheel", label: c.label, raw: w ? w.r : null, op: action?.op || null, ok, err });
      say(
        `  ${c.label} 真实钩子报 rotation=${w ? w.r : "—"}` +
          `（方向 ${w ? w.d : "—"}）   映射 → ${action ? `${action.op}(${action.amount})` : "无"}  ${
            ok ? "✓" : "✗"
          }`
      );
      if (err) say(`         ✗ 注入失败：${err}`);
      else if (!w) say("         ! 钩子没看到这次滚轮事件");
      else if (w.r !== c.expect) {
        say(`         ! 钩子报的 rotation 是 ${w.r}，与预期 ${c.expect} 不一致`);
      }
    }

    // --- sub-notch deltas -------------------------------------------------
    // Precision touchpads and free-spinning wheels emit deltas smaller than one
    // notch; libuiohook reports rotation 0 for them. Treating those as "scroll
    // up" made the wheel twitch on every tiny increment. Only meaningful where
    // the unit is 120 (i.e. Windows), because elsewhere 1 IS a whole notch.
    if (unit > 1) {
      seen.length = 0;
      try {
        await mouse.scrollUp(1); // deliberately less than one notch
        await sleep(160);
      } catch {
        /* ignore */
      }
      const w = seen.find((s) => s.k === "wheel");
      const action = w ? wheelAction(w.r, w.d, unit) : null;
      const ok = !!w && w.r === 0 && action === null;
      cases.push({ kind: "wheel", label: "不足一格", raw: w ? w.r : null, op: action?.op || null, ok });
      say(
        `  不足一格 rotation=${w ? w.r : "—"}   映射 → ${
          action ? `${action.op}(${action.amount})` : "忽略"
        }  ${ok ? "✓" : "✗"}`
      );
      if (w && w.r !== 0) {
        say(`         ! 期望 rotation=0，实际 ${w.r}`);
      } else if (!action) {
        say("         （正确：不足一格的增量不产生任何滚动）");
      }
    }
  } finally {
    uIOhook.off("mousedown", onDown);
    uIOhook.off("mouseup", onUp);
    uIOhook.off("wheel", onWheel);
  }

  return cases;
}

// ---------------------------------------------------------------------------
// `opts` lets the GUI drive this in-process (see main.js runHwTest):
//   argv            CLI-style args when no opts are given
//   outPath         where to write the report
//   onlyEdge        test a single edge
//   edges           explicit list of edges to test
//   stopHookAfter   false when the caller owns the hook (GUI keeps it running)
//   onLine          called with each report line so the GUI log shows progress
// ---------------------------------------------------------------------------
async function runTest(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const argOf = (name, dflt = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const outPath = opts.outPath || argOf("--out", null);
  const onlyEdge = opts.onlyEdge || argOf("--edge", null);
  const stopHookAfter = opts.stopHookAfter !== false;

  const out = [];
  const say = (s = "") => {
    out.push(s);
    console.log(s);
    try {
      opts.onLine?.(s);
    } catch {
      /* a broken sink must not break the test */
    }
  };

  say("NetMouse 本机边缘自检");
  say(`生成时间 : ${new Date().toLocaleString()}`);
  say(`平台     : ${process.platform} ${process.arch}`);
  say(`运行环境 : Electron ${process.versions.electron || "（无）"} / Node ${process.versions.node}`);
  say("");

  if (!process.versions.electron) {
    say("✗ 必须以 Electron 运行：electron src/hwtest.js");
    say("  纯 Node 下没有 screen 模块，会退化成非 DPI 感知的 PowerShell 读数，");
    say("  在缩放屏上得到的几何本身就是错的 —— 那正是本测试要检验的东西。");
    return 2;
  }
  // `screen` only exists after the app is ready; the caller waits for that.
  if (!platform.diagSnapshot().virtual) {
    say("✗ Electron 已就绪但读不到任何显示器，自检中止。");
    return 2;
  }

  const cfg = loadConfig();
  const log = makeLog();

  // --- geometry ------------------------------------------------------------
  const snap = platform.diagSnapshot();
  const virtual = snap.virtual;
  if (!virtual) {
    say("✗ 无法读取系统几何，自检中止。");
    return 2;
  }
  say("几何");
  say(`  虚拟桌面 ${virtual.width}x${virtual.height} @ (${virtual.x},${virtual.y})`);
  if (snap.monitors && snap.monitors.length) {
    say("  显示器");
    for (const line of String(snap.description).split("\n")) say(`  ${line.trim()}`);
  } else {
    say("  显示器  (系统未报告逐屏信息)");
  }

  const selected = cfg.layout.monitor;
  const restricted = selected !== undefined && selected !== null && selected !== "" && selected !== "all";
  let box = { x: virtual.x, y: virtual.y, width: virtual.width, height: virtual.height };
  let boxNote = "整个虚拟桌面";
  if (restricted) {
    const picked = platform.resolveMonitor(selected, snap.monitors);
    if (picked) {
      const m = picked.monitor;
      box = { x: m.x, y: m.y, width: m.width, height: m.height };
      boxNote = `layout.monitor=${selected} → 显示器 #${picked.index}`;
    } else {
      boxNote = `layout.monitor=${selected} 未匹配，回退到整个虚拟桌面`;
    }
  }
  say(`  触发矩形 ${box.width}x${box.height} @ (${box.x},${box.y})  （${boxNote}）`);
  say("");

  // Which physical screen owns each edge -- the thing that makes "I moved the
  // mouse left and nothing happened" so confusing on a multi-monitor desk.
  say("各边归属");
  for (const d of DIRS) {
    const owners = platform.edgeOwner(d, snap.monitors);
    const idx = owners.map((m) => snap.monitors.indexOf(m)).join(",") || "-";
    const primary = owners.some((m) => m.primary);
    say(
      `  ${d.padEnd(7)} 显示器 #${idx}${owners.length ? (primary ? "（主屏）" : "（非主屏）") : ""}` +
        `   触发位置 ${d === "left" || d === "right" ? "x=" : "y="}${
          d === "left" ? box.x : d === "right" ? box.x + box.width - 1 : d === "top" ? box.y : box.y + box.height - 1
        }`
    );
  }
  say("");

  // --- start the real server + a loopback peer -----------------------------
  const password = cfg.peer.password || "change-me-strong-password";
  // Declared before startServer so the onPeer closure can reach it: the peer
  // connects asynchronously, well after startServerInput has assigned it.
  let input = null;
  // The server-side writer. This MUST come from `onPeer(send, ...)` -- it is
  // bound to the server's own socket. Writing on the peer's socket instead
  // sends data the wrong way down the connection, which is a mistake this
  // harness made and then reported as "the product failed to send enter".
  let serverSend = null;
  const serverHandle = startServer(
    { port: 0, password, log, onError: () => {} },
    {
      // This wiring is what app.js does for real: without registering a message
      // handler here, `release` from the peer is silently dropped and the node
      // stays captured forever.
      onPeer(send, peer) {
        serverSend = send;
        peer.onMessage((msg) => {
          if (msg.t === "release") input?.release();
        });
      },
      onClose() {
        serverSend = null;
      },
    }
  );
  await new Promise((resolve, reject) => {
    if (serverHandle.server.listening) return resolve();
    serverHandle.server.once("listening", resolve);
    serverHandle.server.once("error", reject);
    setTimeout(() => reject(new Error("监听超时")), 4000);
  });
  const port = serverHandle.server.address().port;

  let peer;
  try {
    peer = await connectPeer(port, password);
  } catch (e) {
    say(`✗ 回环对端连接失败：${e.message}`);
    serverHandle.close();
    return 2;
  }

  const cleanup = async () => {
    try {
      input?.stop();
    } catch {
      /* ignore */
    }
    try {
      peer?.close();
    } catch {
      /* ignore */
    }
    try {
      serverHandle.close();
    } catch {
      /* ignore */
    }
    // Only the standalone CLI owns the hook. Inside the GUI the node is merely
    // paused, and stopping the process-wide hook here would leave the restarted
    // node without capture (uiohook-napi does not restart cleanly).
    if (stopHookAfter) {
      try {
        stopHook();
      } catch {
        /* ignore */
      }
    }
  };

  const { mouse, Point, Button } = require("@nut-tree-fork/nut-js");

  // Remember where the user's cursor was so we can put it back.
  let original = null;
  try {
    const p = await mouse.getPosition();
    original = { x: p.x, y: p.y };
  } catch {
    /* best effort */
  }

  const restore = async () => {
    if (!original) return;
    try {
      await mouse.setPosition(new Point(original.x, original.y));
    } catch {
      /* best effort */
    }
  };

  const targets =
    Array.isArray(opts.edges) && opts.edges.length
      ? opts.edges.filter((d) => DIRS.includes(d))
      : onlyEdge && DIRS.includes(onlyEdge)
      ? [onlyEdge]
      : DIRS;
  const results = [];
  let contract = [];

  try {
    input = startServerInput({
      cfg,
      log,
      send: (msg) => {
        if (process.env.NETMOUSE_HWTEST_DEBUG) {
          console.log(`>>> send ${JSON.stringify(msg)} haveServerSend=${typeof serverSend}`);
        }
        serverSend?.(msg);
      },
      hasPeer: () => true,
      onStateChange: () => {},
    });
    input.start();
    // The hook needs a moment to be live before we start moving.
    await sleep(400);

    say("自检（真实全局钩子 + 真实光标 + 真实 TCP 回环）");

    for (let i = 0; i < targets.length; i += 1) {
      const dir = targets[i];
      const tag = `  [${i + 1}/${targets.length}] ${dir} (${LABEL[dir]})`;
      const target = edgePoint(box, dir);

      // Start from the centre so every edge is approached from a neutral place
      // and the "must move inward before re-arming" rule is satisfied.
      const centre = { x: box.x + Math.floor(box.width / 2), y: box.y + Math.floor(box.height / 2) };
      let start;
      try {
        await mouse.setPosition(new Point(centre.x, centre.y));
        await sleep(120);
        start = centre;
      } catch (e) {
        say(`${tag}`);
        say(`         ✗ 无法程序化移动光标：${e.message}`);
        say("           （注入权限不足；这一步失败意味着本机也驱动不了对端）");
        results.push({ dir, moved: false, captured: false, error: e.message });
        continue;
      }

      // Tell the server which edge to watch. Without this it keeps watching
      // whatever `layout.edge` says, so driving to any other edge does nothing
      // -- which is exactly the "I push left and nothing happens" symptom,
      // reproduced here on purpose.
      input.setEdge(dir);
      await sleep(60);

      const before = peer.received.length;
      const drove = await driveToEdge({ mouse, Point, from: start, target, input });

      if (!drove.ok) {
        say(`${tag}`);
        say(`         ✗ 移动光标失败：${drove.error}`);
        results.push({ dir, moved: false, captured: false, error: drove.error });
        continue;
      }

      const captured = input.isCaptured();
      const gap = remaining(box, dir, drove.at);

      // `enter` is sent in the same tick as the capture, but it still has to
      // cross a real socket: give it a moment before declaring it lost.
      let enterMsg = null;
      if (captured) {
        const t1 = Date.now();
        while (!enterMsg && Date.now() - t1 < 800) {
          enterMsg = peer.received.slice(before).find((m) => m.t === "enter");
          if (!enterMsg) await sleep(30);
        }
      }

      say(`${tag}`);
      say(`         目标点 (${target.x},${target.y})   光标停在 (${drove.at.x},${drove.at.y})`);
      if (captured) {
        say(`         捕获 ✓  触发位置距该边 ${gap}px`);
        say(
          enterMsg
            ? `         对端收到 enter ✓  vw=${enterMsg.vw} vh=${enterMsg.vh} edge=${enterMsg.edge}`
            : "         对端收到 enter ✗  （捕获了但没发出去 —— 协议/发送环节有问题）"
        );
      } else {
        say(`         捕获 ✗  光标离该边还有 ${gap}px`);
        say(
          gap > 1
            ? "           光标没能贴到这条边（可能被系统限制挡住，或该边不属于任何显示器）"
            : "           光标已贴到该边却没触发 —— 边缘判定本身有问题"
        );
      }

      // Hand control back the way the peer would, and confirm it takes effect.
      let released = null;
      let forced = false;
      if (captured) {
        peer.send({ t: "release" });
        const t0 = Date.now();
        while (input.isCaptured() && Date.now() - t0 < 1500) await sleep(30);
        released = !input.isCaptured();
        if (!released) {
          // Never let a stuck capture poison the remaining sub-tests: note it,
          // force the local path, and carry on.
          input.release();
          await sleep(150);
          forced = !input.isCaptured();
        }
        say(
          `         release 后回到本地 ${
            released ? "✓" : forced ? "✗（对端 release 无效，本地强制才解除）" : "✗"
          }`
        );
      }
      results.push({ dir, moved: true, captured, enter: !!enterMsg, released, forced, gap });
      await sleep(150);
    }

    // --- buttons + wheel ---------------------------------------------------
    // Movement working tells us nothing about clicking: they are separate
    // events on separate code paths. "The pointer moves but the buttons do
    // nothing" is a real failure mode this section exists to catch.
    say("");
    say("按键与滚轮（真实钩子读数 → 客户端映射）");
    try {
      input.release(); // not captured: read the hook directly, nothing forwarded
    } catch {
      /* ignore */
    }
    await sleep(150);
    const { uIOhook } = require("uiohook-napi");
    contract = await buttonWheelContract({
      mouse,
      Button,
      uIOhook,
      unit: platform.scrollUnit(),
      say,
    });
  } finally {
    await restore();
    await cleanup();
  }

  // --- verdict -------------------------------------------------------------
  say("");
  say("结论");
  const ok = results.filter((r) => r.captured && r.enter && r.released !== false);
  const noMove = results.filter((r) => !r.moved);
  const noCapture = results.filter((r) => r.moved && !r.captured);
  const noSend = results.filter((r) => r.captured && !r.enter);
  const stuck = results.filter((r) => r.forced);

  say(`  配置的共享边 layout.edge = ${cfg.layout.edge}（自检过程中每条边都临时切过去试了）`);
  const sweptAll = targets.length === DIRS.length;
  if (
    sweptAll &&
    cfg.layout.edge !== "any" &&
    ok.length === results.length &&
    !ok.some((r) => r.dir === cfg.layout.edge)
  ) {
    // Cannot normally happen (the configured edge is among the four), but if it
    // ever did it would mean the edge was not actually being applied.
    say("  ! 配置的那条边反而没测到，请检查 setEdge 是否生效。");
  }

  if (noMove.length === results.length) {
    say("  ✗ 无法程序化移动光标 —— 本机连自己的光标都驱动不了，");
    say("    对端那台更不可能被驱动。请检查注入权限（Windows 上是否被安全软件拦截）。");
  } else if (ok.length === results.length) {
    say(`  ✓ 测试的 ${results.length} 条边全部可触发，且 enter / release 都正常。`);
    say("    本机 server 侧（几何换算、边缘判定、协议发送）完全正常。");
    say("    若对端仍然不动，问题在 client 机器或两端之间的网络，不在这一侧。");
    if (cfg.layout.edge === "right") {
      say("");
      say(`    提示：当前 layout.edge 是 right。若对端（Ubuntu）在左侧，`);
      say("    必须把它改成 left，或改成 any —— 否则往左推永远不会有反应。");
    }
  } else if (ok.length > 0) {
    say(`  ! ${ok.length}/${results.length} 条边可触发：${ok.map((r) => r.dir).join(", ")}`);
    if (noCapture.length) {
      say(`    不可触发的边：${noCapture.map((r) => `${r.dir}(差 ${r.gap}px)`).join(", ")}`);
      say("    把共享边设成上面能触发的那条（托盘菜单可直接切换），或设成 any。");
    }
  } else {
    say("  ✗ 没有一条边能触发。");
    say("    既然四条边都不行，就不是「配错了方向」——是几何或钩子本身的问题。");
    say("    请把本报告完整发出来。");
  }

  if (contract.length) {
    const bad = contract.filter((c) => !c.ok);
    say("");
    if (!bad.length) {
      say(`  ✓ 按键与滚轮：${contract.length} 项全部通过。`);
      say("    本机的左/中/右键和滚轮，都以客户端能正确识别的形式发出去了；");
      say("    对端若仍然点不动或滚不动，问题在 client 的注入权限，不在这一侧。");
    } else {
      say(`  ✗ 按键与滚轮：${bad.length}/${contract.length} 项异常 —— ${bad.map((c) => c.label).join("、")}`);
      for (const c of bad) {
        if (c.err) say(`    ${c.label}：注入失败（${c.err}）`);
      }
      say("    若注入失败，通常是本机注入权限被安全软件拦截；请把本报告发出来。");
    }
  }

  if (noSend.length) {
    say("");
    say(`  ! 有 ${noSend.length} 条边捕获了但对端没收到 enter：`);
    say(`    ${noSend.map((r) => r.dir).join(", ")} —— 发送链路有问题，请回报。`);
  }
  if (stuck.length) {
    say("");
    say(`  ! 有 ${stuck.length} 条边对端 release 无效：${stuck.map((r) => r.dir).join(", ")}`);
    say("    控制权交不回来，请回报。");
  }

  if (input) {
    const kinds = [...new Set(peer.received.map((m) => m.t))];
    say("");
    say(`对端共收到 ${peer.received.length} 条消息${kinds.length ? `：${kinds.join(", ")}` : "（无）"}`);

    const interesting = log.lines.filter((l) => /captured|released|共享边|显示器/.test(l.text));
    if (interesting.length) {
      say("");
      say("相关日志");
      for (const l of interesting.slice(-12)) say(`  ${l.text}`);
    }
  }

  if (outPath) {
    fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
    console.log(`\n报告已写入 ${outPath}`);
  }

  return 0;
}

// --- standalone entry ------------------------------------------------------
// `require.main === module` is NOT enough in Electron's main process (it points
// at Electron's own bootstrap), so compare the resolved argv path too -- the
// same trap documented in diag.js.
function isEntryScript() {
  if (require.main === module) return true;
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return path.resolve(arg) === __filename;
  } catch {
    return false;
  }
}

function bail(msg) {
  console.error(msg);
  try {
    stopHook();
  } catch {
    /* ignore */
  }
  process.exit(3);
}

if (isEntryScript()) {
  if (!process.versions.electron) {
    bail(
      "自检必须以 Electron 运行（纯 Node 拿不到正确的屏幕几何）：\n" +
        "  electron src/hwtest.js\n" +
        "或先清除环境变量 ELECTRON_RUN_AS_NODE 再运行。"
    );
  } else {
    const { app } = require("electron");
    if (!app || typeof app.whenReady !== "function") {
      bail(
        "自检需要真正的 Electron 运行时，但当前进程是纯 Node 模式。\n" +
          "请先清除环境变量 ELECTRON_RUN_AS_NODE 再运行：\n" +
          "  unset ELECTRON_RUN_AS_NODE && electron src/hwtest.js"
      );
    }
    try {
      app.disableHardwareAcceleration();
    } catch {
      /* not fatal */
    }
    // The screen module is only populated once the app is ready.
    app.whenReady().then(async () => {
      let code = 0;
      try {
        code = await runTest();
      } catch (e) {
        console.error("自检异常：", e && e.stack ? e.stack : e);
        code = 3;
      }
      try {
        stopHook();
      } catch {
        /* ignore */
      }
      app.exit(code || 0);
    });
  }
}

// Exported so the GUI can run it in-process and the pure helpers can be
// unit-tested without a real cursor.
module.exports = { runTest, edgePoint, remaining, connectPeer, makeLog, buttonWheelContract, DIRS };

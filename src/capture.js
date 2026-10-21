// ---------------------------------------------------------------------------
// Capture backend selection.
//
// There are two ways to see the user's mouse and keyboard on Linux, and which
// one works depends on the session type:
//
//   * **uiohook** (uiohook-napi) -- an X11 client. Works everywhere X11 works.
//     Under Wayland it talks to Xwayland, which only receives events while an
//     X11 window has focus. On GNOME 50 -- which no longer ships an Xorg
//     session at all -- that means capture silently stops the moment the user
//     clicks a native Wayland window, and the mouse never crosses over.
//   * **evdev** (capture-evdev.js) -- reads /dev/input/event* directly. Immune
//     to the display protocol. Costs read access to the device nodes, and has
//     to model the cursor position because the kernel only reports deltas.
//
// This module picks one, starts it, and -- the part that matters most in
// practice -- falls back to the other if the first cannot start. A machine
// where the user is not in the `input` group would otherwise end up with *no*
// capture at all, when the uiohook path would still have worked whenever an
// X11 window had focus. Half a working mouse beats none, as long as the log
// says clearly which half.
//
// The native hook is a process-wide singleton: starting and stopping it on
// every config reload is fragile (uiohook-napi does not guarantee a clean
// restart), so it is started once on first use and kept for the process
// lifetime. Individual capture sessions only attach and detach listeners.
// That lifecycle lives here rather than in server-input.js so both backends
// are owned by the same module.
// ---------------------------------------------------------------------------

const CAPTURE_MODES = ["auto", "uiohook", "evdev"];

// Pure so it can be tested without a Linux box or a Wayland session.
function chooseCapture({ mode = "auto", platform = process.platform, isWayland = false } = {}) {
  if (mode === "uiohook" || mode === "evdev") return mode;
  if (platform !== "linux") return "uiohook";
  // On Wayland, uiohook's capture is the broken half (see the header), so evdev
  // leads. On X11 the roles reverse: uiohook reports true absolute positions
  // and needs no permission beyond an X connection.
  return isWayland ? "evdev" : "uiohook";
}

// ---------------------------------------------------------------------------
// uiohook backend
// ---------------------------------------------------------------------------

let hookStarted = false;

function ensureHook() {
  if (hookStarted) return;
  // eslint-disable-next-line global-require
  require("uiohook-napi").uIOhook.start();
  hookStarted = true;
}

function stopHook() {
  if (!hookStarted) return;
  try {
    // eslint-disable-next-line global-require
    require("uiohook-napi").uIOhook.stop();
  } catch {
    /* already stopped */
  }
  hookStarted = false;
}

function isHookStarted() {
  return hookStarted;
}

function makeUiohookBackend({ log } = {}) {
  const hook = () => require("uiohook-napi").uIOhook;
  return {
    name: "uiohook",
    // uiohook reports absolute physical pixels, so the server may warp the
    // cursor to re-centre it.
    canRecenter: true,
    positionKind: "absolute",
    on: (ev, fn) => hook().on(ev, fn),
    off: (ev, fn) => hook().off(ev, fn),
    // Nothing to anchor: the position comes from the hook itself.
    setAnchor() {},
    getAnchor: () => ({ x: null, y: null, anchored: false }),
    async start() {
      ensureHook();
      log?.info?.("输入捕获后端：uiohook（X11 / Xwayland）");
      return { ok: true, devices: [] };
    },
    stop() {
      /* the hook is process-wide and deliberately outlives capture sessions */
    },
    isStarted: isHookStarted,
    status: () => ({ started: hookStarted, devices: [], error: null }),
  };
}

// ---------------------------------------------------------------------------
// Selection + fallback
// ---------------------------------------------------------------------------

function makeEvdev({ log, deps }) {
  // eslint-disable-next-line global-require
  const { createEvdevCapture } = require("./capture-evdev");
  return createEvdevCapture({ log, deps });
}

function detectWayland() {
  try {
    // eslint-disable-next-line global-require
    return !!require("./platform").isWaylandSession();
  } catch {
    return false;
  }
}

// Start a capture backend. Always resolves; `backend` is null only when neither
// option could start, which is the one case where the node cannot do its job.
async function createCaptureBackend({ cfg, log, deps } = {}) {
  const mode = CAPTURE_MODES.includes(cfg?.input?.capture) ? cfg.input.capture : "auto";
  const isWayland = deps?.isWayland !== undefined ? deps.isWayland : detectWayland();
  // Injectable so the Linux branches can be exercised from a build machine that
  // is not Linux -- otherwise the whole selection path is untestable here.
  const platform = deps?.platform || process.platform;
  const preferred = chooseCapture({ mode, platform, isWayland });
  const other = preferred === "evdev" ? "uiohook" : "evdev";

  // Auto tries the preferred one first and then the other. An explicit choice
  // also falls back, but says so loudly: having no capture at all is worse than
  // running on the backend the user did not ask for, as long as they are told.
  const order = mode === "auto" ? [preferred, other] : [mode, other];

  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const backend = name === "evdev" ? makeEvdev({ log, deps }) : makeUiohookBackend({ log });
    let res;
    try {
      res = await backend.start();
    } catch (e) {
      res = { ok: false, reason: e.message };
    }
    if (res && res.ok) {
      if (i > 0) {
        log?.warn?.(
          `捕获后端 ${preferred} 不可用，已回退到 ${name}。` +
            (name === "uiohook"
              ? "uiohook 走 Xwayland，只有 X11 窗口有焦点时才收得到事件 —— 鼠标可能时灵时不灵。"
              : "evdev 直接读 /dev/input，位置是积分推算出来的，边缘判定可能有偏差。")
        );
      }
      return { backend, name, preferred, fellBack: i > 0, isWayland };
    }
    log?.warn?.(`捕获后端 ${name} 启动失败：${(res && res.reason) || "未知原因"}`);
    if (res && res.hint) log?.warn?.("  " + String(res.hint).replace(/\n/g, "\n  "));
    try {
      backend.stop();
    } catch {
      /* nothing was started */
    }
  }
  return { backend: null, error: "没有任何可用的输入捕获后端", isWayland, preferred };
}

module.exports = {
  createCaptureBackend,
  chooseCapture,
  ensureHook,
  stopHook,
  isHookStarted,
  CAPTURE_MODES,
};

"use strict";
// ---------------------------------------------------------------------------
// uinput-backed injection: the backend that actually works under Wayland.
//
// Why this file exists
// --------------------
// Everything else in this project injects through libnut, which on Linux is
// XTest. XTest is an X11 protocol: it asks the X server to synthesise an event.
// Under a real Xorg session that works everywhere. Under Wayland it does not,
// and it fails in the worst possible way:
//
//   * Xwayland *implements* XTest, so every single call SUCCEEDS. libnut
//     returns normally, no promise rejects, nothing throws.
//   * but Xwayland is only a client of the compositor. The events it
//     synthesises are delivered to X11 (Xwayland) clients and to nobody else.
//     Native Wayland applications never see them, and the compositor does not
//     reflect pointer warps -- the cursor the user is looking at does not move.
//
// So the API says yes, the log stays clean, and absolutely nothing happens.
// That is exactly the report this file was written to fix: "Win11 <-> Win11 is
// fine, Win11 <-> Ubuntu does not move the mouse and clicking does nothing".
//
// The only way to inject under Wayland is BELOW the display server: create a
// virtual input device through the kernel's uinput module. The compositor then
// sees a real mouse and a real keyboard, exactly as if one had been plugged in.
// That works on Wayland, on X11 and even on a text console, because no display
// server is involved at all.
//
// Creating that device needs ioctl() on /dev/uinput, which Node cannot do
// without a native addon -- and this project deliberately ships N-API
// prebuilds only, so that installing never needs a compiler. We therefore
// drive an existing uinput tool over a line-based pipe:
//
//   dotool   (preferred) reads actions from stdin and owns a persistent virtual
//            device, so ONE long-lived process serves every event: fast enough
//            for ~100 Hz motion, and it is the only tool here that can scroll.
//   ydotool  (fallback) talks to the ydotoold daemon over a unix socket. Each
//            action is a separate short-lived process (so motion has to be
//            throttled) and it has NO wheel support whatsoever -- scrolling is
//            dropped with a one-time warning rather than silently swallowed.
//            The daemon is started and stopped by ydotoold.js, so the user is
//            never asked to remember to run it.
//
// Neither ships in the Ubuntu/Debian archives. See INSTALL_HINT below and the
// README for the one-time setup each one needs.
// ---------------------------------------------------------------------------

const { createYdotooldManager, resolveBin, hasBin } = require("./ydotoold");

// ---------------------------------------------------------------------------
// What each tool can do and how it is driven.
//
// `persistent` decides the transport: a persistent tool is spawned once and fed
// lines on stdin; a non-persistent one is spawned per action.
// `wheel` / `hwheel` are real capability flags, not optimism -- ydotool simply
// has no scroll subcommand, and pretending otherwise would send the user
// hunting for a bug in the wrong place.
// `daemon` says whether the tool needs a background process to talk to. dotool
// owns its virtual device itself, so our long-lived child IS the owner; ydotool
// is a pure client and does nothing at all unless ydotoold is running. That
// distinction is why ydotoold.js exists.
// ---------------------------------------------------------------------------
const TOOLS = {
  dotool: {
    bin: "dotool",
    persistent: true,
    daemon: false,
    wheel: true,
    hwheel: true,
    keyboard: true,
    // motionIntervalMs 0 = flush on the next tick (the process is already warm)
    motionIntervalMs: 0,
    install:
      "dotool 不在 Ubuntu/Debian 官方源里，需要从源码装一次：\n" +
      "    sudo apt install -y gcc golang libxkbcommon-dev scdoc\n" +
      "    git clone https://git.sr.ht/~geb/dotool && cd dotool\n" +
      "    ./build.sh && sudo ./build.sh install\n" +
      "    sudo udevadm control --reload && sudo udevadm trigger\n" +
      "    然后把当前用户加进 input 组并重新登录：sudo usermod -aG input $USER",
  },
  ydotool: {
    bin: "ydotool",
    persistent: false,
    daemon: true, // useless without ydotoold -- see ydotoold.js
    // ydotool has no wheel command. NetMouse ships a tiny uinput helper
    // (bin/wheel.py) that writes REL_WHEEL directly, so scrolling works anyway.
    wheel: true,
    hwheel: true,
    keyboard: true,
    // Each event is a fork+exec, so cap motion at ~60 Hz instead of the input
    // rate; the deltas are coalesced, so no movement is lost, only smoothed.
    motionIntervalMs: 16,
    install:
      "ydotool 可以直接装，但它不支持滚轮。ydotoold 守护进程由 NetMouse 自己拉起，" +
      "所以不需要手动配置服务；只需要一次性给它 /dev/uinput 的权限：\n" +
      "    sudo apt install -y ydotool\n" +
      "    sudo ./install-linux.sh --uinput   # 装 udev 规则（或 sudo usermod -aG input $USER 后注销重登）",
  },
};

// dotool is tried first: it is the only one of the two with wheel support.
const PREFERRED = ["dotool", "ydotool"];

// nut-js button enum -> dotool button name.
// (nut-js: LEFT = 0, MIDDLE = 1, RIGHT = 2 -- note LEFT is 0, i.e. falsy.)
const DOTOOL_BUTTON = { 0: "left", 1: "middle", 2: "right" };

// nut-js button enum -> ydotool button index.
// ydotool numbers them LEFT = 0x00, RIGHT = 0x01, MIDDLE = 0x02, which is a
// THIRD numbering scheme; do not reuse the nut-js or uiohook numbers here.
const YDOTOOL_BUTTON = { 0: 0x00, 1: 0x02, 2: 0x01 };

// ---------------------------------------------------------------------------
// Action -> wire format.
//
// An "action" is the small, tool-independent description of one thing we want
// the operating system to do. Both builders are pure functions so the exact
// command line can be unit-tested without a Linux box in sight.
// ---------------------------------------------------------------------------

// dotool reads one action per line from stdin.
//   mousemove X Y     relative  (integers)
//   mouseto X Y       absolute, as fractions 0.0-1.0 of the output
//   buttondown left | buttonup middle | ...
//   wheel N | hwheel N    vertical / horizontal, signed
//   keydown k:30 | keyup k:30
// `k:` is a raw Linux input event code -- see the note in client-input.js about
// uiohook's keycodes already BEING those codes.
function dotoolLine(action) {
  switch (action.kind) {
    case "move": {
      const dx = Math.round(action.dx) || 0;
      const dy = Math.round(action.dy) || 0;
      if (!dx && !dy) return null; // nothing to do; do not wake the tool up
      return `mousemove ${dx} ${dy}`;
    }
    case "moveTo": {
      const x = clamp01(action.x);
      const y = clamp01(action.y);
      return `mouseto ${x} ${y}`;
    }
    case "button": {
      const name = DOTOOL_BUTTON[action.button];
      if (name === undefined) return null;
      return `${action.down ? "buttondown" : "buttonup"} ${name}`;
    }
    case "wheel": {
      const n = Math.round(action.notches) || 0;
      if (!n) return null;
      return `${action.horizontal ? "hwheel" : "wheel"} ${n}`;
    }
    case "key": {
      if (!Number.isFinite(action.code)) return null;
      return `${action.down ? "keydown" : "keyup"} k:${action.code}`;
    }
    default:
      return null;
  }
}

// ydotool takes a short argument vector per invocation.
//   mousemove -x D -y D            relative (default; --absolute switches it)
//   click 0x40 | 0x80|idx          button bitmask: 0x40 down, 0x80 up
//   key CODE:1 | CODE:0
// There is deliberately no wheel case: ydotool has no such command.
function ydotoolArgs(action) {
  switch (action.kind) {
    case "move": {
      const dx = Math.round(action.dx) || 0;
      const dy = Math.round(action.dy) || 0;
      if (!dx && !dy) return null;
      return ["mousemove", "-x", String(dx), "-y", String(dy)];
    }
    case "button": {
      const idx = YDOTOOL_BUTTON[action.button];
      if (idx === undefined) return null;
      const mask = action.down ? 0x40 : 0x80;
      return ["click", `0x${(mask | idx).toString(16).toUpperCase()}`];
    }
    case "wheel":
      // Capability, not implementation: ydotool has no wheel support at all.
      return null;
    case "key": {
      if (!Number.isFinite(action.code)) return null;
      return ["key", `${action.code}:${action.down ? 1 : 0}`];
    }
    default:
      return null;
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
}

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------
let cachedTool;

// Returns "dotool" | "ydotool" | null. `opts.has` lets tests supply their own
// lookup so the ordering can be pinned down without installing anything.
function detectUinputTool(opts = {}) {
  if (opts.has) return PREFERRED.find((t) => opts.has(TOOLS[t].bin)) || null;
  if (process.platform !== "linux") return null;
  if (cachedTool !== undefined) return cachedTool;
  // hasBin, not a bare `which`: the Linux build ships ydotool/ydotoold under
  // <resources>/bin, so "not installed" and "not available" are different
  // questions. Asking `which` alone would report the bundled copy as missing.
  cachedTool = PREFERRED.find((t) => hasBin(TOOLS[t].bin)) || null;
  return cachedTool;
}

function toolSpec(tool) {
  return TOOLS[tool] || null;
}

// One line for the settings UI / doctor: what this tool can and cannot do.
function describeTool(tool) {
  const s = TOOLS[tool];
  if (!s) return null;
  const caps = ["移动", "按键"];
  caps.push(s.wheel ? "滚轮" : "滚轮（不支持）");
  if (s.keyboard) caps.push("键盘");
  return {
    tool,
    bin: s.bin,
    persistent: s.persistent,
    daemon: !!s.daemon,
    wheel: s.wheel,
    hwheel: s.hwheel,
    keyboard: s.keyboard,
    caps: caps.join(" / "),
    install: s.install,
  };
}

// ---------------------------------------------------------------------------
// The injector
//
// `spawn` is injectable so the transport can be tested on any platform: the
// unit test hands in a fake child and asserts the exact bytes that would have
// reached the tool.
//
// `daemon` is injectable for the same reason -- it is the ydotoold manager. A
// tool that does not need a daemon gets none, and on a non-Linux platform we do
// not even look for one (there is no ydotoold there, and constructing a manager
// would only produce a confusing failure).
// ---------------------------------------------------------------------------
function createUinputInjector({ tool, binPath, log, spawn, manageDaemon, daemon, wheelHelper } = {}) {
  const spec = TOOLS[tool];
  if (!spec) throw new Error(`unsupported uinput tool: ${tool}`);
  const doSpawn = spawn || require("child_process").spawn;
  // Absolute path when the binary ships with us, bare name when it comes from
  // PATH. Resolved once here: the transport forks per action, and resolving
  // per action would add a `which` to every mouse movement.
  const bin = binPath || resolveBin(spec.bin);

  // A tool that owns its virtual device itself (dotool) gets no daemon manager
  // at all -- not even an injected one, so there is no way to accidentally talk
  // to a daemon the tool has nothing to do with.
  const daemons = spec.daemon
    ? daemon ||
      (process.platform === "linux"
        ? createYdotooldManager({ log, maySpawn: manageDaemon !== false })
        : null)
    : null;

  let child = null;
  let closing = false;

  let applied = 0;
  let errors = 0;
  let lastError = null;
  let reported = false;
  let warnedWheel = false;
  let stderrTail = "";
  let deadNoted = false;
  let daemonNoted = false;

  // The tool died. Counted exactly once, whether we learn about it from the
  // exit event or from noticing a stale exit code on the next write -- if it
  // went uncounted, the session would report "0 failures" while injecting
  // nothing, which is the precise bug this whole backend exists to expose.
  function noteDead(why) {
    if (deadNoted) return;
    deadNoted = true;
    noteError(`${bin} 不可用`, why);
  }

  function noteError(what, message) {
    errors += 1;
    lastError = message;
    if (!reported) {
      reported = true;
      log?.warn?.(
        `uinput 注入失败（${what}）：${message}\n` +
          "  → 本机控制不了自己的光标，也就控制不了对端。\n" +
          "  → 在本机运行「本机注入自检」定位：NetMouse --injecttest"
      );
    }
  }

  // A persistent tool is started once and kept alive for the whole session.
  // dotool registers its virtual device at startup, which takes a moment; doing
  // that per event would be both slow and visible.
  function ensureChild() {
    if (!spec.persistent || child) return child;
    child = doSpawn(bin, [], { stdio: ["pipe", "ignore", "pipe"] });
    child.on("error", (e) => noteError(`启动 ${bin}`, e.message));
    child.on("exit", (code, signal) => {
      if (!closing) {
        noteDead(`code=${code} signal=${signal}${stderrTail ? ` stderr=${stderrTail}` : ""}`);
      }
    });
    if (child.stderr) {
      if (child.stderr.setEncoding) child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        const s = String(d).trim();
        if (!s) return;
        stderrTail = s.split("\n")[0];
        // Not counted as an error: the tool may print progress on stderr.
        // It is kept only so an exit message can say WHY it died.
        log?.debug?.(`${bin}: ${stderrTail}`);
      });
    }
    if (child.stdin && child.stdin.on) {
      child.stdin.on("error", (e) => noteError(`${bin} stdin`, e.message));
    }
    return child;
  }

  // -------------------------------------------------------------------------
  // The daemon gate (ydotool only).
  //
  // ydotool is a pure client: until ydotoold is listening, nothing happens and
  // every call exits non-zero. So the first action of the session waits for the
  // daemon, and every action after it reuses the socket we resolved. The wait is
  // memoised inside the manager, so this costs one check per session, not one
  // per event.
  //
  // A failure here is reported ONCE and counted ONCE: the point of the counter
  // is "this machine accepted nothing", and inflating it per mouse event would
  // bury that in noise.
  // -------------------------------------------------------------------------
  async function ensureDaemon() {
    if (!daemons) return true;
    const st = await daemons.ensure();
    if (st.ok) return true;
    if (!daemonNoted) {
      daemonNoted = true;
      reported = true; // this message is better than the generic one below
      errors += 1;
      lastError = st.note;
      log?.warn?.(
        `uinput 注入不可用：${st.note}\n` +
          "  → 本机控制不了自己的光标，也就控制不了对端。\n" +
          "  → 在本机运行「本机注入自检」定位：NetMouse --injecttest"
      );
    }
    return false;
  }

  async function sendViaDaemon(args) {
    if (!(await ensureDaemon())) return false;
    // YDOTOOL_SOCKET is the only knob the client reads; pass the socket we
    // resolved explicitly rather than trusting the ambient environment.
    const socketPath = daemons ? daemons.socketPath() : null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        if (ok) {
          applied += 1;
        } else {
          noteError("执行", why);
        }
        resolve(ok);
      };
      let p;
      try {
        p = doSpawn(bin, args, {
          stdio: "ignore",
          env: socketPath ? { ...process.env, YDOTOOL_SOCKET: socketPath } : process.env,
        });
      } catch (e) {
        finish(false, e.message);
        return;
      }
      p.on("error", (e) => finish(false, e.message));
      p.on("exit", (code) => finish(code === 0, `${bin} ${args.join(" ")} -> exit ${code}`));
    });
  }

  // ydotool has no wheel command, so scrolling is done by a small bundled
  // helper that writes REL_WHEEL / REL_HWHEEL straight to /dev/uinput. It needs
  // no daemon and no socket; only the usual uinput permission.
  function wheelHelperPath() {
    const fs = require("fs");
    const path = require("path");
    const cands = [];
    if (process.resourcesPath) cands.push(path.join(process.resourcesPath, "bin", "wheel.py"));
    cands.push(path.join(__dirname, "..", "bin", "wheel.py"));
    for (const c of cands) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  function sendWheelHelper(action) {
    const notches = Math.round(action.notches) || 0;
    if (!notches) return Promise.resolve(false);
    // `wheelHelper` is a test seam; production always asks the filesystem.
    const helper = wheelHelper !== undefined ? wheelHelper : wheelHelperPath();
    if (!helper) {
      if (!warnedWheel) {
        warnedWheel = true;
        log?.warn?.(
          "滚轮不可用：找不到 bin/wheel.py（随程序附带）。\n" +
            "  → 移动/点击/键盘不受影响。"
        );
      }
      return Promise.resolve(false);
    }
    const args = [helper, String(notches)];
    if (action.horizontal) args.push("h");
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        if (ok) applied += 1;
        else noteError("滚轮", why);
        resolve(ok);
      };
      let p;
      try {
        p = doSpawn("python3", args, { stdio: "ignore" });
      } catch (e) {
        finish(false, e.message);
        return;
      }
      p.on("error", (e) => finish(false, e.message));
      p.on("exit", (code) => finish(code === 0, `wheel.py -> exit ${code}`));
    });
  }

  function send(action) {
    if (action.kind === "wheel" && !spec.wheel) {
      if (!warnedWheel) {
        warnedWheel = true;
        log?.warn?.(
          `${tool} 不支持滚轮：本次会话的滚动会被忽略。\n` +
            "  → 需要滚轮请改用 dotool（input.backend 留 auto 时它会优先被选中）。"
        );
      }
      return Promise.resolve(false);
    }

    if (spec.persistent) {
      const line = dotoolLine(action);
      if (line === null) return Promise.resolve(false);
      const c = ensureChild();
      if (!c || !c.stdin || c.exitCode !== null) {
        if (c && c.exitCode !== null) noteDead(`进程已退出（code=${c.exitCode}）`);
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        c.stdin.write(`${line}\n`, (err) => {
          if (err) {
            noteError("写入", err.message);
            resolve(false);
            return;
          }
          applied += 1;
          resolve(true);
        });
      });
    }

    if (action.kind === "wheel") {
      // ydotool cannot scroll; use the bundled uinput helper.
      return sendWheelHelper(action);
    }
    const args = ydotoolArgs(action);
    if (args === null) return Promise.resolve(false);
    return sendViaDaemon(args);
  }

  return {
    tool,
    bin,
    // 0 means "flush on the next tick"; a non-persistent tool asks for a
    // slightly lazier cadence so it is not forked once per input event.
    motionIntervalMs: spec.motionIntervalMs,
    capabilities: { wheel: spec.wheel, hwheel: spec.hwheel, keyboard: spec.keyboard },
    // True when this tool cannot do anything until a background daemon is up.
    needsDaemon: !!spec.daemon,

    move: (dx, dy) => send({ kind: "move", dx, dy }),
    moveTo: (x, y) => send({ kind: "moveTo", x, y }),
    button: (button, down) => send({ kind: "button", button, down }),
    wheel: (notches, horizontal) => send({ kind: "wheel", notches, horizontal }),
    key: (code, down) => send({ kind: "key", code, down }),

    // Resolve the daemon up front instead of letting the first mouse movement
    // pay for it (and, if it cannot be started, say so before the user starts
    // wondering why the far cursor is not moving).
    async prepare() {
      if (!daemons) {
        return { ok: true, mode: "none", note: `${tool} 自己持有虚拟设备，无需守护进程` };
      }
      const st = await daemons.ensure();
      if (!st.ok) await ensureDaemon();
      return st;
    },

    // For --injecttest / --doctor / the settings UI. Null when this backend
    // needs no daemon at all.
    daemonStatus: () =>
      daemons ? { ...daemons.status(), label: daemons.label() } : null,

    close() {
      closing = true;
      if (child) {
        try {
          child.stdin?.end?.();
        } catch {
          /* already gone */
        }
        try {
          child.kill?.();
        } catch {
          /* already gone */
        }
        child = null;
      }
      // Only ever tears down a daemon this process started; an adopted one
      // belongs to whoever started it.
      try {
        daemons?.close?.();
      } catch {
        /* already gone */
      }
    },

    health: () => ({ applied, errors, lastError }),
  };
}

module.exports = {
  createUinputInjector,
  detectUinputTool,
  describeTool,
  toolSpec,
  TOOLS,
  PREFERRED,
  // Exported for unit tests: these two encode the exact command language of the
  // two tools, and getting them wrong is invisible without a Linux desktop.
  dotoolLine,
  ydotoolArgs,
  DOTOOL_BUTTON,
  YDOTOOL_BUTTON,
};

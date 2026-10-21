const { mouse, keyboard, screen, Button, Point } = require("@nut-tree-fork/nut-js");
const {
  detectVirtualScreen,
  invalidateScreenCache,
  scrollUnit,
  isWaylandSession,
} = require("./platform");
const { createUinputInjector, detectUinputTool } = require("./inject-uinput");

// uiohook button codes -> nut Button enum.
//
// uiohook/libuiohook (libuiohook/include/uiohook.h) defines
//   MOUSE_BUTTON1 = 1  left
//   MOUSE_BUTTON2 = 2  right
//   MOUSE_BUTTON3 = 3  middle
//   MOUSE_BUTTON4 = 4  thumb "back"      (nut-js cannot inject these)
//   MOUSE_BUTTON5 = 5  thumb "forward"
// Verified against a real Windows low-level hook: left reports 1, right 2,
// middle 3.
//
// nut-js's own enum is LEFT = 0, MIDDLE = 1, RIGHT = 2 — note that LEFT is 0,
// i.e. FALSY. Never guard an injection with `if (btn)`; use buttonFor() below
// and compare against null. A truthiness check here silently dropped every
// left click while right/middle kept working.
const BTN = {
  1: Button.LEFT, // 0
  2: Button.RIGHT, // 2
  3: Button.MIDDLE, // 1
};

// Returns the nut Button for a uiohook button code, or null when nut-js has no
// equivalent (the two thumb buttons).
function buttonFor(code) {
  const b = BTN[code];
  return b === undefined ? null : b;
}

// uiohook WheelDirection: 3 = vertical, 4 = horizontal.
const WHEEL_HORIZONTAL = 4;
// A single event never carries an absurd notch count, but clamp anyway so a
// corrupt or hostile message cannot spin the injector.
const MAX_NOTCHES = 20;

// Map a wheel event onto a nut-js call. Returns { op, amount } or null when the
// event is not a scroll at all.
//
// libuiohook normalises wheel rotation to whole notches, and its sign is the
// same on every platform (X11 input_hook.c sets WheelUp/WheelLeft to -1 and
// WheelDown/WheelRight to +1; the Windows and macOS paths are written to match):
//
//   rotation < 0 -> wheel up   / wheel left
//   rotation > 0 -> wheel down / wheel right
//   rotation = 0 -> a sub-notch delta. Precision touchpads and free-spinning
//                   wheels emit these constantly; libuiohook accumulates the
//                   remainder and reports 0 until a whole notch is reached.
//                   These are NOT scrolls and must be dropped — treating them
//                   as ">= 0, so scroll up" made the wheel twitch upward.
//
// `unit` is how many nut-js "amount" units make one notch on this platform
// (120 on Windows, 1 elsewhere) — see platform.scrollUnit().
function wheelNotches(rotation) {
  const r = Math.round(rotation || 0);
  if (!r) return 0;
  const n = Math.min(MAX_NOTCHES, Math.max(1, Math.abs(r)));
  return r > 0 ? n : -n;
}

function wheelAction(rotation, direction, unit) {
  const n = wheelNotches(rotation);
  if (!n) return null;
  const amount = Math.abs(n) * unit;
  if (direction === WHEEL_HORIZONTAL) {
    return { op: n > 0 ? "scrollRight" : "scrollLeft", amount };
  }
  return { op: n > 0 ? "scrollDown" : "scrollUp", amount };
}

// Wheel direction for a uinput tool, which speaks the kernel's REL_WHEEL
// instead of the X11 button numbers.
//
// Linux defines REL_WHEEL +1 as "rolled up" (away from the user), while
// libuiohook -- and therefore our whole wire format -- uses the opposite sign:
// rotation < 0 is wheel up. So the amount handed to the tool is the NEGATED
// notch count. Kept as its own named function because it is the one place where
// the two sign conventions meet, and a silent inversion here looks exactly like
// "the wheel scrolls the wrong way".
function uinputWheelAmount(rotation) {
  const n = wheelNotches(rotation);
  return n === 0 ? 0 : -n; // avoid returning -0
}

// ---------------------------------------------------------------------------
// Which injection backend this machine will use.
//
//   xtest   libnut -> XTest. Fine on Windows, macOS and a real Xorg session.
//   uinput  a virtual kernel input device, via dotool or ydotool. The only
//           thing that works under Wayland.
//
// `auto` is the default because the session type is something the program can
// see for itself -- making the user answer a question the program already knows
// the answer to is how you end up with a wrong answer. And on Wayland XTest is
// not merely inferior, it is silently inert (see inject-uinput.js), so if a
// uinput tool is present it always wins.
// ---------------------------------------------------------------------------
function chooseBackend(cfg, opts = {}) {
  const want = (cfg.input && cfg.input.backend) || "auto";
  const platform = opts.platform || process.platform;

  // Only Linux has this choice to make; everywhere else libnut talks to the
  // native API directly and there is nothing to decide (or to probe).
  if (platform !== "linux") {
    return { kind: "xtest", tool: null, reason: `${platform} 上使用 libnut` };
  }

  const wayland = opts.wayland !== undefined ? opts.wayland : isWaylandSession();
  const tool = "uinputTool" in opts ? opts.uinputTool : detectUinputTool();
  if (want === "xtest") {
    return { kind: "xtest", tool: null, reason: "配置指定 xtest" };
  }
  if (want === "uinput" && !tool) {
    return {
      kind: "xtest",
      tool: null,
      reason: "配置要求 uinput，但没找到 dotool/ydotool —— 已退回 XTest",
      warn: true,
    };
  }
  if (tool && (want === "uinput" || wayland)) {
    return {
      kind: "uinput",
      tool,
      reason: want === "uinput" ? "配置指定 uinput" : "Wayland 会话（XTest 在此无效）",
    };
  }
  if (wayland && !tool) {
    return {
      kind: "xtest",
      tool: null,
      reason: "Wayland 会话，但没有 dotool/ydotool —— XTest 不会生效",
      warn: true,
    };
  }
  return { kind: "xtest", tool: null, reason: "X11 会话" };
}

// This machine's desktop box, in the same absolute space nut-js injects into.
// Electron's screen module reports the whole virtual desktop in physical pixels
// (multi-monitor included, origin may be negative); nut-js only knows the
// primary screen, so it is the fallback for headless mode.
async function detectLocalDesktop() {
  const vs = detectVirtualScreen();
  if (vs && vs.width > 0 && vs.height > 0) return { ...vs, source: "electron" };
  const [width, height] = await Promise.all([screen.width(), screen.height()]);
  return { x: 0, y: 0, width, height, source: "nut" };
}

// Read the local screen size. Kept for the UI's "detect" button.
async function detectScreen() {
  const d = await detectLocalDesktop();
  return { width: d.width, height: d.height, x: d.x, y: d.y };
}

// Scale an incoming coordinate from the server's desktop into an absolute point
// on this desktop, honouring a non-zero origin (a monitor left of / above the
// primary yields negative coordinates). Only used for the legacy absolute "mm"
// form; modern peers send relative deltas.
function mapPoint(x, y, srcW, srcH, dst) {
  return new Point(
    dst.x + Math.round((x / srcW) * dst.width),
    dst.y + Math.round((y / srcH) * dst.height)
  );
}

function createInjector({ cfg, log }) {
  // Source size = the server's virtual desktop. Only used by the legacy
  // absolute path; relative motion needs no source size.
  let srcW = cfg.layout.screenWidth;
  let srcH = cfg.layout.screenHeight;

  // nut-js "amount" units per wheel notch on THIS machine. Configurable so a
  // client whose libnut disagrees with the measured value can be corrected
  // without a rebuild (see platform.scrollUnit()).
  const unit = Number(cfg.input?.scrollUnit) > 0 ? Number(cfg.input.scrollUnit) : scrollUnit();

  // Which injector we drive. Note that `unit` above only ever matters for the
  // XTest path: a uinput tool takes a notch COUNT, not a raw wheel delta, so
  // input.scrollUnit is meaningless there.
  const backend = chooseBackend(cfg);
  let uinput = null;
  if (backend.kind === "uinput") {
    try {
      uinput = createUinputInjector({
        tool: backend.tool,
        log,
        // input.manageYdotoold: false means "I start the daemon myself, just
        // reuse it" -- for anyone running ydotool's own system service.
        manageDaemon: cfg.input?.manageYdotoold !== false,
      });
      log.info(`输入后端：uinput（${backend.tool}）—— ${backend.reason}`);
      // Resolve the daemon now rather than on the first mouse event: a client
      // that cannot inject should say so at startup, not look healthy until the
      // user notices the far cursor is not moving.
      if (uinput.needsDaemon) {
        uinput.prepare().then(
          (st) => {
            if (st.ok) log.info(`ydotoold：${st.note}`);
            // A failure is already reported once, with the fix, by the injector.
          },
          () => {}
        );
      }
    } catch (e) {
      log.warn(`uinput 后端（${backend.tool}）启用失败：${e.message}，退回 XTest`);
      uinput = null;
    }
  } else {
    log.info(`输入后端：XTest（libnut）—— ${backend.reason}`);
    if (backend.warn) {
      log.warn(
        `${backend.reason}。\n` +
          "  → 本机作为客户端时鼠标/按键不会生效。\n" +
          "  → 装 uinput 工具后重启即可自动切换：sudo apt install -y ydotool" +
          "（守护进程由 NetMouse 自己拉起，你只需要给一次 /dev/uinput 权限）。\n" +
          "  → 若你的发行版还提供 Xorg 会话，登录界面选它也能立刻解决。"
      );
    }
  }

  // Buttons we have pressed on this machine and not yet released. If control
  // goes back to the server mid-drag the release event never arrives, which
  // used to leave the far machine with a permanently held button (a "stuck"
  // drag/selection). releaseAll() is called when control returns home.
  const held = new Set();
  // Log each unsupported button code once, not once per event.
  const warned = new Set();

  // --- injection health ----------------------------------------------------
  //
  // Every injection call used to end in `.catch(() => {})`. That is how "the
  // cursor does not move on the other machine" stayed invisible: the tracked
  // position kept advancing (it is pure arithmetic), control kept returning
  // home on schedule, and the log looked perfectly healthy while the operating
  // system had rejected every single injection.
  //
  // So: count them, keep the last real message, and say something once.
  let injectApplied = 0;
  let injectErrors = 0;
  let lastInjectError = null;
  let injectErrorReported = false;

  function noteApplied() {
    injectApplied += 1;
  }

  function noteInjectError(what, e) {
    injectErrors += 1;
    lastInjectError = (e && e.message) || String(e);
    if (!injectErrorReported) {
      injectErrorReported = true;
      log.warn(
        `注入失败（${what}）：${lastInjectError}\n` +
          "  → 本机控制不了自己的光标，也就控制不了对端。\n" +
          "  → 在本机运行「本机注入自检」定位：NetMouse --injecttest（或 npm run injecttest）"
      );
    }
  }

  // Local desktop box, resolved lazily; until it lands we assume the two
  // desktops match, which degrades to a 1:1 mapping instead of wrong scaling.
  let dst = null;
  let sizing = null;

  // Relative motion is applied against a cursor position WE track, not by
  // reading the live cursor each event. getPosition is an RPC to libnut and
  // races with the OS applying our previous setPosition, so reading it back
  // per event returns stale values and the movement stalls. Tracking our own
  // target and coalescing updates keeps it smooth under high event rates.
  //
  // The tracked position is in ABSOLUTE desktop coordinates (it includes the
  // desktop origin), so it stays consistent with getLocalBox() and the
  // return-home check in app.js even on a multi-monitor desktop whose primary
  // is not at (0,0).
  let posX = null;
  let posY = null;
  let pendingX = 0;
  let pendingY = 0;
  let flushScheduled = false;

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

  function flushMotion() {
    flushScheduled = false;
    if (pendingX === 0 && pendingY === 0) return;
    if (posX === null) return; // not initialised yet
    const dx = pendingX;
    const dy = pendingY;
    pendingX = 0;
    pendingY = 0;
    posX += dx;
    posY += dy;
    const loX = dst ? dst.x : 0;
    const loY = dst ? dst.y : 0;
    const hiX = dst ? dst.x + dst.width - 1 : posX;
    const hiY = dst ? dst.y + dst.height - 1 : posY;
    const x = clampInt(posX, loX, hiX);
    const y = clampInt(posY, loY, hiY);
    posX = x;
    posY = y;
    if (uinput) {
      // A uinput tool moves RELATIVE to wherever the real cursor is. The
      // tracked position above is still clamped to the desktop, so the two
      // agree: the compositor clamps the real cursor at the same boundary.
      uinput.move(dx, dy).then((ok) => {
        if (ok) noteApplied();
      });
      return;
    }
    mouse
      .setPosition(new Point(x, y))
      .then(noteApplied, (e) => noteInjectError("移动光标", e));
  }

  function ensureSize() {
    if (dst) return Promise.resolve();
    if (!sizing) {
      sizing = detectLocalDesktop()
        .then((d) => {
          dst = d;
          log.info(
            `local desktop detected: ${d.width}x${d.height} @ (${d.x},${d.y}) [${d.source}]`
          );
        })
        .catch((e) => {
          log.warn("cannot read local screen size, assuming it matches the server:", e.message);
          dst = { x: 0, y: 0, width: srcW, height: srcH, source: "assumed" };
        });
    }
    return sizing;
  }

  ensureSize();

  mouse.config.mouseSpeed = 10000; // move fast, we get high-frequency updates
  keyboard.config.autoDelayMs = 0;

  const handle = async function handle(msg) {
    try {
      switch (msg.t) {
        case "enter":
          if (msg.vw > 0 && msg.vh > 0 && (msg.vw !== srcW || msg.vh !== srcH)) {
            srcW = msg.vw;
            srcH = msg.vh;
            log.info(`server desktop ${srcW}x${srcH} (scaling source updated)`);
          }
          // Re-read the local layout at each hand-over so a hotplug / resolution
          // change on this machine is picked up without a restart.
          invalidateScreenCache();
          dst = null;
          sizing = null;
          // A new session: drop any button left pressed by the previous one.
          releaseAll();
          // Seed our tracked position at the CENTRE of this desktop. The deltas
          // are relative, so the start point is arbitrary — but it must not be
          // read from the live cursor, which holds wherever this machine's own
          // physical mouse happens to be (that made the remote cursor collapse
          // toward a corner). Centre gives equal room in every direction.
          ensureSize().then(() => {
            const cx = dst ? dst.x + Math.floor(dst.width / 2) : Math.floor(srcW / 2);
            const cy = dst ? dst.y + Math.floor(dst.height / 2) : Math.floor(srcH / 2);
            posX = cx;
            posY = cy;
            pendingX = 0;
            pendingY = 0;
            if (uinput) {
              // A uinput tool can only move relatively, so the real cursor is
              // wherever the user's own hand left it. dotool can still jump
              // (mouseto takes fractions of the output), which lines the real
              // cursor up with the tracked centre; ydotool cannot, so it simply
              // stays offset and the relative motion still works from there.
              uinput.moveTo(0.5, 0.5).then((ok) => {
                if (ok) noteApplied();
              });
              return;
            }
            mouse
              .setPosition(new Point(posX, posY))
              .then(noteApplied, (e) => noteInjectError("落点居中", e));
          });
          log.debug("peer took control");
          break;
        case "mm": {
          ensureSize();
          if (typeof msg.dx === "number" || typeof msg.dy === "number") {
            // Coalesce deltas and apply at the next tick: applying every event
            // synchronously cannot keep up with ~100 Hz input and stalls.
            pendingX += msg.dx || 0;
            pendingY += msg.dy || 0;
            if (!flushScheduled) {
              flushScheduled = true;
              // dotool is a warm, long-lived process, so the next tick is fine.
              // ydotool forks a process per action and asks for a lazier
              // cadence instead; deltas are coalesced either way, so nothing is
              // lost -- only smoothed.
              const every = uinput ? uinput.motionIntervalMs : 0;
              if (every > 0) setTimeout(flushMotion, every);
              else setImmediate(flushMotion);
            }
          } else if (typeof msg.x === "number") {
            // Legacy absolute form (older peers).
            await ensureSize();
            const p = mapPoint(msg.x, msg.y, srcW, srcH, dst);
            posX = p.x;
            posY = p.y;
            await mouse.setPosition(p);
            noteApplied();
          }
          break;
        }
        case "md": {
          const b = buttonFor(msg.b);
          if (b === null) {
            warnUnsupportedButton(msg.b);
            break;
          }
          held.add(b);
          if (uinput) {
            if (await uinput.button(b, true)) noteApplied();
            break;
          }
          await mouse.pressButton(b);
          noteApplied();
          break;
        }
        case "mu": {
          const b = buttonFor(msg.b);
          if (b === null) break;
          held.delete(b);
          if (uinput) {
            if (await uinput.button(b, false)) noteApplied();
            break;
          }
          await mouse.releaseButton(b);
          noteApplied();
          break;
        }
        case "wh": {
          if (uinput) {
            // A uinput tool takes a signed notch count, so the platform scroll
            // UNIT does not apply here at all (see uinputWheelAmount).
            const n = uinputWheelAmount(msg.r);
            if (n && (await uinput.wheel(n, msg.d === WHEEL_HORIZONTAL))) noteApplied();
            break;
          }
          const a = wheelAction(msg.r, msg.d, unit);
          if (a) {
            await mouse[a.op](a.amount);
            noteApplied();
          }
          break;
        }
        case "kd":
          await pressKey(msg, true);
          break;
        case "ku":
          await pressKey(msg, false);
          break;
      }
    } catch (e) {
      noteInjectError(`事件 ${msg.t}`, e);
    }
  };

  // Keyboard events carry TWO key codes. `c` is the nut-js Key value, which is
  // what the XTest path needs. `k` is the raw uiohook keycode, and uiohook's
  // keycodes ARE Linux input event codes -- VC_A is 30 and KEY_A is 30, and the
  // same holds across the whole alphanumeric block -- so the uinput backend can
  // hand `k` straight to the tool as `k:<code>` with no translation table.
  //
  // A peer that predates the `k` field simply has no keyboard on the uinput
  // backend. Say so once, rather than appearing to swallow every keystroke.
  let warnedNoKeycode = false;

  async function pressKey(msg, down) {
    if (!uinput) {
      if (down) await keyboard.pressKey(msg.c);
      else await keyboard.releaseKey(msg.c);
      return;
    }
    if (!Number.isFinite(msg.k)) {
      if (!warnedNoKeycode) {
        warnedNoKeycode = true;
        log.warn(
          "对端没有发送原始键码（k 字段），uinput 后端无法注入键盘。\n" +
            "  → 两端版本不一致：把服务器也升级到同一版本即可。"
        );
      }
      return;
    }
    await uinput.key(msg.k, down);
  }

  function warnUnsupportedButton(code) {
    if (warned.has(code)) return;
    warned.add(code);
    log.info(
      `忽略鼠标按键 ${code}（nut-js 只能注入左/中/右键；` +
        `4/5 是侧键"后退/前进"，暂不支持）`
    );
  }

  // Release every button we are still holding. Called when control returns to
  // the server so a drag that crossed the boundary does not leave the far
  // machine with a stuck button.
  async function releaseAll() {
    if (!held.size) return 0;
    const list = [...held];
    held.clear();
    for (const b of list) {
      try {
        if (uinput) {
          if (await uinput.button(b, false)) noteApplied();
        } else {
          await mouse.releaseButton(b);
          noteApplied();
        }
      } catch (e) {
        noteInjectError("松开按键", e);
      }
    }
    return list.length;
  }

  return {
    handle,
    releaseAll,
    // The position WE have driven the cursor to, in absolute desktop space.
    // This is what the return-home check must use: reading the live cursor
    // (mouse.getPosition) is unreliable here because this machine's own
    // physical mouse keeps moving it.
    getTrackedPosition: () => ({ x: posX, y: posY }),
    getLocalBox: () => dst,
    getSourceSize: () => ({ width: srcW, height: srcH }),
    // How injection is actually going on this machine. `applied` counts the
    // calls nut-js accepted; `errors` counts the ones it rejected. A client
    // whose errors are climbing is a client whose peer's cursor never moves,
    // no matter how healthy the rest of the log looks.
    getInjectionHealth: () => {
      // The uinput backend keeps its own counters (it never goes through the
      // nut-js calls above), so the two are added together: from the outside
      // the only question is "did this machine accept what we asked it to do".
      const sub = uinput ? uinput.health() : { applied: 0, errors: 0, lastError: null };
      return {
        applied: injectApplied + sub.applied,
        errors: injectErrors + sub.errors,
        lastError: lastInjectError || sub.lastError,
      };
    },
    // Which backend is actually in use, and why. Reported by --injecttest and
    // the settings UI so "the cursor does not move" has a visible cause.
    getBackend: () => ({
      kind: backend.kind,
      tool: backend.tool,
      reason: backend.reason,
      active: uinput ? "uinput" : "xtest",
      capabilities: uinput ? uinput.capabilities : null,
      // ydotool only: whether a daemon was adopted, started by us, or could not
      // be started at all -- which is the difference between "broken" and
      // "nothing is running yet".
      daemon: uinput ? uinput.daemonStatus() : null,
    }),
    close() {
      if (uinput) uinput.close();
    },
  };
}

module.exports = {
  createInjector,
  detectScreen,
  detectLocalDesktop,
  mapPoint,
  // Exported for unit tests — these two encode the button/wheel contract that
  // a real hook reports, and getting them wrong is invisible until you are
  // sitting in front of two machines.
  buttonFor,
  wheelAction,
  wheelNotches,
  // The one place the X11 and kernel wheel sign conventions meet.
  uinputWheelAmount,
  // Backend selection, so the "which injector am I on" decision can be tested
  // without a Wayland session.
  chooseBackend,
  BTN,
};

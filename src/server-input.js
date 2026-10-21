const { execFile } = require("child_process");
const { UiohookKey } = require("uiohook-napi");
const { Key } = require("@nut-tree-fork/nut-js");
const { buildKeyMap } = require("./keymap");
const { parseHotkey, hotkeyMatches } = require("./hotkey");
const {
  createCaptureBackend,
  ensureHook,
  stopHook,
  isHookStarted,
} = require("./capture");
const {
  hasXdotool,
  getScreenInfo,
  resolveMonitor,
  invalidateScreenCache,
  describeMonitors,
  edgeOwner,
} = require("./platform");

const { u2n } = buildKeyMap(UiohookKey, Key);

// The hook lifecycle now lives in capture.js, which owns both backends. It is
// re-exported below because `NetMouse --doctor` and main.js still ask for it
// here.

// How often to re-read the display layout so a hotplug / resolution change is
// picked up without a restart. Electron's screen module is cheap (no process
// spawn); the headless PowerShell/xrandr path is not, so it polls far less.
const POLL_MS = process.versions.electron ? 3000 : 30000;

// Set once per process: the "no OS geometry" warning must not repeat on every
// geometry poll.
let warnedNoGeometry = false;

// Resolve the coordinate frame the server works in:
//   - the whole virtual desktop box (origin + size), and
//   - the rectangle whose edge triggers the hand-over (one monitor, or all).
//
// The OS-reported geometry is authoritative: uiohook reports absolute physical
// pixels in the virtual desktop, and Electron's `screen` (bounds*scaleFactor)
// and xrandr both report physical pixels too, so they agree. PowerShell is the
// only source that can disagree (it is not DPI aware), and it is used only in
// headless mode with no other option.
function resolveGeometry(cfg, log) {
  const info = getScreenInfo();
  if (!info.virtual && !warnedNoGeometry) {
    warnedNoGeometry = true;
    log.warn(
      `无法从系统读取桌面尺寸（无 Electron screen / xrandr / PowerShell 结果）；` +
        `改用 config 的 ${cfg.layout.screenWidth}x${cfg.layout.screenHeight}。` +
        `若边缘触发位置不对，请把 layout.screenWidth/Height 改成实际值，或改用图形界面运行`
    );
  }
  const virtual =
    info.virtual || {
      x: 0,
      y: 0,
      width: cfg.layout.screenWidth || 1920,
      height: cfg.layout.screenHeight || 1080,
    };
  const geo = {
    VX: virtual.x,
    VY: virtual.y,
    W: virtual.width,
    H: virtual.height,
    EX: virtual.x,
    EY: virtual.y,
    EW: virtual.width,
    EH: virtual.height,
    signature: info.signature,
    monitors: info.monitors,
    monitorIndex: null,
  };

  const sel = cfg.layout.monitor;
  const restricted = sel !== undefined && sel !== null && sel !== "" && sel !== "all";
  if (restricted) {
    const picked = resolveMonitor(sel, info.monitors);
    if (picked) {
      const m = picked.monitor;
      geo.EX = m.x;
      geo.EY = m.y;
      geo.EW = m.width;
      geo.EH = m.height;
      geo.monitorIndex = picked.index;
    } else {
      log.warn(
        `layout.monitor="${sel}" 未匹配到任何显示器（共 ${info.monitors.length} 块），改用整个虚拟桌面`
      );
    }
  }
  return geo;
}

function describe(geo, cfg) {
  const parts = [`虚拟桌面 ${geo.W}x${geo.H} @ (${geo.VX},${geo.VY})`];
  if (geo.monitorIndex !== null) {
    parts.push(
      `触发屏 #${geo.monitorIndex} ${geo.EW}x${geo.EH} @ (${geo.EX},${geo.EY})`
    );
  }
  if (geo.W !== cfg.layout.screenWidth || geo.H !== cfg.layout.screenHeight) {
    parts.push(`(config 写的是 ${cfg.layout.screenWidth}x${cfg.layout.screenHeight})`);
  }
  return parts.join("  ·  ");
}

// Explain, in the log, which physical screen owns the edge the user selected.
// On a multi-monitor desk the shared edge usually belongs to a secondary
// screen, and "I moved the mouse left and nothing happened" is almost always
// this: the configured edge is not the side the other machine is on, or the
// cursor has to cross the whole secondary screen to reach it.
function describeEdge(edge, geo, cfg) {
  if (!geo.monitors || !geo.monitors.length) return "";
  if (edge === "any") {
    return "共享边 = any（碰到任意一条边都会交出去）";
  }
  const owners = edgeOwner(edge, geo.monitors);
  if (!owners.length) return "";
  const idx = owners.map((m) => geo.monitors.indexOf(m)).join(",");
  const primaryOwns = owners.some((m) => m.primary);
  const where = `共享边 ${edge} 属于显示器 #${idx}` + (primaryOwns ? "（主屏）" : "（非主屏）");
  const hint =
    geo.monitors.length > 1 && !primaryOwns
      ? `；注意：该边不在主屏上，鼠标要跨过整块 #${idx} 才会到达`
      : "";
  return where + hint;
}

// Server side: own the physical mouse/keyboard. When the cursor reaches the
// configured edge it becomes "captured" and all subsequent motion is streamed
// to the peer as RELATIVE deltas; the peer's opposite edge sends "release" to
// return control.
//
// Two hard-won rules live here:
//
//  1. EDGE DETECTION USES OS GEOMETRY, NEVER THE CURSOR ITSELF.
//     A "learn the desktop from the cursor's min/max" scheme is self-
//     referential: the maximum always equals wherever the cursor currently is,
//     so the right/bottom edge would trigger mid-screen. The trigger rectangle
//     therefore comes from `getScreenInfo()` (Electron/xrandr), falling back to
//     the configured size only when the OS reports nothing.
//
//  2. THE PHYSICAL CURSOR IS RE-CENTRED NEAR SCREEN EDGES.
//     While captured we forward deltas between consecutive hook samples. On
//     Windows the cursor is clamped at the screen boundary, so a single warp
//     at capture time would give the peer's cursor only ~half a screen of
//     travel and it could never reach the far edge. Re-centring whenever the
//     cursor nears any boundary keeps full travel room in every direction.
//     Linux/X11 needs xdotool for this (the pointer is not clamped there).
function startServerInput({ cfg, log, send, hasPeer, onStateChange, blocker, onPanic }) {
  // Mutable: the tray menu can switch the shared edge at runtime, so the user
  // does not have to guess, edit config.json, and restart.
  let edge = cfg.layout.edge;
  // The concrete direction that actually triggered (for edge === "any").
  let activeEdge = edge === "any" ? null : edge;
  const env = makeEnvelope(cfg); // diagnostics only (see note above)
  let geo = resolveGeometry(cfg, log);
  log.info(`input capture: ${describe(geo, cfg)}`);
  if (geo.monitors && geo.monitors.length) {
    log.info(`显示器:\n${describeMonitors(geo.monitors)}`);
  }
  const edgeLine = describeEdge(edge, geo, cfg);
  if (edgeLine) log.info(edgeLine);
  if (geo.monitors && geo.monitors.length > 1 && edge !== "any" && geo.monitorIndex === null) {
    log.info(
      "提示：多屏时若对端不在所配的那一侧，鼠标怎么移都不会触发。" +
        "可以在托盘菜单直接切换共享边，或把 layout.edge 设为 any（任意边都触发）。"
    );
  }

  // Global escape hatch: a key combo that drops remote control no matter which
  // window has focus (the physical keys always reach the hook). Needed because
  // the input blocker can cover the whole screen.
  const panic = parseHotkey(cfg.input?.panicHotkey, UiohookKey);
  if (cfg.input?.panicHotkey && !panic) {
    log.warn(`panicHotkey "${cfg.input.panicHotkey}" 无法解析，已忽略`);
  }
  const pressed = new Set();

  const MARGIN = 1; // px band that counts as touching the trigger edge
  const PULLBACK = 6; // px inward the cursor must travel before re-capturing
  // Keep the physical cursor at least this far from any desktop boundary while
  // captured, so it never clamps and always has room to move.
  const EDGE_KEEP = 120;
  const DIRS = ["left", "right", "top", "bottom"];

  let captured = false;
  let active = false;
  // After a release the physical cursor is still pinned at the edge, so the
  // very next move would re-capture instantly. Require it to move inward first.
  let armed = true;
  let pollTimer = null;
  // The selected capture backend (capture.js). null until start() resolves.
  let capture = null;
  // True when the backend reports deltas only and cannot say where the cursor
  // is -- i.e. the evdev backend under Wayland. The trigger logic then has to
  // change shape; see the push model below.
  let relativeOnly = false;

  // --- the push model (relative backends only) ------------------------------
  //
  // Wayland gives no way to ask where the pointer is, so "the cursor reached
  // the edge" is not a question that can be answered. What CAN be measured is
  // that the user shoved the mouse toward the shared edge, so that becomes the
  // gesture: accumulate one-directional travel and hand over once it is
  // deliberate. Each counter is cleared the moment the direction reverses, so
  // wiggling back and forth can never add up to a trigger.
  //
  // The threshold scales with the desktop so the gesture feels the same on a
  // laptop panel and on a 4K monitor. 35% of the short side is ~378 px at
  // 1080p: far more than an accidental nudge, far less than a drag across the
  // screen.
  const push = { left: 0, right: 0, top: 0, bottom: 0 };
  const pushTarget = () => Math.max(200, Math.round(Math.min(geo.W, geo.H) * 0.35));
  // Last raw hook position, for computing relative motion while captured.
  // null means "no baseline yet" (just captured / just re-centred).
  let lastX = null;
  let lastY = null;
  let diagDone = false;
  // Feedback state: how close the cursor has come to the trigger edge, so a
  // silent "nothing happens" turns into a number in the log.
  let closest = Infinity;
  let nearLogged = false;
  let movesSeen = 0;
  let startedAt = Date.now();
  let hinted = false;

  // The rectangle that owns the shared edge (a monitor, or the whole desktop).
  function triggerBox() {
    return { x: geo.EX, y: geo.EY, width: geo.EW, height: geo.EH };
  }
  // The whole virtual desktop: the region the cursor must stay inside.
  function desktopBox() {
    return { x: geo.VX, y: geo.VY, width: geo.W, height: geo.H };
  }

  // Signed distance from the cursor to one boundary of `box` (>= 0 while the
  // cursor is on the desktop side of it).
  function edgeDistance(dir, box, e) {
    switch (dir) {
      case "right":
        return box.x + box.width - e.x;
      case "left":
        return e.x - box.x;
      case "bottom":
        return box.y + box.height - e.y;
      default:
        return e.y - box.y; // top
    }
  }

  // Whether the cursor is inside the box's span on the perpendicular axis
  // (otherwise travelling along the outside of a chosen monitor would trigger).
  function withinSpan(dir, box, e) {
    return dir === "right" || dir === "left"
      ? e.y >= box.y && e.y <= box.y + box.height
      : e.x >= box.x && e.x <= box.x + box.width;
  }

  // Which boundary is the cursor closest to, and how far.
  // For a concrete edge this is just that edge; for "any" it is the nearest of
  // the four, so a hand-over happens whichever way the user pushes the mouse.
  function probe(box, e) {
    if (edge !== "any") return { dir: edge, dist: edgeDistance(edge, box, e) };
    let best = null;
    for (const dir of DIRS) {
      if (!withinSpan(dir, box, e)) continue;
      const dist = edgeDistance(dir, box, e);
      if (best === null || dist < best.dist) best = { dir, dist };
    }
    return best || { dir: null, dist: Infinity };
  }

  const setCaptured = (v) => {
    if (captured === v) return;
    captured = v;
    log.info(
      v
        ? `captured -> forwarding to peer (${activeEdge || edge})`
        : "released -> local control"
    );
    // Engage / disengage local input blocking with the capture state.
    try {
      if (v) blocker?.engage?.();
      else blocker?.disengage?.();
    } catch (e) {
      log.warn("input blocker error:", e.message);
    }
    onStateChange?.(v);
  };

  // Capturing with nobody on the other end would latch the node into "remote"
  // forever, so require a live peer before taking control.
  const canCapture = () => (typeof hasPeer === "function" ? hasPeer() : true);

  // One-time diagnostic: once the cursor has swept a real desktop, compare what
  // the hook actually reports against the OS geometry. A large mismatch means
  // the geometry source is in a different scale (typically headless Windows
  // under per-monitor DPI, where PowerShell is not DPI aware).
  function diagnose() {
    if (diagDone) return;
    const b = envelopeBox(env);
    // Only compare once the cursor has swept most of a real desktop; a thin
    // sweep (or a few early events) would look like a mismatch when it is
    // simply incomplete.
    if (b.width < geo.W * 0.5 || b.height < geo.H * 0.5) return;
    diagDone = true;
    const dW = Math.abs(b.width - geo.W);
    const dX = Math.abs(b.x - geo.VX);
    if (dW > geo.W * 0.1 || dX > geo.W * 0.1) {
      log.warn(
        `钩子观测到的桌面 (${b.x},${b.y} ${b.width}x${b.height}) 与系统几何 ` +
          `(${geo.VX},${geo.VY} ${geo.W}x${geo.H}) 不一致；边缘判定以系统几何为准，` +
          `若触发位置不准请核对缩放/多屏设置`
      );
    }
  }

  const onMouseMove = (e) => {
    if (relativeOnly) return onMouseMoveRelative(e);
    envelopeObserve(env, e);
    diagnose();
    const box = triggerBox();

    if (!captured) {
      movesSeen++;
      const p = probe(box, e);
      const inSpan = p.dir ? withinSpan(p.dir, box, e) : false;
      const dist = inSpan ? p.dist : Infinity;

      // Track how close the cursor ever gets to the shared edge. If it never
      // gets close, the user is pushing against an edge we are not watching.
      if (Number.isFinite(dist) && dist < closest) closest = dist;

      // Once the cursor has moved clear of the edge, allow capture again.
      if (dist > PULLBACK) armed = true;

      // Approach feedback: one line per approach, so "nothing happens" becomes
      // a number. Reset the latch once the cursor is well away again.
      if (dist <= 40 && !nearLogged) {
        nearLogged = true;
        log.info(`靠近共享边 ${p.dir}，还差 ${Math.round(dist)}px，再推一点就会交出去`);
      } else if (dist > 200) {
        nearLogged = false;
      }

      // After a while with movement but no trigger, say so explicitly — this is
      // the "I moved the mouse left and nothing happened" case.
      if (!hinted && movesSeen > 400 && Date.now() - startedAt > 15000) {
        hinted = true;
        const gap = Number.isFinite(closest) ? Math.round(closest) : null;
        // With edge="any" a missing trigger cannot be a wrong direction: the
        // geometry itself must disagree with where the cursor can actually go.
        const advice =
          edge === "any"
            ? "共享边已经是 any 却一直没触发，说明边缘判定用的几何和光标实际能到的范围对不上。" +
              "请在托盘菜单跑一次「运行诊断（含 20 秒边缘观测）」并把报告发出来。"
            : `如果对端在另一侧，请把 layout.edge 改成 ${edge === "right" ? "left" : "right"}` +
              "，或改成 any（任意边都触发）；也可以直接在托盘菜单切换。";
        log.warn(
          `启动以来共享边（${edge}）从未触发` +
            (gap === null
              ? "：光标始终不在该边的范围内（多屏时很可能是选错了边）"
              : `：最近一次离该边还有 ${gap}px`) +
            `。${advice}`
        );
      }

      const atEdge = dist <= MARGIN;
      if (atEdge && armed && canCapture()) {
        activeEdge = p.dir;
        setCaptured(true);
        // Warp ONCE to the middle so the cursor has full travel room.
        lastX = null;
        lastY = null;
        recenterCursor(desktopBox(), log);
        // Tell the client the desktop size our coordinates use and which edge
        // is shared, so it does not have to be configured with a matching
        // `layout.edge` by hand.
        send?.({ t: "enter", vw: geo.W, vh: geo.H, edge: activeEdge });
      }
      return;
    }

    // Captured: forward RELATIVE motion. Absolute coordinates are unusable
    // here — uiohook reports physical pixels, the OS uses logical ones under
    // DPI scaling, and multi-monitor layouts have negative origins, so any
    // absolute mapping disagrees somewhere. A delta between consecutive events
    // is in the same units as the user's actual hand motion and survives all of
    // that, and it works between machines of different resolutions.
    const d = desktopBox();
    // A delta this large between two samples is our own teleport, not hand
    // motion: at 100 Hz a hand cannot cross ~min(screen)/4 in 10 ms.
    const jumpLimit = Math.max(120, Math.min(300, Math.min(d.width, d.height) / 4));

    if (lastX === null) {
      // First sample after capture or after a re-centre: establish the
      // baseline, so the teleport itself is never forwarded.
      lastX = e.x;
      lastY = e.y;
      return;
    }
    const dx = e.x - lastX;
    const dy = e.y - lastY;
    lastX = e.x;
    lastY = e.y;
    if (Math.abs(dx) > jumpLimit || Math.abs(dy) > jumpLimit) {
      // A late-arriving re-centre teleport (setPosition is async, so the hook
      // can report the jump one event after the real motion that triggered it).
      return;
    }
    if (dx || dy) send?.({ t: "mm", dx, dy });

    // Re-centre before the cursor reaches a boundary so it never clamps.
    if (
      e.x <= d.x + EDGE_KEEP ||
      e.y <= d.y + EDGE_KEEP ||
      e.x >= d.x + d.width - EDGE_KEEP ||
      e.y >= d.y + d.height - EDGE_KEEP
    ) {
      recenterCursor(d, log);
      // Drop the baseline so the next sample is measured from wherever the
      // cursor lands, not from the pre-warp position.
      lastX = null;
      lastY = null;
    }
  };

  // The evdev path. Two differences from the absolute path above, and both come
  // from the same fact -- there is no position, only deltas:
  //
  //   * while captured, the deltas are forwarded AS THEY ARRIVE. No
  //     delta-of-absolutes, no jump filter, and no re-centring: the physical
  //     cursor is never warped, so it cannot clamp at a screen edge and never
  //     needs travel room. That removes an entire class of bug (the "cursor
  //     pinned to the edge" failure the absolute path works around).
  //   * while not captured, the trigger is the push gesture described above.
  function onMouseMoveRelative(e) {
    const dx = e.dx || 0;
    const dy = e.dy || 0;
    if (captured) {
      if (dx || dy) send?.({ t: "mm", dx, dy });
      return;
    }

    movesSeen++;
    if (dx < 0) {
      push.left += -dx;
      push.right = 0;
    } else if (dx > 0) {
      push.right += dx;
      push.left = 0;
    }
    if (dy < 0) {
      push.top += -dy;
      push.bottom = 0;
    } else if (dy > 0) {
      push.bottom += dy;
      push.top = 0;
    }

    const candidates = edge === "any" ? DIRS : [edge];
    let best = null;
    for (const dir of candidates) {
      const p = push[dir];
      if (p <= 0) continue;
      if (best === null || p > best.p) best = { dir, p };
    }
    if (!best) {
      // Nothing is being pushed in a watched direction: the hand has stopped or
      // reversed, which is exactly the condition for allowing a hand-over again.
      armed = true;
      nearLogged = false;
      return;
    }

    const target = pushTarget();
    const remain = target - best.p;
    if (remain < closest) closest = remain;

    if (remain > 0) {
      if (remain <= 60 && !nearLogged) {
        nearLogged = true;
        log.info(
          `正在推向共享边 ${best.dir}，还差约 ${Math.round(remain)}px 的连续位移就会交出去`
        );
      } else if (remain > target * 0.6) {
        nearLogged = false;
      }
      if (!hinted && movesSeen > 400 && Date.now() - startedAt > 15000) {
        hinted = true;
        const gap = Number.isFinite(closest) ? Math.round(closest) : null;
        log.warn(
          `启动以来共享边（${edge}）从未触发` +
            (gap === null ? "" : `：最接近时还差约 ${gap}px 的连续位移`) +
            "。Wayland 下用的是「连续推向某一边」的手势而不是光标位置 ——" +
            `请朝${edge === "any" ? "任意" : "共享"}边连续推 ${target}px 左右试试；` +
            "也可以把 layout.edge 改成 any（任意边都触发）。"
        );
      }
      return;
    }

    if (!armed || !canCapture()) return;
    activeEdge = best.dir;
    setCaptured(true);
    // Deliberately no cursor warp and no baseline reset: see the note above.
    send?.({ t: "enter", vw: geo.W, vh: geo.H, edge: activeEdge });
  }

  const onMouseDown = (e) => {
    if (captured) send?.({ t: "md", b: e.button });
  };
  const onMouseUp = (e) => {
    if (captured) send?.({ t: "mu", b: e.button });
  };
  const onWheel = (e) => {
    if (!captured) return;
    // libuiohook normalises rotation to whole notches and reports 0 for the
    // sub-notch deltas a precision touchpad or free-spinning wheel produces
    // (it accumulates the remainder until a full notch is reached). Forwarding
    // those would make the peer scroll on every tiny increment, so drop them.
    if (!e.rotation) return;
    send?.({ t: "wh", r: e.rotation, d: e.direction });
  };
  const onKeyDown = (e) => {
    pressed.add(e.keycode);
    // Panic combo wins over everything, even mid-capture.
    if (panic && hotkeyMatches(panic, pressed)) {
      pressed.clear();
      log.warn(`panic hotkey (${cfg.input.panicHotkey}) — 交还本地控制`);
      onPanic?.();
      return;
    }
    if (!captured) return;
    const c = u2n[e.keycode];
    if (c !== undefined) {
      // `c` is the nut-js Key, for a peer injecting through libnut/XTest.
      // `k` is the RAW uiohook keycode, which on Linux is also the kernel's
      // input event code (VC_A = KEY_A = 30, and so on across the alphanumeric
      // block). A peer injecting through uinput passes `k` straight to the
      // tool, so it needs no key table at all. Old peers ignore the extra field.
      send?.({ t: "kd", c, k: e.keycode });
    }
  };
  const onKeyUp = (e) => {
    pressed.delete(e.keycode);
    if (!captured) return;
    const c = u2n[e.keycode];
    if (c !== undefined) send?.({ t: "ku", c, k: e.keycode });
  };

  // Re-read the layout; if it changed (hotplug / resolution), adopt it and tell
  // the peer so its scaling source stays correct mid-session.
  function refreshGeometry() {
    invalidateScreenCache();
    const next = resolveGeometry(cfg, log);
    const same =
      next.signature === geo.signature &&
      next.EW === geo.EW &&
      next.EH === geo.EH &&
      next.EX === geo.EX &&
      next.EY === geo.EY &&
      next.W === geo.W &&
      next.H === geo.H;
    if (same) return;
    const before = `${geo.W}x${geo.H}`;
    geo = next;
    diagDone = false;
    log.info(`display layout changed (${before} -> ${geo.W}x${geo.H}): ${describe(geo, cfg)}`);
    log.info(`显示器:\n${describeMonitors(geo.monitors)}`);
    const line = describeEdge(edge, geo, cfg);
    if (line) log.info(line);
    if (captured) send?.({ t: "enter", vw: geo.W, vh: geo.H, edge: activeEdge || edge });
  }

  // Switch the shared edge without a restart. The client is told separately
  // (a lightweight "edge" message, NOT another "enter") so its return-home
  // direction follows without re-seeding the remote cursor position.
  function setEdge(next) {
    if (!DIRS.includes(next) && next !== "any") {
      log.warn(`忽略无法识别的共享边 "${next}"`);
      return false;
    }
    if (next === edge) return true;
    edge = next;
    activeEdge = next === "any" ? null : next;
    closest = Infinity;
    nearLogged = false;
    hinted = false;
    movesSeen = 0;
    startedAt = Date.now();
    log.info(`共享边切换为 ${next}`);
    const line = describeEdge(edge, geo, cfg);
    if (line) log.info(line);
    if (captured) send?.({ t: "edge", edge: activeEdge || next });
    return true;
  }

  // Called when the peer signals the cursor came back to its shared edge.
  function release() {
    if (!captured) return;
    armed = false; // require an inward move before capturing again
    setCaptured(false);
  }

  // The event names both backends speak.
  const BINDINGS = [
    ["mousemove", onMouseMove],
    ["mousedown", onMouseDown],
    ["mouseup", onMouseUp],
    ["wheel", onWheel],
    ["keydown", onKeyDown],
    ["keyup", onKeyUp],
  ];

  return {
    // Async because choosing and starting a backend can involve probing
    // /dev/input. Callers do not have to await it, but `stop()` must be safe if
    // they stop the node while this is still in flight -- hence the `active`
    // re-check after the await.
    async start() {
      if (active) return;
      active = true;
      const picked = await createCaptureBackend({ cfg, log });
      if (!active) {
        // Stopped while we were still probing. Do not attach anything.
        try {
          picked.backend?.stop();
        } catch {
          /* nothing started */
        }
        return;
      }
      if (!picked.backend) {
        log.error(
          "没有可用的输入捕获后端 —— 本机收不到鼠标键盘事件，无法作为服务器转发。" +
            "运行 `NetMouse --doctor` 看具体原因（Linux 上通常是 /dev/input 的权限）。"
        );
        return;
      }
      capture = picked.backend;
      relativeOnly = capture.positionKind === "relative";
      for (const [ev, fn] of BINDINGS) capture.on(ev, fn);
      pollTimer = setInterval(refreshGeometry, POLL_MS);
      if (pollTimer.unref) pollTimer.unref();
      if (relativeOnly) {
        log.info(
          `边缘触发方式：连续推向某一边（阈值约 ${pushTarget()}px）—— ` +
            "Wayland 下读不到光标位置，只能按手势判定"
        );
      }
      log.info(
        `input capture started (edge=${edge}, backend=${capture.name}); ` +
          `边缘按系统几何 ${geo.EX},${geo.EY} ${geo.EW}x${geo.EH}`
      );
    },
    release,
    setEdge,
    getEdge: () => edge,
    isCaptured: () => captured,
    getGeometry: () => ({ ...triggerBox(), desktop: desktopBox(), edge, activeEdge }),
    // Which backend is actually running, for the doctor and the self-test.
    captureStatus: () => (capture ? { name: capture.name, ...capture.status() } : null),
    stop() {
      if (!active) return;
      // Detach this session's listeners. Leaving them attached would make a
      // restarted node forward every event twice.
      if (capture) {
        for (const [ev, fn] of BINDINGS) capture.off(ev, fn);
        try {
          capture.stop();
        } catch (e) {
          log.debug("capture stop failed:", e.message);
        }
        capture = null;
      }
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      pressed.clear();
      active = false;
      relativeOnly = false;
      setCaptured(false);
      log.info("input capture stopped");
    },
  };
}

// Teleport the physical cursor to the middle of `box`. Used on capture and
// whenever the cursor nears a boundary, so it always has travel room and never
// clamps against a screen edge.
//
// Linux/X11 prefers xdotool (a tiny process spawn, cheaper than loading the
// injector just to warp); nut-js/libnut is the fallback on both platforms.
function recenterCursor(box, log) {
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  if (process.platform === "linux" && hasXdotool()) {
    execFile("xdotool", ["mousemove", String(x), String(y)], (err) => {
      if (err) noteRecenterFailure(log, `xdotool: ${err.message}`);
    });
    return;
  }
  try {
    // eslint-disable-next-line global-require
    const { mouse, Point } = require("@nut-tree-fork/nut-js");
    mouse
      .setPosition(new Point(x, y))
      .catch((e) => noteRecenterFailure(log, e && e.message));
  } catch (e) {
    noteRecenterFailure(log, e && e.message);
  }
}

// Re-centring the SERVER's own cursor is how it keeps travel room while the
// client owns the pointer. If that warp silently stops working the cursor pins
// itself to the shared edge, so it is worth saying out loud once -- the same
// class of silent failure that hid a completely dead client injection.
let recenterFailureReported = false;
function noteRecenterFailure(log, detail) {
  if (recenterFailureReported) return;
  recenterFailureReported = true;
  log?.warn(
    `无法把本机光标拉回屏幕中心（${detail}）—— 光标会卡在共享边上。\n` +
      "  → Linux 上装 xdotool 最省事：sudo apt install xdotool"
  );
}

// --- self-learned envelope (diagnostics only) ------------------------------
// Retained so the settings UI / selftest can reason about what the hook
// actually observes, and so the DPI-mismatch warning above has data. It is
// deliberately NOT used for edge detection — see the note on startServerInput.
function makeEnvelope(cfg) {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    seedW: cfg.layout.screenWidth || 1920,
    seedH: cfg.layout.screenHeight || 1080,
  };
}

function envelopeObserve(env, e) {
  if (e.x < env.minX) env.minX = e.x;
  if (e.y < env.minY) env.minY = e.y;
  if (e.x > env.maxX) env.maxX = e.x;
  if (e.y > env.maxY) env.maxY = e.y;
}

function envelopeBox(env) {
  const haveX = Number.isFinite(env.minX) && Number.isFinite(env.maxX);
  const haveY = Number.isFinite(env.minY) && Number.isFinite(env.maxY);
  const minX = haveX ? env.minX : 0;
  const minY = haveY ? env.minY : 0;
  const maxX = haveX ? env.maxX : minX + env.seedW;
  const maxY = haveY ? env.maxY : minY + env.seedH;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

module.exports = {
  startServerInput,
  ensureHook,
  stopHook,
  isHookStarted,
  hasXdotool,
  makeEnvelope,
  envelopeObserve,
  envelopeBox,
};

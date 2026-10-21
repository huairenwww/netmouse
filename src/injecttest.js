"use strict";
// ---------------------------------------------------------------------------
// Client-side injection self-test.
//
// `--hwtest` proves the SERVER side of this machine: geometry, edge detection
// and hand-over. It deliberately refuses to run on a client, because those
// things only exist on a server. That left the CLIENT side with no test at all
// -- and "the cursor does not move on the other machine" is exactly a
// client-side question.
//
// This test drives the REAL client injector (the very `createInjector()` the
// client role uses) with the REAL protocol messages, while the REAL global hook
// watches what actually reaches the operating system. Nothing is stubbed:
//
//   enter + mm      -> did the physical cursor move?
//   md / mu  1,2,3  -> did the OS see button 1, 2, 3 go down and up?
//   wh  -1 / +1     -> did the OS see one wheel notch each way?
//
// Three independent verdicts, because they are three independent code paths.
// "It doesn't work" is not actionable until you know which one is broken.
//
// Why this exists: every injection call in client-input.js used to end in
// `.catch(() => {})`. A machine whose injections were all being rejected still
// logged a perfectly cheerful session -- the tracked cursor position is pure
// arithmetic and keeps advancing regardless, so control even returned home on
// schedule. The symptom the user sees ("nothing happens over there") and the
// log ("looks fine") disagreed, and no tool could settle it.
//
// Run:  electron src/injecttest.js
//       NetMouse.exe --injecttest
//       NetMouse.exe --injecttest --out report.txt
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const platform = require("./platform");
const { loadConfig } = require("./config");
const { createInjector } = require("./client-input");
const { ensureHook, stopHook } = require("./server-input");
const { makeLog } = require("./hwtest");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// uiohook's button numbering. This is what a real hook reports and what the
// server puts on the wire -- NOT nut-js's enum (LEFT = 0, MIDDLE = 1,
// RIGHT = 2), which is a different numbering entirely.
const BUTTONS = [
  { code: 1, label: "左键" },
  { code: 2, label: "右键" },
  { code: 3, label: "中键" },
];

// A client whose injections are being rejected must not be able to hide behind
// a rounded-off coordinate: 8px is far tighter than any real rounding error and
// far looser than a cursor that never moved.
const MOVE_TOLERANCE = 8;

function argOf(argv, name, dflt = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

// ---------------------------------------------------------------------------
// The motion half, kept separate and pure enough to unit-test: given the box we
// are injecting into, how far should six steps move the cursor, and did the
// real cursor actually get there?
// ---------------------------------------------------------------------------
function motionPlan(box, steps = 6, divisor = 16) {
  const dx = Math.max(1, Math.floor(box.width / divisor));
  const dy = Math.max(1, Math.floor(box.height / divisor));
  const from = { x: box.x + Math.floor(box.width / 2), y: box.y + Math.floor(box.height / 2) };
  return {
    dx,
    dy,
    steps,
    from,
    to: { x: from.x + dx * steps, y: from.y + dy * steps },
  };
}

// Did the real cursor move by as much as we asked it to?
//
// This compares DISPLACEMENT, not absolute position, and that matters:
//
//   * The uinput backends can only move relatively (a kernel mouse has no
//     "teleport" primitive -- dotool's mouseto is a fraction of the output and
//     ydotool has nothing at all), so the real cursor starts wherever the
//     user's own hand left it and can never be expected to sit on the computed
//     centre. An absolute comparison would call that a failure.
//   * Displacement is also the more honest question. "We asked for +960,+540
//     and the cursor moved +960,+540" is exactly what the server->client path
//     promises, whatever the starting point was.
//
// `before` is measured immediately before the motion burst. When it cannot be
// read at all, fall back to the absolute target (which is only sound when the
// hand-over seeding worked, i.e. on the XTest path).
function motionVerdict(plan, before, after, tolerance = MOVE_TOLERANCE) {
  if (!after) return { ok: false, reason: "no-cursor", off: null };
  const expected = { x: plan.dx * plan.steps, y: plan.dy * plan.steps };
  if (before) {
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    if (dx === 0 && dy === 0) return { ok: false, reason: "did-not-move", off: null, dx, dy };
    const off = Math.max(Math.abs(dx - expected.x), Math.abs(dy - expected.y));
    return {
      ok: off <= tolerance,
      reason: off <= tolerance ? "ok" : "off-target",
      off,
      dx,
      dy,
      expected,
    };
  }
  const off = Math.max(Math.abs(after.x - plan.to.x), Math.abs(after.y - plan.to.y));
  return { ok: off <= tolerance, reason: off <= tolerance ? "ok" : "off-target", off, expected };
}

async function runInjectTest(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const outPath = opts.outPath || argOf(argv, "--out", null);
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

  const info = platform.platformInfo();

  say("NetMouse 本机注入自检（客户端侧）");
  say(`生成时间 : ${new Date().toLocaleString()}`);
  say(`平台     : ${info.label} ${info.arch}  (${info.platform})`);
  say(`运行环境 : Electron ${process.versions.electron || "（无）"} / Node ${process.versions.node}`);
  say(
    `会话     : ${info.sessionType || "-"}${
      info.display ? `  DISPLAY=${info.display}` : "  无 DISPLAY"
    }`
  );
  say("");
  say("检验的是「这台机器能不能真的驱动自己的光标 / 按键 / 滚轮」。");
  say("走的是客户端真正使用的注入路径，原生层没有任何替身。");
  say("");

  // --- environment ---------------------------------------------------------
  say("运行环境检查");
  if (!info.warnings.length) {
    say("  ✓ 没有发现会话 / 依赖方面的已知问题");
  } else {
    for (const w of info.warnings) say(`  ! ${w}`);
  }
  if (info.platform === "linux") {
    say(
      `  会话类型 ${info.sessionType || "（未知）"}` +
        (info.wayland
          ? "（Wayland：XTest 注入不会到达原生应用，见下面的「注入后端」）"
          : "（X11：XTest 可用）")
    );
  }
  say("");

  const snap = platform.diagSnapshot();
  const virtual = snap.virtual;
  if (!virtual || !virtual.width) {
    say("✗ 读不到任何显示器几何，自检中止。");
    say("  纯 Node 下没有 Electron screen 模块，请用 Electron 运行：");
    say("    unset ELECTRON_RUN_AS_NODE && electron src/injecttest.js");
    if (outPath) fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
    return 2;
  }
  say("本机桌面");
  say(`  ${virtual.width}x${virtual.height} @ (${virtual.x},${virtual.y})`);
  if (snap.monitors && snap.monitors.length) {
    for (const m of snap.monitors) {
      say(
        `  ${m.primary ? "[主]" : "    "} ${m.width}x${m.height}@(${m.x},${m.y})` +
          `${m.scaleFactor ? ` scale=${m.scaleFactor}` : ""}`
      );
    }
  }
  say("");

  // --- native stack --------------------------------------------------------
  say("原生注入栈");
  let nut;
  try {
    nut = require("@nut-tree-fork/nut-js");
    say("  ✓ nut-js 加载成功");
  } catch (e) {
    say(`  ✗ nut-js 加载失败：${e.message}`);
    say("    → 客户端完全无法注入。请检查安装是否完整（libnut 原生模块）。");
    if (outPath) fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
    return 2;
  }
  const { mouse, Button } = nut;

  const cfg = opts.cfg || loadConfig();
  const log = makeLog();
  const inject = createInjector({ cfg, log });

  // Which injector this machine will actually drive.
  //
  // This is not cosmetic. Under Wayland XTest accepts every call and delivers
  // the events to nobody, so a green "cursor moved" from an XTest client on a
  // Wayland session is worse than useless -- the hook sees the event (Xwayland
  // does synthesise it) while the compositor ignores the pointer warp. The
  // result is marked untrustworthy rather than reported as a pass.
  const backend = inject.getBackend ? inject.getBackend() : null;
  const unreliable = !!backend && backend.active === "xtest" && info.wayland;
  if (backend) {
    say("注入后端");
    say(
      `  ${backend.active}${backend.tool ? `（${backend.tool}）` : ""} —— ${backend.reason}`
    );
    if (backend.capabilities) {
      const c = backend.capabilities;
      say(
        `  能力：移动 ✓ / 按键 ✓ / 滚轮 ${c.wheel ? "✓" : "✗ 该工具不支持"} / ` +
          `键盘 ${c.keyboard ? "✓" : "✗"}`
      );
    }
    // ydotool is a pure client: without ydotoold every call exits 2 and nothing
    // happens at all. Which of "reused", "we started one" or "could not start
    // one" it is decides whether the numbers below mean anything.
    if (backend.daemon) {
      const d = backend.daemon;
      say(`  ydotoold：${d.label || d.mode}${d.pid ? `（pid ${d.pid}）` : ""}`);
      if (d.socketPath) say(`    socket: ${d.socketPath}`);
      // "未检测" here means the daemon has not been resolved YET -- the tests
      // below resolve it. Printing only that made the report contradict itself
      // ("未检测" above, "不可用" at the bottom) and sent readers looking for a
      // failure that had not happened yet.
      if (d.mode === "unknown") {
        say("    还没拉起 —— 下面的测试会先把它拉起来，跑完再看末尾的真实状态");
      } else if (!d.ok && d.note) {
        say(`    ! ${d.note.split("\n").join("\n      ")}`);
      }
    }
    if (unreliable) {
      say("");
      say("  ✗✗ 不可信：这是 Wayland 会话，却在用 XTest 注入。");
      say("     Xwayland 实现了 XTest，所以下面每一次调用都会「成功」，");
      say("     事件却只送给 X11 窗口，原生应用收不到，合成器也不会移动光标。");
      say("     本机自检看到的事件是 Xwayland 合成的假象 —— 结论一律不算数。");
      say("     请先解决后端：装 uinput 工具（sudo apt install -y ydotool，");
      say("     ydotoold 由本程序自动拉起），input.backend 保持 auto。");
      say("     若你的发行版仍提供 Xorg 会话，选它也能立刻解决。");
    }
    say("");
  }

  // Remember where the user's cursor was; put it back at the end.
  let original = null;
  try {
    const p = await mouse.getPosition();
    original = { x: p.x, y: p.y };
  } catch (e) {
    say(`  ! 读不到当前光标位置：${e.message}（这本身就是一个注入/读取权限问题）`);
  }

  const restore = async () => {
    if (!original) return;
    try {
      await mouse.setPosition(new nut.Point(original.x, original.y));
    } catch {
      /* best effort */
    }
  };

  const results = { motion: null, buttons: [], wheel: [] };
  let hookOk = true;

  try {
    // The hook is what makes this test trustworthy: it is the only thing that
    // can tell "nut-js accepted the call" apart from "the operating system
    // actually did it".
    try {
      ensureHook();
    } catch (e) {
      hookOk = false;
      say(`  ! 全局钩子启动失败：${e.message}`);
      say("    → 将退化为「只能证明调用没抛异常」，不能证明系统真的执行了。");
    }
    await sleep(350);

    const { uIOhook } = require("uiohook-napi");
    const seen = [];
    const onDown = (e) => seen.push({ k: "down", b: e.button });
    const onUp = (e) => seen.push({ k: "up", b: e.button });
    const onWheel = (e) => seen.push({ k: "wheel", r: e.rotation, d: e.direction });
    if (hookOk) {
      uIOhook.on("mousedown", onDown);
      uIOhook.on("mouseup", onUp);
      uIOhook.on("wheel", onWheel);
    }

    // -----------------------------------------------------------------------
    // 1. motion
    // -----------------------------------------------------------------------
    say("① 光标移动（走客户端真实的 enter + mm 路径）");
    const enterMsg = {
      t: "enter",
      vw: virtual.width,
      vh: virtual.height,
      edge: "right", // only used to pick a home edge in app.js; irrelevant here
    };
    await inject.handle(enterMsg);

    // `enter` seeds the cursor asynchronously (it has to read the local desktop
    // first), so wait for the box rather than guessing a delay.
    for (let i = 0; i < 60 && !inject.getLocalBox(); i += 1) await sleep(25);
    const box = inject.getLocalBox();
    if (!box) {
      say("  ✗ 读不到本机桌面尺寸，无法给出位移判据");
    } else {
      const plan = motionPlan(box);
      await sleep(200);
      const before = await mouse.getPosition().catch(() => null);
      say(
        `  桌面 ${box.width}x${box.height}@(${box.x},${box.y})   起始光标 ` +
          `(${before ? `${before.x},${before.y}` : "—"})   本段应位移 ` +
          `+${plan.dx * plan.steps},+${plan.dy * plan.steps}`
      );

      for (let i = 0; i < plan.steps; i += 1) {
        await inject.handle({ t: "mm", dx: plan.dx, dy: plan.dy });
        await sleep(30); // let the coalesced flush land
      }
      await sleep(250);

      const tracked = inject.getTrackedPosition();
      const after = await mouse.getPosition().catch(() => null);
      const v = motionVerdict(plan, before, after);
      results.motion = { ...v, plan, tracked, before, after };

      say(
        `  实际光标 (${after ? `${after.x},${after.y}` : "—"})   位移 ` +
          `${v.dx === undefined ? "—" : `+${v.dx},+${v.dy}`}   偏差 ${
            v.off === null ? "—" : `${v.off}px`
          }  ${v.ok ? "✓" : "✗"}`
      );
      if (v.reason === "did-not-move") {
        say("         ✗ 光标完全没动 —— 注入调用被系统忽略或拒绝。");
      } else if (v.reason === "off-target") {
        say(`         ✗ 光标动了，但没到目标位置（偏差 ${v.off}px）。`);
        say("           若测试期间碰过鼠标，请重跑一次并把手离开鼠标。");
      }
    }
    say("");

    // -----------------------------------------------------------------------
    // 2. buttons
    // -----------------------------------------------------------------------
    say("② 按键（走客户端真实的 md / mu 路径）");
    if (!hookOk) {
      say("  ! 全局钩子没起来：只能证明「调用没抛异常」，不能证明系统真的执行了。");
    }
    for (const c of BUTTONS) {
      if (hookOk) seen.length = 0;
      let err = null;
      try {
        await inject.handle({ t: "md", b: c.code });
        await sleep(70);
        await inject.handle({ t: "mu", b: c.code });
        await sleep(150);
      } catch (e) {
        err = e.message;
      }
      const down = seen.find((s) => s.k === "down");
      const up = seen.find((s) => s.k === "up");
      // Without the hook we can only say "nut-js accepted it" -- never dress
      // that up as a verified success.
      const verified = hookOk;
      const ok = !err && (!verified || (!!down && down.b === c.code && !!up && up.b === c.code));
      results.buttons.push({ code: c.code, label: c.label, ok, verified, down, up, err });
      say(
        `  ${c.label}  ` +
          (verified
            ? `真实钩子报按下=${down ? down.b : "—"} 松开=${up ? up.b : "—"}`
            : "（钩子不可用，未验证）") +
          `  ${ok ? "✓" : "✗"}`
      );
      if (err) say(`         ✗ 注入抛异常：${err}`);
      else if (verified && !down) say("         ✗ 钩子没看到这次按下 —— 注入被系统忽略了。");
    }
    say("");

    // -----------------------------------------------------------------------
    // 3. wheel
    // -----------------------------------------------------------------------
    const unit =
      Number(cfg.input && cfg.input.scrollUnit) > 0
        ? Number(cfg.input.scrollUnit)
        : platform.scrollUnit();
    say(`③ 滚轮（走客户端真实的 wh 路径；本机一格 = ${unit} 个单位）`);
    const wheelCases = [
      { r: -1, label: "向上", expect: -1 },
      { r: 1, label: "向下", expect: 1 },
    ];
    for (const c of wheelCases) {
      if (hookOk) seen.length = 0;
      let err = null;
      try {
        await inject.handle({ t: "wh", r: c.r, d: 3 });
        await sleep(180);
      } catch (e) {
        err = e.message;
      }
      const w = seen.find((s) => s.k === "wheel");
      const verified = hookOk;
      const ok = !err && (!verified || (!!w && w.r === c.expect));
      results.wheel.push({
        label: c.label,
        expect: c.expect,
        raw: w ? w.r : null,
        ok,
        verified,
        err,
      });
      say(
        `  滚轮${c.label}  ` +
          (verified
            ? `真实钩子报 rotation=${w ? w.r : "—"}（方向 ${w ? w.d : "—"}）`
            : "（钩子不可用，未验证）") +
          `  ${ok ? "✓" : "✗"}`
      );
      if (err) say(`         ✗ 注入抛异常：${err}`);
      else if (verified && !w) say("         ✗ 钩子没看到这次滚轮事件 —— 注入被系统忽略了。");
    }
    say("");

    if (hookOk) {
      uIOhook.off("mousedown", onDown);
      uIOhook.off("mouseup", onUp);
      uIOhook.off("wheel", onWheel);
    }
  } finally {
    await restore();
    if (stopHookAfter) {
      try {
        stopHook();
      } catch {
        /* ignore */
      }
    }
  }

  // --- what the injector itself recorded -----------------------------------
  const health = inject.getInjectionHealth ? inject.getInjectionHealth() : null;
  if (health) {
    say("注入器自身的计数");
    say(`  成功 ${health.applied} 次，失败 ${health.errors} 次`);
    if (health.errors) {
      say(`  最近一次失败：${health.lastError}`);
      say("  （这就是 client-input.js 以前用 .catch(() => {}) 吞掉的东西）");
    }
    say("");
  }

  // --- the daemon, as it ended up -------------------------------------------
  // The section at the top can only say "not resolved yet" (nothing had run).
  // This is the answer, and it is the first thing to look at when injection
  // failed: a daemon that never came up explains every ✗ above at once.
  if (backend.daemon) {
    const d = backend.daemon;
    say("ydotoold 最终状态");
    say(`  ${d.label || d.mode}${d.pid ? `（pid ${d.pid}）` : ""}`);
    if (d.socketPath) say(`  socket: ${d.socketPath}`);
    if (!d.ok && d.note) say(`  ! ${d.note.split("\n").join("\n    ")}`);
    say("");
  }

  // --- verdict -------------------------------------------------------------
  say("结论");
  const motionOk = !!results.motion && results.motion.ok;
  const badButtons = results.buttons.filter((b) => !b.ok);
  const badWheel = results.wheel.filter((w) => !w.ok);
  const buttonsOk = results.buttons.length > 0 && !badButtons.length;
  const wheelOk = results.wheel.length > 0 && !badWheel.length;
  const allOk = motionOk && buttonsOk && wheelOk;

  if (unreliable) {
    // Deliberately checked BEFORE the green path: on Wayland the XTest numbers
    // above are produced by Xwayland synthesising the very events we injected,
    // so they can be perfect and still mean nothing.
    say("  ✗ 结论不可用：Wayland 会话 + XTest 后端。");
    say("     上面无论显示什么（哪怕全是 ✓），都不能证明对端能收到输入 ——");
    say("     Xwayland 会把我们注入的事件原样回放给本机钩子，看起来一切正常。");
    say("     先修好后端再重跑：sudo apt install -y ydotool（ydotoold 由本程序");
    say("     自动拉起，无需配置服务），input.backend 保持 auto。");
    say("     若你的发行版仍提供 Xorg 会话，登录时选它也能立刻解决。");
    say("");
  } else if (allOk) {
    say("  ✓ 光标、按键、滚轮三项全部通过。");
    say("    本机作为客户端可以正常注入 —— 若对端仍然没反应，");
    say("    问题在服务器那台（是否真的发出去了）或两端之间的网络。");
    if (!hookOk) {
      say("    ! 但全局钩子没起来，按键与滚轮只是「调用没报错」，不算已验证。");
    }
  } else {
    if (!motionOk) {
      say("  ✗ 光标移动失败 —— 本机连自己的光标都驱动不了。");
      if (health && health.errors > 0) {
        say(`    注入调用被系统拒绝 ${health.errors} 次，最近一次：${health.lastError}`);
        say("    这就是「对端鼠标不动」的直接原因。");
      } else if (results.motion && results.motion.reason === "off-target") {
        say("    注入没有报错，但光标没到位 —— 若测试期间碰过鼠标，先重跑一次。");
      } else {
        say("    注入调用没有报错，系统却没有执行 —— 多半是合成器或安全软件忽略了注入。");
      }
      if (info.platform === "linux") {
        say("");
        say("    Linux 上按这个顺序查：");
        say("      1. 注入后端是不是 XTest —— 纯 Wayland 下合成器会忽略 XTest 注入，");
        say("         而且调用会「成功」，日志看不出任何异常。装 uinput 工具即可：");
        say("         sudo apt install -y ydotool（ydotoold 由本程序自动拉起）。");
        say("         若发行版仍提供 Xorg 会话，选它也能立刻解决。");
        say("      2. 用 ydotool 时 /dev/uinput 是否可写（doctor 会给出确切修法）。");
        say("      3. 是不是在 SSH / 非图形环境下启动的（没有 DISPLAY）。");
        say("      4. X11 库是否齐全：libx11-6 libxtst6 libxt6 libxrandr2");
        say("         用 NetMouse --doctor 逐项检查。");
      } else if (info.platform === "win32") {
        say("    Windows 上检查：安全软件 / UAC 是否拦截了 SendInput，");
        say("    以及本程序是否运行在更高完整性级别的窗口之上。");
      }
    }
    if (!buttonsOk) {
      say(
        `  ✗ 按键失败：${badButtons.map((b) => b.label).join("、")}` +
          " —— 光标能动但按键不动，说明是按键注入被拒。"
      );
    }
    if (!wheelOk) {
      say(
        `  ✗ 滚轮失败：${badWheel.map((w) => w.label).join("、")}` +
          " —— 若滚轮方向反了，用 input.scrollUnit 调（当前按平台自动）。"
      );
    }
    if (!hookOk) {
      say("  ! 全局钩子没起来，按键与滚轮只能算「未验证」（注入调用没报错而已）。");
      say("    先解决钩子问题再重跑，否则这一半的结论不可信。");
    }
    say("");
    say("  请把本报告完整发出来。");
  }

  if (outPath) {
    fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
    console.log(`\n报告已写入 ${outPath}`);
  }

  if (unreliable) return 1;
  return allOk ? 0 : 1;
}

// --- standalone entry ------------------------------------------------------
// `require.main === module` is NOT enough in Electron's main process (it points
// at Electron's own bootstrap) -- the same trap documented in diag.js/hwtest.js.
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

if (isEntryScript()) {
  const { app } = require("electron");
  if (!app || typeof app.whenReady !== "function") {
    console.error(
      "注入自检需要真正的 Electron 运行时（纯 Node 拿不到屏幕几何）。\n" +
        "  unset ELECTRON_RUN_AS_NODE && electron src/injecttest.js"
    );
    process.exit(3);
  }
  try {
    app.disableHardwareAcceleration();
  } catch {
    /* not fatal */
  }
  app.whenReady().then(async () => {
    let code = 1;
    try {
      code = await runInjectTest();
    } catch (e) {
      console.error("注入自检异常：", e && e.stack ? e.stack : e);
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

module.exports = { runInjectTest, motionPlan, motionVerdict, MOVE_TOLERANCE, BUTTONS };

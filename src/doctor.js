#!/usr/bin/env node
// ---------------------------------------------------------------------------
// NetMouse doctor: verify that THIS machine can actually run NetMouse, and say
// exactly what is missing if it cannot.
//
// Run on both machines before pairing them:
//
//   node src/doctor.js              # static checks only (safe, instant)
//   node src/doctor.js --inject     # also move the cursor 1px to prove injection
//   node src/doctor.js --hook       # also start the global hook for 3s
//
// Exit code 0 = no FAIL lines, 1 = at least one FAIL.
// ---------------------------------------------------------------------------
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const DO_INJECT = argv.includes("--inject");
const DO_HOOK = argv.includes("--hook");

const results = [];

// Where report lines go. Default is the console, but the diagnostic bundle
// (src/diagbundle.js) redirects this into a string so the doctor's findings can
// be shipped to whoever is helping debug. Keeping one sink means the collected
// text is byte-identical to what the user sees on screen -- a bundle that
// disagrees with the terminal would be worse than no bundle.
let sink = null;
function write(line) {
  if (sink) sink(line);
  else console.log(line);
}

const ok = (name, detail = "") => {
  results.push({ level: "ok", name });
  write(`  \u2713 ${name}${detail ? `  — ${detail}` : ""}`);
};
const warn = (name, detail = "") => {
  results.push({ level: "warn", name });
  write(`  ! ${name}${detail ? `  — ${detail}` : ""}`);
};
const fail = (name, detail = "") => {
  results.push({ level: "fail", name });
  write(`  \u2717 ${name}${detail ? `  — ${detail}` : ""}`);
};
const section = (t) => write(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isLinux = process.platform === "linux";

// First candidate path that actually accepts a connection. A crashed daemon
// leaves its socket file behind, so existence is not evidence of anything.
async function firstLive(paths, probe) {
  for (const p of paths) {
    if (await probe(p)) return p;
  }
  return null;
}

// How many /dev/input/eventN nodes can be opened. This is the gate on the evdev
// capture backend, and it is the same permission story as /dev/uinput (group
// `input`, mode 0660) -- so one install step fixes both. Never throws: the
// doctor has to be able to report "cannot even look" as a finding.
function evdevProbe() {
  if (!isLinux) return { total: 0, readable: 0 };
  const fsm = require("fs");
  try {
    const names = fsm.readdirSync("/dev/input").filter((n) => /^event\d+$/.test(n));
    let readable = 0;
    for (const n of names) {
      try {
        fsm.accessSync(`/dev/input/${n}`, fsm.constants.R_OK);
        readable += 1;
      } catch {
        /* denied, or gone */
      }
    }
    return { total: names.length, readable };
  } catch {
    return { total: 0, readable: 0 };
  }
}

async function runDoctor(opts = {}) {
  // `results` is module-level so the helpers above can push into it, but that
  // means a second call would inherit the first run's findings and double-count
  // them. The bundle runs the doctor in-process, so reset explicitly.
  results.length = 0;

  // The live probes are opt-in. A caller can override what the command line
  // asked for -- the bundle wants the static checks only, because its live
  // coverage already comes from the injection self-test it runs separately.
  const doInject = opts.inject ?? DO_INJECT;
  const doHook = opts.hook ?? DO_HOOK;

  // --- 1. runtime ----------------------------------------------------------
  section("Runtime");
  ok("platform", `${process.platform} ${process.arch}`);
  ok("node", process.versions.node);
  if (process.versions.electron) ok("electron", process.versions.electron);
  else warn("electron", "plain node (GUI unavailable; headless mode only)");

  // --- 2. display session (Linux) -----------------------------------------
  if (isLinux) {
    section("Display session (Linux)");
    const sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
    const display = process.env.DISPLAY || "";
    const wayland = process.env.WAYLAND_DISPLAY || "";
    const ev = evdevProbe();
    if (sessionType === "wayland" && !display) {
      // This used to be an unconditional FAIL. It stopped being true when the
      // evdev capture backend landed: /dev/input is the kernel's stream and
      // needs no DISPLAY at all, so "no Xwayland" is now only fatal when the
      // device nodes are unreadable too.
      if (ev.readable) {
        warn(
          "Wayland without DISPLAY",
          `the X11 hook cannot work, but ${ev.readable}/${ev.total} /dev/input device(s) are ` +
            "readable — capture will use the evdev backend instead. Not a problem."
        );
      } else {
        fail(
          "Wayland without DISPLAY, and /dev/input is unreadable",
          `no DISPLAY for the X11 hook, and 0/${ev.total} /dev/input device(s) can be opened. ` +
            "This machine cannot be the SERVER. Fix the device permissions (group `input`): " +
            "sudo ./install-linux.sh --uinput, then log out and back in."
        );
      }
    } else if (wayland && display) {
      warn(
        "Wayland via Xwayland",
        `DISPLAY=${display} — capture works only while an X11 window has focus` +
          (ev.readable
            ? `; the evdev backend is available too (${ev.readable} device(s)), and auto prefers it.`
            : "; evdev is unavailable, so capture really will stop when a Wayland window is focused.") +
          " Injection does NOT work through XTest — see Client-role injection below."
      );
    } else if (!display) {
      fail("no DISPLAY", "cannot reach X11; set DISPLAY/XAUTHORITY, or use an Xorg session");
    } else {
      ok(
        "X11 session",
        `DISPLAY=${display}${process.env.XAUTHORITY ? ` XAUTHORITY=${process.env.XAUTHORITY}` : ""}`
      );
    }
  }

  // --- 2b. server-role capture --------------------------------------------
  // Which backend will actually read the local mouse and keyboard. Worth its
  // own section because getting it wrong is invisible: the node looks healthy
  // and simply never forwards anything.
  if (isLinux) {
    section("Server-role capture");
    const ev = evdevProbe();
    const wayland = !!(process.env.WAYLAND_DISPLAY || (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland");
    let chosen = "uiohook";
    try {
      chosen = require("./capture").chooseCapture({
        mode: cfg?.input?.capture,
        platform: process.platform,
        isWayland: wayland,
      });
    } catch (e) {
      fail("capture selector unavailable", e.message);
    }
    ok("capture backend selected", `${chosen} (input.capture=${cfg?.input?.capture || "auto"})`);
    if (!wayland) {
      ok("uiohook on X11", "absolute positions, no extra permissions needed");
    } else if (ev.readable) {
      ok(
        "evdev available",
        `${ev.readable}/${ev.total} /dev/input device(s) readable — capture survives Wayland`
      );
      warn(
        "evdev has no absolute position",
        "Wayland does not expose the pointer position, so the shared edge triggers on a " +
          '"push toward that edge" gesture (~35% of the short side) instead of "cursor at the edge".'
      );
    } else {
      fail(
        "evdev unavailable",
        `/dev/input: 0 of ${ev.total} device(s) readable. Under Wayland this means capture ` +
          "falls back to Xwayland and only works while an X11 window has focus. " +
          "Fix: sudo ./install-linux.sh --uinput, then log out and back in " +
          "(being in /etc/group is not enough until the session is re-created)."
      );
    }
  }

  // --- 3. native modules load ---------------------------------------------
  section("Native input stack");
  let uio = null;
  let nut = null;
  try {
    uio = require("uiohook-napi");
    ok("uiohook-napi loads", "global mouse/keyboard capture");
  } catch (e) {
    fail("uiohook-napi failed to load", e.message);
  }
  try {
    nut = require("@nut-tree-fork/nut-js");
    ok("nut-js loads", "mouse/keyboard injection");
  } catch (e) {
    fail("nut-js failed to load", e.message);
  }

  // --- 4. Linux shared libraries ------------------------------------------
  if (isLinux) {
    section("X11 libraries");
    const needed = [
      ["libX11.so.6", "libx11-6"],
      ["libXtst.so.6", "libxtst6"],
      ["libXt.so.6", "libxt6"],
      ["libXrandr.so.2", "libxrandr2"],
    ];
    let ldconfig = "";
    try {
      ldconfig = spawnSync("ldconfig", ["-p"], { encoding: "utf8" }).stdout || "";
    } catch {
      /* ignore */
    }
    for (const [lib, pkg] of needed) {
      if (!ldconfig) warn(`cannot check ${lib}`, "ldconfig unavailable");
      else if (ldconfig.includes(lib)) ok(lib, `present (${pkg})`);
      else fail(`${lib} missing`, `sudo apt install ${pkg}`);
    }

    section("Server-role helper");
    const hasXdotool = spawnSync("which", ["xdotool"], { stdio: "ignore" }).status === 0;
    if (hasXdotool) ok("xdotool", "present (server can re-centre its cursor)");
    else warn("xdotool missing", "only needed when this machine is the SERVER: sudo apt install xdotool");

    // --- 4b. can this machine INJECT? ------------------------------------
    //
    // Separate from the capture checks above, and the distinction matters:
    // under Wayland capture still works through Xwayland while injection
    // silently does nothing. That asymmetry is the whole reason a client can
    // log a perfectly healthy session while the far cursor never moves.
    section("Client-role injection");
    const { isWaylandSession } = require("./platform");
    const { detectUinputTool, describeTool, TOOLS } = require("./inject-uinput");
    const {
      uinputAccess,
      externalSocketCandidates,
      socketAlive,
      lookupBin,
      DAEMON_BIN,
    } = require("./ydotoold");
    const wayland = isWaylandSession();
    const tool = detectUinputTool();
    if (!wayland) {
      ok("X11 session", "libnut/XTest injection works here");
    } else if (tool) {
      const info = describeTool(tool);
      ok(`uinput tool: ${tool}`, info.caps);
      // Which copy will actually run. The Linux build ships one, so "bundled"
      // is the normal answer; "system" means an apt install is in use and the
      // bundled copy is (correctly) ignored.
      const look = lookupBin(TOOLS[tool].bin);
      ok(
        `${TOOLS[tool].bin} (${look.source === "bundled" ? "bundled" : "system"})`,
        look.path
      );
      const access = uinputAccess();
      if (access.writable) {
        ok("/dev/uinput writable", "a virtual input device can be created");
      } else {
        fail("/dev/uinput not writable", access.hint);
      }
      // ydotool is a pure client: without ydotoold every call exits 2. NetMouse
      // starts one itself, so report which of the three cases we are in rather
      // than just "it is not running".
      if (TOOLS[tool].daemon) {
        const live = await firstLive(externalSocketCandidates(), socketAlive);
        if (live) {
          ok(`${DAEMON_BIN} already running`, `${live} — will be reused, not touched`);
        } else if (!access.writable) {
          warn(
            `${DAEMON_BIN} not running`,
            "and it cannot be started without /dev/uinput access (see above)"
          );
        } else {
          ok(
            `${DAEMON_BIN} not running`,
            "NetMouse will start a private one and stop it on exit — nothing to do"
          );
        }
      } else {
        ok(`${tool} needs no daemon`, "it owns its virtual input device directly");
      }
    } else {
      warn(
        "Wayland session with no uinput tool",
        "as a CLIENT, XTest injection will appear to succeed and do nothing. " +
          "Install one: sudo apt install -y ydotool"
      );
    }
  }

  // --- 5. screen geometry --------------------------------------------------
  section("Screen geometry");
  try {
    const { getScreenInfo } = require("./platform");
    const info = getScreenInfo();
    if (info.virtual && info.virtual.width > 0) {
      ok(
        "virtual desktop",
        `${info.virtual.width}x${info.virtual.height} @ (${info.virtual.x},${info.virtual.y})`
      );
      ok("monitors", `${info.monitors.length}: ${info.monitors.map((m) => m.sig).join(", ")}`);
    } else {
      warn(
        "virtual desktop unknown",
        "no Electron screen and no xrandr/PowerShell result; config layout.screenWidth/Height will be used"
      );
    }
  } catch (e) {
    warn("geometry detection failed", e.message);
  }

  // --- 6. live hook (optional) --------------------------------------------
  if (doHook) {
    section("Global hook (3s)");
    if (!uio) {
      fail("hook test skipped", "uiohook-napi did not load");
    } else {
      let hit = false;
      const onMove = () => {
        hit = true;
      };
      try {
        uio.uIOhook.on("mousemove", onMove);
        uio.uIOhook.start();
        const end = Date.now() + 3000;
        while (Date.now() < end && !hit) await sleep(50);
        uio.uIOhook.off("mousemove", onMove);
        uio.uIOhook.stop();
        if (hit) ok("hook captured a mouse move", "capture path works");
        else warn("no mouse move seen in 3s", "move the mouse during the test to confirm");
      } catch (e) {
        fail("hook failed to start", e.message);
      }
    }
  }

  // --- 7. live injection (optional) ---------------------------------------
  if (doInject) {
    section("Injection");
    if (!nut) {
      fail("injection test skipped", "nut-js did not load");
    } else {
      try {
        const { mouse, Point } = nut;
        const start = await mouse.getPosition();
        await mouse.setPosition(new Point(start.x + 1, start.y));
        const after = await mouse.getPosition();
        await mouse.setPosition(start);
        if (after.x !== start.x) ok("injection works", `moved ${start.x} -> ${after.x} and back`);
        else
          warn(
            "cursor did not move",
            "X11/XTest may be blocked (Wayland?). Full check: npm run injecttest"
          );
      } catch (e) {
        fail(
          "injection failed",
          `${e.message} —— 完整诊断：npm run injecttest（或 NetMouse --injecttest）`
        );
      }
    }
  }

  // --- verdict -------------------------------------------------------------
  const fails = results.filter((r) => r.level === "fail");
  const warns = results.filter((r) => r.level === "warn");
  write(
    `\n${fails.length === 0 ? "DOCTOR PASS" : "DOCTOR FAIL"} — ` +
      `${results.length - fails.length - warns.length} ok, ${warns.length} warn, ${fails.length} fail`
  );
  if (fails.length) {
    write("\nFix the FAIL lines above, then re-run. See docs/开发记录.md for the checklist.");
  }
  return fails.length === 0 ? 0 : 1;
}

// Same run, but returning the text instead of printing it. Used by the
// diagnostic bundle so the report it ships matches the terminal output exactly.
async function runDoctorText({ inject = false, hook = false } = {}) {
  const lines = [];
  const previous = sink;
  sink = (line) => lines.push(String(line));
  try {
    // The flags are read from process.argv at module load, so a caller that
    // wants the live probes has to say so explicitly here.
    const code = await runDoctor({ inject, hook });
    return { code, text: lines.join("\n") + "\n", results: results.slice() };
  } finally {
    sink = previous;
  }
}

// Export so the packaged app can run it too (`NetMouse --doctor`). The doctor is
// the single most useful diagnostic here, and until now it was unreachable from
// a downloaded build -- the user had to have the source and a node toolchain.
module.exports = { runDoctor, runDoctorText };

// Auto-run only when invoked as a script, so requiring it has no side effect.
if (require.main === module) {
  runDoctor()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("doctor crashed:", e);
      process.exit(2);
    });
}

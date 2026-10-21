"use strict";
// ---------------------------------------------------------------------------
// Unit tests for the uinput injection backend and the backend selection.
//
// Why this file exists
// --------------------
// The uinput backend is the only thing that can inject under Wayland, and the
// machine that builds the release cannot test it (there is no Wayland session
// here, and often no Linux at all). So the parts that CAN be pinned down are
// pinned down hard:
//
//   * the exact command language of dotool and ydotool (one wrong word and the
//     tool silently does nothing, which looks exactly like the bug we are
//     fixing);
//   * the three different mouse-button numberings that meet in this code
//     (uiohook, nut-js, and each tool's own);
//   * that uiohook keycodes really are Linux input event codes, which is the
//     whole reason the keyboard needs no translation table;
//   * which backend gets picked in which session.
//
// The transport is tested with a fake `spawn`, so no tool has to be installed.
// ---------------------------------------------------------------------------
const assert = require("assert");
const { EventEmitter } = require("events");

const {
  dotoolLine,
  ydotoolArgs,
  detectUinputTool,
  describeTool,
  toolSpec,
  createUinputInjector,
  DOTOOL_BUTTON,
  YDOTOOL_BUTTON,
  TOOLS,
} = require("../src/inject-uinput");

const { Button, Key } = require("@nut-tree-fork/nut-js");
// UiohookKey lives in the capture package, not in nut-js -- they are two
// different libraries with two different numbering schemes, which is the point.
const { UiohookKey } = require("uiohook-napi");
const { chooseBackend, wheelNotches, uinputWheelAmount } = require("../src/client-input");

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  \u2717 ${name}\n      ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  \u2717 ${name}\n      ${e.message}`);
  }
}

function makeLog() {
  const lines = [];
  const add = (lvl) => (...a) => lines.push({ lvl, text: a.join(" ") });
  return { lines, info: add("info"), warn: add("warn"), error: add("error"), debug: add("debug") };
}

// A stand-in for child_process.spawn that records what would have been run.
function fakeSpawn(opts = {}) {
  const calls = [];
  const children = [];
  const spawn = (bin, args = [], sopts = {}) => {
    const child = new EventEmitter();
    child.bin = bin;
    child.args = args;
    child.sopts = sopts;
    child.exitCode = opts.exitCode === undefined ? null : opts.exitCode;
    child.killed = false;
    child.stdin = {
      lines: [],
      write(line, cb) {
        if (opts.writeError) {
          if (cb) cb(opts.writeError);
          return false;
        }
        this.lines.push(line);
        if (cb) cb();
        return true;
      },
      end() {
        child.stdinEnded = true;
      },
      on() {},
    };
    child.stderr = { setEncoding() {}, on() {} };
    child.kill = () => {
      child.killed = true;
    };
    if (opts.emitExit) {
      // A real one-shot process (ydotool) exits; emit it on the next tick so a
      // caller awaiting the action is not left hanging forever.
      setImmediate(() => child.emit("exit", child.exitCode === null ? 0 : child.exitCode, null));
    }
    calls.push({ bin, args });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

console.log("\n=== 1. dotool command language ===");

check("relative move is an integer mousemove", () => {
  assert.strictEqual(dotoolLine({ kind: "move", dx: 7, dy: -3 }), "mousemove 7 -3");
});

check("a rounded-to-zero move is dropped, not sent", () => {
  assert.strictEqual(dotoolLine({ kind: "move", dx: 0.4, dy: -0.2 }), null);
  assert.strictEqual(dotoolLine({ kind: "move", dx: 0, dy: 0 }), null);
});

check("button down/up use the tool's own names", () => {
  assert.strictEqual(dotoolLine({ kind: "button", button: Button.LEFT, down: true }), "buttondown left");
  assert.strictEqual(dotoolLine({ kind: "button", button: Button.MIDDLE, down: false }), "buttonup middle");
  assert.strictEqual(dotoolLine({ kind: "button", button: Button.RIGHT, down: true }), "buttondown right");
});

check("an unknown button is refused rather than guessed", () => {
  assert.strictEqual(dotoolLine({ kind: "button", button: 9, down: true }), null);
});

check("wheel is signed and axis-aware", () => {
  assert.strictEqual(dotoolLine({ kind: "wheel", notches: -2 }), "wheel -2");
  assert.strictEqual(dotoolLine({ kind: "wheel", notches: 1 }), "wheel 1");
  assert.strictEqual(dotoolLine({ kind: "wheel", notches: 1, horizontal: true }), "hwheel 1");
  assert.strictEqual(dotoolLine({ kind: "wheel", notches: 0 }), null);
});

check("keys are sent as raw kernel codes", () => {
  assert.strictEqual(dotoolLine({ kind: "key", code: 30, down: true }), "keydown k:30");
  assert.strictEqual(dotoolLine({ kind: "key", code: 30, down: false }), "keyup k:30");
});

check("mouseto takes clamped fractions of the output", () => {
  assert.strictEqual(dotoolLine({ kind: "moveTo", x: 0.5, y: 0.5 }), "mouseto 0.5 0.5");
  assert.strictEqual(dotoolLine({ kind: "moveTo", x: 3, y: -1 }), "mouseto 1 0");
  assert.strictEqual(dotoolLine({ kind: "moveTo", x: "nonsense", y: 0.25 }), "mouseto 0.5 0.25");
});

console.log("\n=== 2. ydotool command language ===");

check("relative move uses -x/-y (absolute is opt-in)", () => {
  assert.deepStrictEqual(ydotoolArgs({ kind: "move", dx: 5, dy: -9 }), [
    "mousemove",
    "-x",
    "5",
    "-y",
    "-9",
  ]);
  assert.strictEqual(ydotoolArgs({ kind: "move", dx: 0, dy: 0 }), null);
});

check("buttons use the 0x40/0x80 bitmask, with ydotool's own numbering", () => {
  // 0x00 LEFT, 0x01 RIGHT, 0x02 MIDDLE -- a THIRD numbering scheme.
  assert.deepStrictEqual(ydotoolArgs({ kind: "button", button: Button.LEFT, down: true }), [
    "click",
    "0x40",
  ]);
  assert.deepStrictEqual(ydotoolArgs({ kind: "button", button: Button.MIDDLE, down: true }), [
    "click",
    "0x42",
  ]);
  assert.deepStrictEqual(ydotoolArgs({ kind: "button", button: Button.RIGHT, down: true }), [
    "click",
    "0x41",
  ]);
  assert.deepStrictEqual(ydotoolArgs({ kind: "button", button: Button.LEFT, down: false }), [
    "click",
    "0x80",
  ]);
});

check("ydotool has no wheel command, but the bundled helper covers it", () => {
  // Two separate facts, and conflating them was the bug: the *command* does not
  // exist, yet the *capability* does (via bin/wheel.py). ydotoolArgs must keep
  // returning null so nothing ever runs `ydotool wheel`.
  assert.strictEqual(ydotoolArgs({ kind: "wheel", notches: 1 }), null);
  assert.strictEqual(TOOLS.ydotool.wheel, true);
  assert.strictEqual(TOOLS.ydotool.hwheel, true);
  assert.strictEqual(toolSpec("ydotool").wheel, true);
});

check("keys use the CODE:1/CODE:0 form", () => {
  assert.deepStrictEqual(ydotoolArgs({ kind: "key", code: 30, down: true }), ["key", "30:1"]);
  assert.deepStrictEqual(ydotoolArgs({ kind: "key", code: 30, down: false }), ["key", "30:0"]);
});

console.log("\n=== 3. the numberings that meet here ===");

check("nut-js LEFT really is 0 (so no truthiness guards anywhere)", () => {
  assert.strictEqual(Button.LEFT, 0);
  assert.strictEqual(DOTOOL_BUTTON[Button.LEFT], "left");
  assert.strictEqual(DOTOOL_BUTTON[Button.MIDDLE], "middle");
  assert.strictEqual(DOTOOL_BUTTON[Button.RIGHT], "right");
});

check("the two tools' button indices are consistent with their docs", () => {
  assert.strictEqual(YDOTOOL_BUTTON[Button.LEFT], 0x00);
  assert.strictEqual(YDOTOOL_BUTTON[Button.RIGHT], 0x01);
  assert.strictEqual(YDOTOOL_BUTTON[Button.MIDDLE], 0x02);
});

check("uiohook keycodes ARE Linux input event codes (no key table needed)", () => {
  // This is the whole reason the keyboard works on the uinput backend without
  // a translation table: libuiohook numbers keys with the PC scancode values,
  // and the kernel's KEY_* codes for the alphanumeric block are the same
  // numbers. If a future uiohook changed this, the check below is the alarm.
  const same = [
    ["Escape", 1],
    ["Enter", 28],
    ["A", 30],
    ["Z", 44],
    ["Space", 57],
    ["Numpad0", 82],
  ];
  for (const [name, code] of same) {
    assert.strictEqual(UiohookKey[name], code, `${name} should be ${code}`);
  }
});

check("nut-js Key values are NOT kernel codes, so `k` is genuinely needed", () => {
  // If these ever became equal the extra wire field would be pointless -- but
  // today they are wildly different, which is why the server sends both.
  assert.notStrictEqual(Key.A, UiohookKey.A);
  assert.notStrictEqual(Key.Enter, UiohookKey.Enter);
});

console.log("\n=== 4. tool discovery ===");

check("dotool is preferred over ydotool (it is the one with a wheel)", () => {
  assert.strictEqual(detectUinputTool({ has: () => true }), "dotool");
  assert.strictEqual(detectUinputTool({ has: (b) => b === "ydotool" }), "ydotool");
  assert.strictEqual(detectUinputTool({ has: () => false }), null);
});

check("describeTool reports real capabilities, not optimism", () => {
  assert.strictEqual(describeTool("dotool").wheel, true);
  // It really can scroll now -- through bin/wheel.py, not through the CLI.
  assert.strictEqual(describeTool("ydotool").wheel, true);
  assert.match(describeTool("ydotool").caps, /滚轮/);
  assert.doesNotMatch(describeTool("ydotool").caps, /不支持/);
  assert.match(describeTool("dotool").caps, /滚轮/);
  assert.strictEqual(describeTool("nope"), null);
});

check("each tool carries the install hint the user will actually need", () => {
  assert.match(TOOLS.dotool.install, /udevadm/);
  assert.match(TOOLS.ydotool.install, /ydotoold/);
});

console.log("\n=== 5. dotool transport (persistent process) ===");

(async () => {
  await checkAsync("one long-lived child serves every action", async () => {
    const { spawn, calls, children } = fakeSpawn();
    const inj = createUinputInjector({ tool: "dotool", spawn, log: makeLog() });
    await inj.move(10, -4);
    await inj.button(Button.LEFT, true);
    await inj.button(Button.LEFT, false);
    await inj.wheel(-1);
    await inj.key(30, true);
    assert.strictEqual(calls.length, 1, "must not fork once per event");
    assert.deepStrictEqual(children[0].stdin.lines, [
      "mousemove 10 -4\n",
      "buttondown left\n",
      "buttonup left\n",
      "wheel -1\n",
      "keydown k:30\n",
    ]);
    assert.strictEqual(inj.health().applied, 5);
    assert.strictEqual(inj.health().errors, 0);
  });

  await checkAsync("dotool flushes on the next tick (it is already warm)", async () => {
    const { spawn } = fakeSpawn();
    const inj = createUinputInjector({ tool: "dotool", spawn, log: makeLog() });
    assert.strictEqual(inj.motionIntervalMs, 0);
    assert.deepStrictEqual(inj.capabilities, { wheel: true, hwheel: true, keyboard: true });
  });

  await checkAsync("a child that dies is reported once, not once per event", async () => {
    const { spawn, children } = fakeSpawn();
    const log = makeLog();
    const inj = createUinputInjector({ tool: "dotool", spawn, log });
    assert.strictEqual(await inj.move(5, 5), true);

    // The tool dies (no /dev/uinput permission, wrong binary, whatever).
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);

    assert.strictEqual(await inj.move(5, 5), false);
    assert.strictEqual(await inj.move(5, 5), false);
    assert.strictEqual(inj.health().applied, 1, "only the write before the crash counts");
    assert.strictEqual(inj.health().errors, 1, "one death, one error");
    assert.match(inj.health().lastError, /code=1/);
    const warned = log.lines.filter((l) => l.lvl === "warn" && /uinput 注入失败/.test(l.text));
    assert.strictEqual(warned.length, 1, "the user must be told exactly once");
  });

  await checkAsync("a child that was never alive is still counted, not silent", async () => {
    // If a dead process went uncounted the session would report "0 failures"
    // while injecting nothing -- exactly the failure mode this backend exists
    // to make visible.
    const { spawn } = fakeSpawn({ exitCode: 127 });
    const inj = createUinputInjector({ tool: "dotool", spawn, log: makeLog() });
    assert.strictEqual(await inj.move(5, 5), false);
    assert.strictEqual(inj.health().errors, 1);
    assert.match(inj.health().lastError, /127/);
  });

  await checkAsync("close() ends the child", async () => {
    const { spawn, children } = fakeSpawn();
    const inj = createUinputInjector({ tool: "dotool", spawn, log: makeLog() });
    await inj.move(1, 1);
    inj.close();
    assert.strictEqual(children[0].stdinEnded, true);
    assert.strictEqual(children[0].killed, true);
  });

  console.log("\n=== 6. ydotool transport (process per action) ===");

  await checkAsync("each action is its own process, with the exact argv", async () => {
    const { spawn, calls } = fakeSpawn({ emitExit: true });
    const inj = createUinputInjector({ tool: "ydotool", binPath: "ydotool", spawn, log: makeLog() });
    await inj.move(3, -3);
    await inj.button(Button.RIGHT, true);
    await inj.key(28, false);
    assert.deepStrictEqual(calls, [
      { bin: "ydotool", args: ["mousemove", "-x", "3", "-y", "-3"] },
      { bin: "ydotool", args: ["click", "0x41"] }, // RIGHT = 0x01, down = 0x40
      { bin: "ydotool", args: ["key", "28:0"] },
    ]);
    assert.strictEqual(inj.health().applied, 3);
  });

  await checkAsync("ydotool asks for a lazier motion cadence", async () => {
    const { spawn } = fakeSpawn({ emitExit: true });
    const inj = createUinputInjector({ tool: "ydotool", binPath: "ydotool", spawn, log: makeLog() });
    assert.ok(inj.motionIntervalMs > 0, "forking per event at input rate would be far too slow");
    assert.deepStrictEqual(inj.capabilities, { wheel: true, hwheel: true, keyboard: true });
  });

  await checkAsync("wheel is routed to the bundled helper, sign preserved", async () => {
    const { spawn, calls } = fakeSpawn({ emitExit: true });
    const inj = createUinputInjector({
      tool: "ydotool",
      binPath: "ydotool",
      wheelHelper: "/opt/nm/bin/wheel.py",
      spawn,
      log: makeLog(),
    });
    assert.strictEqual(await inj.wheel(-2), true);
    assert.strictEqual(await inj.wheel(3, true), true);
    assert.deepStrictEqual(calls, [
      { bin: "python3", args: ["/opt/nm/bin/wheel.py", "-2"] },
      { bin: "python3", args: ["/opt/nm/bin/wheel.py", "3", "h"] },
    ]);
    assert.strictEqual(inj.health().applied, 2);
  });

  await checkAsync("a helper that exits non-zero is an error, not a success", async () => {
    const { spawn } = fakeSpawn({ emitExit: true, exitCode: 1 });
    const inj = createUinputInjector({
      tool: "ydotool",
      binPath: "ydotool",
      wheelHelper: "/opt/nm/bin/wheel.py",
      spawn,
      log: makeLog(),
    });
    assert.strictEqual(await inj.wheel(1), false);
    assert.strictEqual(inj.health().applied, 0);
    assert.strictEqual(inj.health().errors, 1);
    assert.match(inj.health().lastError, /wheel\.py/);
  });

  await checkAsync("a missing helper warns once and is not counted as applied", async () => {
    const { spawn, calls } = fakeSpawn();
    const log = makeLog();
    const inj = createUinputInjector({
      tool: "ydotool",
      binPath: "ydotool",
      wheelHelper: null,
      spawn,
      log,
    });
    const a = await inj.wheel(1);
    const b = await inj.wheel(1);
    assert.strictEqual(a, false);
    assert.strictEqual(b, false);
    assert.strictEqual(calls.length, 0, "nothing should be spawned when the helper is absent");
    assert.strictEqual(inj.health().applied, 0);
    const warned = log.lines.filter((l) => l.lvl === "warn" && /找不到 bin\/wheel\.py/.test(l.text));
    assert.strictEqual(warned.length, 1, `expected exactly one warning, got ${warned.length}`);
  });

  await checkAsync("a non-zero exit is an error, not a success", async () => {
    const { spawn } = fakeSpawn({ emitExit: true, exitCode: 3 });
    const inj = createUinputInjector({ tool: "ydotool", binPath: "ydotool", spawn, log: makeLog() });
    const ok = await inj.move(2, 2);
    assert.strictEqual(ok, false);
    assert.strictEqual(inj.health().applied, 0);
    assert.strictEqual(inj.health().errors, 1);
    assert.match(inj.health().lastError, /exit 3/);
  });

  await checkAsync("an unknown tool is refused at construction", async () => {
    assert.throws(() => createUinputInjector({ tool: "nope", spawn: fakeSpawn().spawn }), /unsupported/);
  });

  console.log("\n=== 7. wheel sign conventions ===");

  check("notches keep the wire sign (negative = up)", () => {
    assert.strictEqual(wheelNotches(-3), -3);
    assert.strictEqual(wheelNotches(2), 2);
    assert.strictEqual(wheelNotches(0), 0);
    assert.strictEqual(wheelNotches(0.4), 0);
  });

  check("a kernel wheel is the NEGATION of a wire wheel", () => {
    // libuiohook: rotation < 0 is wheel up. Linux REL_WHEEL: +1 is wheel up.
    // The two conventions meet here and nowhere else.
    assert.strictEqual(uinputWheelAmount(-1), 1);
    assert.strictEqual(uinputWheelAmount(1), -1);
    assert.strictEqual(uinputWheelAmount(0), 0);
  });

  console.log("\n=== 8. backend selection ===");

  const cfgWith = (backend) => ({ layout: {}, input: { backend } });

  check("non-Linux always uses libnut", () => {
    const b = chooseBackend(cfgWith("auto"), { platform: "win32" });
    assert.strictEqual(b.kind, "xtest");
    const m = chooseBackend(cfgWith("uinput"), { platform: "darwin" });
    assert.strictEqual(m.kind, "xtest", "macOS has no uinput tool to use");
  });

  check("X11 uses XTest even when a uinput tool is installed", () => {
    const b = chooseBackend(cfgWith("auto"), {
      platform: "linux",
      wayland: false,
      uinputTool: "dotool",
    });
    assert.strictEqual(b.kind, "xtest");
  });

  check("Wayland + a uinput tool switches to uinput automatically", () => {
    const b = chooseBackend(cfgWith("auto"), {
      platform: "linux",
      wayland: true,
      uinputTool: "dotool",
    });
    assert.strictEqual(b.kind, "uinput");
    assert.strictEqual(b.tool, "dotool");
    assert.match(b.reason, /Wayland/);
  });

  check("Wayland with no tool stays on XTest but says so", () => {
    const b = chooseBackend(cfgWith("auto"), {
      platform: "linux",
      wayland: true,
      uinputTool: null,
    });
    assert.strictEqual(b.kind, "xtest");
    assert.strictEqual(b.warn, true, "silence here is the bug being fixed");
  });

  check("the config can force either backend", () => {
    assert.strictEqual(
      chooseBackend(cfgWith("xtest"), { platform: "linux", wayland: true, uinputTool: "dotool" }).kind,
      "xtest"
    );
    assert.strictEqual(
      chooseBackend(cfgWith("uinput"), { platform: "linux", wayland: false, uinputTool: "ydotool" }).kind,
      "uinput"
    );
  });

  check("forcing uinput without a tool degrades loudly, not silently", () => {
    const b = chooseBackend(cfgWith("uinput"), {
      platform: "linux",
      wayland: true,
      uinputTool: null,
    });
    assert.strictEqual(b.kind, "xtest");
    assert.strictEqual(b.warn, true);
    assert.match(b.reason, /没找到/);
  });

  check("an unknown backend value is treated as auto", () => {
    const b = chooseBackend({ layout: {}, input: { backend: "magic" } }, {
      platform: "linux",
      wayland: true,
      uinputTool: "dotool",
    });
    assert.strictEqual(b.kind, "uinput");
  });

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length) {
    console.log(`UINPUT-UNITS FAIL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  console.log(`UINPUT-UNITS PASS: ${passed}/${passed} checks passed`);
  process.exit(0);
})();

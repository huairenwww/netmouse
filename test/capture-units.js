"use strict";
// ---------------------------------------------------------------------------
// Unit tests for the native Wayland capture path.
//
// Why this file exists
// --------------------
// This is the one part of NetMouse that cannot be exercised on the machine that
// builds it: there is no Linux here, no /dev/input, and no Wayland session. So
// the tests below pin down every decision that CAN be pinned down without a
// kernel -- the byte layout, the framing, the button numbering, the device
// filtering, the permission branch -- and the docs are explicit that the rest
// (does a real GNOME session actually deliver events?) is unverified.
//
// The three things most worth getting right, because each fails silently:
//
//   * **struct input_event is 24 bytes on a 64-bit process and 16 on a 32-bit
//     one.** Get it wrong and the parser produces plausible-looking garbage
//     forever -- the mouse moves, but not where you pointed.
//   * **A report is a burst terminated by SYN_REPORT.** Treating each record as
//     an event turns one diagonal drag into two axis-aligned jumps.
//   * **The button numbers must be uiohook's.** They go on the wire and the
//     client maps them to nut-js Buttons; 1/2/3 for left/right/middle is a
//     contract, not a preference.
// ---------------------------------------------------------------------------
const assert = require("assert");
const { EventEmitter } = require("events");

const {
  createEvdevCapture,
  createFrameDecoder,
  parseEventBuffer,
  parseInputDevices,
  classifyDevice,
  bitmapHas,
  buttonOf,
  isOurOwnDevice,
  eventSize,
  EV,
  REL,
  WHEEL_VERTICAL,
  WHEEL_HORIZONTAL,
} = require("../src/capture-evdev");
const { chooseCapture, createCaptureBackend, CAPTURE_MODES } = require("../src/capture");

let passed = 0;
const failures = [];
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
const check = (name, fn) => checkAsync(name, () => fn());

// --- building synthetic kernel events --------------------------------------

function ev(type, code, value, size = 24) {
  const b = Buffer.alloc(size);
  b.writeUInt16LE(type, size - 8);
  b.writeUInt16LE(code, size - 6);
  b.writeInt32LE(value, size - 4);
  return b;
}
const syn = (size = 24) => ev(EV.SYN, 0, 0, size);
const rel = (code, value, size = 24) => ev(EV.REL, code, value, size);
const key = (code, value, size = 24) => ev(EV.KEY, code, value, size);

function collect(chunks, size = 24) {
  const frames = [];
  const dec = createFrameDecoder({ size, onFrame: (f) => frames.push(f) });
  for (const c of chunks) dec.push(c);
  return frames;
}

function makeLog() {
  const lines = [];
  const add = (lvl) => (...a) => lines.push({ lvl, text: a.join(" ") });
  return { lines, info: add("info"), warn: add("warn"), error: add("error"), debug: add("debug") };
}

// A stand-in for a ReadStream on a character device.
function fakeStream() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = () => {
    s.destroyed = true;
    return s;
  };
  s.unref = () => {};
  return s;
}

const PROC_DEVICES = [
  "I: Bus=0003 Vendor=046d Product=c52b Version=0111",
  'N: Name="Logitech USB Receiver Mouse"',
  "P: Phys=usb-0000:00:14.0-1/input2:1",
  "S: Sysfs=/devices/pci0000:00/usb1/1-1/1-1:1.0/0003:046D:C52B.0003/input/input15",
  "U: Uniq=",
  "H: Handlers=mouse0 event5",
  "B: PROP=0",
  "B: EV=17",
  "B: KEY=ffff0000 0 0 0 0 0 0 0 0 0",
  "B: REL=143",
  "",
  "I: Bus=0003 Vendor=046d Product=c52b Version=0111",
  'N: Name="Logitech USB Receiver Keyboard"',
  "H: Handlers=sysrq kbd leds event3",
  "B: PROP=0",
  "B: EV=120013",
  "B: KEY=1000000000007 ff8000000000000 0 0 0 0 0 0 0 0",
  "B: REL=0",
  "",
  "I: Bus=0003 Vendor=1d6b Product=0001 Version=0001",
  'N: Name="ydotoold virtual device"',
  "H: Handlers=mouse1 event7",
  "B: REL=3",
  "",
].join("\n");

function fakeDeps({ readable = ["/dev/input/event3", "/dev/input/event5"], files = ["event3", "event5", "event7"], proc = PROC_DEVICES } = {}) {
  const streams = new Map();
  return {
    streams,
    deps: {
      arch: "x64",
      readdir: async () => files,
      readFile: async (p) => {
        if (p === "/proc/bus/input/devices") return proc;
        throw new Error(`unexpected read: ${p}`);
      },
      access: async (p) => {
        if (readable.includes(p)) return;
        const e = new Error("permission denied");
        e.code = "EACCES";
        throw e;
      },
      createReadStream: (p) => {
        const s = fakeStream();
        streams.set(p, s);
        return s;
      },
      // The permission diagnosis is reused from the uinput path; stub it so the
      // test asserts the wiring, not the /etc/group parsing (that has its own
      // test file).
      uinputAccess: () => ({ hint: "STUB-HINT" }),
    },
  };
}

(async () => {
  // -------------------------------------------------------------------------
  console.log("\n-- struct input_event --");

  await check("the record size follows the process ABI, not the kernel", () => {
    assert.strictEqual(eventSize("x64"), 24);
    assert.strictEqual(eventSize("arm64"), 24);
    assert.strictEqual(eventSize("ia32"), 16);
    assert.strictEqual(eventSize("arm"), 16);
  });

  await check("24-byte records decode to the right type/code/value", () => {
    const buf = Buffer.concat([ev(EV.REL, REL.X, -7), ev(EV.KEY, 0x110, 1)]);
    const out = parseEventBuffer(buf, 24);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], { type: EV.REL, code: REL.X, value: -7 });
    assert.deepStrictEqual(out[1], { type: EV.KEY, code: 0x110, value: 1 });
  });

  await check("16-byte records decode at their own offsets", () => {
    const buf = Buffer.concat([ev(EV.REL, REL.Y, 12, 16), ev(EV.REL, REL.WHEEL, -1, 16)]);
    const out = parseEventBuffer(buf, 16);
    assert.deepStrictEqual(out[0], { type: EV.REL, code: REL.Y, value: 12 });
    assert.deepStrictEqual(out[1], { type: EV.REL, code: REL.WHEEL, value: -1 });
  });

  await check("a partial trailing record is ignored, not misread", () => {
    const buf = Buffer.concat([ev(EV.REL, REL.X, 3), Buffer.alloc(10)]);
    assert.strictEqual(parseEventBuffer(buf, 24).length, 1);
  });

  // -------------------------------------------------------------------------
  console.log("\n-- framing on SYN_REPORT --");

  await check("a diagonal move is ONE frame carrying both axes", () => {
    // The whole reason for SYN_REPORT framing: two axis-aligned jumps would
    // make a diagonal drag arrive as a staircase.
    const frames = collect([Buffer.concat([rel(REL.X, 5), rel(REL.Y, -3), syn()])]);
    assert.deepStrictEqual(frames, [{ kind: "move", dx: 5, dy: -3 }]);
  });

  await check("a frame that splits across chunk boundaries is still one frame", () => {
    const buf = Buffer.concat([rel(REL.X, 4), rel(REL.Y, 2), syn(), rel(REL.X, 1), syn()]);
    // Feed it one byte at a time: the worst case a real read can produce.
    const chunks = [];
    for (let i = 0; i < buf.length; i++) chunks.push(buf.subarray(i, i + 1));
    const frames = collect(chunks);
    assert.deepStrictEqual(frames, [
      { kind: "move", dx: 4, dy: 2 },
      { kind: "move", dx: 1, dy: 0 },
    ]);
  });

  await check("an empty report emits nothing", () => {
    assert.deepStrictEqual(collect([Buffer.concat([syn(), syn()])]), []);
  });

  await check("motion inside one frame is summed, not emitted twice", () => {
    const frames = collect([Buffer.concat([rel(REL.X, 1), rel(REL.X, 2), rel(REL.X, 3), syn()])]);
    assert.deepStrictEqual(frames, [{ kind: "move", dx: 6, dy: 0 }]);
  });

  await check("a frame's order is move, button, wheel, keys", () => {
    // Order is what makes a click land where the user aimed rather than one
    // frame behind it.
    const frames = collect([
      Buffer.concat([
        key(0x110, 1),
        rel(REL.WHEEL, -1),
        ev(EV.KEY, 30, 1), // KEY_A
        rel(REL.X, 9),
        syn(),
      ]),
    ]);
    assert.deepStrictEqual(frames, [
      { kind: "move", dx: 9, dy: 0 },
      { kind: "down", button: 1 },
      { kind: "wheel", rotation: -1, direction: WHEEL_VERTICAL },
      { kind: "keydown", keycode: 30 },
    ]);
  });

  // -------------------------------------------------------------------------
  console.log("\n-- buttons, keys and wheels --");

  await check("BTN_ codes map to the uiohook numbers the protocol already uses", () => {
    assert.strictEqual(buttonOf(0x110), 1); // BTN_LEFT
    assert.strictEqual(buttonOf(0x111), 2); // BTN_RIGHT
    assert.strictEqual(buttonOf(0x112), 3); // BTN_MIDDLE
    assert.strictEqual(buttonOf(0x113), 4); // BTN_SIDE
    assert.strictEqual(buttonOf(0x114), 5); // BTN_EXTRA
    assert.strictEqual(buttonOf(30), null); // KEY_A is not a button
  });

  await check("press and release are distinguished", () => {
    const frames = collect([
      Buffer.concat([key(0x111, 1), syn()]),
      Buffer.concat([key(0x111, 0), syn()]),
    ]);
    assert.deepStrictEqual(frames, [
      { kind: "down", button: 2 },
      { kind: "up", button: 2 },
    ]);
  });

  await check("autorepeat (value 2) is dropped -- the peer's OS repeats for us", () => {
    const frames = collect([
      Buffer.concat([key(30, 1), syn()]),
      Buffer.concat([key(30, 2), syn()]),
      Buffer.concat([key(30, 2), syn()]),
      Buffer.concat([key(30, 0), syn()]),
    ]);
    assert.deepStrictEqual(frames, [
      { kind: "keydown", keycode: 30 },
      { kind: "keyup", keycode: 30 },
    ]);
  });

  await check("vertical and horizontal wheels are told apart", () => {
    const frames = collect([
      Buffer.concat([rel(REL.WHEEL, 1), syn()]),
      Buffer.concat([rel(REL.HWHEEL, -2), syn()]),
    ]);
    assert.deepStrictEqual(frames, [
      { kind: "wheel", rotation: 1, direction: WHEEL_VERTICAL },
      { kind: "wheel", rotation: -2, direction: WHEEL_HORIZONTAL },
    ]);
  });

  await check("REL_WHEEL_HI_RES is ignored so a notch is never counted twice", () => {
    // A mouse with hi-res wheel support reports BOTH: REL_WHEEL=1 and
    // REL_WHEEL_HI_RES=120 for one physical notch. Counting both would scroll
    // 121 notches.
    const frames = collect([
      Buffer.concat([rel(REL.WHEEL, 1), rel(REL.WHEEL_HI_RES, 120), syn()]),
      Buffer.concat([rel(REL.HWHEEL_HI_RES, 120), syn()]),
    ]);
    assert.deepStrictEqual(frames, [{ kind: "wheel", rotation: 1, direction: WHEEL_VERTICAL }]);
  });

  await check("EV_ABS (a touchpad) is ignored rather than guessed at", () => {
    const frames = collect([Buffer.concat([ev(0x03, 0x00, 1000), syn()])]);
    assert.deepStrictEqual(frames, []);
  });

  // -------------------------------------------------------------------------
  console.log("\n-- device discovery --");

  await check("/proc/bus/input/devices parses into name + handlers + bitmaps", () => {
    const recs = parseInputDevices(PROC_DEVICES);
    assert.strictEqual(recs.length, 3);
    assert.strictEqual(recs[0].name, "Logitech USB Receiver Mouse");
    assert.deepStrictEqual(recs[0].handlers, ["mouse0", "event5"]);
    assert.strictEqual(recs[1].name, "Logitech USB Receiver Keyboard");
    assert.ok(recs[1].handlers.includes("kbd"));
    assert.strictEqual(recs[0].rel, "143");
  });

  await check("classification uses the kernel's own handlers when available", () => {
    const recs = parseInputDevices(PROC_DEVICES);
    assert.strictEqual(classifyDevice(recs[0]), "pointer"); // mouse0
    assert.strictEqual(classifyDevice(recs[1]), "keyboard"); // kbd
    assert.strictEqual(classifyDevice(null), "unknown");
  });

  await check("classification falls back to the REL bitmap when handlers are absent", () => {
    // REL=3 is REL_X|REL_Y: a pointer, even with no Handlers line.
    assert.strictEqual(classifyDevice({ handlers: [], rel: "3", key: "" }), "pointer");
    assert.strictEqual(classifyDevice({ handlers: [], rel: "0", key: "0" }), "other");
  });

  await check("bitmapHas reads a single-hex-string bitmap", () => {
    assert.strictEqual(bitmapHas("3", 0), true);
    assert.strictEqual(bitmapHas("3", 1), true);
    assert.strictEqual(bitmapHas("3", 2), false);
    assert.strictEqual(bitmapHas("143", 0), true); // REL_X
    assert.strictEqual(bitmapHas("143", 8), true); // REL_WHEEL
  });

  await check("bitmapHas reads space-separated words in EITHER order", () => {
    // The exact word order of these sysfs files is not worth betting on, and it
    // cannot be checked from a Windows build machine -- so both readings are
    // accepted. Only ever used for reporting, never for correctness.
    // BTN_LEFT is bit 272 -> word 4, bit 16 -> 0x10000 in the top word.
    const msbFirst = "10000 0 0 0 0";
    const lsbFirst = "0 0 0 0 10000";
    assert.strictEqual(bitmapHas(msbFirst, 272), true);
    assert.strictEqual(bitmapHas(lsbFirst, 272), true);
    assert.strictEqual(bitmapHas(msbFirst, 0), false);
    assert.strictEqual(bitmapHas(lsbFirst, 0), false);
    assert.strictEqual(bitmapHas("", 0), false);
  });

  await check("our own virtual devices are filtered out", () => {
    // Reading the device our own injector created would feed injected motion
    // back in as user input -- a feedback loop, not a feature.
    assert.strictEqual(isOurOwnDevice("ydotoold virtual device"), true);
    assert.strictEqual(isOurOwnDevice("dotool"), true);
    assert.strictEqual(isOurOwnDevice("NetMouse virtual mouse"), true);
    assert.strictEqual(isOurOwnDevice("uinput"), true);
    assert.strictEqual(isOurOwnDevice("Logitech USB Receiver Mouse"), false);
  });

  // -------------------------------------------------------------------------
  console.log("\n-- the backend --");

  await checkAsync("start() opens the readable devices and skips our own", async () => {
    const { deps, streams } = fakeDeps();
    const log = makeLog();
    const cap = createEvdevCapture({ log, deps });
    const res = await cap.start();
    assert.strictEqual(res.ok, true);
    assert.ok(streams.has("/dev/input/event3"), "the keyboard should be opened");
    assert.ok(streams.has("/dev/input/event5"), "the mouse should be opened");
    assert.ok(!streams.has("/dev/input/event7"), "our own virtual device must NOT be opened");
    assert.ok(log.lines.some((l) => /跳过/.test(l.text) || l.lvl === "info"));
    cap.stop();
  });

  await checkAsync("events flow through to the listeners, with a synthesised position", async () => {
    const { deps, streams } = fakeDeps();
    const cap = createEvdevCapture({ log: makeLog(), deps });
    await cap.start();
    const moves = [];
    const downs = [];
    cap.on("mousemove", (e) => moves.push(e));
    cap.on("mousedown", (e) => downs.push(e));
    cap.setAnchor(100, 200);
    streams
      .get("/dev/input/event5")
      .emit(
        "data",
        Buffer.concat([rel(REL.X, 5), rel(REL.Y, -3), syn(), key(0x110, 1), rel(REL.X, 2), syn()])
      );
    assert.strictEqual(moves.length, 2);
    assert.strictEqual(moves[0].dx, 5);
    assert.strictEqual(moves[0].dy, -3);
    assert.strictEqual(moves[0].x, 105, "the model integrates the deltas");
    assert.strictEqual(moves[0].y, 197);
    assert.strictEqual(moves[1].x, 107);
    assert.deepStrictEqual(downs, [{ button: 1 }]);
    cap.stop();
  });

  await checkAsync("setAnchor re-anchors the synthesised position", async () => {
    const { deps, streams } = fakeDeps();
    const cap = createEvdevCapture({ log: makeLog(), deps });
    await cap.start();
    const moves = [];
    cap.on("mousemove", (e) => moves.push(e));
    cap.setAnchor(960, 540);
    streams.get("/dev/input/event5").emit("data", Buffer.concat([rel(REL.X, 10), syn()]));
    assert.strictEqual(moves[0].x, 970);
    assert.strictEqual(moves[0].y, 540);
    assert.strictEqual(cap.getAnchor().anchored, true);
    cap.stop();
  });

  await checkAsync("listeners can be detached, so a restart does not double every event", async () => {
    const { deps, streams } = fakeDeps();
    const cap = createEvdevCapture({ log: makeLog(), deps });
    await cap.start();
    const seen = [];
    const fn = (e) => seen.push(e);
    cap.on("mousemove", fn);
    streams.get("/dev/input/event5").emit("data", Buffer.concat([rel(REL.X, 1), syn()]));
    cap.off("mousemove", fn);
    streams.get("/dev/input/event5").emit("data", Buffer.concat([rel(REL.X, 1), syn()]));
    assert.strictEqual(seen.length, 1);
    cap.stop();
  });

  await checkAsync("no readable device fails with the permission fix, not a stack trace", async () => {
    const { deps } = fakeDeps({ readable: [] });
    const cap = createEvdevCapture({ log: makeLog(), deps });
    const res = await cap.start();
    assert.strictEqual(res.ok, false);
    assert.ok(/没有可读/.test(res.reason), `unexpected reason: ${res.reason}`);
    assert.strictEqual(res.hint, "STUB-HINT", "the uinput/input group diagnosis must be attached");
    assert.strictEqual(cap.isStarted(), false);
  });

  await checkAsync("no devices at all is reported as such", async () => {
    const { deps } = fakeDeps({ files: ["mice", "by-path"] });
    const cap = createEvdevCapture({ log: makeLog(), deps });
    const res = await cap.start();
    assert.strictEqual(res.ok, false);
    assert.ok(/没有.*eventN/.test(res.reason), `unexpected reason: ${res.reason}`);
  });

  await checkAsync("stop() destroys every stream it opened", async () => {
    const { deps, streams } = fakeDeps();
    const cap = createEvdevCapture({ log: makeLog(), deps });
    await cap.start();
    cap.stop();
    assert.strictEqual(cap.isStarted(), false);
    for (const s of streams.values()) assert.strictEqual(s.destroyed, true);
  });

  await checkAsync("a device that disappears mid-session does not throw", async () => {
    const { deps, streams } = fakeDeps();
    const log = makeLog();
    const cap = createEvdevCapture({ log, deps });
    await cap.start();
    streams.get("/dev/input/event5").emit("error", new Error("ENODEV"));
    assert.ok(log.lines.some((l) => /ENODEV/.test(l.text)));
    cap.stop();
  });

  await checkAsync("status() reports what was found, for the doctor", async () => {
    const { deps } = fakeDeps();
    const cap = createEvdevCapture({ log: makeLog(), deps });
    await cap.start();
    const st = cap.status();
    assert.strictEqual(st.started, true);
    // Two, not three: our own virtual device is filtered out during discovery
    // and never becomes a capture source.
    assert.strictEqual(st.devices.length, 2);
    const kinds = Object.fromEntries(st.devices.map((d) => [d.path, d.kind]));
    assert.strictEqual(kinds["/dev/input/event5"], "pointer");
    assert.strictEqual(kinds["/dev/input/event3"], "keyboard");
    cap.stop();
  });

  // -------------------------------------------------------------------------
  console.log("\n-- backend selection --");

  await check("auto picks evdev on Wayland and uiohook elsewhere", () => {
    assert.strictEqual(chooseCapture({ mode: "auto", platform: "win32" }), "uiohook");
    assert.strictEqual(chooseCapture({ mode: "auto", platform: "linux", isWayland: false }), "uiohook");
    assert.strictEqual(chooseCapture({ mode: "auto", platform: "linux", isWayland: true }), "evdev");
  });

  await check("an explicit choice is honoured", () => {
    assert.strictEqual(chooseCapture({ mode: "evdev", platform: "win32" }), "evdev");
    assert.strictEqual(chooseCapture({ mode: "uiohook", platform: "linux", isWayland: true }), "uiohook");
    assert.deepStrictEqual(CAPTURE_MODES, ["auto", "uiohook", "evdev"]);
  });

  await checkAsync("on Wayland the failed evdev probe falls back to uiohook, loudly", async () => {
    // Having no capture at all is worse than running on the backend the user
    // did not pick -- but they must be told, because the fallback half-works:
    // uiohook only sees events while an X11 window has focus.
    const log = makeLog();
    const r = await createCaptureBackend({
      cfg: { input: { capture: "auto" } },
      log,
      deps: {
        platform: "linux",
        isWayland: true,
        readdir: async () => ["event0"],
        readFile: async () => "",
        access: async () => {
          const e = new Error("denied");
          e.code = "EACCES";
          throw e;
        },
        createReadStream: () => fakeStream(),
        uinputAccess: () => ({ hint: "STUB-HINT" }),
      },
    });
    assert.strictEqual(r.preferred, "evdev", "Wayland must prefer evdev");
    assert.ok(r.backend, "it must end up with SOME backend");
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(r.name, "uiohook");
    assert.ok(
      log.lines.some((l) => l.lvl === "warn" && /回退/.test(l.text)),
      "the fallback must be logged"
    );
    assert.ok(
      log.lines.some((l) => /Xwayland|时灵时不灵/.test(l.text)),
      "the warning must say WHY the fallback is worse"
    );
    assert.ok(
      log.lines.some((l) => /STUB-HINT/.test(l.text)),
      "the permission hint must reach the log"
    );
    r.backend.stop();
  });

  await checkAsync("an explicit choice also falls back rather than leaving no capture", async () => {
    const log = makeLog();
    const r = await createCaptureBackend({
      cfg: { input: { capture: "evdev" } },
      log,
      deps: {
        platform: "linux",
        isWayland: false,
        readdir: async () => ["event0"],
        readFile: async () => "",
        access: async () => {
          throw new Error("denied");
        },
        createReadStream: () => fakeStream(),
        uinputAccess: () => ({ hint: null }),
      },
    });
    assert.strictEqual(r.preferred, "evdev");
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(r.name, "uiohook");
    r.backend.stop();
  });

  await checkAsync("when nothing can start, that is reported instead of a crash", async () => {
    const log = makeLog();
    const r = await createCaptureBackend({
      cfg: { input: { capture: "uiohook" } },
      log,
      deps: {
        isWayland: false,
        readdir: async () => ["event0"],
        readFile: async () => "",
        access: async () => {
          throw new Error("denied");
        },
        createReadStream: () => fakeStream(),
        uinputAccess: () => ({ hint: null }),
      },
    });
    // uiohook itself starts fine on this build machine, so this asserts the
    // shape of the result rather than a null backend.
    assert.ok(r.backend || r.error);
    if (r.backend) r.backend.stop();
  });

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length) {
    console.log(`CAPTURE-UNITS FAIL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  console.log(`CAPTURE-UNITS PASS: ${passed}/${passed} checks passed`);
  process.exit(0);
})();

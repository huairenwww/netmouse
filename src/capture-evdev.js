// ---------------------------------------------------------------------------
// Native Wayland capture: read the kernel's input devices directly.
//
// Why this exists
// ---------------
// NetMouse's capture path uses uiohook, which on Linux is an X11 client
// (XRecord/XInput). Under Wayland that means Xwayland, and Xwayland only sees
// pointer and keyboard events **while an X11 window has focus**. The moment the
// user clicks a native Wayland window -- which on GNOME 50 is every window,
// since there is no Xorg session at all any more -- capture goes silent. The
// mouse then simply does not cross to the other machine, with no error
// anywhere. Injection already has a Wayland answer (uinput, see
// inject-uinput.js); capture did not. This is that answer.
//
// `/dev/input/event*` is the kernel's own event stream. It is the same data
// every compositor reads, it is independent of the display protocol, and
// reading it needs no ioctl, no native module and no privileges beyond read
// access to the device node. That last point matters: this project ships
// prebuilt binaries and cannot compile a native addon, so `libei` /
// `xdg-desktop-portal RemoteDesktop` -- the "official" Wayland input APIs --
// are out of reach. Reading evdev is the strongest thing available without a
// compiler, and it is what other cross-platform KVM tools fall back to.
//
// Three consequences of reading evdev that shape everything below:
//
//   1. **There are no absolute coordinates.** A mouse reports EV_REL deltas.
//      Wayland deliberately does not let a client ask "where is the pointer?".
//      So the cursor position is *synthesised* by integrating deltas from an
//      anchor, and the anchor is re-set at well-defined moments (capture,
//      release). See `setAnchor` for why that is good enough -- and better
//      than it sounds, because deltas need no re-centring at all: the physical
//      cursor is never warped, so it can never clamp at a screen edge, which
//      removes the entire `jumpLimit` / `recenterCursor` dance the uiohook
//      path needs.
//   2. **One physical device can appear as several.** A wireless receiver
//      exposes a pointer, a keyboard and a "consumer control" as three separate
//      input devices. That is fine: the events are self-describing (EV_REL is
//      motion, EV_KEY with a BTN_ code is a button), so nothing has to be
//      classified to be handled correctly. Classification is only used to
//      report health.
//   3. **We must not read our own virtual devices.** NetMouse's own injection
//      creates a uinput device that looks exactly like a mouse. Reading it would
//      feed our injected motion back in as if it were the user's hand. Filtered
//      by name -- see OUR_DEVICE_PATTERNS.
//
// What is NOT solved here, stated plainly: a Wayland session will not hand out
// input events for *secure* contexts, and a compositor that ever stops exposing
// evdev would break this. Neither is testable from a Windows build machine.
// ---------------------------------------------------------------------------

const fs = require("fs");
const { uinputAccess } = require("./ydotoold");

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

// struct input_event on a 64-bit kernel is 24 bytes:
//   struct timeval time;   // 16 bytes (two 8-byte longs)
//   __u16 type; __u16 code; __s32 value;
// On 32-bit it is 16 bytes. The kernel ABI is the *process* ABI, so this must
// follow the arch we are running as, not the kernel's build target.
const ARCH_64 = new Set(["x64", "arm64", "ppc64", "ppc64le", "s390x", "riscv64", "loong64", "mips64el"]);
const EVENT_SIZE_64 = 24;
const EVENT_SIZE_32 = 16;

function eventSize(arch = process.arch) {
  return ARCH_64.has(arch) ? EVENT_SIZE_64 : EVENT_SIZE_32;
}

const EV = { SYN: 0x00, KEY: 0x01, REL: 0x02, ABS: 0x03, MSC: 0x04 };
const SYN_REPORT = 0;
const REL = {
  X: 0x00,
  Y: 0x01,
  HWHEEL: 0x06,
  WHEEL: 0x08,
  WHEEL_HI_RES: 0x0b,
  HWHEEL_HI_RES: 0x0c,
};

// uiohook's WheelDirection, which is what goes on the wire.
const WHEEL_VERTICAL = 3;
const WHEEL_HORIZONTAL = 4;

// Kernel BTN_ codes -> the uiohook button numbers the protocol already uses
// (1 left, 2 right, 3 middle). The mapping is not a guess: it is the same
// numbering client-input.js maps to nut-js Buttons and injecttest.js exercises.
//
// 4 and 5 (BTN_SIDE / BTN_EXTRA -- the thumb buttons) are forwarded so the
// information is not lost, but the client currently rejects them; see the
// side-button entry in 已知限制.
const BTN_MAP = new Map([
  [0x110, 1], // BTN_LEFT
  [0x111, 2], // BTN_RIGHT
  [0x112, 3], // BTN_MIDDLE
  [0x113, 4], // BTN_SIDE
  [0x114, 5], // BTN_EXTRA
]);

function buttonOf(code) {
  const b = BTN_MAP.get(code);
  return b === undefined ? null : b;
}

// Devices created by our own injector (or by the tools it drives). Reading one
// would turn our injected motion into input, which is a feedback loop, not a
// feature.
const OUR_DEVICE_PATTERNS = [/ydotool/i, /dotool/i, /netmouse/i, /\buinput\b/i];

function isOurOwnDevice(name) {
  return OUR_DEVICE_PATTERNS.some((re) => re.test(String(name || "")));
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// Decode a buffer of fixed-size input_event records. Returns the events; the
// caller is responsible for carrying any partial trailing record forward.
function parseEventBuffer(buf, size = EVENT_SIZE_64) {
  const out = [];
  const n = Math.floor(buf.length / size);
  for (let i = 0; i < n; i++) {
    const off = i * size;
    out.push({
      // The timeval is skipped: it is never used, and its width is the only
      // thing that differs between 32- and 16-byte records.
      type: buf.readUInt16LE(off + size - 8),
      code: buf.readUInt16LE(off + size - 6),
      value: buf.readInt32LE(off + size - 4),
    });
  }
  return out;
}

// input_event records are not one-event-per-report: a single physical report is
// a burst of records terminated by EV_SYN/SYN_REPORT, and the burst can carry
// X, Y and a wheel notch together. Framing on SYN_REPORT is what keeps a
// diagonal drag diagonal instead of turning it into two axis-aligned jumps.
function createFrameDecoder({ size = EVENT_SIZE_64, onFrame } = {}) {
  let leftover = Buffer.alloc(0);
  let frame = null;
  const reset = () => {
    frame = { dx: 0, dy: 0, wheel: 0, hwheel: 0, buttons: [], keys: [] };
  };
  reset();

  function absorb(e) {
    if (e.type === EV.SYN) {
      if (e.code === SYN_REPORT) flush();
      return;
    }
    if (e.type === EV.REL) {
      if (e.code === REL.X) frame.dx += e.value;
      else if (e.code === REL.Y) frame.dy += e.value;
      else if (e.code === REL.WHEEL) frame.wheel += e.value;
      else if (e.code === REL.HWHEEL) frame.hwheel += e.value;
      // REL_WHEEL_HI_RES / REL_HWHEEL_HI_RES are deliberately ignored. A mouse
      // that reports them also reports REL_WHEEL, and counting both would
      // double every notch. REL_WHEEL alone is also exactly the notch-quantised
      // semantics uiohook produces, which is what the rest of the pipeline
      // (and the client's scrollUnit arithmetic) already assumes.
      return;
    }
    if (e.type === EV.KEY) {
      const b = buttonOf(e.code);
      if (b !== null) {
        frame.buttons.push({ button: b, down: e.value !== 0 });
      } else if (e.value === 1 || e.value === 0) {
        frame.keys.push({ keycode: e.code, down: e.value === 1 });
      }
      // e.value === 2 is autorepeat and is dropped on purpose: the peer's own
      // OS repeats the key for as long as it is held down, so forwarding
      // repeats too would double the rate.
      return;
    }
    // EV_MSC / EV_ABS and anything else are ignored: a relative-motion mouse
    // never needs them, and a touchpad's EV_ABS stream cannot be mapped to the
    // relative protocol without inventing gesture semantics.
  }

  function flush() {
    const f = frame;
    // Order matters and mirrors the wire order the client applies: move, then
    // buttons, then wheel, then keys. A click therefore lands at the position
    // the user was aiming at rather than one frame behind it.
    if (f.dx || f.dy) onFrame({ kind: "move", dx: f.dx, dy: f.dy });
    for (const b of f.buttons) onFrame({ kind: b.down ? "down" : "up", button: b.button });
    if (f.wheel) onFrame({ kind: "wheel", rotation: f.wheel, direction: WHEEL_VERTICAL });
    if (f.hwheel) onFrame({ kind: "wheel", rotation: f.hwheel, direction: WHEEL_HORIZONTAL });
    for (const k of f.keys) onFrame({ kind: k.down ? "keydown" : "keyup", keycode: k.keycode });
    reset();
  }

  return {
    push(chunk) {
      if (!chunk || !chunk.length) return 0;
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = Math.floor(buf.length / size) * size;
      leftover = usable === buf.length ? Buffer.alloc(0) : buf.subarray(usable);
      const events = parseEventBuffer(buf.subarray(0, usable), size);
      for (const e of events) absorb(e);
      return events.length;
    },
    reset,
    _leftoverLength: () => leftover.length,
    _frame: () => frame,
  };
}

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

// Parse /proc/bus/input/devices into records. This is the authoritative,
// symbolic description of what each device is -- the `H: Handlers=` line names
// the kernel's own classifier (a `mouseN` handler only exists for a device with
// REL_X + REL_Y + BTN_LEFT), so it needs no bit twiddling.
function parseInputDevices(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split("\n")) {
    if (!raw.trim()) {
      cur = null;
      continue;
    }
    const m = /^([A-Z]): (.*)$/.exec(raw);
    if (!m) continue;
    const tag = m[1];
    const rest = m[2];
    if (tag === "N") {
      const nm = /Name="(.*)"/.exec(rest);
      cur = {
        name: nm ? nm[1] : "",
        handlers: [],
        ev: "",
        key: "",
        rel: "",
        abs: "",
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (tag === "H") {
      cur.handlers = rest
        .replace(/^Handlers=/, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    } else if (tag === "B") {
      const bm = /^([A-Z]+)=(.*)$/.exec(rest);
      if (bm) {
        const key = bm[1].toLowerCase();
        if (Object.prototype.hasOwnProperty.call(cur, key)) cur[key] = bm[2].trim();
      }
    }
  }
  return out;
}

// Test one bit in a sysfs capability bitmap.
//
// These files come in two shapes and, worse, in an order that is not worth
// betting on: a single long hex string, or 64-bit words separated by spaces.
// Rather than pick one and be wrong on somebody's machine, both readings are
// tried and either may answer yes. That is safe here because this is only ever
// a *fallback* for reporting -- never a correctness decision, since events are
// dispatched by their own type regardless of which device they came from.
function bitmapHas(text, bit) {
  const tokens = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return false;
  const wordIndex = Math.floor(bit / 64);
  const inWord = bit % 64;
  const test = (words) => {
    const idx = words.length - 1 - wordIndex; // words are most-significant first
    if (idx < 0 || idx >= words.length) return false;
    let w;
    try {
      w = BigInt("0x" + words[idx]);
    } catch {
      return false;
    }
    return ((w >> BigInt(inWord)) & 1n) === 1n;
  };
  if (tokens.length === 1) return test(tokens);
  return test(tokens) || test([...tokens].reverse());
}

// "pointer" / "keyboard" / "both" / "other", for reporting only.
function classifyDevice(rec) {
  if (!rec) return "unknown";
  const h = rec.handlers || [];
  const isMouse = h.some((x) => /^mouse\d+$/.test(x));
  const isKbd = h.some((x) => x === "kbd");
  if (isMouse && isKbd) return "both";
  if (isMouse) return "pointer";
  if (isKbd) return "keyboard";
  if (rec.rel && bitmapHas(rec.rel, REL.X) && bitmapHas(rec.rel, REL.Y)) return "pointer";
  if (rec.key && bitmapHas(rec.key, 0x110)) return "pointer";
  return "other";
}

// ---------------------------------------------------------------------------
// The capture backend
// ---------------------------------------------------------------------------

// Same shape as the uiohook singleton it replaces, so server-input.js can use
// either without knowing which it has:
//   on(ev, fn) / off(ev, fn) for mousemove | mousedown | mouseup | wheel |
//   keydown | keyup
// plus two things uiohook cannot offer: `canRecenter` (it is false here) and
// an anchor for the synthesised position.
function createEvdevCapture({ log, deps = {} } = {}) {
  const readdir = deps.readdir || ((p) => fs.promises.readdir(p));
  const readFile = deps.readFile || ((p, enc) => fs.promises.readFile(p, enc));
  const access = deps.access || ((p) => fs.promises.access(p, fs.constants.R_OK));
  const createReadStream = deps.createReadStream || ((p, o) => fs.createReadStream(p, o));
  const size = eventSize(deps.arch || process.arch);
  const accessInfo = deps.uinputAccess || uinputAccess;

  const listeners = {
    mousemove: [],
    mousedown: [],
    mouseup: [],
    wheel: [],
    keydown: [],
    keyup: [],
  };
  const devices = [];
  let started = false;
  let pos = { x: 0, y: 0 };
  let anchored = false;
  let lastError = null;
  let frames = 0;

  const emit = (ev, payload) => {
    for (const fn of listeners[ev] || []) {
      try {
        fn(payload);
      } catch (e) {
        log?.debug?.(`evdev ${ev} listener threw: ${e.message}`);
      }
    }
  };

  function onFrame(f) {
    frames += 1;
    if (f.kind === "move") {
      // Integrate. The absolute value is a model, not a measurement; only the
      // deltas are real. See setAnchor for how the model is kept honest.
      pos = { x: pos.x + f.dx, y: pos.y + f.dy };
      anchored = true;
      emit("mousemove", { x: pos.x, y: pos.y, dx: f.dx, dy: f.dy, relative: true });
      return;
    }
    if (f.kind === "down") return emit("mousedown", { button: f.button });
    if (f.kind === "up") return emit("mouseup", { button: f.button });
    if (f.kind === "wheel") return emit("wheel", { rotation: f.rotation, direction: f.direction });
    if (f.kind === "keydown") return emit("keydown", { keycode: f.keycode });
    if (f.kind === "keyup") return emit("keyup", { keycode: f.keycode });
  }

  async function discover() {
    const skipped = [];
    const found = [];
    let records = [];
    let procError = null;
    try {
      records = parseInputDevices(await readFile("/proc/bus/input/devices", "utf8"));
    } catch (e) {
      // Not fatal: without it we can still enumerate /dev/input, we just lose
      // the names and the kernel's own classification.
      procError = e.message;
    }
    const byEvent = new Map();
    for (const r of records) {
      const ev = (r.handlers || []).find((h) => /^event\d+$/.test(h));
      if (ev) byEvent.set(ev, r);
    }

    let names;
    try {
      names = await readdir("/dev/input");
    } catch (e) {
      return { devices: [], skipped, error: `读不到 /dev/input：${e.message}` };
    }
    const eventNames = names
      .filter((n) => /^event\d+$/.test(n))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    if (!eventNames.length) {
      return { devices: [], skipped, error: "/dev/input 下没有任何 eventN 设备" };
    }

    for (const n of eventNames) {
      const rec = byEvent.get(n);
      const name = rec ? rec.name : "(未命名)";
      if (isOurOwnDevice(name)) {
        // Our own injector's virtual device. Reading it would feed injected
        // motion back in as user input.
        skipped.push({ path: `/dev/input/${n}`, name, why: "netmouse 自己的虚拟设备" });
        continue;
      }
      const path = `/dev/input/${n}`;
      const d = { path, name, kind: classifyDevice(rec), readable: false, error: null };
      try {
        await access(path);
        d.readable = true;
      } catch (e) {
        d.error = e.code === "EACCES" ? "权限不足" : e.message;
      }
      found.push(d);
    }
    return { devices: found, skipped, error: procError };
  }

  // The permission story for /dev/input/event* is the same as for /dev/uinput
  // (group `input`, mode 0660 on every mainstream distro), and it has the same
  // three look-alike failure modes. Reusing the uinput diagnosis keeps the two
  // consistent and keeps the "you are in the group but this session has not
  // caught up" distinction -- which is the one that wastes an afternoon,
  // because re-running usermod appears to do nothing.
  function permissionHint(path) {
    try {
      const a = accessInfo({ path });
      return a.hint;
    } catch {
      return null;
    }
  }

  return {
    name: "evdev",
    // evdev never warps the physical cursor, so there is nothing to re-centre.
    canRecenter: false,
    // And it cannot report where the cursor is either: only deltas exist. The
    // server must therefore trigger on a gesture, not on a position -- see the
    // push model in server-input.js.
    positionKind: "relative",

    on(ev, fn) {
      (listeners[ev] || (listeners[ev] = [])).push(fn);
    },
    off(ev, fn) {
      if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn);
    },

    // The synthesised cursor position, and the way to re-anchor it.
    //
    // An anchor is a *statement about where the pointer is*, made at a moment
    // when that is known independently of the delta stream:
    //   * on capture, the centre of the desktop -- the uiohook path warps the
    //     real cursor there for the same reason, to leave travel room in every
    //     direction;
    //   * on release, just inside the shared edge, because that is physically
    //     where the pointer was when control came back.
    // Without the second one the model would drift further from reality on
    // every hand-over, and the edge would trigger at the wrong place.
    setAnchor(x, y) {
      pos = { x: Math.round(x), y: Math.round(y) };
      anchored = true;
    },
    getAnchor: () => ({ ...pos, anchored }),

    async start() {
      if (started) return { ok: false, reason: "already-started" };
      const disc = await discover();
      devices.length = 0;
      devices.push(...disc.devices);
      const readable = devices.filter((d) => d.readable);
      if (!readable.length) {
        const sample = devices[0];
        lastError = devices.length
          ? `没有可读的输入设备（${sample ? sample.path + "：" + sample.error : "未发现设备"}）`
          : disc.error || "没有找到输入设备";
        return {
          ok: false,
          reason: lastError,
          hint: devices.length ? permissionHint(devices[0].path) : null,
          devices: devices.map((d) => ({ ...d, stream: undefined })),
        };
      }

      for (const d of readable) {
        const decoder = createFrameDecoder({ size, onFrame });
        d.decoder = decoder;
        try {
          const stream = createReadStream(d.path, { highWaterMark: size * 32 });
          stream.on("data", (chunk) => decoder.push(chunk));
          stream.on("error", (e) => {
            // A device can disappear (unplugged) or be revoked mid-session.
            d.error = e.message;
            log?.debug?.(`evdev ${d.path} 读取出错：${e.message}`);
          });
          if (stream.unref) stream.unref();
          d.stream = stream;
        } catch (e) {
          d.error = e.message;
          log?.debug?.(`evdev 无法打开 ${d.path}：${e.message}`);
        }
      }
      started = true;
      const pointers = devices.filter((d) => d.kind === "pointer" || d.kind === "both");
      log?.info?.(
        `Wayland 原生捕获（evdev）已启动：读取 ${readable.length} 个设备` +
          `（指针 ${pointers.length} 个），跳过 ${disc.skipped.length} 个自己的虚拟设备`
      );
      for (const s of disc.skipped) log?.debug?.(`evdev 跳过 ${s.path}（${s.name}）：${s.why}`);
      return { ok: true, devices: devices.map((d) => ({ ...d, stream: undefined })) };
    },

    stop() {
      if (!started) return;
      for (const d of devices) {
        try {
          d.stream?.destroy?.();
        } catch {
          /* already gone */
        }
        d.stream = null;
        d.decoder = null;
      }
      started = false;
      log?.info?.("Wayland 原生捕获（evdev）已停止");
    },

    isStarted: () => started,
    frames: () => frames,
    // Health, for the doctor and the self-test.
    status() {
      return {
        started,
        error: lastError,
        devices: devices.map((d) => ({
          path: d.path,
          name: d.name,
          kind: d.kind,
          readable: d.readable,
          error: d.error,
        })),
      };
    },
  };
}

module.exports = {
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
  BTN_MAP,
  WHEEL_VERTICAL,
  WHEEL_HORIZONTAL,
  EVENT_SIZE_64,
  EVENT_SIZE_32,
  OUR_DEVICE_PATTERNS,
};

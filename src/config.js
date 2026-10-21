const fs = require("fs");
const path = require("path");

// The capture backend names live with the backend selector so the two cannot
// drift apart. capture.js has no top-level dependencies, so requiring it here
// costs nothing at load time.
const { CAPTURE_MODES } = require("./capture");

// ---------------------------------------------------------------------------
// Defaults. Everything the app needs is filled in here, so a config file only
// has to contain the keys the user actually cares about.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  role: "server", // server | client
  listenPort: 24800,
  peer: { host: "", port: 24800, password: "change-me-strong-password" },
  layout: {
    // left | right | top | bottom | any
    // "any" hands control over on whichever boundary the cursor reaches first,
    // which is the forgiving choice when you are not sure which side the other
    // machine sits on (or when a multi-monitor layout makes it ambiguous).
    edge: "right",
    screenWidth: 1920, // server virtual desktop width (auto-detected at runtime)
    screenHeight: 1080, // server virtual desktop height (auto-detected at runtime)
    // Which monitor's edge triggers the hand-over: "all" (whole virtual desktop),
    // "primary", or a 0-based index. Monitors are listed primary-first.
    monitor: "all",
  },
  input: {
    // While the server is driving the peer, swallow the physical keyboard and
    // mouse so stray clicks/keys do not land in the server's own windows.
    // false = old behaviour (events reach local apps).
    blockLocal: true,
    // Global escape hatch, read from the physical keyboard regardless of which
    // window has focus: drops remote control and releases the input block.
    panicHotkey: "Ctrl+Alt+Shift+Q",
    // How many nut-js "amount" units make ONE wheel notch on this machine.
    // nut-js forwards the value straight to libnut, where it means the raw
    // wheel delta on Windows (120 = one notch) but a notch count on X11/macOS.
    // 0/absent = use the built-in per-platform default (platform.scrollUnit()).
    // Only touch this if scrolling is too slow or too fast by a factor of ~120.
    // Meaningless for the uinput backend, which takes a notch count, not a
    // raw wheel delta.
    scrollUnit: 0,
    // How the CLIENT injects input on this machine:
    //   auto   (default) XTest on X11; uinput on Wayland when dotool/ydotool is
    //          installed. The program can see the session type itself, so this
    //          is almost never worth changing.
    //   xtest  force libnut/XTest. Only works on X11 (and Windows/macOS).
    //   uinput force a virtual kernel device via dotool/ydotool. The only thing
    //          that works under Wayland; needs a one-time install.
    backend: "auto",
    // ydotool is a client with no device of its own: it does nothing until the
    // ydotoold daemon is running. true (default) = NetMouse reuses a daemon that
    // is already up (including ydotool's own system service, which runs as root
    // and therefore needs no group membership), and starts a private one when
    // there is none, shutting it down again on exit.
    // false = only ever reuse; never start one. For users who run the daemon
    // themselves and do not want a second one.
    manageYdotoold: true,
    // How the SERVER sees the local mouse and keyboard. Only meaningful on
    // Linux; Windows and macOS always use the native hook.
    //   auto    (default) uiohook on X11, evdev on Wayland. The session type is
    //           observable, so this is almost never worth changing.
    //   uiohook the X11 client hook. Under Wayland it goes through Xwayland and
    //           therefore only sees events while an X11 window has focus.
    //   evdev   read /dev/input/event* directly. Works under any display
    //           protocol, but needs read access to the device nodes (group
    //           `input`) and, having no absolute coordinates to read, uses the
    //           "push toward an edge" gesture instead of "cursor at the edge".
    // If the chosen backend cannot start, the other one is tried and the log
    // says so -- having no capture at all is worse than the wrong backend.
    capture: "auto",
  },
  clipboard: {
    enabled: true, // share the clipboard between the two ends
    // Images as well as text. Only takes effect when the peer also advertises
    // the capability (see protocol.js `CAPS`), so turning this on cannot break
    // an older peer.
    images: true,
    // Ceiling on the ENCODED image we will send or accept -- PNG normally, or
    // JPEG when the PNG does not fit (see clipboard.js). A screenshot lands well
    // under this; a photo that does not gets re-encoded, and only if even the
    // lowest JPEG quality is still over is it dropped. Base64 inflates the
    // number ~4/3 on the wire.
    maxImageBytes: 8000000,
  },
  logging: { level: "info" }, // error | warn | info | debug
  ui: {
    autoStart: true, // start the node as soon as the app launches
    minimizeToTray: true, // closing the window keeps NetMouse running
  },
};

const ROLES = ["server", "client"];
const EDGES = ["left", "right", "top", "bottom"];
// `layout.edge` additionally accepts "any": hand over on whichever boundary the
// cursor reaches first. Kept separate from EDGES so the places that need a
// concrete direction (oppositeOf, per-monitor edge maths) never see "any".
const EDGE_MODES = [...EDGES, "any"];
const LEVELS = ["error", "warn", "info", "debug"];
// Client-side injection backends. "auto" is the only one that needs no
// knowledge from the user: the session type is observable at runtime.
const BACKENDS = ["auto", "xtest", "uinput"];

// ---------------------------------------------------------------------------
// Where config.json may live.
//
// Order matters. A packaged app must never depend on a read-only location:
//   * Windows NSIS install -> <install dir>\config.json is writable
//   * Linux AppImage       -> <mount>/config.json is read-only
//   * Linux deb            -> /opt/... is root-owned
// so the per-user data dir is checked first. It is only used once the GUI
// actually saves something; until then the shipped file wins.
// ---------------------------------------------------------------------------
function bundledConfigPath() {
  return path.join(__dirname, "..", "config.json");
}

// ---------------------------------------------------------------------------
// Portable builds ("no install, just run the file").
//
// electron-builder's `portable` target unpacks the app into a temp dir on every
// launch and points PORTABLE_EXECUTABLE_DIR at the folder holding the *real*
// .exe; an AppImage likewise exposes its own path in APPIMAGE. In both cases
// the thing the user owns is a single file, so the config belongs right next to
// it — the copy inside the app is a throwaway extraction.
//
// NETMOUSE_PORTABLE_DIR is our own escape hatch, used by the Linux portable
// launcher scripts, which know where the user actually put the file.
// ---------------------------------------------------------------------------
function portableDir() {
  if (process.env.NETMOUSE_PORTABLE_DIR) return process.env.NETMOUSE_PORTABLE_DIR;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.env.APPIMAGE) return path.dirname(process.env.APPIMAGE);
  return null;
}

function isPortable() {
  return portableDir() !== null;
}

function candidatePaths(opts = {}) {
  const { userDataDir } = opts;
  const list = [];
  if (process.env.NETMOUSE_CONFIG) list.push(process.env.NETMOUSE_CONFIG);
  const pdir = portableDir();
  if (pdir) list.push(path.join(pdir, "config.json"));
  if (userDataDir) list.push(path.join(userDataDir, "config.json"));
  if (process.execPath) {
    list.push(path.join(path.dirname(process.execPath), "config.json"));
  }
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, "config.json"));
  }
  list.push(bundledConfigPath());
  return list;
}

function resolveConfigPath(opts = {}) {
  for (const p of candidatePaths(opts)) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable candidate, keep looking */
    }
  }
  return null;
}

function isInsideAsar(p) {
  return /[\\/]app\.asar[\\/]/.test(p);
}

function canWriteTo(filePath) {
  if (!filePath || isInsideAsar(filePath)) return false;
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    try {
      fs.accessSync(path.dirname(filePath), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// Where the GUI should persist changes. Prefer the file we read from when it
// is actually writable, otherwise fall back to the per-user data dir.
function resolveWritePath(readPath, opts = {}) {
  if (process.env.NETMOUSE_CONFIG) return process.env.NETMOUSE_CONFIG;
  if (readPath && !isInsideAsar(readPath) && canWriteTo(readPath)) return readPath;

  // Nothing readable yet (fresh portable first run): write beside the exe so
  // the tool stays self-contained.
  const pdir = portableDir();
  if (pdir) {
    const p = path.join(pdir, "config.json");
    if (canWriteTo(p)) return p;
  }

  if (opts.userDataDir) return path.join(opts.userDataDir, "config.json");
  return readPath || bundledConfigPath();
}

// ---------------------------------------------------------------------------
// JSONC. The shipped config.json carries `//` annotations, so strip comments
// (and stray trailing commas) before handing it to JSON.parse.
// ---------------------------------------------------------------------------
function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalize(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {});

  if (!ROLES.includes(cfg.role)) {
    throw new Error(`config.role must be "server" or "client", got "${cfg.role}"`);
  }
  if (!EDGE_MODES.includes(cfg.layout.edge)) {
    throw new Error(
      `config.layout.edge must be one of ${EDGE_MODES.join("|")}, got "${cfg.layout.edge}"`
    );
  }
  if (!LEVELS.includes(cfg.logging.level)) {
    throw new Error(
      `config.logging.level must be one of ${LEVELS.join("|")}, got "${cfg.logging.level}"`
    );
  }

  cfg.listenPort = clampInt(cfg.listenPort, 24800, 1, 65535);
  cfg.peer.port = clampInt(cfg.peer.port, 24800, 1, 65535);
  cfg.peer.host = String(cfg.peer.host || "").trim();
  cfg.peer.password = String(cfg.peer.password ?? "");
  cfg.layout.screenWidth = clampInt(cfg.layout.screenWidth, 1920, 1, 100000);
  cfg.layout.screenHeight = clampInt(cfg.layout.screenHeight, 1080, 1, 100000);
  // monitor: keep a string ("all" | "primary" | "0" | "1" …)
  cfg.layout.monitor =
    cfg.layout.monitor === undefined || cfg.layout.monitor === null
      ? "all"
      : String(cfg.layout.monitor);
  cfg.input.blockLocal = cfg.input.blockLocal !== false;
  cfg.input.panicHotkey =
    cfg.input.panicHotkey === undefined || cfg.input.panicHotkey === null
      ? ""
      : String(cfg.input.panicHotkey).trim();
  // 0 means "use the platform default"; anything else overrides it.
  cfg.input.scrollUnit = clampInt(cfg.input.scrollUnit, 0, 0, 1000);
  // An unknown value falls back to "auto" rather than erroring: a config
  // written by a newer build must not stop an older one from starting.
  cfg.input.backend = BACKENDS.includes(String(cfg.input.backend))
    ? String(cfg.input.backend)
    : "auto";
  // Default true: only an explicit false opts out of the daemon being started
  // for us.
  cfg.input.manageYdotoold = cfg.input.manageYdotoold !== false;
  // An unrecognised value would silently mean "auto", which is confusing to
  // debug; fall back explicitly and say nothing (the log line at capture start
  // already names the backend actually used).
  cfg.input.capture = CAPTURE_MODES.includes(cfg.input.capture) ? cfg.input.capture : "auto";
  cfg.clipboard.enabled = cfg.clipboard.enabled !== false;
  cfg.clipboard.images = cfg.clipboard.images !== false;
  // A non-numeric or non-positive ceiling would either disable images silently
  // or reject everything, so fall back to the default rather than trusting it.
  const mi = Number(cfg.clipboard.maxImageBytes);
  cfg.clipboard.maxImageBytes = Number.isFinite(mi) && mi > 0 ? Math.floor(mi) : DEFAULTS.clipboard.maxImageBytes;
  cfg.ui.autoStart = cfg.ui.autoStart !== false;
  cfg.ui.minimizeToTray = cfg.ui.minimizeToTray !== false;

  return cfg;
}

// Keys that are persisted; runtime-only fields (paths, status) are dropped.
function serialize(cfg) {
  return {
    role: cfg.role,
    listenPort: cfg.listenPort,
    peer: {
      host: cfg.peer.host,
      port: cfg.peer.port,
      password: cfg.peer.password,
    },
    layout: {
      edge: cfg.layout.edge,
      screenWidth: cfg.layout.screenWidth,
      screenHeight: cfg.layout.screenHeight,
      monitor: cfg.layout.monitor,
    },
    input: {
      blockLocal: cfg.input.blockLocal,
      panicHotkey: cfg.input.panicHotkey,
      scrollUnit: cfg.input.scrollUnit,
      backend: cfg.input.backend,
      manageYdotoold: cfg.input.manageYdotoold,
      capture: cfg.input.capture,
    },
    clipboard: {
      enabled: cfg.clipboard.enabled,
      images: cfg.clipboard.images,
      maxImageBytes: cfg.clipboard.maxImageBytes,
    },
    logging: { level: cfg.logging.level },
    ui: { autoStart: cfg.ui.autoStart, minimizeToTray: cfg.ui.minimizeToTray },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function loadConfig(overrides = {}, opts = {}) {
  // Drop undefined overrides so they don't clobber file values.
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined)
  );

  const readPath = resolveConfigPath(opts);
  let raw = {};

  if (readPath) {
    try {
      raw = parseJsonc(fs.readFileSync(readPath, "utf8"));
    } catch (err) {
      throw new Error(`cannot parse ${readPath}: ${err.message}`);
    }
  }

  const cfg = normalize(deepMerge(raw, clean));
  const writePath = resolveWritePath(readPath, opts);

  cfg.configPath = readPath;
  cfg.writePath = writePath;
  cfg.configWritable = canWriteTo(writePath);
  cfg.searchedPaths = candidatePaths(opts);
  cfg.portable = isPortable();
  cfg.portableDir = portableDir();
  return cfg;
}

// Atomic write: tmp file + rename, so a crash mid-save cannot truncate config.
function saveConfig(cfg, opts = {}) {
  const readPath = resolveConfigPath(opts);
  const target = resolveWritePath(readPath, opts);

  if (isInsideAsar(target)) {
    throw new Error("cannot write into app.asar");
  }

  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const body = JSON.stringify(serialize(cfg), null, 2) + "\n";
  const tmp = path.join(dir, `.config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

module.exports = {
  DEFAULTS,
  ROLES,
  EDGES,
  EDGE_MODES,
  BACKENDS,
  LEVELS,
  loadConfig,
  saveConfig,
  normalize,
  serialize,
  parseJsonc,
  resolveConfigPath,
  resolveWritePath,
  candidatePaths,
  canWriteTo,
  bundledConfigPath,
  portableDir,
  isPortable,
  get CONFIG_PATH() {
    return resolveConfigPath();
  },
};

const { spawnSync } = require("child_process");
const { detectUinputTool, describeTool } = require("./inject-uinput");

// ---------------------------------------------------------------------------
// Runtime platform facts + the warnings the settings UI should show.
//
// The CAPTURE stack (uiohook-napi) is X11-based on Linux, so a Wayland session
// only works through Xwayland. The INJECTION stack is worse: libnut uses XTest,
// and under Wayland Xwayland accepts every XTest call while delivering the
// events to nobody -- see the long note at the top of inject-uinput.js. That
// asymmetry is why this file has to distinguish "can capture" from "can inject".
// ---------------------------------------------------------------------------

let xdotoolCache = null;

function hasXdotool() {
  if (xdotoolCache !== null) return xdotoolCache;
  if (process.platform !== "linux") {
    xdotoolCache = true; // only required on Linux
    return xdotoolCache;
  }
  try {
    xdotoolCache = spawnSync("which", ["xdotool"], { stdio: "ignore" }).status === 0;
  } catch {
    xdotoolCache = false;
  }
  return xdotoolCache;
}

// Is this a Wayland session (as opposed to a real Xorg one)?
//
// XDG_SESSION_TYPE is the authoritative signal; WAYLAND_DISPLAY is the
// fallback for sessions that set the socket without the type. Having a DISPLAY
// as well does NOT mean X11 -- it only means Xwayland is running, which is the
// trap: Xwayland makes XTest *look* like it works.
function isWaylandSession(env = process.env, platform = process.platform) {
  if (platform !== "linux") return false;
  const type = (env.XDG_SESSION_TYPE || "").toLowerCase();
  return type === "wayland" || !!env.WAYLAND_DISPLAY;
}

// ---------------------------------------------------------------------------
// Wheel unit: how many "amount" units nut-js needs for ONE wheel notch.
//
// nut-js's scrollUp/scrollDown/scrollLeft/scrollRight forward `amount` straight
// to libnut without any normalisation (libnut-mouse.class.js), and libnut's
// meaning for it is NOT portable:
//
//   Windows : mouse_event(MOUSEEVENTF_WHEEL, ..., amount) — `amount` is the raw
//             wheel delta, and one notch is WHEEL_DELTA = 120.
//   X11     : `amount` is a click count; each click is one button-4/5 press,
//             i.e. one notch.
//   macOS   : CGEventCreateScrollWheelEvent(kCGScrollEventUnitLine, ..., amount)
//             — one line per unit.
//
// Measured on Windows with the real global hook: scrollUp(120) is exactly one
// notch, scrollUp(240) is two, and scrollUp(1) produces a rotation of 0 — a
// 1/120th of a notch, i.e. nothing at all. So a caller that passes "1 notch"
// to nut-js scrolls *nothing* on Windows and one notch on Linux.
// ---------------------------------------------------------------------------
function scrollUnit() {
  return process.platform === "win32" ? 120 : 1;
}

// ---------------------------------------------------------------------------
// Screen geometry (virtual desktop + per-monitor boxes)
//
// uiohook reports absolute coordinates in the *virtual desktop* space, whose
// origin is negative when a monitor sits left of / above the primary one, and
// nut-js injects in the same absolute space. Both edge detection and coordinate
// scaling need the whole-desktop box, not one monitor's size.
//
// Detection order:
//   1. Electron's `screen` module — DPI-aware and always in physical pixels,
//      which is the same space the OS hooks report. Only available in the main
//      process after `app.whenReady()`.
//   2. A platform shell-out (PowerShell / xrandr) for headless CLI mode.
//
// IMPORTANT: `powershell.exe` is *not* per-monitor DPI aware, so on a scaled
// display (e.g. 150%) its `Screen.Bounds` come back in virtualised logical
// pixels and disagree with the physical coordinates uiohook sends. Electron's
// screen module does not have that problem, which is why it is preferred.
// ---------------------------------------------------------------------------

let vsCache = null;
let monCache = null;

// Drop cached geometry. Call after a display change (hotplug / resolution) or
// when the UI asks for a fresh reading.
function invalidateScreenCache() {
  vsCache = null;
  monCache = null;
}

const rnd = (n) => Math.round(n);

// A compact, human-readable geometry signature used as a *stable* monitor
// identity in config (an index silently points at the wrong screen once the
// user plugs another monitor in; "1728x2170+0+0" does not).
function monitorSig(m) {
  const sx = m.x >= 0 ? `+${m.x}` : `${m.x}`;
  const sy = m.y >= 0 ? `+${m.y}` : `${m.y}`;
  return `${m.width}x${m.height}${sx}${sy}`;
}

// Raw display list as Electron reports it (bounds are DIP points), plus the
// physical rect we derive. Exported for the `--diag` diagnostic.
function rawDisplays() {
  if (!process.versions.electron) return null;
  try {
    const { screen } = require("electron");
    if (!screen || typeof screen.getAllDisplays !== "function") return null;
    const primaryId = screen.getPrimaryDisplay()?.id;
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      primary: d.id === primaryId,
      bounds: { ...d.bounds }, // DIP
      scaleFactor: d.scaleFactor || 1,
      rotation: d.rotation,
      label: d.label,
    }));
  } catch {
    return null;
  }
}

// Monitors via Electron's screen module, in PHYSICAL pixels (the same space the
// OS input hooks report in), or null.
//
// The conversion is the subtle part. `display.bounds` is in DIP points, and
// under MIXED per-monitor DPI a secondary display's DIP origin is NOT its
// physical origin divided by its own scale factor -- so the naive
// `bounds * scaleFactor` (what this used to do) produces a virtual desktop that
// is larger than the coordinate range the cursor can actually reach, and the
// shared edge is then never touched. Chromium exposes its own conversion,
// `screen.dipToScreenRect`, which is DPI-correct; use that first (win32 only)
// and keep the naive math only as a last resort.
function electronMonitors() {
  if (!process.versions.electron) return null;
  try {
    const { screen } = require("electron");
    if (!screen || typeof screen.getAllDisplays !== "function") return null;
    const displays = screen.getAllDisplays();
    if (!displays || !displays.length) return null;
    const primaryId = screen.getPrimaryDisplay()?.id;
    const canConvert = process.platform === "win32" && typeof screen.dipToScreenRect === "function";
    const list = displays.map((d) => {
      const s = d.scaleFactor || 1;
      let rect = null;
      if (canConvert) {
        try {
          const r = screen.dipToScreenRect(null, d.bounds);
          if (r && r.width > 0 && r.height > 0) rect = r;
        } catch {
          rect = null;
        }
      }
      const physical = rect
        ? { x: rnd(rect.x), y: rnd(rect.y), width: rnd(rect.width), height: rnd(rect.height) }
        : {
            x: rnd(d.bounds.x * s),
            y: rnd(d.bounds.y * s),
            width: rnd(d.bounds.width * s),
            height: rnd(d.bounds.height * s),
          };
      return {
        ...physical,
        primary: d.id === primaryId,
        scaleFactor: s,
        id: String(d.id),
        dip: { ...d.bounds },
        converted: !!rect,
      };
    });
    return list;
  } catch {
    return null;
  }
}

// --- xrandr parsing (kept exported: the selftest asserts on it) -------------

function parseXrandrBounds(text) {
  // "Screen 0: minimum 320 x 200, current 3456 x 2170, maximum ..."
  const m = /current\s+(\d+)\s+x\s+(\d+)/.exec(text);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  // xrandr "current" does not expose a negative origin directly; compute the
  // bounding box from the connected outputs' position offsets instead.
  // Positions look like "1728x2170+1728+0" or "1920x1080-1920+0".
  let minX = 0;
  let minY = 0;
  const re = / connected\b.*?(\d+)x(\d+)([+-]\d+)([+-]\d+)/g;
  let mo;
  let seen = false;
  while ((mo = re.exec(text))) {
    const ox = Number(mo[3]);
    const oy = Number(mo[4]);
    if (!seen) {
      minX = ox;
      minY = oy;
      seen = true;
    } else {
      minX = Math.min(minX, ox);
      minY = Math.min(minY, oy);
    }
  }
  return { x: minX, y: minY, width, height };
}

function parseXrandrMonitors(text) {
  const out = [];
  const re = /^(\S+) connected\b.*?(\d+)x(\d+)([+-]\d+)([+-]\d+)/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      x: Number(m[4]),
      y: Number(m[5]),
      width: Number(m[2]),
      height: Number(m[3]),
      primary: /primary/.test(m[0]),
    });
  }
  return out;
}

// --- PowerShell / xrandr fallbacks -----------------------------------------

function shellMonitors() {
  const p = process.platform;
  try {
    if (p === "win32") {
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms;" +
        "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {" +
        '$b=$_.Bounds; "$($b.X),$($b.Y),$($b.Width),$($b.Height),$($_.Primary)" }';
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { encoding: "utf8", timeout: 8000 }
      );
      const list = (r.stdout || "")
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [x, y, width, height, primary] = line.split(",");
          return {
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
            primary: /true/i.test(primary),
          };
        })
        .filter((m) => Number.isFinite(m.width) && m.width > 0);
      return list.length ? list : null;
    }
    if (p === "linux") {
      const r = spawnSync("xrandr", ["--query"], { encoding: "utf8", timeout: 8000 });
      const list = parseXrandrMonitors(r.stdout || "");
      return list.length ? list : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// --- public geometry API ---------------------------------------------------

// Per-monitor boxes in virtual-desktop space, primary first.
function detectMonitors(opts = {}) {
  if (monCache && !opts.force) return monCache;
  const list = electronMonitors() || shellMonitors();
  if (!list || !list.length) {
    if (!monCache) return [];
    return monCache; // keep the last good reading rather than flapping to []
  }
  monCache = list
    .map((m) => ({ ...m, sig: monitorSig(m) }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  return monCache;
}

// Whole-desktop bounding box, or null when detection is unavailable.
function detectVirtualScreen(opts = {}) {
  if (vsCache && !opts.force) return vsCache;
  const monitors = detectMonitors(opts);
  if (monitors.length) {
    const minX = Math.min(...monitors.map((m) => m.x));
    const minY = Math.min(...monitors.map((m) => m.y));
    const maxX = Math.max(...monitors.map((m) => m.x + m.width));
    const maxY = Math.max(...monitors.map((m) => m.y + m.height));
    vsCache = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    return vsCache;
  }
  // Last resort on Linux without Electron/xrandr: trust the config later.
  return null;
}

// Whole-desktop bounding box in **DIP points** — the space Electron's own window
// geometry lives in (BrowserWindow x/y/width/height, setBounds).
//
// This is deliberately separate from detectVirtualScreen(): that one is in
// PHYSICAL pixels, because it has to line up with what the OS input hook
// reports. Under per-monitor DPI scaling the two differ (a 200% 2880x1800 panel
// is 1440x900 in DIP), and handing physical pixels to a window API puts the
// window in the wrong place and the wrong size. An overlay built from the
// physical box can end up not covering the screen at all on a mixed-DPI desk.
//
// Returns null when Electron is unavailable; callers then fall back to the
// physical box, which is correct on every platform that does not scale.
function detectVirtualDipScreen() {
  if (!process.versions.electron) return null;
  try {
    const { screen } = require("electron");
    if (!screen || typeof screen.getAllDisplays !== "function") return null;
    const displays = screen.getAllDisplays();
    if (!displays || !displays.length) return null;
    const minX = Math.min(...displays.map((d) => d.bounds.x));
    const minY = Math.min(...displays.map((d) => d.bounds.y));
    const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
    const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  } catch {
    return null;
  }
}

// Everything the input layer needs, plus a signature to detect changes.
function getScreenInfo(opts = {}) {
  const monitors = detectMonitors(opts);
  const virtual = detectVirtualScreen(opts);
  const signature = monitors.length
    ? monitors.map((m) => m.sig).join("|")
    : virtual
    ? `${virtual.width}x${virtual.height}${virtual.x >= 0 ? "+" : ""}${virtual.x}${
        virtual.y >= 0 ? "+" : ""
      }${virtual.y}`
    : "";
  return { virtual, monitors, signature };
}

// Resolve `layout.monitor` against the current monitor list.
// Accepts "all", "primary", a 0-based index, or a geometry signature
// ("1728x2170+0+0") which survives monitor reshuffles.
// Returns { index, monitor } or null (meaning: use the whole virtual desktop).
function resolveMonitor(sel, monitors) {
  if (sel === undefined || sel === null || sel === "" || sel === "all") return null;
  if (!monitors || !monitors.length) return null;
  if (sel === "primary") {
    const i = monitors.findIndex((m) => m.primary);
    return i >= 0 ? { index: i, monitor: monitors[i] } : null;
  }
  if (/^\d+$/.test(String(sel))) {
    const i = Number.parseInt(String(sel), 10);
    return monitors[i] ? { index: i, monitor: monitors[i] } : null;
  }
  const want = String(sel);
  const i = monitors.findIndex((m) => m.sig === want);
  return i >= 0 ? { index: i, monitor: monitors[i] } : null;
}

// How many /dev/input/eventN nodes this process can actually open. This is the
// gate on the evdev capture backend, and it fails for the same reason
// /dev/uinput does (group `input`, mode 0660) -- so the UI can point at the one
// install step that fixes both.
function probeEvdev() {
  const fsMod = require("fs");
  try {
    const names = fsMod.readdirSync("/dev/input").filter((n) => /^event\d+$/.test(n));
    let readable = 0;
    for (const n of names) {
      try {
        fsMod.accessSync(`/dev/input/${n}`, fsMod.constants.R_OK);
        readable += 1;
      } catch {
        /* permission denied, or it vanished */
      }
    }
    return { total: names.length, readable };
  } catch {
    return { total: 0, readable: 0 };
  }
}

function platformInfo(opts = {}) {
  // `opts` exists so the Wayland verdict can be unit-tested from any platform:
  // the interesting branch is unreachable on the machine that builds the
  // release, which is exactly how it went unnoticed for so long.
  const p = opts.platform || process.platform;
  const env = opts.env || process.env;
  const label =
    p === "win32" ? "Windows" : p === "linux" ? "Linux" : p === "darwin" ? "macOS" : p;

  const sessionType = (env.XDG_SESSION_TYPE || "").toLowerCase();
  const display = env.DISPLAY || "";
  const warnings = [];

  const uinputTool =
    "uinputTool" in opts
      ? opts.uinputTool
      : p === "linux"
      ? detectUinputTool()
      : null;
  const wayland = p === "linux" && isWaylandSession(env, p);

  // Can the evdev capture backend work here? One readdir plus an access check
  // per node -- cheap, and it is the difference between "capture works under
  // Wayland" and "capture is dead". Injectable for tests.
  const evdev =
    "evdev" in opts ? opts.evdev : p === "linux" ? probeEvdev() : null;

  if (p === "linux") {
    if (wayland && !display && !evdev?.readable) {
      // This used to be an unconditional "capture cannot work". That stopped
      // being true when the evdev backend landed: /dev/input is the kernel's
      // own stream and needs no DISPLAY at all.
      warnings.push(
        "Wayland 会话且没有 DISPLAY：X11 键鼠钩子（捕获）无法工作。" +
          "但本机也读不到 /dev/input —— 两条捕获路径都断了，本机不能当服务器。" +
          "把用户加进 input 组即可启用 evdev：sudo ./install-linux.sh --uinput 然后注销重登。"
      );
    } else if (wayland && !display) {
      warnings.push(
        `Wayland 会话且没有 DISPLAY：X11 键鼠钩子无法工作，` +
          `但本机可直接读 /dev/input（${evdev.readable} 个设备），` +
          "捕获会自动改用 evdev 后端 —— 不需要 DISPLAY。"
      );
    } else if (wayland && !uinputTool) {
      // The important one. Under Wayland XTest still "succeeds" -- Xwayland
      // implements it -- but the events never reach native Wayland apps and the
      // compositor ignores the pointer warp. So the client looks healthy and
      // does nothing, which is precisely the bug report this warning answers.
      //
      // Note the ORDER of the two fixes. "Log in with Xorg" used to be listed
      // first, and it is simply not available on a modern GNOME (the Linux workstation this
      // was debugged on is pure Wayland -- there is no Xorg session to pick), so
      // leading with it sends the user hunting for a menu entry that is not
      // there. uinput is the fix that always exists.
      warnings.push(
        "Wayland 会话：本机作为「客户端」时输入注入不会生效。" +
          "XTest 只在 X11 下有效；Xwayland 会让它「调用成功、事件却到不了原生应用」，" +
          "于是日志一切正常、对端光标却不动。" +
          "解法：装 uinput 工具（dotool 或 ydotool），input.backend 保持 auto —— " +
          "ydotoold 守护进程由本程序自己拉起，不需要手工配置。" +
          "若你的发行版仍提供 Xorg 会话，选它也能立刻解决（GNOME 50 起多数发行版已不再提供）。"
      );
    } else if (wayland) {
      warnings.push(
        `Wayland 会话：已找到 uinput 工具 ${uinputTool}，客户端将用它注入` +
          "（在内核层建虚拟设备，绕过显示服务器，Wayland 下可用）。"
      );
    } else if (!display) {
      warnings.push("没有 DISPLAY 环境变量：无法访问 X11，键鼠钩子将无法工作。");
    }
    if (!hasXdotool()) {
      warnings.push(
        "未找到 xdotool：server 端转发时无法把本地光标钉在边缘。安装：sudo apt install xdotool"
      );
    }
  }

  // Behaviour that is decided by the operating system rather than by config.
  // The settings UI shows these side by side so it is obvious which options
  // cannot be made identical on the two machines.
  const facts =
    p === "win32"
      ? {
          geometry: "Electron screen + dipToScreenRect（DPI 感知）",
          scaling: "每屏独立 DPI 缩放；DIP ≠ 物理像素",
          injection: "SendInput",
          wheelUnit: scrollUnit(),
          sandbox: null,
          deps: [],
          tray: "系统托盘稳定可用",
        }
      : p === "linux"
      ? {
          geometry: "xrandr 解析（X11）；Electron screen 亦可",
          scaling: "X11 通常 100%；分数缩放对 X11 应用不可见",
          injection: uinputTool
            ? `uinput（${uinputTool}${
                describeTool(uinputTool)?.daemon ? " + ydotoold，由本程序自动拉起" : ""
              }）— Wayland 下可用`
            : "XTest（libnut）— 仅 X11；Wayland 下无效",
          wheelUnit: scrollUnit(),
          sandbox: "chrome-sandbox 需 root:root 4755，否则启动脚本自动加 --no-sandbox",
          deps: ["xdotool", "libx11-6", "libxtst6", "libxt6", "libxrandr2"],
          tray: "托盘依赖桌面环境（GNOME 可能需要扩展），可能不可用",
        }
      : {
          geometry: "Electron screen",
          scaling: "由系统决定",
          injection: "libnut",
          wheelUnit: scrollUnit(),
          sandbox: null,
          deps: [],
          tray: "托盘可用性依桌面环境而定",
        };

  return {
    platform: p,
    label,
    arch: process.arch,
    electron: process.versions.electron || null,
    node: process.versions.node,
    sessionType: sessionType || null,
    display: display || null,
    xdotool: p === "linux" ? hasXdotool() : null,
    // Wayland vs Xorg, and which uinput tool (if any) can inject here. The
    // settings UI shows both so "why does it not work on this machine" has a
    // visible answer instead of a README hunt.
    wayland,
    uinputTool,
    uinputInfo: uinputTool ? describeTool(uinputTool) : null,
    // Which capture backend this machine would use, and why. Shown in the
    // settings window because "capture silently stopped when I clicked a
    // Wayland window" is otherwise invisible.
    evdev,
    capture:
      p === "linux"
        ? wayland
          ? evdev && evdev.readable
            ? `evdev（直接读 /dev/input，${evdev.readable} 个设备）`
            : "uiohook（经 Xwayland）—— 读不到 /dev/input，权限不足"
          : "uiohook（X11）"
        : "uiohook（原生钩子）",
    facts,
    warnings,
  };
}

// --- multi-monitor reasoning ----------------------------------------------

// One line per monitor: physical rect, DIP rect, scale factor, and whether the
// physical rect came from Chromium's own conversion or the naive fallback.
function describeMonitors(monitors) {
  if (!monitors || !monitors.length) return "  (no monitor reported)";
  return monitors
    .map((m, i) => {
      const dip = m.dip
        ? ` dip ${m.dip.width}x${m.dip.height}@(${m.dip.x},${m.dip.y})`
        : "";
      const scale = m.scaleFactor ? ` ${Math.round(m.scaleFactor * 100)}%` : "";
      const how = m.dip ? (m.converted ? "" : " [估算: bounds*scale]") : "";
      return `  #${i}${m.primary ? "(主)" : ""} ${m.width}x${m.height}@(${m.x},${m.y})${scale}${dip}${how}`;
    })
    .join("\n");
}

// Which monitor(s) physically own the virtual desktop's outer edge in `dir`.
// This is what the hand-over triggers on when layout.monitor is "all", and it is
// usually NOT the primary screen — which is exactly the thing that makes
// "moving left does nothing" confusing on a two-monitor desk.
function edgeOwner(dir, monitors) {
  if (!monitors || !monitors.length) return [];
  if (dir !== "left" && dir !== "right" && dir !== "top" && dir !== "bottom") return [];
  const minX = Math.min(...monitors.map((m) => m.x));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  return monitors.filter((m) => {
    if (dir === "left") return m.x === minX;
    if (dir === "right") return m.x + m.width === maxX;
    if (dir === "top") return m.y === minY;
    return m.y + m.height === maxY;
  });
}

// Everything the `--diag` report needs about this machine's screen layout, in
// one object. Pure read; safe to call from the GUI or headless.
function diagSnapshot() {
  const info = getScreenInfo({ force: true });
  const monitors = info.monitors || [];
  const owners = {};
  for (const d of ["left", "right", "top", "bottom"]) {
    owners[d] = edgeOwner(d, monitors).map((m) => monitors.indexOf(m));
  }
  return {
    raw: rawDisplays(),
    monitors,
    virtual: info.virtual,
    signature: info.signature,
    edgeOwners: owners,
    description: describeMonitors(monitors),
  };
}

module.exports = {
  platformInfo,
  hasXdotool,
  isWaylandSession,
  scrollUnit,
  detectVirtualScreen,
  detectVirtualDipScreen,
  detectMonitors,
  getScreenInfo,
  invalidateScreenCache,
  resolveMonitor,
  monitorSig,
  rawDisplays,
  describeMonitors,
  edgeOwner,
  diagSnapshot,
  parseXrandrBounds,
  parseXrandrMonitors,
};

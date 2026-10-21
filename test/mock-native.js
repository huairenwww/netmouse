"use strict";
// ---------------------------------------------------------------------------
// Deterministic stand-ins for the two native modules so the REAL protocol,
// edge-detection, relative-motion and injection logic can be exercised
// end-to-end without a physical mouse, a real OS hook, or a Linux box.
//
// Loaded with `--require` before anything under src/, so the stubs are in
// require.cache by the time src/server-input.js / src/client-input.js resolve
// them.
// ---------------------------------------------------------------------------

// Keep the genuine keycode table (requiring the package only loads the native
// binding, it does not start the hook).
const realUiohook = require("uiohook-napi");
const UiohookKey = realUiohook.UiohookKey;

const listeners = {
  mousemove: [],
  mousedown: [],
  mouseup: [],
  wheel: [],
  keydown: [],
  keyup: [],
};

const hook = {
  _started: false,
  start() {
    this._started = true;
  },
  stop() {
    this._started = false;
  },
  on(ev, fn) {
    (listeners[ev] || (listeners[ev] = [])).push(fn);
  },
  off(ev, fn) {
    if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn);
  },
};

const uiohookMock = {
  UiohookKey,
  WheelDirection: { VERTICAL: 3, HORIZONTAL: 4 },
  uIOhook: hook,
  __started: () => hook._started,
  __emit(ev, payload) {
    (listeners[ev] || []).slice().forEach((fn) => fn(payload));
  },
  __listenerCount() {
    return Object.values(listeners).reduce((n, a) => n + a.length, 0);
  },
};

// --- nut-js mock -----------------------------------------------------------
const injectCalls = [];
const cursor = { x: 0, y: 0 };

// A faithful model of the OS pointer on this machine: hand motion moves it and
// it is CLAMPED to the desktop bounds (as Windows does), while setPosition
// teleports it (that is how the server re-centres itself).
const simCursor = { x: 0, y: 0 };
function clampToDesktop(p) {
  const d = mockDesktop();
  p.x = Math.max(d.x, Math.min(d.x + d.width - 1, p.x));
  p.y = Math.max(d.y, Math.min(d.y + d.height - 1, p.y));
  return p;
}
function handMove(dx, dy) {
  simCursor.x += dx;
  simCursor.y += dy;
  clampToDesktop(simCursor);
  return { x: simCursor.x, y: simCursor.y };
}
function setCursor(x, y) {
  simCursor.x = x;
  simCursor.y = y;
  clampToDesktop(simCursor);
  return { x: simCursor.x, y: simCursor.y };
}

// MUST mirror nut-js exactly (@nut-tree-fork/shared button.enum.js):
//   Button[Button["LEFT"] = 0] = "LEFT";
//   Button[Button["MIDDLE"] = 1] = "MIDDLE";
//   Button[Button["RIGHT"] = 2] = "RIGHT";
// An earlier version of this mock used { LEFT: 1, RIGHT: 2, MIDDLE: 3 } — which
// is the *uiohook* numbering, not nut-js's. Because Button.LEFT is really 0, a
// client-side `if (btn) pressButton(btn)` passed here (1 is truthy) while
// dropping every left click in production (0 is falsy). The mock has to be
// able to fail the same way the real library does.
const Button = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
// Any property access yields the property name, so buildKeyMap() produces a
// usable keycode -> name table without shipping the real enum here.
const Key = new Proxy(
  {},
  { get: (_t, k) => (typeof k === "string" ? k : undefined) }
);

const nutMock = {
  Button,
  Point,
  Key,
  mouse: {
    config: {},
    async setPosition(p) {
      // A teleport: both the injected cursor and the local physical pointer move.
      cursor.x = p.x;
      cursor.y = p.y;
      simCursor.x = p.x;
      simCursor.y = p.y;
      clampToDesktop(simCursor);
      injectCalls.push({ op: "setPosition", x: p.x, y: p.y });
    },
    async pressButton(b) {
      injectCalls.push({ op: "pressButton", b });
    },
    async releaseButton(b) {
      injectCalls.push({ op: "releaseButton", b });
    },
    async scrollUp(n) {
      injectCalls.push({ op: "scrollUp", n });
    },
    async scrollDown(n) {
      injectCalls.push({ op: "scrollDown", n });
    },
    async scrollLeft(n) {
      injectCalls.push({ op: "scrollLeft", n });
    },
    async scrollRight(n) {
      injectCalls.push({ op: "scrollRight", n });
    },
  },
  keyboard: {
    config: {},
    async pressKey(k) {
      injectCalls.push({ op: "pressKey", k });
    },
    async releaseKey(k) {
      injectCalls.push({ op: "releaseKey", k });
    },
  },
  screen: {
    async width() {
      return mockDesktop().width;
    },
    async height() {
      return mockDesktop().height;
    },
  },
  __calls: injectCalls,
  __cursor: cursor,
  __simCursor: simCursor,
  __handMove: handMove,
  __setCursor: setCursor,
};

// --- platform mock ---------------------------------------------------------
// Each runner process declares its own desktop so a server (1920x1080) and a
// client (e.g. 2560x1440) can be simulated simultaneously.
//
// NETMOUSE_MOCK_DESKTOP   one spec, e.g. "1920x1080" or "1440x2560-1440+0"
// NETMOUSE_MOCK_MONITORS  comma-separated list for a multi-monitor desk, e.g.
//                         "2880x1800+0+0,1440x2560+2880+0". The first entry is
//                         the primary; the virtual desktop is their bounding
//                         box, exactly like the real platform layer computes it.
function parseSpec(spec) {
  const m = /^(\d+)x(\d+)(?:([+-]\d+)([+-]\d+))?$/.exec(String(spec).trim());
  if (!m) return null;
  return {
    x: m[3] ? Number(m[3]) : 0,
    y: m[4] ? Number(m[4]) : 0,
    width: Number(m[1]),
    height: Number(m[2]),
  };
}

function mockMonitors() {
  const raw =
    process.env.NETMOUSE_MOCK_MONITORS ||
    process.env.NETMOUSE_MOCK_DESKTOP ||
    "1920x1080";
  const list = String(raw)
    .split(",")
    .map(parseSpec)
    .filter(Boolean);
  if (!list.length) list.push({ x: 0, y: 0, width: 1920, height: 1080 });
  list.forEach((m, i) => {
    m.primary = i === 0;
  });
  return list;
}

function mockDesktop() {
  const ms = mockMonitors();
  const x = Math.min(...ms.map((m) => m.x));
  const y = Math.min(...ms.map((m) => m.y));
  const width = Math.max(...ms.map((m) => m.x + m.width)) - x;
  const height = Math.max(...ms.map((m) => m.y + m.height)) - y;
  return { x, y, width, height };
}

function mockSig(m) {
  return `${m.width}x${m.height}${m.x >= 0 ? "+" : ""}${m.x}${m.y >= 0 ? "+" : ""}${m.y}`;
}

const platformMock = {
  getScreenInfo() {
    const monitors = mockMonitors().map((m) => ({ ...m, sig: mockSig(m) }));
    return { virtual: mockDesktop(), monitors, signature: monitors.map((m) => m.sig).join("|") };
  },
  detectVirtualScreen() {
    return mockDesktop();
  },
  detectVirtualDipScreen() {
    return mockDesktop();
  },
  detectMonitors() {
    return this.getScreenInfo().monitors;
  },
  invalidateScreenCache() {},
  resolveMonitor(sel, monitors) {
    if (sel === undefined || sel === null || sel === "" || sel === "all") return null;
    if (!monitors || !monitors.length) return null;
    if (sel === "primary") return { index: 0, monitor: monitors[0] };
    if (/^\d+$/.test(String(sel))) {
      const i = Number.parseInt(String(sel), 10);
      return monitors[i] ? { index: i, monitor: monitors[i] } : null;
    }
    const i = monitors.findIndex((m) => m.sig === String(sel));
    return i >= 0 ? { index: i, monitor: monitors[i] } : null;
  },
  hasXdotool() {
    return false;
  },
  // The e2e suite runs on the XTest path, so default to "not Wayland". Set
  // NETMOUSE_MOCK_WAYLAND=1 to exercise the Wayland branch of chooseBackend.
  isWaylandSession() {
    return process.env.NETMOUSE_MOCK_WAYLAND === "1";
  },
  // The e2e suite asserts on the wire values the client *sends* to nut-js, so
  // pin the unit to 1 and keep the arithmetic obvious. (The real function is
  // platform-dependent: 120 on Windows, 1 elsewhere.)
  scrollUnit() {
    return 1;
  },
  platformInfo() {
    return { platform: process.platform, warnings: [] };
  },
  monitorSig: mockSig,
  describeMonitors(monitors) {
    return (monitors || [])
      .map(
        (m, i) =>
          `  #${i}${m.primary ? "(主)" : ""} ${m.width}x${m.height}@(${m.x},${m.y})`
      )
      .join("\n");
  },
  edgeOwner(dir, monitors) {
    if (!monitors || !monitors.length) return [];
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
  },
  rawDisplays() {
    return null;
  },
  diagSnapshot() {
    const info = this.getScreenInfo();
    const owners = {};
    for (const d of ["left", "right", "top", "bottom"]) {
      owners[d] = this.edgeOwner(d, info.monitors).map((m) => info.monitors.indexOf(m));
    }
    return {
      raw: null,
      monitors: info.monitors,
      virtual: info.virtual,
      signature: info.signature,
      edgeOwners: owners,
      description: this.describeMonitors(info.monitors),
    };
  },
  parseXrandrBounds: () => null,
  parseXrandrMonitors: () => [],
};

// --- install ---------------------------------------------------------------
function stub(spec, exports) {
  const id = require.resolve(spec);
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

const path = require("path");
stub("uiohook-napi", uiohookMock);
stub("@nut-tree-fork/nut-js", nutMock);
stub(path.resolve(__dirname, "..", "src", "platform.js"), platformMock);

module.exports = { uiohookMock, nutMock, platformMock, mockDesktop };

"use strict";
// ---------------------------------------------------------------------------
// Child process used by test/e2e.js. Runs ONE real NetMouse role (server or
// client) with the native layer mocked, and speaks a tiny JSON-lines protocol
// on stdin/stdout so the parent can drive synthetic input and read back the
// injected actions.
// ---------------------------------------------------------------------------

// Mocks must be installed before any src/ module is required.
require("./mock-native");
const readline = require("readline");

const { createServer, createClient } = require("../src/app");

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const role = arg("--role", "server");
const port = Number(arg("--port", "24800"));
const host = arg("--host", "127.0.0.1");
const edge = arg("--edge", "right");
const password = arg("--password", "test-pw");
const monitor = arg("--monitor", "all");

const cfg = {
  role,
  listenPort: port,
  peer: { host, port, password },
  layout: { edge, screenWidth: 1920, screenHeight: 1080, monitor },
  logging: { level: "error" },
  input: { blockLocal: false, panicHotkey: "Ctrl+Alt+Shift+Q" },
  clipboard: { enabled: false },
  ui: {},
};

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const log = {
  info: (...a) => out({ ev: "log", lvl: "info", m: a.join(" ") }),
  warn: (...a) => out({ ev: "log", lvl: "warn", m: a.join(" ") }),
  error: (...a) => out({ ev: "log", lvl: "error", m: a.join(" ") }),
  debug: () => {},
};

const node =
  role === "server"
    ? createServer({ cfg, log, onStatus: (s) => out({ ev: "status", s }) })
    : createClient({ cfg, log, onStatus: (s) => out({ ev: "status", s }) });

node.start();
out({ ev: "ready", role, pid: process.pid });

const { uiohookMock, nutMock } = require("./mock-native");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let c;
  try {
    c = JSON.parse(line);
  } catch {
    return;
  }
  switch (c.cmd) {
    case "move":
      uiohookMock.__emit("mousemove", { x: c.x, y: c.y });
      break;
    case "hand": {
      // Model the user's hand: the OS pointer moves by (dx,dy) and is clamped
      // to the desktop, then a hook sample is emitted (as the real hook would).
      const p = nutMock.__handMove(c.dx || 0, c.dy || 0);
      uiohookMock.__emit("mousemove", { x: p.x, y: p.y });
      break;
    }
    case "setpos": {
      const p = nutMock.__setCursor(c.x, c.y);
      uiohookMock.__emit("mousemove", { x: p.x, y: p.y });
      break;
    }
    case "down":
      uiohookMock.__emit("mousedown", { button: c.b, x: c.x ?? 0, y: c.y ?? 0 });
      break;
    case "up":
      uiohookMock.__emit("mouseup", { button: c.b, x: c.x ?? 0, y: c.y ?? 0 });
      break;
    case "wheel":
      uiohookMock.__emit("wheel", {
        rotation: c.r,
        direction: c.d ?? 3,
        x: c.x ?? 0,
        y: c.y ?? 0,
      });
      break;
    case "key":
      uiohookMock.__emit(c.up ? "keyup" : "keydown", { keycode: c.k });
      break;
    case "calls":
      out({ ev: "calls", calls: nutMock.__calls.splice(0) });
      break;
    case "cursor":
      out({ ev: "cursor", cursor: { ...nutMock.__cursor } });
      break;
    case "geom":
      out({ ev: "geom", geom: node.getGeometry ? node.getGeometry() : null });
      break;
    case "hook":
      out({ ev: "hook", started: uiohookMock.__started(), listeners: uiohookMock.__listenerCount() });
      break;
    case "quit":
      try {
        node.stop();
      } catch {
        /* ignore */
      }
      process.exit(0);
      break;
    default:
      break;
  }
});

process.on("SIGTERM", () => process.exit(0));

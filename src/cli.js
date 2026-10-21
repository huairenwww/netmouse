#!/usr/bin/env node
// Headless runner: same core as the Electron app but no GUI, for servers / testing.
//
// Usage: node src/cli.js [--role server|client] [--config /path/to/config.json]
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { createServer, createClient } = require("./app");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --config is the same knob as $NETMOUSE_CONFIG, just more convenient.
if (arg("--config")) process.env.NETMOUSE_CONFIG = arg("--config");

const cfg = loadConfig({ role: arg("--role") || undefined });
const log = createLogger(cfg.logging.level);

const node = cfg.role === "server" ? createServer({ cfg, log }) : createClient({ cfg, log });
node.start();

log.info(`NetMouse running as ${cfg.role} (headless). Ctrl-C to stop.`);
log.info(`config: ${cfg.configPath}`);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    node.stop();
  } catch {
    /* already down */
  }
  try {
    require("./server-input").stopHook();
  } catch {
    /* hook never started */
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL_NAMES = ["error", "warn", "info", "debug"];

// Recent log lines, so the GUI can render history when it opens.
const RING_SIZE = 500;
const ring = [];
const subscribers = new Set();

function formatArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function push(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      /* a broken subscriber must not break logging */
    }
  }
}

function createLogger(level = "info") {
  let min = LEVELS[level] ?? LEVELS.info;

  // Local wall-clock time: the GUI shows entries next to local timestamps, and
  // a UTC console stamp just reads as wrong to a desktop user.
  const stamp = () => {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  const mk = (name, n) => (...args) => {
    if (n > min) return;
    const message = args.map(formatArg).join(" ");
    console.log(`[${stamp()}] ${name.toUpperCase()}`, ...args);
    push({ time: Date.now(), level: name, message });
  };

  return {
    error: mk("error", 0),
    warn: mk("warn", 1),
    info: mk("info", 2),
    debug: mk("debug", 3),
    setLevel(next) {
      min = LEVELS[next] ?? LEVELS.info;
    },
    getLevel() {
      return LEVEL_NAMES.find((n) => LEVELS[n] === min) || "info";
    },
  };
}

function getHistory() {
  return ring.slice();
}

function clearHistory() {
  ring.length = 0;
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = { createLogger, getHistory, clearHistory, subscribe, LEVELS };

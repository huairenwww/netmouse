"use strict";
// ---------------------------------------------------------------------------
// ydotoold: the daemon ydotool cannot work without -- started and stopped by us.
//
// Why this file exists
// --------------------
// ydotool is only a *client*. Since v1.0.0 it does nothing on its own: it writes
// a command to a unix socket and a separate daemon, ydotoold, holds the virtual
// input device and performs it. If ydotoold is not running, every single call
// fails the same way:
//
//     failed to connect socket .ydotool_socket
//     ydotool mousemove -x -26 -y -557 -> exit 2
//
// ...and NetMouse looks broken while nothing is wrong with NetMouse. Asking the
// user to remember to start a daemon is a bad interface: the program knows
// whether it needs one, can see whether one is running, and is perfectly capable
// of starting it. So it does.
//
// Three rules, in order:
//
//   1. If YDOTOOL_SOCKET names a live socket, that is an explicit instruction.
//      Use it and touch nothing else.
//   2. Otherwise look at the well-known locations. A daemon somebody else
//      started -- most importantly the SYSTEM service, which runs as root and
//      therefore needs no group membership from the user at all -- is strictly
//      better than one of ours, so it wins.
//   3. Otherwise start our own, on a private socket, and kill it when we exit.
//
// The private socket matters. Two NetMouse instances (or NetMouse alongside the
// user's own daemon) must not fight over one socket, and we must never kill a
// daemon we did not start -- that would break whatever else was using it.
//
// What this file deliberately does NOT do is run anything as root. ydotoold
// needs read/write on /dev/uinput; that is granted by group membership or a
// udev rule, and both are one-time administrative decisions the user makes (see
// uinputAccess() below and `install-linux.sh --uinput`). Silently escalating
// from a mouse-sharing utility is not acceptable, and it would not even be
// reliable: there is no portable way to raise a password prompt from a GUI app.
// ---------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const posix = require("path").posix;
const { spawnSync } = require("child_process");

const DAEMON_BIN = "ydotoold";
const CLIENT_BIN = "ydotool";
const UINPUT = "/dev/uinput";
const SOCKET_BASENAME = ".ydotool_socket";
// sockaddr_un.sun_path is 108 bytes on Linux *including* the terminating NUL, so
// a socket path longer than 107 characters cannot be bound at all. This is not
// theoretical: TMPDIR is sometimes set to something deep in a user's home.
const MAX_UNIX_PATH = 107;
const DEFAULT_WAIT_MS = 3000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_PROBE_TIMEOUT_MS = 250;

const DAEMON_MODE_LABEL = {
  unknown: "未检测",
  external: "复用外部守护进程",
  spawned: "NetMouse 自行拉起",
  absent: "外部未运行",
  missing: "未安装",
  failed: "启动失败",
};

// ---------------------------------------------------------------------------
// Bundled binaries.
//
// ydotool and ydotoold are tiny (tens of KB) and link only against libc, so
// shipping them next to the app makes the Linux client work out of the box on
// any distro without `apt install ydotool`. We look in the app's own bin/
// directory first and fall back to PATH, so an existing system install still
// works (and can be preferred if the user wants).
//
// Only /dev/uinput access cannot be bundled -- that is a kernel permission and
// must be granted once per machine (input group or udev rule).
// ---------------------------------------------------------------------------
function bundledBinDir() {
  // Packaged: <resources>/bin. Resources dir differs by launcher; Electron
  // exposes it, but this module is also used from plain `node src/cli.js`,
  // where __dirname points into the source tree.
  const path = require("path");
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "bin"));
  candidates.push(path.join(__dirname, "..", "bin"));
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* not there */
    }
  }
  return null;
}

// Absolute path to a usable binary, or the bare name so PATH lookup applies.
//
// Precedence is deliberate: a system install wins over our bundled copy. The
// bundled ELF binaries are linked against glibc 2.34, so on an older distro
// (Ubuntu 20.04 has 2.31, Debian 11 has 2.31) they fail to load with
// "version `GLIBC_2.34' not found" -- while that distro's own build works fine.
// Bundling is a convenience for machines with nothing installed, never an
// upgrade, so it must not shadow something that already works.
//
// Results are cached: the injector resolves a binary per action, and a `which`
// fork for every mouse movement at 60 Hz would be absurd.
const binCache = new Map();

function onPath(bin) {
  try {
    return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// `opts.onPath` is a test seam (see the file header): supplying it also skips
// the cache, so a test can exercise both branches in one process without
// poisoning what production would resolve.
function lookupBin(bin, opts = {}) {
  const probe = opts.onPath || onPath;
  const useCache = !opts.onPath;

  if (useCache) {
    const cached = binCache.get(bin);
    if (cached) return cached;
  }

  let entry;
  if (probe(bin)) {
    // Bare name on purpose: execvp resolves it to the same file, and the log
    // then shows the command the user would type themselves.
    entry = { path: bin, found: true, source: "path" };
  } else {
    const dir = bundledBinDir();
    let bundled = null;
    if (dir) {
      const cand = require("path").join(dir, bin);
      try {
        fs.accessSync(cand, fs.constants.X_OK);
        bundled = cand;
      } catch {
        /* not bundled, or not executable */
      }
    }
    entry = bundled
      ? { path: bundled, found: true, source: "bundled" }
      : { path: bin, found: false, source: null };
  }

  if (useCache) binCache.set(bin, entry);
  return entry;
}

function resolveBin(bin) {
  return lookupBin(bin).path;
}

// Test hook: the cache is process-wide, so a test that wants to exercise both
// branches ("system install" and "bundled fallback") has to start clean.
function _resetBinCache() {
  binCache.clear();
}

// A local copy of inject-uinput's binary probe, on purpose: inject-uinput
// requires THIS module, so requiring it back would close a cycle.
function hasBin(bin) {
  return lookupBin(bin).found;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Where the socket lives
// ---------------------------------------------------------------------------

function runtimeDir(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  // XDG_RUNTIME_DIR is normally /run/user/<uid>; derive it when the session did
  // not export it (a daemon started from a systemd unit, a bare TTY, cron).
  if (typeof process.getuid === "function") return `/run/user/${process.getuid()}`;
  return null;
}

// The socket paths an *external* daemon might be listening on, most specific
// first. ydotoold's own default is not documented in the man page, so all the
// candidates ydotool has used over the years are listed.
//
// path.posix, not path: a unix socket path is always POSIX, and building it with
// the host separator would produce "\\run\\user\\1000\\..." the moment this code
// is exercised anywhere but Linux -- which is exactly where it gets tested.
function externalSocketCandidates(env = process.env) {
  const out = [];
  if (env.YDOTOOL_SOCKET) out.push(env.YDOTOOL_SOCKET);
  const rd = runtimeDir(env);
  if (rd) out.push(posix.join(rd, SOCKET_BASENAME));
  out.push(posix.join("/tmp", SOCKET_BASENAME));
  return [...new Set(out)];
}

// Our own socket. It must be unique per instance and short enough to bind.
function privateSocketPath(env = process.env, pid = process.pid) {
  const name = `.netmouse-ydotoold-${pid}.sock`;
  const candidates = [];
  const rd = runtimeDir(env);
  if (rd) candidates.push(posix.join(rd, name));
  candidates.push(posix.join(posix.normalize(os.tmpdir().replace(/\\/g, "/")), name));
  candidates.push(posix.join("/tmp", name));
  return candidates.find((c) => c.length <= MAX_UNIX_PATH) || candidates[candidates.length - 1];
}

// The daemon's argv. `--socket-path` is passed explicitly rather than relying on
// an environment variable, because the man page does not say that ydotoold
// honours YDOTOOL_SOCKET (only the client's page documents it).
function daemonArgs(socketPath) {
  return ["--socket-path", socketPath];
}

// Is something actually accepting connections there? A plain existsSync is not
// enough: a crashed daemon leaves its socket file behind, and "reusing" that
// stale file is exactly the failure this module exists to prevent.
//
// Why the last probe said no. A boolean is all the caller needs, but when the
// answer is "no" the *reason* is the only thing that can be acted on -- a
// missing binary, a glibc mismatch and a wedged daemon all look identical
// otherwise. Kept module-level so the failure note can quote it.
let lastProbeError = null;

function socketAlive(socketPath, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  // ydotoold's socket is a SOCK_DGRAM unix socket. Node's net.connect() creates
  // a SOCK_STREAM socket, and the kernel rejects it outright:
  //     EPROTOTYPE: Protocol wrong type for socket
  // so probing that way ALWAYS reported "daemon not running" even when it was.
  // (That bug cost a release: the daemon was healthy, every probe said no, and
  // we killed it after the 3-second wait.)
  //
  // Instead ask the real client to talk to the daemon: `ydotool debug` only
  // succeeds when the daemon is reachable and ready, which is exactly the
  // question we are trying to answer.
  const bin = resolveBin(CLIENT_BIN);
  const r = spawnSync(bin, ["debug"], {
    env: { ...process.env, YDOTOOL_SOCKET: socketPath },
    timeout: Math.max(200, timeoutMs),
    encoding: "utf8",
  });
  // exit 0 = daemon answered. Anything else (2, signal, timeout) = not usable.
  const ok = r.status === 0;
  if (!ok) {
    const stderr = String(r.stderr || "").trim().split("\n")[0];
    lastProbeError = r.error
      ? `${bin}：${r.error.message}`
      : stderr || `${bin} debug -> exit ${r.status}`;
  }
  return ok;
}

function probeError() {
  return lastProbeError;
}

// ---------------------------------------------------------------------------
// /dev/uinput: the permission that decides whether ANY of this can work.
//
// This is where the real-world failure lives, and it has three distinct shapes
// that look identical from the outside ("ydotoold will not start"):
//
//   * the user is not in the `input` group at all;
//   * the user IS in the group but the running session has not picked the group
//     up yet -- usermod only affects sessions started afterwards, so the fix is
//     "log out and back in", NOT "run usermod again";
//   * the user is in the group and the session knows it, but the udev rule does
//     not actually grant the group write access to the device node.
//
// Telling those three apart is the difference between a one-minute fix and an
// hour of guessing, so uinputAccess() reports all of it.
// ---------------------------------------------------------------------------

function readGroups(file = "/etc/group") {
  const list = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return list; // unreadable (/etc/group is 0644 everywhere, but be safe)
  }
  for (const line of text.split("\n")) {
    const p = line.split(":");
    if (p.length < 4) continue;
    const gid = Number(p[2]);
    if (!Number.isFinite(gid)) continue;
    list.push({ name: p[0], gid, members: p[3] ? p[3].split(",").filter(Boolean) : [] });
  }
  return list;
}

// The groups THIS process is actually a member of, which is not the same thing
// as the groups /etc/group says it should have.
function currentGroups() {
  try {
    const r = spawnSync("id", ["-nG"], { encoding: "utf8", timeout: 4000 });
    if (r.status === 0) {
      const names = String(r.stdout || "").trim().split(/\s+/).filter(Boolean);
      if (names.length) return names;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function userName(env = process.env) {
  if (env.USER) return env.USER;
  if (env.LOGNAME) return env.LOGNAME;
  try {
    return os.userInfo().username;
  } catch {
    return "?";
  }
}

function uinputAccess(opts = {}) {
  const p = opts.path || UINPUT;
  const groups = opts.groups || readGroups();
  const who = opts.user || userName();
  const now = "currentGroups" in opts ? opts.currentGroups : currentGroups();
  // stat/access are injectable so every permission branch can be tested on a
  // machine that has no /dev/uinput -- which is every machine that builds this.
  const statFn = opts.stat || fs.statSync;
  const accessFn = opts.access || fs.accessSync;

  const r = {
    path: p,
    exists: false,
    writable: false,
    mode: null,
    gid: null,
    group: null,
    user: who,
    listedInGroup: null,
    inGroupNow: null,
    needsRelogin: false,
    hint: null,
  };

  try {
    const st = statFn(p);
    r.exists = true;
    r.mode = st.mode & 0o777;
    r.gid = st.gid;
    const g = groups.find((x) => x.gid === st.gid);
    r.group = g ? g.name : String(st.gid);
  } catch {
    /* missing: the uinput module may not be loaded */
  }

  if (r.exists) {
    try {
      accessFn(p, fs.constants.W_OK);
      r.writable = true;
    } catch {
      r.writable = false;
    }
  }
  if (r.writable) return r;

  const input = groups.find((g) => g.name === "input");
  r.listedInGroup = !!(input && input.members.includes(who));
  r.inGroupNow = Array.isArray(now) ? now.includes("input") : null;
  const mode = r.mode === null ? "?" : `0${r.mode.toString(8)}`;

  if (!r.exists) {
    r.hint =
      `${p} 不存在：内核 uinput 模块没加载。\n` +
      "    sudo modprobe uinput\n" +
      "    （重启后仍缺失就写进 /etc/modules-load.d/uinput.conf）";
  } else if (r.listedInGroup && r.inGroupNow === false) {
    r.needsRelogin = true;
    r.hint =
      `已经在 input 组里（/etc/group 有 ${who}），但当前会话还没拿到这个组。\n` +
      "    注销后重新登录即可 —— usermod 不用再跑一次。";
  } else if (r.listedInGroup === false) {
    r.hint =
      `${who} 不在 input 组。任选其一：\n` +
      `    ① sudo usermod -aG input ${who}   然后注销重新登录\n` +
      "    ② sudo ./install-linux.sh --uinput   # 装 udev 规则，一次生效且更持久\n" +
      `    ③ 临时免重登：sudo setfacl -m u:${who}:rw ${p}`;
  } else {
    r.hint =
      `${p} 存在（${mode} ${r.group}）但没有组写权限。装一条 udev 规则：\n` +
      '    KERNEL=="uinput", GROUP="input", MODE="0660"\n' +
      `  或临时：sudo setfacl -m u:${who}:rw ${p}`;
  }
  return r;
}

// ---------------------------------------------------------------------------
// The manager
//
// `spawn` and `probe` are injectable so every branch can be unit-tested on a
// machine that has no ydotoold, no Linux and no /dev/uinput.
// ---------------------------------------------------------------------------
function createYdotooldManager(opts = {}) {
  const log = opts.log;
  const env = opts.env || process.env;
  const pid = opts.pid || process.pid;
  const doSpawn = opts.spawn || require("child_process").spawn;
  const probe = opts.probe || ((p) => socketAlive(p, opts.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS));
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : DEFAULT_WAIT_MS;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  // maySpawn false = "I run the daemon myself, only reuse it". That is the whole
  // of input.manageYdotoold: false.
  const maySpawn = opts.maySpawn !== false;
  const hasBinFn = opts.hasBin || hasBin;

  let state = {
    ok: false,
    mode: "unknown",
    socketPath: null,
    owned: false,
    pid: null,
    note: "尚未检测",
  };
  let pending = null;
  let child = null;
  let stderrTail = "";
  let closed = false;

  function set(next) {
    state = { ...state, ...next };
    return state;
  }

  async function probeExternal() {
    for (const cand of externalSocketCandidates(env)) {
      if (await probe(cand)) return cand;
    }
    return null;
  }

  async function spawnOwn() {
    const socketPath = privateSocketPath(env, pid);
    // A previous crash of OUR pid is unlikely but possible (pid reuse); a stale
    // file would make the bind fail and look like "the daemon is broken".
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* nothing stale */
    }

    let exitNote = null;
    const daemonBin = resolveBin(DAEMON_BIN);
    let c;
    try {
      c = doSpawn(daemonBin, daemonArgs(socketPath), {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...env, YDOTOOL_SOCKET: socketPath },
      });
    } catch (e) {
      return set({
        ok: false,
        mode: "failed",
        note: `无法启动 ${DAEMON_BIN}：${e.message}`,
      });
    }
    child = c;

    c.on?.("error", (e) => {
      if (!exitNote) exitNote = `无法启动 ${DAEMON_BIN}：${e.message}`;
    });
    c.on?.("exit", (code, signal) => {
      if (!exitNote) {
        exitNote =
          `${DAEMON_BIN} 启动后立即退出（code=${code} signal=${signal}）` +
          (stderrTail ? `：${stderrTail}` : "");
      }
    });
    if (c.stderr) {
      if (c.stderr.setEncoding) c.stderr.setEncoding("utf8");
      c.stderr.on?.("data", (d) => {
        const s = String(d).trim();
        if (!s) return;
        stderrTail = s.split("\n")[0];
        log?.debug?.(`${DAEMON_BIN}: ${stderrTail}`);
      });
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (exitNote) break;
      if (await probe(socketPath)) {
        return set({
          ok: true,
          mode: "spawned",
          socketPath,
          owned: true,
          pid: c.pid ?? null,
          note: `已自动拉起 ${DAEMON_BIN}（pid ${c.pid ?? "?"}，socket ${socketPath}）`,
        });
      }
      await delay(intervalMs);
    }

    // Evidence, not a guess. Three completely different faults (client missing,
    // client cannot load, daemon not listening) produce the same sentence
    // otherwise, and the user is left guessing which one to fix.
    const probed = probeError();
    const why =
      exitNote ||
      `${waitMs}ms 内没有出现可连接的 socket（${socketPath}）` +
        `\n    守护进程：${daemonBin}` +
        `\n    客户端：${resolveBin(CLIENT_BIN)}` +
        (probed ? `\n    探测结果：${probed}` : "");
    // Only reach for a specific fix when the evidence points at one. A daemon
    // that could not bind its socket has a different problem from one that could
    // not open the device, and blaming /dev/uinput for both sends the user off
    // in the wrong direction.
    const permissionish = exitNote && /uinput|permission|denied|EACCES/i.test(exitNote);
    // ydotool before the 1.0 refactor had no daemon at all, and a daemon from a
    // distro that patched the CLI may reject --socket-path outright.
    const oldish = exitNote && /unknown option|unrecognized option|invalid option|usage:/i.test(exitNote);
    const access = permissionish ? uinputAccess() : null;
    const hint = oldish
      ? `这个 ${DAEMON_BIN} 不接受 --socket-path，版本可能过旧（需要 ydotool ≥ 1.0）。\n` +
        "    sudo apt install --reinstall ydotool"
      : access && access.hint
      ? access.hint
      : null;

    try {
      c.kill?.();
    } catch {
      /* already gone */
    }
    child = null;
    return set({
      ok: false,
      mode: "failed",
      socketPath: null,
      owned: false,
      pid: null,
      note: `${DAEMON_BIN} 不可用：${why}` + (hint ? `\n  → ${hint}` : ""),
    });
  }

  async function ensure() {
    if (closed) return state;
    if (pending) return pending;
    pending = (async () => {
      const ext = await probeExternal();
      if (ext) {
        return set({
          ok: true,
          mode: "external",
          socketPath: ext,
          owned: false,
          pid: null,
          note: `复用已在运行的 ${DAEMON_BIN}（${ext}）`,
        });
      }
      if (!maySpawn) {
        return set({
          ok: false,
          mode: "absent",
          socketPath: null,
          owned: false,
          pid: null,
          note:
            `没有正在运行的 ${DAEMON_BIN}，且配置里关闭了自动拉起（input.manageYdotoold: false）。\n` +
            "  → 自己启动：systemctl --user enable --now ydotool.service\n" +
            "    或（该服务启动失败时）systemd-run --user --unit=ydotoold /usr/bin/ydotoold",
        });
      }
      if (!hasBinFn(DAEMON_BIN)) {
        return set({
          ok: false,
          mode: "missing",
          socketPath: null,
          owned: false,
          pid: null,
          note: `找不到 ${DAEMON_BIN} —— 它随 ydotool 一起安装：sudo apt install -y ydotool`,
        });
      }
      return spawnOwn();
    })();
    return pending;
  }

  return {
    ensure,
    // Which socket the client must use, or null when there is none.
    socketPath: () => (state.ok ? state.socketPath : null),
    status: () => ({ ...state, stderr: stderrTail || null, maySpawn }),
    label: () => DAEMON_MODE_LABEL[state.mode] || state.mode,
    // Only ever kills a daemon WE started. An adopted one belongs to whoever
    // started it (possibly a root system service shared with other tools).
    close() {
      closed = true;
      const owned = state.owned;
      const sock = state.socketPath;
      if (child && owned) {
        try {
          child.kill?.();
        } catch {
          /* already gone */
        }
      }
      if (owned && sock) {
        try {
          fs.unlinkSync(sock);
        } catch {
          /* already gone */
        }
      }
      child = null;
    },
  };
}

module.exports = {
  createYdotooldManager,
  externalSocketCandidates,
  privateSocketPath,
  daemonArgs,
  socketAlive,
  probeError,
  uinputAccess,
  readGroups,
  currentGroups,
  userName,
  hasBin,
  resolveBin,
  lookupBin,
  bundledBinDir,
  onPath,
  _resetBinCache,
  DAEMON_BIN,
  CLIENT_BIN,
  UINPUT,
  SOCKET_BASENAME,
  MAX_UNIX_PATH,
  DEFAULT_WAIT_MS,
  DAEMON_MODE_LABEL,
};

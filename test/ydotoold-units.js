"use strict";
// ---------------------------------------------------------------------------
// Unit tests for the ydotoold manager.
//
// Why this file exists
// --------------------
// ydotool is a pure client: until ydotoold is listening on a socket, every call
// exits 2 and NOTHING happens. That is exactly the failure the real two-machine
// debug hit --
//
//     uinput 注入失败：ydotool mousemove -x -26 -y -557 -> exit 2
//
// -- and the fix is for NetMouse to own the daemon instead of asking the user to
// remember it. Which means this module has to be right about a handful of things
// that are invisible from a Windows build machine:
//
//   * which socket path to use, including the 108-byte sockaddr_un limit;
//   * that a socket FILE is not a socket (a crashed daemon leaves the file);
//   * that the socket is SOCK_DGRAM, so net.connect() can never probe it --
//     the probe has to ask the real client (`ydotool debug`) instead. This one
//     cost a whole release: the daemon was running perfectly and every probe
//     said "no socket", so we killed a healthy daemon after 3 seconds;
//   * that a daemon somebody else started must be reused, never killed;
//   * that a daemon WE started and could not use must be killed;
//   * that "permission denied on /dev/uinput" and "this binary is too old" are
//     different problems with different fixes.
//
// Every branch is driven with an injected spawn/probe, so nothing has to be
// installed and no Linux is required.
// ---------------------------------------------------------------------------
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const {
  createYdotooldManager,
  externalSocketCandidates,
  privateSocketPath,
  daemonArgs,
  socketAlive,
  uinputAccess,
  readGroups,
  hasBin,
  lookupBin,
  _resetBinCache,
  DAEMON_BIN,
  MAX_UNIX_PATH,
} = require("../src/ydotoold");

const { createUinputInjector } = require("../src/inject-uinput");

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

const ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };
const FIRST = "/run/user/1000/.ydotool_socket";

// A stand-in for the daemon process.
function fakeDaemonSpawn(opts = {}) {
  const calls = [];
  const children = [];
  const spawn = (bin, args = [], sopts = {}) => {
    const child = new EventEmitter();
    child.bin = bin;
    child.args = args;
    child.sopts = sopts;
    child.pid = opts.pid || 4242;
    child.killed = false;
    child.stderr = {
      setEncoding() {},
      on(ev, fn) {
        this._fn = fn;
      },
    };
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ bin, args, env: sopts.env });
    children.push(child);
    if (opts.stderrText) {
      // Emitted before 'exit' on purpose: the manager reads the tail when it
      // builds the failure message, so ordering is part of the contract.
      setImmediate(() => child.stderr._fn && child.stderr._fn(opts.stderrText));
    }
    if (opts.emitExit) {
      setImmediate(() => child.emit("exit", opts.exitCode === undefined ? 0 : opts.exitCode, null));
    }
    return child;
  };
  return { spawn, calls, children };
}

// A stand-in for the daemon manager, for the injector-integration checks.
function fakeDaemon(ok, socketPath) {
  const calls = [];
  const sock = socketPath || "/run/user/1000/.netmouse-ydotoold-1.sock";
  return {
    calls,
    ensure: async () => {
      calls.push("ensure");
      return { ok, socketPath: ok ? sock : null, mode: ok ? "external" : "failed", note: ok ? "ok" : "no daemon" };
    },
    socketPath: () => (ok ? sock : null),
    status: () => ({ ok, mode: ok ? "external" : "failed", socketPath: ok ? sock : null }),
    label: () => (ok ? "复用外部守护进程" : "启动失败"),
    close: () => calls.push("close"),
  };
}

console.log("\n=== 1. where the socket lives ===");

check("an explicit YDOTOOL_SOCKET is an instruction, and comes first", () => {
  const c = externalSocketCandidates({ YDOTOOL_SOCKET: "/custom/.s", XDG_RUNTIME_DIR: "/run/user/1000" });
  assert.strictEqual(c[0], "/custom/.s");
  assert.ok(c.includes(FIRST), "the standard location is still worth trying");
});

check("the runtime dir and /tmp are both probed", () => {
  assert.deepStrictEqual(externalSocketCandidates(ENV), [FIRST, "/tmp/.ydotool_socket"]);
});

check("with no XDG_RUNTIME_DIR at all, /tmp is still tried", () => {
  assert.deepStrictEqual(externalSocketCandidates({}), ["/tmp/.ydotool_socket"]);
});

check("our own socket is per-process, so two instances cannot collide", () => {
  const a = privateSocketPath(ENV, 111);
  const b = privateSocketPath(ENV, 222);
  assert.notStrictEqual(a, b);
  assert.match(a, /\.netmouse-ydotoold-111\.sock$/);
  assert.ok(a.startsWith("/run/user/1000/"), a);
});

check("a socket path is always POSIX, even when built on Windows", () => {
  // The one place this can silently break: path.join() would produce
  // "\\run\\user\\1000\\..." and the daemon would never bind it.
  assert.ok(!privateSocketPath(ENV, 1).includes("\\"), privateSocketPath(ENV, 1));
  assert.ok(!externalSocketCandidates(ENV).some((p) => p.includes("\\")));
});

check("a too-long runtime dir falls back to something bindable", () => {
  // sockaddr_un.sun_path is 108 bytes including the NUL, so >107 cannot bind.
  const deep = "/very/deep/directory/layout/".repeat(6);
  const p = privateSocketPath({ XDG_RUNTIME_DIR: deep }, 7);
  assert.ok(p.length <= MAX_UNIX_PATH, `${p} is ${p.length} bytes`);
  assert.ok(p.endsWith(".netmouse-ydotoold-7.sock"));
});

check("the daemon is told the socket path explicitly", () => {
  // The man page does not say ydotoold honours YDOTOOL_SOCKET (only the client
  // page documents it), so relying on the environment alone would be a guess.
  assert.deepStrictEqual(daemonArgs("/run/user/1000/x.sock"), [
    "--socket-path",
    "/run/user/1000/x.sock",
  ]);
});

console.log("\n=== 2. a socket file is not a socket ===");

(async () => {
  await checkAsync("probing a path with nothing on it resolves false, not a throw", async () => {
    assert.strictEqual(await socketAlive("/nonexistent/definitely-not-a-socket", 200), false);
  });

  await checkAsync("the probe is synchronous and boolean, never a Promise", () => {
    // Pins the contract that replaced net.connect(): a Promise-returning probe
    // is how the old code looked, and it was wrong for a SOCK_DGRAM socket.
    // If someone reintroduces an async probe, `await` still works -- so the
    // only way to catch it is to assert the shape.
    const r = socketAlive("/nonexistent/definitely-not-a-socket", 200);
    assert.strictEqual(typeof r, "boolean", "socketAlive must not return a Promise");
  });

  console.log("\n=== 3. reusing a daemon somebody else started ===");

  await checkAsync("a live external daemon is adopted, not duplicated", async () => {
    let spawned = 0;
    const mgr = createYdotooldManager({
      probe: async (p) => p === FIRST,
      spawn: () => {
        spawned += 1;
      },
      hasBin: () => true,
      env: ENV,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.mode, "external");
    assert.strictEqual(st.socketPath, FIRST);
    assert.strictEqual(st.owned, false);
    assert.strictEqual(spawned, 0, "starting a second daemon would fight over the device");
    assert.strictEqual(mgr.socketPath(), FIRST);
  });

  await checkAsync("an adopted daemon is never killed by us", async () => {
    const { spawn, children } = fakeDaemonSpawn();
    const mgr = createYdotooldManager({
      probe: async () => true,
      spawn,
      hasBin: () => true,
      env: ENV,
      log: makeLog(),
    });
    await mgr.ensure();
    mgr.close();
    assert.strictEqual(children.length, 0);
  });

  await checkAsync("a stale socket file is not mistaken for a running daemon", async () => {
    // probe() is the connection test, and it is the ONLY thing that counts.
    const { spawn, calls } = fakeDaemonSpawn({ emitExit: false });
    let n = 0;
    const mgr = createYdotooldManager({
      probe: async () => {
        n += 1;
        return n > 2; // the two external candidates fail, our own socket comes up
      },
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 55,
      waitMs: 200,
      intervalMs: 5,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.mode, "spawned", "a dead file must not stop us starting a real one");
    assert.strictEqual(calls.length, 1);
  });

  await checkAsync("ensure() resolves once, not once per mouse event", async () => {
    let probes = 0;
    const mgr = createYdotooldManager({
      probe: async (p) => {
        probes += 1;
        return p === FIRST;
      },
      hasBin: () => true,
      env: ENV,
      log: makeLog(),
    });
    const a = await mgr.ensure();
    const before = probes;
    const b = await mgr.ensure();
    assert.strictEqual(a, b);
    assert.strictEqual(probes, before, "the second call must not re-probe");
  });

  console.log("\n=== 4. starting our own ===");

  await checkAsync("we spawn it on a private socket and pass the path both ways", async () => {
    const { spawn, calls } = fakeDaemonSpawn();
    let n = 0;
    const mgr = createYdotooldManager({
      probe: async () => {
        n += 1;
        return n > 2;
      },
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 321,
      waitMs: 200,
      intervalMs: 5,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.mode, "spawned");
    assert.strictEqual(st.owned, true);
    assert.strictEqual(st.pid, 4242);
    const want = privateSocketPath(ENV, 321);
    assert.strictEqual(st.socketPath, want);
    assert.deepStrictEqual(calls[0].args, ["--socket-path", want]);
    assert.strictEqual(calls[0].env.YDOTOOL_SOCKET, want, "the client and the daemon must agree");
    // basename, not the bare name: when the Linux build ships bin/ydotoold the
    // resolver hands us an absolute path, and that is the intended behaviour.
    assert.strictEqual(path.basename(calls[0].bin), DAEMON_BIN);
  });

  await checkAsync("close() kills a daemon we started", async () => {
    const { spawn, children } = fakeDaemonSpawn();
    let n = 0;
    const mgr = createYdotooldManager({
      probe: async () => {
        n += 1;
        return n > 2;
      },
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 322,
      waitMs: 200,
      intervalMs: 5,
      log: makeLog(),
    });
    await mgr.ensure();
    mgr.close();
    assert.strictEqual(children[0].killed, true, "leaving it behind would leak a virtual input device");
  });

  console.log("\n=== 5. failures, told apart ===");

  await checkAsync("no ydotoold binary says how to get one", async () => {
    let spawned = 0;
    const mgr = createYdotooldManager({
      probe: async () => false,
      spawn: () => {
        spawned += 1;
      },
      hasBin: () => false,
      env: ENV,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, false);
    assert.strictEqual(st.mode, "missing");
    assert.match(st.note, /apt install/);
    assert.strictEqual(spawned, 0);
  });

  await checkAsync("input.manageYdotoold = false refuses to start one", async () => {
    let spawned = 0;
    const mgr = createYdotooldManager({
      probe: async () => false,
      spawn: () => {
        spawned += 1;
      },
      hasBin: () => true,
      maySpawn: false,
      env: ENV,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, false);
    assert.strictEqual(st.mode, "absent");
    assert.match(st.note, /systemd-run|systemctl/, "it must still say how to start one yourself");
    assert.strictEqual(spawned, 0);
  });

  await checkAsync("a permission failure quotes the daemon AND gives the fix", async () => {
    const { spawn } = fakeDaemonSpawn({
      emitExit: true,
      exitCode: 1,
      stderrText: "failed to open /dev/uinput: Permission denied\n",
    });
    const mgr = createYdotooldManager({
      probe: async () => false,
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 333,
      waitMs: 120,
      intervalMs: 5,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, false);
    assert.match(st.note, /Permission denied/, "the daemon's own words are the evidence");
    assert.match(st.note, /→/, "and a symptom without a fix is not a diagnosis");
  });

  await checkAsync("an unrelated failure does not blame /dev/uinput", async () => {
    const { spawn } = fakeDaemonSpawn({
      emitExit: true,
      exitCode: 2,
      stderrText: "fatal: something else went wrong\n",
    });
    const mgr = createYdotooldManager({
      probe: async () => false,
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 334,
      waitMs: 120,
      intervalMs: 5,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, false);
    assert.doesNotMatch(st.note, /uinput/, "sending the user after the wrong thing wastes their evening");
  });

  await checkAsync("a daemon too old for --socket-path is named as such", async () => {
    const { spawn } = fakeDaemonSpawn({
      emitExit: true,
      exitCode: 1,
      stderrText: "unknown option --socket-path\n",
    });
    const mgr = createYdotooldManager({
      probe: async () => false,
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 335,
      waitMs: 120,
      intervalMs: 5,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.match(st.note, /过旧|reinstall/, st.note);
  });

  await checkAsync("a daemon that never opens its socket is killed, not leaked", async () => {
    const { spawn, children } = fakeDaemonSpawn();
    const mgr = createYdotooldManager({
      probe: async () => false,
      spawn,
      hasBin: () => true,
      env: ENV,
      pid: 336,
      waitMs: 40,
      intervalMs: 5,
      log: makeLog(),
    });
    const st = await mgr.ensure();
    assert.strictEqual(st.ok, false);
    assert.strictEqual(st.mode, "failed");
    assert.match(st.note, /40ms/);
    // The report the user is asked to send has to name what was tried, or the
    // next round of debugging starts from zero again.
    assert.match(st.note, /守护进程：/);
    assert.match(st.note, /客户端：/);
    assert.strictEqual(children[0].killed, true);
    assert.strictEqual(st.owned, false, "nothing to tear down later");
    assert.strictEqual(mgr.socketPath(), null);
  });

  console.log("\n=== 6. /dev/uinput, the three failure shapes ===");

  const GROUPS = [
    { name: "root", gid: 0, members: [] },
    { name: "input", gid: 995, members: ["alice"] },
    { name: "alice", gid: 1000, members: [] },
  ];
  const device = (mode = 0o660, gid = 995) => ({
    stat: () => ({ mode, gid }),
    access: () => {
      throw new Error("EACCES");
    },
  });

  check("writable means writable, and no hint is invented", () => {
    const a = uinputAccess({
      groups: GROUPS,
      user: "alice",
      currentGroups: ["alice"],
      stat: () => ({ mode: 0o660, gid: 995 }),
      access: () => {},
    });
    assert.strictEqual(a.exists, true);
    assert.strictEqual(a.writable, true);
    assert.strictEqual(a.hint, null);
  });

  check("not in the group -> join it", () => {
    const a = uinputAccess({
      groups: GROUPS,
      user: "alice",
      currentGroups: ["alice"],
      ...device(),
    });
    assert.strictEqual(a.listedInGroup, false);
    assert.match(a.hint, /usermod -aG input alice/);
    assert.match(a.hint, /setfacl/, "the no-re-login escape hatch matters");
    assert.strictEqual(a.needsRelogin, false);
  });

  check("in the group but the session has not caught up -> log out, do NOT usermod again", () => {
    // This is the trap the real debug walked into: /etc/group already lists the
    // user, usermod appears to have worked, and the device is still root-only
    // because the running session predates the change.
    const a = uinputAccess({
      groups: GROUPS,
      user: "alice",
      currentGroups: ["alice"], // the session does not know about `input` yet
      ...device(),
    });
    assert.strictEqual(a.listedInGroup, true);
    assert.strictEqual(a.inGroupNow, false);
    assert.strictEqual(a.needsRelogin, true);
    assert.match(a.hint, /注销/);
    // It may *mention* usermod to say "you do not need to run it again"; what it
    // must not do is hand them the command as the fix.
    assert.doesNotMatch(a.hint, /sudo usermod/, "re-running usermod changes nothing here");
  });

  check("in the group and the session knows, yet still not writable -> the udev rule", () => {
    const a = uinputAccess({
      groups: GROUPS,
      user: "alice",
      currentGroups: ["alice", "input"],
      ...device(0o600),
    });
    assert.strictEqual(a.writable, false);
    assert.match(a.hint, /KERNEL=="uinput"/);
    assert.match(a.hint, /0660/);
  });

  check("a missing device node is a module problem, not a permission one", () => {
    const a = uinputAccess({
      groups: GROUPS,
      user: "alice",
      currentGroups: ["alice", "input"],
      stat: () => {
        throw new Error("ENOENT");
      },
    });
    assert.strictEqual(a.exists, false);
    assert.match(a.hint, /modprobe uinput/);
    assert.doesNotMatch(a.hint, /usermod/, "they may already be in the group");
  });

  check("the group name is resolved from the gid, not assumed", () => {
    const a = uinputAccess({
      groups: GROUPS,
      user: "alice",
      currentGroups: ["alice"],
      ...device(0o660, 995),
    });
    assert.strictEqual(a.group, "input");
    assert.strictEqual(a.gid, 995);
  });

  check("readGroups parses real /etc/group syntax", () => {
    // Sanity on the parser itself: no /etc/group on the build machine.
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmp = path.join(os.tmpdir(), `netmouse-group-${process.pid}`);
    fs.writeFileSync(tmp, "root:x:0:\ninput:x:995:alice,carol\nusers:x:100:\nmalformed\n");
    try {
      const g = readGroups(tmp);
      assert.strictEqual(g.length, 3, "the malformed line must be skipped, not crash");
      assert.deepStrictEqual(g.find((x) => x.name === "input").members, ["alice", "carol"]);
      assert.strictEqual(g.find((x) => x.name === "input").gid, 995);
      assert.deepStrictEqual(g.find((x) => x.name === "root").members, []);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  console.log("\n=== 7. the injector drives the daemon ===");

  await checkAsync("ydotool clients are pointed at OUR socket", async () => {
    const { spawn, children, calls } = fakeDaemonSpawn({ emitExit: true });
    const sock = "/run/user/1000/.netmouse-ydotoold-1.sock";
    const inj = createUinputInjector({
      tool: "ydotool",
      binPath: "ydotool",
      spawn,
      log: makeLog(),
      daemon: fakeDaemon(true, sock),
    });
    await inj.move(4, -4);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].bin, "ydotool");
    assert.deepStrictEqual(calls[0].args, ["mousemove", "-x", "4", "-y", "-4"]);
    assert.strictEqual(children[0].sopts.env.YDOTOOL_SOCKET, sock);
    assert.strictEqual(inj.health().applied, 1);
  });

  await checkAsync("a daemon that cannot start fails once and spawns no client", async () => {
    const { spawn, calls } = fakeDaemonSpawn({ emitExit: true });
    const log = makeLog();
    const inj = createUinputInjector({
      tool: "ydotool",
      spawn,
      log,
      daemon: fakeDaemon(false),
    });
    assert.strictEqual(await inj.move(1, 1), false);
    assert.strictEqual(await inj.move(1, 1), false);
    assert.strictEqual(calls.length, 0, "forking a client that cannot connect is pointless");
    assert.strictEqual(inj.health().applied, 0);
    assert.strictEqual(inj.health().errors, 1, "one failure, one error -- not one per mouse event");
    const warned = log.lines.filter((l) => l.lvl === "warn" && /uinput 注入不可用/.test(l.text));
    assert.strictEqual(warned.length, 1);
  });

  await checkAsync("prepare() surfaces the daemon state before the first event", async () => {
    const inj = createUinputInjector({
      tool: "ydotool",
      spawn: fakeDaemonSpawn({ emitExit: true }).spawn,
      log: makeLog(),
      daemon: fakeDaemon(true, "/run/user/1000/.netmouse-ydotoold-1.sock"),
    });
    const st = await inj.prepare();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(inj.needsDaemon, true);
    const ds = inj.daemonStatus();
    assert.strictEqual(ds.socketPath, "/run/user/1000/.netmouse-ydotoold-1.sock");
  });

  await checkAsync("close() shuts the daemon down", async () => {
    const daemon = fakeDaemon(true);
    const inj = createUinputInjector({
      tool: "ydotool",
      spawn: fakeDaemonSpawn().spawn,
      log: makeLog(),
      daemon,
    });
    inj.close();
    assert.deepStrictEqual(daemon.calls, ["close"]);
  });

  await checkAsync("dotool is left entirely out of the daemon machinery", async () => {
    // dotool owns its virtual device itself; there is no daemon to adopt, start
    // or stop, and pretending otherwise would be the kind of fake symmetry that
    // hides a real difference.
    const daemon = fakeDaemon(true);
    const inj = createUinputInjector({
      tool: "dotool",
      spawn: fakeDaemonSpawn().spawn,
      log: makeLog(),
      daemon,
    });
    assert.strictEqual(inj.needsDaemon, false);
    assert.strictEqual(inj.daemonStatus(), null);
    const st = await inj.prepare();
    assert.strictEqual(st.mode, "none");
    assert.deepStrictEqual(daemon.calls, []);
  });

  // -------------------------------------------------------------------------
  console.log("\n=== 8. bundled binaries ===");

  await checkAsync("a system install wins over the bundled copy", async () => {
    // The bundled ELF binaries need glibc 2.34, so on Ubuntu 20.04 / Debian 11
    // they cannot even load -- while that distro's own ydotool works. Bundling
    // is a fallback for machines with nothing installed, never an upgrade, so
    // precedence has to be "whatever the system already has".
    const r = lookupBin(DAEMON_BIN, { onPath: () => true });
    assert.strictEqual(r.source, "path");
    assert.strictEqual(r.path, DAEMON_BIN, "a bare name lets execvp pick the system one");
    assert.strictEqual(r.found, true);
  });

  await checkAsync("with nothing on PATH the bundled copy is used", async () => {
    const r = lookupBin(DAEMON_BIN, { onPath: () => false });
    assert.strictEqual(r.source, "bundled");
    assert.strictEqual(r.found, true);
    assert.ok(fs.existsSync(r.path), `${r.path} should exist in the source tree`);
    assert.strictEqual(path.basename(r.path), DAEMON_BIN);
  });

  await checkAsync("with neither, the bare name survives so the error can name it", async () => {
    const r = lookupBin("netmouse-no-such-tool", { onPath: () => false });
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.path, "netmouse-no-such-tool", "the spawn error must name the thing that is missing");
  });

  await checkAsync("hasBin asks exactly that question, and caches the answer", async () => {
    _resetBinCache();
    assert.strictEqual(hasBin("netmouse-no-such-tool"), false);
    _resetBinCache();
    assert.strictEqual(hasBin(DAEMON_BIN), true, "bundled counts as available");
  });

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length) {
    console.log(`YDOTOOLD-UNITS FAIL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  console.log(`YDOTOOLD-UNITS PASS: ${passed}/${passed} checks passed`);
  process.exit(0);
})();

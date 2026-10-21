"use strict";
// ---------------------------------------------------------------------------
// End-to-end loopback tests for NetMouse.
//
// Spawns the REAL server role and the REAL client role as separate processes,
// connected over a real TCP socket, with only the native input layer mocked.
// The mock models the OS pointer faithfully: hand motion moves it and it is
// CLAMPED to the desktop bounds (as Windows does), while the server's own
// re-centring teleports it.
//
// Three scenarios, each a regression test for a bug that actually shipped:
//
//   1. single monitor, edge "right"
//      the whole hand-over contract: no capture mid-screen, capture exactly at
//      the shared edge, resolution-independent relative motion, buttons/wheel
//      (including scroll DIRECTION) and keys, the client always being able to
//      reach its home edge, and no capture/release oscillation.
//
//   2. single monitor, edge "any"
//      pushing toward ANY boundary hands over. This is the answer to "I move
//      the mouse toward the other machine and nothing happens" when the user
//      is not sure which side the peer is on. The server must report the edge
//      it actually used, and the client must return home from the opposite one.
//
//   3. two monitors of different sizes, edge "left"
//      the regression test for the mixed-DPI / multi-monitor geometry bug: the
//      shared left edge belongs to the SECONDARY screen, so the primary's own
//      left edge must NOT trigger, and the cursor must be able to reach the
//      virtual desktop's real left edge.
//
// Run: node test/e2e.js
// ---------------------------------------------------------------------------
const { spawn } = require("child_process");
const path = require("path");

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, "..");
// Derived from the pid so back-to-back runs (and a previous run's children that
// have not finished exiting yet) cannot collide on the listening port.
const PORT = 25000 + (process.pid % 900);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(cond, label, extra) {
  checks += 1;
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${label}${extra ? `  -> ${extra}` : ""}`);
  }
}
const section = (t) => console.log(`\n== ${t} ==`);

// --- one role, driven over JSON-lines on stdin/stdout -----------------------
class Child {
  constructor(name, args, env = {}) {
    this.name = name;
    this.status = [];
    this.calls = [];
    this.logs = [];
    this._buf = "";
    this.proc = spawn(NODE, [path.join(__dirname, "node-runner.js"), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this._feed(d.toString()));
    this.proc.stderr.on("data", (d) => this.logs.push(`[stderr] ${d.toString().trim()}`));
    this.proc.on("exit", (code) => {
      this._exited = true;
      if (code !== 0 && code !== null) this.logs.push(`[exit ${code}]`);
    });
  }
  _feed(chunk) {
    this._buf += chunk;
    let i;
    while ((i = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.ev === "status") this.status.push(o.s);
      else if (o.ev === "calls") this.calls.push(...o.calls);
      else if (o.ev === "log") this.logs.push(`[${o.lvl}] ${o.m}`);
    }
  }
  send(cmd) {
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }
  get last() {
    return this.status[this.status.length - 1] || {};
  }
  get mode() {
    return this.last.mode;
  }
  hasLog(re) {
    return this.logs.some((l) => re.test(l));
  }
  async drain() {
    const before = this.calls.length;
    this.send({ cmd: "calls" });
    const t0 = Date.now();
    while (Date.now() - t0 < 900 && this.calls.length === before) await sleep(15);
    return this.calls.slice(before);
  }
  async lastPosition() {
    const c = await this.drain();
    const positions = c.filter((x) => x.op === "setPosition");
    return positions[positions.length - 1] || null;
  }
  kill() {
    try {
      this.send({ cmd: "quit" });
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
  // Await the real exit so the next scenario can bind the port safely.
  async stop() {
    if (this._exited) return;
    this.kill();
    await new Promise((resolve) => {
      if (this._exited) return resolve();
      const t = setTimeout(resolve, 2000);
      this.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

async function waitFor(fn, timeout, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// Mirror of the server's simulated physical pointer. The mock clamps it to the
// virtual desktop exactly like the OS does, so the assertions can say where the
// cursor "really" was when a capture fired.
class Mirror {
  constructor(spec) {
    this.monitors = spec.split(",").map((s) => {
      const m = /^(\d+)x(\d+)(?:([+-]\d+)([+-]\d+))?$/.exec(s.trim());
      return {
        x: m[3] ? Number(m[3]) : 0,
        y: m[4] ? Number(m[4]) : 0,
        width: Number(m[1]),
        height: Number(m[2]),
      };
    });
    this.box = {
      x: Math.min(...this.monitors.map((m) => m.x)),
      y: Math.min(...this.monitors.map((m) => m.y)),
    };
    this.box.width =
      Math.max(...this.monitors.map((m) => m.x + m.width)) - this.box.x;
    this.box.height =
      Math.max(...this.monitors.map((m) => m.y + m.height)) - this.box.y;
    this.x = 0;
    this.y = 0;
  }
  clamp() {
    this.x = Math.max(this.box.x, Math.min(this.box.x + this.box.width - 1, this.x));
    this.y = Math.max(this.box.y, Math.min(this.box.y + this.box.height - 1, this.y));
  }
  set(x, y) {
    this.x = x;
    this.y = y;
    this.clamp();
    return { x: this.x, y: this.y };
  }
  step(dx, dy = 0) {
    this.x += dx;
    this.y += dy;
    this.clamp();
    return { x: this.x, y: this.y };
  }
}

// --- scenario 1: single monitor, right edge --------------------------------
async function scenarioRightEdge() {
  const server = new Child(
    "server",
    ["--role", "server", "--port", String(PORT), "--edge", "right"],
    { NETMOUSE_MOCK_DESKTOP: "1920x1080" }
  );
  // The client is deliberately started with the WRONG edge ("left" instead of
  // "right"): the server must tell it which edge is shared, so the return-home
  // logic still works without the two configs being kept in sync by hand.
  const client = new Child(
    "client",
    ["--role", "client", "--port", String(PORT), "--host", "127.0.0.1", "--edge", "left"],
    { NETMOUSE_MOCK_DESKTOP: "2560x1440" }
  );
  const m = new Mirror("1920x1080");
  const SW = 1920;
  const hand = (dx, dy = 0) => {
    const p = m.step(dx, dy);
    server.send({ cmd: "hand", dx, dy });
    return p;
  };

  try {
    section("handshake");
    await waitFor(() => server.status.some((s) => s.peer === "connected"), 6000, "server connected");
    await waitFor(() => client.status.some((s) => s.peer === "connected"), 6000, "client connected");
    check(true, "both roles connected over TCP");

    section("server hook");
    server.send({ cmd: "hook" });
    await sleep(120);
    check(server.mode === "local", "server starts in local mode", `mode=${server.mode}`);

    // --- approach but stay well clear of the shared right edge --------------
    section("approach (must NOT capture yet)");
    m.set(300, 500);
    server.send({ cmd: "setpos", x: 300, y: 500 });
    await sleep(40);
    for (let i = 0; i < 10; i += 1) {
      hand(50, 0); // 300 -> 800, still 1100px from the edge
      await sleep(12);
    }
    await sleep(150);
    check(
      server.mode === "local",
      "no capture while cursor is far from the right edge (stopped at x=800 of 1920)",
      `mode=${server.mode}`
    );

    // --- continue to the real right edge -----------------------------------
    section("reach the shared edge");
    let capturedAt = null;
    for (let i = 0; i < 60; i += 1) {
      hand(25, 0);
      await sleep(10);
      if (server.mode === "remote") {
        capturedAt = m.x;
        break;
      }
    }
    check(server.mode === "remote", "capture fires when the cursor reaches the shared edge", `mode=${server.mode}`);
    check(
      capturedAt !== null && capturedAt >= SW - 3,
      `capture happened AT the edge, not mid-screen (x=${capturedAt}, edge=${SW - 1})`,
      `x=${capturedAt}`
    );

    await waitFor(() => client.mode === "remote", 2000, "client remote").catch(() => {});
    check(client.mode === "remote", "client entered remote mode on 'enter'", `mode=${client.mode}`);

    // --- relative motion ----------------------------------------------------
    section("relative motion forwarding");
    await sleep(300); // let the client seed its tracked position and settle
    const early = await client.drain();
    const earlyPos = early.filter((c) => c.op === "setPosition");
    const seed = earlyPos[0];
    check(
      !!seed && seed.x === 1280 && seed.y === 720,
      "client seeded its cursor at the centre of its own 2560x1440 desktop",
      seed ? `got (${seed.x},${seed.y})` : "no setPosition"
    );

    // Measure motion as a DELTA so the assertion does not depend on which
    // sample happens to consume the post-capture baseline. hand(0,0) forces
    // that baseline to be taken without moving anything.
    hand(0, 0);
    await sleep(120);
    const before = earlyPos[earlyPos.length - 1] || { x: 1280, y: 720 };
    hand(20, 15);
    await sleep(70);
    hand(20, 15);
    await sleep(220);
    const after = await client.lastPosition();
    check(
      !!after && after.x - before.x === 40 && after.y - before.y === 30,
      "client re-injected the forwarded deltas (moved exactly +40,+30 in its own space)",
      after ? `before=(${before.x},${before.y}) after=(${after.x},${after.y})` : "no motion injected"
    );

    // --- buttons / wheel / keys --------------------------------------------
    section("buttons / wheel / keys");

    // uiohook reports button 1 for the LEFT button; nut-js's Button.LEFT is 0.
    // So a correct client sends pressButton(0). This assertion is the one that
    // would have caught the `if (btn)` truthiness bug: with Button.LEFT === 0
    // the injection was skipped entirely and nothing appeared here.
    server.send({ cmd: "down", b: 1 });
    server.send({ cmd: "up", b: 1 });
    await sleep(80);
    const clicks = await client.drain();
    check(
      clicks.some((c) => c.op === "pressButton" && c.b === 0) &&
        clicks.some((c) => c.op === "releaseButton" && c.b === 0),
      "left button (uiohook 1 -> nut Button.LEFT = 0) forwarded",
      JSON.stringify(clicks)
    );

    server.send({ cmd: "down", b: 2 });
    server.send({ cmd: "up", b: 2 });
    server.send({ cmd: "down", b: 3 });
    server.send({ cmd: "up", b: 3 });
    await sleep(80);
    const rm = await client.drain();
    check(
      rm.some((c) => c.op === "pressButton" && c.b === 2) &&
        rm.some((c) => c.op === "releaseButton" && c.b === 2) &&
        rm.some((c) => c.op === "pressButton" && c.b === 1) &&
        rm.some((c) => c.op === "releaseButton" && c.b === 1),
      "right (2 -> Button.RIGHT = 2) and middle (3 -> Button.MIDDLE = 1) forwarded",
      JSON.stringify(rm)
    );

    // Thumb buttons 4/5 have no nut-js equivalent. They must be dropped
    // without throwing and without emitting a bogus injection.
    server.send({ cmd: "down", b: 4 });
    server.send({ cmd: "up", b: 5 });
    await sleep(80);
    const thumb = await client.drain();
    check(
      !thumb.some((c) => c.op === "pressButton" || c.op === "releaseButton"),
      "unsupported thumb buttons (4/5) are ignored, not injected",
      JSON.stringify(thumb)
    );

    // The wheel values below are what a REAL hook reports (verified on Windows
    // with the real libuiohook): one notch up is rotation -1, one notch down is
    // +1 — not +/-120, and not the sign the old code assumed.
    server.send({ cmd: "wheel", r: -1, d: 3 }); // one notch up
    await sleep(90);
    const up = await client.drain();
    check(
      up.some((c) => c.op === "scrollUp" && c.n === 1) && !up.some((c) => c.op === "scrollDown"),
      "one notch up (rotation -1) -> scrollUp",
      JSON.stringify(up)
    );

    server.send({ cmd: "wheel", r: 1, d: 3 }); // one notch down
    await sleep(90);
    const down = await client.drain();
    check(
      down.some((c) => c.op === "scrollDown" && c.n === 1) && !down.some((c) => c.op === "scrollUp"),
      "one notch down (rotation +1) -> scrollDown",
      JSON.stringify(down)
    );

    server.send({ cmd: "wheel", r: -3, d: 3 }); // fast scroll: three notches at once
    await sleep(90);
    const fast = await client.drain();
    check(
      fast.some((c) => c.op === "scrollUp" && c.n === 3),
      "a -3 rotation scrolls three notches, not one",
      JSON.stringify(fast)
    );

    server.send({ cmd: "wheel", r: -1, d: 4 }); // horizontal: tilt left
    server.send({ cmd: "wheel", r: 1, d: 4 }); // tilt right
    await sleep(90);
    const horiz = await client.drain();
    check(
      horiz.some((c) => c.op === "scrollLeft") && horiz.some((c) => c.op === "scrollRight"),
      "horizontal wheel maps to scrollLeft / scrollRight",
      JSON.stringify(horiz)
    );

    // Sub-notch deltas (precision touchpads, free-spinning wheels) arrive as
    // rotation 0. They are not scrolls and must produce no injection at all.
    server.send({ cmd: "wheel", r: 0, d: 3 });
    server.send({ cmd: "wheel", r: 0, d: 3 });
    await sleep(90);
    const zero = await client.drain();
    check(
      !zero.some((c) => c.op.startsWith("scroll")),
      "rotation 0 (sub-notch) produces no scroll at all",
      JSON.stringify(zero)
    );

    server.send({ cmd: "key", k: 16 }); // UiohookKey.Q
    await sleep(80);
    const kd = await client.drain();
    check(kd.some((c) => c.op === "pressKey" && c.k === "Q"), "key down forwarded", JSON.stringify(kd));
    server.send({ cmd: "key", k: 16, up: true });
    await sleep(80);
    const ku = await client.drain();
    check(ku.some((c) => c.op === "releaseKey" && c.k === "Q"), "key up forwarded", JSON.stringify(ku));

    // --- a held button must not survive the hand-back -----------------------
    // If the user drags across the boundary and lets go on the server, the
    // button-up is delivered to the server's own hook and never reaches the
    // client — which would keep the button pressed on the far machine forever
    // (a "stuck" drag / selection). The client has to let go by itself.
    server.send({ cmd: "down", b: 1 }); // left button held down
    await sleep(80);
    const heldDown = await client.drain();
    check(
      heldDown.some((c) => c.op === "pressButton" && c.b === 0),
      "left button is held down on the client",
      JSON.stringify(heldDown)
    );

    // --- return home --------------------------------------------------------
    section("return home (client must reach its far edge)");
    // Server edge 'right' => the client's home edge is its LEFT edge. The
    // client cursor is at x~1320 of 2560 and must reach x<=2: that is ~1300px
    // of leftward travel, far more than the server cursor's remaining room
    // before it clamps at x=0. Only the re-centre dead zone makes this possible.
    let released = false;
    for (let i = 0; i < 90 && !released; i += 1) {
      hand(-60, 0);
      await sleep(12);
      if (client.mode === "local") released = true;
    }
    check(released, "client returned control on reaching its home edge (x<=2 of 2560)", `mode=${client.mode}`);
    const handback = await client.drain();
    check(
      handback.some((c) => c.op === "releaseButton" && c.b === 0),
      "client let go of the held left button on hand-back (no stuck drag)",
      JSON.stringify(handback.filter((c) => c.op.endsWith("Button")))
    );
    await waitFor(() => server.mode === "local", 3000, "server released").catch(() => {});
    check(server.mode === "local", "server resumed local control after 'release'", `mode=${server.mode}`);

    // --- no oscillation + re-capture ---------------------------------------
    section("stability after release");
    const modesSeen = new Set();
    for (let i = 0; i < 15; i += 1) {
      modesSeen.add(server.mode);
      await sleep(40);
    }
    check(
      modesSeen.size === 1 && modesSeen.has("local"),
      "no capture/release oscillation after control returns (stays local)",
      `modes=${[...modesSeen].join(",")}`
    );

    for (let i = 0; i < 40 && server.mode === "local"; i += 1) {
      hand(60, 0);
      await sleep(12);
    }
    await waitFor(() => server.mode === "remote", 1500, "re-capture").catch(() => {});
    check(server.mode === "remote", "re-captures after moving back to the shared edge", `mode=${server.mode}`);
    check(m.x >= SW - 3, `re-capture also happened at the edge (x=${m.x})`, `x=${m.x}`);
  } finally {
    await server.stop();
    await client.stop();
  }
}

// --- scenario 2: single monitor, edge "any" --------------------------------
async function scenarioAnyEdge() {
  const server = new Child(
    "server",
    ["--role", "server", "--port", String(PORT), "--edge", "any"],
    { NETMOUSE_MOCK_DESKTOP: "1920x1080" }
  );
  const client = new Child(
    "client",
    ["--role", "client", "--port", String(PORT), "--host", "127.0.0.1", "--edge", "right"],
    { NETMOUSE_MOCK_DESKTOP: "2560x1440" }
  );
  const m = new Mirror("1920x1080");
  const hand = (dx, dy = 0) => {
    const p = m.step(dx, dy);
    server.send({ cmd: "hand", dx, dy });
    return p;
  };

  try {
    section("handshake");
    await waitFor(() => server.status.some((s) => s.peer === "connected"), 6000, "server connected");
    await waitFor(() => client.status.some((s) => s.peer === "connected"), 6000, "client connected");
    check(true, "both roles connected over TCP");

    // Start mid-screen and push LEFT. With edge "any" this must hand over even
    // though the client is configured with edge "right" -- that mismatch is the
    // whole point of "any".
    section('edge "any": pushing LEFT must hand over');
    m.set(900, 540);
    server.send({ cmd: "setpos", x: 900, y: 540 });
    await sleep(60);
    let capturedAt = null;
    for (let i = 0; i < 60; i += 1) {
      hand(-40, 0);
      await sleep(10);
      if (server.mode === "remote") {
        capturedAt = m.x;
        break;
      }
    }
    check(server.mode === "remote", "capture fires on the LEFT edge with edge=any", `mode=${server.mode}`);
    check(
      capturedAt !== null && capturedAt <= 2,
      `capture happened AT the left edge (x=${capturedAt})`,
      `x=${capturedAt}`
    );
    check(
      server.hasLog(/captured -> forwarding to peer \(left\)/),
      "server reports the edge it actually used (left)",
      server.logs.filter((l) => /captured/.test(l)).join(" | ")
    );

    await waitFor(() => client.mode === "remote", 2000, "client remote").catch(() => {});
    check(client.mode === "remote", "client entered remote mode", `mode=${client.mode}`);

    // The client must now treat its RIGHT edge as home (the opposite of the
    // "left" the server reported), not the "right" its own config implies is
    // shared. Driving the client cursor right must therefore return control.
    section("client returns home from the OPPOSITE edge");
    let released = false;
    for (let i = 0; i < 60 && !released; i += 1) {
      hand(60, 0);
      await sleep(12);
      if (client.mode === "local") released = true;
    }
    check(released, "client returned control at its right edge", `mode=${client.mode}`);
    await waitFor(() => server.mode === "local", 3000, "server released").catch(() => {});
    check(server.mode === "local", "server resumed local control", `mode=${server.mode}`);
  } finally {
    await server.stop();
    await client.stop();
  }
}

// --- scenario 3: two monitors, shared edge on the SECONDARY ----------------
async function scenarioMultiMonitorLeftEdge() {
  // Primary 2880x1800 at (0,0); a portrait 1440x2560 sitting to its LEFT at
  // x=-1440. Virtual desktop: x -1440..2880 (4320 wide), y 0..2560.
  //
  // This is the shape of the desk in the bug report ("I move the mouse left and
  // nothing happens"): the primary's own left edge is at x=0 and is NOT the
  // shared edge, so touching it must do nothing at all. Only x=-1440 counts.
  const SERVER_MONITORS = "2880x1800+0+0,1440x2560-1440+0";
  const server = new Child(
    "server",
    ["--role", "server", "--port", String(PORT), "--edge", "left"],
    { NETMOUSE_MOCK_MONITORS: SERVER_MONITORS }
  );
  const client = new Child(
    "client",
    ["--role", "client", "--port", String(PORT), "--host", "127.0.0.1", "--edge", "right"],
    { NETMOUSE_MOCK_DESKTOP: "1920x1080" }
  );
  const m = new Mirror(SERVER_MONITORS);
  const hand = (dx, dy = 0) => {
    const p = m.step(dx, dy);
    server.send({ cmd: "hand", dx, dy });
    return p;
  };

  try {
    section("handshake");
    await waitFor(() => server.status.some((s) => s.peer === "connected"), 6000, "server connected");
    await waitFor(() => client.status.some((s) => s.peer === "connected"), 6000, "client connected");
    check(true, "both roles connected over TCP");

    check(
      m.box.x === -1440 && m.box.width === 4320 && m.box.height === 2560,
      `harness models the two-monitor desktop (x=${m.box.x} ${m.box.width}x${m.box.height})`,
      JSON.stringify(m.box)
    );

    section("the shared edge belongs to the secondary screen");
    check(
      server.hasLog(/共享边 left 属于显示器 #1（非主屏）/),
      "server log names the monitor that owns the shared edge",
      server.logs.filter((l) => /共享边/.test(l)).join(" | ")
    );

    // --- the primary's own left edge must NOT trigger ----------------------
    section("primary screen's left edge must NOT capture");
    m.set(200, 900);
    server.send({ cmd: "setpos", x: 200, y: 900 });
    await sleep(60);
    for (let i = 0; i < 12; i += 1) {
      hand(-40, 0); // 200 -> -280, crossing the primary's x=0 boundary
      await sleep(10);
    }
    await sleep(150);
    check(
      server.mode === "local",
      `no capture at the primary's left edge (cursor now at x=${m.x}, shared edge is x=-1440)`,
      `mode=${server.mode} x=${m.x}`
    );

    // --- the virtual desktop's real left edge must trigger ------------------
    section("virtual desktop's real left edge must capture");
    let capturedAt = null;
    for (let i = 0; i < 80; i += 1) {
      hand(-40, 0);
      await sleep(10);
      if (server.mode === "remote") {
        capturedAt = m.x;
        break;
      }
    }
    check(server.mode === "remote", "capture fires at x=-1440 (the secondary's outer edge)", `mode=${server.mode}`);
    check(
      capturedAt !== null && capturedAt <= -1437,
      `capture happened AT the far left edge (x=${capturedAt}, expected ~-1440)`,
      `x=${capturedAt}`
    );
    await waitFor(() => client.mode === "remote", 2000, "client remote").catch(() => {});
    check(client.mode === "remote", "client entered remote mode", `mode=${client.mode}`);
  } finally {
    await server.stop();
    await client.stop();
  }
}

async function main() {
  console.log("\n########## scenario 1: single monitor, edge=right ##########");
  await scenarioRightEdge();
  console.log("\n########## scenario 2: single monitor, edge=any ##########");
  await scenarioAnyEdge();
  console.log("\n########## scenario 3: two monitors, edge=left on the secondary ##########");
  await scenarioMultiMonitorLeftEdge();

  console.log(`\n${failures === 0 ? "E2E PASS" : "E2E FAIL"}: ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E harness error:", e);
  process.exit(2);
});

"use strict";
// ---------------------------------------------------------------------------
// Unit tests for the client-side injection self-test and, more importantly, for
// the injection-health contract it depends on.
//
// The bug this file exists to prevent:
//
//   client-input.js used to end every injection in `.catch(() => {})`. On a
//   machine where the OS rejected every injection, the client therefore logged
//   a completely healthy session -- the tracked cursor position is pure
//   arithmetic and keeps advancing whether or not anything reached the OS, so
//   even "returning control to server" fired on schedule. The user saw "the
//   cursor doesn't move over there"; the log said everything was fine.
//
// So the assertions below are behavioural, not textual: with setPosition
// rejecting, the injector MUST report errors and MUST say something. Restoring
// the old swallow-the-error code makes this file fail.
//
// Runs on the native mock (test/mock-native.js) so it needs no real cursor,
// no real hook and no display.
// ---------------------------------------------------------------------------
const assert = require("assert");

// Install the stubs into require.cache BEFORE anything under src/ is required.
const mock = require("./mock-native.js");

const { createInjector } = require("../src/client-input");
const { runInjectTest, motionPlan, motionVerdict, MOVE_TOLERANCE } = require("../src/injecttest");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function makeCfg() {
  return {
    layout: { screenWidth: 1920, screenHeight: 1080, edge: "right" },
    input: { scrollUnit: 1 },
  };
}

async function injectorWithLog() {
  const log = makeLog();
  const inject = createInjector({ cfg: makeCfg(), log });
  await inject.handle({ t: "enter", vw: 1920, vh: 1080, edge: "right" });
  for (let i = 0; i < 50 && !inject.getLocalBox(); i += 1) await sleep(10);
  return { inject, log };
}

console.log("\n=== 1. motionPlan (pure) ===");

check("six steps of width/16 land inside the desktop", () => {
  const plan = motionPlan({ x: 0, y: 0, width: 2560, height: 1440 });
  assert.strictEqual(plan.dx, 160);
  assert.strictEqual(plan.dy, 90);
  assert.deepStrictEqual(plan.from, { x: 1280, y: 720 });
  assert.deepStrictEqual(plan.to, { x: 2240, y: 1260 });
});

check("the plan never leaves the desktop (so clamping cannot mask a failure)", () => {
  for (const box of [
    { x: 0, y: 0, width: 1280, height: 800 },
    { x: 0, y: 0, width: 3840, height: 2160 },
    { x: -1440, y: 0, width: 4320, height: 2715 },
    { x: 0, y: 0, width: 320, height: 200 },
  ]) {
    const p = motionPlan(box);
    assert.ok(p.to.x <= box.x + box.width - 1, `x ${p.to.x} escaped ${JSON.stringify(box)}`);
    assert.ok(p.to.y <= box.y + box.height - 1, `y ${p.to.y} escaped ${JSON.stringify(box)}`);
    assert.ok(p.to.x > p.from.x && p.to.y > p.from.y, "must actually move");
  }
});

check("a tiny desktop still yields a non-zero step", () => {
  const p = motionPlan({ x: 0, y: 0, width: 4, height: 4 });
  assert.strictEqual(p.dx, 1);
  assert.strictEqual(p.dy, 1);
});

check("the plan honours a negative desktop origin", () => {
  const p = motionPlan({ x: -1440, y: -100, width: 4320, height: 2715 });
  assert.strictEqual(p.from.x, -1440 + 2160);
  assert.strictEqual(p.from.y, -100 + 1357);
  assert.ok(p.to.x > p.from.x);
});

console.log("\n=== 2. motionVerdict (pure) ===");

// A plan for a 2560x1440 desktop: six steps of +160,+90 out of the centre.
const PLAN = motionPlan({ x: 0, y: 0, width: 2560, height: 1440 });
const EXPECT = { x: PLAN.dx * PLAN.steps, y: PLAN.dy * PLAN.steps };

check("the cursor moved exactly as far as we asked -> ok", () => {
  const v = motionVerdict(PLAN, { x: 100, y: 100 }, { x: 100 + EXPECT.x, y: 100 + EXPECT.y });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reason, "ok");
  assert.strictEqual(v.off, 0);
  assert.strictEqual(v.dx, EXPECT.x);
});

check("within tolerance -> ok", () => {
  const v = motionVerdict(PLAN, { x: 100, y: 100 }, { x: 100 + EXPECT.x + 5, y: 100 + EXPECT.y - 4 });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.off, 5);
});

check("just past tolerance -> off-target", () => {
  const v = motionVerdict(
    PLAN,
    { x: 0, y: 0 },
    { x: EXPECT.x + MOVE_TOLERANCE + 1, y: EXPECT.y }
  );
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, "off-target");
});

check("the cursor never moved -> did-not-move", () => {
  const v = motionVerdict(PLAN, { x: 37, y: 42 }, { x: 37, y: 42 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, "did-not-move");
});

check("half the motion is off-target, not a pass", () => {
  const v = motionVerdict(PLAN, { x: 0, y: 0 }, { x: EXPECT.x / 2, y: EXPECT.y / 2 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, "off-target");
});

check("a relative-only backend passes wherever the cursor started", () => {
  // This is why the verdict compares displacement. A uinput tool cannot seed
  // the cursor, so on a real machine the real cursor begins at an arbitrary
  // offset from the computed centre; an absolute comparison would fail it.
  const v = motionVerdict(PLAN, { x: 2400, y: 30 }, { x: 2400 + EXPECT.x, y: 30 + EXPECT.y });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.off, 0);
});

check("an unreadable cursor is its own reason", () => {
  const v = motionVerdict(PLAN, { x: 0, y: 0 }, null);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, "no-cursor");
});

check("with no baseline it falls back to the absolute target", () => {
  assert.strictEqual(motionVerdict(PLAN, null, PLAN.to).ok, true);
  const bad = motionVerdict(PLAN, null, { x: PLAN.to.x + 500, y: PLAN.to.y });
  assert.strictEqual(bad.reason, "off-target");
});

console.log("\n=== 3. injection health (behavioural, on the native mock) ===");

(async () => {
  const realSetPosition = mock.nutMock.mouse.setPosition;

  await checkAsync("a healthy injector reports zero errors", async () => {
    const { inject } = await injectorWithLog();
    await inject.handle({ t: "mm", dx: 20, dy: 20 });
    await sleep(30);
    const h = inject.getInjectionHealth();
    assert.strictEqual(h.errors, 0, `expected 0 errors, got ${h.errors} (${h.lastError})`);
    assert.ok(h.applied > 0, "expected the injection to be counted as applied");
  });

  await checkAsync("a rejected setPosition is counted, not swallowed", async () => {
    mock.nutMock.mouse.setPosition = () => Promise.reject(new Error("XTest: BadDisplay (test)"));
    try {
      const { inject } = await injectorWithLog();
      await inject.handle({ t: "mm", dx: 20, dy: 20 });
      await sleep(30);
      const h = inject.getInjectionHealth();
      assert.ok(h.errors > 0, "a rejected injection MUST be counted");
      assert.match(h.lastError || "", /BadDisplay/);
    } finally {
      mock.nutMock.mouse.setPosition = realSetPosition;
    }
  });

  await checkAsync("...and it says so out loud, with the real message", async () => {
    mock.nutMock.mouse.setPosition = () => Promise.reject(new Error("XTest: BadDisplay (test)"));
    try {
      const { inject, log } = await injectorWithLog();
      await inject.handle({ t: "mm", dx: 20, dy: 20 });
      await sleep(30);
      const warned = log.lines.filter((l) => l.lvl === "warn" && /注入失败/.test(l.text));
      assert.ok(warned.length > 0, "expected a warning naming the injection failure");
      assert.match(warned[0].text, /BadDisplay/, "the warning must carry the real error text");
      assert.match(warned[0].text, /injecttest/, "the warning must point at the self-test");
      assert.ok(inject.getInjectionHealth().errors > 0);
    } finally {
      mock.nutMock.mouse.setPosition = realSetPosition;
    }
  });

  await checkAsync("the warning is emitted once, not once per mouse event", async () => {
    mock.nutMock.mouse.setPosition = () => Promise.reject(new Error("boom"));
    try {
      const { inject, log } = await injectorWithLog();
      for (let i = 0; i < 12; i += 1) {
        await inject.handle({ t: "mm", dx: 5, dy: 5 });
        await sleep(5);
      }
      await sleep(40);
      const warned = log.lines.filter((l) => l.lvl === "warn" && /注入失败/.test(l.text));
      assert.strictEqual(warned.length, 1, `expected exactly 1 warning, got ${warned.length}`);
      assert.ok(inject.getInjectionHealth().errors >= 12, "every failure must still be counted");
    } finally {
      mock.nutMock.mouse.setPosition = realSetPosition;
    }
  });

  await checkAsync("rejected button injection is counted too", async () => {
    const realPress = mock.nutMock.mouse.pressButton;
    mock.nutMock.mouse.pressButton = () => Promise.reject(new Error("no button for you"));
    try {
      const { inject } = await injectorWithLog();
      await inject.handle({ t: "md", b: 1 });
      const h = inject.getInjectionHealth();
      assert.ok(h.errors > 0, "a rejected pressButton MUST be counted");
      assert.match(h.lastError || "", /no button/);
    } finally {
      mock.nutMock.mouse.pressButton = realPress;
    }
  });

  await checkAsync("the success counter still moves for buttons and wheel", async () => {
    const { inject } = await injectorWithLog();
    // The hand-over seeding is an async setPosition; let it land before we take
    // the baseline, otherwise it gets counted after the fact and shifts the
    // expected total by one.
    await sleep(30);
    const before = inject.getInjectionHealth().applied;
    await inject.handle({ t: "md", b: 1 });
    await inject.handle({ t: "mu", b: 1 });
    await inject.handle({ t: "wh", r: -1, d: 3 });
    const after = inject.getInjectionHealth();
    assert.strictEqual(after.errors, 0);
    assert.strictEqual(after.applied, before + 3);
  });

  await checkAsync("runInjectTest is exported and callable as a module", async () => {
    assert.strictEqual(typeof runInjectTest, "function");
  });

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length) {
    console.log(`INJECTTEST-UNITS FAIL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  console.log(`INJECTTEST-UNITS PASS: ${passed}/${passed} checks passed`);
  process.exit(0);
})();

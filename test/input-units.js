"use strict";
// ---------------------------------------------------------------------------
// Unit checks for the button and wheel contract between the two machines.
//
// This file exists because of a bug that no other test could catch: nut-js's
// Button enum is { LEFT: 0, MIDDLE: 1, RIGHT: 2 }, so a client-side guard
// written as `if (btn) mouse.pressButton(btn)` compiles, runs, and silently
// drops EVERY left click — while right and middle keep working, because 2 and 1
// are truthy. Movement is unaffected, so the symptom is "the pointer moves but
// clicking does nothing".
//
// The same class of mistake hit the wheel: the wire carries libuiohook's
// normalised notch count (one notch up is rotation -1), not the raw +/-120 that
// a first reading of the docs suggests, and a rotation of 0 is a sub-notch
// delta that is not a scroll at all.
//
// These assertions are deliberately written against the REAL nut-js enum, not a
// stub, so that a future version changing Button.LEFT fails loudly here.
//
// Run: node test/input-units.js
// ---------------------------------------------------------------------------
const { Button } = require("@nut-tree-fork/nut-js");
const { buttonFor, wheelAction, BTN } = require("../src/client-input");
const { scrollUnit } = require("../src/platform");

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

// ---------------------------------------------------------------------------
section("nut-js's real Button enum is the trap we are guarding against");
check(Button.LEFT === 0, "Button.LEFT is 0 (falsy!)", String(Button.LEFT));
check(Button.MIDDLE === 1, "Button.MIDDLE is 1", String(Button.MIDDLE));
check(Button.RIGHT === 2, "Button.RIGHT is 2", String(Button.RIGHT));
check(!Button.LEFT, "`if (Button.LEFT)` is false — the exact bug", String(!!Button.LEFT));

// ---------------------------------------------------------------------------
section("uiohook button code -> nut Button");
// libuiohook/include/uiohook.h: MOUSE_BUTTON1=1 left, 2 right, 3 middle,
// 4/5 thumb. Confirmed against a real Windows hook.
check(buttonFor(1) === Button.LEFT, "1 (left) -> Button.LEFT");
check(buttonFor(1) === 0, "1 (left) -> 0, which is why `if (b)` breaks", String(buttonFor(1)));
check(buttonFor(2) === Button.RIGHT, "2 (right) -> Button.RIGHT");
check(buttonFor(3) === Button.MIDDLE, "3 (middle) -> Button.MIDDLE");
check(buttonFor(4) === null, "4 (thumb back) -> null (nut-js cannot inject it)", String(buttonFor(4)));
check(buttonFor(5) === null, "5 (thumb forward) -> null", String(buttonFor(5)));
check(buttonFor(0) === null, "0 -> null", String(buttonFor(0)));
check(buttonFor(undefined) === null, "undefined -> null", String(buttonFor(undefined)));

// The guard the handler must use: `=== null`, never truthiness.
section("the correct guard accepts every real button");
const allButtons = [1, 2, 3].map(buttonFor);
check(
  allButtons.every((b) => b !== null),
  "1/2/3 all pass a `!== null` guard",
  JSON.stringify(allButtons)
);
check(
  allButtons.filter((b) => b).length === 2,
  "only 2 of the 3 survive a truthiness guard — left is lost",
  `${allButtons.filter((b) => b).length}/3`
);

// ---------------------------------------------------------------------------
section("wheel: sign, axis and magnitude");
const V = 3; // WheelDirection.VERTICAL
const H = 4; // WheelDirection.HORIZONTAL
const U = 1; // unit 1 keeps the arithmetic readable

// Verified on Windows with the real hook: one notch up reports rotation -1.
check(
  wheelAction(-1, V, U)?.op === "scrollUp",
  "rotation -1 (vertical) -> scrollUp",
  JSON.stringify(wheelAction(-1, V, U))
);
check(
  wheelAction(1, V, U)?.op === "scrollDown",
  "rotation +1 (vertical) -> scrollDown",
  JSON.stringify(wheelAction(1, V, U))
);
check(
  wheelAction(-1, H, U)?.op === "scrollLeft",
  "rotation -1 (horizontal) -> scrollLeft",
  JSON.stringify(wheelAction(-1, H, U))
);
check(
  wheelAction(1, H, U)?.op === "scrollRight",
  "rotation +1 (horizontal) -> scrollRight",
  JSON.stringify(wheelAction(1, H, U))
);

// The old bug: 0 fell into the ">= 0 so scroll up" branch and twitched the
// wheel upward on every sub-notch delta from a precision touchpad.
check(wheelAction(0, V, U) === null, "rotation 0 -> null (not a scroll)", JSON.stringify(wheelAction(0, V, U)));
check(wheelAction(0, H, U) === null, "rotation 0 horizontal -> null", JSON.stringify(wheelAction(0, H, U)));
check(wheelAction(undefined, V, U) === null, "rotation undefined -> null", String(wheelAction(undefined, V, U)));
check(wheelAction(null, V, U) === null, "rotation null -> null", String(wheelAction(null, V, U)));

section("wheel: magnitude and clamping");
check(wheelAction(-3, V, U)?.amount === 3, "rotation -3 -> 3 notches", String(wheelAction(-3, V, U)?.amount));
check(wheelAction(1, V, 120)?.amount === 120, "unit 120 scales one notch to 120", String(wheelAction(1, V, 120)?.amount));
check(wheelAction(-2, V, 120)?.amount === 240, "unit 120 scales two notches to 240", String(wheelAction(-2, V, 120)?.amount));
check(
  wheelAction(-99999, V, U)?.amount === 20,
  "an absurd rotation is clamped to 20 notches",
  String(wheelAction(-99999, V, U)?.amount)
);
check(wheelAction(0.4, V, U) === null, "a fractional rotation below 0.5 rounds to 0 -> null", String(wheelAction(0.4, V, U)));
check(wheelAction(-0.6, V, U)?.op === "scrollUp", "a fractional rotation rounds to -1 -> scrollUp", JSON.stringify(wheelAction(-0.6, V, U)));

// ---------------------------------------------------------------------------
section("scroll unit is platform-dependent (nut-js leaky abstraction)");
check(
  scrollUnit() === (process.platform === "win32" ? 120 : 1),
  `scrollUnit() is ${process.platform === "win32" ? 120 : 1} on ${process.platform}`,
  String(scrollUnit())
);
check(typeof scrollUnit() === "number" && scrollUnit() > 0, "scrollUnit() is a positive number");

// ---------------------------------------------------------------------------
section("the wire contract the server must produce");
// This mirrors server-input.js onWheel(): rotation 0 is dropped before sending.
const forwarded = (e) => (!e.rotation ? null : { t: "wh", r: e.rotation, d: e.direction });
check(forwarded({ rotation: 0, direction: 3 }) === null, "server drops rotation 0");
check(forwarded({ rotation: -1, direction: 3 })?.r === -1, "server forwards rotation -1");

// ---------------------------------------------------------------------------
section("input options survive a save/load round trip");
// A setting the UI can change but that silently disappears on restart is worse
// than no setting at all, and nothing else in the suite covers config.js.
const { normalize, serialize, DEFAULTS, BACKENDS } = require("../src/config");
{
  const n = normalize({});
  check(n.input.backend === "auto", "input.backend defaults to auto", String(n.input.backend));
  check(
    n.input.manageYdotoold === true,
    "input.manageYdotoold defaults to true (the daemon is started for you)",
    String(n.input.manageYdotoold)
  );
  check(
    normalize({ input: { manageYdotoold: false } }).input.manageYdotoold === false,
    "an explicit false is honoured, not coerced back"
  );
  check(
    normalize({ input: { manageYdotoold: "false" } }).input.manageYdotoold === true,
    'only a JSON boolean disables it -- "false" (a string) does not, matching every other flag in config.js'
  );
  check(
    normalize({ input: { backend: "nonsense" } }).input.backend === "auto",
    "an unknown backend falls back to auto rather than failing to start"
  );
  check(BACKENDS.includes("uinput") && BACKENDS.includes("xtest"), "both backends are valid values");

  const saved = serialize(normalize({ input: { backend: "uinput", manageYdotoold: false } }));
  check(saved.input.backend === "uinput", "serialize() persists input.backend", saved.input.backend);
  check(
    saved.input.manageYdotoold === false,
    "serialize() persists input.manageYdotoold",
    String(saved.input.manageYdotoold)
  );
  // Round trip: what serialize() writes must reload to the same values.
  const back = normalize(JSON.parse(JSON.stringify(saved)));
  check(
    back.input.backend === "uinput" && back.input.manageYdotoold === false,
    "the round trip is lossless"
  );
  check(
    DEFAULTS.input.manageYdotoold === true,
    "DEFAULTS and normalize() agree on the default"
  );
}

console.log("");
if (failures) {
  console.log(`HWTEST-INPUT FAIL: ${checks - failures}/${checks} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`HWTEST-INPUT PASS: ${checks}/${checks}`);

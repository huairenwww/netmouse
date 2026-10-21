"use strict";
// ---------------------------------------------------------------------------
// Unit checks for the helpers behind the hardware self-test.
//
// The self-test drives the real cursor and asserts "capture happened AT the
// edge". If edgePoint() aimed at the wrong pixel, or remaining() measured from
// the wrong boundary, the test would confidently report the wrong verdict on
// the user's machine -- the one place it cannot be debugged. So the aiming and
// measuring math is pinned down here.
//
// Run: node test/hwtest-units.js
// ---------------------------------------------------------------------------
const { edgePoint, remaining, DIRS } = require("../src/hwtest");

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

// The desk from the bug report, as the platform layer would report it: a
// 2880x1800 primary at 200% with a portrait 1440x2560 at 125% on its left.
// Physical virtual desktop: x -1440..2880, y 0..2560.
const TWO_MONITOR = { x: -1440, y: 0, width: 4320, height: 2560 };
const SINGLE = { x: 0, y: 0, width: 1280, height: 800 };

section("edgePoint lands exactly ON the boundary");
check(edgePoint(SINGLE, "left").x === 0, "left edge is x=0", String(edgePoint(SINGLE, "left").x));
check(
  edgePoint(SINGLE, "right").x === 1279,
  "right edge is x=width-1 (not width)",
  String(edgePoint(SINGLE, "right").x)
);
check(edgePoint(SINGLE, "top").y === 0, "top edge is y=0", String(edgePoint(SINGLE, "top").y));
check(
  edgePoint(SINGLE, "bottom").y === 799,
  "bottom edge is y=height-1",
  String(edgePoint(SINGLE, "bottom").y)
);

section("edgePoint aims at the MIDDLE of the perpendicular span");
// Not the corner: a corner point is ambiguous between two edges, and on a
// multi-monitor desk a corner may belong to a different screen entirely.
check(edgePoint(SINGLE, "left").y === 400, "left aims at y=height/2", String(edgePoint(SINGLE, "left").y));
check(edgePoint(SINGLE, "top").x === 640, "top aims at x=width/2", String(edgePoint(SINGLE, "top").x));
check(
  edgePoint(TWO_MONITOR, "left").y === 1280,
  "on the two-monitor desk, left aims at y=1280 (middle of 2560)",
  String(edgePoint(TWO_MONITOR, "left").y)
);

section("negative origins are honoured (secondary screen left of primary)");
check(
  edgePoint(TWO_MONITOR, "left").x === -1440,
  "left edge is the virtual desktop's -1440, not the primary's 0",
  String(edgePoint(TWO_MONITOR, "left").x)
);
check(
  edgePoint(TWO_MONITOR, "right").x === 2879,
  "right edge is 2880-1 (the primary's outer edge)",
  String(edgePoint(TWO_MONITOR, "right").x)
);

section("remaining() is zero exactly when sitting on the edge");
for (const dir of DIRS) {
  const p = edgePoint(TWO_MONITOR, dir);
  check(remaining(TWO_MONITOR, dir, p) === 0, `${dir}: 0 at the edge`, String(remaining(TWO_MONITOR, dir, p)));
}

section("remaining() grows inward and goes negative past the edge");
const centre = { x: TWO_MONITOR.x + Math.floor(TWO_MONITOR.width / 2), y: 1280 };
check(remaining(TWO_MONITOR, "left", centre) === 2160, "left: centre is 2160 in", String(remaining(TWO_MONITOR, "left", centre)));
check(remaining(TWO_MONITOR, "right", centre) === 2159, "right: centre is 2159 in", String(remaining(TWO_MONITOR, "right", centre)));
check(
  remaining(TWO_MONITOR, "left", { x: -1441, y: 1280 }) === -1,
  "left: 1px past the edge reads -1 (reported as an overshoot)",
  String(remaining(TWO_MONITOR, "left", { x: -1441, y: 1280 }))
);

section("the primary's own left edge is NOT the shared edge");
// The whole point of the bug report: x=0 sits between the two screens. If
// remaining() reported 0 there, the self-test would call a mid-desktop point
// "at the edge" and the diagnosis would be worthless.
check(
  remaining(TWO_MONITOR, "left", { x: 0, y: 1280 }) === 1440,
  "x=0 is 1440px away from the real left edge",
  String(remaining(TWO_MONITOR, "left", { x: 0, y: 1280 }))
);

console.log(
  `\n${failures === 0 ? "HWTEST-UNITS PASS" : "HWTEST-UNITS FAIL"}: ${checks - failures}/${checks} checks passed\n`
);
process.exit(failures === 0 ? 0 : 1);

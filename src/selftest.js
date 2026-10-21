// Minimal self-check. Run: node src/selftest.js
const assert = require("assert");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const { Key } = require("@nut-tree-fork/nut-js");
const { buildKeyMap } = require("./keymap");

const { u2n, n2name } = buildKeyMap(UiohookKey, Key);

// letters & digits
assert.strictEqual(u2n[UiohookKey.A], Key.A, "A");
assert.strictEqual(u2n[UiohookKey["9"]], Key["9"], "9");
// modifiers translate correctly
assert.strictEqual(u2n[UiohookKey.Shift], Key.LeftShift, "Shift->LeftShift");
assert.strictEqual(u2n[UiohookKey.Ctrl], Key.LeftControl, "Ctrl->LeftControl");
assert.strictEqual(u2n[UiohookKey.AltRight], Key.RightAlt, "AltRight->RightAlt");
// punctuation aliases
assert.strictEqual(u2n[UiohookKey.BracketLeft], Key.LeftBracket, "BracketLeft");
assert.strictEqual(u2n[UiohookKey.Backquote], Key.Grave, "Backquote->Grave");
// arrows
assert.strictEqual(u2n[UiohookKey.ArrowLeft], Key.ArrowLeft, "ArrowLeft");
// numpad
assert.strictEqual(u2n[UiohookKey.Numpad7], Key.NumPad7, "Numpad7->NumPad7");

// no unintended collisions. NumpadEnter/Enter intentionally share Key.Enter
// (nut-js has no separate numpad-enter code), so allow that one pair.
const targets = Object.values(u2n);
assert.strictEqual(new Set(targets).size, targets.length - 1, "only Enter is dual-mapped");
assert.strictEqual(u2n[UiohookKey.NumpadEnter], Key.Enter, "NumpadEnter->Enter");

// reverse map is consistent
for (const [u, n] of Object.entries(u2n)) {
  assert.strictEqual(n2name[n] !== undefined, true, `reverse for ${u}`);
}

// coordinate scaling (same math client-input uses)
const map = (x, y, srcW, srcH, dstW, dstH) => [
  Math.round((x / srcW) * dstW),
  Math.round((y / srcH) * dstH),
];
assert.deepStrictEqual(map(0, 0, 1920, 1080, 2560, 1440), [0, 0]);
assert.deepStrictEqual(map(1920, 1080, 1920, 1080, 2560, 1440), [2560, 1440]);
assert.deepStrictEqual(map(960, 540, 1920, 1080, 2560, 1440), [1280, 720]);

// --- edge-gate regression -------------------------------------------------
// Bug: on taking control the cursor is injected AT the shared edge, so both the
// server (re-capture) and the client (return-home) immediately fired and the
// pair entered an enter/release loop. Each side must first see the cursor move
// inward before an edge hit counts.

// server: distance to its own shared edge
function serverDist(edge, x, y, W, H) {
  return edge === "right" ? W - x : edge === "left" ? x : edge === "top" ? y : H - y;
}
// client: distance to the home edge (opposite of the server's)
function clientDist(homeEdge, x, y, W, H) {
  return homeEdge === "left" ? x : homeEdge === "right" ? W - 1 - x : homeEdge === "top" ? y : H - 1 - y;
}

const W = 2560, H = 1440;
// Simulate a capture session: start pinned at edge, user moves inward, returns.
function simulate(LEAVE, EDGE) {
  let armed = false;
  const seq = [0, 0, 3, 10, 50, 20, 5, 1, 0]; // edge -> inward -> back to edge
  for (const d of seq) {
    if (!armed && d > LEAVE) armed = true;
    if (armed && d <= EDGE) return 1; // fired, session ends (release)
  }
  return 0;
}
assert.strictEqual(simulate(8, 2), 1, "client returns exactly once");
// Without the gate, the very first frame (already at edge) fires.
assert.strictEqual([0, 0, 0, 0].filter((d) => d <= 2).length, 4, "ungated fires every frame");

// server side: right edge, cursor pinned at W-2 -> dist 2, must arm after moving in
assert.strictEqual(serverDist("right", W - 1, 0, W, H) <= 1, true, "server edge hit detected");
assert.strictEqual(serverDist("right", W - 50, 0, W, H) > 6, true, "server sees inward move");
assert.strictEqual(clientDist("right", 0, 0, W, H) > 8, true, "client inward (left side)");

// --- multi-monitor parsing -------------------------------------------------
const { parseXrandrBounds, parseXrandrMonitors } = require("./platform");

// two 1728-wide monitors side by side, primary on the right
const XR = [
  "Screen 0: minimum 320 x 200, current 3456 x 2170, maximum 16384 x 16384",
  "DP-1 connected 1728x2170+0+0 (normal left inverted right x axis y axis)",
  "DP-2 connected primary 1728x2170+1728+0 (normal left inverted right)",
].join("\n");

assert.deepStrictEqual(parseXrandrBounds(XR), { x: 0, y: 0, width: 3456, height: 2170 }, "virtual bounds");
const mons = parseXrandrMonitors(XR);
assert.strictEqual(mons.length, 2, "two monitors parsed");
assert.strictEqual(mons[1].primary, true, "primary flagged");
assert.deepStrictEqual(mons[0], { x: 0, y: 0, width: 1728, height: 2170, primary: false }, "left monitor");

// monitor left of primary -> negative origin
const XR_NEG = [
  "Screen 0: minimum 320 x 200, current 3840 x 1080, maximum 16384 x 16384",
  "HDMI-1 connected 1920x1080-1920+0 (normal)",
  "DP-1 connected primary 1920x1080+0+0 (normal)",
].join("\n");
assert.deepStrictEqual(parseXrandrBounds(XR_NEG), { x: -1920, y: 0, width: 3840, height: 1080 }, "negative origin");

// edge trigger rectangle math: pick monitor #1 (left, 1728 wide)
function edgeDist(edge, x, y, EX, EY, EW, EH) {
  return edge === "right" ? EX + EW - x : edge === "left" ? x - EX : edge === "top" ? y - EY : EY + EH - y;
}
// left monitor's left edge at x=0; moving one px in from x=0
assert.strictEqual(edgeDist("left", 0, 100, 0, 0, 1728, 2170), 0, "left edge hit on monitor 0");
assert.strictEqual(edgeDist("left", 5, 100, 0, 0, 1728, 2170), 5, "inward move");
// right monitor's right edge
assert.strictEqual(edgeDist("right", 3456, 100, 1728, 0, 1728, 2170), 0, "right edge hit on monitor 1");

// --- monitor resolution / stable identity ---------------------------------
const { resolveMonitor, monitorSig } = require("./platform");
const MONS = [
  { x: 1728, y: 0, width: 1728, height: 2170, primary: true, sig: "1728x2170+1728+0" },
  { x: 0, y: 0, width: 1728, height: 2170, primary: false, sig: "1728x2170+0+0" },
];
assert.strictEqual(resolveMonitor("all", MONS), null, "all -> whole desktop");
assert.strictEqual(resolveMonitor("", MONS), null, "empty -> whole desktop");
assert.strictEqual(resolveMonitor("primary", MONS).index, 0, "primary resolves");
assert.strictEqual(resolveMonitor("1", MONS).monitor.x, 0, "index 1 is the left monitor");
// geometry signature survives a reorder (the whole point vs a bare index)
assert.strictEqual(resolveMonitor("1728x2170+0+0", MONS).index, 1, "signature resolves");
assert.strictEqual(resolveMonitor("9", MONS), null, "out-of-range index -> null");
assert.strictEqual(resolveMonitor("999x999+9+9", MONS), null, "unknown signature -> null");
assert.strictEqual(monitorSig({ x: -1920, y: 0, width: 1920, height: 1080 }), "1920x1080-1920+0", "negative sig");

// --- panic hotkey parsing --------------------------------------------------
const { parseHotkey, hotkeyMatches } = require("./hotkey");
const hk = parseHotkey("Ctrl+Alt+Shift+Q", UiohookKey);
assert.ok(hk && hk.groups.length === 4, "4 groups parsed");
// all keys held -> match
assert.strictEqual(
  hotkeyMatches(hk, new Set([UiohookKey.Ctrl, UiohookKey.Alt, UiohookKey.Shift, UiohookKey.Q])),
  true,
  "exact combo matches"
);
// right-hand modifiers count as their left counterparts
assert.strictEqual(
  hotkeyMatches(hk, new Set([UiohookKey.CtrlRight, UiohookKey.AltRight, UiohookKey.ShiftRight, UiohookKey.Q])),
  true,
  "right-hand modifiers match"
);
// missing a modifier -> no match
assert.strictEqual(
  hotkeyMatches(hk, new Set([UiohookKey.Ctrl, UiohookKey.Shift, UiohookKey.Q])),
  false,
  "missing Alt does not match"
);
// plain typing of Q must not trigger it
assert.strictEqual(hotkeyMatches(hk, new Set([UiohookKey.Q])), false, "bare Q does not match");
assert.strictEqual(parseHotkey("Q", UiohookKey), null, "single key spec rejected");
assert.strictEqual(parseHotkey("", UiohookKey), null, "empty spec rejected");
assert.strictEqual(parseHotkey("Ctrl+Bogus", UiohookKey), null, "unknown key rejected");

// --- config: new sections default + round-trip -----------------------------
const cfgMod = require("./config");
const dflt = cfgMod.normalize({});
assert.strictEqual(dflt.input.blockLocal, true, "blockLocal defaults to true");
assert.strictEqual(dflt.clipboard.enabled, true, "clipboard defaults to true");
assert.strictEqual(dflt.layout.monitor, "all", "monitor defaults to all");
assert.strictEqual(cfgMod.normalize({ input: { blockLocal: false } }).input.blockLocal, false, "blockLocal override");
const ser = cfgMod.serialize(cfgMod.normalize({ input: { panicHotkey: "Ctrl+Alt+Q" } }));
assert.strictEqual(ser.input.panicHotkey, "Ctrl+Alt+Q", "panicHotkey survives serialize");
assert.strictEqual(ser.clipboard.enabled, true, "clipboard survives serialize");
assert.strictEqual(ser.layout.monitor, "all", "monitor survives serialize");

// --- clipboard loop guard --------------------------------------------------
const { createClipboardSync } = require("./clipboard");
let cbValue = "seed";
const sent = [];
const clip = createClipboardSync({
  io: {
    read: () => cbValue,
    write: (t) => {
      cbValue = t;
    },
  },
  send: (m) => sent.push(m),
  log: { debug() {}, warn() {} },
});
clip.start(); // baseline is adopted, nothing sent
assert.strictEqual(sent.length, 0, "baseline clipboard not sent on start");
cbValue = "local-copy";
clip._tick();
assert.deepStrictEqual(sent, [{ t: "cb", text: "local-copy" }], "local copy sent once");
clip._tick();
assert.strictEqual(sent.length, 1, "unchanged clipboard not re-sent");

assert.strictEqual(clip.onMessage({ t: "cb", text: "from-peer" }), true, "cb message handled");
assert.strictEqual(cbValue, "from-peer", "peer text written locally");
clip._tick();
assert.strictEqual(sent.length, 1, "applied peer text is not echoed back");
assert.strictEqual(clip._state().lastApplied, "from-peer", "applied value remembered");

// an echo of what we last sent is a no-op
const before = cbValue;
assert.strictEqual(clip.onMessage({ t: "cb", text: "from-peer" }), true, "duplicate cb handled");
assert.strictEqual(cbValue, before, "duplicate cb does not rewrite");

assert.strictEqual(clip.onMessage({ t: "mm", x: 1, y: 2 }), false, "non-cb not handled");
clip.stop();
assert.strictEqual(clip.isActive(), false, "clipboard sync stopped");

// --- uiohook envelope (Server physical coordinate frame) -------------------
// The server learns the desktop box from the hook itself because per-monitor
// DPI makes every OS API report a space that disagrees with the hooks.
const { makeEnvelope, envelopeObserve, envelopeBox } = require("./server-input");
const env = makeEnvelope({ layout: { screenWidth: 1920, screenHeight: 1080 } });

// before any event, falls back to the seeded span
assert.deepStrictEqual(envelopeBox(env), { x: 0, y: 0, width: 1920, height: 1080 }, "seeded box");

// observed extreme points (mixed physical layout, negative-capable)
const pts = [
  { x: -109, y: -67 },
  { x: 4397, y: 2729 },
  { x: 100, y: 100 },
  { x: 2880, y: 1800 },
];
for (const p of pts) envelopeObserve(env, p);
const box = envelopeBox(env);
assert.strictEqual(box.x, -109, "min x learned");
assert.strictEqual(box.y, -67, "min y learned");
assert.strictEqual(box.width, 4397 - -109, "width from envelope");
assert.strictEqual(box.height, 2729 - -67, "height from envelope");

// left-edge distance uses raw hook coords minus the learned origin
const leftDist = (e, b) => e.x - b.x;
assert.strictEqual(leftDist({ x: -109 }, box), 0, "left edge at min x");
assert.strictEqual(leftDist({ x: 0 }, box), 109, "inward from left edge");

// --- raw-hook edge rule (primary at origin) --------------------------------
// Left/top must key off the fixed primary origin, not the learned envelope —
// learning from the current cursor position caused instant false captures.
const MARGIN = 1;
const atLeftEdge = (e) => e.x <= 0 + MARGIN;
assert.strictEqual(atLeftEdge({ x: 0 }), true, "x=0 is left edge");
assert.strictEqual(atLeftEdge({ x: -109 }), true, "negative overshoot is left edge");
assert.strictEqual(atLeftEdge({ x: 500 }), false, "middle is not left edge");

// a tiny early envelope must not be treated as a mature desktop
const env2 = makeEnvelope({ layout: { screenWidth: 1920, screenHeight: 1080 } });
[0, 200, 400].forEach((x) => envelopeObserve(env2, { x, y: 0 }));
const b2 = envelopeBox(env2);
assert.strictEqual(b2.width < 600, true, "immature envelope stays small");
[1350, 4397].forEach((x) => envelopeObserve(env2, { x, y: 0 }));
assert.strictEqual(envelopeBox(env2).width >= 600, true, "mature after a real sweep");

// --- relative motion (what the server forwards while captured) -------------
// Deltas between consecutive hook samples are DPI- and layout-proof.
function deltaSeq(pts) {
  const out = [];
  let lx = pts[0].x;
  let ly = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    out.push({ dx: pts[i].x - lx, dy: pts[i].y - ly });
    lx = pts[i].x;
    ly = pts[i].y;
  }
  return out;
}
assert.deepStrictEqual(
  deltaSeq([{ x: 100, y: 100 }, { x: 103, y: 106 }, { x: 103, y: 106 }]),
  [{ dx: 3, dy: 6 }, { dx: 0, dy: 0 }],
  "deltas reflect hand motion"
);

console.log(`selftest OK: ${Object.keys(u2n).length} keys mapped`);

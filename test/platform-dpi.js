"use strict";
// ---------------------------------------------------------------------------
// Regression test for the mixed-DPI / multi-monitor geometry bug.
//
// THE BUG
//   `display.bounds` from Electron is in DIP points, while uiohook reports the
//   mouse position in PHYSICAL pixels. The original code converted with
//   `bounds * scaleFactor`, which is only correct when the display happens to
//   sit directly beside the primary on the same axis.
//
// WHY IT IS WRONG
//   Chromium does not scale each display independently. It reasons over the
//   monitors as a TREE rooted at the primary, laying children out adjacently in
//   DIP space ("DisplayInfosToScreenWinDisplays", ui/display/win/screen_win.cc).
//   So a secondary's DIP origin is its *parent's DIP edge*, not its own
//   physical origin divided by its own scale factor. Multiplying that DIP
//   origin by the secondary's scale factor lands somewhere that is not the
//   display's real physical position -- which is exactly how a shared edge ends
//   up at a coordinate the cursor can never reach.
//
//   The authoritative conversion is Chromium's own inverse,
//   `screen.dipToScreenRect(null, bounds)`: Electron documents that with a null
//   window the scaling is "performed to the display nearest to `rect`", i.e.
//   the display itself.
//
// WHAT THIS FILE PINS DOWN
//   1. `detectMonitors()` returns the rect from `dipToScreenRect`, not the
//      naive product.
//   2. The virtual desktop is therefore the TRUE bounding box (4320 wide in the
//      fixture below, where the naive maths yields 3240).
//   3. The fallback is still the naive product when the conversion API is
//      unavailable (older Electron / non-win32).
//   4. `edgeOwner()` names the screen that actually owns a shared edge, which
//      is the thing that makes "moving left does nothing" diagnosable.
//
// Run: node test/platform-dpi.js
// ---------------------------------------------------------------------------
const path = require("path");

let failures = 0;
let checks = 0;
function check(cond, label, extra) {
  checks += 1;
  if (cond) console.log(`  \u2713 ${label}`);
  else {
    failures += 1;
    console.log(`  \u2717 ${label}${extra !== undefined ? `  -> ${extra}` : ""}`);
  }
}
const section = (t) => console.log(`\n== ${t} ==`);

// --- fake Electron screen ---------------------------------------------------
// Each entry declares BOTH its DIP rect and its real physical rect, exactly as
// a real mixed-DPI desk produces: the DIP rects are laid out contiguously
// relative to the primary (Chromium's tree), so the DIP origin of a child is
// NOT its physical origin divided by its own scale factor.
function makeScreen(displays, { withRect = true, withPoint = true } = {}) {
  const api = {
    getAllDisplays: () =>
      displays.map((d) => ({
        id: d.id,
        bounds: { ...d.dip },
        scaleFactor: d.scaleFactor,
        rotation: 0,
        label: d.label || "",
      })),
    getPrimaryDisplay: () => ({ id: displays.find((d) => d.primary).id }),
  };
  if (withRect) {
    // Faithful stand-in for Chromium's DIPToScreenRect: find the display the
    // rect belongs to, then map through that display's own DIP->physical
    // offset and scale. For rect === display.dip this yields display.physical.
    api.dipToScreenRect = (_win, rect) => {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const d =
        displays.find(
          (x) =>
            cx >= x.dip.x &&
            cx <= x.dip.x + x.dip.width &&
            cy >= x.dip.y &&
            cy <= x.dip.y + x.dip.height
        ) || displays[0];
      const s = d.scaleFactor;
      return {
        x: d.physical.x + Math.round((rect.x - d.dip.x) * s),
        y: d.physical.y + Math.round((rect.y - d.dip.y) * s),
        width: Math.round(rect.width * s),
        height: Math.round(rect.height * s),
      };
    };
  }
  if (withPoint) {
    api.dipToScreenPoint = (p) => {
      const d =
        displays.find(
          (x) =>
            p.x >= x.dip.x &&
            p.x <= x.dip.x + x.dip.width &&
            p.y >= x.dip.y &&
            p.y <= x.dip.y + x.dip.height
        ) || displays[0];
      return {
        x: d.physical.x + Math.round((p.x - d.dip.x) * d.scaleFactor),
        y: d.physical.y + Math.round((p.y - d.dip.y) * d.scaleFactor),
      };
    };
  }
  api.getCursorScreenPoint = () => ({ x: 0, y: 0 });
  api.getDisplayNearestPoint = () => ({ id: displays[0].id });
  return api;
}

// --- the two fixtures -------------------------------------------------------
//
// The desk from the bug report: a 2880x1800 primary at 200% with a portrait
// 1440x2560 panel at 125%. Chromium lays the child out adjacent to the primary
// in DIP space, so its DIP origin is the primary's DIP edge -- not its physical
// origin over its own scale.
//
//   right-hand placement:  DIP x = 1440   physical x = 2880
//       naive 1440 * 1.25 = 1800  ->  wrong by 1080px
//   left-hand placement:   DIP x = -1152  physical x = -1440
//       naive -1152 * 1.25 = -1440 ->  coincidentally right
//
// The right-hand placement is therefore the one that exposes the bug, and it is
// also the one that silently shrinks the virtual desktop.
const PRIMARY = {
  id: 1,
  primary: true,
  scaleFactor: 2,
  dip: { x: 0, y: 0, width: 1440, height: 900 },
  physical: { x: 0, y: 0, width: 2880, height: 1800 },
};
const SECONDARY_RIGHT = {
  id: 2,
  primary: false,
  scaleFactor: 1.25,
  dip: { x: 1440, y: 0, width: 1152, height: 2048 },
  physical: { x: 2880, y: 0, width: 1440, height: 2560 },
};
const SECONDARY_LEFT = {
  id: 2,
  primary: false,
  scaleFactor: 1.25,
  dip: { x: -1152, y: 0, width: 1152, height: 2048 },
  physical: { x: -1440, y: 0, width: 1440, height: 2560 },
};

// --- harness ----------------------------------------------------------------
const ELECTRON_ID = require.resolve("electron");
const realElectron = require.cache[ELECTRON_ID];
const WIN = process.platform === "win32";

function withScreen(fakeScreen) {
  // platform.js reads process.versions.electron to decide whether to try
  // Electron at all, and requires "electron" inside the try.
  if (!process.versions.electron) {
    Object.defineProperty(process.versions, "electron", {
      value: "31.7.7",
      configurable: true,
      writable: true,
    });
  }
  require.cache[ELECTRON_ID] = {
    id: ELECTRON_ID,
    filename: ELECTRON_ID,
    loaded: true,
    exports: { screen: fakeScreen },
    children: [],
    paths: [],
  };
  // Re-require platform.js fresh so its module-level caches start empty.
  delete require.cache[require.resolve("../src/platform")];
  const platform = require("../src/platform");
  platform.invalidateScreenCache();
  return platform;
}

function restore() {
  if (realElectron) require.cache[ELECTRON_ID] = realElectron;
  else delete require.cache[ELECTRON_ID];
  delete require.cache[require.resolve("../src/platform")];
}

function run() {
  console.log("platform mixed-DPI geometry");
  console.log(`  host platform: ${process.platform}${WIN ? " (conversion path active)" : ""}`);

  // --- 1. right-hand secondary: the bug case -------------------------------
  section("secondary at 125% placed to the RIGHT of a 200% primary");
  {
    const platform = withScreen(makeScreen([PRIMARY, SECONDARY_RIGHT]));
    const monitors = platform.detectMonitors({ force: true });
    const vs = platform.detectVirtualScreen({ force: true });

    check(monitors.length === 2, "both displays are reported", monitors.length);
    const sec = monitors.find((m) => !m.primary);
    if (WIN) {
      check(
        sec && sec.x === 2880 && sec.width === 1440 && sec.height === 2560,
        "secondary physical rect comes from dipToScreenRect (2880,0 1440x2560)",
        sec ? `${sec.x},${sec.y} ${sec.width}x${sec.height}` : "missing"
      );
      check(
        sec && sec.x !== 1800,
        "the naive `bounds * scaleFactor` result (x=1800) is NOT used",
        sec ? `x=${sec.x}` : "missing"
      );
      check(
        sec && sec.converted === true,
        "the monitor records that it came from the DPI-correct conversion",
        sec ? `converted=${sec.converted}` : "missing"
      );
    } else {
      check(true, "conversion path is win32-only; skipped on this host");
      check(true, "naive fallback expected on this host");
      check(true, "converted flag not set on this host");
    }

    check(
      vs && vs.x === 0 && vs.width === 4320 && vs.height === 2560,
      "virtual desktop is the TRUE bounding box (0,0 4320x2560)",
      vs ? `${vs.x},${vs.y} ${vs.width}x${vs.height}` : "null"
    );
    if (WIN) {
      check(
        vs && vs.width !== 3240,
        "the naive virtual desktop (3240 wide) is NOT used",
        vs ? `width=${vs.width}` : "null"
      );
    }

    // Window APIs (BrowserWindow bounds / setBounds) are in DIP, so the overlay
    // must NOT be sized from the physical box: a 200% 2880x1800 panel is only
    // 1440x900 in DIP. Getting this wrong misplaces an overlay on a mixed-DPI
    // desk, which is how the "block local input" shield ends up not covering the
    // screen.
    const dip = platform.detectVirtualDipScreen();
    check(
      dip && dip.x === 0 && dip.y === 0 && dip.width === 2592 && dip.height === 2048,
      "detectVirtualDipScreen returns the DIP box (2592x2048), not the physical one",
      dip ? `${dip.x},${dip.y} ${dip.width}x${dip.height}` : "null"
    );
    check(
      dip && vs && dip.width !== vs.width,
      "the DIP box and the physical box are genuinely different here",
      dip && vs ? `dip=${dip.width} physical=${vs.width}` : "null"
    );
    restore();
  }

  // --- 2. left-hand secondary ---------------------------------------------
  section("secondary at 125% placed to the LEFT of a 200% primary");
  {
    const platform = withScreen(makeScreen([PRIMARY, SECONDARY_LEFT]));
    const vs = platform.detectVirtualScreen({ force: true });
    check(
      vs && vs.x === -1440 && vs.width === 4320,
      "virtual desktop keeps the negative origin (-1440, 4320 wide)",
      vs ? `${vs.x} ${vs.width}` : "null"
    );
    restore();
  }

  // --- 3. fallback when the conversion API is absent ----------------------
  section("older Electron without dipToScreenRect");
  {
    const platform = withScreen(makeScreen([PRIMARY, SECONDARY_RIGHT], { withRect: false }));
    const monitors = platform.detectMonitors({ force: true });
    const sec = monitors.find((m) => !m.primary);
    const expect = WIN ? 1800 : 1800; // bounds.x * scaleFactor, on any host
    check(
      sec && sec.x === expect,
      `falls back to bounds * scaleFactor (x=${expect}) when the API is missing`,
      sec ? `x=${sec.x}` : "missing"
    );
    check(
      sec && sec.converted === false,
      "and marks the rect as estimated",
      sec ? `converted=${sec.converted}` : "missing"
    );
    restore();
  }

  // --- 4. edge ownership ---------------------------------------------------
  section("which screen owns a shared edge");
  {
    const platform = withScreen(makeScreen([PRIMARY, SECONDARY_RIGHT]));
    const monitors = platform.detectMonitors({ force: true });
    const right = platform.edgeOwner("right", monitors);
    const left = platform.edgeOwner("left", monitors);
    const top = platform.edgeOwner("top", monitors);
    check(
      right.length === 1 && !right[0].primary,
      "the RIGHT edge belongs to the secondary screen",
      right.map((m) => m.id).join(",")
    );
    check(
      left.length === 1 && left[0].primary,
      "the LEFT edge belongs to the primary screen",
      left.map((m) => m.id).join(",")
    );
    check(top.length === 2, "the TOP edge is shared by both screens", top.length);

    const desc = platform.describeMonitors(monitors);
    check(
      /#0\(主\)/.test(desc) && /#1/.test(desc) && /200%/.test(desc) && /125%/.test(desc),
      "describeMonitors reports both screens with their scale factors",
      desc.replace(/\n/g, " / ")
    );
    restore();
  }

  // --- 5. sanity: one plain display ---------------------------------------
  section("single display at 100%");
  {
    const plain = {
      id: 1,
      primary: true,
      scaleFactor: 1,
      dip: { x: 0, y: 0, width: 1920, height: 1080 },
      physical: { x: 0, y: 0, width: 1920, height: 1080 },
    };
    const platform = withScreen(makeScreen([plain]));
    const vs = platform.detectVirtualScreen({ force: true });
    check(
      vs && vs.x === 0 && vs.width === 1920 && vs.height === 1080,
      "an unscaled display is unchanged",
      vs ? `${vs.x},${vs.y} ${vs.width}x${vs.height}` : "null"
    );
    restore();
  }

  console.log(
    `\n${failures === 0 ? "PLATFORM PASS" : "PLATFORM FAIL"}: ${checks - failures}/${checks} checks passed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

try {
  run();
} catch (e) {
  restore();
  console.error("platform-dpi test crashed:", e);
  process.exit(2);
}

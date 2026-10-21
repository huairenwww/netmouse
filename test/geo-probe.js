// Dev probe: print the geometry Electron reports (the authoritative source for
// edge detection), plus both DIP->physical conversions side by side.
//
// The second line of each block is the interesting one: `dipToScreenRect` is
// Chromium's own DPI-correct inverse, while `bounds * scaleFactor` is the naive
// product that is wrong for a secondary display at a different scale factor.
//
// Run:  <electron> test/geo-probe.js
// For the full report (including a live edge watch) use:  npm run diag
const { app, screen } = require("electron");

app.whenReady().then(() => {
  const primaryId = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays().map((d) => {
    let physical = null;
    if (typeof screen.dipToScreenRect === "function") {
      try {
        physical = screen.dipToScreenRect(null, d.bounds);
      } catch (e) {
        physical = { error: e.message };
      }
    }
    return {
      id: d.id,
      primary: d.id === primaryId,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      dipToScreenRect: physical,
      naiveBoundsTimesScale: {
        x: Math.round(d.bounds.x * d.scaleFactor),
        y: Math.round(d.bounds.y * d.scaleFactor),
        width: Math.round(d.bounds.width * d.scaleFactor),
        height: Math.round(d.bounds.height * d.scaleFactor),
      },
    };
  });
  const { getScreenInfo, diagSnapshot } = require("../src/platform");
  console.log(
    JSON.stringify(
      {
        displays,
        info: getScreenInfo({ force: true }),
        snapshot: diagSnapshot(),
      },
      null,
      2
    )
  );
  app.quit();
});

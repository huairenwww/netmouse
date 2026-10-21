"use strict";
// Static sanity check for the settings UI: every id the renderer reaches for
// must exist in the markup, and the platform-split additions must be wired.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/ui/index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "src/ui/renderer.js"), "utf8");
const css = fs.readFileSync(path.join(root, "src/ui/style.css"), "utf8");

let fails = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  -> ${extra}` : ""}`);
  if (!cond) fails += 1;
};

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
const missing = [...used].filter((i) => !ids.has(i));
check(missing.length === 0, "every id the renderer uses exists in the markup", missing.join(", "));
check(ids.size > 0, "markup declares ids", String(ids.size));

// The platform split must be present end to end.
for (const id of ["osPill", "osTag", "platList", "platHint", "osLinuxList", "osWinList", "onlyLocal", "diffTable", "scrollUnit", "scrollUnitHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(js.includes("PLATFORM_DIFF"), "renderer defines the platform comparison table");
check(js.includes("renderPlatform"), "renderer has renderPlatform()");
check(js.includes("applyPlatformFilter"), "renderer has applyPlatformFilter()");
check(js.includes("renderScrollUnitHint"), "renderer has renderScrollUnitHint()");
check(/scrollUnit:\s*num\("scrollUnit"/.test(js), "collect() sends input.scrollUnit");
check(/\$\("scrollUnit"\)\.value\s*=/.test(js), "fillForm() restores input.scrollUnit");

// The injection backend is the Wayland escape hatch: without it a Wayland
// client silently injects into nothing. It must be selectable AND saved.
for (const id of ["inputBackend", "inputBackendHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(/renderInputBackendHint/.test(js), "renderer has renderInputBackendHint()");
check(/backend:\s*\$\("inputBackend"\)\.value/.test(js), "collect() sends input.backend");
check(/\$\("inputBackend"\)\.value\s*=/.test(js), "fillForm() restores input.backend");
check(
  /<select id="inputBackend">[\s\S]*?value="auto"[\s\S]*?value="xtest"[\s\S]*?value="uinput"/.test(html),
  "the backend selector offers auto / xtest / uinput"
);
check(
  /inputBackend"\)\.addEventListener/.test(js),
  "the backend selector re-renders its hint on change"
);

// ydotool cannot work without the ydotoold daemon, so the choice of whether
// NetMouse may start one for you has to be visible and persisted -- a setting
// that only exists in config.json is a setting nobody finds.
for (const id of ["manageYdotoold", "manageYdotooldHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(/renderManageYdotooldHint/.test(js), "renderer has renderManageYdotooldHint()");
check(
  /manageYdotoold:\s*\$\("manageYdotoold"\)\.checked/.test(js),
  "collect() sends input.manageYdotoold"
);
check(
  /\$\("manageYdotoold"\)\.checked\s*=/.test(js),
  "fillForm() restores input.manageYdotoold"
);
check(
  /<input type="checkbox" id="manageYdotoold"/.test(html),
  "the daemon option is a checkbox"
);
check(
  /manageYdotoold"\)\.addEventListener/.test(js),
  "the daemon checkbox re-renders its hint on change"
);

// The client-side injection self-test must be reachable from the UI, and the
// renderer must actually call the bridge for it. "The other machine doesn't
// move" is a client-side question, so the client card is where it belongs.
for (const id of ["injecttestBtn", "injecttestHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(/api\.runInjectTest\s*\(/.test(js), "renderer calls api.runInjectTest()");
check(/injecttestBtn"\)\.addEventListener/.test(js), "the inject-test button is wired up");
check(
  /injecttestBtn[\s\S]{0,600}?disabled = true/.test(js),
  "the inject-test button disables itself while running"
);
check(
  fs.readFileSync(path.join(root, "src/preload.js"), "utf8").includes("app:runInjectTest"),
  "preload exposes app:runInjectTest"
);
check(
  fs.readFileSync(path.join(root, "src/main.js"), "utf8").includes('ipcMain.handle("app:runInjectTest"'),
  "main registers the app:runInjectTest handler"
);

// The one-click diagnostic bundle. It spans both roles (either end can be the
// broken one), so it lives next to the other self-tests and must be reachable
// without the tray menu -- the tray is easy to miss and the button is the
// thing a user is told to press.
for (const id of ["bundleBtn", "bundleLive", "bundleHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(/api\.makeDiagBundle\s*\(/.test(js), "renderer calls api.makeDiagBundle()");
check(/bundleBtn"\)\.addEventListener/.test(js), "the bundle button is wired up");
check(
  /makeDiagBundle\(\{\s*includeLive:/.test(js),
  "the bundle button passes the includeLive choice through"
);
check(
  /bundleBtn[\s\S]{0,400}?disabled = true/.test(js),
  "the bundle button disables itself while running"
);
check(
  fs.readFileSync(path.join(root, "src/preload.js"), "utf8").includes("app:makeDiagBundle"),
  "preload exposes app:makeDiagBundle"
);
check(
  fs.readFileSync(path.join(root, "src/main.js"), "utf8").includes('ipcMain.handle("app:makeDiagBundle"'),
  "main registers the app:makeDiagBundle handler"
);
check(css.includes(".check--inline"), "stylesheet defines .check--inline for the in-row checkbox");

// Image clipboard. Three separate things can each stop images from working and
// all three look the same from outside, so the sub-controls have to be visible,
// persisted, and explained.
for (const id of ["clipboardImages", "clipboardMaxImageMB", "clipboardHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(/renderClipboardHint/.test(js), "renderer has renderClipboardHint()");
check(
  /images:\s*\$\("clipboardImages"\)\.checked/.test(js),
  "collect() sends clipboard.images"
);
check(
  /maxImageBytes:[\s\S]{0,200}?numFloat\("clipboardMaxImageMB"/.test(js),
  "collect() converts the MB box to clipboard.maxImageBytes"
);
check(
  /numFloat/.test(js),
  "the MB box is parsed as a float (parseInt would truncate 0.5 MB to 0)"
);
check(
  /\$\("clipboardImages"\)\.checked\s*=/.test(js),
  "fillForm() restores clipboard.images"
);
check(
  /\$\("clipboardEnabled"\)\.addEventListener\("change", renderClipboardHint\)/.test(js) &&
    /\$\("clipboardImages"\)\.addEventListener\("change", renderClipboardHint\)/.test(js),
  "the clipboard checkboxes re-render their hint on change"
);
check(css.includes(".field--indent"), "stylesheet defines .field--indent");
check(css.includes(".unit"), "stylesheet defines .unit");

// The capture backend. Under Wayland this decides whether the mouse can cross
// at all, so it has to be visible next to the injection backend it mirrors.
for (const id of ["inputCapture", "inputCaptureHint"]) {
  check(ids.has(id), `new UI element #${id} exists`);
}
check(/renderInputCaptureHint/.test(js), "renderer has renderInputCaptureHint()");
check(/capture:\s*\$\("inputCapture"\)\.value/.test(js), "collect() sends input.capture");
check(/\$\("inputCapture"\)\.value\s*=/.test(js), "fillForm() restores input.capture");
check(
  /<select id="inputCapture">[\s\S]*?value="auto"[\s\S]*?value="uiohook"[\s\S]*?value="evdev"/.test(html),
  "the capture selector offers auto / uiohook / evdev"
);
check(
  /\$\("inputCapture"\)\.addEventListener\("change", renderInputCaptureHint\)/.test(js),
  "the capture selector re-renders its hint on change"
);

// CSS classes the renderer applies must be defined.
for (const cls of ["pill--os", "scope", "scope--server", "scope--client", "scope--both", "osblock", "oslist", "subhead", "difftable", "diffrow", "diffcell--local", "diffnote"]) {
  check(css.includes("." + cls), `stylesheet defines .${cls}`);
}

// The comparison table must actually name both platforms.
check(/Windows 11/.test(js) && /Ubuntu|Linux/.test(js), "comparison table names both platforms");

console.log("");
if (fails) {
  console.log(`UI CHECK FAIL: ${fails} problem(s)`);
  process.exit(1);
}
console.log("UI CHECK PASS: markup, renderer and stylesheet agree");

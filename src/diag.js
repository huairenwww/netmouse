// ---------------------------------------------------------------------------
// NetMouse diagnostics.
//
// This exists because of one specific class of bug that is invisible from the
// outside: "I move the mouse toward the other machine and nothing happens".
// There are three completely different causes, and only measurement can tell
// them apart:
//
//   1. the configured shared edge is not the side the peer is on;
//   2. the shared edge belongs to a *secondary* monitor, so the cursor has to
//      cross a whole extra screen before it gets there;
//   3. the geometry we compute does not match the coordinate space the OS
//      input hook reports in -- the classic per-monitor-DPI trap, where a
//      display at 125% next to one at 200% makes a naive
//      `bounds * scaleFactor` produce a virtual desktop that is wider than
//      anything the cursor can reach.
//
// So the report prints the raw displays, BOTH conversions side by side, the
// cursor position in DIP and physical space, and (with --live) a running
// distance from the cursor to each boundary of the virtual desktop. Move the
// mouse into every corner and the numbers say exactly which case you are in.
//
// Run it with:
//   npm run diag            (electron, full report)
//   npm run diag -- --live  (adds a 15s live edge watch)
// or from the tray menu: "运行诊断…"
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");

const pkg = (() => {
  try {
    return require("../package.json");
  } catch {
    return { version: "?" };
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- environment ------------------------------------------------------------

function electronScreen() {
  if (!process.versions.electron) return null;
  try {
    const { screen } = require("electron");
    return screen && typeof screen.getAllDisplays === "function" ? screen : null;
  } catch {
    return null;
  }
}

// --- report sections --------------------------------------------------------

function header() {
  const { platformInfo } = require("./platform");
  const info = platformInfo();
  const lines = [
    "NetMouse 诊断报告",
    `生成时间 : ${new Date().toLocaleString()}`,
    `版本     : ${pkg.version}`,
    `平台     : ${info.label} ${info.arch}  (${info.platform})`,
    `运行环境 : ${process.versions.electron ? `Electron ${process.versions.electron}` : "纯 Node"} / Node ${process.versions.node}`,
    `会话     : ${info.sessionType || "-"}${info.display ? `  DISPLAY=${info.display}` : ""}`,
  ];
  for (const w of info.warnings || []) lines.push(`提示     : ${w}`);
  return lines.join("\n");
}

// The raw display list straight from Electron: `bounds` is in DIP points and
// `scaleFactor` is that display's own scaling. This is the ground truth the
// rest of the app has to convert from.
function displaySection() {
  const { rawDisplays } = require("./platform");
  const raw = rawDisplays();
  if (!raw) {
    return [
      "显示器（原始）",
      "  不可用 —— 没有 Electron screen 模块（纯 Node / 无 GUI 会话）。",
    ].join("\n");
  }
  const lines = ["显示器（原始，bounds 单位 = DIP）"];
  for (const d of raw) {
    lines.push(
      `  id=${d.id}${d.primary ? " [主]" : ""}  bounds=${d.bounds.width}x${d.bounds.height}@(${d.bounds.x},${d.bounds.y})` +
        `  scale=${d.scaleFactor} (${Math.round(d.scaleFactor * 100)}%)  rotation=${d.rotation}` +
        (d.label ? `  label=${d.label}` : "")
    );
  }
  return lines.join("\n");
}

// The important one: convert each display's DIP rect to physical pixels with
// BOTH methods and show the difference. A non-zero delta on the second line is
// the mixed-DPI bug, and it is what makes an edge unreachable.
function conversionSection() {
  const { rawDisplays } = require("./platform");
  const raw = rawDisplays();
  const screen = electronScreen();
  if (!raw || !screen) {
    return ["DIP → 物理像素换算", "  不可用（需要 Electron screen 模块）。"].join("\n");
  }
  const canRect = typeof screen.dipToScreenRect === "function";
  const canPoint = typeof screen.dipToScreenPoint === "function";
  const lines = [
    "DIP → 物理像素换算",
    "  uiohook 的鼠标钩子在 Windows 上报的是物理像素，Electron 的 bounds 是 DIP，",
    "  所以这张表就是边缘判定的依据。第 1 行是本程序实际使用的换算。",
  ];
  for (const d of raw) {
    let byRect = null;
    if (canRect) {
      try {
        byRect = screen.dipToScreenRect(null, d.bounds);
      } catch (e) {
        byRect = { error: e.message };
      }
    }
    let byPoint = null;
    if (canPoint) {
      try {
        const tl = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
        const br = screen.dipToScreenPoint({
          x: d.bounds.x + d.bounds.width - 1,
          y: d.bounds.y + d.bounds.height - 1,
        });
        byPoint = {
          x: tl.x,
          y: tl.y,
          width: br.x - tl.x + 1,
          height: br.y - tl.y + 1,
        };
      } catch (e) {
        byPoint = { error: e.message };
      }
    }
    const naive = {
      x: Math.round(d.bounds.x * d.scaleFactor),
      y: Math.round(d.bounds.y * d.scaleFactor),
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor),
    };
    const fmt = (r) =>
      r && !r.error
        ? `${r.width}x${r.height}@(${r.x},${r.y})`
        : `失败(${r ? r.error : "n/a"})`;
    lines.push(`  id=${d.id}${d.primary ? " [主]" : ""}`);
    lines.push(`    1. dipToScreenRect(null, bounds) = ${fmt(byRect)}   <-- 本程序使用`);
    lines.push(`    2. dipToScreenPoint(两角)        = ${fmt(byPoint)}`);
    lines.push(`    3. bounds * scaleFactor          = ${fmt(naive)}`);
    if (byRect && !byRect.error) {
      const dx = naive.x - byRect.x;
      const dw = naive.width - byRect.width;
      if (dx !== 0 || dw !== 0) {
        lines.push(
          `    ! 第 3 行与第 1 行不一致（原点差 ${dx}px，宽度差 ${dw}px）：` +
            "这就是混合缩放（比如 200% 主屏 + 125% 副屏）下用乘法的老算法，会让边缘判定落到光标到不了的位置。"
        );
      } else {
        lines.push("    = 第 3 行与第 1 行一致（这块屏的缩放不会造成偏差）。");
      }
    }
  }
  return lines.join("\n");
}

// What the app actually decides from the above.
function geometrySection() {
  const { diagSnapshot, monitorSig } = require("./platform");
  const snap = diagSnapshot();
  const lines = ["本程序解析出的几何"];
  if (!snap.virtual || !snap.monitors.length) {
    lines.push("  未检测到 —— 会退回 config 里的 layout.screenWidth/Height。");
    return lines.join("\n");
  }
  lines.push(
    `  虚拟桌面 : ${snap.virtual.width}x${snap.virtual.height} @ (${snap.virtual.x},${snap.virtual.y})`
  );
  lines.push(`  签名     : ${snap.signature || snap.monitors.map(monitorSig).join("|")}`);
  lines.push("  显示器   :");
  lines.push(snap.description);
  lines.push("  各边归属 :");
  for (const [dir, idxs] of Object.entries(snap.edgeOwners)) {
    const label = { left: "左", right: "右", top: "上", bottom: "下" }[dir];
    lines.push(
      `    ${label} (${dir}) -> ${idxs.length ? `显示器 #${idxs.join(",")}` : "无"}`
    );
  }
  lines.push(
    "  说明     : layout.monitor = all 时，鼠标必须到达上表里那块显示器的最外缘才会触发。"
  );
  return lines.join("\n");
}

// Cursor position, read three ways. If the hook's numbers and the physical
// numbers disagree, the coordinate spaces do not line up.
async function cursorSection() {
  const screen = electronScreen();
  const lines = ["光标位置"];
  if (!screen) {
    lines.push("  Electron screen 不可用，跳过。");
    return lines.join("\n");
  }
  try {
    const dip = screen.getCursorScreenPoint();
    lines.push(`  DIP      (getCursorScreenPoint) : (${dip.x},${dip.y})`);
    if (typeof screen.dipToScreenPoint === "function") {
      const phys = screen.dipToScreenPoint(dip);
      lines.push(`  物理     (dipToScreenPoint)     : (${phys.x},${phys.y})`);
    }
    const nearest = screen.getDisplayNearestPoint(dip);
    lines.push(
      `  所在显示器 : id=${nearest.id}${nearest.id === screen.getPrimaryDisplay().id ? " [主]" : ""}`
    );
  } catch (e) {
    lines.push(`  读取失败: ${e.message}`);
  }
  try {
    const { mouse } = require("@nut-tree-fork/nut-js");
    const p = await mouse.getPosition();
    lines.push(`  nut-js   (注入坐标空间)         : (${p.x},${p.y})`);
  } catch (e) {
    lines.push(`  nut-js 读取失败: ${e.message}`);
  }
  return lines.join("\n");
}

// The live part: watch the real OS hook and print, every second, how far the
// cursor is from each boundary of the virtual desktop. Move the mouse into
// every corner while this runs.
async function liveSection(ms, log) {
  const { detectVirtualScreen } = require("./platform");
  const vs = detectVirtualScreen({ force: true });
  if (!vs) return "实时边缘观测\n  无法确定虚拟桌面尺寸，跳过。";

  const { uIOhook } = require("uiohook-napi");
  const { ensureHook, stopHook, isHookStarted } = require("./server-input");

  const wasRunning = isHookStarted();
  let env = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let last = null;
  const onMove = (e) => {
    last = { x: e.x, y: e.y };
    if (e.x < env.minX) env.minX = e.x;
    if (e.y < env.minY) env.minY = e.y;
    if (e.x > env.maxX) env.maxX = e.x;
    if (e.y > env.maxY) env.maxY = e.y;
  };

  try {
    if (!wasRunning) ensureHook();
    uIOhook.on("mousemove", onMove);
  } catch (e) {
    return `实时边缘观测\n  无法启动全局钩子: ${e.message}`;
  }

  const lines = [
    `实时边缘观测（${Math.round(ms / 1000)} 秒）`,
    `  虚拟桌面边界: x ${vs.x} … ${vs.x + vs.width}   y ${vs.y} … ${vs.y + vs.height}`,
    "  请把鼠标分别推到四个角落，让下面的数字走到 0。",
    "",
  ];

  const end = Date.now() + ms;
  let tick = 0;
  while (Date.now() < end) {
    await sleep(1000);
    tick++;
    if (!last) {
      lines.push(`  [${tick}s] 还没收到任何鼠标事件 —— 钩子没工作？`);
      continue;
    }
    const d = {
      left: last.x - vs.x,
      right: vs.x + vs.width - last.x,
      top: last.y - vs.y,
      bottom: vs.y + vs.height - last.y,
    };
    lines.push(
      `  [${tick}s] 钩子坐标 (${last.x},${last.y})  ` +
        `离左${d.left} 右${d.right} 上${d.top} 下${d.bottom}` +
        `   最近=${Math.min(d.left, d.right, d.top, d.bottom)}px`
    );
  }

  try {
    uIOhook.off("mousemove", onMove);
  } catch {
    /* ignore */
  }
  if (!wasRunning) stopHook();

  if (Number.isFinite(env.minX)) {
    lines.push("");
    lines.push("  本次观测到的可达范围（钩子坐标）:");
    lines.push(
      `    x ${env.minX} … ${env.maxX}   (宽 ${env.maxX - env.minX})   ` +
        `y ${env.minY} … ${env.maxY}   (高 ${env.maxY - env.minY})`
    );
    // Only an OVER-reach is conclusive: the cursor got somewhere the geometry
    // says does not exist, so the geometry is too small and the shared edge sits
    // inside the screen. An under-reach just means the sweep was incomplete.
    const over =
      env.minX < vs.x - 2 ||
      env.minY < vs.y - 2 ||
      env.maxX > vs.x + vs.width + 2 ||
      env.maxY > vs.y + vs.height + 2;
    const covered =
      (env.maxX - env.minX) >= vs.width * 0.9 &&
      (env.maxY - env.minY) >= vs.height * 0.9;
    if (over) {
      lines.push(
        "    ! 光标跑到了几何范围之外：说明解析出的虚拟桌面偏小，共享边会落在屏幕内部。" +
          "请把这份报告发出来。"
      );
    } else if (covered) {
      lines.push("    = 与解析出的虚拟桌面一致，几何来源没问题。");
    } else {
      lines.push(
        "    ? 没有覆盖到整个桌面，无法判定。请把鼠标分别推到四个角落再测一次。"
      );
    }
  }
  if (log) log.info(`诊断：实时观测结束（${tick} 个采样）`);
  return lines.join("\n");
}

// --- entry points -----------------------------------------------------------

async function buildReport({ live = false, liveMs = 15000, log = null } = {}) {
  const parts = [
    header(),
    "",
    displaySection(),
    "",
    conversionSection(),
    "",
    geometrySection(),
    "",
    await cursorSection(),
  ];
  if (live) {
    parts.push("", await liveSection(liveMs, log));
  }
  parts.push("", "— 报告结束 —");
  return parts.join("\n");
}

// Where to drop the report. Beside the config is the friendliest place: the
// user already knows how to find that folder from the settings window. Falls
// back to the working directory when the config lives inside app.asar.
function reportPath() {
  let dir = null;
  try {
    const config = require("./config");
    const read = config.resolveConfigPath();
    const write = config.resolveWritePath(read, {});
    const candidate = /[\\/]app\.asar[\\/]/.test(write || "") ? read : write;
    if (candidate && !/[\\/]app\.asar[\\/]/.test(candidate)) dir = path.dirname(candidate);
  } catch {
    /* fall through */
  }
  if (!dir) dir = process.env.NETMOUSE_REPORT_DIR || process.cwd();
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return path.join(dir, `netmouse-diag-${stamp}.txt`);
}

async function writeReport(opts = {}) {
  const text = await buildReport(opts);
  const target = opts.outPath || reportPath();
  fs.writeFileSync(target, text + "\n", "utf8");
  return { path: target, text };
}

module.exports = { buildReport, writeReport, reportPath };

// --- standalone entry: `electron src/diag.js [--live] [--seconds N] [--out P] -
//
// NOTE: `require.main === module` is NOT enough here. In Electron's main process
// require.main points at Electron's own bootstrap module, not at the user
// script, so that check silently evaluates to false and the process just sits
// there with no window and no output. Compare the resolved argv path as well.
function isEntryScript() {
  if (require.main === module) return true;
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return path.resolve(arg) === __filename;
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const si = argv.indexOf("--seconds");
  const liveMs = si >= 0 ? Math.max(3000, Number(argv[si + 1]) * 1000 || 15000) : 15000;
  const oi = argv.indexOf("--out");
  const outPath = oi >= 0 ? argv[oi + 1] : null;

  const run = async () => {
    const { text, path: p } = await writeReport({ live, liveMs, outPath });
    try {
      process.stdout.write(text + "\n");
      process.stdout.write(`\n报告已写入: ${p}\n`);
    } catch {
      /* a GUI-subsystem build may have no usable stdout; the file is the deliverable */
    }
    return p;
  };

  if (process.versions.electron) {
    const electron = require("electron");
    const app = electron.app;
    if (!app || typeof app.whenReady !== "function") {
      // Almost always $ELECTRON_RUN_AS_NODE=1 in the environment.
      process.stderr.write(
        "诊断需要真正的 Electron 运行时，但当前进程是纯 Node 模式。\n" +
          "请先清除环境变量 ELECTRON_RUN_AS_NODE 再运行：\n" +
          "  unset ELECTRON_RUN_AS_NODE && npm run diag\n"
      );
      process.exit(2);
    }
    // No window is ever created; skip the GPU/compositor entirely.
    try {
      app.disableHardwareAcceleration();
    } catch {
      /* not fatal */
    }
    app.whenReady().then(async () => {
      try {
        await run();
      } catch (e) {
        process.stderr.write(`诊断失败: ${e.stack || e.message}\n`);
      }
      app.exit(0);
    });
  } else {
    run().catch((e) => {
      process.stderr.write(`诊断失败: ${e.stack || e.message}\n`);
      process.exit(2);
    });
  }
}

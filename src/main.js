const fs = require("fs");
const path = require("path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  ipcMain,
} = require("electron");

const config = require("./config");
const { createLogger, getHistory, clearHistory, subscribe } = require("./logger");
const { createServer, createClient } = require("./app");
const { platformInfo } = require("./platform");
const { createBlocker } = require("./blocker");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
let trayOk = false;
let node = null;
let cfg = null;
let log = null;
let blocker = null;
let quitting = false;

function getBlocker() {
  if (!blocker) blocker = createBlocker({ log });
  return blocker;
}

function userDataDir() {
  return app.getPath("userData");
}

function loadCfg() {
  return config.loadConfig(
    { role: process.env.NETMOUSE_ROLE || undefined },
    { userDataDir: userDataDir() }
  );
}

// ---------------------------------------------------------------------------
// Portable mode
//
// The portable exe unpacks itself to a temp dir on every launch, so the
// config.json that ships inside it is a throwaway. Materialise a real, editable
// copy beside the .exe the user actually double-clicked, once.
// ---------------------------------------------------------------------------
function ensurePortableConfig() {
  if (process.env.NETMOUSE_CONFIG) return null;
  const dir = config.portableDir();
  if (!dir) return null;

  const target = path.join(dir, "config.json");
  try {
    if (fs.existsSync(target)) return target;
  } catch {
    return null;
  }

  // Seed from the copy bundled in the app so the shipped comments survive.
  const shipped = path.join(path.dirname(process.execPath), "config.json");
  let body;
  try {
    body = fs.readFileSync(shipped, "utf8");
  } catch {
    body = JSON.stringify(config.serialize(config.normalize({})), null, 2) + "\n";
  }

  try {
    // "wx" so two instances racing at boot can't clobber each other.
    fs.writeFileSync(target, body, { flag: "wx" });
    return target;
  } catch {
    return null; // read-only folder -> loadConfig falls back to the user dir
  }
}

function statusSnapshot() {
  const st =
    node?.getStatus() || {
      running: false,
      role: cfg?.role || "server",
      peer: "stopped",
      mode: "local",
      detail: "",
    };
  return { ...st, blocked: !!blocker?.isEngaged() };
}

function pushStatus() {
  if (win && !win.isDestroyed()) win.webContents.send("status", statusSnapshot());
  refreshTray();
}

// ---------------------------------------------------------------------------
// Node lifecycle
// ---------------------------------------------------------------------------
function startNode() {
  if (node) return;
  try {
    const useBlocker = cfg.role === "server" && cfg.input?.blockLocal !== false;
    node =
      cfg.role === "server"
        ? createServer({
            cfg,
            log,
            onStatus: pushStatus,
            blocker: useBlocker ? getBlocker() : null,
            // Panic hotkey: hand control back and lift the input block.
            onPanic: () => {
              try {
                node?.release?.();
              } catch (e) {
                log?.warn("panic release failed:", e.message);
              }
              pushStatus();
            },
          })
        : createClient({ cfg, log, onStatus: pushStatus });
    node.start();
    log.info(`NetMouse started as ${cfg.role}`);
  } catch (err) {
    log.error("failed to start node:", err.message);
    node = null;
  }
  pushStatus();
}

function stopNode() {
  if (node) {
    try {
      node.stop();
    } catch (err) {
      log.warn("stop failed:", err.message);
    }
    node = null;
  }
  // Never leave a full-screen input shield behind a stopped node.
  blocker?.disengage();
  pushStatus();
}

function restartNode() {
  stopNode();
  startNode();
}

// ---------------------------------------------------------------------------
// Shared edge
//
// Which screen edge hands control to the peer. Getting this wrong is the single
// most common reason "I move the mouse toward the other machine and nothing
// happens", and on a multi-monitor desk it is genuinely hard to guess (the
// shared edge often belongs to a secondary screen). So it is switchable live
// from the tray, and persisted so it survives a restart.
// ---------------------------------------------------------------------------
const EDGE_LABEL = {
  left: "左 (left)",
  right: "右 (right)",
  top: "上 (top)",
  bottom: "下 (bottom)",
  any: "任意边都触发 (any)",
};

function currentEdge() {
  try {
    return node?.getEdge?.() ?? cfg?.layout?.edge ?? "right";
  } catch {
    return cfg?.layout?.edge ?? "right";
  }
}

function switchEdge(edge) {
  if (!cfg) return;
  if (cfg.role !== "server") {
    log?.warn("共享边只对服务器端有意义：客户端会自动采用服务器发过来的边");
    return;
  }
  const ok = node?.setEdge?.(edge);
  if (!ok) {
    log?.warn(`切换共享边失败：${edge}（服务可能还没启动）`);
    return;
  }
  try {
    config.saveConfig(cfg, { userDataDir: userDataDir() });
    log?.info(`共享边已保存：${edge}`);
  } catch (err) {
    log?.warn("共享边已生效，但写配置文件失败:", err.message);
  }
  pushStatus();
}

// ---------------------------------------------------------------------------
// Diagnostics
//
// A report the user can read (or send on). Live mode briefly stops the running
// node so the measurement is not polluted by the hand-over logic, then puts it
// back exactly as it was.
// ---------------------------------------------------------------------------
async function runDiag({ live = false, liveMs = 20000 } = {}) {
  const wasRunning = !!node;
  if (wasRunning) {
    log?.info("诊断：先暂停当前服务，避免干扰观测");
    stopNode();
  }
  try {
    const { writeReport } = require("./diag");
    log?.info(live ? `诊断：生成报告并实时观测 ${Math.round(liveMs / 1000)} 秒（请把鼠标推到四个角落）` : "诊断：生成报告…");
    const res = await writeReport({ live, liveMs, log });
    log?.info(`诊断报告已写入：${res.path}`);
    const err = await shell.openPath(res.path);
    if (err) log?.warn("无法自动打开诊断报告:", err);
    return { ok: true, path: res.path };
  } catch (err) {
    log?.error("诊断失败:", err.message);
    return { ok: false, error: err.message };
  } finally {
    if (wasRunning) startNode();
  }
}

// ---------------------------------------------------------------------------
// Hardware edge self-test
//
// Drives the REAL cursor to each shared edge with the REAL global hook running
// and a real TCP peer on 127.0.0.1, so it can tell "this machine's server side
// is broken" apart from "the other machine / the network is broken". That
// distinction is the one a two-machine symptom report cannot make.
//
// The running node is paused first (it would otherwise fight for the hook and
// the cursor) and put back exactly as it was afterwards.
// ---------------------------------------------------------------------------
async function runHwTest({ edges = null } = {}) {
  if (cfg?.role !== "server") {
    log?.warn(
      "本机自检只对服务器端有意义：它检验的是共享边的判定与交接。" +
        "客户端侧请用「本机注入自检」（--injecttest）"
    );
    return { ok: false, error: "not-server" };
  }
  const wasRunning = !!node;
  if (wasRunning) {
    log?.info("自检：先暂停当前服务，避免与自检争用全局钩子");
    stopNode();
  }
  try {
    const { runTest } = require("./hwtest");
    const reportDir = path.dirname(configFileToOpen() || process.cwd());
    const outPath = path.join(reportDir, `netmouse-hwtest-${Date.now()}.txt`);
    log?.info("自检：把鼠标推到每条共享边…（会短暂接管光标，结束后自动还原）");
    const code = await runTest({
      outPath,
      edges,
      // The GUI owns the process-wide hook: stopping it here would leave the
      // restarted node without capture.
      stopHookAfter: false,
      onLine: (line) => {
        if (line.trim()) log?.info(line);
      },
    });
    log?.info(`自检报告已写入：${outPath}`);
    const err = await shell.openPath(outPath);
    if (err) log?.warn("无法自动打开自检报告:", err);
    return { ok: code === 0, path: outPath };
  } catch (err) {
    log?.error("自检失败:", err.message);
    return { ok: false, error: err.message };
  } finally {
    if (wasRunning) startNode();
  }
}

// ---------------------------------------------------------------------------
// Client-side injection self-test
//
// The mirror image of runHwTest. That one answers "is this box a working
// SERVER?"; this one answers "is this box a working CLIENT?" -- can it actually
// drive its own cursor, buttons and wheel? It matters because the two roles fail
// completely differently, and "the mouse doesn't move on the other machine" is
// a client-side question that hwtest refuses to answer.
//
// The running node is paused first (it would otherwise be injecting at the same
// time) and put back exactly as it was afterwards.
// ---------------------------------------------------------------------------
async function runInjectTest({ outPath = null } = {}) {
  const wasRunning = !!node;
  if (wasRunning) {
    log?.info("注入自检：先暂停当前服务，避免与自检同时操作光标");
    stopNode();
  }
  try {
    const { runInjectTest: run } = require("./injecttest");
    const dir = path.dirname(configFileToOpen() || process.cwd());
    const target = outPath || path.join(dir, `netmouse-injecttest-${Date.now()}.txt`);
    log?.info("注入自检：会短暂接管光标（请先把手离开鼠标）…");
    const code = await run({
      cfg,
      outPath: target,
      stopHookAfter: false, // the GUI owns the process-wide hook
      onLine: (line) => {
        if (line.trim()) log?.info(line);
      },
    });
    log?.info(`注入自检报告已写入：${target}`);
    const err = await shell.openPath(target);
    if (err) log?.warn("无法自动打开注入自检报告:", err);
    return { ok: code === 0, path: target, code };
  } catch (err) {
    log?.error("注入自检失败:", err.message);
    return { ok: false, error: err.message };
  } finally {
    if (wasRunning) startNode();
  }
}

// ---------------------------------------------------------------------------
// One-click diagnostic bundle
//
// Everything needed to debug "it doesn't work" in one file: the config
// (password redacted), the platform facts, the log ring buffer, and the three
// self-test reports. The node is paused while it runs so the self-tests are not
// fighting a live session for the cursor, then put back as it was.
// ---------------------------------------------------------------------------
async function runDiagBundle({ includeLive = true } = {}) {
  const wasRunning = !!node;
  if (wasRunning) {
    log?.info("诊断包：先暂停当前服务，避免与自检争用光标");
    stopNode();
  }
  try {
    const { writeDiagBundle } = require("./diagbundle");
    const dir = path.dirname(configFileToOpen() || process.cwd());
    log?.info(
      includeLive
        ? "诊断包：会短暂接管光标跑两个自检（约 15 秒，请先把手离开鼠标）…"
        : "诊断包：正在收集配置、日志与体检结果…"
    );
    const res = await writeDiagBundle({ cfg, log, dir, includeLive });
    log?.info(`诊断包已生成：${res.path}`);
    // Reveal it in the file manager rather than opening the archive: a .zip is
    // meant to be attached to a chat or an email, and that is the next step.
    shell.showItemInFolder(res.path);
    return res;
  } catch (err) {
    log?.error("生成诊断包失败:", err.message);
    return { ok: false, error: err.message };
  } finally {
    if (wasRunning) startNode();
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function appIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function windowIconPath() {
  return path.join(__dirname, "assets", "icon.png");
}

function buildTray() {
  // Linux desktops without an appindicator host have no tray; the settings
  // window is the primary UI, so this is allowed to fail.
  try {
    tray = new Tray(appIcon());
    trayOk = true;
  } catch (err) {
    trayOk = false;
    log?.warn("system tray unavailable, using the window only:", err.message);
    return;
  }

  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  refreshTray();
}

function refreshTray() {
  if (!tray || !trayOk) return;
  const st = statusSnapshot();
  const roleLabel = cfg ? (cfg.role === "server" ? "服务器" : "客户端") : "-";
  const running = st.running;

  tray.setToolTip(
    `NetMouse — ${roleLabel} · ${running ? "运行中" : "已停止"}${
      st.mode === "remote" ? " · 远程控制中" : ""
    }${st.blocked ? " · 本机已拦截" : ""}`
  );

  const items = [
    { label: `角色：${roleLabel}`, enabled: false },
    { label: running ? "状态：运行中" : "状态：已停止", enabled: false },
    {
      label:
        st.mode === "remote"
          ? `控制：远程中${st.blocked ? "（本机已拦截）" : ""}`
          : "控制：本地",
      enabled: false,
    },
    { type: "separator" },
    { label: "打开设置…", click: showWindow },
    st.mode === "remote"
      ? { label: "交还本地控制", click: () => node?.release?.() }
      : null,
    running
      ? { label: "停止", click: () => { stopNode(); } }
      : { label: "启动", click: () => { startNode(); } },
    { label: "重启", click: () => restartNode() },
    cfg?.role === "server"
      ? {
          label: `共享边：${EDGE_LABEL[currentEdge()] || currentEdge()}`,
          submenu: ["left", "right", "top", "bottom", "any"].map((e) => ({
            label: EDGE_LABEL[e],
            type: "radio",
            checked: e === currentEdge(),
            click: () => switchEdge(e),
          })),
        }
      : null,
    {
      label: cfg?.role === "server" ? "运行诊断（含 20 秒边缘观测）…" : "运行诊断…",
      click: () => runDiag({ live: cfg?.role === "server" }),
    },
    cfg?.role === "server"
      ? {
          label: "本机边缘自检（真光标走一遍四条边）…",
          click: () => runHwTest(),
        }
      : null,
    {
      label: "本机注入自检（本机能否驱动光标/按键/滚轮）…",
      click: () => runInjectTest(),
    },
    {
      label: "生成诊断包（配置+日志+自检，一个 zip）…",
      click: () => runDiagBundle({ includeLive: true }),
    },
    { type: "separator" },
    { label: "打开配置文件", click: () => openConfigFile() },
    { label: "打开配置文件夹", click: () => openConfigFolder() },
    { type: "separator" },
    {
      label: "退出",
      click() {
        quitting = true;
        app.quit();
      },
    },
  ].filter(Boolean);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// "Open config" should always have something to open: on a first portable run
// the file may not exist yet, so write the current values out first.
function configFileToOpen() {
  const existing = [cfg?.configPath, cfg?.writePath].find(
    (p) => p && !/[\\/]app\.asar[\\/]/.test(p) && fs.existsSync(p)
  );
  if (existing) return existing;
  if (!cfg) return cfg?.configPath || config.bundledConfigPath();
  try {
    return config.saveConfig(cfg, { userDataDir: userDataDir() });
  } catch (err) {
    log?.warn("cannot create config file:", err.message);
    return cfg.writePath || config.bundledConfigPath();
  }
}

function openConfigFile() {
  const p = configFileToOpen();
  if (!p) return;
  shell.openPath(p).then((err) => {
    if (err) log.warn("cannot open config file:", err);
  });
}

function openConfigFolder() {
  const p = configFileToOpen();
  if (!p) return;
  shell.showItemInFolder(p);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 900,
    minWidth: 780,
    minHeight: 620,
    title: "NetMouse 设置",
    icon: windowIconPath(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#eef2f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.once("ready-to-show", () => win.show());

  win.on("close", (e) => {
    const keepRunning = cfg?.ui?.minimizeToTray !== false && trayOk;
    if (!quitting && keepRunning) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle("app:getState", () => ({
    config: cfg ? config.serialize(cfg) : null,
    runtime: {
      configPath: cfg?.configPath || null,
      writePath: cfg?.writePath || null,
      configWritable: !!cfg?.configWritable,
      searchedPaths: cfg?.searchedPaths || [],
      trayAvailable: trayOk,
      portable: !!cfg?.portable,
      portableDir: cfg?.portableDir || null,
      blockLocal: cfg ? cfg.input?.blockLocal !== false : true,
      panicHotkey: cfg?.input?.panicHotkey || "",
      blocked: !!blocker?.isEngaged(),
      // The edge actually in force right now (the tray can change it at runtime).
      edge: currentEdge(),
      screen: (() => {
        try {
          const { diagSnapshot } = require("./platform");
          const snap = diagSnapshot();
          return {
            virtual: snap.virtual,
            monitors: snap.monitors,
            description: snap.description,
            edgeOwners: snap.edgeOwners,
          };
        } catch {
          return { virtual: null, monitors: [], description: "", edgeOwners: {} };
        }
      })(),
    },
    status: statusSnapshot(),
    platform: platformInfo(),
    defaults: config.DEFAULTS,
    options: {
      roles: config.ROLES,
      edges: config.EDGES,
      edgeModes: config.EDGE_MODES,
      levels: config.LEVELS,
    },
  }));

  ipcMain.handle("app:saveConfig", (_e, payload) => {
    try {
      const normalized = config.normalize(payload);
      const target = config.saveConfig(normalized, { userDataDir: userDataDir() });
      log.info(`config saved to ${target}`);
      return { ok: true, path: target };
    } catch (err) {
      log.error("cannot save config:", err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:reloadConfig", () => {
    try {
      cfg = loadCfg();
      log?.setLevel(cfg.logging.level);
      return { ok: true };
    } catch (err) {
      log.error("cannot reload config:", err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:start", () => {
    startNode();
    return { ok: true, status: statusSnapshot() };
  });

  ipcMain.handle("app:stop", () => {
    stopNode();
    return { ok: true, status: statusSnapshot() };
  });

  ipcMain.handle("app:restart", () => {
    // Pick up whatever is on disk now (the user may have hand-edited the file).
    try {
      cfg = loadCfg();
      log.setLevel(cfg.logging.level);
    } catch (err) {
      log.error("cannot reload config before restart:", err.message);
      return { ok: false, error: err.message };
    }
    restartNode();
    return { ok: true, status: statusSnapshot() };
  });

  ipcMain.handle("app:detectScreen", async () => {
    try {
      const { getScreenInfo } = require("./platform");
      const info = getScreenInfo({ force: true });
      return { ok: true, ...(info.virtual || {}), monitors: info.monitors };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:getMonitors", () => {
    try {
      const { detectMonitors, detectVirtualScreen, invalidateScreenCache } = require("./platform");
      invalidateScreenCache();
      return {
        ok: true,
        monitors: detectMonitors({ force: true }),
        virtual: detectVirtualScreen({ force: true }),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Manual "take back control" from the settings window (the panic hotkey is
  // the same thing from the physical keyboard).
  ipcMain.handle("app:releaseControl", () => {
    try {
      node?.release?.();
    } catch (err) {
      log.warn("release failed:", err.message);
    }
    return { ok: true, status: statusSnapshot() };
  });

  // Live edge switch from the settings window (same code path as the tray).
  ipcMain.handle("app:setEdge", (_e, edge) => {
    switchEdge(String(edge));
    return { ok: true, edge: currentEdge(), status: statusSnapshot() };
  });

  // Generate the diagnostic report; optionally with a live edge watch.
  ipcMain.handle("app:runDiag", (_e, opts) => runDiag({ live: !!opts?.live }));

  // Real-hardware edge self-test: pauses the node, walks the real cursor to
  // each shared edge, writes a report, restarts the node.
  ipcMain.handle("app:runHwTest", (_e, opts) =>
    runHwTest({ edges: Array.isArray(opts?.edges) ? opts.edges : null })
  );

  // Client-side injection self-test: can this machine drive its own cursor,
  // buttons and wheel? Answers the half of "it doesn't work" that hwtest cannot.
  ipcMain.handle("app:runInjectTest", () => runInjectTest());

  // One-click diagnostic bundle: config (redacted) + platform + logs + all
  // three self-tests in a single zip, ready to send on.
  ipcMain.handle("app:makeDiagBundle", (_e, opts) =>
    runDiagBundle({ includeLive: opts?.includeLive !== false })
  );

  // Detailed geometry, for the "屏幕布局" card: per-monitor physical rects plus
  // which monitor owns each boundary of the virtual desktop.
  ipcMain.handle("app:getGeometry", () => {
    try {
      const { diagSnapshot } = require("./platform");
      return { ok: true, ...diagSnapshot() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:openConfigFile", () => {
    openConfigFile();
    return { ok: true };
  });

  ipcMain.handle("app:openConfigFolder", () => {
    openConfigFolder();
    return { ok: true };
  });

  ipcMain.handle("app:getLogs", () => getHistory());

  ipcMain.handle("app:clearLogs", () => {
    clearHistory();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Three headless diagnostics, all runnable from the packaged executable:
//
//   --doctor      EVERYTHING: session type, libraries, hooks, injection,
//                 /dev/uinput and the ydotoold situation. Start here.
//                 NetMouse.exe --doctor
//   --hwtest      SERVER side: geometry, edge detection, hand-over
//                 NetMouse.exe --hwtest [--edge left] [--out report.txt]
//   --injecttest  CLIENT side: can this box drive its own cursor/buttons/wheel?
//                 NetMouse.exe --injecttest [--out report.txt]
//
// They are deliberately separate: "the mouse doesn't cross" is ambiguous, and
// each half is only answerable on the machine that owns it.
// ---------------------------------------------------------------------------
const HW_TEST = process.argv.includes("--hwtest");
const INJECT_TEST = process.argv.includes("--injecttest");
const DOCTOR = process.argv.includes("--doctor");
const DIAG_BUNDLE = process.argv.includes("--diagbundle");

// Where a report should land when the user did not pass --out. Prefer the
// portable config directory (beside the executable the user actually ran) so the
// file is easy to find and send on.
function defaultReportPath(prefix) {
  let dir = null;
  try {
    dir = config.portableDir();
  } catch {
    /* ignore */
  }
  if (!dir) {
    try {
      dir = app.getPath("userData");
    } catch {
      /* ignore */
    }
  }
  return path.join(dir || process.cwd(), `${prefix}-${Date.now()}.txt`);
}

if (HW_TEST) {
  app.whenReady().then(async () => {
    let code = 0;
    try {
      const { runTest } = require("./hwtest");
      code = await runTest();
    } catch (err) {
      console.error("自检异常：", err && err.stack ? err.stack : err);
      code = 3;
    }
    try {
      require("./server-input").stopHook();
    } catch {
      /* never started */
    }
    app.exit(code || 0);
  });
} else if (INJECT_TEST) {
  app.whenReady().then(async () => {
    let code = 1;
    try {
      const { runInjectTest: run } = require("./injecttest");
      const outPath = process.argv.includes("--out") ? undefined : defaultReportPath("netmouse-injecttest");
      code = await run({ outPath });
    } catch (err) {
      console.error("注入自检异常：", err && err.stack ? err.stack : err);
      code = 3;
    }
    try {
      require("./server-input").stopHook();
    } catch {
      /* never started */
    }
    app.exit(code || 0);
  });
} else if (DOCTOR) {
  app.whenReady().then(async () => {
    let code = 2;
    try {
      // The doctor was previously source-only (`node src/doctor.js`), which
      // meant a user with a downloaded build could not run the one diagnostic
      // that explains why their machine is not working.
      const { runDoctor } = require("./doctor");
      code = await runDoctor();
    } catch (err) {
      console.error("doctor 异常：", err && err.stack ? err.stack : err);
      code = 3;
    }
    try {
      require("./server-input").stopHook();
    } catch {
      /* never started */
    }
    app.exit(code || 0);
  });
} else if (DIAG_BUNDLE) {
  app.whenReady().then(async () => {
    let code = 2;
    try {
      // Same reason as --doctor: the bundle is what you are asked for when
      // something is wrong, so it must be reachable from a downloaded build
      // and from a machine whose GUI will not come up at all.
      ensurePortableConfig();
      const { loadConfig } = require("./config");
      const { createLogger } = require("./logger");
      const { writeDiagBundle } = require("./diagbundle");
      const c = loadConfig(
        { role: process.env.NETMOUSE_ROLE || undefined },
        { userDataDir: userDataDir() }
      );
      const log = createLogger(c.logging?.level || "info");
      const dir = path.dirname(c.writePath || c.configPath || process.cwd());
      const res = await writeDiagBundle({
        cfg: c,
        log,
        dir,
        // `--no-live` skips the two cursor-taking self-tests (useful over SSH
        // and on a machine nobody is sitting at).
        includeLive: !process.argv.includes("--no-live"),
      });
      console.log(`诊断包：${res.path}（${res.files.length} 个文件，${res.bytes} 字节）`);
      for (const f of res.files) console.log(`  ${f}`);
      code = 0;
    } catch (err) {
      console.error("生成诊断包失败：", err && err.stack ? err.stack : err);
      code = 3;
    }
    try {
      require("./server-input").stopHook();
    } catch {
      /* never started */
    }
    app.exit(code || 0);
  });
} else if (!app.requestSingleInstanceLock()) {
  // A second instance would fight over the global input hook and the port.
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    const portableCfg = ensurePortableConfig();

    try {
      cfg = loadCfg();
      log = createLogger(cfg.logging.level);
    } catch (err) {
      log = createLogger("error");
      log.error("cannot load config:", err.message);
    }

    if (cfg?.portable) {
      log.info(`portable mode — config lives beside the executable: ${portableCfg || cfg.writePath}`);
    }

    registerIpc();
    buildTray();

    subscribe((entry) => {
      if (win && !win.isDestroyed()) win.webContents.send("log", entry);
    });

    createWindow();

    if (cfg && cfg.ui.autoStart) startNode();
    pushStatus();

    if (cfg) log.info(`config file: ${cfg.configPath}`);
    log.info(`platform: ${platformInfo().label} ${process.arch}`);
  });

  app.on("window-all-closed", () => {
    // Closing the window is "hide to tray"; quitting happens via the tray menu
    // or when the tray is unavailable.
    if (!trayOk) app.quit();
  });

  app.on("activate", () => showWindow());

  app.on("before-quit", () => {
    quitting = true;
    stopNode();
    try {
      blocker?.destroy();
    } catch {
      /* never engaged */
    }
    try {
      require("./server-input").stopHook();
    } catch {
      /* hook was never started */
    }
  });
}

const api = window.netmouse;
const $ = (id) => document.getElementById(id);

const PEER_LABEL = {
  stopped: "已停止",
  listening: "等待客户端连接",
  connecting: "连接中…",
  connected: "已连接",
  reconnecting: "连接断开，重连中…",
  error: "错误",
};

const PEER_TONE = {
  connected: "ok",
  listening: "warn",
  connecting: "warn",
  reconnecting: "warn",
  error: "err",
  stopped: "off",
};

let state = null;
// role / edge are segmented controls, so they live outside the DOM inputs.
let draft = { role: "server", edge: "right" };

// ------------------------------------------------------- platform split
// The two machines run the same build, but a fair amount of behaviour is
// decided by the operating system rather than by config. This table is what
// the settings window shows so it is obvious which options can be shared and
// which cannot. `win`/`linux` are the two columns; `note` is the one-line
// "why it matters" shown underneath.
const PLATFORM_DIFF = [
  {
    aspect: "屏幕几何来源",
    win: "Electron screen + dipToScreenRect（DPI 感知）",
    linux: "xrandr 解析（X11）",
    note: "都取物理像素，与钩子同一坐标空间。",
  },
  {
    aspect: "缩放 / 高 DPI",
    win: "每屏独立缩放（125% / 200%…），DIP ≠ 物理像素",
    linux: "X11 通常 100%；分数缩放对 X11 应用不可见",
    note: "Windows 上必须走 dipToScreenRect，朴素乘法在混合缩放下会算偏。",
  },
  {
    aspect: "输入注入方式",
    win: "SendInput",
    linux: "X11：XTest（libnut）／Wayland：uinput（dotool、ydotool）",
    note:
      "XTest 只在 X11 下有效。Wayland 下 Xwayland 会让它「调用成功、事件却到不了原生应用」，" +
      "日志看不出任何问题 —— 这是本机作为客户端时「鼠标不动」最常见的原因。",
  },
  {
    aspect: "滚轮「一格」的单位",
    win: "120（原始 wheel delta）",
    linux: "1（点击次数）",
    note: "nut-js 原样把数值转给 libnut，两个平台含义不同，已按平台自动换算。",
  },
  {
    aspect: "额外运行时依赖",
    win: "无",
    linux: "xdotool + libx11-6 / libxtst6 / libxt6 / libxrandr2",
    note: "缺了会影响边缘钉光标与全局钩子。",
  },
  {
    aspect: "沙箱",
    win: "不适用",
    linux: "chrome-sandbox 需 root:root 4755，否则自动加 --no-sandbox",
    note: "免安装包解压后没有 setuid 位，启动脚本会自动降级。",
  },
  {
    aspect: "会话类型",
    win: "始终 Win32",
    linux: "X11 或 Wayland；Wayland 需经 Xwayland",
    note:
      "捕获与注入是两回事：Wayland 下有 DISPLAY 时捕获（钩子）能用，" +
      "注入却不能用。所以客户端「日志正常但鼠标不动」是正常现象，不是玄学。",
  },
  {
    aspect: "系统托盘",
    win: "稳定可用",
    linux: "依赖桌面环境，GNOME 可能需要扩展",
    note: "托盘不可用时用窗口上的按钮控制。",
  },
];

const OS_NAME = { win32: "Windows", linux: "Linux", darwin: "macOS" };

function renderPlatform(p) {
  if (!p) return;
  const key = p.platform;
  const facts = p.facts || {};
  const localCol = key === "win32" ? "win" : "linux";
  const name = OS_NAME[key] || p.label || key;

  $("osPill").textContent = `${name} ${p.arch || ""}`.trim();
  $("osPill").className = "pill pill--os pill--" + localCol;
  $("osTag").textContent = name;

  // --- this machine, in one glance ---------------------------------------
  const rows = [
    ["操作系统", `<b>${name}</b> ${p.arch || ""}`],
    ["角色", draft.role === "server" ? "服务器（接物理键鼠）" : "客户端（被控制）"],
    ["屏幕几何", facts.geometry || "-"],
    ["缩放", facts.scaling || "-"],
    ["注入方式", facts.injection || "-"],
    ["滚轮单位", `<b>${facts.wheelUnit}</b>（一格）`],
  ];
  if (p.sessionType) rows.push(["会话", p.sessionType + (p.display ? ` · DISPLAY=${p.display}` : "")]);
  if (p.xdotool !== null && p.xdotool !== undefined) {
    rows.push([
      "xdotool",
      p.xdotool
        ? '<span class="dot dot--ok"></span>已安装'
        : '<span class="dot dot--warn"></span>未安装（server 端钉光标需要）',
    ]);
  }

  const dl = $("platList");
  dl.textContent = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.innerHTML = v;
    dl.append(dt, dd);
  }

  $("platHint").textContent =
    draft.role === "server"
      ? `这台是「服务器」（${name}）。服务器设置、屏幕布局、输入拦截 由这台生效。`
      : `这台是「客户端」（${name}）。客户端设置里的「滚轮单位」等注入选项由这台生效。`;

  // --- the two platform-specific runtime blocks --------------------------
  const linuxList = $("osLinuxList");
  linuxList.textContent = "";
  const linuxItems = [
    p.sessionType
      ? `会话类型：${p.sessionType}${p.display ? `，DISPLAY=${p.display}` : "，无 DISPLAY"}`
      : "会话类型：未知",
    p.xdotool ? "xdotool：已安装" : "xdotool：未安装 —— sudo apt install xdotool",
    "依赖：libx11-6 libxtst6 libxt6 libxrandr2（sudo apt install 同名包）",
    "沙箱：若提示 SUID sandbox，启动脚本会自动加 --no-sandbox",
    p.wayland
      ? `注入：Wayland 下 XTest 无效，需 uinput 工具${
          p.uinputTool ? `（已找到 ${p.uinputTool}）` : "（未找到 —— sudo apt install -y ydotool）"
        }；ydotoold 由程序自动拉起`
      : "注入：X11 会话，libnut/XTest 直接可用",
  ];
  for (const t of linuxItems) {
    const li = document.createElement("li");
    li.textContent = t;
    linuxList.appendChild(li);
  }

  const winList = $("osWinList");
  winList.textContent = "";
  const winItems = [
    "无额外依赖，原生模块随包分发。",
    "多屏混合缩放由 dipToScreenRect 处理，无需手工换算。",
    "输入拦截靠全屏透明遮罩（应用层），键盘焦点尽力而为。",
    "若点击/注入无效，先查安全软件是否拦截了模拟输入。",
  ];
  for (const t of winItems) {
    const li = document.createElement("li");
    li.textContent = t;
    winList.appendChild(li);
  }

  // --- the comparison table ---------------------------------------------
  const table = $("diffTable");
  table.textContent = "";
  const head = document.createElement("div");
  head.className = "diffrow diffrow--head";
  head.innerHTML = "<span>方面</span><span>Windows 11</span><span>Ubuntu / Linux</span>";
  table.appendChild(head);
  for (const r of PLATFORM_DIFF) {
    const row = document.createElement("div");
    row.className = "diffrow";
    const a = document.createElement("span");
    a.className = "diffaspect";
    a.textContent = r.aspect;
    const w = document.createElement("span");
    w.className = "diffcell" + (localCol === "win" ? " diffcell--local" : "");
    w.textContent = r.win;
    const l = document.createElement("span");
    l.className = "diffcell" + (localCol === "linux" ? " diffcell--local" : "");
    l.textContent = r.linux;
    row.append(a, w, l);
    table.appendChild(row);

    const note = document.createElement("div");
    note.className = "diffnote";
    note.textContent = r.note;
    table.appendChild(note);
  }

  applyPlatformFilter();
}

// "Only show what applies to this machine": hides the other platform's
// runtime block. The role split is handled separately by renderRole().
function applyPlatformFilter() {
  const only = $("onlyLocal").checked;
  const key = state?.platform?.platform;
  for (const el of document.querySelectorAll(".osblock[data-os]")) {
    const match = !key || el.dataset.os === key;
    el.hidden = only && !match;
    // Even when both are shown, make it obvious which one is NOT this machine.
    el.classList.toggle("osblock--other", !match);
  }
}

// ------------------------------------------------------------------ helpers
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function msg(text, tone) {
  const el = $("saveMsg");
  el.textContent = text;
  el.className = "save-msg" + (tone ? " " + tone : "");
  if (tone === "ok") {
    clearTimeout(msg._t);
    msg._t = setTimeout(() => {
      el.textContent = "";
      el.className = "save-msg";
    }, 6000);
  }
}

function num(id, fallback) {
  const v = Number.parseInt($(id).value, 10);
  return Number.isFinite(v) ? v : fallback;
}

// For inputs whose value is a decimal (MB, seconds). parseInt would silently
// truncate "0.5 MB" to 0, which config.js then rejects as non-positive.
function numFloat(id, fallback) {
  const v = Number.parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

// -------------------------------------------------------------------- logs
function appendLog(entry) {
  const box = $("log");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const row = document.createElement("div");
  row.className = `lv-${entry.level}`;
  const t = document.createElement("time");
  t.textContent = fmtTime(entry.time);
  row.appendChild(t);
  row.appendChild(document.createTextNode(entry.message));
  box.appendChild(row);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function loadLogs() {
  const box = $("log");
  box.textContent = "";
  for (const entry of await api.getLogs()) appendLog(entry);
}

// --------------------------------------------------------------- form fill
function fillForm(c) {
  draft.role = c.role;
  draft.edge = c.layout.edge;

  $("listenPort").value = c.listenPort;
  $("peerHost").value = c.peer.host;
  $("peerPort").value = c.peer.port;
  $("peerPassword").value = c.peer.password;
  $("screenWidth").value = c.layout.screenWidth;
  $("screenHeight").value = c.layout.screenHeight;
  setMonitorOptions(c.layout.monitor);
  $("logLevel").value = c.logging.level;
  $("autoStart").checked = c.ui.autoStart;
  $("minimizeToTray").checked = c.ui.minimizeToTray;
  $("blockLocal").checked = c.input ? c.input.blockLocal !== false : true;
  $("panicHotkey").value = (c.input && c.input.panicHotkey) || "";
  $("scrollUnit").value = (c.input && c.input.scrollUnit) || 0;
  $("inputBackend").value = (c.input && c.input.backend) || "auto";
  $("manageYdotoold").checked = c.input ? c.input.manageYdotoold !== false : true;
  $("inputCapture").value = (c.input && c.input.capture) || "auto";
  $("clipboardEnabled").checked = c.clipboard ? c.clipboard.enabled !== false : true;
  $("clipboardImages").checked = c.clipboard ? c.clipboard.images !== false : true;
  const mb =
    c.clipboard && Number(c.clipboard.maxImageBytes) > 0
      ? Number(c.clipboard.maxImageBytes) / 1e6
      : 8;
  $("clipboardMaxImageMB").value = String(Math.round(mb * 10) / 10);

  renderRole();
  renderEdge();
  renderScrollUnitHint();
  renderInputBackendHint();
  renderManageYdotooldHint();
  renderInputCaptureHint();
  renderClipboardHint();
}

// The value is a platform default, not a preference: nut-js forwards the scroll
// "amount" straight to libnut, where it means the raw wheel delta on Windows
// (120 = one notch) but a click count on X11/macOS (1 = one notch). 0 means
// "use whatever this platform needs".
function renderScrollUnitHint() {
  const facts = state?.platform?.facts || {};
  const unit = facts.wheelUnit;
  const name = OS_NAME[state?.platform?.platform] || "本机";
  const v = Number.parseInt($("scrollUnit").value, 10);
  const lines = [
    `0 = 按平台自动。本机（${name}）自动值是 ${unit}，也就是「一格 = ${unit} 个单位」。`,
  ];
  if (v === 0) {
    lines.push(`当前：自动（${unit}）。`);
  } else if (v === unit) {
    lines.push(`当前：${v}，与平台自动值一致。`);
  } else {
    lines.push(
      `当前：${v}，与平台自动值 ${unit} 不同 —— ` +
        `只有在滚轮明显「几乎不动 / 一次滚太多」时才需要改（相差约 ${unit} 倍）。`
    );
  }
  $("scrollUnitHint").textContent = lines.join("");
}

// The capture side. Under Wayland this is the option that decides whether the
// mouse can cross at all, and the failure it prevents is the nastiest one in
// the whole project: uiohook goes through Xwayland, so it works while an X11
// window has focus and stops the instant the user clicks a native Wayland
// window -- with no error anywhere.
function renderInputCaptureHint() {
  const p = state?.platform || {};
  const v = $("inputCapture").value;
  const lines = [];

  if (p.platform && p.platform !== "linux") {
    lines.push(
      `${OS_NAME[p.platform] || "本机"} 上只有一种捕获方式（原生全局钩子），这个选项不起作用。`
    );
  } else {
    lines.push(`自动 = 按会话判断：本机现在会选 ${p.capture || "（未知）"}。`);
    if (p.wayland) {
      const ev = p.evdev || { total: 0, readable: 0 };
      if (ev.readable) {
        lines.push(
          `evdev 可用（${ev.readable}/${ev.total} 个 /dev/input 设备可读）：` +
            "它不受显示协议影响，Wayland 下也能一直收到事件。"
        );
      } else {
        lines.push(
          `evdev 不可用（/dev/input 下 ${ev.total} 个设备，一个都读不了）：` +
            "Wayland 下会退回 uiohook，而 uiohook 走 Xwayland —— " +
            "只有 X11 窗口有焦点时才收得到事件，鼠标会时灵时不灵。" +
            "把用户加进 input 组即可：sudo ./install-linux.sh --uinput 然后注销重新登录。"
        );
      }
    }
  }

  if (v === "evdev") {
    lines.push(
      "已强制 evdev。它读不到光标位置（Wayland 不提供），所以共享边改成" +
        "「朝那一边连续推一段距离」的手势触发，阈值约 35% 屏幕短边。"
    );
  }
  if (v === "uiohook" && p.wayland) {
    lines.push("已强制 uiohook，而本机是 Wayland —— 只有 X11 窗口有焦点时才收得到事件。");
  }
  $("inputCaptureHint").textContent = lines.join("");
}

// The clipboard card. Images need explaining because three separate things can
// each independently stop them, and from the outside all three look identical
// ("I copied a picture and nothing happened"):
//   * the checkbox here is off;
//   * the peer is an older build, so it never advertised the capability;
//   * this machine's clipboard backend cannot read an image at all.
// Saying which is the difference between a five-second fix and an afternoon.
function renderClipboardHint() {
  const on = $("clipboardEnabled").checked;
  const imgs = $("clipboardImages").checked;
  const mb = numFloat("clipboardMaxImageMB", 8);
  const lines = [];
  if (!on) {
    lines.push("剪贴板同步已关闭：两端不会互传文本或图片。");
  } else {
    lines.push("只在本端主动复制时才发出去；对端写回来的内容不会弹回去（有回声抑制）。");
    if (imgs) {
      lines.push(
        `图片优先按 PNG 传输（无损）；PNG 超过 ${mb} MB 时自动转成 JPEG 再发，仍然超限才丢弃（丢一次就记住，不会反复重试）。`
      );
      lines.push("复制的图片本身不限格式 —— JPG、PNG、WebP、BMP、截图都行，发出去之前统一转码。");
      lines.push(
        "需要两端都是当前版本：对端若是旧版、没声明支持图片，本端就自动只发文本。"
      );
      lines.push("剪贴板里同时有文本和图片时只发文本 —— 浏览器复制图片往往两者都有。");
    } else {
      lines.push("当前只同步文本。");
    }
  }
  $("clipboardHint").textContent = lines.join("");
  $("clipboardImages").disabled = !on;
  $("clipboardMaxImageMB").disabled = !on || !imgs;
}

// Which injector this machine will actually drive, and why. "auto" is the
// default because the session type is observable: on Wayland XTest accepts// every call and delivers the events to nobody, so if a uinput tool is present
// auto picks it and the user never has to know any of this.
function renderInputBackendHint() {
  const p = state?.platform || {};
  const v = $("inputBackend").value;
  const lines = [];

  if (p.platform && p.platform !== "linux") {
    lines.push(
      `${OS_NAME[p.platform] || "本机"} 上只有一种注入方式（libnut），这个选项不起作用。`
    );
  } else {
    const auto = p.wayland
      ? p.uinputTool
        ? `uinput（${p.uinputTool}）`
        : "XTest —— 但在 Wayland 下不会生效"
      : "XTest";
    lines.push(`自动 = 按会话判断：本机现在会选 ${auto}。`);
    if (p.wayland && !p.uinputTool) {
      lines.push(
        "本机是 Wayland 会话，且没找到 dotool / ydotool：" +
          "客户端注入不会生效（Xwayland 会让 XTest「调用成功、事件到不了原生应用」）。" +
          "装一个 uinput 工具即可：sudo apt install -y ydotool" +
          "（若你的发行版仍提供 Xorg 会话，选它也能立刻解决）。"
      );
    } else if (p.uinputTool) {
      lines.push(`已找到 ${p.uinputTool}，Wayland 下会自动改用它。`);
    }
  }

  if (v === "uinput" && p.platform === "linux" && !p.uinputTool) {
    lines.push("已强制 uinput，但本机没找到 dotool / ydotool —— 会退回 XTest 并在日志里警告。");
  }
  if (v === "xtest" && p.wayland) {
    lines.push("已强制 XTest，而本机是 Wayland —— 客户端注入不会生效。");
  }
  $("inputBackendHint").textContent = lines.join("");
  renderManageYdotooldHint();
}

// ydotool is a pure client: it exits 2 on every call until the ydotoold daemon
// is listening. The daemon is not something the user should have to remember, so
// the default is for NetMouse to reuse one that is already up and otherwise start
// a private one (and stop it on exit). This is the one place that is explained.
function renderManageYdotooldHint() {
  const p = state?.platform || {};
  const on = $("manageYdotoold").checked;
  const lines = [];

  if (p.platform && p.platform !== "linux") {
    lines.push(`${OS_NAME[p.platform] || "本机"} 上不存在 ydotoold，这个选项不起作用。`);
  } else if (p.uinputTool === "ydotool") {
    lines.push(
      on
        ? "本机用 ydotool：程序会先找已经运行的 ydotoold 复用，没有就自己拉起一个私有实例，" +
            "退出时关掉。你不需要配置任何服务。"
        : "已关闭：程序只会复用你手动启动的 ydotoold，不会自己拉起。" +
            "没启动时 ydotool 每次调用都会以 exit 2 失败。"
    );
  } else if (p.uinputTool === "dotool") {
    lines.push(
      "本机用 dotool：它自己持有虚拟设备，不需要守护进程，这个选项对 dotool 无影响。"
    );
  } else {
    lines.push(
      on
        ? "仅在使用 ydotool 时生效：自动复用/拉起 ydotoold 守护进程（dotool 不需要）。"
        : "仅在使用 ydotool 时生效：关闭后需自己启动 ydotoold。"
    );
  }
  $("manageYdotooldHint").textContent = lines.join("");
}

function renderRole() {
  for (const b of $("roleSeg").children) {
    b.classList.toggle("on", b.dataset.value === draft.role);
  }
  const isServer = draft.role === "server";
  $("cardServer").hidden = !isServer;
  $("cardClient").hidden = isServer;
  $("cardInput").hidden = !isServer;
  $("roleHint").textContent = isServer
    ? "服务器：接物理鼠标键盘的那台，等待客户端接入。"
    : "客户端：被控制的那台，主动连接服务器。";
  renderEdge(); // the edge/resolution wording depends on the role
  // The platform panel names this machine's role, so it has to follow too.
  if (state?.platform) renderPlatform(state.platform);
}

function renderEdge() {
  for (const b of $("edgePick").querySelectorAll("button[data-edge]")) {
    b.classList.toggle("on", b.dataset.edge === draft.edge);
  }
  renderEdgeHint();
  renderResHint();
}

// `layout.edge` is the *server's* shared edge: the server needs it to detect
// the hand-over, and the client derives its own facing edge as the opposite of
// it (the server sends the value at hand-over time, so the client config is
// only a fallback for older peers).
function renderEdgeHint() {
  const isServer = draft.role === "server";
  $("edgeScreenLabel").textContent = isServer ? "本机" : "服务器";
  $("edgeHint").textContent = isServer
    ? "选客户端在哪一侧：鼠标碰到这一侧的边缘时，控制权交给客户端。拿不准就选“任意边都触发”。"
    : "客户端不用手工对齐：运行时自动采用服务器发来的边，这里只是旧版本对端的兜底值。";
}

const EDGE_CN = { left: "左", right: "右", top: "上", bottom: "下" };

// The table the edge detection actually uses. On a multi-monitor desk the
// shared edge usually belongs to a secondary screen, and seeing that spelled
// out is what turns "moving left does nothing" into an obvious answer.
function renderGeometry(rt) {
  const sc = rt.screen || {};
  const monitors = Array.isArray(sc.monitors) ? sc.monitors : [];
  const box = $("geomBox");
  const list = $("geomList");
  const edgeEl = $("geomEdge");
  list.textContent = "";
  edgeEl.textContent = "";

  if (!monitors.length || !sc.virtual) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const v = sc.virtual;
  const head = document.createElement("li");
  head.textContent = `虚拟桌面 ${v.width}×${v.height} @ (${v.x},${v.y})`;
  list.appendChild(head);

  monitors.forEach((m, i) => {
    const li = document.createElement("li");
    if (m.primary) li.className = "primary";
    const scale = m.scaleFactor ? `  ${Math.round(m.scaleFactor * 100)}%` : "";
    const dip = m.dip ? `  dip ${m.dip.width}×${m.dip.height}` : "";
    li.textContent = `#${i}${m.primary ? " 主" : ""}  ${m.width}×${m.height} @ (${m.x},${m.y})${scale}${dip}`;
    list.appendChild(li);
  });

  const edge = rt.edge || draft.edge;
  const owners = (sc.edgeOwners || {})[edge] || [];
  if (edge === "any") {
    edgeEl.innerHTML = "共享边：<b>任意边</b> —— 碰到任意一条边都会把控制权交出去。";
  } else if (!owners.length) {
    edgeEl.innerHTML = `共享边：<b>${EDGE_CN[edge] || edge}</b> —— 未识别到归属显示器。`;
  } else {
    const nonPrimary = owners.every((i) => !monitors[i]?.primary);
    edgeEl.innerHTML =
      `共享边：<b>${EDGE_CN[edge] || edge}</b> 位于显示器 <b>#${owners.join(",")}</b>` +
      (nonPrimary ? "（非主屏）" : "（主屏）") +
      (monitors.length > 1 && nonPrimary
        ? `<br><span class="warnline">鼠标要先跨过整块 #${owners.join(",")} 才能到达这条边。` +
          `如果对端其实在另一侧，请改选别的方向或“任意边都触发”。</span>`
        : "");
  }
}

// The stored resolution is the *server's*, on both machines: the server needs it
// for edge detection, the client needs it to scale incoming coordinates.
function renderResHint() {
  const isServer = draft.role === "server";
  $("detectBtn").textContent = "检测本机多屏布局";
  $("resHint").textContent = isServer
    ? "服务器多屏时会自动检测虚拟桌面尺寸，这里只需在自动检测不可用时兜底。"
    : "⚠️ 这里要填服务器端的虚拟桌面尺寸（多屏是各屏拼起来的总尺寸），不是本机的。运行时会用服务器实际值自动校正。";
}

// Rebuild the monitor picker: "all", "primary", then one entry per detected
// monitor. No-op (keeps just all/primary) when detection is unavailable.
async function setMonitorOptions(selected) {
  const sel = $("monitor");
  const want = selected === undefined || selected === null ? "all" : String(selected);
  const base = [
    { value: "all", label: "全部（整个虚拟桌面）" },
    { value: "primary", label: "主显示器" },
  ];
  let monitors = [];
  try {
    const res = await api.getMonitors();
    if (res.ok && Array.isArray(res.monitors)) monitors = res.monitors;
  } catch {
    /* detection optional */
  }
  monitors.forEach((m, i) => {
    base.push({
      value: String(i),
      label: `#${i} ${m.width}x${m.height} @ (${m.x},${m.y})${m.primary ? " 主" : ""}`,
    });
  });

  sel.textContent = "";
  for (const o of base) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  // Keep the stored value if it is still offered, else fall back to "all".
  sel.value = base.some((o) => o.value === want) ? want : "all";
}

// ------------------------------------------------------------------ collect
function collect() {
  return {
    role: draft.role,
    listenPort: num("listenPort", 24800),
    peer: {
      host: $("peerHost").value.trim(),
      port: num("peerPort", 24800),
      password: $("peerPassword").value,
    },
    layout: {
      edge: draft.edge,
      screenWidth: num("screenWidth", 1920),
      screenHeight: num("screenHeight", 1080),
      monitor: $("monitor").value,
    },
    input: {
      blockLocal: $("blockLocal").checked,
      panicHotkey: $("panicHotkey").value.trim(),
      scrollUnit: num("scrollUnit", 0),
      backend: $("inputBackend").value,
      manageYdotoold: $("manageYdotoold").checked,
      capture: $("inputCapture").value,
    },
    clipboard: {
      enabled: $("clipboardEnabled").checked,
      images: $("clipboardImages").checked,
      // config.js rejects a non-positive ceiling and falls back to the default,
      // so clamp here too: an empty or "0" box should mean "default", not
      // "silently ignore whatever I typed".
      maxImageBytes: Math.max(1, Math.round(numFloat("clipboardMaxImageMB", 8) * 1e6)),
    },
    logging: { level: $("logLevel").value },
    ui: {
      autoStart: $("autoStart").checked,
      minimizeToTray: $("minimizeToTray").checked,
    },
  };
}

// ------------------------------------------------------------------- render
function renderStatus(st) {
  const running = !!st.running;

  const pill = $("runPill");
  pill.textContent = running ? "运行中" : "已停止";
  pill.className = "pill " + (running ? "pill--on" : "pill--off");

  const modePill = $("modePill");
  const remote = st.mode === "remote";
  modePill.textContent = remote ? "远程控制中" : "本地控制";
  modePill.className = "pill " + (remote ? "pill--remote" : "pill--ghost");

  const tone = PEER_TONE[st.peer] || "off";
  const rows = [
    ["运行", `<span class="dot dot--${running ? "ok" : "off"}"></span>${running ? "运行中" : "已停止"}`],
    ["角色", st.role === "server" ? "服务器" : "客户端"],
    ["对端", `<span class="dot dot--${tone}"></span>${PEER_LABEL[st.peer] || st.peer}`],
    ["当前", remote ? "远程（正在转发输入）" : "本地"],
  ];
  if (st.role === "server") {
    const edge = state?.runtime?.edge || draft.edge;
    rows.push([
      "共享边",
      `<b>${edge === "any" ? "任意边都触发" : EDGE_CN[edge] || edge}</b>（托盘菜单可随时切换）`,
    ]);
    rows.push([
      "本机拦截",
      st.blocked
        ? `<span class="dot dot--warn"></span>已拦截（本机键鼠不会落到本地窗口）`
        : `<span class="dot dot--off"></span>未拦截`,
    ]);
  }
  if (st.detail) rows.push(["详情", st.detail]);

  const dl = $("statusList");
  dl.textContent = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.innerHTML = v;
    dl.append(dt, dd);
  }

  $("startBtn").disabled = running;
  $("stopBtn").disabled = !running;
  $("restartBtn").disabled = false;
  // The manual escape is only useful while the server is actually remote.
  $("releaseBtn").hidden = !(st.role === "server" && remote);
}

function renderRuntime(rt, platform) {
  $("configPath").textContent = rt.configPath || rt.writePath || "(未找到)";
  $("portableTag").hidden = !rt.portable;
  renderPlatform(platform);
  // The backend hint depends on the platform report (Wayland? uinput tool?),
  // so it has to be refreshed whenever that arrives, not only on fillForm.
  renderInputBackendHint();

  const note = [];
  note.push(
    rt.configWritable
      ? `保存目标：${rt.writePath}`
      : `当前文件不可写，保存会写到：${rt.writePath}`
  );
  if (rt.portable) {
    note.push("免安装便携版：配置就放在程序所在文件夹，换机器时整个文件夹拷走即可。");
  }
  if (!rt.trayAvailable) note.push("系统托盘不可用，请用窗口上的按钮控制。");
  $("configNote").textContent = note.join("　·　");

  // Detected local layout, appended under the resolution fields.
  const sc = rt.screen || {};
  if (sc.virtual) {
    const n = Array.isArray(sc.monitors) ? sc.monitors.length : 0;
    $("resHint").textContent += `　本机检测：虚拟桌面 ${sc.virtual.width}×${sc.virtual.height} @ (${sc.virtual.x},${sc.virtual.y})，${n} 块显示器。`;
  }
  renderGeometry(rt);

  const warns = platform.warnings || [];
  $("warnCard").hidden = warns.length === 0;
  const ul = $("warnList");
  ul.textContent = "";
  for (const w of warns) {
    const li = document.createElement("li");
    li.textContent = w;
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ actions
async function refresh() {
  state = await api.getState();
  fillForm(state.config);
  renderStatus(state.status);
  renderRuntime(state.runtime, state.platform);
}

async function save() {
  const res = await api.saveConfig(collect());
  if (!res.ok) {
    msg("保存失败：" + res.error, "err");
    return false;
  }
  msg("已保存到 " + res.path, "ok");
  await refresh();
  return true;
}

async function saveAndRestart() {
  if (!(await save())) return;
  const res = await api.restart();
  if (!res.ok) msg("重启失败：" + res.error, "err");
  else msg("已保存并重启", "ok");
  await refresh();
}

function wire() {
  // Remembered across restarts: once someone hides the other platform's
  // block they rarely want it back.
  try {
    $("onlyLocal").checked = localStorage.getItem("netmouse.onlyLocal") === "1";
  } catch {
    /* localStorage may be unavailable; default to showing everything */
  }
  $("onlyLocal").addEventListener("change", () => {
    try {
      localStorage.setItem("netmouse.onlyLocal", $("onlyLocal").checked ? "1" : "0");
    } catch {
      /* ignore */
    }
    applyPlatformFilter();
  });

  $("scrollUnit").addEventListener("input", renderScrollUnitHint);
  $("inputBackend").addEventListener("change", renderInputBackendHint);
  $("manageYdotoold").addEventListener("change", renderManageYdotooldHint);
  $("inputCapture").addEventListener("change", renderInputCaptureHint);
  $("clipboardEnabled").addEventListener("change", renderClipboardHint);
  $("clipboardImages").addEventListener("change", renderClipboardHint);
  $("clipboardMaxImageMB").addEventListener("input", renderClipboardHint);

  $("roleSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    draft.role = b.dataset.value;
    renderRole();
  });

  $("edgePick").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-edge]");
    if (!b) return;
    draft.edge = b.dataset.edge;
    renderEdge();
    renderGeometry(state?.runtime || {});
    // Apply immediately when this machine is the running server, so trying the
    // other direction is one click instead of edit-save-restart.
    if (draft.role === "server" && state?.status?.running) {
      api.setEdge(draft.edge).then((res) => {
        if (res && res.ok) {
          msg(
            `共享边已即时切换为「${EDGE_CN[draft.edge] || draft.edge}」（点保存可持久化）`,
            "ok"
          );
        } else {
          msg("即时切换失败，请保存后重启", "err");
        }
      });
    }
  });

  $("diagBtn").addEventListener("click", async () => {
    const isServer = draft.role === "server";
    const btn = $("diagBtn");
    btn.disabled = true;
    msg(
      isServer
        ? "正在生成诊断报告：会暂停服务约 20 秒做实时观测，期间请把鼠标推到屏幕的四个角落…"
        : "正在生成诊断报告…"
    );
    try {
      const res = await api.runDiag({ live: isServer });
      if (res && res.ok) msg("诊断报告已生成并打开：" + res.path, "ok");
      else msg("诊断失败：" + ((res && res.error) || "未知错误"), "err");
    } catch (err) {
      msg("诊断失败：" + err.message, "err");
    }
    btn.disabled = false;
    await refresh();
  });

  $("hwtestBtn").addEventListener("click", async () => {
    const btn = $("hwtestBtn");
    btn.disabled = true;
    msg("正在自检：会用真实光标依次推到四条边的外缘，请先松开鼠标、不要动它…");
    try {
      const res = await api.runHwTest({});
      if (res && res.ok) msg("自检完成，报告已打开：" + res.path, "ok");
      else if (res && res.error === "not-server") msg("本机自检只在「服务器」角色下有意义。", "err");
      else msg("自检未通过：" + ((res && res.error) || "请查看报告"), "err");
    } catch (err) {
      msg("自检失败：" + err.message, "err");
    }
    btn.disabled = false;
    await refresh();
  });

  $("injecttestBtn").addEventListener("click", async () => {
    const btn = $("injecttestBtn");
    btn.disabled = true;
    msg("正在注入自检：会短暂接管光标，请先松开鼠标、不要动它…");
    try {
      const res = await api.runInjectTest();
      if (res && res.ok) msg("注入自检通过，报告已打开：" + res.path, "ok");
      else
        msg(
          "注入自检未通过（本机可能驱动不了光标/按键/滚轮）：" +
            ((res && res.path) || (res && res.error) || "请查看报告"),
          "err"
        );
    } catch (err) {
      msg("注入自检失败：" + err.message, "err");
    }
    btn.disabled = false;
    await refresh();
  });

  $("bundleBtn").addEventListener("click", async () => {
    const btn = $("bundleBtn");
    const withLive = $("bundleLive").checked;
    btn.disabled = true;
    msg(
      withLive
        ? "正在生成诊断包：会跑两个自检（约 15 秒，会短暂接管光标），请先松开鼠标、不要动它…"
        : "正在生成诊断包：只收配置、日志与体检结果…"
    );
    try {
      const res = await api.makeDiagBundle({ includeLive: withLive });
      if (res && res.ok)
        msg(`诊断包已生成（${res.files.length} 个文件）：${res.path}`, "ok");
      else msg("生成诊断包失败：" + ((res && res.error) || "未知错误"), "err");
    } catch (err) {
      msg("生成诊断包失败：" + err.message, "err");
    }
    btn.disabled = false;
    await refresh();
  });

  $("togglePw").addEventListener("click", () => {
    const inp = $("peerPassword");
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    $("togglePw").textContent = show ? "隐藏" : "显示";
  });

  $("detectBtn").addEventListener("click", async () => {
    const res = await api.getMonitors();
    if (!res.ok || !res.virtual) {
      msg("检测失败：" + (res.error || "无检测结果"), "err");
      return;
    }
    const v = res.virtual;
    $("screenWidth").value = v.width;
    $("screenHeight").value = v.height;
    const n = Array.isArray(res.monitors) ? res.monitors.length : 0;
    msg(`检测到虚拟桌面 ${v.width}×${v.height}（${n} 块显示器）`, "ok");
    // Refresh the monitor list for the newly detected layout.
    await setMonitorOptions($("monitor").value);
  });

  $("startBtn").addEventListener("click", async () => {
    await api.start();
    await refresh();
  });
  $("stopBtn").addEventListener("click", async () => {
    await api.stop();
    await refresh();
  });
  $("restartBtn").addEventListener("click", async () => {
    await api.restart();
    await refresh();
  });
  $("releaseBtn").addEventListener("click", async () => {
    const res = await api.releaseControl();
    msg("已交还本地控制", "ok");
    if (res && res.status) renderStatus(res.status);
    else await refresh();
  });

  $("saveBtn").addEventListener("click", () => save());
  $("saveRestartBtn").addEventListener("click", () => saveAndRestart());

  $("reloadBtn").addEventListener("click", async () => {
    const res = await api.reloadConfig();
    if (!res.ok) msg("载入失败：" + res.error, "err");
    else msg("已从磁盘重新载入", "ok");
    await refresh();
  });

  $("openFileBtn").addEventListener("click", () => api.openConfigFile());
  $("openFolderBtn").addEventListener("click", () => api.openConfigFolder());
  $("clearLogBtn").addEventListener("click", async () => {
    await api.clearLogs();
    $("log").textContent = "";
  });

  api.onStatus(renderStatus);
  api.onLog(appendLog);
}

(async function boot() {
  wire();
  await refresh();
  await loadLogs();
})();

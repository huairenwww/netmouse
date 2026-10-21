# NetMouse

软件 KVM：一套鼠标键盘跨两台电脑使用（Ubuntu / Windows 11，同一局域网）。

一台是 **server**（插着物理鼠标键盘的机器），一台是 **client**（接收注入输入的机器）。  
鼠标移到共享边缘时控制权切到对面，移回边缘切回来。

自带图形界面（Electron），可以直接改所有参数、看运行状态和日志。

> 打包、跨平台适配、便携版实现的完整过程与踩坑记录见 [`docs/开发记录.md`](docs/开发记录.md)；  
> Windows 侧的构建 / 更新 / 双机联调步骤清单见 [`docs/Windows构建与联调.md`](docs/Windows构建与联调.md)。

## 遇到问题先看这里

这个项目最耗时间的一类问题，&#x662F;**「日志一切正常，但鼠标就是不动」** ——  
因为注入失败曾经被静默吞掉，工具本身在说谎。所以先按症状定位，别从日志猜：

| 症状                                | 先做什么                                              | 去哪一节                                      |
| --------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| 推过去没反应 / 对端完全不动                   | 两台机器各跑一次自检，把「哪一侧坏了」分开                             | [本机自检](#本机自检不需要第二台机器)                     |
| 鼠标能动，但**左键点了没反应 / 滚轮不对**          | `--hwtest` 的「按键与滚轮」一段（移动和点击是两条独立代码路径）             | [三个容易踩的坑](#三个容易踩的坑)                       |
| 日志干干净净，Ubuntu 那台就是不动              | **多半是 Wayland**：跑 `--doctor` 看「Client-role injection」那几行 | [Wayland 会话](#wayland-会话为什么日志正常鼠标就是不动)    |
| 报告说 `ydotoold 不可用：… 没有出现可连接的 socket` | 那是 0.2.10 及更早的 bug（探测方式错），**升到 0.2.11**  | [Wayland 会话](#wayland-会话为什么日志正常鼠标就是不动)    |
| Ubuntu 上鼠标能动，**只有滚轮不动**            | 多半没有 `python3`（滚轮走附带的 `bin/wheel.py`）             | [Wayland 会话](#wayland-会话为什么日志正常鼠标就是不动)    |
| Ubuntu 上双击 `netmouse.sh` 打开了文本编辑器 | 这是正常现象，不是 bug；跑一次 `install-linux.sh`              | [Linux 上怎么做到「双击就能运行」](#linux-上怎么做到双击就能运行) |
| 不知道对端在左还是右，怎么推都不切                 | 把共享边改成 `any`（托盘菜单里点一下即可）                          | [三个容易踩的坑](#三个容易踩的坑) ②                     |
| 多屏时鼠标要穿过整块屏才触发                    | 共享边其实落在**副屏**上，用 `layout.monitor` 指定              | [三个容易踩的坑](#三个容易踩的坑) ③                     |
| 想知道这台机器够不够格当 server / client      | 跑 `--doctor`（成品包也能跑）                              | [验证 / 自检](#验证--自检)                        |
| 混合缩放下共享边在光标到不了的位置                 | 跑诊断报告，看「DIP → 物理像素换算」那一行                          | [混合缩放（不同 DPI）的显示](#混合缩放不同-dpi的显示)         |
| 想把整个现场一次性交给别人看                    | 跑 `--diagbundle`，把生成的 zip 发过去                        | [一键诊断包](#一键诊断包diagbundle)                  |
| Wayland 下鼠标一碰原生窗口就捕获不到           | 那是捕获侧，`input.capture` 用 `auto` 即走 evdev                | [捕获侧](#捕获侧wayland-下读不到光标位置)             |
| 复制了图片但对面没同步                       | 看剪贴板提示；对端太旧（没声明 `img`）会自动退回纯文本                   | [剪贴板共享](#剪贴板共享)                          |
| 复制**大照片**（手机图 / 相机图）对面收不到         | 0.2.11 及更早只发 PNG，超 8 MB 整张丢弃；**升到 0.2.12** 起自动转 JPEG 再发 | [剪贴板共享](#剪贴板共享)                          |

## 目录

- [结构](#结构)
- [快速开始](#快速开始)
- [配置项](#配置项)
  - [三个容易踩的坑](#三个容易踩的坑)
  - [混合缩放（不同 DPI）的显示](#混合缩放不同-dpi的显示)
  - [本机自检（不需要第二台机器）](#本机自检不需要第二台机器)
  - [配置文件的存放位置](#配置文件的存放位置)
- [图形界面](#图形界面)
- [输入拦截与剪贴板](#输入拦截与剪贴板)
- [打包](#打包)
  - [为什么 AppImage 必须在 Linux 上打](#为什么-appimage-必须在-linux-上打)
  - [Linux 上怎么做到「双击就能运行」](#linux-上怎么做到双击就能运行)
- [验证 / 自检](#验证--自检)
  - [一键诊断包](#一键诊断包)
- [Wayland 会话：为什么「日志正常，鼠标就是不动」](#wayland-会话为什么日志正常鼠标就是不动)
  - [捕获侧：Wayland 下读不到光标位置](#捕获侧wayland-下读不到光标位置)
- [平台依赖 / 注意事项](#平台依赖--注意事项)
- [已知限制](#已知限制)

## 结构

```
src/
  config.js        配置加载 / 校验 / 原子保存（JSONC）
  logger.js        日志 + 环形缓冲（供界面显示）
  platform.js      平台信息 + 虚拟桌面/多显示器检测（Electron screen + DPI 正确换算，回退 xrandr）
  protocol.js      TCP 换行 JSON + sha256 握手 + 退避自动重连
  keymap.js        uiohook 键码 -> nut-js 键码映射
  hotkey.js        全局热键解析（逃生热键用，可单测）
  blocker.js       输入拦截：覆盖虚拟桌面的透明置顶遮罩窗
  clipboard.js     两端剪贴板同步（纯文本 + 图片；PNG 优先、超限自动转 JPEG，带回声抑制）
  capture.js       采集后端选择：uiohook（X11/Windows）或 evdev（Wayland 原生）
  capture-evdev.js Wayland 原生采集：直接读 /dev/input/event*，按 SYN_REPORT 分帧
  server-input.js  采集物理输入 + 边缘检测（支持 edge=any）+ 转发 + 几何热刷新
  client-input.js  接收并注入鼠标键盘（按本机虚拟桌面换算；选择 XTest / uinput 后端）
  inject-uinput.js Wayland 可用的注入后端：驱动 dotool / ydotool 在内核层建虚拟设备
  ydotoold.js      管理 ydotoold 守护进程：探测（ydotool debug）/ 复用 / 自己拉起 / 只关自己起的
  diag.js          诊断报告：两种 DPI 换算并排 + 各边归属 + 实时边缘观测
  diagbundle.js    一键诊断包：把配置/日志/体检/自检报告打成一个 zip（密码已脱敏）
  hwtest.js        服务器侧自检：真钩子 + 真光标 + 真 TCP 回环，四条边 + 按键 + 滚轮
  injecttest.js    客户端侧自检：驱动真注入器，验证本机能否驱动光标/按键/滚轮
  app.js           两个角色组装，对外暴露 start/stop/getStatus
  main.js          Electron 主进程：窗口 + 托盘（含共享边切换、诊断、自检）+ IPC
  preload.js       渲染进程的安全桥（contextBridge）
  ui/              设置界面（index.html / style.css / renderer.js）
  assets/          窗口与托盘图标（icon.png / tray.png）
  cli.js           无界面运行（服务器/测试用）
  selftest.js      键位映射 / 多屏解析 / 热键 / 剪贴板回声 自检
  doctor.js        目标机体检（X11 库 / DISPLAY / xdotool / 钩子 / 注入 / uinput / ydotoold）
                   也可由成品包调用：NetMouse --doctor

test/
  mock-native.js   原生输入层的可控替身（支持多显示器）
  node-runner.js   以子进程跑单个角色，用 JSON 行驱动
  e2e.js           三场景端到端回环测试（真进程 + 真 TCP）
  platform-dpi.js  混合缩放（200% + 125%）几何回归测试
  input-units.js   按键 / 滚轮契约（直接读真 nut-js 的枚举值）
  injecttest-units.js  注入自检的纯函数 + 注入失败必须被计数/播报
  clipboard-units.js   剪贴板：文本/图片发送去重、能力协商、按解码像素去重、PNG→JPEG 回退
  capture-units.js     evdev 采集：24/16 字节记录、SYN_REPORT 分帧、滚轮去重、后端选择
  diagbundle-units.js  诊断包：独立 ZIP 读回校验、CRC、脱敏、清单自引用
  uinput-units.js  uinput 后端命令语言 + 三套按键编号 + 后端选择（假 spawn，无需 Linux）
  ydotoold-units.js 守护进程管理：socket 路径 / 复用不杀 / 自起必杀 / 权限三种形态
  ui-check.js      界面静态一致性（标记 / 渲染器 / 样式三方对齐）
  hwtest-units.js  自检脚本自身的瞄准/测距数学（防止自检说谎）
  geo-probe.js     开发用：打印 Electron 的显示器信息与两种换算

bin/
  ydotool, ydotoold     随包附带的 uinput 工具（x86-64 ELF，glibc ≥ 2.34；系统装了就用系统的）
  wheel.py              ydotool 没有滚轮子命令，这个脚本直接往 /dev/uinput 写 REL_WHEEL

build/
  netmouse.sh            Linux 便携版启动脚本（补权限 + 处理沙箱）
  icon.png, icons/       应用图标（Windows / Linux 多尺寸）

scripts/
  install-linux.sh            生成 .desktop 双击启动器（+ 可选装 /dev/uinput udev 规则）
  package-linux-portable.py   Linux 便携包归档（tar.gz + 自解压 .run）
  verify-linux-portable.py    校验上面的产物（权限位 / ELF / 自解压偏移 / 脚本语法）
  make-src-zip.py             打源码包 netmouse-src-<version>.zip

docs/
  开发记录.md            打包 / 界面 / 跨平台 / 便携版的完整过程与踩坑记录
  Windows构建与联调.md    Windows 侧构建 / 更新 / 双机联调的步骤清单
reports/
  示例-*.txt / 示例-*.png  自检报告与界面截图的样例（文档里引用的证据，随源码包分发）
```

> `dist/`、`*.log`、`node_modules/` 都在 `.gitignore` 里；`reports/` 里是**样例**，  
> 真正跑出来的诊断报告写在配置文件旁边（`diag` 报告、`--injecttest` / `--hwtest` 的 txt），  
> 托盘菜单里点一下会自动打开。

## 快速开始

**方式一：免安装便携版（推荐）**

**Windows**：下载 `NetMouse-<version>-portable-x64.exe`，**直接双击**即可，不需要安装。  
第一次运行会在它旁边自动生成一个 `config.json`，界面里改参数就存这个文件。  
换机器时把 exe（和 config.json）一起拷走就行。

**Ubuntu**：下载 `NetMouse-<version>-linux-x64.run`，给一次执行权限后运行：

```bash
chmod +x NetMouse-0.2.12-linux-x64.run
./NetMouse-0.2.12-linux-x64.run        # 首次运行解压到旁边的 .netmouse/，之后直接启动
cd .netmouse && ./install-linux.sh    # 一次性：生成双击就能启动的桌面/菜单图标
```

或者用 `NetMouse-<version>-linux-x64.tar.gz`（绿色包）：解压后跑一次  
`./install-linux.sh`，之后双击图标即可（也可以直接 `./netmouse.sh`）。

> ### ⚠️ Ubuntu 上还有一步，不做的话「鼠标就是不动」
>
> 现代 Ubuntu（GNOME 50 起）默认是 **Wayland** 会话，而 X11 的注入在 Wayland 下  
> **会静默失效**：每次调用都返回成功，日志一条错误都没有，光标一动不动。  
> 所以装完之后再补三件事：
>
> ```bash
> sudo apt install -y ydotool          # 或从源码装 dotool（比 ydotool 多一个滚轮支持）
> sudo ./install-linux.sh --uinput     # 给 /dev/uinput 装 udev 规则（一次即可）
> ./NetMouse --injecttest              # 确认本机注入真的生效
> ```
>
> `ydotoold` 守护进程**由程序自己拉起**，不需要配 systemd 服务。  
> 原理、两种解法与排查顺序见 **[Wayland 会话](#wayland-会话为什么日志正常鼠标就是不动)**。
>
> **只想先试通、不想装东西？** 如果你的发行版还提供 Xorg 会话，注销后在登录界面  
> 右下角齿轮里选 **“Ubuntu on Xorg”** 即可零安装。但 GNOME 50 起多数发行版已经  
> 不提供这个选项了 —— 本项目联调用的那台就是纯 Wayland。

> **为什么不能直接双击 `netmouse.sh`？** GNOME 的 Nautilus 出于安全考虑不执行它判定为  
> 「文本」的文件，而 `.sh` / `.run` 正是文本 —— 双击只会打开编辑器。Linux 上  
> 「双击就能运行」的正规形式是 `.desktop` 启动器，`install-linux.sh` 就是替你写一个。  
> 细节见下面 **「Linux 上怎么做到「双击就能运行」」**。
>
> Windows 也可用 zip 版：解压后运行 `NetMouse.exe`，同样是绿色免安装。

**方式二：从源码运行**

```bash
npm install

npm start                  # 图形界面
npm run start:headless     # 无界面（等价 node src/cli.js）
npm test                   # 自检 + 端到端回环测试
npm run doctor -- --inject --hook   # 本机体检（能否当 server / client）
```

> **成品包也能跑诊断**：`./NetMouse --doctor`（体检）、`--injecttest`（客户端侧注入自检）、  
> `--hwtest`（服务器侧边缘/几何自检）。Windows 上是 `NetMouse.exe --doctor`。

两台机器分别准备好，打开界面：

- **server 那台**：角色选「服务器」，填监听端口、共享边缘、**服务器自己的真实分辨率**。
- **client 那台**：角色选「客户端」，填服务器 IP / 端口 / 密码。  
  共享边缘不用管（server 会在接管时下发），分辨率也不影响（转发的是相对位移）。

点「保存并重启」即可生效。

## 配置项

配置文件支持 `//` 注释（JSONC）。

```jsonc
{
  "role": "server",                      // server（插键鼠的那台）| client（被控制的那台）
  "listenPort": 24800,                   // server 监听端口

  "peer": {
    "host": "",                          // server 不用填；client 填 server 的局域网 IP
    "port": 24800,                       // client 连接 server 的端口
    "password": "change-me-strong-password"   // 两端必须完全一致
  },

  "layout": {
    "edge": "right",                     // server 共享出去的那条边：
                                         // left | right | top | bottom | any
                                         // any = 碰到任意一条边都交出去（拿不准对端在哪侧时用它）
                                         // client 端不用手工对齐，运行时会采用 server 发来的边
    "screenWidth": 2880,                 // server 虚拟桌面尺寸；运行时自动检测，这里只是兜底
    "screenHeight": 1800,
    "monitor": "all"                     // 哪块屏的边缘触发：all | primary | 0 | 1 | "1728x2170+0+0"
  },

  "input": {
    "blockLocal": true,                  // server 远程控制时拦截本机物理键鼠
    "panicHotkey": "Ctrl+Alt+Shift+Q",   // 全局逃生热键：立即交还本地控制
    "scrollUnit": 0,                     // 滚轮一格 = 多少单位；0 = 按平台自动（win 120 / 其余 1）
                                         // 仅对 XTest 后端有效；uinput 收的是「格数」
    "backend": "auto",                   // 客户端怎么注入：auto（推荐）| xtest | uinput
                                         // auto = X11 用 XTest；Wayland 且装了 dotool/ydotool 就自动改用它
    "manageYdotoold": true               // 用 ydotool 时是否由本程序管理 ydotoold 守护进程
                                         // true = 先复用已有的（含 root 系统服务），没有就自己拉起私有实例，
                                         //        退出时只关掉自己起的那个
                                         // false = 只复用，绝不自己拉起（适合你自己管守护进程）
                                         // dotool 不需要守护进程，此项对它无影响
    "capture": "auto"                    // server 端怎么读物理输入：auto（推荐）| uiohook | evdev
                                         // auto = Windows/X11 用 uiohook；Wayland 自动改用 evdev（读 /dev/input）
                                         // evdev 是 Wayland 下唯一能「鼠标在别处也照样捕获」的方式，
                                         // 但读不到光标绝对位置 —— 触发改用「连续推向某边」的手势（见下）
  },

  "clipboard": {
    "enabled": true,                     // 两端之间共享剪贴板（文本 + 图片）
    "images": true,                      // 是否也同步图片（关闭则只同步纯文本）
    "maxImageBytes": 8000000             // 单张图片上限（编码后字节）；PNG 超限会先转 JPEG
  },

  "logging": { "level": "info" },        // error|warn|info|debug

  "ui": {
    "autoStart": true,                   // 启动程序时自动运行
    "minimizeToTray": true               // 关闭窗口时最小化到托盘
  }
}
```

只写关心的字段即可，其余用默认值补齐。

### 三个容易踩的坑

> 另外还有一类坑不在这份清单里，但同样常见：**鼠标能移动，左键点了没反应 /  
> 滚轮方向不对**。移动和点击走的是**两条完全独立的代码路径**，能移动不代表点击没问题。  
> 遇到就先跑 `npm run hwtest`，它的「按键与滚轮」一段会把本机真实钩子的读数打出来。
>
> 还有一类更隐蔽：**对端完全不动，但日志看起来一切正常**。见下面「本机自检」里  
> 关于 `--injecttest` 的说明 —— 客户端的注入失败以前是被静默吞掉的。

1. **`layout.screenWidth/Height` 是「服务器」的虚拟桌面尺寸，两台机器都填服务器的值。**  
   server 用它做边缘判定；client 用它把收到的坐标换算到本机桌面。  
   现在 server 端会**自动检测**真实尺寸（Windows 走 Electron `screen` 模块，Linux 走 `xrandr`），  
   并通过 `enter` 消息把实际值告诉 client，所以这里填错也能自动纠正，只是留个兜底。
2. **`layout.edge` 是「服务器」的共享边。**  
   client 不用填：运行时 server 会把实际共享边随 `enter` 一起发过去，client 自动取反得到  
   自己的「回家边」（server 共享 `right` ⇒ client 从自己的 `left` 边把控制权还回去）。  
   这一项是「鼠标推过去没反应」最常见的原因，所以：
   - **拿不准就填 `any`**：碰到任意一条边都交出去，怎么推都能切；
   - 也可以**直接在托盘菜单里切换**（左/右/上/下/任意边），改完立刻生效并写回配置；
   - 启动日志会写明 `共享边 left 属于显示器 #1（非主屏）`；15 秒内一次都没触发，  
     还会补一句「最近一次离该边还有 Npx」并告诉你该改成什么。
   > `any` 的代价：**碰到任务栏所在的那条边也会交出去**（Windows 任务栏通常在底部）。  
   > 如果觉得误触，把它换成具体方向即可。
3. **多显示器时，`layout.monitor` 决定哪块屏的边缘触发。**  
   默认 `all` = 整个虚拟桌面的最外侧；若对端在左侧而 server 是双屏，  
   要选**具体那块屏**（例如 `0`），否则鼠标要穿过两块屏才会触发。  
   用 `all`/`primary`/索引都行；**索引会随显示器增减而变化**，想稳定就填几何签名  
   （界面里选完会写索引，但日志会打印每块屏的 `WxH+X+Y`，可手填进配置）。
    > 注意：**多屏时共享边通常不属于主屏。** 比如左边还挂一块竖屏显示器，  
    > 那么「左」这条边在竖屏的最左缘，鼠标要穿过整块竖屏才会碰到。  
   > 设置界面「屏幕布局」里会直接把每块屏的矩形和四条边的归属列出来。

### 混合缩放（不同 DPI）的显示

Win11 上两块屏缩放不同（例如主屏 200% + 副屏 125%）时，坐标系会变得很绕：  
`uiohook` 的鼠标钩子报的是**物理像素**，而 Electron 的 `Display.bounds` 是 **DIP**。  
Chromium 的 DIP 布局是**以主屏为根的树**，副屏的 DIP 原点是「父屏的 DIP 边缘」，  
不是「自己物理原点 ÷ 自己缩放」—— 所以用 `bounds * scaleFactor` 换算会在某些摆位下算错，  
让共享边落到光标**到不了的位置**，表现就是「怎么推都没反应」。


程序改用 Chromium 自己的逆运算 `screen.dipToScreenRect(null, bounds)` 换算  
（Electron 文档：`window` 为 `null` 时按 `rect` 最近的显示器缩放）。  
乘法只在老版本 Electron 没有这个 API 时兜底，并在诊断报告里标注为「估算」。

同一个程序里因此存在**两个坐标空间**，别混用：

| 用途                                   | 取值                                  | 单位                       |
| ------------------------------------ | ----------------------------------- | ------------------------ |
| 边缘判定、转发位移、光标定位                       | `platform.getScreenInfo().virtual`  | **物理像素**（与 `uiohook` 一致） |
| 窗口/遮罩尺寸（`BrowserWindow`、`setBounds`） | `platform.detectVirtualDipScreen()` | **DIP**                  |

拿物理值去设窗口，在 200% 缩放的屏上会让遮罩大一倍且位置错，多屏负原点时甚至盖不住屏幕  
（输入拦截会失效）。

**遇到「推过去没反应」，先跑一次诊断**（托盘菜单「运行诊断（含 20 秒边缘观测）…」，  
或命令行 `npm run diag`）。报告里最关键的两处：

- `DIP → 物理像素换算`：第 1 行（程序实际使用的）和第 3 行（朴素乘法）是否一致；
- 实时观测结尾的「可达范围」：把鼠标推到屏幕四个角，数字走到 0 就说明几何没问题；  
  如果提示「光标跑到了几何范围之外」，那就是几何偏小，把报告发出来即可。

**遇到「鼠标能移动，但左键点了没反应 / 滚轮不对」**：先跑自检的「按键与滚轮」那一段  
（见下），它会把本机真实钩子的读数打出来。**鼠标移动和点击是两条完全独立的代码路径**，  
能移动不代表点击没问题。

**遇到「对端完全不动」**：别只看日志。日志里那句 `returning control to server`  
**不能**证明这一侧成功了 —— 判断「该回家了」用的是我们自己累加的位置，那是纯算术，  
**注入全挂时它照样会走到边缘并正常交还**。所以判据必须是注入器自己的成功/失败计数  
（现在会打出来），以及在**客户端那台**跑一次 `--injecttest`。

> 0.2.5 之前，每一次注入失败都以 `.catch(() => {})` 结尾，于是「注入全挂」和  
> 「注入全好」在日志里**长得一模一样** —— 这是最难查的一类 bug，因为工具本身在说谎。  
> 现在失败会被计数、播报一次（带真实错误文本），交还控制时也会报「本次远程期间有 N 次注入失败」。

### 本机自检（不需要第二台机器）

「推过去没反应」其实有**三种**完全不同的可能：**本机 server 侧坏了**、  
**本机 client 侧坏了**、或者**对端 / 网络坏了**。一句症状描述分不出是哪种 ——  
下面两个自检就是用来把它们分开的。两个都在**本机**跑，都不需要第二台机器：

| 自检                  | 检验                                         | 在哪台上跑才有意义                      |
| ------------------- | ------------------------------------------ | ------------------------------ |
| `--hwtest` 边缘自检     | 几何换算、边缘判定、`enter`/`release` 交接、按键与滚轮**发出** | **服务器**（客户端上会直接拒绝）             |
| `--injecttest` 注入自检 | 本机能不能真的**驱动自己的光标 / 按键 / 滚轮**               | **客户端**（服务器也可以跑，用于验证它够不够格当客户端） |

两个都跑一遍，「哪一侧坏了」就没有歧义了。

#### 一、`--hwtest`：服务器侧（边缘 + 交接）

它用**真实的全局鼠标钩子**、**真实的物理光标**和**真实的 TCP 回环**（监听  
`127.0.0.1` 并自己连自己），做两件事：

**一、四条边各走一遍**，逐条检验：

1. 光标能不能真的到达那条边；
2. 到达时边缘判定是否准确触发（应该正好 0px）；
3. 对端是否真的收到了 `enter`（带着正确的 `vw/vh/edge`）；
4. 发 `release` 能不能交还控制。

**二、按键与滚轮**：把左/中/右键和滚轮上/下各做一次，读出**真实钩子**报上来的  
`button` 号和 `rotation`，再对照客户端会怎么映射。低层钩子分不出「物理点击」和  
「程序注入的点击」，所以这一步等价于真按了一次。典型输出：

```
按键与滚轮（真实钩子读数 → 客户端映射）
  左键   真实钩子报 button=1   映射 → pressButton(0 = LEFT)  ✓
  中键   真实钩子报 button=3   映射 → pressButton(1 = MIDDLE)  ✓
  滚轮上 真实钩子报 rotation=-1（方向 3）   映射 → scrollUp(120)  ✓
  不足一格 rotation=0   映射 → 忽略  ✓
```

跑法（三种入口，同一份代码）：

```bash
npm run hwtest                  # 四条边全测 + 按键 + 滚轮
npm run hwtest -- --edge left   # 只测一条边（仍会测按键与滚轮）
NetMouse.exe --hwtest           # 打包后的 exe 也能这么跑
```

托盘菜单「本机边缘自检（真光标走一遍四条边）…」，以及设置界面的「本机边缘自检」按钮。

**怎么读结果：**

| 结果       | 含义                                      |
| -------- | --------------------------------------- |
| 四条边都能触发  | 本机 server 侧没问题，问题在 Ubuntu 那台或网络         |
| 只有某几条能触发 | 把共享边改成能触发的那条（或 `any`）                   |
| 一条都不行    | 不是「配错方向」，是几何或钩子本身的问题，把报告发出来             |
| 按键与滚轮全绿  | 本机把按键/滚轮按客户端能识别的形式发出去了，问题在 client 的注入权限 |

> 自检会短暂接管光标（约 10 秒），跑的时候别动鼠标，结束后自动还原。  
> 它会**先暂停正在运行的服务**（否则两者抢钩子和光标），测完原样恢复。

> 自检**必须用 Electron 运行**（`npm run hwtest` 已经是）。纯 Node 下没有 `screen`  
> 模块，会退化成非 DPI 感知的 PowerShell 读数，在缩放屏上拿到的几何本身就是错的 ——  
> 而那正是它要检验的东西。所以它在纯 Node 下会直接拒绝运行，而不是给一份误导性的报告。

#### 二、`--injecttest`：客户端侧（本机能不能注入）

「对端鼠标不动」是**客户端**的问题，而上面那个自检只对服务器侧有意义 ——  
所以这里还有一个。它驱动**真正的客户端注入器**（就是客户端在用的那套代码），  
喂它真正的协议消息，再用**真正的全局钩子**看操作系统到底收到了什么：

| 喂进去                | 断言                          |
| ------------------ | --------------------------- |
| `enter` + 6 × `mm` | 真实光标有没有跟着我们驱动的目标走（偏差 ≤ 8px） |
| `md`/`mu` × 左/右/中  | 钩子有没有看到 button 1/2/3 按下与松开  |
| `wh` × −1/+1       | 钩子有没有看到一格滚轮，方向对不对           |

三项**各自独立下结论**，因为它们是三条独立代码路径。典型输出：

```
① 光标移动（走客户端真实的 enter + mm 路径）
  桌面 1920x1080@(0,0)   起点应为 (960,540)   实测 (960,540)
  驱动到 (1680,945)   实际光标 (1680,945)   偏差 0px  ✓
② 按键（走客户端真实的 md / mu 路径）
  左键  真实钩子报按下=1 松开=1  ✓
③ 滚轮（走客户端真实的 wh 路径；本机一格 = 1 个单位）
  滚轮向上  真实钩子报 rotation=-1（方向 3）  ✓

结论
  ✓ 光标、按键、滚轮三项全部通过。
```

跑法：

```bash
npm run injecttest                  # 约 5 秒
NetMouse.exe --injecttest           # 打包后的 exe 也能这么跑
NetMouse --injecttest --out r.txt   # 指定报告路径
```

托盘菜单「本机注入自检…」，以及设置界面客户端卡片里的「本机注入自检」按钮。

**怎么读结果：**

| 结果         | 含义                                                  |
| ---------- | --------------------------------------------------- |
| 三项全绿       | 本机作为客户端没问题 → 问题在服务器那台或网络，去那边跑 `--hwtest`            |
| **光标一项就红** | 本机驱动不了自己的光标，对端更不可能被驱动 —— **这就是「Ubuntu 上鼠标不动」的直接原因** |
| 只有按键红      | 光标能动但按键不动，是按键注入被拒                                   |
| 只有滚轮红      | 方向反了就用 `input.scrollUnit` 调（见配置项）                   |

报告里还会给出**注入器自己统计的成功/失败次数和真实错误文本**。Linux 上按这个顺序查：

1. **会话是不是 Wayland** —— 这是最常见的那个，且**日志完全看不出异常**。  
   报告开头会打印实际选中的后端；若写着  
   `结论不可用：Wayland 会话 + XTest 后端`，说明 uinput 工具没装成。  
   详见上面的 **「Wayland 会话」** 一节：要么改用 Xorg 会话，要么装 dotool / ydotool。
2. 是不是在 SSH / 非图形环境下启动的（没有 `DISPLAY`）。
3. X11 库是否齐全（`libx11-6 libxtst6 libxt6 libxrandr2`）—— `node src/doctor.js` 逐项检查。
4. 用 uinput 后端时：`/dev/uinput` 是否可写（`sudo usermod -aG input $USER` 后要**重新登录**）。

> 自检会短暂接管光标（约 5 秒），**跑之前先把手离开鼠标**，结束后自动还原。  
> 它也会**先暂停正在运行的服务**，测完原样恢复。

### 配置文件的存放位置

按以下顺序取第一个存在的文件：

1. 环境变量 `NETMOUSE_CONFIG` 指定的路径
2. **便携版 / AppImage**：可执行文件所在目录  
   （`NETMOUSE_PORTABLE_DIR`，或 `PORTABLE_EXECUTABLE_DIR`，或 `.AppImage` 文件旁边）
3. 用户数据目录（`%APPDATA%\NetMouse\config.json` / `~/.config/NetMouse/config.json`）
4. 程序同目录（`NetMouse.exe` 旁边）
5. `<resources>/config.json`
6. 打进 asar 的默认副本（兜底）

保存时会写回「读到的那个文件」——前提是它可写；如果不可写  
（Linux deb 安装到 `/opt`、Windows 装到 Program Files），  
自动改写到用户数据目录。界面上「配置文件」一栏会直接显示实际路径，  
便携版还会带一个「免安装 · 便携版」标记。

**便携版**：第一次运行会在 exe 旁边自动生成 `config.json`（内容取自内置默认值）。  
之后界面里保存的参数都写这个文件，整个文件夹拷到别的机器就能直接用。  
如果 exe 放在只读目录（例如 Program Files），会自动改用用户数据目录。

> 注意（仅安装版）：升级重装会用安装包里的默认 `config.json` 覆盖程序目录那份，  
> 升级前先备份；便携版没有这个问题，配置就在你自己那个文件夹里。

## 图形界面

- 角色 / 端口 / 对端地址密码 / 共享边缘 / 分辨率 / 显示器 / 日志级别 / 自启动，全部可视化编辑
- 共享边缘用九宫格点选，直观；**「任意边都触发」**&#x6309;钮专治「不知道对端在哪一侧」。  
  服务器运行中时点一下**立即生效**（不用保存重启），点保存则持久化
- 「检测本机多屏布局」一键填入虚拟桌面尺寸，并刷新「触发边缘的显示器」下拉  
  （**服务器端填 server 的值**，见上面的坑）
- **屏幕布局表**：列出每块屏的物理矩形、缩放比，以及四条边分别属于哪块屏 ——  
  多屏时一眼看出「共享边其实在副屏上」
- **运行诊断并生成报告**按钮（含实时边缘观测）
- **生成诊断包**按钮 + **含实时自检**勾选：一键打成 zip（详见「一键诊断包」一节）
- **本机边缘自检**按钮：用真光标把四条边各走一遍，不需要第二台机器
- **本机注入自检**按钮（客户端卡片里）：检验本机能不能真的驱动自己的光标/按键/滚轮 ——  
  「对端鼠标不动」先在本机跑这个
- **剪贴板**开关 + **同步图片**勾选 + **图片上限(MB)** 输入框；下面那行提示会说明  
  「本机后端能不能读图、当前会不会推图片」
- **输入拦截**开关 + **逃生热键**设置
- 实时状态：运行中 / 已停止、对端连接状态、当前是本地还是远程控制、**当前共享边**、  
  **本机是否已拦截**
- 实时日志（带环形缓冲，打开界面能看到之前的记录）
- 环境提示：Wayland / 缺 DISPLAY / 缺 xdotool 会直接警告
- **本机平台卡片**：顶部显示本机平台（如 `Windows x64`），下面按平台列出七项关键事实  
  （屏幕几何来源 / 缩放·高DPI / 输入注入方式 / 滚轮一格单位 / 额外运行时依赖 /  
  沙箱 / 会话类型）。非本机那一块会打上「（非本机，仅供参考）」角标，  
  也可以勾「只看本机」把它整块收起来
- **Windows / Linux 差异对照表**：8 行并排对比，**本机那一列高亮**，  
  省得对着另一台平台的说明去填本机配置
- 每个卡片标题旁有 `仅服务器` / `仅客户端` / `两端都要` 小标签 ——  
  「共享边」只有 server 有意义、「滚轮单位」只有 client 有意义，别在错的那台上改
- 滚轮单位输入框下面会把「0 = 按平台自动」展开成本机的实际值  
  （例如「本机（Windows）自动值是 120」）
- **「输入采集方式」下拉**（服务器卡片里）：`自动` / `uiohook` / `evdev`。  
  下面那行提示会说明本机现在会选什么、为什么 —— 例如「本机是 Wayland：用 evdev  
  直接读 /dev/input，触发方式改为『推向某边』」。默认 `自动` 就够了
- **「输入注入方式」下拉**（客户端卡片里）：`自动` / `XTest` / `uinput`。  
  下面那行提示会直接说明**本机现在会选什么、为什么** ——  
  例如「本机是 Wayland 会话，且没找到 dotool / ydotool：客户端注入不会生效」。  
  默认 `自动` 就够了：会话类型程序自己看得出来，不用你去填
- 托盘菜单：打开设置、启动、停止、重启、**共享边切换（左/右/上/下/任意边）**、  
  **运行诊断…**、**交还本地控制**、打开配置文件、退出

## 输入拦截与剪贴板

### 输入拦截（server 端）

远程控制期间，物理鼠标/键盘不应该再点到 server 自己的窗口。真正的「吞事件」需要  
OS 级低级钩子（要原生编译，本仓库不引入），所以这里用 Electron 能做的方式：

**一层覆盖整个虚拟桌面的无边框、透明、置顶窗口**。它是最顶层窗口，  
指针输入落在它身上并被丢弃，不会传给用户原本在用的程序；键盘焦点尽力争取  
（Windows 上 `SetForegroundWindow` 有限制，但遮罩一旦被点到就会拿到焦点）。

- 真实事件仍然由全局 uiohook 钩子捕获并转发给对端，**不会丢**
- 遮罩只在「已捕获 + 有对端」时出现，停止节点 / 对端断开 / 逃生热键都会立刻解除
- 关掉 `input.blockLocal` 就回到旧行为

> ⚠️ 遮罩会挡住整个屏幕。**逃生热键**（默认 `Ctrl+Alt+Shift+Q`）由全局钩子读取，  
> 不受焦点影响，按下即刻交还本地控制并解除遮罩。托盘菜单和设置窗口里也有  
> 「交还本地控制」按钮。

### 剪贴板共享

两端之间同步剪贴板（`clipboard.enabled`，默认开）：**纯文本**和**图片**。

**文本**：

- 任一端复制文本，另一端立刻同步；带回声抑制，不会来回弹
- 超过 1 MB 的文本不同步
- 只在连接建立期间工作，断线自动停

**图片**（`clipboard.images`，默认开）：

- 复制一张图片（截图、右键「复制图像」、相册里一张照片……），对端剪贴板里就会出现同一张图
- **你复制的图片格式不受限制**：JPG、PNG、WebP、BMP、GIF（首帧）、系统截图都行 ——  
  剪贴板给出的是一张**位图**，程序读的是像素，发出去之前再统一编码
- **传输格式有两种，自动选**：先编 PNG（无损），PNG 塞不进上限就改编 JPEG 并把质量逐级降下去，
  最低 q60 还超才丢弃。这样截图/图表仍然无损，而一张手机照片（2400×1800 存 PNG 约 **12.4 MB**、
  转 JPEG q92 只要 **3.6 MB**）不会再被整张丢掉
- 单张上限 `clipboard.maxImageBytes`（默认 8 MB，按**编码后**的字节算），超过只跳过图片、文本照常
- **文本优先**：浏览器「复制图片」时往往**同时**往剪贴板塞文本和位图，此时按文本处理  
  （否则粘出来会莫名其妙变成一张图）
- **能力协商**：`hello` / `ok` 握手时各自声明 `caps` —— `img` 表示懂图片，`jpg` 表示懂 JPEG。  
  只有对端声明了 `img` 才推图片；只有声明了 `jpg` 才会用 JPEG 兜底（0.2.8–0.2.11 懂图片但只懂 PNG，
  给它们发 JPEG 会白传一趟再被丢掉）。老版本（没有 `caps`）自动退回纯文本，**协议字节级向后兼容**
- **去重按解码后的像素**，不是按编码文件字节：Electron 的 `clipboard.readImage()`  
  会把位图**重新编码**一次（同一张图，读回来的字节和写进去的不一样），  
  所以若拿编码字节做去重键，两端会**无限互推同一张图**。改成对解码后的位图算 SHA-256  
  即可稳定去重 —— 这是用真 Electron 探针才发现的坑，单测里专门造了个「会重编码」的假后端钉住它。  
  JPEG 是有损的，但键是**各端算自己的位图**，所以照样稳定（已用真 Electron 探针确认
  「解码出来的键 == 写进剪贴板再读回来的键」对 PNG / JPEG 都成立）
- 轮询有成本，所以**不是每个 tick 都读图**：每 3 个 tick 读一次图（文本每 tick 都读），  
  且只在真的要发出去时才编码（`toPNG()` 在 1920×1080 上约 103ms，而读位图算哈希只要几毫秒）

## 打包

```bash
npm run build:win              # 免安装：portable exe + zip -> dist/
npm run build:win:installer    # 需要时才打 NSIS 安装包 -> dist/
npm run build:linux            # AppImage（免安装）+ deb -> dist/   【必须在 Linux 上跑】
npm run build:linux:portable   # 免安装：tar.gz 绿色包 + 单文件 .run -> dist/
npm run build:src              # 源码包 netmouse-src-<version>.zip（放到项目上一级目录）
```

产物：

| 文件                                      | 说明                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NetMouse-<version>-portable-x64.exe`   | Windows **单文件免安装**，双击即用，首次运行在自身旁边生成 `config.json`                                                      |
| `NetMouse-<version>-win-x64.zip`        | Windows 绿色压缩包，解压后运行 `NetMouse.exe`，配置就在同目录                                                             |
| `NetMouse-<version>-setup-x64.exe`      | NSIS 安装包（`build:win:installer`），会写入开始菜单/桌面快捷方式                                                         |
| `NetMouse-<version>-linux-x64.run`      | Linux **单文件免安装**。首次运行解压到旁边的 `.netmouse/`，并提示跑一次 `install-linux.sh` 生成双击启动器                             |
| `NetMouse-<version>-linux-x64.tar.gz`   | Linux 绿色包。解压后跑 `./install-linux.sh` 生成双击启动器（或直接 `./netmouse.sh`）                                       |
| `NetMouse-<version>-linux-x64.AppImage` | Linux 单文件免安装（需在 Linux 上打包），配置放在 `.AppImage` 旁边                                                         |
| `netmouse-src-<version>.zip`            | **源码包**：`src/ test/ build/ docs/ scripts/` + 配置文件，不含 `node_modules`/`dist`。解压后 `npm i && npm start` 即可 |

`build:src` 会把可执行位一起写进 zip（`build/netmouse.sh`、`run-linux.sh` 需要），
并用固定时间戳，所以同一份源码打两次得到字节一致的包。

> **注意 Windows 上没有 Unix 执行位。** 如果归档时直接抄 `os.stat().st_mode`，  
> 在 Windows 上打出的源码包里 `.sh` 会是 `0o666`，解压到 Ubuntu 后  
> `./run-linux.sh` 报 `Permission denied`；而 Git Bash 的 `ls -l` 会**假装**显示
> `rwxr-xr-x`，肉眼看不出来。所以归档脚本改成显式决定模式：  
> POSIX 上保留真实模式，Windows 上按规则合成（`.sh` → `0755`，其余 → `0644`）。  
> `python3 scripts/verify-linux-portable.py` 会直接读 zip 的 `external_attr` 断言这一点。

两个原生依赖（`uiohook-napi`、`@nut-tree-fork/nut-js`）都自带各平台预编译二进制，  
打包时**不需要**本机编译环境（已设 `npmRebuild: false`），也正因如此  
**可以在 Windows 上交叉打出 Linux 的 tar.gz / .run**。

### 为什么 AppImage 必须在 Linux 上打

AppImage 目标要调用 `mksquashfs`，而它是 Linux ELF 可执行文件，在 Windows 上  
直接 `Exec format error`；electron-builder 自己也会在解压 `appimage-12.0.1.7z` 时  
因为包里的符号链接报 `Cannot create symbolic link`。


所以在 Ubuntu 上执行一次即可（会自动下 Electron 的 linux-x64 包）：

```bash
npm run build:linux            # AppImage + deb
npm run build:linux:appimage   # 只要 AppImage
```

`build:linux:portable` 则是跨平台可用的替代方案：它让 electron-builder 只产出  
`--linux dir` 目录，再由 `scripts/package-linux-portable.py` 归档。  
之所以要自己归档，是因为**从 Windows 打 tar 包时没有 Unix 权限位**，  
所有文件都会变成 0644 —— 包括 `netmouse` 和需要 setuid 的 `chrome-sandbox`。  
脚本会显式写回正确模式（`netmouse` 755、`chrome-sandbox` 4755）。  
校验脚本：`python3 scripts/verify-linux-portable.py`。

在 Linux 上交叉打包 Windows 需要 wine。**建议在各自平台上打包。**

> Windows 上首次打包如果报  
> `Cannot create symbolic link ... libcrypto.dylib`，  
> 是 `winCodeSign` 压缩包里两个 macOS 符号链接解不开（非管理员/未开开发者模式）。  
> 把已解压出来的目录改名成  
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` 即可绕过。

### Linux 上怎么做到「双击就能运行」

Windows 是一个 `.exe`：下载、双击、完事。Linux 的绿色包**没有**完全等价的东西，  
原因值得知道：

- **Nautilus（GNOME 文件管理器）刻意不执行它判定为「文本」的文件**，而 `.sh` / `.run`  
  正是文本 —— 双击只会打开编辑器。这是安全设计，不是 bug。所以  
  「双击 netmouse.sh」在 GNOME 上**永远**不会像 Windows 那样工作。
- Linux 上「双击就能运行的程序」的**正规形式是 `.desktop` 启动器**：  
  文件管理器和应用菜单都认识它。

所以便携包里带了一个 `install-linux.sh`，跑一次即可：

```bash
./install-linux.sh              # 应用菜单 + 桌面图标
./install-linux.sh --no-desktop # 只在应用菜单里
sudo ./install-linux.sh --uinput  # 顺便装 /dev/uinput 的 udev 规则（Wayland 注入需要）
./install-linux.sh --uninstall  # 删掉启动器和 udev 规则
```

它做四件事：用**绝对路径**写出 `~/.local/share/applications/NetMouse.desktop`，  
拷一份到桌面，`chmod +x` 并用 `gio set metadata::trusted true` 标记为受信任  
（GNOME 不信任的 `.desktop` 会弹「未受信任的启动器」，需要右键「允许启动」），  
再刷新 `update-desktop-database`。之后就是双击图标，和 Windows 一样。

> **换目录要重跑一次。** 启动器里存的是绝对路径，把文件夹挪走或拷到另一台机器后，  
> 重新执行一次 `./install-linux.sh` 即可。

**想要「单文件、chmod +x、双击」的形态就用 AppImage** —— 它是个二进制文件，  
不受「不执行文本文件」的限制，最接近 Windows 的 portable exe。但它必须在 Linux 上打  
（见上一节），并且 Ubuntu 24.04+ 需要 `sudo apt install libfuse2t64`  
（没有 FUSE 时可以 `./NetMouse-*.AppImage --appimage-extract-and-run`）。

在 KDE / XFCE 等允许直接执行脚本的文件管理器上，双击 `netmouse.sh` 本来就能跑，  
`install-linux.sh` 只是让 GNOME 也一样。

## 验证 / 自检

```bash
npm test                             # 十二块：纯函数 + 混合缩放几何 + 按键/滚轮契约 + 注入健康 + 剪贴板 + evdev 采集 + 诊断包 + uinput 后端 + ydotoold 守护进程 + 界面一致性 + 自检数学 + 端到端回环
npm run test:ydotoold                # 只跑守护进程管理那一块
npm run test:clipboard               # 只跑剪贴板（文本/图片/能力协商）
npm run test:capture                 # 只跑 evdev 采集后端
npm run test:diagbundle              # 只跑一键诊断包
npm run diag                         # 生成诊断报告（含实时边缘观测）
npm run diag:live                    # 同上，命令行版
node src/doctor.js --inject --hook   # 本机体检：能否当 server / client
./NetMouse --doctor                  # 同上，但用成品包（Windows: NetMouse.exe --doctor）
./NetMouse --diagbundle              # 一键诊断包：把上面这些结果打成一个 zip
python3 scripts/verify-linux-portable.py   # 校验 Linux 便携产物（权限位/ELF/脚本语法）
```

`npm test` 分十二块：

1. **`selftest`** —— 键位映射、热键解析、xrandr 解析、坐标换算等纯函数。
2. **`test/platform-dpi.js`** —— 伪造 Electron 的 `screen`，构造「200% 主屏 + 125% 副屏」  
   的混合缩放桌面，断言物理矩形来自 `dipToScreenRect` 而**不是**朴素的 `bounds * scaleFactor`，  
   以及虚拟桌面是真实包围盒而不是被算小的那个。
3. **`test/input-units.js`** —— 按键与滚轮的契约，**直接读真 nut-js 的枚举值**  
   （不是替身）。它断言 `Button.LEFT === 0`，并证明「真值判断会丢掉左键、  
   `!== null` 判断不会」；以及滚轮 `rotation` 的符号、格数、0 值语义与平台单位换算。  
   这个文件存在的唯一理由是：左键失效这个 bug 其它测试全都抓不到。
4. **`test/injecttest-units.js`** —— 注入自检的纯函数（`motionPlan` / `motionVerdict`），  
   以及**行为级**的注入健康契约：把 `setPosition` 换成会 reject 的实现，断言失败被计数、  
   被播报（且只播报一次）、真实错误文本在里面。它存在的理由是：注入失败曾经被  
   `.catch(() => {})` 吞掉，于是「注入全挂」和「注入全好」在日志里长得一模一样。
5. **`test/clipboard-units.js`**（45 项）—— 剪贴板（文本 + 图片）。钉住的是几件容易出错的事：  
   同一张图**只发一次**、不同图会发、能力协商（对端没声明 `img` 就退回纯文本、没声明 `jpg` 就不用 JPEG）、  
   收到不合规消息（非 PNG/JPEG / 超限 / 坏图 / 标签与载荷不符）时的处理，  
   **PNG 够小就不碰 JPEG、超限才按质量阶梯降到第一个塞得进去的档**，以及最关键的那条 ——  
   **用「会重编码」的假后端证明按字节去重会回声、按像素去重不会**。  
   它存在的理由是：Electron 读剪贴板会重新编码，按字节去重会让两台机器无限互推同一张图。
6. **`test/capture-units.js`** —— evdev 采集后端（Wayland 原生）。`struct input_event`  
   在 64 位进程是 24 字节、32 位是 16 字节，这里断言两种都能解；断言**一次物理报告**  
   （一串事件 + `SYN_REPORT`）被合成**一帧**，所以斜向拖拽是斜线而不是阶梯；  
   断言 `REL_WHEEL_HI_RES` 被忽略（高分辨率滚轮会同时报 `REL_WHEEL=1` 和  
   `REL_WHEEL_HI_RES=120`，两个都算会一格滚 121 格）、`EV_ABS` 被忽略、自动重复被丢；  
   还断言**我们自己的虚拟设备被过滤**（否则注入的位移会被当成用户输入读回来）、  
   以及后端选择与回退时**要打印原因**。传输层用假 `readdir`/`readFile`，不需要 Linux。
7. **`test/diagbundle-units.js`** —— 一键诊断包。它用一个**独立的 ZIP 读回器**  
   （不复用写包的那份代码）反解生成的 zip：断言 CRC-32 向量、UTF-8 名称标志、  
   该存则存该压则压、README 排在第一个、**清单把自己也列进去且字节数与真实目录一致**、  
   以及一条硬规则 —— **包里任何条目、任何编码下都不能出现密码明文**（含解压后）。
8. **`test/uinput-units.js`** —— uinput 后端的**命令语言**与**后端选择**。它逐条断言  
   dotool / ydotool 的确切命令行（错一个词，工具就会静默什么都不做，看起来和要修的 bug 一模一样）、  
   三套并存且互不相同的鼠标按键编号（uiohook / nut-js / 各工具自己的）、  
   以及「uiohook 的键码 == 内核 `KEY_*` 码」这个**不变量** —— 整个键盘映射不靠表就靠它。  
   传输层用假 `spawn` 测试，所以不需要装任何工具、也不需要 Linux。
9. **`test/ydotoold-units.js`** —— `ydotoold` 守护进程管理。ydotool 是纯客户端，  
   守护进程没跑时**每次调用都 exit 2、什么都不发生**（这正是真实联调遇到的那条  
   `ydotool mousemove ... -> exit 2`）。这个文件钉住的是几件从 Windows 上看不见的事：  
   socket 路径怎么选（含 `sockaddr_un` 的 108 字节上限）、  
   **「socket 文件存在 ≠ 守护进程活着」**（崩溃的守护进程会把文件留下）、  
   **探测只能让真客户端去问**（socket 是 `SOCK_DGRAM`，`net.connect()` 建的是  
   `SOCK_STREAM`，内核必然回 `EPROTOTYPE` —— 这就是 0.2.8～0.2.10「守护进程明明活着，  
   却报 socket 没出现」的根因）、  
   **别人启动的守护进程只能复用、绝不能杀**、**自己启动又用不上的必须杀掉**、  
   以及「`/dev/uinput` 没权限」和「这个二进制太旧不认 `--socket-path`」是**两种不同的  
   故障、两种不同的修法**。`/dev/uinput` 的三种权限形态（不在组里 / 在组里但当前会话  
   没生效 / 在组里但 udev 没给组写权限）也各有断言 —— 中间那种是最坑的，  
   提示必须说「注销重登」而不是「再跑一次 usermod」。
10. **`test/ui-check.js`** —— 界面的静态一致性校验（纯文本解析，不需要 Electron）：  
   `renderer.js` 里出现的每个 `$("id")` 都必须在 `index.html` 里真的存在、  
   平台卡片 / 差异对照表 / 滚轮单位提示 / 注入后端下拉 / 守护进程开关 / 注入自检按钮的元素都在、`collect()` 真的会把  
   `scrollUnit`、`backend` 与 `manageYdotoold` 发出去而 `fillForm()` 真的会读回来、以及每个新 CSS 类都在 `style.css`  
   里有定义。界面改坏了会在 `npm test` 里立刻红掉。
11. **`test/hwtest-units.js`** —— 自检脚本自身的瞄准/测距数学。自检会在一台  
   无法调试的机器上给出结论，所以它自己的数学必须先被钉死。
12. **`test/e2e.js`** —— 真起两个进程（一个 server 角色、一个 client 角色），走**真实 TCP**，  
   只把原生输入层换成可控替身。三个场景：

| 场景              | 断言重点                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| 单屏 `edge=right` | 远离边缘不切 → 贴边才切 → 相对位移转发并在对端注入 → **左/右/中键与滚轮（用真实钩子的取值）** → 跨边界拖拽后按键不粘住 → 移回对端朝向 server 的边 → 交还控制 → 不抖动、可再次捕获 |
| 单屏 `edge=any`   | 往**左**推也能交接；server 报告实际用的是 `left`；client 从**右边**回家                                                         |
| 双屏 `edge=left`  | **主屏自己的左缘不能触发**；必须到虚拟桌面的真实左缘才触发（用户场景的直接回归测试）                                                               |

对端故意设成**不同分辨率**（server 1920×1080 / client 2560×1440），  
所以通过即证明位移换算与分辨率无关。

`doctor` 在目标机上逐项检查：X11 会话、原生模块、X11 库、xdotool、屏幕几何、  
**客户端侧注入后端 / `/dev/uinput` 权限 / ydotoold 状态**，  
以及（`--hook`）全局钩子、（`--inject`）注入是否真能动光标；缺什么直接给 `apt` 命令。

> **打包后的程序也能跑它**：`./NetMouse --doctor`（`--hwtest` / `--injecttest` 同理）。  
> 在这之前 doctor 只能 `node src/doctor.js` 跑 —— 也就是说，一个下载了成品包的用户  
> 反而跑不了那个最能解释「为什么这台机器不工作」的诊断。

`diag` 生成一份可直接看的报告：原始显示器列表、**两种 DIP→物理像素换算并排对比**、  
解析出的几何与各边归属、光标在 DIP / 物理 / 注入三种坐标空间下的位置，  
以及一段实时观测（每秒打印光标到四条边的距离，让你把鼠标推到四个角验证）。  
报告写在配置文件旁边，托盘菜单里点一下会自动打开。

> 命令行跑 `diag` 前如果 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node，  
> 拿不到 `screen` 模块。程序会直接提示，`unset ELECTRON_RUN_AS_NODE` 再跑即可。

### 一键诊断包

「你把报告发给我看看」在双机联调里很常见，但让人**手工凑一堆文件**既麻烦又容易漏。  
所以有一个命令（`--diagbundle`）把该看的都收进**一个 zip**：

```bash
./NetMouse --diagbundle            # 打包到配置文件旁边：netmouse-diag-<时间戳>.zip
./NetMouse --diagbundle --no-live  # 跳过两个会接管光标的实时自检（SSH / 无人值守时用）
```

包里是这些（每个都标注了「这一项为什么在这里」）：

| 条目                     | 内容                                                     |
| ---------------------- | ------------------------------------------------------ |
| `README.txt`           | **排在第一个**：列出包内所有文件、每份是什么、怎么看                            |
| `manifest.json`        | 清单：每个文件的名字与字节数（**包括它自己**）                              |
| `config.json`          | 本机配置，**密码已隐藏**                                         |
| `doctor.txt`           | `--doctor` 的完整文本输出（会话/库/钩子/注入/uinput/ydotoold/采集后端）     |
| `hwtest.txt`           | 服务器侧边缘自检报告（`--no-live` 时不生成）                            |
| `injecttest.txt`       | 客户端侧注入自检报告（`--no-live` 时不生成）                            |
| `platform.txt` / `env.txt` | 平台事实与相关环境变量                                          |
| `log.txt`              | 程序日志（环形缓冲里的那一段）                                        |

三条设计规则：

- **密码绝不出这台机器。** `peer.password` 被替换成 `__已隐藏__（原长 N 字符）` ——  
  **长度保留**是有意的：联调里「两端密码长度不一样」是常见的握手失败原因，  
  光看长度就能安全地确认这件事，而不必知道密码本身。路径里的家目录会折叠成 `~`  
  （路径本身有用，但不必暴露系统用户名）。
- **某一项失败不会让整包失败。** 每个子项（体检、自检…）跑挂时，把**失败信息本身**  
  写成一个文件放进包里 —— 因为「某项跑不起来」恰恰是最该被看到的信息。
- **不引入新依赖。** 项目只发预编译包、不带编译器，所以 zip 是仓库里一个约 80 行的  
  纯 Node 写包器（自己算 CRC-32、自己写中央目录），单测用一个**独立的读包器**反解验证。

托盘菜单里也有「生成诊断包…」一项，点一下会打完并自动打开所在目录。

## Wayland 会话：为什么「日志正常，鼠标就是不动」

**这一节请优先看。** 症状长这样：

- 两台 Windows 之间一切正常；Windows ↔ Ubuntu 之间**鼠标不动、点了也没反应**。
- 两端日志都**干干净净**：`captured -> forwarding to peer`、`local desktop detected`、  
  `returning control to server` 都在，**一条错误都没有**。
- Ubuntu 那边启动时会打印：`环境: Wayland 会话，当前通过 Xwayland 工作（DISPLAY=:0）`。

### 原因

注入走的是 libnut，在 Linux 上就是 **XTest** —— 一个 **X11 协议**。而

- Xwayland **实现了 XTest 扩展**，所以每一次调用**都返回成功**：不抛异常、不 reject，  
  连 `.catch` 都不会触发；
- 但 Xwayland 只是合成器的一个客户端。它合成出来的事件**只送给 X11（Xwayland）客户端**，  
  原生 Wayland 应用收不到；**指针 warp 也不会被合成器采纳**，你看到的光标一动不动。

于是「注入全挂」和「注入全好」在日志里**长得一模一样**。  
（顺带一提，捕获和注入是两回事：Wayland 下**捕获**靠 Xwayland 能用，**注入**不能。  
所以「客户端日志正常但鼠标不动」不是玄学，是必然。）

### 两个解法

**解法一（推荐）：装一个 uinput 工具，留在 Wayland。**

uinput 是**内核**模块：在它下面建一个虚拟输入设备，合成器就会当成一只真鼠标、  
一个真键盘。Wayland、X11、纯文本终端都能用，因为压根不经过显示服务器。  
建这个设备需要对 `/dev/uinput` 做 `ioctl()`，Node 做不了（本项目只发预编译包、不带编译器），  
所以驱动现成的工具：

| 工具               | 安装                            | 移动 | 按键 | 滚轮        | 键盘 | 守护进程            |
| ---------------- | ----------------------------- | -- | -- | --------- | -- | --------------- |
| **`dotool`**（首选） | 见下（需源码装一次）                    | ✓  | ✓  | **✓**     | ✓  | 不需要（自己持有设备）     |
| `ydotool`（兜底）    | **随程序附带**（也可 `apt install`）  | ✓  | ✓  | **✓**（走 `bin/wheel.py`） | ✓  | **需要，由本程序自动拉起** |

**0.2.11 起 `ydotool` 与 `ydotoold` 随程序附带**（`resources/bin/`），不用 `apt install`，
只需要给一次 `/dev/uinput` 权限：

```bash
sudo ./install-linux.sh --uinput     # 装 udev 规则；或 sudo usermod -aG input $USER 后注销重登
```

系统里装了 ydotool 也**不冲突**：**有系统版就优先用系统版**。附带的那两个是按 glibc 2.34
编的，Ubuntu 20.04 / Debian 11（glibc 2.31）上加载不了 —— 附带是「本来什么都没有」时的兜底，
不是升级，所以绝不能盖掉一个已经能用的。`--doctor` 会打印实际用的是哪一个。

`ydotool` 官方 manpage 里只有 `type` / `key` / `mousemove` / `click` / `stdin`，**没有滚轮**。
滚轮由附带的 `bin/wheel.py` 直接往 `/dev/uinput` 写 `REL_WHEEL` / `REL_HWHEEL` 实现，
所以需要系统里有 `python3`（Ubuntu 桌面版默认自带；缺了只有滚轮不可用，移动/点击/键盘不受影响）。

**`ydotoold` 守护进程由 NetMouse 自己管理，你不需要配置任何 systemd 服务。** 启动时它按顺序：

1. `YDOTOOL_SOCKET` 指向一个**能应答**的 socket（`ydotool debug` 退出码 0）→ 用它（明确的指示，不碰别的）；
2. 否则探测 `$XDG_RUNTIME_DIR/.ydotool_socket`、`/tmp/.ydotool_socket`。  
   **已经在跑的守护进程会被复用而不是被顶掉** —— 包括 ydotool 自己的**系统服务**  
   （那种以 root 运行，因此**完全不需要**把用户加进 `input` 组，多用户机器上更干净）；
3. 都没有就自己拉起一个**私有 socket** 的实例（`.netmouse-ydotoold-<pid>.sock`），  
   退出时关掉。私有是刻意的：两个 NetMouse 实例、或你和别的工具之间不会互相抢。

两个细节值得说：

- **探测不能用 `net.connect()`。** `ydotoold` 的 socket 是 **`SOCK_DGRAM`**，Node 的
  `net.connect()` 建的是 `SOCK_STREAM`，内核直接回 `EPROTOTYPE: Protocol wrong type for socket`。
  结果就是「守护进程明明活着，探测却永远说没有」，等 3 秒后还把一个**能用**的守护进程杀掉 ——
  0.2.9 就栽在这上面：日志、报告全说「socket 没出现」，其实什么都没坏。
  现在改成让真客户端去问：**`ydotool debug` 退出码为 0 才算活着**。
  （「socket 文件存在」同样不等于「活着」：崩溃的守护进程会把文件留在原地，复用它会得到
  「每次调用都 exit 2」——所以必须真问一次，问不通就自己拉一个。）
- **只杀自己拉起的那个。** 复用的守护进程属于启动它的人（可能是共享的 root 服务），  
  关掉 NetMouse 不会动它。

`input.manageYdotoold: false` 可以关掉「自动拉起」，只复用不自己起。

`dotool` 不在 Ubuntu/Debian 官方源里，装一次大概这样：

```bash
sudo apt install -y gcc golang libxkbcommon-dev scdoc
git clone https://git.sr.ht/~geb/dotool && cd dotool
./build.sh && sudo ./build.sh install
sudo udevadm control --reload && sudo udevadm trigger
sudo usermod -aG input $USER      # 然后注销重新登录，权限才生效
```

装好之后 **`input.backend` 保持 `auto` 就行**：程序检测到 Wayland 会话且有 uinput 工具，  
会自己切过去，并在日志里打印 `输入后端：uinput（dotool）—— Wayland 会话（XTest 在此无效）`，  
紧跟着一行 `ydotoold：…`。界面「客户端设置」卡片里也能看到当前会选什么、为什么，  
以及守护进程是「复用外部」还是「自行拉起」。

**解法二（如果你的发行版还提供 Xorg 会话）：改用 Xorg。**

注销，在登录界面点右下角**齿轮**，选 **“Ubuntu on Xorg”**，重新登录。零安装。  
**但注意：GNOME 50（Ubuntu 26.04）起已不再提供 Xorg 会话** —— 在那种机器上这个选项  
根本不存在（本项目测试的 Linux 工作站使用纯 Wayland，没有 Xorg 可选），
所以 uinput 才是唯一的通用解法。

> **为什么不做成「模式开关」？** 会话类型是程序自己能看出来的东西（`XDG_SESSION_TYPE`），  
> 让用户去回答一个程序已经知道答案的问题，只会多出一种配错的组合。  
> 所以 `auto` 是默认值，`xtest` / `uinput` 只是留给「自动选错了」时的兜底。

### 捕获侧：Wayland 下读不到光标位置

注入是 client 的事，**捕获**是 server 的事。Wayland 下捕获原本靠 uiohook（走 Xwayland）  
勉强能用，但有个要命的前提：**只有当某个 X11 窗口有焦点时**它才收得到事件。  
用户一碰原生 Wayland 应用，server 就瞎了 —— 表现为「明明在推鼠标，对端却不动」。

0.2.8 加了 **evdev 采集后端**：直接读内核的 `/dev/input/event*`，不经过任何显示服务器，  
所以**鼠标在哪个窗口上都照样捕获**。`input.capture` 默认 `auto`：  
Windows / X11 用 uiohook，**Wayland 自动切 evdev**。两件事必须知道：

- **evdev 读不到光标的绝对位置。** Wayland 出于安全**刻意不暴露**指针坐标，  
  只给相对位移。所以 server 端的「光标在哪」是**自己积分出来的**（从一个锚点累加位移）。  
  既然读不到位置，「推到屏幕边缘」这个判据就失效了 —— 于是**触发方式改成手势**：  
  **持续朝某一边推**（累计约屏短边的 35%，至少 200px）就交出去。  
  好处是顺带干掉了整套「回中」逻辑（`jumpLimit` / `recenterCursor`）——  
  物理光标从不被挪动，也就不会被屏幕边缘夹住。
- **权限和 uinput 是同一套。** `/dev/uinput`（注入）和 `/dev/input/event*`（采集）  
  都在 `input` 组，所以 `sudo ./install-linux.sh --uinput` 这一步**一次修好两件事**，  
  之后注销重登一次即可。跑 `./NetMouse --doctor` 会打印 `N/M /dev/input 可读`。

> **兜底优先于报错。** 首选后端起不来时会自动换另一个，并在日志里**大声说明为什么** ——  
> 因为「完全没有捕获」比「用错后端」更糟：后者至少还能动，只是有前提。  
> 例如 Wayland 上 evdev 失败回退到 uiohook，日志会写明「只在 X11 窗口有焦点时有效」。

### 验证

在 Ubuntu 那台跑：

```bash
./NetMouse --injecttest
```

报告开头会打印**实际选中的后端与能力**，用 ydotool 时还会多一行 `ydotoold：…`  
（复用外部 / 自行拉起 / 启动失败，失败时连同修法一起打印）。三种结果：

- 显示 `xtest` 且会话是 Wayland → 报告会直接标成  
  **「结论不可用：Wayland 会话 + XTest 后端」**&#x5E76;返回退出码 1。  
  **这是刻意的**：自检靠全局钩子判定，而 Xwayland 会把我们注入的事件**原样回放**给钩子，  
  于是「光标 ✓ / 按键 ✓ / 滚轮 ✓」可以全绿而实际毫无作用。宁可说「我不知道」，  
  也不给一个会误导人的绿勾。
- 显示 `uinput（dotool）` / `uinput（ydotool）` 且 `ydotoold` 那行是「复用」或「自行拉起」  
  → 这才是可信的结论。
- 显示 `uinput（ydotool）` 但 `ydotoold` 那行是「启动失败」→ 后面每一项都会失败，  
  报告里的提示就是原因（`/dev/uinput` 权限最常见）。

想一次看全（会话类型、库、钩子、注入、`/dev/uinput`、ydotoold）用：

```bash
./NetMouse --doctor
```

---

## 平台依赖 / 注意事项

**Ubuntu**

- **注入在 Wayland 下需要 uinput 工具**（详见上一节）：`sudo apt install -y ydotool`  
  再 `sudo ./install-linux.sh --uinput`，或者从源码装 `dotool`（多一个滚轮支持）。  
  `ydotoold` 守护进程由程序自动拉起，不需要配置服务。  
  **不要指望「登录时选 Ubuntu on Xorg」**：GNOME 50 起多数发行版已不再提供 Xorg 会话。
- **Wayland 下捕获自动改用 evdev**（读 `/dev/input/event*`），不再依赖「X11 窗口有焦点」。  
  采集和注入都需要 `input` 组权限，所以 `sudo ./install-linux.sh --uinput` 会**同时**写  
  `/dev/uinput` 和 `/dev/input/event*` 两条 udev 规则，之后**注销重登**一次即可。  
  `run-linux.sh` 仍会自动从运行中的会话里找出 Xwayland 的 `DISPLAY` / `XAUTHORITY`
  （uiohook 回退路径仍需要它）。
- 需要 `xdotool`（**仅当这台机是 server**：转发期间把本地光标在接近屏幕边界时回中，  
  保证有足够行程）。`sudo apt install xdotool`。deb 包已把它列为 `Recommends`。
- X11 运行时库（桌面版一般已装；最小化安装可能缺）：  
  `sudo apt install libx11-6 libxtst6 libxt6 libxrandr2`。用 `node src/doctor.js` 可逐项确认。
- 托盘图标依赖桌面环境的 appindicator 支持（GNOME 需装 AppIndicator 扩展）。  
  托盘不可用时程序会自动退化成「只用窗口」，不会变成找不到的僵尸进程。
- **便携版（tar.gz / .run）的沙箱**：Electron 的 `chrome-sandbox` 必须是  
  `root:root` 且权限 `4755`，绿色包没法自带这个权限位，所以 `netmouse.sh`  
  会检测并自动加 `--no-sandbox` 启动。想恢复完整沙箱，执行一次：
  ```bash
  sudo chown root:root chrome-sandbox
  sudo chmod 4755 chrome-sandbox
  ```
  （AppImage 和 deb 由各自的启动器处理，不用手动管。）


**Windows 11**

- 直接可用，无需额外依赖。系统会把光标夹在屏幕边缘 —— 正因为如此，server 转发期间  
  会主动把光标在接近边界时**回中**（见下），否则对端光标走不满一个屏幕。

**两端通用**

- server 转发的是**相邻两次鼠标采样的位移**（相对位移），不是绝对坐标。  
  这样天然跨分辨率、跨 DPI 缩放、跨多屏负原点；两端屏幕尺寸不同也能正确移动。
- server 转发期间会把自己的物理光标**保持在桌面中央区域**：靠近任意边界 120px 就回中一次，  
  回中造成的跳变按阈值剔除（>400px 视为自己的瞬移，不转发）。  
  所以本机光标看起来会「钉」在中间 —— 这是正常的，它保证对端光标永远有走完全屏的行程。
- 边缘判定以 server 的**系统几何**（Electron `screen` / xrandr，均为物理像素，与钩子同一坐标空间）为准；  
  取不到时才退回 config 的 `layout.screenWidth/Height`，并在启动日志里给出提示。

## 已知限制

- **输入拦截是应用层方案**（全屏透明遮罩窗），不是 OS 级吞事件。  
  指针输入可靠地被拦下；键盘焦点是尽力而为（Windows 上遮罩被点到后即取得焦点）。  
  要做到内核级拦截需要原生低级钩子，本仓库不引入（本机没有编译环境）。
- 剪贴板同步**纯文本**（上限 1 MB）和**图片**（上限 8 MB，PNG 优先、超限自动转 JPEG）；
  不处理**文件**（资源管理器里 Ctrl+C 一个文件）、HTML、富文本等其它格式。
  对端是老版本（没声明 `img` 能力）时自动退回纯文本。
- 图片传输只支持 **PNG 和 JPEG** 两种编码 —— 这是 Chromium 解码器能吃下的全部。
  GIF 只同步**首帧**（剪贴板给的本来就是一张位图，动画信息在进程序之前就丢了），
  WebP/BMP/TIFF 源文件能同步是因为它们被解码成了位图，不是以原格式传输。
- **图片剪贴板的 Electron 胶水只在 Windows 上探针验证过**：两端纯逻辑（发送去重、  
  能力协商、按像素去重防回声、PNG→JPEG 回退）有 45 项单测钉住，但「在真实 GNOME/Wayland 桌面上  
  复制一张截图能同步过去」需要在真机上确认。图片去重按**解码像素**而非文件字节，  
  这一点已用真 Electron 探针确认（读写会重编码）。
- 只有对端连着的时候才会进入转发状态；对端断开会自动释放控制权。
- 仅支持一对一的 server↔client。
- 明文 sha256 握手，仅适用于可信局域网；公网使用请加 TLS。
- **headless 模式（`node src/cli.js`）**：若系统几何取不到（Windows 上安全策略禁用  
  `Add-Type` 时 PowerShell 会失败），会退回 config 的 `layout.screenWidth/Height` 并在日志里提示。  
  这时请把这两个值改成实际桌面尺寸，或直接用图形界面（Electron `screen` 更可靠）。
- **鼠标侧键（后退/前进）不转发**：nut-js 的 `Button` 枚举只有左/中/右三个，  
  没有侧键。事件会被明确忽略并在日志里说明一次，不会静默丢弃。
- **滚轮「一格」的单位在 Linux/macOS 上是推断的**：Windows 实测一格 = 120 单位，  
  Linux/macOS 从 libnut 的实现推断为 1，**没有实测**。若 Ubuntu 上滚轮明显「几乎不动」  
  或「一次滚太多」，把 `input.scrollUnit` 改成 `120` 或 `1` 各试一次即可确认。
- **水平滚轮（左右倾斜）没有下结论**：实测 Windows 上 `scrollRight` 产生的  
  `rotation` 符号与 X11 的约定相反，怀疑是 nut-js/libnut 自身取反。  
  垂直滚动是实测正确的；水平滚动用得少，未据此改代码。
- **混合 DPI 换算只在模拟环境验证过**：`dipToScreenRect` 的换算逻辑有 16 项  
  几何回归测试（假 Electron `screen` 建模 Chromium 的 DIP 树），但**没有在真实的  
  混合缩放桌面上验证过**。请在双屏不同缩放的机器上跑一次 `--hwtest` 确认。
- **uinput 后端的 `dotool` 路径没有实测过**：命令行、按键编号、传输方式都有 39 项  
  单元测试钉住（假 `spawn` 断言确切字节）。`ydotool` 路径已在真实 Wayland 机器上跑通，
  但**踩过一次大坑**（见下一条），所以「测试绿」不等于「真机能动」这一点请记住。
- **`ydotoold` 探测方式的坑（0.2.8～0.2.10 全中）**：`ydotoold` 的 socket 是  
  `SOCK_DGRAM`，而代码用 `net.connect()`（`SOCK_STREAM`）去探测，内核一律回  
  `EPROTOTYPE` —— 于是**守护进程活得好好的，探测永远说「没有」**，3 秒后还把它杀掉。  
  现在改成 `ydotool debug` 的退出码。这个 bug 的教训：**「进程活着 / 没退出 / 没 stderr /  
  我要的 socket 没人应答」四种观测同时成立时，先怀疑探测手段本身**。  
  现有 37 项单测覆盖 socket 路径、复用/拉起/只杀自己起的、三种 `/dev/uinput` 权限形态；
  **没有第二台 Wayland 机器复跑过**，所以真机验证仍以 `--injecttest` 为准。
- **uinput 滚轮的符号是推出来的**：libuiohook 用 `rotation < 0 = 上`，内核 `REL_WHEEL`  
  用 `+1 = 上`，所以代码里对符号**取负**（`uinputWheelAmount()`）。  
  若实测方向反了，改那一个函数（一行）即可。
- **`ydotool` 的滚轮靠附带的小脚本**：`ydotool` 本身没有滚轮子命令（官方 manpage 里只有  
  `type`/`key`/`mousemove`/`click`/`stdin`），所以滚轮由 `bin/wheel.py` 直接写  
  `/dev/uinput` 的 `REL_WHEEL` / `REL_HWHEEL` 实现。代价是**每滚一次 fork 一个 `python3`**  
  （含建/销虚拟设备约 60ms，滚轮本来就是低频操作），并且**系统里必须有 `python3`**。  
  缺 `python3` 时只有滚轮不可用，日志会说明一次，移动/点击/键盘不受影响。
- **`dotool` 不在 Ubuntu/Debian 官方源里**（要源码装一次），`ydotool` 已随程序附带；  
  两者都需要一次性的 `/dev/uinput` 权限 ——  
  用 `sudo ./install-linux.sh --uinput` 装 udev 规则，或把用户加进 `input` 组后**重新登录**。  
  `ydotoold` 守护进程由程序自动管理，不需要配置 systemd 服务。
- **`install-linux.sh` 的 `.desktop` 生成没有在真实 GNOME 上验证过**：脚本本身有语法检查  
  和产物校验（`verify-linux-portable.py` 断言它存在于包里、可执行、`sh -n` 通过、  
  且确实写了 `Desktop Entry`），但「Nautilus 真的认这个图标」需要在真机上确认。  
  如果图标显示为「未受信任的启动器」，右键「允许启动」即可 —— 这是 GNOME 的机制，  
  不是脚本失败。**AppImage 仍未构建过**（Windows 上无法构建）。
- **`dotool` 的键盘映射依赖一个不变量**：uiohook 的键码 == 内核 `KEY_*` 码。  
  字母/数字/修饰键/F 键这一段是成立的（已有断言钉住），但媒体键、部分小键盘键  
  未必；键盘转发在 uinput 后端下属于「能用但没全面验证」。
- **evdev 采集后端从没在真实 Wayland 桌面上跑过**：`struct input_event` 的两种宽度、  
  `SYN_REPORT` 分帧、滚轮去重、自有设备过滤、后端选择与回退都有 35 项单测  
  （假 `readdir`/`readFile`）钉住，但「在真实 GNOME Wayland 上真的能捕获、  
  手势真的能触发」需要在装了 Linux 的机器上实测。**它的触发手势（推向某边约 35%）  
  也是设计出来的、未在真机上校准过** —— 阈值可能偏灵敏或偏钝，`pushTarget()` 一个函数可调。
- **evdev 下鼠标侧键会被转发，但 client 仍会拒绝**：采集层认得 BTN_SIDE / BTN_EXTRA，  
  可 nut-js 的 `Button` 枚举里根本没有侧键，所以到了注入那一步还是被忽略（见上）。  
  这是注入端的限制，不是采集端的。
- **一键诊断包没有在真机上跑过全流程**：ZIP 结构、CRC、脱敏、清单自引用都有 18 项单测  
  用**独立读包器**反解验证，但「在真实出问题的那台机器上打包、发给别人能看懂」  
  仍需实测。它故意不引入新依赖（自己写 zip），所以任何环境都能跑。

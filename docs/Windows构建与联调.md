# Windows 侧：构建、更新与双机联调

这份文档是**操作清单**：怎么在 Windows 上打出便携版、怎么验证产物、怎么和 Ubuntu 那台  
联调。原理与设计取舍见 [`开发记录.md`](开发记录.md)，日常使用与配置说明见  
[`../README.md`](../README.md)。

> 版本：**0.2.12**。文中的命令与产物名对应当前版本；版本号变了以后把 `0.2.12` 换掉即可。

---

## 0. 构建前的两条环境前提

```bash
unset ELECTRON_RUN_AS_NODE                                        # 必须
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/    # 加速，可选
```

1. **必须 `unset ELECTRON_RUN_AS_NODE`。** 如果宿主环境设了 `ELECTRON_RUN_AS_NODE=1`，  
   Electron 会被当成普通 Node 跑，`electron-builder` 和程序本身的行为都不对。  
   所有构建命令前面都要加 `unset`（或者 `env -u ELECTRON_RUN_AS_NODE ...`）。
2. **`ELECTRON_MIRROR` 只是加速。** 不设也能构建，只是首次要等 Electron 二进制从  
   GitHub 下载（本项目实测约 17 分钟）。

两个原生依赖（`uiohook-napi`、`@nut-tree-fork/nut-js`）都自带各平台预编译二进制，  
所以**不需要本机编译环境**，也正因如此可以在 Windows 上交叉打出 Linux 的 tar.gz / .run。

---

## 1. 拿到源码

用源码包 `netmouse-src-<version>.zip`（`npm run build:src` 生成，或随交付拿到）：

```powershell
Expand-Archive netmouse-src-0.2.12.zip -DestinationPath . -Force
cd netmouse
npm install
```

`npm install` 会装 Electron 等依赖（几分钟到十几分钟）。装完先跑一次测试确认环境没问题：

```powershell
npm test          # 十二块：纯函数 / 几何 / 按键滚轮 / 注入 / 剪贴板 / evdev 采集 / 诊断包 / uinput / ydotoold / 界面 / 自检数学 / 端到端
```

期望全部通过（当前基线：`selftest 96` · `PLATFORM 16/16` · `HWTEST-INPUT 42/42` ·  
`INJECTTEST-UNITS 19/19` · `CLIPBOARD-UNITS 45/45` · `CAPTURE-UNITS 35/35` ·  
`DIAGBUNDLE-UNITS 18/18` · `UINPUT-UNITS 39/39` · `YDOTOOLD-UNITS 37/37` ·  
`UI CHECK PASS` · `HWTEST-UNITS 17/17` · `E2E 39/39`）。

---

## 2. 先不打包，直接验证能跑

```powershell
npm run start:headless      # 无界面跑一次，看启动日志
```

启动日志里应该出现几何检测那一行，例如：

```
INFO input capture: 虚拟桌面 3240x2656 @ (0,0)  ·  (config 写的是 3240x2656)
```

- 看到 `虚拟桌面 WxH@(x,y)` → 几何检测正常，按 `Ctrl+C` 停掉。
- **没看到** → 多半是旧代码或几何取不到，去跑 `npm run diag` 看报告。

---

## 3. 打便携版

```powershell
npm run build:win              # 免安装：portable exe + zip
npm run build:win:installer    # 需要时才打 NSIS 安装包
```

产物在 `dist\`：

| 文件                                | 说明                           |
| --------------------------------- | ---------------------------- |
| `NetMouse-0.2.12-portable-x64.exe` | **单文件免安装**，双击即用，配置生成在它旁边     |
| `NetMouse-0.2.12-win-x64.zip`      | 绿色压缩包，解压后运行 `NetMouse.exe`   |
| `NetMouse-0.2.12-setup-x64.exe`    | NSIS 安装包（可选），会写开始菜单 / 桌面快捷方式 |

> **首次打包报 `Cannot create symbolic link ... libcrypto.dylib`**：  
> 是 `winCodeSign` 压缩包里两个 macOS 符号链接解不开（非管理员 / 未开开发者模式）。  
> 把已解压出来的目录改名成  
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` 即可绕过。

---

## 4. 在真产物上验证（发布前固定动作）

不要只信源码树 —— 跑一遍**真正要发出去的那个 exe**：

```powershell
dist\win-unpacked\NetMouse.exe --doctor        # 会话 / 库 / 钩子 / 注入 / 采集 / 环境 全查
dist\win-unpacked\NetMouse.exe --hwtest        # 服务器侧：真光标走四条边 + 按键 + 滚轮
dist\win-unpacked\NetMouse.exe --injecttest    # 客户端侧：本机能否驱动自己的光标/按键/滚轮
dist\win-unpacked\NetMouse.exe --diagbundle    # 一键诊断包：把上面这些结果打成一个 zip
```

前三个都是**约 5–10 秒**、会自动接管光标，跑的时候别动鼠标，结束自动还原。
`--diagbundle` 默认也会跑那两个实时自检，加 `--no-live` 可跳过（SSH / 无人值守时用）。

期望：

| 命令             | 期望结果                                      |
| -------------- | ----------------------------------------- |
| `--doctor`     | `DOCTOR PASS — N ok, 0 warn, 0 fail`      |
| `--injecttest` | 光标 / 左中右键 / 滚轮全绿，注入器计数**失败 0**            |
| `--hwtest`     | 四条共享边全部可触发、`enter`/`release` 正常，按键与滚轮 6/6 |
| `--diagbundle` | 生成 `netmouse-diag-<时间戳>.zip`，列出包内文件（README 排第一） |

`--hwtest` 结束时会提示当前 `layout.edge`；**如果对端（Ubuntu）在左侧，必须改成 `left`  
或 `any`**，否则往左推永远不会有反应。

> **Linux 包要单独看一眼 `resources/bin/`。** 0.2.11 起 `ydotool` / `ydotoold` / `wheel.py`
> 随包附带（`linux.extraResources`）。**在 Windows 上打 Unix 包会丢执行位**，所以
> `npm run build:linux:portable` 自己写模式，`scripts/verify-linux-portable.py` 逐项断言
> `0755` + x86-64 ELF。手工核对：
>
> ```bash
> python3 - <<'PY'
> import tarfile
> t = tarfile.open("dist/NetMouse-0.2.12-linux-x64.tar.gz")
> for m in t.getmembers():
>     if "resources/bin" in m.name:
>         print(oct(m.mode), m.size, m.name)
> PY
> ```
>
> 三个都必须是 `0o755`。变成 `0o644` 的话客户端 spawn 会 `EACCES`，
> **而 `EACCES` 的表现和「XTest 注入」一模一样**（日志干干净净，光标不动）。

---

## 5. 部署与配置

便携版第一次运行会在 **exe 同目录**生成 `config.json`，界面里改的参数都写这个文件。  
换机器时把 exe（和 `config.json`）一起拷走即可。

配置查找顺序、只读目录回退等细节见 README 的  
[配置文件的存放位置](../README.md#配置文件的存放位置)。

**两台机器的关键差异：**

| 项                           | server（插键鼠的那台）        | client（被控制的那台）                 |
| --------------------------- | --------------------- | ------------------------------ |
| `role`                      | `server`              | `client`                       |
| `listenPort`                | 监听端口，如 `24800`        | —                              |
| `peer.host` / `port`        | —                     | server 的局域网 IP + 端口            |
| `peer.password`             | 两端必须**完全一致**          | 同左                             |
| `layout.edge`               | **server 共享出去的那条边**   | 不用填（运行时采用 server 发来的边）         |
| `layout.screenWidth/Height` | server 的虚拟桌面尺寸（会自动检测） | 不用管（转发的是相对位移）                  |
| `input.capture`             | `auto` 即可（Wayland 下自动切 evdev） | —                    |
| `input.scrollUnit`          | —                     | 滚轮一格单位，`0` = 按平台自动             |
| `input.backend`             | —                     | `auto` 即可（Wayland 下自动切 uinput） |
| `clipboard.images`          | 两端一致即可（默认开）            | 同左                             |

> **client 那台第一次打开要先改角色再「保存并重启」**：便携版默认 `autoStart: true`，  
> 双击就会以 `server` 身份在 24800 起服务端。如果这台是要当 client 用的，先把角色改掉。

---

## 6. 双机联调清单

假设 **Win11 = server（插键鼠）**、**Ubuntu = client**，且 Ubuntu 在左侧。

### 6.1 联调前

- [ ] 两台在**同一局域网**，防火墙放行 24800（或你改的端口）。
- [ ] 两台 `peer.password` 完全一致（不一致会 `peer rejected`）。
- [ ] server 的 `layout.edge` = `left`（或 `any`）。
- [ ] **Ubuntu 那台先补齐 Wayland 注入能力**（见 README  
  [Wayland 会话](../README.md#wayland-会话为什么日志正常鼠标就是不动)）：  
  `sudo apt install -y ydotool && sudo ./install-linux.sh --uinput`，  
  再 `./NetMouse --injecttest` 确认注入真的生效。  
  这一步同时会把 `/dev/input/event*` 的权限也装好（同一套 `input` 组规则），  
  所以**如果角色反过来（Ubuntu 当 server）**，捕获也能用 —— `input.capture` 留 `auto` 即可。
- [ ] 两台各跑一次 `--doctor`，确认没有 `✗`。

### 6.2 逐项确认

- [ ] 远离共享边**不切换**；贴到边缘才切换。
- [ ] 切过去后**光标能移动**（这是 Wayland 那条最常见的坑）。
- [ ] **左键能点、右键能点、中键能点** —— 移动和点击是两条独立代码路径，能移动不代表能点。
- [ ] **滚轮上下方向正确**（`ydotool` 根本不支持滚轮，需要滚轮得用 `dotool`）。
- [ ] 跨边界**拖拽**（按住左键移过去）后，按键**不粘住**。
- [ ] 从 client 朝 server 的那条边移回去，能**交还控制权**，且不抖动。
- [ ] 卡住时按 **`Ctrl+Alt+Shift+Q`**（全局逃生热键，不受焦点影响）能立刻交还本地控制。

### 6.3 出问题时的分工

**先在两台各跑一次自检**，把「哪一侧坏了」变成有据可查的结论：

| 自检                  | 意义                                       | 在哪台跑   |
| ------------------- | ---------------------------------------- | ------ |
| `--hwtest` 边缘自检     | 本机 server 侧（几何 / 边缘判定 / 交接 / 按键滚轮**发出**） | server |
| `--injecttest` 注入自检 | 本机 client 侧（能不能真的**驱动自己的光标/按键/滚轮**）      | client |

| 症状                         | 结论                                                          |
| -------------------------- | ----------------------------------------------------------- |
| server `--hwtest` 四条边全触发   | server 侧没问题 → 去查 client 或网络                                 |
| client `--injecttest` 三项全绿 | client 侧没问题 → 问题在 server 或网络                                |
| client **光标一项就红**          | client 驱动不了自己的光标 → **这就是「鼠标不动」的直接原因**（Wayland 没装 uinput 工具） |
| 只有按键红 / 只有滚轮红              | 分别是按键注入被拒 / 滚轮方向或单位问题                                       |

完整的症状 → 章节索引见 README 的  
[遇到问题先看这里](../README.md#遇到问题先看这里)。

---

## 7. 常见问题速查

| 现象                   | 原因与处理                                            |
| -------------------- | ------------------------------------------------ |
| Linux 端连不上           | `peer.host` 写错、server 没先启动、防火墙挡端口                |
| 握手被拒 `peer rejected` | 两端密码不一致                                          |
| server 边缘不触发切换       | 启动日志没有 `虚拟桌面` 行 → 几何取不到；或 `edge` 填错了对端所在的方向      |
| 坐标错位 / 光标乱跳          | 日志里 `虚拟桌面` 尺寸与实际多屏布局不一致（跑 `npm run diag` 对比）     |
| 远程时本机也被点亮            | `input.blockLocal` 是否为 `true`                    |
| 移动正常但点不动             | 去 server 跑 `--hwtest` 看「按键与滚轮」读数；或 client 注入权限问题 |
| 日志正常但鼠标不动            | **Wayland + XTest**，装 uinput 工具                  |
| Wayland 下鼠标一碰原生应用就捕获不到 | 捕获侧问题：`input.capture` 留 `auto` 会自动切 evdev（读 `/dev/input`） |
| 复制了图片但对面没同步          | 看剪贴板提示；对端太旧（没声明 `img`）会自动退回纯文本                   |
| 想要把现场一次性交出去          | 跑 `--diagbundle`，把生成的 zip 发过去                     |

---

## 8. 这份文档没验证的部分

如实标注，避免把推断当成实测：

- 混合缩放（200% + 125%）的换算只有**模拟环境**的 16 项回归测试，**没在真实混合 DPI 桌面上验证过**。
- `ydotoold` 的自动拉起**在真机上跑过一次，但结论是错的**：守护进程确实起来了，
  探测却用 `net.connect()`（`SOCK_STREAM`）去连一个 `SOCK_DGRAM` socket，内核回
  `EPROTOTYPE`，于是「起来了」被读成「没起来」。0.2.11 改成 `ydotool debug` 退出码，
  **尚未在第二台 Wayland 机器上复跑**（见 `开发记录.md` §10 与 §15）。
- `install-linux.sh` 的 `.desktop` 生成**没有在真实 Linux 上跑过**（产物校验通过，真机待确认）。
- `dotool` 路径**完全没在真机跑过**（ydotool 路径已在真实联调中打通）。
- uinput 的滚轮**符号**是从两边的文档推出来的（`uinputWheelAmount()` 取负），未实测。
- 水平滚轮（左右倾斜）**没有下结论**。
- **0.2.12 新增、仍未在真机验证的一项**：跨机 **JPEG 兜底**（PNG 超上限时自动转 JPEG）。
  发送逻辑与解码有 45 项单测 + 真 Electron 探针（`toJPEG` 存在、`createFromBuffer` 能解 JPEG、
  「解码键 == 写进剪贴板再读回来的键」对 PNG/JPEG 都成立），但**没有第二台机器真的收过一次**。
- **0.2.11 新增、仍未在真机验证的两项**：① `bin/wheel.py`（滚轮）**从没在真实 Linux 上跑过**，
  只做了静态检查（能编译、写 `REL_WHEEL`、打包 0755）；② 附带的 `ydotool`/`ydotoold`
  是 glibc 2.34 编的，**没有在 2.31 的发行版上验证过**「系统版优先」是否真的救回那种环境。
- **0.2.8 新增、仍未在真机验证的三项**：① evdev 采集后端**从没在真实 Wayland 桌面上跑过**  
  （35 项单测都是假的 `readdir`/`readFile`），触发手势的 35% 阈值也是**设计出来的、未校准**；  
  ② 图片剪贴板的 **Electron 胶水只在 Windows 上探针验证过**，真实 GNOME/Wayland 的截图同步未测；  
  ③ 一键诊断包**没有在真机上跑过全流程**（结构/CRC/脱敏有独立读回器验证）。

细节与后续计划见 [`开发记录.md`](开发记录.md) 的 §15「待办 / 未验证项」。

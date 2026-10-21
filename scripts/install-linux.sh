#!/bin/sh
# ---------------------------------------------------------------------------
# NetMouse — Linux launcher installer ("double-click to run").
#
# Why this script exists
# ----------------------
# Windows ships one .exe: download it, double-click it, done. Linux has no exact
# equivalent for a *portable folder*, and the reason is worth knowing:
#
#   * Nautilus (GNOME Files) deliberately refuses to execute files it detects as
#     TEXT, and a .sh / .run file IS text -- double-clicking one opens an editor
#     instead of running it. That is a safety feature, not a bug, and it is why
#     "double-click netmouse.sh" does not work the way it does on Windows.
#   * The native Linux equivalent of a double-clickable program is a .desktop
#     launcher. It is what both the file manager and the application menu know
#     how to run.
#
# So this script writes a .desktop pointing at wherever you unpacked NetMouse,
# marks it trusted so Nautilus launches it instead of warning, and optionally
# installs the udev rule that BOTH halves of Wayland support need:
#   * /dev/uinput      -- so the client can INJECT (create a virtual device)
#   * /dev/input/event* -- so the server can CAPTURE (read the real devices)
# Both are gated on the `input` group, which is why one flag covers them.
# After that you double-click the NetMouse icon like any other application.
#
# Usage:
#   ./install-linux.sh                 # launcher in the app menu + on the Desktop
#   ./install-linux.sh --no-desktop    # app menu only
#   ./install-linux.sh --uinput        # also install the udev rule + join the input group (asks for sudo)
#   ./install-linux.sh --uninstall     # remove the launcher and the udev rule
#   ./install-linux.sh --help
#
# No arguments are required, and nothing here touches the app itself.
# ---------------------------------------------------------------------------
set -e

APP_DIR=$(cd "$(dirname "$0")" && pwd)
DESKTOP_NAME="NetMouse.desktop"
UDEV_RULE="/etc/udev/rules.d/99-netmouse-uinput.rules"

WANT_DESKTOP=1
WANT_UINPUT=0
UNINSTALL=0

usage() {
  cat <<'EOF'
用法: ./install-linux.sh [选项]

  (无选项)        创建桌面启动器（应用菜单 + 桌面图标）
  --no-desktop    只在应用菜单里创建，不在桌面放图标
  --uinput        额外安装 udev 规则并把用户加入 input 组（需要 sudo，一次性）
                  这一步同时解决 Wayland 下的两件事：
                    · 注入 —— /dev/uinput 可写（客户端建虚拟设备）
                    · 捕获 —— /dev/input/event* 可读（服务器直接读内核事件，
                              不需要 DISPLAY，点击原生 Wayland 窗口后也不会失灵）
  --uninstall     删除启动器和 udev 规则
  -h, --help      显示本帮助

装完之后就可以像普通程序一样双击 NetMouse 图标启动了。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --uinput) WANT_UINPUT=1 ;;
    --no-desktop) WANT_DESKTOP=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "未知选项: $arg" >&2
      echo "试试 ./install-linux.sh --help" >&2
      exit 2
      ;;
  esac
done

# --- where things live -----------------------------------------------------

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPS_DIR/$DESKTOP_NAME"

DESKTOP_DIR=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR=$(xdg-user-dir DESKTOP 2>/dev/null || true)
fi
[ -n "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME/Desktop"

# Prefer the packaged launcher; fall back to the repo's dev launcher so this
# script is useful straight out of a git checkout too.
LAUNCHER=""
for cand in "$APP_DIR/netmouse.sh" "$APP_DIR/run-linux.sh"; do
  if [ -f "$cand" ]; then
    LAUNCHER="$cand"
    break
  fi
done

ICON=""
for cand in "$APP_DIR/netmouse.png" "$APP_DIR/build/icon.png" "$APP_DIR/src/assets/icon.png"; do
  if [ -f "$cand" ]; then
    ICON="$cand"
    break
  fi
done

# Run something as root, or explain why we cannot.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "需要 root 权限：$*" >&2
    echo "（没找到 sudo，请用 root 身份重跑本脚本）" >&2
    return 1
  fi
}

in_group_now() {
  id -nG 2>/dev/null | tr ' ' '\n' | grep -qx "$1"
}

# GNOME/Nautilus will not launch a .desktop it has not been told to trust, and
# gio records that as GVFS metadata -- which is why this only sticks for files
# in a GVFS-monitored location (~/Desktop, ~/.local/share/applications).
mark_trusted() {
  f="$1"
  [ -f "$f" ] || return 0
  chmod 755 "$f" 2>/dev/null || true
  if command -v gio >/dev/null 2>&1; then
    gio set "$f" metadata::trusted true 2>/dev/null || true
  fi
}

write_desktop_file() {
  mkdir -p "$APPS_DIR"
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=NetMouse
GenericName=Software KVM
Comment=一套键鼠跨两台电脑使用
Comment[en]=Share one mouse and keyboard across two computers
Exec="$LAUNCHER"
Path=$APP_DIR
Icon=$ICON
Terminal=false
Categories=Utility;Network;
StartupWMClass=NetMouse
Keywords=mouse;keyboard;KVM;share;
EOF
  mark_trusted "$DESKTOP_FILE"
}

# --- uninstall -------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  echo "==> 删除启动器"
  rm -f "$DESKTOP_FILE"
  rm -f "$DESKTOP_DIR/$DESKTOP_NAME"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" 2>/dev/null || true
  fi
  if [ -f "$UDEV_RULE" ]; then
    echo "==> 删除 $UDEV_RULE（需要 sudo）"
    if as_root rm -f "$UDEV_RULE"; then
      as_root udevadm control --reload-rules 2>/dev/null || true
      echo "    已删除。（input 组的成员关系不会自动撤销，如需要：sudo gpasswd -d $USER input）"
    fi
  fi
  echo "完成。NetMouse 本体没有改动。"
  exit 0
fi

# --- sanity ----------------------------------------------------------------

if [ -z "$LAUNCHER" ]; then
  echo "找不到 netmouse.sh 或 run-linux.sh（在 $APP_DIR 里）。" >&2
  echo "本脚本要和它们放在同一个目录。" >&2
  exit 1
fi

# --- 1. the launcher -------------------------------------------------------

echo "==> 创建启动器"
write_desktop_file
echo "    应用菜单: $DESKTOP_FILE"

if [ "$WANT_DESKTOP" = 1 ]; then
  if [ -d "$DESKTOP_DIR" ]; then
    cp "$DESKTOP_FILE" "$DESKTOP_DIR/$DESKTOP_NAME"
    mark_trusted "$DESKTOP_DIR/$DESKTOP_NAME"
    echo "    桌面图标: $DESKTOP_DIR/$DESKTOP_NAME"
  else
    echo "    （没有 $DESKTOP_DIR，跳过桌面图标）"
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
fi

# --- 2. device permissions, optionally ------------------------------------

if [ "$WANT_UINPUT" = 1 ]; then
  echo "==> 安装 udev 规则（/dev/uinput 注入 + /dev/input 捕获，需要 sudo）"
  TMP_RULE=$(mktemp)
  cat > "$TMP_RULE" <<'EOF'
# NetMouse: give the "input" group access to the kernel's input devices.
#
# Two separate things need this, and they fail in completely different ways:
#
#   1. /dev/uinput -- creating a virtual input device, which is the whole
#      Wayland INJECTION fix. Without it, /dev/uinput is root-only on many
#      distributions and no uinput tool (dotool, ydotool) can work at all.
#
#   2. /dev/input/event* -- reading the real devices, which is the Wayland
#      CAPTURE fix. Most distributions already ship these as 0660 root:input,
#      in which case only the group membership below matters; the rule is
#      repeated here so a 0640 default cannot silently break capture.
#
# Security note: being in the "input" group means being able to READ every
# input device, keyboards included. That is inherent to both jobs and is why
# this is an explicit, separate step rather than something the app does
# silently. To revoke: sudo gpasswd -d $USER input
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
KERNEL=="event*", SUBSYSTEM=="input", GROUP="input", MODE="0660"
EOF
  if as_root install -m 0644 "$TMP_RULE" "$UDEV_RULE"; then
    echo "    已写入 $UDEV_RULE"
    as_root modprobe uinput 2>/dev/null || true
    as_root udevadm control --reload-rules 2>/dev/null || true
    as_root udevadm trigger --name-match=uinput 2>/dev/null || true
    as_root udevadm trigger --subsystem-match=input 2>/dev/null || true
    echo "    已重载 udev 规则"
  else
    echo "    !! 写入失败，跳过。请用 sudo 重跑：sudo $0 --uinput" >&2
  fi
  rm -f "$TMP_RULE"

  # The rule grants the GROUP; the user still has to be in it, and usermod only
  # affects sessions started afterwards -- the single most confusing step here.
  if in_group_now input; then
    echo "    当前会话已在 input 组，无需重新登录。"
  else
    if as_root usermod -aG input "$USER"; then
      echo "    已把 $USER 加入 input 组 —— 需要注销后重新登录才生效。"
    else
      echo "    加入 input 组失败，请手动执行：sudo usermod -aG input $USER" >&2
    fi
  fi

  # Say out loud what this actually bought. Two very different features ride on
  # the same group, and "did it work?" is otherwise unanswerable without
  # launching the app and moving a mouse.
  echo "    检查当前会话的权限："
  if [ -w /dev/uinput ]; then
    echo "      /dev/uinput        可写  -> Wayland 下可以注入"
  else
    echo "      /dev/uinput        不可写（已加入 input 组的话，注销重新登录即可）"
  fi
  EV_TOTAL=0
  EV_OK=0
  for f in /dev/input/event*; do
    [ -e "$f" ] || continue
    EV_TOTAL=$((EV_TOTAL + 1))
    if [ -r "$f" ]; then EV_OK=$((EV_OK + 1)); fi
  done
  if [ "$EV_TOTAL" -gt 0 ] && [ "$EV_OK" -eq "$EV_TOTAL" ]; then
    echo "      /dev/input/event*  $EV_OK/$EV_TOTAL 可读 -> Wayland 下可以捕获（不需要 DISPLAY）"
  elif [ "$EV_TOTAL" -gt 0 ]; then
    echo "      /dev/input/event*  $EV_OK/$EV_TOTAL 可读（注销重新登录后应当全部可读）"
  else
    echo "      /dev/input/event*  没有找到任何设备"
  fi
fi

# --- 3. what to do next ----------------------------------------------------

cat <<EOF

完成。

  启动方式
    ① 双击桌面上的 NetMouse 图标，或在应用菜单里搜 NetMouse
    ② 命令行: $LAUNCHER

  GNOME 提示
    若桌面图标显示为「未受信任的启动器」，右键 → 「允许启动」即可。
    首次双击 .run / .sh 文件会被当成文本打开，这是 Nautilus 的安全策略；
    用上面这两个方式启动不受影响。

EOF

if [ "$WANT_UINPUT" = 0 ]; then
  cat <<EOF
  Wayland 下的注入（可选，一次性）
    只有在「本机作为客户端」且是 Wayland 会话时才需要。先看看缺什么：
        $LAUNCHER --doctor
    若提示 /dev/uinput 不可写，执行：
        sudo $0 --uinput

EOF
fi

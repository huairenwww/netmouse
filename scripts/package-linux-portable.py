#!/usr/bin/env python3
"""Package dist/linux-unpacked into portable Linux artifacts.

electron-builder can *cross-build* the Linux app directory from Windows, but it
cannot finish the job there:

  * the AppImage target shells out to mksquashfs, which is a Linux ELF binary
    and simply will not execute on Windows;
  * when archiving from Windows there are no Unix permission bits to record, so
    every file lands as 0644 -- including `netmouse` and `chrome-sandbox`.

So we do the archiving ourselves, with the modes set explicitly.

Outputs (in dist/):
  NetMouse-<ver>-linux-x64.tar.gz   green package: extract anywhere and run
  NetMouse-<ver>-linux-x64.run      single file, self-extracting on first run
"""

import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
SRC = os.path.join(DIST, "linux-unpacked")
LAUNCHER = os.path.join(ROOT, "build", "netmouse.sh")
# Writes the .desktop launcher, which is what "double-click to run" means on
# Linux -- see the long note at the top of that script.
LAUNCHER_INSTALL = os.path.join(ROOT, "scripts", "install-linux.sh")
ICON = os.path.join(ROOT, "build", "icons", "256x256.png")

# The bundled uinput tools are spawned directly by the app, so they need the
# execute bit -- without it ydotoold fails with EACCES and the client quietly
# falls back to XTest, which Wayland ignores.
EXECUTABLE = {
    "netmouse",
    "chrome_crashpad_handler",
    "netmouse.sh",
    "install-linux.sh",
    "ydotool",
    "ydotoold",
    "wheel.py",
}
SETUID = {"chrome-sandbox"}  # Electron wants root:root 4755 here


def mode_for(rel):
    base = os.path.basename(rel)
    if base in SETUID:
        return 0o4755
    if base in EXECUTABLE:
        return 0o755
    return 0o644


def version():
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as fh:
        return json.load(fh)["version"]


README = """NetMouse — Linux 免安装便携版
================================

开始使用（三步）
----------------

1) 先生成一次启动器：

       ./install-linux.sh

   之后「应用菜单」和桌面上都会出现 NetMouse 图标，双击即可启动。

   为什么不能直接双击 netmouse.sh：
   Nautilus（GNOME 文件管理器）出于安全考虑，不执行它识别为「文本」的文件，
   而 .sh / .run 正是文本 —— 双击只会打开编辑器。Linux 上「双击即运行」的正规
   做法是 .desktop 启动器，install-linux.sh 就是替你写一个并标记为受信任。
   （KDE / XFCE 等允许直接执行脚本的文件管理器不受此限制。）

2) 想跳过启动器直接跑：

       ./netmouse.sh

3) 换机器或换目录后，重新执行一次 ./install-linux.sh
   （启动器里存的是绝对路径）。config.json 就在本目录，整个文件夹拷走即可。

不需要 root、不写系统目录。

首次运行会在本目录生成 config.json，界面里改的参数都存这里。

想要启用 Electron 完整沙箱（可选，需要 sudo 一次）：
    sudo chown root:root chrome-sandbox
    sudo chmod 4755 chrome-sandbox
不设置也能用，启动脚本会自动加 --no-sandbox。

Wayland 会话（Ubuntu 22.04 起默认）
----------------------------------
Wayland 下 libnut 走的 XTest 协议会「调用成功、事件却到不了原生应用」，
所以本机作为「客户端」时需要 uinput 工具：

    sudo ./install-linux.sh --uinput     # 一次性：给 /dev/uinput 权限

ydotool 与 ydotoold 已经随程序附带（resources/bin/），不需要 apt 安装。
系统里装了也不冲突：有系统版就优先用系统版（它是按本机 glibc 编的）。
滚轮由 bin/wheel.py 直接写 /dev/uinput 实现，需要系统有 python3
（Ubuntu 桌面版默认自带；缺了只有滚轮不可用，移动/点击/键盘不受影响）。

ydotoold 守护进程由 NetMouse 自己拉起和关闭，不需要你手工配置任何服务。
装完用 ./netmouse.sh --doctor 或 ./netmouse.sh --injecttest 验证。

注意：GNOME 50 起多数发行版已不再提供 Xorg 会话，「登录时选 Ubuntu on Xorg」
这条老办法在新系统上可能根本没有这个选项 —— uinput 才是通用的解法。

Ubuntu 注意事项
---------------
* server 端建议安装 xdotool：
      sudo apt install xdotool
* 托盘图标需要桌面环境的 appindicator 支持（GNOME 需装 AppIndicator 扩展）。
  托盘不可用时会自动退化成只用窗口。
* 桌面图标若显示为「未受信任的启动器」，右键 →「允许启动」即可。
"""


def stage(root_name):
    """Copy the unpacked tree, add the launcher + notes, normalise the modes."""
    # Stage under the system temp dir, not dist/: a staged copy is throwaway and
    # leaving it in the repo would (a) bloat dist/ and (b) make the cleanup a
    # 300+ file bulk delete.
    staging = os.path.join(tempfile.gettempdir(), "netmouse-linux-stage")
    if os.path.isdir(staging):
        shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)

    shutil.copy2(LAUNCHER, os.path.join(staging, "netmouse.sh"))
    shutil.copy2(LAUNCHER_INSTALL, os.path.join(staging, "install-linux.sh"))
    # The launcher's Icon= must point at a real file: linux-unpacked has no
    # top-level icon, and an Icon= that resolves to nothing leaves a blank entry.
    if os.path.exists(ICON):
        shutil.copy2(ICON, os.path.join(staging, "netmouse.png"))
    with open(os.path.join(staging, "README-linux.txt"), "w", encoding="utf-8") as fh:
        fh.write(README)

    for entry in sorted(os.listdir(SRC)):
        s = os.path.join(SRC, entry)
        d = os.path.join(staging, entry)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)

    for dirpath, dirnames, filenames in os.walk(staging):
        os.chmod(dirpath, 0o755)
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), staging)
            os.chmod(os.path.join(dirpath, name), mode_for(rel))
    return staging, root_name


def build_tar(staging, root_name, out_path):
    """tar.gz with Unix modes and a single top-level directory."""
    # Deterministic ordering keeps rebuilds comparable.
    entries = []
    for dirpath, dirnames, filenames in os.walk(staging):
        dirnames.sort()
        entries.append(dirpath)
        entries.extend(sorted(os.path.join(dirpath, f) for f in filenames))

    def arcname(path):
        return os.path.join(root_name, os.path.relpath(path, staging))

    with tarfile.open(out_path, "w:gz", format=tarfile.GNU_FORMAT, compresslevel=6) as tar:
        for path in entries:
            rel = os.path.relpath(path, staging)
            ti = tar.gettarinfo(path, arcname=arcname(path))
            ti.mode = mode_for(rel) if os.path.isfile(path) else 0o755
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            if os.path.isfile(path):
                with open(path, "rb") as fh:
                    tar.addfile(ti, fh)
            else:
                tar.addfile(ti)
    return out_path


STUB = """#!/bin/sh
# NetMouse - single-file portable launcher (self-extracting).
#
# First run unpacks the app next to this file (in .netmouse/) and starts it.
# config.json is kept beside this file, so the whole thing stays portable.

set -e

SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
DIR=$(cd "$(dirname "$SELF")" && pwd)
APPDIR="${NETMOUSE_HOME:-$DIR/.netmouse}"

if [ ! -x "$APPDIR/netmouse" ]; then
  echo "NetMouse: 首次运行，正在解压到 $APPDIR ..."
  mkdir -p "$APPDIR"
  tail -c +{OFFSET} "$SELF" | tar xz -C "$APPDIR" --strip-components=1
  echo
  echo "提示：想要一个双击就能启动的图标，执行一次："
  echo "    ./install-linux.sh"
fi

NETMOUSE_PORTABLE_DIR="$DIR"
export NETMOUSE_PORTABLE_DIR
exec "$APPDIR/netmouse.sh" "$@"
"""


def build_run(tarball, out_path):
    """Prepend a shell stub to the tarball so the file is its own installer."""
    with open(tarball, "rb") as fh:
        payload = fh.read()

    # `tail -c +N` is 1-based, so N is the archive's first byte. N's own digit
    # count changes the stub length, which changes N -- solve for the fixed point.
    base = len(STUB.replace("{OFFSET}", "").encode())
    digits = 1
    for _ in range(10):
        offset = base + digits + 1
        if len(str(offset)) == digits:
            break
        digits = len(str(offset))

    stub_bytes = STUB.replace("{OFFSET}", str(offset)).encode()
    assert len(stub_bytes) == offset - 1, "stub length drifted from the offset"

    with open(out_path, "wb") as fh:
        fh.write(stub_bytes)
        fh.write(payload)
    return out_path


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"missing {SRC} -- run electron-builder --linux dir first")

    ver = version()
    root_name = f"NetMouse-{ver}-linux-x64"
    staging, root_name = stage(root_name)

    tarball = os.path.join(DIST, f"{root_name}.tar.gz")
    build_tar(staging, root_name, tarball)
    print(f"built {tarball}  ({os.path.getsize(tarball) / 1e6:.1f} MB)")

    runfile = os.path.join(DIST, f"{root_name}.run")
    build_run(tarball, runfile)
    print(f"built {runfile}  ({os.path.getsize(runfile) / 1e6:.1f} MB)")

    shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    main()

#!/bin/sh
# NetMouse portable launcher (Linux).
#
# A portable/green build cannot ship Electron's SUID sandbox helper the way a
# distro package does: chrome-sandbox must be owned by root with mode 4755, and
# only root can arrange that. So this script fixes up what it can, then picks a
# sandbox mode that actually starts.

set -e

APP_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$APP_DIR"

# Where the user keeps the portable copy. The self-extracting .run wrapper sets
# this to the folder holding the .run file, so the config stays next to it.
if [ -z "${NETMOUSE_PORTABLE_DIR:-}" ]; then
  NETMOUSE_PORTABLE_DIR="$APP_DIR"
  export NETMOUSE_PORTABLE_DIR
fi

# Archive extraction across filesystems loses the executable bits.
[ -x ./netmouse ] || chmod +x ./netmouse 2>/dev/null || true
[ -x ./chrome_crashpad_handler ] || chmod +x ./chrome_crashpad_handler 2>/dev/null || true

# Electron aborts with a fatal "SUID sandbox helper binary ... not configured
# correctly" if chrome-sandbox exists but is not root:root 4755. Only root can
# fix that, so fall back to --no-sandbox instead of refusing to start.
SANDBOX_MODE=$(stat -c '%u:%a' ./chrome-sandbox 2>/dev/null || echo "?:?")
if [ "$SANDBOX_MODE" = "0:4755" ]; then
  exec ./netmouse "$@"
fi

echo "NetMouse: chrome-sandbox 不是 root:root 4755，改用 --no-sandbox 启动。"
echo "          想启用完整沙箱，执行一次（需要 sudo）："
echo "            sudo chown root:root '$APP_DIR/chrome-sandbox'"
echo "            sudo chmod 4755 '$APP_DIR/chrome-sandbox'"
echo
exec ./netmouse --no-sandbox "$@"

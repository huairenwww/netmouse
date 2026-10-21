#!/usr/bin/env bash
# Launch NetMouse on this machine (Ubuntu/Wayland aware).
#
# On Wayland the input stack only works through Xwayland, so we discover a live
# DISPLAY + XAUTHORITY from the running session and export them first.
#
# Prefers the packaged Linux GUI (dist/linux-unpacked/netmouse). Falls back to
# running the source with Electron, then to the headless CLI.
#
# Usage:
#   ./run-linux.sh                  # GUI, config = ./config.json
#   ./run-linux.sh config-linux.json # GUI, config = given file
#   NETMOUSE_HEADLESS=1 ./run-linux.sh [config]   # force headless CLI
set -euo pipefail
cd "$(dirname "$0")"

# --- discover the graphics environment -------------------------------------
if [ -z "${DISPLAY:-}" ] || [ ! -e "${XAUTHORITY:-/nonexistent}" ]; then
  for pid in $(pgrep -u "$USER" -f "gnome-shell|Xwayland" 2>/dev/null); do
    env_display=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^DISPLAY=//p')
    env_auth=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^XAUTHORITY=//p')
    if [ -n "$env_display" ] && [ -n "$env_auth" ] && [ -e "$env_auth" ]; then
      export DISPLAY="$env_display"
      export XAUTHORITY="$env_auth"
      break
    fi
  done
fi

# --- pick a config file -----------------------------------------------------
CONFIG="${1:-config.json}"
if [ -f "$CONFIG" ]; then
  export NETMOUSE_CONFIG="$PWD/$CONFIG"
fi

echo "DISPLAY=${DISPLAY:-<unset>}  XAUTHORITY=${XAUTHORITY:-<unset>}"
echo "config=${NETMOUSE_CONFIG:-<bundled>}"

# --- headless (no GUI) ------------------------------------------------------
if [ "${NETMOUSE_HEADLESS:-}" = "1" ]; then
  exec node src/cli.js
fi

# --- packaged Linux GUI -----------------------------------------------------
APP="dist/linux-unpacked/netmouse"
if [ -x "$APP" ]; then
  # A green/portable copy loses the executable bit and cannot ship the SUID
  # sandbox, so fix permissions and fall back to --no-sandbox.
  chmod +x "$APP" dist/linux-unpacked/chrome_crashpad_handler 2>/dev/null || true
  SANDBOX=$(stat -c '%u:%a' dist/linux-unpacked/chrome-sandbox 2>/dev/null || echo "?:?")
  if [ "$SANDBOX" = "0:4755" ]; then
    exec "$APP"
  fi
  exec "$APP" --no-sandbox
fi

# --- source Electron --------------------------------------------------------
if [ -x node_modules/.bin/electron ] && [ -x node_modules/electron/dist/electron ]; then
  exec node_modules/.bin/electron . --no-sandbox
fi

echo "No packaged build and no Linux Electron found; falling back to headless." >&2
exec node src/cli.js

const { BrowserWindow, app } = require("electron");
const { getScreenInfo, detectVirtualDipScreen } = require("./platform");

// ---------------------------------------------------------------------------
// Local input blocking.
//
// While the server is driving the peer, physical clicks and keystrokes should
// not reach the server's own windows. A true OS-level swallow needs a native
// low-level hook (not shippable without a compiler), so we use the mechanism
// available to a plain Electron app: a frameless, transparent, always-on-top
// window stretched over the whole virtual desktop. It becomes the topmost
// window under the cursor, so pointer input lands on it (and is discarded)
// instead of on whatever the user was working with, and it takes keyboard focus
// when it can.
//
// The real events are still delivered to the global uiohook hook and forwarded
// to the peer, so nothing is lost — this window only exists to absorb them.
//
// The window is created once and then shown/hidden: destroying it could make it
// the last window and trigger Electron's default "window-all-closed" quit.
//
// Degrades to a no-op when Electron is unavailable (headless CLI mode) or when
// window creation fails; the caller keeps working either way.
// ---------------------------------------------------------------------------
function createBlocker({ log }) {
  let win = null;
  let engaged = false;

  // BrowserWindow geometry (x/y/width/height, setBounds) is in DIP points, while
  // getScreenInfo().virtual is in PHYSICAL pixels. Under per-monitor DPI scaling
  // those are different numbers, and feeding the physical box to a window API
  // both oversizes and mispositions the overlay -- on a mixed-DPI desk it can
  // end up not covering the screen at all. Prefer the DIP box; fall back to the
  // physical one only when Electron's screen module is unavailable, where the
  // two are identical anyway.
  function desktopBounds() {
    const dip = detectVirtualDipScreen();
    if (dip && dip.width > 0 && dip.height > 0) return dip;
    const info = getScreenInfo();
    const v = info.virtual || { x: 0, y: 0, width: 1920, height: 1080 };
    return { x: v.x, y: v.y, width: v.width, height: v.height };
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const b = desktopBounds();
    win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* X11/Wayland may not support this */
    }
    // Belt and braces: swallow anything that still reaches the renderer.
    win.webContents.on("before-input-event", (e) => e.preventDefault());
    win.loadURL(
      "data:text/html,<html><head><meta charset='utf-8'></head>" +
        "<body style='margin:0;overflow:hidden;background:transparent;cursor:none'></body></html>"
    );
    // A dead renderer must not leave a full-screen window stuck on top.
    win.webContents.on("render-process-gone", () => disengage());
    win.on("closed", () => {
      win = null;
      engaged = false;
    });
    return win;
  }

  function engage() {
    if (engaged) return true;
    if (!process.versions.electron) return false; // headless: no overlay possible
    try {
      const w = ensureWindow();
      // The constructor clamps bounds to the work area (taskbar excluded) and
      // the desktop may have changed since the window was created, so re-apply
      // the full desktop rect every time.
      try {
        w.setBounds(desktopBounds());
      } catch {
        /* keep whatever we got */
      }
      w.show();
      try {
        app.focus({ steal: true }); // macOS; harmless elsewhere
      } catch {
        /* ignore */
      }
      try {
        w.focus();
        w.moveTop();
      } catch {
        /* focus is best-effort on Windows */
      }
      engaged = true;
      log?.info("本机输入已拦截（全屏遮罩已启用）");
      return true;
    } catch (e) {
      log?.warn("无法启用输入拦截，改为不拦截：", e.message);
      disengage();
      return false;
    }
  }

  function disengage() {
    engaged = false;
    if (win && !win.isDestroyed()) {
      try {
        win.hide();
      } catch {
        /* already gone */
      }
    }
    if (log) log.info("本机输入拦截已解除");
  }

  // Called on quit only — see the note about window-all-closed above.
  function destroy() {
    engaged = false;
    const w = win;
    win = null;
    try {
      w?.destroy();
    } catch {
      /* already gone */
    }
  }

  return {
    engage,
    disengage,
    destroy,
    isEngaged: () => engaged,
    hasWindow: () => !!(win && !win.isDestroyed()),
  };
}

module.exports = { createBlocker };

const net = require("net");
const crypto = require("crypto");

// Newline-delimited JSON. Every connection sends a handshake first:
//   { t: "hello", pwd: <sha256 of password>, caps: [...] }
// Peer replies { t: "ok", caps: [...] } or closes.
//
// `caps` is how a feature that is expensive or lossy to send gets negotiated
// instead of assumed. Image clipboard is the reason it exists: pushing 8 MB of
// PNG at a peer that predates the feature would be silently dropped on arrival,
// after the transfer. An absent `caps` means an older build, which understands
// nothing extra -- so text-only, exactly as before.
//
//   img -- the peer understands `{ t:"cb", kind:"image" }` at all (0.2.8+)
//   jpg -- the peer can decode JPEG as well as PNG (0.2.12+). Kept separate
//          because 0.2.8..0.2.11 understand images but only PNG: sending them
//          the JPEG fallback for a large photo would be dropped on arrival.
const CAPS = ["img", "jpg"];

function normalizeCaps(x) {
  return Array.isArray(x) ? x.filter((c) => typeof c === "string") : [];
}

function hashPwd(pwd) {
  return crypto.createHash("sha256").update(String(pwd || "")).digest("hex");
}

// A single JSON line is the framing, so a peer that never sends a newline would
// otherwise grow this buffer without bound. Generous: a base64 8 MB PNG is
// ~10.7 MB, and the cap only has to be above anything we would legitimately
// send, below "this is not a NetMouse peer any more".
const MAX_LINE_BYTES = 48 * 1024 * 1024;

function makeSender(socket) {
  return function send(msg) {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      return false;
    }
  };
}

function attachReader(socket, onMessage, log) {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > MAX_LINE_BYTES) {
      log?.warn(`协议行超过 ${MAX_LINE_BYTES} 字节上限，断开该连接`);
      buf = "";
      socket.destroy();
      return;
    }
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  });
}

// Server: accepts one authenticated peer. `onPeer(send, socket)` gets a sender
// and a way to register the message handler.
function startServer({ port, password, log, onError }, { onPeer, onClose }) {
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let authed = false;
    let onMsg = null;

    attachReader(
      socket,
      (msg) => {
        if (msg.t === "ping") return socket.write('{"t":"pong"}\n');
        if (msg.t === "pong") return;
        if (!authed) {
          if (msg.t === "hello" && msg.pwd === hashPwd(password)) {
            authed = true;
            const peerCaps = normalizeCaps(msg.caps);
            socket.write(JSON.stringify({ t: "ok", caps: CAPS }) + "\n");
            log.info("peer authenticated", socket.remoteAddress);
            onPeer(makeSender(socket), {
              onMessage: (fn) => (onMsg = fn),
              caps: peerCaps,
            });
          } else {
            log.warn("peer rejected (bad password)", socket.remoteAddress);
            socket.destroy();
          }
          return;
        }
        if (onMsg) onMsg(msg);
      },
      log
    );

    socket.on("close", () => {
      sockets.delete(socket);
      if (authed) {
        log.warn("peer disconnected");
        onClose?.();
      }
    });
    socket.on("error", (e) => log.warn("socket error:", e.message));
  });

  server.on("error", (e) => {
    log.error("server error:", e.message);
    onError?.(e);
  });
  server.listen(port, () => log.info(`listening on :${port}`));

  return {
    server,
    // Destroy live sockets too: server.close() alone keeps the listening port
    // bound until every connection drains, which would make "Restart node"
    // fail with EADDRINUSE.
    close() {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      sockets.clear();
      try {
        server.close();
      } catch {
        /* not listening */
      }
    },
  };
}

// Client: connects, authenticates, auto-reconnects with exponential backoff.
// `onConnected(send)` fires once authed; `onMessage` receives every post-auth
// message.
function connectClient({ host, port, password, log }, { onConnected, onMessage, onClose }) {
  let socket;
  let reconnectTimer;
  let stopped = false;
  let attempt = 0;

  const BACKOFF_MIN = 1000;
  const BACKOFF_MAX = 15000;

  function connect() {
    if (stopped) return;
    socket = net.connect({ host, port });
    socket.setNoDelay(true);

    socket.on("connect", () => {
      socket.write(
        JSON.stringify({ t: "hello", pwd: hashPwd(password), caps: CAPS }) + "\n"
      );
    });

    let authed = false;
    attachReader(
      socket,
      (msg) => {
        if (msg.t === "ping") return socket.write('{"t":"pong"}\n');
        if (msg.t === "pong") return;
        if (!authed) {
          if (msg.t === "ok") {
            authed = true;
            attempt = 0; // a good connection resets the backoff
            log.info("connected to", `${host}:${port}`);
            onConnected(makeSender(socket), { caps: normalizeCaps(msg.caps) });
          }
          return;
        }
        onMessage(msg);
      },
      log
    );

    socket.on("error", (e) => log.warn("connection error:", e.message));
    socket.on("close", () => {
      if (stopped) return; // explicit stop(): do not schedule another attempt
      if (authed) onClose?.();
      authed = false;
      clearTimeout(reconnectTimer);
      // 1s, 2s, 4s, 8s, then 15s, with a little jitter so two clients that lose
      // the server at the same moment do not retry in lockstep.
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt) + Math.floor(Math.random() * 250);
      attempt += 1;
      log.warn(`reconnecting in ${(delay / 1000).toFixed(1)}s…`);
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (socket) socket.destroy();
    },
  };
}

module.exports = { startServer, connectClient, hashPwd, CAPS, normalizeCaps, MAX_LINE_BYTES };

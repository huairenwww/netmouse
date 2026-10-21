// ---------------------------------------------------------------------------
// Clipboard sharing: plain text AND images.
//
// The polling loop and the peer I/O are injected so the (tricky) loop-guard
// logic is testable without Electron. Both ends run the same code:
//
//   * poll the local clipboard; if it changed since the last value we sent AND
//     it is not the value we just applied from the peer, ship it as { t:"cb" }
//   * on receiving { t:"cb" }, write it locally and remember it so the next
//     poll does not bounce it straight back (no echo loop).
//
// Text and images differ in one way that shapes everything below: text is a
// value you can compare with `===`, an image is a blob you cannot. So an image
// is identified by the SHA-256 of its **decoded pixels**, and every "is this
// the thing I just sent?" question is a comparison of that key.
//
// Pixels, not PNG bytes, and that distinction is not academic. Measured on this
// build machine, Electron's clipboard does NOT round-trip PNG bytes: writing a
// 1x1 PNG and reading it back gives different bytes (70 -> 83) with identical
// pixels, because `toPNG()` re-encodes the stored bitmap. A hash of the encoded
// bytes therefore never matches what the other end hashed, and the two machines
// would bounce the same image back and forth forever. Hashing the bitmap fixes
// it, because the bitmap is what the clipboard actually stores.
//
// The other measurement that shaped this file: `toPNG()` costs ~103 ms at
// 1920x1080 and ~180 ms at 2560x1440, while `toBitmap()` + SHA-256 costs
// ~7-15 ms. So the poll NEVER encodes -- `readImage()` returns a lazily-encoded
// handle, and the encode only happens on the tick that actually sends. Images
// are also polled on every Nth tick rather than every tick, which keeps the
// steady-state cost of a screenshot sitting on the clipboard near zero.
//
// **Two wire formats, chosen automatically.** What you copy is never limited by
// this: the clipboard hands over a decoded bitmap whatever the source was (a
// JPEG from a browser, a PNG from a screenshot tool, a WebP, a BMP), and this
// file only ever sees pixels. The wire format is a separate question, and it
// used to have exactly one answer, PNG. That is lossless and right for the
// common case -- a screenshot of text or a diagram survives a round trip
// exactly -- but a *photograph* encoded as PNG is routinely 20-40 MB, so it hit
// the size cap and was dropped whole: "copy a photo, nothing arrives".
//
// So PNG stays the default and JPEG is the fallback: if the PNG does not fit
// under the cap, re-encode as JPEG, stepping quality down until it does. The
// receiver decodes whichever arrived. Only those two are accepted off the wire
// (they are the two formats Chromium's decoder handles), the declared format
// must agree with the payload's magic bytes, and anything else is refused
// rather than handed to a decoder to make up its own mind about.
//
// Three deliberate policies:
//
//   1. **Text wins.** If the clipboard carries text, only the text is synced --
//      even when an image is also present (browsers routinely put both on the
//      clipboard when you copy a picture). This keeps the common case exactly
//      as it was before images existed, and means "copy some text" never
//      surprises you by sending a bitmap instead.
//   2. **Images are opt-in per peer.** The capability is negotiated in the
//      handshake (`caps`), so a newer NetMouse never pushes a multi-megabyte
//      payload at an older one that would silently drop it.
//   3. **Oversized payloads are dropped and remembered.** Dropping without
//      remembering would retry the same huge blob forever.
// ---------------------------------------------------------------------------

const crypto = require("crypto");

const DEFAULT_INTERVAL_MS = 600;
const DEFAULT_MAX_BYTES = 1_000_000; // 1 MB of text is already unusual
// 8 MB of encoded image. Base64 inflates that to ~10.7 MB on the wire, which is
// still a single JSON line the reader can buffer. The real limit is that a
// clipboard image is a screenshot or a photo: a screenshot lands well under
// this as PNG, and a photo that does not is re-encoded as JPEG (see the header)
// rather than dropped.
const DEFAULT_MAX_IMAGE_BYTES = 8_000_000;
// Text is polled every tick; images every Nth. See the header for the numbers.
const DEFAULT_IMAGE_EVERY = 3;

// PNG's 8-byte signature. Checked before handing bytes to the image decoder:
// base64 decoding is lenient and will happily turn a truncated or corrupt
// payload into garbage, and "this is not a PNG" is a far more useful message
// than whatever the decoder says about the garbage.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// JPEG's SOI marker. Three bytes is the whole of what is cheap to check; the
// rest of the header is a sequence of segments and verifying it properly is
// the decoder's job, not ours.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// The wire formats, keyed by the short name used on the wire. `test` is the
// magic-byte check; `mime` is only used in messages. Keeping this a table (and
// not two `if`s) is what makes "which formats do we accept?" a single readable
// answer that a test can enumerate.
const IMAGE_FORMATS = {
  png: { mime: "image/png", test: (b) => isPng(b) },
  jpeg: { mime: "image/jpeg", test: (b) => isJpeg(b) },
};

// Quality ladder for the JPEG fallback, best first. The first rung that fits
// under the cap wins, so a photo only degrades as far as it has to: q92 is
// visually lossless for most content, q60 is the last rung before a photo
// starts looking obviously soft.
const JPEG_QUALITIES = [92, 85, 78, 70, 60];

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC);
}

// Accepts what a peer might plausibly write: the short name we send ("jpeg"),
// the common alias ("jpg"), and the MIME type ("image/jpeg"). Returns null for
// anything else, which the caller turns into a refusal that names the format --
// guessing at an unknown payload is how you end up decoding garbage.
function normalizeImageFormat(fmt) {
  const s = String(fmt == null ? "" : fmt)
    .trim()
    .toLowerCase();
  if (s === "png" || s === "image/png") return "png";
  if (s === "jpeg" || s === "jpg" || s === "image/jpeg" || s === "image/jpg") return "jpeg";
  return null;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function createClipboardSync({
  io,
  send,
  log,
  intervalMs,
  maxBytes,
  maxImageBytes,
  imageEvery,
  images = false,
  jpeg = false,
} = {}) {
  const every = intervalMs || DEFAULT_INTERVAL_MS;
  const cap = maxBytes || DEFAULT_MAX_BYTES;
  const imgCap = maxImageBytes || DEFAULT_MAX_IMAGE_BYTES;
  const imgEvery = Math.max(1, imageEvery || DEFAULT_IMAGE_EVERY);
  // The caller has already folded "the user wants images" and "the peer said it
  // understands them" into `images`; all we check here is that this clipboard
  // backend can actually read one.
  const imagesOn = !!images && typeof io?.readImage === "function";
  // Whether the peer can decode JPEG. Separate from `images` on purpose: a
  // 0.2.11 peer understands images but only PNG, and pushing JPEG at it would
  // waste the transfer and be dropped on arrival -- the exact failure the caps
  // handshake exists to prevent.
  const jpegOn = imagesOn && !!jpeg;

  let lastSent = null; // last text we pushed to the peer
  let lastApplied = null; // last text we took from the peer
  let lastSentImg = null; // pixel key of the last image we pushed
  let lastAppliedImg = null; // pixel key of the last image we took
  let ticks = 0;
  let timer = null;
  let active = false;

  // The key that identifies an image by its PIXELS. Prefers the backend's own
  // decoder (Electron re-encodes on read, so byte hashing would never match);
  // falls back to hashing the bytes, which is correct for a backend that stores
  // them verbatim. Works for either wire format -- the decoder sniffs it.
  function keyOfIncoming(bytes) {
    if (typeof io.imageKey === "function") {
      try {
        return io.imageKey(bytes);
      } catch (e) {
        log?.debug("clipboard image decode failed:", e.message);
        return null;
      }
    }
    return sha256(bytes);
  }

  function tick() {
    if (!active) return;
    ticks += 1;
    let text;
    try {
      text = io.read();
    } catch (e) {
      log?.debug("clipboard read failed:", e.message);
      return;
    }
    if (typeof text === "string" && text.length > 0) {
      tickText(text);
      return;
    }
    // Images are the expensive half of the poll, so they get every Nth tick.
    if (imagesOn && ticks % imgEvery === 0) tickImage();
  }

  function tickText(text) {
    if (text === lastSent) return; // nothing new since our last push
    if (text === lastApplied) {
      // Our own applied write showing up in the local clipboard.
      lastSent = text;
      return;
    }
    if (text.length > cap) {
      lastSent = text; // remember so we do not retry it every tick
      log?.warn(`clipboard payload too large (${text.length} chars), not synced`);
      return;
    }
    lastSent = text;
    send({ t: "cb", text });
  }

  // Decides what actually goes on the wire for this image. Returns
  //   { format, bytes, quality? }            -> send it
  //   { format, bytes, over: true, why }     -> too big even after degrading
  //   null                                   -> nothing encodable, stay quiet
  //
  // PNG is tried first and is used whenever it fits: it is lossless, and for
  // the overwhelmingly common case (a screenshot, a diagram, anything with
  // text) it is also smaller than a JPEG at a quality that keeps the text
  // legible. JPEG only enters when PNG does not fit -- which is exactly the
  // photo case that used to be dropped whole.
  //
  // Cost: `toPng()` is ~100-180 ms at screenshot sizes, and each JPEG rung
  // ~20-40 ms. That is fine because this runs once per *change*, never per
  // tick -- `lastSentImg` is set before we get here.
  function encodeForWire(img) {
    let png;
    try {
      png = img.toPng();
    } catch (e) {
      log?.debug("clipboard image encode failed:", e.message);
      return null;
    }
    if (!png || !png.length) return null;
    if (png.length <= imgCap) return { format: "png", bytes: png };

    if (!jpegOn || typeof img.toJpeg !== "function") {
      return {
        format: "png",
        bytes: png,
        over: true,
        why: jpegOn ? "本机剪贴板后端不支持 JPEG 编码" : "对端未声明 JPEG 能力",
      };
    }

    // Walk the ladder down; keep the smallest attempt so a failure can quote a
    // real number ("even q60 was 9.1 MB") instead of just "too big".
    let smallest = null;
    for (const q of JPEG_QUALITIES) {
      let j;
      try {
        j = img.toJpeg(q);
      } catch (e) {
        log?.debug("clipboard jpeg encode failed:", e.message);
        break;
      }
      if (!j || !j.length) continue;
      if (!smallest || j.length < smallest.bytes.length) {
        // `pngBytes` rides along so the log line can say what we started from
        // ("PNG 12.4 MB -> JPEG q92 3.6 MB"), which is the difference between
        // "it worked" and "why is my screenshot suddenly blurry".
        smallest = { format: "jpeg", bytes: j, quality: q, pngBytes: png.length };
      }
      if (j.length <= imgCap) return smallest;
    }
    if (!smallest) return { format: "png", bytes: png, over: true, why: "JPEG 编码失败" };
    return { ...smallest, over: true, why: `已降到 JPEG q${smallest.quality}` };
  }

  function tickImage() {
    let img;
    try {
      img = io.readImage();
    } catch (e) {
      log?.debug("clipboard image read failed:", e.message);
      return;
    }
    if (!img || !img.key) return;
    if (img.key === lastSentImg) return; // unchanged since our last push
    if (img.key === lastAppliedImg) {
      // Our own applied write showing up locally.
      lastSentImg = img.key;
      return;
    }
    // Only now, on the tick that actually sends, is anything encoded.
    const enc = encodeForWire(img);
    if (!enc) return;
    if (enc.over) {
      lastSentImg = img.key; // remember, or we re-encode and re-warn every tick
      log?.warn(
        `剪贴板图片过大（${fmtBytes(enc.bytes.length)} > 上限 ${fmtBytes(
          imgCap
        )}），未同步：${enc.why}`
      );
      return;
    }
    lastSentImg = img.key;
    send({
      t: "cb",
      kind: "image",
      format: enc.format,
      data: enc.bytes.toString("base64"),
      w: img.width || 0,
      h: img.height || 0,
    });
    if (enc.format === "jpeg") {
      log?.debug(
        `剪贴板图片已发送（PNG ${fmtBytes(enc.pngBytes)} 超过上限，转 JPEG q${
          enc.quality
        }，${fmtBytes(enc.bytes.length)}）`
      );
    } else {
      log?.debug(`剪贴板图片已发送（PNG ${fmtBytes(enc.bytes.length)}）`);
    }
  }

  function onMessage(msg) {
    if (!msg || msg.t !== "cb") return false;
    // An absent `kind` means text: that is what a peer predating images sends,
    // and it must keep working byte-for-byte.
    const kind = msg.kind || "text";
    if (kind === "image") return onImageMessage(msg);
    if (kind !== "text") {
      // A kind we do not know (a newer peer). Consume it rather than letting it
      // fall through to the injector, which would not know what to do with it.
      log?.debug(`忽略不认识的剪贴板类型：${kind}`);
      return true;
    }
    if (typeof msg.text !== "string") return true;
    if (msg.text === lastSent) {
      // Echo of what we just sent — nothing to do.
      lastApplied = msg.text;
      return true;
    }
    if (msg.text.length > cap) {
      log?.warn("incoming clipboard payload too large, ignored");
      return true;
    }
    try {
      io.write(msg.text);
    } catch (e) {
      log?.warn("clipboard write failed:", e.message);
      return true;
    }
    lastApplied = msg.text;
    lastSent = msg.text; // suppress the echo from our own next poll
    log?.debug("clipboard updated from peer");
    return true;
  }

  function onImageMessage(msg) {
    const format = normalizeImageFormat(msg.format);
    if (!format) {
      // Only the two formats Chromium's decoder handles travel. Anything else
      // -- a newer peer, a corrupt frame, a hand-typed payload -- is refused by
      // name rather than guessed at.
      log?.warn(`收到不支持的剪贴板图片格式「${msg.format}」，已忽略`);
      return true;
    }
    if (typeof msg.data !== "string" || !msg.data) return true;
    let bytes;
    try {
      bytes = Buffer.from(msg.data, "base64");
    } catch {
      return true;
    }
    if (!bytes.length) return true;
    if (bytes.length > imgCap) {
      log?.warn(`对端发来的剪贴板图片过大（${fmtBytes(bytes.length)}），已忽略`);
      return true;
    }
    if (!IMAGE_FORMATS[format].test(bytes)) {
      // The label and the payload must agree. base64 decoding is lenient
      // enough that a truncated or corrupt payload still yields *some* bytes,
      // and "this is not a PNG" is far more useful than a decoder complaint
      // about garbage.
      log?.warn(`对端发来的剪贴板图片不是合法 ${format.toUpperCase()}，已忽略`);
      return true;
    }
    // The key is derived from the DECODED pixels, so it matches what the sender
    // computed even though our clipboard will re-encode (and, for JPEG, that
    // the lossy round trip changed the pixels slightly -- each side hashes its
    // own bitmap, which is what makes the comparison stable).
    const key = keyOfIncoming(bytes);
    if (!key) {
      log?.warn("对端发来的剪贴板图片无法解析，已忽略");
      return true;
    }
    if (key === lastSentImg) {
      // Echo of what we just sent.
      lastAppliedImg = key;
      return true;
    }
    if (key === lastAppliedImg) return true; // duplicate delivery
    if (typeof io.writeImage !== "function") {
      log?.warn("本机剪贴板后端不支持写入图片，已忽略对端图片");
      return true;
    }
    try {
      io.writeImage({ data: bytes, format, width: msg.w, height: msg.h });
    } catch (e) {
      log?.warn("写入剪贴板图片失败:", e.message);
      return true;
    }
    lastAppliedImg = key;
    lastSentImg = key; // suppress the echo from our own next poll
    log?.debug(`剪贴板图片已接收（${format.toUpperCase()} ${fmtBytes(bytes.length)}）`);
    return true;
  }

  return {
    start() {
      if (timer || !io) return;
      active = true;
      // Adopt the current clipboard as the baseline so we don't ship whatever
      // happened to be on it before the connection came up.
      try {
        const seed = io.read();
        if (typeof seed === "string") lastSent = seed;
        if (imagesOn && (!seed || seed.length === 0)) {
          const img = io.readImage();
          if (img && img.key) lastSentImg = img.key;
        }
      } catch {
        /* ignore */
      }
      timer = setInterval(tick, every);
      if (timer.unref) timer.unref();
    },
    stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    onMessage,
    isActive: () => active,
    // Whether images will actually flow: the user asked for them AND this
    // backend can read them. Surfaced so the app can say which of the two is
    // missing instead of leaving the user to guess.
    imagesEnabled: () => imagesOn,
    _state: () => ({ lastSent, lastApplied, lastSentImg, lastAppliedImg }),
    _tick: tick, // exposed so the selftest can drive the loop deterministically
  };
}

// Electron-backed clipboard access (main process only). Returns null when
// Electron is unavailable (headless CLI) so callers can skip the feature.
function electronClipboardIO() {
  if (!process.versions.electron) return null;
  try {
    const { clipboard, nativeImage } = require("electron");
    if (!clipboard) return null;

    // Cheap "is there even an image?" pre-check. `toPNG()` copies the whole
    // bitmap and the poll runs every 600 ms, so reading unconditionally would
    // burn CPU on every tick just to find nothing.
    const hasImage = () => {
      try {
        if (typeof clipboard.availableFormats === "function") {
          const formats = clipboard.availableFormats() || [];
          return formats.some((f) => /^image\//i.test(String(f)));
        }
      } catch {
        /* fall through: let the direct read decide */
      }
      return true;
    };

    return {
      read: () => clipboard.readText(),
      write: (text) => clipboard.writeText(text),
      // Returns a handle, NOT the encoded image. `toPng()`/`toJpeg()` are
      // getters on purpose: see the measurements in the header -- encoding on
      // every poll would cost ~100-180 ms per tick at screenshot sizes.
      readImage: () => {
        if (!hasImage()) return null;
        const img = clipboard.readImage();
        if (!img || img.isEmpty()) return null;
        const bmp = img.toBitmap();
        if (!bmp || !bmp.length) return null;
        const size = img.getSize ? img.getSize() : {};
        let encoded; // memoised for this handle: one encode per read, at most
        const jpegs = new Map(); // one per quality actually asked for
        const handle = {
          key: sha256(bmp),
          width: size.width || 0,
          height: size.height || 0,
          toPng: () => {
            if (encoded === undefined) encoded = img.toPNG();
            return encoded;
          },
        };
        // Only present when this Electron build can encode JPEG. The sender
        // checks for the method rather than assuming, so an older runtime
        // degrades to "PNG or nothing" instead of throwing mid-tick.
        if (typeof img.toJPEG === "function") {
          handle.toJpeg = (quality) => {
            const q = Math.max(1, Math.min(100, Math.round(quality || 85)));
            if (!jpegs.has(q)) jpegs.set(q, img.toJPEG(q));
            return jpegs.get(q);
          };
        }
        return handle;
      },
      // The same key, computed from bytes arriving off the wire (PNG or JPEG).
      // Decoding and re-encoding is not identity-preserving, so this has to go
      // through the decoder to be comparable with `readImage().key`.
      imageKey: (bytes) => {
        const img = nativeImage && nativeImage.createFromBuffer(bytes);
        if (!img || img.isEmpty()) return null;
        const bmp = img.toBitmap();
        if (!bmp || !bmp.length) return null;
        return sha256(bmp);
      },
      writeImage: ({ data, format }) => {
        const img = nativeImage && nativeImage.createFromBuffer(data);
        if (!img || img.isEmpty()) {
          throw new Error(`${String(format || "png").toUpperCase()} 解码失败（图片可能已损坏）`);
        }
        clipboard.writeImage(img);
      },
    };
  } catch {
    return null;
  }
}

module.exports = {
  createClipboardSync,
  electronClipboardIO,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_IMAGE_EVERY,
  IMAGE_FORMATS,
  JPEG_QUALITIES,
  sha256,
  isPng,
  isJpeg,
  normalizeImageFormat,
};

"use strict";
// ---------------------------------------------------------------------------
// Unit tests for clipboard sharing -- text, and the new image path.
//
// Why this file exists
// --------------------
// Images break the one assumption the text implementation was built on: that a
// clipboard value can be compared with `===` to decide "is this new?" and "is
// this the thing I just sent?". An image cannot, so every such decision becomes
// a SHA-256 comparison -- and a mistake there does not fail loudly, it produces
// an infinite echo loop between two machines, or a silent refusal to sync.
//
// The other half of the file pins the *capability handshake*. Images are only
// sent to a peer that said it understands them; a build that predates the
// feature must keep working byte-for-byte, which means an absent `caps` and an
// absent `kind` both have to mean "the old thing". Those two are tested over a
// real socket pair, not a mock, because the thing being tested is the wire.
// ---------------------------------------------------------------------------
const assert = require("assert");
const net = require("net");
const { once } = require("events");

const {
  createClipboardSync,
  sha256,
  isPng,
  isJpeg,
  normalizeImageFormat,
  IMAGE_FORMATS,
  JPEG_QUALITIES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_IMAGE_EVERY,
} = require("../src/clipboard");
const { startServer, connectClient, CAPS, normalizeCaps, MAX_LINE_BYTES } = require("../src/protocol");

// A real 1x1 PNG. Using genuine bytes rather than "the first 8 bytes of
// something" keeps the fixture honest: the magic check, the hash and the size
// cap all see what a real clipboard would hand over.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
// A minimal but structurally real JPEG: SOI, then a padding byte. Only the
// three-byte SOI marker is ever inspected, and this keeps the fixture honest
// about "a JPEG starts with FF D8 FF".
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let passed = 0;
const failures = [];
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  \u2717 ${name}\n      ${e.message}`);
  }
}
const check = (name, fn) => checkAsync(name, () => fn());

function makeLog() {
  const lines = [];
  const add = (lvl) => (...a) => lines.push({ lvl, text: a.join(" ") });
  return {
    lines,
    info: add("info"),
    warn: add("warn"),
    error: add("error"),
    debug: add("debug"),
    warns: () => lines.filter((l) => l.lvl === "warn"),
  };
}

// A clipboard backend that behaves like Electron's: one text slot, one image
// slot, and counters so a test can prove a read (or an encode) never happened.
//
// `readImage()` returns a HANDLE, mirroring the real backend: the poll must be
// able to ask "did it change?" without paying for a PNG encode.
//
// `image.jpeg` controls the JPEG encoder the fallback path uses:
//   undefined  -> a small fake JPEG whose size grows with quality
//   false      -> no toJpeg() at all (a runtime that cannot encode JPEG)
//   function   -> (quality) => Buffer, for tests that need exact sizes
function fakeIO({ text = "", image = null } = {}) {
  const s = {
    text,
    image,
    textWrites: [],
    imageWrites: [],
    imageFormats: [],
    textReads: 0,
    imageReads: 0,
    pngEncodes: 0,
    jpegEncodes: 0,
    jpegQualities: [],
  };
  return {
    state: s,
    read() {
      s.textReads += 1;
      return s.text;
    },
    write(t) {
      s.text = t;
      s.textWrites.push(t);
    },
    readImage() {
      s.imageReads += 1;
      if (!s.image) return null;
      const png = s.image.png;
      const handle = {
        key: sha256(png),
        width: s.image.width || 0,
        height: s.image.height || 0,
        toPng: () => {
          s.pngEncodes += 1;
          return png;
        },
      };
      if (s.image.jpeg !== false) {
        // Default: a tiny valid JPEG, so a test that only cares "did the
        // fallback fire?" does not have to think about sizes.
        const enc =
          typeof s.image.jpeg === "function"
            ? s.image.jpeg
            : (q) => Buffer.concat([JPEG_MIN, Buffer.alloc(4)]);
        handle.toJpeg = (q) => {
          s.jpegEncodes += 1;
          s.jpegQualities.push(q);
          return enc(q);
        };
      }
      return handle;
    },
    writeImage({ data, format }) {
      s.image = { png: data, width: 1, height: 1 };
      s.imageWrites.push(data);
      s.imageFormats.push(format);
    },
  };
}

// A backend that mimics Electron's ACTUAL round trip: the clipboard stores
// PIXELS, and reading re-encodes them, so the bytes that come back are not the
// bytes that went in. Hashing PNG bytes would make two such machines echo the
// same image at each other forever -- which is exactly what the first version
// of this feature did, and why this double exists.
//
// The "pixels" here are the first 9 bytes of the PNG (signature + 1 payload
// byte); `toPng()` appends a counter so every encode differs.
function reencodingIO() {
  const s = { pixels: null, text: "", imageWrites: [], encodes: 0 };
  const pixelOf = (png) => png.subarray(0, 9);
  return {
    state: s,
    read: () => s.text,
    write: (t) => {
      s.text = t;
    },
    readImage: () => {
      if (!s.pixels) return null;
      return {
        key: sha256(s.pixels),
        width: 1,
        height: 1,
        toPng: () => {
          s.encodes += 1;
          return Buffer.concat([s.pixels, Buffer.from([s.encodes])]);
        },
      };
    },
    writeImage: ({ data }) => {
      s.pixels = pixelOf(data);
      s.imageWrites.push(data);
    },
    imageKey: (bytes) => sha256(pixelOf(bytes)),
  };
}

function makeSync({ io, images = true, jpeg = false, maxImageBytes, imageEvery, send } = {}) {
  const log = makeLog();
  const sent = [];
  const clip = createClipboardSync({
    io,
    images,
    jpeg,
    maxImageBytes,
    imageEvery: imageEvery || 1, // every tick, so tests drive _tick() directly
    send: send || ((m) => sent.push(m)),
    log,
    intervalMs: 1_000_000, // never fires: the tests drive _tick() themselves
  });
  return { clip, sent, log };
}

const img = (png = PNG_1PX) => ({ png, width: 1, height: 1 });

(async () => {
  // -------------------------------------------------------------------------
  console.log("\n-- text still behaves exactly as before --");

  await check("a new text value is sent once, and only once", () => {
    const io = fakeIO({ text: "seed" });
    const { clip, sent } = makeSync({ io });
    clip.start(); // adopts the baseline
    assert.strictEqual(sent.length, 0, "the pre-existing clipboard is not shipped on start");
    io.state.text = "local-copy";
    clip._tick();
    assert.deepStrictEqual(sent, [{ t: "cb", text: "local-copy" }]);
    clip._tick();
    assert.strictEqual(sent.length, 1, "an unchanged clipboard is not re-sent");
    clip.stop();
  });

  await check("applied peer text is written locally and not echoed back", () => {
    const io = fakeIO({ text: "seed" });
    const { clip, sent } = makeSync({ io });
    clip.start();
    assert.strictEqual(clip.onMessage({ t: "cb", text: "from-peer" }), true);
    assert.strictEqual(io.state.text, "from-peer");
    clip._tick();
    assert.strictEqual(sent.length, 0, "our own applied write must not bounce back");
    clip.stop();
  });

  await check("a message with no `kind` is text -- the older wire format", () => {
    const io = fakeIO();
    const { clip } = makeSync({ io });
    assert.strictEqual(clip.onMessage({ t: "cb", text: "old-peer" }), true);
    assert.strictEqual(io.state.text, "old-peer");
  });

  await check("non-clipboard messages are left for the injector", () => {
    const io = fakeIO();
    const { clip } = makeSync({ io });
    assert.strictEqual(clip.onMessage({ t: "mm", x: 1, y: 2 }), false);
    assert.strictEqual(clip.onMessage(null), false);
  });

  // -------------------------------------------------------------------------
  console.log("\n-- images: sending --");

  await check("an image is sent when the clipboard carries no text", () => {
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    io.state.image = img();
    clip._tick();
    assert.strictEqual(sent.length, 1);
    const m = sent[0];
    assert.strictEqual(m.t, "cb");
    assert.strictEqual(m.kind, "image");
    assert.strictEqual(m.format, "png");
    assert.strictEqual(m.w, 1);
    assert.strictEqual(m.h, 1);
    assert.deepStrictEqual(Buffer.from(m.data, "base64"), PNG_1PX, "the bytes must survive base64");
    clip.stop();
  });

  await check("the same image is not sent twice -- and is never re-encoded to find that out", () => {
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    io.state.image = img();
    clip._tick();
    const encodesAfterSend = io.state.pngEncodes;
    clip._tick();
    clip._tick();
    assert.strictEqual(sent.length, 1, "identical bytes must be recognised by key");
    assert.strictEqual(
      io.state.pngEncodes,
      encodesAfterSend,
      "an unchanged image must not be encoded again (toPNG is ~100-180 ms)"
    );
    clip.stop();
  });

  await check("a different image IS sent, even at the same size", () => {
    // The key has to be over the content, not the length: two screenshots of
    // the same window are the same size and must still both sync.
    const other = Buffer.concat([PNG_1PX, Buffer.from([0])]);
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    io.state.image = img();
    clip._tick();
    io.state.image = { png: other, width: 1, height: 1 };
    clip._tick();
    assert.strictEqual(sent.length, 2);
    assert.notStrictEqual(sent[0].data, sent[1].data);
    clip.stop();
  });

  // -------------------------------------------------------------------------
  console.log("\n-- the re-encoding backend (what Electron really does) --");

  await check("an image applied from the peer is NOT echoed back, even though the bytes change", () => {
    // The regression test for the real bug. Electron's clipboard stores a
    // bitmap and re-encodes it on read, so writeImage(x) then readImage()
    // yields different bytes. Hashing those bytes meant the key never matched
    // the sender's, and the two ends bounced the image forever.
    const io = reencodingIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    const wire = Buffer.concat([PNG_1PX.subarray(0, 9), Buffer.from([0xaa])]);
    assert.strictEqual(
      clip.onMessage({ t: "cb", kind: "image", format: "png", data: wire.toString("base64"), w: 1, h: 1 }),
      true
    );
    assert.strictEqual(io.state.imageWrites.length, 1, "it must be written locally");
    clip._tick();
    clip._tick();
    assert.strictEqual(sent.length, 0, "and must NOT be sent back");
    clip.stop();
  });

  await check("with byte-hashing, that same case would have echoed (the double proves it)", () => {
    // Guards the double itself: if `toPng()` ever returned the input bytes
    // verbatim, the test above would pass for the wrong reason.
    const io = reencodingIO();
    const wire = Buffer.concat([PNG_1PX.subarray(0, 9), Buffer.from([0xaa])]);
    io.writeImage({ data: wire, format: "png" });
    const back = io.readImage();
    assert.notDeepStrictEqual(
      back.toPng(),
      wire,
      "this double must NOT round-trip bytes, or it cannot catch the bug"
    );
    assert.strictEqual(
      back.key,
      io.imageKey(wire),
      "but the pixel key MUST round-trip -- that is the whole fix"
    );
  });

  await check("a backend with no imageKey falls back to hashing the bytes", () => {
    // Correct for a backend that stores bytes verbatim; the Electron backend
    // supplies imageKey precisely because it does not.
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    clip.onMessage({ t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64") });
    clip._tick();
    assert.strictEqual(sent.length, 0, "no echo with the byte-hash fallback either");
    clip.stop();
  });

  await check("an undecodable image is refused rather than written", () => {
    const io = reencodingIO();
    io.imageKey = () => null; // decoder says no
    const { clip, log } = makeSync({ io });
    clip.onMessage({ t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64") });
    assert.strictEqual(io.state.imageWrites.length, 0);
    assert.ok(log.warns().some((w) => /无法解析/.test(w.text)));
  });

  await check("text wins when the clipboard carries both", () => {
    // Browsers put text/HTML and a bitmap on the clipboard together when you
    // copy a picture. Sending the bitmap would be a surprise, and it would also
    // make "copy some text" behave differently depending on the source app.
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    io.state.text = "some text";
    io.state.image = img();
    clip._tick();
    assert.deepStrictEqual(sent, [{ t: "cb", text: "some text" }]);
    assert.strictEqual(io.state.imageReads, 1, "only start() may probe the image slot");
    clip.stop();
  });

  await check("with images off, the image slot is never even read", () => {
    const io = fakeIO();
    const { clip, sent } = makeSync({ io, images: false });
    clip.start();
    io.state.image = img();
    clip._tick();
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(io.state.imageReads, 0, "no image read when the feature is off");
    assert.strictEqual(clip.imagesEnabled(), false);
    clip.stop();
  });

  await check("images are polled every Nth tick; text is polled every tick", () => {
    // The cadence is the other half of the cost fix: a key-only poll is ~7-15 ms
    // at screenshot sizes, so it does not run at the text rate.
    const io = fakeIO();
    const log = makeLog();
    const sent = [];
    const clip = createClipboardSync({
      io,
      images: true,
      imageEvery: 3,
      send: (m) => sent.push(m),
      log,
      intervalMs: 1_000_000,
    });
    clip.start();
    const afterStart = io.state.imageReads;
    io.state.image = img();
    clip._tick();
    clip._tick();
    assert.strictEqual(io.state.imageReads, afterStart, "not polled before the Nth tick");
    clip._tick();
    assert.strictEqual(io.state.imageReads, afterStart + 1, "polled on the Nth tick");
    assert.strictEqual(sent.length, 1, "and sent when it finally is polled");
    clip.stop();
  });

  await check("the default image cadence is the documented one", () => {
    assert.strictEqual(DEFAULT_IMAGE_EVERY, 3);
  });

  await check("start() adopts a pre-existing clipboard image as the baseline", () => {
    const io = fakeIO();
    io.state.image = img();
    const { clip, sent } = makeSync({ io });
    clip.start();
    clip._tick();
    assert.strictEqual(sent.length, 0, "whatever was already copied must not be shipped");
    clip.stop();
  });

  await check("an oversized image is dropped -- and remembered, so it warns once", () => {
    const io = fakeIO();
    const { clip, sent, log } = makeSync({ io, maxImageBytes: 32 });
    clip.start();
    io.state.image = img(); // PNG_1PX is larger than 32 bytes
    clip._tick();
    clip._tick();
    clip._tick();
    assert.strictEqual(sent.length, 0, "an oversized image must not be sent");
    assert.strictEqual(log.warns().length, 1, "it must be remembered, not retried every tick");
    assert.ok(/过大/.test(log.warns()[0].text), "the warning should say what happened");
    clip.stop();
  });

  await check("a backend with no readImage at all is treated as text-only", () => {
    const log = makeLog();
    const sent = [];
    const clip = createClipboardSync({
      io: { read: () => "", write: () => {} }, // no image methods
      images: true,
      send: (m) => sent.push(m),
      log,
      intervalMs: 1_000_000,
    });
    clip.start();
    clip._tick();
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(clip.imagesEnabled(), false);
    clip.stop();
  });

  // -------------------------------------------------------------------------
  console.log("\n-- choosing a wire format (PNG first, JPEG when PNG is too big) --");

  await check("a PNG that fits is sent as PNG even when JPEG is available", () => {
    // The whole point of trying PNG first: it is lossless, and for a
    // screenshot of text it is also smaller than a legible JPEG. Reaching for
    // the lossy encoder when it is not needed would degrade every screenshot.
    const io = fakeIO();
    const { clip, sent } = makeSync({ io, jpeg: true, maxImageBytes: 1_000_000 });
    clip.start();
    io.state.image = img();
    clip._tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].format, "png");
    assert.strictEqual(io.state.jpegEncodes, 0, "JPEG must not be encoded when PNG fits");
    clip.stop();
  });

  await check("a PNG over the cap is re-encoded as JPEG instead of being dropped", () => {
    // The regression this feature exists for: copy a photo, PNG is 20-40 MB,
    // the old code dropped it whole and the user saw nothing arrive.
    const io = fakeIO();
    const { clip, sent } = makeSync({ io, jpeg: true, maxImageBytes: 32 });
    clip.start();
    io.state.image = img(); // PNG_1PX is ~70 B, over a 32 B cap
    clip._tick();
    assert.strictEqual(sent.length, 1, "it must go out, not be dropped");
    assert.strictEqual(sent[0].format, "jpeg");
    assert.strictEqual(sent[0].kind, "image");
    assert.strictEqual(sent[0].t, "cb");
    assert.ok(isJpeg(Buffer.from(sent[0].data, "base64")), "the payload must be the JPEG bytes");
    assert.strictEqual(sent[0].w, 1);
    clip.stop();
  });

  await check("the highest quality that fits is the one chosen", () => {
    // Degrade only as far as necessary: q92 if it fits, q85 next, and so on.
    const sizes = { 92: 200, 85: 100, 78: 20, 70: 10, 60: 5 };
    const io = fakeIO();
    const { clip, sent } = makeSync({ io, jpeg: true, maxImageBytes: 50 });
    clip.start(); // before the image exists, so it is not adopted as the baseline
    io.state.image = img();
    io.state.image.jpeg = (q) => Buffer.concat([JPEG_MIN, Buffer.alloc(sizes[q] - JPEG_MIN.length)]);
    clip._tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].format, "jpeg");
    assert.deepStrictEqual(
      io.state.jpegQualities,
      [92, 85, 78],
      "it must try 92, 85, then stop at the first that fits -- not walk the whole ladder"
    );
    assert.strictEqual(Buffer.from(sent[0].data, "base64").length, 20);
    clip.stop();
  });

  await check("the JPEG quality ladder is the documented one, best first", () => {
    assert.deepStrictEqual(JPEG_QUALITIES, [92, 85, 78, 70, 60]);
  });

  await check("with no JPEG capability on the peer, an oversized PNG is still dropped", () => {
    // 0.2.8..0.2.11 understand images but only PNG. Sending them JPEG would
    // transfer megabytes and be refused on arrival -- worse than not trying.
    const io = fakeIO();
    const { clip, sent, log } = makeSync({ io, jpeg: false, maxImageBytes: 32 });
    clip.start();
    io.state.image = img();
    clip._tick();
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(io.state.jpegEncodes, 0, "no point encoding a format they cannot read");
    assert.ok(log.warns().some((w) => /JPEG/.test(w.text)), "the warning must name the reason");
    clip.stop();
  });

  await check("a runtime that cannot encode JPEG drops rather than pretending", () => {
    const io = fakeIO();
    const { clip, sent, log } = makeSync({ io, jpeg: true, maxImageBytes: 32 });
    clip.start();
    io.state.image = { ...img(), jpeg: false }; // handle has no toJpeg()
    clip._tick();
    assert.strictEqual(sent.length, 0);
    assert.ok(log.warns().some((w) => /不支持 JPEG 编码/.test(w.text)));
    clip.stop();
  });

  await check("when even the lowest quality is too large, the warning quotes the real number", () => {
    // "too large" on its own is unactionable. The user needs to know the cap
    // was not the problem -- the image was enormous even as a q60 JPEG.
    const io = fakeIO();
    const { clip, sent, log } = makeSync({ io, jpeg: true, maxImageBytes: 32 });
    clip.start();
    io.state.image = img();
    io.state.image.jpeg = (q) => Buffer.concat([JPEG_MIN, Buffer.alloc(q * 100)]);
    clip._tick();
    clip._tick();
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(log.warns().length, 1, "remembered: one warning, not one per tick");
    const w = log.warns()[0].text;
    assert.ok(/过大/.test(w), w);
    assert.ok(/q60/.test(w), `the warning should name the best attempt: ${w}`);
    assert.ok(/未同步/.test(w), w);
    clip.stop();
  });

  // -------------------------------------------------------------------------
  console.log("\n-- images: receiving --");

  await check("an incoming image is written locally and not echoed back", () => {
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    const msg = { t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64"), w: 1, h: 1 };
    assert.strictEqual(clip.onMessage(msg), true);
    assert.strictEqual(io.state.imageWrites.length, 1);
    assert.deepStrictEqual(io.state.imageWrites[0], PNG_1PX, "the bytes must arrive intact");
    clip._tick();
    assert.strictEqual(sent.length, 0, "our own applied image must not bounce back");
    clip.stop();
  });

  await check("the same image delivered twice is written once", () => {
    const io = fakeIO();
    const { clip } = makeSync({ io });
    clip.start();
    const msg = { t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64"), w: 1, h: 1 };
    clip.onMessage(msg);
    clip.onMessage(msg);
    assert.strictEqual(io.state.imageWrites.length, 1);
    clip.stop();
  });

  await check("a format we do not implement is refused, not guessed at", () => {
    const io = fakeIO();
    const { clip, log } = makeSync({ io });
    assert.strictEqual(
      clip.onMessage({ t: "cb", kind: "image", format: "image/webp", data: "AAAA" }),
      true
    );
    assert.strictEqual(io.state.imageWrites.length, 0);
    assert.ok(/webp/.test(log.warns().join(" ") + log.warns().map((w) => w.text).join(" ")));
  });

  await check("an incoming JPEG is written locally, with its format preserved", () => {
    const io = fakeIO();
    const { clip, sent } = makeSync({ io });
    clip.start();
    const msg = {
      t: "cb",
      kind: "image",
      format: "jpeg",
      data: JPEG_MIN.toString("base64"),
      w: 1,
      h: 1,
    };
    assert.strictEqual(clip.onMessage(msg), true);
    assert.strictEqual(io.state.imageWrites.length, 1, "it must be written");
    assert.deepStrictEqual(io.state.imageWrites[0], JPEG_MIN, "bytes must arrive intact");
    assert.strictEqual(
      io.state.imageFormats[0],
      "jpeg",
      "the backend needs to know what it is decoding"
    );
    clip._tick();
    clip._tick();
    assert.strictEqual(sent.length, 0, "and must NOT be echoed back");
    clip.stop();
  });

  await check("format aliases are accepted, because the label is not the contract", () => {
    // A peer may write "jpg" or "image/jpeg"; refusing those over spelling
    // would be a compatibility bug that looks like a format bug.
    for (const alias of ["jpeg", "jpg", "image/jpeg", "IMAGE/JPEG"]) {
      const io = fakeIO();
      const { clip } = makeSync({ io });
      clip.onMessage({
        t: "cb",
        kind: "image",
        format: alias,
        data: JPEG_MIN.toString("base64"),
      });
      assert.strictEqual(io.state.imageWrites.length, 1, `alias "${alias}" should be accepted`);
      assert.strictEqual(io.state.imageFormats[0], "jpeg", "and normalised to the short name");
    }
  });

  await check("the declared format and the payload must agree", () => {
    // Both directions. If we trusted either one alone, a corrupt frame would be
    // handed to the decoder to produce a confusing error instead of a clear
    // refusal -- and trusting the payload alone would let a PNG through on the
    // JPEG path and vice versa.
    for (const [declared, bytes] of [
      ["jpeg", PNG_1PX],
      ["png", JPEG_MIN],
    ]) {
      const io = fakeIO();
      const { clip, log } = makeSync({ io });
      clip.onMessage({ t: "cb", kind: "image", format: declared, data: bytes.toString("base64") });
      assert.strictEqual(io.state.imageWrites.length, 0, `${declared} mismatch must be refused`);
      assert.ok(
        log.warns().some((w) => new RegExp(declared.toUpperCase()).test(w.text)),
        `the warning should name ${declared}`
      );
    }
  });

  await check("normalizeImageFormat and isJpeg behave", () => {
    assert.strictEqual(normalizeImageFormat("png"), "png");
    assert.strictEqual(normalizeImageFormat("image/png"), "png");
    assert.strictEqual(normalizeImageFormat("jpg"), "jpeg");
    assert.strictEqual(normalizeImageFormat("image/jpg"), "jpeg");
    assert.strictEqual(normalizeImageFormat("webp"), null);
    assert.strictEqual(normalizeImageFormat(undefined), null);
    assert.strictEqual(normalizeImageFormat(null), null);
    assert.deepStrictEqual(Object.keys(IMAGE_FORMATS), ["png", "jpeg"], "exactly two wire formats");
    assert.strictEqual(isJpeg(JPEG_MIN), true);
    assert.strictEqual(isJpeg(PNG_1PX), false, "a PNG must not pass the JPEG check");
    assert.strictEqual(isJpeg(Buffer.from([0xff, 0xd8])), false, "two bytes is not enough to judge");
    assert.strictEqual(isJpeg(null), false);
    assert.strictEqual(isPng(JPEG_MIN), false, "nor a JPEG pass the PNG check");
  });

  await check("a payload that is not really a PNG is refused", () => {
    // base64 decoding is lenient: garbage decodes to garbage without throwing.
    // The magic check is what turns that into a clear message instead of a
    // decoder error about an unreadable buffer.
    const io = fakeIO();
    const { clip, log } = makeSync({ io });
    const bogus = Buffer.from("this is definitely not a PNG").toString("base64");
    assert.strictEqual(clip.onMessage({ t: "cb", kind: "image", format: "png", data: bogus }), true);
    assert.strictEqual(io.state.imageWrites.length, 0);
    assert.ok(log.warns().some((w) => /PNG/.test(w.text)), "the warning should name the problem");
  });

  await check("a truncated PNG is refused", () => {
    const io = fakeIO();
    const { clip } = makeSync({ io });
    const truncated = PNG_1PX.subarray(0, 6).toString("base64");
    clip.onMessage({ t: "cb", kind: "image", format: "png", data: truncated });
    assert.strictEqual(io.state.imageWrites.length, 0);
  });

  await check("an incoming image over the cap is refused", () => {
    const io = fakeIO();
    const { clip, log } = makeSync({ io, maxImageBytes: 16 });
    clip.onMessage({ t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64") });
    assert.strictEqual(io.state.imageWrites.length, 0);
    assert.ok(log.warns().some((w) => /过大/.test(w.text)));
  });

  await check("empty or malformed payloads are ignored without throwing", () => {
    const io = fakeIO();
    const { clip } = makeSync({ io });
    for (const m of [
      { t: "cb", kind: "image", format: "png" },
      { t: "cb", kind: "image", format: "png", data: "" },
      { t: "cb", kind: "image", format: "png", data: 12345 },
      { t: "cb", kind: "image", format: "png", data: "!!!!" },
    ]) {
      assert.strictEqual(clip.onMessage(m), true);
    }
    assert.strictEqual(io.state.imageWrites.length, 0);
  });

  await check("a backend that cannot write images is handled, not crashed into", () => {
    const log = makeLog();
    const clip = createClipboardSync({
      io: { read: () => "", write: () => {}, readImage: () => null }, // read-only
      images: true,
      send: () => {},
      log,
      intervalMs: 1_000_000,
    });
    clip.start();
    assert.strictEqual(
      clip.onMessage({ t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64") }),
      true
    );
    assert.ok(log.warns().some((w) => /不支持写入图片/.test(w.text)));
    clip.stop();
  });

  await check("a clipboard kind we do not know is consumed, not handed to the injector", () => {
    const io = fakeIO();
    const { clip } = makeSync({ io });
    assert.strictEqual(clip.onMessage({ t: "cb", kind: "files", data: "x" }), true);
  });

  await check("isPng and sha256 behave", () => {
    assert.strictEqual(isPng(PNG_1PX), true);
    assert.strictEqual(isPng(Buffer.from("nope")), false);
    assert.strictEqual(isPng(null), false);
    assert.strictEqual(sha256(Buffer.from("a")), sha256(Buffer.from("a")));
    assert.notStrictEqual(sha256(Buffer.from("a")), sha256(Buffer.from("b")));
  });

  await check("the default image cap is the documented 8 MB", () => {
    assert.strictEqual(DEFAULT_MAX_IMAGE_BYTES, 8_000_000);
  });

  // -------------------------------------------------------------------------
  console.log("\n-- the capability handshake (over a real socket) --");

  await check("normalizeCaps keeps only strings", () => {
    assert.deepStrictEqual(normalizeCaps(["img", 1, null, "x"]), ["img", "x"]);
    assert.deepStrictEqual(normalizeCaps(undefined), []);
    assert.deepStrictEqual(normalizeCaps("img"), []);
  });

  // One real server + one real client on an ephemeral port. The handshake is
  // the thing under test, so mocking the transport would test nothing.
  async function pair() {
    const log = makeLog();
    const received = [];
    const seen = { peerCaps: null, clientCaps: null };
    const srv = startServer(
      { port: 0, password: "pw", log, onError: () => {} },
      {
        onPeer(send, peer) {
          seen.peerCaps = peer.caps;
          send({ t: "cb", kind: "image", format: "png", data: PNG_1PX.toString("base64"), w: 1, h: 1 });
          send({ t: "cb", text: "hello-from-server" });
        },
        onClose() {},
      }
    );
    await once(srv.server, "listening");
    const port = srv.server.address().port;

    const conn = connectClient(
      { host: "127.0.0.1", port, password: "pw", log },
      {
        onConnected(send, info) {
          seen.clientCaps = info.caps;
          send({ t: "cb", text: "hello-from-client" });
        },
        onMessage: (m) => received.push(m),
        onClose() {},
      }
    );
    // Wait for the handshake to complete on both sides.
    for (let i = 0; i < 200 && (seen.peerCaps === null || seen.clientCaps === null); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; i < 200 && received.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { srv, conn, seen, received, port, log };
  }

  await checkAsync("both ends advertise `img` and `jpg`, and each learns the other's caps", async () => {
    const { srv, conn, seen } = await pair();
    try {
      assert.ok(CAPS.includes("img"), "images are advertised");
      assert.ok(CAPS.includes("jpg"), "the JPEG fallback is advertised separately from images");
      assert.deepStrictEqual(seen.peerCaps, ["img", "jpg"], "the server should see the client's caps");
      assert.deepStrictEqual(seen.clientCaps, ["img", "jpg"], "the client should see the server's caps");
    } finally {
      conn.close();
      srv.close();
    }
  });

  await checkAsync("a large base64 image survives the real socket and the line reader", async () => {
    const { srv, conn, received } = await pair();
    try {
      const image = received.find((m) => m.kind === "image");
      assert.ok(image, "the image message should have arrived");
      assert.deepStrictEqual(Buffer.from(image.data, "base64"), PNG_1PX, "bytes must be intact");
      assert.ok(received.some((m) => m.text === "hello-from-server"), "text still flows");
    } finally {
      conn.close();
      srv.close();
    }
  });

  await checkAsync("a client that omits `caps` is treated as text-only, not rejected", async () => {
    // This is the compatibility guarantee: an older build sends the old hello.
    // It must authenticate normally and simply never receive images.
    const log = makeLog();
    const seen = { caps: "unset" };
    const srv = startServer(
      { port: 0, password: "pw", log, onError: () => {} },
      {
        onPeer(send, peer) {
          seen.caps = peer.caps;
        },
        onClose() {},
      }
    );
    await once(srv.server, "listening");
    const port = srv.server.address().port;

    const sock = net.connect({ host: "127.0.0.1", port });
    await once(sock, "connect");
    // The pre-images handshake, verbatim.
    sock.write(
      JSON.stringify({ t: "hello", pwd: require("../src/protocol").hashPwd("pw") }) + "\n"
    );
    let reply = "";
    sock.on("data", (c) => (reply += c.toString("utf8")));
    for (let i = 0; i < 200 && !reply.includes("\n"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    try {
      assert.ok(reply.includes('"t":"ok"'), `the old client must be accepted, got: ${reply}`);
      assert.deepStrictEqual(seen.caps, [], "no caps means no capabilities");
    } finally {
      sock.destroy();
      srv.close();
    }
  });

  await checkAsync("the line-length guard is far above any payload we would send", async () => {
    // The guard exists so a peer that never sends a newline cannot grow the
    // buffer without bound. It must not fire on our own legitimate traffic: a
    // base64 8 MB PNG is ~10.7 MB.
    assert.ok(MAX_LINE_BYTES > (DEFAULT_MAX_IMAGE_BYTES * 4) / 3 + 1024);
  });

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length) {
    console.log(`CLIPBOARD-UNITS FAIL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  console.log(`CLIPBOARD-UNITS PASS: ${passed}/${passed} checks passed`);
  process.exit(0);
})();

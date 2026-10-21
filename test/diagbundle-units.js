"use strict";
// ---------------------------------------------------------------------------
// Unit tests for the one-click diagnostic bundle.
//
// Why this file exists
// --------------------
// "The mouse doesn't move" spans two machines and the evidence is scattered
// across the config, the log ring buffer and three separate self-test reports.
// The bundle is meant to be *sent to somebody else*, which makes two things
// load-bearing that are easy to get wrong and impossible to notice by eye:
//
//   * **the password must not be in it.** A bundle is an attachment. If
//     `peer.password` leaks, the redaction is worse than useless -- it looks
//     safe. The test scans every byte of every entry, so a leak anywhere (a
//     log line, the manifest, the README) fails.
//   * **the archive must be readable by other people's tools.** The ZIP writer
//     is hand-rolled (the project ships prebuilt binaries, so no new
//     dependencies), and a subtly malformed ZIP still opens fine in *some*
//     extractors. So the test parses the archive back with a reader written
//     from the spec -- EOCD -> central directory -> local header -> inflate --
//     and checks the CRCs and sizes itself.
//
// It also pins the failure policy: a sub-step that throws must become a file
// inside the archive, never an aborted bundle. Half a bundle is worth far more
// than an error dialog when the other machine is not reachable.
// ---------------------------------------------------------------------------
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

// Stub the four collectors BEFORE diagbundle requires them, so this file needs
// no display, no hook, no native modules and no real self-tests. diagbundle
// requires them lazily inside the function, so mutating these objects between
// cases is enough to drive each branch.
const stubs = {
  platform: {
    platformInfo: () => ({ platform: process.platform, warnings: [] }),
    diagSnapshot: () => ({ monitors: [{ width: 1920, height: 1080 }], signature: "1920x1080+0+0" }),
  },
  logger: {
    getHistory: () => [
      { time: 1700000000000, level: "info", message: "peer connected" },
      { time: 1700000001000, level: "warn", message: "uinput 注入失败：exit 2" },
    ],
  },
  doctor: {
    runDoctorText: async () => ({ code: 0, text: "DOCTOR PASS — 7 ok, 0 warn, 0 fail\n" }),
  },
  injecttest: {
    runInjectTest: async ({ outPath }) => {
      fs.writeFileSync(outPath, "INJECTTEST PASS\n", "utf8");
    },
  },
  hwtest: {
    runTest: async ({ outPath }) => {
      fs.writeFileSync(outPath, "HWTEST PASS\n", "utf8");
    },
  },
};

function stub(name, exports) {
  const id = path.resolve(__dirname, "..", "src", `${name}.js`);
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
}
for (const [name, exports] of Object.entries(stubs)) stub(name, exports);

const {
  createZip,
  crc32,
  redactConfig,
  tidyPath,
  collectDiagBundle,
  writeDiagBundle,
} = require("../src/diagbundle");

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

// ---------------------------------------------------------------------------
// A ZIP reader written from the spec. Deliberately independent of the writer:
// sharing code would let a symmetric bug pass.
// ---------------------------------------------------------------------------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "no end-of-central-directory record found");
  assert.strictEqual(buf.readUInt16LE(eocd + 4), 0, "multi-disk archives are not expected");
  assert.strictEqual(buf.readUInt16LE(eocd + 8), buf.readUInt16LE(eocd + 10), "entry count mismatch");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    assert.strictEqual(buf.readUInt32LE(off), 0x02014b50, `entry ${n}: bad central directory header`);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString("utf8");

    assert.strictEqual(buf.readUInt32LE(lho), 0x04034b50, `entry ${n}: bad local file header`);
    const lname = buf.slice(lho + 30, lho + 30 + buf.readUInt16LE(lho + 26)).toString("utf8");
    assert.strictEqual(lname, name, `entry ${n}: local and central names disagree`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.slice(start, start + csize);
    const data = method === 0 ? body : zlib.inflateRawSync(body);
    entries.push({ name, method, flags, crc, csize, usize, data });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

const fakeCfg = () => ({
  role: "client",
  peer: { host: "192.0.2.10", port: 7766, password: "hunter2-is-my-secret" },
  input: { backend: "ydotool", manageYdotoold: true },
});

(async () => {
  // -------------------------------------------------------------------------
  console.log("\n-- ZIP writer --");

  await check("crc32 matches the standard test vector", () => {
    // The canonical CRC-32 check value: crc32("123456789") === 0xCBF43926.
    assert.strictEqual(crc32(Buffer.from("123456789")).toString(16), "cbf43926");
    assert.strictEqual(crc32(Buffer.alloc(0)), 0);
  });

  await check("the archive parses back: EOCD, central directory, local headers, CRCs", () => {
    const zip = createZip([
      { name: "README.txt", data: "说明 hello\n".repeat(40) },
      { name: "sub/nested.json", data: JSON.stringify({ a: 1, b: "中文" }) },
      { name: "tiny.txt", data: "x" },
    ]);
    const entries = readZip(zip);
    assert.deepStrictEqual(
      entries.map((e) => e.name),
      ["README.txt", "sub/nested.json", "tiny.txt"]
    );
    for (const e of entries) {
      assert.strictEqual(e.usize, e.data.length, `${e.name}: uncompressed size is wrong`);
      assert.strictEqual(e.crc, crc32(e.data), `${e.name}: CRC in the header is wrong`);
    }
    assert.strictEqual(entries[1].data.toString("utf8"), '{"a":1,"b":"中文"}');
  });

  await check("UTF-8 names are flagged, so Windows does not render them as mojibake", () => {
    const zip = createZip([{ name: "报告-自检.txt", data: "ok" }]);
    const [e] = readZip(zip);
    assert.strictEqual(e.name, "报告-自检.txt");
    assert.ok(e.flags & 0x0800, "the UTF-8 (EFS) flag must be set on the entry");
  });

  await check("compressible data is deflated, incompressible data is stored", () => {
    // Storing already-compressed data (a PNG screenshot) must not pay CPU to
    // make the file bigger; deflating repetitive text must shrink it.
    const noise = require("crypto").randomBytes(4096);
    const entries = readZip(
      createZip([
        { name: "text.txt", data: "abc".repeat(2000) },
        { name: "noise.bin", data: noise },
      ])
    );
    assert.strictEqual(entries[0].method, 8, "repetitive text should be deflated");
    assert.ok(entries[0].csize < entries[0].usize, "deflate should actually shrink it");
    assert.strictEqual(entries[1].method, 0, "random bytes should be stored, not deflated");
    assert.deepStrictEqual(entries[1].data, noise, "stored data must survive byte-for-byte");
  });

  // -------------------------------------------------------------------------
  console.log("\n-- redaction --");

  await check("the password is replaced by a length marker", () => {
    const cfg = fakeCfg();
    const out = redactConfig(cfg);
    assert.ok(!String(out.peer.password).includes("hunter2"), "the value must be gone");
    // The LENGTH is kept on purpose: "both ends typed a different password" is
    // a common refused handshake, and a length mismatch proves it safely.
    // Derived from the fixture rather than hardcoded, so editing the fixture
    // cannot silently make this assertion vacuous.
    assert.ok(
      out.peer.password.includes(String(cfg.peer.password.length)),
      `length should be preserved, got ${out.peer.password}`
    );
  });

  await check("redaction does not mutate the caller's config", () => {
    const cfg = fakeCfg();
    redactConfig(cfg);
    assert.strictEqual(cfg.peer.password, "hunter2-is-my-secret");
  });

  await check("tidyPath collapses the home directory but keeps the rest", () => {
    const home = process.platform === "win32" ? "C:\\Users\\someone" : "/home/someone";
    assert.strictEqual(
      tidyPath(`${home}${path.sep}AppData${path.sep}netmouse`, home),
      `~${path.sep}AppData${path.sep}netmouse`
    );
    assert.strictEqual(tidyPath("/etc/passwd", home), "/etc/passwd", "unrelated paths are untouched");
    assert.strictEqual(tidyPath(null, home), null);
  });

  await check("a config that cannot be serialized degrades to an error entry", () => {
    const cyc = { role: "client" };
    cyc.self = cyc;
    const out = redactConfig(cyc);
    assert.ok(out.error, "should report rather than throw");
  });

  // -------------------------------------------------------------------------
  console.log("\n-- bundle contents --");

  await checkAsync("the README is first, and the manifest lists exactly the files shipped", async () => {
    const { files, manifest } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: false });
    assert.strictEqual(files[0].name, "README.txt", "the README must be the first entry");
    assert.deepStrictEqual(
      manifest.files.map((f) => f.name),
      files.map((f) => f.name),
      "the manifest must describe the archive it is inside"
    );
    assert.strictEqual(manifest.role, "client");
    assert.strictEqual(manifest.includesLiveTests, false);
    assert.ok(manifest.app.version, "the app version must be recorded");
  });

  await checkAsync("the manifest lists ITSELF, and its sizes match the real bytes", async () => {
    // Regression: the entry list used to be computed before the README was
    // prepended, so the manifest was always one short. Only comparing it
    // against the archive actually written catches that.
    const { files, manifest } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: true });
    const names = manifest.files.map((f) => f.name);
    assert.ok(names.includes("manifest.json"), "the manifest must list itself");
    assert.strictEqual(names.length, files.length, "no entry may be missing");
    const zip = createZip(files);
    assert.deepStrictEqual(
      names,
      readZip(zip).map((e) => e.name),
      "the manifest must match the archive's real central directory, in order"
    );
    for (const f of manifest.files) {
      const real = files.find((x) => x.name === f.name);
      assert.ok(real, `${f.name} is in the manifest but not in the archive`);
      assert.strictEqual(
        f.bytes,
        Buffer.byteLength(String(real.data)),
        `${f.name}: the recorded size is wrong`
      );
    }
    // And the manifest's own recorded size must be the size it actually is.
    const self = manifest.files.find((f) => f.name === "manifest.json");
    const onDisk = files.find((f) => f.name === "manifest.json");
    assert.strictEqual(self.bytes, Buffer.byteLength(String(onDisk.data)));
  });

  await checkAsync("with includeLive:false the self-tests are marked 'not run', not omitted", async () => {
    // Omitting them would leave the reader wondering whether they failed; a
    // placeholder says "you asked for the fast path", which is a different fact.
    const { files } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: false });
    const names = files.map((f) => f.name);
    assert.ok(names.includes("injecttest.txt"), "injecttest.txt should still be present");
    assert.ok(names.includes("hwtest.txt"), "hwtest.txt should still be present");
    const inj = files.find((f) => f.name === "injecttest.txt");
    assert.ok(String(inj.data).includes("未运行"), "it should say it was not run");
  });

  await checkAsync("with includeLive:true the real self-test reports are collected", async () => {
    const { files } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: true });
    const inj = files.find((f) => f.name === "injecttest.txt");
    const hw = files.find((f) => f.name === "hwtest.txt");
    assert.ok(String(inj.data).includes("INJECTTEST PASS"), "should read the report the test wrote");
    assert.ok(String(hw.data).includes("HWTEST PASS"), "should read the report the test wrote");
    assert.ok(files.some((f) => f.name === "doctor.txt"), "the doctor output should be included");
    assert.ok(files.some((f) => f.name === "platform.json"), "the geometry snapshot should be included");
    assert.ok(files.some((f) => f.name === "logs.txt"), "the log ring buffer should be included");
  });

  await checkAsync("a collector that throws becomes a file, it does NOT abort the bundle", async () => {
    const original = stubs.injecttest.runInjectTest;
    stubs.injecttest.runInjectTest = async () => {
      throw new Error("模拟：自检进程起不来");
    };
    try {
      const { files, manifest } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: true });
      const inj = files.find((f) => f.name === "injecttest.txt");
      assert.ok(inj, "the bundle must still contain the entry");
      assert.ok(String(inj.data).includes("模拟：自检进程起不来"), "and must record why");
      // The rest of the bundle must be unaffected.
      assert.ok(files.some((f) => f.name === "config.json"));
      assert.ok(files.some((f) => f.name === "hwtest.txt"));
      assert.strictEqual(manifest.files.length, files.length);
    } finally {
      stubs.injecttest.runInjectTest = original;
    }
  });

  await checkAsync("a broken logger does not lose the rest of the bundle", async () => {
    const original = stubs.logger.getHistory;
    stubs.logger.getHistory = () => {
      throw new Error("ring buffer unavailable");
    };
    try {
      const { files } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: false });
      const logs = files.find((f) => f.name === "logs.txt");
      assert.ok(logs, "logs.txt must still exist");
      assert.ok(String(logs.data).includes("ring buffer unavailable"), "and must say what happened");
      assert.ok(files.some((f) => f.name === "config.json"), "the rest must survive");
    } finally {
      stubs.logger.getHistory = original;
    }
  });

  // -------------------------------------------------------------------------
  console.log("\n-- the password never leaves the machine --");

  await checkAsync("no entry contains the password, in any encoding", async () => {
    const cfg = fakeCfg();
    const secret = cfg.peer.password;
    const { files } = await collectDiagBundle({ cfg, includeLive: true });
    const zip = createZip(files);
    const haystacks = [
      ...files.map((f) => ({ name: f.name, text: String(f.data) })),
      { name: "<the zip bytes>", text: zip.toString("latin1") },
    ];
    for (const h of haystacks) {
      assert.ok(!h.text.includes(secret), `${h.name} leaked the password`);
      assert.ok(!h.text.includes("hunter2"), `${h.name} leaked part of the password`);
      // Deflate would hide a plaintext leak, so search the inflated entries too.
    }
    for (const e of readZip(zip)) {
      const text = e.data.toString("latin1");
      assert.ok(!text.includes(secret), `${e.name} leaked the password after inflate`);
    }
  });

  await checkAsync("the README states what was redacted and what was never collected", async () => {
    const { files } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: false });
    const readme = String(files[0].data);
    assert.ok(readme.includes("peer.password"), "should name the redacted field");
    assert.ok(/没有上传/.test(readme), "should state that nothing is uploaded");
    assert.ok(/剪贴板/.test(readme), "should state that clipboard contents are excluded");
  });

  await checkAsync("the README's own table lists every entry, itself included", async () => {
    const { files } = await collectDiagBundle({ cfg: fakeCfg(), includeLive: true });
    const readme = String(files[0].data);
    for (const f of files) {
      assert.ok(readme.includes(f.name), `the README should mention ${f.name}`);
    }
  });

  // -------------------------------------------------------------------------
  console.log("\n-- writing to disk --");

  await checkAsync("writeDiagBundle writes a readable archive and reports its path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-diagtest-"));
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    try {
      const res = await writeDiagBundle({ cfg: fakeCfg(), log, dir, includeLive: false });
      assert.strictEqual(res.ok, true);
      assert.ok(res.path.startsWith(dir), "the bundle lands in the requested directory");
      assert.ok(/netmouse-diag-\d{8}-\d{6}\.zip$/.test(res.path), `unexpected name: ${res.path}`);
      const onDisk = fs.readFileSync(res.path);
      assert.strictEqual(onDisk.length, res.bytes, "the reported size must match the file");
      const entries = readZip(onDisk);
      assert.deepStrictEqual(
        entries.map((e) => e.name),
        res.files,
        "the reported file list must match the archive"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  console.log("");
  if (failures.length) {
    console.log(`DIAGBUNDLE-UNITS FAIL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
  console.log(`DIAGBUNDLE-UNITS PASS: ${passed}/${passed} checks passed`);
  process.exit(0);
})();

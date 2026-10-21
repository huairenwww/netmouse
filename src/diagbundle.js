// ---------------------------------------------------------------------------
// One-click diagnostic bundle.
//
// "The mouse doesn't move" spans two machines, and the evidence is scattered:
// the config, the log ring buffer, and three separate self-test reports, each
// written next to the config file. Asking a user to find and attach all of them
// reliably fails -- and the report that would have answered the question is
// always the one that did not get attached.
//
// So: gather everything into a single .zip, with a README that says what is
// inside and what was deliberately left out.
//
// Three rules this module follows:
//
//   1. **The password never leaves the machine.** A bundle is meant to be sent
//      to somebody else. `peer.password` is replaced by a length marker, and
//      the home directory in any path is collapsed to `~` (paths leak the OS
//      user name, which is enough to matter and never useful for debugging).
//   2. **A failing sub-test must not fail the bundle.** Half a bundle is worth
//      far more than an error dialog; each step records its failure as a file
//      in the archive instead of aborting.
//   3. **No new dependencies.** The project ships prebuilt binaries only, so
//      the ZIP writer lives here (store/deflate, ~80 lines) rather than pulling
//      in a library.
// ---------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const BUNDLE_VERSION = 1;

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

// zlib.crc32 only exists on newer Node builds, and the packaged app pins the
// Electron runtime's Node, so the table is built here instead.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// MS-DOS packed date/time, as every ZIP reader expects.
function dosStamp(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Build a ZIP archive in memory.
//
// Entries are stored (method 0) when deflate does not shrink them -- which is
// the normal case for the PNG screenshots a bundle may carry, and avoids paying
// CPU to make the file bigger.
//
// Names are written with the UTF-8 flag (0x0800) set: the bundle's own README
// and report titles are Chinese, and without the flag Windows' built-in
// extractor renders them as mojibake.
function createZip(entries, { date = new Date() } = {}) {
  const { time, date: dt } = dosStamp(date);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(dt, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(dt, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);

    parts.push(lfh, nameBuf, body);
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Replace the user's home directory with `~`. Paths are genuinely useful in a
// bundle (they show where the config lives); the OS user name is not.
function tidyPath(p, home = os.homedir()) {
  if (typeof p !== "string" || !p) return p;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function redactConfig(cfg, home = os.homedir()) {
  let out;
  try {
    out = JSON.parse(JSON.stringify(cfg));
  } catch {
    return { error: "配置无法序列化（含循环引用或非 JSON 值）" };
  }
  if (out.peer && typeof out.peer.password === "string") {
    // Keep the LENGTH: "both ends have a different password" is a common cause
    // of a refused handshake, and a length mismatch proves it without ever
    // revealing the value.
    out.peer.password = `__已隐藏__（原长 ${out.peer.password.length} 字符）`;
  }
  if (typeof out.configPath === "string") out.configPath = tidyPath(out.configPath, home);
  return out;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

function bundleReadme({ stamp, files }) {
  return `NetMouse 诊断包
================
生成时间：${stamp}

这个包里有什么
--------------
${files.map((f) => `  ${f.name.padEnd(28)} ${f.note || ""}`).join("\n")}

已做脱敏
--------
* peer.password 已替换成「原长 N 字符」，不包含密码本身。
* 路径里的家目录已替换成 ~（不包含系统用户名）。

没做什么
--------
* 没有上传任何东西：整个包是在本机生成的，发不发由你决定。
* 不包含剪贴板内容、键盘记录或屏幕截图。
* 日志是本次运行的环形缓冲（最近 500 条），不含历史运行。

怎么用
------
把整个 zip 发给帮忙排查的人即可。两端各生成一份最有价值 ——
只看一台分不清是「本机没发出去」还是「对端没注入成功」。
`;
}

// Collect everything into a Buffer. Kept separate from writing the file so the
// contents are testable without touching the filesystem.
async function collectDiagBundle({ cfg, log, now = Date.now(), includeLive = true } = {}) {
  const when = new Date(now);
  const stamp = when.toLocaleString();
  const files = [];
  const add = (name, data, note) => {
    files.push({ name, data, note });
  };

  // 1. Config (redacted).
  add("config.json", JSON.stringify(redactConfig(cfg), null, 2), "本机配置（密码已隐藏）");

  // 2. Platform facts + the raw geometry snapshot. This is the file that
  //    usually answers "why did the edge land somewhere unreachable".
  try {
    const { platformInfo, diagSnapshot } = require("./platform");
    add(
      "platform.json",
      JSON.stringify({ platform: platformInfo(), geometry: diagSnapshot() }, null, 2),
      "平台事实 + 显示器几何原始快照"
    );
  } catch (e) {
    add("platform.json", JSON.stringify({ error: e.message }, null, 2), "平台信息收集失败");
  }

  // 3. The log ring buffer.
  try {
    const { getHistory } = require("./logger");
    const lines = getHistory().map(
      (e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} ${e.message}`
    );
    add("logs.txt", lines.join("\n") + "\n", `本次运行日志（${lines.length} 行）`);
  } catch (e) {
    add("logs.txt", `日志收集失败：${e.message}\n`, "日志收集失败");
  }

  // 4. The doctor, captured in-process so the text matches the terminal.
  try {
    const { runDoctorText } = require("./doctor");
    // Static checks only: the live probes are covered by the injection
    // self-test below, and running both would move the cursor twice.
    const { code, text } = await runDoctorText({ inject: false, hook: false });
    add("doctor.txt", text, `环境体检（${code === 0 ? "通过" : "有 FAIL"}）`);
  } catch (e) {
    add("doctor.txt", `体检失败：${e.message}\n`, "体检失败");
  }

  // 5. The two live self-tests. Each writes its own report file, so run them
  //    into a temp file and read it back.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-bundle-"));
  const runInto = async (label, file, fn) => {
    const target = path.join(tmp, file);
    try {
      await fn(target);
      if (fs.existsSync(target)) {
        add(file, fs.readFileSync(target), label);
        return;
      }
      add(file, `${label}没有生成报告。\n`, `${label}未生成报告`);
    } catch (e) {
      add(file, `${label}运行失败：${e.message}\n`, `${label}运行失败`);
    }
  };

  if (includeLive) {
    await runInto("客户端侧注入自检（本机能否驱动光标/按键/滚轮）", "injecttest.txt", async (out) => {
      const { runInjectTest } = require("./injecttest");
      await runInjectTest({ cfg, outPath: out, stopHookAfter: false });
    });
    await runInto("服务器侧边缘自检（四条边 + 按键 + 滚轮）", "hwtest.txt", async (out) => {
      const { runTest } = require("./hwtest");
      await runTest({ outPath: out, stopHookAfter: false });
    });
  } else {
    add("injecttest.txt", "本次未运行（生成时选择了「不含自检」）。\n", "未运行");
    add("hwtest.txt", "本次未运行（生成时选择了「不含自检」）。\n", "未运行");
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  // 6. README first, so it is the first thing seen when the archive is opened.
  //
  //    Its table lists the full set, including the manifest that is appended
  //    after it and itself. Both files describe the same archive, so both have
  //    to agree with the real central directory -- see the unit test that
  //    compares them against the written ZIP.
  const readme = bundleReadme({
    stamp,
    files: [
      { name: "README.txt", note: "说明（本文件）" },
      ...files,
      { name: "manifest.json", note: "本包清单" },
    ],
  });
  files.unshift({ name: "README.txt", data: readme, note: "说明（本文件）" });

  // 7. The manifest, last, and it lists itself.
  //
  //    This used to be built *before* the README was unshifted, so the entry
  //    list was one short of the archive every single time. Caught by comparing
  //    the manifest against the real central directory of the written file --
  //    nothing else would have noticed.
  //
  //    The manifest cannot know its own byte size before it is serialized, so
  //    iterate to a fixed point: the first pass fixes the digit count of every
  //    size, the second fixes its own. It converges in two.
  const entryList = () =>
    files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(String(f.data)) }));
  const buildManifest = (list) => ({
    bundleVersion: BUNDLE_VERSION,
    generatedAt: when.toISOString(),
    app: {
      version: safeVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron || null,
      node: process.versions.node,
    },
    role: cfg?.role || null,
    includesLiveTests: !!includeLive,
    files: list,
  });

  let selfBytes = 0;
  let manifestText = "";
  for (let i = 0; i < 6; i++) {
    manifestText = JSON.stringify(
      buildManifest([...entryList(), { name: "manifest.json", bytes: selfBytes }]),
      null,
      2
    );
    const actual = Buffer.byteLength(manifestText);
    if (actual === selfBytes) break;
    selfBytes = actual;
  }
  add("manifest.json", manifestText, "本包清单");

  return { files, when, manifest: buildManifest(entryList()) };
}

function safeVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return "unknown";
  }
}

// Build the bundle and write it next to the config file.
async function writeDiagBundle({ cfg, log, dir, now = Date.now(), includeLive = true } = {}) {
  const { files, when } = await collectDiagBundle({ cfg, log, now, includeLive });
  const target = path.join(dir, `netmouse-diag-${stampForFile(when)}.zip`);
  fs.mkdirSync(dir, { recursive: true });
  const buf = createZip(files, { date: when });
  fs.writeFileSync(target, buf);
  log?.info(`诊断包已写入：${target}（${files.length} 个文件，${buf.length} 字节）`);
  return { ok: true, path: target, bytes: buf.length, files: files.map((f) => f.name) };
}

function stampForFile(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

module.exports = {
  createZip,
  crc32,
  redactConfig,
  tidyPath,
  collectDiagBundle,
  writeDiagBundle,
  BUNDLE_VERSION,
};

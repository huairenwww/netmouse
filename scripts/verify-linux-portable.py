#!/usr/bin/env python3
"""Static verification of the Linux portable artifacts.

The artifact names embed the package version, so we read it from package.json
(or take it as the first CLI argument) instead of hardcoding it.  The same
script also verifies the source archive when one is present.
"""
import glob
import gzip
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")


def resolve_version():
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip().lstrip("v")
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as fh:
        return json.load(fh)["version"]


VERSION = resolve_version()
TAR = os.path.join(DIST, f"NetMouse-{VERSION}-linux-x64.tar.gz")
RUN = os.path.join(DIST, f"NetMouse-{VERSION}-linux-x64.run")

fails = []


def fail_fast_missing(path, hint):
    if not os.path.exists(path):
        print(f"FAIL  missing artifact: {path}")
        print(f"      {hint}")
        sys.exit(1)


def check(name, cond, extra=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  -> {extra}" if extra else ""))
    if not cond:
        fails.append(name)


print(f"verifying Linux portable artifacts for version {VERSION}")
print(f"  tarball: {os.path.basename(TAR)}")
print(f"  launcher: {os.path.basename(RUN)}")
print()
fail_fast_missing(TAR, "run `npm run build:linux:portable` first")
fail_fast_missing(RUN, "run `npm run build:linux:portable` first")

# ---------------------------------------------------------------- tar layout
tar = tarfile.open(TAR)
names = tar.getnames()
roots = sorted({n.split("/")[0] for n in names})
check("single top-level directory", len(roots) == 1, roots[0])

want = {
    "netmouse": 0o755,
    "chrome-sandbox": 0o4755,
    "chrome_crashpad_handler": 0o755,
    "netmouse.sh": 0o755,
    "install-linux.sh": 0o755,
    "netmouse.png": 0o644,
    "README-linux.txt": 0o644,
    "config.json": 0o644,
    "resources/app.asar": 0o644,
    "resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/linux-x64/uiohook-napi.node": 0o644,
    "resources/app.asar.unpacked/node_modules/@nut-tree-fork/libnut-linux/build/Release/libnut.node": 0o644,
}
print()
for rel, mode in want.items():
    full = f"{roots[0]}/{rel}"
    try:
        m = tar.getmember(full)
    except KeyError:
        check(f"mode {rel}", False, "MISSING")
        continue
    check(f"mode {rel} = {oct(mode)}", m.mode == mode, oct(m.mode))

# No file should have lost its executable bit among the ones that need it.
dirs = [m for m in tar.getmembers() if m.isdir()]
check("all dirs are 0755", all(m.mode == 0o755 for m in dirs), f"{len(dirs)} dirs")

# ------------------------------------------------------------- ELF sanity
print()
for rel in ("netmouse", "chrome-sandbox", "chrome_crashpad_handler"):
    with tar.extractfile(f"{roots[0]}/{rel}") as fh:
        magic = fh.read(4)
    check(f"{rel} is an ELF binary", magic == b"\x7fELF", repr(magic))

with tar.extractfile(f"{roots[0]}/resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/linux-x64/uiohook-napi.node") as fh:
    check("uiohook linux-x64 is ELF", fh.read(4) == b"\x7fELF")

# ---------------------------------------------------- bundled uinput tools
# 0.2.11 ships ydotool/ydotoold next to the app so a machine with nothing
# installed still works. Two things can silently go wrong here and both look
# like "the cursor does not move": the execute bit (EACCES on spawn) and the
# wrong architecture (ENOEXEC). Neither shows up in a file listing.
print()
BIN_DIR = "resources/bin"
for rel, mode in {
    f"{BIN_DIR}/ydotool": 0o755,
    f"{BIN_DIR}/ydotoold": 0o755,
    f"{BIN_DIR}/wheel.py": 0o755,
}.items():
    full = f"{roots[0]}/{rel}"
    try:
        m = tar.getmember(full)
    except KeyError:
        check(f"bundled {rel}", False, "MISSING")
        continue
    check(f"bundled {rel} present", True, f"{m.size} B")
    check(f"mode {rel} = {oct(mode)}", m.mode == mode, oct(m.mode))

for rel in ("ydotool", "ydotoold"):
    with tar.extractfile(f"{roots[0]}/{BIN_DIR}/{rel}") as fh:
        head = fh.read(20)
    is_elf = head[:4] == b"\x7fELF"
    is_x64 = head[4] == 2 and head[18:20] == b"\x3e\x00"
    check(f"{rel} is an x86-64 ELF", is_elf and is_x64, head[:4].hex())

with tar.extractfile(f"{roots[0]}/{BIN_DIR}/wheel.py") as fh:
    wheel_src = fh.read().decode("utf-8")
try:
    compile(wheel_src, "wheel.py", "exec")
    wheel_ok = True
except SyntaxError:
    wheel_ok = False
check("wheel.py compiles", wheel_ok)
check("wheel.py writes REL_WHEEL to /dev/uinput",
      "REL_WHEEL" in wheel_src and "/dev/uinput" in wheel_src)

# The app must not have dragged the Windows/Darwin Electron binary along.
check("no win32 electron dlls", not any(n.endswith(".dll") for n in names))
check("app.asar present", f"{roots[0]}/resources/app.asar" in names)

# ---------------------------------------------------------------- .run stub
print()
raw = open(RUN, "rb").read()
m = re.search(rb"tail -c \+(\d+)", raw)
check("stub contains a tail offset", m is not None)
offset = int(m.group(1))
check("offset points at the gzip payload", raw[offset - 1:offset + 1] == b"\x1f\x8b", repr(raw[offset - 1:offset + 1]))
check("offset == stub length + 1", raw[:offset - 1].endswith(b"exec \"$APPDIR/netmouse.sh\" \"$@\"\n"))

stub_text = raw[:offset - 1].decode("utf-8")
check("stub starts with a shebang", stub_text.startswith("#!/bin/sh\n"))

with gzip.GzipFile(fileobj=io.BytesIO(raw[offset - 1:])) as gz:
    payload = gz.read()
check("payload decompresses", len(payload) > 0, f"{len(payload)/1e6:.1f} MB")
# The embedded gzip stream must be byte-identical to the standalone tarball.
check("embedded stream == standalone tarball", raw[offset - 1:] == open(TAR, "rb").read())

with tarfile.open(fileobj=io.BytesIO(payload)) as inner:
    inner_names = inner.getnames()
check("payload is a valid tar with the same root", sorted({n.split('/')[0] for n in inner_names}) == roots)

# ------------------------------------------------------------ shell syntax
print()
with tempfile.TemporaryDirectory() as td:
    for label, text in (("stub", stub_text),):
        p = os.path.join(td, f"{label}.sh")
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        r = subprocess.run(["sh", "-n", p], capture_output=True)
        check(f"{label} passes `sh -n`", r.returncode == 0, r.stderr.decode().strip())

    with tar.extractfile(f"{roots[0]}/netmouse.sh") as fh:
        launcher = fh.read().decode("utf-8")
    p = os.path.join(td, "netmouse.sh")
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(launcher)
    r = subprocess.run(["sh", "-n", p], capture_output=True)
    check("netmouse.sh passes `sh -n`", r.returncode == 0, r.stderr.decode().strip())

    # The launcher installer is the thing the user runs to get a double-clickable
    # icon, so a syntax error in it is a broken first-run experience.
    with tar.extractfile(f"{roots[0]}/install-linux.sh") as fh:
        installer = fh.read().decode("utf-8")
    p = os.path.join(td, "install-linux.sh")
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(installer)
    r = subprocess.run(["sh", "-n", p], capture_output=True)
    check("install-linux.sh passes `sh -n`", r.returncode == 0, r.stderr.decode().strip())
    # It must reference the .desktop it writes and the udev rule it can install;
    # both are load-bearing for the Wayland path.
    check("installer writes a .desktop launcher", "Desktop Entry" in installer)
    # Two rules, two different jobs: /dev/uinput is what makes INJECTION work
    # under Wayland, /dev/input/event* is what makes CAPTURE work there.
    check("installer can install the uinput rule", "KERNEL==\"uinput\"" in installer)
    check("installer can install the input-device rule", "KERNEL==\"event*\"" in installer)
    check(
        "installer reports whether capture will work",
        "/dev/input/event*" in installer,
    )

# ------------------------------------------------------------ source archive
print()
src_candidates = [
    os.path.join(os.path.dirname(ROOT), f"netmouse-src-{VERSION}.zip"),
    os.path.join(DIST, f"netmouse-src-{VERSION}.zip"),
]
src = next((p for p in src_candidates if os.path.exists(p)), None)
if src is None:
    print(f"SKIP  source archive netmouse-src-{VERSION}.zip not found")
    print(f"      looked in: {', '.join(src_candidates)}")
else:
    import zipfile

    with zipfile.ZipFile(src) as z:
        entries = z.namelist()
        roots_src = sorted({n.split("/")[0] for n in entries})
        check("src zip has a single top-level dir", len(roots_src) == 1, roots_src[0] if roots_src else "?")
        check("src zip root is `netmouse`", roots_src and roots_src[0] == "netmouse")
        base = roots_src[0] if roots_src else "netmouse"
        must = [
            f"{base}/package.json",
            f"{base}/src/main.js",
            f"{base}/src/platform.js",
            f"{base}/src/server-input.js",
            f"{base}/src/inject-uinput.js",
            f"{base}/src/ydotoold.js",
            f"{base}/src/capture.js",
            f"{base}/src/capture-evdev.js",
            f"{base}/src/clipboard.js",
            f"{base}/src/diagbundle.js",
            f"{base}/src/diag.js",
            f"{base}/src/injecttest.js",
            f"{base}/test/injecttest-units.js",
            f"{base}/test/uinput-units.js",
            f"{base}/test/ydotoold-units.js",
            f"{base}/test/clipboard-units.js",
            f"{base}/test/capture-units.js",
            f"{base}/test/diagbundle-units.js",
            f"{base}/bin/ydotool",
            f"{base}/bin/ydotoold",
            f"{base}/bin/wheel.py",
            f"{base}/scripts/install-linux.sh",
            f"{base}/docs/开发记录.md",
            # The docs cite these; the handover has to be self-contained.
            f"{base}/docs/Windows构建与联调.md",
            f"{base}/reports/README.md",
            f"{base}/reports/示例-本机注入自检.txt",
            f"{base}/reports/示例-本机边缘自检.txt",
            f"{base}/scripts/verify-linux-portable.py",
        ]
        for rel in must:
            check(f"src zip contains {rel[len(base) + 1:]}", rel in entries)
        bad = [n for n in entries
               if any(seg in ("node_modules", "dist", "__pycache__", ".workbuddy-ai")
                      for seg in n.split("/"))]
        check("src zip has no regenerable dirs", not bad, f"{len(bad)} offenders")
        # Launcher scripts must keep their executable bit: on Linux a .sh without
        # +x is a text file, and the whole point of install-linux.sh is to be run.
        for script in ("run-linux.sh", "scripts/install-linux.sh",
                       "bin/ydotool", "bin/ydotoold", "bin/wheel.py"):
            key = f"{base}/{script}"
            if key not in entries:
                print(f"SKIP  {script} not in source archive")
                continue
            info = z.getinfo(key)
            check(f"{script} keeps the executable bit",
                  bool((info.external_attr >> 16) & 0o111),
                  oct((info.external_attr >> 16) & 0o777))

print()
print("ALL CHECKS PASSED" if not fails else f"FAILURES: {', '.join(fails)}")
sys.exit(1 if fails else 0)

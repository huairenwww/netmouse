#!/usr/bin/env python3
"""Build the distributable source archive (netmouse-src-<version>.zip).

The source archive is what the project is handed over as: everything needed to
build it, and nothing that can be regenerated or is machine-specific.

Included : src/ test/ build/ bin/ docs/ scripts/ reports/, config.json, package.json,
           package-lock.json, README.md, .gitignore, run-linux.sh
Excluded : node_modules/ dist/ .workbuddy-ai/ .bak-*/ *.log tmp*/ __pycache__/

`reports/` holds the sample self-test reports and UI screenshot that
`docs/开发记录.md` cites as evidence; shipping them keeps the handover
self-contained.  Real diagnostic reports are written next to the config
file, not here.

Layout is a single top-level `netmouse/` directory, so unzipping never scatters
files into the current folder.

Shell scripts are recorded as 0755 even when the archive is built on Windows,
where the filesystem has no execute bit (see `mode_for`).

Usage:
    python3 scripts/make-src-zip.py [--out DIR] [--version X.Y.Z]
"""
import argparse
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

INCLUDE_DIRS = ["src", "test", "build", "bin", "docs", "scripts", "reports"]
INCLUDE_FILES = [
    ".gitignore",
    "config.json",
    "package.json",
    "package-lock.json",
    "README.md",
    "run-linux.sh",
]

# Regenerable, machine-specific, or just noise.
EXCLUDE_DIR_NAMES = {"node_modules", "dist", "__pycache__", ".workbuddy-ai"}
EXCLUDE_SUFFIXES = (".log", ".pyc", ".tmp")
EXCLUDE_PREFIXES = (".bak-", "tmp", ".")

# Files that must stay executable after unzipping on Linux.
# Windows has no execute bit: Python's os.stat() only sets S_IEXEC for
# extensions listed in PATHEXT, and `.sh` is not one of them, so a zip built
# on Windows would ship non-executable shell scripts.  Force the bit.
EXEC_SUFFIXES = (".sh",)

# The bundled uinput tools have no suffix, so the rule above cannot see them:
# ydotoold refuses to spawn (EACCES) and the client silently falls back to
# XTest -- which is exactly the "logs look fine, cursor never moves" failure.
EXEC_PATHS = {"bin/ydotool", "bin/ydotoold", "bin/wheel.py"}


def mode_for(rel_path: str, st) -> int:
    """Return the 0oXYZ mode to record for `rel_path` in the archive."""
    if os.name != "nt":
        real = st.st_mode & 0o777
        if real:
            return real
    if rel_path in EXEC_PATHS or os.path.basename(rel_path).endswith(EXEC_SUFFIXES):
        return 0o755
    return 0o644


def keep(rel_path: str) -> bool:
    parts = rel_path.split("/")
    if any(p in EXCLUDE_DIR_NAMES for p in parts):
        return False
    if any(p.startswith(EXCLUDE_PREFIXES) for p in parts if p != parts[-1]):
        return False
    base = parts[-1]
    if base.startswith(EXCLUDE_PREFIXES):
        return False
    return not base.endswith(EXCLUDE_SUFFIXES)


def collect(root: str):
    """Yield paths relative to `root`, sorted, filtered."""
    out = []
    for name in INCLUDE_FILES:
        p = os.path.join(root, name)
        if os.path.isfile(p):
            out.append(name)
        else:
            print(f"  ! missing, skipped: {name}", file=sys.stderr)
    for d in INCLUDE_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            print(f"  ! missing, skipped: {d}/", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(n for n in dirnames if n not in EXCLUDE_DIR_NAMES
                                 and not n.startswith(EXCLUDE_PREFIXES))
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                if keep(rel):
                    out.append(rel)
    return sorted(set(out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.dirname(ROOT),
                    help="directory to write the zip into (default: parent of the project)")
    ap.add_argument("--version", default=None, help="override the version in package.json")
    ap.add_argument("--name", default="netmouse", help="top-level folder name inside the zip")
    args = ap.parse_args()

    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as fh:
        version = args.version or json.load(fh)["version"]

    files = collect(ROOT)
    os.makedirs(args.out, exist_ok=True)
    target = os.path.join(args.out, f"netmouse-src-{version}.zip")

    # Fixed timestamp so two builds of identical sources produce identical bytes.
    fixed = (2026, 1, 1, 0, 0, 0)
    exec_count = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            full = os.path.join(ROOT, rel)
            info = zipfile.ZipInfo(f"{args.name}/{rel}", date_time=fixed)
            mode = mode_for(rel, os.stat(full))
            if mode & 0o111:
                exec_count += 1
            # Preserve the executable bit: the Linux launcher scripts need it.
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as fh:
                z.writestr(info, fh.read())

    size = os.path.getsize(target)
    print(f"built {target}  ({len(files)} files, {exec_count} executable, {size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

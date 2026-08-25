#!/usr/bin/env bash
#
# Adds settings that exist in .env.example but are missing from .env.
#
#   sudo ./scripts/sync-env.sh
#
# Existing values are never touched - only absent keys are appended, with the
# example's default and the comment block that explains it.
#
# This exists because .env is created once and then diverges. Every setting
# added later is invisible to an existing installation: the code defaults
# cover it, so nothing breaks, but a setting you are supposed to choose is
# not there to be found.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="${REPO_ROOT}/.env.example"
TARGET="${REPO_ROOT}/.env"

[[ -f "${EXAMPLE}" ]] || { echo "missing ${EXAMPLE}" >&2; exit 1; }
[[ -f "${TARGET}" ]] || { echo "missing ${TARGET} - run bootstrap-server.sh first" >&2; exit 1; }

python3 - "${EXAMPLE}" "${TARGET}" <<'PYEOF'
import re, sys, pathlib

example, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
existing = {
    m.group(1)
    for line in target.read_text().splitlines()
    if (m := re.match(r"^([A-Z0-9_]+)=", line))
}

# Carry each missing key across with the comment block above it, so the file
# stays as self-explanatory as the example it came from.
added, block, pending = [], [], []
for line in example.read_text().splitlines():
    match = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
    if match:
        key = match.group(1)
        if key not in existing:
            pending.extend(block)
            pending.append(line)
            added.append(key)
        block = []
    elif line.strip().startswith("#") or not line.strip():
        block.append(line)
    else:
        block = []

if not added:
    print("  .env is already complete")
    sys.exit(0)

with target.open("a") as fh:
    fh.write("\n")
    fh.write("\n".join(pending).rstrip() + "\n")

for key in added:
    print(f"  added {key}")
print(f"\n  {len(added)} setting(s) appended to {target}")
print("  values are the documented defaults - review them before restarting")
PYEOF

chown root:ivr "${TARGET}" 2>/dev/null || true
chmod 640 "${TARGET}"

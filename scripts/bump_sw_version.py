"""
Bump the CACHE_VERSION string in docs/sw.js to the current UTC timestamp.

Run this before every deploy so Chrome detects sw.js changed and installs
the new Service Worker. Without it, Chrome sees identical sw.js bytes and
keeps serving the old cache forever.

Usage:
    python scripts/bump_sw_version.py
"""
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SW_PATH = Path(__file__).resolve().parent.parent / "docs" / "sw.js"
PATTERN = re.compile(r'const\s+CACHE_VERSION\s*=\s*"([^"]+)"')


def main() -> int:
    if not SW_PATH.exists():
        print(f"sw.js not found: {SW_PATH}", file=sys.stderr)
        return 1

    src = SW_PATH.read_text(encoding="utf-8")
    m = PATTERN.search(src)
    if not m:
        print(
            'No CACHE_VERSION line found in sw.js. Expected: const CACHE_VERSION = "..."',
            file=sys.stderr,
        )
        return 1

    new_version = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    old_version = m.group(1)
    if new_version == old_version:
        print(f"CACHE_VERSION already {old_version}, nothing to do")
        return 0

    updated = PATTERN.sub(f'const CACHE_VERSION = "{new_version}"', src, count=1)
    SW_PATH.write_text(updated, encoding="utf-8")
    print(f"CACHE_VERSION: {old_version} -> {new_version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

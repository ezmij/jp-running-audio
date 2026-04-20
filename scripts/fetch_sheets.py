"""
Fetch vocabulary rows from 3 sheets and normalize to unified schema.

Outputs: data/<sheet_slug>/rows.json

Usage (from project root):
    python scripts/fetch_sheets.py
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SHEET_ID = "19hrdgkU2kcAtdPUOHhZXqna0c4dMnezpiKo-EbVSv-E"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"

# Output slug keeps filenames ASCII-safe
SHEETS = [
    {"title": "北海道BD農法", "slug": "bd-nouhou", "schema": "bd"},
    {"title": "北海道BD農法2", "slug": "bd-nouhou2", "schema": "bd"},
    {"title": "常用的100個對話", "slug": "daily-100", "schema": "mrjp"},
    {"title": "談故鄉", "slug": "kokyou", "schema": "mrjp"},
]

# MR JP vocab categories appear as sub-headers inside 一、單字表整理
MRJP_CATEGORIES = [
    "一類動詞", "二類動詞", "三類動詞",
    "名詞", "な形容詞", "い形容詞", "副詞",
]


def gws_read(sheet_id: str, a1_range: str) -> list[list[str]]:
    """Call `gws sheets +read` via shell (gws is a .cmd on Windows)."""
    # Escape single quotes inside range by doubling (none expected here) and
    # wrap the whole arg. On Windows git-bash, shell=True uses cmd.exe so
    # single quotes don't quote — use double quotes.
    cmd = (
        f'gws sheets +read --spreadsheet {sheet_id} '
        f'--range "{a1_range}" --format csv'
    )
    proc = subprocess.run(
        cmd, shell=True, capture_output=True, text=True, encoding="utf-8"
    )
    if proc.returncode != 0:
        raise RuntimeError(f"gws read failed: {proc.stderr}")
    data = json.loads(proc.stdout)
    return data.get("values", [])


def parse_bd(rows: list[list[str]]) -> list[dict]:
    """
    BD農法 schema:
      Col A # | B 分類 | C 日文詞彙 | D 假名 | E 中文意思
      F 情境 | G 日文例句 | H 語序中文直譯 | I 學習重點
    """
    out = []
    # First row is header
    for i, row in enumerate(rows[1:], start=2):
        row = row + [""] * (9 - len(row))
        number, category, jp, reading, cn, ctx, example, literal, note = row[:9]
        if not jp.strip():
            continue
        out.append({
            "id": len(out) + 1,
            "category": category,
            "jp": jp.strip(),
            "reading": reading.strip(),
            "cn": cn.strip(),
            "example": example.strip(),
            "example_literal": literal.strip(),
            "note": note.strip(),
            "level": "",
        })
    return out


def parse_mrjp(rows: list[list[str]]) -> list[dict]:
    """
    MR JP schema (look at column B for markers and header rows):
      Col B 單字 | C 発音 | D 日檢 | E 中文意思 | F 引用句

    Skip headers (where B == '單字' exactly), skip category subheaders,
    process from 一、單字表整理 until 二、主要句型公式整理.
    """
    out = []
    in_vocab_section = False
    current_category = ""
    for i, row in enumerate(rows, start=1):
        row = row + [""] * (6 - len(row))
        b = row[1].strip() if len(row) > 1 else ""
        if b.startswith("一、"):
            in_vocab_section = True
            continue
        if b.startswith("二、") or b.startswith("三、") or b.startswith("四、"):
            in_vocab_section = False
            continue
        if not in_vocab_section:
            continue
        if b in MRJP_CATEGORIES:
            current_category = b
            continue
        if b in ("單字", "単字", "单字"):  # header row — traditional/Japanese/simplified
            continue
        # Secondary defense: col C being "発音" means this is a header row
        c = row[2].strip() if len(row) > 2 else ""
        if c in ("発音", "發音", "讀音"):
            continue
        if not b:
            continue
        # Data row
        jp = row[1].strip()
        reading = row[2].strip()
        level = row[3].strip()
        cn = row[4].strip()
        example = row[5].strip() if len(row) > 5 else ""
        out.append({
            "id": len(out) + 1,
            "category": current_category,
            "jp": jp,
            "reading": reading,
            "cn": cn,
            "example": example,
            "example_literal": "",  # filled later by AI
            "note": "",
            "level": level,
        })
    return out


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    for sheet in SHEETS:
        title = sheet["title"]
        slug = sheet["slug"]
        schema = sheet["schema"]
        # Read generously; actual row counts are at most ~300 for vocab area
        a1 = f"{title}!A1:I300"
        print(f"Fetching {title} ({schema}) ...", flush=True)
        rows = gws_read(SHEET_ID, a1)
        if schema == "bd":
            parsed = parse_bd(rows)
        else:
            parsed = parse_mrjp(rows)
        out_dir = DATA_DIR / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / "rows.json", "w", encoding="utf-8") as f:
            json.dump({
                "sheet": title,
                "slug": slug,
                "schema": schema,
                "count": len(parsed),
                "rows": parsed,
            }, f, ensure_ascii=False, indent=2)
        summary.append((title, schema, len(parsed)))
        print(f"  -> {len(parsed)} rows")
    print("\nSummary:")
    for title, schema, n in summary:
        print(f"  {title} ({schema}): {n} rows")
    return 0


if __name__ == "__main__":
    import io
    # Safe stdout on Windows (cp932) when printing CJK
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.exit(main())

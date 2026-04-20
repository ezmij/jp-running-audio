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
    {"title": "常用的100個對話", "slug": "daily-100", "schema": "mrjp"},
    {"title": "談故鄉", "slug": "kokyou", "schema": "mrjp"},
    {"title": "談故鄉", "slug": "kokyou-transcript", "schema": "mrjp-transcript",
     "display_name": "談故鄉 — 全文對照"},
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


def parse_mrjp_transcript(rows: list[list[str]]) -> list[dict]:
    """
    Extract the full video transcript section paired with word-by-word
    Chinese literal translation.

    Section headers vary across sheets:
      - 談壓力: col B = "四、日漢對照"
      - 談故鄉: col A = "Context"
    Both layouts then put data in col E (JP) and col F (CN literal),
    with a header row containing "中文（詞序對應" in col F.
    """
    out = []
    in_section = False
    seen_header = False
    for row in rows:
        row = row + [""] * (6 - len(row))
        a = row[0].strip() if len(row) > 0 else ""
        b = row[1].strip() if len(row) > 1 else ""
        # Start markers
        if (b.startswith("四、") and "日漢" in b) or a == "Context":
            in_section = True
            seen_header = False
            continue
        # Stop at next major section
        if b.startswith("五、"):
            break
        if not in_section:
            continue
        e = row[4].strip() if len(row) > 4 else ""
        f = row[5].strip() if len(row) > 5 else ""
        # Skip the "中文（詞序對應，不潤飾）" header row
        if not seen_header and f and ("詞序對應" in f or "不潤飾" in f):
            seen_header = True
            continue
        if e == "日文原句":
            continue
        if not e:
            continue
        out.append({
            "id": len(out) + 1,
            "schema": "transcript",
            "category": "",
            "jp": e,
            "reading": "",
            "cn": "",
            "example": "",
            "example_literal": f,
            "note": "",
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
        # Read generously; transcript sections can extend to row ~800
        a1 = f"{title}!A1:I800"
        print(f"Fetching {title} ({schema}) ...", flush=True)
        rows = gws_read(SHEET_ID, a1)
        if schema == "bd":
            parsed = parse_bd(rows)
        elif schema == "mrjp-transcript":
            parsed = parse_mrjp_transcript(rows)
        else:
            parsed = parse_mrjp(rows)

        # Preserve AI-filled example_literal from previous rows.json so we
        # don't clobber generated word-by-word translations on each refetch.
        out_dir = DATA_DIR / slug
        prev_path = out_dir / "rows.json"
        if prev_path.exists():
            try:
                with open(prev_path, encoding="utf-8") as pf:
                    prev = json.load(pf)
                # Match by (category, jp, example) — same triple → carry literal
                prev_map = {
                    (r.get("category", ""), r.get("jp", ""), r.get("example", "")): r.get("example_literal", "")
                    for r in prev.get("rows", [])
                    if r.get("example_literal")
                }
                for row in parsed:
                    key = (row.get("category", ""), row.get("jp", ""), row.get("example", ""))
                    if not row.get("example_literal") and prev_map.get(key):
                        row["example_literal"] = prev_map[key]
            except Exception as e:
                print(f"  WARN: could not merge previous literals: {e}")

        out_dir.mkdir(parents=True, exist_ok=True)
        display_name = sheet.get("display_name", title)
        with open(out_dir / "rows.json", "w", encoding="utf-8") as f:
            json.dump({
                "sheet": display_name,
                "source_tab": title,
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

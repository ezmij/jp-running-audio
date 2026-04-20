"""
Generate 語序中文直譯 for MR JP sheets using Gemini CLI.

Reads:  data/<slug>/rows.json
Writes: data/<slug>/rows.json  (in place, fills example_literal)

Only processes rows where example_literal is empty AND example is non-empty.
Batches ~20 sentences per Gemini call to keep prompts short and reduce drops.

Usage (from project root):
    python scripts/gen_literal.py            # all MR JP sheets
    python scripts/gen_literal.py daily-100  # specific slug
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
BATCH_SIZE = 20
MODEL = "gemini-2.5-pro"

PROMPT_TEMPLATE = """你是日中翻譯助手。請對下方每句日文產生「語序中文直譯」。

規則：
- 不要潤飾語序，按日文原文節段順序直翻
- 助詞用括號標示功能：(主詞) (受詞) (地點) (時間) (方向) (手段) 等
- 每句輸出一個字串
- 節段間用半形空格分隔
- 保留專有名詞原文

範例：
日文：バイオダイナミック農法の基礎を学びます。
直譯：BD農法的 基礎(受詞) 學習。

日文：約1300万人が東京23区に住んでいると思います。
直譯：約1300萬人(主詞) 東京23區(地點) 居住 認為。

待翻譯的日文：
{sentences}

輸出一個 JSON 陣列，每元素是對應的語序直譯字串，順序嚴格對應上方編號。
只輸出 JSON 本體，不要 ```json 圍籬，不要前後文字、不要解釋。"""


def gemini_call(prompt: str) -> str:
    """Call gemini CLI with a prompt via stdin-like mechanism (use -p flag)."""
    # gemini -y -m <model> -p "<prompt>"
    # The prompt can be long; we pipe via a temp file + command substitution
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".txt", delete=False
    ) as tf:
        tf.write(prompt)
        tf_path = tf.name
    try:
        # Use bash-style command substitution to read prompt file
        cmd = f'gemini -y -m {MODEL} -p "$(cat {tf_path!r})"'
        proc = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, encoding="utf-8",
            timeout=180,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"gemini failed: {proc.stderr[:500]}")
        return proc.stdout
    finally:
        try:
            os.unlink(tf_path)
        except OSError:
            pass


def extract_json_array(text: str) -> list[str]:
    """Grab the first [...] JSON array in text, tolerant to fences."""
    t = text.strip()
    # Strip code fences if present
    if t.startswith("```"):
        # remove opening fence line
        lines = t.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    # Find first '[' and matching ']'
    start = t.find("[")
    end = t.rfind("]")
    if start < 0 or end < 0:
        raise ValueError(f"no JSON array in output:\n{text[:500]}")
    blob = t[start : end + 1]
    return json.loads(blob)


def batch_translate(sentences: list[str]) -> list[str]:
    """Translate one batch. Returns list aligned with input."""
    numbered = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(sentences))
    prompt = PROMPT_TEMPLATE.format(sentences=numbered)
    for attempt in range(3):
        try:
            out = gemini_call(prompt)
            arr = extract_json_array(out)
            if len(arr) != len(sentences):
                raise ValueError(
                    f"count mismatch: got {len(arr)} expected {len(sentences)}"
                )
            return arr
        except Exception as e:
            print(f"  attempt {attempt + 1} failed: {e}", flush=True)
            if attempt == 2:
                raise
            time.sleep(2 + attempt * 3)
    raise RuntimeError("unreachable")


def process_sheet(slug: str) -> int:
    path = DATA_DIR / slug / "rows.json"
    if not path.exists():
        print(f"  skip {slug}: rows.json missing")
        return 0
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    pending = [
        (i, r) for i, r in enumerate(data["rows"])
        if r.get("example") and not r.get("example_literal")
    ]
    if not pending:
        print(f"  {slug}: nothing to fill")
        return 0

    print(f"  {slug}: {len(pending)} rows to translate")
    total_updated = 0
    for batch_start in range(0, len(pending), BATCH_SIZE):
        batch = pending[batch_start : batch_start + BATCH_SIZE]
        sentences = [r["example"] for _, r in batch]
        print(
            f"    batch {batch_start // BATCH_SIZE + 1}: "
            f"{len(sentences)} sentences",
            flush=True,
        )
        try:
            translations = batch_translate(sentences)
        except Exception as e:
            print(f"    BATCH FAILED (leaving empty): {e}")
            continue
        for (idx, row), tr in zip(batch, translations):
            data["rows"][idx]["example_literal"] = tr.strip()
            total_updated += 1

        # Save incrementally after each successful batch
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    return total_updated


def main() -> int:
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    targets = sys.argv[1:] if len(sys.argv) > 1 else None
    slugs = [p.name for p in DATA_DIR.iterdir() if p.is_dir()]
    if targets:
        slugs = [s for s in slugs if s in targets]
    print(f"Processing: {slugs}")
    total = 0
    for slug in slugs:
        print(f"\n=== {slug} ===")
        n = process_sheet(slug)
        total += n
        print(f"  updated {n} rows")
    print(f"\nTotal updated: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

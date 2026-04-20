"""
Generate TTS MP3s per row using Google Cloud Text-to-Speech.

Per row produces up to 4 audio segments, stored under web/audio/<slug>/:
    001-1-word.mp3     ja-JP       (日文單字)
    001-2-meaning.mp3  cmn-TW      (中文意思)
    001-3-example.mp3  ja-JP       (日文例句)
    001-4-literal.mp3  cmn-TW      (語序直譯; skipped if empty)

Also writes a web/data/<slug>/manifest.json for the PWA:
    {
      "sheet": "...",
      "slug": "...",
      "total": 154,
      "tracks": [
        {"id": 1, "jp": "...", "reading": "...", "cn": "...",
         "example": "...", "example_literal": "...",
         "segments": ["audio/slug/001-1-word.mp3", ...]}
      ]
    }

Uses `gcloud auth print-access-token` for bearer auth against the REST endpoint.
Requires texttospeech.googleapis.com enabled on the active gcloud project.

Usage (from project root):
    python scripts/gen_tts.py               # all sheets
    python scripts/gen_tts.py daily-100     # specific slug
    python scripts/gen_tts.py --limit 3     # smoke test: 3 rows per sheet
"""
import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
WEB_DIR = PROJECT_ROOT / "docs"
AUDIO_DIR = WEB_DIR / "audio"
MANIFEST_DIR = WEB_DIR / "data"

TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize"
JA_VOICE = {"languageCode": "ja-JP", "name": "ja-JP-Neural2-B"}
ZH_VOICE = {"languageCode": "cmn-TW", "name": "cmn-TW-Standard-A"}
QUOTA_PROJECT = "yuningweb"


def get_access_token() -> str:
    proc = subprocess.run(
        "gcloud auth print-access-token",
        shell=True, capture_output=True, text=True, encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"gcloud auth failed: {proc.stderr}")
    return proc.stdout.strip()


def synth(token: str, text: str, voice: dict, speaking_rate: float = 1.0) -> bytes:
    payload = {
        "input": {"text": text},
        "voice": voice,
        "audioConfig": {
            "audioEncoding": "MP3",
            "speakingRate": speaking_rate,
            "sampleRateHertz": 24000,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        TTS_ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "X-Goog-User-Project": QUOTA_PROJECT,
        },
        method="POST",
    )
    for attempt in range(3):
        try:
            with urlrequest.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read())
                return base64.b64decode(data["audioContent"])
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            if e.code == 401 and attempt == 0:
                # Token possibly expired — caller should refresh and retry
                raise PermissionError(body)
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"TTS HTTP {e.code}: {body[:400]}")
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
                continue
            raise
    raise RuntimeError("unreachable")


def render_segment(token: str, text: str, voice: dict, path: Path) -> None:
    if path.exists() and path.stat().st_size > 0:
        return  # already rendered
    audio = synth(token, text, voice)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(audio)


def row_segments(row: dict) -> list[tuple[str, str, dict]]:
    """Return list of (kind, text, voice) per row. Kind used for filename."""
    segs = []
    # 1. word + reading (reading only if different from jp)
    if row["reading"] and row["reading"] != row["jp"]:
        word_text = f"{row['jp']}。{row['reading']}"
    else:
        word_text = row["jp"]
    segs.append(("word", word_text, JA_VOICE))
    # 2. chinese meaning
    if row.get("cn"):
        segs.append(("meaning", f"中文意思：{row['cn']}", ZH_VOICE))
    # 3. japanese example
    if row.get("example"):
        segs.append(("example", f"例句：{row['example']}", JA_VOICE))
    # 4. literal zh
    if row.get("example_literal"):
        segs.append(("literal", f"直譯：{row['example_literal']}", ZH_VOICE))
    return segs


def process_sheet(slug: str, token: str, limit: int | None) -> dict:
    rows_path = DATA_DIR / slug / "rows.json"
    if not rows_path.exists():
        print(f"  skip {slug}: rows.json missing")
        return {}
    with open(rows_path, encoding="utf-8") as f:
        data = json.load(f)

    rows = data["rows"]
    if limit:
        rows = rows[:limit]

    sheet_audio_dir = AUDIO_DIR / slug
    sheet_audio_dir.mkdir(parents=True, exist_ok=True)

    tracks = []
    for i, row in enumerate(rows):
        rid = f"{row['id']:03d}"
        segs = row_segments(row)
        segment_urls = []
        for seq, (kind, text, voice) in enumerate(segs, start=1):
            fname = f"{rid}-{seq}-{kind}.mp3"
            out_path = sheet_audio_dir / fname
            try:
                render_segment(token, text, voice, out_path)
            except PermissionError:
                token = get_access_token()
                render_segment(token, text, voice, out_path)
            segment_urls.append(f"audio/{slug}/{fname}")
        track = {
            "id": row["id"],
            "jp": row["jp"],
            "reading": row["reading"],
            "cn": row["cn"],
            "example": row["example"],
            "example_literal": row["example_literal"],
            "category": row.get("category", ""),
            "level": row.get("level", ""),
            "segments": segment_urls,
        }
        tracks.append(track)
        if (i + 1) % 10 == 0 or i == len(rows) - 1:
            print(f"  {slug}: {i + 1}/{len(rows)}", flush=True)

    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = MANIFEST_DIR / f"{slug}.json"
    manifest = {
        "sheet": data["sheet"],
        "slug": slug,
        "total": len(tracks),
        "tracks": tracks,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest


def main() -> int:
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("slugs", nargs="*")
    parser.add_argument("--limit", type=int, default=None,
                        help="only render first N rows per sheet (smoke test)")
    args = parser.parse_args()

    slugs = args.slugs or [p.name for p in DATA_DIR.iterdir() if p.is_dir()]
    print(f"Generating TTS for: {slugs}")
    if args.limit:
        print(f"Limit: first {args.limit} rows per sheet")

    token = get_access_token()

    index = []
    for slug in slugs:
        print(f"\n=== {slug} ===")
        manifest = process_sheet(slug, token, args.limit)
        if manifest and manifest.get("total", 0) > 0:
            index.append({
                "slug": manifest["slug"],
                "sheet": manifest["sheet"],
                "total": manifest["total"],
            })

    # Top-level index for PWA sheet picker
    (MANIFEST_DIR / "index.json").write_text(
        json.dumps({"sheets": index}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\nDone. Sheets:", [s["slug"] for s in index])
    return 0


if __name__ == "__main__":
    sys.exit(main())

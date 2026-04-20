"""
Generate one sample MP3 per available ja-JP + cmn-TW voice and build
docs/voices.html so Masa can audition each one on his phone.

Usage (from project root):
    python scripts/gen_voice_samples.py
"""
import base64
import json
import subprocess
import sys
from pathlib import Path
from urllib import request as urlrequest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "docs" / "voices"
SAMPLES = {
    "ja-JP": "こんにちは、これは日本語のサンプル音声です。"
             "バッグを詰めます。約1300万人が東京に住んでいます。",
    "cmn-TW": "你好，這是台灣華語的聲音範例。"
               "今天天氣不錯，中文意思是「填裝、塞進」。",
}
QUOTA_PROJECT = "yuningweb"


def get_token() -> str:
    proc = subprocess.run(
        "gcloud auth print-access-token",
        shell=True, capture_output=True, text=True, encoding="utf-8",
    )
    return proc.stdout.strip()


def api(url: str, token: str, body=None) -> dict:
    req = urlrequest.Request(
        url,
        data=json.dumps(body).encode("utf-8") if body else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "X-Goog-User-Project": QUOTA_PROJECT,
        },
        method="POST" if body else "GET",
    )
    with urlrequest.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def list_voices(lang: str, token: str) -> list[dict]:
    data = api(
        f"https://texttospeech.googleapis.com/v1/voices?languageCode={lang}",
        token,
    )
    return data.get("voices", [])


def synth(voice_name: str, lang: str, text: str, token: str) -> bytes:
    payload = {
        "input": {"text": text},
        "voice": {"languageCode": lang, "name": voice_name},
        "audioConfig": {"audioEncoding": "MP3", "sampleRateHertz": 24000},
    }
    data = api(
        "https://texttospeech.googleapis.com/v1/text:synthesize",
        token,
        payload,
    )
    return base64.b64decode(data["audioContent"])


def build_html(samples: list[dict]) -> str:
    rows = []
    for s in samples:
        tier = s["tier"]
        tier_cls = tier.lower().replace("-", "").replace(" ", "")
        rows.append(f"""
        <li class="voice">
          <button class="play" data-src="voices/{s['fname']}" aria-label="播放">▶</button>
          <div class="meta">
            <div class="name">{s['name']}</div>
            <div class="tags">
              <span class="tag tier-{tier_cls}">{tier}</span>
              <span class="tag">{s['gender']}</span>
              <span class="tag">{s['lang']}</span>
            </div>
          </div>
        </li>
        """)
    return f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>聲音試聽</title>
<style>
  body {{ font-family: -apple-system, sans-serif; background: #0a0a0a; color: #eee; margin: 0; padding: 16px; }}
  h1 {{ font-size: 20px; margin: 8px 0 4px; }}
  .note {{ color: #888; font-size: 13px; margin-bottom: 16px; line-height: 1.5; }}
  .section-label {{ color: #888; font-size: 12px; margin: 16px 0 6px; letter-spacing: 0.5px; }}
  ul {{ list-style: none; padding: 0; margin: 0; }}
  li.voice {{ display: flex; align-items: center; gap: 12px; background: #1a1a1a; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }}
  button.play {{ background: #2563eb; color: #fff; border: none; border-radius: 50%; width: 40px; height: 40px; font-size: 16px; cursor: pointer; flex-shrink: 0; }}
  button.play.playing {{ background: #16a34a; }}
  .meta .name {{ font-size: 15px; font-family: ui-monospace, monospace; }}
  .tags {{ display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }}
  .tag {{ font-size: 10px; background: #333; color: #aaa; padding: 2px 6px; border-radius: 4px; }}
  .tier-studio {{ background: #a855f7; color: #fff; }}
  .tier-chirp3hd, .tier-chirphd {{ background: #0891b2; color: #fff; }}
  .tier-neural2 {{ background: #2563eb; color: #fff; }}
  .tier-wavenet {{ background: #16a34a; color: #fff; }}
  .tier-standard {{ background: #6b7280; color: #fff; }}
  .back {{ display: block; color: #888; margin: 20px 0 8px; text-decoration: none; font-size: 14px; }}
</style>
</head>
<body>
<a class="back" href="./">← 回主畫面</a>
<h1>聲音試聽</h1>
<p class="note">每個 button 播 5-10 秒樣本。告訴我你要留哪幾個，我寫進技巧檔。<br>
Studio &gt; Chirp HD &gt; Neural2 &gt; Wavenet &gt; Standard（自然度排序，價格也是這樣）。</p>

<div class="section-label">日文 ja-JP</div>
<ul>{"".join(r for s, r in zip(samples, rows) if s['lang'] == 'ja-JP')}</ul>

<div class="section-label">台灣華語 cmn-TW</div>
<ul>{"".join(r for s, r in zip(samples, rows) if s['lang'] == 'cmn-TW')}</ul>

<script>
let current = null;
const audio = new Audio();
audio.addEventListener('ended', () => {{
  if (current) current.classList.remove('playing');
  current = null;
}});
document.querySelectorAll('.play').forEach(btn => {{
  btn.addEventListener('click', () => {{
    if (current === btn) {{
      audio.pause(); current.classList.remove('playing'); current = null; return;
    }}
    if (current) current.classList.remove('playing');
    audio.src = btn.dataset.src;
    audio.play();
    btn.classList.add('playing');
    current = btn;
  }});
}});
</script>
</body>
</html>
"""


def main() -> int:
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    token = get_token()
    samples = []
    for lang, text in SAMPLES.items():
        print(f"\n=== {lang} ===")
        voices = list_voices(lang, token)
        # Sort: Studio > Chirp3-HD > Chirp-HD > Neural2 > Wavenet > Standard
        def tier(v):
            n = v["name"]
            if "Studio" in n: return 0
            if "Chirp3-HD" in n: return 1
            if "Chirp-HD" in n: return 2
            if "Neural2" in n: return 3
            if "Wavenet" in n: return 4
            return 5

        voices.sort(key=lambda v: (tier(v), v["name"]))
        for v in voices:
            name = v["name"]
            n = name
            if "Studio" in n: t = "Studio"
            elif "Chirp3-HD" in n: t = "Chirp3-HD"
            elif "Chirp-HD" in n: t = "Chirp-HD"
            elif "Neural2" in n: t = "Neural2"
            elif "Wavenet" in n: t = "Wavenet"
            else: t = "Standard"
            gender = v.get("ssmlGender", "NEUTRAL")
            fname = f"{name}.mp3"
            fpath = OUT_DIR / fname
            if not fpath.exists():
                try:
                    audio = synth(name, lang, text, token)
                    fpath.write_bytes(audio)
                    print(f"  {name} ({t}, {gender})")
                except Exception as e:
                    print(f"  SKIP {name}: {str(e)[:100]}")
                    continue
            samples.append({
                "name": name, "tier": t, "gender": gender,
                "lang": lang, "fname": fname,
            })

    html = build_html(samples)
    (PROJECT_ROOT / "docs" / "voices.html").write_text(html, encoding="utf-8")
    print(f"\nTotal samples: {len(samples)}")
    print(f"Wrote docs/voices.html + docs/voices/*.mp3 ({len(samples)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# 日語跑步聽

iOS PWA — 跑步時聽日文單字＋例句＋中文直譯，AirPods 按鍵控制。

## 結構

```
scripts/
  fetch_sheets.py     拉試算表資料 → data/<slug>/rows.json
  gen_literal.py      Gemini 版語序直譯（備用，速度慢）
  gen_tts.py          Google Cloud TTS → web/audio/ + web/data/
web/
  index.html + app.js + style.css + sw.js + manifest.webmanifest
  audio/<slug>/001-1-word.mp3 …
  data/<slug>.json    PWA manifest（含 tracks + segments URL）
  data/index.json     sheet picker 用
data/
  <slug>/rows.json    中間檔
```

## 更新流程

試算表改了以後：

```bash
cd "Coding Projects/jp-running-audio"
python scripts/fetch_sheets.py          # 重抓試算表
# 如果 MR JP 新增了分頁 / 例句：
# 找 Claude/AI 幫忙補 data/<slug>/rows.json 的 example_literal
python scripts/gen_tts.py               # 只會生新的 MP3
git add -A && git commit -m "update content"
git push                                # GitHub Pages 自動部署
```

`gen_tts.py` 會跳過已存在的 MP3，所以重跑便宜。

## 部署

首次：

```bash
gh repo create jp-running-audio --public --source=.
git push -u origin main
gh api -X POST repos/{owner}/jp-running-audio/pages \
  -f 'source[branch]=main' -f 'source[path]=/web'
```

之後每次 `git push` 就會自動部署到 `https://<user>.github.io/jp-running-audio/`。

## iOS 使用

1. iPhone Safari 開 `https://<user>.github.io/jp-running-audio/web/`
2. 分享鍵 → 加到主畫面
3. 選主題 + 模式 → 開始
4. AirPods：雙擊＝下一詞、三擊＝上一詞、單擊＝暫停／播放

## 設定

- TTS 聲音：`scripts/gen_tts.py` 的 `JA_VOICE` / `ZH_VOICE`
- 模式預設：`web/app.js` 的 `state.mode`

// 日語跑步聽 PWA — single-file controller
// - Loads sheet manifests from data/*.json
// - Settings panel (per schema) gates sheet entry: pick segments + gaps, then play
// - Hooks MediaSession API for AirPods/lock-screen controls

const SPEEDS = [0.7, 0.85, 1.0, 1.1, 1.3];

const KIND_META = {
  vocab: [
    { kind: "word",    label: "日文單字" },
    { kind: "meaning", label: "中文意思" },
    { kind: "example", label: "日文例句" },
    { kind: "literal", label: "語序直譯" },
  ],
  transcript: [
    { kind: "sentence", label: "日文原句" },
    { kind: "literal",  label: "語序直譯" },
  ],
};

const DEFAULT_SETTINGS = {
  vocab: {
    enabled: { word: true, meaning: true, example: true, literal: true },
    gaps: [350, 350, 350, 600],
  },
  transcript: {
    enabled: { sentence: true, literal: true },
    gaps: [350, 600],
  },
};

const state = {
  sheets: [],
  currentSheet: null,
  currentTrackIdx: 0,
  currentSegmentIdx: 0,
  mode: localStorage.getItem("mode") || "tap",
  speed: parseFloat(localStorage.getItem("speed")) || 1.0,
  isPlaying: false,
  segmentTimer: null,
  activeSegments: [],
  settings: loadSettings(),
};

const $ = (id) => document.getElementById(id);
const audio = $("audio");

// ----- Settings persistence -----

function loadSettings() {
  const fallback = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try {
    const raw = localStorage.getItem("settings");
    if (!raw) return fallback;
    const s = JSON.parse(raw);
    return {
      vocab: {
        enabled: { ...fallback.vocab.enabled, ...(s?.vocab?.enabled || {}) },
        gaps: Array.isArray(s?.vocab?.gaps) && s.vocab.gaps.length === 4
          ? s.vocab.gaps.map(Number) : fallback.vocab.gaps,
      },
      transcript: {
        enabled: { ...fallback.transcript.enabled, ...(s?.transcript?.enabled || {}) },
        gaps: Array.isArray(s?.transcript?.gaps) && s.transcript.gaps.length === 2
          ? s.transcript.gaps.map(Number) : fallback.transcript.gaps,
      },
    };
  } catch (e) {
    return fallback;
  }
}

function saveSettings() {
  localStorage.setItem("settings", JSON.stringify(state.settings));
}

// ----- Kind / schema helpers -----

function segKindFromUrl(url) {
  const m = url.match(/-(\d+)-([a-z]+)\.mp3(?:[?#].*)?$/);
  return m ? m[2] : null;
}

function sheetSchema(manifest) {
  const first = manifest.tracks?.[0]?.segments?.[0];
  const kind = first ? segKindFromUrl(first) : null;
  return kind === "sentence" ? "transcript" : "vocab";
}

function activeSegmentsForTrack(track) {
  const schema = state.currentSheet?.schema || "vocab";
  const cfg = state.settings[schema];
  return track.segments.filter((url) => {
    const kind = segKindFromUrl(url);
    return kind && cfg.enabled[kind];
  });
}

function gapAfterKind(kind) {
  const schema = state.currentSheet?.schema || "vocab";
  const kinds = KIND_META[schema].map((k) => k.kind);
  const idx = kinds.indexOf(kind);
  if (idx < 0) return 350;
  return state.settings[schema].gaps[idx] ?? 350;
}

function lastGap() {
  const schema = state.currentSheet?.schema || "vocab";
  const gaps = state.settings[schema].gaps;
  return gaps[gaps.length - 1] ?? 600;
}

// ----- Timers -----

function clearSegmentTimer() {
  if (state.segmentTimer) {
    clearTimeout(state.segmentTimer);
    state.segmentTimer = null;
  }
}

// ----- Init -----
init();

async function init() {
  restoreUIState();
  await loadSheetIndex();
  bindEvents();
  bindOfflinePanel();
  registerServiceWorker();
}

function restoreUIState() {
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
}

async function loadSheetIndex() {
  const list = $("sheet-list");
  try {
    const res = await fetch("data/index.json", { cache: "no-cache" });
    const data = await res.json();
    state.sheets = data.sheets || [];
    list.innerHTML = "";
    for (const s of state.sheets) {
      const li = document.createElement("li");
      li.dataset.slug = s.slug;
      li.innerHTML = `
        <span>${s.sheet}</span>
        <span class="count">${s.total} 詞 <span class="cache-badge" data-cache-badge="${s.slug}" title="點主題進去會自動下載到離線"></span></span>
      `;
      li.addEventListener("click", () => openSheet(s.slug));
      list.appendChild(li);
    }
    if (state.sheets.length === 0) {
      list.innerHTML = "<li class='loading'>沒有可用的主題</li>";
    }
    refreshAllCacheBadges();
  } catch (e) {
    list.innerHTML = `<li class='loading'>載入失敗：${e.message}</li>`;
  }
}

// ----- Offline / cache management -----

async function fetchSheetManifest(slug) {
  if (!state.manifestCache) state.manifestCache = {};
  if (state.manifestCache[slug]) return state.manifestCache[slug];
  const res = await fetch(`data/${slug}.json`);
  if (!res.ok) throw new Error(`manifest ${slug}: ${res.status}`);
  const m = await res.json();
  state.manifestCache[slug] = m;
  return m;
}

function manifestUrls(manifest, slug) {
  const segUrls = manifest.tracks.flatMap((t) => t.segments);
  return [`data/${slug}.json`, ...segUrls];
}

function swPost(message) {
  return new Promise((resolve, reject) => {
    if (!navigator.serviceWorker?.controller) return reject(new Error("no SW"));
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("SW timeout")), 30000);
    ch.port1.onmessage = (ev) => { clearTimeout(timer); resolve(ev.data); };
    navigator.serviceWorker.controller.postMessage(message, [ch.port2]);
  });
}

async function querySheetCacheStatus(slug) {
  try {
    const manifest = await fetchSheetManifest(slug);
    const urls = manifestUrls(manifest, slug);
    const resp = await swPost({ type: "query-cache-status", urls, tag: slug });
    return { slug, cached: resp.cached, total: resp.total };
  } catch (e) {
    return { slug, cached: 0, total: 0, error: e.message };
  }
}

function renderCacheBadge(slug, cached, total) {
  const el = document.querySelector(`[data-cache-badge="${slug}"]`);
  if (!el) return;
  if (total === 0) {
    el.textContent = "";
    return;
  }
  if (cached >= total) {
    el.textContent = "✅ 離線";
    el.className = "cache-badge ok";
  } else if (cached === 0) {
    el.textContent = "⬇ 未下載";
    el.className = "cache-badge none";
  } else {
    const pct = Math.round((cached / total) * 100);
    el.textContent = `🔄 ${pct}%`;
    el.className = "cache-badge partial";
  }
}

async function refreshAllCacheBadges() {
  if (!navigator.serviceWorker?.controller) return;
  for (const s of state.sheets || []) {
    const r = await querySheetCacheStatus(s.slug);
    renderCacheBadge(s.slug, r.cached, r.total);
  }
  updateGlobalStorageInfo();
}

async function precacheSheet(slug, onProgress) {
  const manifest = await fetchSheetManifest(slug);
  const urls = manifestUrls(manifest, slug);
  return new Promise((resolve, reject) => {
    if (!navigator.serviceWorker?.controller) return reject(new Error("no SW"));
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("precache timeout")), 600000);
    ch.port1.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === "precache-progress" && onProgress) onProgress(d);
      if (d.type === "precache-done") { clearTimeout(timer); resolve(d); }
    };
    navigator.serviceWorker.controller.postMessage(
      { type: "precache", urls, tag: slug },
      [ch.port2]
    );
  });
}

async function precacheAllSheets() {
  const btn = $("dl-all-btn");
  if (btn) btn.disabled = true;
  for (const s of state.sheets || []) {
    try {
      await precacheSheet(s.slug, (p) => {
        renderCacheBadge(s.slug, p.done, p.total);
        if (btn) btn.textContent = `下載中 ${s.sheet} ${p.done}/${p.total}…`;
      });
      await querySheetCacheStatus(s.slug).then((r) =>
        renderCacheBadge(s.slug, r.cached, r.total));
    } catch (e) {
      console.warn("precache failed", s.slug, e);
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = "全部下載到離線";
  }
  updateGlobalStorageInfo();
}

async function clearAudioCache() {
  if (!confirm("確定清除已下載的離線 MP3？\n（程式 + 設定不受影響，下次播放會重新下載）")) return;
  await swPost({ type: "clear-audio-cache" });
  refreshAllCacheBadges();
}

async function requestPersistent() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch (_) { return false; }
}

async function updateGlobalStorageInfo() {
  const usageEl = $("storage-usage");
  const persistEl = $("storage-persist");
  if (!usageEl || !persistEl) return;
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    const used = (e.usage || 0) / 1024 / 1024;
    const quota = (e.quota || 0) / 1024 / 1024 / 1024;
    usageEl.textContent = `已用 ${used.toFixed(1)} MB${quota ? ` / 配額 ${quota.toFixed(2)} GB` : ""}`;
  } else {
    usageEl.textContent = "（瀏覽器不支援用量查詢）";
  }
  if (navigator.storage?.persisted) {
    const p = await navigator.storage.persisted();
    persistEl.textContent = p ? "✅ 永久（不會被系統回收）" : "⚠️ 非永久（系統可能在儲存空間不足時清除）";
    persistEl.className = "persist-status " + (p ? "ok" : "warn");
  } else {
    persistEl.textContent = "（瀏覽器不支援永久儲存查詢）";
  }
}

function bindEvents() {
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      localStorage.setItem("mode", state.mode);
      document.querySelectorAll(".mode-btn").forEach((x) =>
        x.classList.toggle("active", x.dataset.mode === state.mode)
      );
      updateModeIndicator();
    });
  });

  $("back-btn").addEventListener("click", goHome);
  $("prev-btn").addEventListener("click", () => prevTrack(true));
  $("next-btn").addEventListener("click", () => nextTrack(true));
  $("replay-btn").addEventListener("click", (e) => {
    if (state.suppressReplayClick) {
      state.suppressReplayClick = false;
      e.preventDefault();
      return;
    }
    toggleReplay();
  });
  $("mode-indicator").addEventListener("click", () => {
    state.mode = state.mode === "tap" ? "continuous" : "tap";
    localStorage.setItem("mode", state.mode);
    updateModeIndicator();
  });
  $("speed-btn").addEventListener("click", cycleSpeed);

  $("settings-back-btn").addEventListener("click", () => {
    $("settings").classList.remove("active");
    $("home").classList.add("active");
  });
  $("start-play-btn").addEventListener("click", startPlaying);

  const slider = $("position-slider");
  slider.addEventListener("input", (e) => {
    updatePreview(parseInt(e.target.value, 10) - 1);
  });
  slider.addEventListener("change", (e) => {
    const newIdx = parseInt(e.target.value, 10) - 1;
    clearSegmentTimer();
    state.currentTrackIdx = newIdx;
    state.currentSegmentIdx = 0;
    renderTrack();
    playCurrent();
    updateMediaSession();
  });

  let pressTimer = null;
  const replayBtn = $("replay-btn");
  const startPress = () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (!state.currentSheet) return;
      state.suppressReplayClick = true;
      clearSegmentTimer();
      state.currentTrackIdx = 0;
      state.currentSegmentIdx = 0;
      renderTrack();
      playCurrent();
      updateMediaSession();
    }, 600);
  };
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };
  replayBtn.addEventListener("pointerdown", startPress);
  replayBtn.addEventListener("pointerup", cancelPress);
  replayBtn.addEventListener("pointerleave", cancelPress);
  replayBtn.addEventListener("pointercancel", cancelPress);

  applySpeed();
  updateSpeedIndicator();

  audio.addEventListener("ended", onSegmentEnded);
  audio.addEventListener("play", () => setPlayingUI(true));
  audio.addEventListener("pause", () => setPlayingUI(false));
  audio.addEventListener("error", () => {
    console.warn("audio error", audio.error);
  });
}

// ----- Sheet loading / settings panel -----

async function openSheet(slug) {
  const res = await fetch(`data/${slug}.json`, { cache: "no-cache" });
  const manifest = await res.json();
  manifest.schema = sheetSchema(manifest);
  state.currentSheet = manifest;

  const savedIdx = parseInt(localStorage.getItem(`pos:${slug}`), 10);
  state.currentTrackIdx = Number.isFinite(savedIdx) && savedIdx >= 0 && savedIdx < manifest.total
    ? savedIdx : 0;
  state.currentSegmentIdx = 0;
  localStorage.setItem("lastSheet", slug);

  showSettings();

  if (navigator.serviceWorker?.controller) {
    const urls = manifest.tracks.flatMap((t) => t.segments);
    navigator.serviceWorker.controller.postMessage({ type: "precache", urls });
  }
}

function showSettings() {
  const manifest = state.currentSheet;
  if (!manifest) return;

  $("home").classList.remove("active");
  $("player").classList.remove("active");
  $("settings").classList.add("active");

  $("settings-title").textContent = manifest.sheet;
  $("settings-subtitle").textContent = `${state.currentTrackIdx + 1} / ${manifest.total}`;

  const schema = manifest.schema;
  const cfg = state.settings[schema];

  const togglesEl = $("segment-toggles");
  togglesEl.innerHTML = "";
  KIND_META[schema].forEach((k) => {
    const label = document.createElement("label");
    label.className = "segment-toggle";
    label.innerHTML = `
      <input type="checkbox" data-kind="${k.kind}" ${cfg.enabled[k.kind] ? "checked" : ""}>
      <span class="seg-label">${k.label}</span>
    `;
    togglesEl.appendChild(label);
  });
  togglesEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      cfg.enabled[cb.dataset.kind] = cb.checked;
      saveSettings();
      updateStartBtn();
    });
  });

  const gapsEl = $("gap-inputs");
  gapsEl.innerHTML = "";
  KIND_META[schema].forEach((k, i) => {
    const row = document.createElement("div");
    row.className = "gap-row";
    const isLast = i === KIND_META[schema].length - 1;
    const labelText = isLast
      ? `${k.label}→下一筆`
      : `${k.label}→下一段`;
    row.innerHTML = `
      <span class="gap-label">${labelText}</span>
      <input type="number" min="0" max="10" step="0.1" value="${(cfg.gaps[i] / 1000).toFixed(1)}" data-idx="${i}">
      <span class="gap-unit">秒</span>
    `;
    gapsEl.appendChild(row);
  });
  gapsEl.querySelectorAll("input[type=number]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const secs = parseFloat(inp.value);
      if (Number.isFinite(secs) && secs >= 0) {
        cfg.gaps[idx] = Math.round(secs * 1000);
        saveSettings();
      } else {
        inp.value = (cfg.gaps[idx] / 1000).toFixed(1);
      }
    });
  });

  updateStartBtn();
}

function updateStartBtn() {
  const schema = state.currentSheet?.schema || "vocab";
  const cfg = state.settings[schema];
  const anyEnabled = Object.values(cfg.enabled).some(Boolean);
  const btn = $("start-play-btn");
  btn.disabled = !anyEnabled;
  btn.textContent = anyEnabled ? "開始播放" : "請至少選一項";
  btn.style.opacity = anyEnabled ? "" : "0.5";
}

function startPlaying() {
  $("settings").classList.remove("active");
  $("player").classList.add("active");
  updateModeIndicator();
  setupSlider();
  renderTrack();
  playCurrent();
  setupMediaSession();
}

function savePosition() {
  if (!state.currentSheet) return;
  localStorage.setItem(`pos:${state.currentSheet.slug}`, state.currentTrackIdx);
}

function goHome() {
  clearSegmentTimer();
  audio.pause();
  $("player").classList.remove("active");
  $("settings").classList.remove("active");
  $("home").classList.add("active");
}

function updateModeIndicator() {
  $("mode-indicator").textContent = state.mode === "tap" ? "點擊" : "連播";
}

function updateSpeedIndicator() {
  const v = state.speed;
  $("speed-btn").textContent = (v === 1 ? "1.0" : String(v)) + "×";
}

function applySpeed() {
  audio.playbackRate = state.speed;
  if ("preservesPitch" in audio) audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
}

function cycleSpeed() {
  const idx = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(idx + 1) % SPEEDS.length];
  localStorage.setItem("speed", state.speed);
  applySpeed();
  updateSpeedIndicator();
}

// ----- Rendering -----

function currentTrack() {
  return state.currentSheet?.tracks[state.currentTrackIdx];
}

function renderTrack() {
  const t = currentTrack();
  if (!t) return;
  $("sheet-title").textContent = state.currentSheet.sheet;
  $("position").textContent = `${state.currentTrackIdx + 1} / ${state.currentSheet.total}`;
  setField("category", [t.category, t.level].filter(Boolean).join(" · "));
  setField("jp", t.jp);
  setField("reading", t.reading && t.reading !== t.jp ? t.reading : "");
  setField("cn", t.cn);
  setField("example", t.example);
  setField("literal", t.example_literal);
  state.activeSegments = activeSegmentsForTrack(t);
  renderDots();
  syncSlider();
  savePosition();
}

function setField(id, value) {
  const el = $(id);
  el.textContent = value || "";
  el.hidden = !value;
}

function setupSlider() {
  const slider = $("position-slider");
  slider.min = 1;
  slider.max = state.currentSheet.total;
  slider.value = state.currentTrackIdx + 1;
  updatePreview(state.currentTrackIdx);
}

function syncSlider() {
  const slider = $("position-slider");
  slider.value = state.currentTrackIdx + 1;
  updatePreview(state.currentTrackIdx);
}

function updatePreview(idx) {
  const t = state.currentSheet?.tracks[idx];
  if (!t) return;
  $("preview-pos").textContent = `${idx + 1} / ${state.currentSheet.total}`;
  $("preview-cat").textContent = [t.category, t.level].filter(Boolean).join(" · ");
}

function renderDots() {
  const dots = $("segment-dots");
  dots.innerHTML = "";
  const n = state.activeSegments.length;
  for (let i = 0; i < n; i++) {
    const d = document.createElement("span");
    d.className = "dot" +
      (i === state.currentSegmentIdx ? " active" :
       i < state.currentSegmentIdx ? " done" : "");
    dots.appendChild(d);
  }
}

// ----- Playback -----

function playCurrent() {
  if (!state.activeSegments.length) return;
  const url = state.activeSegments[state.currentSegmentIdx];
  if (!url) return;
  audio.src = url;
  applySpeed();
  audio.play().catch((e) => console.warn("play error", e));
  renderDots();
}

function onSegmentEnded() {
  const active = state.activeSegments;
  const justEnded = active[state.currentSegmentIdx];
  const justKind = justEnded ? segKindFromUrl(justEnded) : null;

  if (state.currentSegmentIdx < active.length - 1) {
    state.currentSegmentIdx++;
    renderDots();
    clearSegmentTimer();
    const gap = justKind ? gapAfterKind(justKind) : 350;
    state.segmentTimer = setTimeout(() => {
      state.segmentTimer = null;
      playCurrent();
    }, gap);
    return;
  }
  // Track finished
  state.currentSegmentIdx = 0;
  if (state.mode === "continuous") {
    clearSegmentTimer();
    state.segmentTimer = setTimeout(() => {
      state.segmentTimer = null;
      nextTrack(false);
    }, lastGap());
  } else {
    setPlayingUI(false);
    renderDots();
  }
}

function nextTrack(fromUser) {
  clearSegmentTimer();
  const total = state.currentSheet.total;
  if (state.currentTrackIdx >= total - 1) {
    if (state.mode === "continuous") {
      state.currentTrackIdx = 0;
    } else {
      setPlayingUI(false);
      return;
    }
  } else {
    state.currentTrackIdx++;
  }
  state.currentSegmentIdx = 0;
  renderTrack();
  playCurrent();
  updateMediaSession();
}

function prevTrack(fromUser) {
  clearSegmentTimer();
  if (state.currentTrackIdx > 0) state.currentTrackIdx--;
  state.currentSegmentIdx = 0;
  renderTrack();
  playCurrent();
  updateMediaSession();
}

function toggleReplay() {
  if (audio.paused) {
    if (state.currentSegmentIdx === 0 && (audio.ended || !audio.src)) {
      playCurrent();
    } else if (audio.ended) {
      playCurrent();
    } else {
      audio.play();
    }
  } else {
    clearSegmentTimer();
    audio.pause();
  }
}

function setPlayingUI(playing) {
  state.isPlaying = playing;
  const btn = $("replay-btn");
  btn.classList.toggle("playing", playing);
  btn.textContent = playing ? "⏸" : "▶";
}

// ----- MediaSession -----

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack(true));
  navigator.mediaSession.setActionHandler("previoustrack", () => prevTrack(true));
  updateMediaSession();
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const t = currentTrack();
  if (!t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${t.jp} — ${t.cn}`,
    artist: state.currentSheet.sheet,
    album: `${state.currentTrackIdx + 1} / ${state.currentSheet.total}`,
    artwork: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
}

// ----- Service Worker -----

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch((e) =>
    console.warn("sw register failed", e)
  );
  navigator.serviceWorker.ready.then(() => {
    requestPersistent();
    refreshAllCacheBadges();
  });
}

function bindOfflinePanel() {
  const dlAll = $("dl-all-btn");
  const clear = $("clear-cache-btn");
  if (dlAll) dlAll.addEventListener("click", () => precacheAllSheets());
  if (clear) clear.addEventListener("click", () => clearAudioCache());
  const panel = $("offline-panel");
  if (panel) panel.addEventListener("toggle", () => {
    if (panel.open) refreshAllCacheBadges();
  });
}

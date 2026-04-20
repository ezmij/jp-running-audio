// 日語跑步聽 PWA — single-file controller
// - Loads sheet manifests from data/*.json
// - Plays 4-segment audio sequences per track
// - Hooks MediaSession API for AirPods/lock-screen controls

const SPEEDS = [0.7, 0.85, 1.0, 1.1, 1.3];

const state = {
  sheets: [],
  currentSheet: null,      // manifest object
  currentTrackIdx: 0,
  currentSegmentIdx: 0,
  mode: localStorage.getItem("mode") || "tap", // "tap" | "continuous"
  speed: parseFloat(localStorage.getItem("speed")) || 1.0,
  isPlaying: false,
  segmentTimer: null,      // setTimeout between segments; cleared on pause
};

function clearSegmentTimer() {
  if (state.segmentTimer) {
    clearTimeout(state.segmentTimer);
    state.segmentTimer = null;
  }
}

const $ = (id) => document.getElementById(id);
const audio = $("audio");

// ----- Init -----
init();

async function init() {
  restoreUIState();
  await loadSheetIndex();
  bindEvents();
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
      li.innerHTML = `<span>${s.sheet}</span><span class="count">${s.total} 詞</span>`;
      li.addEventListener("click", () => openSheet(s.slug));
      list.appendChild(li);
    }
    if (state.sheets.length === 0) {
      list.innerHTML = "<li class='loading'>沒有可用的主題</li>";
    }
  } catch (e) {
    list.innerHTML = `<li class='loading'>載入失敗：${e.message}</li>`;
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

  // Position slider: preview on drag, seek on release
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

  // Long-press replay button = restart sheet from idx 0
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

  // Apply persisted speed on load
  applySpeed();
  updateSpeedIndicator();

  audio.addEventListener("ended", onSegmentEnded);
  audio.addEventListener("play", () => setPlayingUI(true));
  audio.addEventListener("pause", () => setPlayingUI(false));
  audio.addEventListener("error", () => {
    console.warn("audio error", audio.error);
  });
}

// ----- Sheet loading -----

async function openSheet(slug) {
  const res = await fetch(`data/${slug}.json`, { cache: "no-cache" });
  const manifest = await res.json();
  state.currentSheet = manifest;
  // Restore last position for this sheet (auto-resume)
  const savedIdx = parseInt(localStorage.getItem(`pos:${slug}`), 10);
  state.currentTrackIdx = Number.isFinite(savedIdx) && savedIdx >= 0 && savedIdx < manifest.total
    ? savedIdx : 0;
  state.currentSegmentIdx = 0;
  localStorage.setItem("lastSheet", slug);
  showPlayer();
  setupSlider();
  renderTrack();
  playCurrent();
  setupMediaSession();
  // Hint SW to pre-cache the manifest + all segments for this sheet
  if (navigator.serviceWorker?.controller) {
    const urls = manifest.tracks.flatMap((t) => t.segments);
    navigator.serviceWorker.controller.postMessage({ type: "precache", urls });
  }
}

function savePosition() {
  if (!state.currentSheet) return;
  localStorage.setItem(`pos:${state.currentSheet.slug}`, state.currentTrackIdx);
}

function showPlayer() {
  $("home").classList.remove("active");
  $("player").classList.add("active");
  updateModeIndicator();
}

function goHome() {
  audio.pause();
  $("player").classList.remove("active");
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
  // preservesPitch avoids chipmunk effect at >1x
  if ("preservesPitch" in audio) audio.preservesPitch = true;
  // Safari legacy
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
  const t = currentTrack();
  const dots = $("segment-dots");
  dots.innerHTML = "";
  for (let i = 0; i < t.segments.length; i++) {
    const d = document.createElement("span");
    d.className = "dot" +
      (i === state.currentSegmentIdx ? " active" :
       i < state.currentSegmentIdx ? " done" : "");
    dots.appendChild(d);
  }
}

// ----- Playback -----

function playCurrent() {
  const t = currentTrack();
  if (!t) return;
  const url = t.segments[state.currentSegmentIdx];
  audio.src = url;
  applySpeed();
  audio.play().catch((e) => console.warn("play error", e));
  renderDots();
}

function onSegmentEnded() {
  const t = currentTrack();
  if (state.currentSegmentIdx < t.segments.length - 1) {
    // Next segment in same track
    state.currentSegmentIdx++;
    renderDots();
    clearSegmentTimer();
    state.segmentTimer = setTimeout(() => {
      state.segmentTimer = null;
      playCurrent();
    }, 350);
    return;
  }
  // Track finished
  state.currentSegmentIdx = 0;
  if (state.mode === "continuous") {
    clearSegmentTimer();
    state.segmentTimer = setTimeout(() => {
      state.segmentTimer = null;
      nextTrack(false);
    }, 600);
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
      // Loop back to start
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
    // Track fully ended: start over from segment 1
    if (state.currentSegmentIdx === 0 && (audio.ended || !audio.src)) {
      playCurrent();
    } else if (audio.ended) {
      // Current segment finished but still mid-track — resume next segment via onSegmentEnded
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

// ----- MediaSession (AirPods, Lock Screen) -----

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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) =>
      console.warn("sw register failed", e)
    );
  }
}

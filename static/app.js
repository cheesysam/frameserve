(() => {
  const imgA = document.getElementById("imgA");
  const imgB = document.getElementById("imgB");
  const hud = document.getElementById("hud");
  const statusEl = document.getElementById("status");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const countdownEl = document.getElementById("countdown");
  const countdownBar = document.getElementById("countdownBar");
  const countdownNum = document.getElementById("countdownNum");

  // Circumference of the countdown ring (r=19 in the SVG viewBox).
  const CD_CIRCUMFERENCE = 2 * Math.PI * 19;

  // Query params (client-side only):
  //  - seconds=10
  //  - shuffle=1
  //  - fit=contain|cover
  //  - hud=1
  //  - order=mtime_desc|mtime_asc|name_asc|name_desc
  //  - refresh=60 (seconds to re-fetch list)
  //  - awake=1 (request Screen Wake Lock; default on)
  //  - transition=fade|none|slide (default: fade)
  const params = new URLSearchParams(location.search);

  const seconds = clampInt(params.get("seconds"), 10, 1, 3600);
  const shuffle = truthy(params.get("shuffle"), true);
  const fit = (params.get("fit") || "contain").toLowerCase();
  const showHud = truthy(params.get("hud"), false);
  const order = (params.get("order") || "mtime_desc");
  const refreshSeconds = clampInt(params.get("refresh"), 60, 5, 3600);
  const keepAwake = truthy(params.get("awake"), true);
  const transition = validTransition(params.get("transition"));

  imgA.style.objectFit = (fit === "cover") ? "cover" : "contain";
  imgB.style.objectFit = (fit === "cover") ? "cover" : "contain";

  const stage = document.getElementById("stage");
  stage.classList.add("trans-" + transition);

  if (!showHud) hud.classList.add("hidden");
  else hud.classList.remove("hidden");

  let photos = [];
  let idx = 0;
  let paused = false;
  let active = "A";
  let timer = null;
  let lastListHash = "";

  // Countdown state (drives the on-screen timer ring).
  let remainingMs = seconds * 1000;
  let lastTick = 0;

  // Navigation history: the trail of photo indices we've actually shown.
  // Back walks this trail; Forward replays it; only past the tip do we pick
  // a new (random, when shuffling) photo.
  const MAX_HISTORY = 500;
  let history = [];
  let histPos = -1;

  // ---- Wake Lock (best-effort; OS/browser may still dim/sleep) ----
  let wakeLock = null;

  async function requestWakeLock() {
    if (!keepAwake) return;
    if (!("wakeLock" in navigator)) {
      console.debug("Wake Lock API not supported");
      return;
    }

    // If we already have one, don't spam requests
    if (wakeLock) return;

    try {
      wakeLock = await navigator.wakeLock.request("screen");
      console.debug("Wake lock acquired");

      wakeLock.addEventListener("release", () => {
        console.debug("Wake lock released");
        wakeLock = null;
      });
    } catch (err) {
      console.warn("Wake lock request failed:", err);
      wakeLock = null;
    }
  }

  // Browsers commonly release wake locks when the tab loses visibility.
  document.addEventListener("visibilitychange", () => {
    if (!keepAwake) return;

    if (document.visibilityState === "visible") {
      requestWakeLock();
    } else {
      // We don't need to do anything here; release events will fire if it releases.
      // But we clear our reference to avoid thinking it's still held.
      wakeLock = null;
    }
  });
  // ---------------------------------------------------------------

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function clampInt(v, def, min, max) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function truthy(v, def) {
    if (v === null || v === undefined) return def;
    const s = String(v).toLowerCase().trim();
    return (s === "1" || s === "true" || s === "yes" || s === "on");
  }

  function validTransition(v) {
    const allowed = ["fade", "none", "slide"];
    const s = (v || "").toLowerCase().trim();
    return allowed.includes(s) ? s : "fade";
  }

  function pickStartIndex() {
    if (!photos.length) return 0;
    return shuffle ? Math.floor(Math.random() * photos.length) : 0;
  }

  function nextIndex() {
    if (!photos.length) return 0;
    if (shuffle) return Math.floor(Math.random() * photos.length);
    return (idx + 1) % photos.length;
  }

  function currentImg() {
    return active === "A" ? imgA : imgB;
  }
  function nextImg() {
    return active === "A" ? imgB : imgA;
  }

  function swapLayers() {
    const cur = currentImg();
    const nxt = nextImg();
    if (transition === "slide") {
      cur.classList.add("exiting");
      cur.classList.remove("visible");
      nxt.classList.add("visible");
      // Remove exiting class after the CSS transition finishes
      setTimeout(() => cur.classList.remove("exiting"), 950);
    } else {
      cur.classList.remove("visible");
      nxt.classList.add("visible");
    }
    active = (active === "A") ? "B" : "A";
  }

  function preload(url) {
    return new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve(true);
      i.onerror = () => resolve(false);
      i.src = url;
    });
  }

  async function showAt(i, immediate = false) {
    if (!photos.length) return;
    if (i < 0 || i >= photos.length) i = 0; // guard stale history indices

    idx = i;
    const url = photos[idx].url || photos[idx];

    // Restart the countdown for the photo we're about to display.
    resetCountdown();

    setStatus(`${idx + 1}/${photos.length} • ${paused ? "paused" : seconds + "s"} • ${shuffle ? "shuffle" : "ordered"} • fit=${fit}`);

    const nxt = nextImg();
    // preload first to minimize blank flashes
    await preload(url);

    nxt.src = url;

    if (immediate) {
      // Make next visible instantly without animation
      imgA.classList.remove("visible");
      imgB.classList.remove("visible");
      nxt.classList.add("visible");
      active = (nxt === imgA) ? "A" : "B";
      return;
    }

    // Crossfade
    requestAnimationFrame(() => {
      swapLayers();
    });
  }

  function updateCountdown() {
    const total = seconds * 1000;
    const frac = Math.max(0, Math.min(1, remainingMs / total));
    if (countdownBar) {
      countdownBar.style.strokeDasharray = CD_CIRCUMFERENCE.toFixed(2);
      // Deplete the ring as time runs out (frac=1 → full, frac=0 → empty).
      countdownBar.style.strokeDashoffset = (CD_CIRCUMFERENCE * (1 - frac)).toFixed(2);
    }
    if (countdownNum) {
      countdownNum.textContent = String(Math.max(0, Math.ceil(remainingMs / 1000)));
    }
    if (countdownEl) countdownEl.classList.toggle("fs-paused", paused);
  }

  function resetCountdown() {
    remainingMs = seconds * 1000;
    lastTick = performance.now();
    updateCountdown();
  }

  function tick() {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (!paused) {
      remainingMs -= dt;
      if (remainingMs <= 0) {
        goNext(); // advances (replaying forward history, else new), resets countdown
        return;
      }
    }
    updateCountdown();
  }

  function startTimer() {
    stopTimer();
    resetCountdown();
    // Tick frequently so the ring animates smoothly and stays accurate.
    timer = setInterval(tick, 100);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function fetchPhotos() {
    const url = new URL("/api/photos", location.origin);
    url.searchParams.set("order", order);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`api returned ${res.status}`);
    const data = await res.json();
    const list = data.photos || [];

    // Create a simple hash signature to detect changes
    const signature = JSON.stringify(list.map(p => [p.name, p.mtime]));

    photos = list;
    lastListHash = signature;
  }

  async function refreshListPeriodically() {
    setInterval(async () => {
      try {
        const url = new URL("/api/photos", location.origin);
        url.searchParams.set("order", order);
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const list = data.photos || [];
        const signature = JSON.stringify(list.map(p => [p.name, p.mtime]));

        if (signature !== lastListHash) {
          photos = list;
          lastListHash = signature;

          // If current index is out of range after deletions, clamp.
          if (idx >= photos.length) idx = 0;
          // Continue slideshow seamlessly; show current immediately.
          await showAt(idx, true);
        }
      } catch {
        // ignore
      }
    }, refreshSeconds * 1000);
  }

  function pushHistory(i) {
    // Append a freshly chosen photo and move the pointer to the tip.
    history.push(i);
    if (history.length > MAX_HISTORY) {
      const removed = history.length - MAX_HISTORY;
      history.splice(0, removed);
      histPos -= removed;
    }
    histPos = history.length - 1;
  }

  async function goNext() {
    if (!photos.length) return;
    // If we've stepped back, Forward replays the recorded trail first.
    if (histPos < history.length - 1) {
      histPos++;
      await showAt(history[histPos]);
      return;
    }
    // At the tip: pick a new photo (random when shuffling) and record it.
    const i = nextIndex();
    pushHistory(i);
    await showAt(i);
  }

  async function goPrev() {
    if (!photos.length) return;
    // Back walks the recorded trail; do nothing once we're at its start.
    if (histPos > 0) {
      histPos--;
      await showAt(history[histPos]);
    }
  }

  function updatePauseBtn() {
    if (!pauseBtn) return;
    // ▶ when paused (tap to resume), ❙❙ when playing (tap to pause).
    pauseBtn.textContent = paused ? "▶" : "❙❙";
    pauseBtn.setAttribute("aria-label", paused ? "Resume slideshow" : "Pause slideshow");
  }

  function togglePause() {
    paused = !paused;
    updatePauseBtn();
    updateCountdown();
    setStatus(`${idx + 1}/${photos.length} • ${paused ? "paused" : seconds + "s"} • ${shuffle ? "shuffle" : "ordered"} • fit=${fit}`);
  }

  function bindControls() {
    if (nextBtn) nextBtn.addEventListener("click", goNext);
    if (prevBtn) prevBtn.addEventListener("click", goPrev);
    if (pauseBtn) pauseBtn.addEventListener("click", togglePause);
    updatePauseBtn();
    if (countdownEl) {
      countdownEl.addEventListener("click", togglePause);
      countdownEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.code === "Space") {
          e.preventDefault();
          togglePause();
        }
      });
    }
  }

  function bindKeys() {
    window.addEventListener("keydown", async (e) => {
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePause();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        await goNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        await goPrev();
        return;
      }
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.();
        } else {
          document.exitFullscreen?.();
        }
        return;
      }
      if (e.key.toLowerCase() === "h") {
        e.preventDefault();
        hud.classList.toggle("hidden");
        return;
      }
    });
  }

  async function boot() {
    bindKeys();
    bindControls();

    // Best-effort attempt to keep screen awake while visible.
    // Note: Some platforms require user interaction or may ignore due to power settings.
    requestWakeLock();

    try {
      setStatus("Loading photos…");
      await fetchPhotos();

      if (!photos.length) {
        setStatus("No photos found in /photos (mount your directory).");
        // Keep HUD visible so user sees message
        hud.classList.remove("hidden");
        return;
      }

      idx = pickStartIndex();
      history = [idx];
      histPos = 0;
      await showAt(idx, true);

      startTimer();
      refreshListPeriodically();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      hud.classList.remove("hidden");
    }
  }

  boot();
})();

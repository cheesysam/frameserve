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

  // Top-right controls + panels
  const favBtn = document.getElementById("favBtn");
  const menuBtn = document.getElementById("menuBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const menuPanel = document.getElementById("menuPanel");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsCloseBtn = document.getElementById("settingsCloseBtn");
  const viewAllBtn = document.getElementById("viewAllBtn");
  const viewFavsBtn = document.getElementById("viewFavsBtn");
  const favCountEl = document.getElementById("favCount");
  const secondsRange = document.getElementById("secondsRange");
  const secondsValue = document.getElementById("secondsValue");
  const diffFolderToggle = document.getElementById("diffFolderToggle");

  // Favourites gallery
  const galleryOverlay = document.getElementById("galleryOverlay");
  const galleryGrid = document.getElementById("galleryGrid");
  const galleryCloseBtn = document.getElementById("galleryCloseBtn");
  const galleryCount = document.getElementById("galleryCount");
  const galleryEmpty = document.getElementById("galleryEmpty");

  // Inline SVG icons for the controls whose glyph changes at runtime.
  const ICONS = {
    pause: '<svg class="fs-icon fs-icon--fill" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>',
    play: '<svg class="fs-icon fs-icon--fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
    heart: '<svg class="fs-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5C8 17.5 4 14.2 4 9.8 4 7.1 6 5.2 8.4 5.2c1.6 0 3 .9 3.6 2.2.6-1.3 2-2.2 3.6-2.2C18 5.2 20 7.1 20 9.8c0 4.4-4 7.7-8 10.7z"/></svg>',
    heartFilled: '<svg class="fs-icon fs-icon--fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5C8 17.5 4 14.2 4 9.8 4 7.1 6 5.2 8.4 5.2c1.6 0 3 .9 3.6 2.2.6-1.3 2-2.2 3.6-2.2C18 5.2 20 7.1 20 9.8c0 4.4-4 7.7-8 10.7z"/></svg>',
  };

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

  // ---- Persisted settings (localStorage) ----
  // These override URL params and survive reloads. The ?seconds= param still
  // acts as the initial default the first time a device is used.
  const SETTINGS_KEY = "frameserve.settings.v1";
  const SECONDS_MIN = 5;
  const SECONDS_MAX = 600;

  const settings = loadSettings();

  function loadSettings() {
    const s = {
      seconds: clampInt(params.get("seconds"), 10, SECONDS_MIN, SECONDS_MAX),
      favourDifferentFolder: false,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed.seconds)) {
          s.seconds = Math.max(SECONDS_MIN, Math.min(SECONDS_MAX, Math.round(parsed.seconds)));
        }
        if (typeof parsed.favourDifferentFolder === "boolean") {
          s.favourDifferentFolder = parsed.favourDifferentFolder;
        }
      }
    } catch { /* ignore corrupt storage */ }
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }

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

  // allPhotos is the full server list; photos is the current view (all or
  // favourites). idx always indexes into photos.
  let allPhotos = [];
  let photos = [];
  let favourites = new Set(); // favourited photo names (relative paths)
  let viewMode = "all";       // "all" | "favourites"
  let idx = 0;
  let paused = false;
  let active = "A";
  let timer = null;
  let lastListHash = "";

  // Countdown state (drives the on-screen timer ring).
  let remainingMs = settings.seconds * 1000;
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

  function folderOf(name) {
    const slash = String(name || "").lastIndexOf("/");
    return slash === -1 ? "" : name.slice(0, slash);
  }

  function randomOther() {
    // Random index that isn't the current one (when more than one photo).
    if (photos.length <= 1) return 0;
    let r = Math.floor(Math.random() * photos.length);
    if (r === idx) r = (r + 1) % photos.length;
    return r;
  }

  function nextIndex() {
    if (!photos.length) return 0;
    if (!shuffle) return (idx + 1) % photos.length;

    // Optionally bias the random pick toward a photo in a *different* folder
    // than the current one, so the slideshow roams across albums instead of
    // dwelling in one. Falls back to a plain random pick if there are no
    // photos in other folders.
    if (settings.favourDifferentFolder && photos.length > 1) {
      const cur = folderOf(photos[idx] && photos[idx].name);
      const others = [];
      for (let k = 0; k < photos.length; k++) {
        if (k !== idx && folderOf(photos[k].name) !== cur) others.push(k);
      }
      if (others.length) return others[Math.floor(Math.random() * others.length)];
    }

    return randomOther();
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

    updateStatus();
    updateFavBtn();

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

  function updateStatus() {
    const view = viewMode === "favourites" ? "favourites" : (shuffle ? "shuffle" : "ordered");
    setStatus(`${idx + 1}/${photos.length} • ${paused ? "paused" : settings.seconds + "s"} • ${view} • fit=${fit}`);
  }

  function updateCountdown() {
    const total = settings.seconds * 1000;
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
    remainingMs = settings.seconds * 1000;
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

    allPhotos = list;
    lastListHash = signature;
    applyView();
  }

  // Rebuild the current view (photos) from allPhotos based on viewMode.
  function applyView() {
    if (viewMode === "favourites") {
      photos = allPhotos.filter(p => favourites.has(p.name));
    } else {
      photos = allPhotos.slice();
    }
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
          allPhotos = list;
          lastListHash = signature;
          applyView();

          // If current index is out of range after deletions, clamp.
          if (idx >= photos.length) idx = 0;
          // Continue slideshow seamlessly; show current immediately.
          if (photos.length) await showAt(idx, true);
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
    // Play glyph when paused (tap to resume), pause bars when playing.
    pauseBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    pauseBtn.setAttribute("aria-label", paused ? "Resume slideshow" : "Pause slideshow");
  }

  function togglePause() {
    paused = !paused;
    updatePauseBtn();
    updateCountdown();
    updateStatus();
  }

  // ---- Favourites ----
  async function fetchFavourites() {
    try {
      const res = await fetch("/api/favourites", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      favourites = new Set(data.favourites || []);
      updateFavCount();
      updateFavBtn();
    } catch { /* ignore */ }
  }

  function currentName() {
    return photos.length ? photos[idx].name : null;
  }

  function updateFavBtn() {
    if (!favBtn) return;
    const name = currentName();
    const isFav = !!name && favourites.has(name);
    favBtn.classList.toggle("is-fav", isFav);
    // Filled heart when favourited, outline when not.
    favBtn.innerHTML = isFav ? ICONS.heartFilled : ICONS.heart;
    favBtn.title = isFav ? "Remove from favourites" : "Favourite this photo";
  }

  function updateFavCount() {
    if (favCountEl) favCountEl.textContent = String(favourites.size);
  }

  async function toggleFavourite() {
    const name = currentName();
    if (!name) return;
    const isFav = favourites.has(name);

    // Optimistic update for snappy feedback, reconciled with the server reply.
    if (isFav) favourites.delete(name); else favourites.add(name);
    updateFavBtn();
    updateFavCount();

    try {
      const res = await fetch("/api/favourites", {
        method: isFav ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const data = await res.json();
        favourites = new Set(data.favourites || []);
      } else {
        // Revert on failure.
        if (isFav) favourites.add(name); else favourites.delete(name);
      }
    } catch {
      if (isFav) favourites.add(name); else favourites.delete(name);
    }

    updateFavBtn();
    updateFavCount();

    // If we just un-favourited while viewing favourites, drop it from the view.
    if (viewMode === "favourites" && !favourites.has(name)) {
      const wasIdx = idx;
      applyView();
      if (!photos.length) {
        setStatus("No favourites yet — tap ♥ to add some.");
      } else {
        if (wasIdx >= photos.length) idx = 0;
        history = [idx];
        histPos = 0;
        await showAt(idx, true);
      }
    }
  }

  // ---- View mode (all / favourites) ----
  async function setViewMode(mode) {
    closeMenu();
    if (mode === viewMode) return;

    if (mode === "favourites" && favourites.size === 0) {
      setStatus("No favourites yet — tap ♥ to add some.");
      return;
    }

    viewMode = mode;
    applyView();
    updateMenuActive();

    if (!photos.length) {
      setStatus(mode === "favourites" ? "No favourites yet — tap ♥ to add some." : "No photos found.");
      return;
    }

    idx = pickStartIndex();
    history = [idx];
    histPos = 0;
    await showAt(idx, true);
  }

  function updateMenuActive() {
    if (viewAllBtn) viewAllBtn.classList.toggle("is-active", viewMode === "all");
    if (viewFavsBtn) viewFavsBtn.classList.toggle("is-active", viewMode === "favourites");
  }

  // Favourited photos in slideshow order (so the gallery and the favourites
  // view stay consistent).
  function favouritePhotos() {
    return allPhotos.filter(p => favourites.has(p.name));
  }

  // ---- Favourites gallery ----
  function openGallery() {
    closeMenu();
    buildGallery();
    if (galleryOverlay) galleryOverlay.classList.remove("hidden");
  }

  function closeGallery() {
    if (galleryOverlay) galleryOverlay.classList.add("hidden");
  }

  function buildGallery() {
    if (!galleryGrid) return;
    const favs = favouritePhotos();

    if (galleryCount) galleryCount.textContent = String(favs.length);
    if (galleryEmpty) galleryEmpty.classList.toggle("hidden", favs.length > 0);

    galleryGrid.textContent = ""; // clear
    for (const p of favs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fs-thumb";
      btn.setAttribute("aria-label", `Show ${p.name}`);

      const img = document.createElement("img");
      img.src = p.url;
      img.alt = p.name;
      img.loading = "lazy";
      img.decoding = "async";

      const label = document.createElement("span");
      label.className = "fs-thumb-name";
      label.textContent = p.name;

      btn.appendChild(img);
      btn.appendChild(label);
      btn.addEventListener("click", () => showFavourite(p.name));
      galleryGrid.appendChild(btn);
    }
  }

  // Jump the slideshow to a specific favourite and continue cycling favourites.
  async function showFavourite(name) {
    closeGallery();
    viewMode = "favourites";
    applyView();
    updateMenuActive();

    if (!photos.length) return;
    const i = photos.findIndex(p => p.name === name);
    idx = i >= 0 ? i : 0;
    history = [idx];
    histPos = 0;
    await showAt(idx, true);
  }

  // ---- Panels (menu + settings) ----
  function closeMenu() { menuPanel && menuPanel.classList.add("hidden"); }
  function closeSettings() { settingsPanel && settingsPanel.classList.add("hidden"); }

  function toggleMenu() {
    if (!menuPanel) return;
    closeSettings();
    updateFavCount();
    menuPanel.classList.toggle("hidden");
  }

  function toggleSettings() {
    if (!settingsPanel) return;
    closeMenu();
    settingsPanel.classList.toggle("hidden");
  }

  // ---- Settings panel wiring ----
  function initSettingsControls() {
    if (secondsRange) {
      secondsRange.min = String(SECONDS_MIN);
      secondsRange.max = String(SECONDS_MAX);
      secondsRange.value = String(settings.seconds);
    }
    if (secondsValue) secondsValue.textContent = String(settings.seconds);
    if (diffFolderToggle) diffFolderToggle.checked = settings.favourDifferentFolder;

    if (secondsRange) {
      secondsRange.addEventListener("input", () => {
        const v = clampInt(secondsRange.value, settings.seconds, SECONDS_MIN, SECONDS_MAX);
        settings.seconds = v;
        if (secondsValue) secondsValue.textContent = String(v);
        saveSettings();
        // Apply immediately to the running countdown.
        resetCountdown();
        updateStatus();
      });
    }

    if (diffFolderToggle) {
      diffFolderToggle.addEventListener("change", () => {
        settings.favourDifferentFolder = diffFolderToggle.checked;
        saveSettings();
      });
    }
  }

  function bindControls() {
    if (nextBtn) nextBtn.addEventListener("click", goNext);
    if (prevBtn) prevBtn.addEventListener("click", goPrev);
    if (pauseBtn) pauseBtn.addEventListener("click", togglePause);

    if (favBtn) favBtn.addEventListener("click", toggleFavourite);
    if (menuBtn) menuBtn.addEventListener("click", toggleMenu);
    if (settingsBtn) settingsBtn.addEventListener("click", toggleSettings);
    if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettings);
    if (viewAllBtn) viewAllBtn.addEventListener("click", () => setViewMode("all"));
    if (viewFavsBtn) viewFavsBtn.addEventListener("click", openGallery);
    if (galleryCloseBtn) galleryCloseBtn.addEventListener("click", closeGallery);

    // Tapping the empty stage dismisses any open panel.
    if (stage) stage.addEventListener("click", (e) => {
      const inControls = e.target.closest(
        "#fs-topbar, #fs-overlay, #menuPanel, #settingsPanel"
      );
      if (!inControls) { closeMenu(); closeSettings(); }
    });

    updatePauseBtn();
    if (countdownEl) {
      countdownEl.addEventListener("click", togglePause);
    }
  }

  async function boot() {
    bindControls();
    initSettingsControls();
    updateMenuActive();

    // Best-effort attempt to keep screen awake while visible.
    // Note: Some platforms require user interaction or may ignore due to power settings.
    requestWakeLock();

    try {
      setStatus("Loading photos…");
      await fetchFavourites();
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

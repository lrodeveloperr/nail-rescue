/*
 * ytplayables-bridge.js: safe wrapper over the YouTube Playables SDK (ytgame).
 * Load it right AFTER <script src="https://www.youtube.com/game_api/v1"></script>
 * and before the game code. Exposes window.YTP.
 *
 * It enforces the certification rules people fail most often:
 *   - firstFrameReady before gameReady, each sent once        (INT-2)
 *   - no saveData before loadData succeeded; 3 MiB cap; UTF-16 well-formed (INT-4, STA-4)
 *   - audio on only when YouTube audio is enabled AND the game isn't paused (INT-5)
 *   - pause/resume only from the SDK, never Page Visibility  (INT-6)
 *   - interstitials pause the game and always resume it        (MON-2)
 *   - rewarded ads only reward on `true`                       (MON-2.1)
 *   - no web storage, cookies or network anywhere             (INT-4b, PRV-3)
 */
(function (global) {
  'use strict';

  var sdk = typeof global.ytgame !== 'undefined' ? global.ytgame : null;
  var inPlayables = !!(sdk && sdk.IN_PLAYABLES_ENV);

  var HARD_SAVE_LIMIT = 3 * 1024 * 1024;   // bytes in UTF-16 => chars * 2
  var SOFT_SAVE_LIMIT = 500 * 1024;
  var SAVE_DEBOUNCE_MS = 400;

  var state = {
    firstFrameSent: false,
    gameReadySent: false,
    loaded: false,          // loadData resolved successfully
    loadFailed: false,
    pendingSave: null,
    saveTimer: null,
    memoryStore: '',        // fallback outside Playables
    ytAudio: true,
    paused: false,
    adActive: false,
    audioSink: null,
    pauseCbs: [],
    resumeCbs: [],
    pauseSaveProvider: null,
    best: null
  };

  function warn(msg, err) {
    try { console.warn('[YTP] ' + msg, err || ''); } catch (e) {}
    if (sdk && sdk.health && sdk.health.logWarning) { try { sdk.health.logWarning(msg); } catch (e) {} }
  }
  function logError(err) {
    if (sdk && sdk.health && sdk.health.logError) { try { sdk.health.logError(err); } catch (e) {} }
  }

  // ---------- lifecycle ----------
  function firstFrameReady() {
    if (state.firstFrameSent) return;
    state.firstFrameSent = true;
    if (sdk) { try { sdk.game.firstFrameReady(); } catch (e) { logError(e); } }
  }
  function gameReady() {
    if (state.gameReadySent) return;
    if (!state.firstFrameSent) firstFrameReady();
    state.gameReadySent = true;
    if (sdk) { try { sdk.game.gameReady(); } catch (e) { logError(e); } }
    applyAudio();
  }

  // ---------- audio ----------
  function audioAllowed() { return state.ytAudio && !state.paused && !state.adActive; }
  function applyAudio() {
    if (!state.audioSink) return;
    try { audioAllowed() ? state.audioSink.unmute() : state.audioSink.mute(); } catch (e) { logError(e); }
  }
  /** sink = { mute(): void, unmute(): void }. Must silence WebAudio + HTMLAudio + engine audio. */
  function bindAudio(sink) { state.audioSink = sink; applyAudio(); }

  if (sdk && sdk.system) {
    try { state.ytAudio = !!sdk.system.isAudioEnabled(); } catch (e) { state.ytAudio = true; }
    try {
      sdk.system.onAudioEnabledChange(function (enabled) { state.ytAudio = !!enabled; applyAudio(); });
    } catch (e) { logError(e); }
  }

  // ---------- pause / resume ----------
  function onPause(cb) { state.pauseCbs.push(cb); }
  function onResume(cb) { state.resumeCbs.push(cb); }
  /** fn() => object to save when YouTube pauses (or the user leaves). */
  function onBeforePauseSave(fn) { state.pauseSaveProvider = fn; }

  function firePause() {
    if (state.paused) return;
    state.paused = true;
    applyAudio();
    state.pauseCbs.forEach(function (cb) { try { cb(); } catch (e) { logError(e); } });
    if (state.pauseSaveProvider) {
      try { save(state.pauseSaveProvider(), { immediate: true }); } catch (e) { logError(e); }
    } else {
      flush();
    }
  }
  function fireResume() {
    if (!state.paused) return;
    state.paused = false;
    state.resumeCbs.forEach(function (cb) { try { cb(); } catch (e) { logError(e); } });
    applyAudio();
  }
  if (sdk && sdk.system) {
    try { sdk.system.onPause(firePause); sdk.system.onResume(fireResume); } catch (e) { logError(e); }
  }

  // ---------- cloud save ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Resolves to the parsed save object, or null (no save / unreadable / unavailable).
   * Handles every McPlay "Global Override":
   *  - slow (8 s): waits; keep the loading screen up until this resolves.
   *  - never settles: times out after opts.timeoutMs (default 10 s) -> null, saves DISABLED, YTP.saveUnavailable = true.
   *  - rejects: retries, then null with saves disabled (never overwrite a save we could not read).
   *  - foreign/unreadable save: JSON or opts.validate(obj) fails -> null, saves ENABLED (start fresh).
   */
  function load(opts) {
    opts = opts || {};
    var retries = opts.retries == null ? 2 : opts.retries;
    var timeoutMs = opts.timeoutMs == null ? 10000 : opts.timeoutMs;
    var validate = opts.validate || null;
    if (!inPlayables) {
      state.loaded = true;
      return Promise.resolve(parse(state.memoryStore));
    }
    var attempt = 0;
    function withTimeout(p) {
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject({ timeout: true }); }, timeoutMs);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
      });
    }
    function tryOnce() {
      return withTimeout(sdk.game.loadData()).then(function (str) {
        state.loaded = true;
        state.loadFailed = false;
        var obj = parse(str);
        if (obj && validate) { try { if (!validate(obj)) { warn('save failed validation; starting fresh'); obj = null; } } catch (e) { obj = null; } }
        return obj;
      }, function (err) {
        if (err && err.timeout) {
          state.loadFailed = true; global.YTP.saveUnavailable = true;
          warn('loadData timed out; continuing without cloud save');
          return null;
        }
        attempt++;
        if (attempt <= retries) return sleep(500 * attempt).then(tryOnce);
        state.loadFailed = true;   // saves stay disabled: never overwrite an unread save
        global.YTP.saveUnavailable = true;
        warn('loadData failed; cloud saves disabled for this session', err);
        return null;
      });
    }
    return tryOnce();
  }
  function parse(str) {
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) { warn('save data was not JSON', e); return null; }
  }

  /** Debounced save. Pass {immediate:true} to write now. Returns a promise. */
  function save(obj, opts) {
    opts = opts || {};
    var str;
    try { str = JSON.stringify(obj); } catch (e) { warn('save object not serializable', e); return Promise.resolve(false); }
    if (typeof str.isWellFormed === 'function' && !str.isWellFormed()) {
      warn('save string not well-formed UTF-16; dropped'); return Promise.resolve(false);
    }
    var bytes = str.length * 2;
    if (bytes >= HARD_SAVE_LIMIT) { warn('save exceeds 3 MiB; dropped (' + bytes + ' bytes)'); return Promise.resolve(false); }
    if (bytes >= SOFT_SAVE_LIMIT) warn('save is ' + Math.round(bytes / 1024) + ' KiB (should be < 500 KiB)');
    state.pendingSave = str;
    if (opts.immediate) return flush();
    if (state.saveTimer) clearTimeout(state.saveTimer);
    return new Promise(function (resolve) {
      state.saveTimer = setTimeout(function () { flush().then(resolve); }, SAVE_DEBOUNCE_MS);
    });
  }
  function flush() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    var str = state.pendingSave;
    if (str == null) return Promise.resolve(true);
    if (!state.loaded) {
      if (!state.loadFailed) warn('save requested before load() resolved; kept pending');
      return Promise.resolve(false);
    }
    state.pendingSave = null;
    if (!inPlayables) { state.memoryStore = str; return Promise.resolve(true); }
    return sdk.game.saveData(str).then(function () { return true; }, function (err) {
      warn('saveData failed', err); state.pendingSave = state.pendingSave || str; return false;
    });
  }

  // ---------- score ----------
  /** Send only improvements. Keep the same value in your save (INT-3). */
  function sendBestScore(value) {
    var v = Math.floor(Number(value));
    if (!isFinite(v) || v > Number.MAX_SAFE_INTEGER) return Promise.resolve(false);
    if (state.best != null && v <= state.best) return Promise.resolve(false);
    state.best = v;
    if (!inPlayables) return Promise.resolve(true);
    return sdk.engagement.sendScore({ value: v }).then(function () { return true; }, function (e) { warn('sendScore failed', e); return false; });
  }

  // ---------- language ----------
  function language(fallback) {
    fallback = fallback || 'en';
    if (!inPlayables || !sdk.system.getLanguage) return Promise.resolve(fallback);
    return sdk.system.getLanguage().then(function (t) { return t || fallback; }, function () { return fallback; });
  }

  // ---------- ads ----------
  // While an ad runs the game is paused and silent. When it ends the game resumes,
  // unless YouTube itself paused the game in the meantime (then onResume will resume it).
  function runAd(request, hooks) {
    hooks = hooks || {};
    var gameWasPaused = state.paused;
    if (hooks.pause && !gameWasPaused) { try { hooks.pause(); } catch (e) {} }
    state.adActive = true; applyAudio();
    return request().then(function (v) { return v; }, function () { return undefined; })
      .then(function (v) {
        state.adActive = false; applyAudio();
        if (hooks.resume && !gameWasPaused && !state.paused) { try { hooks.resume(); } catch (e) {} }
        return v;
      });
  }
  /** Call ONLY at natural transitions (level end, game over). Pauses + always resumes. */
  function interstitial(hooks) {
    if (!inPlayables || !sdk.ads) return Promise.resolve(false);
    return runAd(function () { return sdk.ads.requestInterstitialAd().then(function () { return true; }); }, hooks)
      .then(function (v) { return v === true; });
  }
  /** Call ONLY from an explicit, clearly-labelled player button. Resolves true only if earned. */
  function rewarded(rewardId, hooks) {
    if (!rewardId) throw new Error('rewardId required (fixed id per reward type, no user data)');
    if (!inPlayables || !sdk.ads) { if (hooks && hooks.onUnavailable) { try { hooks.onUnavailable(); } catch (e) {} } return Promise.resolve(false); }
    return runAd(function () { return sdk.ads.requestRewardedAd(String(rewardId)); }, hooks)
      .then(function (earned) {
        var ok = earned === true;
        // MediaCube QA: on false / rejection / no fill show feedback ("No ads available") and restore the button.
        if (!ok && hooks && hooks.onUnavailable) { try { hooks.onUnavailable(); } catch (e) {} }
        return ok;
      });
  }

  // ---------- YouTube content (the only allowed "links") ----------
  function openVideo(id) {
    if (!inPlayables) return Promise.resolve(false);
    return sdk.engagement.openYTContent({ id: id, contentType: sdk.engagement.ContentType.VIDEO }).then(function () { return true; }, function () { return false; });
  }
  function openPlayable(id) {
    if (!inPlayables) return Promise.resolve(false);
    return sdk.engagement.openYTContent({ id: id, contentType: sdk.engagement.ContentType.PLAYABLE }).then(function () { return true; }, function () { return false; });
  }

  global.YTP = {
    inPlayables: inPlayables,
    saveUnavailable: false,
    firstFrameReady: firstFrameReady,
    gameReady: gameReady,
    bindAudio: bindAudio,
    audioAllowed: audioAllowed,
    onPause: onPause,
    onResume: onResume,
    onBeforePauseSave: onBeforePauseSave,
    isPaused: function () { return state.paused; },
    load: load,
    save: save,
    flush: flush,
    sendBestScore: sendBestScore,
    language: language,
    interstitial: interstitial,
    rewarded: rewarded,
    openVideo: openVideo,
    openPlayable: openPlayable,
    logError: logError,
    logWarning: warn,
    // test hooks for local dev (simulate SDK events)
    _simulatePause: firePause,
    _simulateResume: fireResume,
    _simulateAudio: function (enabled) { state.ytAudio = !!enabled; applyAudio(); }
  };
})(typeof window !== 'undefined' ? window : this);

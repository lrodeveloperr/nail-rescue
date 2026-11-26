/*
 * shell.js: the reusable YouTube Playables (MediaCube McPlay) game shell.
 * Load order in index.html: SDK (first script) -> ytplayables-bridge.js -> shell.js -> your game.js.
 *
 * Already wired, so a game never touches the SDK directly:
 *   - lifecycle: firstFrameReady while the loading screen shows; gameReady only when interactive, loader hidden
 *     and NOT paused (a pre-roll that starts during loading holds the game back until YouTube resumes it)
 *   - pre-roll / host pause / ads: one pause gate stops the loop, timers, input, CSS animations and audio;
 *     a pause sent before this file ran (inside firstFrameReady) is picked up from the bridge
 *   - audio: WebAudio master + music/SFX buses; silent while YouTube is muted, paused or an ad plays; no master
 *     mute button (INT-5c), separate music/SFX sliders; starts without waiting for a click
 *   - cloud save: versioned envelope, migrations, legacy import, McPlay faults (reject, never, foreign, slow 8 s,
 *     all-error), autosave on pause, never saves before load, "saving unavailable" notice
 *   - interstitial at EVERY round transition: Shell.transition(next) (no cooldown, pauses + always resumes)
 *   - rewarded buttons: Shell.rewardButton(el, 'reward-id', grant) (opt-in, grants only on true,
 *     "No ads available" toast + button restored on false/reject/no fill)
 *   - score: Shell.reportBest(n) keeps the save and sendScore equal
 *   - scaling: DPR-aware canvas in logical units (short side = design units), live resize, 0x0 cold boot,
 *     safe areas, --u CSS unit for the DOM UI
 *
 * Game contract (Shell.register(game)), every field optional except update/render for a canvas game:
 *   saveVersion: 1, defaults(): {...}, migrate(data, fromVersion): data, validate(data): bool,
 *   importLegacy(rawSaveObject): data|null           // saves from builds made before this shell
 *   preload(progress): Promise                        // progress(0..1) drives the loading bar
 *   renderer: '2d' | 'webgl' | 'none'                 // '2d' (default): Shell gives a ctx in logical units
 *   design: 720                                       // logical units on the screen's short side
 *   strings: {en: {...}, es: {...}}                   // merged into the shell's i18n table
 *   start(), resize(stage), update(dt), render(ctx, stage), pointer({type, x, y, id}), onPause(), onResume()
 */
(function (global) {
  'use strict';
  var YTP = global.YTP;
  var doc = document, html = doc.documentElement;
  var $ = function (id) { return doc.getElementById(id); };

  // INT-2a: the loading screen is already in the DOM (scripts sit at the end of <body>), so report the first frame now.
  YTP.firstFrameReady();

  var game = null, ctx = null, canvas = $('stage'), app = $('app');
  var booted = false, readySent = false, raf = 0, last = 0, busy = false;
  var reasons = {};                  // pause gate: host | ad | (game-defined)
  var timers = [];                   // pause-aware timers (game time)
  var stage = null, screen = null, data = null, best = 0;
  var settings = {music: 70, sfx: 80};
  var saveVersion = 1;

  // ---------------------------------------------------------------- i18n
  var STRINGS = {en: {title: 'Nail Salon', music: 'Music', sfx: 'Sound effects', noAds: 'No ads available, try later',
    saveOff: 'Progress can’t be saved right now.', end: 'You’ve beaten every level. More levels are coming soon. Keep playing to beat your best!'}};
  var lang = 'en';
  function t(key) { return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key; }
  function applyStrings() { doc.querySelectorAll('[data-t]').forEach(function (el) { el.textContent = t(el.getAttribute('data-t')); }); }

  // ---------------------------------------------------------------- pause gate
  function paused() { for (var k in reasons) if (reasons[k]) return true; return false; }
  function setReason(name, on) {
    var was = paused();
    reasons[name] = !!on;
    var now = paused();
    if (was !== now) now ? halt() : run();
    applyAudio();
  }
  function halt() {
    cancelAnimationFrame(raf); raf = 0; stopMusic();
    html.classList.add('is-paused');
    app.inert = true;                                   // lock the game only; <body> stays usable for YouTube's ad UI
    if (game && game.onPause) safe(game.onPause);
  }
  function run() {
    html.classList.remove('is-paused');
    app.inert = false;
    if (!booted) return;
    if (game && game.onResume) safe(game.onResume);
    last = performance.now();
    if (!raf) raf = requestAnimationFrame(frame);
    startMusic();
    maybeGameReady();
  }
  YTP.onPause(function () { setReason('host', true); });
  YTP.onResume(function () { setReason('host', false); });
  if (YTP.isPaused()) setReason('host', true);          // pause that arrived inside firstFrameReady, before this file ran

  // ---------------------------------------------------------------- loop + pause-aware timers
  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    for (var i = timers.length - 1; i >= 0; i--) { var tm = timers[i]; tm.left -= dt; if (tm.left <= 0) { timers.splice(i, 1); safe(tm.fn); } }
    if (game && game.update) safe(function () { game.update(dt); });
    draw();
  }
  function draw() {
    if (!game || !stage) return;
    if (ctx) { var k = stage.dpr * stage.scale; ctx.setTransform(k, 0, 0, k, 0, 0); }
    if (game.render) safe(function () { game.render(ctx, stage); });
  }
  function after(seconds, fn) { var tm = {left: seconds, fn: fn}; timers.push(tm); return function () { var i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); }; }
  function safe(fn) { try { return fn(); } catch (e) { YTP.logError(e); if (global.console) console.error(e); } }

  // ---------------------------------------------------------------- stage (responsive, DPR-aware, 0x0-safe)
  var resizeTimer = 0, stageReady, stageReadyP = new Promise(function (r) { stageReady = r; });
  function measure() {
    var w = Math.floor(app.clientWidth || global.innerWidth || 0), h = Math.floor(app.clientHeight || global.innerHeight || 0);
    if (w <= 0 || h <= 0) return null;                  // zero-viewport cold boot: wait, never throw
    var design = (game && game.design) || 720;
    var dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    if (w * h * dpr * dpr > 6e6) dpr = Math.max(1, Math.sqrt(6e6 / (w * h)));
    var shortSide = Math.min(w, h), scale = shortSide / design;
    return {cssW: w, cssH: h, dpr: dpr, pxW: Math.round(w * dpr), pxH: Math.round(h * dpr), scale: scale,
      logicalW: w / scale, logicalH: h / scale, portrait: h >= w, design: design};
  }
  function applyStage() {
    var s = measure(); if (!s) return;
    var changed = !stage || s.cssW !== stage.cssW || s.cssH !== stage.cssH || s.dpr !== stage.dpr;
    stage = s;
    html.style.setProperty('--u', Math.max(0.3, Math.min(1.6, Math.min(s.cssW, s.cssH) / 720)).toFixed(3));
    if (changed) {
      if (!game || game.renderer !== 'none') { canvas.width = s.pxW; canvas.height = s.pxH; }
      if (game && game.resize) safe(function () { game.resize(s); });
      if (booted) draw();                                // repaint now, even while paused (a resize clears the canvas)
    }
    stageReady(s);
  }
  function scheduleStage() { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyStage, stage ? 60 : 0); }
  if (global.ResizeObserver) new ResizeObserver(scheduleStage).observe(app);
  global.addEventListener('resize', scheduleStage);
  var stagePoll = setInterval(function () { if (stage) clearInterval(stagePoll); else applyStage(); }, 100);

  // ---------------------------------------------------------------- input (pointer = touch + mouse + pen)
  function toLogical(e) { var r = canvas.getBoundingClientRect(); return {x: (e.clientX - r.left) / stage.scale, y: (e.clientY - r.top) / stage.scale}; }
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (type) {
    canvas.addEventListener(type, function (e) {
      if (!booted || paused() || !game || !game.pointer || !stage) return;
      var p = toLogical(e);
      safe(function () { game.pointer({type: type.slice(7), x: p.x, y: p.y, id: e.pointerId, button: e.button}); });
    });
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  doc.addEventListener('pointerdown', unlockAudio, true);

  // ---------------------------------------------------------------- audio
  var actx = null, master = null, musicBus = null, sfxBus = null, musicTimer = 0, musicStep = 0, musicAt = 0;
  function initAudio() {
    var AC = global.AudioContext || global.webkitAudioContext; if (!AC || actx) return;
    try { actx = new AC(); } catch (e) { return; }
    master = actx.createGain(); master.connect(actx.destination);
    musicBus = actx.createGain(); musicBus.connect(master);
    sfxBus = actx.createGain(); sfxBus.connect(master);
    applyVolumes(); applyAudio();
  }
  function audioOn() { return booted && YTP.audioAllowed() && !paused(); }
  function applyAudio() {
    if (!actx) return;
    var on = audioOn();
    master.gain.setValueAtTime(on ? 1 : 0, actx.currentTime);
    if (on) { if (actx.state !== 'running') actx.resume().catch(function () {}); }
    else if (actx.state === 'running') actx.suspend().catch(function () {});
  }
  function unlockAudio() { if (actx && audioOn() && actx.state !== 'running') actx.resume().catch(function () {}); }
  function applyVolumes() { if (!actx) return; musicBus.gain.value = settings.music / 100 * 0.35; sfxBus.gain.value = settings.sfx / 100 * 0.6; }
  YTP.bindAudio({mute: applyAudio, unmute: applyAudio});

  function tone(bus, freq, start, dur, type, vol, slideTo) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(vol || 0.3, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(bus); o.start(start); o.stop(start + dur + 0.02);
  }
  // Procedural background music (no licensing to clear). Replace with a licensed loop if you prefer:
  // decode an <audio>-free ArrayBuffer and play it through musicBus so mute/pause still apply.
  var CHORDS = [[261.6, 329.6, 392.0, 493.9], [220.0, 261.6, 329.6, 392.0], [174.6, 220.0, 261.6, 329.6], [196.0, 246.9, 293.7, 329.6]];
  function startMusic() {
    if (customMusic && customMusic.start) { if (actx && audioOn()) safe(function () { customMusic.start(actx, musicBus); }); return; }
    if (!actx || musicTimer || !audioOn()) return;
    musicAt = Math.max(musicAt, actx.currentTime + 0.05);
    (function schedule() {
      if (!audioOn()) { musicTimer = 0; return; }
      if (customMusic) {                                 // game-provided track: one call per step
        while (musicAt < actx.currentTime + 0.5) { safe(function () { customMusic.play(actx, musicBus, musicAt, musicStep, tone); }); musicAt += customMusic.step; musicStep++; }
        musicTimer = setTimeout(schedule, 120); return;
      }
      while (musicAt < actx.currentTime + 0.4) {
        var chord = CHORDS[Math.floor(musicStep / 8) % 4], n = musicStep % 8, beat = 0.36;
        if (n !== 3 && n !== 7) tone(musicBus, chord[[0, 2, 1, 3, 2, 1, 3, 0][n]] * 2, musicAt, beat * 1.6, 'sine', 0.14);
        if (n === 0) tone(musicBus, chord[0] / 2, musicAt, beat * 7.5, 'sine', 0.22);
        musicAt += beat; musicStep++;
      }
      musicTimer = setTimeout(schedule, 120);
    })();
  }
  function stopMusic() {
    if (customMusic && customMusic.stop) { safe(function () { customMusic.stop(); }); return; } clearTimeout(musicTimer); musicTimer = 0; if (actx) musicAt = actx.currentTime; }
  var SFX = {
    pop: function (t0) { tone(sfxBus, 880, t0, 0.12, 'sine', 0.5, 1760); },
    click: function (t0) { tone(sfxBus, 660, t0, 0.05, 'square', 0.12); },
    win: function (t0) { [523, 659, 784, 1046].forEach(function (f, i) { tone(sfxBus, f, t0 + i * 0.09, 0.2, 'triangle', 0.35); }); },
    lose: function (t0) { [392, 330, 262].forEach(function (f, i) { tone(sfxBus, f, t0 + i * 0.12, 0.25, 'sine', 0.3); }); },
    coin: function (t0) { tone(sfxBus, 1318, t0, 0.08, 'square', 0.15); tone(sfxBus, 1760, t0 + 0.07, 0.12, 'square', 0.15); }
  };
  var customMusic = null;
  function registerMusic(m) { customMusic = m; }
  function registerSfx(name, fn) { SFX[name] = function (t0) { fn(actx, sfxBus, t0, tone); }; }
  function sfx(name) { if (actx && audioOn() && SFX[name]) safe(function () { SFX[name](actx.currentTime + 0.005); }); }

  // ---------------------------------------------------------------- save (versioned envelope over the bridge)
  function envelope() { return {shell: 1, v: saveVersion, best: best, settings: settings, data: data}; }
  function isEnvelope(o) { return o && typeof o === 'object' && o.shell === 1 && typeof o.v === 'number' && o.data && typeof o.data === 'object'; }
  function freshData() { return game && game.defaults ? game.defaults() : {}; }
  function adopt(raw) {
    var d = null;
    if (isEnvelope(raw)) {
      d = raw.data;
      if (raw.v < saveVersion && game.migrate) d = safe(function () { return game.migrate(d, raw.v); }) || null;
      if (raw.settings) settings = {music: num(raw.settings.music, 70), sfx: num(raw.settings.sfx, 80)};
      best = Math.max(0, Math.floor(num(raw.best, 0)));
    } else if (raw && game.importLegacy) {
      d = safe(function () { return game.importLegacy(raw); }) || null;
    }
    if (d && game.validate && !safe(function () { return game.validate(d); })) d = null;  // foreign / corrupt: start fresh
    data = d ? Object.assign(freshData(), d) : freshData();
  }
  function num(v, fallback) { v = Number(v); return isFinite(v) ? v : fallback; }
  function commit(immediate) { if (data) return YTP.save(envelope(), {immediate: !!immediate}); return Promise.resolve(false); }
  YTP.onBeforePauseSave(function () { return envelope(); });
  function reportBest(n) {
    n = Math.floor(n); if (!(n > best)) return;
    best = n; commit(true); YTP.sendBestScore(best);
  }

  // ---------------------------------------------------------------- UI helpers
  function show(name) {
    screen = name;
    doc.querySelectorAll('#ui .screen').forEach(function (el) { el.hidden = el.id !== name; });
  }
  var toastTimer = null;
  function toast(msg, seconds) {
    var el = $('toast'); el.textContent = msg; el.hidden = false; el.classList.add('is-on');
    if (toastTimer) toastTimer();
    toastTimer = after(seconds || 2.4, function () { el.classList.remove('is-on'); });
  }
  function openSettings() {
    setCtl($('vol-music'), settings.music); setCtl($('vol-sfx'), settings.sfx);
    $('settings').hidden = false; $('close-settings').focus();
  }
  function setCtl(el, v) { if (el.type === 'checkbox') el.checked = v > 0; else el.value = v; }
  function readCtl(el, on) { return el.type === 'checkbox' ? (el.checked ? on : 0) : +el.value; }
  function closeSettings() { if (!$('settings').hidden) { $('settings').hidden = true; commit(); } }
  function wireSettings() {
    var open = $('open-settings'); if (open) open.addEventListener('click', function () { sfx('click'); openSettings(); });
    $('close-settings').addEventListener('click', closeSettings);
    // Esc closes dialogs; the default action is left alone (DES-2e: Safari needs Esc to leave fullscreen)
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSettings(); unlockAudio(); });
    $('vol-music').addEventListener('change', function (e) { settings.music = readCtl(e.target, 70); applyVolumes(); });
    $('vol-sfx').addEventListener('change', function (e) { settings.sfx = readCtl(e.target, 80); applyVolumes(); sfx('click'); });
  }

  // ---------------------------------------------------------------- ads
  var adHooks = {pause: function () { setReason('ad', true); }, resume: function () { setReason('ad', false); }};
  /** Interstitial at a natural break, then next(). Call it at EVERY round transition (MediaCube: no cooldown). */
  function transition(next) {
    if (busy) return Promise.resolve(false);
    busy = true;
    return YTP.interstitial(adHooks).then(function () {
      setReason('ad', false); busy = false; if (next) safe(next); return true;
    });
  }
  /**
   * Wire an opt-in rewarded button. grant() runs only when the video was watched to the end.
   * opts.once (default true): the button stays disabled after a reward until you call ctl.enable() (next round).
   */
  function rewardButton(el, rewardId, grant, opts) {
    opts = opts || {};
    var once = opts.once !== false;
    var ctl = {el: el, rewardId: rewardId,
      enable: function () { el.disabled = false; el.hidden = false; }, disable: function () { el.disabled = true; },
      hide: function () { el.hidden = true; }, show: function () { el.hidden = false; }};
    el.addEventListener('click', function () {
      if (el.disabled || busy) return;
      busy = true; el.disabled = true; sfx('click');
      YTP.rewarded(rewardId, {pause: adHooks.pause, resume: adHooks.resume, onUnavailable: function () { toast(t('noAds')); }})
        .then(function (earned) {
          setReason('ad', false); busy = false;
          if (earned) { safe(grant); commit(true); if (!once) el.disabled = false; }
          else el.disabled = false;                     // nothing granted, button restored (MediaCube)
        });
    });
    rewardButtons = rewardButtons.filter(function (c) { return c.el.isConnected; });   // trays rebuild: drop buttons no longer on screen
    rewardButtons.push(ctl);
    return ctl;
  }
  var rewardButtons = [];

  // ---------------------------------------------------------------- boot
  function setProgress(p) {
    p = Math.max(0, Math.min(1, p));
    var b = $('loading-bar'); if (b) b.style.width = Math.round(p * 100) + '%';
    // the game's own loading art reads --p (0..1) and the percentage text
    var l = $('loading'); if (l) { l.style.setProperty('--p', p.toFixed(3)); l.classList.toggle('is-full', p >= 1); }
    var t = $('loading-pct'); if (t) t.textContent = Math.round(p * 100) + '%';
  }
  function maybeGameReady() {
    // INT-2b: interactive, loader gone, and not behind a pre-roll / host pause
    if (readySent || !booted || paused()) return;
    readySent = true;
    YTP.gameReady();
    if (best > 0) YTP.sendBestScore(best);         // tell YouTube the saved best (INT-3: equal to the save)
    if (YTP.saveUnavailable) toast(t('saveOff'), 3.5);
  }
  function boot() {
    var loadP = YTP.load({timeoutMs: 9000, retries: 2});   // > McPlay's 8 s slow load, < a hang
    var assetP = Promise.resolve(game.preload ? game.preload(function (p) { setProgress(0.1 + p * 0.8); }) : null);
    YTP.language('en').then(function (code) {
      var base = String(code || 'en').toLowerCase().split(/[-_]/)[0];
      if (STRINGS[code]) lang = code; else if (STRINGS[base]) lang = base;
      html.lang = lang; applyStrings();
    });
    setProgress(0.1);
    Promise.all([loadP, assetP, stageReadyP]).then(function (res) {
      adopt(res[0]);
      applyStrings();
      if (game.renderer !== 'none' && game.renderer !== 'webgl') ctx = canvas.getContext('2d');
      applyStage();
      if (game.resize) safe(function () { game.resize(stage); });
      setProgress(1);
      initAudio();
      booted = true;
      $('loading').hidden = true;
      safe(function () { if (game.start) game.start(); });
      if (!paused()) run(); else draw();
    }, function (e) {                                      // even a broken boot must never hang on the loader
      YTP.logError(e); adopt(null); booted = true; $('loading').hidden = true; if (game.start) safe(game.start); if (!paused()) run();
    });
  }

  global.Shell = {
    register: function (g) {
      game = g; saveVersion = g.saveVersion || 1;
      if (g.strings) for (var k in g.strings) STRINGS[k] = Object.assign({}, STRINGS[k] || {}, g.strings[k]);
      wireSettings(); applyStage(); boot();
    },
    get data() { return data; }, get stage() { return stage; }, get best() { return best; },
    t: t, show: show, toast: toast, sfx: sfx, registerSfx: registerSfx, registerMusic: registerMusic,
    audio: function () { return actx && audioOn() ? {ctx: actx, bus: sfxBus, music: musicBus} : null; },
    audioCtx: function () { return actx ? {ctx: actx, bus: sfxBus, music: musicBus} : null; },
    get lang() { return lang; }, after: after, commit: commit, reportBest: reportBest,
    transition: transition, rewardButton: rewardButton, openSettings: openSettings,
    pause: function (name) { setReason(name || 'game', true); }, resume: function (name) { setReason(name || 'game', false); },
    isPaused: paused,
    // read-only snapshot for QA hooks (scripts/qa) and debugging
    state: function () { return {booted: booted, ready: readySent, paused: paused(), screen: screen, audioOn: audioOn(), busy: busy,
      audioState: actx ? actx.state : 'none', saveUnavailable: !!YTP.saveUnavailable}; }
  };
})(window);

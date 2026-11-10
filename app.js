/*
 * app.js — interface de l'accordeur (navigateur).
 * Capture micro (Web Audio) ou signal de test -> DSP.analyze() (FFT maison) -> affichage.
 */
(function () {
  'use strict';

  const DSP = window.DSP;
  const $ = (id) => document.getElementById(id);

  const COLOR = {
    panel: '#1d2128', fg: '#e8ecf1', muted: '#8b95a5', green: '#38d27a', orange: '#f5a524',
    red: '#ef5350', accent: '#4da3ff', grid: '#2a303a', zone: '#1f4d36', dim: '#7a5a1a',
  };
  const F_MIN = 30, F_MAX = 4000, DB_MIN = -90, STEP_MS = 40;

  const state = {
    running: false,
    source: null,
    cfg: Object.assign({}, DSP.DEFAULTS),
    lastSeen: 0,
    lastRun: 0,
    smoothCents: null,
    smoothMidi: null,
    analysis: null,   // dernière analyse (pour le spectre)
    cents: null,      // valeur affichée par la jauge (null = pas de note)
  };

  // ------------------------------------------------------------ sources
  class SyntheticSource {
    constructor(freq) {
      this.sampleRate = 44100;
      this.freq = freq;
      this.t0 = performance.now();
      this.counter = 1;
    }
    async start() { this.t0 = performance.now(); }
    stop() {}
    setFreq(f) { this.freq = f; }
    read(n) {
      const now = (performance.now() - this.t0) / 1000;
      this.counter = (this.counter + 1) % 100000;
      return DSP.generateTone(this.freq, this.sampleRate, n, {
        t0: now - n / this.sampleRate, noise: 0.002, seed: this.counter,
      });
    }
  }

  class MicSource {
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Le micro n'est pas accessible : ouvrez la page en https:// ou sur localhost.");
      }
      // Pour un accordeur, on coupe les traitements du navigateur qui altèrent le signal.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.node = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = state.cfg.frameSize;      // 8192 : dernière trame du signal
      this.buf = new Float32Array(this.analyser.fftSize);
      this.node.connect(this.analyser);                  // volontairement pas relié aux haut-parleurs
      this.sampleRate = this.ctx.sampleRate;
    }
    stop() {
      try { this.node && this.node.disconnect(); } catch (e) { /* ignore */ }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close().catch(() => {});
      this.stream = this.ctx = this.node = this.analyser = null;
    }
    read() {
      this.analyser.getFloatTimeDomainData(this.buf);
      return this.buf;
    }
  }

  // ------------------------------------------------------------ canvas
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawMeter() {
    const { ctx, w, h } = setupCanvas($('meter'));
    ctx.fillStyle = COLOR.panel;
    ctx.fillRect(0, 0, w, h);
    const left = 34, right = w - 34, y = 72;
    const x = (c) => left + ((c + 50) / 100) * (right - left);

    ctx.fillStyle = COLOR.zone;                       // zone juste : +/- 5 cents
    ctx.fillRect(x(-5), y - 16, x(5) - x(-5), 18);
    ctx.strokeStyle = COLOR.muted;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    for (let c = -50; c <= 50; c += 10) {
      const len = (c === -50 || c === 0 || c === 50) ? 16 : 9;
      ctx.strokeStyle = c === 0 ? COLOR.fg : COLOR.muted;
      ctx.lineWidth = c === 0 ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x(c), y); ctx.lineTo(x(c), y - len); ctx.stroke();
    }
    ctx.fillStyle = COLOR.muted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    [[-50, '-50'], [-25, '-25'], [0, '0'], [25, '+25'], [50, '+50']].forEach(([c, t]) => ctx.fillText(t, x(c), y + 20));
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillText('♭', left - 16, 24);
    ctx.fillText('♯', right + 16, 24);

    if (state.cents !== null) {
      const c = Math.max(-50, Math.min(50, state.cents));
      ctx.strokeStyle = tone(c) === 'good' ? COLOR.green : tone(c) === 'near' ? COLOR.orange : COLOR.red;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x(c), 14); ctx.lineTo(x(c), y); ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  function drawSpectrum() {
    const { ctx, w, h } = setupCanvas($('spectrum'));
    ctx.fillStyle = COLOR.panel;
    ctx.fillRect(0, 0, w, h);
    const l = 44, t = 10, r = w - 12, b = h - 24;
    const a = state.analysis;
    const fmaxPlot = a ? Math.min(F_MAX, a.fs / 2) : F_MAX;
    const lo = Math.log10(F_MIN), hi = Math.log10(fmaxPlot);
    const fx = (f) => l + ((Math.log10(Math.max(f, F_MIN)) - lo) / (hi - lo)) * (r - l);
    const dy = (db) => t + ((0 - db) / (0 - DB_MIN)) * (b - t);

    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let db = 0; db >= DB_MIN; db -= 20) {
      ctx.strokeStyle = COLOR.grid;
      ctx.beginPath(); ctx.moveTo(l, dy(db)); ctx.lineTo(r, dy(db)); ctx.stroke();
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(String(db), l - 6, dy(db));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    [50, 100, 200, 500, 1000, 2000, 4000].forEach((f) => {
      if (f > fmaxPlot) return;
      ctx.strokeStyle = COLOR.grid;
      ctx.beginPath(); ctx.moveTo(fx(f), t); ctx.lineTo(fx(f), b); ctx.stroke();
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(f < 1000 ? f + ' Hz' : f / 1000 + 'k', fx(f), b + 14);
    });
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR.muted;
    ctx.fillText('dB', l + 4, t + 10);
    if (!a) return;

    // courbe : maximum des bins couverts par chaque colonne de pixels
    const mag = a.magnitude, df = a.df;
    const cols = Math.max(50, Math.floor(r - l));
    ctx.strokeStyle = COLOR.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let prev = Math.round(Math.pow(10, lo) / df);
    for (let i = 0; i < cols; i++) {
      const next = Math.round(Math.pow(10, lo + ((hi - lo) * (i + 1)) / cols) / df);
      const i0 = Math.min(prev, mag.length - 1), i1 = Math.min(Math.max(next, i0), mag.length - 1);
      let m = 0;
      for (let k = i0; k <= i1; k++) if (mag[k] > m) m = mag[k];
      const db = Math.max(DB_MIN, Math.min(0, 20 * Math.log10(m + 1e-12)));
      const px = l + (i / (cols - 1)) * (r - l);
      if (i === 0) ctx.moveTo(px, dy(db)); else ctx.lineTo(px, dy(db));
      prev = next;
    }
    ctx.stroke();

    // marqueurs de la fondamentale et de ses harmoniques
    if (a.f0) {
      ctx.font = '10px system-ui, sans-serif';
      for (let k = 1; k <= 8; k++) {
        const f = k * a.f0;
        if (f >= fmaxPlot) break;
        ctx.strokeStyle = k === 1 ? COLOR.orange : COLOR.dim;
        ctx.setLineDash(k === 1 ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(fx(f), t); ctx.lineTo(fx(f), b); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = k === 1 ? COLOR.orange : '#b08a3a';
        ctx.fillText(k === 1 ? 'f0' : k + 'f0', fx(f) + 3, t + 10);
      }
    }
  }

  function drawAll() { drawMeter(); drawSpectrum(); }

  // ------------------------------------------------------------ logique
  function tone(cents) {
    const c = Math.abs(cents);
    return c <= 5 ? 'good' : c <= 15 ? 'near' : 'far';
  }

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function resetDisplay() {
    $('note').textContent = '--';
    $('note').dataset.state = 'idle';
    $('freq').textContent = 'Aucun son détecté';
    $('detail').textContent = ' ';
    state.cents = null;
    state.smoothCents = state.smoothMidi = null;
    state.analysis = null;
  }

  function showPitch(a) {
    const now = performance.now();
    if (a.f0 === null) {
      if (now - state.lastSeen > 600) {                 // on garde l'affichage 0,6 s
        $('note').textContent = '--';
        $('note').dataset.state = 'idle';
        $('freq').textContent = 'Aucun son détecté';
        $('detail').textContent = 'niveau : ' + (20 * Math.log10(a.rms + 1e-12)).toFixed(0) + ' dBFS';
        state.cents = null;
        state.smoothCents = state.smoothMidi = null;
      }
      return;
    }
    state.lastSeen = now;
    const a4 = parseFloat($('a4').value) || 440;
    const notation = document.querySelector('input[name=notation]:checked').value;
    const note = DSP.freqToNote(a.f0, a4, notation);
    // lissage de la jauge tant que la note reste la même
    if (state.smoothMidi === note.midi && state.smoothCents !== null) {
      state.smoothCents = 0.6 * state.smoothCents + 0.4 * note.cents;
    } else {
      state.smoothCents = note.cents;
    }
    state.smoothMidi = note.midi;
    const cents = state.smoothCents;
    state.cents = cents;
    $('note').textContent = note.label;
    $('note').dataset.state = tone(cents);
    $('freq').textContent = a.f0.toFixed(2) + ' Hz';
    const sense = Math.abs(cents) <= 5 ? '  ✔ juste' : cents < 0 ? '  ↓ trop grave' : '  ↑ trop aigu';
    $('detail').textContent = 'cible ' + note.targetFreq.toFixed(2) + ' Hz   |   ' +
      (cents >= 0 ? '+' : '') + cents.toFixed(1) + ' cents' + sense;
  }

  function step() {
    const src = state.source;
    if (!src) return;
    state.cfg.rmsThreshold = Math.pow(10, parseFloat($('threshold').value) / 20);
    const x = src.read(state.cfg.frameSize);
    state.analysis = DSP.analyze(x, src.sampleRate, state.cfg);
    showPitch(state.analysis);
    drawAll();
  }

  function frame(ts) {
    if (!state.running) return;
    if (ts - state.lastRun >= STEP_MS) {
      state.lastRun = ts;
      try { step(); } catch (e) { setStatus('Erreur : ' + e.message, true); }
    }
    requestAnimationFrame(frame);
  }

  async function start() {
    const kind = $('source').value;
    setStatus(kind === 'mic' ? 'Autorisez l\'accès au micro…' : '');
    const src = kind === 'mic' ? new MicSource() : new SyntheticSource(parseFloat($('testFreq').value));
    try {
      await src.start();
    } catch (e) {
      src.stop && src.stop();
      const msg = e && e.name === 'NotAllowedError' ? 'Accès au micro refusé : autorisez-le dans la barre d\'adresse du navigateur.'
        : e && e.name === 'NotFoundError' ? 'Aucun microphone détecté sur cet appareil.'
        : (e && e.message) || String(e);
      setStatus(msg, true);
      return;
    }
    state.source = src;
    state.running = true;
    $('toggle').textContent = '■ Arrêter';
    $('toggle').dataset.running = 'true';
    setStatus(kind === 'mic' ? 'Micro actif (' + src.sampleRate + ' Hz). Jouez une note.' :
      'Signal de test actif : réglez la fréquence avec le curseur.');
    requestAnimationFrame(frame);
  }

  function stop() {
    state.running = false;
    if (state.source) state.source.stop();
    state.source = null;
    $('toggle').textContent = '▶ Démarrer';
    $('toggle').dataset.running = 'false';
    setStatus('');
    resetDisplay();
    drawAll();
  }

  function onSourceChange() {
    $('synthRow').style.display = $('source').value === 'synth' ? '' : 'none';
    if (state.running) { stop(); start(); }
  }

  // ------------------------------------------------------------ init
  function init() {
    $('toggle').addEventListener('click', () => (state.running ? stop() : start()));
    $('source').addEventListener('change', onSourceChange);
    $('threshold').addEventListener('input', () => {
      $('thresholdOut').textContent = $('threshold').value + ' dBFS';
    });
    $('testFreq').addEventListener('input', () => {
      const f = parseFloat($('testFreq').value);
      $('testFreqOut').textContent = f.toFixed(1) + ' Hz';
      if (state.source instanceof SyntheticSource) state.source.setFreq(f);
    });
    window.addEventListener('resize', drawAll);

    // Paramètres d'URL (démonstrations, captures) : ?source=synth&freq=443&autostart=1
    const q = new URLSearchParams(location.search);
    if (q.get('source') === 'synth' || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      $('source').value = 'synth';
    }
    if (q.get('freq')) {
      $('testFreq').value = q.get('freq');
      $('testFreq').dispatchEvent(new Event('input'));
    }
    onSourceChange();
    drawAll();
    if (q.get('autostart') === '1' && $('source').value === 'synth') start();

    window.__tuner = { state, step, start, stop };   // pour les tests automatisés
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

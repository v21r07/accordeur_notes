/*
 * dsp.js — Transformée de Fourier Discrète, extraction de la fréquence
 * fondamentale et conversion en note. Aucune dépendance.
 *
 * Même chaîne de traitement que la version Python (python/tuner/pitch.py) :
 *   1. suppression de la composante continue + niveau RMS
 *   2. fenêtre de Hann
 *   3. bourrage de zéros (x2) puis FFT radix-2 (Cooley-Tukey, écrite à la main)
 *   4. produit spectral harmonique (somme des log des amplitudes de f, 2f, 3f...)
 *   5. correction d'octave par la sous-harmonique
 *   6. interpolation parabolique du pic -> précision sub-bin
 *
 * Utilisable dans le navigateur (window.DSP) et dans Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NAMES_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

  const DEFAULTS = Object.freeze({
    frameSize: 8192,        // échantillons analysés (puissance de 2)
    zeroPad: 2,             // facteur de bourrage de zéros (puissance de 2)
    fmin: 40,               // fondamentale minimale (Hz)
    fmax: 2000,             // fondamentale maximale (Hz)
    harmonics: 5,           // nombre d'harmoniques du HPS
    rmsThreshold: 0.004,    // niveau minimal (pleine échelle = 1)
    minPeakRatio: 8,        // pic / médiane du spectre : rejette le bruit
    subharmonicRatio: 0.3,  // seuil de la correction d'octave
    floorNoiseMult: 4,      // plancher du HPS : 4 x médiane ...
    floorPeakFrac: 1e-3,    // ... ou -60 dB sous le pic (le plus grand des deux)
  });

  function isPowerOfTwo(n) {
    return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  }

  // ------------------------------------------------------------------ DFT
  /** DFT directe, O(N^2) : X[k] = sum x[n] exp(-2 pi i k n / N). Référence / pédagogie. */
  function dft(re, im) {
    const n = re.length;
    const outRe = new Float64Array(n);
    const outIm = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const ang = -2 * Math.PI * ((k * t) % n) / n;
        const c = Math.cos(ang), s = Math.sin(ang);
        const xr = re[t], xi = im ? im[t] : 0;
        sr += xr * c - xi * s;
        si += xr * s + xi * c;
      }
      outRe[k] = sr;
      outIm[k] = si;
    }
    return { re: outRe, im: outIm };
  }

  // ------------------------------------------------------------------ FFT
  const plans = new Map();

  function plan(n) {
    let p = plans.get(n);
    if (p) return p;
    const bits = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let t = 0; t < n / 2; t++) {
      cos[t] = Math.cos((2 * Math.PI * t) / n);
      sin[t] = -Math.sin((2 * Math.PI * t) / n); // exp(-2 pi i t / n)
    }
    p = { rev, cos, sin };
    plans.set(n, p);
    return p;
  }

  /**
   * FFT radix-2 de Cooley-Tukey, itérative, EN PLACE.
   * re, im : Float64Array de même longueur N (puissance de 2).
   */
  function fft(re, im) {
    const n = re.length;
    if (!isPowerOfTwo(n) || im.length !== n) {
      throw new Error('La taille de la FFT doit être une puissance de 2 (reçu ' + n + ').');
    }
    const { rev, cos, sin } = plan(n);

    // 1) permutation par inversion de bits
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // 2) log2(N) étages de papillons
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t], wi = sin[t];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr;        im[a] += xi;
        }
      }
    }
  }

  const hannCache = new Map();
  /** Fenêtre de Hann périodique de longueur n. */
  function hann(n) {
    let w = hannCache.get(n);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      hannCache.set(n, w);
    }
    return w;
  }

  // ---------------------------------------------------------------- notes
  function freqToMidi(freq, a4) { return 69 + 12 * Math.log2(freq / (a4 || 440)); }
  function midiToFreq(midi, a4) { return (a4 || 440) * Math.pow(2, (midi - 69) / 12); }

  /** Note la plus proche de freq : {midi, name, octave, label, targetFreq, cents}. */
  function freqToNote(freq, a4, notation) {
    a4 = a4 || 440;
    if (!(freq > 0) || !isFinite(freq)) throw new RangeError('La fréquence doit être strictement positive.');
    const exact = freqToMidi(freq, a4);
    const nearest = Math.floor(exact + 0.5);
    const names = notation === 'en' ? NAMES_EN : NAMES_FR;
    const name = names[((nearest % 12) + 12) % 12];
    const octave = Math.floor(nearest / 12) - 1;
    return {
      midi: nearest, name, octave, label: name + octave,
      targetFreq: midiToFreq(nearest, a4), cents: 100 * (exact - nearest),
    };
  }

  // -------------------------------------------------- fondamentale (pitch)
  function median(arr) {
    const s = Float64Array.from(arr).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  function parabolicPeak(mag, k) {
    if (k <= 0 || k >= mag.length - 1) return k;
    const tiny = 1e-20;
    const a = Math.log(mag[k - 1] + tiny);
    const b = Math.log(mag[k] + tiny);
    const c = Math.log(mag[k + 1] + tiny);
    const denom = a - 2 * b + c;
    if (denom === 0) return k;
    const delta = 0.5 * (a - c) / denom;
    return k + Math.max(-1, Math.min(1, delta));
  }

  function argmax(arr, lo, hi) { // premier maximum sur [lo, hi]
    let best = lo;
    for (let i = lo + 1; i <= hi; i++) if (arr[i] > arr[best]) best = i;
    return best;
  }

  /** {f0 (Hz) ou null, ratio pic/médiane} à partir du spectre d'amplitude. */
  function extractFundamental(mag, fs, nfft, cfg) {
    const df = fs / nfft;
    const nh = cfg.harmonics;
    const kmin = Math.max(2, Math.ceil(cfg.fmin / df));
    const kmax = Math.min(Math.floor(cfg.fmax / df), Math.floor((mag.length - 1) / nh) - 1);
    if (kmax <= kmin) return { f0: null, ratio: 0 };
    let peak = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i] > peak) peak = mag[i];
    if (peak <= 0) return { f0: null, ratio: 0 };

    // plancher de bruit (cf. version Python)
    const band = mag.subarray(kmin, Math.min(mag.length, kmax * nh + 1));
    const med = median(band) + 1e-20;
    const floor = Math.max(cfg.floorNoiseMult * med, cfg.floorPeakFrac * peak);

    // produit spectral harmonique = somme des logs ; le terme h = 1 compte double
    const logm = new Float64Array(mag.length);
    for (let i = 0; i < mag.length; i++) logm[i] = Math.log(Math.max(mag[i], floor));
    let best = -Infinity, kc = kmin;
    for (let k = kmin; k <= kmax; k++) {
      let s = 2 * logm[k];
      for (let h = 2; h <= nh; h++) s += logm[h * k];
      if (s > best) { best = s; kc = k; }
    }

    // pic réel le plus proche du candidat
    const w = Math.max(2, Math.round(cfg.zeroPad * 2));
    let kpk = argmax(mag, Math.max(1, kc - w), Math.min(mag.length - 2, kc + w));

    // correction d'octave
    for (let it = 0; it < 2; it++) {
      const k2 = kpk >> 1;
      if (k2 - w < kmin) break;
      const kk = argmax(mag, k2 - w, k2 + w);
      if (mag[kk] >= cfg.subharmonicRatio * mag[kpk] && kk >= kmin) kpk = kk;
      else break;
    }

    const ratio = mag[kpk] / med;
    if (ratio < cfg.minPeakRatio) return { f0: null, ratio };
    return { f0: parabolicPeak(mag, kpk) * df, ratio };
  }

  /**
   * Analyse une trame.
   * @param {ArrayLike<number>} samples  signal mono (float, [-1, 1])
   * @param {number} fs                  fréquence d'échantillonnage (Hz)
   * @param {object} [options]           surcharge de DEFAULTS
   * @returns {{fs, df, rms, magnitude: Float64Array, f0: number|null, peakRatio: number}}
   */
  function analyze(samples, fs, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const n = cfg.frameSize;
    if (!isPowerOfTwo(n) || !isPowerOfTwo(cfg.zeroPad)) {
      throw new Error('frameSize et zeroPad doivent être des puissances de 2.');
    }
    const nfft = n * cfg.zeroPad;

    // dernière trame de n échantillons (complétée par du silence à gauche si trop courte)
    const x = new Float64Array(n);
    const len = samples.length;
    if (len >= n) for (let i = 0; i < n; i++) x[i] = samples[len - n + i];
    else for (let i = 0; i < len; i++) x[n - len + i] = samples[i];

    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let sq = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; sq += x[i] * x[i]; }
    const rms = Math.sqrt(sq / n);

    const w = hann(n);
    let wsum = 0;
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) { re[i] = x[i] * w[i]; wsum += w[i]; }
    fft(re, im);

    const half = nfft / 2;
    const norm = wsum / 2; // un sinus d'amplitude A donne un pic d'amplitude ~A
    const mag = new Float64Array(half + 1);
    for (let i = 0; i <= half; i++) mag[i] = Math.hypot(re[i], im[i]) / norm;

    const out = { fs, df: fs / nfft, rms, magnitude: mag, f0: null, peakRatio: 0 };
    if (rms < cfg.rmsThreshold) return out;
    const r = extractFundamental(mag, fs, nfft, cfg);
    out.f0 = r.f0;
    out.peakRatio = r.ratio;
    return out;
  }

  // ----------------------------------------------- signaux de test (démo)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Somme d'harmoniques de freq (amplitudes relatives) + bruit blanc gaussien. */
  function generateTone(freq, fs, nSamples, opts) {
    opts = opts || {};
    const harmonics = opts.harmonics || [1, 0.5, 0.33, 0.25];
    const amplitude = opts.amplitude === undefined ? 0.5 : opts.amplitude;
    const noise = opts.noise || 0;
    const t0 = opts.t0 || 0;
    const rand = mulberry32(opts.seed === undefined ? 1 : opts.seed);
    const norm = harmonics.reduce((s, a) => s + Math.abs(a), 0) || 1;
    const x = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      const t = t0 + i / fs;
      let v = 0;
      for (let k = 1; k <= harmonics.length; k++) {
        if (k * freq < fs / 2) v += harmonics[k - 1] * Math.sin(2 * Math.PI * k * freq * t);
      }
      v *= amplitude / norm;
      if (noise > 0) { // Box-Muller
        const u1 = Math.max(rand(), 1e-12), u2 = rand();
        v += noise * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      }
      x[i] = v;
    }
    return x;
  }

  return {
    DEFAULTS, NAMES_EN, NAMES_FR,
    isPowerOfTwo, dft, fft, hann,
    freqToMidi, midiToFreq, freqToNote,
    analyze, extractFundamental, generateTone,
  };
});

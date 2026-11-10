'use strict';
// Lancer :  node --test web/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const DSP = require('../dsp.js');

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} attendu ${expected} ± ${tol}, reçu ${actual}`);
}

function randn(n, seed) {
  const a = DSP.generateTone(1, 1000, n, { harmonics: [0], noise: 1, seed, amplitude: 0 });
  return Float64Array.from(a);
}

// ----------------------------------------------------------- DFT / FFT
for (const n of [1, 2, 4, 8, 64, 256, 1024]) {
  test(`FFT == DFT pour N = ${n}`, () => {
    const re = randn(n, n), im = randn(n, n + 100);
    const ref = DSP.dft(re, im);
    const fr = Float64Array.from(re), fi = Float64Array.from(im);
    DSP.fft(fr, fi);
    for (let k = 0; k < n; k++) {
      near(fr[k], ref.re[k], 1e-8, `re[${k}]`);
      near(fi[k], ref.im[k], 1e-8, `im[${k}]`);
    }
  });
}

test('FFT refuse une taille qui n\'est pas une puissance de 2', () => {
  assert.throws(() => DSP.fft(new Float64Array(12), new Float64Array(12)));
});

test('FFT d\'un cosinus pur : deux raies', () => {
  const n = 256, k0 = 10;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / n);
  DSP.fft(re, im);
  const mag = i => Math.hypot(re[i], im[i]);
  near(mag(k0), n / 2, 1e-9);
  near(mag(n - k0), n / 2, 1e-9);
  for (let i = 0; i < n; i++) if (i !== k0 && i !== n - k0) assert.ok(mag(i) < 1e-9);
});

test('relation de Parseval', () => {
  const n = 512;
  const re = randn(n, 7), im = new Float64Array(n);
  let e = 0;
  for (const v of re) e += v * v;
  DSP.fft(re, im);
  let E = 0;
  for (let i = 0; i < n; i++) E += re[i] * re[i] + im[i] * im[i];
  near(E / n, e, 1e-8 * e);
});

test('fenêtre de Hann', () => {
  const w = DSP.hann(8);
  assert.equal(w[0], 0);
  near(w[4], 1, 1e-12);
});

// --------------------------------------------------------------- notes
test('La4 = 440 Hz', () => {
  const n = DSP.freqToNote(440);
  assert.equal(n.label, 'La4');
  near(n.cents, 0, 1e-9);
  assert.equal(DSP.freqToNote(440, 440, 'en').label, 'A4');
});

test('Do central, Mi grave de guitare, La0', () => {
  assert.equal(DSP.freqToNote(261.6256).label, 'Do4');
  assert.equal(DSP.freqToNote(82.4069).label, 'Mi2');
  assert.equal(DSP.freqToNote(27.5).label, 'La0');
});

test('signe et valeur des cents', () => {
  near(DSP.freqToNote(440 * 2 ** (20 / 1200)).cents, 20, 1e-6);
  near(DSP.freqToNote(440 * 2 ** (-20 / 1200)).cents, -20, 1e-6);
});

test('diapason personnalisé', () => {
  near(DSP.freqToNote(432, 432).cents, 0, 1e-9);
});

test('fréquence invalide', () => {
  for (const bad of [0, -5, NaN, Infinity]) assert.throws(() => DSP.freqToNote(bad), RangeError);
});

// ------------------------------------------------ fondamentale (pitch)
const TIMBRES = {
  'sinus': [1],
  'guitare (fondamentale faible)': [0.4, 1, 0.7, 0.5, 0.3],
  'voix': Array.from({ length: 8 }, (_, i) => 1 / (i + 1)),
  'scie': Array.from({ length: 19 }, (_, i) => 1 / (i + 1)),
  'clarinette (harmoniques impairs)': [1, 0, 0.5, 0, 0.3, 0, 0.15],
  '2e harmonique dominant': [0.2, 1, 0.3],
};

for (const fs of [44100, 48000]) {
  for (const [name, harmonics] of Object.entries(TIMBRES)) {
    for (const noise of [0, 0.01]) {
      test(`précision < 5 cents — ${name}, fs=${fs}, bruit=${noise}`, () => {
        let worst = 0, count = 0;
        for (let midi = 33; midi < 97; midi++) {
          const f = DSP.midiToFreq(midi) * (1 + 0.0123 * (((midi * 7) % 5) - 2));
          if (f < 45 || f > 1900) continue;
          const x = DSP.generateTone(f, fs, 8192, { harmonics, noise, seed: midi });
          const a = DSP.analyze(x, fs);
          assert.notEqual(a.f0, null, `rien détecté à ${f.toFixed(1)} Hz`);
          worst = Math.max(worst, Math.abs(1200 * Math.log2(a.f0 / f)));
          count++;
        }
        assert.ok(count > 50);
        assert.ok(worst < 5, `erreur max ${worst.toFixed(2)} cents`);
      });
    }
  }
}

for (const amp of [0, 0.001, 0.05, 0.3]) {
  test(`bruit/silence (amplitude ${amp}) : pas de note`, () => {
    const x = Float32Array.from(randn(8192, 3), v => v * amp);
    assert.equal(DSP.analyze(x, 44100).f0, null);
  });
}

test('la composante continue est ignorée', () => {
  const x = DSP.generateTone(220, 44100, 8192, { harmonics: [1, 0.5] }).map(v => v + 0.3);
  near(DSP.analyze(x, 44100).f0, 220, 0.2);
});

test('trame trop courte : complétée par du silence', () => {
  const x = DSP.generateTone(440, 44100, 4410);
  near(DSP.analyze(x, 44100).f0, 440, 1);
});

test('calibration de l\'amplitude du spectre', () => {
  const x = DSP.generateTone(440, 44100, 8192, { harmonics: [1], amplitude: 0.5 });
  const a = DSP.analyze(x, 44100);
  near(Math.max(...a.magnitude), 0.5, 0.025);
});

test('configuration invalide', () => {
  assert.throws(() => DSP.analyze(new Float32Array(1000), 44100, { frameSize: 1000 }));
});

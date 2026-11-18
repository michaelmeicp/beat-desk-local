import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeAudio, demoWav, guardFile, makeDemo, tapTempo, MAX_ANALYSIS_SECONDS, MAX_FILE_BYTES
} from './engine.mjs';

const pcmBuffer = (sampleRate, ...channels) => ({
  sampleRate, length: channels[0].length, numberOfChannels: channels.length,
  getChannelData: i => channels[i],
});

// Separate pulse envelope and oscillator from the built-in audition demos.
function clickFixture(rate, bpm, { accented = false, duration = 18 } = {}) {
  const samples = new Float32Array(rate * duration);
  for (let i = 0; 0.3 + (i * 60 / bpm) < duration; i++) {
    const start = Math.round(rate * (0.3 + (i * 60 / bpm)));
    const gain = !accented || i % 2 === 0 ? 0.76 : 0.14;
    for (let k = 0; k < Math.min(samples.length - start, Math.round(rate * 0.035)); k++) {
      const t = k / rate;
      samples[start + k] = gain * Math.exp(-t * 67) *
        (0.68 * Math.sin(2 * Math.PI * 1300 * t) + 0.32 * Math.sin(2 * Math.PI * 2350 * t));
    }
  }
  return pcmBuffer(rate, samples);
}

for (const rate of [44_100, 48_000]) {
  for (const bpm of [90, 120, 128, 150]) {
    test(`decoded PCM at ${rate} Hz, ${bpm} BPM`, () => {
      const result = analyzeAudio(clickFixture(rate, bpm));
      assert.equal(result.status, 'ok');
      assert.ok(Math.abs(result.bpm - bpm) <= 2, JSON.stringify(result));
      assert.equal(result.confidence, 'strong');
      assert.equal(result.waveform.length, 96);
      assert.ok(result.waveform.some(value => value > 0));
    });
  }
}

test('an accented 140 click train offers the other metrical level as an explicit candidate', () => {
  const result = analyzeAudio(clickFixture(48_000, 140, { accented: true }));
  assert.equal(result.status, 'ok');
  assert.ok(Math.min(Math.abs(result.bpm - 140), Math.abs(result.bpm - 70)) <= 2);
  const otherTempo = result.bpm > 100 ? 70 : 140;
  assert.ok(result.alternatives.some(bpm => Math.abs(bpm - otherTempo) <= 2));
});

test('opposite-polarity stereo pulses do not cancel', () => {
  const audio = clickFixture(44_100, 90);
  const samples = audio.getChannelData(0);
  assert.equal(analyzeAudio(pcmBuffer(44_100, samples, samples.map(x => -x))).bpm, 90);
});

test('silence, weak transients, insufficient time, and invalid decoded data do not fabricate BPM', () => {
  const weak = clickFixture(44_100, 90).getChannelData(0).map(x => x * 1e-5);
  const badPcm = new Float32Array(8000);
  badPcm[128] = NaN;
  const cases = [
    [pcmBuffer(44_100, new Float32Array(44_100 * 12)), 'silent'],
    [pcmBuffer(44_100, weak), 'silent'],
    [clickFixture(44_100, 150, { duration: 2 }), 'insufficient'],
    [pcmBuffer(8000, badPcm), 'invalid'],
    [pcmBuffer(1000, badPcm), 'invalid'],
    [null, 'invalid'],
    [{sampleRate: 48_000, length: 96_000, numberOfChannels: 1, getChannelData: () => new Float32Array(11)}, 'invalid'],
  ];
  for (const [buffer, status] of cases) {
    const result = analyzeAudio(buffer);
    assert.equal(result.status, status);
    assert.equal(result.bpm, null);
    assert.deepEqual(result.alternatives, []);
  }
});

test('one isolated audio event and unsteady rhythm do not fabricate BPM', () => {
  const rate = 8000;
  const samples = new Float32Array(rate * 12);
  samples[4000] = 0.8;
  assert.equal(analyzeAudio(pcmBuffer(rate, samples)).bpm, null);
  for (const t of [1, 1.21, 1.93, 2.35, 3.69, 4.61, 4.88, 5.69, 6.3, 7.46, 9.05]) {
    samples.fill(0.7, Math.round(rate * t), Math.round(rate * t) + 40);
  }
  assert.equal(analyzeAudio(pcmBuffer(rate, samples)).bpm, null);
});

test('analysis never reads samples beyond the first minute', () => {
  const rate = 8000;
  const samples = new Float32Array(rate * 62);
  samples.fill(NaN, rate * MAX_ANALYSIS_SECONDS);
  const result = analyzeAudio(pcmBuffer(rate, samples));
  assert.equal(result.analyzedSeconds, 60);
  assert.equal(result.status, 'silent');
});

test('oversized and empty files are rejected before read', () => {
  assert.equal(guardFile(null), 'empty');
  assert.equal(guardFile({ size: 0 }), 'empty');
  assert.equal(guardFile({ size: MAX_FILE_BYTES + 1 }), 'too-large');
  assert.equal(guardFile({ size: MAX_FILE_BYTES }), null);
});

test('Tap Tempo restarts after a pause and tolerates timing deviations', () => {
  assert.equal(tapTempo([0, 666, 1333, 2003]), 90);
  assert.equal(tapTempo([0, 500, 1000, 1500, 4600]), null);
  assert.equal(tapTempo([0, 500, 1000, 1500, 4600, 5066, 5538]), 128);
  assert.equal(tapTempo([0, 1, 2]), null);
});

test('original demo can be auditioned as an actual 16-bit PCM WAV', async () => {
  const demo = makeDemo(128);
  assert.equal(analyzeAudio(demo).bpm, 128);
  assert.throws(() => makeDemo(0), RangeError);
  const blob = demoWav(demo);
  assert.equal(blob.type, 'audio/wav');
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), demo.length * 2);
  assert.ok(view.getInt16(44 + (Math.round(0.268 * 48000) * 2), true) !== 0);
});

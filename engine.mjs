export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ANALYSIS_SECONDS = 60;
const WAVE_BINS = 96;
const MIN_TEMPO = 40;
const MAX_TEMPO = 240;

export function guardFile(file) {
  if (!Number.isFinite(file?.size) || file.size <= 0) return 'empty';
  return file.size > MAX_FILE_BYTES ? 'too-large' : null;
}

const emptyWave = () => new Array(WAVE_BINS).fill(0);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};

export function analyzeAudio(buffer) {
  const rate = buffer?.sampleRate;
  const length = buffer?.length;
  const waveform = emptyWave();
  const analyzedSeconds = Number.isFinite(length) && length >= 0 && rate > 0
    ? Math.min(MAX_ANALYSIS_SECONDS, length / rate) : 0;
  const unknown = status => ({
    status, bpm: null, alternatives: [], confidence: null, waveform, analyzedSeconds
  });
  if (!Number.isFinite(rate) || rate < 8000 || rate > 384000
    || !Number.isInteger(length) || length < 1 || !Number.isInteger(buffer?.numberOfChannels)
    || buffer.numberOfChannels < 1 || typeof buffer.getChannelData !== 'function') return unknown('invalid');

  // 5 ms hops derived from the *decoded* rate. Binning peak energy rather than
  // taking the mono average prevents an inverted stereo channel cancelling the other.
  // Up to two channels, with uniformly spaced samples for rates well above 48 kHz.
  const end = Math.min(length, Math.floor(MAX_ANALYSIS_SECONDS * rate));
  const hop = Math.max(1, Math.round(rate / 200));
  const stride = Math.max(1, Math.floor(rate / 48000));
  const channels = [];
  try {
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      const data = buffer.getChannelData(c);
      if (!data || data.length < end) return unknown('invalid');
      channels.push(data);
    }
  } catch {
    return unknown('invalid');
  }

  const energy = [];
  let fullPeak = 0;
  for (let p = 0; p < end; p += hop) {
    let sum = 0;
    let count = 0;
    let peak = 0;
    for (let i = p; i < Math.min(p + hop, end); i += stride) {
      for (const ch of channels) {
        const value = ch[i];
        if (!Number.isFinite(value)) return unknown('invalid');
        sum += value * value;
        peak = Math.max(peak, Math.abs(value));
        count++;
      }
    }
    energy.push(Math.sqrt(sum / count));
    const bin = Math.min(WAVE_BINS - 1, Math.floor(WAVE_BINS * p / end));
    waveform[bin] = Math.max(waveform[bin], Math.min(peak, 1));
    fullPeak = Math.max(fullPeak, peak);
  }
  if (fullPeak < 0.00015) return unknown('silent');
  if (analyzedSeconds < 4) return unknown('insufficient');

  // Score a fast rise against the preceding ≈40 ms baseline. The global floor
  // stops low-level decode noise and the local peak check suppresses click tails.
  const novelty = energy.map((e, i) => {
    let baseline = 0;
    let count = 0;
    for (let j = Math.max(0, i - 10); j < i - 2; j++) {
      baseline += energy[j];
      count++;
    }
    return Math.max(0, e - (count ? baseline / count : 0) * 1.35);
  });
  const maxNovelty = Math.max(...novelty);
  if (maxNovelty < Math.max(0.00025, 0.045 * fullPeak)) return unknown('unclear');
  const noveltyFloor = Math.max(0.00025, maxNovelty * 0.085, median(novelty) * 3.5);
  const spacing = Math.round(0.10 * rate / hop);
  const onsets = [];
  for (let i = 0; i < novelty.length; i++) {
    const power = novelty[i];
    if (power < noveltyFloor || power < (novelty[i - 1] ?? 0) || power <= (novelty[i + 1] ?? 0))
      continue;
    const last = onsets.at(-1);
    if (last && i - last.i <= spacing) {
      if (power > last.power) onsets[onsets.length - 1] = { i, power };
      continue;
    }
    onsets.push({ i, power });
  }
  if (onsets.length < 5 || (onsets.at(-1).i - onsets[0].i) * hop / rate < 2)
    return unknown('insufficient');

  const intervals = onsets.slice(1).map(({i}, index) => (i - onsets[index].i) * hop / rate);
  const admissible = intervals.filter(gap => gap >= 60 / MAX_TEMPO - 0.012 && gap <= 60 / MIN_TEMPO + 0.02);
  if (admissible.length < 4) return unknown('unclear');

  // Vote around nearby interval durations, not integer BPM. Missed pulses count
  // as weaker positive evidence; subdivisions and distant durations count against
  // confidence. Refine the winning interval using the median of inliers.
  let best = null;
  for (const period of admissible) {
    const width = Math.max(0.016, period * 0.085);
    let direct = 0;
    let multiple = 0;
    let score = 0;
    for (const gap of intervals) {
      const distance = Math.abs(gap - period) / width;
      if (distance <= 1) {
        direct++;
        score += 1 - 0.45 * distance;
      } else if (Math.abs(gap - period * 2) <= width * 1.5) {
        multiple++;
        score += 0.28;
      }
    }
    if (!best || score > best.score) best = { period, width, direct, multiple, score };
  }
  if (best.direct < 4 || best.direct / intervals.length < 0.48 ||
      (best.direct + best.multiple) / intervals.length < 0.60) return unknown('unclear');
  const refined = median(admissible.filter(gap => Math.abs(gap - best.period) <= best.width));
  const bpm = Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, Math.round(60 / refined)));
  // Alternatives express metrical interpretations of the same pulse, not a second measurement.
  const alternatives = [Math.round(bpm / 2), bpm * 2].filter(n => n >= MIN_TEMPO && n <= MAX_TEMPO);
  const confidence = best.direct / intervals.length >= 0.83 && onsets.length >= 9 ? 'strong' : 'moderate';
  return { status: 'ok', bpm, alternatives, confidence, waveform, analyzedSeconds };
}

export function tapTempo(timestampsMs) {
  if (!Array.isArray(timestampsMs) || timestampsMs.length < 3) return null;
  const taps = timestampsMs.slice(-9);
  const gaps = [];
  for (let i = taps.length - 1; i > 0; i--) {
    const gap = taps[i] - taps[i - 1];
    if (!Number.isFinite(gap) || gap <= 0 || gap > 2500) break;
    gaps.push(gap);
  }
  if (gaps.length < 2) return null;
  const bpm = Math.round(60_000 / median(gaps));
  return bpm >= MIN_TEMPO && bpm <= MAX_TEMPO ? bpm : null;
}

export function makeDemo(bpm = 128, { rate = 48000, seconds = 18, accented = false } = {}) {
  if (!Number.isFinite(bpm) || bpm < MIN_TEMPO || bpm > MAX_TEMPO
    || !Number.isInteger(rate) || rate < 8000 || rate > 96000
    || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ANALYSIS_SECONDS)
    throw new RangeError('Demo options outside supported range');
  const pcm = new Float32Array(Math.round(rate * seconds));
  const step = 60 / bpm;
  for (let n = 0; 0.26 + n * step < seconds; n++) {
    const start = Math.round((0.26 + n * step) * rate);
    const accent = accented ? (n % 2 === 0 ? 1 : 0.26) : (n % 4 === 0 ? 1 : 0.72);
    for (let k = 0; k < Math.min(Math.round(0.075 * rate), pcm.length - start); k++) {
      const t = k / rate;
      const low = n % 4 === 0 ? 158 : 233;
      pcm[start + k] = accent * Math.min(1, t * 620) * (
        0.38 * Math.exp(-t * 55) * Math.sin(2 * Math.PI * low * t)
        + 0.27 * Math.exp(-t * 95) * Math.sin(2 * Math.PI * 1490 * t)
      );
    }
  }
  return {
    sampleRate: rate,
    length: pcm.length,
    duration: pcm.length / rate,
    numberOfChannels: 1,
    getChannelData: c => {
      if (c !== 0) throw new RangeError('Only one demo channel');
      return pcm;
    }
  };
}

export function demoWav(demoBuffer) {
  const pcm = demoBuffer.getChannelData(0);
  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(bytes);
  const tag = (offset, value) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, demoBuffer.sampleRate, true);
  view.setUint32(28, demoBuffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.round(pcm[i] * 32767), true);
  return new Blob([bytes], {type: 'audio/wav'});
}

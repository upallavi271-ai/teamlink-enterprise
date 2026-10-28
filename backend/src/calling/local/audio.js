// ---------------------------------------------------------------------------
// AUDIO HELPERS for the self-hosted call path. All audio is signed 16-bit little-endian mono PCM ("slin"):
//   phone (Asterisk AudioSocket)  8 kHz  -> Vexyl STT wants 16 kHz
//   Vexyl TTS answers a WAV file (8 kHz when VEXYL_TTS_SAMPLE_RATE=8000, else the model's rate) -> the phone wants 8 kHz
// ---------------------------------------------------------------------------

// A WAV file -> { sampleRate, channels, bits, pcm } (pcm = the 'data' chunk). Only PCM 16-bit is accepted.
function parseWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null; let data = null;
  for (let off = 12; off + 8 <= b.length;) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data') { data = b.subarray(body, Math.min(b.length, body + size)); break; }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV file without fmt / data');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`WAV must be 16-bit PCM (got format ${fmt.format}, ${fmt.bits}-bit)`);
  let pcm = data;
  if (fmt.channels > 1) { // keep the first channel
    const n = Math.floor(data.length / (2 * fmt.channels));
    pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) pcm.writeInt16LE(data.readInt16LE(i * 2 * fmt.channels), i * 2);
  }
  return { sampleRate: fmt.sampleRate, channels: 1, bits: 16, pcm };
}

// 16-bit PCM bytes from one rate to another (linear interpolation; plenty for speech on a phone line).
function resample(pcm, from, to) {
  if (!pcm || !pcm.length || from === to) return Buffer.from(pcm || []);
  const n = Math.floor(pcm.length / 2);
  const outN = Math.max(1, Math.floor((n * to) / from));
  const out = Buffer.alloc(outN * 2);
  const step = from / to;
  for (let i = 0; i < outN; i += 1) {
    const x = i * step;
    const i0 = Math.min(n - 1, Math.floor(x));
    const i1 = Math.min(n - 1, i0 + 1);
    const f = x - i0;
    const v = pcm.readInt16LE(i0 * 2) * (1 - f) + pcm.readInt16LE(i1 * 2) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

// Loudness of a chunk, 0..32767 (root mean square).
function rms(pcm) {
  const n = Math.floor((pcm ? pcm.length : 0) / 2);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i += 1) { const v = pcm.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / n);
}

// A WAV file around 16-bit mono PCM (tests and the disk cache).
function toWav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

module.exports = { parseWav, resample, rms, toWav };

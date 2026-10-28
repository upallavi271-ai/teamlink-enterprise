// ---------------------------------------------------------------------------
// VOICE DETECTION on the phone line (free, no model): is the person talking, and when did they finish?
//
//   new Vad({ onStart, onEnd })   push(frame)  - one 20 ms frame of 8 kHz 16-bit PCM
//     onStart()          the person started talking (the gateway stops the assistant at once: barge-in)
//     onEnd(pcm, ms)     the person finished (END_MS of quiet): the whole sentence, ready for speech-to-text
//
// Energy based with a moving noise floor, tuned for phone audio: a sentence must last MIN_MS, a pause of END_MS ends
// it, and nothing runs past MAX_MS (a person who never stops still gets an answer).
// ---------------------------------------------------------------------------
const FRAME_MS = 20;
const START_FRAMES = 3; // 60 ms of voice = talking
const END_MS = 700; // this much quiet = finished
const MIN_MS = 250; // shorter than this = a click / a cough
const MAX_MS = 12000;
const PRE_MS = 200; // keep a little audio from just before the start (the first sound of the word)

function rms(frame) {
  let sum = 0; const n = Math.floor(frame.length / 2);
  for (let i = 0; i < n; i += 1) { const s = frame.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}

class Vad {
  constructor({ onStart, onEnd, minLevel = 400 } = {}) {
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.minLevel = minLevel; // below this a frame is never speech (line hiss)
    this.noise = minLevel / 2;
    this.talking = false;
    this.loud = 0;
    this.quietMs = 0;
    this.frames = [];
    this.pre = [];
    this.paused = false;
  }

  level() { return Math.max(this.minLevel, this.noise * 3); }

  push(frame) {
    if (this.paused) return;
    const e = rms(frame);
    const voiced = e > this.level();
    if (!this.talking) {
      if (!voiced) this.noise = this.noise * 0.95 + e * 0.05; // learn the line's background level while quiet
      this.pre.push(frame);
      if (this.pre.length > PRE_MS / FRAME_MS) this.pre.shift();
      this.loud = voiced ? this.loud + 1 : 0;
      if (this.loud >= START_FRAMES) {
        this.talking = true; this.quietMs = 0; this.frames = this.pre.slice(); this.pre = [];
        this.onStart();
      }
      return;
    }
    this.frames.push(frame);
    this.quietMs = voiced ? 0 : this.quietMs + FRAME_MS;
    const ms = this.frames.length * FRAME_MS;
    if (this.quietMs >= END_MS || ms >= MAX_MS) {
      const speechMs = ms - this.quietMs;
      const pcm = Buffer.concat(this.frames);
      this.talking = false; this.loud = 0; this.frames = []; this.quietMs = 0;
      if (speechMs >= MIN_MS) this.onEnd(pcm, speechMs);
    }
  }

  reset() { this.talking = false; this.loud = 0; this.frames = []; this.pre = []; this.quietMs = 0; }
}

module.exports = { Vad, rms, END_MS };

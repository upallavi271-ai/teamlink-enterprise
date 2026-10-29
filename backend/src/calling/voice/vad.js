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
const STRICT_FRAMES = 15; // while the assistant speaks: 300 ms of clearly louder voice (line echo / noise must not cut it off)
// this much quiet = finished. 550 cut people off while they paused to think ("I think that's not..." ended a call as Not
// Interested, 2026-10-29); 800 by default, AI_VOICE_END_MS to tune it against real calls (400 - 2000).
const END_MS = Math.min(2000, Math.max(400, Number(process.env.AI_VOICE_END_MS) || 800));
const MIN_MS = 250; // shorter than this = a click / a cough
const MAX_MS = 12000;
const PRE_MS = 200; // keep a little audio from just before the start (the first sound of the word)
const BARGE_PRE_FRAMES = 1000 / 20; // over the assistant: a full second before the voice was believed (2026-10-29)

function rms(frame) {
  let sum = 0; const n = Math.floor(frame.length / 2);
  for (let i = 0; i < n; i += 1) { const s = frame.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}

class Vad {
  // strict(): true while the assistant is speaking - only a real, louder voice counts then (barge-in), not its own echo
  constructor({ onStart, onEnd, minLevel = 400, strict = () => false } = {}) {
    this.strict = strict;
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
    const hard = !this.talking && this.strict();
    const voiced = e > (hard ? Math.max(this.minLevel * 4, this.noise * 8) : this.level());
    if (!this.talking) {
      if (!voiced) this.noise = this.noise * 0.95 + e * 0.05; // learn the line's background level while quiet
      this.pre.push(frame);
      // keep up to a second of audio from before the start. With only PRE_MS kept, a person who spoke over the assistant
      // lost their first words ("तीस दिन का नोटिस है" reached the listener as "नोटिस है", 2026-10-29).
      if (this.pre.length > BARGE_PRE_FRAMES) this.pre.shift();
      this.loud = voiced ? this.loud + 1 : 0;
      if (this.loud >= (hard ? STRICT_FRAMES : START_FRAMES)) {
        // a normal start keeps PRE_MS; talking OVER the assistant keeps a full second (its quiet first syllables)
        this.talking = true; this.quietMs = 0; this.frames = hard ? this.pre.slice() : this.pre.slice(-(PRE_MS / FRAME_MS + START_FRAMES)); this.pre = [];
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

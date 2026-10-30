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
const STRICT_FRAMES = 25; // (kept for reference; the barge-in now uses the window below)
// TALKING OVER THE ASSISTANT (founder 2026-10-30: "candidate madhyalo matladithey ai vinali ... ai chances eyadam ledhu"):
// 500 ms of voice in a row never came - speech has small gaps between syllables, and the count started again at every one,
// so the assistant talked on for 38 s. Now: in any 500 ms window, 280 ms of voice (gaps allowed) = the person is talking.
// A short "ఆ" / "ok" or a cough that gets through is handled by the gateway: the assistant goes on with what it was saying.
const BARGE_WINDOW = 25; // 500 ms
const BARGE_NEED = 14; // 280 ms of voice inside it
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
  // endMs(): the pause that ends this answer (the gateway: shorter after a yes / no question); default END_MS
  constructor({ onStart, onEnd, minLevel = 400, strict = () => false, endMs = null } = {}) {
    this.strict = strict;
    this.endMs = typeof endMs === 'function' ? endMs : () => END_MS;
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
    this.win = []; // the last frames while the assistant speaks: voice or not (barge-in window)
  }

  // a voice: above the line's own background (2.5x its learned level), never below minLevel
  level() { return Math.max(this.minLevel, this.noise * 2.5); }

  push(frame) {
    if (this.paused) return;
    const e = rms(frame);
    const hard = !this.talking && this.strict();
    // over the assistant a voice must be clearly above the line's own level (its echo comes back on a SIM line)
    const voiced = e > (hard ? Math.max(this.minLevel * 2.5, this.noise * 5) : this.level());
    if (!this.talking) {
      if (!voiced) this.noise = this.noise * 0.95 + e * 0.05; // learn the line's background level while quiet
      this.pre.push(frame);
      // keep up to a second of audio from before the start. With only PRE_MS kept, a person who spoke over the assistant
      // lost their first words ("तीस दिन का नोटिस है" reached the listener as "नोटिस है", 2026-10-29).
      if (this.pre.length > BARGE_PRE_FRAMES) this.pre.shift();
      this.loud = voiced ? this.loud + 1 : 0;
      if (hard) { this.win.push(voiced); if (this.win.length > BARGE_WINDOW) this.win.shift(); } else this.win = [];
      const barge = hard && this.win.filter(Boolean).length >= BARGE_NEED;
      if (barge || (!hard && this.loud >= START_FRAMES)) {
        this.win = [];
        // a normal start keeps PRE_MS; talking OVER the assistant keeps a full second (its quiet first syllables)
        this.talking = true; this.quietMs = 0; this.frames = hard ? this.pre.slice() : this.pre.slice(-(PRE_MS / FRAME_MS + START_FRAMES)); this.pre = [];
        this.onStart();
      }
      return;
    }
    this.frames.push(frame);
    this.quietMs = voiced ? 0 : this.quietMs + FRAME_MS;
    const ms = this.frames.length * FRAME_MS;
    if (this.quietMs >= this.endMs() || ms >= MAX_MS) {
      const speechMs = ms - this.quietMs;
      const pcm = Buffer.concat(this.frames);
      this.talking = false; this.loud = 0; this.frames = []; this.quietMs = 0;
      if (speechMs >= MIN_MS) this.onEnd(pcm, speechMs);
    }
  }

  reset() { this.talking = false; this.loud = 0; this.frames = []; this.pre = []; this.quietMs = 0; }
}

module.exports = { Vad, rms, END_MS };

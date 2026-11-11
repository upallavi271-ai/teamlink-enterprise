// ---------------------------------------------------------------------------
// LIVE CALLS COME FIRST (founder 2026-11-09: "voice struck avuthundhi, correct ga ravadam ledhu, 5 november 7 o'clock ki ochinatlu ravali").
// The voice (Piper) and the ears (Whisper) share the server's processor with the local language model that answers WhatsApp chats and makes script
// translations. While a call is going on, that model waits (up to a limit) instead of taking the processor from the voice.
// ---------------------------------------------------------------------------
let live = 0;
// THE NUMBER OF LIVE CALLS IN A FILE (founder 2026-11-11: gaps of 5-22 s while a code update was building and restarting TeamLink on the
// same server): the update script (deploy/vps/teamlink-sync.sh) reads it and waits while a call is on the line - no build stealing the
// processor from the voice, no restart cutting the call.
const LIVE_FILE = process.env.AI_VOICE_LIVE_FILE || require('path').join(require('os').tmpdir(), 'teamlink-live-calls'); // eslint-disable-line global-require
const note = () => { try { require('fs').writeFileSync(LIVE_FILE, `${live} ${Math.floor(Date.now() / 1000)}\n`); } catch { /* never breaks a call */ } }; // eslint-disable-line global-require
const enter = () => { live += 1; note(); };
const leave = () => { live = Math.max(0, live - 1); note(); };
const active = () => live;
/** Resolves when no AI call is going on (or after maxMs, so a chat is only delayed, never lost). */
async function whenQuiet(maxMs = 120000, pollMs = 1000) {
  const until = Date.now() + maxMs;
  while (live > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, pollMs)); // eslint-disable-line no-await-in-loop
}
note(); // a restart starts at 0
module.exports = { enter, leave, active, whenQuiet, LIVE_FILE };

// ---------------------------------------------------------------------------
// SELF-HOSTED AI CALLING - IS EVERY PIECE THERE? Asks the real Ollama, Vexyl STT and Vexyl TTS named in backend/.env
// (AI_CALL_OLLAMA_URL / AI_CALL_STT_URL / AI_CALL_TTS_URL). Places NO call and sends no candidate data: STT gets an empty session,
// TTS renders the word "Hello", Ollama lists its models.
//
//   node scripts/ai-calling-local-check.js
// ---------------------------------------------------------------------------
require('dotenv').config();
const local = require('../src/calling/local');

(async () => {
  const h = await local.health();
  const line = (name, r) => console.log(`${r.ok ? 'OK  ' : 'NOT '} ${name.padEnd(6)} ${r.message}`);
  line('LLM', h.llm);
  line('STT', h.stt);
  line('TTS', h.tts);
  console.log(`     Phone  AudioSocket: ${h.audioSocket}`);
  process.exit(h.llm.ok && h.stt.ok && h.tts.ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

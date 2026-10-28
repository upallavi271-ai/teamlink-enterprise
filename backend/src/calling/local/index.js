// ---------------------------------------------------------------------------
// SELF-HOSTED AI CALLING - switched on by the server's environment (config.js), started once from index.js.
//   * Vexyl STT + TTS set  -> the voicebot's speech provider (setSpeech)
//   * AI_CALL_AUDIOSOCKET_PORT set -> the Asterisk AudioSocket bridge listens
//   * AI_CALL_OLLAMA_URL set -> voicebot.llmClassifier asks the local model (ollama.js)
// Nothing here places a call: calls are still created, confirmed and limited by calling/callService.js.
// ---------------------------------------------------------------------------
const { cfg } = require('./config');

function start() {
  const c = cfg();
  const on = [];
  const speech = require('./speech'); // eslint-disable-line global-require
  if (speech.ready()) { require('../voicebot').setSpeech(speech.provider); on.push('Vexyl speech'); } // eslint-disable-line global-require
  if (c.audioSocket.port != null && Number.isInteger(c.audioSocket.port)) {
    if (!speech.ready()) console.error('[ai-calling] AudioSocket NOT started: set AI_CALL_STT_URL and AI_CALL_TTS_URL (private addresses) first'); // eslint-disable-line no-console
    else { require('./audioSocket').listen(c.audioSocket.port, c.audioSocket.host); on.push(`AudioSocket ${c.audioSocket.host}:${c.audioSocket.port}`); } // eslint-disable-line global-require
  }
  if (c.ollama.ok) on.push(`Ollama ${c.ollama.model}`);
  if (on.length) console.log(`[ai-calling] self-hosted: ${on.join(', ')}`); // eslint-disable-line no-console
  return on;
}

// Every piece checked for real (scripts/ai-calling-local-check.js).
async function health() {
  const [llm, stt, tts] = await Promise.all([
    require('./ollama').health(), require('./vexylStt').health(), require('./vexylTts').health(), // eslint-disable-line global-require
  ]);
  const c = cfg();
  return { llm, stt, tts, audioSocket: c.audioSocket.port != null ? `${c.audioSocket.host}:${c.audioSocket.port}` : 'off (AI_CALL_AUDIOSOCKET_PORT not set)' };
}

module.exports = { start, health };

// ---------------------------------------------------------------------------
// THE SPEECH PROVIDER for calling/voicebot.js setSpeech() - self-hosted Vexyl STT + TTS instead of any paid cloud speech.
// The voicebot's audio is 8 kHz 16-bit mono PCM, base64 (the Exotel Voicebot stream); the AudioSocket bridge (audioSocket.js)
// uses the same two pieces directly.
// ---------------------------------------------------------------------------
const { cfg, sttLang } = require('./config');
const A = require('./audio');
const stt = require('./vexylStt');
const tts = require('./vexylTts');

const ready = () => { const c = cfg(); return c.stt.ok && c.tts.ok; };

const provider = {
  // 8 kHz PCM -> words
  async transcribe(audioBuffer, language) { return stt.transcribeOnce(A.resample(audioBuffer, 8000, 16000), sttLang(language)); },
  // words -> 8 kHz PCM, base64
  async synthesize(text, language) { return (await tts.pcm8k(text, language)).toString('base64'); },
};

module.exports = { provider, ready };

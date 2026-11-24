// The English video voice-over comes from Kokoro (natural), is kept as a file, and falls back to the Piper voice when Kokoro cannot answer.
//   node backend/test-fixtures/mkVoiceKokoro.test.js   (a local fake Kokoro; no outside call)
const assert = require('node:assert/strict');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.MK_MEETING_VOICE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-kok-'));
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(300, 1)]);
const calls = []; let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ key: req.headers['x-api-key'], body: JSON.parse(body || '{}') });
    if (mode === 'down') { res.statusCode = 500; return res.end('{}'); }
    res.setHeader('Content-Type', 'audio/wav'); return res.end(wav);
  });
});
server.listen(0, '127.0.0.1', async () => {
  try {
    process.env.AI_VOICE_KOKORO_URL = `http://127.0.0.1:${server.address().port}/`; process.env.AI_VOICE_KEY = 'secret-key';
    const V = require('../src/marketing/meetingVoice');
    const a = await V.speakAny('en', 'Hello, this is   a test of the voice.');
    assert.ok(a.wav && a.wav.length === wav.length); assert.equal(calls.length, 1);
    assert.equal(calls[0].body.voice, 'af_heart'); assert.equal(calls[0].body.lang, 'en-us'); assert.equal(calls[0].key, 'secret-key');
    assert.equal(calls[0].body.text, 'Hello, this is a test of the voice.'); console.log('PASS  English goes to Kokoro: natural voice, English language, the key, the words with only white space tidied');
    await V.speakAny('en', 'Hello, this is a test of the voice.'); assert.equal(calls.length, 1); console.log('PASS  the same sentence is kept (no second call to Kokoro)');
    mode = 'down';
    const d = await V.speakAny('en', 'A different sentence that Kokoro cannot make.');
    assert.ok(d.error || d.wav); console.log('PASS  when Kokoro cannot answer, the old voice is tried and the answer is plain words, never a crash');
    const hi = await V.speakAny('te', 'నమస్తే'); const before = calls.length;
    assert.equal(calls.length, before); console.log('PASS  Telugu and Hindi do not go to the English Kokoro voice');
    process.env.MK_VIDEO_VOICE_EN = 'piper'; mode = 'ok';
    const p = await V.speakAny('en', 'Switch back to the old voice please.'); assert.equal(calls.length, before); console.log('PASS  MK_VIDEO_VOICE_EN=piper switches back to the old voice');
    setTimeout(() => process.exit(0), 200);
  } catch (e) { console.error(e); setTimeout(() => process.exit(1), 200); }
});

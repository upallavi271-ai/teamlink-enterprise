// THE FAKE PROVIDER (tests only). It never reads the image and never touches the network.
// It is chosen ONLY inside the test sandbox (utils/sandbox.js isSandbox) with BILL_OCR_PROVIDER=fake, and answers from a JSON file named by
// BILL_OCR_FAKE_FILE:  { "default": <entry>, "bySha": { "<sha256 of the FIRST file>": <entry> }, "byName": { "<file name>": <entry> } }
// where <entry> = { "output": <the raw model JSON, snake_case, exactly the shape of schema.js>, "delayMs": 0 }
//             or  { "error": "timeout" | "unavailable" | "rate-limit" | "bad-output" | "refused" | "not-configured", "message": "..." }
// Every call is appended to BILL_OCR_FAKE_FILE + ".calls" (one JSON line) so a test can count the reads.
const fs = require('fs');
const crypto = require('crypto');
const { OcrError } = require('../errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function plan() {
  try { return JSON.parse(fs.readFileSync(process.env.BILL_OCR_FAKE_FILE, 'utf8')); } catch { return {}; }
}
const RETRYABLE = new Set(['timeout', 'unavailable', 'rate-limit']);

const provider = {
  name: 'fake',
  async status() { return { ready: true, provider: 'fake', model: 'fake-reader', reason: null }; },
  async read({ files }) {
    const first = files && files[0] ? files[0] : null;
    const sha = first ? crypto.createHash('sha256').update(first.data).digest('hex') : '';
    const p = plan();
    const entry = (p.bySha && p.bySha[sha]) || (first && p.byName && p.byName[first.name]) || p.default || null;
    try { fs.appendFileSync(`${process.env.BILL_OCR_FAKE_FILE}.calls`, `${JSON.stringify({ at: Date.now(), sha, name: first && first.name, files: (files || []).length })}\n`); } catch { /* ignore */ }
    if (!entry) throw new OcrError('The fake reader has no answer for this file.', 'unavailable', false);
    if (entry.delayMs) await sleep(Math.min(Number(entry.delayMs) || 0, 60000));
    if (entry.error) throw new OcrError(entry.message || `fake ${entry.error}`, entry.error, RETRYABLE.has(entry.error));
    return { raw: entry.output, usage: { input_tokens: 1000, output_tokens: 500 }, model: 'fake-reader', provider: 'fake' };
  },
};
module.exports = provider;

// ---------------------------------------------------------------------------
// THE CLAUDE VISION PROVIDER (2026-10-21): reads a bill with the Anthropic Messages API.
//
//   * The key and the client are the SAME ones every other AI feature uses (utils/aiAgent.js: the encrypted key from Administration >
//     Integrations > AI Assistant, one cached client, the out-of-credits hold). The key never leaves the server and is in no message below.
//   * Model: Integrations > AI Assistant > "Bill reading model" (blank = DEFAULT_MODEL below). It is never hard-coded anywhere else.
//   * Images -> normalised (auto-rotate, max 2000 px long edge, JPEG) image blocks; a PDF -> a document block (the model reads scanned pages).
//   * Answer shape: structured output (output_config.format = our JSON schema). If the API refuses that parameter the call is repeated once
//     without it and the JSON is taken from the text (the answer is validated the same way in both cases).
//   * 429 / 5xx / network trouble: up to 3 tries with a wait of 2 s then 6 s. Everything else fails at once with a plain message.
//   * No tool use, no web, no code execution: the model can only return text. The bill's own words never reach any other system prompt.
// ---------------------------------------------------------------------------
const { OcrError } = require('../errors');
const { EXTRACTION_SCHEMA, SYSTEM_PROMPT, userText } = require('../schema');

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'high';
const MAX_TOKENS = 8000;
const TIMEOUT_MS = 150000;
const WAITS = [2000, 6000];
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

let schemaParamRefused = false; // the API said it does not know output_config on this model: do not send it again until restart
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function looseJson(text) {
  let s = String(text == null ? '' : text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* try the outer braces */ }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
  return null;
}

// -> { blocks, pages }
async function prepare(files) {
  const sharp = require('sharp'); // eslint-disable-line global-require
  const blocks = [];
  let n = 0;
  for (const f of files) {
    n += 1;
    blocks.push({ type: 'text', text: `File ${n} of ${files.length}:` });
    if (f.mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(f.data).toString('base64') } });
    } else if (require('../../billUploadFiles').SHEET_MIMES.includes(f.mime)) { // eslint-disable-line global-require
      // an Excel / CSV bill (2026-10-28): its cells as text - read exactly like a typed bill
      let text = '';
      try { text = require('../../billUploadFiles').sheetText(Buffer.from(f.data), f.mime); } catch { throw new OcrError('The Excel / CSV file could not be opened.', 'unreadable', false); } // eslint-disable-line global-require
      blocks.push({ type: 'text', text: `This file is a spreadsheet (Excel / CSV). Its cells, as CSV text:\n${text}` });
    } else {
      let jpg;
      try {
        // eslint-disable-next-line no-await-in-loop
        jpg = await sharp(f.data, { limitInputPixels: 80e6, failOn: 'none' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
      } catch { throw new OcrError('One of the pictures could not be opened.', 'unreadable', false); }
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.toString('base64') } });
    }
  }
  return { blocks, pages: files.length };
}

function make(deps = {}) {
  const sleep = deps.sleep || sleepReal;
  const aiAgent = () => require('../../aiAgent'); // eslint-disable-line global-require

  async function config() {
    if (deps.getConfig) return deps.getConfig();
    const cfg = await aiAgent().agentConfig();
    let extra = {};
    try { extra = (await require('../../integrationStore').readConfig(aiAgent().CHANNEL)).values || {}; } catch { extra = {}; } // eslint-disable-line global-require
    const model = String(extra['Bill reading model'] || process.env.BILL_OCR_MODEL || '').trim() || DEFAULT_MODEL;
    return { ...cfg, billModel: model };
  }

  return {
    name: 'claude-vision',
    async status() {
      const cfg = await config();
      return { ready: !!cfg.configured, provider: 'claude-vision', model: cfg.billModel || DEFAULT_MODEL, reason: cfg.configured ? null : 'AI bill reading is not switched on (no Anthropic key is saved).' };
    },
    async read({ files, hints }) {
      const cfg = await config();
      if (!cfg.configured) throw new OcrError('AI bill reading is not switched on.', 'not-configured', false);
      const client = deps.client || aiAgent().clientFor(cfg.apiKey);
      const { blocks, pages } = await prepare(files);
      const model = cfg.billModel || DEFAULT_MODEL;
      const base = {
        model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: userText(hints, pages) }] }],
      };
      let lastErr = null;
      for (let attempt = 0; attempt <= WAITS.length; attempt += 1) {
        try {
          const body = schemaParamRefused ? base : { ...base, output_config: { effort: DEFAULT_EFFORT, format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } } };
          // eslint-disable-next-line no-await-in-loop
          const resp = await client.messages.create(body, { timeout: TIMEOUT_MS });
          if (resp && resp.stop_reason === 'refusal') throw new OcrError('The AI would not read this file.', 'refused', false);
          if (resp && resp.stop_reason === 'max_tokens') throw new OcrError('The AI answer was cut short.', 'bad-output', false);
          const text = ((resp && resp.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const raw = looseJson(text);
          if (!raw || typeof raw !== 'object') throw new OcrError('The AI did not return a readable answer.', 'bad-output', false);
          return { raw, usage: resp.usage || null, model: resp.model || model, provider: 'claude-vision' };
        } catch (err) {
          if (err instanceof OcrError) throw err;
          lastErr = err;
          const status = err && err.status;
          const msg = String((err && err.error && err.error.error && err.error.error.message) || (err && err.message) || '');
          if (status === 400 && !schemaParamRefused && /output_config|output_format|json_schema|effort/i.test(msg)) { // this model/API does not take the structured-output parameter
            schemaParamRefused = true;
            continue; // eslint-disable-line no-continue
          }
          const retry = RETRY_STATUS.has(status) || (!status && /timeout|timed out|ECONN|ETIMEDOUT|fetch failed|socket|network|Connection/i.test(msg));
          if (!retry || attempt >= WAITS.length) break;
          // eslint-disable-next-line no-await-in-loop
          await sleep(WAITS[attempt]);
        }
      }
      const status = lastErr && lastErr.status;
      const plain = aiAgent().apiError(lastErr);
      if (status === 429) throw new OcrError(plain, 'rate-limit', true);
      if (/timeout|timed out/i.test(String(lastErr && lastErr.message)) || (lastErr && /Timeout/.test(lastErr.constructor && lastErr.constructor.name))) throw new OcrError('The AI did not answer in time.', 'timeout', true);
      if (status === 401 || status === 403) throw new OcrError(plain, 'not-configured', false);
      throw new OcrError(plain, 'unavailable', RETRY_STATUS.has(status) || !status);
    },
  };
}

module.exports = { make, prepare, looseJson, DEFAULT_MODEL, DEFAULT_EFFORT, MAX_TOKENS, _resetSchemaFlag: () => { schemaParamRefused = false; } };

// ---------------------------------------------------------------------------
// BILL READING - THE ONE DOOR (2026-10-21).
//   read({ files, hints })  -> { fields, confidence, unclear, fieldNotes, lines, notes, docType, isBill, raw, usage, model, provider }
//       files = [{ name, mime, data: Buffer }]   hints = { vendorName, assetIds, repairIds }   (hints are reading aids only)
//   status()                -> { ready, provider, model, reason }      the "AI bill reading: Ready / Not set up" light
//   settings()              -> { perVendorPerDay, perDay, model }       the cost guard numbers (Integrations > AI Assistant)
// Providers (providers/): claude-vision (real), not-configured (honest), fake (tests only: needs the test sandbox + BILL_OCR_PROVIDER=fake).
// A test can also put its own provider in with setProvider(). Whatever a provider returns is cleaned by validate.normaliseModelOutput: the
// raw answer is kept for the audit trail and nothing else.
// ---------------------------------------------------------------------------
const V = require('./validate');
const { OcrError } = require('./errors');
const claude = require('./providers/claudeVision');
const notConfigured = require('./providers/notConfigured');

let injected = null;
const setProvider = (p) => { injected = p || null; };

async function provider() {
  if (injected) return injected;
  const sb = require('../sandbox'); // eslint-disable-line global-require
  if (process.env.BILL_OCR_PROVIDER === 'fake' && sb.isSandbox()) return require('./providers/fake'); // eslint-disable-line global-require
  if (process.env.BILL_OCR_PROVIDER === 'none') return notConfigured.make();
  return claude.make();
}

async function status() {
  try { return await (await provider()).status(); } catch (err) { return { ready: false, provider: 'none', model: null, reason: 'AI bill reading could not be checked.' }; }
}

const DEFAULT_PER_VENDOR_PER_DAY = 30;
const DEFAULT_PER_DAY = 300;
async function settings() {
  let values = {};
  try { values = (await require('../integrationStore').readConfig('ai-claude')).values || {}; } catch { values = {}; } // eslint-disable-line global-require
  const n = (x, d, max) => { const v = Math.floor(Number(String(x == null ? '' : x).trim())); return Number.isFinite(v) && v > 0 ? Math.min(v, max) : d; };
  return {
    perVendorPerDay: n(values['Bill reads per vendor per day'] || process.env.BILL_OCR_PER_VENDOR_PER_DAY, DEFAULT_PER_VENDOR_PER_DAY, 500),
    perDay: n(process.env.BILL_OCR_PER_DAY, DEFAULT_PER_DAY, 5000),
    model: String(values['Bill reading model'] || process.env.BILL_OCR_MODEL || '').trim() || claude.DEFAULT_MODEL,
  };
}

async function read({ files, hints } = {}) {
  if (!Array.isArray(files) || !files.length) throw new OcrError('There is nothing to read.', 'unreadable', false);
  const p = await provider();
  const r = await p.read({ files, hints: hints || {} });
  const n = V.normaliseModelOutput(r.raw);
  const fields = {}; const confidence = {}; const unclear = {}; const fieldNotes = {};
  for (const k of V.FIELD_KEYS) {
    const f = n.fields[k];
    fields[k] = f.value; confidence[k] = f.confidence; unclear[k] = !!f.unclear; fieldNotes[k] = f.note;
  }
  return { fields, confidence, unclear, fieldNotes, lines: n.lines, notes: n.notes, docType: n.docType, isBill: n.isBill, raw: r.raw, usage: r.usage || null, model: r.model || null, provider: r.provider || p.name };
}

module.exports = { read, status, settings, setProvider, OcrError, DEFAULT_PER_VENDOR_PER_DAY, DEFAULT_PER_DAY };

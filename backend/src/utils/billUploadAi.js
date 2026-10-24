// ---------------------------------------------------------------------------
// VENDOR BILL UPLOADS - THE READING JOB (2026-10-21).
// The AI is NEVER called inside the upload request. An upload only stores the files and queues the id here; a small in-process queue (2 at a
// time) picks it up, and a sweep (every minute, started in index.js, not in the test sandbox) re-queues anything that was left behind by a
// restart. Every step is a compare-and-set on the status, so a job that runs twice, or two servers, can never read or write a bill twice.
//
//   UPLOADED -> AI_PROCESSING (this job, with a run id) -> NEEDS_REVIEW | PENDING_APPROVAL (utils/billUploads.js revalidate)
//   * AI not switched on  -> no call, the bill goes to NEEDS_REVIEW with empty fields and a plain notice (meta.ai = 'off'); nothing is invented
//   * daily limit reached -> no call (meta.ai = 'limit'): per vendor (default 30 reads a day, Integrations > AI Assistant > "Bill reads per
//                            vendor per day") and for the whole company (default 300); a re-read asked by Accounts skips the vendor limit
//   * failure             -> up to 3 tries (a timeout, a 429 or a 5xx is retried after a wait); then NEEDS_REVIEW (meta.ai = 'failed')
//   * the model's raw answer is kept (rawJson), with the token usage, for the audit trail; the vendor never receives it.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./vmDb');
const BU = require('./billUploads');
const V = require('./billOcr/validate');
const OCR = require('./billOcr');
const { OcrError } = require('./billOcr/errors');

const S = BU.S;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 2;
const queue = []; const queued = new Set(); const again = new Set(); let running = 0;
const log = (...a) => console.error('[bill-upload-ai]', ...a); // eslint-disable-line no-console
const retryDelay = (attempts) => Number(process.env.BILL_AI_RETRY_MS || 30000) * Math.max(1, attempts);

function enqueue(id, delayMs = 0) {
  if (!id) return;
  if (queued.has(id)) { again.add(id); return; } // already waiting or running: run once more when it is done (a bill asked for again right after a reading)
  queued.add(id);
  const go = () => { queue.push(id); pump(); };
  if (delayMs > 0) setTimeout(go, delayMs); else setImmediate(go);
}
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running += 1;
    runAi(id).catch((err) => log(id, err && err.message)).finally(() => { running -= 1; queued.delete(id); if (again.delete(id)) enqueue(id); pump(); });
  }
}

// After the vendor sends a bill that was "Not sent yet": a bill that was already read (it was sent back) is only checked again.
async function afterSubmit(id) {
  const row = await BU.getRow(id);
  if (!row || row.status !== S.UPLOADED) return;
  if (row.rawJson || (row.meta && row.meta.ai)) await BU.revalidate(id); else enqueue(id);
}

async function dayStartIso() {
  const ist = require('./accounts').istDay(); // eslint-disable-line global-require
  return new Date(`${ist}T00:00:00+05:30`).toISOString();
}
async function budgetProblem(row, staff) {
  const st = await OCR.settings();
  const since = await dayStartIso();
  const [mine, all] = await Promise.all([
    DB.one(`SELECT COUNT(*) AS n FROM "VendorBillUploadEvent" WHERE "vendorId" = ? AND "kind" = 'ai-call' AND "field" = 'vendor' AND "createdAt" >= ?`, [row.vendorId, since]),
    DB.one(`SELECT COUNT(*) AS n FROM "VendorBillUploadEvent" WHERE "kind" = 'ai-call' AND "createdAt" >= ?`, [since]),
  ]);
  if (!staff && mine.n >= st.perVendorPerDay) return `This vendor has used its ${st.perVendorPerDay} AI readings for today.`;
  if (all.n >= st.perDay) return `The company limit of ${st.perDay} AI readings a day is used up.`;
  return null;
}

function mergeResult(row, res) {
  const meta = { ...(row.meta || {}) };
  const data = {};
  const vals = {};
  BU.FIELD_KEYS.forEach((k) => {
    if (meta[k] && meta[k].edited) { vals[k] = row[k]; return; } // a person's value stays
    vals[k] = res.fields[k];
    data[k] = res.fields[k];
    meta[k] = { confidence: res.confidence[k], unclear: !!res.unclear[k], note: res.fieldNotes[k] || null };
  });
  const lineObjs = meta.linesEdited ? null : res.lines;
  const d = V.derive({ subtotal: vals.subtotal, gst: vals.gst, total: vals.total, lines: lineObjs || [] });
  meta.derived = [];
  for (const k of d.derived) {
    if ((meta[k] && meta[k].edited) || res.unclear[k] || vals[k] != null) continue; // eslint-disable-line no-continue
    data[k] = d[k]; vals[k] = d[k]; meta[k] = { ...(meta[k] || {}), confidence: null, unclear: false, derived: true }; meta.derived.push(k);
  }
  if (vals.invoiceNo !== undefined) data.invoiceNoKey = vals.invoiceNo ? V.normInvoiceNo(vals.invoiceNo) : null;
  meta.ai = 'done'; meta.isBill = res.isBill; meta.docType = res.docType;
  return { data, meta, lines: lineObjs };
}

// One reading. Safe to call twice: only the call that wins the UPLOADED -> AI_PROCESSING move does anything.
async function runAi(id) {
  await BU.ensure();
  let row = await BU.getRow(id);
  if (!row || row.status !== S.UPLOADED) return;
  const runId = crypto.randomBytes(8).toString('hex');
  const staff = !!(row.meta && row.meta.rereadBy);
  const won = await BU.move(null, id, S.UPLOADED, S.AI_PROCESSING, { aiRunId: runId, aiStartedAt: BU.nowIso(), aiAttempts: (row.aiAttempts || 0) + 1, aiError: null });
  if (!won) return;
  row = await BU.getRow(id);
  await BU.event(null, row, { kind: 'ai-start', actorKind: 'System', actorName: 'TeamLink', note: 'Reading the bill.' });
  const finish = async (ai, plain, errText) => {
    const meta = { ...(row.meta || {}), ai }; delete meta.rereadBy;
    const n = await BU.patch(null, id, { metaJson: JSON.stringify(meta), aiError: errText || null, aiFinishedAt: BU.nowIso(), aiNotes: plain || row.aiNotes || null }, [S.AI_PROCESSING], { aiRunId: runId });
    if (!n) return;
    await BU.event(null, row, { kind: ai === 'failed' ? 'ai-failed' : 'ai-skipped', actorKind: 'System', actorName: 'TeamLink', note: ai === 'failed' ? 'The automatic reading did not work. Accounts will check the bill.' : 'Accounts will read this bill and type the details.' });
    if (errText || plain) await BU.event(null, row, { kind: 'ai-info', actorKind: 'System', actorName: 'TeamLink', note: errText || plain, visible: false });
    await BU.revalidate(id);
  };
  try {
    const st = await OCR.status();
    if (!st.ready) return await finish('off', 'AI reading is not switched on.', null);
    const limit = await budgetProblem(row, staff);
    if (limit) return await finish('limit', limit, null);
    const vendor = await BU.vendorOf(row.vendorId);
    const files = BU.loadFiles(row);
    await BU.event(null, row, { kind: 'ai-call', field: staff ? 'staff' : 'vendor', actorKind: 'System', actorName: 'TeamLink', note: `${st.provider}${st.model ? ` ${st.model}` : ''}`, visible: false });
    let hints = { vendorName: vendor ? vendor.name : null };
    try {
      const M = await require('./assetVendorPortal').ensureMask(); // eslint-disable-line global-require
      if (row.assetId) { const a = await prisma.asset.findUnique({ where: { id: row.assetId } }); if (a) hints.assetIds = [M.code(a)]; }
      if (row.repairId) { const r = await prisma.assetRepair.findUnique({ where: { id: row.repairId } }); if (r) hints.repairIds = [r.repairNo]; }
    } catch { hints = { vendorName: hints.vendorName }; }
    const res = await OCR.read({ files, hints });
    row = await BU.getRow(id);
    if (!row || row.status !== S.AI_PROCESSING || row.aiRunId !== runId) return undefined; // replaced / re-run meanwhile: this answer is not used
    const merged = mergeResult(row, res);
    delete merged.meta.rereadBy;
    const raw = JSON.stringify(res.raw);
    const ok = await prisma.$transaction(async (tx) => {
      const n = await BU.patch(tx, id, {
        ...merged.data, metaJson: JSON.stringify(merged.meta), rawJson: raw.length <= 300000 ? raw : JSON.stringify({ truncated: true, note: 'The answer was larger than 300 KB and was not kept.' }), docType: res.docType,
        aiNotes: res.notes || null, aiProvider: res.provider || null, aiModel: res.model || null, aiUsageJson: res.usage ? JSON.stringify(res.usage) : null, aiFinishedAt: BU.nowIso(), aiError: null, aiReads: (row.aiReads || 0) + 1,
      }, [S.AI_PROCESSING], { aiRunId: runId });
      if (!n) return false;
      if (merged.lines) {
        await DB.run('DELETE FROM "VendorBillUploadLine" WHERE "uploadId" = ?', [id], tx);
        let i = 0;
        for (const l of merged.lines) {
          i += 1;
          // eslint-disable-next-line no-await-in-loop
          await DB.run('INSERT INTO "VendorBillUploadLine" ("id","uploadId","lineNo","description","quantity","rate","amount","confidence","unclear","note","edited","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [BU.newId('bl'), id, i, l.description, l.quantity, l.rate, l.amount, l.confidence, l.unclear ? 1 : 0, l.note, 0, BU.nowIso()], tx);
        }
      }
      return true;
    });
    if (!ok) return undefined;
    await BU.event(null, row, { kind: 'ai-read', actorKind: 'System', actorName: 'TeamLink', note: 'The bill was read. Please check the details.', visible: true });
    await BU.event(null, row, { kind: 'ai-result', actorKind: 'System', actorName: 'TeamLink', note: `${res.provider || ''} ${res.model || ''}; ${res.lines.length} line(s); ${res.usage ? JSON.stringify(res.usage).slice(0, 200) : ''}`, visible: false });
    await BU.revalidate(id);
    return undefined;
  } catch (err) {
    const code = err instanceof OcrError ? err.code : 'unavailable';
    const plain = err instanceof OcrError ? err.message : (err && err.code === 'MISSING_FILE' ? 'The stored file could not be found.' : 'The reading failed.');
    if (code === 'not-configured') return finish('off', plain, null);
    const fresh = await BU.getRow(id);
    if (!fresh || fresh.status !== S.AI_PROCESSING || fresh.aiRunId !== runId) return undefined;
    const retryable = err instanceof OcrError ? err.retryable : false;
    if (retryable && (fresh.aiAttempts || 0) < MAX_ATTEMPTS) {
      const n = await BU.move(null, id, S.AI_PROCESSING, S.UPLOADED, { aiError: plain, aiFinishedAt: BU.nowIso() });
      if (n) { await BU.event(null, fresh, { kind: 'ai-retry', actorKind: 'System', actorName: 'TeamLink', note: `Try ${fresh.aiAttempts} did not work (${plain}). Trying again.`, visible: false }); setTimeout(() => enqueue(id), retryDelay(fresh.aiAttempts)); }
      return undefined;
    }
    row = fresh;
    return finish('failed', plain, plain);
  }
}

// ---- the sweep: bills left behind by a restart --------------------------------------------------------------------------------------
async function sweep() {
  try {
    await BU.ensure();
    const stale = new Date(Date.now() - 20000).toISOString();
    const old = new Date(Date.now() - 6 * 60000).toISOString();
    const waiting = await DB.q(`SELECT "id" FROM "VendorBillUpload" WHERE "status" = 'UPLOADED' AND COALESCE("aiFinishedAt","uploadedAt") < ? LIMIT 50`, [stale]);
    waiting.forEach((r) => enqueue(r.id));
    const stuck = await DB.q(`SELECT "id","aiAttempts" FROM "VendorBillUpload" WHERE "status" = 'AI_PROCESSING' AND "aiStartedAt" < ? LIMIT 50`, [old]);
    for (const r of stuck) {
      // eslint-disable-next-line no-await-in-loop
      const row = await BU.getRow(r.id);
      if (!row) continue; // eslint-disable-line no-continue
      if ((row.aiAttempts || 0) < MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        if (await BU.move(null, row.id, S.AI_PROCESSING, S.UPLOADED, { aiError: 'The reading took too long.' })) enqueue(row.id);
      } else {
        const meta = { ...(row.meta || {}), ai: 'failed' };
        // eslint-disable-next-line no-await-in-loop
        if (await BU.patch(null, row.id, { metaJson: JSON.stringify(meta), aiError: 'The reading took too long.', aiFinishedAt: BU.nowIso() }, [S.AI_PROCESSING])) await BU.revalidate(row.id); // eslint-disable-line no-await-in-loop
      }
    }
  } catch (err) { log('sweep', err && err.message); }
}
let timer = null;
function start() {
  if (timer) return;
  const ms = Number(process.env.BILL_AI_SWEEP_MS || 60000);
  if (!(ms > 0)) return;
  timer = setInterval(sweep, ms);
  if (timer.unref) timer.unref();
  setTimeout(sweep, 15000).unref();
}

// Accounts asks for a new reading: the bill goes back to UPLOADED and is queued (the vendor limit is skipped for this one).
async function requestReread(row, actor) {
  if (!BU.REVIEW_STATES.includes(row.status)) return { ok: false, error: `This bill is ${BU.LABEL[row.status].toLowerCase()}, so it cannot be read again.` };
  const meta = { ...(row.meta || {}), rereadBy: { id: actor.id, name: actor.name } };
  const n = await BU.move(null, row.id, row.status, S.UPLOADED, { metaJson: JSON.stringify(meta), aiAttempts: 0, aiError: null });
  if (!n) return { ok: false, error: 'Someone else changed this bill. Open it again.' };
  await BU.event(null, row, { kind: 'reread', actorKind: 'Company', actorName: actor.name, actorId: actor.id, note: `${actor.name} asked for the bill to be read again.`, visible: false });
  enqueue(row.id);
  return { ok: true };
}

module.exports = { enqueue, afterSubmit, runAi, sweep, start, requestReread, budgetProblem, mergeResult, MAX_ATTEMPTS, _state: () => ({ running, queued: queued.size }) };

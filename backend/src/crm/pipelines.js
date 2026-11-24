// ---------------------------------------------------------------------------
// CRM WAVE D - DEALS & PIPELINE (2026-11-24)
//   pipelines          several pipelines (one per product / business line), each with its own stages in the Admin's order; the
//                      first one ("Sales pipeline") keeps the eight stages the reports are built on and may get extra stages in between
//   stage rules        per stage: the fields a deal must have to ENTER it (value, close date, contact, next step, product lines, a
//                      proposal, a file) and a checklist that must be ticked before the deal LEAVES it (guided selling)
//   stage log          every stage a deal stood on (entered / left / who) -> time in stage, and the velocity analysis
//   bulk edit          many deals at once: owner, stage, close date, probability, forecast category (each deal checked on its own)
//   forecast           categories (Pipeline / Best case / Commit / Omitted) per deal, a salesperson's monthly forecast, the manager's adjustment
//   splits             the credit of a deal shared among salespeople (percent, total 100)
//   recurring revenue  billing period + term on a deal (or on its product lines) -> MRR / ARR; a renewal deal made from a won one
//                      (by hand; by itself 60 days before the renewal only when the Admin turns it on)
// Who sees what stays crm/service.js (scopeSql / canSeeRow / canEditRow).
// ---------------------------------------------------------------------------
const S = require('./service');
const SETTINGS = require('./settings');
const P = require('./plusSchema');

const { STAGES } = SETTINGS;
const CORE_OPEN = STAGES.filter((s) => !['Won', 'Lost'].includes(s));
const REQUIRED_FIELDS = { value: 'Deal value', expectedClose: 'Expected close date', contactId: 'Contact person', nextStep: 'Next step', lines: 'Product lines', proposal: 'A proposal', file: 'A file (quotation / PO)', notes: 'Notes' };
const FORECAST_CATS = ['Pipeline', 'Best case', 'Commit', 'Omitted'];
const BILLINGS = ['One-time', 'Monthly', 'Quarterly', 'Yearly'];
const PER_MONTH = { Monthly: 1, Quarterly: 1 / 3, Yearly: 1 / 12 };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const cents = (n) => Math.round(Number(n || 0) * 100) / 100;
const daysBetween = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 86400000);
const istYmd = (iso) => (iso ? new Date(Date.parse(iso) + 5.5 * 3600000).toISOString().slice(0, 10) : null);
const addMonths = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + (Number(n) || 0)); return d.toISOString().slice(0, 10); };

// ---- pipelines (AppSetting crm.plus.pipelines) ----------------------------------------------------------------------------
const cleanStage = (x) => {
  const name = String((x && x.name) || '').trim().slice(0, 40);
  const prob = x && x.probability !== null && x.probability !== undefined && x.probability !== '' ? Math.round(Number(x.probability)) : NaN;
  return {
    name,
    probability: Number.isFinite(prob) && prob >= 0 && prob <= 100 ? prob : null,
    required: [...new Set((Array.isArray(x && x.required) ? x.required : []).filter((f) => REQUIRED_FIELDS[f]))],
    checklist: [...new Set((Array.isArray(x && x.checklist) ? x.checklist : String((x && x.checklist) || '').split('\n')).map((c) => String(c || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 12),
    mustTick: !!(x && x.mustTick),
  };
};
function defaultPipeline() { return { id: 'default', name: 'Sales pipeline', stages: CORE_OPEN.map((name) => ({ name, probability: null, required: [], checklist: [], mustTick: false })) }; }
function normalize(raw) {
  const list = Array.isArray(raw && raw.pipelines) ? raw.pipelines : [];
  const seenP = new Set();
  const out = [];
  const def = list.find((p) => p && p.id === 'default') || defaultPipeline();
  [def, ...list.filter((p) => p && p.id !== 'default')].forEach((p, i) => {
    const id = i === 0 ? 'default' : String(p.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    const name = String(p.name || '').trim().slice(0, 60) || (i === 0 ? 'Sales pipeline' : '');
    if (!id || !name || seenP.has(id) || seenP.has(name.toLowerCase())) return;
    seenP.add(id); seenP.add(name.toLowerCase());
    const seen = new Set(['won', 'lost']);
    let stages = (Array.isArray(p.stages) ? p.stages : []).map(cleanStage).filter((s) => s.name && !seen.has(s.name.toLowerCase()) && seen.add(s.name.toLowerCase())).slice(0, 15);
    if (id === 'default') {
      // the eight stages every report reads stay on the first pipeline, in their order; extra stages sit where the Admin put them
      CORE_OPEN.forEach((c, ci) => {
        if (!stages.some((s) => s.name === c)) {
          const after = ci === 0 ? -1 : stages.findIndex((s) => s.name === CORE_OPEN[ci - 1]);
          stages.splice(after + 1, 0, cleanStage({ name: c }));
        }
      });
      const coreIdx = stages.filter((s) => CORE_OPEN.includes(s.name)).map((s) => s.name);
      if (coreIdx.join('|') !== CORE_OPEN.join('|')) {
        // the core stages were reordered: put them back in their order, keeping the extra ones after the core stage they followed
        const extrasAfter = {}; let last = '';
        stages.forEach((s) => { if (CORE_OPEN.includes(s.name)) last = s.name; else (extrasAfter[last] = extrasAfter[last] || []).push(s); });
        const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
        stages = [...(extrasAfter[''] || []), ...CORE_OPEN.flatMap((c) => [byName[c], ...(extrasAfter[c] || [])])];
      }
    }
    if (!stages.length) return;
    out.push({ id, name, stages });
  });
  return { pipelines: out.slice(0, 12) };
}
async function load() { return normalize(await P.getCfg('pipelines', { pipelines: [defaultPipeline()] })); }
const loadSync = () => normalize(P.cachedCfg('pipelines', { pipelines: [defaultPipeline()] }));
const pipelineOf = (cfg, id) => cfg.pipelines.find((p) => p.id === (id || 'default')) || cfg.pipelines[0];
const stageNames = (pl) => [...pl.stages.map((s) => s.name), 'Won', 'Lost'];
function probabilityOf(pl, stage) {
  if (stage === 'Won') return 100;
  if (stage === 'Lost') return 0;
  const st = pl.stages.find((s) => s.name === stage);
  if (st && st.probability != null && !(pl.id === 'default' && CORE_OPEN.includes(stage))) return st.probability;
  const fromSettings = SETTINGS.current().stageProbability[stage];
  if (fromSettings != null) return fromSettings;
  const i = pl.stages.findIndex((s) => s.name === stage);
  return Math.round(10 + (80 * Math.max(0, i)) / Math.max(1, pl.stages.length - 1));
}
// what the screen needs: the pipelines with each stage's probability worked out
async function config() {
  const cfg = await load();
  return { pipelines: cfg.pipelines.map((pl) => ({ ...pl, stages: pl.stages.map((s) => ({ ...s, probability: probabilityOf(pl, s.name), core: pl.id === 'default' && CORE_OPEN.includes(s.name) })), allStages: stageNames(pl) })), requiredFields: REQUIRED_FIELDS, forecastCategories: FORECAST_CATS, billings: BILLINGS };
}

async function savePipelines(user, body = {}) {
  const r = S.roleOf(user);
  if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin can change the pipelines.');
  const next = normalize({ pipelines: (Array.isArray(body.pipelines) ? body.pipelines : []).map((p) => ({ ...p, id: p.id || `pl_${Math.random().toString(36).slice(2, 9)}` })) });
  // a stage (or a whole pipeline) that still has open deals cannot go: move those deals first
  const open = await P.all('SELECT "pipelineId", "stage", COUNT(*) AS "n" FROM "CrmDeal" WHERE "stage" NOT IN (\'Won\', \'Lost\') GROUP BY "pipelineId", "stage"');
  for (const o of open) {
    const pl = next.pipelines.find((p) => p.id === (o.pipelineId || 'default'));
    if (!pl) return S.fail(400, `A pipeline you removed still has ${o.n} open deal(s). Move them to another pipeline first.`);
    if (!pl.stages.some((s) => s.name === o.stage) && !(pl.id === 'default' && CORE_OPEN.includes(o.stage))) return S.fail(400, `The stage "${o.stage}" of "${pl.name}" still has ${o.n} open deal(s). Move them before removing the stage.`);
  }
  await P.setCfg('pipelines', next);
  await S.audit(user, 'CRM pipelines changed', 'CrmSettings', 'pipelines', next.pipelines.map((p) => `${p.name}: ${p.stages.length} stages`).join('; '));
  return S.okBody({ ok: true, ...(await config()) });
}

// ---- hooks called by crm/service.js ---------------------------------------------------------------------------------------
// A new deal: its pipeline (default the first), its stage (default the pipeline's first stage), the probability of that stage.
async function prepareNewDeal(row, body = {}) {
  await P.ensure();
  const cfg = await load();
  const wanted = String(body.pipelineId || '').slice(0, 40);
  if (wanted && !cfg.pipelines.some((p) => p.id === wanted)) return { error: 'Pick a pipeline from the list.' };
  const pl = pipelineOf(cfg, wanted);
  const open = pl.stages.map((s) => s.name);
  row.pipelineId = pl.id === 'default' ? null : pl.id;
  row.stage = open.includes(body.stage) ? body.stage : open[0];
  if (body.probability == null || body.probability === '') row.probability = probabilityOf(pl, row.stage);
  if (body.forecastCategory && FORECAST_CATS.includes(body.forecastCategory)) row.forecastCategory = body.forecastCategory;
  if (body.billing && BILLINGS.includes(body.billing)) row.billing = body.billing;
  const tm = Math.round(Number(body.termMonths));
  if (Number.isFinite(tm) && tm >= 1 && tm <= 120) row.termMonths = tm;
  return { ok: true };
}
const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '' && !(typeof v === 'number' && v === 0);
async function missingFor(deal, stageDef) {
  const miss = [];
  for (const f of stageDef.required || []) {
    if (f === 'lines') { const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmDealLine" WHERE "dealId" = ?', deal.id); if (!Number(n && n.n)) miss.push(REQUIRED_FIELDS[f]); } // eslint-disable-line no-await-in-loop
    else if (f === 'proposal') { const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmProposal" WHERE "dealId" = ?', deal.id); if (!Number(n && n.n)) miss.push(REQUIRED_FIELDS[f]); } // eslint-disable-line no-await-in-loop
    else if (f === 'file') { const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmDealFile" WHERE "dealId" = ?', deal.id); if (!Number(n && n.n)) miss.push(REQUIRED_FIELDS[f]); } // eslint-disable-line no-await-in-loop
    else if (!filled(deal[f])) miss.push(REQUIRED_FIELDS[f]);
  }
  return miss;
}
const ticksOf = (deal) => P.parse(deal.checklistJson, {});
// Before a deal moves: the stage must be one of its pipeline's; entering a stage needs its required fields; leaving a stage forward needs its
// checklist ticked when the Admin made the checklist a must. Lost is always allowed (with its reason, crm/service.js).
async function checkMove(deal, stage) {
  await P.ensure();
  const cfg = await load();
  const pl = pipelineOf(cfg, deal.pipelineId);
  const names = stageNames(pl);
  if (!names.includes(stage)) return { status: 400, error: `Pick a stage of the "${pl.name}" pipeline.` };
  if (stage !== 'Lost') {
    const target = pl.stages.find((s) => s.name === stage);
    const need = target ? await missingFor(deal, target) : [];
    const from = pl.stages.find((s) => s.name === deal.stage);
    const forward = names.indexOf(stage) > names.indexOf(deal.stage) || stage === 'Won';
    const notTicked = from && from.mustTick && forward ? from.checklist.filter((c) => !(ticksOf(deal)[from.name] || {})[c]) : [];
    if (need.length || notTicked.length) {
      const parts = [need.length ? `fill in ${need.join(', ')}` : '', notTicked.length ? `tick the "${from.name}" checklist (${notTicked.join('; ')})` : ''].filter(Boolean);
      return { status: 400, error: `Before this deal moves to ${stage}, ${parts.join(' and ')}.`, extra: { missing: need, checklist: notTicked } };
    }
  }
  return { ok: true, probability: probabilityOf(pl, stage), pipelineId: pl.id };
}
// the stage log: the current stage gets a line when the deal is made; a move closes the open line and opens the next
async function logStage(deal, stage, user, at = new Date().toISOString()) {
  await P.ensure();
  await P.run('UPDATE "CrmDealStageLog" SET "leftAt" = ? WHERE "dealId" = ? AND "leftAt" IS NULL', at, deal.id);
  await P.run('INSERT INTO "CrmDealStageLog" ("id", "dealId", "pipelineId", "stage", "enteredAt", "leftAt", "byId", "byName") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    S.newId('dsl'), deal.id, deal.pipelineId || 'default', stage, at, ['Won', 'Lost'].includes(stage) ? at : null, user ? user.id : null, user ? user.name || null : null);
}
// an old deal (made before the stage log) gets its history worked out from the "Stage: A -> B" lines of its timeline, once
async function backfillLog(deal) {
  const have = await P.one('SELECT COUNT(*) AS "n" FROM "CrmDealStageLog" WHERE "dealId" = ?', deal.id);
  if (Number(have && have.n)) return;
  const acts = await P.all('SELECT "subject", "at", "byId", "byName" FROM "CrmActivity" WHERE "dealId" = ? AND "subject" LIKE \'Stage: %\' ORDER BY "at" ASC', deal.id);
  const rows = []; let cur = null;
  const first = acts.length ? (/^Stage:\s*(.+?)\s*→/.exec(acts[0].subject) || [])[1] : deal.stage;
  rows.push({ stage: first || deal.stage, enteredAt: deal.createdAt, byId: deal.createdById, byName: deal.ownerName });
  acts.forEach((a) => { const to = (/→\s*(.+)$/.exec(a.subject) || [])[1]; if (to) { cur = { stage: to.trim(), enteredAt: a.at, byId: a.byId, byName: a.byName }; rows.push(cur); } });
  for (let i = 0; i < rows.length; i += 1) {
    const left = rows[i + 1] ? rows[i + 1].enteredAt : (['Won', 'Lost'].includes(rows[i].stage) ? rows[i].enteredAt : null);
    // eslint-disable-next-line no-await-in-loop
    await P.run('INSERT INTO "CrmDealStageLog" ("id", "dealId", "pipelineId", "stage", "enteredAt", "leftAt", "byId", "byName") VALUES (?, ?, ?, ?, ?, ?, ?, ?)', S.newId('dsl'), deal.id, deal.pipelineId || 'default', rows[i].stage, rows[i].enteredAt, left, rows[i].byId || null, rows[i].byName || null);
  }
}
async function afterCreate(user, deal) { await logStage(deal, deal.stage, user, deal.createdAt); }
async function afterMove(user, before, after) {
  await backfillLog(before);
  await logStage(after, after.stage, user, after.updatedAt);
}

// ---- checklist ticks, pipeline change ----------------------------------------------------------------------------------
async function tick(user, dealId, { stage, item, done } = {}) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canEditRow(user, r, deal)) return S.fail(deal && S.canSeeRow(user, r, deal) ? 403 : 404, 'You cannot change this deal.');
  const pl = pipelineOf(await load(), deal.pipelineId);
  const st = pl.stages.find((s) => s.name === stage);
  if (!st || !st.checklist.includes(item)) return S.fail(400, 'This item is not on the stage checklist.');
  const ticks = ticksOf(deal);
  ticks[stage] = ticks[stage] || {};
  if (done) ticks[stage][item] = { by: user.name || null, at: new Date().toISOString() }; else delete ticks[stage][item];
  const saved = await S.update('CrmDeal', deal.id, { checklistJson: JSON.stringify(ticks), updatedAt: new Date().toISOString() });
  return S.okBody({ ok: true, deal: saved, ticks });
}
async function changePipeline(user, dealId, { pipelineId, stage } = {}) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canEditRow(user, r, deal)) return S.fail(deal && S.canSeeRow(user, r, deal) ? 403 : 404, 'You cannot change this deal.');
  if (['Won', 'Lost'].includes(deal.stage)) return S.fail(400, 'A won or lost deal stays in its pipeline.');
  const cfg = await load();
  const pl = cfg.pipelines.find((p) => p.id === pipelineId);
  if (!pl) return S.fail(400, 'Pick a pipeline from the list.');
  const st = pl.stages.some((s) => s.name === stage) ? stage : pl.stages[0].name;
  const now = new Date().toISOString();
  await backfillLog(deal);
  const saved = await S.update('CrmDeal', deal.id, { pipelineId: pl.id === 'default' ? null : pl.id, stage: st, probability: probabilityOf(pl, st), updatedAt: now });
  await logStage(saved, st, user, now);
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Pipeline: moved to ${pl.name} (${st})`, at: now, dealId: deal.id, accountId: deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, 'CRM deal moved to another pipeline', 'CrmDeal', deal.id, `${deal.title}: ${pl.name} / ${st}`);
  return S.okBody({ ok: true, deal: saved });
}

// ---- stage history (time in stage) -----------------------------------------------------------------------------------------
async function history(user, dealId) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canSeeRow(user, r, deal)) return S.fail(404, 'This deal is not there, or it is not yours.');
  await P.ensure();
  await backfillLog(deal);
  const rows = await P.all('SELECT * FROM "CrmDealStageLog" WHERE "dealId" = ? ORDER BY "enteredAt" ASC, "rowid" ASC', deal.id);
  const now = new Date().toISOString();
  const out = rows.map((x) => ({ ...x, days: Math.round(daysBetween(x.enteredAt, x.leftAt || now) * 10) / 10, current: !x.leftAt }));
  const byStage = {};
  out.forEach((x) => { byStage[x.stage] = Math.round(((byStage[x.stage] || 0) + x.days) * 10) / 10; });
  const cur = out.filter((x) => x.current).pop();
  const pl = pipelineOf(await load(), deal.pipelineId);
  const stageDef = pl.stages.find((s) => s.name === deal.stage);
  return S.okBody({ history: out, byStage, daysInStage: cur ? cur.days : 0, stageSince: cur ? cur.enteredAt : null, pipeline: { id: pl.id, name: pl.name }, checklist: stageDef ? stageDef.checklist : [], mustTick: !!(stageDef && stageDef.mustTick), ticks: ticksOf(deal), stages: pl.stages.map((s) => ({ name: s.name, required: s.required.map((f) => REQUIRED_FIELDS[f]), checklist: s.checklist, mustTick: s.mustTick })) });
}
// For a list of deals: since when each stands on its stage (the board shows "N days in stage")
async function stageSince(ids) {
  if (!ids.length) return {};
  await P.ensure();
  const out = {};
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    (await P.all(`SELECT "dealId", MAX("enteredAt") AS "at" FROM "CrmDealStageLog" WHERE "dealId" IN (${part.map(() => '?').join(',')}) GROUP BY "dealId"`, ...part)).forEach((x) => { out[x.dealId] = x.at; });
  }
  return out;
}

// ---- bulk edit of deals --------------------------------------------------------------------------------------------------
async function bulk(user, { ids, set } = {}) {
  const r = S.roleOf(user);
  if (!S.mayEdit(r) || !S.can(user, 'edit')) return S.fail(403, 'Your CRM rights do not allow changing deals.');
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).slice(0, 60)))].slice(0, 500);
  if (!list.length) return S.fail(400, 'Tick the deals to change.');
  const s = set || {};
  const fields = {};
  if (s.expectedClose !== undefined) { if (s.expectedClose && !YMD.test(s.expectedClose)) return S.fail(400, 'Please pick a proper close date.'); fields.expectedClose = s.expectedClose || null; }
  if (s.probability !== undefined && s.probability !== '') { const p = Math.round(Number(s.probability)); if (!(p >= 0 && p <= 100)) return S.fail(400, 'Probability is 0 to 100.'); fields.probability = p; }
  if (s.forecastCategory !== undefined) { if (s.forecastCategory && !FORECAST_CATS.includes(s.forecastCategory)) return S.fail(400, 'Pick a forecast category.'); fields.forecastCategory = s.forecastCategory || null; }
  if (s.nextStep !== undefined) fields.nextStep = S.clip(s.nextStep);
  const ownerId = s.ownerId ? String(s.ownerId).slice(0, 60) : null;
  if (ownerId && !S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin can give deals to another salesperson.');
  const stage = s.stage ? String(s.stage).slice(0, 40) : null;
  if (!Object.keys(fields).length && !ownerId && !stage) return S.fail(400, 'Pick what to change.');
  let changed = 0; const failed = [];
  for (const id of list) {
    /* eslint-disable no-await-in-loop */
    const row = await S.getRow('deal', id);
    if (!S.canEditRow(user, r, row)) { failed.push({ id, name: row ? row.title : id, reason: 'not yours to change' }); continue; } // eslint-disable-line no-continue
    let ok = true;
    if (Object.keys(fields).length || ownerId) {
      const out = await S.edit(user, 'deal', id, { ...fields, ...(ownerId ? { ownerId } : {}) });
      if (out.status !== 200) { ok = false; failed.push({ id, name: row.title, reason: out.body.error }); }
    }
    if (ok && stage && stage !== row.stage) {
      const out = await S.moveDeal(user, id, { stage, lostReason: s.lostReason });
      if (out.status !== 200) { ok = false; failed.push({ id, name: row.title, reason: out.body.error }); }
    }
    if (ok) changed += 1;
    /* eslint-enable no-await-in-loop */
  }
  await S.audit(user, 'CRM deals changed in bulk', 'CrmDeal', `${list.length} deals`, `${changed} changed, ${failed.length} not: ${JSON.stringify({ ...fields, ownerId, stage })}`);
  return S.okBody({ ok: true, changed, failed });
}

// ---- recurring revenue ----------------------------------------------------------------------------------------------------
// MRR of one deal: its recurring product lines (after their own discount, then the deal discount), else its value x its billing period
function mrrOf(deal, lines = []) {
  const disc = 1 - (Number(deal.discountPercent) || 0) / 100;
  const rec = lines.filter((l) => PER_MONTH[l.billing]);
  if (lines.length) return cents(rec.reduce((n, l) => n + l.qty * l.unitPrice * (1 - (Number(l.discountPercent) || 0) / 100) * PER_MONTH[l.billing], 0) * disc);
  return PER_MONTH[deal.billing] ? cents((deal.finalValue != null ? deal.finalValue : deal.value) * PER_MONTH[deal.billing]) : 0;
}
const termOf = (deal) => Number(deal.termMonths) || 12;
const renewalDateOf = (deal) => (deal.wonAt ? addMonths(istYmd(deal.wonAt), termOf(deal)) : null);
async function linesByDeal(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    if (part.length) (await P.all(`SELECT * FROM "CrmDealLine" WHERE "dealId" IN (${part.map(() => '?').join(',')}) ORDER BY "sort"`, ...part)).forEach((l) => { (out[l.dealId] = out[l.dealId] || []).push(l); });
  }
  return out;
}
async function recurring(user) {
  const r = S.roleOf(user);
  const sc = S.scopeSql(user, r, 'x.');
  await P.ensure();
  const won = await P.all(`SELECT x.*, a."name" AS "accountName" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE x."stage" = 'Won' AND ${sc.sql}`, ...sc.params);
  const lines = await linesByDeal(won.map((d) => d.id));
  const today = S.istToday();
  const rows = won.map((d) => ({ id: d.id, title: d.title, code: d.code, accountName: d.accountName, ownerName: d.ownerName, billing: d.billing || null, termMonths: termOf(d), wonOn: istYmd(d.wonAt), renewalDate: renewalDateOf(d), renewalDealId: d.renewalDealId || null, mrr: mrrOf(d, lines[d.id] || []) }))
    .filter((d) => d.mrr > 0);
  const active = rows.filter((d) => !d.renewalDate || d.renewalDate >= today);
  const mrr = cents(active.reduce((n, d) => n + d.mrr, 0));
  const soon = addMonths(today, 3); // renewals in the next three months that have no renewal deal yet
  const due = active.filter((d) => d.renewalDate && d.renewalDate <= soon && !d.renewalDealId).sort((a, b) => String(a.renewalDate).localeCompare(String(b.renewalDate)));
  return S.okBody({ mrr, arr: cents(mrr * 12), active: active.length, deals: active.sort((a, b) => b.mrr - a.mrr), renewalsDue: due.slice(0, 50), settings: await renewalSettings() });
}
async function renewalSettings() { const v = await P.getCfg('renewals', {}); return { autoRenewalDeals: v.autoRenewalDeals === true, daysBefore: [30, 45, 60, 90].includes(Number(v.daysBefore)) ? Number(v.daysBefore) : 60 }; }
async function saveRenewalSettings(user, body = {}) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Only a Sales manager or an Admin can change this.');
  const next = { autoRenewalDeals: body.autoRenewalDeals === true, daysBefore: [30, 45, 60, 90].includes(Number(body.daysBefore)) ? Number(body.daysBefore) : 60 };
  await P.setCfg('renewals', next);
  await S.audit(user, 'CRM renewal settings changed', 'CrmSettings', 'renewals', JSON.stringify(next));
  return S.okBody({ ok: true, settings: next });
}
// A renewal deal from a won recurring deal: same account, contact, owner, product lines and billing; closes on the renewal date.
async function makeRenewal(user, deal, { auto = false } = {}) {
  if (deal.renewalDealId) { const d = await S.getRow('deal', deal.renewalDealId); if (d) return { deal: d, already: true }; }
  const lines = await P.all('SELECT * FROM "CrmDealLine" WHERE "dealId" = ? ORDER BY "sort"', deal.id);
  const renewOn = renewalDateOf(deal) || addMonths(S.istToday(), 12);
  const out = await S.create(user, 'deal', { title: `${deal.title} - renewal ${renewOn.slice(0, 7)}`, accountId: deal.accountId, contactId: deal.contactId, value: deal.value, expectedClose: renewOn, nextStep: 'Confirm the renewal: users, plan and price', ownerId: deal.ownerId, pipelineId: deal.pipelineId || undefined, billing: deal.billing || undefined, termMonths: deal.termMonths || undefined });
  if (out.status !== 200) return { error: out.body.error };
  const nd = out.body.deal;
  const now = new Date().toISOString();
  for (const [i, l] of lines.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await P.run('INSERT INTO "CrmDealLine" ("id", "dealId", "productKey", "plan", "name", "qty", "unitPrice", "listPrice", "discountPercent", "billing", "bundle", "rule", "sort", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('dln'), nd.id, l.productKey, l.plan, l.name, l.qty, l.unitPrice, l.listPrice, l.discountPercent, l.billing, l.bundle, l.rule, i, now);
  }
  await S.update('CrmDeal', nd.id, { renewalOfId: deal.id, discountPercent: deal.discountPercent || null, finalValue: deal.finalValue != null ? deal.finalValue : deal.value, approvalStatus: deal.approvalStatus === 'Approved' ? 'Approved' : 'None' });
  await S.update('CrmDeal', deal.id, { renewalDealId: nd.id });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Renewal deal made${auto ? ' by itself' : ''}: ${nd.code || nd.title} (closes ${renewOn})`, at: now, dealId: deal.id, accountId: deal.accountId, byId: auto ? null : user.id, byName: auto ? 'CRM (renewals)' : user.name || null, createdAt: now });
  return { deal: await S.getRow('deal', nd.id) };
}
async function renewal(user, dealId) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canEditRow(user, r, deal)) return S.fail(deal && S.canSeeRow(user, r, deal) ? 403 : 404, 'You cannot make a renewal of this deal.');
  if (deal.stage !== 'Won') return S.fail(400, 'A renewal is made from a won deal.');
  const out = await makeRenewal(user, deal);
  if (out.error) return S.fail(400, out.error);
  return S.okBody({ ok: true, deal: out.deal, already: !!out.already });
}
// by itself (OFF unless the Admin turns it on): won recurring deals whose renewal date is within N days get their renewal deal
async function renewalTick() {
  const st = await renewalSettings();
  if (!st.autoRenewalDeals) return { made: 0, off: true };
  await P.ensure();
  const won = await P.all('SELECT * FROM "CrmDeal" WHERE "stage" = \'Won\' AND "renewalDealId" IS NULL AND "wonAt" IS NOT NULL');
  const lines = await linesByDeal(won.map((d) => d.id));
  const horizon = new Date(Date.now() + 5.5 * 3600000 + st.daysBefore * 86400000).toISOString().slice(0, 10);
  let made = 0;
  for (const d of won) {
    const due = renewalDateOf(d);
    if (!due || due > horizon || mrrOf(d, lines[d.id] || []) <= 0) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const out = await makeRenewal({ id: d.ownerId, name: 'CRM (renewals)', role: 'SUPER_ADMIN' }, d, { auto: true }).catch(() => ({ error: 'x' }));
    if (!out.error && !out.already) made += 1;
  }
  return { made };
}

// ---- splits -------------------------------------------------------------------------------------------------------------
async function splits(user, dealId) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canSeeRow(user, r, deal)) return S.fail(404, 'This deal is not there, or it is not yours.');
  const rows = await P.all('SELECT * FROM "CrmDealSplit" WHERE "dealId" = ? ORDER BY "percent" DESC', deal.id);
  return S.okBody({ splits: rows.length ? rows : [{ id: null, userId: deal.ownerId, name: deal.ownerName, percent: 100, role: 'Owner' }], custom: rows.length > 0, canEdit: S.canEditRow(user, r, deal), people: await S.ownerOptions() });
}
async function saveSplits(user, dealId, { splits: list } = {}) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canEditRow(user, r, deal)) return S.fail(deal && S.canSeeRow(user, r, deal) ? 403 : 404, 'You cannot change this deal.');
  const people = new Map((await S.ownerOptions()).map((o) => [o.id, o.name]));
  if (deal.ownerId && !people.has(deal.ownerId)) people.set(deal.ownerId, deal.ownerName);
  const clean = []; const seen = new Set();
  for (const x of (Array.isArray(list) ? list : []).slice(0, 10)) {
    const uid = String((x && x.userId) || '').slice(0, 60);
    const pct = Math.round(Number(x && x.percent) * 100) / 100;
    if (!people.has(uid)) return S.fail(400, 'Pick each person from the sales team.');
    if (seen.has(uid)) return S.fail(400, 'A person is listed twice.');
    if (!(pct > 0 && pct <= 100)) return S.fail(400, 'Each share is more than 0 and at most 100 percent.');
    seen.add(uid); clean.push({ userId: uid, name: people.get(uid), percent: pct, role: S.clip(x.role, 40) });
  }
  const total = Math.round(clean.reduce((n, x) => n + x.percent, 0) * 100) / 100;
  if (clean.length && Math.abs(total - 100) > 0.01) return S.fail(400, `The shares add up to ${total}%. They must add up to 100%.`);
  await P.run('DELETE FROM "CrmDealSplit" WHERE "dealId" = ?', deal.id);
  const now = new Date().toISOString();
  for (const x of clean) await P.run('INSERT INTO "CrmDealSplit" ("id", "dealId", "userId", "name", "percent", "role", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)', S.newId('dsp'), deal.id, x.userId, x.name, x.percent, x.role, now); // eslint-disable-line no-await-in-loop
  await S.audit(user, 'CRM deal credit split', 'CrmDeal', deal.id, clean.map((x) => `${x.name} ${x.percent}%`).join(', ') || 'owner 100%');
  return splits(user, dealId);
}

// ---- forecast ---------------------------------------------------------------------------------------------------------
const autoCategory = (d) => (d.forecastCategory && FORECAST_CATS.includes(d.forecastCategory) ? d.forecastCategory : (d.probability >= 80 ? 'Commit' : d.probability >= 50 ? 'Best case' : 'Pipeline'));
async function forecast(user, { month } = {}) {
  const r = S.roleOf(user);
  const ym = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : S.istToday().slice(0, 7);
  const sc = S.scopeSql(user, r, 'x.');
  await P.ensure();
  const deals = await P.all(`SELECT x.*, a."name" AS "accountName" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${sc.sql} AND ((x."stage" NOT IN ('Won', 'Lost') AND substr(x."expectedClose", 1, 7) = ?) OR (x."stage" = 'Won' AND x."wonAt" IS NOT NULL))`, ...sc.params, ym);
  const fv = (d) => (d.finalValue != null ? d.finalValue : d.value) || 0;
  const people = {};
  const row = (id, name) => { people[id] = people[id] || { ownerId: id, ownerName: name, won: 0, commit: 0, bestCase: 0, pipeline: 0, omitted: 0, deals: [] }; return people[id]; };
  deals.forEach((d) => {
    if (d.stage === 'Won') { if (istYmd(d.wonAt).slice(0, 7) !== ym) return; const p = row(d.ownerId, d.ownerName); p.won += fv(d); return; }
    const p = row(d.ownerId, d.ownerName); const cat = autoCategory(d);
    if (cat === 'Commit') p.commit += fv(d); else if (cat === 'Best case') p.bestCase += fv(d); else if (cat === 'Omitted') p.omitted += fv(d); else p.pipeline += fv(d);
    p.deals.push({ id: d.id, title: d.title, accountName: d.accountName, value: fv(d), probability: d.probability, category: cat, set: !!d.forecastCategory, expectedClose: d.expectedClose, stage: d.stage });
  });
  const subs = await P.all('SELECT * FROM "CrmForecast" WHERE "month" = ?', ym);
  const seeIds = new Set(Object.keys(people));
  subs.forEach((s) => { if (S.seesAll(r) || s.ownerId === user.id || seeIds.has(s.ownerId)) { const p = row(s.ownerId, s.ownerName); p.submission = s; } });
  const rows = Object.values(people).map((p) => ({ ...p, won: cents(p.won), commit: cents(p.commit), bestCase: cents(p.bestCase), pipeline: cents(p.pipeline), omitted: cents(p.omitted), autoCommit: cents(p.won + p.commit), autoBestCase: cents(p.won + p.commit + p.bestCase), final: cents(p.submission && p.submission.managerCommit != null ? p.submission.managerCommit : p.submission && p.submission.commit != null ? p.submission.commit : p.won + p.commit) }))
    .sort((a, b) => b.final - a.final);
  const sum = (k) => cents(rows.reduce((n, x) => n + (x[k] || 0), 0));
  return S.okBody({ month: ym, rows, totals: { won: sum('won'), autoCommit: sum('autoCommit'), autoBestCase: sum('autoBestCase'), pipeline: sum('pipeline'), final: sum('final') }, canAdjust: S.mayAssign(r), categories: FORECAST_CATS });
}
async function submitForecast(user, { month, commit, bestCase, note } = {}) {
  const r = S.roleOf(user);
  if (!S.mayEdit(r)) return S.fail(403, 'A viewer does not submit a forecast.');
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return S.fail(400, 'Pick the month.');
  const c = S.num(commit); const b = S.num(bestCase);
  if (c == null) return S.fail(400, 'Write your commit amount.');
  if (b != null && b < c) return S.fail(400, 'Best case is at least the commit amount.');
  await P.ensure();
  const now = new Date().toISOString();
  const have = await P.one('SELECT * FROM "CrmForecast" WHERE "ownerId" = ? AND "month" = ?', user.id, month);
  if (have) await P.run('UPDATE "CrmForecast" SET "commit" = ?, "bestCase" = ?, "note" = ?, "submittedAt" = ?, "updatedAt" = ? WHERE "id" = ?', c, b, S.clip(note, 500), now, now, have.id);
  else await P.run('INSERT INTO "CrmForecast" ("id", "ownerId", "ownerName", "month", "commit", "bestCase", "note", "submittedAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('fc'), user.id, user.name || null, month, c, b, S.clip(note, 500), now, now);
  await S.audit(user, 'CRM forecast submitted', 'CrmForecast', `${user.id}:${month}`, `commit ${c}, best case ${b == null ? '-' : b}`);
  return forecast(user, { month });
}
async function adjustForecast(user, { month, ownerId, managerCommit, managerBestCase, managerNote } = {}) {
  const r = S.roleOf(user);
  if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin adjusts a forecast.');
  if (!/^\d{4}-\d{2}$/.test(String(month || '')) || !ownerId) return S.fail(400, 'Pick the month and the salesperson.');
  const c = managerCommit === '' || managerCommit == null ? null : S.num(managerCommit);
  const b = managerBestCase === '' || managerBestCase == null ? null : S.num(managerBestCase);
  await P.ensure();
  const now = new Date().toISOString();
  const have = await P.one('SELECT * FROM "CrmForecast" WHERE "ownerId" = ? AND "month" = ?', String(ownerId).slice(0, 60), month);
  const name = have ? have.ownerName : ((await S.ownerOptions()).find((o) => o.id === ownerId) || {}).name || null;
  if (have) await P.run('UPDATE "CrmForecast" SET "managerCommit" = ?, "managerBestCase" = ?, "managerNote" = ?, "adjustedByName" = ?, "adjustedAt" = ?, "updatedAt" = ? WHERE "id" = ?', c, b, S.clip(managerNote, 500), user.name || null, now, now, have.id);
  else await P.run('INSERT INTO "CrmForecast" ("id", "ownerId", "ownerName", "month", "managerCommit", "managerBestCase", "managerNote", "adjustedByName", "adjustedAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('fc'), String(ownerId).slice(0, 60), name, month, c, b, S.clip(managerNote, 500), user.name || null, now, now);
  await S.audit(user, 'CRM forecast adjusted', 'CrmForecast', `${ownerId}:${month}`, `commit ${c == null ? '-' : c}, best case ${b == null ? '-' : b}`, S.clip(managerNote, 300) || undefined);
  return forecast(user, { month });
}

// ---- analysis: win rate, cycle length, time per stage, conversion, velocity, split credit ----------------------------------------
async function analysis(user, { pipeline, from, to } = {}) {
  const r = S.roleOf(user);
  const sc = S.scopeSql(user, r, 'x.');
  await P.ensure();
  const cfg = await load();
  const pl = pipelineOf(cfg, pipeline);
  const where = [sc.sql, pl.id === 'default' ? '(x."pipelineId" IS NULL OR x."pipelineId" = \'default\')' : 'x."pipelineId" = ?'];
  const params = [...sc.params, ...(pl.id === 'default' ? [] : [pl.id])];
  const deals = await P.all(`SELECT x.* FROM "CrmDeal" x WHERE ${where.join(' AND ')}`, ...params);
  const f = YMD.test(String(from || '')) ? from : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const t = YMD.test(String(to || '')) ? to : S.istToday();
  const inRange = (iso) => { const d = istYmd(iso); return d && d >= f && d <= t; };
  const logged = new Set((await P.all('SELECT DISTINCT "dealId" FROM "CrmDealStageLog"')).map((x) => x.dealId));
  for (const d of deals.filter((x) => !logged.has(x.id)).slice(0, 2000)) await backfillLog(d); // eslint-disable-line no-await-in-loop
  const ids = deals.map((d) => d.id);
  const logs = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    if (part.length) logs.push(...(await P.all(`SELECT * FROM "CrmDealStageLog" WHERE "dealId" IN (${part.map(() => '?').join(',')}) ORDER BY "enteredAt"`, ...part)));
  }
  const names = stageNames(pl);
  const now = new Date().toISOString();
  const fv = (d) => (d.finalValue != null ? d.finalValue : d.value) || 0;
  const won = deals.filter((d) => d.stage === 'Won' && inRange(d.wonAt));
  const lost = deals.filter((d) => d.stage === 'Lost' && inRange(d.lostAt || d.updatedAt));
  const open = deals.filter((d) => !['Won', 'Lost'].includes(d.stage));
  const winRate = won.length + lost.length ? won.length / (won.length + lost.length) : 0;
  const avgWon = won.length ? won.reduce((n, d) => n + fv(d), 0) / won.length : 0;
  const cycles = won.map((d) => daysBetween(d.createdAt, d.wonAt));
  const avgCycle = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : 0;
  const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const byDeal = {};
  logs.forEach((l) => { (byDeal[l.dealId] = byDeal[l.dealId] || []).push(l); });
  const stages = pl.stages.map((st, i) => {
    const rows = logs.filter((l) => l.stage === st.name);
    const entered = new Set(rows.map((l) => l.dealId));
    const later = new Set(names.slice(i + 1).filter((n) => n !== 'Lost'));
    const movedOn = [...entered].filter((id) => (byDeal[id] || []).some((l) => later.has(l.stage))).length;
    const days = rows.map((l) => daysBetween(l.enteredAt, l.leftAt || now));
    const openHere = open.filter((d) => d.stage === st.name);
    return { stage: st.name, entered: entered.size, movedOn, conversion: entered.size ? Math.round((movedOn / entered.size) * 1000) / 10 : null, avgDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null, open: openHere.length, openValue: cents(openHere.reduce((n, d) => n + fv(d), 0)) };
  });
  const openValue = open.reduce((n, d) => n + fv(d), 0);
  const velocity = avgCycle > 0 ? (open.length * winRate * avgWon) / avgCycle : 0;
  const owners = {};
  [...won, ...lost].forEach((d) => { const o = owners[d.ownerId] = owners[d.ownerId] || { ownerId: d.ownerId, ownerName: d.ownerName, won: 0, lost: 0, wonValue: 0, cycle: [] }; if (d.stage === 'Won') { o.won += 1; o.wonValue += fv(d); o.cycle.push(daysBetween(d.createdAt, d.wonAt)); } else o.lost += 1; });
  // credit with splits: each won deal's final value shared as its splits say (no split = all to the owner)
  const splitRows = won.length ? await P.all(`SELECT * FROM "CrmDealSplit" WHERE "dealId" IN (${won.map(() => '?').join(',')})`, ...won.map((d) => d.id)) : [];
  const credit = {};
  won.forEach((d) => {
    const sp = splitRows.filter((s) => s.dealId === d.id);
    (sp.length ? sp : [{ userId: d.ownerId, name: d.ownerName, percent: 100 }]).forEach((s) => { const c = credit[s.userId] = credit[s.userId] || { userId: s.userId, name: s.name, deals: 0, credit: 0 }; c.deals += 1; c.credit += (fv(d) * s.percent) / 100; });
  });
  return S.okBody({
    pipeline: { id: pl.id, name: pl.name }, pipelines: cfg.pipelines.map((p) => ({ id: p.id, name: p.name })), from: f, to: t,
    summary: { open: open.length, openValue: cents(openValue), won: won.length, lost: lost.length, winRate: Math.round(winRate * 1000) / 10, avgWonValue: cents(avgWon), avgCycleDays: Math.round(avgCycle * 10) / 10, medianCycleDays: Math.round(median(cycles) * 10) / 10, velocityPerDay: cents(velocity), velocityPerMonth: cents(velocity * 30) },
    stages,
    owners: Object.values(owners).map((o) => ({ ownerId: o.ownerId, ownerName: o.ownerName, won: o.won, lost: o.lost, winRate: o.won + o.lost ? Math.round((o.won / (o.won + o.lost)) * 1000) / 10 : 0, wonValue: cents(o.wonValue), avgCycleDays: o.cycle.length ? Math.round((o.cycle.reduce((a, b) => a + b, 0) / o.cycle.length) * 10) / 10 : null })).sort((a, b) => b.wonValue - a.wonValue),
    credit: Object.values(credit).map((c) => ({ ...c, credit: cents(c.credit) })).sort((a, b) => b.credit - a.credit),
  });
}

// The open stages a dashboard groups by: the first pipeline's (with the Admin's extra stages) and then any other stage an open deal stands
// on (another pipeline's), so no open deal drops out of a pipeline chart. A sync read of the last loaded pipelines.
function reportStages(stagesPresent = []) {
  const first = loadSync().pipelines[0];
  const base = first ? first.stages.map((s) => s.name) : CORE_OPEN;
  const extra = [...new Set(stagesPresent)].filter((s) => s && !base.includes(s) && !['Won', 'Lost'].includes(s));
  return [...base, ...extra];
}
// the probability of a stage of any pipeline (for the weighted forecast of a chart)
function probabilityFor(stage) {
  const cfg = loadSync();
  const pl = cfg.pipelines.find((p) => p.stages.some((s) => s.name === stage)) || cfg.pipelines[0];
  return probabilityOf(pl, stage);
}

module.exports = {
  reportStages, probabilityFor, load, loadSync, config, savePipelines, prepareNewDeal, checkMove, afterCreate, afterMove, tick, changePipeline, history, stageSince, bulk,
  recurring, renewal, renewalTick, renewalSettings, saveRenewalSettings, mrrOf, splits, saveSplits, forecast, submitForecast, adjustForecast, analysis,
  autoCategory, pipelineOf, stageNames, probabilityOf, FORECAST_CATS, BILLINGS, REQUIRED_FIELDS, CORE_OPEN,
};

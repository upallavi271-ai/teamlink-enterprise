// ---------------------------------------------------------------------------
// CRM WAVE D - THE FEW PLACES crm/service.js CALLS OUT (2026-11-24), kept in one file so service.js changes stay a handful of lines:
//   beforeCreate / afterCreate   a deal's pipeline + first stage + stage log; a lead / account's territory
//   beforeEdit / afterEdit       field security (hidden / read-only fields), the deal's forecast / billing fields, the value of a deal
//                                that has product lines; the field history
//   checkMove / afterMove        the deal's own pipeline stages, required fields and checklist; the stage log
//   invoiceLines                 the Won invoice carries the deal's product lines
// Every hook is safe to fail: a problem here never loses a save (the callers catch and go on), except the rules that refuse on purpose.
// ---------------------------------------------------------------------------
const P = require('./plusSchema');

const PL = () => require('./pipelines'); // eslint-disable-line global-require
const CO = () => require('./collab'); // eslint-disable-line global-require
const CA = () => require('./catalog'); // eslint-disable-line global-require

function dealExtras(data) {
  const { FORECAST_CATS, BILLINGS } = PL();
  if ('forecastCategory' in data && data.forecastCategory && !FORECAST_CATS.includes(data.forecastCategory)) return 'Pick a forecast category: Pipeline, Best case, Commit or Omitted.';
  if ('billing' in data && data.billing && !BILLINGS.includes(data.billing)) return 'Billing is One-time, Monthly, Quarterly or Yearly.';
  if ('termMonths' in data && data.termMonths != null && !(data.termMonths >= 1 && data.termMonths <= 120)) return 'The term is 1 to 120 months.';
  return null;
}
async function beforeCreate(user, kind, row, body = {}) {
  await P.ensure();
  if (kind !== 'deal') return { ok: true };
  const bad = dealExtras(row);
  if (bad) return { error: bad };
  return PL().prepareNewDeal(row, body);
}
async function afterCreate(user, kind, saved, body = {}) {
  try {
    if (kind === 'deal') await PL().afterCreate(user, saved);
    if (kind === 'lead' || kind === 'account') return (await CO().afterCreateRecord(user, kind, saved, body)) || saved;
  } catch (e) { console.error('[crm-plus] after create:', e.message); } // eslint-disable-line no-console
  return saved;
}
async function beforeEdit(user, kind, row, data, body = {}) {
  await P.ensure();
  const fs = CO().beforeEdit(user, kind, row, data);
  if (fs.error) return { status: 403, error: fs.error };
  if (kind === 'deal') {
    const bad = dealExtras(data);
    if (bad) return { status: 400, error: bad };
    if ('value' in data && !body.__fromLines && Number(data.value) !== Number(row.value)) {
      const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmDealLine" WHERE "dealId" = ?', row.id);
      if (Number(n && n.n)) return { status: 400, error: 'This deal\'s value is the sum of its product lines. Change the lines (Products tab) instead.' };
    }
  }
  return { ok: true };
}
async function afterEdit(user, kind, before, after) {
  try { await CO().afterEdit(user, kind, before, after); } catch (e) { console.error('[crm-plus] field history:', e.message); } // eslint-disable-line no-console
}
async function checkMove(row, stage) { return PL().checkMove(row, stage); }
async function afterMove(user, before, after) {
  try { await PL().afterMove(user, before, after); } catch (e) { console.error('[crm-plus] stage log:', e.message); } // eslint-disable-line no-console
}
async function invoiceLines(deal, amount, st) {
  try { return await CA().invoiceLinesFor(deal, amount, st); } catch (e) { console.error('[crm-plus] invoice lines:', e.message); return null; } // eslint-disable-line no-console
}
// sub-team managers read their team's records (crm/service.js scopeSql / canSeeRow); a sync read of the last loaded teams
function managedIds(userId) { try { return CO().managedIds(userId); } catch { return []; } }

module.exports = { beforeCreate, afterCreate, beforeEdit, afterEdit, checkMove, afterMove, invoiceLines, managedIds };

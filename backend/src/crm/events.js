// ---------------------------------------------------------------------------
// CRM EVENTS (wave A, 2026-11-24): one place every CRM change is announced. crm/service.js, crm/sales.js and crm/extra.js call
// emit('deal.won', { kind: 'deal', record, before, user }) after they saved; here it goes, after the request has answered, to
//   1. the admins' own rules (crm/automation.js)          - only while "Rules run by themselves" is on
//   2. the outside webhooks (crm/connect.js)             - only while "Webhooks" is on
//   3. Slack / Microsoft Teams (crm/connect.js)          - only while "Slack / Teams posts" is on, and only the ticked events
// A change a rule made carries depth = 1, so rules never set each other off in a loop (a rule's change is still sent to webhooks).
// emit() never throws and never slows the request that caused it.
// ---------------------------------------------------------------------------
const listeners = [];
const recent = []; // the last events, for the tests and the Automation screen's "what happened" line
function on(fn) { listeners.push(fn); }

function emit(event, payload = {}) {
  const p = { ...payload, event, at: new Date().toISOString(), depth: Number(payload.depth) || 0 };
  recent.unshift({ event, kind: p.kind, id: p.record && p.record.id, at: p.at, via: p.via || null, depth: p.depth });
  if (recent.length > 50) recent.length = 50;
  setImmediate(async () => {
    try {
      const C = require('./connect'); // eslint-disable-line global-require
      await C.deliverEvent(event, p).catch(() => 0);
      await C.chatEvent(event, p).catch(() => 0);
      if (p.depth < 1) await require('./automation').onEvent(event, p).catch((e) => console.error('[crm] rules:', e.message)); // eslint-disable-line global-require, no-console
      for (const fn of listeners) await Promise.resolve(fn(event, p)).catch(() => {}); // eslint-disable-line no-await-in-loop
    } catch { /* an event never breaks the CRM */ }
  });
}
// the same, from a place that has only ids (crm/sales.js autoStage, crm/money.js): the record is read first
async function emitFor(event, kind, id, extra = {}) {
  try {
    const S = require('./service'); // eslint-disable-line global-require
    const table = { lead: 'lead', deal: 'deal', account: 'account', contact: 'contact', task: 'CrmTask', invoice: 'CrmInvoice', activity: 'CrmActivity' }[kind];
    const record = await S.getRow(table, id);
    if (record) emit(event, { kind, record, ...extra });
  } catch { /* never breaks the caller */ }
}

module.exports = { emit, emitFor, on, recent };

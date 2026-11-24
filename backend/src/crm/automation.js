// ---------------------------------------------------------------------------
// CRM WAVE A - THE ADMINS' OWN RULES (2026-11-24; 08.01 workflow rules, 08.02 time triggers, 08.05 field updates, 08.08 approvals,
// 08.09 the visual builder's data, 08.12 scripts). A Sales manager / Admin writes "WHEN this happens, IF these are true, DO these":
//
//   WHEN   a CRM event (lead added / changed / moved, deal added / moved / won / lost, follow-up done, invoice paid ...), or
//          a DATE: N days before / after a lead's or deal's date (expected close, added on, last activity = "no activity for N days"),
//          an invoice's due date or a follow-up's date. A date rule fires once per record per date.
//   IF     conditions on the record's fields (all of them, or any one), incl. "changed" / "changed to" for change events
//   DO     in order: change a field, give it to an owner (or the next salesperson in turn), add a follow-up, write a note,
//          a bell to the owner / managers / a person, a mail (to the owner, the managers, or the lead / contact itself), a webhook,
//          a Slack / Teams post, WAIT (minutes / hours / days, optionally "only if still ..." = SLA and escalation), ASK FOR APPROVAL
//          (one to five steps, each a different person; can hold the deal back from Won until approved), a small SCRIPT (Admin only).
//
// NOTHING RUNS until an Admin turns on "Rules run by themselves" (crm.wave switches) AND the rule itself is on. Scripts need their own
// switch. A change a rule makes is announced with depth 1: rules never set each other off in a loop. Every run is logged (CrmRuleRun).
// Records are touched as "Rule: <name>"; what a rule writes is never counted as somebody's logged work.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const vm = require('vm');
const W = require('./waveSchema');
const S = require('./service');
const DB = require('./schema');
const SETTINGS = require('./settings');
const { notifyUsers } = require('../utils/notify');

const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const now = () => new Date().toISOString();
const isManager = (user) => ['admin', 'tl'].includes(S.roleOf(user));
const isAdmin = (user) => S.roleOf(user) === 'admin';
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + (Number(n) || 0)); return d.toISOString().slice(0, 10); };

// ---- what a rule may listen to, look at and do ------------------------------------------------------------------------------------
const TRIGGERS = [
  ['lead.created', 'lead', 'A lead is added'], ['lead.updated', 'lead', 'A lead is changed'], ['lead.stage_changed', 'lead', 'A lead moves to another stage'], ['lead.converted', 'lead', 'A lead is converted'],
  ['deal.created', 'deal', 'A deal is added'], ['deal.updated', 'deal', 'A deal is changed'], ['deal.stage_changed', 'deal', 'A deal moves to another stage'], ['deal.won', 'deal', 'A deal is won'], ['deal.lost', 'deal', 'A deal is lost'],
  ['account.created', 'account', 'A customer / account is added'], ['account.updated', 'account', 'A customer / account is changed'],
  ['activity.logged', 'activity', 'A call, meeting, email or note is logged'], ['task.done', 'task', 'A follow-up is done'],
  ['invoice.created', 'invoice', 'An invoice is raised'], ['invoice.paid', 'invoice', 'An invoice is paid in full'],
  ['time', null, 'On a date (days before / after)'],
];
const TRIGGER_KIND = Object.fromEntries(TRIGGERS.map(([k, kind]) => [k, kind]));
// [key, words, type] type: s text, n number, d date, o owner
const FIELDS = {
  lead: [['company', 'Company', 's'], ['contactName', 'Contact person', 's'], ['source', 'Source', 's'], ['status', 'Status', 's'], ['stage', 'Stage', 's'], ['rating', 'Rating', 's'], ['industry', 'Industry', 's'], ['city', 'City', 's'], ['expectedValue', 'Expected value', 'n'], ['ownerId', 'Owner', 'o'], ['createdAt', 'Added on', 'd'], ['lastActivityAt', 'Last activity', 'd']],
  deal: [['title', 'Deal name', 's'], ['stage', 'Stage', 's'], ['value', 'Value', 'n'], ['finalValue', 'Value after discount', 'n'], ['discountPercent', 'Discount %', 'n'], ['probability', 'Probability %', 'n'], ['expectedClose', 'Expected close', 'd'], ['nextStep', 'Next step', 's'], ['approvalStatus', 'Discount approval', 's'], ['lostReason', 'Lost reason', 's'], ['ownerId', 'Owner', 'o'], ['createdAt', 'Added on', 'd'], ['lastActivityAt', 'Last activity', 'd']],
  account: [['name', 'Name', 's'], ['kind', 'Prospect / Client', 's'], ['industry', 'Industry', 's'], ['city', 'City', 's'], ['state', 'State', 's'], ['source', 'Source', 's'], ['ownerId', 'Owner', 'o'], ['createdAt', 'Added on', 'd']],
  activity: [['kind', 'What it was (call, meeting, email, whatsapp, note)', 's'], ['subject', 'Subject', 's'], ['note', 'Note', 's'], ['byName', 'Logged by', 's']],
  task: [['title', 'Follow-up', 's'], ['type', 'Type', 's'], ['priority', 'Priority', 's'], ['outcome', 'What came of it', 's'], ['dueDate', 'Due date', 'd'], ['ownerId', 'Owner', 'o']],
  invoice: [['code', 'Number', 's'], ['accountName', 'Customer', 's'], ['status', 'Status', 's'], ['total', 'Total', 'n'], ['paidAmount', 'Paid', 'n'], ['issueDate', 'Issued on', 'd'], ['dueDate', 'Due date', 'd'], ['ownerId', 'Owner', 'o']],
};
const FIELD_TYPE = (kind, f) => ((FIELDS[kind] || []).find((x) => x[0] === f) || [])[2];
// the dates a time rule can count from (SQL, India date)
const IST = (col) => `date(datetime(${col}, '+330 minutes'))`;
const LAST_ACT = (col) => `COALESCE((SELECT MAX(a."at") FROM "CrmActivity" a WHERE a."${col}" = x."id" AND a."byId" IS NOT NULL), x."createdAt")`;
const TIME_FIELDS = {
  lead: { table: 'CrmLead', fields: { createdAt: ['Added on', IST('x."createdAt"')], lastActivityAt: ['Last activity (no activity for N days)', IST(LAST_ACT('leadId'))] } },
  deal: { table: 'CrmDeal', fields: { expectedClose: ['Expected close', 'x."expectedClose"'], createdAt: ['Added on', IST('x."createdAt"')], wonAt: ['Won on', IST('x."wonAt"')], lastActivityAt: ['Last activity (no activity for N days)', IST(LAST_ACT('dealId'))] } },
  account: { table: 'CrmAccount', fields: { createdAt: ['Added on', IST('x."createdAt"')] } },
  task: { table: 'CrmTask', fields: { dueDate: ['Due date', 'x."dueDate"'] } },
  invoice: { table: 'CrmInvoice', fields: { dueDate: ['Due date', 'x."dueDate"'], issueDate: ['Issued on', 'x."issueDate"'] } },
};
const OPS = {
  eq: 'is', ne: 'is not', contains: 'contains', not_contains: 'does not contain', gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most',
  empty: 'is empty', not_empty: 'is not empty', in: 'is one of (comma list)', changed: 'changed', changed_to: 'changed to',
};
const UPDATABLE = {
  lead: { rating: ['Hot', 'Warm', 'Cold'], source: null, industry: null, city: null, expectedValue: null, status: ['Junk'] },
  deal: { probability: null, nextStep: null, expectedClose: null },
  account: { industry: null, city: null, tags: null },
  task: { priority: ['High', 'Medium', 'Low'] },
};
const ACTIONS = {
  update_field: 'Change a field', assign: 'Give it to an owner', create_task: 'Add a follow-up', add_note: 'Write a note on the record',
  notify: 'Bell notice', email: 'Send a mail', webhook: 'Send a webhook', chat: 'Post to Slack / Teams', wait: 'Wait', approval: 'Ask for approval', script: 'Run a script (Admin)',
};

// ---- records ----------------------------------------------------------------------------------------------------------------------
const TABLE = { lead: 'CrmLead', deal: 'CrmDeal', account: 'CrmAccount', contact: 'CrmContact', task: 'CrmTask', activity: 'CrmActivity', invoice: 'CrmInvoice' };
async function load(kind, id) {
  if (!TABLE[kind] || !id) return null;
  const row = await DB.one(`SELECT * FROM "${TABLE[kind]}" WHERE "id" = ?`, String(id));
  if (!row) return null;
  if (kind === 'lead' || kind === 'deal') {
    const col = kind === 'lead' ? 'leadId' : 'dealId';
    const a = await DB.one(`SELECT MAX("at") AS "t" FROM "CrmActivity" WHERE "${col}" = ? AND "byId" IS NOT NULL`, row.id).catch(() => null);
    row.lastActivityAt = (a && a.t) || row.createdAt;
  }
  if (kind === 'lead' && !row.stage) {
    const SALES = require('./sales'); // eslint-disable-line global-require
    row.stage = SALES.stageOf(row, SALES.stageNames(await SETTINGS.load()));
  }
  return row;
}
const nameOf = (kind, r) => (r ? String(r.company || r.title || r.name || r.subject || r.code || r.id) : '');
// the lead / deal / account a follow-up, an activity or an invoice belongs to (where notes and follow-ups of a rule go)
function homeOf(kind, r) {
  if (!r) return null;
  if (['lead', 'deal', 'account'].includes(kind)) return { kind, id: r.id };
  if (r.dealId) return { kind: 'deal', id: r.dealId };
  if (r.leadId) return { kind: 'lead', id: r.leadId };
  if (r.accountId) return { kind: 'account', id: r.accountId };
  return null;
}
const linkCols = (home, rec) => {
  if (!home) return { leadId: null, dealId: null, accountId: null };
  if (home.kind === 'deal') return { dealId: home.id, accountId: (rec && rec.accountId) || null, leadId: null };
  if (home.kind === 'lead') return { leadId: home.id, accountId: (rec && rec.accountId) || null, dealId: null };
  return { accountId: home.id, leadId: null, dealId: null };
};
const page = { lead: 'leads', deal: 'deals', account: 'accounts' };
const openOf = (home) => (home ? `/crm/${page[home.kind] || 'dashboard'}?open=${home.kind}:${home.id}` : '/crm/dashboard');

// {name} {owner} {stage} {value} {company} {title} {field:xyz}
function fill(text, kind, r) {
  const rec = r || {};
  return String(text || '').replace(/\{(\w+)(?::(\w+))?\}/g, (m, a, b) => {
    if (a === 'field' && b) return rec[b] == null ? '' : String(rec[b]);
    if (a === 'name') return nameOf(kind, rec);
    if (a === 'owner') return rec.ownerName || '';
    if (a === 'today') return S.istToday();
    return rec[a] == null ? m : String(rec[a]);
  }).slice(0, 3000);
}

// ---- conditions -----------------------------------------------------------------------------------------------------------------
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
function dateValue(v) {
  const m = /^today\s*([+-])\s*(\d{1,4})$/.exec(String(v || '').trim());
  if (String(v || '').trim() === 'today') return S.istToday();
  if (m) return addDays(S.istToday(), (m[1] === '-' ? -1 : 1) * Number(m[2]));
  return String(v || '').slice(0, 10);
}
const asDate = (v) => (v && /T/.test(String(v)) ? new Date(Date.parse(v) + 5.5 * 3600000).toISOString().slice(0, 10) : String(v || '').slice(0, 10));
function testOne(kind, c, rec, before) {
  const t = FIELD_TYPE(kind, c.field);
  const v = rec ? rec[c.field] : null;
  const changed = !!before && lc(before[c.field]) !== lc(v);
  const cmp = (a, b) => {
    if (t === 'n') return Number(a) - Number(b);
    if (t === 'd') { const x = asDate(a); const y = dateValue(b); return x < y ? -1 : x > y ? 1 : 0; }
    return lc(a) < lc(b) ? -1 : lc(a) > lc(b) ? 1 : 0;
  };
  switch (c.op) {
    case 'eq': return t === 'd' ? asDate(v) === dateValue(c.value) : (t === 'n' ? Number(v) === Number(c.value) : lc(v) === lc(c.value));
    case 'ne': return !testOne(kind, { ...c, op: 'eq' }, rec, before);
    case 'contains': return lc(v).includes(lc(c.value));
    case 'not_contains': return !lc(v).includes(lc(c.value));
    case 'gt': return v != null && v !== '' && cmp(v, c.value) > 0;
    case 'gte': return v != null && v !== '' && cmp(v, c.value) >= 0;
    case 'lt': return v != null && v !== '' && cmp(v, c.value) < 0;
    case 'lte': return v != null && v !== '' && cmp(v, c.value) <= 0;
    case 'empty': return v == null || String(v).trim() === '';
    case 'not_empty': return !(v == null || String(v).trim() === '');
    case 'in': return String(c.value || '').split(',').map(lc).filter(Boolean).includes(lc(v));
    case 'changed': return changed;
    case 'changed_to': return changed && lc(v) === lc(c.value);
    default: return false;
  }
}
function matches(rule, kind, rec, before, conds = null) {
  const list = conds || W.parse(rule.conditionsJson, []);
  if (!list.length) return true;
  const res = list.map((c) => testOne(kind, c, rec, before));
  return (conds ? true : rule.matchAll !== 0) ? res.every(Boolean) : res.some(Boolean);
}

// ---- checking what a person saves -----------------------------------------------------------------------------------------------
const UNIT_MIN = { minutes: 1, hours: 60, days: 1440 };
async function cleanRule(user, body = {}) {
  const name = S.clip(body.name, 120);
  if (!name) return { error: 'Give the rule a name.' };
  const trigger = String(body.trigger || '');
  if (!(trigger in TRIGGER_KIND)) return { error: 'Pick when the rule starts.' };
  let kind = TRIGGER_KIND[trigger];
  let time = null;
  if (trigger === 'time') {
    const t = body.time || {};
    if (!TIME_FIELDS[t.kind] || !TIME_FIELDS[t.kind].fields[t.field]) return { error: 'Pick the date the rule counts from.' };
    const days = Math.round(Number(t.days));
    if (!Number.isFinite(days) || days < 0 || days > 730) return { error: 'Days are 0 to 730.' };
    time = { kind: t.kind, field: t.field, days, direction: t.direction === 'before' ? 'before' : 'after' };
    kind = t.kind;
  }
  const conds = Array.isArray(body.conditions) ? body.conditions : [];
  if (conds.length > 20) return { error: 'At most 20 conditions.' };
  const conditions = [];
  for (const c of conds) {
    if (!FIELD_TYPE(kind, c.field)) return { error: `"${c.field}" is not a field of this record.` };
    if (!OPS[c.op]) return { error: 'Pick how the field is compared.' };
    if (['changed', 'changed_to'].includes(c.op) && !/\.(updated|stage_changed)$/.test(trigger)) return { error: '"Changed" works only on a rule that starts when a record is changed or moved.' };
    conditions.push({ field: c.field, op: c.op, value: S.clip(c.value, 200) });
  }
  const acts = Array.isArray(body.actions) ? body.actions : [];
  if (!acts.length) return { error: 'Add at least one thing the rule does.' };
  if (acts.length > 15) return { error: 'At most 15 steps in one rule.' };
  const owners = await S.ownerOptions();
  const actions = [];
  for (const a of acts) {
    const type = String(a.type || '');
    if (!ACTIONS[type]) return { error: 'Pick what the rule does.' };
    const x = { type };
    if (type === 'update_field') {
      const allowed = UPDATABLE[kind] || {};
      if (!(a.field in allowed)) return { error: `A rule cannot change "${a.field || '?'}" on this record. It can change: ${Object.keys(allowed).join(', ') || 'nothing here'}.` };
      if (allowed[a.field] && !allowed[a.field].includes(a.value)) return { error: `Pick ${allowed[a.field].join(' / ')} for ${a.field}.` };
      x.field = a.field; x.value = S.clip(a.value, 300);
    } else if (type === 'assign') {
      if (!['lead', 'deal', 'account'].includes(kind)) return { error: 'Only a lead, deal or account can be given to an owner.' };
      if (a.to !== 'round_robin' && !owners.some((o) => o.id === a.to)) return { error: 'Pick a person on the sales team, or "the next in turn".' };
      x.to = a.to;
    } else if (type === 'create_task') {
      x.title = S.clip(a.title, 200); if (!x.title) return { error: 'Write the follow-up.' };
      x.inDays = Math.max(0, Math.min(365, Math.round(Number(a.inDays) || 0)));
      x.time = /^\d{2}:\d{2}$/.test(String(a.time || '')) ? a.time : null;
      x.taskType = ['Call', 'Meeting', 'WhatsApp', 'Visit', 'Email', 'Other'].includes(a.taskType) ? a.taskType : 'Call';
      x.priority = ['High', 'Medium', 'Low'].includes(a.priority) ? a.priority : 'Medium';
      x.to = a.to && a.to !== 'owner' ? a.to : 'owner';
      if (x.to !== 'owner' && !owners.some((o) => o.id === x.to)) return { error: 'The follow-up goes to the owner or a person on the sales team.' };
    } else if (type === 'add_note') {
      x.text = S.clip(a.text, 1000); if (!x.text) return { error: 'Write the note.' };
    } else if (type === 'notify') {
      x.to = ['owner', 'managers', 'admins'].includes(a.to) ? a.to : (owners.some((o) => o.id === a.to) ? a.to : null);
      if (!x.to) return { error: 'Who gets the bell: the owner, the Sales managers, the Admins, or one person.' };
      x.title = S.clip(a.title, 120) || 'CRM rule'; x.text = S.clip(a.text, 500) || '';
    } else if (type === 'email') {
      x.to = ['owner', 'managers', 'record'].includes(a.to) ? a.to : null;
      if (!x.to) return { error: 'The mail goes to the owner, the Sales managers, or the lead / contact itself.' };
      x.subject = S.clip(a.subject, 200); x.body = S.clip(a.body, 3000);
      if (!x.subject || !x.body) return { error: 'Write the subject and the mail.' };
    } else if (type === 'webhook') {
      x.note = S.clip(a.note, 200);
    } else if (type === 'chat') {
      x.tool = ['slack', 'teams', 'both'].includes(a.tool) ? a.tool : 'both';
      x.text = S.clip(a.text, 500); if (!x.text) return { error: 'Write what is posted.' };
    } else if (type === 'wait') {
      const unit = UNIT_MIN[a.unit] ? a.unit : 'hours';
      const amount = Math.round(Number(a.amount));
      if (!(amount >= 1) || amount * UNIT_MIN[unit] > 365 * 1440) return { error: 'Wait 1 minute to 365 days.' };
      x.amount = amount; x.unit = unit;
      const only = Array.isArray(a.onlyIf) ? a.onlyIf : [];
      x.onlyIf = [];
      for (const c of only.slice(0, 10)) {
        if (!FIELD_TYPE(kind, c.field) || !OPS[c.op] || ['changed', 'changed_to'].includes(c.op)) return { error: 'Check the "only if still" conditions of the wait.' };
        x.onlyIf.push({ field: c.field, op: c.op, value: S.clip(c.value, 200) });
      }
    } else if (type === 'approval') {
      x.title = S.clip(a.title, 200) || 'Approval';
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (!steps.length || steps.length > 5) return { error: 'An approval has 1 to 5 steps.' };
      x.steps = [];
      for (const s of steps) {
        const who = ['managers', 'admins'].includes(s.approver) ? s.approver : (owners.some((o) => o.id === s.approver) ? s.approver : null);
        if (!who) return { error: 'Each approval step is the Sales managers, the Admins, or one person.' };
        x.steps.push({ approver: who, label: S.clip(s.label, 80) || null });
      }
      x.holdWon = a.holdWon === true && kind === 'deal';
    } else if (type === 'script') {
      if (!isAdmin(user)) return { error: 'Only an Admin may put a script in a rule.' };
      x.code = String(a.code || '').slice(0, 4000);
      if (!x.code.trim()) return { error: 'Write the script.' };
      try { new vm.Script(`(function(record, before, event, today){\n${x.code}\n})`); } catch (e) { return { error: `The script does not read right: ${e.message}` }; } // eslint-disable-line no-new
    }
    actions.push(x);
  }
  let graph = null;
  if (body.graph) { const g = JSON.stringify(body.graph); if (g.length < 20000) graph = g; }
  return { data: { name, trigger, kind, conditionsJson: JSON.stringify(conditions), matchAll: body.matchAll === false ? 0 : 1, actionsJson: JSON.stringify(actions), timeJson: time ? JSON.stringify(time) : null, graphJson: graph, notes: S.clip(body.notes, 500), on: body.on === true ? 1 : 0 } };
}
const ruleOut = (r) => ({ id: r.id, name: r.name, on: !!r.on, trigger: r.trigger, kind: r.kind, conditions: W.parse(r.conditionsJson, []), matchAll: r.matchAll !== 0, actions: W.parse(r.actionsJson, []), time: W.parse(r.timeJson, null), graph: W.parse(r.graphJson, null), notes: r.notes, runs: r.runs || 0, lastRunAt: r.lastRunAt, createdByName: r.createdByName, createdAt: r.createdAt, updatedAt: r.updatedAt });

// ---- the screen's calls ------------------------------------------------------------------------------------------------------
const TEMPLATES = [
  { name: 'New lead not contacted in 2 hours: tell the managers', trigger: 'lead.created', conditions: [], actions: [{ type: 'wait', amount: 2, unit: 'hours', onlyIf: [{ field: 'stage', op: 'eq', value: 'New' }] }, { type: 'notify', to: 'managers', title: 'Lead not contacted in 2 hours', text: '{name} ({owner}) has not been contacted yet.' }] },
  { name: 'Hot website lead: a call today', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Website' }], actions: [{ type: 'update_field', field: 'rating', value: 'Hot' }, { type: 'create_task', title: 'Call {name} (website lead)', inDays: 0, taskType: 'Call', priority: 'High', to: 'owner' }] },
  { name: 'Big deal: manager and Admin approve before Won', trigger: 'deal.created', conditions: [{ field: 'value', op: 'gte', value: '1000000' }], actions: [{ type: 'approval', title: 'Big deal {name}', steps: [{ approver: 'managers', label: 'Sales manager' }, { approver: 'admins', label: 'Admin' }], holdWon: true }] },
  { name: 'Deal closing in 3 days: remind the owner', trigger: 'time', time: { kind: 'deal', field: 'expectedClose', days: 3, direction: 'before' }, conditions: [{ field: 'stage', op: 'not_contains', value: 'Won' }, { field: 'stage', op: 'ne', value: 'Lost' }], actions: [{ type: 'notify', to: 'owner', title: 'Closing in 3 days', text: '{name} is expected to close in 3 days.' }] },
  { name: 'No activity on a deal for 10 days: escalate', trigger: 'time', time: { kind: 'deal', field: 'lastActivityAt', days: 10, direction: 'after' }, conditions: [{ field: 'stage', op: 'ne', value: 'Won' }, { field: 'stage', op: 'ne', value: 'Lost' }], actions: [{ type: 'notify', to: 'managers', title: 'Deal gone quiet', text: 'Nothing logged on {name} ({owner}) for 10 days.' }, { type: 'create_task', title: 'Wake up {name}', inDays: 0, priority: 'High', to: 'owner' }] },
  { name: 'Deal won: post it and thank the team', trigger: 'deal.won', conditions: [], actions: [{ type: 'chat', tool: 'both', text: 'Deal won: {name} by {owner}' }, { type: 'webhook' }] },
];
async function meta(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sets up rules.');
  const st = await SETTINGS.load();
  const sw = await W.switches();
  return S.okBody({
    on: sw.rulesOn, scriptsOn: sw.scriptsOn, canScript: isAdmin(user), canSwitch: isAdmin(user),
    triggers: TRIGGERS.map(([key, kind, label]) => ({ key, kind, label })),
    fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.map(([key, label, type]) => ({ key, label, type }))])),
    timeFields: Object.fromEntries(Object.entries(TIME_FIELDS).map(([k, v]) => [k, Object.entries(v.fields).map(([key, [label]]) => ({ key, label }))])),
    ops: Object.entries(OPS).map(([key, label]) => ({ key, label })),
    actions: Object.entries(ACTIONS).map(([key, label]) => ({ key, label })),
    updatable: Object.fromEntries(Object.entries(UPDATABLE).map(([k, v]) => [k, Object.entries(v).map(([key, options]) => ({ key, options }))])),
    owners: await S.ownerOptions(),
    choices: { stage: [...S.STAGES, ...st.leadStages.map((s) => s.name)].filter((v, i, a) => a.indexOf(v) === i), source: st.sources, status: S.LEAD_STATUSES, rating: S.RATINGS },
    templates: TEMPLATES,
  });
}
async function listRules(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees the rules.');
  const rows = await W.all('SELECT * FROM "CrmRule" ORDER BY "createdAt" DESC');
  const waiting = await W.all('SELECT "ruleId", COUNT(*) AS "n" FROM "CrmRuleRun" WHERE "status" IN (\'waiting\', \'approval\') GROUP BY "ruleId"');
  const wmap = Object.fromEntries(waiting.map((x) => [x.ruleId, Number(x.n)]));
  const sw = await W.switches();
  return S.okBody({ on: sw.rulesOn, rules: rows.map((r) => ({ ...ruleOut(r), waiting: wmap[r.id] || 0 })) });
}
async function saveRule(user, id, body = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sets up rules.');
  const prev = id ? await W.one('SELECT * FROM "CrmRule" WHERE "id" = ?', String(id)) : null;
  if (id && !prev) return S.fail(404, 'This rule is not there.');
  // a rule with a script stays the Admin's: a Sales manager may switch it on / off, not change it
  if (prev && !isAdmin(user) && W.parse(prev.actionsJson, []).some((a) => a.type === 'script') && Object.keys(body).some((k) => k !== 'on')) return S.fail(403, 'This rule runs a script: only an Admin may change it.');
  let data;
  if (prev && Object.keys(body).length === 1 && 'on' in body) data = { on: body.on ? 1 : 0 };
  else { const c = await cleanRule(user, { ...(prev ? ruleOut(prev) : {}), ...body }); if (c.error) return S.fail(400, c.error); data = c.data; }
  const t = now();
  let saved;
  if (prev) saved = await W.update('CrmRule', prev.id, { ...data, updatedAt: t });
  else saved = await W.insert('CrmRule', { id: newId('rule'), ...data, runs: 0, createdById: user.id, createdByName: user.name || null, createdAt: t, updatedAt: t });
  await S.audit(user, prev ? 'CRM rule changed' : 'CRM rule added', 'CrmRule', saved.id, `${saved.name}${saved.on ? ' (on)' : ' (off)'}`);
  return S.okBody({ ok: true, rule: ruleOut(saved) });
}
async function removeRule(user, id) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin removes rules.');
  const prev = await W.one('SELECT * FROM "CrmRule" WHERE "id" = ?', String(id || ''));
  if (!prev) return S.fail(404, 'This rule is not there.');
  if (!isAdmin(user) && W.parse(prev.actionsJson, []).some((a) => a.type === 'script')) return S.fail(403, 'This rule runs a script: only an Admin may remove it.');
  await W.run('DELETE FROM "CrmRule" WHERE "id" = ?', prev.id);
  await W.run('UPDATE "CrmRuleRun" SET "status" = \'stopped\', "log" = COALESCE("log", \'\') || ? WHERE "ruleId" = ? AND "status" IN (\'waiting\', \'approval\')', '\nThe rule was removed.', prev.id);
  await W.run('UPDATE "CrmApproval" SET "status" = \'Withdrawn\', "decidedAt" = ? WHERE "ruleId" = ? AND "status" = \'Pending\'', now(), prev.id);
  await S.audit(user, 'CRM rule removed', 'CrmRule', prev.id, prev.name);
  return S.okBody({ ok: true });
}
async function runs(user, { ruleId, limit } = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sees the rule runs.');
  const n = Math.min(200, Math.max(1, Number(limit) || 60));
  const rows = ruleId ? await W.all('SELECT * FROM "CrmRuleRun" WHERE "ruleId" = ? ORDER BY "createdAt" DESC LIMIT ?', String(ruleId), n) : await W.all('SELECT * FROM "CrmRuleRun" ORDER BY "createdAt" DESC LIMIT ?', n);
  return S.okBody({ runs: rows });
}
// "Try it on a record": the conditions against a real record, and what the rule would do - nothing is changed
async function dryRun(user, id, { recordId } = {}) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin tries rules.');
  const rule = await W.one('SELECT * FROM "CrmRule" WHERE "id" = ?', String(id || ''));
  if (!rule) return S.fail(404, 'This rule is not there.');
  const rec = await load(rule.kind, recordId);
  if (!rec) return S.fail(404, 'That record is not there.');
  const conds = W.parse(rule.conditionsJson, []);
  const each = conds.map((c) => ({ ...c, label: `${((FIELDS[rule.kind] || []).find((f) => f[0] === c.field) || [])[1] || c.field} ${OPS[c.op]}${['empty', 'not_empty', 'changed'].includes(c.op) ? '' : ` ${c.value}`}`, now: rec[c.field] == null ? '' : String(rec[c.field]), pass: testOne(rule.kind, c, rec, null) }));
  const pass = matches(rule, rule.kind, rec, null);
  const actions = W.parse(rule.actionsJson, []).map((a) => ({ type: a.type, words: describe(a, rule.kind, rec) }));
  return S.okBody({ record: { id: rec.id, name: nameOf(rule.kind, rec) }, pass, conditions: each, actions });
}
function describe(a, kind, rec) {
  switch (a.type) {
    case 'update_field': return `Set ${a.field} to ${a.field === 'expectedClose' ? dateValue(a.value) : a.value}`;
    case 'assign': return a.to === 'round_robin' ? 'Give it to the next salesperson in turn' : 'Give it to the chosen person';
    case 'create_task': return `Follow-up "${fill(a.title, kind, rec)}" in ${a.inDays} day(s) for ${a.to === 'owner' ? 'the owner' : 'the chosen person'}`;
    case 'add_note': return `Note: ${fill(a.text, kind, rec)}`;
    case 'notify': return `Bell to ${a.to}: ${fill(a.title, kind, rec)}`;
    case 'email': return `Mail to ${a.to === 'record' ? 'the lead / contact' : a.to}: ${fill(a.subject, kind, rec)}`;
    case 'webhook': return 'Webhook rule.fired to the outside addresses';
    case 'chat': return `Post to ${a.tool}: ${fill(a.text, kind, rec)}`;
    case 'wait': return `Wait ${a.amount} ${a.unit}${a.onlyIf && a.onlyIf.length ? ', then go on only if still true' : ''}`;
    case 'approval': return `Ask for approval in ${a.steps.length} step(s)${a.holdWon ? '; the deal cannot be won until approved' : ''}`;
    case 'script': return 'Run the script';
    default: return a.type;
  }
}

// ---- doing it ----------------------------------------------------------------------------------------------------------------------
const ruleUser = (rule) => ({ id: rule.createdById || 'system', name: `Rule: ${rule.name}`.slice(0, 120) });
async function note(home, rec, text) {
  if (!home) return;
  const t = now();
  await S.insert('CrmActivity', { id: newId('act'), kind: 'note', subject: String(text).slice(0, 200), note: String(text).length > 200 ? String(text).slice(0, 2000) : null, at: t, ...linkCols(home, rec), byId: null, byName: 'TeamLink rule', createdAt: t }).catch(() => {});
}
async function adminIds() {
  const prisma = require('../db'); // eslint-disable-line global-require
  return (await prisma.user.findMany({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, status: 'Active' }, select: { id: true }, take: 10 }).catch(() => [])).map((u) => u.id);
}
async function managerIds() {
  const st = await SETTINGS.load();
  const ids = (st.salesTeam || []).filter((m) => m.role === 'manager' && m.userId).map((m) => m.userId);
  return ids.length ? [...new Set(ids)] : adminIds();
}
async function peopleFor(to, rec) {
  if (to === 'owner') return rec && rec.ownerId ? [rec.ownerId] : [];
  if (to === 'managers') return managerIds();
  if (to === 'admins') return adminIds();
  return to ? [to] : [];
}
async function setField(rule, kind, rec, field, raw, ctx) {
  const allowed = UPDATABLE[kind] || {};
  if (!(field in allowed)) return `cannot change ${field}`;
  let value = raw;
  if (field === 'expectedClose') value = dateValue(raw);
  if (allowed[field] && !allowed[field].includes(value)) return `${field}: ${value} is not allowed`;
  let data = { [field]: value };
  if (S.cleanFields && ['lead', 'deal', 'account'].includes(kind)) {
    const c = S.cleanFields(kind, { [field]: value }, { partial: true });
    if (c.error) return c.error;
    data = c.data;
  }
  if (kind === 'lead' && field === 'source' && data.source && !(await SETTINGS.load()).sources.includes(data.source)) data.source = 'Other';
  if (String(rec[field] == null ? '' : rec[field]) === String(data[field] == null ? '' : data[field])) return `${field} was ${data[field]} already`;
  const saved = await S.update(TABLE[kind], rec.id, { ...data, updatedAt: now() });
  await note(homeOf(kind, rec), rec, `Rule "${rule.name}" set ${field} to ${data[field]}`);
  require('./events').emit(`${kind}.updated`, { kind, record: saved, before: rec, depth: (ctx.depth || 0) + 1, via: 'rule' }); // eslint-disable-line global-require
  return `${field} set to ${data[field]}`;
}

function runScript(code, rec, before, event) {
  const box = vm.createContext({ __rec: JSON.stringify(rec || {}), __before: JSON.stringify(before || null), __event: String(event || ''), __today: S.istToday() }, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const src = `"use strict"; (function(){ const record = JSON.parse(__rec); const before = JSON.parse(__before); const out = (function(record, before, event, today){\n${code}\n})(record, before, __event, __today); return out === undefined ? 'null' : JSON.stringify(out); })()`;
  const outStr = vm.runInContext(src, box, { timeout: 200 });
  return JSON.parse(typeof outStr === 'string' ? outStr : 'null');
}

async function doAction(rule, a, kind, rec, ctx) {
  const home = homeOf(kind, rec);
  const sw = await W.switches();
  switch (a.type) {
    case 'update_field': return setField(rule, kind, rec, a.field, a.value, ctx);
    case 'assign': {
      let own = null;
      if (a.to === 'round_robin') own = await require('./sales').takeTurn().catch(() => null); // eslint-disable-line global-require
      else own = (await S.ownerOptions()).find((o) => o.id === a.to) || null;
      if (!own) return 'nobody to give it to';
      if (own.id === rec.ownerId) return `already ${own.name}'s`;
      const saved = await S.update(TABLE[kind], rec.id, { ownerId: own.id, ownerName: own.name, updatedAt: now() });
      await note(home, rec, `Rule "${rule.name}" gave it to ${own.name}`);
      await notifyUsers([own.id], { title: `${nameOf(kind, rec)} is yours now`, message: `Given to you by the rule "${rule.name}".`, open: openOf(home) }).catch(() => {});
      require('./events').emit(`${kind}.updated`, { kind, record: saved, before: rec, depth: (ctx.depth || 0) + 1, via: 'rule' }); // eslint-disable-line global-require
      return `given to ${own.name}`;
    }
    case 'create_task': {
      if (!home) return 'no lead, deal or account to put the follow-up on';
      const homeRec = home.kind === kind ? rec : await load(home.kind, home.id);
      const to = a.to === 'owner' ? { id: (homeRec && homeRec.ownerId) || rec.ownerId, name: (homeRec && homeRec.ownerName) || rec.ownerName } : (await S.ownerOptions()).find((o) => o.id === a.to);
      if (!to || !to.id) return 'nobody owns it yet';
      const t = now();
      const extras = await require('./sales').taskExtras({ type: a.taskType || 'Call', priority: a.priority }); // eslint-disable-line global-require
      const task = await S.insert('CrmTask', { id: newId('task'), title: fill(a.title, kind, rec).slice(0, 200), dueDate: addDays(S.istToday(), a.inDays || 0), dueTime: a.time || null, ...extras, status: 'Open', ...linkCols(home, homeRec || rec), ownerId: to.id, ownerName: to.name || null, createdById: null, createdAt: t, updatedAt: t, origin: `rule:${rule.id}` });
      return `follow-up "${task.title}" on ${task.dueDate} for ${to.name || to.id}`;
    }
    case 'add_note': await note(home, rec, fill(a.text, kind, rec)); return 'note written';
    case 'notify': {
      const ids = await peopleFor(a.to, rec);
      if (!ids.length) return 'nobody to tell';
      await notifyUsers(ids, { title: fill(a.title, kind, rec).slice(0, 120), message: fill(a.text, kind, rec), open: openOf(home) });
      return `bell to ${ids.length} person(s)`;
    }
    case 'email': {
      const mailer = require('../utils/mailer'); // eslint-disable-line global-require
      const prisma = require('../db'); // eslint-disable-line global-require
      let to = [];
      if (a.to === 'record') {
        const addr = rec.email || (home && home.kind !== kind ? ((await load(home.kind, home.id)) || {}).email : null);
        if (!addr) return 'no email on the record';
        const out = await DB.one('SELECT "id" FROM "CrmOptOut" WHERE "channel" = \'email\' AND lower("value") = lower(?)', addr).catch(() => null);
        if (out) return 'they asked for no mails: not sent';
        to = [addr];
      } else {
        const ids = await peopleFor(a.to, rec);
        to = (await prisma.user.findMany({ where: { id: { in: ids } }, select: { email: true } }).catch(() => [])).map((u) => u.email).filter(Boolean);
      }
      if (!to.length) return 'no address to mail';
      let sent = 0;
      for (const addr of to.slice(0, 10)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await mailer.sendMail({ to: addr, subject: fill(a.subject, kind, rec), text: fill(a.body, kind, rec) }).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) sent += 1;
      }
      if (a.to === 'record' && sent) {
        const t = now();
        await S.insert('CrmActivity', { id: newId('act'), kind: 'email', subject: `Email sent: ${fill(a.subject, kind, rec)}`.slice(0, 200), note: `To ${to[0]}\n\n${fill(a.body, kind, rec)}`.slice(0, 4000), at: t, ...linkCols(home, rec), byId: null, byName: `Rule: ${rule.name}`.slice(0, 120), createdAt: t }).catch(() => {});
      }
      return `mail sent to ${sent} of ${to.length}`;
    }
    case 'webhook': {
      const C = require('./connect'); // eslint-disable-line global-require
      const n = await C.deliverEvent('rule.fired', { kind, record: rec, via: `rule:${rule.name}` });
      return sw.webhooksOn ? `webhook to ${n} address(es)` : 'webhooks are switched off';
    }
    case 'chat': {
      if (!sw.chatOn) return 'Slack / Teams posts are switched off';
      const C = require('./connect'); // eslint-disable-line global-require
      const tools = a.tool === 'both' ? ['slack', 'teams'] : [a.tool];
      const said = [];
      for (const tool of tools) {
        // eslint-disable-next-line no-await-in-loop
        const r = await C.postChat(tool, fill(a.text, kind, rec), '').catch(() => ({ ok: false }));
        said.push(`${tool} ${r.ok ? 'posted' : (r.notSet ? 'not set up' : 'failed')}`);
      }
      return said.join(', ');
    }
    case 'script': {
      if (!sw.scriptsOn) return 'scripts are switched off: skipped';
      let out;
      try { out = runScript(a.code, rec, ctx.before, ctx.event); } catch (e) { throw new Error(`script: ${String(e && e.message).slice(0, 200)}`); }
      if (!out || typeof out !== 'object') return 'script: nothing to do';
      const said = [];
      if (out.set && typeof out.set === 'object') {
        let cur = rec;
        for (const [f, v] of Object.entries(out.set).slice(0, 5)) {
          // eslint-disable-next-line no-await-in-loop
          said.push(await setField(rule, kind, cur, f, v == null ? '' : String(v), ctx));
          cur = (await load(kind, rec.id)) || cur; // eslint-disable-line no-await-in-loop
        }
      }
      if (out.note) { await note(home, rec, `Rule "${rule.name}": ${String(out.note).slice(0, 500)}`); said.push('note written'); }
      if (out.task && out.task.title) said.push(await doAction(rule, { type: 'create_task', title: String(out.task.title).slice(0, 200), inDays: Math.max(0, Math.min(365, Number(out.task.inDays) || 0)), priority: out.task.priority, to: 'owner' }, kind, rec, ctx));
      if (out.notify) said.push(await doAction(rule, { type: 'notify', to: 'owner', title: `Rule: ${rule.name}`, text: String(out.notify).slice(0, 500) }, kind, rec, ctx));
      if (out.stop) said.push('stop');
      return `script: ${said.join('; ') || 'nothing to do'}`;
    }
    default: return `unknown step ${a.type}`;
  }
}

async function logRun(run, line, data = {}) {
  const log = `${run.log ? `${run.log}\n` : ''}${new Date().toISOString().slice(11, 19)} ${line}`.slice(-4000);
  const saved = await W.update('CrmRuleRun', run.id, { ...data, log, updatedAt: now() });
  return saved || { ...run, ...data, log };
}
// go on from run.step until the end, a wait or an approval
async function proceed(rule, run, ctx) {
  const actions = W.parse(rule.actionsJson, []);
  let rec = await load(run.kind, run.entityId);
  if (!rec) return logRun(run, 'the record is gone', { status: 'stopped' });
  let cur = run;
  for (let i = cur.step; i < actions.length; i += 1) {
    const a = actions[i];
    if (a.type === 'wait') {
      const due = new Date(Date.now() + a.amount * UNIT_MIN[a.unit] * 60000).toISOString();
      return logRun(cur, `waiting ${a.amount} ${a.unit} (until ${due})`, { status: 'waiting', step: i + 1, dueAt: due });
    }
    if (a.type === 'approval') {
      const t = now();
      const ap = await W.insert('CrmApproval', { id: newId('apr'), ruleId: rule.id, ruleName: rule.name, runId: cur.id, kind: run.kind, entityId: rec.id, entityName: nameOf(run.kind, rec), title: fill(a.title, run.kind, rec).slice(0, 200), stepsJson: JSON.stringify(a.steps.map((s) => ({ ...s, decision: null, byId: null, byName: null, at: null, note: null }))), step: 0, status: 'Pending', gate: a.holdWon ? 'won' : null, createdAt: t });
      await tellApprovers(ap);
      await note(homeOf(run.kind, rec), rec, `Approval asked: ${ap.title} (${a.steps.length} step${a.steps.length === 1 ? '' : 's'})`);
      require('./events').emit('approval.requested', { kind: 'approval', record: ap, depth: 1 }); // eslint-disable-line global-require
      return logRun(cur, `asked for approval "${ap.title}"`, { status: 'approval', step: i + 1 });
    }
    let said;
    try {
      said = await doAction(rule, a, run.kind, rec, ctx); // eslint-disable-line no-await-in-loop
    } catch (e) {
      return logRun(cur, `step ${i + 1} (${a.type}) failed: ${String(e.message).slice(0, 300)}`, { status: 'failed', step: i });
    }
    cur = await logRun(cur, `${ACTIONS[a.type]}: ${said}`, { step: i + 1 }); // eslint-disable-line no-await-in-loop
    if (/(^|; )stop$/.test(String(said))) break;
    rec = (await load(run.kind, run.entityId)) || rec; // eslint-disable-line no-await-in-loop
  }
  return logRun(cur, 'done', { status: 'done', dueAt: null });
}
async function start(rule, { event, kind, record, before, anchor, depth } = {}) {
  const t = now();
  const run = await W.insert('CrmRuleRun', { id: newId('run'), ruleId: rule.id, ruleName: rule.name, event, kind, entityId: record.id, entityName: nameOf(kind, record), status: 'running', step: 0, anchor: anchor || null, log: '', createdAt: t, updatedAt: t });
  await W.run('UPDATE "CrmRule" SET "runs" = COALESCE("runs", 0) + 1, "lastRunAt" = ? WHERE "id" = ?', t, rule.id);
  return proceed(rule, run, { event, before, depth });
}

// a CRM event (crm/events.js): every rule that is on and listens to it, whose conditions are true
async function onEvent(event, p = {}) {
  const sw = await W.switches();
  if (!sw.rulesOn || !p.record || !p.record.id) return 0;
  const rules = await W.all('SELECT * FROM "CrmRule" WHERE "on" = 1 AND "trigger" = ?', event);
  let n = 0;
  for (const rule of rules) {
    if (rule.kind !== p.kind) continue;
    // the record as it stands now (with its last activity and stage worked out), the change compared with what it was
    const rec = (await load(p.kind, p.record.id)) || p.record; // eslint-disable-line no-await-in-loop
    if (!matches(rule, p.kind, rec, p.before || null)) continue;
    await start(rule, { event, kind: p.kind, record: rec, before: p.before || null, depth: p.depth }).catch((e) => console.error('[crm] rule run:', e.message)); // eslint-disable-line no-await-in-loop, no-console
    n += 1;
  }
  return n;
}

// ---- the clock: delays that are over, and the date rules ------------------------------------------------------------------------
async function resumeDue() {
  const due = await W.all('SELECT * FROM "CrmRuleRun" WHERE "status" = \'waiting\' AND "dueAt" <= ? ORDER BY "dueAt" LIMIT 200', now());
  let n = 0;
  for (const run of due) {
    const claimed = await W.run('UPDATE "CrmRuleRun" SET "status" = \'running\' WHERE "id" = ? AND "status" = \'waiting\'', run.id); // eslint-disable-line no-await-in-loop
    if (!Number(claimed)) continue;
    const rule = await W.one('SELECT * FROM "CrmRule" WHERE "id" = ?', run.ruleId); // eslint-disable-line no-await-in-loop
    if (!rule) { await logRun(run, 'the rule is gone', { status: 'stopped' }); continue; } // eslint-disable-line no-await-in-loop
    const wait = W.parse(rule.actionsJson, [])[run.step - 1] || {};
    if (wait.onlyIf && wait.onlyIf.length) {
      const rec = await load(run.kind, run.entityId); // eslint-disable-line no-await-in-loop
      if (!rec || !matches(rule, run.kind, rec, null, wait.onlyIf)) { await logRun(run, 'not needed any more: the "only if still" check is no longer true', { status: 'stopped' }); n += 1; continue; } // eslint-disable-line no-await-in-loop
    }
    await proceed(rule, { ...run, status: 'running' }, { event: run.event, depth: 0 }).catch((e) => logRun(run, `failed: ${e.message}`, { status: 'failed' })); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  return n;
}
async function timeRules() {
  const rules = await W.all('SELECT * FROM "CrmRule" WHERE "on" = 1 AND "trigger" = \'time\'');
  const today = S.istToday();
  let n = 0;
  for (const rule of rules) {
    const t = W.parse(rule.timeJson, null);
    const tf = t && TIME_FIELDS[t.kind];
    if (!tf || !tf.fields[t.field]) continue;
    const expr = tf.fields[t.field][1];
    // the record's date + / - N days is today (or up to 3 days ago, for a server that was down): the date it counts from is target
    const sign = t.direction === 'before' ? 1 : -1;
    const hi = addDays(today, sign * t.days);
    // eslint-disable-next-line no-await-in-loop
    const rows = await DB.all(`SELECT x."id", ${expr} AS "d" FROM "${tf.table}" x WHERE ${expr} BETWEEN ? AND ? LIMIT 300`, addDays(hi, -3), hi).catch(() => []);
    for (const r of rows) {
      const anchor = `${t.field}:${r.d}`;
      // eslint-disable-next-line no-await-in-loop
      const seen = await W.one('SELECT "id" FROM "CrmRuleRun" WHERE "ruleId" = ? AND "entityId" = ? AND "anchor" = ? LIMIT 1', rule.id, r.id, anchor);
      if (seen) continue;
      const rec = await load(t.kind, r.id); // eslint-disable-line no-await-in-loop
      if (!rec || !matches(rule, t.kind, rec, null)) continue;
      await start(rule, { event: 'time', kind: t.kind, record: rec, anchor }).catch((e) => console.error('[crm] date rule:', e.message)); // eslint-disable-line no-await-in-loop, no-console
      n += 1;
    }
  }
  return n;
}
async function tick() {
  const sw = await W.switches();
  if (!sw.rulesOn) return { resumed: 0, dated: 0, off: true };
  const resumed = await resumeDue();
  const dated = await timeRules();
  return { resumed, dated };
}
async function tickNow(user) {
  if (!isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin runs the rules now.');
  return S.okBody({ ok: true, ...(await tick()) });
}

// ---- approvals (08.08) ------------------------------------------------------------------------------------------------------
async function approversOf(step) {
  if (step.approver === 'managers') return managerIds();
  if (step.approver === 'admins') return adminIds();
  return [step.approver];
}
async function tellApprovers(ap) {
  const steps = W.parse(ap.stepsJson, []);
  const st = steps[ap.step];
  if (!st) return;
  const ids = await approversOf(st);
  await notifyUsers(ids, { title: `Approval needed: ${ap.title}`.slice(0, 120), message: `Step ${ap.step + 1} of ${steps.length}${st.label ? ` (${st.label})` : ''}. ${ap.entityName || ''}`, open: '/crm/dashboard?tab=automation' }).catch(() => {});
}
async function mayDecide(user, ap) {
  const steps = W.parse(ap.stepsJson, []);
  const st = steps[ap.step];
  if (!st || ap.status !== 'Pending') return false;
  const r = S.roleOf(user);
  if (st.approver === 'admins') return r === 'admin';
  if (st.approver === 'managers') return r === 'admin' || r === 'tl';
  return st.approver === user.id;
}
const apOut = async (ap, user) => ({ id: ap.id, title: ap.title, kind: ap.kind, entityId: ap.entityId, entityName: ap.entityName, ruleName: ap.ruleName, status: ap.status, step: ap.step, steps: W.parse(ap.stepsJson, []), holdWon: ap.gate === 'won', createdAt: ap.createdAt, decidedAt: ap.decidedAt, canDecide: user ? await mayDecide(user, ap) : false });
async function approvals(user, { status } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const rows = status === 'all' ? await W.all('SELECT * FROM "CrmApproval" ORDER BY "createdAt" DESC LIMIT 200') : await W.all('SELECT * FROM "CrmApproval" WHERE "status" = \'Pending\' ORDER BY "createdAt" LIMIT 200');
  const out = [];
  for (const ap of rows) {
    const o = await apOut(ap, user); // eslint-disable-line no-await-in-loop
    // a salesperson sees an approval only when it is theirs to decide; managers and Admins see them all
    if (isManager(user) || o.canDecide) out.push(o);
  }
  return S.okBody({ approvals: out, waitingForMe: out.filter((x) => x.canDecide).length });
}
async function decide(user, id, { decision, note: text } = {}) {
  const ap = await W.one('SELECT * FROM "CrmApproval" WHERE "id" = ?', String(id || ''));
  if (!ap) return S.fail(404, 'This approval is not there.');
  if (ap.status !== 'Pending') return S.fail(400, `This approval is ${ap.status.toLowerCase()} already.`);
  if (!['approve', 'reject'].includes(decision)) return S.fail(400, 'Approve or reject?');
  if (!(await mayDecide(user, ap))) return S.fail(403, 'This step is not yours to decide.');
  const steps = W.parse(ap.stepsJson, []);
  if (steps.some((s, i) => i < ap.step && s.byId === user.id)) return S.fail(409, 'You decided an earlier step: the next step needs another person.');
  steps[ap.step] = { ...steps[ap.step], decision, byId: user.id, byName: user.name || null, at: now(), note: S.clip(text, 300) };
  let status = 'Pending'; let step = ap.step;
  if (decision === 'reject') status = 'Rejected';
  else if (ap.step + 1 >= steps.length) status = 'Approved';
  else step = ap.step + 1;
  const saved = await W.update('CrmApproval', ap.id, { stepsJson: JSON.stringify(steps), step, status, ...(status !== 'Pending' ? { decidedAt: now() } : {}) });
  const rec = await load(ap.kind, ap.entityId);
  await note(homeOf(ap.kind, rec || { id: ap.entityId }), rec, `${ap.title}: step ${ap.step + 1} ${decision === 'approve' ? 'approved' : 'rejected'} by ${user.name || 'a manager'}${text ? ` (${S.clip(text, 200)})` : ''}`);
  await S.audit(user, `CRM approval ${decision === 'approve' ? 'step approved' : 'rejected'}`, 'CrmApproval', ap.id, `${ap.title}: step ${ap.step + 1} of ${steps.length}`, text || undefined);
  if (status === 'Pending') await tellApprovers(saved);
  else {
    require('./events').emit('approval.decided', { kind: 'approval', record: saved, depth: 1 }); // eslint-disable-line global-require
    if (rec && rec.ownerId) await notifyUsers([rec.ownerId], { title: `${ap.title}: ${status.toLowerCase()}`, message: ap.entityName || '', open: openOf(homeOf(ap.kind, rec)), exceptUserId: user.id }).catch(() => {});
    const run = ap.runId ? await W.one('SELECT * FROM "CrmRuleRun" WHERE "id" = ?', ap.runId) : null;
    if (run && run.status === 'approval') {
      if (status === 'Approved') {
        const rule = await W.one('SELECT * FROM "CrmRule" WHERE "id" = ?', run.ruleId);
        if (rule) await proceed(rule, { ...run, status: 'running' }, { event: run.event, depth: 0 }).catch(() => null);
        else await logRun(run, 'approved, but the rule is gone', { status: 'stopped' });
      } else await logRun(run, `rejected by ${user.name || 'a manager'}`, { status: 'stopped' });
    }
  }
  return S.okBody({ ok: true, approval: await apOut(saved, user) });
}
// moveDeal asks: may this deal be won? (an approval with "hold back Won" still waiting)
async function wonGate(dealId) {
  const ap = await W.one('SELECT * FROM "CrmApproval" WHERE "kind" = \'deal\' AND "entityId" = ? AND "status" = \'Pending\' AND "gate" = \'won\' LIMIT 1', String(dealId || ''));
  if (!ap) return null;
  const steps = W.parse(ap.stepsJson, []);
  return `"${ap.title}" must be approved first (step ${ap.step + 1} of ${steps.length} is waiting). Then the deal can be won.`;
}

module.exports = { meta, listRules, saveRule, removeRule, runs, dryRun, onEvent, tick, tickNow, approvals, decide, wonGate, runScript, matches, testOne, TRIGGERS, FIELDS, ACTIONS, OPS };

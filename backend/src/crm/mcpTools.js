// ---------------------------------------------------------------------------
// CRM TOOLS FOR OUTSIDE AI (wave A 15.12, 2026-11-24): the TeamLink MCP server (utils/mktb/mcp.js, POST /api/mcp, its own mcp_ token)
// lists these tools as well when (1) an Admin turned on "Outside AI tools read the CRM" and (2) the token's person is on the CRM team.
// Every answer is what that person may see in the CRM (a salesperson: their own records). Phone numbers and emails are never returned.
// Two tools ADD something (a note, a follow-up) - only while "Outside AI tools add notes and follow-ups" is also on, and only on records
// the person may change. Every call is audited by the MCP server.
// ---------------------------------------------------------------------------
const S = require('./service');
const W = require('./waveSchema');
const DB = require('./schema');

const READ_TOOLS = [
  { name: 'crm_search_leads', description: 'Search the CRM leads you may see (company, contact, city, source). Returns code, company, stage, rating, source, owner, expected value. Never phone or email.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'crm_list_deals', description: 'Deals you may see, optionally only one stage or only open ones. Returns title, customer, stage, value, probability, expected close, owner.', inputSchema: { type: 'object', properties: { stage: { type: 'string' }, open: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'crm_get_record', description: 'One lead, deal or account you may see, with its last 20 timeline lines and open follow-ups. kind = lead | deal | account.', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' } }, required: ['kind', 'id'] } },
  { name: 'crm_pipeline', description: 'The open pipeline you may see: count, value and weighted value per stage, and what was won this month.', inputSchema: { type: 'object', properties: {} } },
  { name: 'crm_followups_due', description: 'Your follow-ups due today and late (or everybody\'s you may see when all = true).', inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } } },
];
const WRITE_TOOLS = [
  { name: 'crm_log_note', description: 'Write a note on a lead, deal or account you may change. kind = lead | deal | account.', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' }, note: { type: 'string' } }, required: ['kind', 'id', 'note'] } },
  { name: 'crm_add_follow_up', description: 'Add a follow-up (date YYYY-MM-DD, optional time HH:MM) on a lead, deal or account you may change.', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string' }, dueTime: { type: 'string' } }, required: ['kind', 'id', 'title', 'dueDate'] } },
];
const NO_CONTACT = (row) => { if (!row) return row; const { phone, email, ...rest } = row; return rest; }; // eslint-disable-line no-unused-vars
const lim = (n, d = 25) => Math.max(1, Math.min(100, Math.round(Number(n) || d)));

async function toolsFor(user) {
  const sw = await W.switches();
  if (!sw.mcpCrm || !(await S.crmRoleFor(user))) return [];
  return [...READ_TOOLS, ...(sw.mcpWrite && S.mayEdit(S.roleOf(user)) ? WRITE_TOOLS : [])];
}
const has = async (user, name) => (await toolsFor(user)).some((t) => t.name === name);
const COL = { lead: 'leadId', deal: 'dealId', account: 'accountId' };

async function call(name, args, user) {
  if (!(await has(user, name))) return null; // not a CRM tool (or switched off): the MCP server answers "unknown tool"
  const r = S.roleOf(user);
  if (name === 'crm_search_leads') {
    const rows = await S.list(user, 'lead', { q: S.clip(args.query, 120) || undefined, status: S.clip(args.status, 30) || undefined });
    return { total: rows.length, leads: rows.slice(0, lim(args.limit)).map((l) => ({ id: l.id, code: l.code, company: l.company, contactName: l.contactName, stage: l.stage, status: l.status, rating: l.rating, source: l.source, city: l.city, expectedValue: l.expectedValue, owner: l.ownerName, lastActivityAt: l.lastActivityAt, nextFollowUp: l.nextTaskDue })) };
  }
  if (name === 'crm_list_deals') {
    let rows = await S.list(user, 'deal', {});
    if (args.stage) rows = rows.filter((d) => String(d.stage).toLowerCase() === String(args.stage).toLowerCase());
    if (args.open) rows = rows.filter((d) => !['Won', 'Lost'].includes(d.stage));
    return { total: rows.length, deals: rows.slice(0, lim(args.limit)).map((d) => ({ id: d.id, code: d.code, title: d.title, customer: d.accountName, stage: d.stage, value: d.value, finalValue: d.finalValue, probability: d.probability, expectedClose: d.expectedClose, owner: d.ownerName, nextStep: d.nextStep })) };
  }
  if (name === 'crm_get_record') {
    const kind = String(args.kind || '');
    if (!COL[kind]) return { error: 'kind is lead, deal or account.' };
    const row = await S.getRow(kind, String(args.id || ''));
    if (!S.canSeeRow(user, r, row)) return { error: 'Not found or not in your scope.' };
    const tl = await DB.all(`SELECT "kind", "subject", "note", "at", "byName" FROM "CrmActivity" WHERE "${COL[kind]}" = ? ORDER BY "at" DESC LIMIT 20`, row.id);
    const tasks = await DB.all(`SELECT "title", "dueDate", "dueTime", "type", "priority" FROM "CrmTask" WHERE "${COL[kind]}" = ? AND "status" = 'Open' ORDER BY "dueDate" LIMIT 20`, row.id);
    return { kind, record: NO_CONTACT(row), timeline: tl.map((a) => ({ ...a, note: a.note ? String(a.note).replace(/^To [^\n]+\n\n/, '').slice(0, 500) : null })), openFollowUps: tasks };
  }
  if (name === 'crm_pipeline') return pipeline(user);
  return callMore(name, args, user);
}
// the open pipeline by stage and what was won this month, in the person's scope (also GET /api/crm-api/v1/pipeline)
async function pipeline(user) {
  const r = S.roleOf(user);
  const sc = S.scopeSql(user, r);
  const stages = await DB.all(`SELECT "stage", COUNT(*) AS "count", COALESCE(SUM("value"), 0) AS "value", COALESCE(SUM("value" * "probability" / 100.0), 0) AS "weighted" FROM "CrmDeal" WHERE "stage" NOT IN ('Won', 'Lost') AND ${sc.sql} GROUP BY "stage"`, ...sc.params);
  const ym = S.istToday().slice(0, 7);
  const won = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE "stage" = 'Won' AND "wonAt" >= ? AND ${sc.sql}`, new Date(Date.parse(`${ym}-01T00:00:00Z`) - 5.5 * 3600000).toISOString(), ...sc.params);
  return { open: stages.map((s) => ({ stage: s.stage, count: Number(s.count), value: Math.round(Number(s.value)), weighted: Math.round(Number(s.weighted)) })), wonThisMonth: { deals: Number(won.n), value: Math.round(Number(won.v)) } };
}
async function callMore(name, args, user) {
  if (name === 'crm_followups_due') {
    const tasks = await S.tasks(user, { when: 'action', mine: !args.all });
    const today = S.istToday();
    return { followUps: tasks.filter((t) => t.dueDate <= today).slice(0, 50).map((t) => ({ title: t.title, dueDate: t.dueDate, dueTime: t.dueTime, type: t.type, priority: t.priority, late: t.dueDate < today, record: t.recordName || null, owner: t.ownerName })) };
  }
  if (name === 'crm_log_note') {
    const kind = String(args.kind || '');
    if (!COL[kind]) return { error: 'kind is lead, deal or account.' };
    const out = await S.addActivity(user, { kind: 'note', subject: 'Note from an AI tool', note: String(args.note || '').slice(0, 2000), [COL[kind]]: String(args.id || '') });
    return out.status === 200 ? { ok: true, activityId: out.body.activity.id } : { error: out.body.error };
  }
  if (name === 'crm_add_follow_up') {
    const kind = String(args.kind || '');
    if (!COL[kind]) return { error: 'kind is lead, deal or account.' };
    const out = await S.addTask(user, { title: args.title, dueDate: args.dueDate, dueTime: args.dueTime, [COL[kind]]: String(args.id || '') });
    return out.status === 200 ? { ok: true, followUpId: out.body.task.id, dueDate: out.body.task.dueDate } : { error: out.body.error };
  }
  return null;
}

module.exports = { toolsFor, call, pipeline, READ_TOOLS, WRITE_TOOLS };

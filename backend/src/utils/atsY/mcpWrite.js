// ---------------------------------------------------------------------------
// MCP WRITE TOOLS FOR THE ATS (ATS wave 2 Y, benchmark 09.14) - like the CRM's (crm/mcpTools.js). The TeamLink MCP server
// (utils/mktb/mcp.js, POST /api/mcp, its own mcp_ token) lists these three tools ONLY while
//   (1) the MCP server is on (AI governance > Overview), (2) an Admin turned on "mcpWrite" (Sourcing & AI connectors), and
//   (3) the token's person may change ATS records (never a view-only Manager / Assistant Manager, never the BDE team).
// Each tool runs the SAME route a person uses in the app, as the token's person, on this server (loopback): the scope check, the
// permissions, the stage rules (reasons for a rejection, the share checklist, the blueprint) are exactly the app's. The MCP server audits
// every call ("MCP tool used: ...") and the route writes its own audit line.
// ---------------------------------------------------------------------------
const C = require('./core');

const TOOLS = [
  { name: 'ats_add_note', description: 'Write an internal note on a candidate you may see (optionally about one application).', inputSchema: { type: 'object', properties: { candidateId: { type: 'string' }, note: { type: 'string' }, applicationId: { type: 'string' } }, required: ['candidateId', 'note'] } },
  { name: 'ats_add_follow_up', description: 'Add a follow-up on an application you work on: the due date (YYYY-MM-DD), optional time (HH:MM), what is owed next.', inputSchema: { type: 'object', properties: { applicationId: { type: 'string' }, dueDate: { type: 'string' }, dueTime: { type: 'string' }, nextAction: { type: 'string' }, notes: { type: 'string' } }, required: ['applicationId', 'dueDate'] } },
  { name: 'ats_move_stage', description: 'Move an application to another step (a step code such as SCREENING, SHORTLISTED, INTERVIEW_SCHEDULED, REJECTED, or its label). A rejection needs rejectedBy (Client / Internal / Candidate), reasonCategory and reasonDetail. The usual rules of the step apply.', inputSchema: { type: 'object', properties: { applicationId: { type: 'string' }, stage: { type: 'string' }, comment: { type: 'string' }, rejectedBy: { type: 'string' }, reasonCategory: { type: 'string' }, reasonDetail: { type: 'string' } }, required: ['applicationId', 'stage'] } },
];
const mayWrite = (user) => !['mgmt', 'bde', 'client', 'candidate', 'none', 'accounts'].includes(C.viewRole(user));

async function toolsFor(user) {
  if (!(await C.switchOn('mcpWrite')) || !mayWrite(user)) return [];
  return TOOLS;
}
function stageCode(v) {
  const s = String(v || '').trim();
  const V = require('../atsVocab'); // eslint-disable-line global-require
  if (V.STAGE_LABELS[s.toUpperCase()]) return s.toUpperCase();
  const hit = Object.entries(V.STAGE_LABELS).find(([, label]) => String(label).toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : s.toUpperCase().replace(/\s+/g, '_');
}
const idOk = (v) => /^[A-Za-z0-9_-]{6,64}$/.test(String(v || ''));
const said = (r, fallback) => (r.body && (r.body.error || r.body.message)) || fallback;

async function call(name, args, user) {
  if (!(await toolsFor(user)).some((t) => t.name === name)) return null; // switched off / not this person's: "unknown tool"
  const a = args || {};
  if (name === 'ats_add_note') {
    if (!idOk(a.candidateId)) return { error: 'candidateId is needed.' };
    const note = String(a.note || '').trim().slice(0, 4000);
    if (!note) return { error: 'The note is empty.' };
    const r = await C.asUser(user, 'POST', `/candidates/${encodeURIComponent(a.candidateId)}/notes`, { body: `${note}\n(added by an AI tool through MCP)`, applicationId: idOk(a.applicationId) ? a.applicationId : null });
    return r.status < 300 ? { ok: true, noteId: r.body.id } : { error: r.status === 404 || r.status === 403 ? 'Not found or not in your scope.' : said(r, 'The note was not saved.') };
  }
  if (name === 'ats_add_follow_up') {
    if (!idOk(a.applicationId)) return { error: 'applicationId is needed.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.dueDate || ''))) return { error: 'dueDate is YYYY-MM-DD.' };
    if (a.dueTime && !/^\d{2}:\d{2}$/.test(String(a.dueTime))) return { error: 'dueTime is HH:MM.' };
    const r = await C.asUser(user, 'POST', '/followups', { applicationId: a.applicationId, dueDate: a.dueDate, dueTime: a.dueTime || undefined, nextAction: String(a.nextAction || '').slice(0, 300) || undefined, notes: a.notes ? `${String(a.notes).slice(0, 1500)} (AI tool, MCP)` : '(added by an AI tool through MCP)', contacted: false });
    return r.status < 300 ? { ok: true, followUpId: r.body.id || (r.body.followUp && r.body.followUp.id) || null, dueDate: a.dueDate } : { error: r.status === 403 || r.status === 404 ? said(r, 'Not found or not in your scope.') : said(r, 'The follow-up was not saved.') };
  }
  if (name === 'ats_move_stage') {
    if (!idOk(a.applicationId)) return { error: 'applicationId is needed.' };
    const stage = stageCode(a.stage);
    const r = await C.asUser(user, 'PATCH', `/applications/${encodeURIComponent(a.applicationId)}/stage`, { stage, comment: a.comment ? `${String(a.comment).slice(0, 1000)} (AI tool, MCP)` : '(moved by an AI tool through MCP)', rejectedBy: a.rejectedBy, reasonCategory: a.reasonCategory, reasonDetail: a.reasonDetail });
    return r.status < 300 ? { ok: true, stage, step: require('../atsVocab').STAGE_LABELS[stage] || stage } : { error: said(r, 'The step was not changed.'), code: r.body && r.body.code }; // eslint-disable-line global-require
  }
  return null;
}

module.exports = { TOOLS, toolsFor, call, stageCode };

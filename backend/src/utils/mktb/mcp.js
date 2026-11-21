// ---------------------------------------------------------------------------
// MCP SERVER (market wave B 09.14): READ-ONLY tools over the ATS data the token's own login may see, for an outside AI tool
// (Claude Desktop, an IDE agent ...). OFF by default (mcp.on, Admin). JSON-RPC 2.0 over HTTP POST /api/mcp (MCP "streamable HTTP",
// plain JSON answers). Auth: "Authorization: Bearer mcp_..." - a token a login makes for itself in AI governance > MCP; only its
// SHA-256 is stored; revoking it ends access at once. Every tool call is audited. Contact details are never returned.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const S = require('./store');

const PROTOCOL = '2025-06-18';
async function createToken(user, label) {
  const token = `mcp_${crypto.randomBytes(24).toString('base64url')}`;
  const id = S.newId();
  await S.x('INSERT INTO "MktMcpToken" ("id","userId","userName","label","tokenHash","createdAt") VALUES (?,?,?,?,?,?)', id, user.id, user.name, S.clean(label, 60) || 'MCP token', S.hash(token), S.now());
  return { id, token, note: 'Copy it now: it is shown only once. It reads only what your own login may see, and can never change anything.' };
}
async function tokens(user) {
  return S.q('SELECT "id","label","createdAt","lastUsedAt","revokedAt" FROM "MktMcpToken" WHERE "userId" = ? ORDER BY "createdAt" DESC', user.id);
}
async function revoke(id, user) {
  const n = await S.x('UPDATE "MktMcpToken" SET "revokedAt" = ? WHERE "id" = ? AND "userId" = ? AND "revokedAt" IS NULL', S.now(), id, user.id);
  return S.num(n) ? { ok: true } : { error: 'Token not found.', status: 404 };
}
async function identityOf(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer mcp_') ? h.slice(7) : null;
  if (!tok) return null;
  const [row] = await S.q('SELECT * FROM "MktMcpToken" WHERE "tokenHash" = ? AND "revokedAt" IS NULL', S.hash(tok));
  if (!row) return null;
  const { resolveIdentity } = require('../identity'); // eslint-disable-line global-require
  const u = await resolveIdentity(row.userId).catch(() => null);
  if (!u || (u.status && u.status !== 'Active')) return null;
  await S.x('UPDATE "MktMcpToken" SET "lastUsedAt" = ? WHERE "id" = ?', S.now(), row.id);
  return u;
}

const TOOLS = [
  { name: 'search_candidates', description: 'Search the candidates you may see, in plain words (e.g. "java developers in hyderabad 5+ years notice 30 days"). Returns names, role, experience, location, skills. Never contact details.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_candidate', description: 'One candidate you may see: profile facts and where each application stands. Never contact details.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_requirements', description: 'Open requirements (jobs) you may see.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_requirement', description: 'One requirement you may see, with its pipeline counts per step.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
async function callTool(name, args, user) {
  const scope = require('../scope'); // eslint-disable-line global-require
  const V = require('../atsVocab'); // eslint-disable-line global-require
  if (name === 'search_candidates') {
    const C = require('./cands'); // eslint-disable-line global-require
    const f = await C.parseNl(String(args.query || '').slice(0, 300));
    const r = await C.search(f, user, { limit: 25 });
    return { filters: C.filterChips(f), total: r.total, people: r.rows.map((p) => ({ id: p.id, name: p.name, designation: p.designation, experienceYears: p.experienceYears, location: p.location, skills: p.skills })) };
  }
  if (name === 'get_candidate') {
    const c = await prisma.candidate.findFirst({ where: { AND: [scope.candidateWhere(user), { id: String(args.id || '') }] }, select: { id: true, name: true, currentDesignation: true, currentCompany: true, experienceYears: true, location: true, skills: true, education: true, noticePeriod: true, applications: { select: { stage: true, updatedAt: true, requirement: { select: { id: true, title: true } } } } } });
    if (!c) return { error: 'Not found or not in your scope.' };
    return { ...c, applications: c.applications.map((a) => ({ requirement: a.requirement.title, requirementId: a.requirement.id, step: V.STAGE_LABELS[a.stage] || a.stage, updatedAt: a.updatedAt })) };
  }
  if (name === 'list_requirements') {
    const rows = await prisma.requirement.findMany({ where: { AND: [scope.requirementWhere(user), { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] } }] }, select: { id: true, reqCode: true, title: true, location: true, experience: true, skills: true, openings: true, department: true }, orderBy: { createdAt: 'desc' }, take: Math.min(100, Number(args.limit) || 25) });
    return { requirements: rows };
  }
  if (name === 'get_requirement') {
    const r = await prisma.requirement.findFirst({ where: { AND: [scope.requirementWhere(user), { id: String(args.id || '') }] }, select: { id: true, reqCode: true, title: true, status: true, location: true, experience: true, skills: true, goodToHaveSkills: true, openings: true, department: true, employmentType: true, workMode: true, jobDescription: true } });
    if (!r) return { error: 'Not found or not in your scope.' };
    const by = await prisma.application.groupBy({ by: ['stage'], where: { AND: [scope.applicationWhere(user), { requirementId: r.id }] }, _count: { _all: true } });
    return { ...r, jobDescription: String(r.jobDescription || '').slice(0, 3000), pipeline: by.map((b) => ({ step: V.STAGE_LABELS[b.stage] || b.stage, count: b._count._all })) };
  }
  return { error: `Unknown tool ${name}` };
}

async function handle(req, res) {
  const rpcErr = (id, code, message) => res.status(200).json({ jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } });
  if (!(await S.setting('mcp.on'))) return res.status(403).json({ error: 'The MCP server is switched off. An Admin turns it on in Administration > AI governance.' });
  const user = await identityOf(req);
  if (!user) return res.status(401).json({ error: 'A valid MCP token is needed (Authorization: Bearer mcp_...).' });
  const ext = require('../permissions'); // eslint-disable-line global-require
  if (ext.isExternalLogin && ext.isExternalLogin(user)) return res.status(403).json({ error: 'MCP is for TeamLink staff logins.' });
  const msg = req.body || {};
  if (Array.isArray(msg)) return rpcErr(null, -32600, 'Batches are not supported.');
  const { id, method, params = {} } = msg;
  if (!method) return rpcErr(id, -32600, 'Invalid request.');
  if (method.startsWith('notifications/')) return res.status(202).end();
  if (method === 'initialize') return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'teamlink-ats', version: '1.0.0' }, instructions: 'Read-only TeamLink ATS tools. Results are limited to what the token owner may see. Contact details are never returned.' } });
  if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = String(params.name || '');
    if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
    try {
      const out = await callTool(name, params.arguments || {}, user);
      await require('../audit').logAudit({ userId: user.id, action: `MCP tool used: ${name}`, entity: 'Mcp', entityId: name, toValue: JSON.stringify(params.arguments || {}).slice(0, 200) }); // eslint-disable-line global-require
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: !!out.error } });
    } catch (e) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
  }
  return rpcErr(id, -32601, `Method not found: ${method}`);
}

module.exports = { createToken, tokens, revoke, handle, TOOLS, PROTOCOL };

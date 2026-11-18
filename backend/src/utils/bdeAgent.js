// ---------------------------------------------------------------------------
// THE BDE AGENT (founder 2026-11-18: "bde ki matrame oka agent kaavali - bde ki sambandhinchi ey information kavali anna, ey doubts vunna,
// agent ni adigithey ventaney accurate ga answer cheyyali, fast ga quick replies ivvali").
//
// WHO: only a BDE (atsRole BDE) or a BDE TL (a TL of the BDE department). Everybody else gets 403 (routes/bdeAgent.js).
// WHAT IT KNOWS: exactly what that login may see, read through the same scope helpers the screens use (utils/scope.js clientWhere,
//   requirementWhere, applicationWhere) plus the BDE's pending client work (utils/clientWork.js bdePending) and their CRM leads, deals,
//   follow-ups and target when they are on the sales team (crm/service.js scope). Nothing outside that scope is ever read.
// HOW IT STAYS ACCURATE: the model sees a FACTS block of that data and is told to answer from it alone, to say "not in your data" instead of
//   guessing, and never to invent a number, name or date. Questions that name a client or a requirement get that record's full details.
// HOW IT STAYS FAST: the facts are built once and kept for 60 seconds per login (a follow-up question does not read the database again),
//   and the answer comes from the free fast model (utils/fastAi.js: Groq, then Gemini, then OpenRouter, then the app's own AI).
// READ-ONLY: it changes nothing.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { clientWhere, requirementWhere, applicationWhere, isBdeTl, scopeOf } = require('./scope');
const fastAi = require('./fastAi');

const FACTS_TTL_MS = 60000;
const factsCache = new Map(); // userId -> { at, facts, clients, reqs }

// Who may use it: BDE and BDE TL logins, plus (founder 2026-11-18) the Super Admin and Developer logins. Everybody still reads only their
// OWN scope through the same helpers below (a Super Admin sees every client, a Developer only what their login may see).
function isBdeAgentUser(user) {
  if (!user) return false;
  if (String(user.atsRole || '').toUpperCase() === 'BDE') return true;
  if (String(user.role || '').toUpperCase() === 'SUPER_ADMIN' || String(user.atsRole || '').toUpperCase() === 'SUPER_ADMIN') return true;
  if (/develop/i.test(String(user.designation || ''))) return true;
  try { return !!isBdeTl(user); } catch { return false; }
}

const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const d10 = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

const STAGE_WORD = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
const JOINED = ['JOINED'];
const SELECTED = ['SELECTED', 'OFFERED', 'OFFER_ACCEPTED', 'DOCUMENTS_PENDING', 'JOINING_PENDING'];

async function safe(fn, fallback) { try { return await fn(); } catch (err) { console.error('[bde-agent]', err.message); return fallback; } } // eslint-disable-line no-console

// THE FACTS, IN SECTIONS (2026-11-18): the live site has 1,500+ candidates and every client, and the whole block used to go to the model on every
// question: it ran into the free plan's tokens-per-minute limit and then into the slow local model (the web server's 60 s). Now: exact COUNTS
// always (read from the database, not from a capped list), and the DETAIL sections only for what the question is about, each capped, the lot
// kept under MAX_FACT_CHARS (about 3,500 tokens).
const MAX_FACT_CHARS = 14000;
const CAPS = { clients: 60, reqs: 40, cands: 12, pending: 6, crm: 10 };

async function buildFacts(user) {
  const today = istToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const monthStartDate = new Date(`${monthStart}T00:00:00.000Z`);
  const sc = await safe(() => scopeOf(user), {});
  const tl = (() => { try { return isBdeTl(user); } catch { return false; } })();
  const appScope = applicationWhere(user);

  const clients = await safe(() => prisma.client.findMany({
    where: clientWhere(user),
    select: {
      id: true, name: true, clientCode: true, status: true, priority: true, ownerDepartment: true, industry: true, location: true, bdeOwner: true,
      agreementStatus: true, agreementFeePercent: true, agreementStart: true, agreementEnd: true, agreementSentAt: true, agreementSignedAt: true,
      contactName: true, contactDesignation: true, contactPhone: true, contactEmail: true, paymentTerms: true, gstPercent: true, tdsPercent: true, createdAt: true,
    },
    orderBy: { name: 'asc' },
    take: 1000,
  }), []);

  const reqs = await safe(() => prisma.requirement.findMany({
    where: requirementWhere(user),
    select: {
      id: true, title: true, reqCode: true, status: true, priority: true, openings: true, department: true, location: true, workMode: true, salary: true,
      experience: true, skills: true, closingDate: true, targetDate: true, hiringType: true, tl: true, createdAt: true, clientId: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  }), []);

  // exact counts, not the length of a capped list
  const stageGroups = await safe(() => prisma.application.groupBy({ by: ['stage'], where: appScope, _count: { _all: true } }), []);
  const stageCount = {};
  let candTotal = 0;
  stageGroups.forEach((g) => { stageCount[STAGE_WORD(g.stage)] = g._count._all; candTotal += g._count._all; });
  const joinedWhere = { AND: [appScope, { stage: { in: JOINED }, joinedAt: { gte: monthStartDate } }] };
  const joinedMonthN = await safe(() => prisma.application.count({ where: joinedWhere }), 0);

  // the people lines (joined / selected / interviews): only the recent and upcoming ones
  const listSelect = { id: true, stage: true, requirementId: true, interviewAt: true, joiningDate: true, joinedAt: true, updatedAt: true, candidate: { select: { name: true } }, requirement: { select: { title: true, client: { select: { name: true } } } } };
  const joinedRows = await safe(() => prisma.application.findMany({ where: joinedWhere, select: listSelect, orderBy: { joinedAt: 'desc' }, take: CAPS.cands }), []);
  const selectedWhere = { AND: [appScope, { stage: { in: SELECTED } }] };
  const selectedRows = await safe(() => prisma.application.findMany({ where: selectedWhere, select: listSelect, orderBy: { updatedAt: 'desc' }, take: CAPS.cands }), []);
  const selectedN = await safe(() => prisma.application.count({ where: selectedWhere }), 0);
  const upcomingWhere = { AND: [appScope, { interviewAt: { gte: new Date(`${today}T00:00:00.000Z`) } }] };
  const upcomingRows = await safe(() => prisma.application.findMany({ where: upcomingWhere, select: listSelect, orderBy: { interviewAt: 'asc' }, take: CAPS.cands }), []);
  const upcomingN = await safe(() => prisma.application.count({ where: upcomingWhere }), 0);
  const perReq = await safe(() => prisma.application.groupBy({ by: ['requirementId', 'stage'], where: appScope, _count: { _all: true } }), []);
  const byReq = {};
  perReq.forEach((g) => { const o = (byReq[g.requirementId] = byReq[g.requirementId] || { n: 0, st: {} }); o.n += g._count._all; o.st[STAGE_WORD(g.stage)] = g._count._all; });

  const pending = await safe(() => require('./clientWork').bdePending(user), null); // eslint-disable-line global-require

  // ---- the SECTIONS -----------------------------------------------------------------------------------------------------------------
  const agr = {};
  clients.forEach((c) => { const k = c.agreementStatus || 'None'; agr[k] = (agr[k] || 0) + 1; });
  const unsignedList = clients.filter((c) => !/active|confirmed|signed/i.test(String(c.agreementStatus || '')));
  const openReqs = reqs.filter((r) => String(r.status).toUpperCase() === 'OPEN');
  const pendingTotal = pending && pending.total != null ? pending.total : 0;
  const sections = {};
  const role = tl ? 'BDE Team Lead (every client and agreement, view only)' : (String(user.role).toUpperCase() === 'SUPER_ADMIN' ? 'Super Admin (the whole company)' : 'BDE');
  sections.head = `Today: ${today} (IST). You are talking to ${user.name || 'a BDE'}, ${role}${sc && Array.isArray(sc.bdeDeskDepartments) && sc.bdeDeskDepartments.length ? `, desk: ${sc.bdeDeskDepartments.join(', ')}` : ''}. Money is in Indian rupees. TeamLink Consultants is a recruitment company: it earns a fee (agreement fee %) when a placed candidate joins a client.`;
  sections.counts = [
    `COUNTS (exact): clients ${clients.length}; agreements ${Object.entries(agr).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; agreements not signed / not active ${unsignedList.length}.`,
    `Requirements: ${reqs.length} in all, ${openReqs.length} open, ${reqs.filter((r) => String(r.status).toUpperCase() === 'CLOSED').length} closed, ${reqs.filter((r) => String(r.status).toUpperCase() === 'DRAFT').length} draft.`,
    `Candidates (applications) in your scope: ${candTotal}. By stage: ${Object.entries(stageCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    `Joined this month: ${joinedMonthN}. Selected / offered, not joined yet: ${selectedN}. Upcoming interviews: ${upcomingN}. Pending client work: ${pendingTotal} items.`,
  ].join('\n');
  const cl = (c) => `- ${c.name}${c.clientCode ? ` [${c.clientCode}]` : ''}: agreement ${c.agreementStatus || 'none'}${c.agreementFeePercent != null ? ` ${c.agreementFeePercent}%` : ''}${c.agreementEnd ? ` ends ${c.agreementEnd}` : ''}${c.agreementSentAt && !c.agreementSignedAt ? `, sent ${d10(c.agreementSentAt)} unsigned` : ''}; ${c.status || '-'}${c.priority ? `, ${c.priority}` : ''}${c.ownerDepartment ? `, ${c.ownerDepartment}` : ''}${tl && c.bdeOwner ? `, BDE ${c.bdeOwner}` : ''}`;
  // the unsigned ones first: that is what a BDE asks about
  const orderedClients = [...unsignedList, ...clients.filter((c) => !unsignedList.includes(c))];
  sections.clients = { title: 'CLIENTS (agreements not signed first)', lines: orderedClients.map(cl) };
  sections.reqs = {
    title: 'OPEN REQUIREMENTS',
    lines: openReqs.map((r) => {
      const b = byReq[r.id] || { n: 0, st: {} };
      const st = Object.entries(b.st).map(([k, v]) => `${k} ${v}`).join(', ');
      return `- ${r.reqCode ? `${r.reqCode} ` : ''}${r.title} (${(r.client && r.client.name) || '-'}): ${r.openings || 0} openings, ${r.priority || '-'}, ${r.department || '-'}${r.closingDate ? `, closes ${r.closingDate}` : ''}; candidates ${b.n}${b.n ? ` (${st})` : ''}`;
    }),
  };
  const who = (a) => `${(a.candidate && a.candidate.name) || '-'} (${(a.requirement && a.requirement.title) || '-'}, ${(a.requirement && a.requirement.client && a.requirement.client.name) || '-'})`;
  sections.cands = {
    title: 'CANDIDATE DETAILS',
    lines: [
      ...(joinedRows.length ? [`Joined this month: ${joinedRows.map(who).join('; ')}`] : []),
      ...(selectedRows.length ? [`Selected / offered, not joined: ${selectedRows.map((a) => `${who(a)}${a.joiningDate ? ` joining ${a.joiningDate}` : ''}`).join('; ')}`] : []),
      ...(upcomingRows.length ? [`Next interviews: ${upcomingRows.map((a) => `${d10(a.interviewAt)} ${who(a)}`).join('; ')}`] : []),
    ],
  };
  const pl = [];
  if (pending && pending.lists) {
    const labels = Object.fromEntries(require('./clientWork').BDE_TYPES.map((t) => [t.id, t.label])); // eslint-disable-line global-require
    Object.entries(pending.lists).forEach(([k, items]) => {
      if (!Array.isArray(items) || !items.length) return;
      pl.push(`${labels[k] || k}: ${items.length}`);
      items.slice(0, CAPS.pending).forEach((x) => {
        const bits = [x.candidate && x.candidate !== '—' ? x.candidate : '', x.job && x.job !== '—' ? x.job : '', x.client || x.name || x.title || '', x.step || '', x.waitedDays != null ? `waiting ${x.waitedDays} days` : '', x.status === 'late' ? 'LATE' : (x.status === 'due_today' ? 'due today' : '')].filter(Boolean);
        pl.push(`  - ${bits.join(', ')}`);
      });
    });
  }
  sections.pending = { title: `YOUR PENDING CLIENT WORK: ${pendingTotal} items`, lines: pl };

  // CRM: leads, deals, follow-ups, target (only for logins on the sales team)
  const crmLines = [];
  await safe(async () => {
    const S = require('../crm/service'); // eslint-disable-line global-require
    const DB = require('../crm/schema'); // eslint-disable-line global-require
    const r = S.roleOf(user);
    if (!r) return;
    const all = S.seesAll(r);
    const own = all ? '1=1' : '"ownerId" = ?';
    const p = all ? [] : [user.id];
    const deals = await DB.all(`SELECT d."title", d."stage", d."value", d."probability", d."expectedClose", d."nextStep", a."name" AS "account" FROM "CrmDeal" d LEFT JOIN "CrmAccount" a ON a."id" = d."accountId" WHERE ${own.replace('"ownerId"', 'd."ownerId"')} AND d."stage" NOT IN ('Won', 'Lost') ORDER BY d."value" DESC LIMIT ${CAPS.crm}`, ...p);
    const leads = await DB.all(`SELECT "company", "contactName", "status", "rating", "source", "city" FROM "CrmLead" WHERE ${own} AND "status" NOT IN ('Converted', 'Junk') ORDER BY "updatedAt" DESC LIMIT ${CAPS.crm}`, ...p);
    const late = await S.tasks(user, { when: 'overdue' });
    const todayTasks = await S.tasks(user, { when: 'today' }).catch(() => []);
    const tgt = await DB.one('SELECT "amount", "deals" FROM "CrmTarget" WHERE "ownerId" = ? AND "month" = ?', user.id, today.slice(0, 7)).catch(() => null);
    const won = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND substr(COALESCE("wonAt", "updatedAt"), 1, 7) = ?`, ...p, today.slice(0, 7)).catch(() => null);
    crmLines.push(`Open deals ${deals.length}+, won this month ${won ? `${won.n} deals ${money(won.v)}` : 'unknown'}${tgt ? `, target this month ${money(tgt.amount)}${tgt.deals ? ` / ${tgt.deals} deals` : ''}` : ', no target set this month'}.`);
    deals.forEach((d) => crmLines.push(`- Deal ${d.title} (${d.account || '-'}): ${d.stage} ${d.probability || 0}%, ${money(d.value)}, close ${d.expectedClose || 'not set'}${d.nextStep ? `, next: ${clip(d.nextStep, 60)}` : ''}`));
    leads.forEach((l) => crmLines.push(`- Lead ${l.company}${l.contactName ? ` (${l.contactName})` : ''}: ${l.status}${l.rating ? `, ${l.rating}` : ''}${l.source ? `, from ${l.source}` : ''}`));
    const tlist = (arr, n) => arr.slice(0, n).map((t) => `${t.title} (${t.recordName || '-'}${t.dueDate ? `, due ${t.dueDate}` : ''})`).join('; ');
    crmLines.push(`Follow-ups due today: ${todayTasks.length}${todayTasks.length ? ` - ${tlist(todayTasks, 6)}` : ''}. Late: ${late.length}${late.length ? ` - ${tlist(late, 6)}` : ''}.`);
  }, null);
  sections.crm = { title: 'CRM (sales)', lines: crmLines };

  return {
    sections,
    clients,
    reqs,
    counts: { candidates: candTotal, clients: clients.length, openRequirements: openReqs.length, unsigned: unsignedList.length },
    facts: compose({ sections }, '', { all: true }),
  };
}

// which detail sections a question needs (the head and the exact counts are always there)
function wanted(question) {
  const t = String(question || '').toLowerCase();
  const w = new Set();
  if (/client|agreement|sign|fee|contract|compan|hospital|college|institute|account/.test(t)) w.add('clients');
  if (/requirement|\breq\b|req-|job|opening|vacanc|position|hiring|role/.test(t)) w.add('reqs');
  if (/candidate|pipeline|interview|joined|join|selected|offer|stage|profile|resume|shortlist|placement|placed/.test(t)) w.add('cands');
  if (/pending|today|follow|chase|waiting|reply|late|todo|to-do|work|task|urgent|priority/.test(t)) w.add('pending');
  if (/deal|lead|crm|target|revenue|sales|quota|meeting/.test(t)) w.add('crm');
  return w;
}
function compose(built, question, { all = false } = {}) {
  const S = built.sections;
  const w = all ? new Set(['clients', 'reqs', 'cands', 'pending', 'crm']) : wanted(question);
  const general = !all && !w.size; // nothing named: a small look at everything
  const out = [S.head, S.counts];
  ['clients', 'reqs', 'cands', 'pending', 'crm'].forEach((k) => {
    if (!(w.has(k) || general)) return;
    const sec = S[k];
    if (!sec || !sec.lines || !sec.lines.length) return;
    const cap = general ? 8 : (all ? 400 : CAPS[k]);
    const shown = sec.lines.slice(0, cap);
    const more = sec.lines.length > shown.length ? `\n(+${sec.lines.length - shown.length} more; ask about one by name or narrow the question)` : '';
    out.push(`\n${sec.title}:\n${shown.join('\n')}${more}`);
  });
  let text = out.join('\n');
  if (!all && text.length > MAX_FACT_CHARS) text = `${text.slice(0, MAX_FACT_CHARS)}\n(...shortened: ask a narrower question for the rest)`;
  return text;
}

async function factsFor(user, { fresh = false } = {}) {
  const hit = factsCache.get(user.id);
  if (!fresh && hit && Date.now() - hit.at < FACTS_TTL_MS) return hit;
  const built = { at: Date.now(), ...(await buildFacts(user)) };
  factsCache.set(user.id, built);
  if (factsCache.size > 500) factsCache.delete(factsCache.keys().next().value);
  return built;
}

// The client / requirement the question names: its full record (still from the scoped lists above, so nothing new is read).
const STOP = new Set('the and for with this that what which who when where how many much have has are was were our your you my me all any can please tell show give list about from into they them their there status client clients requirement requirements candidate candidates agreement agreements today week month year details info information pending open closed late due joined join interview interviews deal deals lead leads target follow ups follow-ups enti emi entha ela evaru eppudu cheppu chupinchu kavali undi unnayi vunnayi lo ki ni ga'.split(' '));
function mentioned(question, built) {
  const q = String(question || '').toLowerCase();
  const words = (q.match(/[a-z0-9][a-z0-9&.-]{2,}/g) || []).filter((w) => !STOP.has(w));
  if (!words.length) return '';
  const score = (name) => { const n = String(name || '').toLowerCase(); return words.reduce((s, w) => s + (n.includes(w) ? w.length : 0), 0); };
  const out = [];
  built.clients.map((c) => ({ c, s: Math.max(score(c.name), score(c.clientCode)) })).filter((x) => x.s >= 4).sort((a, b) => b.s - a.s).slice(0, 2).forEach(({ c }) => {
    const rq = built.reqs.filter((r) => r.clientId === c.id);
    out.push(`CLIENT DETAIL - ${c.name}${c.clientCode ? ` [${c.clientCode}]` : ''}: status ${c.status || '-'}, priority ${c.priority || '-'}, industry ${c.industry || '-'}, location ${c.location || '-'}, department ${c.ownerDepartment || '-'}, BDE ${c.bdeOwner || '-'}. Contact: ${c.contactName || '-'}${c.contactDesignation ? `, ${c.contactDesignation}` : ''}${c.contactPhone ? `, ${c.contactPhone}` : ''}${c.contactEmail ? `, ${c.contactEmail}` : ''}. Agreement: ${c.agreementStatus || 'none'}${c.agreementFeePercent != null ? `, fee ${c.agreementFeePercent}%` : ''}${c.agreementStart ? `, from ${c.agreementStart}` : ''}${c.agreementEnd ? ` to ${c.agreementEnd}` : ''}${c.agreementSentAt ? `, sent ${d10(c.agreementSentAt)}` : ''}${c.agreementSignedAt ? `, signed ${d10(c.agreementSignedAt)}` : ''}. Payment terms: ${c.paymentTerms || '-'}; GST ${c.gstPercent != null ? `${c.gstPercent}%` : '-'}; TDS ${c.tdsPercent != null ? `${c.tdsPercent}%` : '-'}. Client since ${d10(c.createdAt)}. Requirements: ${rq.length ? rq.map((r) => `${r.title} (${r.status}, ${r.openings || 0} openings)`).join('; ') : 'none'}.`);
  });
  built.reqs.map((r) => ({ r, s: Math.max(score(r.title), score(r.reqCode)) })).filter((x) => x.s >= 5).sort((a, b) => b.s - a.s).slice(0, 2).forEach(({ r }) => {
    const a = built.apps.filter((x) => x.requirementId === r.id);
    out.push(`REQUIREMENT DETAIL - ${r.reqCode ? `${r.reqCode} ` : ''}${r.title} for ${(r.client && r.client.name) || '-'}: status ${r.status}, ${r.openings || 0} openings, priority ${r.priority || '-'}, department ${r.department || '-'}, location ${r.location || '-'} ${r.workMode || ''}, experience ${r.experience || '-'}, salary ${r.salary || '-'}, skills ${clip(r.skills, 160) || '-'}, hiring ${r.hiringType || '-'}, TL ${r.tl || '-'}, opened ${d10(r.createdAt)}${r.closingDate ? `, closes ${r.closingDate}` : ''}. Candidates (${a.length}): ${a.slice(0, 20).map((x) => `${(x.candidate && x.candidate.name) || '-'} - ${STAGE_WORD(x.stage)}${x.interviewAt ? `, interview ${d10(x.interviewAt)}` : ''}`).join('; ') || 'none'}.`);
  });
  return out.join('\n');
}

const SYSTEM = `You are the BDE Agent inside TeamLink (TeamLink Consultants, an Indian recruitment / staffing company). You help one Business Development Executive with their clients, agreements, requirements, candidates, pending client work and sales pipeline.
RULES:
- Answer ONLY from the FACTS below. If the answer is not in the facts, say plainly that it is not in their TeamLink data - never guess.
- Never invent a number, name, date, fee or phone number. Copy them exactly from the facts.
- Be quick and practical: answer first in 1-4 short lines or a short list; add the next step only when it helps.
- Reply in the language and style the BDE writes in (English, Telugu, Hindi, or Telugu/Hindi written in English letters).
- For a general BDE doubt (how to pitch, how to handle an objection, what to say in a follow-up), give short practical advice for Indian recruitment sales, and say it is general advice.
- You cannot change anything in TeamLink; tell them which screen to use (Clients, Requirements, Candidates, CRM) when they want to do something.`;

async function ask(user, { question, history } = {}) {
  const q = clip(question, 1000);
  if (!q) return { status: 400, body: { error: 'Ask a question.' } };
  const t0 = Date.now();
  const built = await factsFor(user);
  const extra = mentioned(q, built);
  const hist = (Array.isArray(history) ? history : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-8);
  const system = `${SYSTEM}\n\nFACTS (read ${new Date(built.at).toISOString().slice(11, 16)} UTC):\n${compose(built, q)}${extra ? `\n\n${extra}` : ''}`;
  try {
    const r = await fastAi.chat(system, [...hist, { role: 'user', content: q }], { maxTokens: 900, temperature: 0.1 });
    return { status: 200, body: { text: r.text, provider: r.provider, model: r.model, ms: Date.now() - t0, note: r.note || '' } };
  } catch (err) {
    return { status: err.status && err.status < 600 ? err.status : 503, body: { error: err.message || 'The BDE Agent could not answer right now.' } };
  }
}

async function overview(user) {
  const built = await factsFor(user);
  const st = await fastAi.status().catch(() => ({ ready: false }));
  return { status: 200, body: { clients: built.counts.clients, openRequirements: built.counts.openRequirements, unsignedAgreements: built.counts.unsigned, candidates: built.counts.candidates, aiReady: !!st.ready, fastReady: !!st.fastReady } };
}

module.exports = { isBdeAgentUser, ask, overview, factsFor, buildFacts, compose, wanted };

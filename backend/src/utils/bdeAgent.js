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

function isBdeAgentUser(user) {
  if (!user) return false;
  if (String(user.atsRole || '').toUpperCase() === 'BDE') return true;
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

async function buildFacts(user) {
  const today = istToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const scope = safe(() => scopeOf(user), {});
  const sc = await scope;
  const tl = (() => { try { return isBdeTl(user); } catch { return false; } })();

  const clients = await safe(() => prisma.client.findMany({
    where: clientWhere(user),
    select: {
      id: true, name: true, clientCode: true, status: true, priority: true, ownerDepartment: true, industry: true, location: true, bdeOwner: true,
      agreementStatus: true, agreementFeePercent: true, agreementStart: true, agreementEnd: true, agreementSentAt: true, agreementSignedAt: true,
      contactName: true, contactDesignation: true, contactPhone: true, contactEmail: true, paymentTerms: true, gstPercent: true, tdsPercent: true, createdAt: true,
    },
    orderBy: { name: 'asc' },
    take: 400,
  }), []);

  const reqs = await safe(() => prisma.requirement.findMany({
    where: requirementWhere(user),
    select: {
      id: true, title: true, reqCode: true, status: true, priority: true, openings: true, department: true, location: true, workMode: true, salary: true,
      experience: true, skills: true, closingDate: true, targetDate: true, hiringType: true, tl: true, createdAt: true, clientId: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 400,
  }), []);

  const apps = await safe(() => prisma.application.findMany({
    where: applicationWhere(user),
    select: {
      id: true, stage: true, requirementId: true, interviewAt: true, interviewStatus: true, joiningDate: true, joinedAt: true, offeredCtc: true, updatedAt: true,
      candidate: { select: { name: true } },
      requirement: { select: { title: true, client: { select: { name: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 1500,
  }), []);

  const pending = await safe(() => require('./clientWork').bdePending(user), null); // eslint-disable-line global-require

  // ---- the FACTS block (kept compact so the free models answer quickly) ----------------------------------------------------------
  const L = [];
  L.push(`Today: ${today} (IST). You are talking to ${user.name || 'a BDE'}, ${tl ? 'BDE Team Lead (sees every client and agreement, view only)' : 'BDE'}${sc && Array.isArray(sc.bdeDeskDepartments) && sc.bdeDeskDepartments.length ? `, desk: ${sc.bdeDeskDepartments.join(', ')}` : ''}.`);
  L.push('Money is in Indian rupees. TeamLink Consultants is a recruitment company: it earns a fee (agreement fee %) when a placed candidate joins a client.');

  // clients + agreements
  const agr = {};
  clients.forEach((c) => { const k = c.agreementStatus || 'None'; agr[k] = (agr[k] || 0) + 1; });
  L.push('', `CLIENTS: ${clients.length}. Agreements by status: ${Object.entries(agr).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  clients.slice(0, 120).forEach((c) => {
    L.push(`- ${c.name}${c.clientCode ? ` [${c.clientCode}]` : ''}: ${c.status || 'status not set'}${c.priority ? `, priority ${c.priority}` : ''}${c.ownerDepartment ? `, ${c.ownerDepartment}` : ''}; agreement ${c.agreementStatus || 'none'}${c.agreementFeePercent != null ? ` fee ${c.agreementFeePercent}%` : ''}${c.agreementEnd ? ` ends ${c.agreementEnd}` : ''}${c.agreementSentAt && !c.agreementSignedAt ? `, sent ${d10(c.agreementSentAt)} not signed` : ''}${tl && c.bdeOwner ? `; BDE ${c.bdeOwner}` : ''}`);
  });
  if (clients.length > 120) L.push(`(+${clients.length - 120} more clients; ask about one by name for its details)`);

  // requirements
  const open = reqs.filter((r) => String(r.status).toUpperCase() === 'OPEN');
  const byReq = {};
  apps.forEach((a) => { (byReq[a.requirementId] = byReq[a.requirementId] || []).push(a); });
  L.push('', `REQUIREMENTS: ${reqs.length} in all, ${open.length} open, ${reqs.filter((r) => String(r.status).toUpperCase() === 'CLOSED').length} closed, ${reqs.filter((r) => String(r.status).toUpperCase() === 'DRAFT').length} draft.`);
  open.slice(0, 100).forEach((r) => {
    const a = byReq[r.id] || [];
    const st = {};
    a.forEach((x) => { const w = STAGE_WORD(x.stage); st[w] = (st[w] || 0) + 1; });
    L.push(`- ${r.reqCode ? `${r.reqCode} ` : ''}${r.title} (${(r.client && r.client.name) || '-'}): ${r.openings || 0} openings${r.priority ? `, ${r.priority}` : ''}${r.department ? `, ${r.department}` : ''}${r.closingDate ? `, closes ${r.closingDate}` : ''}; candidates ${a.length}${a.length ? ` (${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  });

  // candidates the BDE follows (BDE stages only, from the scope)
  const stageCount = {};
  apps.forEach((a) => { const w = STAGE_WORD(a.stage); stageCount[w] = (stageCount[w] || 0) + 1; });
  const joinedMonth = apps.filter((a) => JOINED.includes(a.stage) && d10(a.joinedAt || a.updatedAt) >= monthStart);
  const selectedNotJoined = apps.filter((a) => SELECTED.includes(a.stage));
  const upcoming = apps.filter((a) => a.interviewAt && d10(a.interviewAt) >= today).sort((x, y) => String(x.interviewAt).localeCompare(String(y.interviewAt)));
  L.push('', `CANDIDATES in your scope: ${apps.length}. By stage: ${Object.entries(stageCount).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  L.push(`Joined this month (${monthStart} to ${today}): ${joinedMonth.length}${joinedMonth.length ? ` - ${joinedMonth.slice(0, 15).map((a) => `${(a.candidate && a.candidate.name) || '-'} at ${(a.requirement && a.requirement.client && a.requirement.client.name) || '-'}`).join('; ')}` : ''}.`);
  L.push(`Selected / offered, not joined yet: ${selectedNotJoined.length}${selectedNotJoined.length ? ` - ${selectedNotJoined.slice(0, 15).map((a) => `${(a.candidate && a.candidate.name) || '-'} (${(a.requirement && a.requirement.title) || '-'}, ${(a.requirement && a.requirement.client && a.requirement.client.name) || '-'}${a.joiningDate ? `, joining ${a.joiningDate}` : ''})`).join('; ')}` : ''}.`);
  L.push(`Upcoming interviews: ${upcoming.length}${upcoming.length ? ` - ${upcoming.slice(0, 15).map((a) => `${d10(a.interviewAt)} ${(a.candidate && a.candidate.name) || '-'} for ${(a.requirement && a.requirement.title) || '-'} (${(a.requirement && a.requirement.client && a.requirement.client.name) || '-'})`).join('; ')}` : ''}.`);

  // pending client work
  if (pending && pending.lists) {
    const labels = Object.fromEntries(require('./clientWork').BDE_TYPES.map((t) => [t.id, t.label])); // eslint-disable-line global-require
    L.push('', `YOUR PENDING CLIENT WORK: ${pending.total || 0} items.`);
    Object.entries(pending.lists).forEach(([k, items]) => {
      if (!Array.isArray(items) || !items.length) return;
      L.push(`${labels[k] || k}: ${items.length}`);
      items.slice(0, 8).forEach((x) => {
        const bits = [x.candidate && x.candidate !== '—' ? x.candidate : '', x.job && x.job !== '—' ? x.job : '', x.client || x.name || x.title || '', x.step || '', x.waitedDays != null ? `waiting ${x.waitedDays} days` : '', x.status === 'late' ? 'LATE' : (x.status === 'due_today' ? 'due today' : '')].filter(Boolean);
        L.push(`  - ${bits.join(', ')}`);
      });
    });
  }

  // CRM: leads, deals, follow-ups, target (only for logins on the sales team)
  await safe(async () => {
    const S = require('../crm/service'); // eslint-disable-line global-require
    const DB = require('../crm/schema'); // eslint-disable-line global-require
    const r = S.roleOf(user);
    if (!r) return;
    const all = S.seesAll(r);
    const own = all ? '1=1' : '"ownerId" = ?';
    const p = all ? [] : [user.id];
    const deals = await DB.all(`SELECT d."title", d."stage", d."value", d."probability", d."expectedClose", d."nextStep", a."name" AS "account" FROM "CrmDeal" d LEFT JOIN "CrmAccount" a ON a."id" = d."accountId" WHERE ${own.replace('"ownerId"', 'd."ownerId"')} AND d."stage" NOT IN ('Won', 'Lost') ORDER BY d."value" DESC LIMIT 25`, ...p);
    const leads = await DB.all(`SELECT "company", "contactName", "status", "rating", "source", "city" FROM "CrmLead" WHERE ${own} AND "status" NOT IN ('Converted', 'Junk') ORDER BY "updatedAt" DESC LIMIT 25`, ...p);
    const late = await S.tasks(user, { when: 'overdue' });
    const todayTasks = await S.tasks(user, { when: 'today' }).catch(() => []);
    const tgt = await DB.one(`SELECT "amount", "deals" FROM "CrmTarget" WHERE "ownerId" = ? AND "month" = ?`, user.id, today.slice(0, 7)).catch(() => null);
    const won = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND substr(COALESCE("wonAt", "updatedAt"), 1, 7) = ?`, ...p, today.slice(0, 7)).catch(() => null);
    L.push('', `CRM (sales): open deals ${deals.length}, open leads ${leads.length}, won this month ${won ? `${won.n} deals ${money(won.v)}` : 'unknown'}${tgt ? `, target this month ${money(tgt.amount)}${tgt.deals ? ` / ${tgt.deals} deals` : ''}` : ', no target set this month'}.`);
    deals.forEach((d) => L.push(`- Deal ${d.title} (${d.account || '-'}): ${d.stage} ${d.probability || 0}%, ${money(d.value)}, close ${d.expectedClose || 'not set'}${d.nextStep ? `, next: ${clip(d.nextStep, 80)}` : ''}`));
    leads.forEach((l) => L.push(`- Lead ${l.company}${l.contactName ? ` (${l.contactName})` : ''}: ${l.status}${l.rating ? `, ${l.rating}` : ''}${l.source ? `, from ${l.source}` : ''}${l.city ? `, ${l.city}` : ''}`));
    L.push(`Follow-ups due today: ${todayTasks.length}${todayTasks.length ? ` - ${todayTasks.slice(0, 10).map((t) => `${t.title} (${t.recordName || '-'})`).join('; ')}` : ''}. Late follow-ups: ${late.length}${late.length ? ` - ${late.slice(0, 10).map((t) => `${t.title} (${t.recordName || '-'}, due ${t.dueDate})`).join('; ')}` : ''}.`);
  }, null);

  return { facts: L.join('\n'), clients, reqs, apps };
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
  const system = `${SYSTEM}\n\nFACTS (read ${new Date(built.at).toISOString().slice(11, 16)} UTC):\n${built.facts}${extra ? `\n\n${extra}` : ''}`;
  try {
    const r = await fastAi.chat(system, [...hist, { role: 'user', content: q }], { maxTokens: 700, temperature: 0.1 });
    return { status: 200, body: { text: r.text, provider: r.provider, model: r.model, ms: Date.now() - t0 } };
  } catch (err) {
    return { status: err.status && err.status < 600 ? err.status : 503, body: { error: err.message || 'The BDE Agent could not answer right now.' } };
  }
}

async function overview(user) {
  const built = await factsFor(user);
  const open = built.reqs.filter((r) => String(r.status).toUpperCase() === 'OPEN').length;
  const unsigned = built.clients.filter((c) => !/active|confirmed|signed/i.test(String(c.agreementStatus || ''))).length;
  const st = await fastAi.status().catch(() => ({ ready: false }));
  return { status: 200, body: { clients: built.clients.length, openRequirements: open, unsignedAgreements: unsigned, candidates: built.apps.length, aiReady: !!st.ready, fastReady: !!st.fastReady } };
}

module.exports = { isBdeAgentUser, ask, overview, factsFor, buildFacts };

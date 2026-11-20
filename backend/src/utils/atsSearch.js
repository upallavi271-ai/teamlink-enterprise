// ---------------------------------------------------------------------------
// THE ONE SEARCH (founder 2026-11-20: "a search bar on the dashboard: whatever I search, the complete end-to-end history must come").
//
// ONE engine for the top bar's "Search TeamLink", the dashboard bar and the full results page (GET /api/ats/history/search). It answers in groups,
// each row carrying the address of its COMPLETE HISTORY (`to`) and of the plain record (`recordTo`):
//
//   People                    recruiters, TLs, STLs, BDEs (name, employee code, seat, section) + employee records for logins that may view them
//   Clients                   name, old names, client code, legal name, GSTIN, location, contact person / phone / e-mail (client desk)
//   Requirements              title, REQ code, location, skills, client name (old names too)
//   Candidates                name, ID, phone, e-mail, skills, current company, designation, location
//   Interviews, offers & joinings   by candidate, role, client, interviewer
//   Invoices & agreements     invoice number, client, candidate (only a login that sees invoices); agreement client / number / status (not for the
//                             logins that never see agreements)
//   Other                     follow-up text, my own tasks, documents by file name (names only)
//
// MATCHING: every word must match somewhere (word order free), partial and any case; a phone number matches with or without spaces, +91, dashes;
// when little is found a SIMPLE TYPO is forgiven (one wrong, missing or extra letter) on names and titles; a Telugu name is found as typed and by
// its Latin spelling.
//
// SCOPE: every group runs through the login's own scope (candidateWhere / requirementWhere / clientWhere / applicationWhere / invoiceWhere /
// employeeWhere). A record the login may not see is never in the answer, and the answer for such a name is exactly the answer for a nonsense name.
//
// SPEED: typeahead (mode=type) asks each group for 5 rows and skips counts and headline numbers; the full page (default) counts and adds the numbers.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const SC = require('./scope');
const V = require('./atsVocab');
const H = require('./atsHistory');
const P = require('./atsHistoryPeople');

const MAX_TOKENS = 6;
const TYPE_TAKE = 5;
const FULL_TAKE = 12;
const GROUP_TITLES = {
  people: 'People', clients: 'Clients', requirements: 'Requirements', candidates: 'Candidates',
  events: 'Interviews, offers & joinings', money: 'Invoices & agreements', other: 'Other',
};
const GROUP_ORDER = ['people', 'clients', 'requirements', 'candidates', 'events', 'money', 'other'];

// ---- words ---------------------------------------------------------------------------------------------------------------------------------
const TELUGU = /[ఀ-౿]/;
const T_VOWEL = { 'అ': 'a', 'ఆ': 'aa', 'ఇ': 'i', 'ఈ': 'ee', 'ఉ': 'u', 'ఊ': 'oo', 'ఋ': 'ru', 'ఎ': 'e', 'ఏ': 'ee', 'ఐ': 'ai', 'ఒ': 'o', 'ఓ': 'o', 'ఔ': 'au' };
const T_SIGN = { 'ా': 'a', 'ి': 'i', 'ీ': 'i', 'ు': 'u', 'ూ': 'u', 'ృ': 'ru', 'ె': 'e', 'ే': 'e', 'ై': 'ai', 'ొ': 'o', 'ో': 'o', 'ౌ': 'au', 'ం': 'm', 'ః': 'h', 'ఁ': 'n' };
const T_CONS = {
  'క': 'k', 'ఖ': 'kh', 'గ': 'g', 'ఘ': 'gh', 'ఙ': 'n', 'చ': 'ch', 'ఛ': 'chh', 'జ': 'j', 'ఝ': 'jh', 'ఞ': 'n', 'ట': 't', 'ఠ': 'th', 'డ': 'd', 'ఢ': 'dh', 'ణ': 'n',
  'త': 't', 'థ': 'th', 'ద': 'd', 'ధ': 'dh', 'న': 'n', 'ప': 'p', 'ఫ': 'ph', 'బ': 'b', 'భ': 'bh', 'మ': 'm', 'య': 'y', 'ర': 'r', 'ల': 'l', 'వ': 'v', 'శ': 'sh', 'ష': 'sh',
  'స': 's', 'హ': 'h', 'ళ': 'l', 'ఱ': 'r',
};
// Telugu -> an approximate Latin spelling (a, ravi -> "ravi"): used as one more way to match a Latin-spelled name. Never shown.
function teluguToLatin(word) {
  const chars = [...word];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (T_VOWEL[c]) out += T_VOWEL[c];
    else if (T_CONS[c]) {
      const next = chars[i + 1];
      if (next === '్') { out += T_CONS[c]; i += 1; } else if (next && T_SIGN[next] !== undefined) { out += T_CONS[c] + T_SIGN[next]; i += 1; } else out += `${T_CONS[c]}a`;
    } else if (T_SIGN[c] !== undefined) out += T_SIGN[c];
    else if (/[a-z0-9]/i.test(c)) out += c.toLowerCase();
  }
  return out.replace(/a$/, '');
}
function tokensOf(q) {
  return String(q || '').normalize('NFC').toLowerCase().split(/[\s,;/|]+/).map((t) => t.replace(/^[^\p{L}\p{N}@+]+|[^\p{L}\p{N}@]+$/gu, '')).filter((t) => t.length >= 1).slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, 40));
}
const digitsOf = (q) => String(q || '').replace(/\D/g, '');
// "98765 43210", "+91-98765-43210", "(040) 2345 6789": mostly digits and phone punctuation
const phoneLike = (q) => digitsOf(q).length >= 5 && /^[\d\s+\-().]+$/.test(String(q).trim());
const wordsOnly = (t) => t.replace(/[^\p{L}\p{N}]/gu, '');

// the plain "contains every word" test on a list of field builders: (token) => prisma condition
const allWords = (tokens, builders) => ({ AND: tokens.map((t) => ({ OR: builders.map((b) => b(t)).flat() })) });
const has = (field) => (t) => ({ [field]: { contains: t } });

// one wrong / missing / extra letter: SQLite LIKE patterns ( _ = any one letter ). A 4+ letter word only.
function typoPatterns(token) {
  const w = wordsOnly(token);
  const chars = [...w];
  const n = chars.length;
  if (n < 4) return [];
  const out = new Set();
  for (let i = 0; i < n; i += 1) {
    out.add(`%${chars.slice(0, i).join('')}_${chars.slice(i + 1).join('')}%`); // a wrong letter
    out.add(`%${chars.slice(0, i).concat(chars.slice(i + 1)).join('')}%`); // an extra letter typed
  }
  for (let i = 1; i < n; i += 1) out.add(`%${chars.slice(0, i).join('')}_${chars.slice(i).join('')}%`); // a missing letter
  for (let i = 0; i < n - 1; i += 1) { const c = [...chars]; [c[i], c[i + 1]] = [c[i + 1], c[i]]; out.add(`%${c.join('')}%`); } // two letters swapped
  return [...out];
}
// ids of rows of `table` whose `cols` match EVERY word loosely (a typo allowed in each word of 4+ letters). cap rows.
async function fuzzyIds(table, cols, tokens, cap = 60) {
  const parts = [];
  const args = [];
  for (const t of tokens) { // eslint-disable-line no-restricted-syntax
    const pats = typoPatterns(t);
    const plain = `%${wordsOnly(t)}%`;
    const alts = [];
    cols.forEach((c) => { alts.push(`"${c}" LIKE ?`); args.push(plain); pats.forEach((p) => { alts.push(`"${c}" LIKE ?`); args.push(p); }); });
    parts.push(`(${alts.join(' OR ')})`);
  }
  if (!parts.length) return [];
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE ${parts.join(' AND ')} LIMIT ${cap}`, ...args);
    return rows.map((r) => r.id);
  } catch { return []; }
}
const PHONE_SQL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE("${col}",' ',''),'-',''),'+',''),'(',''),')','')`;
async function phoneIds(table, cols, digits, cap = 200) {
  if (digits.length < 5) return [];
  const needle = `%${digits.slice(-10)}%`;
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE ${cols.map((c) => `${PHONE_SQL(c)} LIKE ?`).join(' OR ')} LIMIT ${cap}`, ...cols.map(() => needle));
    return rows.map((r) => r.id);
  } catch { return []; }
}
// Telugu words also try their Latin spelling (and the other way is already covered: a Latin word contains-matches a Latin-spelled name)
function expand(tokens) {
  return tokens.map((t) => (TELUGU.test(t) ? { t, alt: teluguToLatin(t) } : { t, alt: null }));
}
// match one word in the given builders, also by its Latin spelling when it is Telugu
const wordMatch = (tok, builders) => ({ OR: [...builders.map((b) => b(tok.t)).flat(), ...(tok.alt && tok.alt.length >= 3 ? builders.map((b) => b(tok.alt)).flat() : [])] });
const allWordsX = (toks, builders) => ({ AND: toks.map((tok) => wordMatch(tok, builders)) });

// rows whose NAME has a word starting with the first typed word come before the rest: asked first, so they are never pushed out of the
// window by alphabetical order (a common first name in a big company)
const wordStart = (field) => (tok) => ({ OR: [{ [field]: { startsWith: tok.t } }, { [field]: { contains: ` ${tok.t}` } }, ...(tok.alt && tok.alt.length >= 3 ? [{ [field]: { startsWith: tok.alt } }, { [field]: { contains: ` ${tok.alt}` } }] : [])] });
async function twoPass(findMany, baseAnd, matchWhere, toks, field, take, orderBy) {
  const first = toks.length ? [wordStart(field)(toks[0])] : [];
  const pass1 = first.length ? await findMany({ AND: [matchWhere, ...first, ...baseAnd] }, take) : [];
  if (pass1.length >= take) return pass1;
  const seen = new Set(pass1.map((r) => r.id));
  const pass2 = await findMany({ AND: [matchWhere, ...baseAnd] }, take * 3, orderBy);
  return [...pass1, ...pass2.filter((r) => !seen.has(r.id))];
}
const clip = (s, n = 90) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const codeOf = (id) => String(id || '').slice(-8).toUpperCase();
const idLikeOf = (text) => {
  const bare = text.replace(/^(id|can|cand|cl)[-\s#:]*/i, '');
  return /^[a-z0-9]{6,}$/i.test(bare) ? bare.toLowerCase() : '';
};
const viaOf = (toks, fields) => {
  const via = [];
  Object.entries(fields).forEach(([label, val]) => {
    const v = String(val || '').toLowerCase();
    if (v && toks.some((tok) => v.includes(tok.t) || (tok.alt && v.includes(tok.alt)))) via.push(label);
  });
  return via;
};
// rows that start with the first word, or have all words in the name, first
function rank(rows, toks, nameOf) {
  const first = toks.length ? toks[0].t : '';
  const score = (r) => {
    const n = String(nameOf(r) || '').toLowerCase();
    return (toks.length && toks.every((tok) => n.includes(tok.t)) ? 4 : 0) + (first && n.startsWith(first) ? 2 : 0) + (first && n.split(/\s+/).some((w) => w.startsWith(first)) ? 1 : 0);
  };
  return [...rows].sort((a, b) => score(b) - score(a) || String(nameOf(a)).localeCompare(String(nameOf(b))));
}
const dayOf = (d) => H.istDay(d);

// ---- the filters of the full results page ----------------------------------------------------------------------------------------------
const BY = ['name', 'client', 'requirement', 'recruiter', 'tl', 'bde'];
// Type, Status / step and Owner take SEVERAL values (a comma list, OR inside one filter; founder 2026-11-20)
const MPS = require('./multiParam');
const listOf = (v) => MPS.parseMulti(v);
const typeHas = (f, g) => !f.type || listOf(f.type).includes(g);
// INTERVIEWS, OFFERS & JOININGS, CLEARLY COUNTED (founder 2026-11-20: "many people here, but how many offers, how many joined, how many dropped?")
const EV_KEYS = ['interview:upcoming', 'interview:done', 'offer:released', 'offer:accepted', 'offer:declined', 'joining:joined', 'joining:dropped', 'joining:scheduled'];
const EV_LABEL = {
  'interview:upcoming': 'Interviews coming up', 'interview:done': 'Interviews done', 'offer:released': 'Offers waiting for an answer', 'offer:accepted': 'Offers accepted',
  'offer:declined': 'Offers declined', 'joining:joined': 'Joined (still working)', 'joining:dropped': 'Dropped / left after joining', 'joining:scheduled': 'Joining scheduled',
};
function filtersOf(q) {
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const txt = (v, n = 60) => String(v || '').trim().slice(0, n) || null;
  const num = (v) => { const n = Number(v); return String(v === undefined || v === null ? '' : v).trim() !== '' && Number.isFinite(n) ? n : null; };
  return {
    type: (() => { const t = MPS.parseMulti(q.type).filter((x) => GROUP_ORDER.includes(x)); return t.length ? t.join(',') : null; })(),
    from: ok(q.from) ? q.from : null, to: ok(q.to) ? q.to : null, status: txt(MPS.multiCsv(q.status), 300), owner: txt(MPS.multiCsv(q.owner), 800), client: txt(q.client), dept: txt(q.dept), loc: txt(q.loc), src: txt(q.src),
    ev: (() => { const e = MPS.parseMulti(q.ev).filter((x) => EV_KEYS.includes(x)); return e.length ? e : null; })(),
    by: BY.includes(q.by) ? q.by : null, ctcMin: num(q.ctcMin), ctcMax: num(q.ctcMax), expMin: num(q.expMin), expMax: num(q.expMax), notice: txt(q.notice, 20), skills: txt(q.skills, 80),
  };
}
// a filter on its own (no words typed) lists the matching records: the page is then a browse-by-filter screen
const hasFilters = (f) => Object.entries(f).some(([k, v]) => k !== 'type' && v !== null && v !== '');
const dateWhere = (f, field = 'createdAt') => {
  if (!f.from && !f.to) return [];
  return [{ [field]: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00+05:30`) } : {}), ...(f.to ? { lt: new Date(`${H.addDays(f.to, 1)}T00:00:00+05:30`) } : {}) } }];
};
const LEFT = ['Replacement Due', 'Replaced', 'Left after Guarantee', 'Dropped'];
const NOT_LEFT = { OR: [{ joiningStatus: null }, { joiningStatus: { notIn: LEFT } }] };
// the stage words of the lists: Joined = still working; Dropped = rejected at any step or left after joining (the one definition of the History)
const stageGroup = (s) => ({
  joined: { AND: [{ stage: { in: ['JOINED', 'HIRED'] } }, NOT_LEFT] },
  dropped: { OR: [{ stage: 'REJECTED' }, { AND: [{ stage: { in: ['JOINED', 'HIRED'] } }, { joiningStatus: { in: LEFT } }] }] },
  rejected: { stage: 'REJECTED' },
  active: { stage: { notIn: ['JOINED', 'HIRED', 'REJECTED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'] } },
  selected: { stage: { in: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'] } },
}[s] || null);
// several steps at once (OR); several owners at once (the owner's own applications, or the jobs they lead or manage)
const stageGroupsOf = (s) => { const w = listOf(s).map(stageGroup).filter(Boolean); return w.length ? (w.length === 1 ? w[0] : { OR: w }) : null; };
const ownerAppArm = (o) => ({ OR: listOf(o).flatMap((u) => [{ ownerRecruiterId: u }, { requirement: { tlId: u } }, { requirement: { bdeId: u } }]) });
const csvOf = (v) => String(v || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);

// the filters on a CANDIDATE (pay / notice only for a login that reads them: a BDE or a role without the contact-and-salary right never has them)
async function candidateFilters(v, f, limited) {
  const out = [...dateWhere(f)];
  if (f.src) out.push({ source: { contains: f.src } });
  if (f.loc && !limited) out.push({ location: { contains: f.loc } });
  if (f.expMin !== null) out.push({ experienceYears: { gte: f.expMin } });
  if (f.expMax !== null) out.push({ experienceYears: { lte: f.expMax } });
  csvOf(f.skills).forEach((sk) => out.push({ skills: { contains: sk } }));
  if (v.contact && !limited) {
    if (f.notice) out.push({ noticePeriod: { contains: f.notice } });
    if (f.ctcMin !== null || f.ctcMax !== null) {
      const lo = f.ctcMin === null ? 0 : f.ctcMin * 100000;
      const hi = f.ctcMax === null ? 1e12 : f.ctcMax * 100000;
      const col = `CAST(REPLACE(REPLACE("expectedSalary", ',', ''), ' ', '') AS REAL)`;
      try {
        const rows = await prisma.$queryRawUnsafe(`SELECT "id" FROM "Candidate" WHERE "expectedSalary" IS NOT NULL AND (CASE WHEN ${col} < 1000 THEN ${col} * 100000 ELSE ${col} END) BETWEEN ? AND ? LIMIT 30000`, lo, hi);
        out.push({ id: { in: rows.map((r) => r.id) } });
      } catch { out.push({ id: { in: [] } }); }
    }
  }
  const app = [];
  if (stageGroupsOf(f.status)) app.push(stageGroupsOf(f.status));
  if (f.owner) app.push(ownerAppArm(f.owner));
  if (f.client) app.push({ requirement: { client: { name: { contains: f.client } } } });
  if (f.dept) app.push({ requirement: { department: { contains: f.dept } } });
  if (app.length) out.push({ applications: { some: { AND: app } } });
  return out;
}


// WHO HANDLED IT (founder 2026-11-20: "who is the TL that handled this client, who the recruiters, who the BDE - it must be complete"):
// the BDE, the team lead(s) and the recruiters of a set of requirements - the ones named on the requirement AND the recruiters who actually worked
// its candidates (an application this login may see). Names only; one query for the people.
async function teamOfReqs(user, reqs, extraBde = []) {
  const ids = reqs.map((r) => r.id);
  const worked = ids.length ? await prisma.application.groupBy({ by: ['requirementId', 'ownerRecruiterId'], where: { AND: [{ requirementId: { in: ids } }, { ownerRecruiterId: { not: null } }, SC.applicationWhere(user)] } }).catch(() => []) : [];
  const per = new Map(ids.map((id) => [id, { tl: new Set(), rec: new Set(), bde: new Set() }]));
  reqs.forEach((r) => {
    const t = per.get(r.id);
    if (r.tlId) t.tl.add(r.tlId);
    if (r.bdeId) t.bde.add(r.bdeId);
    if (r.recruiterId) t.rec.add(r.recruiterId);
    String(r.recruiterIds || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => t.rec.add(x));
  });
  worked.forEach((w) => { const t = per.get(w.requirementId); if (t) t.rec.add(w.ownerRecruiterId); });
  const all = new Set(); per.forEach((t) => { [...t.tl, ...t.rec, ...t.bde].forEach((x) => all.add(x)); });
  const users = all.size ? await prisma.user.findMany({ where: { id: { in: [...all] } }, select: { id: true, name: true } }) : [];
  const nm = new Map(users.map((u) => [u.id, u.name]));
  const names = (set) => [...set].map((x) => nm.get(x)).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const out = new Map();
  per.forEach((t, id) => out.set(id, { tl: names(t.tl), recruiters: names(t.rec).filter((n) => !names(t.tl).includes(n)), bde: [...new Set([...names(t.bde), ...extraBde.filter(Boolean)])] }));
  return out;
}
const mergeTeams = (list) => {
  const u = (k) => [...new Set(list.flatMap((t) => t[k]))].sort((a, b) => a.localeCompare(b));
  return { bde: u('bde'), tl: u('tl'), recruiters: u('recruiters') };
};
const teamLine = (t) => {
  if (!t) return '';
  const part = (word, arr, max) => (arr.length ? `${word}: ${arr.slice(0, max).join(', ')}${arr.length > max ? ` +${arr.length - max} more` : ''}` : `${word}: —`);
  return [part('BDE', t.bde, 3), part(t.tl.length > 1 ? 'TLs' : 'TL', t.tl, 4), part('Recruiters', t.recruiters, 6)].join(' · ');
};

// ---- the groups ----------------------------------------------------------------------------------------------------------------------------
async function peopleGroup(user, v, ctx) {
  const { toks, text, take, full } = ctx;
  const rows = [];
  if (!toks.length) return { rows, count: 0 }; // a filter alone lists records, not people
  // a BDE finds themself, the BDE TL their BDEs (the logins that may open the BDE history, atsHistoryPeople.js mayBde)
  if (v.all || ['tl', 'recruiter'].includes(v.kind) || (v.bdeIds && v.bdeIds.size)) {
    const ids = new Set();
    const roles = ['RECRUITER', 'TL', 'STL', 'BDE'];
    (await prisma.user.findMany({ where: { atsRole: { in: roles }, ...allWordsX(toks, [has('name')]) }, select: { id: true }, take: 60 })).forEach((u) => ids.add(u.id));
    const t0 = toks[0] ? toks[0].t : text;
    if (toks.length === 1 || !ids.size) {
      const seat = await prisma.positionAssignment.findMany({ where: { toDate: null, position: { OR: [{ code: { contains: text } }, { name: { contains: text } }, { team: { contains: text } }] } }, select: { employee: { select: { userId: true } } }, take: 40 }).catch(() => []);
      seat.forEach((a) => { if (a.employee && a.employee.userId) ids.add(a.employee.userId); });
      (await prisma.employee.findMany({ where: { userId: { not: null }, OR: [{ team: { contains: text } }, { employeeCode: { contains: t0 } }, { department: { contains: text } }] }, select: { userId: true }, take: 60 }).catch(() => [])).forEach((e) => ids.add(e.userId));
    }
    if (!ids.size) { // a typo in a name
      const fz = await fuzzyIds('User', ['name'], toks.map((x) => x.t), 40);
      fz.forEach((id) => ids.add(id));
    }
    const users = ids.size ? await prisma.user.findMany({ where: { id: { in: [...ids] }, atsRole: { in: roles } }, select: { id: true, name: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true } }) : [];
    // a TL of the BDE department is a BDE TL: their page is the BDE history
    const tlNoDept = users.filter((u) => u.atsRole === 'TL' && !u.atsDepartment && !u.atsScopeDepartments).map((u) => u.id);
    const empDept = new Map(tlNoDept.length ? (await prisma.employee.findMany({ where: { userId: { in: tlNoDept } }, select: { userId: true, department: true } }).catch(() => [])).map((e) => [e.userId, e.department]) : []);
    const bdeLike = (u) => u.atsRole === 'BDE' || P.bdeTlRow(u, empDept.get(u.id));
    const allowed = users.filter((u) => (bdeLike(u) ? P.mayBde(v, u.id) : ['TL', 'STL'].includes(u.atsRole) ? P.mayTl(v, u.id) : P.mayRecruiter(v, u.id)));
    allowed.forEach((u) => {
      ctx.links.names.set(u.id, u.name);
      if (u.atsRole === 'RECRUITER') ctx.links.rec.push(u.id); else if (u.atsRole === 'BDE') ctx.links.bde.push(u.id); else { ctx.links.tl.push(u.id); if (bdeLike(u)) ctx.links.bde.push(u.id); }
    });
    for (const u of rank(allowed, toks, (x) => x.name).slice(0, full ? take : take + 1)) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const h = await P.headerOf(u.id);
      if (!h) continue; // eslint-disable-line no-continue
      const kind = u.atsRole === 'RECRUITER' ? 'recruiter' : bdeLike(u) ? 'bde' : 'tl';
      const roleWord = u.atsRole === 'RECRUITER' ? 'Recruiter' : u.atsRole === 'BDE' ? 'BDE' : bdeLike(u) ? 'BDE TL' : u.atsRole === 'STL' ? 'Senior team lead' : 'Team lead';
      rows.push({
        type: 'person', id: h.id, name: h.name, title: h.name, code: h.employeeCode || h.seat || null, kind, role: roleWord, department: h.department, section: h.section, seat: h.seat, teamLead: h.teamLead, active: h.active, statusWord: h.statusWord,
        sub: [roleWord, h.department, h.section, h.seat, (kind === 'recruiter' || u.atsRole === 'BDE') && h.teamLead ? `TL ${h.teamLead}` : null, h.active ? null : h.statusWord].filter(Boolean).join(' · '),
        to: `/ats/history/${kind}/${h.id}`, // recruiter | tl | bde: each one's complete history (the BDE one since 2026-11-20, before: the Clients list)
        recordTo: h.employeeId ? `/employees/${h.employeeId}` : null,
      });
    }
  }
  // employee records (HR) for a login that may view them, in its employee scope; a recruiter / TL already listed is not listed twice
  try {
    const { can } = require('../middleware/auth'); // eslint-disable-line global-require
    if (!H.external(user) && (await can(user, 'hrms', 'hrms', 'Employee Management', 'view'))) {
      const have = new Set(rows.map((r) => r.id));
      const emps = await prisma.employee.findMany({
        where: { AND: [SC.employeeWhere(user), { OR: [allWordsX(toks, [has('name')]), { employeeCode: { contains: text } }] }] },
        select: { id: true, userId: true, name: true, employeeCode: true, department: true, designation: true, employmentStatus: true }, take: take + 1, orderBy: { name: 'asc' },
      });
      emps.filter((e) => !(e.userId && have.has(e.userId))).forEach((e) => rows.push({
        type: 'employee', id: e.id, name: e.name, title: e.name, code: e.employeeCode, kind: 'employee', role: e.designation || 'Employee', department: e.department,
        sub: [e.designation, e.department, e.employmentStatus !== 'Active' ? e.employmentStatus : null].filter(Boolean).join(' · '), to: `/employees/${e.id}`, recordTo: `/employees/${e.id}`,
      }));
    }
  } catch { /* the employee part is a bonus */ }
  return { rows: rows.slice(0, full ? take : take + 1), count: rows.length };
}

async function clientsGroup(user, v, ctx) {
  const { toks, text, take, full, f } = ctx;
  if (!ctx.clientDesk) return { rows: [], count: 0 };
  const CS = require('./clientSearch'); // eslint-disable-line global-require
  const browse = !toks.length;
  const fields = ['name', 'legalName', 'clientCode', 'location', 'gst', 'contactName', 'secondaryContactName', 'contactEmail', 'secondaryContactEmail'];
  const digits = phoneLike(text) ? digitsOf(text) : '';
  const perTok = [];
  for (const tok of toks) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const alias = await CS.aliasClientIds(tok.t, { max: 200 });
    perTok.push({ OR: [...fields.map((c) => ({ [c]: { contains: tok.t } })), ...(tok.alt ? [{ name: { contains: tok.alt } }] : []), ...(alias.length ? [{ id: { in: alias } }] : [])] });
  }
  const phoneHit = digits ? await phoneIds('Client', ['contactPhone', 'secondaryContactPhone', 'billingContactPhone'], digits) : [];
  const idLike = idLikeOf(text);
  const arms = [{ AND: perTok }, ...(phoneHit.length ? [{ id: { in: phoneHit } }] : []), ...(/^cl[-\s#:]/i.test(text) && idLike ? [{ id: idLike }, { id: { endsWith: idLike } }] : [])];
  const scope = SC.clientWhere(user);
  const extra = [...dateWhere(f), ...(f.dept ? [{ ownerDepartment: { contains: f.dept } }] : []), ...(f.loc ? [{ location: { contains: f.loc } }] : []), ...(f.client ? [{ name: { contains: f.client } }] : []),
    ...(() => { const nm = listOf(f.owner).map((o) => ctx.links.names.get(o)).filter(Boolean); return nm.length ? [{ OR: nm.map((n) => ({ bdeOwner: { contains: n } })) }] : []; })()];
  let where = { AND: [...(browse ? [] : [{ OR: arms }]), scope, ...extra] };
  let fuzzy = false;
  const cSel = { id: true, name: true, clientCode: true, location: true, contactName: true, agreementStatus: true };
  let rows = await prisma.client.findMany({ where, select: cSel, orderBy: browse ? { createdAt: 'desc' } : { name: 'asc' }, take: Math.max(take * 3, 60) });
  if (!rows.length && !browse) {
    const fz = await fuzzyIds('Client', ['name'], toks.map((x) => x.t), 40);
    if (fz.length) { where = { AND: [{ id: { in: fz } }, scope, ...extra] }; fuzzy = true; rows = await prisma.client.findMany({ where, select: cSel, take: 60 }); }
  }
  ctx.links.clientIds = rows.map((r) => r.id).slice(0, 200); // the candidates of these clients are listed with the candidates
  ctx.links.clientNames = new Map(rows.map((r) => [r.id, r.name]));
  rows = browse ? rows : rank(rows, toks, (r) => r.name);
  const count = full ? await prisma.client.count({ where }) : rows.length;
  const shown = rows.slice(0, full ? take : take + 1);
  const ids = shown.map((x) => x.id);
  const reqs = full && ids.length ? await prisma.requirement.findMany({ where: { AND: [{ clientId: { in: ids } }, SC.requirementWhere(user)] }, select: { id: true, clientId: true, status: true, tlId: true, bdeId: true, recruiterId: true, recruiterIds: true } }) : [];
  const owners = full && ids.length ? new Map((await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, bdeOwner: true } })).map((c) => [c.id, c.bdeOwner])) : new Map();
  const teams = full && reqs.length ? await teamOfReqs(user, reqs) : new Map();
  return {
    count, fuzzy,
    rows: shown.map((x) => {
      const mine = reqs.filter((k) => k.clientId === x.id);
      const lower = String(x.name).toLowerCase();
      return {
        type: 'client', id: x.id, name: x.name, title: x.name, code: x.clientCode || null, location: x.location || null,
        requirements: full ? mine.length : undefined, open: full ? mine.filter((k) => !['CLOSED', 'DRAFT'].includes(k.status)).length : undefined,
        matchedOldName: !browse && !fuzzy && !toks.every((tok) => `${lower} ${String(x.contactName || '').toLowerCase()} ${String(x.clientCode || '').toLowerCase()} ${String(x.location || '').toLowerCase()}`.includes(tok.t)), // not in the name or the contact: it was an old name
        via: viaOf(toks, { 'contact person': x.contactName, code: x.clientCode, location: x.location }),
        sub: [x.clientCode, x.location, x.contactName && viaOf(toks, { c: x.contactName }).length ? `contact ${x.contactName}` : null, full ? `${mine.length} requirements` : null].filter(Boolean).join(' · '),
        to: `/clients/${x.id}?tab=history`, recordTo: `/clients/${x.id}`,
        ...(full ? (() => { const t = mergeTeams([...mine.map((k) => teams.get(k.id)).filter(Boolean), { bde: owners.get(x.id) ? [owners.get(x.id)] : [], tl: [], recruiters: [] }]); return { team: t, teamLine: teamLine(t) }; })() : {}),
      };
    }),
  };
}

// the requirements whose title / code / location / skills / client name match every word (cheap; the candidates of these are listed with the candidates)
async function requirementOwnIds(user, ctx) {
  const { toks, text } = ctx;
  if (!toks.length) return [];
  const CS = require('./clientSearch'); // eslint-disable-line global-require
  const perTok = [];
  for (const tok of toks) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    perTok.push({ OR: [...['title', 'reqCode', 'location', 'skills'].map((c) => ({ [c]: { contains: tok.t } })), ...(tok.alt ? [{ title: { contains: tok.alt } }] : []), await CS.clientRelationTerm(tok.t)] });
  }
  const idLike = idLikeOf(text);
  const rows = await prisma.requirement.findMany({ where: { AND: [{ OR: [{ AND: perTok }, ...(idLike ? [{ id: idLike }] : [])] }, SC.requirementWhere(user)] }, select: { id: true, reqCode: true, title: true }, take: 200 });
  rows.forEach((r) => ctx.links.reqLabels.set(r.id, r.reqCode || r.title));
  return rows.map((r) => r.id);
}

async function requirementsGroup(user, v, ctx) {
  const { toks, take, full, f, links } = ctx;
  const browse = !toks.length;
  const scope = SC.requirementWhere(user);
  const sts = listOf(f.status).filter((x) => ['open', 'closed'].includes(x));
  const extra = [...dateWhere(f), ...(f.owner ? [{ OR: listOf(f.owner).flatMap((o) => [{ recruiterId: o }, { tlId: o }, { bdeId: o }]) }] : []),
    ...(sts.length ? [{ OR: sts.map((st) => (st === 'open' ? { status: { notIn: ['CLOSED', 'DRAFT'] } } : { status: 'CLOSED' })) }] : []),
    ...(f.client ? [{ client: { name: { contains: f.client } } }] : []), ...(f.dept ? [{ department: { contains: f.dept } }] : []), ...(f.loc ? [{ location: { contains: f.loc } }] : [])];
  const own = new Set(links.reqOwn);
  // own matches, then the requirements of the matched recruiters / TLs / BDEs, then the requirements a matched candidate applied to
  const linkArms = [];
  if (links.rec.length) linkArms.push({ recruiterId: { in: links.rec } }, ...links.rec.map((u) => ({ recruiterIds: { contains: u } })));
  if (links.tl.length) linkArms.push({ tlId: { in: links.tl } });
  if (links.bde.length) linkArms.push({ bdeId: { in: links.bde } });
  // only through an application this login may see (a BDE never learns that a candidate still at recruiter review applied to their job)
  if (links.directIds.length) linkArms.push({ applications: { some: { AND: [{ candidateId: { in: links.directIds.slice(0, 200) } }, SC.applicationWhere(user)] } } });
  const arms = [...(own.size ? [{ id: { in: [...own] } }] : []), ...linkArms];
  if (!browse && !arms.length) {
    const fz = await fuzzyIds('Requirement', ['title'], toks.map((x) => x.t), 40);
    if (fz.length) arms.push({ id: { in: fz } });
  }
  if (!browse && !arms.length) return { rows: [], count: 0 };
  const where = { AND: [...(browse ? [] : [{ OR: arms }]), scope, ...extra] };
  const idRows = await prisma.requirement.findMany({ where, select: { id: true, createdAt: true, clientId: true, recruiterId: true, recruiterIds: true, tlId: true, bdeId: true }, orderBy: { createdAt: 'desc' }, take: 3000 });
  const matchedOf = (r) => {
    const by = [];
    if (own.has(r.id)) by.push(links.clientIds.includes(r.clientId) ? 'client' : 'requirement');
    if (links.rec.some((u) => u === r.recruiterId || String(r.recruiterIds || '').includes(u))) by.push('recruiter');
    if (links.tl.includes(r.tlId)) by.push('tl');
    if (links.bde.includes(r.bdeId)) by.push('bde');
    if (!by.length && !browse) by.push('candidate');
    return by;
  };
  let ordered = [...idRows.filter((r) => own.has(r.id)), ...idRows.filter((r) => !own.has(r.id))];
  if (f.by) ordered = ordered.filter((r) => matchedOf(r).includes(f.by));
  const count = ordered.length;
  const start = full ? ctx.offset : 0;
  const pageIds = ordered.slice(start, start + (full ? take : take + 1));
  const byId = new Map(ordered.map((r) => [r.id, r]));
  const shown = pageIds.length ? await prisma.requirement.findMany({ where: { id: { in: pageIds.map((r) => r.id) } }, select: H.REQ_SELECT }) : [];
  shown.sort((a, b) => pageIds.findIndex((r) => r.id === a.id) - pageIds.findIndex((r) => r.id === b.id));
  const per = new Map(shown.map((r) => [r.id, []]));
  if (full && shown.length) {
    const { recs } = await H.loadRecords(user, shown, { fresh: false });
    recs.forEach((x) => per.get(x.requirementId) && per.get(x.requirementId).push(x));
  }
  const nameOf = (id) => links.names.get(id) || '';
  const rTeams = full && shown.length ? await teamOfReqs(user, shown) : new Map();
  return {
    count, fuzzy: false,
    rows: shown.map((r) => {
      const fn = full ? H.funnelOf(per.get(r.id) || [], { from: null, to: null }) : null;
      const n = (k) => (fn ? (fn.tiles.find((t) => t.key === k) || {}).count || 0 : undefined);
      const m = matchedOf(byId.get(r.id));
      const via = [];
      if (!own.has(r.id) || m.includes('client')) { if (links.clientIds.includes(r.clientId)) via.push(`via client ${links.clientNames.get(r.clientId) || H.clientNameOf(r)}`); }
      if (m.includes('recruiter')) via.push(`recruiter ${nameOf(links.rec.find((u) => u === r.recruiterId || String(r.recruiterIds || '').includes(u)))}`);
      if (m.includes('tl')) via.push(`TL ${nameOf(r.tlId)}`);
      if (m.includes('bde')) via.push(`BDE ${nameOf(r.bdeId)}`);
      if (m.includes('candidate')) via.push('a candidate you searched applied to it');
      return {
        type: 'requirement', id: r.id, reqCode: r.reqCode, title: r.title, name: r.title, code: r.reqCode || null, status: r.status, statusLabel: V.requirementStatusLabel(r.status), openings: r.openings,
        client: H.clientNameOf(r), clientId: r.clientId, matchedBy: m, via: via.filter((x) => !/^recruiter $|^TL $|^BDE $/.test(x)),
        headline: full ? { sourced: n('sourced'), shared: n('shared'), selected: n('selected'), joined: n('joined'), dropped: n('dropped'), inProcess: n('inprocess') } : undefined,
        sub: [H.clientNameOf(r), V.requirementStatusLabel(r.status), `${r.openings} opening${r.openings === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
        to: `/requirements/${r.id}?tab=history`, recordTo: `/requirements/${r.id}`,
        ...(rTeams.get(r.id) ? { team: rTeams.get(r.id), teamLine: teamLine(rTeams.get(r.id)) } : {}),
      };
    }),
  };
}

// the candidates a client / requirement / recruiter / TL / BDE search leads to: a person's own name is matched in the narrow index; everyone with an
// application on those clients' requirements, on that requirement, handled by that recruiter, in that TL's team or on that BDE's clients is added
const stageWord = (a) => (V.leftAfterJoining(a) ? 'Dropped' : V.stageLabel(a.stage));
async function candidatesGroup(user, v, ctx) {
  const { toks, take, full, f, links } = ctx;
  if (['external', 'none', 'accounts'].includes(v.kind)) return { rows: [], count: 0 };
  const limited = v.bdeTeam || v.kind === 'bde';
  const browse = !toks.length;
  const CI = require('./candidateSearchIndex'); // eslint-disable-line global-require
  const cf = await candidateFilters(v, f, limited);
  const scope = SC.candidateWhere(user);
  const scoped = JSON.stringify(scope) !== '{}';
  const select = { id: true, name: true, phone: true, email: true, currentCompany: true, currentDesignation: true, location: true, skills: true, createdAt: true };
  const offset = full ? ctx.offset : 0;
  const withTest = H.testViewer(user);
  let ordered = [];
  const matchedBy = new Map();
  const add = (id, k) => { if (!matchedBy.has(id)) matchedBy.set(id, new Set()); matchedBy.get(id).add(k); };
  let fuzzy = false;
  let count = 0;
  let linkedApps = [];
  if (browse) {
    const where = { AND: [scope, ...cf] };
    const rows = await prisma.candidate.findMany({ where, select: { id: true }, orderBy: { createdAt: 'desc' }, skip: offset, take: full ? take : take + 1 });
    count = await prisma.candidate.count({ where });
    ordered = rows.map((r) => r.id);
  } else {
    const direct = links.directIds;
    direct.forEach((id) => add(id, 'name'));
    const arms = [];
    if (links.clientIds.length) arms.push({ requirement: { clientId: { in: links.clientIds } } });
    if (links.reqOwn.length) arms.push({ requirementId: { in: links.reqOwn } });
    if (links.rec.length) arms.push({ ownerRecruiterId: { in: links.rec } });
    if (links.tl.length) arms.push({ requirement: { tlId: { in: links.tl } } });
    if (links.bde.length) arms.push({ requirement: { bdeId: { in: links.bde } } });
    if (arms.length) {
      linkedApps = await prisma.application.findMany({
        where: { AND: [{ OR: arms }, SC.applicationWhere(user)] },
        select: { candidateId: true, requirementId: true, ownerRecruiterId: true, requirement: { select: { clientId: true, tlId: true, bdeId: true } } }, orderBy: { updatedAt: 'desc' }, take: 20000,
      });
      linkedApps.forEach((a) => {
        const rq = a.requirement || {};
        if (links.clientIds.includes(rq.clientId)) add(a.candidateId, 'client');
        if (links.reqOwn.includes(a.requirementId)) add(a.candidateId, 'requirement');
        if (a.ownerRecruiterId && links.rec.includes(a.ownerRecruiterId)) add(a.candidateId, 'recruiter');
        if (rq.tlId && links.tl.includes(rq.tlId)) add(a.candidateId, 'tl');
        if (rq.bdeId && links.bde.includes(rq.bdeId)) add(a.candidateId, 'bde');
      });
    }
    const seen = new Set();
    const union = [];
    [...direct, ...linkedApps.map((a) => a.candidateId)].forEach((id) => { if (!seen.has(id)) { seen.add(id); union.push(id); } });
    let valid = union;
    if (scoped || cf.length) {
      const ok = new Set();
      for (let i = 0; i < union.length; i += 3000) {
        // eslint-disable-next-line no-await-in-loop
        (await prisma.candidate.findMany({ where: { AND: [{ id: { in: union.slice(i, i + 3000) } }, scope, ...cf] }, select: { id: true } })).forEach((r) => ok.add(r.id));
      }
      valid = union.filter((id) => ok.has(id));
    }
    if (!valid.length) {
      const fz = await CI.fuzzyIds(toks, 60);
      if (fz && fz.length) {
        const rows = await prisma.candidate.findMany({ where: { AND: [{ id: { in: fz } }, scope, ...cf] }, select: { id: true } });
        valid = fz.filter((id) => rows.some((r) => r.id === id)); fuzzy = valid.length > 0; valid.forEach((id) => add(id, 'name'));
      }
    }
    ordered = f.by ? valid.filter((id) => matchedBy.has(id) && matchedBy.get(id).has(f.by)) : valid;
    count = ordered.length;
    ordered = ordered.slice(offset, offset + (full ? take : take + 1));
  }
  const rows = ordered.length ? await prisma.candidate.findMany({ where: { id: { in: ordered } }, select }) : [];
  const pos = new Map(ordered.map((id, i) => [id, i]));
  rows.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  const shown = rows.filter((r) => withTest || !H.TEST_RE.test(r.name));
  const cids = shown.map((r) => r.id);
  const apps = cids.length ? await prisma.application.findMany({
    where: { AND: [{ candidateId: { in: cids } }, SC.applicationWhere(user)] },
    select: { candidateId: true, stage: true, joiningStatus: true, rollStatus: true, requirementId: true, ownerRecruiterId: true, updatedAt: true, requirement: { select: { title: true, reqCode: true, clientId: true, tlId: true, bdeId: true, client: { select: { name: true } } } } },
    orderBy: { updatedAt: 'desc' },
  }) : [];
  // the facets of the full page: how many of these people are in each step, and by what each was matched
  let facets = null;
  if (full && !browse && count <= 3000 && count > 0) {
    const all = [...matchedBy.keys()];
    const fa = all.length && all.length <= 6000 ? await prisma.application.findMany({ where: { AND: [{ candidateId: { in: all } }, SC.applicationWhere(user)] }, select: { candidateId: true, stage: true, joiningStatus: true, rollStatus: true } }) : [];
    const per = new Map();
    fa.forEach((a) => { if (!per.has(a.candidateId)) per.set(a.candidateId, []); per.get(a.candidateId).push(a); });
    const buckets = { joined: 0, selected: 0, dropped: 0, active: 0 };
    all.forEach((id) => {
      const list = per.get(id) || [];
      if (!list.length) return;
      if (list.some((a) => H.JOINED.includes(a.stage) && !V.leftAfterJoining(a))) buckets.joined += 1;
      else if (list.some((a) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage))) buckets.selected += 1;
      else if (list.some((a) => a.stage === 'REJECTED' || V.leftAfterJoining(a))) buckets.dropped += 1;
      else buckets.active += 1;
    });
    const by = {};
    all.forEach((id) => matchedBy.get(id).forEach((k) => { by[k] = (by[k] || 0) + 1; }));
    facets = { status: buckets, matched: by };
  }
  const nm = (id) => links.names.get(id) || '';
  return {
    count, fuzzy, facets,
    rows: shown.map((r) => {
      const mine = apps.filter((a) => a.candidateId === r.id);
      const last = mine[0];
      const why = [];
      mine.forEach((a) => {
        const rq = a.requirement || {};
        if (links.clientIds.includes(rq.clientId)) why.push(`via client ${(rq.client && rq.client.name) || links.clientNames.get(rq.clientId) || ''} · ${stageWord(a)}`);
        if (links.reqOwn.includes(a.requirementId)) why.push(`via requirement ${rq.reqCode || rq.title} · ${stageWord(a)}`);
        if (a.ownerRecruiterId && links.rec.includes(a.ownerRecruiterId)) why.push(`recruiter ${nm(a.ownerRecruiterId)} · ${stageWord(a)}`);
        if (rq.tlId && links.tl.includes(rq.tlId)) why.push(`TL ${nm(rq.tlId)}`);
        if (rq.bdeId && links.bde.includes(rq.bdeId)) why.push(`BDE ${nm(rq.bdeId)}`);
      });
      const direct = links.directIds.includes(r.id);
      return {
        type: 'candidate', id: r.id, name: r.name, title: r.name, code: codeOf(r.id), ...(v.contact ? { phone: r.phone || null, email: r.email || null } : {}),
        applications: mine.length, rejected: mine.filter((a) => a.stage === 'REJECTED').length, joined: mine.filter((a) => H.JOINED.includes(a.stage) && !V.leftAfterJoining(a)).length,
        selected: mine.filter((a) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage)).length, step: last ? stageWord(last) : null,
        matchedBy: [...(matchedBy.get(r.id) || (browse ? [] : ['name']))],
        via: [...new Set([...(direct ? viaOf(toks, { skills: r.skills, company: limited ? '' : r.currentCompany, location: limited ? '' : r.location, email: v.contact ? r.email : '' }) : []), ...why])].slice(0, 4),
        sub: [v.contact ? r.phone : null, limited ? null : r.currentDesignation, limited ? null : r.currentCompany, last ? `${last.requirement ? last.requirement.title : ''} · ${stageWord(last)}` : null].filter(Boolean).join(' · '),
        to: `/ats/history/candidate/${r.id}`, recordTo: `/candidates/${r.id}`,
      };
    }),
  };
}

// interviews, offers and joinings: one application can be in several of these
async function eventsGroup(user, v, ctx) {
  const { toks, take, full, f } = ctx;
  if (['external', 'none'].includes(v.kind)) return { rows: [], count: 0 };
  const builders = [(t) => ({ candidate: { name: { contains: t } } }), (t) => ({ requirement: { title: { contains: t } } }), (t) => ({ requirement: { reqCode: { contains: t } } }), (t) => ({ requirement: { client: { name: { contains: t } } } })];
  const match = toks.length ? allWordsX(toks, [...builders, (t) => ({ interviewer: { contains: t } })]) : {};
  const matchNoInterviewer = toks.length ? allWordsX(toks, builders) : {};
  const scope = SC.applicationWhere(user);
  const appExtra = [...dateWhere(f), ...(f.owner ? [ownerAppArm(f.owner)] : []), ...(stageGroupsOf(f.status) ? [stageGroupsOf(f.status)] : []),
    ...(f.client ? [{ requirement: { client: { name: { contains: f.client } } } }] : []), ...(f.dept ? [{ requirement: { department: { contains: f.dept } } }] : [])];
  const sel = {
    id: true, candidateId: true, stage: true, interviewAt: true, interviewStatus: true, interviewer: true, interviewRound: true, offerStatus: true, offerDate: true, joiningDate: true, joiningStatus: true, joinedAt: true,
    candidate: { select: { name: true } }, requirement: { select: { title: true, reqCode: true, client: { select: { name: true } } } },
  };
  const where = (kindWhere, m) => ({ AND: [m, kindWhere, scope, ...appExtra] });
  const JR = require('./joinedRule'); // eslint-disable-line global-require
  const droppedIds = [...(await JR.droppedAppIds().catch(() => new Set()))];
  const JOINED_ST = { stage: { in: ['JOINED', 'HIRED'] } };
  const isDroppedW = { OR: [{ AND: [JOINED_ST, { joiningStatus: { in: LEFT } }] }, { joiningStatus: 'Dropped' }, ...(droppedIds.length ? [{ id: { in: droppedIds } }] : [])] };
  const now = new Date();
  const STATUS_W = {
    'interview:upcoming': { AND: [{ interviewAt: { gte: now } }, { OR: [{ interviewStatus: null }, { interviewStatus: { not: 'COMPLETED' } }] }] },
    'interview:done': { OR: [{ interviewStatus: 'COMPLETED' }, { AND: [{ interviewAt: { lt: now } }, { stage: { notIn: ['INTERVIEW_SCHEDULED'] } }] }] },
    'offer:released': { AND: [{ OR: [{ offerStatus: 'Offer Released' }, { AND: [{ stage: 'OFFER' }, { offerStatus: null }] }] }] },
    'offer:accepted': { OR: [{ offerStatus: 'Offer Accepted' }, { AND: [{ stage: 'OFFER_ACCEPTED' }, { offerStatus: null }] }] },
    'offer:declined': { offerStatus: 'Offer Declined' },
    'joining:joined': { AND: [JOINED_ST, NOT_LEFT, { OR: [{ joiningStatus: null }, { joiningStatus: { not: 'Dropped' } }] }, ...(droppedIds.length ? [{ id: { notIn: droppedIds } }] : [])] },
    'joining:dropped': isDroppedW,
    'joining:scheduled': { AND: [{ joiningStatus: 'Joining Scheduled' }, { stage: { notIn: ['JOINED', 'HIRED'] } }] },
  };
  const KIND_W = {
    interview: { interviewAt: { not: null } },
    offer: { OR: [{ offerStatus: { in: ['Offer Released', 'Offer Accepted', 'Offer Declined'] } }, { stage: { in: ['OFFER', 'OFFER_ACCEPTED'] } }] },
    joining: { OR: [JOINED_ST, { joiningStatus: { not: null } }] },
  };
  const matchOf = (kind) => (kind === 'interview' ? match : matchNoInterviewer);
  // ?ev= narrows to the ticked statuses (several allowed, OR inside one kind)
  const evs = f.ev || [];
  const kinds = ['interview', 'offer', 'joining'].map((kind) => {
    const mine = evs.filter((e) => e.startsWith(`${kind}:`));
    if (evs.length && !mine.length) return null;
    const kw = mine.length ? { AND: [KIND_W[kind], { OR: mine.map((e) => STATUS_W[e]) }] } : KIND_W[kind];
    return [kind, kw, matchOf(kind)];
  }).filter(Boolean);
  const withTest = H.testViewer(user);
  const results = await Promise.all(kinds.map(async ([kind, kw, m]) => {
    const rows = await prisma.application.findMany({ where: where(kw, m), select: sel, orderBy: { updatedAt: 'desc' }, take: take + 1 });
    const count = full ? await prisma.application.count({ where: where(kw, m) }) : rows.length;
    return { kind, rows: rows.filter((a) => withTest || !H.TEST_RE.test((a.candidate && a.candidate.name) || '')), count };
  }));
  // the clear counts: always over the words and filters typed, not over the ticked statuses (so the other numbers stay visible)
  const breakdown = full ? await Promise.all(EV_KEYS.map(async (key) => {
    const kind = key.split(':')[0];
    const n = await prisma.application.count({ where: where({ AND: [KIND_W[kind], STATUS_W[key]] }, matchOf(kind)) });
    return { key, kind, label: EV_LABEL[key], count: n, on: evs.includes(key) };
  })) : null;
  const dropSet = new Set(droppedIds);
  const joinWord = (a) => {
    if (dropSet.has(a.id) || LEFT.includes(a.joiningStatus) || a.joiningStatus === 'Dropped') return H.JOINED.includes(a.stage) ? 'dropped (left after joining)' : 'dropped (did not join)';
    if (H.JOINED.includes(a.stage)) return 'joined, still working';
    return a.joiningStatus ? String(a.joiningStatus).toLowerCase() : V.stageLabel(a.stage);
  };
  const rows = [];
  results.forEach(({ kind, rows: list }) => list.forEach((a) => {
    const title = `${a.candidate ? a.candidate.name : '—'} — ${a.requirement ? a.requirement.title : ''}`;
    const client = a.requirement && a.requirement.client ? a.requirement.client.name : '';
    let sub; let at;
    if (kind === 'interview') { at = a.interviewAt; sub = `Interview${a.interviewRound > 1 ? ` round ${a.interviewRound}` : ''} · ${dayOf(a.interviewAt)}${a.interviewStatus ? ` · ${String(a.interviewStatus).toLowerCase()}` : ''}${a.interviewer ? ` · ${a.interviewer}` : ''}`; }
    else if (kind === 'offer') { at = a.offerDate || a.joinedAt; sub = `Offer · ${a.offerStatus || V.stageLabel(a.stage)}${a.offerDate ? ` · ${H.isoDay(a.offerDate) || ''}` : ''}`; }
    else { at = a.joiningDate; sub = `Joining · ${joinWord(a)}${H.isoDay(a.joiningDate) ? ` · ${H.isoDay(a.joiningDate)}` : ''}`; }
    rows.push({
      type: kind, id: `${kind}-${a.id}`, applicationId: a.id, candidateId: a.candidateId, name: title, title, code: null, client, sub: `${sub}${client ? ` · ${client}` : ''}`, at: at ? new Date(at).toISOString() : null,
      to: `/ats/history/candidate/${a.candidateId}?focus=${kind}-${a.id}`, recordTo: `/candidates/${a.candidateId}`,
    });
  }));
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { rows: rows.slice(0, full ? take * 3 : take + 1), count: results.reduce((n, r) => n + r.count, 0), breakdown };
}

async function moneyGroup(user, v, ctx) {
  const { toks, text, take, full, f } = ctx;
  const rows = [];
  let count = 0;
  if (!toks.length) return { rows, count };
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  // invoices: only a login that sees invoices, inside its invoice scope
  if (!H.external(user) && (await can(user, 'accounts', 'accounts', 'Invoices', 'view'))) {
    const CS = require('./clientSearch'); // eslint-disable-line global-require
    const perTok = [];
    for (const tok of toks) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      perTok.push({ OR: [{ invoiceNumber: { contains: tok.t } }, { notes: { contains: tok.t } }, { candidate: { name: { contains: tok.t } } }, { requirement: { title: { contains: tok.t } } }, await CS.clientRelationTerm(tok.t)] });
    }
    const extra = [...(f.from || f.to ? [{ invoiceDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }] : []), ...(f.status ? [{ OR: listOf(f.status).map((s) => ({ status: { contains: s } })) }] : [])];
    const where = { AND: [{ AND: perTok }, SC.invoiceWhere(user), ...extra] };
    const inv = await prisma.invoice.findMany({ where, select: { id: true, invoiceNumber: true, status: true, invoiceDate: true, clientId: true, client: { select: { name: true } }, candidate: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: take + 1 });
    count += full ? await prisma.invoice.count({ where }) : inv.length;
    const openable = new Set();
    if (ctx.clientDesk && inv.length) (await prisma.client.findMany({ where: { AND: [{ id: { in: [...new Set(inv.map((i) => i.clientId))] } }, SC.clientWhere(user)] }, select: { id: true } })).forEach((c) => openable.add(c.id));
    inv.forEach((i) => rows.push({
      type: 'invoice', id: `invoice-${i.id}`, invoiceId: i.id, name: `Invoice ${i.invoiceNumber || i.id.slice(-6).toUpperCase()}`, title: `Invoice ${i.invoiceNumber || i.id.slice(-6).toUpperCase()}`, code: i.invoiceNumber || null,
      sub: [i.client ? i.client.name : null, i.candidate ? i.candidate.name : null, i.status, i.invoiceDate].filter(Boolean).join(' · '),
      to: openable.has(i.clientId) ? `/clients/${i.clientId}?tab=history&focus=invoice-${i.id}` : `/invoices/${i.id}`, recordTo: `/invoices/${i.id}`,
    }));
  }
  // agreements: the client desk, and not the logins that never see agreements
  let blind = false;
  try { blind = require('./agreementPrivacy').blindTo(user); } catch { blind = false; } // eslint-disable-line global-require
  if (ctx.clientDesk && !blind) {
    const CS = require('./clientSearch'); // eslint-disable-line global-require
    const perTok = [];
    for (const tok of toks) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      const alias = await CS.aliasClientIds(tok.t, { max: 100 });
      perTok.push({ OR: [{ name: { contains: tok.t } }, { agreementId: { contains: tok.t } }, { agreementStatus: { contains: tok.t } }, ...(alias.length ? [{ id: { in: alias } }] : [])] });
    }
    const where = { AND: [{ AND: perTok }, { agreementStatus: { not: 'DRAFT' } }, SC.clientWhere(user)] };
    const cls = await prisma.client.findMany({ where, select: { id: true, name: true, agreementId: true, agreementStatus: true, agreementEnd: true }, orderBy: { name: 'asc' }, take: take + 1 });
    count += full ? await prisma.client.count({ where }) : cls.length;
    cls.forEach((c) => rows.push({
      type: 'agreement', id: `agreement-${c.id}`, name: `Agreement — ${c.name}`, title: `Agreement — ${c.name}`, code: c.agreementId || null,
      sub: [c.agreementStatus, c.agreementEnd ? `renewal ${H.isoDay(c.agreementEnd) || c.agreementEnd}` : null].filter(Boolean).join(' · '),
      to: `/clients/${c.id}?tab=history&focus=agreement`, recordTo: `/clients/${c.id}`,
    }));
  }
  void text;
  return { rows: rows.slice(0, full ? take * 2 : take + 1), count };
}

async function otherGroup(user, v, ctx) {
  const { toks, take, full, f } = ctx;
  const rows = [];
  let count = 0;
  if (!toks.length) return { rows, count };
  if (H.external(user)) return { rows, count };
  const limited = v.bdeTeam || v.kind === 'bde';
  if (!limited && !['none', 'accounts'].includes(v.kind)) {
    // follow-up text, in the login's applications
    const fb = [has('nextAction'), has('notes'), has('outcome'), has('ownerName')];
    const fwhere = { AND: [allWordsX(toks, fb), { application: SC.applicationWhere(user) }, ...dateWhere(f)] };
    const fus = await prisma.applicationFollowUp.findMany({
      where: fwhere, select: { id: true, applicationId: true, candidateId: true, nextAction: true, notes: true, outcome: true, ownerName: true, createdAt: true, application: { select: { candidate: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: take + 1,
    });
    count += full ? await prisma.applicationFollowUp.count({ where: fwhere }) : fus.length;
    fus.forEach((x) => rows.push({
      type: 'followup', id: `followup-${x.id}`, name: `Follow-up: ${clip(x.nextAction || x.notes || x.outcome, 70)}`, title: `Follow-up: ${clip(x.nextAction || x.notes || x.outcome, 70)}`,
      sub: [x.application && x.application.candidate ? x.application.candidate.name : null, x.ownerName, dayOf(x.createdAt)].filter(Boolean).join(' · '), to: `/ats/history/candidate/${x.candidateId}?focus=followup-${x.applicationId}`, recordTo: `/candidates/${x.candidateId}`,
    }));
    // documents, by file name only
    const dwhere = { AND: [allWordsX(toks, [has('name'), has('fileName')]), { deletedAt: null }, { candidate: SC.candidateWhere(user) }, ...dateWhere(f)] };
    const docs = await prisma.candidateDocument.findMany({ where: dwhere, select: { id: true, candidateId: true, docType: true, name: true, fileName: true, createdAt: true, candidate: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: take + 1 });
    count += full ? await prisma.candidateDocument.count({ where: dwhere }) : docs.length;
    docs.forEach((d) => rows.push({
      type: 'document', id: `document-${d.id}`, name: `${d.docType}: ${d.fileName || d.name}`, title: `${d.docType}: ${d.fileName || d.name}`, sub: [d.candidate ? d.candidate.name : null, dayOf(d.createdAt)].filter(Boolean).join(' · '),
      to: `/ats/history/candidate/${d.candidateId}?focus=document-${d.id}`, recordTo: `/candidates/${d.candidateId}`,
    }));
  }
  // my own tasks
  try {
    const twhere = { AND: [allWordsX(toks, [has('name'), has('description')]), { OR: [{ assigneeId: user.id }, { assignedById: user.id }] }] };
    const tasks = await prisma.task.findMany({ where: twhere, select: { id: true, name: true, status: true, endDate: true }, orderBy: { createdAt: 'desc' }, take: take + 1 });
    count += full ? await prisma.task.count({ where: twhere }) : tasks.length;
    tasks.forEach((t) => rows.push({ type: 'task', id: `task-${t.id}`, name: `Task: ${t.name}`, title: `Task: ${t.name}`, sub: [t.status, t.endDate ? `due ${t.endDate}` : null].filter(Boolean).join(' · '), to: '/timesheet', recordTo: '/timesheet' }));
  } catch { /* the tasks table is optional */ }
  return { rows: rows.slice(0, full ? take * 2 : take + 1), count };
}

// ---- the answer ------------------------------------------------------------------------------------------------------------------------------
async function search(user, textIn, opts = {}) {
  const text = String(textIn || '').normalize('NFC').trim().slice(0, 100);
  const full = opts.mode !== 'type';
  const exportAll = opts.exportAll === true;
  const take = exportAll ? 2000 : opts.limit ? Math.min(100, Math.max(1, Number(opts.limit) || 0)) : (full ? FULL_TAKE : TYPE_TAKE);
  const offset = Math.max(0, Number(opts.offset) || 0);
  const empty = {
    q: text, total: 0, groups: [], people: [], clients: [], requirements: [], candidates: [], events: [], clientsAllowed: false, mode: full ? 'full' : 'type', facets: {},
  };
  if (H.external(user)) return empty;
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  const clientDesk = !!(await can(user, 'ats', 'clients', 'Client List', 'view'));
  const f = filtersOf(opts);
  const toks = text.length >= 2 ? expand(tokensOf(text)) : [];
  if (!toks.length && !hasFilters(f)) return { ...empty, clientsAllowed: clientDesk };
  const v = await P.viewerOf(user);
  const links = {
    names: new Map(), rec: [], tl: [], bde: [], clientIds: [], clientNames: new Map(), reqOwn: [], reqLabels: new Map(), directIds: [],
  };
  const only = GROUP_ORDER.includes(opts.group) ? opts.group : null; // a page of ONE group (Show more)
  const limited = v.bdeTeam || v.kind === 'bde';
  const ctx = {
    toks, text, take, full, clientDesk, f, links, offset: only ? offset : 0,
  };
  const timed = (name, fn) => { const t0 = Date.now(); return fn().then((r) => { if (process.env.SEARCH_TIMING) console.log(`[search] ${name} ${Date.now() - t0} ms`); return r; }); }; // eslint-disable-line no-console
  // phase 1: who and what the words name (small tables), and the candidates whose own name / number matches
  const CI = require('./candidateSearchIndex'); // eslint-disable-line global-require
  const direct = async () => {
    if (!toks.length || ['external', 'none', 'accounts'].includes(v.kind)) return;
    const cols = limited ? ['basic'] : ['basic', 'more', ...(v.contact ? ['contact'] : [])];
    const ids = await CI.ids({
      tokens: toks, cols, digits: v.contact && phoneLike(text) ? digitsOf(text) : '', idLike: idLikeOf(text), limit: 2000,
    });
    if (ids === null) { // no index (should not happen): the plain scan
      const builders = (limited ? ['name', 'skills'] : ['name', 'skills', 'currentCompany', 'currentDesignation', 'location', ...(v.contact ? ['email'] : [])]).map((c) => has(c));
      links.directIds = (await prisma.candidate.findMany({ where: allWordsX(toks, builders), select: { id: true }, take: 2000 })).map((r) => r.id);
    } else links.directIds = ids;
  };
  const [people, clients] = await Promise.all([
    timed('people', () => peopleGroup(user, v, ctx)), timed('clients', () => clientsGroup(user, v, ctx)),
    timed('reqOwn', async () => { links.reqOwn = await requirementOwnIds(user, ctx); }), timed('direct', direct),
  ]);
  // phase 2
  const sized = (g) => (only && only !== g ? { ...ctx, take: 1 } : (!typeHas(f, g) && !only ? { ...ctx, take: 1 } : ctx));
  const [requirements, candidates, events, money, other] = await Promise.all([
    timed('requirements', () => requirementsGroup(user, v, sized('requirements'))), timed('candidates', () => candidatesGroup(user, v, sized('candidates'))),
    timed('events', () => eventsGroup(user, v, sized('events'))), timed('money', () => moneyGroup(user, v, sized('money'))), timed('other', () => otherGroup(user, v, sized('other'))),
  ]);
  const byId = {
    people, clients, requirements, candidates, events, money, other,
  };
  const wanted = (id) => (only ? only === id : typeHas(f, id));
  const groups = GROUP_ORDER.filter((id) => wanted(id)).map((id) => {
    const g = byId[id];
    const cap = id === 'events' || id === 'money' || id === 'other' ? take * 3 : take;
    const more = full ? (g.count > offset + Math.min(g.rows.length, cap) && ['candidates', 'requirements'].includes(id)) : g.rows.length > take;
    return {
      id, title: GROUP_TITLES[id], count: full ? g.count : Math.min(g.rows.length, take), more: full ? more : g.rows.length > take, offset: only ? offset : 0, rows: full ? g.rows.slice(0, cap) : g.rows.slice(0, take),
      breakdown: full ? (id === 'events' ? g.breakdown || null : (id === 'candidates' && g.facets && g.facets.status
        ? [['active', 'In process'], ['selected', 'Selected'], ['joined', 'Joined (still working)'], ['dropped', 'Dropped / rejected']].map(([key, label]) => ({ key, label, count: g.facets.status[key] || 0, param: 'status' }))
        : null)) : null,
    };
  }).filter((g) => g.rows.length > 0 || (full && g.count > 0));
  const counts = Object.fromEntries(GROUP_ORDER.map((id) => [id, full ? byId[id].count : byId[id].rows.length]));
  const facets = full ? {
    type: GROUP_ORDER.map((id) => ({ value: id, label: GROUP_TITLES[id], count: counts[id] })).filter((o) => o.count > 0),
    status: candidates.facets ? [['joined', 'Joined'], ['selected', 'Selected'], ['dropped', 'Dropped'], ['active', 'In process']].map(([value, label]) => ({ value, label, count: candidates.facets.status[value] || 0 })) : undefined,
    by: candidates.facets ? BY.map((value) => ({ value, label: { name: 'Name / number', client: 'Client', requirement: 'Requirement', recruiter: 'Recruiter', tl: 'TL', bde: 'BDE' }[value], count: candidates.facets.matched[value] || 0 })).filter((o) => o.count > 0) : undefined,
  } : {};
  return {
    q: text,
    mode: full ? 'full' : 'type',
    total: groups.reduce((n, g) => n + (full ? g.count : g.rows.length), 0),
    groups,
    people: byId.people.rows.filter((r) => r.type === 'person').slice(0, take),
    clients: byId.clients.rows.slice(0, take),
    clientTotal: byId.clients.count,
    requirements: byId.requirements.rows.slice(0, take),
    requirementTotal: byId.requirements.count,
    candidates: byId.candidates.rows.slice(0, take),
    candidateTotal: byId.candidates.count,
    clientsAllowed: clientDesk,
    viewer: { kind: v.kind, contact: v.contact && !limited, pay: v.contact && !limited, limited },
    filters: f,
    facets,
  };
}

module.exports = {
  search, filtersOf, hasFilters, BY, tokensOf, typoPatterns, teluguToLatin, phoneLike, digitsOf, GROUP_TITLES,
};

// ---------------------------------------------------------------------------
// NAUKRI / SHINE MAIL RESPONSES -> ATS APPLICATIONS (founder 2026-10-30: "shine nad nauki responses oche mail sync ani click
// chesakkaa read anii no of candiates chpistunaii kaniii applications loo kanipiyadam ledhuu").
//
// The mailbox engine is the Job Portal's (routes/portalMailboxes.js): it reads the mail and files each response as a portal
// application on a portal job matched by the mail's title - usually a job of its own ("Urgent | Hiring For Staff Nurse"), not a
// TeamLink requirement, so the Job Portal pull (utils/jobPortalBridge.js, TeamLink jobs only) never brought them into the ATS.
// pull() reads them (embed GET .../mail-applications), matches the title to a TeamLink requirement and files each one through
// the same ingest as every portal application (ingestApplication: one portal application = one pipeline row, the resume, the
// duplicate check), owned by the mailbox's recruiter (the seat holder the mailbox belongs to, utils/mailboxSeats.js).
//
// MATCHING, never guessed: the mail's title without its board noise ("Email Response-", "Urgent |", "Hiring For"...) equal to a
// requirement's title (case, spacing and punctuation ignored) - several such: the mailbox recruiter's own, then live ones, then
// the recruiter's seat department, then the newest. Otherwise every word of one title inside the other, OPEN requirements only,
// never a one-word requirement for a longer title, and it must come down to ONE requirement (recruiter's own, then department).
// None -> left waiting and listed by title on the mailbox screen; it is tried again on every sync, so it links as soon as a
// requirement with that title exists.
// Runs right after "Sync now" on a mailbox and on every Job Portal sync (startup, hourly).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const NOISE = [
  /^\s*(re|fw|fwd)\s*:\s*/gi, /email\s*response\s*[-:|]?/gi, /job\s*application\s*(for)?/gi, /application\s*for/gi,
  /\burgent(ly)?\b/gi, /\bhiring\s*(for)?\b/gi, /\bopening\s*(for)?\b/gi, /\brequired\b/gi, /\bnaukri(\.com)?\b/gi, /\bshine(\.com)?\b/gi,
  /\bimmediate\s*joiners?\b/gi,
];
function normTitle(t) {
  let s = String(t || '');
  for (const re of NOISE) s = s.replace(re, ' ');
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

async function requirementsIndex() {
  const reqs = await prisma.requirement.findMany({
    select: { id: true, title: true, department: true, status: true, recruiterId: true, recruiterIds: true, createdAt: true },
  });
  return reqs.map((r) => ({ ...r, norm: normTitle(r.title) })).filter((r) => r.norm);
}

const LIVE = /^(open|active|live|in progress|on hold|sourcing)$/i;
function pick(list, { userId, department }) {
  if (list.length <= 1) return list[0] || null;
  const narrow = (xs, f) => { const y = xs.filter(f); return y.length ? y : xs; };
  let xs = list;
  if (userId) xs = narrow(xs, (r) => r.recruiterId === userId || csv(r.recruiterIds).includes(userId));
  xs = narrow(xs, (r) => LIVE.test(String(r.status || '')));
  if (department) xs = narrow(xs, (r) => String(r.department || '').toLowerCase() === String(department).toLowerCase());
  return xs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}
const STOP = new Set(['and', 'or', 'for', 'the', 'of', 'in', 'at', 'a', 'an', 'to', 'with', 'cum']);
const tokens = (n) => n.split(' ').filter((w) => w && !STOP.has(w));
const within = (small, big) => small.length > 0 && small.every((w) => big.includes(w));
function match(index, title, ctx) {
  const n = normTitle(title);
  if (!n) return null;
  const exact = index.filter((r) => r.norm === n);
  if (exact.length) return pick(exact, ctx);
  // Not word for word: every word of one title inside the other, and only to an OPEN requirement. A requirement of a single word
  // never takes a longer title ("Faculty" is not "Ophthalmology Faculty", "Professor" is not "Professor and Assistant Professor").
  const t = tokens(n);
  const inside = index.filter((r) => {
    if (!LIVE.test(String(r.status || ''))) return false;
    const rt = tokens(r.norm);
    if (within(t, rt)) return true;                      // "Staff Nurse" in "Nurse - Staff Nurses"? (word for word) / "Physiology" in "Associate Professor - Physiology"
    return rt.length >= 2 && within(rt, t);              // "Packaging Artwork Executive" in "Urgent | PACKAGING ARTWORK EXECUTIVE"
  });
  if (!inside.length) return null;
  // a partial match must point at ONE requirement: the mailbox recruiter's own, then their seat's department; several left
  // ("Assistant Professor - Pharm D" / "- Pharmacology" for "Professor and Assistant Professor") = not guessed, it waits
  let xs = inside;
  const narrow = (f) => { const y = xs.filter(f); if (y.length) xs = y; };
  if (ctx && ctx.userId) narrow((r) => r.recruiterId === ctx.userId || csv(r.recruiterIds).includes(ctx.userId));
  if (ctx && ctx.department) narrow((r) => String(r.department || '').toLowerCase() === String(ctx.department).toLowerCase());
  return xs.length === 1 ? xs[0] : null;
}

// TITLES LINKED BY HAND (the mailbox screen): { <normalised mail title>: requirementId } - for a title that matches no requirement
// or several. Checked before any matching.
const MAP_KEY = 'mailImports.titleMap';
async function titleMap() {
  try { const row = await prisma.appSetting.findUnique({ where: { key: MAP_KEY } }); const v = row ? JSON.parse(row.value) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
async function linkTitle(title, requirementId) {
  const map = await titleMap();
  const k = normTitle(title);
  if (!k) return null;
  if (requirementId) map[k] = String(requirementId); else delete map[k];
  const value = JSON.stringify(map);
  await prisma.appSetting.upsert({ where: { key: MAP_KEY }, create: { key: MAP_KEY, value }, update: { value } });
  return k;
}

let last = null; // the last run, for the mailbox screen
let running = null;

async function pull({ sinceDays = 60 } = {}) {
  if (running) return running;
  running = (async () => {
    const { portalFetch, ingestApplication } = require('./jobPortalBridge'); // eslint-disable-line global-require
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
    const res = await portalFetch(`/integrations/teamlink/mail-applications?since=${encodeURIComponent(since)}&limit=5000`, { timeoutMs: 60000 });
    const apps = (res && res.applications) || [];
    const index = await requirementsIndex();
    const byHand = await titleMap();
    const byId = new Map(index.map((r) => [r.id, r]));
    // the mailbox recruiter -> their TeamLink login and their seat's department
    const emails = [...new Set(apps.map((a) => String(a.application.recruiterEmail || '').toLowerCase()).filter(Boolean))];
    const users = emails.length ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } }) : [];
    const userOf = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
    const seats = new Map((await require('./jobPortalRecruiters').people().catch(() => [])).map((p) => [p.email, p.department])); // eslint-disable-line global-require
    const out = { at: new Date().toISOString(), read: apps.length, added: 0, already: 0, waiting: 0, failed: 0, waitingTitles: {} };
    for (const a of apps) {
      const email = String(a.application.recruiterEmail || '').toLowerCase();
      const ctx = { userId: userOf.get(email) || null, department: seats.get(email) || null };
      const req = byId.get(byHand[normTitle(a.application.jobTitle)]) || match(index, a.application.jobTitle, ctx);
      if (!req) {
        out.waiting += 1;
        const t = String(a.application.jobTitle || '(no title)').slice(0, 120);
        if (!out.waitingTitles[t]) out.waitingTitles[t] = { count: 0, several: candidatesFor(index, t).length > 1 };
        out.waitingTitles[t].count += 1;
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await ingestApplication({ ...a, requirementId: req.id, ownerUserId: ctx.userId || undefined, viaMail: true })
        .catch((e) => ({ status: 500, body: { error: e.message } }));
      if (r.status === 201) out.added += 1;
      else if (r.status === 200) out.already += 1;
      else out.failed += 1;
    }
    out.waitingTitles = Object.entries(out.waitingTitles).sort((x, y) => y[1].count - x[1].count).slice(0, 30)
      .map(([title, w]) => ({ title, count: w.count, why: w.several ? 'several requirements have this title' : 'no requirement has this title' }));
    if (out.added) console.log(`[mail-imports] ${out.added} Naukri / Shine response(s) added to ATS applications`);
    last = out;
    return out;
  })().finally(() => { running = null; });
  return running;
}

// the requirements a title could be (for "several requirements have this title")
function candidatesFor(index, title) {
  const t = tokens(normTitle(title));
  return t.length ? index.filter((r) => { const rt = tokens(r.norm); return within(t, rt) || (rt.length >= 2 && within(rt, t)); }) : [];
}

function lastRun() { return last; }
function pullQuietly(opts) { return pull(opts).catch((e) => { last = { at: new Date().toISOString(), error: e.message }; return last; }); }

module.exports = { pull, pullQuietly, lastRun, normTitle, match, linkTitle, titleMap, _pick: pick };

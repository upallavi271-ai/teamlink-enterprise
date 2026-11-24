// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS > ONBOARDING (2026-11-24). What to collect, claim and verify when a new client starts, as a checklist per client on a plan, so nothing is forgotten and a new person can take over:
//   * GET ACCESS      permission, finding the Google profile (and copies of it), claiming it, Google's verification, TeamLink added as a MANAGER (the client stays the Owner; nobody ever writes a password down),
//   * COLLECT FACTS   name, address, phone / WhatsApp / website, hours, categories (ideas from the industry pack), services, description, photos, social pages,
//   * WEBSITE         who can change the website, how the Search Console numbers for the monthly report will come,
//   * TEAMLINK TOOLS  the Google profile audit, the website check, the competitor snapshot and (Premium) the first month's blog plan: these tick THEMSELVES when the work is saved for the client,
//   * AGREE           who approves posts, (healthcare) the doctor who approves medical content and the patient-photo rule, review replies, the date of the first report.
// Steps that apply only to healthcare, or only to a plan with SEO blogs, appear only then. A client is "ready to start" when every MUST-DO step is done. Ticks are kept with who ticked and when.
// Nothing here contacts Google or the client, and nothing is posted: it is the team's own list. A plan that started 7 or more days ago and has must-do steps open is shown in "Needs attention" and
// reminded once at 7 days and once at 14 days (planReminders.js).
// saved per plan: table OmniMkOnboarding; audit log "Omni-Channel AI Marketing: onboarding step ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const CS = require('./clientServices');
const Site = require('./siteCheck');
const Comp = require('./competitors');
const Blog = require('./blogPlanner');
const Packs = require('./industryPacks');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkOnboarding';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL, "steps" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_plan" ON "${T}"("planId")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] onboarding schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console
const SYS = { id: 'system', name: 'TeamLink', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; // reads the saved work of a client the caller may already see

const GROUPS = [['access', 'Get access to the Google profile'], ['facts', 'Collect the facts'], ['website', 'Website and reporting'], ['tools', 'Run the TeamLink tools'], ['agree', 'Agree how we work']];
const WHO = { client: 'The client does this', team: 'TeamLink does this', both: 'Together' };
// key, group, who, core (a MUST-DO step), text, hint; only: 'health' | 'blogs'; auto: ticked by itself when the work is saved
const STEPS = [
  { key: 'consent', group: 'access', who: 'client', core: true, text: 'Written permission from the client to manage its Google profile and to promote the business', hint: 'A signed agreement, or an email or WhatsApp message from the person who owns the business. Keep it with the client\'s papers.' },
  { key: 'find', group: 'access', who: 'team', core: true, text: 'Search Google and Google Maps for the business and for copies of it', hint: 'Search the name and the phone number. Note a profile that is unverified, a duplicate, or one that someone else made.' },
  { key: 'claim', group: 'access', who: 'both', core: true, text: 'Claim the profile, or create it if there is none', hint: 'Create it at business.google.com if none exists. If someone else already owns it, ask Google for ownership with the client\'s help (Google decides).' },
  { key: 'verify', group: 'access', who: 'client', core: true, text: 'Verify the profile with Google', hint: 'Google decides which ways it offers (phone, text, email, video or postcard). The client usually has to receive the code or record the video.' },
  { key: 'manager', group: 'access', who: 'client', core: true, text: 'The client adds TeamLink as a Manager on the profile', hint: 'The client stays the Owner. Manager access is enough for posts, photos, replies and reports. Never share or write down a password: not in TeamLink, not on WhatsApp, not in an email.' },
  { key: 'ownerNote', group: 'access', who: 'team', core: false, text: 'Write down who is the Owner, and which email and phone Google uses for recovery', hint: 'Write who it is, not the passwords. If that person leaves the business, ownership has to be moved.' },
  { key: 'name', group: 'facts', who: 'client', core: true, text: 'The exact business name, as on the signboard', hint: 'Google wants the real name, without extra keywords or the city added.' },
  { key: 'address', group: 'facts', who: 'client', core: true, text: 'The full address, and the map pin checked on Google Maps', hint: 'A business that visits its customers can show a service area instead of the address.' },
  { key: 'contact', group: 'facts', who: 'client', core: true, text: 'Phone number(s), WhatsApp number, website and the booking or enquiry link', hint: 'Write them exactly as the client wants them shown, and use the same everywhere.' },
  { key: 'hours', group: 'facts', who: 'client', core: true, text: 'Opening hours, and the holiday hours for the coming festivals', hint: 'Ask for special hours before each festival, not after.' },
  { key: 'categories', group: 'facts', who: 'both', core: true, text: 'One main category and the other categories', hint: (c) => (c.pack.gbp.length ? `Ideas for this kind of business: ${c.pack.gbp.join(', ')}. Pick the ones that are really true.` : 'Pick the Google categories that describe what the business really does.') },
  { key: 'services', group: 'facts', who: 'client', core: false, text: 'The list of services or products, each with a short real description', hint: 'Prices only if the client wants them shown.' },
  { key: 'description', group: 'facts', who: 'both', core: false, text: 'The business description (up to 750 characters), from the client\'s own facts', hint: 'Use SEO and visibility > FAQ and schema > description as a first draft, then let the client correct it.' },
  { key: 'photos', group: 'facts', who: 'client', core: true, text: 'Photos: logo, cover photo, outside, inside and the team (with their permission)', hint: (c) => (c.health ? 'No patient in any picture. Staff photos need the staff member\'s permission.' : 'Real photos of the real place; people in them need to agree.') },
  { key: 'social', group: 'facts', who: 'client', core: false, text: 'The social media pages that are really used', hint: 'Use the same name, address and phone number everywhere.' },
  { key: 'webAccess', group: 'website', who: 'both', core: true, text: 'Who can change the client\'s website, or how to ask them', hint: 'The FAQ, the business data and the fixes the website check finds need someone who can edit the site.' },
  { key: 'console', group: 'website', who: 'both', core: false, text: 'Search Console: the client adds TeamLink, or sends the export every month', hint: 'The monthly report uses the Search Console export (Performance > Export). The client can send it by WhatsApp if access is not given.' },
  { key: 'audit', group: 'tools', who: 'team', core: true, auto: 'audit', text: 'Run the Google profile audit and save it for the client', hint: 'Client plans > the client\'s plan > Google profile audit.' },
  { key: 'sitecheck', group: 'tools', who: 'team', core: true, auto: 'sitecheck', text: 'Run the website check (up to 10 pages) and save it for the client', hint: 'SEO and visibility > Website check; tick "Save this check for the client".' },
  { key: 'competitors', group: 'tools', who: 'team', core: false, auto: 'competitors', text: 'Save a competitor snapshot', hint: 'SEO and visibility > Competitors; ask the client which businesses it sees as competitors.' },
  { key: 'blogplan', group: 'tools', who: 'team', core: false, only: 'blogs', auto: 'blogplan', text: 'Plan the first month\'s SEO blogs', hint: 'SEO and visibility > Blog planner; tick "Save this plan for the client".' },
  { key: 'approver', group: 'agree', who: 'client', core: true, text: 'Who approves posts for the client, and how (WhatsApp or email)', hint: 'Nothing is posted before this person approves it.' },
  { key: 'medical', group: 'agree', who: 'client', core: true, only: 'health', text: 'The doctor or medical reviewer who approves medical content', hint: 'Medical content is reviewed by a doctor or a qualified medical reviewer before it is published.' },
  { key: 'patients', group: 'agree', who: 'client', core: false, only: 'health', text: 'The rule for patient photos, names and testimonials', hint: 'No patient is named or shown without written permission, and some uses may be restricted.' },
  { key: 'replies', group: 'agree', who: 'both', core: false, text: 'How review replies are handled, and who is called about a bad review', hint: 'Agree the tone (SEO and visibility > Review replies has the starting drafts).' },
  { key: 'firstReport', group: 'agree', who: 'team', core: true, text: 'Tell the client the date of the first monthly report and what it will show', hint: 'It shows what was delivered, the numbers the client or Search Console gave, and what is next. It promises no ranking or lead.' },
];
const KEYS = new Set(STEPS.map((s) => s.key));

const clip = (s, n) => S.clip(s, n) || '';
function ctxOf(planLike) {
  const kind = Blog.guessIndustry(planLike && planLike.industry); const pack = Packs.PACKS[kind]; const q = (planLike && planLike.quotas) || {};
  return { kind, pack, health: !!pack.healthcare, blogs: Number(q.blogs) > 0 };
}
const applies = (s, c) => !s.only || (s.only === 'health' ? c.health : c.blogs);

// what is already saved in TeamLink for this client (the steps that tick themselves)
async function evidence(clientName, planId) {
  const out = {};
  try { let l = await CS.listAudits(SYS, { planId }); if (!l.items || !l.items.length) l = await CS.listAudits(SYS, { clientName }); if (l.items && l.items[0]) out.audit = l.items[0].createdAt; } catch { /* none */ }
  try { const s = await Site.latestFor(SYS, clientName); if (s) out.sitecheck = s.createdAt; } catch { /* none */ }
  try { const c = await Comp.latestFor(SYS, clientName); if (c) out.competitors = c.createdAt || c.comparedAt || true; } catch { /* none */ }
  try { const b = await Blog.list(SYS, { clientName }); if (b.items && b.items[0]) out.blogplan = b.items[0].createdAt; } catch { /* none */ }
  return out;
}
async function savedOf(planId) { if (!(await ensure())) return {}; const r = (await S.q(`SELECT steps FROM "${T}" WHERE planId = ?`, planId))[0]; return r ? S.parse(r.steps, {}) || {} : {}; }
const dayWords = (iso) => { try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch { return ''; } };

function compute(ctx, saved, ev) {
  const items = STEPS.filter((s) => applies(s, ctx)).map((s) => {
    const st = saved[s.key] || {}; const e = s.auto ? ev[s.auto] : null; const done = s.auto ? !!e : !!st.done;
    return { key: s.key, group: s.group, who: s.who, whoWords: WHO[s.who], core: s.core, auto: s.auto || null, text: s.text, hint: typeof s.hint === 'function' ? s.hint(ctx) : s.hint, done,
      doneAt: s.auto ? (e && e !== true ? e : null) : (st.done && st.at ? S.iso(st.at) : null), doneBy: s.auto ? '' : st.byName || '', note: st.note || '',
      evidence: s.auto ? (e ? `Found: saved ${e !== true ? `on ${dayWords(e)}` : 'for this client'}.` : 'Not saved yet.') : '' };
  });
  const core = items.filter((i) => i.core); const done = items.filter((i) => i.done).length; const coreDone = core.filter((i) => i.done).length;
  return { items, summary: { done, total: items.length, pct: items.length ? Math.round((done / items.length) * 100) : 0, coreDone, coreTotal: core.length, coreLeft: core.length - coreDone, ready: coreDone === core.length } };
}
function view(plan, ctx, c) {
  return { planId: plan.id, clientName: plan.clientName, industryLabel: ctx.pack.label, healthcare: ctx.health, startDate: plan.startDate, summary: c.summary,
    groups: GROUPS.map(([key, label]) => ({ key, label, items: c.items.filter((i) => i.group === key) })).filter((g) => g.items.length),
    note: 'This is the team\'s own list. Nothing is sent to Google or to the client from here. A client is ready to start when every must-do step is done.' };
}
async function get(u, planId) {
  const p = await CS.getPlan(u, planId); if (p.error) return p; const plan = p.plan; const ctx = ctxOf(plan);
  return { onboarding: view(plan, ctx, compute(ctx, await savedOf(plan.id), await evidence(plan.clientName, plan.id))) };
}
// the team ticks a step (or un-ticks it) and may keep a note; the steps of the TeamLink tools tick themselves
async function setStep(u, planId, key, b = {}) {
  if (!(await ensure())) return { error: 'The checklist could not be opened.', status: 500 };
  const p = await CS.getPlan(u, planId); if (p.error) return p; const plan = p.plan; const ctx = ctxOf(plan);
  const step = STEPS.find((s) => s.key === key); if (!step || !applies(step, ctx)) return { error: 'That step is not in this checklist.', status: 404 };
  if (step.auto) return { error: 'This step ticks by itself when the work is saved in TeamLink.', status: 400 };
  const row = (await S.q(`SELECT id, steps FROM "${T}" WHERE planId = ?`, plan.id))[0]; const steps = row ? S.parse(row.steps, {}) || {} : {}; const cur = steps[key] || {}; const was = !!cur.done;
  if (b.done != null) { cur.done = !!b.done; if (cur.done && !was) { cur.at = Date.now(); cur.byName = clip(u.name, 80); } if (!cur.done) { cur.at = null; cur.byName = ''; } }
  if (b.note != null) cur.note = clip(b.note, 300);
  steps[key] = cur; const now = Date.now();
  if (row) await S.run(`UPDATE "${T}" SET steps = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(steps), now, row.id);
  else await S.run(`INSERT INTO "${T}" (id, planId, steps, createdAt, updatedAt) VALUES (?,?,?,?,?)`, S.newId('onb'), plan.id, JSON.stringify(steps), now, now);
  if (was !== !!cur.done) await logAudit({ userId: u.id, actorName: u.name, action: `Omni-Channel AI Marketing: onboarding step ${cur.done ? 'done' : 'reopened'}`, entity: T, entityId: plan.id, toValue: `${plan.clientName}: ${step.text.slice(0, 80)}` });
  return get(u, planId);
}
// for the reminders: { coreLeft, coreTotal, ready, done, total } of a plan row (no user needed)
async function summarize(raw) {
  const ctx = ctxOf({ industry: raw.industry, quotas: (CS.PLANS[raw.plan] || {}).quotas }); return compute(ctx, await savedOf(raw.id), await evidence(raw.clientName, raw.id)).summary;
}

module.exports = { ensure, get, setStep, summarize, STEPS, GROUPS, KEYS };

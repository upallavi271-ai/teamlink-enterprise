// ---------------------------------------------------------------------------
// MARKET WAVE C - JOB PORTAL / CAREERS SITE (10.02 / 10.03 / 10.04 / 10.07 / 10.09 / 10.10 / 10.11 / 10.13 / 10.14 / 10.18)
//   apply form      per-job extra questions (text / number / yes-no / choice / date / link, required, yes-no knock-outs)
//   quick apply     the resume is read the moment it is chosen and the form is filled from it (the person checks it)
//   LinkedIn        "Apply with LinkedIn" fallback (the public profile link instead of a resume), a LinkedIn job-wrapping feed,
//                   and the Apply Connect / board application door (needs LinkedIn partner approval: founder)
//   boards          Naukri / Shine / foundit / LinkedIn applications IN: a signed webhook the board calls, or a pull from the
//                   board's applications URL - both need the partner credentials (founder); tested with a stub
//   seo page        a server-rendered job page: meta, Open Graph, canonical, hreflang, JobPosting JSON-LD, mobile, English /
//                   Telugu / Hindi
//   site            the agency's careers site (hero, about, jobs, alerts, contact) kept as JSON, rendered at /site
//   alerts          candidates subscribe on the site (double opt-in); new jobs mailed to them (OFF by default)
//   extension       the LinkedIn sourcing browser extension's door: a per-person key, adds the profile being viewed
//   sms campaign    a job texted to a talent pool (filters over the candidates in the sender's scope), STOP and the DLR rule respected
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const C = require('./core');

const { q, x, nowIso, newId, txt, json } = C;

// ================================================================== 10.03 apply form answers
async function formOf(requirementId) {
  const s = await require('./interviews').jobSettings(requirementId); // eslint-disable-line global-require
  return { fields: s.fields || [], linkedinApply: s.linkedinApply };
}
function checkAnswers(fields, given) {
  const answers = {}; const knockedOut = [];
  for (const f of fields) {
    const raw = given[`q_${f.key}`];
    const v = raw == null ? '' : String(raw).trim();
    if (!v) { if (f.required) return { error: `Please answer: ${f.label}` }; continue; } // eslint-disable-line no-continue
    if (f.type === 'number' && !Number.isFinite(Number(v))) return { error: `"${f.label}" must be a number.` };
    if (f.type === 'yesno' && !['yes', 'no'].includes(v.toLowerCase())) return { error: `"${f.label}": answer yes or no.` };
    if (f.type === 'choice' && !(f.options || []).includes(v)) return { error: `"${f.label}": pick one of the choices.` };
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `"${f.label}": pick a date.` };
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) return { error: `"${f.label}": paste the full link (https://...).` };
    answers[f.key] = { label: f.label, value: txt(v, 1000) };
    if (f.type === 'yesno' && f.knockout && v.toLowerCase() === f.knockout) knockedOut.push(f.label);
  }
  return { answers, knockedOut };
}
async function saveAnswers(applicationId, requirementId, answers, knockedOut) {
  await C.ensure();
  if (!Object.keys(answers).length && !knockedOut.length) return;
  await x('INSERT OR REPLACE INTO "MktFormAnswer" ("applicationId","requirementId","answers","createdAt") VALUES (?,?,?,?)', applicationId, requirementId, JSON.stringify({ answers, knockedOut }), nowIso());
}
async function answersOf(applicationId) { await C.ensure(); const r = (await q('SELECT * FROM "MktFormAnswer" WHERE "applicationId" = ?', applicationId))[0]; return r ? json(r.answers, null) : null; }

// ================================================================== 10.04 quick apply
async function quickFill(file) {
  const RS = require('../resumeStore'); // eslint-disable-line global-require
  const { kind } = RS.validateResumeFile(file);
  const { parsed, error } = await RS.extractAndParse(file.data, kind);
  const p = parsed || {};
  const out = {
    name: p.name || null, email: (p.emails || [])[0] || null, phone: (p.phones || [])[0] || null, location: p.location || null,
    experienceYears: p.totalExperienceYears != null ? p.totalExperienceYears : null, skills: Array.isArray(p.skills) ? p.skills.slice(0, 15).join(', ') : null,
    currentCompany: p.currentCompany || null, noticePeriod: p.noticePeriod || null, currentSalary: p.currentCtc || p.currentSalary || null, expectedSalary: p.expectedCtc || p.expectedSalary || null,
  };
  const filled = Object.values(out).filter((v) => v != null && v !== '').length;
  return { fields: out, filled, note: filled ? `We filled ${filled} box(es) from your resume. Please check them.` : (error ? 'We could not read this resume. Please type your details.' : 'Nothing could be read from this resume. Please type your details.') };
}

// ================================================================== 10.10 LinkedIn links
const LINKEDIN = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{2,100}\/?(\?.*)?$/i;
function cleanLinkedin(u) {
  const s = String(u || '').trim();
  if (!LINKEDIN.test(s)) return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(s);
  return `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}`;
}
// JOB-BOARD PROFILES (founder 2026-11-26, extension 2.0): Naukri (incl. Resdex), Shine and foundit pages, besides LinkedIn. The profile
// address is kept short and stable (host + path, plus the one id parameter a Resdex preview carries), so the same page matches next time.
const SITES = {
  linkedin: { label: 'LinkedIn', test: /(^|\.)linkedin\.com$/i },
  naukri: { label: 'Naukri', test: /(^|\.)naukri\.com$/i },
  shine: { label: 'Shine', test: /(^|\.)shine\.com$/i },
  foundit: { label: 'foundit', test: /(^|\.)(foundit\.in|monsterindia\.com)$/i },
};
function siteOf(u) {
  try { const h = new URL(String(u || '')).hostname; return Object.keys(SITES).find((k) => SITES[k].test.test(h)) || null; } catch { return null; }
}
function cleanProfileUrl(u) {
  const site = siteOf(u);
  if (!site) return null;
  if (site === 'linkedin') { const l = cleanLinkedin(u); return l ? { site, url: l } : null; }
  try {
    const x = new URL(String(u));
    const keep = ['uniqId', 'uniqid', 'profileId', 'id', 'resId', 'candidateId', 'cid'].find((k) => x.searchParams.get(k));
    const path = x.pathname.replace(/\/+$/, '') || '/';
    return { site, url: `https://${x.hostname.toLowerCase()}${path}${keep ? `?${keep}=${encodeURIComponent(x.searchParams.get(keep))}` : ''}` };
  } catch { return null; }
}
async function linkCandidate(candidateId, kind, url, by) {
  await C.ensure();
  await x('INSERT OR IGNORE INTO "MktCandLink" ("candidateId","kind","url","createdAt","createdBy") VALUES (?,?,?,?,?)', candidateId, kind, url, nowIso(), by || null);
}
async function candidateByLink(kind, url) { await C.ensure(); const r = (await q('SELECT "candidateId" FROM "MktCandLink" WHERE "kind" = ? AND "url" = ?', kind, url))[0]; return r ? r.candidateId : null; }
async function linksOf(candidateId) { await C.ensure(); return q('SELECT "kind","url","createdAt","createdBy" FROM "MktCandLink" WHERE "candidateId" = ?', candidateId); }

// ================================================================== 10.02 SEO job page, languages
const LANGS = ['en', 'te', 'hi'];
const T = {
  en: { apply: 'Apply now', location: 'Location', experience: 'Experience', salary: 'Salary', skills: 'Skills', type: 'Job type', about: 'About the job', posted: 'Posted', more: 'More jobs', lang: 'English', intro: (t, l) => `${t} job${l ? ` in ${l}` : ''}. Apply online in two minutes.`, linkedin: 'Apply with LinkedIn', alert: 'Get job alerts' },
  te: { apply: 'ఇప్పుడే దరఖాస్తు చేయండి', location: 'ప్రాంతం', experience: 'అనుభవం', salary: 'జీతం', skills: 'నైపుణ్యాలు', type: 'ఉద్యోగ రకం', about: 'ఉద్యోగం గురించి', posted: 'ప్రచురించిన తేదీ', more: 'మరిన్ని ఉద్యోగాలు', lang: 'తెలుగు', intro: (t, l) => `${t} ఉద్యోగం${l ? ` - ${l}` : ''}. రెండు నిమిషాల్లో ఆన్‌లైన్‌లో దరఖాస్తు చేయండి.`, linkedin: 'LinkedIn తో దరఖాస్తు', alert: 'ఉద్యోగ సమాచారం పొందండి' },
  hi: { apply: 'अभी आवेदन करें', location: 'स्थान', experience: 'अनुभव', salary: 'वेतन', skills: 'कौशल', type: 'नौकरी का प्रकार', about: 'नौकरी के बारे में', posted: 'प्रकाशित', more: 'और नौकरियाँ', lang: 'हिन्दी', intro: (t, l) => `${t} की नौकरी${l ? ` - ${l}` : ''}. दो मिनट में ऑनलाइन आवेदन करें.`, linkedin: 'LinkedIn से आवेदन', alert: 'नौकरी अलर्ट पाएँ' },
};
const escHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// the job text a stranger may read: the careers page's own (no client name, no fee or agreement notes - utils/jobText.masterForCareers)
async function safeText(job) {
  try { return String((await require('../jobText').masterForCareers(job)) || '').trim(); } catch { return ''; } // eslint-disable-line global-require
}
// the job's own words in Telugu / Hindi: written once by the AI and kept (MktJobI18n); English when the model is not there
async function translated(job, lang) {
  if (lang === 'en') return null;
  await x('CREATE TABLE IF NOT EXISTS "MktJobI18n" ("requirementId" TEXT NOT NULL, "lang" TEXT NOT NULL, "title" TEXT, "summary" TEXT, "at" TEXT NOT NULL, PRIMARY KEY ("requirementId","lang"))');
  const had = (await q('SELECT * FROM "MktJobI18n" WHERE "requirementId" = ? AND "lang" = ?', job.id, lang))[0];
  if (had && new Date(had.at) > new Date(job.updatedAt || 0)) return { title: had.title, summary: had.summary };
  const words = (await safeText(job)).slice(0, 1500);
  const ai = await C.aiJson(`Translate a job advert into ${lang === 'te' ? 'Telugu' : 'Hindi'} for job seekers. Keep company names, skill names and numbers as they are. JSON only: {"title":"...","summary":"3-4 short sentences"}.`, C.maskPii(`Title: ${job.title}\n${words}`, []), { maxTokens: 700, timeoutMs: 9000 });
  if (!ai || !ai.value || !ai.value.title) return null;
  const v = { title: txt(ai.value.title, 200), summary: txt(ai.value.summary, 1500) };
  await x('INSERT OR REPLACE INTO "MktJobI18n" ("requirementId","lang","title","summary","at") VALUES (?,?,?,?,?)', job.id, lang, v.title, v.summary, nowIso());
  return v;
}
async function seoJobPage(req, job, { lang = 'en', applyUrl } = {}) {
  const L = LANGS.includes(lang) ? lang : 'en';
  const t = T[L];
  const pub = require('../../routes/public'); // eslint-disable-line global-require
  const { careersPath, slugOf } = require('../jobSlug'); // eslint-disable-line global-require
  const base = pub.publicBase(req);
  const ld = JSON.stringify(await pub.jobPostingLdSafe(job, base)).split('<').join('\\u003c');
  const tr = await translated(job, L).catch(() => null);
  const title = (tr && tr.title) || job.title;
  const desc = await safeText(job);
  const metaDesc = `${t.intro(job.title, job.location)} ${desc.replace(/\s+/g, ' ').slice(0, 120)}`.trim().slice(0, 160);
  const path = careersPath(job);
  const canonical = `${base}${path}`;
  const alt = LANGS.map((l) => `<link rel="alternate" hreflang="${l === 'en' ? 'en-IN' : `${l}-IN`}" href="${escHtml(`${canonical}${l === 'en' ? '' : `?lang=${l}`}`)}">`).join('') + `<link rel="alternate" hreflang="x-default" href="${escHtml(canonical)}">`;
  const apply = applyUrl || `${base}/site/job/${encodeURIComponent(slugOf(job))}`;
  const s = await C.settings();
  const brand = s.site.brand || {};
  const row = (k, v) => (v ? `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>` : '');
  const langLinks = LANGS.map((l) => (l === L ? `<b>${escHtml(T[l].lang)}</b>` : `<a href="${escHtml(`${canonical}${l === 'en' ? '' : `?lang=${l}`}`)}">${escHtml(T[l].lang)}</a>`)).join(' · ');
  return `<!doctype html><html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} - ${escHtml(job.location || '')} | ${escHtml(brand.name || 'TeamLink')} Jobs</title>
<meta name="description" content="${escHtml(metaDesc)}"><link rel="canonical" href="${escHtml(L === 'en' ? canonical : `${canonical}?lang=${L}`)}">${alt}
<meta property="og:type" content="website"><meta property="og:title" content="${escHtml(title)}"><meta property="og:description" content="${escHtml(metaDesc)}"><meta property="og:url" content="${escHtml(canonical)}">${brand.logoUrl ? `<meta property="og:image" content="${escHtml(brand.logoUrl)}">` : ''}
<meta name="twitter:card" content="summary"><meta name="robots" content="index,follow">
<script type="application/ld+json">${ld}</script>
<style>body{font-family:system-ui,Arial,sans-serif;margin:0;color:#111;background:#f8fafc}main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:24px;margin:8px 0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:12px 0}th{text-align:left;color:#6b7280;font-weight:500;padding:4px 12px 4px 0;vertical-align:top}.btn{display:inline-block;background:${escHtml(/^#[0-9a-f]{6}$/i.test(brand.color || '') ? brand.color : '#1f6feb')};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600}.langs{font-size:13px;color:#6b7280}p{line-height:1.55}</style></head>
<body><main><div class="langs">${langLinks}</div><h1>${escHtml(title)}</h1><p>${escHtml(t.intro(job.title, job.location))}</p>
<div class="card"><table>${row(t.location, job.location)}${row(t.experience, job.experience)}${row(t.salary, job.salary)}${row(t.type, job.employmentType)}${row(t.skills, job.skills)}</table></div>
<p><a class="btn" href="${escHtml(apply)}">${escHtml(t.apply)}</a></p>
<div class="card"><h2 style="font-size:18px">${escHtml(t.about)}</h2>${tr && tr.summary ? `<p>${escHtml(tr.summary)}</p>` : ''}${desc ? `<p>${escHtml(desc.slice(0, 4000)).replace(/\r?\n/g, '<br>')}</p>` : ''}</div>
<p><a href="${escHtml(`${base}/site`)}">${escHtml(t.more)}</a></p></main></body></html>`;
}

// ================================================================== 10.18 the careers site
const SECTIONS = ['hero', 'about', 'jobs', 'alerts', 'contact'];
function cleanSite(b) {
  const s = b || {};
  const str = (v, n) => txt(v, n);
  const url = (v) => { const u = str(v, 500); return !u || /^https:\/\/\S+$/i.test(u) ? u : null; };
  const color = /^#[0-9a-f]{6}$/i.test(String((s.brand || {}).color || '')) ? s.brand.color : '#1f6feb';
  const logo = url((s.brand || {}).logoUrl);
  if (logo === null) return { error: 'The logo link must start with https://' };
  const sections = (Array.isArray(s.sections) ? s.sections : SECTIONS).filter((k) => SECTIONS.includes(k));
  if (!sections.length) return { error: 'Keep at least one section on the page.' };
  const contactEmail = str((s.contact || {}).email, 120);
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(contactEmail)) return { error: 'The contact email is not correct.' };
  return {
    value: {
      published: !!s.published,
      brand: { name: str((s.brand || {}).name, 80) || 'TeamLink', color, logoUrl: logo || '' },
      hero: { title: str((s.hero || {}).title, 120) || 'Find your next job', subtitle: str((s.hero || {}).subtitle, 300), button: str((s.hero || {}).button, 40) || 'See open jobs' },
      about: { title: str((s.about || {}).title, 80) || 'About us', text: str((s.about || {}).text, 3000) },
      jobs: { title: str((s.jobs || {}).title, 80) || 'Open jobs', max: Math.min(Math.max(Number((s.jobs || {}).max) || 30, 3), 100) },
      contact: { title: str((s.contact || {}).title, 80) || 'Contact', email: contactEmail, phone: str((s.contact || {}).phone, 30), address: str((s.contact || {}).address, 300) },
      sections: [...new Set(sections)],
      seo: { description: str((s.seo || {}).description, 160), languages: ['en', 'te', 'hi'] },
    },
  };
}
async function publicSite({ preview = false, lang = 'en' } = {}) {
  const s = await C.settings();
  const site = s.site;
  if (!site.published && !preview) return { published: false };
  const CP = require('../../routes/careersPublic'); // eslint-disable-line global-require
  const jobs = (await CP.listedJobs()).slice(0, (site.jobs && site.jobs.max) || 30).map((j) => CP.cardOf(j));
  return { published: !!site.published, site, jobs, alerts: s.switches.jobAlerts, lang: LANGS.includes(lang) ? lang : 'en', labels: { ...T[LANGS.includes(lang) ? lang : 'en'], intro: undefined } };
}

// ================================================================== 10.14 job alerts
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
async function subscribe(b, req) {
  if (!(await C.switchOn('jobAlerts'))) return { status: 409, error: 'Job alerts are not open yet.' };
  await C.ensure();
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  if (!EMAIL.test(email)) return { status: 400, error: 'Please type a correct email address.' };
  const v = await require('./comms').validateEmail(email, { mx: true }); // eslint-disable-line global-require
  if (v.verdict === 'invalid' || v.disposable) return { status: 400, error: v.suggestion ? `Did you mean ${v.suggestion}?` : 'Please use your own email address (not a throw-away one).' };
  if (!/^(yes|true|on|1)$/i.test(String(b.consent || ''))) return { status: 400, error: 'Please tick the box to agree to get job emails.' };
  const lang = LANGS.includes(b.lang) ? b.lang : 'en';
  const had = (await q('SELECT * FROM "MktAlertSub" WHERE "email" = ?', email))[0];
  const token = had ? had.token : C.randToken(18);
  if (had) await x('UPDATE "MktAlertSub" SET "keywords" = ?, "location" = ?, "lang" = ?, "name" = COALESCE(?, "name"), "status" = CASE WHEN "status" = \'active\' THEN \'active\' ELSE \'pending\' END, "stoppedAt" = NULL WHERE "email" = ?', txt(b.keywords, 200) || null, txt(b.location, 80) || null, lang, txt(b.name, 80) || null, email);
  else await x('INSERT INTO "MktAlertSub" ("id","email","name","keywords","location","lang","status","token","createdAt") VALUES (?,?,?,?,?,?,\'pending\',?,?)', newId(), email, txt(b.name, 80) || null, txt(b.keywords, 200) || null, txt(b.location, 80) || null, lang, token, nowIso());
  const row = (await q('SELECT * FROM "MktAlertSub" WHERE "email" = ?', email))[0];
  if (row.status === 'active') return { ok: true, message: 'You already get job alerts. Your choices are saved.' };
  const link = `${C.publicBase(req)}/api/public/mkt/alerts/confirm/${token}`;
  await require('../messaging').send('Email', { to: email, subject: 'Please confirm your job alerts', text: `Hi${row.name ? ` ${row.name.split(/\s+/)[0]}` : ''},\n\nPress this link to start getting new jobs by email:\n${link}\n\nIf you did not ask for this, ignore this email.\n\n- ${((await C.settings()).site.brand || {}).name || 'TeamLink'}`, fromName: 'TeamLink Jobs' }).catch(() => null); // eslint-disable-line global-require
  return { ok: true, message: 'Almost done: we sent you an email. Press the link in it to start the alerts.' };
}
async function confirmAlert(token) {
  await C.ensure();
  const n = await x('UPDATE "MktAlertSub" SET "status" = \'active\', "confirmedAt" = COALESCE("confirmedAt", ?), "lastSentAt" = COALESCE("lastSentAt", ?) WHERE "token" = ? AND "status" <> \'stopped\'', nowIso(), nowIso(), String(token || '').slice(0, 40));
  return n > 0;
}
async function stopAlert(token) {
  await C.ensure();
  const n = await x('UPDATE "MktAlertSub" SET "status" = \'stopped\', "stoppedAt" = ? WHERE "token" = ?', nowIso(), String(token || '').slice(0, 40));
  return n > 0;
}
const matchesSub = (sub, job) => {
  const hay = `${job.title} ${job.skills || ''} ${job.department || ''}`.toLowerCase();
  const kws = String(sub.keywords || '').toLowerCase().split(/[,;]+/).map((k) => k.trim()).filter(Boolean);
  const kwOk = !kws.length || kws.some((k) => hay.includes(k));
  const locOk = !sub.location || String(job.location || '').toLowerCase().includes(String(sub.location).toLowerCase()) || /remote|work from home|anywhere/i.test(`${job.location} ${job.workMode}`);
  return kwOk && locOk;
};
// one digest per person with the jobs published after their last mail (at most 5); -> { people, mails }
async function runAlerts(req = null, { force = false } = {}) {
  if (!force && !(await C.switchOn('jobAlerts'))) return { off: true, people: 0, mails: 0 };
  await C.ensure();
  const CP = require('../../routes/careersPublic'); // eslint-disable-line global-require
  const jobs = await CP.listedJobs();
  const subs = await q('SELECT * FROM "MktAlertSub" WHERE "status" = \'active\'');
  let mails = 0;
  const base = C.publicBase(req);
  const { slugOf } = require('../jobSlug'); // eslint-disable-line global-require
  for (const sub of subs) {
    const sent = new Set(json(sub.sentJobs, []));
    const since = sub.lastSentAt ? new Date(sub.lastSentAt) : new Date(0);
    const fresh = jobs.filter((j) => !sent.has(j.id) && new Date(j.portalPublishedAt || j.createdAt) >= new Date(since.getTime() - 86400e3) && matchesSub(sub, j)).slice(0, 5);
    if (!fresh.length) continue; // eslint-disable-line no-continue
    const stop = `${base}/api/public/mkt/alerts/stop/${sub.token}`;
    const text = `Hi${sub.name ? ` ${sub.name.split(/\s+/)[0]}` : ''},\n\nNew jobs for you:\n\n${fresh.map((j) => `- ${j.title}${j.location ? ` (${j.location})` : ''}\n  ${base}/site/job/${encodeURIComponent(slugOf(j))}`).join('\n')}\n\nStop these emails: ${stop}`;
    // eslint-disable-next-line no-await-in-loop
    const r = await require('../messaging').send('Email', { to: sub.email, subject: `${fresh.length} new job${fresh.length > 1 ? 's' : ''} for you`, text, fromName: 'TeamLink Jobs' }).catch(() => ({ outcome: 'Failed' })); // eslint-disable-line global-require
    if (r.outcome === 'Sent' || r.sandbox) mails += 1;
    // eslint-disable-next-line no-await-in-loop
    await x('UPDATE "MktAlertSub" SET "lastSentAt" = ?, "sentJobs" = ? WHERE "id" = ?', nowIso(), JSON.stringify([...sent, ...fresh.map((j) => j.id)].slice(-300)), sub.id);
  }
  return { people: subs.length, mails };
}
async function alertStats() {
  await C.ensure();
  const rows = await q('SELECT "status", COUNT(*) AS n FROM "MktAlertSub" GROUP BY "status"');
  const by = {}; rows.forEach((r) => { by[r.status] = Number(r.n); });
  const recent = await q('SELECT "email","keywords","location","lang","status","createdAt","lastSentAt" FROM "MktAlertSub" ORDER BY "createdAt" DESC LIMIT 50');
  return { active: by.active || 0, pending: by.pending || 0, stopped: by.stopped || 0, recent: recent.map((r) => ({ ...r, email: r.email.replace(/^(.).*(@.*)$/, '$1***$2') })) };
}
let alertTimer = null;
function startAlerts() {
  if (alertTimer || C.isSandbox()) return;
  alertTimer = setInterval(() => { runAlerts().catch((e) => console.error('[mkt] alerts:', e.message)); }, 6 * 3600e3); // eslint-disable-line no-console
  if (alertTimer.unref) alertTimer.unref();
}

// ================================================================== 10.07 / 10.09 / 10.10 board applications in
const BOARDS = { naukri: 'Naukri', shine: 'Shine', foundit: 'foundit', linkedin: 'LinkedIn' };
async function boardConfig(board) {
  const s = await C.settings();
  const b = (s.boards && s.boards[board]) || {};
  return { webhookSecret: b.webhookSecretEnc ? C.dec(b.webhookSecretEnc) : '', pullUrl: b.pullUrl || '', apiKey: b.apiKeyEnc ? C.dec(b.apiKeyEnc) : '', lastPullAt: b.lastPullAt || null, lastResult: b.lastResult || null, saved: { webhookSecret: !!b.webhookSecretEnc, apiKey: !!b.apiKeyEnc } };
}
async function boardsView(req) {
  const out = [];
  for (const [id, label] of Object.entries(BOARDS)) {
    const c = await boardConfig(id); // eslint-disable-line no-await-in-loop
    out.push({ id, label, webhookUrl: `${C.publicBase(req)}/api/public/mkt/boards/${id}/applications`, pullUrl: c.pullUrl, saved: c.saved, lastPullAt: c.lastPullAt, lastResult: c.lastResult, ready: !!(c.webhookSecret || (c.pullUrl && c.apiKey)) });
  }
  return out;
}
async function saveBoard(board, b, user) {
  if (!BOARDS[board]) return { status: 404, error: 'Unknown job board.' };
  const s = await C.settings();
  const boards = { ...(s.raw.boards || {}) };
  const cur = { ...(boards[board] || {}) };
  try {
    if (b.webhookSecret) cur.webhookSecretEnc = C.enc(String(b.webhookSecret));
    if (b.apiKey) cur.apiKeyEnc = C.enc(String(b.apiKey));
  } catch (e) { return { status: 400, error: e.message }; }
  if (b.clearWebhookSecret) delete cur.webhookSecretEnc;
  if (b.clearApiKey) delete cur.apiKeyEnc;
  if (b.pullUrl !== undefined) {
    const u = txt(b.pullUrl, 500);
    if (u && !/^https:\/\/\S+$/i.test(u) && !(C.isSandbox() && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u))) return { status: 400, error: 'The applications URL must start with https://' };
    cur.pullUrl = u;
  }
  boards[board] = cur;
  await C.saveSettings({ boards }, user);
  return { ok: true };
}
function verifySignature(secret, raw, header) {
  if (!secret || !raw) return false;
  const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const got = String(header || '');
  return want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
async function requirementFor(board, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const byId = await prisma.requirement.findUnique({ where: { id: r.replace(/^tl_/, '') } }).catch(() => null);
  if (byId) return byId;
  const byCode = await prisma.requirement.findFirst({ where: { reqCode: r } }).catch(() => null);
  if (byCode) return byCode;
  const post = await prisma.requirementPosting.findFirst({ where: { source: board, externalJobId: r } }).catch(() => null);
  return post ? prisma.requirement.findUnique({ where: { id: post.requirementId } }) : null;
}
// one application from a board -> the ATS (the same door as the Job Portal's: utils/jobPortalBridge.ingestApplication)
async function ingestBoardApp(board, a) {
  await C.ensure();
  if (board === 'linkedin') a = require('../atsY/boards').fromApplyConnect(a); // eslint-disable-line global-require, no-param-reassign -- LinkedIn Apply Connect's own shape (ATS wave 2 Y, 10.10)
  const ext = txt(a.id || a.applicationId || a.application_id, 120);
  if (!ext) return { error: 'application id missing' };
  const had = (await q('SELECT * FROM "MktBoardApp" WHERE "board" = ? AND "externalId" = ?', board, ext))[0];
  if (had) return { duplicate: true, applicationId: had.applicationId };
  const req = await requirementFor(board, a.jobReference || a.reference || a.jobId || a.job_id);
  if (!req) return { error: `job ${a.jobReference || a.jobId || '?'} is not a TeamLink requirement` };
  const c = a.candidate || a;
  const bridge = require('../jobPortalBridge'); // eslint-disable-line global-require
  const r = await bridge.ingestApplication({
    application: { id: `${board}:${ext}`, jobId: `tl_${req.id}`, source: board },
    candidate: { name: txt(c.name, 100), email: txt(c.email, 120) || null, phone: txt(c.phone || c.mobile, 30) || null, skills: c.skills, location: txt(c.location, 120) || null, currentCompany: txt(c.currentCompany, 120) || null, title: txt(c.designation || c.title, 120) || null, expYears: c.experienceYears != null ? Number(c.experienceYears) : null, noticePeriod: txt(c.noticePeriod, 40) || null, currentCtc: c.currentCtc, expectedCtc: c.expectedCtc },
    requirementId: req.id, attribution: { src: board, utm_source: board },
  });
  if (!r || r.status >= 400) return { error: (r && r.body && r.body.error) || 'not accepted' };
  const appId = r.body.applicationId || (r.body.application && r.body.application.id) || null;
  const candId = r.body.candidateId || (r.body.candidate && r.body.candidate.id) || null;
  if (appId && !r.body.duplicate) await prisma.application.update({ where: { id: appId }, data: { applicationMethod: `${BOARDS[board]} API` } }).catch(() => null);
  const li = cleanLinkedin(c.linkedinUrl || c.profileUrl);
  if (li && candId) await linkCandidate(candId, 'linkedin', li, BOARDS[board]);
  await x('INSERT OR IGNORE INTO "MktBoardApp" ("board","externalId","requirementId","applicationId","candidateId","createdAt") VALUES (?,?,?,?,?,?)', board, ext, req.id, appId, candId, nowIso());
  return { ok: true, applicationId: appId, duplicate: !!r.body.duplicate };
}
async function ingestMany(board, list) {
  const out = { received: 0, added: 0, duplicates: 0, errors: [] };
  for (const a of (Array.isArray(list) ? list : []).slice(0, 200)) {
    out.received += 1;
    // eslint-disable-next-line no-await-in-loop
    const r = await ingestBoardApp(board, a).catch((e) => ({ error: e.message }));
    if (r.error) out.errors.push(String(r.error).slice(0, 120)); else if (r.duplicate) out.duplicates += 1; else out.added += 1;
  }
  return out;
}
async function pullBoard(board, user) {
  if (!BOARDS[board]) return { status: 404, error: 'Unknown job board.' };
  const c = await boardConfig(board);
  if (!c.pullUrl || !c.apiKey) return { status: 409, error: `${BOARDS[board]}: add the applications URL and API key the board gives (partner account - needs founder credentials).`, needsFounder: true };
  const u = new URL(c.pullUrl);
  if (c.lastPullAt) u.searchParams.set('since', c.lastPullAt);
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${c.apiKey}`, Accept: 'application/json' } }).catch((e) => ({ ok: false, status: 0, statusText: e.message }));
  const j = r.ok ? await r.json().catch(() => null) : null;
  const list = j && (Array.isArray(j) ? j : (j.applications || j.data || j.items));
  const at = nowIso();
  const result = list ? await ingestMany(board, list) : { error: `The board answered ${r.status || r.statusText || 'nothing'}` };
  const s = await C.settings();
  const boards = { ...(s.raw.boards || {}) };
  boards[board] = { ...(boards[board] || {}), lastPullAt: list ? at : (boards[board] || {}).lastPullAt, lastResult: { at, ...result } };
  await C.saveSettings({ boards }, user);
  return result.error ? { status: 502, error: result.error } : result;
}
// LinkedIn "Limited Listings" style job-wrapping XML feed (LinkedIn reads it once the company page is approved for it)
async function linkedinFeed(req) {
  const CP = require('../../routes/careersPublic'); // eslint-disable-line global-require
  const { slugOf } = require('../jobSlug'); // eslint-disable-line global-require
  const base = C.publicBase(req);
  const jobs = (await CP.listedJobs()).filter((j) => !j.internal);
  const full = jobs.length ? await prisma.requirement.findMany({ where: { id: { in: jobs.map((j) => j.id) } } }) : [];
  const texts = {};
  for (const j of full) texts[j.id] = await safeText(j); // eslint-disable-line no-await-in-loop
  const cd = (v) => `<![CDATA[${String(v == null ? '' : v).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const s = await C.settings();
  const company = (s.site.brand && s.site.brand.name) || 'TeamLink Consultants';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<source>\n<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n<publisherUrl>${cd(base)}</publisherUrl>\n<publisher>${cd(company)}</publisher>\n${jobs.map((j) => `<job>\n<partnerJobId>${cd(j.id)}</partnerJobId>\n<company>${cd(company)}</company>\n<title>${cd(j.title)}</title>\n<description>${cd(texts[j.id] || j.title)}</description>\n<applyUrl>${cd(`${base}/site/job/${encodeURIComponent(slugOf(j))}?src=LinkedIn`)}</applyUrl>\n<location>${cd(j.location || 'India')}</location>\n<country>${cd('IN')}</country>\n<workplaceTypes>${cd(/remote/i.test(j.workMode || '') ? 'Remote' : (/hybrid/i.test(j.workMode || '') ? 'Hybrid' : 'On-site'))}</workplaceTypes>\n<jobtype>${cd(/contract/i.test(j.employmentType || '') ? 'CONTRACT' : 'FULL_TIME')}</jobtype>\n</job>`).join('\n')}\n</source>\n`;
}

// ================================================================== 10.11 browser extension keys
async function extKeyEnsure() { await x('CREATE TABLE IF NOT EXISTS "MktExtKey" ("userId" TEXT PRIMARY KEY, "keyHash" TEXT NOT NULL UNIQUE, "hint" TEXT, "createdAt" TEXT NOT NULL, "lastUsedAt" TEXT)'); }
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
async function newExtKey(userId) {
  await extKeyEnsure();
  const key = `tlx_${crypto.randomBytes(24).toString('base64url')}`;
  await x('INSERT INTO "MktExtKey" ("userId","keyHash","hint","createdAt") VALUES (?,?,?,?) ON CONFLICT("userId") DO UPDATE SET "keyHash" = excluded."keyHash", "hint" = excluded."hint", "createdAt" = excluded."createdAt", "lastUsedAt" = NULL', userId, hashKey(key), key.slice(-4), nowIso());
  return key;
}
async function extKeyInfo(userId) { await extKeyEnsure(); const r = (await q('SELECT "hint","createdAt","lastUsedAt" FROM "MktExtKey" WHERE "userId" = ?', userId))[0]; return r || null; }
async function dropExtKey(userId) { await extKeyEnsure(); await x('DELETE FROM "MktExtKey" WHERE "userId" = ?', userId); }
async function userOfExtKey(key) {
  if (!/^tlx_[A-Za-z0-9_-]{20,60}$/.test(String(key || ''))) return null;
  await extKeyEnsure();
  const r = (await q('SELECT "userId" FROM "MktExtKey" WHERE "keyHash" = ?', hashKey(key)))[0];
  if (!r) return null;
  await x('UPDATE "MktExtKey" SET "lastUsedAt" = ? WHERE "userId" = ?', nowIso(), r.userId);
  return r.userId;
}
// the profile the person is looking at -> a candidate (de-duplicated by the LinkedIn link, then by email / phone)
async function addFromProfile(user, b) {
  const clean = cleanProfileUrl(b.profileUrl);
  if (!clean) return { status: 400, error: 'Open a candidate profile on LinkedIn, Naukri, Shine or foundit first.' };
  const { site, url } = clean;
  const label = SITES[site].label;
  const name = txt(b.name, 100).replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (!name || name.length < 2) return { status: 400, error: 'The name could not be read from the page.' };
  const known = await candidateByLink(site, url);
  if (known) { const c = await prisma.candidate.findUnique({ where: { id: known }, select: { id: true, name: true } }); if (c) return { status: 200, existing: true, candidate: c }; }
  const email = txt(b.email, 120).toLowerCase() || null; const phone = txt(b.phone, 30) || null;
  if (email || phone) {
    const found = await require('../jobPortalBridge').findCandidateByContact({ email, phone }).catch(() => null); // eslint-disable-line global-require
    if (found) { await linkCandidate(found.id, site, url, C.who(user)); return { status: 200, existing: true, candidate: { id: found.id, name: found.name }, site }; }
  }
  const skills = (Array.isArray(b.skills) ? b.skills : String(b.skills || '').split(',')).map((s) => txt(s, 40)).filter(Boolean).slice(0, 25).join(', ');
  const exp = Number(b.experienceYears);
  const c = await prisma.candidate.create({
    data: {
      name, email, phone, source: label, firstSource: `${label} (browser extension)`, location: txt(b.location, 120) || null, currentCompany: txt(b.currentCompany, 120) || null,
      currentDesignation: txt(b.headline || b.currentDesignation, 160) || null, skills: skills || null, experienceYears: Number.isFinite(exp) && exp >= 0 && exp <= 60 ? exp : null,
      ...(txt(b.currentSalary, 60) ? { currentSalary: txt(b.currentSalary, 60) } : {}),
      ...(txt(b.expectedSalary, 60) ? { expectedSalary: txt(b.expectedSalary, 60) } : {}),
      ...(txt(b.noticePeriod, 60) ? { noticePeriod: txt(b.noticePeriod, 60) } : {}),
      ...(txt(b.education, 200) ? { education: txt(b.education, 200) } : {}),
    },
    select: { id: true, name: true },
  });
  await linkCandidate(c.id, site, url, C.who(user));
  try { require('../candidateListCache').markCandidateDirty(c.id); } catch { /* optional */ } // eslint-disable-line global-require
  return { status: 201, created: true, candidate: c, site };
}

// ================================================================== 10.13 SMS job campaigns
async function audience(user, requirement, f = {}) {
  const { candidateWhere } = require('../scope'); // eslint-disable-line global-require
  const and = [candidateWhere(user), { phone: { not: null } }];
  const sk = String(f.skills || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
  if (sk.length) and.push({ OR: sk.map((s) => ({ skills: { contains: s } })) });
  if (f.location) and.push({ OR: [{ location: { contains: String(f.location).slice(0, 60) } }, { preferredLocation: { contains: String(f.location).slice(0, 60) } }] });
  if (f.minExp !== undefined && f.minExp !== '' && Number.isFinite(Number(f.minExp))) and.push({ experienceYears: { gte: Number(f.minExp) } });
  if (f.maxExp !== undefined && f.maxExp !== '' && Number.isFinite(Number(f.maxExp))) and.push({ experienceYears: { lte: Number(f.maxExp) } });
  and.push({ applications: { none: { requirementId: requirement.id } } });
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 500);
  const rows = await prisma.candidate.findMany({ where: { AND: and }, select: { id: true, name: true, phone: true, profileStatus: true }, take: limit * 2, orderBy: { createdAt: 'desc' } });
  const core = require('../messagingCore'); // eslint-disable-line global-require
  const D = require('../messageDelivery'); // eslint-disable-line global-require
  const out = []; let optedOut = 0; let badNumber = 0;
  for (const r of rows) {
    if (out.length >= limit) break;
    if (/blacklist|do not contact|inactive/i.test(r.profileStatus || '')) continue; // eslint-disable-line no-continue
    const to = core.normalizeMobile(r.phone);
    if (!to.ok) { badNumber += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (await D.optedOut('SMS', to.e164).catch(() => false)) { optedOut += 1; continue; } // eslint-disable-line no-continue
    out.push({ id: r.id, name: r.name, to: to.e164 });
  }
  return { rows: out, optedOut, badNumber };
}
function smsText(requirement, text, req) {
  const { slugOf } = require('../jobSlug'); // eslint-disable-line global-require
  const link = `${C.publicBase(req)}/site/job/${encodeURIComponent(slugOf(requirement))}?src=sms`;
  let t = txt(text, 300) || `New job: ${requirement.title}${requirement.location ? `, ${requirement.location}` : ''}. Apply: {{link}}`;
  t = t.includes('{{link}}') ? t.replace('{{link}}', link) : `${t} ${link}`;
  if (!/reply stop|stop to/i.test(t)) t = `${t} Reply STOP to opt out.`;
  return t.slice(0, 480);
}
async function startCampaign(user, requirement, b, req) {
  if (!(await C.switchOn('smsMarketing'))) return { status: 409, error: C.SWITCH_OFF('smsMarketing') };
  const g = await require('../candidateReach').mayReach(user, { bulkSend: true }); // eslint-disable-line global-require
  if (!g.ok) return { status: g.status, error: g.error };
  const aud = await audience(user, requirement, b);
  if (!aud.rows.length) return { status: 400, error: 'Nobody in the pool matches (or they all said STOP).' };
  const text = smsText(requirement, b.text, req);
  await C.ensure();
  const id = newId();
  await x('INSERT INTO "MktSmsCampaign" ("id","requirementId","text","audience","status","total","createdBy","createdById","createdAt") VALUES (?,?,?,?,\'sending\',?,?,?,?)', id, requirement.id, text, JSON.stringify({ skills: b.skills || '', location: b.location || '', minExp: b.minExp, maxExp: b.maxExp }), aud.rows.length, C.who(user), user.id, nowIso());
  setImmediate(() => runCampaign(id, aud.rows, text, user).catch((e) => console.error('[mkt] sms campaign:', e.message))); // eslint-disable-line no-console
  return { id, total: aud.rows.length, text, optedOut: aud.optedOut };
}
async function runCampaign(id, rows, text, user) {
  const messaging = require('../messaging'); // eslint-disable-line global-require
  let sent = 0; let failed = 0; let skipped = 0; const log = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const res = await messaging.send('SMS', { to: r.to, kind: 'bulk', text, vars: [text], actorUserId: user.id, meta: { audience: 'candidates', personId: r.id, senderUserId: user.id, purpose: 'SMS job campaign', campaignId: id, source: 'ats-sms-campaign', module: 'ATS' } }).catch((e) => ({ outcome: 'Failed', error: e.message }));
    if (res.outcome === 'Sent') sent += 1; else if (res.outcome === 'Failed') failed += 1; else skipped += 1;
    if (log.length < 200) log.push({ candidateId: r.id, outcome: res.outcome, error: res.error ? String(res.error).slice(0, 120) : undefined });
    // the DLR rule / no SMS provider: every send says "Not configured" - stop at once instead of trying all
    if (res.outcome === 'Not configured' && sent === 0 && skipped === 1) { skipped = rows.length - sent - failed; log.push({ note: `Stopped: ${String(res.error || 'SMS is not ready').slice(0, 160)}` }); break; }
  }
  await x('UPDATE "MktSmsCampaign" SET "status" = \'done\', "sent" = ?, "failed" = ?, "skipped" = ?, "log" = ?, "finishedAt" = ? WHERE "id" = ?', sent, failed, skipped, JSON.stringify(log), nowIso(), id);
}
async function campaignsOf(requirementId) {
  await C.ensure();
  return (await q('SELECT * FROM "MktSmsCampaign" WHERE "requirementId" = ? ORDER BY "createdAt" DESC LIMIT 20', requirementId)).map((r) => ({ id: r.id, text: r.text, audience: json(r.audience, {}), status: r.status, total: Number(r.total), sent: Number(r.sent), failed: Number(r.failed), skipped: Number(r.skipped), note: (json(r.log, []).find((l) => l.note) || {}).note || null, createdBy: r.createdBy, createdAt: r.createdAt, finishedAt: r.finishedAt }));
}

module.exports = {
  SITES, siteOf, cleanProfileUrl,
  formOf, checkAnswers, saveAnswers, answersOf, quickFill, cleanLinkedin, linkCandidate, candidateByLink, linksOf,
  LANGS, T, seoJobPage, translated, SECTIONS, cleanSite, publicSite, subscribe, confirmAlert, stopAlert, runAlerts, alertStats, startAlerts, matchesSub,
  BOARDS, boardConfig, boardsView, saveBoard, verifySignature, ingestBoardApp, ingestMany, pullBoard, linkedinFeed,
  newExtKey, extKeyInfo, dropExtKey, userOfExtKey, addFromProfile, audience, smsText, startCampaign, campaignsOf,
};

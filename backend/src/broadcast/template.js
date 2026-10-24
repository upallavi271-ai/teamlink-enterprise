// ---------------------------------------------------------------------------
// THE READY TEMPLATE: when a job (or a job form) is saved as a template, the texts that go out are written at once:
//   jobPost     long text for the boards and the careers page (utils/jobText.js master)
//   whatsapp    short, 6-9 lines, apply link, "Reply YES to apply / STOP to stop"
//   sms         <= 160 letters
//   emailSubject, emailBody
// Built from the job's real fields by the existing writer (utils/jobText.js): the client name is hidden unless the
// job is TeamLink's own, internal notes and agreement lines never get in, nothing is invented (a missing fact
// is left out of the short texts and listed in "missing"). AI only when a model is connected and the person asks
// ("Polish with AI"); the label says which one wrote it.
// Stored per job (AppSetting jobtpl.ready.<requirementId>): every change is a new version.
// Merge fields in the short texts: {{firstName}} {{jobTitle}} {{location}} {{applyLink}}.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const jt = require('../utils/jobText');
const pw = require('../utils/jobPostWriter');
const slug = require('../utils/jobSlug');
const S = require('./store');

const KEYS = ['jobPost', 'whatsapp', 'sms', 'emailSubject', 'emailBody'];
const MAX_VERSIONS = 30;
const AGREEMENT = /\b(agreement|e-?sign\w*|commission|placement fee|service fee|invoice|fee percent|margin|replacement guarantee)\b/i;
const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();

function dropLines(text) {
  return String(text || '').split('\n').filter((l) => !AGREEMENT.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function hideNames(text, names) {
  let out = String(text || '');
  (names || []).forEach((n) => { out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'our client'); });
  return out;
}
const blank = (v) => { const t = clean(v); return !t || t === '[ ]' || t === '-' || t === '—'; };

// Build a Requirement-shaped object from what is on the form (nothing is saved).
async function fromFields(fields) {
  const f = fields || {};
  const client = f.clientId ? await prisma.client.findUnique({ where: { id: String(f.clientId) } }).catch(() => null) : null;
  return {
    id: 'NEW', reqCode: null, title: f.title || '', description: f.description || f.jobDescription || '', jobDescription: f.jobDescription || f.description || '', department: f.department || '',
    skills: f.skills || '', goodToHaveSkills: f.goodToHaveSkills || '', experience: f.experience || '', education: f.education || '', qualifications: f.qualifications || '',
    responsibilities: f.responsibilities || '', employmentType: f.employmentType || '', workMode: f.workMode || '', location: f.location || '', salary: f.salary || '', salaryType: f.salaryType || '',
    openings: Number(f.openings) || 1, priority: f.priority || '', noticePeriodMax: f.noticePeriodMax || '', joiningTimeline: f.joiningTimeline || '', internal: !!f.internal, client, clientId: f.clientId || null, status: f.status || 'DRAFT',
  };
}
async function fromJob(id) { return prisma.requirement.findUnique({ where: { id }, include: { client: true } }); }

const smsLen = (s) => [...String(s)].length;
function buildSms(title, loc, exp, linkSample) {
  const tail = ` Apply: ${linkSample} Reply STOP to opt out`;
  const make = (t, l, e) => `${t}${l ? `, ${l}` : ''}.${e ? ` Exp ${e}.` : ''}${tail}`;
  let t = title; let e = exp;
  let s = make(t, loc, e);
  if (smsLen(s) > 160) { e = ''; s = make(t, loc, e); }
  if (smsLen(s) > 160) { const room = 160 - smsLen(make('', loc, e)) - 1; t = `${t.slice(0, Math.max(8, room)).trim()}…`; s = make(t, loc, e); }
  if (smsLen(s) > 160) { s = make(t, '', ''); }
  return s;
}

function shortTexts(f, applyLinkSample) {
  const title = clean(f.title) || 'Job opening';
  const loc = blank(f.location) ? '' : clean(f.location);
  const exp = blank(f.experience) ? '' : clean(f.experience).replace(/\s*yrs?$/i, ' yrs');
  const sal = blank(f.salary) ? '' : clean(f.salary);
  const skills = (f.skills || []).slice(0, 5).join(', ');
  const who = f.internal ? 'TeamLink Consultants' : 'Hiring through TeamLink Consultants';
  const wa = [
    'Hi {{firstName}} 👋',
    'We have a job opening: *{{jobTitle}}*',
    loc ? `📍 {{location}}${f.workMode ? ` · ${f.workMode}` : ''}` : '',
    exp ? `💼 Experience: ${exp}` : '',
    sal ? `💰 Salary: ${sal}` : '',
    skills ? `🛠 Skills: ${skills}` : '',
    `🏢 ${who}`,
    '👉 Apply here: {{applyLink}}',
    'Reply YES if you are interested, or STOP to stop these messages.',
  ].filter(Boolean).join('\n');
  const sms = buildSms(title, loc ? '{{location}}' : '', exp, '{{applyLink}}');
  // the SMS length is judged with the real values filled in
  const smsReal = buildSms(title, loc, exp, applyLinkSample || 'https://example.com/careers/abc-123');
  const emailSubject = `Job opening: ${title}${loc ? ` in ${loc}` : ''}`;
  const emailBody = [
    'Hi {{firstName}},', '',
    'We have an opening that may suit you.', '',
    `Job: {{jobTitle}}`,
    loc ? 'Location: {{location}}' : '', exp ? `Experience: ${exp}` : '', sal ? `Salary: ${sal}` : '', skills ? `Skills: ${skills}` : '', `${who}.`, '',
    'Apply here: {{applyLink}}', '',
    'If you do not want to get job emails from us, reply STOP and we will remove you.', '', 'TeamLink Consultants',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).filter((l) => l !== undefined).join('\n');
  return { whatsapp: wa, sms, smsReal, emailSubject, emailBody };
}

// -> { texts, label, missing, warnings, applyLink, previews, facts }
async function generate(r, { overrides = {}, base = '' } = {}) {
  const g = await jt.generate(r, overrides, base);
  const f = await jt.buildFacts(r, overrides, base);
  const unsaved = r.id === 'NEW';
  const link = unsaved ? '{{applyLink}}' : `${base || process.env.APP_BASE_URL || ''}${slug.careersPath(r, 'WhatsApp')}`;
  const names = f.clientNames || [];
  let jobPost = dropLines(hideNames(g.master.text, names));
  if (unsaved) jobPost = jobPost.replace(/(https?:\/\/[^\s)]*)?\/careers\/NEW[^\s)]*/g, '{{applyLink}}');
  const st = shortTexts(f, unsaved ? null : link);
  const texts = {
    jobPost, whatsapp: hideNames(dropLines(st.whatsapp), names), sms: hideNames(st.sms, names), emailSubject: hideNames(st.emailSubject, names), emailBody: hideNames(dropLines(st.emailBody), names),
  };
  const sample = { firstName: 'Anita', jobTitle: clean(f.title), location: clean(f.location), applyLink: unsaved ? 'https://your-careers-page/…' : link };
  const boards = {};
  ['naukri', 'indeed', 'shine'].forEach((b) => { boards[b] = { title: g.boards[b].title || clean(f.title), text: unsaved ? g.boards[b].text.replace(/(https?:\/\/[^\s)]*)?\/careers\/NEW[^\s)]*/g, 'https://your-careers-page/…') : g.boards[b].text }; });
  return {
    texts, label: 'Suggested by template', mode: 'template', missing: g.missing || [], warnings: g.warnings || [], applyLink: unsaved ? null : link,
    previews: { naukri: boards.naukri, indeed: boards.indeed, shine: boards.shine, whatsapp: { text: render(texts.whatsapp, sample) } },
    sample, hidesClient: !f.internal, smsChars: smsLen(render(texts.sms, sample)), facts: { title: clean(f.title), location: clean(f.location) },
  };
}

// {{firstName}} {{jobTitle}} {{location}} {{applyLink}} {{name}}
function render(text, v) {
  const val = { name: '', ...v };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    const key = k === 'role' ? 'jobTitle' : k;
    return val[key] == null || val[key] === '' ? (key === 'firstName' || key === 'name' ? 'there' : m) : String(val[key]);
  });
}
const firstNameOf = (name) => { const t = clean(name).split(/\s+/)[0]; return t && !/^\d/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };

// ---- per-job stored versions ----------------------------------------------------
const keyOf = (id) => `jobtpl.ready.${id}`;
async function load(id) { return S.get(keyOf(id), null); }
async function addVersion(id, texts, { label, user, edited = false, note = '' } = {}) {
  return S.update(keyOf(id), null, (cur) => {
    const rec = cur || { versions: [], current: 0, used: 0 };
    const v = (rec.versions.length ? rec.versions[rec.versions.length - 1].v : 0) + 1;
    rec.versions.push({ v, at: new Date().toISOString(), byId: user ? user.id : null, byName: user ? user.name : 'TeamLink', label: label || 'Suggested by template', edited, note, texts });
    if (rec.versions.length > MAX_VERSIONS) rec.versions = rec.versions.slice(-MAX_VERSIONS);
    rec.current = v;
    return rec;
  }, user);
}
function currentOf(rec) { return rec ? rec.versions.find((x) => x.v === rec.current) || rec.versions[rec.versions.length - 1] : null; }
function usedOf(rec) { return rec && rec.used ? rec.versions.find((x) => x.v === rec.used) || null : null; }
function cleanTexts(input, fallback = {}) {
  const out = {};
  KEYS.forEach((k) => { out[k] = typeof input[k] === 'string' ? input[k].replace(/\r/g, '').slice(0, k === 'jobPost' ? 20000 : 4000) : (fallback[k] || ''); });
  return out;
}

// "Use this": the long text goes to the boards through the job-post store (the publishing module reads it), and the
// version is marked as the one WhatsApp / SMS / email use.
async function useVersion(user, r, version) {
  const rec = await load(r.id);
  const ver = rec && rec.versions.find((x) => x.v === Number(version));
  if (!ver) return { error: 'That version was not found.', status: 404 };
  const base = process.env.APP_BASE_URL || '';
  const gen = await jt.generate(r, {}, base);
  const edits = {};
  const generatedMaster = dropLines(hideNames(gen.master.text, []));
  const bare = (t) => clean(t).replace(/https?:\/\/\S+|\/careers\/\S+|\{\{applyLink\}\}/g, '');
  const TAGS = { master: 'Website', naukri: 'Naukri', shine: 'Shine', indeed: 'Indeed', linkedin: 'LinkedIn' };
  const withLink = (tag) => String(ver.texts.jobPost || '').replace(/\{\{applyLink\}\}/g, `${base}${slug.careersPath(r, tag)}`);
  if (clean(ver.texts.jobPost) && bare(ver.texts.jobPost) !== bare(generatedMaster)) {
    Object.keys(TAGS).forEach((k) => { edits[k] = withLink(TAGS[k]); });
  } else if (clean(ver.texts.jobPost)) {
    Object.keys(TAGS).forEach((k) => { edits[k] = null; });
  }
  if (Object.keys(edits).length) await pw.saveTexts(r.id, edits, gen.texts, user);
  await S.update(keyOf(r.id), null, (cur) => { if (!cur) return undefined; cur.used = ver.v; return cur; }, user);
  await require('../utils/audit').logAudit({ userId: user.id, actorName: user.name, action: 'Ready template: version used', entity: 'Requirement', entityId: r.id, toValue: `version ${ver.v}${ver.edited ? ' (edited by a person)' : ''}` });
  return { ok: true, used: ver.v };
}
// the text WhatsApp / SMS / email use for a job: the version in use, else the newest, else a fresh template version
async function ensure(user, r, base = '') {
  let rec = await load(r.id);
  if (!rec) {
    const g = await generate(r, { base });
    rec = await addVersion(r.id, g.texts, { label: g.label, user, note: 'Written when the job was saved' });
  }
  const v = usedOf(rec) || currentOf(rec);
  return { rec, version: v };
}

async function aiPolish(r, base = '') {
  const st = await jt.aiStatus();
  if (!st.available) return { error: st.reason || 'No AI model is connected, so only the template version is available.', status: 409 };
  const d = await jt.aiDraft(r, {}, base, null);
  if (d.error) return d;
  return { master: dropLines(hideNames(d.master.text, [])), label: 'Suggested by AI: please read before posting' };
}

module.exports = { KEYS, generate, fromFields, fromJob, render, firstNameOf, load, addVersion, currentOf, usedOf, cleanTexts, useVersion, ensure, aiPolish, dropLines, hideNames, keyOf, AGREEMENT };

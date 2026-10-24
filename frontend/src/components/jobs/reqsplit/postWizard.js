// ---------------------------------------------------------------------------
// THE POST WIZARD'S SMALL PURE HELPERS (2026-10-15): the five platform cards, the {{placeholder}} filler, and the
// text -> job card reader for the preview. Nothing here talks to a server or a site (tests: postWizard.test.mjs).
// ---------------------------------------------------------------------------

// The six cards of "Create Job - Select Platform" (founder, 2026-10-23: LinkedIn got its own tile, next to Naukri).
//   via 'engine' = /job-broadcast/jobs/:id/post-everywhere (Naukri / Shine browser worker, Indeed = our job feed)
//   via 'own'    = /requirements/:id/posting-sites (our Job Portal and our Website: they confirm themselves)
export const CARDS = [
  { id: 'naukri', name: 'Naukri', via: 'engine', letter: 'N', mode: 'manual', hint: 'We open Naukri and copy the text. You post it there.' },
  { id: 'linkedin', name: 'LinkedIn', via: 'engine', letter: 'in', mode: 'manual', hint: 'We keep the text ready. You post it on LinkedIn.' },
  { id: 'shine', name: 'Shine', via: 'engine', letter: 'S', mode: 'manual', hint: 'We open Shine and copy the text. You post it there.' },
  { id: 'indeed', name: 'Indeed', via: 'engine', letter: 'i', mode: 'auto', hint: 'Goes into our job feed. Indeed picks it up.' },
  { id: 'jobportal', name: 'Job Portal', via: 'own', letter: 'JP', mode: 'auto', hint: 'Our own Job Portal. Live at once.' },
  { id: 'website', name: 'Careers page', via: 'own', letter: 'W', mode: 'auto', hint: 'Our own careers page. Live at once.' },
];
export const CARD_IDS = CARDS.map((c) => c.id);
// Cards that have no tile on screen 1 but open the same screens (none now: LinkedIn has its own tile).
export const EXTRA_CARDS = [];
export const cardOf = (id) => CARDS.find((c) => c.id === id) || EXTRA_CARDS.find((c) => c.id === id) || null;
// the boards that have a "post it by hand" helper on the server (utils/jobBoards/guide.js)
export const HAND_BOARDS = ['naukri', 'shine', 'indeed', 'linkedin'];

// ---- {{placeholders}} ------------------------------------------------------------------------------------------
// The founder's template words. Case and spaces do not matter: {{Job Title}} = {{job title}} = {{jobtitle}}.
export const PLACEHOLDERS = ['Job Title', 'Location', 'Experience', 'Employment Type', 'JD Content', 'Responsibilities', 'Skills'];
const norm = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// the ones the server fills itself when the text is posted (the apply link), or that WhatsApp / SMS fill for each person
const SERVER_KEYS = ['applylink', 'firstname', 'name'];

const str = (v) => String(v == null ? '' : v).trim();
export function experienceOf(job) {
  const j = job || {};
  if (str(j.experience)) return /yr|year/i.test(j.experience) ? str(j.experience) : `${str(j.experience)} yrs`;
  if (j.expMin !== '' && j.expMin != null) return `${j.expMin}-${j.expMax !== '' && j.expMax != null ? j.expMax : j.expMin} yrs`;
  return '';
}
export function jobValues(job) {
  const j = job || {};
  const values = {
    jobtitle: str(j.title),
    location: str(j.location),
    experience: experienceOf(j),
    employmenttype: str(j.employmentType),
    jdcontent: str(j.jobDescription || j.description),
    jobdescription: str(j.jobDescription || j.description),
    responsibilities: str(j.responsibilities),
    skills: str(j.skills),
    goodtohaveskills: str(j.goodToHaveSkills),
    qualifications: str(j.qualifications),
    education: str(j.education),
    workmode: str(j.workMode),
    salary: str(j.salary),
    openings: j.openings ? String(j.openings) : '',
  };
  return values;
}

// Fill the {{...}} words from the saved job. A word the job has no value for stays as it is (so it is seen and fixed).
export function fillTemplate(text, job) {
  const values = jobValues(job);
  return String(text == null ? '' : text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => {
    const v = values[norm(k)];
    return v ? v : m;
  });
}

// The {{words}} still in the text that nobody filled (the apply link is the server's job, so it is not counted).
export function unresolved(text) {
  const out = [];
  String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => { if (!SERVER_KEYS.includes(norm(k)) && !out.includes(k.trim())) out.push(k.trim()); return m; });
  return out;
}

// The founder's mock-up layout (screen 2), with the {{words}} still in it.
export const DEFAULT_TEMPLATE = [
  'Job Title: {{Job Title}}',
  'Location: {{Location}}',
  'Experience: {{Experience}}',
  'Employment Type: {{Employment Type}}', '',
  'Job Description:', '{{JD Content}}', '',
  'Key Responsibilities:', '{{Responsibilities}}', '',
  'Required Skills:', '{{Skills}}', '',
  'Apply here: {{applyLink}}',
].join('\n');

// The same layout filled from the saved job. A part the job has nothing for is left out (never an empty {{word}}).
export function buildLayout(job) {
  const v = jobValues(job);
  const out = [];
  out.push(`Job Title: ${v.jobtitle}`);
  if (v.location) out.push(`Location: ${v.location}`);
  if (v.experience) out.push(`Experience: ${v.experience}`);
  if (v.employmenttype) out.push(`Employment Type: ${v.employmenttype}`);
  const part = (head, body) => { if (body) out.push('', `${head}:`, body); };
  part('Job Description', v.jdcontent);
  part('Key Responsibilities', v.responsibilities);
  part('Required Skills', v.skills);
  out.push('', 'Apply here: {{applyLink}}');
  return out.join('\n');
}

// ---- text -> job card (preview) ------------------------------------------------------------------------------
const HEAD = [
  ['description', /^(about (the )?(job|role|position)|job description|description|role overview|overview|job summary|summary)$/i],
  ['responsibilities', /^((key )?responsibilit(y|ies)|roles? (and|&) responsibilit(y|ies)|what you('| wi)ll do|duties)$/i],
  ['skills', /^((key|required|must have|mandatory) skills?|skills?( required)?|preferred skills?|good to have( skills?)?|requirements?|qualifications?|what we( a)?re looking for)$/i],
  ['company', /^about (the )?(company|us)$/i],
];
const headOf = (line) => {
  const t = line.trim().replace(/[:\-–]+$/, '').trim();
  if (!t || t.length > 40) return null;
  const hit = HEAD.find(([, re]) => re.test(t));
  if (hit) return { kind: hit[0], title: t };
  if (/^[A-Z][A-Z &/]{3,}$/.test(t)) return { kind: 'other', title: t.charAt(0) + t.slice(1).toLowerCase() }; // the engine's "HOW TO APPLY" style
  return null;
};

// -> { title, location, experience, type, description, responsibilities, skills, others: [{ title, body }] }
export function parseJd(text, job = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const facts = {};
  const keep = [];
  lines.forEach((ln) => {
    if (/^\s*apply( here| now)?\s*:/i.test(ln)) return; // the apply link is added by the site
    const m = ln.match(/^\s*(job title|location|experience|employment type|job type|work mode|salary)\s*[:\-–]\s*(.+?)\s*$/i);
    if (m && !facts[m[1].toLowerCase()]) facts[m[1].toLowerCase()] = m[2]; else keep.push(ln);
  });
  const sections = [];
  let cur = { kind: 'intro', title: '', lines: [] };
  keep.forEach((ln) => {
    const h = headOf(ln);
    if (h) { sections.push(cur); cur = { kind: h.kind, title: h.title, lines: [] }; } else cur.lines.push(ln);
  });
  sections.push(cur);
  const body = (s) => s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const join = (kind) => sections.filter((s) => s.kind === kind).map(body).filter(Boolean).join('\n\n');
  let intro = join('intro');
  const title = facts['job title'] || str(job.title) || (intro.split('\n').find((l) => l.trim()) || '').trim();
  if (!facts['job title'] && str(job.title) === '' && intro) intro = intro.split('\n').slice(1).join('\n').trim();
  else if (intro && intro.split('\n')[0].trim().toLowerCase() === title.toLowerCase()) intro = intro.split('\n').slice(1).join('\n').trim();
  const description = join('description') || intro;
  return {
    title,
    location: facts.location || str(job.location),
    experience: facts.experience || experienceOf(job),
    type: facts['employment type'] || facts['job type'] || str(job.employmentType),
    mode: facts['work mode'] || str(job.workMode),
    description,
    responsibilities: join('responsibilities'),
    skills: join('skills'),
    others: sections.filter((s) => ['other', 'company'].includes(s.kind) && body(s)).map((s) => ({ title: s.title, body: body(s) })),
  };
}

// ---- one card's status, from what the server said ---------------------------------------------------------------
// key: posted | hand | queued | feed | needs_help | failed | idle | wait
export const WORDS = {
  posted: ['Posted', 'green'], hand: ['Posted (by hand)', 'green'], queued: ['Waiting to post', 'blue'], feed: ['In our job feed', 'blue'],
  waiting: ['Waiting for you', 'yellow'], needs_help: ['Needs your help', 'yellow'], failed: ['Failed', 'red'], idle: ['Not posted', 'grey'], not_connected: ['Needs your help', 'yellow'], not_available: ['Needs your help', 'yellow'],
};
const lc = (s) => String(s || '').toLowerCase();

// site = the row of GET /requirements/:id/posting-sites; chip = the row of /job-broadcast/jobs/:id/post-status; res = this visit's answer of post-everywhere
export function cardState(id, { site = null, chip = null, res = null, flow = null } = {}) {
  const card = cardOf(id);
  const fl = flowState(id, flow);
  if (fl) return fl;
  if (card && card.via === 'own') {
    if (!site) return { key: 'idle', note: '' };
    const s = lc(site.status);
    const note = site.reason || '';
    if (s === 'posted') return { key: 'posted', note, link: site.link || null };
    if (s === 'posted (by hand)' || s.includes('by hand')) return { key: 'hand', note, link: site.link || null };
    if (s === 'failed') return { key: 'failed', note, retry: true };
    if (['pending', 'queued', 'posting…', 'posting...', 'retrying…', 'retrying...'].includes(s)) return { key: 'queued', note };
    if (['not posted', 'off', 'draft', 'removed', 'removing'].includes(s) || !s) return { key: 'idle', note: s === 'off' ? '' : note };
    return { key: 'needs_help', note };
  }
  if (site && lc(site.status).includes('posted (by hand)')) return { key: 'hand', note: site.reason || '', link: site.link || null };
  if (chip && chip.state && chip.state !== 'idle') {
    const key = ['running', 'queued'].includes(chip.state) ? 'queued' : chip.state;
    return { key, note: chip.error || chip.words || '', link: chip.link || null, queueId: chip.queueId || null, retry: key === 'failed' };
  }
  if (res && res.state) {
    const key = ['running', 'queued'].includes(res.state) ? 'queued' : res.state;
    return { key, note: res.detail && res.detail !== res.words ? `${res.words} ${res.detail}` : res.words || '', retry: key === 'failed' };
  }
  if (site && lc(site.status) === 'submitted to feed') return { key: 'feed', note: site.reason || '' };
  return { key: 'idle', note: '' };
}

// a block of text -> bullet items (one per line; a single comma line is split on the commas)
export function bulletsOf(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (lines.length === 1 && lines[0].includes(',')) return lines[0].split(',').map((x) => x.trim()).filter(Boolean);
  return lines;
}

// ---- the Naukri -> Shine by-hand workflow (rows of GET /api/job-flow/jobs/:id) -----------------------------------------
export const MANUAL = ['naukri', 'shine']; // posted by the recruiter on the site's own recruiter pages, never by TeamLink
const OPEN_ST = ['Naukri Portal Opened', 'Awaiting Naukri Completion', 'Opening Shine', 'Shine Portal Opened', 'Shine Manual Posting Pending', 'Ready to Open Naukri'];
function flowState(id, flow) {
  const row = flow && flow.rows && flow.rows.find((r) => r.platform === id);
  if (!row) return null;
  if (OPEN_ST.includes(row.status)) return { key: 'waiting', note: row.status === 'Ready to Open Naukri' || row.status === 'Opening Shine' ? 'Ready to open. Press Post.' : 'Waiting for you to finish posting on the site.', flowStatus: row.status };
  if (['Failed', 'Action Required'].includes(row.status)) return { key: 'needs_help', note: row.lastError || 'Press Post to continue.', flowStatus: row.status };
  return null; // Naukri Completion Confirmed / Completed by Recruiter: the by-hand record ("Posted (by hand)") speaks for itself
}
// the saved job as copyable fields for the recruiter while filling a site's own form (only fields that have a value)
export function copyFields(job, helper = {}) {
  const j = job || {};
  const has = (v) => String(v == null ? '' : v).trim() !== '';
  const rows = [
    ['Job title', j.title], ['Job description', j.jobDescription || j.description], ['Responsibilities', j.responsibilities], ['Client name to show', 'Our client'],
    ['Department / industry', [j.department, j.specialisation].filter(has).join(' / ')], ['Functional area', j.functionalArea], ['Location', j.location], ['Work mode', j.workMode],
    ['Employment type', j.employmentType], ['Experience', experienceOf(j) || j.experience], ['Skills', j.skills], ['Good to have skills', j.goodToHaveSkills],
    ['Education', j.education], ['Qualifications', j.qualifications], ['Salary range', j.salary], ['Openings', j.openings ? String(j.openings) : ''],
    ['How to apply', helper.applyLink],
  ];
  return rows.filter(([, v]) => has(v)).map(([label, value]) => ({ label, value: String(value) }));
}

// ---- the Postings tab: one honest word per portal --------------------------------------------------------------------
// -> { word: 'Not Posted' | 'Pending' | 'Posted' | 'Posted (by hand)' | 'Failed', tone, action: 'post' | 'continue' | 'retry' | 'view', reason }
export function tableStatus(state) {
  const st = state || { key: 'idle' };
  const k = st.key;
  const note = st.note || '';
  if (k === 'posted') return { word: 'Posted', tone: 'green', action: 'view', reason: note };
  if (k === 'hand') return { word: 'Posted (by hand)', tone: 'green', action: 'view', reason: note || 'You confirmed it. TeamLink cannot see the site.' };
  if (k === 'failed' || ['Failed', 'Action Required'].includes(st.flowStatus)) return { word: 'Failed', tone: 'red', action: 'retry', reason: note || 'It did not go through.' };
  if (['queued', 'waiting', 'feed', 'needs_help', 'not_connected', 'not_available'].includes(k)) return { word: 'Pending', tone: 'yellow', action: 'continue', reason: note || 'Waiting for you to finish.' };
  return { word: 'Not Posted', tone: 'grey', action: 'post', reason: '' };
}
// the JD as a plain text file for "Download JD" (the ready by-hand text when there is one, else the copy fields)
export function jdFileText(rows, helperText) {
  if (helperText && String(helperText).trim()) return String(helperText);
  return (rows || []).map((r) => `${r.label}:\n${r.value}`).join('\n\n');
}

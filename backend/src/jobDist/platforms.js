// ---------------------------------------------------------------------------
// JOB DISTRIBUTION: the platform list (DistPlatform) - every place a job can be posted.
//
//   kind  auto    TeamLink does it (careers page, Google for Jobs, the feeds, Telegram and Facebook through their official APIs)
//         semi    TeamLink prepares the text and the tracked link, a person opens the site and posts it (the default for every
//                 job site: no browser bots unless an Admin switches one on)
//         manual  no website to open (college placement cells, employee referral): a person sends it
//   medium        the utm_medium of the tracked link: job_board | social | careers | search | feed | campus | referral | messaging
//   format        jd (a job description) | short (a short message, for chats and social posts)
//   engine        the key of the job-publish engine portal behind it (the honest chips come from there), or null
//
// The list is edited by an Admin (Integrations > Job portals > Where jobs are posted). Seeded on first use. The post links are
// the sites' own public pages: an Admin can change any of them if a site moves its page.
// ---------------------------------------------------------------------------
const {
  q, q1, ex, ms, iso,
} = require('../jobPublish/db');

const KINDS = ['auto', 'semi', 'manual'];
const MEDIUMS = ['job_board', 'social', 'careers', 'search', 'feed', 'campus', 'referral', 'messaging'];
const FORMATS = ['jd', 'short'];
const NOT_READY = 'Job distribution is not set up in this database yet (the migration 20261014300000_job_distribution has not been applied).';

// key, name, kind, medium, format, postUrl, maxChars, maxTitle, includeSalary, expiryDays, formatHint, engine, sortOrder
const { API_PLACES } = require('../jobPublish/constants');
const { POST_URLS } = require('../config/postUrls'); // where Post opens each site: one list
const DEFAULTS = [
  ['career', 'Own job portal', 'auto', 'careers', 'jd', null, null, null, 1, null, 'Goes live by itself on our careers page. Nothing to copy.', 'career', 10],
  ['google', 'Google for Jobs', 'auto', 'search', 'jd', null, null, null, 1, null, 'Google reads the job page itself (job markup and the site map). Nothing to post.', null, 20],
  ['feed', 'RSS / XML feed', 'auto', 'feed', 'jd', null, null, null, 1, null, 'The requirement is in our feed for job aggregators. Nothing to post.', null, 30],
  ['telegram', 'Telegram channel', 'auto', 'social', 'short', null, 4096, null, 1, null, 'A short message with the apply link. Posted by the Telegram bot (an Admin sets it up once).', 'telegram', 40],
  ['facebook', 'Facebook page', 'auto', 'social', 'short', null, 5000, null, 1, null, 'A short post with the apply link. Posted by the Facebook page connection (an Admin sets it up once).', 'facebook', 50],
  ['instagram', 'Instagram', 'auto', 'social', 'short', null, 2200, null, 1, null, 'A picture of the job with this text under it. Posted by the Instagram account linked to the Facebook Page (an Admin connects it once in Social Media).', 'instagram', 52],
  ['threads', 'Threads', 'auto', 'social', 'short', null, 500, null, 1, null, 'A short text with the apply link. Posted by the Threads connection (an Admin connects it once in Social Media).', 'threads', 54],
  ['linkedinpost', 'LinkedIn post', 'auto', 'social', 'short', null, 3000, null, 1, null, 'A short post on the LinkedIn feed with the apply link (not LinkedIn Jobs). Posted by the LinkedIn connection (an Admin connects it once in Social Media).', 'linkedinpost', 56],
  ['linkedin', 'LinkedIn', 'semi', 'job_board', 'jd', POST_URLS.linkedin, 3000, 100, 1, 30, 'Short and clear. Keep it under about 250 words. LinkedIn does not allow programs to post jobs, so a person posts it.', 'linkedin', 60],
  ['indeed', 'Indeed', 'semi', 'job_board', 'jd', POST_URLS.indeed, 5000, 100, 1, 30, 'Plain text. Paste the title and the description.', null, 70],
  ['naukri', 'Naukri', 'semi', 'job_board', 'jd', POST_URLS.naukri, 4000, 100, 1, 30, 'Plain text with short bullet lines. Naukri checks each job before it shows (up to 24 hours).', 'naukri', 80],
  ['shine', 'Shine', 'semi', 'job_board', 'jd', POST_URLS.shine, 4000, 100, 1, 30, 'Plain text with short bullet lines.', 'shine', 90],
  ['foundit', 'Foundit', 'semi', 'job_board', 'jd', POST_URLS.foundit, 4000, 100, 1, 30, 'Plain text with short bullet lines.', 'foundit', 100],
  ['apna', 'Apna', 'semi', 'job_board', 'jd', 'https://employer.apna.co/', 1500, 80, 1, 30, 'Short and simple words. Apna is read on phones, so keep it brief.', null, 110],
  ['workindia', 'WorkIndia', 'semi', 'job_board', 'jd', 'https://www.workindia.in/employer/', 1200, 80, 1, 30, 'Very short and simple. Say the pay and the place clearly.', null, 120],
  ['freshersworld', 'Freshersworld', 'semi', 'job_board', 'jd', 'https://www.freshersworld.com/employer/', 3000, 100, 1, 30, 'Good for fresher jobs. Say the batch or qualification clearly.', null, 130],
  ['quikr', 'Quikr Jobs', 'semi', 'job_board', 'jd', 'https://www.quikr.com/jobs', 1500, 80, 1, 30, 'Short and simple words.', null, 140],
  ['olx', 'OLX Jobs', 'semi', 'job_board', 'jd', 'https://www.olx.in/', 1500, 80, 1, 30, 'Short and simple words.', null, 150],
  ['ncs', 'NCS portal (National Career Service)', 'semi', 'job_board', 'jd', 'https://www.ncs.gov.in/', 3000, 100, 1, 30, 'The government job portal for employers. Keep to plain facts.', null, 160],
  ['whatsapp', 'WhatsApp group / channel', 'semi', 'messaging', 'short', 'https://web.whatsapp.com/', 1000, null, 1, 14, 'Short. Copy it, open WhatsApp, paste it in the group or channel.', null, 170],
  ['college', 'College placement cells', 'manual', 'campus', 'short', null, 1500, null, 1, 30, 'Send this by e-mail or message to the placement officer.', null, 180],
  ['referral', 'Employee referral', 'manual', 'referral', 'short', null, 800, null, 1, 30, 'Send this to our own team so they can pass it to friends.', null, 190],
];
const ENGINE = Object.fromEntries(DEFAULTS.filter((d) => d[11]).map((d) => [d[0], d[11]]));

const row = (r) => (r ? {
  key: r.key,
  name: r.name,
  kind: r.kind,
  medium: r.medium,
  format: r.format,
  postUrl: r.postUrl || null,
  maxChars: r.maxChars == null ? null : Number(r.maxChars),
  maxTitle: r.maxTitle == null ? null : Number(r.maxTitle),
  formatHint: r.formatHint || '',
  includeSalary: !!r.includeSalary,
  expiryDays: r.expiryDays == null ? null : Number(r.expiryDays),
  active: !!r.active,
  builtin: !!r.builtin,
  sortOrder: Number(r.sortOrder),
  updatedAt: iso(r.updatedAt),
  engine: ENGINE[r.key] || null,
} : null);

let tablesOk = null; let at = 0; let seeded = false;
async function ready() {
  if (tablesOk === true) return true;
  if (tablesOk === false && Date.now() - at < 15000) return false;
  try {
    const r = await q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('DistPlatform','DistPosting')");
    tablesOk = r.length === 2;
  } catch { tablesOk = false; }
  at = Date.now();
  return tablesOk;
}
const forgetReady = () => { tablesOk = null; seeded = false; };

// Insert the defaults that are missing (never overwrites an Admin's edit).
async function ensureSeeded() {
  if (seeded) return;
  if (!(await ready())) return;
  const now = Date.now();
  for (const d of DEFAULTS) {
    // eslint-disable-next-line no-await-in-loop
    await ex(
      'INSERT OR IGNORE INTO "DistPlatform" ("key","name","kind","medium","format","postUrl","maxChars","maxTitle","formatHint","includeSalary","expiryDays","active","builtin","sortOrder","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)',
      d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[10], d[8], d[9], d[12], now, now,
    );
  }
  seeded = true;
}

async function list({ all = false } = {}) {
  if (!(await ready())) return [];
  await ensureSeeded();
  const rows = await q(`SELECT * FROM "DistPlatform" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "sortOrder", "name"`);
  return rows.map(row);
}
async function get(key) {
  if (!(await ready())) return null;
  await ensureSeeded();
  return row(await q1('SELECT * FROM "DistPlatform" WHERE "key" = ?', String(key || '')));
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 24);
// eslint-disable-next-line no-control-regex
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
function cleanUrl(v) {
  const s = text(v, 400);
  if (!s) return { value: null };
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return { error: 'The post link must start with http:// or https://' };
    return { value: u.toString() };
  } catch { return { error: 'The post link is not a valid web address.' }; }
}
const intOrNull = (v, lo, hi) => {
  if (v === '' || v == null) return { value: null };
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? { value: n } : { error: `A number from ${lo} to ${hi} is needed.` };
};

// body: any of name, kind, medium, format, postUrl, maxChars, maxTitle, formatHint, includeSalary, expiryDays, active, sortOrder.
// -> { platform } | { error, status }
async function save(key, body, user, { create = false } = {}) {
  if (!(await ready())) return { error: NOT_READY, status: 503, code: 'NOT_MIGRATED' };
  await ensureSeeded();
  const b = body || {};
  const cur = create ? null : await q1('SELECT * FROM "DistPlatform" WHERE "key" = ?', key);
  if (!create && !cur) return { error: 'This place is not in the list.', status: 404 };
  const next = {};
  let k = key;
  if (create) {
    const name = text(b.name, 60);
    if (!name) return { error: 'Type the name of the place.', status: 400 };
    k = slug(b.key || name);
    if (!k) return { error: 'Type a name with letters or numbers.', status: 400 };
    if (await q1('SELECT 1 x FROM "DistPlatform" WHERE "key" = ?', k)) return { error: 'There is already a place with this name.', status: 409 };
    next.name = name;
  } else if (b.name !== undefined) {
    const name = text(b.name, 60);
    if (!name) return { error: 'The name cannot be empty.', status: 400 };
    next.name = name;
  }
  if (b.kind !== undefined) {
    if (!KINDS.includes(b.kind)) return { error: 'Choose automatic, semi-automatic or by hand.', status: 400 };
    if (cur && [...API_PLACES, 'career', 'google', 'feed'].includes(k) && b.kind !== 'auto') return { error: 'This place is posted by TeamLink itself.', status: 400 };
    next.kind = b.kind;
  }
  if (b.medium !== undefined) { if (!MEDIUMS.includes(b.medium)) return { error: 'Choose a type of place from the list.', status: 400 }; next.medium = b.medium; }
  if (b.format !== undefined) { if (!FORMATS.includes(b.format)) return { error: 'Choose a long job text or a short message.', status: 400 }; next.format = b.format; }
  if (b.postUrl !== undefined) { const u = cleanUrl(b.postUrl); if (u.error) return { error: u.error, status: 400 }; next.postUrl = u.value; }
  if (b.maxChars !== undefined) { const n = intOrNull(b.maxChars, 100, 100000); if (n.error) return { error: `Text limit: ${n.error}`, status: 400 }; next.maxChars = n.value; }
  if (b.maxTitle !== undefined) { const n = intOrNull(b.maxTitle, 20, 500); if (n.error) return { error: `Title limit: ${n.error}`, status: 400 }; next.maxTitle = n.value; }
  if (b.expiryDays !== undefined) { const n = intOrNull(b.expiryDays, 1, 365); if (n.error) return { error: `Days until it expires: ${n.error}`, status: 400 }; next.expiryDays = n.value; }
  if (b.formatHint !== undefined) next.formatHint = text(b.formatHint, 400);
  if (b.includeSalary !== undefined) next.includeSalary = b.includeSalary ? 1 : 0;
  if (b.active !== undefined) next.active = b.active ? 1 : 0;
  if (b.sortOrder !== undefined) { const n = intOrNull(b.sortOrder, 0, 9999); if (n.error) return { error: `Order: ${n.error}`, status: 400 }; next.sortOrder = n.value == null ? 100 : n.value; }
  const now = Date.now();
  if (create) {
    await ex(
      'INSERT INTO "DistPlatform" ("key","name","kind","medium","format","postUrl","maxChars","maxTitle","formatHint","includeSalary","expiryDays","active","builtin","sortOrder","updatedBy","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)',
      k, next.name, next.kind || 'semi', next.medium || 'job_board', next.format || 'jd', next.postUrl || null, next.maxChars == null ? null : next.maxChars, next.maxTitle == null ? null : next.maxTitle,
      next.formatHint || '', next.includeSalary === undefined ? 1 : next.includeSalary, next.expiryDays == null ? 30 : next.expiryDays, next.active === undefined ? 1 : next.active, next.sortOrder == null ? 500 : next.sortOrder, user ? user.id : null, now, now,
    );
  } else {
    const cols = Object.keys(next);
    if (cols.length) await ex(`UPDATE "DistPlatform" SET ${cols.map((c) => `"${c}" = ?`).join(', ')}, "updatedBy" = ?, "updatedAt" = ? WHERE "key" = ?`, ...cols.map((c) => next[c]), user ? user.id : null, now, k);
  }
  return { platform: await get(k) };
}
async function remove(key) {
  if (!(await ready())) return { error: NOT_READY, status: 503 };
  const cur = await q1('SELECT * FROM "DistPlatform" WHERE "key" = ?', key);
  if (!cur) return { error: 'This place is not in the list.', status: 404 };
  if (cur.builtin) return { error: 'The built-in places cannot be deleted. Switch it off instead.', status: 400 };
  const used = await q1('SELECT COUNT(*) n FROM "DistPosting" WHERE "platform" = ?', key);
  if (used && used.n) return { error: 'Requirements were already posted here, so it cannot be deleted. Switch it off instead.', status: 409 };
  await ex('DELETE FROM "DistPlatform" WHERE "key" = ?', key);
  return { ok: true };
}
// Put one built-in place back to its default values.
async function reset(key, user) {
  const d = DEFAULTS.find((x) => x[0] === key);
  if (!d) return { error: 'Only the built-in places can be reset.', status: 400 };
  if (!(await ready())) return { error: NOT_READY, status: 503 };
  await ensureSeeded();
  await ex(
    'UPDATE "DistPlatform" SET "name"=?,"kind"=?,"medium"=?,"format"=?,"postUrl"=?,"maxChars"=?,"maxTitle"=?,"formatHint"=?,"includeSalary"=?,"expiryDays"=?,"active"=1,"sortOrder"=?,"updatedBy"=?,"updatedAt"=? WHERE "key"=?',
    d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[10], d[8], d[9], d[12], user ? user.id : null, Date.now(), key,
  );
  return { platform: await get(key) };
}

module.exports = {
  DEFAULTS, KINDS, MEDIUMS, FORMATS, NOT_READY, ENGINE, ready, forgetReady, ensureSeeded, list, get, save, remove, reset, ms,
};

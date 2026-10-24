// ---------------------------------------------------------------------------
// WHERE DID THEY COME FROM — the ONE clean list the screens offer and show.
//
// This is a word-for-word copy of backend/src/utils/candidateSource.js SOURCES
// (a test, scripts/candidate-source-test.js in the scratchpad, keeps the two
// equal). The server maps every stored word onto this list when it serves a
// row (row.sourceKey), so a list, a filter and an export are clean even though
// the database still holds the old free text; row.sourceRaw is that stored word.
// ---------------------------------------------------------------------------
export const IMPORTED_SOURCE = 'Imported sheet (unknown origin)';
export const OTHER_SOURCE = 'Other';

export const SOURCES = [
  'Job Portal', 'Website', 'Naukri', 'Shine', 'Indeed', 'LinkedIn', 'Referral', 'Campus', 'Walk-in',
  'Agency / partner', 'Social media', "Recruiter's own search", IMPORTED_SOURCE, OTHER_SOURCE,
];
// What a person can CHOOSE when adding someone (the "unknown origin" bucket is only what old imports left).
export const PICK_SOURCES = SOURCES.filter((s) => s !== IMPORTED_SOURCE);

// "Recorded as: …" — shown on hover when the clean word is not the word that is stored.
export function recordedAs(row) {
  const raw = row && row.sourceRaw;
  if (!raw || raw === row.sourceKey) return undefined;
  return `Recorded as: ${raw}`;
}

// The clean source of a row from the server (falls back to the stored word for an old response).
export const sourceOf = (row) => (row && (row.sourceKey || row.source)) || '';

// ---------------------------------------------------------------------------
// "Not recorded" and "Came on" (user, 2026-10-13: clear source + date everywhere)
// ---------------------------------------------------------------------------
export const NOT_RECORDED = 'Not recorded';
// The word a screen shows for a source: the internal "unknown origin" bucket reads "Not recorded".
export const sourceLabel = (k) => (!k || k === IMPORTED_SOURCE ? NOT_RECORDED : k);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
// '2026-10-12' -> '12 Oct' (the year is added when it is not this year: '12 Oct 2025').
export function shortDay(day, today = istToday()) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MON[m - 1]}${String(y) === today.slice(0, 4) ? '' : ` ${y}`}`;
}
export const longDay = (day) => { if (!day) return ''; const [y, m, d] = day.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}`; };
// 'Today' · 'Yesterday' · '3 days ago' · '2 weeks ago' · '5 months ago' · '2 years ago'
export function agoText(day, today = istToday()) {
  if (!day) return '';
  const n = Math.round((dayMs(today) - dayMs(day)) / 86400000);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.floor(n / 7)} weeks ago`;
  if (n < 730) return `${Math.floor(n / 30.4)} months ago`;
  return `${Math.floor(n / 365)} years ago`;
}
// What the "Came on" date means, in plain words (hover text).
export const CAME_KIND_TEXT = {
  sheet: 'The date written in the old sheet.',
  imported: 'The day this profile was loaded into TeamLink with a big import. It is not the day the person really arrived.',
  applied: 'The day the person applied on the job portal.',
  entered: 'The day this profile was added to TeamLink.',
};
// One short cell: { text: 'Naukri · 12 Oct (1 day ago)', title, imported }.
export function sourceCame(row, today = istToday()) {
  const src = sourceLabel(row && (row.sourceKey || row.source));
  const day = row && row.cameOnDay;
  const kind = row && row.cameOnKind;
  if (!day) return { text: src, title: recordedAs(row), imported: false, src, when: '' };
  const when = kind === 'imported' ? `Imported ${shortDay(day, today)}` : `${shortDay(day, today)} (${agoText(day, today).toLowerCase() === 'today' ? 'today' : agoText(day, today)})`;
  const title = [recordedAs(row), `${kind === 'imported' ? 'Imported on' : 'Came on'} ${longDay(day)}. ${CAME_KIND_TEXT[kind] || ''}`].filter(Boolean).join('\n');
  return { text: `${src} · ${when}`, title, imported: kind === 'imported', src, when };
}

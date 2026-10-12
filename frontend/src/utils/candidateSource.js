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

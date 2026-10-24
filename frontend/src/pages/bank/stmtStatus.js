// Statements Matching: the status strip, labels and button rules for an uploaded bank statement.
// Pure functions (no React, no network) so the numbers on screen can be tested on their own.
//
// The counts come from the SERVER (backend/src/utils/bankStatementDedupe.js countsOf); nothing here decides whether a
// transaction is a duplicate. This file only says how the server's numbers are labelled and which buttons may be pressed.

// The four statuses of an uploaded transaction, exactly as the founder named them.
export const STATUS = {
  alreadyImported: 'Already Imported',
  notImported: 'Not Imported',
  duplicateInUpload: 'Duplicate in Current Upload',
  needsReview: 'Needs Review',
};

// What a row can show once an import has run.
export const RESULT = { imported: 'Imported', failed: 'Failed', leftOut: 'Left out' };

// One line of plain words under each card.
const HELP = {
  total: 'Every transaction in the file',
  alreadyImported: 'Already in the system, so skipped',
  notImported: 'New, waiting to be imported',
  duplicateInUpload: 'The same transaction twice in this file',
  needsReview: 'Not sure, you decide',
  newlyImported: 'Saved by this upload',
  failed: 'Could not be saved, see why below',
};

// Filter name used by the list (the server understands these names).
const FILTER = {
  total: '',
  alreadyImported: STATUS.alreadyImported,
  notImported: STATUS.notImported,
  duplicateInUpload: STATUS.duplicateInUpload,
  needsReview: STATUS.needsReview,
  newlyImported: RESULT.imported,
  failed: RESULT.failed,
};

const TONE = {
  total: 'blue',
  alreadyImported: 'grey',
  notImported: 'green',
  duplicateInUpload: 'amber',
  needsReview: 'amber',
  newlyImported: 'green',
  failed: 'red',
};

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The seven cards of the strip. `counts` is the server's answer; a missing number is 0.
export function statusCards(counts) {
  const c = counts || {};
  const cards = [
    ['total', 'Total Statements', n(c.total)],
    ['alreadyImported', STATUS.alreadyImported, n(c.alreadyImported)],
    ['notImported', STATUS.notImported, n(c.notImported)],
    ['duplicateInUpload', STATUS.duplicateInUpload, n(c.duplicateInUpload)],
    ['needsReview', STATUS.needsReview, n(c.needsReview)],
    ['newlyImported', 'Newly Imported', n(c.newlyImported)],
    ['failed', 'Failed', n(c.failed)],
  ];
  return cards.map(([key, label, value]) => ({
    key, label, value, help: HELP[key], filter: FILTER[key], tone: value === 0 && key !== 'total' && key !== 'alreadyImported' && key !== 'notImported' && key !== 'newlyImported' ? 'quiet' : TONE[key],
  }));
}

// A row's status as people read it: the result of an import wins over the check made before it.
export function displayStatus(row) {
  if (!row) return '';
  if (row.result === 'Imported') return RESULT.imported;
  if (row.result === 'Failed') return RESULT.failed;
  if (row.result === 'Skipped') return RESULT.leftOut;
  if (row.status === STATUS.notImported && row.decision === 'skip') return RESULT.leftOut;
  return row.status;
}

export function rowTone(display) {
  switch (display) {
    case STATUS.alreadyImported: return 'grey';
    case STATUS.notImported: return 'green';
    case STATUS.duplicateInUpload: return 'amber';
    case STATUS.needsReview: return 'amber';
    case RESULT.imported: return 'green';
    case RESULT.failed: return 'red';
    case RESULT.leftOut: return 'grey';
    default: return 'grey';
  }
}

// Which rows may the person choose for: only the ones the server could not (or would not) decide alone.
export function canChoose(row) {
  return !!row && !row.result && (row.status === STATUS.needsReview || row.status === STATUS.duplicateInUpload);
}

// The big button. It imports the Not Imported rows and the rows the person chose, never an Already Imported one.
export function importPlan(counts) {
  const c = counts || {};
  const fresh = n(c.notImported);
  const chosen = n(c.chosenImport);
  const total = fresh + chosen;
  let label = 'Import New Transactions';
  if (total > 0) label += ` (${total})`;
  let note = '';
  if (total === 0) {
    if (n(c.total) > 0 && n(c.alreadyImported) === n(c.total)) note = 'Everything in this file is already imported. Nothing to import.';
    else if (n(c.needsReview) + n(c.duplicateInUpload) > 0) note = 'Nothing is new. Choose from the list below if you want any of the other rows imported.';
    else note = 'Nothing new to import.';
  } else if (chosen > 0) {
    note = `${fresh} new and ${chosen} you chose will be imported. Already imported rows are skipped.`;
  } else {
    note = `${fresh} new transaction${fresh === 1 ? '' : 's'} will be imported. Already imported rows are skipped.`;
  }
  return { count: total, fresh, chosen, label, note, canImport: total > 0 };
}

// "Retry failed": only rows that failed while saving (a row that could not be read cannot be retried).
export function retryPlan(counts) {
  const c = counts || {};
  const count = n(c.retryable);
  return { count, canRetry: count > 0, label: count > 0 ? `Retry failed (${count})` : 'Retry failed' };
}

// The final summary after an import, in the order the founder asked for.
export function summaryItems(counts) {
  const c = counts || {};
  return [
    { key: 'uploaded', label: 'Total uploaded', value: n(c.total) },
    { key: 'already', label: 'Already imported', value: n(c.alreadyImported) },
    { key: 'eligible', label: 'New (eligible)', value: n(c.eligible) },
    { key: 'imported', label: 'Successfully imported', value: n(c.newlyImported) },
    { key: 'failed', label: 'Failed', value: n(c.failed) },
    { key: 'review', label: 'Needs manual review', value: n(c.needsReview) + n(c.duplicateInUpload) },
  ];
}

// Do the buckets add up to the total? (A safety net for the screen: if the server ever sent numbers that do not add up, say so.)
export function countsAddUp(counts) {
  const c = counts || {};
  const parts = n(c.alreadyImported) + n(c.notImported) + n(c.duplicateInUpload) + n(c.needsReview) + n(c.newlyImported) + n(c.failed) + n(c.leftOut);
  return parts === n(c.total);
}

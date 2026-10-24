// Plain words for stored status values that must never read "Draft" on screen (founder, 2026-10-16).
// The stored value never changes (it is a database code); only what people read does.
export const creditNoteStatus = (s) => (s === 'Draft' ? 'Not issued' : s);
export const payoutStatus = (s) => (s === 'Draft' ? 'Waiting for approval' : s);

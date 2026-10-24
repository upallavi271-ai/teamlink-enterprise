// ---------------------------------------------------------------------------
// WhatsApp sender helpers (pure functions - no React, no network). Used by every window that sends a WhatsApp message and by the Admin list.
// The SERVER decides everything (utils/waNumbers.js resolveSender); this file only decides what the screen shows:
//   * which line to show above the Send button (nothing / one number / a type-to-search list / a clear "no number" message)
//   * whether the Send button is switched off
//   * how a connection status is worded and coloured
// ---------------------------------------------------------------------------

// connection status -> colour (the five colours of the app: green good, yellow waiting, red problem, grey off, blue test)
export const STATUS_TONE = {
  connected: 'green', verification_required: 'yellow', disconnected: 'red', switched_off: 'grey', test_mode: 'blue', unchecked: 'grey',
};
export const STATUS_WORDS = {
  connected: 'Connected', verification_required: 'Verification Required', disconnected: 'Disconnected', switched_off: 'Switched off', test_mode: 'Test mode', unchecked: 'Not checked yet',
};
export const chipTone = (code) => STATUS_TONE[code] || 'grey';
export const chipWords = (code) => STATUS_WORDS[code] || STATUS_WORDS.unchecked;

// "+919000010001" -> "+91 90000 10001"; anything else is shown as typed
export function fmtNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return `+${d}`;
}

export const NO_NUMBER_MESSAGE = 'No WhatsApp number is assigned to you yet. Ask the Admin (Integrations > WhatsApp > Assign).';

// info = GET /wa-numbers/my-numbers  { legacy, numbers: [{ id, label, displayNumber, usable, reason, isDefault }], defaultId, canSend, message }
// chosenId = what the person picked in the list (or '' / undefined)
// -> { mode, show, canSend, message, selected, usable }
//    mode: loading | legacy | none | down | one | many
export function senderState(info, chosenId) {
  if (!info) return { mode: 'loading', show: false, canSend: true, message: '', selected: null, usable: [] };
  if (info.legacy) return { mode: 'legacy', show: false, canSend: true, message: '', selected: null, usable: [] };
  const numbers = Array.isArray(info.numbers) ? info.numbers : [];
  if (!numbers.length) return { mode: 'none', show: true, canSend: false, message: info.message || NO_NUMBER_MESSAGE, selected: null, usable: [] };
  const usable = numbers.filter((n) => n.usable);
  if (!usable.length) {
    return { mode: 'down', show: true, canSend: false, message: info.message || 'The WhatsApp numbers assigned to you are switched off or not connected. Ask the Admin.', selected: null, usable: [] };
  }
  if (usable.length === 1) return { mode: 'one', show: true, canSend: true, message: '', selected: usable[0].id, usable };
  const pick = usable.find((n) => n.id === chosenId) || usable.find((n) => n.id === info.defaultId) || usable[0];
  return { mode: 'many', show: true, canSend: true, message: '', selected: pick.id, usable };
}

// What goes to the server as waNumberId: only a number the person really CHOSE from their own list. Untouched = nothing,
// so the server keeps an existing chat on its number and applies the department rules.
export function numberToSend(state, chosenId) {
  if (!state || state.mode !== 'many') return undefined;
  return state.usable.some((n) => n.id === chosenId) ? chosenId : undefined;
}

// the line "Sending from: Label (+91 ...)". `planned` = the server's answer ({ label, displayNumber }) when it has one.
export function senderLine(state, planned) {
  if (!state || !state.show) return '';
  if (!state.canSend) return state.message;
  const n = planned && planned.label ? planned : (state.usable || []).find((x) => x.id === state.selected);
  return n ? `Sending from: ${n.label} (${fmtNumber(n.displayNumber)})` : '';
}

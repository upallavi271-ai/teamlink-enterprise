// ---------------------------------------------------------------------------
// AI MARKETING: WHICH WHATSAPP NUMBER A MESSAGE TO A CLIENT LEAVES FROM (founder 2026-11-16: "the first message went from +91 92475 58566, the next one from +91 91540 18777: it must always
// go from the company number, and I want an option to pick another number").
// Before, a message sent by a PERSON's click was routed by utils/waNumbers.js resolveSender as "a person": the number given to that person by name, so the same client got messages from
// two numbers, while the automatic notices used the default. Now every AI Marketing message to a client names its number:
//   * not chosen  -> the DEFAULT company number (Administration > Integrations > WhatsApp numbers: the one marked Default), for everybody, automatic or by a click;
//   * chosen      -> that number, if the person may use it (the numbers they hold, an Admin all of them) or it is the default; a number that is off or not found is refused in words.
// The send is then marked automatic so resolveSender does not swap the number for "the person's own". Only numbers connected in TeamLink can send: a number cannot be typed in.
// With no WhatsApp numbers list at all (the old single connection) nothing changes.
// ---------------------------------------------------------------------------
const WN = require('../utils/waNumbers');

// the numbers a login can choose from for a client message: the default company number first, then the others it may use (switched-off ones are left out)
async function numbersFor(u) {
  if (!(await WN.hasNumbers().catch(() => false))) return { numbers: [], defaultId: null, legacy: true };
  const d = await WN.defaultRow().catch(() => null);
  const mine = u ? await WN.authorisedRows(u).catch(() => []) : [];
  const map = new Map();
  [d, ...mine].filter((r) => r && r.active).forEach((r) => map.set(r.id, r));
  const numbers = [...map.values()].map((r) => ({ id: r.id, label: r.label, number: r.displayNumber, isDefault: !!(d && r.id === d.id) }))
    .sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || String(a.label).localeCompare(String(b.label)));
  return { numbers, defaultId: d && d.active ? d.id : null };
}

// -> { numberId } (or { legacy: true } / { numberId: null }: route as before) | { error, status }
// opts.trusted: the number was already allowed when a person chose it (the 24-hour reminder repeats it), so only "found" and "switched on" are checked
async function pick(u, wanted, { trusted = false } = {}) {
  if (!(await WN.hasNumbers().catch(() => false))) return { legacy: true, numberId: null };
  const d = await WN.defaultRow().catch(() => null);
  const id = String(wanted || '').trim() || (d && d.id) || '';
  if (!id) return { numberId: null };
  const row = await WN.getRow(id).catch(() => null);
  if (!row) return { error: 'That WhatsApp number was not found. Pick one from the list.', status: 400 };
  const allowed = trusted || !!(d && row.id === d.id) || !!(u && await WN.mayUse(u, row.id).catch(() => false));
  if (!allowed) return { error: 'You are not allowed to send from that number. Pick another one.', status: 403 };
  if (!row.active) return { error: `The WhatsApp number "${row.label}" is switched off. Pick another one.`, status: 409 };
  return { numberId: row.id };
}

// what goes on the send: the number, and "automatic" so the router keeps it
const opts = (p) => (p && p.numberId ? { numberId: p.numberId, automatic: true } : {});
// "from Team Link Consultants +91 92475 58566" out of a send result (empty with the old single connection)
const fromWords = (res) => (res && res.numberLabel ? ` from ${res.numberLabel}${res.fromNumber ? ` ${res.fromNumber}` : ''}` : '');

module.exports = { numbersFor, pick, opts, fromWords };

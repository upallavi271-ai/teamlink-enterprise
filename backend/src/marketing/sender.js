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

// THE DIGITAL MARKETING NUMBER (2026-11-24, founder: "where it says digital marketing, the digital marketing number must show"): AI Marketing is the digital marketing service, so its messages to a client
// leave from the company's "Digital Marketing" WhatsApp number (the active number whose name has "digital marketing", a connected one first), not from the general company default. With no such number
// the default company number is used exactly as before. Everybody who may use AI Marketing may send from it.
const isMarketingNumber = (r) => /digital\s*marketing/i.test(String((r && r.label) || ''));
async function marketingRow() {
  const rows = (await WN.listRows().catch(() => [])).filter((r) => r && r.active && isMarketingNumber(r));
  return rows.find((r) => r.statusCode === 'connected') || rows[0] || null;
}
// the number used when none is picked: the Digital Marketing number, else the company default
async function primaryRow() { return (await marketingRow()) || (await WN.defaultRow().catch(() => null)); }

// the numbers a login can choose from for a client message: the Digital Marketing number first (the default here), then the company default and the others it may use (switched-off ones are left out)
async function numbersFor(u) {
  if (!(await WN.hasNumbers().catch(() => false))) return { numbers: [], defaultId: null, legacy: true };
  const d = await primaryRow();
  const co = await WN.defaultRow().catch(() => null);
  const mine = u ? await WN.authorisedRows(u).catch(() => []) : [];
  const map = new Map();
  [d, co, ...mine].filter((r) => r && r.active).forEach((r) => map.set(r.id, r));
  const numbers = [...map.values()].map((r) => ({ id: r.id, label: r.label, number: r.displayNumber, isDefault: !!(d && r.id === d.id) }))
    .sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || String(a.label).localeCompare(String(b.label)));
  return { numbers, defaultId: d && d.active ? d.id : null };
}

// -> { numberId } (or { legacy: true } / { numberId: null }: route as before) | { error, status }
// opts.trusted: the number was already allowed when a person chose it (the 24-hour reminder repeats it), so only "found" and "switched on" are checked
async function pick(u, wanted, { trusted = false } = {}) {
  if (!(await WN.hasNumbers().catch(() => false))) return { legacy: true, numberId: null };
  const d = await primaryRow();
  const co = await WN.defaultRow().catch(() => null);
  const id = String(wanted || '').trim() || (d && d.id) || '';
  if (!id) return { numberId: null };
  const row = await WN.getRow(id).catch(() => null);
  if (!row) return { error: 'That WhatsApp number was not found. Pick one from the list.', status: 400 };
  const allowed = trusted || !!(d && row.id === d.id) || !!(co && row.id === co.id) || !!(u && await WN.mayUse(u, row.id).catch(() => false));
  if (!allowed) return { error: 'You are not allowed to send from that number. Pick another one.', status: 403 };
  if (!row.active) return { error: `The WhatsApp number "${row.label}" is switched off. Pick another one.`, status: 409 };
  return { numberId: row.id };
}

// what goes on the send: the number, and "automatic" so the router keeps it
const opts = (p) => (p && p.numberId ? { numberId: p.numberId, automatic: true } : {});
// "from Team Link Consultants +91 92475 58566" out of a send result (empty with the old single connection)
const fromWords = (res) => (res && res.numberLabel ? ` from ${res.numberLabel}${res.fromNumber ? ` ${res.fromNumber}` : ''}` : '');

// 2026-11-23 (owner: "when I send my AI image or video to the client in WhatsApp it is not going"): a message went out from a number whose own WhatsApp account has not got the template
// (Meta error 132001, "has not been sent to Meta for the WhatsApp account of ..."): the client got nothing. Now the SAME message is sent once more from another connected number whose account
// has that template Approved (the default company number first), and the answer says which number it left from. Nothing changes when the first number can send.
async function alternative(res, tried) {
  try {
    const name = res && res.templateName;
    if (!name) return null;
    const list = (await require('../outreach/tplWaba').approvedNumbers(name)).filter((n) => n.id !== tried); // eslint-disable-line global-require
    if (!list.length) return null;
    const d = await WN.defaultRow().catch(() => null);
    return (d && list.find((n) => n.id === d.id)) || list[0];
  } catch { return null; }
}
// the one way AI Marketing sends WhatsApp to a client: params as for messaging.send (with `...Sender.opts(pk)` in them)
async function send(params) {
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const res = await messaging.send('WhatsApp', params);
  if (res && res.code === 'TEMPLATE_OTHER_ACCOUNT' && params && params.numberId) {
    const alt = await alternative(res, params.numberId);
    if (alt) {
      const again = await messaging.send('WhatsApp', { ...params, numberId: alt.id, automatic: true });
      if (again && again.ok) return { ...again, fellBackTo: alt.label };
      return again || res;
    }
  }
  return res;
}

module.exports = { numbersFor, pick, opts, fromWords, send, alternative, marketingRow, isMarketingNumber };

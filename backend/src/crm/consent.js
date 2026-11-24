// ---------------------------------------------------------------------------
// CRM WAVE D - DPDP ACT 2023: NOTICE, CONSENT AND THE PERSON'S RIGHTS FOR CRM LEADS AND CONTACTS (2026-11-24)
//   notice          the privacy notice (what we keep, why, how long, whom to complain to) the Admin writes once; a public page shows it
//                   (/api/crm-public/privacy-notice) so a link to it can go in a form, a mail or a WhatsApp message
//   consent record  per lead / contact and purpose: Given or Withdrawn, how (website form, call, email, WhatsApp, in person), which notice
//                   version, who wrote it and when. The website form records it by itself when it sends consent=1.
//   withdrawal      Withdrawn puts the person's email and phone on the CRM opt-out list, so campaigns skip them from then on
//   access / erase  the person's data as a file (their right to know), and erasing their personal details (a Sales manager; the record
//                   stays as "Erased" so the numbers do not change)
// ---------------------------------------------------------------------------
const S = require('./service');
const P = require('./plusSchema');

const DEFAULT_NOTICE = 'TeamLink keeps your name, company, phone and email to talk to you about our services. We use them only for that, keep them while we are in touch and for up to two years after, and never sell them. You may ask us to show, correct or erase your details, or withdraw your consent, at any time. For a complaint, write to our Grievance Officer below.';
const PURPOSES = ['Sales calls and emails about our services', 'WhatsApp messages', 'Newsletters and campaigns'];
const CHANNELS = ['Website form', 'Phone call', 'Email', 'WhatsApp', 'In person', 'Other'];
async function settings() {
  const v = await P.getCfg('privacy', {});
  const purposes = (Array.isArray(v.purposes) ? v.purposes : []).map((x) => String(x || '').trim().slice(0, 120)).filter(Boolean).slice(0, 10);
  return { noticeText: String(v.noticeText || DEFAULT_NOTICE).slice(0, 4000), noticeVersion: String(v.noticeVersion || '1').slice(0, 20), purposes: purposes.length ? purposes : PURPOSES, grievanceName: String(v.grievanceName || '').slice(0, 120), grievanceEmail: String(v.grievanceEmail || '').slice(0, 120), grievancePhone: String(v.grievancePhone || '').slice(0, 30), channels: CHANNELS };
}
async function saveSettings(user, body = {}) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Only a Sales manager or an Admin can change the privacy notice.');
  const cur = await settings();
  const email = String(body.grievanceEmail || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return S.fail(400, 'The Grievance Officer\'s email does not look right.');
  const text = String(body.noticeText || '').trim().slice(0, 4000) || DEFAULT_NOTICE;
  // a changed notice is a new version (consents given before keep the version they were given on)
  const version = text !== cur.noticeText ? String((Number(cur.noticeVersion) || 1) + 1) : cur.noticeVersion;
  const next = { noticeText: text, noticeVersion: version, purposes: (Array.isArray(body.purposes) ? body.purposes : String(body.purposes || '').split('\n')).map((x) => String(x || '').trim().slice(0, 120)).filter(Boolean).slice(0, 10), grievanceName: String(body.grievanceName || '').trim().slice(0, 120), grievanceEmail: email, grievancePhone: String(body.grievancePhone || '').trim().slice(0, 30) };
  await P.setCfg('privacy', next);
  await S.audit(user, 'CRM privacy notice changed', 'CrmSettings', 'privacy', `version ${version}`);
  return S.okBody({ ok: true, ...(await settings()) });
}
async function recordFor(user, kind, id, { edit } = {}) {
  if (!['lead', 'contact'].includes(kind)) return { err: S.fail(404, 'Consent is kept for a lead or a contact.') };
  const r = S.roleOf(user);
  const row = await S.getRow(kind, id);
  if (!S.canSeeRow(user, r, row)) return { err: S.fail(404, 'This record is not there, or it is not yours.') };
  if (edit && !S.canEditRow(user, r, row)) return { err: S.fail(403, 'You can read this record but not change it.') };
  return { row, r };
}
function current(rows, purposes) {
  return purposes.map((p) => { const last = rows.filter((x) => x.purpose === p).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0]; return { purpose: p, status: last ? last.status : 'Not asked', at: last ? last.at : null, channel: last ? last.channel : null, noticeVersion: last ? last.noticeVersion : null }; });
}
async function list(user, kind, id) {
  const x = await recordFor(user, kind, id);
  if (x.err) return x.err;
  await P.ensure();
  const st = await settings();
  const rows = await P.all('SELECT * FROM "CrmConsent" WHERE "kind" = ? AND "recordId" = ? ORDER BY "at" DESC', kind, x.row.id);
  return S.okBody({ records: rows, current: current(rows, st.purposes), notice: st, canEdit: S.canEditRow(user, x.r, x.row), canErase: S.mayAssign(x.r), erased: /^Erased/.test(String(x.row.contactName || x.row.name || '')) });
}
async function writeRow(kind, recordId, { purpose, status, channel, source, note, ip, byId, byName, noticeVersion }) {
  await P.ensure();
  const at = new Date().toISOString();
  await P.run('INSERT INTO "CrmConsent" ("id", "kind", "recordId", "purpose", "status", "channel", "source", "noticeVersion", "note", "ip", "byId", "byName", "at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('cns'), kind, recordId, purpose, status, channel || null, source || null, noticeVersion || null, note || null, ip || null, byId || null, byName || null, at);
  return at;
}
async function optOutRecord(row) {
  const CMP = require('./campaigns'); // eslint-disable-line global-require
  if (row.email) await CMP.optOut('email', row.email, { reason: 'DPDP consent withdrawn' }).catch(() => false);
  if (row.phone) await CMP.optOut('whatsapp', row.phone, { reason: 'DPDP consent withdrawn' }).catch(() => false);
}
async function record(user, kind, id, body = {}) {
  const x = await recordFor(user, kind, id, { edit: true });
  if (x.err) return x.err;
  const st = await settings();
  const purposes = body.purpose === 'all' ? st.purposes : [body.purpose];
  if (purposes.some((p) => !st.purposes.includes(p))) return S.fail(400, 'Pick the purpose from the list.');
  if (!['Given', 'Withdrawn'].includes(body.status)) return S.fail(400, 'Given or withdrawn?');
  const channel = CHANNELS.includes(body.channel) ? body.channel : 'Other';
  for (const p of purposes) await writeRow(kind, x.row.id, { purpose: p, status: body.status, channel, source: 'Recorded by the team', note: S.clip(body.note, 300), byId: user.id, byName: user.name || null, noticeVersion: st.noticeVersion }); // eslint-disable-line no-await-in-loop
  if (body.status === 'Withdrawn') await optOutRecord(x.row);
  const now = new Date().toISOString();
  const link = kind === 'lead' ? { leadId: x.row.id } : { accountId: x.row.accountId, contactId: x.row.id };
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Consent ${body.status.toLowerCase()} (${purposes.join(', ')}) - ${channel}`, note: S.clip(body.note, 300), at: now, ...link, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, `CRM consent ${body.status.toLowerCase()}`, kind === 'lead' ? 'CrmLead' : 'CrmContact', x.row.id, `${purposes.join(', ')} via ${channel}`);
  return list(user, kind, id);
}
// the website form sent consent=1: every purpose is Given, from the form, with the address it came from
async function fromWebsite(out, body, ip) {
  if (!out || !out.id || !body || !['1', 'true', 'yes', 'on', true, 1].includes(body.consent)) return;
  const st = await settings();
  for (const p of st.purposes) await writeRow('lead', out.id, { purpose: p, status: 'Given', channel: 'Website form', source: String(body.page_url || body.pageUrl || 'website').slice(0, 300), ip: String(ip || '').slice(0, 60), byName: 'Website form', noticeVersion: st.noticeVersion }); // eslint-disable-line no-await-in-loop
}
// the person's data as a file (DPDP: the right to know what is kept)
async function exportData(user, kind, id) {
  const x = await recordFor(user, kind, id);
  if (x.err) return x.err;
  const col = kind === 'lead' ? 'leadId' : 'contactId';
  const data = {
    exportedAt: new Date().toISOString(), kind, record: x.row,
    activities: await P.all(`SELECT "kind", "subject", "note", "at", "byName" FROM "CrmActivity" WHERE "${col}" = ? ORDER BY "at"`, x.row.id),
    followUps: kind === 'lead' ? await P.all('SELECT "title", "dueDate", "status", "doneAt" FROM "CrmTask" WHERE "leadId" = ? ORDER BY "dueDate"', x.row.id) : [],
    consents: await P.all('SELECT "purpose", "status", "channel", "source", "noticeVersion", "at", "byName" FROM "CrmConsent" WHERE "kind" = ? AND "recordId" = ? ORDER BY "at"', kind, x.row.id),
  };
  await S.audit(user, 'CRM personal data exported (DPDP)', kind === 'lead' ? 'CrmLead' : 'CrmContact', x.row.id, `${kind}`);
  return S.okBody(data);
}
// erase the personal details (a Sales manager / Admin): name, phone, email, designation, notes; the record and its numbers stay
async function erase(user, kind, id, { confirm } = {}) {
  const x = await recordFor(user, kind, id);
  if (x.err) return x.err;
  if (!S.mayAssign(x.r)) return S.fail(403, 'Only a Sales manager or an Admin can erase a person\'s details.');
  if (confirm !== 'ERASE') return S.fail(400, 'Type ERASE to confirm. This cannot be undone.');
  const now = new Date().toISOString();
  await optOutRecord(x.row);
  if (kind === 'lead') await S.update('CrmLead', x.row.id, { contactName: 'Erased (DPDP request)', designation: null, phone: null, email: null, notes: null, updatedAt: now });
  else await S.update('CrmContact', x.row.id, { name: 'Erased (DPDP request)', designation: null, phone: null, email: null, notes: null, updatedAt: now });
  const col = kind === 'lead' ? 'leadId' : 'contactId';
  await P.run(`UPDATE "CrmActivity" SET "note" = NULL WHERE "${col}" = ?`, x.row.id);
  const st = await settings();
  for (const p of st.purposes) await writeRow(kind, x.row.id, { purpose: p, status: 'Withdrawn', channel: 'Other', source: 'Erased on request', byId: user.id, byName: user.name || null, noticeVersion: st.noticeVersion }); // eslint-disable-line no-await-in-loop
  await S.audit(user, 'CRM personal data erased (DPDP)', kind === 'lead' ? 'CrmLead' : 'CrmContact', x.row.id, 'name, phone, email, designation, notes and activity notes erased');
  return S.okBody({ ok: true });
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function noticePage() {
  const st = await settings();
  const g = [st.grievanceName, st.grievanceEmail, st.grievancePhone].filter(Boolean).map(esc).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy notice</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:#1b2a4a;margin:0;padding:16px}.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:24px;max-width:640px;margin:24px auto;line-height:1.6}h1{font-size:20px;margin:0 0 10px}li{margin:4px 0}.m{color:#5b6474;font-size:13px}</style></head>
<body><div class="card"><h1>Privacy notice</h1><p>${esc(st.noticeText).replace(/\n/g, '<br>')}</p><p><b>What we use your details for</b></p><ul>${st.purposes.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<p><b>Grievance Officer</b><br>${g || 'Write to us at the email address you received our message from.'}</p><p class="m">Notice version ${esc(st.noticeVersion)} · under the Digital Personal Data Protection Act, 2023 (India)</p></div></body></html>`;
}

module.exports = { settings, saveSettings, list, record, fromWebsite, exportData, erase, noticePage, PURPOSES, CHANNELS };

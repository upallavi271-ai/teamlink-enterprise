// ---------------------------------------------------------------------------
// CRM WAVE D - PAY AN INVOICE ONLINE (2026-11-24). The CRM's own invoices only (inside CRM Deals); nothing touches Accounts.
//   Razorpay payment link   made for the invoice's balance through Razorpay Payment Links (keys in Administration > Integrations >
//                           Payment Gateway: Provider "Razorpay", Key ID, Key secret, Webhook secret). Razorpay sends nothing to the
//                           customer by itself (notify off): the team shares the link (WhatsApp / email) as they share the invoice.
//   automatic Paid          Razorpay's webhook (payment_link.paid, signed with the webhook secret) records the payment line, and the
//                           invoice turns Partly paid / Paid by itself (crm/service.js settleInvoice). "Check now" asks Razorpay too.
//   UPI link + QR           with only a UPI ID set, a upi://pay link and its QR code for the exact balance (no gateway, no auto status)
// OFF until an Admin turns it on (CRM settings > Payments). In the sandbox / tests no call leaves the server: a stub link is made.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./service');
const P = require('./plusSchema');

const cents = (n) => Math.round(Number(n || 0) * 100) / 100;
const sandbox = () => !!(process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX);
const VPA = /^[a-z0-9.\-_]{2,256}@[a-z][a-z0-9]{1,64}$/i;

async function settings() { const v = await P.getCfg('paylink', {}); return { enabled: v.enabled === true, upiId: VPA.test(String(v.upiId || '')) ? v.upiId : '', payeeName: String(v.payeeName || '').slice(0, 60) }; }
async function razorpay() {
  const { readConfig } = require('../utils/integrationStore'); // eslint-disable-line global-require
  const c = await readConfig('payments').catch(() => ({ values: {} }));
  const v = c.values || {};
  const keyId = String(v['Key ID'] || '').trim(); const secret = String(v['Key secret'] || '').trim();
  return { configured: /razorpay/i.test(String(v.Provider || '')) && !!keyId && !!secret, keyId, secret, webhookSecret: String(v['Webhook secret'] || '').trim(), provider: v.Provider || '' };
}
async function status(user, req) {
  const st = await settings();
  const rz = await razorpay();
  const base = require('../utils/offerLink').publicBase(req); // eslint-disable-line global-require
  return S.okBody({ ...st, razorpay: { configured: rz.configured, webhookSet: !!rz.webhookSecret, provider: rz.provider }, webhookUrl: `${base}/api/crm-public/razorpay/webhook`, canChange: S.roleOf(user) === 'admin' });
}
async function saveSettings(user, body = {}) {
  if (S.roleOf(user) !== 'admin') return S.fail(403, 'Only an Admin can change online payments.');
  const upi = String(body.upiId || '').trim();
  if (upi && !VPA.test(upi)) return S.fail(400, 'The UPI ID looks like name@bank (for example teamlink@icici).');
  const next = { enabled: body.enabled === true, upiId: upi, payeeName: String(body.payeeName || '').trim().slice(0, 60) };
  await P.setCfg('paylink', next);
  await S.audit(user, 'CRM online payment settings changed', 'CrmSettings', 'paylink', `${next.enabled ? 'on' : 'off'}${next.upiId ? `, UPI ${next.upiId}` : ''}`);
  return S.okBody({ ok: true, ...next });
}

async function invoiceFor(user, id, { edit } = {}) {
  const r = S.roleOf(user);
  const row = await P.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!row || !S.canSeeRow(user, r, row)) return { err: S.fail(404, 'This invoice is not there.') };
  if (edit && !S.canEditRow(user, r, row)) return { err: S.fail(403, 'You cannot change this invoice.') };
  return { row };
}
const balanceOf = (row) => cents(Math.max(0, S.netTotalOf(row) - row.paidAmount - (Number(row.tdsAmount) || 0))); // after credit / debit notes
function upiOf(st, row, amount) {
  if (!st.upiId) return null;
  const q = new URLSearchParams({ pa: st.upiId, pn: st.payeeName || 'TeamLink', am: amount.toFixed(2), cu: 'INR', tn: `${row.code || 'Invoice'}`.slice(0, 50) });
  return `upi://pay?${q.toString()}`;
}
async function links(user, id) {
  const x = await invoiceFor(user, id);
  if (x.err) return x.err;
  const st = await settings();
  const rows = await P.all('SELECT * FROM "CrmPayLink" WHERE "invoiceId" = ? ORDER BY "createdAt" DESC', x.row.id);
  const bal = balanceOf(x.row);
  const upi = bal > 0 ? upiOf(st, x.row, bal) : null;
  let qr = null;
  // the QR picture needs the 'qrcode' package (in package.json; a server without it shows the link only)
  if (upi) { try { qr = await require('qrcode').toDataURL(upi, { margin: 1, width: 220 }); } catch { qr = null; } } // eslint-disable-line global-require
  return S.okBody({ enabled: st.enabled, links: rows, upi, qr, balance: bal, razorpay: (await razorpay()).configured });
}
async function createRazorpayLink(rz, row, amount, account) {
  const ref = `${row.code || row.id}-${Date.now().toString(36)}`.slice(0, 40);
  if (sandbox()) return { id: `plink_test_${crypto.randomBytes(5).toString('hex')}`, short_url: `https://rzp.io/i/test${crypto.randomBytes(4).toString('hex')}`, status: 'created', reference_id: ref, stub: true };
  const body = {
    amount: Math.round(amount * 100), currency: 'INR', accept_partial: false, reference_id: ref, description: `${row.code || 'Invoice'} - ${row.title || ''}`.slice(0, 2048),
    customer: { name: (account && account.name) || row.accountName || 'Customer', ...(account && account.email ? { email: account.email } : {}), ...(account && account.phone ? { contact: account.phone } : {}) },
    notify: { sms: false, email: false }, reminder_enable: false, notes: { crmInvoiceId: row.id, crmInvoiceCode: row.code || '' },
  };
  const r = await fetch('https://api.razorpay.com/v1/payment_links', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${rz.keyId}:${rz.secret}`).toString('base64')}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error((j.error && j.error.description) || `Razorpay answered ${r.status}`);
  return j;
}
async function createLink(user, id) {
  const x = await invoiceFor(user, id, { edit: true });
  if (x.err) return x.err;
  const { row } = x;
  const st = await settings();
  if (!st.enabled) return S.fail(400, 'Online payment is off. An Admin turns it on in CRM settings > Payments.');
  if (['Cancelled', 'Paid'].includes(row.status)) return S.fail(400, `This invoice is ${row.status.toLowerCase()}.`);
  if (row.status === 'Draft') return S.fail(400, 'Send the invoice first (or mark it Sent), then make its payment link.');
  const bal = balanceOf(row);
  if (!(bal > 0)) return S.fail(400, 'Nothing is left to pay on this invoice.');
  const rz = await razorpay();
  if (!rz.configured) {
    if (!st.upiId) return S.fail(400, 'Razorpay is not connected yet (Administration > Integrations > Payment Gateway) and no UPI ID is set. Ask the Admin.');
    return links(user, id); // the UPI link + QR only
  }
  const open = await P.one('SELECT * FROM "CrmPayLink" WHERE "invoiceId" = ? AND "status" = \'created\' AND "amount" = ? ORDER BY "createdAt" DESC', row.id, bal);
  if (!open) {
    const account = row.accountId ? await S.getRow('account', row.accountId) : null;
    let j;
    try { j = await createRazorpayLink(rz, row, bal, account); } catch (e) { return S.fail(502, `Razorpay did not make the link: ${e.message}`); }
    const now = new Date().toISOString();
    await P.run('INSERT INTO "CrmPayLink" ("id", "invoiceId", "provider", "providerId", "url", "amount", "status", "createdById", "createdByName", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('plk'), row.id, 'Razorpay', j.id, j.short_url, bal, 'created', user.id, user.name || null, now, now);
    await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Payment link made for ${row.code || 'the invoice'}: ${bal}`, note: j.short_url, at: now, dealId: row.dealId, accountId: row.accountId, byId: user.id, byName: user.name || null, createdAt: now });
    await S.audit(user, 'CRM payment link made', 'CrmInvoice', row.id, `${row.code || row.id}: ${bal} ${j.id}`);
  }
  return links(user, id);
}
const MODE = { upi: 'UPI', card: 'Card', netbanking: 'Bank transfer', wallet: 'Other', emi: 'Card' };
// record what Razorpay says was paid on a link (from the webhook or "Check now"); once per payment id
async function recordPaid(link, payment) {
  if (!link || !payment || !payment.id) return { ok: false, reason: 'no link' };
  if (link.paymentId === payment.id) return { ok: true, already: true };
  const row = await P.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', link.invoiceId);
  if (!row || row.status === 'Cancelled') return { ok: false, reason: 'invoice cancelled or gone' };
  const amount = Math.min(cents(Number(payment.amount || 0) / 100), balanceOf(row));
  const now = new Date().toISOString();
  await P.run('UPDATE "CrmPayLink" SET "status" = \'paid\', "paymentId" = ?, "paidAmount" = ?, "paidAt" = ?, "method" = ?, "updatedAt" = ? WHERE "id" = ?', payment.id, amount, now, payment.method || null, now, link.id);
  if (amount > 0) {
    const system = { id: null, name: 'Razorpay (online payment)' };
    await S.writePayment(system, row, { amount, paidOn: S.istToday(), mode: MODE[payment.method] || 'Other', reference: `Razorpay ${payment.id}`.slice(0, 80), note: 'Paid online from the payment link' });
    await S.settleInvoice(row);
    const owner = row.ownerId;
    if (owner) await require('../utils/notify').pushNotification({ userId: owner, title: `💰 ${row.code || 'An invoice'} paid online: ₹${amount.toLocaleString('en-IN')}`, message: `${row.accountName || ''} paid from the payment link.`, open: `/crm/deals?view=invoices` }).catch(() => null); // eslint-disable-line global-require
  }
  return { ok: true, amount };
}
async function webhook(raw, signature) {
  const rz = await razorpay();
  if (!rz.webhookSecret) return { status: 400, body: { error: 'webhook secret not set' } };
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''));
  const want = crypto.createHmac('sha256', rz.webhookSecret).update(buf).digest('hex');
  const got = String(signature || '');
  if (want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return { status: 401, body: { error: 'bad signature' } };
  let ev = {};
  try { ev = JSON.parse(buf.toString('utf8')); } catch { return { status: 400, body: { error: 'bad json' } }; }
  if (ev.event !== 'payment_link.paid' && ev.event !== 'payment_link.partially_paid') return { status: 200, body: { ok: true, ignored: ev.event || null } };
  await P.ensure();
  const plink = ev.payload && ev.payload.payment_link && ev.payload.payment_link.entity;
  const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  const link = plink && await P.one('SELECT * FROM "CrmPayLink" WHERE "providerId" = ?', String(plink.id || ''));
  if (!link) return { status: 200, body: { ok: true, unknown: true } };
  const out = await recordPaid(link, pay);
  return { status: 200, body: out };
}
async function refresh(user, linkId) {
  const link = await P.one('SELECT * FROM "CrmPayLink" WHERE "id" = ?', S.clip(linkId, 60));
  if (!link) return S.fail(404, 'This payment link is not there.');
  const x = await invoiceFor(user, link.invoiceId);
  if (x.err) return x.err;
  const rz = await razorpay();
  if (!rz.configured || sandbox() || link.status === 'paid') return links(user, link.invoiceId);
  try {
    const r = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(link.providerId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${rz.keyId}:${rz.secret}`).toString('base64')}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (j.status === 'paid' && Array.isArray(j.payments) && j.payments.length) {
      const p = j.payments[j.payments.length - 1];
      await recordPaid(link, { id: p.payment_id, amount: p.amount, method: p.method });
    } else if (j.status && j.status !== link.status) await P.run('UPDATE "CrmPayLink" SET "status" = ?, "updatedAt" = ? WHERE "id" = ?', String(j.status).slice(0, 20), new Date().toISOString(), link.id);
  } catch (e) { return S.fail(502, `Razorpay could not be asked: ${e.message}`); }
  return links(user, link.invoiceId);
}

module.exports = { settings, saveSettings, status, links, createLink, webhook, refresh, recordPaid, razorpay };

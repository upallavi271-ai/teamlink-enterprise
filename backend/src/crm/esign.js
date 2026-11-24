// ---------------------------------------------------------------------------
// A PROPOSAL SIGNED WITH AADHAAR eSIGN (CRM wave A 15.07, 2026-11-24). The customer's proposal link (routes/crmPublic.js) shows a third
// button, "Accept and sign with Aadhaar eSign", ONLY when Administration > Integrations > eMudhra eSign is fully set up (the same
// connection the agreements and offer letters use, utils/emudhra.js). The proposal PDF goes to eMudhra's Signer Gateway; when eMudhra
// posts back, its own status API is asked (the posted form is never trusted), the signed PDF is kept on the deal (Files: "Signed proposal")
// and the proposal is marked Accepted with the eMudhra transaction number on the timeline. Without the eMudhra account nothing changes:
// Accept / Decline with the address recorded, as before.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./service');
const DB = require('./schema');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RETURN_PATH = '/api/crm-public/proposal-esign/return';
const base = (req) => { try { return require('../utils/offerLink').publicBase(req); } catch { return String(process.env.APP_BASE_URL || '').replace(/\/+$/, ''); } }; // eslint-disable-line global-require

async function available() {
  try { return await require('../utils/emudhra').isAvailable(); } catch { return false; } // eslint-disable-line global-require
}
// the gateway form, posted by the customer's browser by itself: { html } or { status, words }
async function start(token, req) {
  const X = require('./extra'); // eslint-disable-line global-require
  const emudhra = require('../utils/emudhra'); // eslint-disable-line global-require
  const id = X.proposalOfToken(token);
  const p = id ? await X.proposalForCustomer(id).catch(() => null) : null;
  if (!p) return { status: 404, words: 'This link has expired. Please ask us to send the proposal again.' };
  if (p.status !== 'Sent') return { status: 409, words: `This proposal is already marked ${esc(p.status)}.` };
  const out = await X.proposalPdf(null, id, { signed: true });
  if (!out.pdf) return { status: 404, words: 'The proposal could not be read.' };
  let form;
  try {
    form = await emudhra.startSession({ client: null, pdf: out.pdf, signerName: p.toName || p.company || 'Customer', returnBase: base(req), returnPath: RETURN_PATH, sessionExtra: { kind: 'crm-proposal', proposalId: id, token } });
  } catch (e) {
    if (e.code === 'NOT_READY') return { status: 409, words: 'Aadhaar eSign is not available right now. Please press Accept on the proposal page instead.' };
    throw e;
  }
  await S.audit({ id: null, name: 'Customer (email link)' }, 'CRM proposal sent to eMudhra for Aadhaar eSign', 'CrmProposal', id, `${p.number} · ${form.ref}`).catch(() => null);
  const inputs = Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return { html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aadhaar eSign</title></head><body style="font-family:Arial,sans-serif;text-align:center;padding:40px 16px"><p>Opening Aadhaar eSign (eMudhra)…</p><form id="f" method="post" action="${esc(form.gatewayUrl)}">${inputs}<button type="submit">Continue</button></form><script>document.getElementById('f').submit()</script></body></html>`, ref: form.ref };
}
// eMudhra posts back here: verified with eMudhra's API before anything changes. -> { status, words }
async function finish(ref, kind, body = {}, ip = '') {
  const emudhra = require('../utils/emudhra'); // eslint-disable-line global-require
  const X = require('./extra'); // eslint-disable-line global-require
  const session = await emudhra.readSession(ref);
  if (!session || session.kind !== 'crm-proposal' || !['success', 'failure', 'cancel'].includes(kind)) return { status: 400, words: 'This signing reply was not recognised, so nothing was changed.' };
  if (session.status !== 'Started') return { status: 409, words: 'This signing reply was already handled, so nothing was changed.' };
  const id = session.proposalId;
  if (kind !== 'success' || String(body.ReturnStatus || '').toLowerCase() !== 'success') {
    await emudhra.closeSession(ref, kind === 'cancel' ? 'Cancelled' : 'Failed');
    return { status: 200, words: kind === 'cancel' ? 'The signing was cancelled. You can open the proposal link again and Accept or sign.' : 'The signing did not complete. You can open the proposal link again and try once more.' };
  }
  const ver = await emudhra.verifyAndFetch({ ref, postedTxn: body.Transactionnumber });
  if (!ver.ok) {
    if (!ver.refuse) await emudhra.closeSession(ref, 'Failed');
    return { status: ver.refuse ? 400 : 200, words: `The signing could not be confirmed with eMudhra (${esc(ver.reason)}). Nothing was changed.` };
  }
  const pr = await DB.one('SELECT * FROM "CrmProposal" WHERE "id" = ?', id);
  if (!pr) { await emudhra.closeSession(ref, 'Late'); return { status: 410, words: 'This proposal is no longer there.' }; }
  const A = require('../utils/attachments'); // eslint-disable-line global-require
  const stored = A.store({ data: ver.pdf, contentType: 'application/pdf', filename: `proposal-${pr.number}-aadhaar-esigned.pdf` }, { maxBytes: 25 * 1024 * 1024 });
  const now = DB.nowIso();
  const deal = await S.getRow('deal', pr.dealId);
  await S.insert('CrmDealFile', { id: S.newId('dfile'), dealId: pr.dealId, accountId: deal ? deal.accountId : null, kind: 'Signed proposal', name: stored.billName, mime: stored.billMime, size: stored.billSize, stored: stored.billFile, createdById: null, createdByName: 'Customer (Aadhaar eSign)', createdAt: now });
  const sha = crypto.createHash('sha256').update(ver.pdf).digest('hex');
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Proposal ${pr.number} signed with Aadhaar eSign`, note: `eMudhra transaction ${ver.transactionNumber}. Signed PDF kept on the deal (SHA-256 ${sha.slice(0, 16)}…).`, at: now, dealId: pr.dealId, accountId: deal ? deal.accountId : null, byId: null, byName: 'Customer (Aadhaar eSign)', createdAt: now });
  await emudhra.closeSession(ref, 'Signed');
  const out = await X.decideByCustomer(id, 'accept', { ip });
  return { status: 200, words: out.error ? esc(out.error) : 'Thank you. The proposal is <b>signed and accepted</b>. Our team will contact you shortly with the next steps.' };
}

module.exports = { available, start, finish, RETURN_PATH };

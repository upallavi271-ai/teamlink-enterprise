// ---------------------------------------------------------------------------
// AGREEMENT DRIVE LINKS (user, 2026-10-12) - mounted into routes/clients.js BEFORE GET /:id.
//
//   GET    /clients/agreement-links/rights        what this login may do (the buttons)
//   GET    /clients/agreement-links/summary       which clients have a link (the "Agreement on Drive" chip)
//   GET    /clients/agreement-links/template      the Excel / CSV template to fill
//   POST   /clients/agreement-links/read-file     an uploaded .xlsx / .csv -> the same text as a paste
//   POST   /clients/agreement-links/check         step 2: match every line, change nothing
//   POST   /clients/agreement-links/apply         step 3: save the good lines (batches of a run)
//   GET    /clients/:id/agreement-links           one client: current link + history
//   POST   /clients/:id/agreement-links           one client: add / replace (same checks)
//   PATCH  /clients/:id/agreement-links/:docId    tick / untick "signed copy on file" (Admin, BDE TL)
//   DELETE /clients/:id/agreement-links/:docId    Admin: take it away (soft - stays in history)
//
// The server never opens, fetches or verifies a link: it checks the text and stores it.
// Everything is enforced here (rights, ownership, the 500-line limit); the screen only mirrors it.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const XLSX = require('xlsx');
const attachments = require('../utils/attachments');
const DL = require('../utils/agreementDriveLinks');

const jsonBody = express.json({ type: () => true, limit: '2mb' }); // a 500-line run is bigger than the default 100 kb
const HEADERS = ['Client name or Client ID', 'Drive link', 'Agreement date', 'End date', 'Note'];
const SIGNED_HEADER = 'Mark as signed copy';

module.exports = function mountAgreementDriveLinks(router) {
  const deny = (res, error, status = 403) => res.status(status).json({ error });
  async function needAdd(req, res) {
    const rights = await DL.rightsOf(req.user);
    if (!rights.canAdd) { deny(res, rights.why); return null; }
    return rights;
  }
  const linesOf = (body) => (Array.isArray(body.lines) ? body.lines : DL.parseText(body.text)).filter((l) => l && typeof l === 'object');
  const tooMany = (res, n) => res.status(400).json({ error: `You can add up to ${DL.MAX_LINES} lines at a time. You have ${n}. Split the list into smaller parts.` });

  router.get('/agreement-links/rights', async (req, res) => {
    const r = await DL.rightsOf(req.user);
    return res.json({
      canAdd: r.canAdd, why: r.why, canMarkSigned: r.canMarkSigned, canRemove: r.canRemove, canSee: !!r.viewMode, limit: r.limit, hosts: r.hosts,
    });
  });

  router.get('/agreement-links/summary', async (req, res) => res.json(await DL.summaryFor(req.user)));

  router.get('/agreement-links/template', async (req, res) => {
    const rights = await needAdd(req, res);
    if (!rights) return undefined;
    const head = rights.canMarkSigned ? [...HEADERS, SIGNED_HEADER] : HEADERS;
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="agreement-links-template.csv"');
      return res.send(`\uFEFF${head.join(',')}\r\n`);
    }
    const how = [
      ['How to fill this sheet'],
      [''],
      ['1. One line for each client. Write the Client name, or better the Client ID (it never has spelling mistakes).'],
      ['2. Paste the Google Drive link of the signed agreement. In Google Drive: open the file, press Share, choose "Anyone with the link" (Viewer) or your company, then Copy link.'],
      ['3. Agreement date and End date are optional. Write them like 31-03-2026.'],
      ['4. Note is optional (for example "signed copy from the client\'s HR").'],
      ...(rights.canMarkSigned ? [['5. Mark as signed copy: write Yes only if this is the final signed copy and you want it marked "Signed copy on file". Leave it empty otherwise.']] : []),
      [''],
      [`You can add up to ${DL.MAX_LINES} lines at a time.`],
      ['Accepted links: Google Drive and Google Docs (also OneDrive, SharePoint and Dropbox). The app only saves the link, it never opens it.'],
    ];
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([head]);
    sheet['!cols'] = head.map((h, i) => ({ wch: i === 0 ? 32 : (i === 1 ? 60 : 18) }));
    XLSX.utils.book_append_sheet(wb, sheet, 'Agreement links');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(how), 'How to fill');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="agreement-links-template.xlsx"');
    return res.send(buf);
  });

  // An uploaded sheet becomes the same text as a paste (tab separated, row for row), so the person
  // sees exactly what will be checked and can still edit it.
  router.post('/agreement-links/read-file', async (req, res) => {
    if (!(await needAdd(req, res))) return undefined;
    let parsed;
    try { parsed = await attachments.parseMultipart(req, { maxBytes: 2 * 1024 * 1024 }); } catch (err) {
      return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: err.code === 'TOO_LARGE' ? 'That file is over 2 MB. Split the list into smaller files.' : 'Choose an Excel or CSV file.' });
    }
    const file = parsed.file;
    if (!file || !file.data || !file.data.length) return res.status(400).json({ error: 'Choose an Excel or CSV file.' });
    try { return res.json(DL.fileToText(file.data)); } catch (err) { return res.status(400).json({ error: err.userMessage || 'That file could not be read.' }); }
  });

  router.post('/agreement-links/check', jsonBody, async (req, res) => {
    if (!(await needAdd(req, res))) return undefined;
    const lines = linesOf(req.body || {});
    if (!lines.length) return res.status(400).json({ error: 'Paste at least one line: the client name (or ID) and its Drive link.' });
    if (lines.length > DL.MAX_LINES) return tooMany(res, lines.length);
    return res.json(await DL.check(req.user, lines));
  });

  router.post('/agreement-links/apply', jsonBody, async (req, res) => {
    if (!(await needAdd(req, res))) return undefined;
    const b = req.body || {};
    const lines = linesOf({ lines: Array.isArray(b.lines) ? b.lines : [] });
    if (!lines.length) return res.status(400).json({ error: 'There is nothing to add.' });
    if (lines.length > DL.MAX_LINES) return tooMany(res, lines.length);
    const runId = /^[a-z0-9-]{6,40}$/i.test(String(b.runId || '')) ? String(b.runId) : crypto.randomBytes(6).toString('hex');
    const sofar = await DL.runTotal(req.user, runId);
    if (sofar + lines.length > DL.MAX_LINES) return tooMany(res, sofar + lines.length);
    const out = await DL.apply(req.user, lines, { runId, via: 'bulk' });
    return res.json({ runId, ...out });
  });

  // ---- one client -------------------------------------------------------------------------------------
  router.get('/:id/agreement-links', async (req, res) => res.json(await DL.forClient(req.user, req.client)));

  router.post('/:id/agreement-links', jsonBody, async (req, res) => {
    const rights = await needAdd(req, res);
    if (!rights) return undefined;
    const b = req.body || {};
    const line = {
      row: 1, clientId: req.client.id, ref: req.client.name, link: b.link, agreementDate: b.agreementDate, endDate: b.endDate, note: b.note,
      markSigned: b.markSigned === true, onExisting: b.onExisting === 'replace' ? 'replace' : 'keep',
    };
    const chk = (await DL.check(req.user, [line])).rows[0];
    if (!chk.ready) return res.status(chk.status === 'notyours' ? 403 : 400).json({ error: chk.message, status: chk.status, row: chk });
    if (chk.status === 'exists' && line.onExisting !== 'replace') return res.status(409).json({ error: chk.message, status: 'exists', row: chk });
    const out = await DL.apply(req.user, [line], { via: 'client' });
    const r = out.results[0];
    return res.status(r.outcome === 'Skipped' ? 400 : 201).json({ ...out, link: (await DL.forClient(req.user, req.client)).current, message: r.outcome === 'Skipped' ? r.reason : (r.outcome === 'Replaced' ? 'Replaced. The old link is kept in history.' : 'Saved.') });
  });

  router.patch('/:id/agreement-links/:docId', jsonBody, async (req, res) => {
    const rights = await DL.rightsOf(req.user);
    if (!rights.canMarkSigned) return deny(res, 'Only an Admin or the BDE team can mark a signed copy.');
    if (!require('../utils/clientLifecycle').ownsClient(req.user, req.client)) return deny(res, 'This client is not in your area.', 403); // eslint-disable-line global-require
    const doc = await DL.setSignedCopy(req.user, req.client, req.params.docId, !!(req.body && req.body.signedCopy));
    if (doc === null) return deny(res, 'That link is not on this client.', 404);
    if (doc === false) return deny(res, 'That link was replaced or removed.', 409);
    return res.json({ ok: true, ...(await DL.forClient(req.user, req.client)) });
  });

  router.delete('/:id/agreement-links/:docId', jsonBody, async (req, res) => {
    const rights = await DL.rightsOf(req.user);
    if (!rights.canRemove) return deny(res, 'Only an Admin or the BDE team can remove an agreement link.');
    if (!require('../utils/clientLifecycle').ownsClient(req.user, req.client)) return deny(res, 'This client is not in your area.', 403); // eslint-disable-line global-require
    const doc = await DL.removeLink(req.user, req.client, req.params.docId, req.body && req.body.reason);
    if (!doc) return deny(res, 'That link is not on this client.', 404);
    return res.json({ ok: true, ...(await DL.forClient(req.user, req.client)) });
  });
};

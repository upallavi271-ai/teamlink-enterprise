// ---------------------------------------------------------------------------
// BIG EXPORTS RUN IN THE BACKGROUND (spec 2026-10-03 §B): an export of more
// than ATS_EXPORT_BG_ROWS rows (default 10,000) is not streamed back on the
// request. The request answers 202 at once; the file is written here, after
// the response, into the private ATS I/O folder (utils/atsIoStore.js), and
// the requester gets
//   * an in-app Notification "Your export is ready" — the file is listed
//     under the screen's History button, where it downloads; and
//   * an email to their own address saying the same. The mailer never hands
//     a reserved test domain (…@example.test) to the provider, and a test
//     identity (ZZTEST / example.test) is never emailed at all.
// The download route checks the file belongs to the caller (Super Admin:
// any). Files are kept for 7 days.
//
// The audit row is the same one an ordinary export writes (who, when, which
// module, how many rows) plus "(background)".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const store = require('./atsIoStore');
const { toCsv, toXlsx, toPdf } = require('./tabularExport');
const { logAudit } = require('./audit');
const { pushNotification } = require('./notify');

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const TEST_RE = /zztest|example\.test/i;
const threshold = () => Math.max(1, Number(process.env.ATS_EXPORT_BG_ROWS || 10000));

const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return v;
};
const safeName = (s) => String(s || 'export').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function build(format, { headers, rows, sheet, title, subtitle }) {
  if (format === 'csv') return Buffer.from(`﻿${toCsv(headers, rows)}`, 'utf8');
  if (format === 'pdf') return toPdf(headers, rows, { title, subtitle });
  return toXlsx(headers, rows, (sheet || title || 'Export').slice(0, 31));
}

// Starts the job; returns { id, rows, filename } immediately.
function startBackgroundExport(user, {
  format, name, title, headers, rows, sheet, entity, what, scope, period, module,
}) {
  store.sweep('exports', KEEP_MS);
  const id = store.newId('x-');
  const clean = rows.map((r) => r.map(cell));
  const filename = `${safeName(name)}-${new Date().toISOString().slice(0, 10)}.${format}`;
  const meta = {
    id, userId: user.id, actorName: user.name || user.email, filename, format, rows: clean.length, title, module: module || null, status: 'running', at: new Date().toISOString(),
  };
  store.writeJson('exports', id, meta);
  setImmediate(async () => {
    try {
      const range = period ? `${period.from} to ${period.to}` : 'all dates';
      const buf = build(format, {
        headers, rows: clean, sheet, title,
        subtitle: `${clean.length} row(s) · scope: ${scope} · ${range} · exported ${new Date().toLocaleString('en-GB')} by ${meta.actorName}`,
      });
      store.writeBin('exports', `${id}.${format}`, buf);
      store.writeJson('exports', id, { ...meta, status: 'ready', bytes: buf.length, readyAt: new Date().toISOString() });
      await logAudit({
        userId: user.id,
        actorName: meta.actorName,
        action: `${what} exported (${format.toUpperCase()}, background)`,
        entity,
        entityId: id,
        toValue: `${clean.length} row(s) · scope: ${scope} · ${range}`,
      });
      await pushNotification({
        userId: user.id,
        title: `Your export is ready — ${title}`,
        message: `${clean.length.toLocaleString('en-IN')} rows (${format.toUpperCase()}). Download it from the History button on that screen within 7 days.`,
      });
      // Email to the requester's OWN address — never for a test identity.
      if (user.email && !TEST_RE.test(`${user.name || ''} ${user.email}`)) {
        // eslint-disable-next-line global-require
        const mailer = require('./mailer');
        if (!mailer.isReservedTestAddress || !mailer.isReservedTestAddress(user.email)) {
          const sent = await mailer.sendMail({
            to: user.email,
            subject: `TeamLink — your export is ready (${title})`,
            text: `Your export of ${clean.length} rows (${format.toUpperCase()}) is ready.\n\nOpen TeamLink → the same screen → History to download it. It is kept for 7 days.`,
            useEmployeeFrom: false,
          }).catch((e) => ({ ok: false, error: e.message }));
          await prisma.notification.create({
            data: { userId: user.id, title: 'Export ready (email)', message: title, channel: 'Email', recipient: user.email, status: sent.ok ? 'Sent' : (sent.notConfigured ? 'Not sent — no email provider' : `Failed: ${String(sent.error || '').slice(0, 150)}`) },
          }).catch(() => {});
        }
      }
    } catch (err) {
      store.writeJson('exports', id, { ...meta, status: 'failed', error: String(err && err.message).slice(0, 300) });
      await pushNotification({ userId: user.id, title: `Your export failed — ${title}`, message: String(err && err.message).slice(0, 300) }).catch(() => {});
    }
  });
  return { id, rows: clean.length, filename };
}

function listExports(user, { all = false } = {}) {
  store.sweep('exports', KEEP_MS);
  const fs = require('fs'); // eslint-disable-line global-require
  let names = [];
  try { names = fs.readdirSync(store.dir('exports')).filter((n) => n.endsWith('.json')); } catch { names = []; }
  return names.map((n) => store.readJson('exports', n.slice(0, -5))).filter(Boolean)
    .filter((m) => all || m.userId === user.id)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 50)
    .map(({ userId, ...m }) => ({ ...m, mine: userId === user.id }));
}

function exportFile(user, id, { all = false } = {}) {
  const meta = store.readJson('exports', id);
  if (!meta) return { status: 404, error: 'That export is not on the server (exports are kept for 7 days).' };
  if (!all && meta.userId !== user.id) return { status: 403, error: 'That export belongs to somebody else.' };
  if (meta.status !== 'ready') return { status: 409, error: meta.status === 'failed' ? `That export failed: ${meta.error}` : 'That export is still being prepared.' };
  const buf = store.readBin('exports', `${id}.${meta.format}`);
  if (!buf) return { status: 410, error: 'That export file is gone.' };
  return { status: 200, meta, buf };
}

module.exports = { threshold, startBackgroundExport, listExports, exportFile };

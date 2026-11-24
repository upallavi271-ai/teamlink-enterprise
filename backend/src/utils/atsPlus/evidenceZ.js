// ---------------------------------------------------------------------------
// DATA REGION AND SLA: THE EVIDENCE THE PRODUCT CAN HOLD (market benchmark 15.11 / IN-14 regional data residency, 15.16 uptime /
// support SLA; ATS wave 2 Z 2026-11-25). Where the server really is and what uptime is promised in a contract are the FOUNDER'S
// decisions - code cannot make them true. What the product does:
//
//   WHAT THE SERVER SEES   facts read on this server, never typed: its time zone, the database's place on its own disk, the backup
//                          folder, the newest backup and its restore check, whether an encrypted off-site copy is set up and the
//                          storage address / region it goes to (host and region only - never a key).
//   STATED vs SEEN         the region an Admin stated (ATS settings > Privacy & security > Where data is stored) beside those facts;
//                          a mismatch (e.g. "India" stated, off-site region us-east-1) is flagged.
//   EVIDENCE REGISTER      the documents that prove it: the hosting provider's invoice / console page showing the data-centre region,
//                          the backup storage region, the signed SLA, the DPA, the sub-processor list (a link + note + who / when).
//   FOUNDER CONFIRMATION   a Super Admin confirms the region and the SLA commitment (who / when, audited); until then the public
//                          trust / SLA pages say "stated by the company, not yet confirmed".
//   MONTHLY SLA REPORT     each month: measured uptime against the target, outage minutes, met or missed, and the credit wording.
//   EVIDENCE PACK          one HTML page to download / print with all of the above (for a client's security questionnaire).
//
//   GET  /api/ats-plus/evidencez            GET /api/ats-plus/evidencez/pack (HTML)
//   POST /api/ats-plus/evidencez/items      DELETE /api/ats-plus/evidencez/items/:id      (Admin)
//   POST /api/ats-plus/evidencez/confirm { what: residency | sla, note }                  (Super Admin)
//   GET  /api/public/sla-history            the monthly report on the public SLA page (only when the status pages are public)
// ---------------------------------------------------------------------------
const os = require('os');
const express = require('express');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const S = require('./store');

const KINDS = ['Hosting region', 'Backup location', 'SLA contract', 'Data processing agreement', 'Sub-processor list', 'Other'];
const CONF_KEY = 'evidenceConfirmZ';
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function regionWords(v) { return String(v || '').toLowerCase(); }
// a region text that is plainly India (a city, "ap-south-1" Mumbai, "asia-south1/2", "centralindia", "in-mum" ...)
const INDIA = /(india|mumbai|bombay|hyderabad|chennai|bengaluru|bangalore|delhi|pune|noida|ap-south-[12]|asia-south[12]|centralindia|southindia|westindia|in-?mum|in-?maa|in-?bom|in-?hyd|\bblr\d*\b|\bbom\d*\b)/;
function seen() {
  let backup = {}; let sets = [];
  try { const B = require('../backup'); const s = B.summary(); backup = { folder: s.folder, lastBackup: s.lastBackup, lastVerify: s.lastVerify, latestAt: s.latest ? s.latest.at : null, sets: s.sets.length }; sets = s.sets; } catch { backup = { error: 'The backup tool did not answer.' }; } // eslint-disable-line global-require
  const endpoint = String(process.env.BACKUP_S3_ENDPOINT || '');
  let host = null; try { host = endpoint ? new URL(endpoint).hostname : null; } catch { host = endpoint || null; }
  const offsite = { set: !!(process.env.BACKUP_ENC_KEY && process.env.BACKUP_S3_BUCKET), encrypted: !!process.env.BACKUP_ENC_KEY, storageHost: host, region: process.env.BACKUP_S3_REGION || null };
  const db = String(process.env.DATABASE_URL || '').replace(/^file:/, '');
  return {
    at: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || null, utcOffsetMinutes: -new Date().getTimezoneOffset(),
    hostName: os.hostname(), platform: `${os.type()} ${os.release()}`, hostingRegionEnv: process.env.HOSTING_REGION || null,
    database: { engine: 'SQLite', onThisServer: !!db && !/^[a-z]+:\/\//i.test(db), file: db ? db.split(/[\\/]/).slice(-2).join('/') : null },
    backup, offsite, backupSets: sets.length,
  };
}
function compare(stated, s) {
  const flags = [];
  const india = INDIA.test(regionWords(stated.region));
  if (s.offsite.region && india && !INDIA.test(regionWords(s.offsite.region))) flags.push(`The off-site backup region is ${s.offsite.region}, but the stated data region is ${stated.region}.`);
  if (s.hostingRegionEnv && india && !INDIA.test(regionWords(s.hostingRegionEnv))) flags.push(`The server says HOSTING_REGION=${s.hostingRegionEnv}, but the stated data region is ${stated.region}.`);
  if (india && s.utcOffsetMinutes !== 330 && !/kolkata|calcutta/i.test(String(s.timeZone))) flags.push(`The server's clock is not on India time (${s.timeZone || 'unknown'}). That does not prove where it is, but check it with the hosting provider.`);
  if (!s.offsite.set) flags.push('No encrypted off-site backup is set up: all copies are on this server (BACKUP_ENC_KEY and BACKUP_S3_* on the server).');
  if (stated.backupLocation && s.offsite.region && INDIA.test(regionWords(stated.backupLocation)) !== INDIA.test(regionWords(s.offsite.region))) flags.push(`The stated backup location (${stated.backupLocation}) and the off-site region (${s.offsite.region}) do not agree.`);
  return flags;
}

async function monthly(months = 6, target = 99.5) {
  await S.ensure();
  const out = [];
  const outage = (() => { try { return (require('../uptimeAlert').readState() || {}).history || []; } catch { return []; } })(); // eslint-disable-line global-require
  const now = new Date();
  for (let i = 0; i < months; i += 1) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    // eslint-disable-next-line no-await-in-loop
    const [r] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n, SUM("ok") AS up, MIN("at") AS first FROM "AtsPlusUptime" WHERE "at" >= ? AND "at" < ?', start.toISOString(), end.toISOString());
    const n = Number(r && r.n) || 0; const up = Number(r && r.up) || 0;
    const downMin = outage.reduce((a, o) => { const s = Math.max(new Date(o.since).getTime(), start.getTime()); const e = Math.min(new Date(o.upAt || Date.now()).getTime(), end.getTime()); return e > s ? a + (e - s) / 60000 : a; }, 0);
    const covered = n ? Math.min(end, now) - Math.max(start.getTime(), new Date(r.first).getTime()) : 0;
    const samplePct = n ? (up / n) * 100 : null;
    const outagePct = covered > 0 ? (1 - (downMin * 60000) / covered) * 100 : null;
    const pct = samplePct === null ? null : Math.round(Math.min(samplePct, outagePct === null ? 100 : outagePct) * 1000) / 1000;
    out.push({ month: start.toISOString().slice(0, 7), samples: n, uptimePct: pct, outageMinutes: Math.round(downMin), target, met: pct === null ? null : pct >= target });
  }
  return out;
}
async function bundle() {
  const PV = require('./privacy'); const ST = require('./status'); // eslint-disable-line global-require
  const stated = await PV.residency();
  const sla = await ST.settings();
  const s = seen();
  const items = await S.items.list('evidence-z', {}, { limit: 500 });
  const conf = await S.settings.get(CONF_KEY, { residency: null, sla: null });
  return {
    stated: { region: stated.region, provider: stated.provider || null, city: stated.city || null, backupLocation: stated.backupLocation, backupProvider: stated.backupProvider || null, processors: stated.processors, statedBy: stated.confirmedBy || null, statedAt: stated.confirmedAt || null },
    seen: s, flags: compare(stated, s),
    sla: { uptimeTarget: sla.uptimeTarget, supportHours: sla.supportHours, response: sla.response, credits: sla.credits || null, months: await monthly(6, sla.uptimeTarget) },
    items: items.map((x) => ({ id: x.id, kind: x.status, title: x.title, link: x.link || null, note: x.note || null, docDate: x.docDate || null, by: x.createdByName, at: x.createdAt })),
    kinds: KINDS, confirmed: conf,
    missing: KINDS.slice(0, 3).filter((k) => !items.some((x) => x.status === k)),
  };
}

const router = express.Router();
router.get('/evidencez', S.internal, S.wrap(async (req, res) => res.json({ ...(await bundle()), canEdit: S.isAdmin(req.user) && !req.viewAs, canConfirm: req.user.role === 'SUPER_ADMIN' && !req.viewAs })));
router.post('/evidencez/items', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const kind = KINDS.includes(b.kind) ? b.kind : null; if (!kind) return res.status(400).json({ error: `Kind: ${KINDS.join(', ')}.` });
  const title = String(b.title || '').trim().slice(0, 160); if (title.length < 3) return res.status(400).json({ error: 'Say what the document is.' });
  const link = String(b.link || '').trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: 'The link must start with https://' });
  const docDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.docDate || '')) ? b.docDate : null;
  const it = await S.items.create('evidence-z', { status: kind, title, link: link.slice(0, 500) || null, note: String(b.note || '').slice(0, 1000) || null, docDate }, req.user);
  await logAudit({ userId: req.user.id, action: `Evidence added: ${kind}`, entity: 'AtsPlusItem', entityId: it.id, toValue: title });
  res.status(201).json({ id: it.id });
}));
router.delete('/evidencez/items/:id', S.adminOnly, S.wrap(async (req, res) => {
  const it = await S.items.get(req.params.id, 'evidence-z'); if (!it) return res.status(404).json({ error: 'Not found.' });
  await S.items.remove(it.id);
  await logAudit({ userId: req.user.id, action: `Evidence removed: ${it.status}`, entity: 'AtsPlusItem', entityId: it.id, toValue: it.title });
  res.json({ ok: true });
}));
router.post('/evidencez/confirm', S.adminOnly, S.wrap(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only the Super Admin (the founder) confirms the data region and the SLA.' });
  const what = ['residency', 'sla'].includes((req.body || {}).what) ? req.body.what : null; if (!what) return res.status(400).json({ error: 'residency or sla' });
  const b = await bundle();
  const value = what === 'residency' ? `${b.stated.region}; backups ${b.stated.backupLocation}` : `${b.sla.uptimeTarget}% uptime; P1 ${b.sla.response.P1}, P2 ${b.sla.response.P2}, P3 ${b.sla.response.P3}`;
  const cur = await S.settings.get(CONF_KEY, { residency: null, sla: null });
  const next = { ...cur, [what]: { value, by: req.user.name, at: new Date().toISOString(), note: String((req.body || {}).note || '').slice(0, 300) || null, evidence: b.items.filter((x) => (what === 'residency' ? ['Hosting region', 'Backup location'] : ['SLA contract']).includes(x.kind)).length } };
  await S.settings.set(CONF_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: what === 'residency' ? 'Data region confirmed by the founder' : 'SLA commitment confirmed by the founder', entity: 'AtsPlusSetting', entityId: CONF_KEY, toValue: value });
  res.json(next);
}));
router.get('/evidencez/pack', S.adminOnly, S.wrap(async (req, res) => {
  const b = await bundle();
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data region and SLA evidence</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1f2937}table{border-collapse:collapse;width:100%;margin:8px 0 18px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:14px;vertical-align:top}th{background:#f9fafb;width:32%}.flag{color:#b42318}</style></head><body>
<h1>Data region and SLA evidence</h1><p>Made ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC by ${esc(req.user.name)}.</p>
<h2>Where the data is (stated)</h2><table>${row('Region', b.stated.region)}${row('Hosting provider / city', [b.stated.provider, b.stated.city].filter(Boolean).join(', ') || '-')}${row('Backups', [b.stated.backupLocation, b.stated.backupProvider].filter(Boolean).join(', '))}${row('Sub-processors', b.stated.processors)}${row('Founder confirmation', b.confirmed.residency ? `${b.confirmed.residency.value} - ${b.confirmed.residency.by}, ${b.confirmed.residency.at.slice(0, 10)}` : 'Not confirmed yet')}</table>
<h2>What the server sees</h2><table>${row('Time zone', `${b.seen.timeZone} (UTC${b.seen.utcOffsetMinutes >= 0 ? '+' : ''}${b.seen.utcOffsetMinutes / 60})`)}${row('Server', `${b.seen.hostName} · ${b.seen.platform}`)}${row('Database', `${b.seen.database.engine}${b.seen.database.onThisServer ? ', on this server\'s own disk' : ''}`)}${row('Newest backup', b.seen.backup.latestAt || '-')}${row('Last restore check', b.seen.backup.lastVerify ? `${b.seen.backup.lastVerify.ok ? 'passed' : 'FAILED'} ${b.seen.backup.lastVerify.at || ''}` : '-')}${row('Encrypted off-site copy', b.seen.offsite.set ? `yes, ${b.seen.offsite.storageHost || ''} ${b.seen.offsite.region ? `(${b.seen.offsite.region})` : ''}` : 'not set up')}</table>
${b.flags.length ? `<h2>To check</h2><ul>${b.flags.map((f) => `<li class="flag">${esc(f)}</li>`).join('')}</ul>` : ''}
<h2>Uptime and support (SLA)</h2><table>${row('Uptime target', `${b.sla.uptimeTarget}%`)}${row('Support hours', b.sla.supportHours)}${row('Response times', `P1 ${b.sla.response.P1} · P2 ${b.sla.response.P2} · P3 ${b.sla.response.P3}`)}${row('Service credits', b.sla.credits || '-')}${row('Founder confirmation', b.confirmed.sla ? `${b.confirmed.sla.value} - ${b.confirmed.sla.by}, ${b.confirmed.sla.at.slice(0, 10)}` : 'Not confirmed yet')}</table>
<table><tr><th>Month</th><th>Measured uptime</th><th>Outage minutes</th><th>Target met</th></tr>${b.sla.months.map((m) => `<tr><td>${esc(m.month)}</td><td>${m.uptimePct === null ? 'not measured' : `${m.uptimePct}%`}</td><td>${m.outageMinutes}</td><td>${m.met === null ? '-' : m.met ? 'Yes' : 'No'}</td></tr>`).join('')}</table>
<h2>Evidence documents</h2><table><tr><th>Kind</th><th>Document</th></tr>${b.items.map((x) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.title)}${x.link ? ` - <a href="${esc(x.link)}">${esc(x.link)}</a>` : ''}${x.docDate ? ` (${esc(x.docDate)})` : ''}<br><small>${esc(x.note || '')} · added by ${esc(x.by)} ${esc(String(x.at).slice(0, 10))}</small></td></tr>`).join('') || '<tr><td colspan="2">None yet.</td></tr>'}</table>
<p><small>Certifications (SOC 2, ISO 27001, ISO 42001) are not held; this page is the company's own statement with the server's own facts.</small></p></body></html>`;
  await logAudit({ userId: req.user.id, action: 'Data region and SLA evidence pack downloaded', entity: 'AtsPlusSetting', entityId: CONF_KEY });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="teamlink-region-sla-evidence-${new Date().toISOString().slice(0, 10)}.html"`);
  res.send(html);
}));

const publicRouter = express.Router();
const { rateLimit } = require('../publicRateLimit');
publicRouter.get('/sla-history', rateLimit({ bucket: 'status-pages', max: 240, windowMs: 10 * 60000 }), S.wrap(async (req, res) => {
  const ST = require('./status'); // eslint-disable-line global-require
  const s = await ST.settings();
  if (!s.public) return res.status(404).json({ error: 'This page is switched off.' });
  const conf = await S.settings.get(CONF_KEY, { residency: null, sla: null });
  res.json({ months: await monthly(6, s.uptimeTarget), committed: conf.sla ? { by: 'the company founder', at: conf.sla.at } : null, regionConfirmed: conf.residency ? { at: conf.residency.at } : null });
}));

module.exports = { router, publicRouter, seen, compare, monthly, bundle, KINDS };

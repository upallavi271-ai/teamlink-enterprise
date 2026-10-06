// ---------------------------------------------------------------------------
// Administration → System (Super Admin only): backups, the restore test and
// the uptime alert switch. The work itself is utils/backup.js (run in a child
// process, so a backup never blocks the API) and utils/uptimeAlert.js.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const backup = require('../utils/backup');
const uptime = require('../utils/uptimeAlert');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a Super Admin can open System settings.' });
  }
  return next();
});

const isSandbox = () => /^(1|true|yes|on)$/i.test(String(process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX || ''));

router.get('/status', async (req, res) => {
  const b = backup.summary();
  const settings = await uptime.uptimeSettings();
  const state = uptime.readState();
  res.json({
    sandbox: isSandbox(),
    backup: b,
    uptime: {
      settings,
      myEmail: req.user.email || null,
      check: state ? {
        lastCheckAt: state.lastCheckAt || null,
        lastOkAt: state.lastOkAt || null,
        lastResult: state.lastResult || null,
        down: state.down || null,
        history: (state.history || []).slice(0, 5),
        url: state.url || null,
      } : null,
      scriptPath: require('path').join(backup.BACKEND, 'scripts', 'healthcheck-hidden.vbs'),
    },
  });
});

function start(req, res, args, what) {
  const busy = backup.readLock() || (backup.childRunning() ? { what: 'backup' } : null);
  if (busy) return res.status(409).json({ error: `A ${busy.what || 'backup'} is already running. Wait a minute and look again.` });
  backup.runChild(args);
  return res.status(202).json({ started: true, message: `${what} started. This page updates when it is done.` });
}

router.post('/backup', async (req, res) => {
  if (!backup.readLock() && !backup.childRunning()) {
    await logAudit({ userId: req.user.id, action: 'BACKUP_NOW', entity: 'System', entityId: 'backup', actorName: req.user.name || null });
  }
  return start(req, res, ['--reason', 'manual', '--by', req.user.name || req.user.email || 'Super Admin'], 'Backup');
});

router.post('/backup/verify', async (req, res) => start(req, res, ['--verify'], 'Restore test'));

router.put('/uptime-alert', async (req, res) => {
  const enabled = !!(req.body && req.body.enabled === true);
  const before = await uptime.uptimeSettings();
  const next = await uptime.saveUptimeSettings({ enabled }, req.user);
  await logAudit({
    userId: req.user.id, action: 'UPDATE', entity: 'System', entityId: uptime.STORE_ID,
    field: 'uptimeAlert', fieldLabel: 'Uptime alert', fromValue: before.enabled ? 'On' : 'Off', toValue: next.enabled ? 'On' : 'Off',
    actorName: req.user.name || null,
  });
  res.json({
    settings: next,
    message: next.enabled
      ? (next.email ? `Uptime alert is on. Alerts go to the bell and to ${next.email}.` : 'Uptime alert is on, in the bell only — your login email is a test address, so no email is sent.')
      : 'Uptime alert is off. Nothing will be sent.',
  });
});

module.exports = router;

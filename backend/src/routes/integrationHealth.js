// ---------------------------------------------------------------------------
// INTEGRATION HEALTH (Administration) — change list 2026-10-03 §16 and spec
// "rejections-logins-followups" §E (fix now: Job Portal "82 failed", Email
// "2 failed", eSSL port, Claude credits).
//
//   GET  /api/admin/integration-health
//        One card per connection — Job Portal sync, Email, eSSL attendance
//        device, AI (Claude) credits — each with: status in plain words, the
//        failed count with the reasons GROUPED, a "Fix" hint, and which Retry
//        the screen may offer. READ-ONLY: it contacts nothing, sends nothing,
//        and never returns a key, password or token (only "set" / "not set").
//
//   POST /api/admin/integration-health/email/retry
//        Puts FAILED emails back in the queue — only when a person presses
//        the button. A message that failed because the candidate had no email
//        address is re-addressed from the candidate's CURRENT record; if there
//        is still no address it stays failed and says so. Nothing else is
//        retried here: the other cards' Retry buttons call the existing
//        endpoints (Job Portal sync, biometric check, AI test), which are
//        already person-pressed and audited.
//
// The attendance import and the biometric code are NOT touched (agent rules):
// the eSSL card only reads the device row and gives configuration hints.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { isSandbox } = require('../utils/sandbox');

const router = express.Router();
router.use(requireAuth);

const VIEW = requirePerm(null, 'administration', 'Integrations', 'view');
const CONFIGURE = requirePerm(null, 'administration', 'Integrations', 'configure');

const clean = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- Job Portal -------------------------------------------------------------
// The sync log mixes whole RUNS that could not start ("Job Portal sync
// (startup) failed: …") with single JOBS the portal did not take. Both are
// grouped by their cause, in words.
function portalCause(reason) {
  const t = clean(reason);
  if (/not reachable at/i.test(t)) {
    const url = (t.match(/not reachable at (\S+)/i) || [])[1] || 'its address';
    return { key: 'down', text: `The Job Portal app was not running (TeamLink could not reach it at ${url}).` };
  }
  if (/Cannot (POST|PUT)|answered 404/i.test(t)) return { key: 'old', text: 'The Job Portal app was an old version without the sync link.' };
  if (/did not answer in time/i.test(t)) return { key: 'slow', text: 'The Job Portal was too slow to answer.' };
  if (/SYNC_TOKEN|secret|answered 401|answered 403/i.test(t)) return { key: 'key', text: 'The Job Portal key is missing or wrong on the server.' };
  if (/SANDBOX/i.test(t)) return { key: 'sandbox', text: 'Test copy — the Job Portal is never contacted from here.' };
  if (/Duplicate application/i.test(t)) return { key: 'dup', text: 'Somebody applied twice to the same job (the second one was not added — correct).' };
  if (/does not exist/i.test(t)) return { key: 'gone', text: 'An application came for a job that was deleted here.' };
  return { key: 'other', text: t.slice(0, 160) || 'Unknown reason.' };
}
const PORTAL_FIX = {
  down: 'Keep the Job Portal app running (on the server, run it under pm2 like TeamLink). Then press Try sync now.',
  old: 'Update the Job Portal app to the latest version, then press Try sync now.',
  slow: 'Check the server is not overloaded, then press Try sync now.',
  key: 'Ask the person who set up the server to check the Job Portal keys in backend/.env (names only: JOB_PORTAL_SYNC_TOKEN, JOB_PORTAL_PUSH_SECRET).',
  sandbox: 'Nothing to fix — this is the test copy.',
  dup: 'Nothing to fix.',
  gone: 'Nothing to fix — the job no longer exists.',
  other: 'Read the reason, fix it, then press Try sync now.',
};

async function jobPortalCard() {
  // eslint-disable-next-line global-require
  const bridge = require('../utils/jobPortalBridge');
  const cfg = bridge.status();
  const [lastGood, failedRows, failedJobs, lastRun] = await Promise.all([
    prisma.syncLog.findFirst({ where: { entity: 'Requirements', status: 'Success', reason: { startsWith: 'Job Portal sync' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.syncLog.findMany({ where: { status: 'Failed' }, select: { entity: true, reason: true, recordRef: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
    prisma.requirement.findMany({ where: { portalPublished: true, portalSyncStatus: 'Failed' }, select: { id: true, reqCode: true, title: true } }),
    prisma.syncLog.findFirst({ where: { entity: 'Requirements', reason: { startsWith: 'Job Portal sync' } }, orderBy: { createdAt: 'desc' }, select: { status: true, reason: true, createdAt: true } }),
  ]);
  const since = lastGood ? lastGood.createdAt : null;
  const open = failedRows.filter((r) => !since || r.createdAt > since);
  const groups = new Map();
  failedRows.forEach((r) => {
    const c = portalCause(r.reason);
    const g = groups.get(c.key) || { key: c.key, reason: c.text, count: 0, sinceLastGood: 0, first: r.createdAt, last: r.createdAt, fix: PORTAL_FIX[c.key] };
    g.count += 1;
    if (!since || r.createdAt > since) g.sinceLastGood += 1;
    if (r.createdAt < g.first) g.first = r.createdAt;
    if (r.createdAt > g.last) g.last = r.createdAt;
    groups.set(c.key, g);
  });
  const sandbox = isSandbox();
  const lastFailed = lastRun && lastRun.status === 'Failed';
  let status; let tone; let message;
  // BUILT IN (2026-10-05): the job portal is this app's /careers, on this
  // database. Nothing to sync, nothing to reach; the old failed tries are history.
  if (cfg.builtIn) {
    const live = await prisma.requirement.count({ where: { portalPublished: true, portalSyncStatus: 'Synced' } });
    return {
      id: 'jobportal',
      name: 'Job Portal',
      status: 'Built in',
      tone: 'green',
      message: `Built in — the job portal is part of TeamLink (${cfg.url}). No sync needed. ${live} job${live === 1 ? '' : 's'} on it now; applications reach Candidates at once.`,
      failedTotal: failedRows.length,
      failedSinceLastGood: open.length,
      lastGoodAt: since,
      lastRunAt: lastRun ? lastRun.createdAt : null,
      jobsNotOnPortal: [],
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
      lostData: false,
      note: 'These are old tries from when the job portal was a separate app. Nothing to fix — it is built in now.',
      fix: 'Nothing to fix.',
      retry: null,
    };
  }
  if (sandbox) { status = 'Test copy'; tone = 'orange'; message = 'This is the test copy — the Job Portal is never contacted from here.'; }
  else if (!cfg.configured) { status = 'Not set up'; tone = 'orange'; message = 'The Job Portal keys are not set on this server, so nothing is synced.'; }
  else if (lastFailed) { status = 'Problem'; tone = 'red'; message = `The last sync did not work: ${portalCause(lastRun.reason).text}`; }
  else if (failedJobs.length) { status = 'Problem'; tone = 'red'; message = `${failedJobs.length} job${failedJobs.length === 1 ? ' is' : 's are'} not on the Job Portal yet.`; }
  else { status = 'Working'; tone = 'green'; message = 'Jobs and applications are syncing.'; }
  return {
    id: 'jobportal',
    name: 'Job Portal sync',
    status,
    tone,
    message,
    failedTotal: failedRows.length,
    failedSinceLastGood: open.length,
    lastGoodAt: since,
    lastRunAt: lastRun ? lastRun.createdAt : null,
    jobsNotOnPortal: failedJobs.map((j) => ({ id: j.id, reqCode: j.reqCode, title: j.title })),
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    lostData: false,
    note: 'A failed sync run does not lose any candidate or application: the next run that works sends every open job again and pulls the last 90 days of applications.',
    fix: groups.size ? [...groups.values()].sort((a, b) => b.sinceLastGood - a.sinceLastGood)[0].fix : 'Nothing to fix.',
    retry: { label: 'Try sync now', method: 'post', url: '/admin/integrations/job-portal/sync' },
  };
}

// ---- Email --------------------------------------------------------------------
function emailCause(row) {
  const t = clean(row.lastError || row.statusDetail);
  if (/no recipient address|no email address/i.test(t)) return { key: 'noaddr', text: 'The candidate has no email address on file.' };
  if (/EAUTH|535|auth/i.test(t)) return { key: 'auth', text: 'The mail server refused the email login (user name or password wrong).' };
  if (/ETIMEDOUT|Greeting never received|ECONNREFUSED|ENOTFOUND/i.test(t)) return { key: 'conn', text: 'TeamLink could not reach the mail server.' };
  if (/5\d\d|rejected|mailbox|does not exist|invalid/i.test(t)) return { key: 'bounced', text: 'The mail server refused the address.' };
  return { key: 'other', text: t.slice(0, 160) || 'Unknown reason.' };
}
const EMAIL_FIX = {
  noaddr: 'Open the candidate, add their email address, then press Send failed emails again.',
  auth: 'Check the email user name and password in Administration → Integrations → Email, then press Send failed emails again.',
  conn: 'Check the mail server name and port in Administration → Integrations → Email (for example port 465 with SSL), then press Send failed emails again.',
  bounced: 'Check the email address on the candidate, then press Send failed emails again.',
  other: 'Read the reason, fix it, then press Send failed emails again.',
};

async function emailCard() {
  // eslint-disable-next-line global-require
  const { emailConfig } = require('../utils/mailer');
  const cfg = await emailConfig().catch(() => ({ configured: false }));
  const [failed, sent, row] = await Promise.all([
    prisma.candidateMessage.findMany({
      where: { channel: 'Email', status: 'FAILED' },
      select: { id: true, lastError: true, statusDetail: true, createdAt: true, subject: true, templateLabel: true, candidate: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.candidateMessage.count({ where: { channel: 'Email', status: 'SENT' } }),
    prisma.integration.findUnique({ where: { id: 'email' }, select: { lastTest: true, lastTestResult: true } }),
  ]);
  const groups = new Map();
  failed.forEach((m) => {
    const c = emailCause(m);
    const g = groups.get(c.key) || { key: c.key, reason: c.text, count: 0, fix: EMAIL_FIX[c.key] };
    g.count += 1;
    groups.set(c.key, g);
  });
  const sandbox = isSandbox();
  let status; let tone; let message;
  if (!cfg.configured) { status = 'Not set up'; tone = 'orange'; message = 'No mail server is set up, so emails are recorded but not sent.'; }
  else if (failed.length) { status = 'Problem'; tone = 'red'; message = `${failed.length} email${failed.length === 1 ? '' : 's'} could not be sent.`; }
  else { status = 'Working'; tone = 'green'; message = sent ? `${sent} email${sent === 1 ? '' : 's'} sent, none failed.` : 'Set up. No email has failed.'; }
  if (sandbox) message += ' (Test copy: emails here go to a fake mail box — nobody receives them.)';
  return {
    id: 'email',
    name: 'Email',
    status,
    tone,
    message,
    failedTotal: failed.length,
    sent,
    server: cfg.configured ? { host: cfg.host || null, port: cfg.port || null } : null,
    lastTest: row && row.lastTest ? { at: row.lastTest, result: clean(row.lastTestResult).slice(0, 200) } : null,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    items: failed.slice(0, 25).map((m) => ({
      id: m.id,
      candidateId: m.candidate ? m.candidate.id : null,
      candidate: m.candidate ? m.candidate.name : '—',
      hasEmailNow: !!(m.candidate && m.candidate.email && String(m.candidate.email).trim()),
      what: m.templateLabel || m.subject || 'Email',
      at: m.createdAt,
      reason: emailCause(m).text,
    })),
    fix: groups.size ? [...groups.values()][0].fix : 'Nothing to fix.',
    retry: failed.length ? { label: 'Send failed emails again', method: 'post', url: '/admin/integration-health/email/retry' } : null,
  };
}

// ---- eSSL device ------------------------------------------------------------------
async function biometricCard() {
  // eslint-disable-next-line global-require
  const bio = require('../utils/biometricDevice');
  const [device, row] = await Promise.all([
    prisma.biometricDevice.findFirst({ orderBy: { createdAt: 'asc' } }),
    prisma.integration.findUnique({ where: { id: 'biometric' }, select: { lastTest: true, lastTestResult: true } }),
  ]);
  const st = bio.deviceState(device);
  let host = null; let port = null;
  if (device && device.endpoint) {
    try { const u = new URL(device.endpoint); host = u.hostname; port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { host = null; }
  }
  const appPort = Number(process.env.PORT) || 4010;
  const hints = [];
  let status; let tone; let message;
  if (!device) {
    status = 'Not set up'; tone = 'orange'; message = 'No attendance device is saved yet.';
    hints.push('Add the device in Administration → Integrations → Biometric.');
  } else if (st.state === 'Connected') {
    status = 'Working'; tone = 'green'; message = `The device is calling in (last ${Math.round(st.ageMs / 1000)} seconds ago).`;
  } else if (st.state === 'Inactive') {
    status = 'Switched off'; tone = 'orange'; message = 'The device is switched off in TeamLink.';
    hints.push('Switch it on in Administration → Integrations → Biometric.');
  } else {
    status = 'Problem'; tone = 'red';
    message = st.state === 'Offline'
      ? `The device stopped calling in. Last call: ${new Date(device.lastSeenAt).toLocaleString('en-IN')}.`
      : 'The device has never called TeamLink.';
    hints.push(`On the device: Menu → COMM → Cloud Server (ADMS). Server address ${host || 'your server IP'}, Server port ${port || appPort}, HTTPS off, Domain name off. The port on the device must be the SAME as in TeamLink (${port || appPort}).`);
    hints.push(`On the server: allow incoming TCP port ${port || appPort} in the firewall, and check http://${host || 'server'}:${port || appPort}/iclock/cdata opens from outside.`);
    hints.push('The device needs internet (or the same network as the server). Restart the device after changing the settings.');
    const testedPort = row && row.lastTestResult ? (String(row.lastTestResult).match(/:(\d{2,5})\/iclock/) || [])[1] : null;
    if (testedPort && port && Number(testedPort) !== port) {
      hints.push(`The last check was for port ${testedPort}, but TeamLink now expects port ${port}. Set port ${port} on the device too, then press Check again.`);
    }
    if (/localhost|127\.0\.0\.1/.test(String(host))) hints.push('The address is "localhost" — the device cannot reach that. Use the server\'s real IP address.');
    if (/^(72\.|[0-9]+\.)/.test(String(host)) && !/localhost/.test(String(host))) {
      hints.push('The device calls the online server, so its heartbeat shows on the online TeamLink — not on a copy running on a laptop.');
    }
  }
  return {
    id: 'biometric',
    name: 'eSSL attendance device',
    status,
    tone,
    message,
    device: device ? {
      vendor: device.vendor, serial: device.serialNumber, host, port, endpoint: device.endpoint,
      lastSeenAt: device.lastSeenAt, lastSeenIp: device.lastSeenIp, punchesReceived: device.punchesReceived,
    } : null,
    unknownDevices: (bio.listUnknown() || []).slice(0, 5),
    lastError: row && row.lastTestResult && !/^Connected/.test(row.lastTestResult) ? { at: row.lastTest, text: clean(row.lastTestResult).slice(0, 240) } : null,
    fix: hints.join(' ') || 'Nothing to fix.',
    hints,
    retry: device ? { label: 'Check again', method: 'post', url: '/admin/integrations/biometric/test' } : null,
  };
}

// ---- AI (Claude) --------------------------------------------------------------------
async function aiCard() {
  const row = await prisma.integration.findUnique({ where: { id: 'ai-claude' }, select: { state: true, connected: true, lastTest: true, lastTestResult: true, error: true } });
  let live = null;
  try {
    // Configuration-only status (no network call, no tokens spent).
    // eslint-disable-next-line global-require
    live = await require('../utils/ai').checkStatus();
  } catch { live = null; }
  const last = clean((row && (row.lastTestResult || row.error)) || '');
  const noCredit = /credit balance is too low|no API credits|purchase credits/i.test(`${last} ${live && live.reason ? live.reason : ''}`);
  const badKey = /401|rejected the (stored )?API key|invalid x-api-key/i.test(`${last} ${live && live.reason ? live.reason : ''}`);
  let status; let tone; let message; let fix;
  if (isSandbox()) {
    status = 'Test copy'; tone = 'orange'; message = 'AI is switched off in the test copy.'; fix = 'Nothing to fix here.';
  } else if (noCredit) {
    status = 'No credits'; tone = 'red';
    message = 'The Claude account has run out of credits, so AI features (resume reading, fit reasons, the assistant) are off. Everything else works, using the free tools.';
    fix = 'The account owner buys credits at console.anthropic.com → Plans & Billing. Then press Test again here. The API key does not need to change.';
  } else if (badKey) {
    status = 'Key refused'; tone = 'red'; message = 'Claude refused the saved API key.';
    fix = 'Enter a new key in Administration → Integrations → AI Assistant (never paste it in chat), then press Test again.';
  } else if (live && live.available) {
    status = 'Working'; tone = 'green'; message = 'AI is set up.'; fix = 'Nothing to fix.';
  } else {
    status = 'Not set up'; tone = 'orange'; message = (live && live.reason) ? clean(live.reason).slice(0, 200) : 'AI is not set up.';
    fix = 'Add the Anthropic API key in Administration → Integrations → AI Assistant.';
  }
  return {
    id: 'ai',
    name: 'AI (Claude) credits',
    status,
    tone,
    message,
    lastTest: row && row.lastTest ? { at: row.lastTest, result: last.slice(0, 240) } : null,
    fix,
    retry: { label: 'Test again', method: 'post', url: '/admin/integrations/ai-claude/test-message', note: 'Sends one tiny test message to Claude (uses a few credits).' },
  };
}

router.get('/', VIEW, async (req, res, next) => {
  try {
    const [jobPortal, email, biometric, ai, mayRetry] = await Promise.all([
      jobPortalCard(), emailCard(), biometricCard(), aiCard(),
      can(req.user, null, 'administration', 'Integrations', 'configure'),
    ]);
    const items = [jobPortal, email, biometric, ai];
    res.json({
      sandbox: isSandbox(),
      checkedAt: new Date(),
      problems: items.filter((i) => i.tone === 'red').length,
      items: items.map((i) => ({ ...i, retry: mayRetry ? i.retry : null })),
      canRetry: !!mayRetry,
    });
  } catch (err) { next(err); }
});

// Put FAILED emails back in the queue — only on a person's click.
router.post('/email/retry', CONFIGURE, async (req, res, next) => {
  try {
    const only = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    const rows = await prisma.candidateMessage.findMany({
      where: { channel: 'Email', status: 'FAILED', ...(only ? { id: { in: only } } : {}) },
      include: { candidate: { select: { id: true, name: true, email: true } } },
      take: 200,
    });
    let queued = 0; let stillNoAddress = 0;
    for (const m of rows) {
      const email = m.candidate && m.candidate.email ? String(m.candidate.email).trim() : '';
      const noAddr = emailCause(m).key === 'noaddr';
      if (noAddr && !email) { stillNoAddress += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidateMessage.update({
        where: { id: m.id },
        data: {
          ...(noAddr ? { recipient: email } : {}),
          status: 'QUEUED', statusDetail: `Queued again by ${req.user.name}.`, nextAttemptAt: null, attempts: 0,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Failed email queued again', entity: 'CandidateMessage', entityId: m.id, fromValue: 'FAILED', toValue: 'QUEUED' });
      queued += 1;
    }
    // eslint-disable-next-line global-require
    if (queued) require('../utils/mailWorker').kick();
    const parts = [];
    if (queued) parts.push(`${queued} email${queued === 1 ? '' : 's'} queued again`);
    if (stillNoAddress) parts.push(`${stillNoAddress} still ha${stillNoAddress === 1 ? 's' : 've'} no email address on the candidate — add it first`);
    res.json({ ok: true, queued, stillNoAddress, message: parts.length ? `${parts.join('; ')}.` : 'Nothing to send again.' });
  } catch (err) { next(err); }
});

module.exports = router;

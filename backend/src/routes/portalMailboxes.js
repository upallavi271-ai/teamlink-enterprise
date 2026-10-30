// ---------------------------------------------------------------------------
// /api/portal-mailboxes — Administration -> Integrations -> "Naukri & Shine mailboxes" (founder, 2026-10-29).
//
// The mailbox that receives Naukri responses, and the one that receives Shine responses, each connected to ONE
// recruiter. The engine is the Job Portal's own (Naukri & Shine Email Import, 0135): it logs in to the mailbox for
// real (IMAP over SSL) BEFORE anything is saved, seals the app password and never sends it back, reads the mail and
// imports the applications into that recruiter's records. TeamLink reaches it server to server through the portal
// bridge (job-portal-app/embed/teamlink-integration.mjs, .../mailboxes, JOB_PORTAL_SYNC_TOKEN); nothing is stored here.
//
//   GET  /                     connections + recruiters (department, employee id, active) + departments
//   POST /                     connect { source, department, recruiterId, address, provider, username?, appPassword, host?, port?, takeOver? }
//   POST /:id/sync | /:id/reconnect { appPassword? } | /:id/disconnect | /:id/reassign { recruiterId, confirm }
//   POST /:id/position { seat, confirm }   the mailbox belongs to an HRMS position and follows its holder (utils/mailboxSeats.js)
//   POST / with { seat } instead of { recruiterId }: connect a mailbox to a position
//   GET  /:id/logs
//
// Super Admin and Admin (Integrations: view to read, configure to change). Every change is also in TeamLink's audit log.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { portalFetch } = require('../utils/jobPortalBridge');

const router = express.Router();
router.use(requireAuth);

const view = requirePerm(null, 'administration', 'Integrations', 'view');
const change = requirePerm(null, 'administration', 'Integrations', 'configure');
const BASE = '/integrations/teamlink/mailboxes';
const CONN = `${BASE}/intake/source-connections`;
const BOARD = { naukri: 'Naukri', shine: 'Shine' };

// The portal's answer, passed on as it is (its words, its field errors); "not running / not set up" said plainly.
function send(res, err) {
  if (err && err.status && err.portalError) return res.status(err.status).json({ error: err.portalError });
  const message = err && err.notConfigured
    ? `The Job Portal is not linked to TeamLink on this server (${err.message}).`
    : `The Job Portal could not be reached: ${(err && err.message) || 'no answer'}.`;
  return res.status(err && err.notConfigured ? 503 : 502).json({ error: { code: 'PORTAL_UNAVAILABLE', message } });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => send(res, err));
const idPath = (id) => `${CONN}/${encodeURIComponent(String(id))}`;
const audit = (req, action, entityId, toValue) => logAudit({
  userId: req.user.id, action, entity: 'PortalMailbox', entityId: entityId ? String(entityId) : undefined, toValue,
});

// HRMS DECIDES WHO IS LISTED (founder 2026-10-29: "exist ina employee chupichakudadhu valla positions lo new employee automatic ga
// ravali"): the recruiters offered are the CURRENT holders of HRMS Recruiter / TL / STL seats (utils/jobPortalRecruiters.js), each
// with a portal recruiter login made / linked by email and the seat's department. Someone who left or was moved off the seat is not
// offered; a mailbox still connected to them is flagged (pastHolder) with the seat's new holder for a one-click Reassign. Nothing is
// moved by itself, nothing is deleted: candidates already imported stay where they are.
async function holderList() {
  const R = require('../utils/jobPortalRecruiters'); // eslint-disable-line global-require
  const positions = await R.seatData();
  const holders = await R.people(positions);
  return { R, positions, holders, byEmail: new Map(holders.map((h) => [h.email, h])) };
}
async function currentRecruiters() {
  const recs = await portalFetch(`${BASE}/recruiters`, { timeoutMs: 20000 });
  const h = await holderList();
  const all = recs.recruiters || [];
  const listed = all.filter((r) => h.byEmail.has(String(r.email || '').toLowerCase())).map((r) => {
    const p = h.byEmail.get(String(r.email || '').toLowerCase());
    return { ...r, name: p.name || r.name, department: p.department || r.department, team: p.team || undefined, employeeId: p.employeeId || r.employeeId, seat: p.seats.join(', ') };
  });
  return { ...h, all, listed };
}

router.get('/', view, wrap(async (req, res) => {
  // a Recruiter / TL placed on a seat in HRMS just now is in the list too; waits at most 15 s, never fails the screen
  // ...and a mailbox mapped to a position follows that position's holder (utils/mailboxSeats.js) before it is shown
  const S = require('../utils/mailboxSeats'); // eslint-disable-line global-require
  await Promise.race([
    require('../utils/jobPortalRecruiters').ensureQuietly().then(() => S.reconcileQuietly()), // eslint-disable-line global-require
    new Promise((r) => { setTimeout(r, 15000); }),
  ]);
  const [conns, cur, map] = await Promise.all([portalFetch(CONN, { timeoutMs: 20000 }), currentRecruiters(), S.loadMap()]);
  const seats = await S.seatsWithRecruiters(cur.all);
  const seatBy = new Map(seats.map((x) => [x.code, x]));
  const byId = new Map(cur.all.map((r) => [r.id, r]));
  const listedIds = new Set(cur.listed.map((r) => r.id));
  const recOfEmail = new Map(cur.listed.map((r) => [String(r.email || '').toLowerCase(), r]));
  const connections = [];
  for (const c of conns.connections || []) {
    const was = byId.get(c.recruiterId);
    const current = listedIds.has(c.recruiterId);
    const row = { ...c, recruiterDepartment: (cur.listed.find((r) => r.id === c.recruiterId) || was || {}).department || undefined };
    const mapped = map[c.id] && seatBy.get(map[c.id].seat);
    if (map[c.id]) {
      // MAPPED TO A POSITION: the mailbox is the seat's; its recruiter is whoever holds the seat today
      row.seat = map[c.id].seat;
      row.recruiterDepartment = (mapped && mapped.department) || row.recruiterDepartment;
      if (!mapped || !mapped.holder) row.seatNote = `Nobody holds ${map[c.id].seat} in HRMS today: new imports stay with ${c.recruiterName || 'the last recruiter'} until someone joins`;
      else if (!mapped.holderRecruiterId) row.seatNote = `${mapped.holder.name} holds ${map[c.id].seat}: their Job Portal login is being made, the mailbox moves to them in a minute`;
    } else if (!current && c.recruiterId) {
      // eslint-disable-next-line no-await-in-loop
      const next = was ? await cur.R.successorOf(was.email, cur.positions) : null;
      const rec = next && next.holder ? recOfEmail.get(next.holder.email) : null;
      row.pastHolder = true;
      row.pastHolderNote = next ? `No longer holds ${next.seat} in HRMS` : 'Does not hold a Recruiter / TL seat in HRMS';
      if (rec) row.replacement = { recruiterId: rec.id, name: rec.name, seat: next.seat };
    }
    if (!map[c.id]) {
      // NOT MAPPED YET (connected before 2026-10-29): suggest the seat the recruiter holds, or held last
      const mine = was ? seats.find((x) => x.holder && x.holder.email === String(was.email || '').toLowerCase()) : null;
      // eslint-disable-next-line no-await-in-loop
      const last = !mine && was ? await cur.R.successorOf(was.email, cur.positions) : null;
      row.suggestedSeat = (mine && mine.code) || (last && last.seat) || undefined;
    }
    connections.push(row);
  }
  res.json({
    connections,
    recruiters: cur.listed,
    names: Object.fromEntries(cur.all.map((r) => [r.id, r.name])), // past holders too, for the mailbox history (View logs)
    // the positions a mailbox can belong to: department (seat code), team, today's holder
    seats: seats.map((x) => ({ code: x.code, kind: x.kind, department: x.department, team: x.team, holderName: x.holder ? x.holder.name : null, holderRecruiterId: x.holderRecruiterId })),
    departments: [...new Set(cur.listed.map((r) => String(r.department || '').trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y)),
    providers: conns.providers || [],
    // the last Naukri / Shine -> ATS Applications run: added, already there, waiting for a requirement (with the job titles)
    atsImport: require('../utils/mailImports').lastRun(), // eslint-disable-line global-require
    // the requirements a waiting title can be linked to by hand (open first)
    requirements: await require('../db').requirement.findMany({ select: { id: true, title: true, department: true, status: true, client: { select: { name: true } } }, orderBy: [{ status: 'desc' }, { createdAt: 'desc' }], take: 1500 }).catch(() => []), // eslint-disable-line global-require
    canStoreCredentials: conns.canStoreCredentials,
  });
}));

// connect / reassign only to a current seat holder (the screen offers only them; this is the server's own check)
async function refuseNonHolder(res, recruiterId) {
  const cur = await currentRecruiters();
  if (cur.listed.some((r) => r.id === recruiterId)) return false;
  const message = 'Choose a recruiter who holds a Recruiter / TL seat in HRMS now. Someone who left or moved off the seat cannot get a mailbox.';
  res.status(422).json({ error: { code: 'VALIDATION_FAILED', message, details: { recruiterId: message } } });
  return true;
}

const seatRefused = (res, message) => res.status(422).json({ error: { code: 'VALIDATION_FAILED', message, details: { seat: message } } });

router.post('/', change, wrap(async (req, res) => {
  const b = { ...(req.body || {}) };
  const S = require('../utils/mailboxSeats'); // eslint-disable-line global-require
  // CONNECTED TO A POSITION (2026-10-29): the seat is chosen; its holder today is the recruiter the portal gets
  if (b.seat) {
    await require('../utils/jobPortalRecruiters').ensureQuietly(); // eslint-disable-line global-require
    const seat = (await S.seatsWithRecruiters()).find((x) => x.code === String(b.seat));
    if (!seat) return seatRefused(res, 'That position is not an active Recruiter / TL seat in HRMS.');
    if (!seat.holderRecruiterId) return seatRefused(res, `Nobody holds ${seat.code} in HRMS today. A mailbox needs the position's recruiter to start with.`);
    b.recruiterId = seat.holderRecruiterId;
    b.department = seat.department || b.department;
  } else if (await refuseNonHolder(res, b.recruiterId)) return undefined;

  // THE MAILBOX IS ALREADY CONNECTED (founder 2026-10-29: "mail already unna kudaa shine and naukri maill vere person kii add chestey
  // tisukovaliii already connected to another mail anii ravodhuu"): the SAME connection is moved to the chosen position / recruiter -
  // no second connection. A new app password typed here is tested and saved on it first (nothing moves if the login fails); without
  // one the saved password stays. The old recruiter / position is no longer linked; candidates it already imported stay with them.
  const addr = String(b.address || '').trim().toLowerCase();
  const had = addr ? ((await portalFetch(CONN, { timeoutMs: 20000 })).connections || []).find((x) => String(x.address || '').trim().toLowerCase() === addr && x.source === b.source) : null;
  if (had) {
    const wasName = had.recruiterName || 'its recruiter';
    const wasSeat = (await S.loadMap())[had.id];
    if (b.appPassword) {
      await portalFetch(`${idPath(had.id)}/reconnect`, { method: 'POST', body: { appPassword: b.appPassword, ...(b.username ? { username: b.username } : {}) }, timeoutMs: 75000 });
    } else if (had.status === 'disconnected') {
      return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: `${had.address} was disconnected, so its saved password was erased. Enter the app password.`, details: { appPassword: 'Enter the app password.' } } });
    }
    let out = { connection: had };
    if (had.recruiterId !== b.recruiterId) out = await portalFetch(`${idPath(had.id)}/reassign`, { method: 'POST', body: { recruiterId: b.recruiterId, confirm: true } });
    if (b.seat) await S.setSeat(had.id, b.seat, req.user);
    else if (wasSeat) { const m = await S.loadMap(); delete m[had.id]; await S.saveMap(m); }
    const nowName = (out.connection && out.connection.recruiterName) || b.recruiterId;
    const from = `${wasName}${wasSeat ? ` (${wasSeat.seat})` : ''}`;
    const to = `${nowName}${b.seat ? ` (${b.seat})` : ''}`;
    await audit(req, `${BOARD[b.source] || 'Portal'} mailbox moved (it was already connected)`, had.id, `${had.address}: ${from} -> ${to}${b.appPassword ? ', new app password' : ''}`);
    return res.status(200).json({
      ...out,
      moved: true,
      message: from === to
        ? `${had.address} was already connected to ${to}.${b.appPassword ? ' Its app password was updated.' : ''}`
        : `This mailbox was with ${from} - it is now with ${to}. ${b.appPassword ? 'The new app password was saved. ' : 'The saved app password was kept. '}New imports go to ${nowName}; candidates imported earlier stay with ${wasName}.`,
    });
  }
  const body = {
    source: b.source, department: b.department || undefined, recruiterId: b.recruiterId, address: b.address, provider: b.provider,
    username: b.username || undefined, appPassword: b.appPassword, host: b.host || undefined, port: b.port || undefined,
    takeOver: b.takeOver === true ? true : undefined,
  };
  // the mail server is asked to log in before anything is saved: allow it its own wait (60 s) and a little more
  const out = await portalFetch(CONN, { method: 'POST', body, timeoutMs: 75000 });
  if (b.seat && out.connection && out.connection.id) await S.setSeat(out.connection.id, b.seat, req.user);
  const who = (out.connection && out.connection.recruiterName) || b.recruiterId;
  await audit(req, `${BOARD[b.source] || 'Portal'} mailbox connected`, out.connection && out.connection.id, `${b.address} -> ${b.seat ? `position ${b.seat} (${who})` : who}`);
  return res.status(201).json(out);
}));

// MAP A MAILBOX TO A POSITION (or move it to another): the same connection and app password; it goes to that seat's holder now and
// to every later holder by itself. { seat, confirm: true }
router.post('/:id/position', change, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.confirm !== true) return seatRefused(res, 'Tick the box to confirm.');
  const S = require('../utils/mailboxSeats'); // eslint-disable-line global-require
  await require('../utils/jobPortalRecruiters').ensureQuietly(); // eslint-disable-line global-require
  const seat = (await S.seatsWithRecruiters()).find((x) => x.code === String(b.seat || ''));
  if (!seat) return seatRefused(res, 'Choose an active Recruiter / TL position from HRMS.');
  const conns = await portalFetch(CONN, { timeoutMs: 20000 });
  const c = (conns.connections || []).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That mailbox connection could not be found.' } });
  const before = await S.loadMap();
  await S.setSeat(c.id, seat.code, req.user);
  await audit(req, `${c.sourceLabel || 'Portal'} mailbox mapped to position ${seat.code}`, c.id, `${before[c.id] ? before[c.id].seat : (c.recruiterName || '-')} -> ${seat.code}`);
  const moved = (await S.reconcile({ apply: true, actor: req.user, onlyId: c.id }))[0];
  let message;
  if (moved && moved.result === 'moved') message = `${c.address} now belongs to ${seat.code}. New imports go to ${moved.toName}; when someone else takes ${seat.code}, it moves to them by itself. Candidates imported earlier stay with their recruiter.`;
  else if (seat.holder) message = `${c.address} now belongs to ${seat.code} (${seat.holder.name}). When someone else takes ${seat.code}, it moves to them by itself.`;
  else message = `${c.address} now belongs to ${seat.code}. Nobody holds it today: imports stay with ${c.recruiterName || 'the last recruiter'} until someone joins.`;
  if (moved && moved.result === 'failed') message = `${c.address} now belongs to ${seat.code}, but moving it to ${moved.toName} did not work yet (${moved.error}). It is tried again on the next refresh.`;
  return res.json({ ok: true, message, seat: seat.code });
}));

router.post('/:id/sync', change, wrap(async (req, res) => {
  await require('../utils/mailboxSeats').reconcile({ apply: true, actor: req.user, onlyId: req.params.id }).catch(() => []); // eslint-disable-line global-require
  const out = await portalFetch(`${idPath(req.params.id)}/sync`, { method: 'POST', body: {}, timeoutMs: 180000 });
  // the responses just read go straight into the ATS Applications (utils/mailImports.js), not only into the portal
  const mail = await require('../utils/mailImports').pullQuietly({ sinceDays: 14 }); // eslint-disable-line global-require
  const ats = mail && !mail.error
    ? ` ATS Applications: ${mail.added} added${mail.already ? `, ${mail.already} already there` : ''}${mail.waiting ? `, ${mail.waiting} waiting for a requirement with the same job title (${mail.waitingTitles.slice(0, 3).map((x) => `"${x.title}"`).join(', ')}${mail.waitingTitles.length > 3 ? ', ...' : ''})` : ''}.`
    : ` The ATS could not be updated just now (${(mail && mail.error) || 'no answer'}); it is tried again within the hour.`;
  res.json({ ...out, atsImport: mail, message: `${out.message || 'Synced.'}${ats}` });
}));

router.post('/:id/reconnect', change, wrap(async (req, res) => {
  const pw = req.body && req.body.appPassword;
  const out = await portalFetch(`${idPath(req.params.id)}/reconnect`, { method: 'POST', body: pw ? { appPassword: pw } : {}, timeoutMs: 75000 });
  await audit(req, 'Portal mailbox reconnected', req.params.id);
  res.json(out);
}));

router.post('/:id/disconnect', change, wrap(async (req, res) => {
  const out = await portalFetch(`${idPath(req.params.id)}/disconnect`, { method: 'POST', body: {} });
  await audit(req, 'Portal mailbox disconnected', req.params.id);
  res.json(out);
}));

router.post('/:id/reassign', change, wrap(async (req, res) => {
  const b = req.body || {};
  const map = await require('../utils/mailboxSeats').loadMap(); // eslint-disable-line global-require
  if (map[req.params.id]) return seatRefused(res, `This mailbox belongs to position ${map[req.params.id].seat}: its recruiter is whoever holds that seat. Use Change position instead.`);
  if (await refuseNonHolder(res, b.recruiterId)) return undefined;
  const out = await portalFetch(`${idPath(req.params.id)}/reassign`, { method: 'POST', body: { recruiterId: b.recruiterId, confirm: b.confirm === true } });
  await audit(req, 'Portal mailbox reassigned', req.params.id, String(b.recruiterId || ''));
  return res.json(out);
}));

// A Naukri / Shine job title that matches no ATS requirement (or several): the requirement its responses go to, picked by hand.
// { title, requirementId } (requirementId empty = forget it). Then the waiting responses are added at once.
router.post('/ats-title', change, wrap(async (req, res) => {
  const b = req.body || {};
  const M = require('../utils/mailImports'); // eslint-disable-line global-require
  const prisma = require('../db'); // eslint-disable-line global-require
  if (b.requirementId) {
    const r = await prisma.requirement.findUnique({ where: { id: String(b.requirementId) }, select: { id: true, title: true } });
    if (!r) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That requirement could not be found.' } });
  }
  const key = await M.linkTitle(b.title, b.requirementId || null);
  if (!key) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Which job title?' } });
  await audit(req, 'Naukri / Shine job title linked to a requirement', b.requirementId || null, `${String(b.title).slice(0, 120)} -> ${b.requirementId || '(unlinked)'}`);
  const out = await M.pullQuietly({ sinceDays: 120 });
  return res.json({ ok: true, atsImport: out, message: out && !out.error ? `Linked. ATS Applications: ${out.added} added.` : 'Linked. The responses are added on the next sync.' });
}));

router.get('/:id/logs', view, wrap(async (req, res) => {
  res.json(await portalFetch(`${idPath(req.params.id)}/logs`, { timeoutMs: 20000 }));
}));

module.exports = router;

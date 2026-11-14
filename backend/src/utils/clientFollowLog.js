// CLIENT FOLLOW-UP LOG (founder 2026-11-03: "ee sheet lo followups vunnai kadha, avi anni ... import cheyyu. tharvatha comments
// enter cheskovali anna kuda option vundali. comments option recruiters ki, tls ki, bde ki andhariki vundali. vallu ey roju
// followup chesaro teluskovadaniki").
//
// One dated line per follow-up with a client - "02-11-2022 - interviews 4" - the way the BDE desk's Excel sheets keep it:
//   * anyone who works the client (BDE, BDE TL, TL, STL, recruiter, Admin) adds a comment for a day (default today);
//   * the client page and every requirement page of that client show the same log, newest day first, with who wrote it;
//   * an Excel workbook of the BDE desk is imported tab by tab (preview -> pick the client -> import); the same line is never imported twice.
//   * SUB TABS (founder 2026-11-05: "followup tab lo, sub tabs vundela pettu"): Client follow-up · Schedule · Interviews · Notes, as the sheets have them.
//   * ONE PLACE (same day): "clients lo ney followups cheskuntaru": the requirement page has no Follow-ups; a line on the client names the requirement.
//   * EDIT: who wrote a line edits it, a BDE also the lines from a sheet; the BDE TL and Admin edit and delete any line.
//   * STATUS: Running / On hold / Stopped / No requirement, one per client (AppSetting clientwork.<clientId>).
// Rows live in appSetting ('clientlog.<clientId>.<id>'), like the client desk's follow-ups (utils/clientBusiness.js).
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const S = require('./scope');
const D = require('./clientDedupe');

const PREFIX = 'clientlog.';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const keyOf = (clientId, id) => `${PREFIX}${clientId}.${id}`;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const hashOf = (clientId, onDate, note) => crypto.createHash('sha1').update(`${clientId}|${onDate}|${norm(note)}`).digest('hex').slice(0, 20);
function parse(row) {
  try { const v = JSON.parse(row.value); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

// ---- who may look / write ------------------------------------------------------------------------------
const ROLE_LABEL = { admin: 'Admin', mgmt: 'Manager', bde: 'BDE', tl: 'TL', stl: 'STL', recruiter: 'Recruiter', hr: 'HR', accounts: 'Accounts' };
function roleOf(user) {
  if (S.isBdeTl(user)) return { key: 'bdetl', label: 'BDE TL' };
  const k = S.atsViewRole(user);
  return { key: k, label: ROLE_LABEL[k] || '' };
}
// Managers / Asst Managers look only (they are view-only everywhere); clients, candidates and accounts never write here.
const mayWrite = (user) => ['admin', 'bdetl', 'bde', 'tl', 'stl', 'recruiter'].includes(roleOf(user).key);
const mayImport = (user) => ['admin', 'bdetl', 'bde'].includes(roleOf(user).key);
const mayManage = (user) => ['admin', 'bdetl'].includes(roleOf(user).key);
const mayEditLine = (user, e) => mayManage(user) || e.byId === user.id || (roleOf(user).key === 'bde' && e.source === 'sheet');
const FOLLOW_TABS = [['client', 'Client follow-up'], ['schedule', 'Schedule'], ['interview', 'Interviews'], ['notes', 'Notes']];
const cleanTab = (v) => (FOLLOW_TABS.some(([k]) => k === v) ? v : 'client');
const STATUS_PREFIX = 'clientwork.';
async function statusOfClient(clientId) {
  const row = await prisma.appSetting.findUnique({ where: { key: STATUS_PREFIX + clientId } });
  return row ? parse(row) : null;
}
async function writeStatus(user, clientId, status) {
  const value = JSON.stringify({ status, by: user.name || null, at: new Date().toISOString() });
  await prisma.appSetting.upsert({ where: { key: STATUS_PREFIX + clientId }, create: { key: STATUS_PREFIX + clientId, value, updatedById: user.id, updatedByName: user.name || null }, update: { value, updatedById: user.id, updatedByName: user.name || null } });
}
// the client's requirements, for the line's "which requirement"
async function requirementsOf(user, clientId) {
  const rows = await prisma.requirement.findMany({ where: { AND: [{ clientId }, S.requirementWhere(user)] }, select: { id: true, title: true, reqCode: true, status: true }, orderBy: { createdAt: 'desc' }, take: 300 });
  const closed = (r) => /^(CLOSED|CANCELLED)/.test(r.status || '');
  return [...rows.filter((r) => !closed(r)), ...rows.filter(closed)].map((r) => ({ id: r.id, label: [r.reqCode, r.title].filter(Boolean).join(' · '), closed: closed(r) }));
}

// The client this login may see the log of: one of their clients, or the client of a requirement they work on.
async function clientFor(user, { clientId, requirementId }) {
  if (requirementId) {
    const r = await prisma.requirement.findFirst({ where: { AND: [{ id: String(requirementId) }, S.requirementWhere(user)] }, select: { id: true, clientId: true, title: true, reqCode: true } });
    if (!r || !r.clientId) return null;
    const client = await prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } });
    return client ? { client, requirement: r } : null;
  }
  if (!clientId) return null;
  const id = String(clientId);
  let client = await prisma.client.findFirst({ where: { AND: [{ id }, S.clientWhere(user)] }, select: { id: true, name: true } });
  if (!client) {
    const r = await prisma.requirement.findFirst({ where: { AND: [{ clientId: id }, S.requirementWhere(user)] }, select: { id: true } });
    if (r) client = await prisma.client.findUnique({ where: { id }, select: { id: true, name: true } });
  }
  return client ? { client, requirement: null } : null;
}

async function entriesOf(clientId) {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: `${PREFIX}${clientId}.` } } });
  return rows.map(parse).filter(Boolean);
}
const publicEntry = (e, reqNames) => ({
  id: e.id, onDate: e.onDate, note: e.note, topic: e.topic || null,
  byName: e.byName || null, byRole: e.byRole || null, createdAt: e.createdAt,
  source: e.source || 'manual', sheet: e.sheet || null, tab: cleanTab(e.tab), candidate: e.candidate || null, recruiter: e.recruiter || null, editedBy: e.editedBy || null,
  requirementId: e.requirementId || null, requirementLabel: e.requirementId ? (reqNames[e.requirementId] || null) : null,
});
const dmyShort = (d) => { const [y, m, dd] = String(d).split('-'); return `${Number(dd)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`; };
// the call-back day set on each line (utils/followUpReminders.js), for "Call back on ..." on the list
async function withCallBacks(entries) {
  try {
    // only the lines people wrote can carry a call-back (not the logged calls / tasks or the sheet lines)
    const m = await require('./followUpReminders').daysOfEntries(entries.filter((e) => e.source === 'manual').map((e) => e.id).slice(0, 900)); // eslint-disable-line global-require
    return entries.map((e) => (m.has(e.id) ? { ...e, callBackOn: m.get(e.id).remindOn, callBackOpen: m.get(e.id).open } : e));
  } catch { return entries; }
}
const newestFirst = (a, b) => String(b.onDate).localeCompare(String(a.onDate)) || String(b.createdAt).localeCompare(String(a.createdAt));

async function list(user, q) {
  const found = await clientFor(user, q);
  if (!found) return { status: 404, body: { error: 'This client is outside your area.' } };
  // Both Education BDE seats filled: a sheet's lines show to its own seat (utils/bdeSplit.js)
  const { seesLine } = require('./bdeSplit'); // eslint-disable-line global-require
  const all = (await entriesOf(found.client.id)).filter((e) => seesLine(user, e)).sort(newestFirst);
  const reqIds = [...new Set(all.map((e) => e.requirementId).filter(Boolean))];
  const reqs = reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, title: true, reqCode: true } }) : [];
  const reqNames = Object.fromEntries(reqs.map((r) => [r.id, [r.reqCode, r.title].filter(Boolean).join(' · ')]));
  const people = [...new Set(all.map((e) => e.byName).filter(Boolean))].sort();
  const [requirements, work] = await Promise.all([requirementsOf(user, found.client.id), statusOfClient(found.client.id)]);
  const entries = (await withCallBacks(all.map((e) => publicEntry(e, reqNames)))).map((e, i) => ({ ...e, canEdit: mayEditLine(user, all[i]), canDelete: mayManage(user) }));
  return {
    status: 200,
    body: {
      tabs: FOLLOW_TABS.map(([key, label]) => ({ key, label, count: entries.filter((e) => e.tab === key).length })),
      requirements, workStatus: work ? work.status : null, workStatusBy: work ? work.by : null, workStatuses: WORK_STATUSES, canSetStatus: mayImport(user),
      client: found.client,
      requirement: found.requirement ? { id: found.requirement.id, label: [found.requirement.reqCode, found.requirement.title].filter(Boolean).join(' · ') } : null,
      entries,
      people,
      lastOn: all.length ? all[0].onDate : null,
      canAdd: mayWrite(user),
      today: istToday(),
    },
  };
}

async function add(user, body) {
  if (!mayWrite(user)) return { status: 403, body: { error: 'Managers can read the follow-ups; the BDE, TL and recruiters write them.' } };
  const found = await clientFor(user, { clientId: body.clientId, requirementId: body.requirementId });
  if (!found) return { status: 404, body: { error: 'This client is outside your area.' } };
  const note = String(body.note || '').trim().slice(0, 2000);
  if (note.length < 3) return { status: 400, body: { error: 'Write what happened in the follow-up (at least 3 letters).' } };
  const onDate = String(body.onDate || istToday()).trim();
  if (!YMD.test(onDate)) return { status: 400, body: { error: 'Pick the date of the follow-up.' } };
  if (onDate > istToday()) return { status: 400, body: { error: 'The date cannot be in the future.' } };
  const role = roleOf(user);
  const id = crypto.randomBytes(6).toString('hex');
  const reqs = body.lineRequirementId ? await requirementsOf(user, found.client.id) : [];
  const lineReq = reqs.some((r) => r.id === String(body.lineRequirementId)) ? String(body.lineRequirementId) : null;
  if (body.lineRequirementId && !lineReq) return { status: 400, body: { error: 'Pick a requirement of this client.' } };
  const e = {
    id, clientId: found.client.id, requirementId: lineReq || (found.requirement ? found.requirement.id : null), tab: cleanTab(body.tab), onDate, note, topic: null,
    byId: user.id, byName: user.name || null, byRole: role.label || null, createdAt: new Date().toISOString(), source: 'manual',
    hash: hashOf(found.client.id, onDate, note),
  };
  await prisma.appSetting.create({ data: { key: keyOf(e.clientId, id), value: JSON.stringify(e), updatedById: user.id, updatedByName: user.name || null } });
  // the day to call back (picked, or in the words: "call on 7th november") -> a pop-up on that day (utils/followUpReminders.js)
  const cb = await require('./followUpReminders').fromEntry(e, { remindOn: body.remindOn }).catch(() => null); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Client follow-up comment added', entity: 'Client', entityId: e.clientId, fieldLabel: 'Follow-up', toValue: onDate, reason: note.slice(0, 500) });
  return { status: 201, body: { ok: true, message: `Saved for ${onDate}.${cb ? ` A reminder pops up on ${dmyShort(cb.remindOn)}.` : ''}`, entry: { ...publicEntry(e, {}), callBackOn: cb ? cb.remindOn : null } } };
}

// Change a line: the text, the day, the sub tab, the requirement.
async function loadLine(user, q) {
  const found = await clientFor(user, { clientId: q.clientId });
  if (!found) return { error: { status: 404, body: { error: 'This client is outside your area.' } } };
  const key = keyOf(found.client.id, String(q.id));
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const e = row ? parse(row) : null;
  if (!e) return { error: { status: 404, body: { error: 'This follow-up was not found.' } } };
  return { found, key, e };
}
async function update(user, id, body) {
  const line = await loadLine(user, { clientId: body.clientId, id });
  if (line.error) return line.error;
  const { found, key, e } = line;
  if (!mayEditLine(user, e)) return { status: 403, body: { error: 'Only the person who wrote it, or the BDE TL, can change this follow-up.' } };
  const note = String(body.note || '').trim().slice(0, 2000);
  if (note.length < 3) return { status: 400, body: { error: 'Write what happened in the follow-up (at least 3 letters).' } };
  const onDate = String(body.onDate === undefined ? e.onDate : body.onDate).trim();
  if (onDate && !YMD.test(onDate)) return { status: 400, body: { error: 'Pick the date of the follow-up.' } };
  if (onDate > istToday()) return { status: 400, body: { error: 'The date cannot be in the future.' } };
  let { requirementId } = e;
  if (body.lineRequirementId !== undefined) {
    requirementId = null;
    if (body.lineRequirementId) {
      if (!(await requirementsOf(user, found.client.id)).some((r) => r.id === String(body.lineRequirementId))) return { status: 400, body: { error: 'Pick a requirement of this client.' } };
      requirementId = String(body.lineRequirementId);
    }
  }
  const next = { ...e, note, onDate, requirementId, tab: body.tab ? cleanTab(body.tab) : cleanTab(e.tab), hash: hashOf(found.client.id, onDate, note), editedBy: user.name || null, editedAt: new Date().toISOString() };
  await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify(next), updatedByName: user.name || null } });
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Client follow-up changed', entity: 'Client', entityId: found.client.id, fieldLabel: 'Follow-up', fromValue: String(e.note).slice(0, 300), toValue: note.slice(0, 300) });
  return { status: 200, body: { ok: true, message: 'Saved.' } };
}
async function remove(user, id, q) {
  if (!mayManage(user)) return { status: 403, body: { error: 'Only the BDE TL or an Admin can delete a follow-up.' } };
  const line = await loadLine(user, { clientId: q.clientId, id });
  if (line.error) return line.error;
  await prisma.appSetting.delete({ where: { key: line.key } });
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Client follow-up deleted', entity: 'Client', entityId: line.found.client.id, fieldLabel: 'Follow-up', fromValue: String(line.e.note).slice(0, 500), toValue: line.e.onDate || null });
  return { status: 200, body: { ok: true, message: 'Deleted.' } };
}
async function setStatus(user, body) {
  if (!mayImport(user)) return { status: 403, body: { error: 'The BDE team sets this status.' } };
  const found = await clientFor(user, { clientId: body.clientId });
  if (!found) return { status: 404, body: { error: 'This client is outside your area.' } };
  if (body.status && !WORK_STATUSES.includes(body.status)) return { status: 400, body: { error: 'Pick a status from the list.' } };
  if (body.status) await writeStatus(user, found.client.id, body.status);
  else await prisma.appSetting.deleteMany({ where: { key: STATUS_PREFIX + found.client.id } });
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Client status changed', entity: 'Client', entityId: found.client.id, fieldLabel: 'Status', toValue: body.status || 'Not set' });
  return { status: 200, body: { ok: true, message: 'Saved.' } };
}

// ---- the Excel sheet ------------------------------------------------------------------------------------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const NUM_DATE = /^\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4}|\d{2})(?!\d)/;
const WORD_DATE = /^\s*(\d{1,2})(?:st|nd|rd|th)?\s*[-\s./]\s*([A-Za-z]{3,9})\s*[-\s.,/]\s*(\d{4}|\d{2})(?!\d)/;
const ANY_DATE = /(\d{1,2})(?:st|nd|rd|th)?\s*[-./\s]\s*(\d{1,2}|[A-Za-z]{3,9})\s*[-./\s,]\s*(\d{4}|\d{2})(?!\d)/;
function ymd(d, m, y) {
  let day = Number(d); let mon = /^\d+$/.test(String(m)) ? Number(m) : MON[String(m).toLowerCase().slice(0, String(m).toLowerCase().startsWith('sept') ? 4 : 3)];
  let year = Number(y); if (String(y).length === 2) year += 2000;
  if (!mon) return null;
  if (mon > 12 && day <= 12) [day, mon] = [mon, day];
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || year < 2015 || year > 2030) return null;
  const dt = new Date(Date.UTC(year, mon - 1, day));
  if (dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}
// The date a line starts with, and the text after it.
function leadingDate(line) {
  const m = line.match(NUM_DATE) || line.match(WORD_DATE);
  if (!m) return null;
  const on = ymd(m[1], m[2], m[3]);
  if (!on) return null;
  const rest = line.slice(m[0].length).replace(/^[\s\-–:.,)]+/, '').trim();
  return { on, rest };
}

// Every cell that holds a follow-up log, by its header. Profile columns (contact, phone, location, link, mail, terms) are not follow-ups.
const PROFILE_HEAD = /contact|number|phone|mobile|location|link|mail|college name|client name|company|charges|agre+ment|designation|bed cap/i;
// never imported from a candidate row: the client's follow-ups are read by people who may not see pay or phone numbers
const PRIVATE_HEAD = /ctc|salary|package|phone|contact|mobile|mail/i;
// THE CLIENT'S STATUS in the sheets: Running, Stopped, On hold, No requirement (and how people wrote them)
const WORK_STATUSES = ['Running', 'On hold', 'Stopped', 'No requirement'];
function statusWord(v) {
  const t = String(v || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 26 || /\d{2}/.test(t)) return null;
  if (/^running/i.test(t)) return 'Running';
  if (/^(on )?hold/i.test(t)) return 'On hold';
  if (/^stop/i.test(t)) return 'Stopped';
  if (/^no req/i.test(t)) return 'No requirement';
  return null;
}
const cellText = (v) => String(v == null ? '' : v).trim();

// EVERY TAB OF THE WORKBOOK (founder 2026-11-05: "ahh sheets lo, sub tabs vunnai, mottham annitini import chesko"). What a tab is, from its headers:
//   client rows     one client per row, dated lines in the cells         -> Client follow-up (lines with no date -> Notes)
//   candidate rows  Date, Name ... Client Name ...                       -> Schedule, or Interviews when the tab's name says so
//   a tab named after a client (a calling list: Candidate Name, Status)  -> Schedule of that client
//   a note tab      one column, the first line names the client          -> Notes
//   anything else (Promotion Data: no client in it)                      -> left out, and named in the preview
// THE EDU PROFILE SCREENING FILE (founder 2026-11-05: "edu interview sheet tab lo - profile scrrening sheet matrmey import cheyyu"): a
// workbook with a ProfileScreening tab gives only that tab, one line per candidate under the college's Interviews sub tab.
const SCREENING_TAB = /^profile\s*screening$/i;
function parseSheet(buf, fileName) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const today = istToday();
  const future = [];
  const clients = new Map();
  const tabs = [];
  const clientOf = (name) => {
    const clean = String(name).trim().replace(/\s+/g, ' ');
    const k = norm(clean);
    if (!clients.has(k)) clients.set(k, { index: clients.size, name: clean, entries: [], status: null });
    return clients.get(k);
  };
  const put = (c, e) => {
    if (e.onDate && e.onDate > today) { // a date after today is a typo in the sheet ("29-08-28"): listed in the preview, never imported on a wrong day
      if (future.length < 20) future.push(`${c.name.slice(0, 40)} · ${e.onDate}: ${e.note.trim().slice(0, 70)}`); else future.push(null);
      return 0;
    }
    c.entries.push({ ...e, note: e.note.trim().slice(0, 2000) });
    return 1;
  };

  // one client per row
  function clientRows(rows, head) {
    const nameCol = Math.max(0, head.findIndex((h) => /college|client|company/i.test(h)));
    const logCols = head.map((h, i) => i).filter((i) => i !== nameCol && !PROFILE_HEAD.test(head[i] || ''));
    const width = Math.max(...rows.map((r) => r.length), head.length);
    for (let i = head.length; i < width; i += 1) logCols.push(i);
    const label = (i) => head[i] || `Status (column ${XLSX.utils.encode_col(i)})`;
    let cur = null; let n = 0;
    rows.slice(1).forEach((r) => {
      const name = cellText(r[nameCol]);
      if (name) cur = clientOf(name);
      if (!cur) return;
      logCols.forEach((ci) => {
        const cell = String(r[ci] || '');
        if (!cell.trim()) return;
        const word = statusWord(cell);
        if (word) { cur.status = cur.status || word; return; }
        let open = null; const loose = [];
        const flush = () => { if (open && open.note.trim().length >= 2) n += put(cur, { onDate: open.on, note: open.note, topic: label(ci), tab: 'client' }); open = null; };
        cell.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
          const d = leadingDate(line);
          if (d) { flush(); open = { on: d.on, note: d.rest || line }; return; }
          if (open) { open.note += `\n${line}`; return; }
          // "signed on 14th-Jan-2022": a date inside the first line still dates it.
          const m = line.match(ANY_DATE);
          const on = m ? ymd(m[1], m[2], m[3]) : null;
          if (on) { open = { on, note: line }; return; }
          if (!/^https?:\/\//i.test(line)) loose.push(line); // a map link is not a follow-up
        });
        flush();
        // no date anywhere: kept under Notes, with no day of its own
        if (loose.join(' ').length >= 2) n += put(cur, { onDate: '', note: loose.join('\n'), topic: label(ci), tab: 'notes' });
      });
    });
    return n;
  }

  // one candidate per row: never their pay or phone (PRIVATE_HEAD)
  function candidateRows(rows, head, tab, fixedClient = null, screening = false) {
    const col = (re) => head.findIndex((h) => re.test(h));
    const clientCol = col(/^(client|college)\s*name$/i);
    const nameCol = col(/^(candidate\s*)?name$/i);
    const dateCol = col(/^date$/i) >= 0 ? col(/^date$/i) : (!head[0] ? 0 : -1);
    const facts = [/^requirement$/i, /qualification/i, /branch|speciali[sz]ation/i, /designation/i, /experience/i, /(current|present)\s*location/i].map(col);
    const interviewDay = col(/interview\s*date/i);
    const interviewState = col(/interviews?\s*status/i);
    const interviewMode = col(/interview\s*mode/i);
    const recruiter = col(screening ? /^position$/i : /recruiter/i); // on the screening sheet "Position" is the person who handled the candidate
    const used = new Set([clientCol, nameCol, dateCol, ...facts, interviewDay, interviewState, interviewMode, recruiter]);
    // the status columns: named Status..., and the unnamed ones after the headers
    const width = Math.max(...rows.map((r) => r.length), head.length);
    const statusCols = [];
    for (let i = 0; i < width; i += 1) if (!used.has(i) && !PRIVATE_HEAD.test(head[i] || '') && (/^status|^remarks/i.test(head[i] || '') || !head[i])) statusCols.push(i);
    let n = 0;
    rows.slice(1).forEach((r) => {
      const who = cellText(r[nameCol]);
      const clientName = fixedClient || cellText(r[clientCol]);
      if (!who || !clientName) return;
      const notes = statusCols.map((i) => cellText(r[i])).filter(Boolean);
      let on = dateCol >= 0 ? (leadingDate(cellText(r[dateCol])) || {}).on : null;
      const interviewOn = interviewDay >= 0 ? (leadingDate(cellText(r[interviewDay])) || {}).on : null;
      if (interviewOn && interviewOn <= today && (!on || on > today)) on = interviewOn; // no Date, or a typo year in it (28-03-2028 for an interview on 28-03-2026)
      if (!on) { const first = notes.map((t) => leadingDate(t)).find(Boolean); on = first ? first.on : ''; }
      const shortest = [...notes].reverse().find((t) => t.length <= 30 && !leadingDate(t));
      const line1 = [who, facts.map((i) => (i >= 0 ? cellText(r[i]) : '')).filter(Boolean).join(' · ')].filter(Boolean).join(' — ');
      const line2 = [interviewDay >= 0 && cellText(r[interviewDay]) ? `Interview ${cellText(r[interviewDay])}` : '', interviewMode >= 0 ? cellText(r[interviewMode]) : '', interviewState >= 0 ? cellText(r[interviewState]) : ''].filter(Boolean).join(' · ');
      n += put(clientOf(clientName), {
        onDate: on, note: [line1, line2, ...notes.filter((t) => t !== shortest)].filter(Boolean).join('\n'),
        topic: shortest || (interviewState >= 0 ? cellText(r[interviewState]) : '') || null, tab, candidate: who.slice(0, 80), recruiter: recruiter >= 0 ? cellText(r[recruiter]).slice(0, 60) || null : null,
      });
    });
    return n;
  }

  const onlyTab = wb.SheetNames.find((n) => SCREENING_TAB.test(n.trim()));
  wb.SheetNames.forEach((tabName) => {
    if (onlyTab && tabName !== onlyTab) { tabs.push({ name: tabName.trim(), kind: '', lines: 0, rows: 0 }); return; }
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[tabName], { header: 1, defval: '', raw: false }).filter((r) => r.some((c) => cellText(c)));
    if (!rows.length) return;
    const head = (rows[0] || []).map(cellText);
    const has = (re) => head.some((h) => re.test(h));
    const named = head.filter(Boolean).length;
    let kind; let n = 0;
    if (has(/^(client|college)\s*name$/i) && has(/^(candidate\s*)?name$/i)) {
      const tab = /interview/i.test(tabName) || tabName === onlyTab ? 'interview' : 'schedule';
      kind = tab === 'interview' ? 'Interviews' : 'Schedule';
      n = candidateRows(rows, head, tab, null, tabName === onlyTab);
    } else if (has(/^candidate\s*name$/i)) {
      kind = `Schedule of ${tabName.trim()}`;
      n = candidateRows(rows, head, 'schedule', tabName);
    } else if (has(/portal\s*name|data\s*count/i)) {
      kind = '';
    } else if (has(/college|client|company|contact|no\.?\s*of\s*profiles/i) || !head[0]) {
      kind = 'Client follow-up';
      n = clientRows(rows, head);
    } else if (named <= 2) {
      const first = rows[0].map(cellText).find(Boolean);
      kind = 'Notes';
      n = put(clientOf(first.replace(/\s*process\s*$/i, '')), { onDate: '', note: rows.slice(1).map((r) => r.map(cellText).filter(Boolean).join(' ')).join('\n'), topic: first, tab: 'notes' });
    } else kind = '';
    tabs.push({ name: tabName.trim(), kind, lines: n, rows: rows.length - 1 });
  });
  const colleges = [...clients.values()].filter((c) => c.entries.length || c.status).map((c, i) => ({ ...c, index: i }));
  return {
    fileName: String(fileName || 'sheet.xlsx').slice(0, 120), colleges, tabs,
    emptyColleges: [], undated: 0, undatedSamples: [], futureCount: future.length, futureSamples: future.filter(Boolean),
  };
}

// The client a college name in the sheet is, with up to 3 suggestions.
function matcher(clients, aliases) {
  const byKey = new Map();
  const put = (k, c, how) => { if (k && k.length >= 3 && !byKey.has(`${how}:${k}`)) byKey.set(`${how}:${k}`, c); };
  clients.forEach((c) => { put(D.fullKey(c.name), c, 'full'); put(D.baseKey(c.name), c, 'base'); put(D.coreKey(c.name), c, 'core'); });
  aliases.forEach((a) => { const c = clients.find((x) => x.id === a.clientId); if (c) put(a.aliasKey, c, 'full'); });
  const toks = (n) => new Set(D.tok(D.clean(n)));
  return (name) => {
    const inBr = (name.match(/\(([^)]{2,40})\)/) || [])[1] || '';
    // 100 = the same name; anything lower is "similar" and the preview asks to check it ("Aurora College(Ghatkesar)" vs "Aurora College - Uppal").
    const tries = [['full', D.fullKey(name), 100], ['full', D.fullKey(inBr), 95], ['base', D.baseKey(name), 90], ['core', D.coreKey(name), 85], ['core', D.coreKey(inBr), 80], ['base', D.fullKey(inBr), 80]];
    for (const [how, k, score] of tries) {
      const c = k && k.length >= 3 ? byKey.get(`${how}:${k}`) : null;
      if (c) return { pick: c.id, score, suggestions: [{ id: c.id, name: c.name, score }] };
    }
    const mine = toks(name.replace(/\([^)]*\)/g, ' '));
    const core = D.coreKey(name);
    const scored = clients.map((c) => {
      const theirs = toks(c.name);
      const inter = [...mine].filter((t) => theirs.has(t)).length;
      const jac = inter / Math.max(1, new Set([...mine, ...theirs]).size);
      const cc = D.coreKey(c.name);
      const near = core && cc && core.length >= 4 && D.osa(core, cc) <= D.thr(core.length) ? 75 : 0;
      return { id: c.id, name: c.name, score: Math.max(near, Math.round(jac * 70)) };
    }).filter((x) => x.score >= 35).sort((a, b) => b.score - a.score).slice(0, 3);
    const best = scored[0];
    return { pick: best && best.score >= 75 && (!scored[1] || scored[1].score < best.score) ? best.id : null, score: best ? best.score : 0, suggestions: scored };
  };
}

const PREVIEWS = new Map(); // token -> { userId, parsed, at }
const PREVIEW_MS = 30 * 60 * 1000;

async function importPreview(user, buf, fileName) {
  if (!mayImport(user)) return { status: 403, body: { error: 'Importing follow-ups is for the BDE team and Admin.' } };
  if (!buf || !buf.length) return { status: 400, body: { error: 'Choose the Excel file (.xlsx).' } };
  let parsed;
  try { parsed = parseSheet(buf, fileName); } catch { return { status: 400, body: { error: 'This file could not be read. Save it as .xlsx and try again.' } }; }
  if (!parsed.colleges.length) return { status: 400, body: { error: 'No follow-up lines were found in any tab of this file.' } };
  const clients = await prisma.client.findMany({ where: { AND: [S.clientWhere(user), { OR: [{ clientType: null }, { clientType: { not: 'Internal' } }] }] }, select: { id: true, name: true, ownerDepartment: true }, orderBy: { name: 'asc' } });
  const aliases = await prisma.clientAlias.findMany({ select: { clientId: true, aliasKey: true } }).catch(() => []);
  const match = matcher(clients, aliases);
  const token = crypto.randomBytes(12).toString('hex');
  [...PREVIEWS.entries()].forEach(([k, v]) => { if (Date.now() - v.at > PREVIEW_MS) PREVIEWS.delete(k); });
  PREVIEWS.set(token, { userId: user.id, parsed, at: Date.now() });
  return {
    status: 200,
    body: {
      token, fileName: parsed.fileName, tabs: parsed.tabs,
      colleges: parsed.colleges.map((c) => {
        const m = match(c.name);
        const dates = c.entries.map((e) => e.onDate).filter(Boolean).sort();
        return { index: c.index, name: c.name, lines: c.entries.length, status: c.status, from: dates[0] || null, to: dates[dates.length - 1] || null, pick: m.pick, score: m.score, suggestions: m.suggestions };
      }),
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
      totalLines: parsed.colleges.reduce((n, c) => n + c.entries.length, 0),
      emptyColleges: parsed.emptyColleges, undated: parsed.undated, undatedSamples: parsed.undatedSamples,
      futureCount: parsed.futureCount, futureSamples: parsed.futureSamples,
    },
  };
}

async function importCommit(user, { token, mapping }) {
  if (!mayImport(user)) return { status: 403, body: { error: 'Importing follow-ups is for the BDE team and Admin.' } };
  const p = PREVIEWS.get(String(token || ''));
  if (!p || p.userId !== user.id || Date.now() - p.at > PREVIEW_MS) return { status: 410, body: { error: 'The preview has expired. Choose the file again.' } };
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  const CL = require('./clientLifecycle'); // eslint-disable-line global-require
  const role = roleOf(user);
  let added = 0; let duplicates = 0; let repeats = 0; let skipped = 0; const refused = []; const perClient = {};
  for (const c of p.parsed.colleges) {
    const clientId = map[c.index] ? String(map[c.index]) : '';
    if (!clientId) { skipped += c.entries.length; continue; }
    // eslint-disable-next-line no-await-in-loop
    const client = await prisma.client.findFirst({ where: { AND: [{ id: clientId }, S.clientWhere(user)] } });
    if (!client || !CL.ownsClient(user, client)) { refused.push(c.name); continue; }
    // eslint-disable-next-line no-await-in-loop
    const have = new Set((await entriesOf(client.id)).map((e) => e.hash));
    const seen = new Set();
    const data = [];
    c.entries.forEach((e) => {
      const hash = hashOf(client.id, e.onDate, e.note);
      if (have.has(hash)) { duplicates += 1; return; }
      if (seen.has(hash)) { repeats += 1; return; } // the same day and words twice in the sheet
      seen.add(hash);
      const id = crypto.randomBytes(6).toString('hex');
      const row = { id, clientId: client.id, requirementId: null, tab: e.tab || 'client', candidate: e.candidate || null, recruiter: e.recruiter || null, onDate: e.onDate, note: e.note, topic: e.topic, byId: user.id, byName: user.name || null, byRole: role.label || null, createdAt: new Date().toISOString(), source: 'sheet', sheet: p.parsed.fileName, hash };
      data.push({ key: keyOf(client.id, id), value: JSON.stringify(row), updatedById: user.id, updatedByName: user.name || null });
    });
    for (let i = 0; i < data.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.appSetting.createMany({ data: data.slice(i, i + 200) });
    }
    added += data.length;
    // the status in the sheet, when TeamLink has none yet
    // eslint-disable-next-line no-await-in-loop
    if (c.status && !(await statusOfClient(client.id))) await writeStatus(user, client.id, c.status);
    if (data.length) {
      perClient[client.name] = (perClient[client.name] || 0) + data.length;
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: user.id, actorName: user.name || null, action: 'Client follow-ups imported', entity: 'Client', entityId: client.id, fieldLabel: 'Follow-up', toValue: `${data.length} lines`, reason: `From ${p.parsed.fileName} (${c.name})`.slice(0, 500) });
    }
  }
  PREVIEWS.delete(String(token));
  return {
    status: 200,
    body: {
      ok: true, added, duplicates, repeats, skipped, refused, clients: Object.keys(perClient).length,
      message: `${added} follow-up line${added === 1 ? '' : 's'} imported into ${Object.keys(perClient).length} client${Object.keys(perClient).length === 1 ? '' : 's'}${duplicates ? `; ${duplicates} were already there` : ''}${repeats ? `; ${repeats} were written twice in the sheet and kept once` : ''}.`,
    },
  };
}

// ---- THE CANDIDATE'S FOLLOW-UP LOG (founder 2026-11-03: "recruiters ki ithey, candidate follow up vundali. ilaaga") --------
// The same dated log on the candidate profile: what the recruiter wrote for the day, plus the calls / mails logged with
// "Follow up" (quick log) and the follow-up tasks marked done, so the day-by-day history is in one list. Rows of the log
// itself live in appSetting 'candlog.<candidateId>.<id>'; the other two are read from where they already are.
const CPREFIX = 'candlog.';
const istDay = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
async function candidateFor(user, candidateId) {
  if (!candidateId) return null;
  return prisma.candidate.findFirst({ where: { AND: [{ id: String(candidateId) }, S.candidateWhere(user)] }, select: { id: true, name: true } });
}
async function appLabels(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const apps = await prisma.application.findMany({ where: { id: { in: list } }, select: { id: true, requirement: { select: { reqCode: true, title: true, client: { select: { name: true } } } } } });
  return Object.fromEntries(apps.map((a) => [a.id, a.requirement ? [a.requirement.reqCode, a.requirement.title, a.requirement.client && a.requirement.client.name].filter(Boolean).join(' · ') : null]));
}
async function namesOf(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const us = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
  return Object.fromEntries(us.map((u) => [u.id, u.name]));
}
// The other two sources, as log lines.
async function otherCandidateLines(where, take = 2000) {
  const [quick, done] = await Promise.all([
    prisma.candidateMessage.findMany({ where: { ...where.msg, template: 'QUICK_LOG' }, select: { id: true, candidateId: true, applicationId: true, channel: true, body: true, templateLabel: true, senderUserId: true, senderName: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take }),
    prisma.applicationFollowUp.findMany({ where: { ...where.fu, completedAt: { not: null, ...(where.fuAt || {}) } }, select: { id: true, candidateId: true, applicationId: true, purpose: true, nextAction: true, completedNote: true, completedAt: true, completedById: true, ownerName: true, ownerRole: true }, orderBy: { completedAt: 'desc' }, take }),
  ]);
  const names = await namesOf(done.map((f) => f.completedById));
  return [
    ...quick.map((m) => ({
      id: `q${m.id}`, candidateId: m.candidateId, applicationId: m.applicationId, onDate: istDay(m.createdAt), createdAt: new Date(m.createdAt).toISOString(),
      note: `${m.channel === 'Email' ? 'Mail' : m.channel}: ${m.body || 'logged'}${m.templateLabel && m.templateLabel !== 'Follow-up' ? ` (${m.templateLabel})` : ''}`,
      byId: m.senderUserId, byName: m.senderName || null, byRole: null, source: 'quick', topic: m.channel === 'Email' ? 'Mail' : m.channel,
    })),
    ...done.map((f) => ({
      id: `f${f.id}`, candidateId: f.candidateId, applicationId: f.applicationId, onDate: istDay(f.completedAt), createdAt: new Date(f.completedAt).toISOString(),
      note: `${f.purpose || f.nextAction || 'Follow-up'} - done${f.completedNote ? `: ${f.completedNote}` : ''}`,
      byId: f.completedById, byName: names[f.completedById] || f.ownerName || null, byRole: f.completedById ? null : (f.ownerRole || null), source: 'task', topic: 'Follow-up task',
    })),
  ];
}
const publicCand = (e, labels) => ({
  id: e.id, onDate: e.onDate, note: e.note, topic: e.topic || null, byName: e.byName || null, byRole: e.byRole || null, createdAt: e.createdAt,
  source: e.source || 'manual', applicationId: e.applicationId || null, requirementLabel: e.applicationId ? (labels[e.applicationId] || null) : null,
});

async function candidateList(user, { candidateId }) {
  const cand = await candidateFor(user, candidateId);
  if (!cand) return { status: 404, body: { error: 'This candidate is outside your area.' } };
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: `${CPREFIX}${cand.id}.` } } });
  const own = rows.map(parse).filter(Boolean);
  const other = await otherCandidateLines({ msg: { candidateId: cand.id }, fu: { candidateId: cand.id } });
  const all = [...own, ...other].sort(newestFirst);
  const labels = await appLabels(all.map((e) => e.applicationId));
  return {
    status: 200,
    body: {
      candidate: cand, client: { id: null, name: cand.name }, requirement: null,
      entries: await withCallBacks(all.map((e) => publicCand(e, labels))),
      people: [...new Set(all.map((e) => e.byName).filter(Boolean))].sort(),
      lastOn: all.length ? all[0].onDate : null, canAdd: mayWrite(user), today: istToday(),
    },
  };
}

async function candidateAdd(user, body) {
  if (!mayWrite(user)) return { status: 403, body: { error: 'Managers can read the follow-ups; the recruiters, TLs and BDEs write them.' } };
  const cand = await candidateFor(user, body.candidateId);
  if (!cand) return { status: 404, body: { error: 'This candidate is outside your area.' } };
  const note = String(body.note || '').trim().slice(0, 2000);
  if (note.length < 3) return { status: 400, body: { error: 'Write what happened in the follow-up (at least 3 letters).' } };
  const onDate = String(body.onDate || istToday()).trim();
  if (!YMD.test(onDate)) return { status: 400, body: { error: 'Pick the date of the follow-up.' } };
  if (onDate > istToday()) return { status: 400, body: { error: 'The date cannot be in the future.' } };
  let applicationId = body.applicationId ? String(body.applicationId) : null;
  if (applicationId) {
    const app = await prisma.application.findFirst({ where: { AND: [{ id: applicationId, candidateId: cand.id }, S.applicationWhere(user)] }, select: { id: true } });
    if (!app) applicationId = null;
  }
  const role = roleOf(user);
  const id = crypto.randomBytes(6).toString('hex');
  const e = { id, candidateId: cand.id, applicationId, onDate, note, byId: user.id, byName: user.name || null, byRole: role.label || null, createdAt: new Date().toISOString(), source: 'manual' };
  await prisma.appSetting.create({ data: { key: `${CPREFIX}${cand.id}.${id}`, value: JSON.stringify(e), updatedById: user.id, updatedByName: user.name || null } });
  // the day to call back (picked, or in the words) -> a pop-up to the candidate's recruiter(s) and the writer (utils/followUpReminders.js)
  const cb = await require('./followUpReminders').fromEntry(e, { remindOn: body.remindOn }).catch(() => null); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Candidate follow-up comment added', entity: 'Candidate', entityId: cand.id, fieldLabel: 'Follow-up', toValue: onDate, reason: note.slice(0, 500) });
  return { status: 201, body: { ok: true, message: `Saved for ${onDate}.${cb ? ` A reminder pops up on ${dmyShort(cb.remindOn)} for the recruiter.` : ''}`, entry: { ...publicCand(e, await appLabels([applicationId])), callBackOn: cb ? cb.remindOn : null } } };
}

// ---- THE TEAM'S FOLLOW-UP HISTORY (founder 2026-11-03: "ah history antha respective tls ki kanipinchali") --------------
// Every follow-up written by the people of this login's team, day by day: client and candidate comments, quick logs and
// follow-up tasks done. A TL sees their recruiters / BDEs (utils/teamWorkload.js peopleFor - the same team as the Team
// page), the BDE TL the BDE team, Admin / Manager everyone, a recruiter or BDE only their own.
const TEAM_ROLE = { RECRUITER: 'Recruiter', BDE: 'BDE', TL: 'TL', STL: 'STL', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Asst Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Admin', HR: 'HR' };
// opts (the bulk export): { maxDays, maxRows } - a longer range and every row, not the screen's 92 days / 3,000 rows.
async function teamHistory(user, q, { maxDays = 92, maxRows = 3000 } = {}) {
  const role = roleOf(user);
  if (!['admin', 'mgmt', 'bdetl', 'tl', 'stl', 'recruiter', 'bde'].includes(role.key)) return { status: 403, body: { error: 'Follow-up history is for the ATS team.' } };
  const today = istToday();
  const to = YMD.test(String(q.to || '')) ? String(q.to) : today;
  let from = YMD.test(String(q.from || '')) ? String(q.from) : new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > maxDays * 86400000) from = new Date(Date.parse(`${to}T00:00:00Z`) - maxDays * 86400000).toISOString().slice(0, 10);
  if (from > to) from = to;
  let people;
  if (['recruiter', 'bde'].includes(role.key)) people = [{ id: user.id, name: user.name, atsRole: role.key === 'bde' ? 'BDE' : 'RECRUITER', atsDepartment: user.atsDepartment }];
  else {
    people = await require('./teamWorkload').peopleFor(user); // eslint-disable-line global-require
    if (!people.some((p) => p.id === user.id)) people.push({ id: user.id, name: user.name, atsRole: user.atsRole });
  }
  const pick = q.personId ? people.filter((p) => p.id === String(q.personId)) : people;
  const ids = pick.map((p) => p.id);
  if (!ids.length) return { status: 200, body: { from, to, people: [], rows: [], summary: [] } };
  const startUtc = new Date(Date.parse(`${from}T00:00:00Z`) - 5.5 * 3600000);
  const endUtc = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000 - 5.5 * 3600000);
  const [ownRows, other] = await Promise.all([
    prisma.appSetting.findMany({ where: { AND: [{ OR: [{ key: { startsWith: PREFIX } }, { key: { startsWith: CPREFIX } }] }, { updatedById: { in: ids } }] } }),
    otherCandidateLines({ msg: { senderUserId: { in: ids }, createdAt: { gte: startUtc, lt: endUtc } }, fu: { completedById: { in: ids } }, fuAt: { gte: startUtc, lt: endUtc } }, Math.max(2000, maxRows)),
  ]);
  const own = ownRows.map(parse).filter((e) => e && e.source !== 'sheet' && ids.includes(e.byId));
  const all = [...own, ...other].filter((e) => e.onDate >= from && e.onDate <= to && ids.includes(e.byId)).sort(newestFirst).slice(0, maxRows);
  const clientIds = [...new Set(all.map((e) => e.clientId).filter(Boolean))];
  const candIds = [...new Set(all.map((e) => e.candidateId).filter(Boolean))];
  const [clients, cands, labels] = await Promise.all([
    clientIds.length ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [],
    candIds.length ? prisma.candidate.findMany({ where: { id: { in: candIds } }, select: { id: true, name: true } }) : [],
    appLabels(all.map((e) => e.applicationId)),
  ]);
  const cName = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  const kName = Object.fromEntries(cands.map((c) => [c.id, c.name]));
  // RECRUITERS FOLLOW UP CANDIDATES, BDEs FOLLOW UP CLIENTS (founder 2026-11-04: "recruiters followups separate & bde follow up
  // separate"): each person is on one side - the BDE and the BDE TL on the client side, everyone else on the candidate side.
  const { isBdeDepartment } = require('./bdeDesk'); // eslint-disable-line global-require
  const bdeTlOf = (p) => p.atsRole === 'TL' && isBdeDepartment(String(p.atsDepartment || '').split(',').map((x) => x.trim()).filter(Boolean));
  const pRole = Object.fromEntries(people.map((p) => [p.id, bdeTlOf(p) ? 'BDE TL' : (TEAM_ROLE[p.atsRole] || '')]));
  const pSide = Object.fromEntries(people.map((p) => [p.id, p.atsRole === 'BDE' || bdeTlOf(p) ? 'client' : 'candidate']));
  const pName = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const rows = all.map((e) => ({
    id: e.id, onDate: e.onDate, createdAt: e.createdAt, byId: e.byId, byName: pName[e.byId] || e.byName || null, byRole: pRole[e.byId] || e.byRole || null,
    kind: e.candidateId ? 'Candidate' : 'Client', name: e.candidateId ? (kName[e.candidateId] || 'Candidate') : (cName[e.clientId] || 'Client'),
    link: e.candidateId ? `/candidates/${e.candidateId}?tab=followups` : `/clients/${e.clientId}?tab=followups`,
    about: e.applicationId ? (labels[e.applicationId] || null) : null, note: e.note, source: e.source || 'manual', topic: e.topic || null,
  }));
  const sum = {};
  rows.forEach((r) => {
    const s = sum[r.byId] || (sum[r.byId] = { id: r.byId, name: r.byName, role: r.byRole, total: 0, candidates: 0, clients: 0, days: new Set(), last: null });
    s.total += 1; if (r.kind === 'Candidate') s.candidates += 1; else s.clients += 1; s.days.add(r.onDate); if (!s.last || r.onDate > s.last) s.last = r.onDate;
  });
  const sumOf = (kind) => { // per side: each person's own days and last day for that kind
    const m = {};
    rows.filter((r) => r.kind === kind).forEach((r) => { const e = m[r.byId] || (m[r.byId] = { days: new Set(), last: null }); e.days.add(r.onDate); if (!e.last || r.onDate > e.last) e.last = r.onDate; });
    return m;
  };
  const byKind = { Candidate: sumOf('Candidate'), Client: sumOf('Client') };
  // ACTIVE EMPLOYEES FIRST (founder 2026-11-14): each person carries the employment status (Exited / Relieved ...), so the screen can open on the people
  // who are still here and write the status beside the others. Nothing is dropped here: every number and row is as before.
  const pEmp = Object.fromEntries(people.map((p) => [p.id, (p.employee && p.employee.employmentStatus) || null]));
  const summary = people.map((p) => sum[p.id] || { id: p.id, name: p.name, role: pRole[p.id], total: 0, candidates: 0, clients: 0, days: new Set(), last: null })
    .filter((s) => !q.personId || s.id === String(q.personId))
    .map((s) => ({
      ...s, days: s.days.size, side: pSide[s.id] || 'candidate', employmentStatus: pEmp[s.id] || null,
      candidateDays: byKind.Candidate[s.id] ? byKind.Candidate[s.id].days.size : 0, candidateLast: byKind.Candidate[s.id] ? byKind.Candidate[s.id].last : null,
      clientDays: byKind.Client[s.id] ? byKind.Client[s.id].days.size : 0, clientLast: byKind.Client[s.id] ? byKind.Client[s.id].last : null,
    })).sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
  return {
    status: 200,
    body: { from, to, today, scope: ['recruiter', 'bde'].includes(role.key) ? 'mine' : 'team', viewerSide: ['bde', 'bdetl'].includes(role.key) ? 'client' : 'candidate', people: people.map((p) => ({ id: p.id, name: p.name, role: pRole[p.id], side: pSide[p.id], employmentStatus: pEmp[p.id] || null })).sort((a, b) => String(a.name).localeCompare(String(b.name))), rows, summary },
  };
}

// ---- EXPORT / IMPORT ON THE FOLLOW-UPS TAB (founder 2026-11-04: "ikkada kuda export import button vundali") ----------------
// Export: the log the caller sees (a candidate's, or a client's / requirement's), as Excel / CSV / PDF (routes/clientFollowLog.js).
// Import: a sheet with a date and what happened on each line - the exported file itself, or any sheet whose lines start with a
// date ("04-11-2026 - called, will join Monday"). Preview first, then import; a line already on the log (same day, same words)
// is never added twice. Imported lines show "From the sheet" (with the "Who" of the file, when it has one).
const EXPORT_HEAD = ['Date', 'What happened', 'Who', 'Role', 'Job', 'Kind'];
const KIND_WORD = { manual: 'Comment', quick: 'Logged contact', task: 'Follow-up task', sheet: 'From a sheet' };
const dmy = (ymdStr) => { const [y, m, d] = String(ymdStr || '').split('-'); return y ? `${d}-${m}-${y}` : ''; };
async function logOf(user, q) {
  return q.candidateId ? candidateList(user, { candidateId: q.candidateId }) : list(user, { clientId: q.clientId, requirementId: q.requirementId });
}
async function exportRows(user, q) {
  const out = await logOf(user, q);
  if (out.status !== 200) return out;
  const b = out.body;
  const rows = b.entries.map((e) => [dmy(e.onDate), e.note, e.source === 'sheet' ? (e.topic || e.byName || '') : (e.byName || ''), e.byRole || '', e.requirementLabel || '', KIND_WORD[e.source] || 'Comment']);
  const name = (b.candidate ? b.candidate.name : b.client.name) || 'follow-ups';
  return { status: 200, body: { name, headers: EXPORT_HEAD, rows, entity: q.candidateId ? 'Candidate' : 'Client' } };
}

// A cell as a day: a real Excel date, an ISO day, or "04-11-2026" / "4 Nov 2026" (day first, as the sheets are written).
function cellDay(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = leadingDate(t);
  return d ? d.on : null;
}
function parseSimpleSheet(buf) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: true }); // raw: a CSV's "04-11-2026" stays day-first text
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  const head = (rows[0] || []).map((h) => String(h || '').trim().toLowerCase());
  const dateCol = head.findIndex((h) => /^(follow[- ]?up )?date|^day$|^on$/.test(h));
  const noteCol = head.findIndex((h) => /what happened|follow[- ]?ups?$|note|comment|remark|status|discussion|details/.test(h) && !/date/.test(h));
  const whoCol = head.findIndex((h) => /^(who|by|done by|recruiter|bde)$/.test(h));
  const today = istToday();
  const out = [];
  let undated = 0; let future = 0;
  const body = dateCol >= 0 && noteCol >= 0 ? rows.slice(1) : rows;
  body.forEach((r) => {
    if (!r.some((c) => String(c).trim())) return;
    let on = null; let note = '';
    if (dateCol >= 0 && noteCol >= 0) {
      on = cellDay(r[dateCol]); note = String(r[noteCol] || '').trim();
    } else {
      // no headers: the first cell that is a day; the rest of the line is what happened
      const cells = r.map((c) => (c instanceof Date ? c : String(c == null ? '' : c).trim()));
      const i = cells.findIndex((c) => cellDay(c));
      if (i >= 0) {
        const lead = typeof cells[i] === 'string' ? leadingDate(cells[i]) : null;
        on = cellDay(cells[i]);
        note = [lead && lead.rest ? lead.rest : '', ...cells.filter((c, j) => j !== i && typeof c === 'string')].filter(Boolean).join(' · ');
      }
    }
    if (!on || note.length < 2) { undated += 1; return; }
    if (on > today) { future += 1; return; }
    out.push({ onDate: on, note: note.slice(0, 2000), who: whoCol >= 0 ? String(r[whoCol] || '').trim().slice(0, 80) : '' });
  });
  return { lines: out, undated, future };
}
const SIMPLE = new Map(); // token -> { userId, target, lines, fileName, at }
async function simplePreview(user, q, buf, fileName) {
  if (!mayWrite(user)) return { status: 403, body: { error: 'Managers can read the follow-ups; the recruiters, TLs and BDEs import them.' } };
  if (!buf || !buf.length) return { status: 400, body: { error: 'Choose the Excel or CSV file.' } };
  const log = await logOf(user, q);
  if (log.status !== 200) return log;
  let parsed;
  try { parsed = parseSimpleSheet(buf); } catch { return { status: 400, body: { error: 'This file could not be read. Save it as .xlsx or .csv and try again.' } }; }
  const have = new Set(log.body.entries.map((e) => `${e.onDate}|${norm(e.note)}`));
  const seen = new Set();
  let already = 0; let repeats = 0;
  const lines = parsed.lines.filter((l) => {
    const k = `${l.onDate}|${norm(l.note)}`;
    if (have.has(k)) { already += 1; return false; }
    if (seen.has(k)) { repeats += 1; return false; }
    seen.add(k);
    return true;
  });
  if (!lines.length) return { status: 400, body: { error: parsed.lines.length ? 'Every line of this file is already on the follow-ups.' : 'No dated follow-up lines were found. Each line needs a date (like 04-11-2026) and what happened.' } };
  const token = crypto.randomBytes(12).toString('hex');
  [...SIMPLE.entries()].forEach(([k, v]) => { if (Date.now() - v.at > PREVIEW_MS) SIMPLE.delete(k); });
  const target = q.candidateId ? { candidateId: log.body.candidate.id } : { clientId: log.body.client.id, requirementId: log.body.requirement ? log.body.requirement.id : null };
  SIMPLE.set(token, { userId: user.id, target, lines, fileName: String(fileName || 'sheet.xlsx').slice(0, 120), at: Date.now() });
  return { status: 200, body: { token, fileName, count: lines.length, already, repeats, undated: parsed.undated, future: parsed.future, sample: lines.slice(0, 8) } };
}
async function simpleCommit(user, { token }) {
  if (!mayWrite(user)) return { status: 403, body: { error: 'Managers can read the follow-ups; the recruiters, TLs and BDEs import them.' } };
  const p = SIMPLE.get(String(token || ''));
  if (!p || p.userId !== user.id || Date.now() - p.at > PREVIEW_MS) return { status: 410, body: { error: 'The preview has expired. Choose the file again.' } };
  SIMPLE.delete(String(token));
  const role = roleOf(user);
  const now = new Date().toISOString();
  const t = p.target;
  const data = p.lines.map((l) => {
    const id = crypto.randomBytes(6).toString('hex');
    const base = { id, onDate: l.onDate, note: l.note, topic: l.who || null, byId: user.id, byName: user.name || null, byRole: role.label || null, createdAt: now, source: 'sheet', sheet: p.fileName };
    return t.candidateId
      ? { key: `${CPREFIX}${t.candidateId}.${id}`, value: JSON.stringify({ ...base, candidateId: t.candidateId, applicationId: null }), updatedById: user.id, updatedByName: user.name || null }
      : { key: keyOf(t.clientId, id), value: JSON.stringify({ ...base, clientId: t.clientId, requirementId: t.requirementId || null, hash: hashOf(t.clientId, l.onDate, l.note) }), updatedById: user.id, updatedByName: user.name || null };
  });
  for (let i = 0; i < data.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.appSetting.createMany({ data: data.slice(i, i + 200) });
  }
  await logAudit({ userId: user.id, actorName: user.name || null, action: t.candidateId ? 'Candidate follow-ups imported' : 'Client follow-ups imported', entity: t.candidateId ? 'Candidate' : 'Client', entityId: t.candidateId || t.clientId, fieldLabel: 'Follow-up', toValue: `${data.length} lines`, reason: `From ${p.fileName}`.slice(0, 500) });
  return { status: 200, body: { ok: true, added: data.length, message: `${data.length} follow-up line${data.length === 1 ? '' : 's'} imported.` } };
}

// THE FOLLOW-UP REPORT IN BULK (founder 2026-11-04: "followup report ni bulk lo export cheyyali"): every row of the team
// follow-up history for the chosen days (up to a year), person and side (kind = Candidate | Client, or both), as a file.
const HOW = { manual: 'Comment', quick: 'Logged contact', task: 'Follow-up task', sheet: 'From a sheet' };
async function teamExportRows(user, q) {
  const out = await teamHistory(user, q, { maxDays: 366, maxRows: 50000 });
  if (out.status !== 200) return out;
  const b = out.body;
  const kind = ['Candidate', 'Client'].includes(q.kind) ? q.kind : null;
  const needle = String(q.q || '').trim().toLowerCase();
  const rows = b.rows
    .filter((r) => (!kind || r.kind === kind) && (!needle || `${r.name} ${r.note} ${r.about || ''} ${r.byName || ''}`.toLowerCase().includes(needle)))
    .map((r) => [dmy(r.onDate), r.byName || '', r.byRole || '', r.kind === 'Candidate' ? 'Recruiter follow-up (candidate)' : 'BDE follow-up (client)', r.name, r.note, r.about || '', HOW[r.source] || 'Comment']);
  return {
    status: 200,
    body: {
      from: b.from, to: b.to, kind, rows,
      headers: ['Date', 'Person', 'Role', 'Follow-up of', 'Candidate / client', 'What happened', 'Job', 'How'],
      scope: b.scope === 'mine' ? 'own follow-ups' : 'team',
    },
  };
}

module.exports = {
  update, remove, setStatus, WORK_STATUSES, teamExportRows, exportRows, simplePreview, simpleCommit, parseSimpleSheet, candidateList, candidateAdd, teamHistory, list, add, importPreview, importCommit, parseSheet, leadingDate, matcher, mayWrite, mayImport, PREFIX };

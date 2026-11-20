// ---------------------------------------------------------------------------
// WHOSE FOLLOW-UPS MAY THIS LOGIN SEE - written ONCE (founder 2026-11-20: "a TL must see the recruiters' (everyone's in the team),
// and each recruiter must see only their own"). The Follow-up report (utils/followUpReport.js, routes/followUpReport.js), its
// Excel file and the follow-up list on the candidate page (utils/clientFollowLog.js candidateList) all ask THIS function, so
// the screen, the list and the export can never disagree about who is in a team.
//
//   Recruiter            only themselves                         (mode "mine")
//   BDE / BDE TL         only themselves (their client desk)     (mode "mine")
//   TL                   their team: the seats that report to their TL seat and whoever holds them now (the same rule that
//                        scopes their requirements: identity.atsTeamUserIds), plus the people who held those seats before and
//                        left - for the days they sat there; never another TL's team          (mode "team")
//   STL                  every TL's team under their STL seat, with a TL picker               (mode "team")
//   Manager / Admin      everyone, with a department / team / TL picker                       (mode "team")
//   HR, Accounts, Client, Candidate, no role: nothing (403)
//
// A person who asks for a TL, a department or a recruiter outside what they may see gets 403 - never an empty list that hides
// the refusal and never the other team's name.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const MP = require('./multiParam');
const S = require('./scope');
const { isBdeDepartment } = require('./bdeDesk');

const TEAM_ROLES = ['RECRUITER', 'TL', 'STL'];
const ROLE_LABEL = { RECRUITER: 'Recruiter', TL: 'TL', STL: 'STL', BDE: 'BDE' };
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const isTestPerson = (u) => !!u && /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);
const REPORT_VIEWERS = ['admin', 'mgmt', 'stl', 'tl', 'recruiter'];
const SELF_ONLY_VIEWERS = ['bde', 'bdetl'];

const PERSON_SELECT = {
  id: true, name: true, email: true, status: true, atsRole: true, atsDepartment: true,
  employee: { select: { team: true, department: true, employmentStatus: true } },
};

/** The kind of viewer the report is drawn for: admin | mgmt | stl | tl | recruiter | bde | bdetl | none (nothing). */
function viewerKind(user) {
  if (S.isBdeTl(user)) return 'bdetl';
  return S.atsViewRole(user);
}

const bdeSide = (p) => p.atsRole === 'BDE' || isBdeDepartment(csv(p.atsDepartment));

function shapePerson(p, extra = {}) {
  const emp = p.employee || {};
  return {
    id: p.id, name: p.name, role: ROLE_LABEL[p.atsRole] || '', atsRole: p.atsRole,
    department: emp.department || p.atsDepartment || null, team: emp.team || null,
    employmentStatus: emp.employmentStatus || null, active: p.status === 'Active' && !/^(relieved|exited)$/i.test(emp.employmentStatus || ''),
    ...extra,
  };
}

// The team of one lead (TL or STL) read from the lead's own identity - the SAME ids their requirements are scoped by.
// -> { ids: [userId...], seatIds: [positionId...] } ; ids is null when the lead has no seat and no team (department fallback).
function teamIdsOf(ident) {
  const s = S.atsScopeOf(ident);
  const seatIds = s.positions && Array.isArray(s.positions.positionIds) ? s.positions.positionIds : [];
  if (s.teamUserIds) return { ids: uniq([ident.id, ...s.teamUserIds]), seatIds, departments: s.departments || [] };
  return { ids: null, seatIds, departments: s.departments || [] };
}

// Former holders of the lead's seats: userId -> [{ from, to }] (YYYY-MM-DD, inclusive). Their follow-ups count for the team
// only on the days they sat there.
async function formerHolders(seatIds, currentIds) {
  if (!seatIds.length) return new Map();
  const rows = await prisma.positionAssignment.findMany({
    where: { positionId: { in: seatIds }, toDate: { not: null } },
    select: { fromDate: true, toDate: true, employee: { select: { userId: true } } },
  });
  const out = new Map();
  rows.forEach((r) => {
    const id = r.employee && r.employee.userId;
    if (!id || currentIds.has(id)) return;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ from: r.fromDate, to: r.toDate });
  });
  return out;
}

async function usersById(ids) {
  const list = uniq(ids);
  if (!list.length) return [];
  const rows = [];
  for (let i = 0; i < list.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(...await prisma.user.findMany({ where: { id: { in: list.slice(i, i + 400) } }, select: PERSON_SELECT }));
  }
  return rows;
}

/** The team lead users the viewer may pick (TLs of the recruiting departments), each with the ids of their own team. */
async function leadTeams(ids, viewer) {
  const where = { atsRole: 'TL', status: 'Active' };
  const tls = (ids ? await usersById(ids) : await prisma.user.findMany({ where, select: PERSON_SELECT }))
    .filter((u) => u.atsRole === 'TL' && u.status === 'Active' && !bdeSide(u) && (!isTestPerson(u) || isTestPerson(viewer)));
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const out = [];
  for (const tl of tls) {
    // eslint-disable-next-line no-await-in-loop
    const ident = await resolveIdentity(tl.id).catch(() => null);
    if (!ident) continue; // eslint-disable-line no-continue
    const t = teamIdsOf(ident);
    out.push({ lead: tl, ident, ...t });
  }
  return out.sort((a, b) => String(a.lead.name).localeCompare(String(b.lead.name)));
}

/**
 * THE ONE SCOPE FUNCTION.
 *   resolve(user, { leadId, department, team, personId }) ->
 *     { ok: false, status, error }
 *     { ok: true, kind, mode: 'mine' | 'team', members: [{ id, name, role, leadName, former, windows, ... }], memberIds: Set,
 *       leads: [{ id, name, count }] | null (the picker), departments: [...], teams: [...], leadId, personId, label }
 * A member with `windows` is a former seat holder: only the days in a window belong to this team.
 */
async function resolve(user, q = {}) {
  const kind = viewerKind(user);
  // several team leads / departments / teams at once (founder 2026-11-20: checkboxes everywhere); a comma list each
  const leadIds = MP.parseMulti(q.leadId);
  if (SELF_ONLY_VIEWERS.includes(kind) || kind === 'recruiter') {
    if (leadIds.some((id) => id !== user.id)) return { ok: false, status: 403, error: 'You can see only your own follow-ups.' };
    if (q.personId && String(q.personId) !== user.id) return { ok: false, status: 403, error: 'You can see only your own follow-ups.' };
    const me = (await usersById([user.id]))[0] || { id: user.id, name: user.name, atsRole: user.atsRole, status: 'Active' };
    const self = shapePerson(me, { leadName: null, former: false, windows: null, self: true });
    return {
      ok: true, kind, mode: 'mine', members: [self], memberIds: new Set([user.id]), leads: null, departments: [], teams: [], leadId: '', personId: '',
      label: 'My follow-ups',
    };
  }
  if (!REPORT_VIEWERS.includes(kind)) return { ok: false, status: 403, error: 'The follow-up report is for the recruiting team.' };

  const viewerIsTest = isTestPerson(user);
  const keep = (u) => TEAM_ROLES.includes(u.atsRole) && !bdeSide(u) && (!isTestPerson(u) || viewerIsTest);
  let teams; // [{ lead, ids, seatIds }]
  let ownIds = null; // the ids this viewer may ever see (null = everyone)
  let seatIds = [];
  if (kind === 'tl' || kind === 'stl') {
    const mine = teamIdsOf(user);
    seatIds = mine.seatIds;
    if (mine.ids) ownIds = mine.ids;
    else {
      // no seat and no team set up: the department's recruiters (the same fallback as the Team page)
      const deps = mine.departments || [];
      const rows = deps.length ? await prisma.user.findMany({ where: { atsDepartment: { in: deps }, atsRole: 'RECRUITER' }, select: { id: true } }) : [];
      ownIds = uniq([user.id, ...rows.map((r) => r.id)]);
    }
    // the TLs inside an STL's tree, each with their own team (for the picker and the "TL" column)
    const people = await usersById(ownIds);
    const tlIds = people.filter((u) => u.atsRole === 'TL' && u.id !== user.id).map((u) => u.id);
    teams = kind === 'stl' ? await leadTeams(tlIds, user) : [];
    if (kind === 'tl') teams = [{ lead: people.find((u) => u.id === user.id) || { id: user.id, name: user.name }, ids: ownIds, seatIds }];
  } else {
    // an Assistant Manager with teams assigned sees those teams only (identity.atsTeamUserIds); a Manager / Admin everyone
    const sc = S.atsScopeOf(user);
    if (kind === 'mgmt' && sc.teamUserIds) {
      ownIds = uniq([user.id, ...sc.teamUserIds]);
      const inTeams = await usersById(ownIds);
      teams = await leadTeams(inTeams.filter((u) => u.atsRole === 'TL').map((u) => u.id), user);
    } else teams = await leadTeams(null, user);
  }

  // the TL picker (one or several team leads)
  const leadId = leadIds.join(',');
  for (const lid of leadIds) {
    if (kind === 'tl' && lid !== user.id) return { ok: false, status: 403, error: 'That team is not yours.' };
    if (kind === 'stl' && lid !== user.id && !teams.some((t) => t.lead.id === lid)) return { ok: false, status: 403, error: 'That team is not under you.' };
    if (['admin', 'mgmt'].includes(kind) && !teams.some((t) => t.lead.id === lid)) return { ok: false, status: 404, error: 'That team lead was not found.' };
  }
  const otherLeads = leadIds.includes(user.id) ? [] : leadIds;
  const leadLabel = otherLeads.map((lid) => `${(teams.find((t) => t.lead.id === lid) || { lead: { name: 'Team' } }).lead.name}'s team`).join(', ');

  // which ids are in the picture
  let ids;
  let seats = seatIds;
  let leadByUser = new Map();
  teams.forEach((t) => (t.ids || []).forEach((id) => { if (!leadByUser.has(id) && id !== t.lead.id) leadByUser.set(id, t.lead.name); }));
  if (kind === 'tl') {
    ids = ownIds;
    leadByUser = new Map(ids.filter((id) => id !== user.id).map((id) => [id, user.name]));
  } else if (otherLeads.length) {
    // the teams of the ticked team leads, together
    const picked = otherLeads.map((lid) => teams.find((x) => x.lead.id === lid)).filter(Boolean);
    ids = uniq(picked.flatMap((t) => t.ids || [t.lead.id]));
    seats = uniq(picked.flatMap((t) => t.seatIds || []));
    leadByUser = new Map();
    picked.forEach((t) => (t.ids || []).forEach((id) => { if (id !== t.lead.id && !leadByUser.has(id)) leadByUser.set(id, t.lead.name); }));
  } else if (ownIds) {
    ids = ownIds;
  } else {
    ids = null; // admin / manager: everyone in the recruiting roles
    seats = uniq(teams.flatMap((t) => t.seatIds));
  }

  let people = ids ? await usersById(ids) : await prisma.user.findMany({ where: { atsRole: { in: TEAM_ROLES } }, select: PERSON_SELECT });
  people = people.filter(keep);
  const currentIds = new Set(people.map((p) => p.id));
  // people who held the team's seats and have left (or moved on): their days in the team stay the team's
  const former = ids || leadId ? await formerHolders(seats, currentIds) : new Map();
  const formerUsers = (await usersById([...former.keys()])).filter(keep);

  const members = [
    ...people.map((p) => shapePerson(p, { leadName: p.atsRole === 'TL' ? null : (leadByUser.get(p.id) || null), former: false, windows: null })),
    ...formerUsers.map((p) => shapePerson(p, { leadName: leadByUser.get(p.id) || null, former: true, windows: former.get(p.id) })),
  ];
  // department / team pickers (Manager, Admin, STL)
  const departments = uniq(members.map((m) => m.department)).sort();
  const teamNames = uniq(members.map((m) => m.team)).sort();
  let shown = members;
  const deps = MP.parseMulti(q.department).map((v) => v.toLowerCase());
  const tms = MP.parseMulti(q.team).map((v) => v.toLowerCase());
  if (deps.length) shown = shown.filter((m) => deps.includes(String(m.department || '').toLowerCase()));
  if (tms.length) shown = shown.filter((m) => tms.includes(String(m.team || '').toLowerCase()));
  if (q.personId) {
    shown = shown.filter((m) => m.id === String(q.personId));
    if (!shown.length) return { ok: false, status: 403, error: 'That person is not in the team you are looking at.' };
  }
  if (kind === 'tl' && (q.department || q.team)) { /* a TL's picker is just their own team */ }
  return {
    ok: true,
    kind,
    mode: 'team',
    members: shown,
    memberIds: new Set(shown.map((m) => m.id)),
    leads: ['admin', 'mgmt', 'stl'].includes(kind) ? teams.map((t) => ({ id: t.lead.id, name: t.lead.name, count: Math.max(0, (t.ids || []).length - 1) })) : null,
    departments: ['admin', 'mgmt', 'stl'].includes(kind) ? departments : [],
    teams: ['admin', 'mgmt', 'stl'].includes(kind) ? teamNames : [],
    leadId,
    personId: q.personId ? String(q.personId) : '',
    label: kind === 'tl' ? 'My team' : otherLeads.length ? leadLabel : leadId ? `${(teams.find((t) => t.lead.id === leadId) || { lead: { name: 'Team' } }).lead.name}'s team` : (kind === 'stl' ? 'My TLs\' teams' : 'Everyone'),
  };
}

/** Is `day` (YYYY-MM-DD) a day this member's follow-ups belong to the team? (a former seat holder: only their days there) */
function inWindow(member, day) {
  if (!member || !member.windows) return true;
  return member.windows.some((w) => (!w.from || day >= w.from) && (!w.to || day <= w.to));
}

/**
 * For the candidate page's follow-up list: which authors' lines may this login see, and who is in the "Who" dropdown.
 *   -> { mode: 'mine' | 'team' | 'all', people: [{ id, name, role }], ids: Set | null (null = everyone) }
 * Recruiter: themselves only. TL / STL: their team. Everyone else (Manager, Admin, BDE side): unchanged - every line.
 */
async function candidateListScope(user) {
  const kind = viewerKind(user);
  if (kind === 'recruiter') {
    return { mode: 'mine', people: [{ id: user.id, name: user.name, role: 'Recruiter' }], ids: new Set([user.id]) };
  }
  if (kind === 'tl' || kind === 'stl') {
    const r = await resolve(user, {});
    if (!r.ok) return { mode: 'mine', people: [{ id: user.id, name: user.name, role: ROLE_LABEL[user.atsRole] || '' }], ids: new Set([user.id]) };
    return { mode: 'team', people: r.members.map((m) => ({ id: m.id, name: m.name, role: m.role })), ids: r.memberIds };
  }
  return { mode: 'all', people: null, ids: null };
}

module.exports = {
  resolve, inWindow, candidateListScope, viewerKind, REPORT_VIEWERS, TEAM_ROLES,
};

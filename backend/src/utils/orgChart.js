// ---------------------------------------------------------------------------
// THE ORGANISATION CHART — who reports to whom, drawn from what the app already knows.
//
// No new data is kept anywhere. The chart is BUILT, on every request, from
//   * Employee.reportingManagerId   the manager HR picked (the explicit line)
//   * Employee.tl / Employee.stl    the TL / STL named on the record (by name, the same way
//                                   Employee Management -> TL-wise matches them)
//   * Positions (seats)             the seat a person holds reports to another seat (Positions & Seat History)
//   * the login's role / designation  which level a person is (Super Admin, Manager, Assistant Manager, STL, TL, Employee)
//   * Attendance + approved leave of TODAY
//
// This file is PURE (no database): routes/orgChart.js reads the rows and hands them in, so the whole
// tree logic can be tested with plain objects (scripts/org-chart-test.js).
//
// THE RULES, in plain words
//   1. A person's boss is the first of these that points at somebody who is on the chart now:
//        reporting manager -> TL named on the record -> STL named on the record -> the seat they hold reports to.
//      A boss must be MORE senior (an explicit reporting manager may be equally senior). A line that would
//      loop (A under B under A) is cut at the person it would loop back to.
//   2. A line that ends at the Super Admin / Admin means "reports to the top": the person is shown in
//      their department instead, so the department boxes sit right under the Super Admin.
//   3. A TL named on the record who is NOT on the chart (left, or not an employee record) still keeps their
//      team together: the team hangs under a grey "TL not on the chart" box so HR can see and fix it.
//   4. Managers / Assistant Managers work across departments: they sit directly under the Super Admin,
//      with whoever reports to them below.
//   5. Everybody else without a boss goes to their department; in a department that has TLs, the people
//      without one are kept together under "No TL assigned yet".
// ---------------------------------------------------------------------------

const LEVELS = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'EMPLOYEE'];
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const LEVEL_LABEL = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager', STL: 'STL', TL: 'TL', EMPLOYEE: 'Employee',
};

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const key = (s) => squash(s).toLowerCase();

// The level a ROLE CODE stands for ('NONE', 'RECRUITER', 'HR' ... are ordinary staff on the chart).
function levelOfRole(code) {
  const c = String(code || '').toUpperCase();
  return LEVELS.includes(c) ? c : 'EMPLOYEE';
}

// The level a DESIGNATION names. Deliberately strict: "Project Manager" or "Account Manager" are job titles, not the
// Manager role, so only the plain role words count (the same words the Designation -> role table is built on).
function levelOfDesignation(text) {
  const t = key(text).replace(/[._]/g, ' ').replace(/\s+/g, ' ');
  if (['super admin', 'superadmin'].includes(t)) return 'SUPER_ADMIN';
  if (t === 'admin') return 'ADMIN';
  if (['assistant manager', 'asst manager', 'asst. manager', 'assistant mgr'].includes(t)) return 'ASSISTANT_MANAGER';
  if (t === 'manager') return 'MANAGER';
  if (['stl', 'senior team lead', 'senior team leader'].includes(t)) return 'STL';
  if (['tl', 'team lead', 'team leader'].includes(t)) return 'TL';
  return 'EMPLOYEE';
}

// The most senior of: the HRMS role, the login's role, the designation. (The ATS role is NOT used: it only says what a
// person may do in recruitment, not where they sit in the company.)
function levelOf(employee) {
  const u = employee.user || {};
  const cands = [levelOfRole(u.hrmsRole), levelOfRole(u.role), levelOfDesignation(employee.designation)];
  return cands.sort((a, b) => RANK[a] - RANK[b])[0];
}

const GENERIC_TITLES = ['employee', 'staff', ''];

function presenceOf(attendanceStatus, onLeave) {
  const s = String(attendanceStatus || '').toLowerCase();
  if (s === 'present') return 'present';
  if (s === 'late') return 'late';
  if (s === 'half day' || s === 'half-day' || s === 'halfday') return 'half';
  if (s === 'leave' || s === 'on leave') return 'leave';
  if (s === 'absent') return 'absent';
  if (onLeave) return 'leave';
  return null;
}

/**
 * employees   [{ id, employeeCode, name, designation, department, team, tl, stl, reportingManagerId, hrStatus,
 *               user: { role, hrmsRole } | null, seatCode?, seatReportsToEmployeeId? }]   (people ON the chart: not left)
 * attendance  Map(employeeId -> status string of today)
 * onLeave     Set(employeeId)  approved leave covering today
 * superAdminLogins  [{ name }]   SUPER_ADMIN logins that have no employee record (shown only when nobody else is on top)
 */
function build({
  employees = [], attendance = new Map(), onLeave = new Set(), superAdminLogins = [], today = null, viewerEmployeeId = null,
} = {}) {
  const people = employees.map((e) => {
    const level = levelOf(e);
    const title = squash(e.designation);
    return {
      id: e.id,
      code: e.employeeCode || null,
      name: squash(e.name) || '—',
      level,
      rank: RANK[level],
      levelLabel: LEVEL_LABEL[level],
      title: level === 'EMPLOYEE' ? (GENERIC_TITLES.includes(title.toLowerCase()) ? 'Employee' : title) : LEVEL_LABEL[level],
      designation: title || null,
      department: squash(e.department) || null,
      team: squash(e.team) || null,
      status: e.hrStatus || 'Active',
      seat: e.seatCode || null,
      presence: presenceOf(attendance.get(e.id), onLeave.has(e.id)),
      _raw: e,
    };
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  // name -> people (a name can be shared; the same department wins)
  const byName = new Map();
  people.forEach((p) => {
    const k = key(p.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  });
  const pickByName = (name, like) => {
    const list = byName.get(key(name));
    if (!list || !list.length) return null;
    return list.find((x) => x.id !== like.id && x.department === like.department) || list.find((x) => x.id !== like.id) || null;
  };

  // --- who is the top -------------------------------------------------------
  const saPeople = people.filter((p) => p.level === 'SUPER_ADMIN').sort((a, b) => a.name.localeCompare(b.name));
  const isTop = (p) => p.rank <= RANK.ADMIN; // Super Admin or Admin: "reports to the top"

  // --- each person's boss ---------------------------------------------------
  const parentOf = new Map(); // id -> person
  const ghostOf = new Map(); // id -> the TL's name (a TL named on the record who is not on the chart)
  people.forEach((p) => {
    if (p.level === 'SUPER_ADMIN') return;
    const r = p._raw;
    const tries = [];
    if (r.reportingManagerId && byId.has(r.reportingManagerId)) tries.push({ who: byId.get(r.reportingManagerId), explicit: true });
    if (squash(r.tl)) tries.push({ who: pickByName(r.tl, p), explicit: false, name: squash(r.tl) });
    if (squash(r.stl)) tries.push({ who: pickByName(r.stl, p), explicit: false, name: squash(r.stl) });
    if (r.seatReportsToEmployeeId && byId.has(r.seatReportsToEmployeeId)) tries.push({ who: byId.get(r.seatReportsToEmployeeId), explicit: false });
    let chosen = null;
    for (const t of tries) {
      const w = t.who;
      if (!w || w.id === p.id) continue; // eslint-disable-line no-continue
      const senior = t.explicit ? w.rank <= p.rank : w.rank < p.rank;
      if (!senior) continue; // eslint-disable-line no-continue
      if (isTop(w)) continue; // eslint-disable-line no-continue
      chosen = w; break;
    }
    if (chosen) { parentOf.set(p.id, chosen); return; }
    // a TL named on the record who is not on the chart: keep the team together under a grey box
    const named = tries.find((t) => t.name && !t.who);
    if (named && p.level !== 'TL' && p.level !== 'STL') ghostOf.set(p.id, named.name);
  });

  // a line that loops is cut at the person where it started
  people.forEach((p) => {
    const seen = new Set([p.id]);
    let cur = parentOf.get(p.id);
    while (cur) {
      if (cur.id === p.id) { parentOf.delete(p.id); break; }
      if (seen.has(cur.id)) break; // a loop that does not include this person: its own members cut it
      seen.add(cur.id);
      cur = parentOf.get(cur.id);
    }
  });

  // --- children lists ---------------------------------------------------------
  const kids = new Map();
  people.forEach((p) => {
    const par = parentOf.get(p.id);
    if (!par) return;
    if (!kids.has(par.id)) kids.set(par.id, []);
    kids.get(par.id).push(p);
  });
  const byRankName = (a, b) => (a.rank - b.rank) || (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name);

  const personNode = (p) => {
    const sub = (kids.get(p.id) || []).sort(byRankName).map(personNode);
    const par = parentOf.get(p.id);
    const node = {
      id: p.id, type: 'person', name: p.name, code: p.code, level: p.level, levelLabel: p.levelLabel, title: p.title,
      department: p.department, team: p.team, status: p.status, seat: p.seat, presence: p.presence,
      reportsTo: par ? par.name : (ghostOf.has(p.id) ? ghostOf.get(p.id) : null),
      messageable: true, isViewer: viewerEmployeeId === p.id,
      children: sub,
    };
    return node;
  };

  // --- who has no boss: leaders, then departments ---------------------------
  const unplaced = people.filter((p) => p.level !== 'SUPER_ADMIN' && !parentOf.has(p.id));
  const leaders = unplaced.filter((p) => p.rank <= RANK.ASSISTANT_MANAGER && !ghostOf.has(p.id)).sort(byRankName);
  const rest = unplaced.filter((p) => !leaders.includes(p));

  const deptNames = [...new Set(rest.map((p) => p.department || 'No department'))];
  const deptNodes = deptNames.map((dept) => {
    const inDept = rest.filter((p) => (p.department || 'No department') === dept);
    const leads = inDept.filter((p) => p.rank <= RANK.TL && !ghostOf.has(p.id)).sort(byRankName);
    const plain = inDept.filter((p) => p.rank > RANK.TL && !ghostOf.has(p.id)).sort(byRankName);
    // the teams of TLs who are not on the chart
    const ghosts = new Map();
    inDept.filter((p) => ghostOf.has(p.id)).forEach((p) => {
      const k = key(ghostOf.get(p.id));
      if (!ghosts.has(k)) ghosts.set(k, { name: ghostOf.get(p.id), members: [] });
      ghosts.get(k).members.push(p);
    });
    const children = leads.map(personNode);
    [...ghosts.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((g) => {
      children.push({
        id: `ghost:${dept}:${key(g.name)}`, type: 'ghost', name: g.name, title: 'TL not on the chart', department: dept,
        note: 'This name is written as the TL on these records, but there is no current employee with that name. Fix it in Employee Management.',
        messageable: false, children: g.members.sort(byRankName).map(personNode),
      });
    });
    if (plain.length) {
      if (children.length) {
        children.push({
          id: `bucket:${dept}`, type: 'bucket', name: 'No TL assigned yet', title: 'Not under a TL', department: dept, messageable: false,
          note: 'These people have no TL / manager on their record.', children: plain.map(personNode),
        });
      } else plain.forEach((p) => children.push(personNode(p)));
    }
    return { id: `dept:${dept}`, type: 'dept', name: dept, title: 'Department', department: dept, messageable: false, children };
  });

  // --- counts (people under a box, not counting boxes) ------------------------
  const tally = (n) => {
    let size = 0;
    (n.children || []).forEach((c) => { tally(c); size += c.size + (c.type === 'person' ? 1 : 0); });
    n.size = size;
    n.directs = (n.children || []).reduce((s, c) => s + (c.type === 'person' ? 1 : c.size), 0);
    return n;
  };
  deptNodes.forEach((d) => {
    d.teams = [...new Set((d.children || []).filter((c) => c.type === 'person' && c.level === 'TL' && c.team).map((c) => c.team))].length;
  });

  // --- the root --------------------------------------------------------------
  const topKids = [...leaders.map(personNode), ...deptNodes.sort((a, b) => {
    const sa = (a.children || []).length; const sb = (b.children || []).length; // bigger departments first, "No department" last
    if (a.name === 'No department') return 1;
    if (b.name === 'No department') return -1;
    return sb - sa || a.name.localeCompare(b.name);
  })];
  let root;
  if (saPeople.length === 1) {
    const sa = saPeople[0];
    root = personNode(sa);
    root.children = [...root.children, ...topKids];
  } else {
    root = {
      id: 'top', type: 'top', name: 'Super Admin', title: saPeople.length ? 'Super Admins' : 'Top of the company',
      messageable: false, department: null,
      note: saPeople.length ? null : (superAdminLogins.length
        ? `Super Admin login${superAdminLogins.length > 1 ? 's' : ''}: ${superAdminLogins.map((l) => l.name).join(', ')} (no employee record)`
        : null),
      children: [...saPeople.map(personNode), ...topKids],
    };
  }
  tally(root);

  // --- the numbers on top ------------------------------------------------------
  const count = (fn) => people.filter(fn).length;
  const stats = {
    people: people.length,
    departments: deptNames.filter((d) => d !== 'No department').length,
    managers: count((p) => p.rank >= RANK.MANAGER && p.rank <= RANK.ASSISTANT_MANAGER),
    leads: count((p) => p.level === 'STL' || p.level === 'TL'),
    present: count((p) => p.presence === 'present' || p.presence === 'late'),
    half: count((p) => p.presence === 'half'),
    leave: count((p) => p.presence === 'leave'),
    absent: count((p) => p.presence === 'absent'),
    notMarked: count((p) => !p.presence),
  };
  const tidy = {
    teamsOfMissingTl: [...ghostOf.values()].map(key).filter((v, i, a) => a.indexOf(v) === i).length,
    withoutTl: unplaced.filter((p) => p.rank > RANK.TL && !ghostOf.has(p.id)).length,
  };
  return { today, stats, tidy, root };
}

module.exports = { build, levelOf, levelOfDesignation, LEVELS, RANK, LEVEL_LABEL };

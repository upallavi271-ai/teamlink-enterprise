// ---------------------------------------------------------------------------
// THE INVOICE PAGE'S CASCADING FILTER — Client -> Department -> Section ->
// Employee -> results, computed in the browser from the ONE hierarchy payload
// GET /invoices/register returns (backend/src/utils/invoiceHierarchy.js), so
// every dropdown is instant and no request is made per change.
//
//   hierarchy.departments  [{ name, label, sections: [{ key, label, department, seats }] }]
//   hierarchy.people       [{ key: 'e:<employeeId>', name, current, entries: [{ role,
//                            seat, department, sectionKey, section, from, to, current,
//                            reportingTl }] }]  — current AND former seat holders
//
// Filter values: dept = department name, section = section key
// ("Education|Team A"), rec = employee key. An invoice row carries
// department / sectionKey / recruiterKey / tlKey from the same attribution, so
// the table, totals and the waiting-joinings card are filtered by ID, never by
// a name string.
// ---------------------------------------------------------------------------
export const ALL = 'All';

const EMPTY_H = { departments: [], people: [] };
const h0 = (h) => h || EMPTY_H;

const monthYear = (iso) => (iso
  ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
  : '');

export function allSections(h) {
  return h0(h).departments.flatMap((d) => d.sections.map((s) => ({ ...s, departmentLabel: d.label })));
}
export const sectionByKey = (h, key) => allSections(h).find((s) => s.key === key) || null;
export const personByKey = (h, key) => h0(h).people.find((p) => p.key === key) || null;
export const deptLabelOf = (h, name) => (h0(h).departments.find((d) => d.name === name) || {}).label || name;

// Department options: the hierarchy's departments, then any other department
// an invoice sits in (so no invoice is unreachable).
export function departmentOptions(h, extra = []) {
  const known = h0(h).departments.map((d) => ({ value: d.name, label: d.label }));
  const more = [...new Set(extra.filter((d) => d && d !== '—' && !known.some((k) => k.value === d)))].sort()
    .map((d) => ({ value: d, label: d }));
  return [...known, ...more];
}

// Section options: only the chosen department's; with All departments, all.
export function sectionOptions(h, dept) {
  const deps = h0(h).departments.filter((d) => dept === ALL || d.name === dept);
  const many = deps.length > 1;
  return deps.flatMap((d) => d.sections.map((s) => ({
    value: s.key,
    label: many ? `${d.label} · ${s.label}` : s.label,
    section: s,
  })));
}

// The seats a person held inside the department / section / role (seat) in view.
export function entriesIn(p, dept, section, role = ALL) {
  return ((p && p.entries) || []).filter((e) => (dept === ALL || e.department === dept)
    && (section === ALL || e.sectionKey === section)
    && (!role || role === ALL || e.seat === role));
}

// Role options: the seats of the department / section in view — its TL seat(s)
// first, then EDU-1, EDU-2… — read from the stored structure, never typed in.
// With one section the TL seat is just its code; with several, the section
// is added so two TL seats can be told apart.
export function roleOptions(h, dept, section = ALL) {
  const deps = h0(h).departments.filter((d) => dept === ALL || d.name === dept);
  const out = [];
  const seen = new Set();
  deps.forEach((d) => d.sections.forEach((s) => {
    if (section !== ALL && s.key !== section) return;
    (s.seats || []).forEach((code) => {
      if (seen.has(code)) return;
      seen.add(code);
      const isTl = code === s.tlSeat;
      out.push({
        value: code,
        label: isTl && d.sections.length > 1 ? `${code} (TL · ${s.label})` : (isTl ? `${code} (TL)` : code),
        tl: isTl,
        department: d.name,
      });
    });
  }));
  return out;
}

// Does an invoice row sit under this role (seat)? Its own seat, or — for a TL
// seat — the TL seat the row's TL held.
export const roleMatch = (r, role) => !role || role === ALL || r.seat === role || r.tlSeat === role;

const latest = (entries) => [...entries].sort((a, b) => String(b.from || '').localeCompare(String(a.from || '')))[0] || null;

// "Name · Recruiter · MED-3 · left Jun 2026" — like the ATS people filters.
export function personLabel(p, entries) {
  if (!p) return '';
  if (p.unplaced) return `${p.name} · ${(p.roles || []).join(' / ') || '—'} · not in the team structure`;
  const e = latest(entries.length ? entries : p.entries || []);
  if (!e) return p.name;
  let when = '';
  if (!e.current) {
    if (!p.current) when = `Former · left${e.to ? ` ${monthYear(e.to)}` : ''}`;
    else if (e.to) when = `until ${monthYear(e.to)}`;
  }
  const earlier = (entries.length ? entries : p.entries || []).filter((x) => x !== e)
    .map((x) => `${x.role} ${x.seat}`);
  return [p.name, e.role, e.seat, when, earlier.length ? `earlier ${earlier.join(', ')}` : '']
    .filter(Boolean).join(' · ');
}

// Employee options for the department / section in view: its TL(s) and
// recruiters, current first, then former — the stored structure only. (A name
// an invoice carries that holds no seat in the structure is not offered; its
// invoices are still reached through their department.)
export function employeeOptions(h, dept, section, role = ALL) {
  const list = h0(h).people.filter((p) => !p.unplaced && entriesIn(p, dept, section, role).length > 0);
  const scoped = list.map((p) => ({ p, entries: entriesIn(p, dept, section, role) }));
  const isCurrent = ({ p, entries }) => (entries.length ? entries.some((e) => e.current) : !!p.current);
  return [...scoped.filter(isCurrent), ...scoped.filter((x) => !isCurrent(x))]
    .map((x) => ({
      value: x.p.key, label: personLabel(x.p, x.entries), person: x.p, current: isCurrent(x),
    }));
}

// The chip beside the Employee name: their actual role and place, e.g.
//   Recruiter · Education · Section A · Reporting TL: D.Leela Usha Sri
//   TL · Education · Section B
export function describeEmployee(h, key, dept = ALL, section = ALL, role = ALL) {
  const p = personByKey(h, key);
  if (!p) return null;
  if (p.unplaced) {
    return {
      role: (p.roles || []).join(' / '),
      text: `${(p.roles || []).join(' / ') || 'Worked'} · ${(p.departments || []).map((d) => deptLabelOf(h, d)).join(', ') || '—'} · not in the team structure`,
    };
  }
  const inView = entriesIn(p, dept, section, role);
  const e = latest(inView.length ? inView : p.entries);
  if (!e) return { role: '', text: p.name };
  const sec = sectionByKey(h, e.sectionKey);
  const bits = [e.role, deptLabelOf(h, e.department), sec ? sec.label : e.section, e.seat];
  if (e.role !== 'TL' && e.reportingTl) bits.push(`Reporting TL: ${e.reportingTl.name}`);
  if (!e.current) {
    if (!p.current) bits.push(`left${e.to ? ` ${monthYear(e.to)}` : ''}`);
    else if (e.to) bits.push(`until ${monthYear(e.to)}`);
  }
  return { role: e.role, text: bits.filter(Boolean).join(' · ') };
}

// Drop any selection the current department / section makes invalid, so no
// stale choice silently filters the results.
export function reconcile(f, h, validDepts = null) {
  const next = { ...f };
  if (next.dept !== ALL && validDepts && !validDepts.includes(next.dept)) next.dept = ALL;
  if (next.section !== ALL) {
    const s = sectionByKey(h, next.section);
    if (!s || (next.dept !== ALL && s.department !== next.dept)) next.section = ALL;
  }
  // A role (seat) must belong to the department / section; an old saved job-title value goes back to All.
  if (next.role && next.role !== ALL && !roleOptions(h, next.dept, next.section).some((o) => o.value === next.role)) next.role = ALL;
  if (next.rec !== ALL && !employeeOptions(h, next.dept, next.section, next.role || ALL).some((o) => o.value === next.rec)) next.rec = ALL;
  return next;
}

// One filter changes -> the dependent ones follow. Picking a section with
// All departments selects its department too; a department change clears a
// section / employee outside it.
export function changeFilter(f, field, value, h, validDepts = null) {
  const v = value === '' || value == null ? ALL : value;
  const next = { ...f, [field]: v };
  if (field === 'section' && v !== ALL) {
    const s = sectionByKey(h, v);
    if (s) next.dept = s.department;
  }
  // Picking a seat with All departments selects its department, like a section does.
  if (field === 'role' && v !== ALL && next.dept === ALL) {
    const o = roleOptions(h, ALL, next.section).find((x) => x.value === v);
    if (o) next.dept = o.department;
  }
  return reconcile(next, h, validDepts);
}

// Does an invoice row / a waiting joining pass the hierarchy filters?
export function matchesHierarchy(r, f) {
  if (f.dept !== ALL && r.department !== f.dept) return false;
  if (f.section !== ALL && r.sectionKey !== f.section) return false;
  if (f.rec !== ALL && r.recruiterKey !== f.rec && r.tlKey !== f.rec) return false;
  if (f.role && f.role !== ALL && !roleMatch(r, f.role)) return false;
  return true;
}
// The Invoice page (S7) holds Client (client IDS) and Recruiter as lists (f.clients,
// f.recs — '__none' = Unassigned); a single f.client still works.
const clientsOf = (f) => (Array.isArray(f.clients) ? f.clients : (f.client && f.client !== ALL ? [f.client] : []));
export function matchesJoining(r, f) {
  const cl = clientsOf(f);
  if (cl.length && !cl.includes(r.clientId)) return false; // by the client's ID, never the name
  if (Array.isArray(f.recs) && f.recs.length && !f.recs.includes(r.recruiterKey || '__none')) return false;
  return matchesHierarchy(r, f);
}
export const hierarchyActive = (f) => clientsOf(f).length > 0 || (Array.isArray(f.recs) && f.recs.length > 0)
  || f.dept !== ALL || f.section !== ALL || f.rec !== ALL || (!!f.role && f.role !== ALL);

// The "joinings have no invoice number yet" card under the filters. With no
// Client / Department / Section / Employee filter it is the server's own.
export function waitingUnder(ni, f) {
  if (!ni || !hierarchyActive(f) || !Array.isArray(ni.rows)) return { ...ni, filtered: false };
  const rows = ni.rows.filter((r) => matchesJoining(r, f));
  const round = (n) => Math.round(n * 100) / 100;
  const billing = round(rows.reduce((s, r) => s + (r.billing != null ? Number(r.billing) : 0), 0));
  const gst = rows.reduce((s, r) => s + (r.billing != null ? Number(r.billing) * Number(r.gstPercent || 0) / 100 : 0), 0);
  const ids = new Set(rows.map((r) => r.applicationId));
  const groups = (ni.groups || []).map((g) => ({ ...g, inView: g.rows.filter((x) => ids.has(x.applicationId)).length }))
    .filter((g) => g.inView > 0);
  return {
    ...ni,
    filtered: true,
    waiting: rows.length,
    billing,
    invoiceValue: round(billing + gst),
    recent: rows.slice(0, 12),
    notBillable: rows.filter((r) => !r.billable),
    groups,
  };
}

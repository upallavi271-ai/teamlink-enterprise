import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// SUPER ADMIN "DASHBOARD OF" (2026-11-10): Role -> Person on the ATS dashboard.
//
// Picking a login draws THAT login's own dashboard here (its panels, charts and
// numbers), read-only, without leaving the Super Admin's session. The server
// does the work (routes/dashboard.js boardSubject, ?asUser=); this is only the
// picker. The people come from the View as list (GET /admin/view-as/people),
// which is Super Admin only and already leaves out Super Admin logins.
// ---------------------------------------------------------------------------

// The roles that have an ATS dashboard of their own, in the order they are listed.
// A TL in the BDE department gets the BDE team's page, so they are listed apart.
export const DASHBOARD_ROLES = [
  ['ADMIN', 'Admin'], ['MANAGER', 'Manager'], ['ASSISTANT_MANAGER', 'Assistant Manager'], ['STL', 'STL'],
  ['TL', 'TL'], ['BDE_TL', 'BDE TL'], ['BDE', 'BDE'], ['RECRUITER', 'Recruiter'], ['HR', 'HR'],
];
const ROLE_LABEL = Object.fromEntries(DASHBOARD_ROLES);
const isBdeDept = (d) => /^bde$/i.test(String(d || '').trim());
export function roleOfPerson(p) {
  if (!p) return '';
  if (p.group === 'TL' && isBdeDept(p.department)) return 'BDE_TL';
  return ROLE_LABEL[p.group] ? p.group : '';
}
const personText = (p) => [p.name, p.department, p.section && p.section !== p.department ? p.section : null].filter(Boolean).join(' · ');

export default function DashboardOfPicker({ value, onPick }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState('');
  const [role, setRole] = useState('');

  useEffect(() => {
    let alive = true;
    api.get('/admin/view-as/people')
      .then((r) => { if (alive) setPeople((r.data && r.data.people) || []); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'The list of logins did not load. Refresh the page to try again.'); });
    return () => { alive = false; };
  }, []);

  const byRole = useMemo(() => {
    const out = {};
    // Only logins that can open an ATS dashboard: they hold the ATS and have not left.
    (people || []).filter((p) => p.ats !== false && !p.left).forEach((p) => {
      const r = roleOfPerson(p);
      if (r) (out[r] = out[r] || []).push(p);
    });
    return out;
  }, [people]);
  const current = useMemo(() => (people && value ? people.find((p) => String(p.id) === String(value)) : null), [people, value]);
  // The role box follows the person picked (a link with ?as= opens on the right role).
  useEffect(() => {
    if (current) setRole(roleOfPerson(current));
    else if (!value) setRole('');
  }, [current, value]);

  const pickRole = (r) => {
    setRole(r);
    if (!r) { onPick(''); return; }
    const first = (byRole[r] || [])[0];
    if (first) onPick(String(first.id));
  };
  const roles = DASHBOARD_ROLES.filter(([k]) => (byRole[k] || []).length > 0);
  const list = byRole[role] || [];

  return (
    <div className="dof" role="group" aria-label="Dashboard of">
      <label className="lph-facet dof-f">
        <span className="lph-facet-lbl">Dashboard of</span>
        <Combo value={role} onChange={(e) => pickRole(e.target.value)} aria-label="Dashboard of: role" departments={false} disabled={!people}>
          <option value="">{people ? 'Me (whole company)' : (error ? 'Not available' : 'Loading…')}</option>
          {roles.map(([k, l]) => <option key={k} value={k}>{`${l} (${byRole[k].length})`}</option>)}
        </Combo>
      </label>
      {role && list.length > 0 && (
        <label className="lph-facet dof-f">
          <span className="lph-facet-lbl">Person</span>
          <Combo value={value ? String(value) : ''} onChange={(e) => onPick(e.target.value)} aria-label="Dashboard of: person" departments={false}>
            {list.map((p) => <option key={p.id} value={String(p.id)}>{personText(p)}</option>)}
          </Combo>
        </label>
      )}
      {error && <span className="small-muted dof-err">{error}</span>}
    </div>
  );
}

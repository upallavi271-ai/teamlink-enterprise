import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// Vacancies on the dashboard (founder 2026-11-02: "dashboard medha vacancies enni unai anni kuda kanipinchali").
// Planned people per department and role (STL / TL / Employee) vs who is working now. Server: GET /dashboard/vacancies (utils/vacancies.js).
// The dashboard shows ONE small card (the number of vacancies); a click opens the table. A login that may not see it gets 403 and the card is simply not shown. Only the Super Admin changes the plan ("Change numbers").
const red = '#b42318';
const green = '#1c7c4a';

// the numbers (null until loaded, or when this login may not see them)
export function useVacancies() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/dashboard/vacancies').then((r) => { if (alive) setD(r.data); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return [d, setD];
}

// WHICH POSITIONS ARE VACANT, DEPARTMENT BY DEPARTMENT (founder 2026-11-13: "dashboard lo vacancies card lo positions wise vacancies em unai,
// ahh department lo kavali"): one line per department (or per team of a department that is split into teams), listing only the positions
// (STL / TL / Employee) that still have a vacancy, e.g. "Medical: TL 1 · Employee 2". The same numbers as the table in the popup.
export function vacantByDepartment(d) {
  const out = [];
  ((d && d.groups) || []).forEach((g) => {
    const parts = (rows) => (rows || []).filter((r) => r.vacant > 0).map((r) => ({ role: r.role, n: r.vacant }));
    // a department split into teams: its TL / Employee rows are the teams added together, so show the teams (and the roles the teams do not plan, the STL)
    const split = new Set((g.teams || []).flatMap((t) => t.rows.map((r) => r.role)));
    const own = parts((g.rows || []).filter((r) => !split.has(r.role)));
    if (own.length) out.push({ label: g.name, parts: own });
    (g.teams || []).forEach((t) => { const p = parts(t.rows); if (p.length) out.push({ label: `${g.name} · ${t.name}`, parts: p }); });
  });
  return out;
}

// the small card (the Super Admin / Admin home); the HRMS dashboard shows the same number as a tile in its Attendance row
export default function Vacancies() {
  const [d, setD] = useVacancies();
  const [show, setShow] = useState(false);
  if (!d) return null;
  const t = d.totals;
  const lines = vacantByDepartment(d);
  return (
    <>
      {/* founder 2026-11-02: "vacancies okka card evvu dani medha click chestey ahh table open avali" */}
      <button
        type="button" className="card" onClick={() => setShow(true)} aria-label={`Vacancies: ${t.vacant}. Open the table`}
        style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '14px 18px', margin: '16px 0', minWidth: 220, maxWidth: 560, textAlign: 'left', cursor: 'pointer', border: '1px solid var(--line, #e5e7eb)' }}
      >
        <span className="small-muted" style={{ fontSize: 12 }}>Vacancies</span>
        <b style={{ fontSize: 28, lineHeight: 1.1, color: t.vacant ? red : green }}>{t.vacant}</b>
        <span className="small-muted" style={{ fontSize: 12 }}>Should have {t.planned} · Working {t.filled}</span>
        {lines.length ? (
          <span style={{ display: 'block', width: '100%', marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--line, #e5e7eb)' }} aria-label="Vacant positions by department">
            {lines.map((l) => (
              <span key={l.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13, lineHeight: 1.6 }}>
                <b>{l.label}</b>
                <span>{l.parts.map((p, i) => <span key={p.role}>{i ? ' · ' : ''}{p.role} <b style={{ color: red }}>{p.n}</b></span>)}</span>
              </span>
            ))}
          </span>
        ) : <span style={{ fontSize: 12, color: green }}>No position is vacant</span>}
        <span style={{ fontSize: 12, color: 'var(--primary, #1a56db)' }}>See the full table →</span>
      </button>
      {show ? <VacanciesPopup d={d} setD={setD} onClose={() => setShow(false)} /> : null}
    </>
  );
}

// the table by department and role, in a popup; the Super Admin changes the numbers here
export function VacanciesPopup({ d, setD, onClose }) {
  const [open, setOpen] = useState({}); // "group|role" -> names shown
  const [edit, setEdit] = useState(null); // the plan being changed
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try { const r = await api.put('/dashboard/vacancies/plan', { plan: edit }); setD(r.data); setEdit(null); } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(false); }
  }
  const setNum = (gi, role, v) => setEdit(edit.map((g, i) => (i !== gi ? g : { ...g, rows: g.rows.map((r) => (r.role === role ? { ...r, planned: v === '' ? '' : Number(v) } : r)) })));
  // the numbers of one team of a department (Education: Team A / Team B)
  const setTeamNum = (gi, ti, role, v) => setEdit(edit.map((g, i) => (i !== gi ? g : { ...g, teams: g.teams.map((t, j) => (j !== ti ? t : { ...t, rows: t.rows.map((r) => (r.role === role ? { ...r, planned: v === '' ? '' : Number(v) } : r)) })) })));
  const hasTeams = d.groups.some((g) => g.teams && g.teams.length);
  const nameList = (people) => people.map((p) => `${p.name}${p.leaving ? ' (notice)' : ''}`).join(', ');
  const t = d.totals;
  return (
    <Modal title={`Vacancies: ${t.vacant}`} size="wide" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="small-muted">Should have {t.planned} · Working now {t.filled}{t.leaving ? ` · ${t.leaving} leaving (notice period)` : ''}</span>
        <span style={{ flex: 1 }} />
        {d.canEdit && !edit ? <button type="button" className="btn btn-sm" onClick={() => setEdit(JSON.parse(JSON.stringify(d.plan)))}>Change numbers</button> : null}
      </div>

      {edit ? (
        <div style={{ marginTop: 12 }}>
          <div className="small-muted" style={{ marginBottom: 8 }}>How many people each department should have.</div>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Department</th>{d.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
            <tbody>{edit.flatMap((g, gi) => [
              <tr key={g.name}>
                <td><b>{g.name}</b></td>
                {d.roles.map((role) => {
                  const row = g.rows.find((r) => r.role === role);
                  const fromTeams = (g.teams || []).some((t) => t.rows.some((r) => r.role === role)); // a role the teams plan is the teams added together
                  if (row && fromTeams) return <td key={role}><span className="small-muted">{row.planned} (the teams below)</span></td>;
                  return <td key={role}>{row ? <input type="number" min={0} max={500} value={row.planned} onChange={(e) => setNum(gi, role, e.target.value)} style={{ width: 70 }} aria-label={`${g.name} ${role}`} /> : <span className="small-muted">—</span>}</td>;
                })}
              </tr>,
              ...(g.teams || []).map((t, ti) => (
                <tr key={`${g.name}|${t.name}`}>
                  <td><b>{g.name} · {t.name}</b></td>
                  {d.roles.map((role) => {
                    const row = t.rows.find((r) => r.role === role);
                    return <td key={role}>{row ? <input type="number" min={0} max={500} value={row.planned} onChange={(e) => setTeamNum(gi, ti, role, e.target.value)} style={{ width: 70 }} aria-label={`${g.name} ${t.name} ${role}`} /> : <span className="small-muted">—</span>}</td>;
                  })}
                </tr>
              )),
            ])}</tbody>
          </table></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setEdit(null); setErr(''); }} disabled={busy}>Cancel</button>
          </div>
          {err ? <div className="error-text" style={{ marginTop: 8 }}>{err}</div> : null}
        </div>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: 12 }}><table>
          <thead><tr><th>Department</th><th>Role</th><th>Should have</th><th>Working now</th><th>Vacant</th></tr></thead>
          <tbody>{d.groups.flatMap((g) => {
            // one row, the same look for a department and for a team of it; a team's names start open (founder 2026-11-12: Education = Team A and Team B only)
            const vrow = (label, r, k, startOpen) => {
              const shown = open[k] === undefined ? !!startOpen : open[k];
              return (
                <tr key={k}>
                  <td>{label}</td>
                  <td>{r.role}</td>
                  <td>{r.planned}</td>
                  <td>
                    {r.filled ? <button type="button" className="link-btn" onClick={() => setOpen({ ...open, [k]: !shown })} style={{ background: 'none', border: 0, padding: 0, color: 'var(--primary, #1a56db)', cursor: 'pointer' }}>{r.filled}</button> : 0}
                    {r.leaving ? <span className="small-muted"> ({r.leaving} leaving)</span> : null}
                    {r.over ? <span className="small-muted"> (+{r.over} more than planned)</span> : null}
                    {shown ? <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{nameList(r.people)}</div> : null}
                  </td>
                  <td><b style={{ color: r.vacant ? red : green }}>{r.vacant}</b></td>
                </tr>
              );
            };
            // a department split into teams shows its own roles (the STL) and then its teams: the TL / Employee rows are the teams added together, so they are not drawn twice
            const split = new Set((g.teams || []).flatMap((t) => t.rows.map((r) => r.role)));
            const out = g.rows.filter((r) => !split.has(r.role)).map((r, i) => vrow(i === 0 ? <b>{g.name}</b> : '', r, `${g.name}|${r.role}`, false));
            (g.teams || []).forEach((t) => t.rows.forEach((r, i) => out.push(vrow(i === 0 ? <b>{g.name} · {t.name}</b> : '', r, `${g.name}|${t.name}|${r.role}`, true))));
            (g.teamless || []).forEach((x, i) => out.push(
              <tr key={`${g.name}|noteam|${x.role}`}>
                <td>{i === 0 ? <b>{g.name} · No team set</b> : ''}</td>
                <td>{x.role}</td>
                <td><span className="small-muted">—</span></td>
                <td>{x.people.length}<div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{nameList(x.people)} (set their team in Employee Management)</div></td>
                <td><span className="small-muted">—</span></td>
              </tr>,
            ));
            return out;
          })}</tbody>
        </table></div>
      )}
      {hasTeams && !edit ? <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>A department with teams shows its teams: its TL and Employee numbers are the teams added together.</div> : null}
    </Modal>
  );
}

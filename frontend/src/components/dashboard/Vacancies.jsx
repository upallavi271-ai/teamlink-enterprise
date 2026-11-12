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

// the small card (the Super Admin / Admin home); the HRMS dashboard shows the same number as a tile in its Attendance row
export default function Vacancies() {
  const [d, setD] = useVacancies();
  const [show, setShow] = useState(false);
  if (!d) return null;
  const t = d.totals;
  return (
    <>
      {/* founder 2026-11-02: "vacancies okka card evvu dani medha click chestey ahh table open avali" */}
      <button
        type="button" className="card" onClick={() => setShow(true)} aria-label={`Vacancies: ${t.vacant}. Open the table`}
        style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '14px 18px', margin: '16px 0', minWidth: 220, textAlign: 'left', cursor: 'pointer', border: '1px solid var(--line, #e5e7eb)' }}
      >
        <span className="small-muted" style={{ fontSize: 12 }}>Vacancies</span>
        <b style={{ fontSize: 28, lineHeight: 1.1, color: t.vacant ? red : green }}>{t.vacant}</b>
        <span className="small-muted" style={{ fontSize: 12 }}>Should have {t.planned} · Working {t.filled}</span>
        <span style={{ fontSize: 12, color: 'var(--primary, #1a56db)' }}>See by department →</span>
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
                  return <td key={role}>{row ? <input type="number" min={0} max={500} value={row.planned} onChange={(e) => setNum(gi, role, e.target.value)} style={{ width: 70 }} aria-label={`${g.name} ${role}`} /> : <span className="small-muted">—</span>}</td>;
                })}
              </tr>,
              ...(g.teams || []).map((t, ti) => (
                <tr key={`${g.name}|${t.name}`}>
                  <td style={{ paddingLeft: 22 }}><span className="small-muted">↳ {g.name} · </span>{t.name}</td>
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
          <tbody>{d.groups.flatMap((g) => [
            ...g.rows.map((r, i) => {
              const k = `${g.name}|${r.role}`;
              return (
                <tr key={k}>
                  <td>{i === 0 ? <b>{g.name}</b> : ''}</td>
                  <td>{r.role}</td>
                  <td>{r.planned}</td>
                  <td>
                    {r.filled ? <button type="button" className="link-btn" onClick={() => setOpen({ ...open, [k]: !open[k] })} style={{ background: 'none', border: 0, padding: 0, color: 'var(--primary, #1a56db)', cursor: 'pointer' }}>{r.filled}</button> : 0}
                    {r.leaving ? <span className="small-muted"> ({r.leaving} leaving)</span> : null}
                    {r.over ? <span className="small-muted"> (+{r.over} more than planned)</span> : null}
                    {open[k] ? <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{nameList(r.people)}</div> : null}
                  </td>
                  <td><b style={{ color: r.vacant ? red : green }}>{r.vacant}</b></td>
                </tr>
              );
            }),
            // the teams of the department (Education: Team A / Team B): a split of the rows above, with the names always shown
            ...(g.teams || []).flatMap((t) => t.rows.map((r, i) => (
              <tr key={`${g.name}|${t.name}|${r.role}`} style={{ background: 'var(--surface-2, #f8fafc)' }}>
                <td />
                <td style={{ paddingLeft: 22 }}>{i === 0 ? <><b>{t.name}</b><br /></> : null}<span className="small-muted">{r.role}</span></td>
                <td>{r.planned}</td>
                <td>
                  {r.filled}
                  {r.leaving ? <span className="small-muted"> ({r.leaving} leaving)</span> : null}
                  {r.over ? <span className="small-muted"> (+{r.over} more than planned)</span> : null}
                  {r.people.length ? <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>{nameList(r.people)}</div> : null}
                </td>
                <td><b style={{ color: r.vacant ? red : green }}>{r.vacant}</b></td>
              </tr>
            ))),
            ...(g.teamless || []).map((x) => (
              <tr key={`${g.name}|noteam|${x.role}`} style={{ background: 'var(--surface-2, #f8fafc)' }}>
                <td />
                <td style={{ paddingLeft: 22 }}><b>No team set</b><br /><span className="small-muted">{x.role}</span></td>
                <td><span className="small-muted">—</span></td>
                <td>{x.people.length}<div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>{nameList(x.people)} - set their team in Employee Management</div></td>
                <td><span className="small-muted">—</span></td>
              </tr>
            )),
          ])}</tbody>
        </table></div>
      )}
      {hasTeams && !edit ? <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>Team rows are part of the department rows above them, so they are not added to the totals again.</div> : null}
    </Modal>
  );
}

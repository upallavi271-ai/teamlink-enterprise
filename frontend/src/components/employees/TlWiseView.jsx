// Employee Management → TL-wise.
//
// The employees the list is showing (every filter except Status, because the
// status split IS the point of this view), grouped by their TL: team size,
// Active / Notice Period / Relieved / Other, the TL's department, and the
// members behind each count one click away. The grouping is done by the
// server (POST /employees/management/tl-wise, utils/employeeAdmin.js
// tlWiseGroups) inside the caller's own Employee Management scope, so the team
// sizes add up to exactly the number of employees counted.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ScrollTable from '../ScrollTable.jsx';
import './TlWiseView.css';

const fmtDoj = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—');
const STATUS_CLASS = { Active: 'active', 'Notice Period': 'pending', Exit: 'rejected' };

export default function TlWiseView({ ids, canExport, onNotice, onError }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  // One request per distinct set of ids, not per render.
  const idsKey = useMemo(() => [...ids].sort().join(','), [ids]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.post('/employees/management/tl-wise', { ids })
        .then((res) => { if (live) setData(res.data); })
        .catch((err) => { if (live) { setData(null); onError?.(err.response?.data?.error || 'Could not load the TL-wise view.'); } })
        .finally(() => { if (live) setLoading(false); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const groups = useMemo(() => {
    const all = data?.groups || [];
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter((g) => `${g.tl} ${g.tlEmployeeCode || ''} ${g.department || ''}`.toLowerCase().includes(s)
      || g.members.some((m) => `${m.name} ${m.employeeCode}`.toLowerCase().includes(s)));
  }, [data, q]);
  const shownTotals = useMemo(() => groups.reduce((t, g) => ({
    teamSize: t.teamSize + g.teamSize, active: t.active + g.active, notice: t.notice + g.notice,
    relieved: t.relieved + g.relieved, other: t.other + g.other,
  }), { teamSize: 0, active: 0, notice: 0, relieved: 0, other: 0 }), [groups]);

  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const allOpen = groups.length > 0 && groups.every((g) => open.has(g.key));

  async function exportXlsx() {
    setExporting(true);
    try {
      const res = await api.post('/employees/management/tl-wise.xlsx', { ids }, { responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || 'employees-tl-wise.xlsx';
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      onNotice?.(`Exported ${name} — TL-wise summary and member list, ${data?.totals?.teamSize ?? ids.length} employee(s).`);
    } catch {
      onError?.('Export is not included in your role’s permissions.');
    } finally { setExporting(false); }
  }

  const t = data?.totals;
  return (
    <div className="emp-tlwise">
      <div className="emp-tlwise-head">
        <div className="emp-tlwise-chips">
          <span className="emp-tlwise-chip"><b>{t ? t.teams : '…'}</b> TLs</span>
          <span className="emp-tlwise-chip"><b>{t ? t.teamSize : '…'}</b> employees</span>
          <span className="emp-tlwise-chip ok"><b>{t ? t.active : '…'}</b> Active</span>
          <span className="emp-tlwise-chip warn"><b>{t ? t.notice : '…'}</b> Notice Period</span>
          <span className="emp-tlwise-chip muted"><b>{t ? t.relieved : '…'}</b> Relieved</span>
          {t && t.other > 0 && <span className="emp-tlwise-chip muted"><b>{t.other}</b> Other</span>}
          {loading && <span className="small-muted">Updating…</span>}
        </div>
        <div className="emp-tlwise-actions">
          <input type="text" placeholder="Search TL, employee or ID…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))} disabled={!groups.length}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
          {canExport && (
            <button type="button" className="btn btn-sm" onClick={exportXlsx} disabled={exporting || !data}>
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          )}
        </div>
      </div>
      <div className="small-muted emp-tlwise-note">
        Grouped by each employee&apos;s TL (the reporting manager where no TL is set), counting everyone the
        filters above show across <b>all statuses</b>. Relieved = Relieved / Exited / Exit Process.
      </div>

      <ScrollTable maxHeight={null} bodyClassName="tbl-fit">
        <table className="emp-tlwise-table">
          <thead>
            <tr>
              <th style={{ width: 34 }} aria-label="Expand" />
              <th>TL</th>
              <th style={{ width: 110 }}>TL Emp ID</th>
              <th>Designation</th>
              <th>Department</th>
              <th className="num">Team size</th>
              <th className="num">Active</th>
              <th className="num">Notice</th>
              <th className="num">Relieved</th>
              <th className="num">Other</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = open.has(g.key);
              return (
                <Fragment key={g.key}>
                  <tr className={`emp-tlwise-row${isOpen ? ' open' : ''}`} onClick={() => toggle(g.key)}>
                    <td>
                      <button type="button" className="emp-tlwise-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} ${g.tl}'s team`}
                        onClick={(ev) => { ev.stopPropagation(); toggle(g.key); }}>
                        {isOpen ? '▾' : '▸'}
                      </button>
                    </td>
                    <td><b>{g.tl}</b></td>
                    <td className="cell-muted">{g.tlEmployeeCode || '—'}</td>
                    <td className="cell-muted">{g.tlDesignation || '—'}</td>
                    <td className="cell-muted">
                      {g.department || '—'}
                      {g.departments.length > 1 && <div className="small-muted" style={{ fontSize: 11 }}>team in {g.departments.join(', ')}</div>}
                    </td>
                    <td className="num"><b>{g.teamSize}</b></td>
                    <td className="num">{g.active}</td>
                    <td className="num">{g.notice}</td>
                    <td className="num">{g.relieved}</td>
                    <td className="num">{g.other}</td>
                  </tr>
                  {isOpen && (
                    <tr className="emp-tlwise-members">
                      <td />
                      <td colSpan={9}>
                        <table>
                          <thead>
                            <tr><th style={{ width: 100 }}>Employee ID</th><th>Name</th><th>Designation</th><th>Department</th><th style={{ width: 130 }}>Status</th><th style={{ width: 120 }}>Date of joining</th></tr>
                          </thead>
                          <tbody>
                            {g.members.map((m) => (
                              <tr key={m.id}>
                                <td><b>{m.employeeCode}</b></td>
                                <td className="row-link"><Link to={`/employees/${m.id}`}>{m.name}</Link></td>
                                <td className="cell-muted">{m.designation || '—'}</td>
                                <td className="cell-muted">{m.department || '—'}</td>
                                <td>
                                  <span className={`status ${STATUS_CLASS[m.hrStatus] || 'pending'}`} title={`HR status: ${m.hrStatus}`}>
                                    {m.employmentStatus}
                                  </span>
                                </td>
                                <td className="cell-muted">{fmtDoj(m.dateOfJoining)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {data && groups.length === 0 && (
              <tr><td colSpan={10} className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>
            )}
          </tbody>
          {data && groups.length > 0 && (
            <tfoot>
              <tr>
                <td />
                <td colSpan={4}>
                  Total — {q.trim() ? `${groups.length} of ${data.groups.length} group(s) matching “${q.trim()}”` : `${t.teams} TL(s)${data.groups.some((g) => g.key === '__none__') ? ' + no TL' : ''}`}
                </td>
                <td className="num">{shownTotals.teamSize}</td>
                <td className="num">{shownTotals.active}</td>
                <td className="num">{shownTotals.notice}</td>
                <td className="num">{shownTotals.relieved}</td>
                <td className="num">{shownTotals.other}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </ScrollTable>
    </div>
  );
}

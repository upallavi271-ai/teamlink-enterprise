import { useEffect, useState } from 'react';
import api from '../../api';
import { downloadFile } from './payrollUi';
import { monthHeading } from './payrollCycleUi.jsx';
import './payrollCycleCard.css';

// "Pending leaves that affect pay" + the days absent with no leave applied, for ONE payroll
// month, shown before the payroll is locked so HR / the TL can decide first (2026-10-12).
export default function PayrollPrecheck({ month }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setData(null); setErr('');
    api.get(`/payroll/cycle/precheck?month=${month}`).then((r) => setData(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load the check.'));
  }, [month]);

  const lop = () => downloadFile(`/payroll/cycle/lop-summary?month=${month}&format=xlsx`, `LOP-summary-${month}.xlsx`).catch(() => setErr('Could not download the LOP summary.'));
  if (err) return <div className="pc-pre"><div className="error-text">{err}</div></div>;
  if (!data) return null;
  const p = data.pendingLeaves;
  const a = data.absentNoLeave;
  return (
    <div className="pc-pre">
      <h4>Check before you lock · {monthHeading(month)}</h4>
      <div className="small-muted">{data.note}</div>
      <h4 style={{ marginTop: 10 }}>Pending leaves that affect pay ({p.length})</h4>
      {p.length === 0 ? <div className="small-muted">No leave is waiting for approval in this pay period.</div> : (
        <ul>
          {p.slice(0, 15).map((l) => (
            <li key={l.id}><b>{l.name}</b> · {l.type} · {l.from === l.to ? l.from : `${l.from} to ${l.to}`} ({l.daysInThisPayroll} day{l.daysInThisPayroll === 1 ? '' : 's'} in this pay period): unpaid until approved</li>
          ))}
          {p.length > 15 && <li>and {p.length - 15} more</li>}
        </ul>
      )}
      {data.absentRule.active && (
        <>
          <h4>Absent with no leave applied ({a.length} {a.length === 1 ? 'person' : 'people'})</h4>
          {a.length === 0 ? <div className="small-muted">Nobody.</div> : (
            <ul>
              {a.slice(0, 15).map((x) => (
                <li key={x.employeeId}><b>{x.name}</b>: {x.text} <span className="small-muted">({[...x.dates, ...x.halfDates].slice(0, 6).join(', ')}{x.dates.length + x.halfDates.length > 6 ? '…' : ''})</span></li>
              ))}
              {a.length > 15 && <li>and {a.length - 15} more</li>}
            </ul>
          )}
        </>
      )}
      <button type="button" className="btn btn-sm" onClick={lop}>Download LOP summary (Excel)</button>
    </div>
  );
}

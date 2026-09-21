import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { PanelPad, StatRow, AssignRow, EmptyMini, TwoCol, QaRow, NumHead } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';


export default function Resignation() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');

  function load() {
    api.get('/resignations').then((res) => setRecords(res.data));
    if (isHR) {
      api.get('/resignations/summary').then((res) => setSummary(res.data)).catch(() => setSummary(null));
      api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
    }
  }
  useEffect(load, [isHR]);

  async function record() {
    setError('');
    let employeeId;
    if (isHR) {
      const list = employees.map((e, i) => `${i + 1}. ${e.name}`).join('\n');
      const pick = prompt(`Employee resigning:\n${list}`, '1');
      if (pick === null) return;
      const emp = employees[(Number(pick) || 1) - 1];
      if (!emp) return;
      employeeId = emp.id;
    }
    const reason = prompt('Reason (optional):', '') ?? '';
    try {
      await api.post('/resignations', { employeeId, title: 'Resignation', detail: reason });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record the resignation');
    }
  }

  async function setStatus(r, status) {
    setError('');
    try {
      await api.patch(`/resignations/${r.id}/status`, { status });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update the resignation');
    }
  }

  const checklist = summary?.exitChecklist || [
    'Exit interview scheduled', 'Assets returned', 'Access revoked',
    'Full & final settlement processed', 'Experience letter issued',
  ];
  const serving = records.filter((r) => !['Relieved', 'Withdrawn'].includes(r.status)).length;
  const relieved = records.filter((r) => r.status === 'Relieved').length;

  return (
    <div>
      <QaRow style={{ marginBottom: 14 }}>
        <button className="btn btn-primary btn-sm" onClick={record}>+ Record Resignation</button>
      </QaRow>
      {error && <div className="error-text">{error}</div>}

      <StatRow cells={[
        { value: summary?.servingNotice ?? serving, label: 'Serving Notice' },
        { value: summary?.relieved ?? relieved, label: 'Relieved' },
        { value: summary?.noticePeriodDays ?? 45, label: 'Notice Period (days)' },
      ]} />

      <TwoCol style={{ alignItems: 'start', marginTop: 14 }}>
        <PanelPad>
          <NumHead n={1} title="Resignations" />
          <div className="cell-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
            Resigning never disables the login on its own — payslips and documents stay available until HR pauses the account.
          </div>
          {records.length === 0 ? <EmptyMini>No resignations on file.</EmptyMini> : records.map((r) => (
            <AssignRow key={r.id}>
              <span>
                <b>{r.employee?.name}</b> <span className="cell-muted">{r.employee?.department || ''}</span><br />
                <span className="cell-muted" style={{ fontSize: 11.5 }}>
                  Last working day {r.lastWorkingDate || '—'}
                  {r.daysLeft != null ? ` · ${r.daysLeft >= 0 ? `${r.daysLeft} day(s) left` : 'past'}` : ''}
                  {r.notes ? ` · ${r.notes}` : ''}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`status ${r.status === 'Relieved' ? 'active' : r.status === 'Withdrawn' ? 'rejected' : 'pending'}`}>{r.status}</span>
                {isHR && ['Notice Period', 'Submitted'].includes(r.status) && <button className="btn btn-sm btn-primary" onClick={() => setStatus(r, 'Accepted')}>Accept</button>}
                {isHR && !['Relieved', 'Withdrawn'].includes(r.status) && <button className="btn btn-sm" onClick={() => setStatus(r, 'Relieved')}>Relieve</button>}
              </span>
            </AssignRow>
          ))}
        </PanelPad>
        <PanelPad>
          <NumHead n={2} title="Exit Checklist" />
          {checklist.map((c) => (
            <AssignRow flush key={c}><span>{c}</span><span className="cell-muted" style={{ fontSize: 11.5 }}>per exit</span></AssignRow>
          ))}
          <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            The same checklist drives the offboarding tracker on each employee's record.
          </div>
        </PanelPad>
      </TwoCol>
    </div>
  );
}

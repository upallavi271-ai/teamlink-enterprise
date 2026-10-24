import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead } from '../../components/proto.jsx';

// ---------------------------------------------------------------------------
// Attendance -> alerts settings -> "Tasks for attendance problems" (HRMS item 2).
// Server: backend/src/utils/attendanceTasks.js (GET / PUT /attendance/issue-tasks).
// OFF until switched on here. When on, every unresolved late / missed check-in / missed check-out of the last
// working days gives the employee and the team lead a notice and the team lead ONE task (HR gets one too when the
// problem is more than N working days old). The task closes by itself when the day is fixed.
// ---------------------------------------------------------------------------
export default function IssueTasksCard() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  function load() { api.get('/attendance/issue-tasks').then((r) => { setData(r.data); setDraft(r.data.settings); }).catch(() => setData(null)); }
  useEffect(load, []);
  if (!data || !draft) return null;
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  async function save(patch) {
    setErr(''); setMsg('');
    try { const r = await api.put('/attendance/issue-tasks', { ...draft, ...patch }); setData((d) => ({ ...d, ...r.data })); setDraft(r.data.settings); setMsg('Saved.'); } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); }
  }
  const on = !!draft.enabled;
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Tasks for attendance problems">
        <button type="button" className={`btn btn-sm ${on ? '' : 'btn-primary'}`} onClick={() => save({ enabled: !on })}>{on ? 'Turn off' : 'Turn on'}</button>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <div className={`notice ${on ? 'green' : ''}`} style={{ marginBottom: 8 }}>
          {on ? <>It is <b>ON</b>{draft.goLiveDate ? ` since ${draft.goLiveDate}` : ''}. Problems from before that day are never raised.</> : <>It is <b>OFF</b>. Nothing is sent and no task is made until you turn it on.</>}
        </div>
        <div className="small-muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>
          For each late arrival (without a late-coming request), missed check-in or missed check-out on the last working days, the employee and the team lead
          are told once a day, and the team lead gets <b>one task</b> (&quot;Resolve: name missed check-out on date&quot;) due the next working day.
          HR gets a task too when the problem is more than {draft.hrAfterWorkingDays} working days old. The task closes by itself when the day is fixed
          (punch added, correction or late-coming approved, leave approved). Nothing on Sundays or holidays.
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
          {[['late', 'Late coming'], ['missingIn', 'Missed check-in'], ['missingOut', 'Missed check-out'], ['notifyEmployee', 'Tell the employee'], ['notifyTl', 'Tell the team lead']].map(([k, l]) => (
            <label key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 16, height: 16, minHeight: 0 }} checked={!!draft[k]} onChange={(e) => set(k, e.target.checked)} /> {l}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field"><label>Look back (working days)</label><input type="number" min="1" max="15" value={draft.lookbackWorkingDays} onChange={(e) => set('lookbackWorkingDays', Number(e.target.value))} style={{ maxWidth: 110 }} /></div>
          <div className="field"><label>HR task after (working days)</label><input type="number" min="0" max="10" value={draft.hrAfterWorkingDays} onChange={(e) => set('hrAfterWorkingDays', Number(e.target.value))} style={{ maxWidth: 110 }} /></div>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => save({})}>Save</button>
        </div>
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="notice red">{err}</div>}
        <div className="small-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          Open attendance tasks now: <b>{data.openTasks}</b>. If it were on today it would find <b>{data.preview?.issues ?? 0}</b> problem(s).
        </div>
      </div>
    </Panel>
  );
}

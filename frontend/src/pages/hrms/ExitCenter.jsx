import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Modal, EmptyMini, SectionLabel } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import { MarkLeftDialog } from '../../components/employees/MarkLeft.jsx';
import { fmtDateTime } from '../../components/ApprovalChain.jsx';
import './ExitCenter.css';

// ---------------------------------------------------------------------------
// EXIT CENTER (HRMS spec items 6 + 7) - backend/src/routes/exitCenter.js.
//
//   ExitApprovals     the "Exit approvals" tab inside Resignation: who is waiting, since when, filters with counts,
//                     per-row buttons, separate Excel / PDF buttons.
//   ExitRecordModal   ONE exit: the approval card (Approve / Reject / Send back = three separate buttons), the
//                     timeline (who / when / note), Edit exit date, Finish exit, "Where this date is used".
//   ExitChip          the small "Exit status" chip for a profile or the directory.
// Plain words only. The server decides who may do what (every button comes from `actions`).
// ---------------------------------------------------------------------------
const STATE_CLS = { done: 'exc-done', current: 'exc-now', todo: 'exc-todo', skipped: 'exc-skip', rejected: 'exc-bad' };
const STATE_MARK = { done: '✓', current: '●', todo: '○', skipped: '–', rejected: '✗' };
const STAGE_CLS = { waiting: 'pending', notice: 'applied', ready: 'pending', relieved: 'active', rejected: 'rejected', withdrawn: 'rejected' };
const REASONS = ['Handover finished early', 'Company asked for a different date', 'Employee asked for a different date', 'The date was entered wrongly'];
const dmy = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(iso || ''))) return iso || '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
};
const err = (e, fallback) => (e && e.response && e.response.data && e.response.data.error) || fallback;

async function download(path, params, filename) {
  const res = await api.get(path, { params, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function ExitChip({ stage, label, onClick }) {
  if (!label) return null;
  const cls = `status ${STAGE_CLS[stage] || 'applied'}`;
  return onClick
    ? <button type="button" className={`${cls} exc-chip-btn`} onClick={onClick} title="Open the exit record">Exit: {label}</button>
    : <span className={cls}>Exit: {label}</span>;
}

// ---- Edit exit date --------------------------------------------------------------------
// HR (Internal HR: Divya, Purna) and the Super Admin fix the resignation date, the notice period and the exit date here (founder 2026-10-24).
export function EditDateModal({ record, onClose, onSaved }) {
  const current = record.lastWorkingDate || '';
  const curRes = record.resignationDate || '';
  const curDays = record.noticeDays == null ? '' : String(record.noticeDays);
  const [date, setDate] = useState(current);
  const [resDate, setResDate] = useState(curRes);
  const [days, setDays] = useState(curDays);
  const [recalc, setRecalc] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState('');
  // A date before the joining day is almost always a slip of the year (founder 2026-10-30: 17-09-2025 for a person who joined
  // 09 Dec 2025 - meant 17-09-2026): said here at once, with the same day in the first year that fits, one click to use it.
  const joined = (record.employee && record.employee.dateOfJoining) || '';
  const beforeJoining = (d) => !!(joined && d && d < joined);
  const sameDayLater = (d) => {
    if (!beforeJoining(d)) return '';
    for (let y = Number(joined.slice(0, 4)); y <= Number(joined.slice(0, 4)) + 1; y += 1) {
      const c = `${y}${d.slice(4)}`;
      if (c >= joined && !Number.isNaN(new Date(`${c}T00:00:00Z`).getTime())) return c;
    }
    return '';
  };
  const noticeEndOf = (from, n) => { if (!from || n === '' || Number.isNaN(Number(n))) return ''; const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(n)); return d.toISOString().slice(0, 10); };
  const startOrDaysMoved = (resDate && resDate !== curRes) || (days !== '' && days !== curDays);
  const suggested = noticeEndOf(resDate, days);
  // Picking "move the last working day to resigned on + notice days" fills the date for them to see (they can still change it).
  useEffect(() => { if (recalc && suggested) setDate(suggested); }, [recalc, suggested]);
  // the resignation date (or notice days) moved: the last working day follows by default = resigned on + notice days (founder 2026-10-26)
  useEffect(() => { if (startOrDaysMoved) setRecalc(true); }, [resDate, days]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!date || date === current || date === checked) return undefined;
    if (beforeJoining(date)) { setWarnings([]); setError(''); return undefined; } // said under the date, with the fix
    const t = setTimeout(() => {
      api.post(`/resignations/exit/${record.id}/date/check`, { date, reason: reason || 'check' })
        .then((r) => { setWarnings(r.data.warnings || []); setError(''); setChecked(date); })
        .catch((e) => { setWarnings([]); setError(err(e, 'That date cannot be used')); setChecked(date); });
    }, 350);
    return () => clearTimeout(t);
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true); setError('');
    try {
      const body = { reason, note: note || undefined };
      if (resDate && resDate !== curRes) body.resignationDate = resDate;
      if (days !== '' && days !== curDays) body.noticeDays = Number(days);
      if (date && date !== current) body.lastWorkingDate = date;
      const r = await api.put(`/resignations/exit/${record.id}/dates`, body);
      onSaved(r.data);
    } catch (e) { setError(err(e, 'Could not save the dates')); } finally { setBusy(false); }
  }
  const changed = (date && date !== current) || (resDate && resDate !== curRes) || (days !== '' && days !== curDays);
  const can = changed && reason.trim().length >= 3 && !busy && !beforeJoining(date) && !beforeJoining(resDate);
  const yearSlip = (d, set, what) => beforeJoining(d) && (
    <div className="error-text" role="alert">
      The {what} cannot be before the joining date ({dmy(joined)}).
      {sameDayLater(d) && <>{' '}Did you mean <b>{dmy(sameDayLater(d))}</b>? <button type="button" className="btn btn-sm" onClick={() => set(sameDayLater(d))}>Use {dmy(sameDayLater(d))}</button></>}
    </div>
  );
  return (
    <Modal
      title="Edit resignation, notice and exit dates" onClose={onClose}
      footer={(<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!can} onClick={save}>{busy ? 'Saving…' : 'Save the dates'}</button></>)}
    >
      <div className="exc-form">
        <div className="exc-now-date">Now: {joined && <>joined on <b>{dmy(joined)}</b> · </>}resigned on <b>{curRes ? dmy(curRes) : 'not set'}</b> · notice <b>{curDays === '' ? 'not set' : `${curDays} days`}</b> · last working day <b>{current ? dmy(current) : 'not set'}</b></div>
        <label className="exc-label" htmlFor="exc-resdate">Resigned on</label>
        <input id="exc-resdate" type="date" min={joined || undefined} value={resDate} onChange={(e) => setResDate(e.target.value)} />
        {yearSlip(resDate, setResDate, 'resignation date')}
        <label className="exc-label" htmlFor="exc-days">Notice period (days)</label>
        <input id="exc-days" type="number" min="0" max="365" value={days} onChange={(e) => setDays(e.target.value)} />
        {startOrDaysMoved && suggested && (
          <label className="exc-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={recalc} onChange={(e) => setRecalc(e.target.checked)} />
            Also move the last working day to {dmy(suggested)} (resigned on + notice days)
          </label>
        )}
        <label className="exc-label" htmlFor="exc-date">Last working day (exit date)</label>
        <input id="exc-date" type="date" min={joined || undefined} value={date} onChange={(e) => { setRecalc(false); setDate(e.target.value); }} />
        {yearSlip(date, (d) => { setRecalc(false); setDate(d); }, 'last working day')}
        <label className="exc-label">Why are the dates changing? <span className="exc-req">(needed)</span></label>
        <div className="exc-quick">
          {REASONS.map((r) => <button type="button" key={r} className={`btn btn-sm${reason === r ? ' btn-primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
        </div>
        <textarea rows={2} placeholder="Or write the reason in your own words" value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="exc-label">Anything else to note? (optional)</label>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: agreed with the TL on Monday" />
        {warnings.map((w) => <div key={w} className="exc-warn" role="status">{w}</div>)}
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="exc-hint">Attendance, leave, payroll, the seat, reports and the employee record follow the new last working day straight away. Every change is written down with who made it and why.</div>
      </div>
    </Modal>
  );
}

// ---- Exit settings (Super Admin) ------------------------------------------------------------
function SettingsModal({ onClose }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    Promise.all([api.get('/resignations/exit/settings'), api.get('/resignations/exit/relieve-now/options')])
      .then(([a, b]) => setS({ ...a.data, direct: b.data.enabled, canSwitch: b.data.canChange }))
      .catch((e) => setError(err(e, 'Could not load')));
  }, []);
  async function save() {
    setError('');
    try { const r = await api.put('/resignations/exit/settings', { finalApprover: s.finalApprover, reminderHours: s.reminderHours }); setS(r.data); setSaved(true); } catch (e) { setError(err(e, 'Could not save')); }
  }
  return (
    <Modal title="Exit approval settings" onClose={onClose} footer={(<><button className="btn" onClick={onClose}>Close</button>{s && s.canEdit && <button className="btn btn-primary" onClick={save}>Save</button>}</>)}>
      {!s && !error && <EmptyMini>Loading…</EmptyMini>}
      {error && <div className="error-text">{error}</div>}
      {s && (
        <div className="exc-form">
          <label className="exc-label">Who finally approves an exit</label>
          <Combo value={s.finalApprover} disabled={!s.canEdit} onChange={(e) => { setSaved(false); setS({ ...s, finalApprover: e.target.value }); }}>
            {s.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </Combo>
          <div className="exc-hint">The steps before the final one (TL, HR and so on) still go first. Only the Super Admin can change this.</div>
          <label className="exc-label">Remind about a waiting approval after (hours)</label>
          <input type="number" min="1" max="720" value={s.reminderHours} disabled={!s.canEdit} onChange={(e) => { setSaved(false); setS({ ...s, reminderHours: e.target.value }); }} />
          <div className="exc-hint">The person whose turn it is and the Super Admin are reminded once a day on working days, until it is decided.</div>
          <label className="exc-label">Let HR mark an employee Exited or Relieved directly</label>
          <Combo value={s.direct ? 'on' : 'off'} disabled={!s.canSwitch} onChange={async (e) => { setSaved(false); try { const r = await api.put('/resignations/exit/relieve-now/setting', { enabled: e.target.value === 'on' }); setS({ ...s, direct: r.data.enabled }); setSaved(true); } catch (x) { setError(err(x, 'Could not save')); } }}>
            <option value="on">On (normal: no approval needed)</option>
            <option value="off">Off (emergency: use the approval steps again)</option>
          </Combo>
          <div className="exc-hint">Only an Admin or the Super Admin can change this. Leave it On.</div>
          {saved && <div className="exc-ok">Saved</div>}
        </div>
      )}
    </Modal>
  );
}

function DateChangesModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/resignations/exit/date-changes').then((r) => setRows(r.data.rows)).catch((e) => setError(err(e, 'Could not load'))); }, []);
  return (
    <Modal title="Exit date changes" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!rows && !error && <EmptyMini>Loading…</EmptyMini>}
      {rows && !rows.length && <EmptyMini>No last working day has been changed yet.</EmptyMini>}
      {rows && rows.length > 0 && (
        <div className="exc-scroll">
          <table className="exc-table">
            <thead><tr><th>Person</th><th>Was</th><th>Now</th><th>Reason</th><th>Changed by</th><th>When</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.employee ? r.employee.name : '—'}</td><td>{r.from ? dmy(r.from) : 'not set'}</td><td><b>{dmy(r.to)}</b></td>
                  <td>{r.reason}</td><td>{r.by}{r.role ? ` (${r.role})` : ''}</td><td>{fmtDateTime(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---- ONE EXIT --------------------------------------------------------------------------------
export function ExitRecordModal({ id, onClose, onChanged, autoEdit = false }) {
  const [v, setV] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [editDate, setEditDate] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [panel, setPanel] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('Relieved');

  function load() {
    setLoadError('');
    api.get(`/resignations/exit/${id}`).then((r) => setV(r.data)).catch((e) => setLoadError(err(e, 'Could not load this exit')));
  }
  useEffect(load, [id]);
  useEffect(() => { if (autoEdit && v && v.actions && v.actions.canEditDate) setEditDate(true); }, [autoEdit, v && v.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn, after) {
    setError(''); setBusy(true);
    try { const r = await fn(); if (r && r.data && r.data.timeline) setV(r.data); else load(); if (r && r.data && r.data.warnings) setWarnings(r.data.warnings); setNote(''); setText(''); setPanel(''); if (after) after(r); onChanged && onChanged(); } catch (e) { setError(err(e, 'That did not work')); } finally { setBusy(false); }
  }
  const a = v ? v.actions || {} : {};
  const base = `/resignations/exit/${id}`;
  return (
    <Modal title="Exit record" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loadError && <div className="error-text">{loadError}</div>}
      {!v && !loadError && <EmptyMini>Loading…</EmptyMini>}
      {v && (
        <div className="exc">
          <div className="exc-head">
            <div>
              <div className="exc-name">{v.employee.name} <span className="exc-sub">{[v.employee.employeeCode, v.employee.department, v.employee.designation].filter(Boolean).join(' · ')}</span></div>
              <div className="exc-sub">Reason: {v.reason || '—'}{v.initiatedBy ? ` · started by ${v.initiatedBy}` : ''}{v.initiatedAt ? ` · ${fmtDateTime(v.initiatedAt)}` : ''}</div>
            </div>
            <span className={`status ${STAGE_CLS[v.stage] || 'applied'}`}>{v.stageLabel}</span>
          </div>

          <div className="exc-dates">
            <div><span>Last working day</span><b>{v.lastWorkingDate ? dmy(v.lastWorkingDate) : 'Not set yet'}</b>{v.daysLeft != null && <em>{v.daysLeft >= 0 ? `${v.daysLeft} day(s) to go` : `${-v.daysLeft} day(s) ago`}</em>}</div>
            <div><span>Resigned on</span><b>{v.resignationDate ? dmy(v.resignationDate) : '—'}</b></div>
            <div><span>Notice period</span><b>{v.noticeDays != null ? `${v.noticeDays} days` : '—'}</b></div>
            {v.finalApprover && !v.simple && <div><span>Final approver</span><b>{v.finalApprover}</b></div>}
          </div>

          {/* THE APPROVAL CARD: three separate buttons for the person whose turn it is */}
          {(a.canApprove || a.canReject || a.canSendBack) && v.status === 'Pending Approval' && (
            <div className="exc-card" role="group" aria-label="Decide this exit">
              <div className="exc-card-title">{a.direct ? 'You can decide this directly (Super Admin)' : 'Your decision'}</div>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed for Reject and Send back)" />
              <div className="exc-three">
                <button className="btn btn-primary exc-approve" disabled={busy} onClick={() => run(() => api.post(`${base}/approve`, { note: note || undefined }))}>Approve</button>
                <button className="btn exc-reject" disabled={busy || note.trim().length < 3} title={note.trim().length < 3 ? 'Write a reason first' : ''} onClick={() => run(() => api.post(`${base}/reject`, { note }))}>Reject</button>
                <button className="btn exc-back" disabled={busy || note.trim().length < 3} title={note.trim().length < 3 ? 'Write what needs to change first' : ''} onClick={() => run(() => api.post(`${base}/send-back`, { note }))}>Send back</button>
              </div>
              <div className="exc-hint">Approve moves it on. Reject stops the exit and the person stays on as before. Send back returns it to the step before with your note.</div>
            </div>
          )}
          {error && <div className="error-text" role="alert">{error}</div>}
          {warnings.map((w) => <div key={w} className="exc-warn" role="status">{w}</div>)}

          <div className="exc-actions">
            {a.canEditDate && <button className="btn btn-sm" onClick={() => setEditDate(true)}>Edit dates</button>}
            {a.canFinalize && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => { if (window.confirm(`Finish ${v.employee.name}'s exit now? They become ${status}.`)) run(() => api.post(`${base}/finalize`, { status })); }}>Finish exit</button>}
            {a.canFinalize && (
              <Combo value={status} onChange={(e) => setStatus(e.target.value)} title="Final status"><option>Relieved</option><option>Exited</option></Combo>
            )}
            {a.canMark && <button className="btn btn-sm btn-primary" onClick={() => setPanel('mark')}>Mark as Exited / Relieved</button>}
            {a.canEarlyRelease && <button className="btn btn-sm" onClick={() => setPanel(panel === 'early' ? '' : 'early')}>Release early</button>}
            {a.canOverride && <button className="btn btn-sm exc-reject" onClick={() => setPanel(panel === 'override' ? '' : 'override')}>Finish without approval</button>}
            {a.canWithdraw && <button className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm('Withdraw your resignation?')) run(() => api.patch(`/resignations/${id}/withdraw`)); }}>Withdraw my resignation</button>}
            {a.canSettings && <span className="exc-grow" />}
          </div>
          {a.finalizeBlocked && <div className="exc-info">{a.finalizeBlocked}</div>}
          {panel === 'early' && (
            <div className="exc-card">
              <div className="exc-card-title">Release early</div>
              <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="The approver's note: who agreed to release them early, and why" />
              <div className="exc-three"><button className="btn btn-primary" disabled={busy || text.trim().length < 5} onClick={() => run(() => api.post(`${base}/early-release`, { note: text }))}>Release today</button><button className="btn" onClick={() => setPanel('')}>Cancel</button></div>
              <div className="exc-hint">Today becomes the last working day. Then you can finish the exit.</div>
            </div>
          )}
          {panel === 'override' && (
            <div className="exc-card exc-card-red">
              <div className="exc-card-title">Finish without approval (Super Admin only)</div>
              <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Why is this exit being finished without the normal approval? (written down for everyone to see)" />
              <div className="exc-three">
                <button className="btn exc-reject" disabled={busy || text.trim().length < 10} onClick={() => run(() => api.post(`/resignations/exit/employee/${v.employee.id}/finalize-override`, { reason: text, status }))}>Finish without approval</button>
                <button className="btn" onClick={() => setPanel('')}>Cancel</button>
              </div>
            </div>
          )}

          <SectionLabel style={{ marginTop: 16 }}>Exit status record</SectionLabel>
          <ol className="exc-timeline">
            {v.timeline.map((t) => (
              <li key={t.key} className={STATE_CLS[t.state] || 'exc-todo'}>
                <span className="exc-mark" aria-hidden="true">{STATE_MARK[t.state]}</span>
                <div>
                  <b>{t.label}</b>
                  <span className="exc-when">{t.at ? (t.dateOnly ? dmy(t.at) : fmtDateTime(t.at)) : ''}</span>
                  <div className="exc-who">{[t.who, t.note].filter(Boolean).join(' · ')}</div>
                </div>
              </li>
            ))}
          </ol>

          {v.dateChanges && v.dateChanges.length > 0 && (
            <>
              <SectionLabel style={{ marginTop: 14 }}>Last working day: changes</SectionLabel>
              <ul className="exc-list">
                {v.dateChanges.map((d, i) => (
                  <li key={d.id || i}><b>{d.from ? dmy(d.from) : 'not set'} → {dmy(d.to)}</b>{d.reason ? ` · ${d.reason}` : ''}<span className="exc-sub"> {d.by ? `· ${d.by}${d.role ? ` (${d.role})` : ''}` : ''} {d.at ? `· ${fmtDateTime(d.at)}` : ''}{d.source ? ` · ${d.source}` : ''}</span></li>
                ))}
              </ul>
            </>
          )}

          {v.usage && (
            <>
              <SectionLabel style={{ marginTop: 14 }}>Where this date is used</SectionLabel>
              <div className="exc-usage">
                {v.usage.rows.map((r) => (
                  <div key={r.key} className="exc-use">
                    <span className={`exc-state exc-state-${r.state}`}>{r.state === 'ok' ? 'OK' : r.state === 'mismatch' ? 'Mismatch' : 'Check'}</span>
                    <div><b>{r.label}</b><div className="exc-sub">{r.value}{r.note ? ` — ${r.note}` : ''}</div></div>
                  </div>
                ))}
              </div>
            </>
          )}
          {v.events && v.events.length > 0 && (
            <>
              <SectionLabel style={{ marginTop: 14 }}>History</SectionLabel>
              <ul className="exc-list">
                {v.events.slice(0, 20).map((e) => <li key={e.id}><b>{e.action}</b>{e.reason ? `: ${e.reason}` : ''}<span className="exc-sub"> · {e.by} · {fmtDateTime(e.at)}</span></li>)}
              </ul>
            </>
          )}
        </div>
      )}
      {panel === 'mark' && v && <MarkLeftDialog employee={{ id: v.employee.id, name: v.employee.name }} onClose={() => setPanel('')} onDone={() => { setPanel(''); load(); onChanged && onChanged(); }} />}
      {editDate && v && <EditDateModal record={v} onClose={() => setEditDate(false)} onSaved={(d) => { setEditDate(false); setV(d); setWarnings(d.warnings || []); onChanged && onChanged(); }} />}
    </Modal>
  );
}

// ---- THE TAB: Exit approvals ------------------------------------------------------------------
export default function ExitApprovals({ openId, onOpen, isDesk }) {
  const { user } = useAuth();
  const [q, setQ] = useState({ stage: '', department: '', wait: '', mine: '', include: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [settings, setSettings] = useState(false);
  const [changes, setChanges] = useState(false);

  function load() {
    const params = Object.fromEntries(Object.entries(q).filter(([, v]) => v));
    api.get('/resignations/exit/approvals', { params }).then((r) => { setData(r.data); setError(''); }).catch((e) => setError(err(e, 'Could not load the exit approvals')));
  }
  useEffect(load, [q.stage, q.department, q.wait, q.mine, q.include]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, val) => setQ((c) => ({ ...c, [k]: val }));

  async function quickApprove(r) {
    setBusy(r.id); setError('');
    try { await api.post(`/resignations/exit/${r.id}/approve`, {}); load(); } catch (e) { setError(err(e, 'Could not approve')); } finally { setBusy(''); }
  }
  const c = data ? data.counts : null;
  const rows = data ? data.rows : [];
  const exportParams = Object.fromEntries(Object.entries(q).filter(([, v]) => v));
  return (
    <div className="exc">
      <div className="exc-bar">
        <button className="btn btn-sm" onClick={() => download('/resignations/exit/records.xlsx', exportParams, 'exit-records.xlsx').catch((e) => setError(err(e, 'Export failed')))}>Download Excel</button>
        <button className="btn btn-sm" onClick={() => download('/resignations/exit/records.pdf', exportParams, 'exit-records.pdf').catch((e) => setError(err(e, 'Export failed')))}>Download PDF</button>
        {isDesk && <button className="btn btn-sm" onClick={() => setChanges(true)}>Last working day changes</button>}
        {isDesk && <button className="btn btn-sm" onClick={() => setSettings(true)}>Exit settings</button>}
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      {c && (
        <div className="exc-tiles">
          <div className={`exc-tile${c.waiting ? ' exc-tile-warn' : ''}`}>{c.waiting ? <><b>{c.waiting}</b><span>{c.waiting === 1 ? 'exit is waiting for approval' : 'exits are waiting for approval'}</span></> : <span>No exit is waiting for approval</span>}</div>
          <div className="exc-tile">{c.waitingOnMe ? <><b>{c.waitingOnMe}</b><span>{c.waitingOnMe === 1 ? 'is waiting for you' : 'are waiting for you'}</span></> : <span>Nothing is waiting for you</span>}</div>
          <div className="exc-tile">{c.total ? <><b>{c.total}</b><span>{q.include === 'all' ? 'exits in all (with finished ones)' : 'exits in progress'}</span></> : <span>No exit is in progress</span>}</div>
        </div>
      )}
      <div className="exc-filters">
        <Combo value={q.stage} title="Status" onChange={(e) => set('stage', e.target.value)}>
          <option value="">All statuses</option>
          {c && c.stageOrder.filter((s) => c.stage[s] || s === q.stage).map((s) => <option key={s} value={s}>{s} ({c.stage[s] || 0})</option>)}
        </Combo>
        <Combo value={q.department} title="Department" onChange={(e) => set('department', e.target.value)}>
          <option value="">All departments</option>
          {c && Object.keys(c.department).sort().map((d) => <option key={d} value={d}>{d} ({c.department[d]})</option>)}
        </Combo>
        <Combo value={q.wait} title="How long waiting" onChange={(e) => set('wait', e.target.value)}>
          <option value="">Any waiting time</option>
          {c && c.waitOrder.filter((w) => c.wait[w] || w === q.wait).map((w) => <option key={w} value={w}>{w} ({c.wait[w] || 0})</option>)}
        </Combo>
        <label className="exc-check"><input type="checkbox" checked={!!q.mine} onChange={(e) => set('mine', e.target.checked ? '1' : '')} /> Waiting on me{c ? ` (${c.mine})` : ''}</label>
        <label className="exc-check"><input type="checkbox" checked={q.include === 'all'} onChange={(e) => set('include', e.target.checked ? 'all' : '')} /> Include finished exits</label>
      </div>
      {!data && !error && <EmptyMini>Loading…</EmptyMini>}
      {data && !rows.length && <EmptyMini>{q.stage || q.department || q.wait || q.mine ? 'Nothing matches these filters.' : 'No exits are waiting. When someone resigns or HR starts an exit, it appears here.'}</EmptyMini>}
      {rows.map((r) => (
        <div key={r.id} className="exc-row">
          <div className="exc-row-main">
            <b>{r.employee ? r.employee.name : '—'}</b> <span className="exc-sub">{[r.department, r.employee && r.employee.designation].filter(Boolean).join(' · ')}</span>
            <div className="exc-sub">
              Last working day {r.lastWorkingDate ? dmy(r.lastWorkingDate) : 'not set'}{r.daysLeft != null ? ` (${r.daysLeft >= 0 ? `${r.daysLeft} day(s) to go` : 'passed'})` : ''} · {r.reason || 'no reason given'}
            </div>
            {r.waitingOn && <div className="exc-sub">With {r.waitingOn.level}: <b>{r.waitingOn.name || 'nobody named'}</b>{r.waitedHours != null ? ` · waiting ${r.waitedHours < 24 ? `${r.waitedHours} hour(s)` : `${Math.floor(r.waitedHours / 24)} day(s)`}` : ''}</div>}
          </div>
          <div className="exc-row-btns">
            <span className={`status ${STAGE_CLS[r.stage] || 'applied'}`}>{r.stageLabel}</span>
            <button className="btn btn-sm" onClick={() => onOpen(r.id)}>{r.canAct ? 'Review' : 'Open'}</button>
            {r.canAct && r.stage === 'waiting' && <button className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => quickApprove(r)}>Approve</button>}
          </div>
        </div>
      ))}
      {openId && <ExitRecordModal id={openId} onClose={() => onOpen(null)} onChanged={load} />}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {changes && <DateChangesModal onClose={() => setChanges(false)} />}
    </div>
  );
}

// ---- A person who is leaving by status alone (no exit record yet): set the last working day with a reason ------
function NoRecordDateModal({ employee, onClose, onSaved }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try { const r = await api.put(`/employees/management/${employee.id}/last-working-date`, { lastWorkingDate: date, reason }); onSaved(r.data); } catch (e) { setError(err(e, 'Could not save the date')); } finally { setBusy(false); }
  }
  return (
    <Modal title="Set last working day" onClose={onClose} footer={(<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!date || reason.trim().length < 3 || busy} onClick={save}>{busy ? 'Saving…' : 'Save date'}</button></>)}>
      <div className="exc-form">
        <div className="exc-hint">{employee.name} has no exit record yet. Saving makes one, so the date is kept in one place.</div>
        <label className="exc-label" htmlFor="exc-nr-date">Last working day</label>
        <input id="exc-nr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label className="exc-label">Why? <span className="exc-req">(needed)</span></label>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: resigned by e-mail on 5 Oct" />
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

// ---- The employee profile row: Exit status chip + the buttons ---------------------------------------------
export function ExitProfileRow({ employee, canEditDate, leaving, onChanged }) {
  const [info, setInfo] = useState(undefined);
  const [open, setOpen] = useState(null); // { edit }
  const [bare, setBare] = useState(false);
  function load() { api.get(`/resignations/exit/employee/${employee.id}`).then((r) => setInfo(r.data.exit)).catch(() => setInfo(null)); }
  useEffect(load, [employee.id]);
  if (info === undefined) return null;
  if (!info && !leaving) return null;
  return (
    <div className="kv">
      <span className="k">Exit status</span>
      <span>
        {info ? <ExitChip stage={info.stage} label={info.stageLabel} onClick={() => setOpen({ edit: false })} /> : <span className="small-muted">No exit on record</span>}
        <span className="exc-profile-btns">
          {info && <button type="button" className="btn btn-sm" onClick={() => setOpen({ edit: false })}>Open exit record</button>}
          {info && canEditDate && <button type="button" className="btn btn-sm" onClick={() => setOpen({ edit: true })}>Edit dates</button>}
          {!info && canEditDate && <button type="button" className="btn btn-sm btn-primary" onClick={() => setBare(true)}>Set last working day</button>}
        </span>
      </span>
      {open && info && <ExitRecordModal id={info.recordId} autoEdit={open.edit} onClose={() => { setOpen(null); load(); }} onChanged={() => { load(); onChanged && onChanged(); }} />}
      {bare && <NoRecordDateModal employee={employee} onClose={() => setBare(false)} onSaved={() => { setBare(false); load(); onChanged && onChanged(); }} />}
    </div>
  );
}

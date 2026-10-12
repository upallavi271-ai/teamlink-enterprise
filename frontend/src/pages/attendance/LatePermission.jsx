// ---------------------------------------------------------------------------
// LATE COMING - Attendance & Time -> "Late coming" tab (user, 2026-10-09 / 2026-10-10).
//   * EMPLOYEE: the days I came late and have not explained, each with ONE button "Tell why I was late" (a small popup:
//     the time I came is read from my check-in, I pick a reason, add a note or a picture, send). "I will be late" asks before a day.
//   * APPROVER (TL / STL / HR / Manager ... the same people who approve a leave): the requests waiting on me with Approve /
//     Reject and "Approve ticked"; filters Department / Person / Dates / Status all narrow each other, with counts.
//   * HR / Admin can add one for somebody (it says "asked by HR" and is audited).
// What approval does (said on the screen): the person stays Present, the day reads "Late (approved)" and is not counted as
// a late arrival in payroll. Waiting / rejected / not explained still count as late.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import Modal from '../../components/Modal.jsx';
import { Panel, PanelPad, PanelHead } from '../../components/proto.jsx';
import { ApprovalChainModal, ApprovalChainLine } from '../../components/ApprovalChain.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import { can } from '../../permissions';
import './late-permission.css';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const addDaysStr = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const t12 = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return '—'; const h = Number(m[1]); return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`; };
const dayName = (iso) => { const d = new Date(`${iso}T00:00:00`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }); };
const TONE = { Pending: 'orange', Approved: 'green', Rejected: 'red', Cancelled: 'grey' };
const SAY = { Pending: 'Waiting for approval', Approved: 'Approved', Rejected: 'Rejected', Cancelled: 'Cancelled' };

// ---------------------------------------------------------------------------
// The popup: "Tell why I was late" (kind Explain) or "I will be late" (kind Advance).
// ---------------------------------------------------------------------------
export function TellWhyDialog({ date: dateIn, kind = 'Explain', employeeId = '', employeeName = '', onClose, onDone }) {
  const [date, setDate] = useState(dateIn || todayStr());
  const [settings, setSettings] = useState({ pastDays: 7, reasons: [] });
  const [facts, setFacts] = useState(null);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [expectedTime, setExpectedTime] = useState('10:30');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const explain = kind === 'Explain';

  useEffect(() => { api.get('/late-permissions/settings').then((r) => setSettings(r.data)).catch(() => {}); }, []);
  useEffect(() => {
    setFacts(null);
    api.get('/late-permissions/eligible', { params: { date, kind, ...(employeeId ? { employeeId } : {}) } })
      .then((r) => setFacts(r.data)).catch((e) => setFacts({ canApply: false, why: e.response?.data?.error || 'Could not check that day.' }));
  }, [date, kind, employeeId]);

  async function send() {
    setError('');
    if (!reasonCode) { setError('Pick the reason first.'); return; }
    if (reasonCode === 'other' && note.trim().length < 3) { setError('Write a few words in the note.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('date', date); fd.append('kind', kind); fd.append('reasonCode', reasonCode);
      if (note.trim()) fd.append('note', note.trim());
      if (!explain) fd.append('expectedTime', expectedTime);
      if (employeeId) fd.append('employeeId', employeeId);
      if (file) fd.append('file', file);
      const r = await api.post('/late-permissions', fd);
      setSent(r.data);
      if (onDone) onDone(r.data);
    } catch (e) { setError(e.response?.data?.error || 'Could not send. Please try again.'); } finally { setBusy(false); }
  }

  const who = employeeName ? ` for ${employeeName}` : '';
  const title = explain ? `Tell why I was late${who}` : `I will be late${who}`;
  if (sent) {
    return (
      <Modal title={title} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="notice green">Sent. {sent.workflow?.currentOwnerName ? <><b>{sent.workflow.currentOwnerName}</b> ({sent.workflow.currentLabel}) has been asked to approve it. </> : 'Your approver has been asked. '}You will get a message when it is decided.</div>
        <p className="small-muted" style={{ marginTop: 10 }}>If it is approved you stay Present and this day is not counted as a late arrival. Until then it still counts as late.</p>
      </Modal>
    );
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={busy || !(facts && facts.canApply)} onClick={send}>{busy ? 'Sending…' : 'Send to my approver'}</button></>}
    >
      <div className="lp-dialog">
        <div className="field">
          <label>Day</label>
          <input type="date" value={date} max={explain ? todayStr() : undefined} min={explain ? addDaysStr(todayStr(), -settings.pastDays) : todayStr()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        {facts && facts.canApply && explain && (
          <div className="lp-came">You came at <b>{t12(facts.arrivedAt)}</b> that day (from your check-in). Late after the office start time.</div>
        )}
        {facts && !facts.canApply && <div className="notice amber">{facts.why}</div>}
        {!explain && (
          <div className="field"><label>I will arrive by</label><input type="time" value={expectedTime} onChange={(e) => setExpectedTime(e.target.value)} /></div>
        )}
        <div className="field">
          <label>Why?</label>
          <div className="lp-reasons" role="radiogroup" aria-label="Reason">
            {(settings.reasons || []).map((r) => (
              <button key={r.code} type="button" role="radio" aria-checked={reasonCode === r.code} className={`lp-reason${reasonCode === r.code ? ' on' : ''}`} onClick={() => setReasonCode(r.code)}>{r.label}</button>
            ))}
          </div>
        </div>
        <div className="field"><label>Note {reasonCode === 'other' ? '(needed)' : '(optional)'}</label><textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Anything your approver should know" /></div>
        <div className="field"><label>Picture or PDF (optional)</label><input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)} /></div>
        <div className="small-muted">Your approver is the same person who approves your leave. If they approve, this day is not counted as a late arrival.</div>
        {error && <div className="notice red" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    </Modal>
  );
}

// Each filter's options are counted over the rows that match ALL THE OTHER filters, and options with none are hidden.
function facetOptions(rows, filters, key, valueOf, labelOf) {
  const m = new Map();
  rows.filter((r) => Object.keys(filters).every((k) => k === key || !filters[k] || matchOne(r, k, filters[k]))).forEach((r) => {
    const v = valueOf(r); if (!v) return;
    const cur = m.get(v) || { value: v, label: labelOf ? labelOf(r) : v, count: 0 };
    cur.count += 1; m.set(v, cur);
  });
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function matchOne(r, k, v) {
  if (k === 'department') return (r.employee?.department || '') === v;
  if (k === 'employeeId') return r.employeeId === v;
  if (k === 'status') return r.status === v;
  if (k === 'from') return r.date >= v;
  if (k === 'to') return r.date <= v;
  return true;
}

export default function LateComing({ isHR = false, canDecide = false }) {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [settings, setSettings] = useState({ pastDays: 7, monthlyAllowance: 0, reasons: [] });
  const [myLate, setMyLate] = useState(null); // my late days that nobody has been told about
  const [dialog, setDialog] = useState(null); // { date, kind, employeeId, employeeName }
  const [people, setPeople] = useState([]);
  const [forPerson, setForPerson] = useState({ employeeId: '', date: todayStr() });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [chainFor, setChainFor] = useState(null);
  const [filters, setFilters] = useState({ department: '', employeeId: '', status: '', from: '', to: '' });
  const [ticked, setTicked] = useState([]);
  const [rejecting, setRejecting] = useState(null); // { ids }
  const [rejectReason, setRejectReason] = useState('');
  const [edit, setEdit] = useState(null);
  const canConfigure = can(user, 'hrms', 'hrms', 'Attendance & Time', 'configure');

  const load = () => api.get('/late-permissions').then((r) => setList(r.data)).catch(() => setList([]));
  const loadMine = (days) => {
    const from = addDaysStr(todayStr(), -(days ?? settings.pastDays));
    return api.get('/attendance/my-days', { params: { from, to: todayStr() } })
      .then((r) => setMyLate(r.data.hasEmployee === false ? null : (r.data.rows || []).filter((d) => (d.late || d.lateExcused) && d.lateState === 'none' && d.checkIn)))
      .catch(() => setMyLate(null));
  };
  useEffect(() => {
    load();
    api.get('/late-permissions/settings').then((r) => { setSettings(r.data); loadMine(r.data.pastDays); }).catch(() => loadMine(7));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (isHR && canDecide) api.get('/employees').then((r) => setPeople(r.data || [])).catch(() => setPeople([])); }, [isHR, canDecide]);

  const afterSend = () => { load(); loadMine(); };

  async function approve(ids) {
    setError(''); setInfo('');
    try {
      const r = await api.post('/late-permissions/bulk-decision', { ids, status: 'Approved' });
      const d = r.data;
      setInfo(`${d.done} approved${d.done && d.results.some((x) => x.moved) ? ' (some go on to the next approver)' : ''}${d.skipped ? `. ${d.skipped} could not be approved: ${[...new Set(d.skippedList.map((s) => s.error))].join('; ')}` : '.'}`);
      setTicked([]); load();
    } catch (e) { setError(e.response?.data?.error || 'Could not approve.'); }
  }
  async function reject() {
    setError(''); setInfo('');
    if (rejectReason.trim().length < 3) { setError('Write the reason for rejecting (a few words).'); return; }
    try {
      const r = await api.post('/late-permissions/bulk-decision', { ids: rejecting.ids, status: 'Rejected', reason: rejectReason.trim() });
      setInfo(`${r.data.done} rejected${r.data.skipped ? `. ${r.data.skipped} could not be rejected: ${[...new Set(r.data.skippedList.map((s) => s.error))].join('; ')}` : '.'}`);
      setRejecting(null); setRejectReason(''); setTicked([]); load();
    } catch (e) { setError(e.response?.data?.error || 'Could not reject.'); }
  }
  async function cancel(id) {
    setError(''); setInfo('');
    try { await api.patch(`/late-permissions/${id}/cancel`); setInfo('Cancelled.'); afterSend(); } catch (e) { setError(e.response?.data?.error || 'Could not cancel the request.'); }
  }
  async function saveSettings(e) {
    e.preventDefault(); setError(''); setInfo('');
    try {
      const r = await api.put('/late-permissions/settings', { pastDays: Number(edit.pastDays), monthlyAllowance: Number(edit.monthlyAllowance) });
      setSettings(r.data); setEdit(null); setInfo('Saved.'); loadMine(r.data.pastDays);
    } catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function openAttachment(id) {
    try {
      const r = await api.get(`/late-permissions/${id}/attachment`, { responseType: 'blob' });
      window.open(URL.createObjectURL(r.data), '_blank', 'noopener');
    } catch { setError('Could not open the attachment.'); }
  }

  const rows = list || [];
  const f = filters;
  const deptOpts = useMemo(() => facetOptions(rows, f, 'department', (r) => r.employee?.department || ''), [rows, f]);
  const empOpts = useMemo(() => facetOptions(rows, f, 'employeeId', (r) => r.employeeId, (r) => `${r.employee?.name || ''} (${r.employee?.employeeCode || ''})`), [rows, f]);
  const statusOpts = useMemo(() => facetOptions(rows, f, 'status', (r) => r.status), [rows, f]);
  const shown = rows.filter((r) => Object.keys(f).every((k) => !f[k] || matchOne(r, k, f[k])));
  const page = usePaged(shown, 25);
  const anyFilter = Object.values(f).some(Boolean);
  const seesOthers = rows.some((r) => r.employee?.userId !== user?.id);
  const myTurn = (r) => canDecide && r.status === 'Pending' && r.employee?.userId !== user?.id && r.workflow?.currentOwnerUserId === user?.id;
  const waitingOnMe = rows.filter(myTurn);
  const shownMine = shown.filter(myTurn);
  const setF = (k, v) => setFilters((x) => ({ ...x, [k]: v }));
  const allTicked = shownMine.length > 0 && shownMine.every((r) => ticked.includes(r.id));

  return (
    <div className="lp">
      {/* ---- the employee's own part: ONE clear button per late day ---- */}
      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 4 }}>My late days</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          Came after the office start time? Tell your approver why. If it is approved you stay Present and the day is not counted as a late arrival. You can do this for today and the last {settings.pastDays} days.
        </div>
        {myLate && myLate.length > 0 && (
          <div className="lp-mydays">
            {myLate.map((d) => (
              <div key={d.date} className="lp-myday">
                <div><b>{dayName(d.date)}</b><div className="small-muted">You came at {t12(d.checkIn)}</div></div>
                <button type="button" className="btn btn-primary" onClick={() => setDialog({ date: d.date, kind: 'Explain' })}>Tell why I was late</button>
              </div>
            ))}
          </div>
        )}
        {myLate && myLate.length === 0 && <div className="notice green">Nothing to explain. You have no unexplained late days in the last {settings.pastDays} days.</div>}
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={() => setDialog({ date: addDaysStr(todayStr(), 1), kind: 'Advance' })}>I will be late (tell in advance)</button>
        </div>
        {isHR && canDecide && (
          <div className="lp-onbehalf">
            <b>Add for somebody</b> <span className="small-muted">(HR, or a TL for their own team) — it says it was asked by you</span>
            <div className="lp-onbehalf-row">
              <select value={forPerson.employeeId} onChange={(e) => setForPerson({ ...forPerson, employeeId: e.target.value })} aria-label="Person">
                <option value="">Pick the person</option>
                {people.filter((p) => p.userId !== user?.id).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.employeeCode})</option>)}
              </select>
              <input type="date" value={forPerson.date} max={todayStr()} onChange={(e) => setForPerson({ ...forPerson, date: e.target.value })} aria-label="Day" />
              <button type="button" className="btn btn-sm" disabled={!forPerson.employeeId} onClick={() => setDialog({ date: forPerson.date, kind: 'Explain', employeeId: forPerson.employeeId, employeeName: (people.find((p) => p.id === forPerson.employeeId) || {}).name })}>Add</button>
            </div>
          </div>
        )}
      </PanelPad>

      {error && <div className="notice red" style={{ margin: '10px 0' }}>{error}</div>}
      {info && <div className="notice green" style={{ margin: '10px 0' }}>{info}</div>}

      {/* ---- requests: mine, or the ones waiting on me ---- */}
      <Panel>
        <PanelHead title={seesOthers ? 'Late coming requests' : 'My late coming requests'}>
          {canConfigure && !edit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ pastDays: settings.pastDays, monthlyAllowance: settings.monthlyAllowance })}>Rules</button>}
        </PanelHead>
        {edit && (
          <form className="lp-rules" onSubmit={saveSettings}>
            <label>Days back a person can tell why <input type="number" min="0" max="30" value={edit.pastDays} onChange={(e) => setEdit({ ...edit, pastDays: e.target.value })} /></label>
            <label>Requests per person per month <input type="number" min="0" max="31" value={edit.monthlyAllowance} onChange={(e) => setEdit({ ...edit, monthlyAllowance: e.target.value })} /> <span className="small-muted">(0 = no limit)</span></label>
            <button className="btn btn-sm btn-primary" type="submit">Save</button> <button className="btn btn-sm" type="button" onClick={() => setEdit(null)}>Close</button>
          </form>
        )}
        {waitingOnMe.length > 0 && (
          <div className="lp-waiting">
            <b>{waitingOnMe.length}</b> waiting for your decision.
            <button type="button" className="btn btn-sm" onClick={() => setF('status', 'Pending')}>Show them</button>
          </div>
        )}
        <div className="lp-filters">
          {seesOthers && (
            <>
              <select value={f.department} onChange={(e) => setF('department', e.target.value)} aria-label="Department">
                <option value="">All departments</option>
                {deptOpts.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
              </select>
              <select value={f.employeeId} onChange={(e) => setF('employeeId', e.target.value)} aria-label="Person">
                <option value="">All people</option>
                {empOpts.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
              </select>
            </>
          )}
          <select value={f.status} onChange={(e) => setF('status', e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            {statusOpts.map((o) => <option key={o.value} value={o.value}>{SAY[o.value] || o.value} ({o.count})</option>)}
          </select>
          <label className="small-muted">From <input type="date" value={f.from} onChange={(e) => setF('from', e.target.value)} /></label>
          <label className="small-muted">To <input type="date" value={f.to} onChange={(e) => setF('to', e.target.value)} /></label>
          {anyFilter && <button type="button" className="btn btn-sm" onClick={() => setFilters({ department: '', employeeId: '', status: '', from: '', to: '' })}>Clear</button>}
        </div>
        {shownMine.length > 0 && (
          <div className="lp-bulk">
            <label><input type="checkbox" checked={allTicked} onChange={(e) => setTicked(e.target.checked ? shownMine.map((r) => r.id) : [])} /> Tick all waiting on me ({shownMine.length})</label>
            <button type="button" className="btn btn-primary btn-sm" disabled={!ticked.length} onClick={() => approve(ticked)}>Approve ticked ({ticked.length})</button>
            <button type="button" className="btn btn-sm" disabled={!ticked.length} onClick={() => { setRejecting({ ids: ticked }); setRejectReason(''); }}>Reject ticked</button>
          </div>
        )}
        <div className="tbl-wrap">
          <table>
            <thead><tr>{shownMine.length > 0 && <th />}{seesOthers && <th>Person</th>}<th>Day</th><th>Came / will come</th><th>Why</th><th>Status</th><th /></tr></thead>
            <tbody>
              {page.slice.map((r) => {
                const mine = r.employee?.userId && r.employee.userId === user?.id;
                return (
                  <tr key={r.id}>
                    {shownMine.length > 0 && <td>{myTurn(r) && <input type="checkbox" aria-label="Tick" checked={ticked.includes(r.id)} onChange={(e) => setTicked((t) => (e.target.checked ? [...t, r.id] : t.filter((x) => x !== r.id)))} />}</td>}
                    {seesOthers && <td><b>{r.employee?.name}</b><div className="small-muted">{r.employee?.employeeCode}{r.employee?.department ? ` · ${r.employee.department}` : ''}</div></td>}
                    <td style={{ whiteSpace: 'nowrap' }}>{dayName(r.date)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.kind === 'Explain' ? 'Came ' : 'By '}{t12(r.expectedTime)}</td>
                    <td className="cell-muted">{r.reason}{r.note ? <div className="small-muted">{r.note}</div> : null}{r.hasAttachment ? <div><button type="button" className="lp-link" onClick={() => openAttachment(r.id)}>Open attachment</button></div> : null}{r.appliedBy && r.employee?.name && r.appliedBy !== r.employee.name ? <div className="small-muted">Asked by {r.appliedBy}</div> : null}</td>
                    <td>
                      <span className={`lp-chip tone-${TONE[r.status] || 'grey'}`}>{SAY[r.status] || r.status}</span>
                      {r.workflow && r.status === 'Pending' && <ApprovalChainLine workflow={r.workflow} compact />}
                      {r.status !== 'Pending' && r.decidedBy ? <div className="small-muted">{r.status === 'Cancelled' ? '' : `by ${r.decidedBy}`}{r.decisionNote ? ` — ${r.decisionNote}` : ''}</div> : null}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {myTurn(r) && <button type="button" className="btn btn-sm btn-primary" onClick={() => approve([r.id])}>Approve</button>}{' '}
                      {myTurn(r) && <button type="button" className="btn btn-sm" onClick={() => { setRejecting({ ids: [r.id] }); setRejectReason(''); }}>Reject</button>}{' '}
                      {r.workflow && <button type="button" className="btn btn-sm" onClick={() => setChainFor(r.id)}>Chain</button>}{' '}
                      {r.status === 'Pending' && (mine || (canDecide && isHR)) && <button type="button" className="btn btn-sm" onClick={() => cancel(r.id)}>Cancel request</button>}
                    </td>
                  </tr>
                );
              })}
              {list && shown.length === 0 && <tr><td colSpan={seesOthers ? 7 : 5}><ListEmpty lf={{ activeCount: anyFilter ? 1 : 0, clear: () => setFilters({ department: '', employeeId: '', status: '', from: '', to: '' }) }} noun="late coming requests" title="No late coming requests yet." /></td></tr>}
              {!list && <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
            </tbody>
          </table>
        </div>
        {page.total > 0 && <Pager page={page} noun="requests" />}
      </Panel>

      {rejecting && (
        <Modal title="Why are you rejecting?" onClose={() => setRejecting(null)} footer={<><button type="button" className="btn" onClick={() => setRejecting(null)}>Close</button><button type="button" className="btn btn-primary" onClick={reject}>Reject {rejecting.ids.length > 1 ? `${rejecting.ids.length} requests` : 'the request'}</button></>}>
          <div className="field"><label>Reason (the person will read this)</label><textarea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} maxLength={300} /></div>
          <div className="small-muted">A rejected request still counts the day as late.</div>
        </Modal>
      )}
      {dialog && <TellWhyDialog {...dialog} onClose={() => setDialog(null)} onDone={afterSend} />}
      {chainFor && <ApprovalChainModal type="latePermission" recordId={chainFor} onClose={() => setChainFor(null)} onChanged={load} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recruiter joinings — the pieces shared by the Super Admin popup on the HRMS
// dashboard and the "Recruiter joinings" tab of Performance & Development.
// The server decides who sees what (routes/recruiterJoinings.js); this file
// only draws what it is sent. Money is in the payload for Super Admin only.
// ---------------------------------------------------------------------------
import { Fragment, useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import './rj.css';
import './rj-carry.css';

export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(m) {
  if (!/^\d{4}-\d{2}$/.test(String(m || ''))) return m || '';
  const [y, mm] = m.split('-').map(Number);
  return `${MONTHS[mm - 1]} ${y}`;
}
export const nowMonth = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
export function addMonths(m, n) {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1 + n, 1)).toISOString().slice(0, 7);
}
const dayLabel = (d) => {
  if (!d) return '—';
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? d : `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)} ${dt.getUTCFullYear()}`;
};
export const errText = (e, fallback) => e?.response?.data?.error || e?.message || fallback;

export function Score({ row }) {
  return (
    <span title={row.targetSource}>
      <span className={`rj-score ${row.tone}`}>{row.joinings} / {row.target}</span>
      <span className="rj-word">{row.toneWord}</span>
      {row.carryNote && row.carried > 0 && <div className="rj-sub">{row.carryNote}</div>}
    </span>
  );
}

// The incentive of a month under the department rule, in words.
function IncentiveCell({ row, mayDecide }) {
  const i = row.incentive;
  if (!i) return <span className="rj-sub">—</span>;
  const word = i.status === 'Waiting for amount' ? 'Target completed - waiting for the amount'
    : i.status === 'Pending' ? 'Waiting for approval' : i.status === 'Approved' ? 'Approved' : i.status === 'Paid' ? 'Paid' : i.status === 'Rejected' ? 'Rejected' : i.status;
  const tone = i.status === 'Target not completed' ? 'grey' : i.status === 'Not worked out yet' ? 'blue' : (i.status === 'Approved' || i.status === 'Paid') ? 'green' : i.status === 'Rejected' ? 'red' : 'orange';
  return (
    <span>
      <span className={`rj-tag ${tone}`}>{word}</span>
      {i.amount ? <div className="rj-sub">{inr(i.amount)}</div> : null}
      {mayDecide && i.status === 'Not worked out yet' ? <div className="rj-sub">Payroll → Incentives → Work out the month</div> : null}
    </span>
  );
}

// What was decided, in one line.
export function DecisionLine({ d }) {
  if (!d) return null;
  if (d.decision === 'INCENTIVE') {
    return <div className="rj-done green">Incentive{d.amount != null ? ` ${inr(d.amount)}` : ''}{d.payLabel ? ` · paid with ${d.payLabel} salary` : ''}</div>;
  }
  if (d.decision === 'RAISE') return <div className="rj-done blue">Salary raised{d.raiseFrom ? ` from ${monthLabel(d.raiseFrom)}` : ''}</div>;
  return <div className="rj-done grey">No action{d.note ? ` — ${d.note}` : ''}</div>;
}

// ---- The three decision dialogs (Super Admin) ---------------------------------------
function DialogShell({ title, onClose, onSave, busy, error, saveLabel, children }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={onSave} disabled={busy}>{busy ? 'Saving…' : saveLabel}</button>
        </>
      )}
    >
      <div className="rj rj-form">
        {error && <div className="rj-error">{error}</div>}
        {children}
      </div>
    </Modal>
  );
}
const who = (row, label) => `${row.name}${row.seat ? ` · ${row.seat}` : ''} · ${label}: ${row.joinings} / ${row.target} joinings`;

// suggested / suggestedNote: the amount worked out from the category targets (Medical), put in for Super Admin to confirm or change.
export function IncentiveDialog({
  row, month, onClose, onSaved, suggested = null, suggestedNote = '',
}) {
  const [amount, setAmount] = useState(row.decision?.decision === 'INCENTIVE' && row.decision.amount ? String(row.decision.amount) : (suggested > 0 ? String(suggested) : ''));
  const [note, setNote] = useState(row.decision?.decision === 'INCENTIVE' ? row.decision.note || '' : suggestedNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setError('');
    if (!(Number(amount) > 0)) { setError('Enter the incentive amount in rupees.'); return; }
    setBusy(true);
    try {
      const res = await api.post('/recruiter-joinings/decisions', { employeeId: row.employeeId, month, decision: 'INCENTIVE', amount: Number(amount), note });
      onSaved(res.data);
    } catch (e) { setError(errText(e, 'Could not save the incentive.')); } finally { setBusy(false); }
  }
  return (
    <DialogShell title="Give incentive" onClose={onClose} onSave={save} busy={busy} error={error} saveLabel="Give incentive">
      <p className="rj-hint">{who(row, monthLabel(month))}</p>
      {suggested > 0 && <p className="rj-hint">Worked out from the category amounts: <b>{inr(suggested)}</b>{suggestedNote ? ` (${suggestedNote})` : ''}. You can change it.</p>}
      <div className="field"><label>Amount (₹)</label><input type="number" min="1" step="100" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 2000" /></div>
      <div className="field"><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why — e.g. 3 joinings in September" /></div>
      <p className="rj-hint">It is paid with the next salary as a separate <b>Incentive</b> line on the payslip (counted in gross pay and tax like any other earning). Only Super Admin and the employee (on their payslip) see the amount.</p>
    </DialogShell>
  );
}

export function NoActionDialog({ row, month, onClose, onSaved }) {
  const [note, setNote] = useState(row.decision?.decision === 'NONE' ? row.decision.note || '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      const res = await api.post('/recruiter-joinings/decisions', { employeeId: row.employeeId, month, decision: 'NONE', note });
      onSaved(res.data);
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <DialogShell title="No action" onClose={onClose} onSave={save} busy={busy} error={error} saveLabel="Save — no action">
      <p className="rj-hint">{who(row, monthLabel(month))}</p>
      <div className="field"><label>Note (optional)</label><input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Target not reached" /></div>
    </DialogShell>
  );
}

// Raise salary = the existing salary revision (PUT /payroll/structure/:id →
// a new SalaryStructureVersion from the chosen month), then the decision.
export function RaiseDialog({ row, month, onClose, onSaved }) {
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState('pct');
  const [pct, setPct] = useState('10');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/payroll/structure/${row.employeeId}`).then((res) => {
      const d = res.data;
      const st = d.structure;
      const stipend = st?.payMode === 'Stipend';
      const current = st ? (stipend ? Math.round(Number(st.stipend) || 0) : Math.round((Number(st.ctc) || 0) / 12)) : 0;
      // Default: from next month, after anything already approved.
      let m = addMonths(nowMonth(), 1);
      if (d.lockedThrough && d.lockedThrough >= m) m = addMonths(d.lockedThrough, 1);
      setFrom(m);
      setInfo({ current, stipend, bonus: st?.bonus, lockedThrough: d.lockedThrough, has: !!st && current > 0 });
    }).catch((e) => setError(errText(e, 'Could not load the current salary.')));
  }, [row.employeeId]);
  const newAmount = info ? (mode === 'pct' ? Math.round(info.current * (1 + (Number(pct) || 0) / 100)) : Math.round(Number(amount) || 0)) : 0;
  async function save() {
    setError('');
    if (!info?.has) { setError('This person has no salary set yet. Set it first in Payroll → Salary Structure.'); return; }
    if (!(newAmount > info.current)) { setError('The new salary must be more than the current one.'); return; }
    if (!/^\d{4}-\d{2}$/.test(from) || from <= month) { setError(`Pick a month after ${monthLabel(month)}.`); return; }
    setBusy(true);
    try {
      const body = info.stipend
        ? { payMode: 'Stipend', stipend: newAmount, effectiveFrom: from, note: note || `Raise after ${monthLabel(month)} joinings` }
        : { payMode: 'Package', monthlyCtc: newAmount, bonus: info.bonus, effectiveFrom: from, note: note || `Raise after ${monthLabel(month)} joinings` };
      const sv = await api.put(`/payroll/structure/${row.employeeId}`, body);
      const res = await api.post('/recruiter-joinings/decisions', {
        employeeId: row.employeeId, month, decision: 'RAISE', salaryVersionId: sv.data.version?.id, note,
      });
      onSaved({ ...res.data, recalculate: [...new Set([...(res.data.recalculate || []), ...(sv.data.staleDrafts || [])])] });
    } catch (e) { setError(errText(e, 'Could not raise the salary.')); } finally { setBusy(false); }
  }
  return (
    <DialogShell title="Raise salary" onClose={onClose} onSave={save} busy={busy} error={error} saveLabel="Raise salary">
      <p className="rj-hint">{who(row, monthLabel(month))}</p>
      {!info ? <div className="rj-empty">Loading the current salary…</div> : !info.has ? (
        <div className="rj-error">{row.name} has no salary set yet, so it cannot be raised here. Set it first in Payroll → Salary Structure, then come back.</div>
      ) : (
        <>
          <p className="rj-hint">Current {info.stipend ? 'stipend' : 'monthly CTC'}: <b>{info.has ? inr(info.current) : 'not set'}</b></p>
          <div className="rj-tabs">
            <button type="button" className={mode === 'pct' ? 'on' : ''} onClick={() => setMode('pct')}>Raise by %</button>
            <button type="button" className={mode === 'amount' ? 'on' : ''} onClick={() => setMode('amount')}>New amount</button>
          </div>
          <div className="rj-row2">
            {mode === 'pct'
              ? <div className="field"><label>Raise (%)</label><input type="number" min="1" step="1" value={pct} onChange={(e) => setPct(e.target.value)} /></div>
              : <div className="field"><label>New {info.stipend ? 'stipend' : 'monthly CTC'} (₹)</label><input type="number" min="0" step="500" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}
            <div className="field"><label>From month</label><input type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          </div>
          <p className="rj-hint">New {info.stipend ? 'stipend' : 'monthly CTC'}: <b>{inr(newAmount)}</b> from {monthLabel(from)}. Basic, HRA, PF and the rest are worked out by the usual salary rules (Payroll → Salary Structure keeps the history).</p>
          <div className="field"><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </>
      )}
    </DialogShell>
  );
}

// ---- WHO JOINED, WHO DROPPED AND WHY (founder 2026-11-11) ----------------------------
// The people behind a recruiter's month, straight from ATS: the joinings, the drop-outs with the reason, and the ones still to join.
// Names, clients and jobs are ATS data: the server answers only a login that holds the ATS (and only for recruiters it may see);
// `allowed` is that answer in advance (board.viewer.details), so a login without the ATS sees the counts and this note.
const dropWhen = (x) => (x.droppedOn ? dayLabel(x.droppedOn) : (x.lastWorkingDay ? `last day ${dayLabel(x.lastWorkingDay)}` : '—'));

export function JoiningPeople({ month, rowKey, allowed = true }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!allowed || !rowKey) return undefined;
    let alive = true;
    setD(null); setError('');
    api.get('/recruiter-joinings/details', { params: { month, key: rowKey } })
      .then((r) => { if (alive) setD(r.data); })
      .catch((e) => { if (alive) setError(errText(e, 'Could not load who joined.')); });
    return () => { alive = false; };
  }, [month, rowKey, allowed]);
  if (!allowed) return <p className="rj-hint">Candidate names and details are in ATS. Your login shows the counts only.</p>;
  if (error) return <div className="rj-error">{error}</div>;
  if (!d) return <div className="rj-empty">Loading who joined…</div>;
  // A BDE's month: the new clients whose agreement was signed (each one is that BDE's joining).
  if (d.kind === 'agreements') {
    return (
      <div className="rj-people">
        {!d.joined.length ? <p className="rj-hint">No client agreement was signed in {d.label}.</p> : (
          <>
            <h4>Agreements signed in {d.label} ({d.joined.length})</h4>
            <div className="tbl-wrap">
              <table className="rj-mini">
                <thead><tr><th>Client</th><th>Client code</th><th>Signed on</th><th>Status</th></tr></thead>
                <tbody>
                  {d.joined.map((x) => (
                    <tr key={x.id}>
                      <td><b>{x.client}</b></td>
                      <td>{x.jobCode || '—'}</td>
                      <td>{dayLabel(x.joiningDate)}</td>
                      <td><span className="rj-tag green">{x.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rj-hint">A new client whose agreement is signed is one joining for the BDE who owns the client. A later cancel or expiry does not change a past month.</p>
          </>
        )}
      </div>
    );
  }
  const none = !d.joined.length && !d.dropouts.length && !d.waiting.length;
  const unrecorded = d.dropouts.filter((x) => !x.reasonRecorded).length;
  return (
    <div className="rj-people">
      {none && <p className="rj-hint">No joinings or drop-outs with a joining date in {d.label}.</p>}
      {d.joined.length > 0 && (
        <>
          <h4>Joined in {d.label} ({d.joined.length})</h4>
          <div className="tbl-wrap">
            <table className="rj-mini">
              <thead><tr><th>Candidate</th><th>Client</th><th>Job</th>{d.joined.some((x) => x.category) && <th>Target category</th>}<th>Joining date</th><th>Status</th></tr></thead>
              <tbody>
                {d.joined.map((x) => (
                  <tr key={x.id}>
                    <td><b>{x.candidate}</b></td>
                    <td>{x.client}</td>
                    <td>{x.job}{x.jobCode ? <span className="rj-sub"> · {x.jobCode}</span> : null}</td>
                    {d.joined.some((y) => y.category) && (
                      <td>
                        {x.category ? <span className={`rj-tag ${x.category.bucket === 'six' ? 'green' : x.category.bucket === 'check' ? 'red' : 'orange'}`} title={x.category.reason}>{x.category.label}</span> : <span className="rj-sub">—</span>}
                        {x.category && x.category.bucket !== 'six' ? <div className="rj-sub">{x.category.reason}</div> : null}
                      </td>
                    )}
                    <td>{dayLabel(x.joiningDate)}</td>
                    <td>
                      <span className={`rj-tag ${x.kind === 'left' ? 'red' : x.tone === 'orange' ? 'orange' : 'green'}`}>{x.kind === 'left' ? 'Dropped after joining' : x.status}</span>
                      {x.kind === 'left' && <div className="rj-sub">Still counted in the joinings above</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {d.dropouts.length > 0 && (
        <>
          <h4>Drop-outs ({d.dropouts.length})</h4>
          <div className="tbl-wrap">
            <table className="rj-mini">
              <thead><tr><th>Candidate</th><th>Client</th><th>Job</th><th>What happened</th><th>Joining date</th><th>Dropped on</th><th>Reason</th></tr></thead>
              <tbody>
                {d.dropouts.map((x) => (
                  <tr key={x.id}>
                    <td><b>{x.candidate}</b></td>
                    <td>{x.client}</td>
                    <td>{x.job}{x.jobCode ? <span className="rj-sub"> · {x.jobCode}</span> : null}</td>
                    <td>
                      <span className="rj-tag red">{x.kind === 'left' ? 'Left after joining' : (/declined/i.test(x.status) ? 'Offer declined' : 'Did not join')}</span>
                      {x.withinGuarantee === true && <div className="rj-sub">Inside the guarantee</div>}
                      {x.afterIncentive && <div className="rj-sub">After the incentive was decided: HR to review</div>}
                    </td>
                    <td>{dayLabel(x.joiningDate)}</td>
                    <td>{x.kind === 'left' || x.droppedOn ? dropWhen(x) : '—'}</td>
                    <td>{x.reasonRecorded ? x.reason : <span className="rj-sub">Reason not recorded</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unrecorded > 0 && <p className="rj-hint">{unrecorded} of {d.dropouts.length} have no reason on record. The reason is added in ATS, on the candidate&rsquo;s Joining &amp; Drop record, and shows here after that.</p>}
        </>
      )}
      {d.waiting.length > 0 && (
        <>
          <h4>Not joined yet ({d.waiting.length})</h4>
          <div className="tbl-wrap">
            <table className="rj-mini">
              <thead><tr><th>Candidate</th><th>Client</th><th>Job</th><th>Joining date</th><th>Status</th></tr></thead>
              <tbody>
                {d.waiting.map((x) => (
                  <tr key={x.id}>
                    <td><b>{x.candidate}</b></td><td>{x.client}</td>
                    <td>{x.job}{x.jobCode ? <span className="rj-sub"> · {x.jobCode}</span> : null}</td>
                    <td>{dayLabel(x.joiningDate)}</td><td><span className="rj-tag orange">{x.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// The same panel in a window: opened from a row of the Monthly Targets table.
export function JoiningDetailModal({ month, rowKey, name, allowed, onClose }) {
  return (
    <Modal title={`Joinings and drop-outs · ${name} · ${monthLabel(month)}`} onClose={onClose} wide footer={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
      <div className="rj"><JoiningPeople month={month} rowKey={rowKey} allowed={allowed} /></div>
    </Modal>
  );
}

// ---- One person's joinings + month-by-month history ---------------------------------
// The counts (required, achieved, completion %, drop-outs) come with the board; the people behind them
// (who joined, who dropped and why) are JoiningPeople above, for a login that holds the ATS.
const pct = (a, t) => (t > 0 ? `${Math.round((a * 100) / t)}%` : '—');

export function PersonDetail({ row, month, details = false }) {
  const [hist, setHist] = useState(null);
  const [carry, setCarry] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!row.employeeId) return;
    api.get(`/recruiter-joinings/history/${row.employeeId}`, { params: { months: 12 } }).then((r) => { setHist(r.data.months); setCarry(r.data.carry || []); }).catch((e) => setError(errText(e, 'Could not load the history.')));
  }, [row.employeeId]);
  return (
    <div>
      <h4>{monthLabel(month)}</h4>
      <p className="rj-hint">
        {row.generated != null ? <>Generated <b>{row.generated}</b> candidates · </> : null}Required <b>{row.required ?? row.target}</b> · Achieved <b>{row.achieved ?? row.joinings}</b> · Completion <b>{pct(row.joinings, row.target)}</b>
        {row.droppedCount ? <> · <b>{row.droppedCount}</b> left after joining</> : null}
        {row.didNotJoinCount ? <> · <b>{row.didNotJoinCount}</b> did not join</> : null}
        {row.notCountedCount ? <> · {row.notCountedCount} not counted (did not join, left, or still waiting)</> : null}.
        {row.droppedCount ? ' A person who left after joining stays in the count: a drop does not change a past count or incentive.' : ''}
      </p>
      <JoiningPeople month={month} rowKey={row.key} allowed={details} />
      {carry.length > 0 && (
        <>
          <h4>Target month by month (the missing joinings are carried forward)</h4>
          <div className="tbl-wrap">
            <table className="rj-mini">
              <thead><tr><th>Month</th><th>Base target</th><th>Carried in</th><th>Target</th><th>Joined</th><th>Completed</th><th>Carried to next month</th></tr></thead>
              <tbody>
                {carry.map((c) => (
                  <tr key={c.month}>
                    <td>{c.label}</td><td>{c.base}</td><td>{c.carried}</td><td><b>{c.target}</b></td><td>{c.achieved}</td>
                    <td><span className={`rj-tag ${c.completed ? 'green' : 'orange'}`}>{c.completed ? 'Yes - incentive earned' : 'No'}</span></td><td>{c.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {row.employeeId && (hist ? (
        <>
          <h4>Completion history (last 12 months)</h4>
          <div className="tbl-wrap">
            <table className="rj-mini">
              <thead><tr><th>Month</th><th>Candidates generated</th><th>Required</th><th>Achieved</th><th>Completion</th><th>Drop-outs</th><th>Result</th></tr></thead>
              <tbody>
                {hist.filter((h) => h.listed).map((h) => (
                  <tr key={h.month}>
                    <td>{h.label}</td><td>{h.generated == null ? '—' : h.generated}</td><td>{h.target}</td><td>{h.joinings}</td><td>{pct(h.joinings, h.target)}</td>
                    <td>{(h.dropped || 0) + (h.didNotJoin || 0) ? <span className="rj-tag red" title={`${h.dropped || 0} left after joining, ${h.didNotJoin || 0} did not join`}>{(h.dropped || 0) + (h.didNotJoin || 0)}</span> : <span className="rj-sub">None</span>}</td>
                    <td><span className={`rj-score ${h.tone}`}>{h.toneWord}</span>{h.decision ? <span className="rj-sub"> · {h.decision.decision === 'INCENTIVE' ? `Incentive${h.decision.amount != null ? ` ${inr(h.decision.amount)}` : ''}` : h.decision.word}</span> : null}</td>
                  </tr>
                ))}
                {!hist.some((h) => h.listed) && <tr><td colSpan="7" className="rj-sub">No months on the recruiter list yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : !error && <div className="rj-empty">Loading the history…</div>)}
      {error && <div className="rj-error">{error}</div>}
    </div>
  );
}

// ---- The table (popup + tab) -----------------------------------------------------------
// board: GET /recruiter-joinings/board payload. onChanged(message) reloads.
export function JoiningsTable({ board, rows, onChanged, showDecision = true }) {
  const [open, setOpen] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind, row }
  const [msg, setMsg] = useState('');
  const v = board.viewer || {};
  const canDecide = !!v.decide;
  const hasCarry = rows.some((r) => r.completed !== undefined);
  // A table of BDEs counts signed client agreements, not candidates: no "generated" / "not counted" / drop-out columns (founder 2026-11-14).
  const bde = rows.length > 0 && rows.every((r) => r.kind === 'BDE');
  const cols = (bde ? 5 : 8) + (hasCarry ? 1 : 0) + (showDecision && v.decisions ? 1 : 0);

  async function undo(row) {
    if (!window.confirm(`Undo the decision for ${row.name}?`)) return;
    try {
      const r = await api.delete(`/recruiter-joinings/decisions/${row.decision.id}`);
      setMsg(r.data.message || 'Undone.');
      onChanged && onChanged();
    } catch (e) { setMsg(errText(e, 'Could not undo.')); }
  }
  function saved(data) {
    setDialog(null);
    const re = data.recalculate && data.recalculate.length ? ` Recalculate the ${data.recalculate.map(monthLabel).join(', ')} payroll before submitting it.` : '';
    setMsg(`${data.message || 'Saved.'}${re}`);
    onChanged && onChanged();
  }

  if (!rows.length) return <div className="rj-empty">No recruiters to show for {board.label} with these filters.</div>;
  return (
    <div className="rj">
      {msg && <div className="rj-saved">{msg}</div>}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>{bde ? 'BDE' : 'Recruiter'}</th><th>Seat</th>{!bde && <th>Team lead</th>}{!bde && <th title="Candidates this recruiter generated (sourced / added) in the month">Candidates generated</th>}<th title={bde ? 'New clients whose agreement was signed this month, out of the target' : undefined}>{bde ? 'Agreements signed / required' : 'Joinings / required'}</th><th>Completion</th>{hasCarry && <th>Incentive for the month</th>}{!bde && <th>Not counted</th>}{!bde && <th>Drop-outs</th>}
              {showDecision && v.decisions && <th>Decision</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.key}>
                <tr>
                  <td>
                    <button className="rj-name" onClick={() => setOpen(open === r.key ? null : r.key)} title="Show the joinings">
                      {open === r.key ? '▾' : '▸'} {r.name}
                    </button>
                    <div className="rj-sub">{[r.employeeCode, r.department, r.statusGroup && r.statusGroup !== 'Active' ? r.statusGroup : null].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  <td>{r.seat || '—'}</td>
                  {!bde && <td>{r.tlName || '—'}</td>}
                  {!bde && <td>{r.generated == null ? '—' : r.generated}</td>}
                  <td><Score row={r} /></td>
                  <td><b>{pct(r.joinings, r.target)}</b>{r.completed !== undefined && <div className="rj-sub">{r.completed ? 'Target completed' : 'Not completed yet'}</div>}</td>
                  {hasCarry && <td>{r.completed !== undefined ? <IncentiveCell row={r} mayDecide={v.decide} /> : <span className="rj-sub">No rule</span>}</td>}
                  {!bde && <td>{r.notCountedCount ? <span className="rj-tag orange">{r.notCountedCount}</span> : <span className="rj-sub">None</span>}</td>}
                  {!bde && (
                    <td>
                      {(r.droppedCount || 0) + (r.didNotJoinCount || 0)
                        ? <span className="rj-tag red" title={`${r.droppedCount || 0} left after joining, ${r.didNotJoinCount || 0} did not join`}>{(r.droppedCount || 0) + (r.didNotJoinCount || 0)}</span>
                        : <span className="rj-sub">None</span>}
                    </td>
                  )}
                  {showDecision && v.decisions && (
                    <td>
                      {r.decision ? <DecisionLine d={r.decision} /> : (r.needsDecision ? <span className="rj-wait">{board.ended ? 'Waiting for decision' : 'Month not over yet'}</span> : <span className="rj-sub">{r.employeeId ? 'Not needed (left)' : 'No HRMS record'}</span>)}
                      {canDecide && r.employeeId && (r.needsDecision || r.decision) && (
                        <div className="rj-acts" style={{ marginTop: 6 }}>
                          {!r.left && <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'incentive', row: r })}>Give incentive</button>}
                          {!r.left && <button className="btn btn-sm" onClick={() => setDialog({ kind: 'raise', row: r })}>Raise salary</button>}
                          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'none', row: r })}>No action</button>
                          {r.decision && <button className="btn btn-sm" onClick={() => undo(r)}>Undo</button>}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
                {open === r.key && (
                  <tr className="rj-detail"><td colSpan={cols}><PersonDetail row={r} month={board.month} details={!!v.details} /></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {dialog?.kind === 'incentive' && <IncentiveDialog row={dialog.row} month={board.month} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'raise' && <RaiseDialog row={dialog.row} month={board.month} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'none' && <NoActionDialog row={dialog.row} month={board.month} onClose={() => setDialog(null)} onSaved={saved} />}
    </div>
  );
}

// The department rules in plain words, and the departments that have none yet.
export function DeptRules({ rules, example }) {
  if (!rules || !rules.length) return null;
  return (
    <div className="rj-deptrules">
      {rules.map((r) => (
        <div key={r.department} className={`rj-deptrule${r.set ? '' : ' unset'}`}>
          <b>{r.department}</b>
          <span>{r.sentence}{r.set && !r.amountSet ? ' The incentive amount is not set: Super Admin gives it when the target is completed.' : ''}</span>
        </div>
      ))}
      {example && example.length > 0 && rules.some((r) => r.set) && (
        <div className="rj-sub">Example (target 4): joined 2 in January, so February&apos;s target is 6; joined 2 in February, so March&apos;s target is 8.</div>
      )}
    </div>
  );
}

export function RuleBox({ rule }) {
  if (!rule) return null;
  return (
    <details className="rj-rule">
      <summary>How joinings are counted</summary>
      <p>{rule.counted}</p>
      <p>{rule.notCounted}</p>
      <p>{rule.credit}</p>
    </details>
  );
}

export function SummaryCards({ s, decisions }) {
  if (!s) return null;
  const cards = [
    { k: 'people', label: 'Recruiters', v: s.people, tone: 'blue' },
    { k: 'generated', label: 'Candidates generated', v: s.generated, tone: 'blue' },
    { k: 'joinings', label: `Joinings (target ${s.target})`, v: s.joinings, tone: 'blue' },
    { k: 'dropouts', label: 'Drop-outs', v: s.dropouts, tone: 'red' },
    { k: 'reached', label: 'Reached target', v: s.reached, tone: 'green' },
    { k: 'close', label: 'Close (1 short)', v: s.close, tone: 'orange' },
    { k: 'low', label: 'Low', v: s.low, tone: 'red' },
  ];
  if (decisions && s.pending != null) cards.push({ k: 'pending', label: s.pending ? 'Waiting for decision' : 'All decided', v: s.pending || '✓', tone: s.pending ? 'orange' : 'green' });
  return (
    <div className="rj-cards">
      {cards.map((c) => <div key={c.k} className={`rj-card ${c.tone}`}><b>{c.v === 0 ? 'None' : c.v}</b><span>{c.label}</span></div>)}
    </div>
  );
}

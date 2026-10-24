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

export function IncentiveDialog({ row, month, onClose, onSaved }) {
  const [amount, setAmount] = useState(row.decision?.decision === 'INCENTIVE' && row.decision.amount ? String(row.decision.amount) : '');
  const [note, setNote] = useState(row.decision?.decision === 'INCENTIVE' ? row.decision.note || '' : '');
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

// ---- One person's joinings + month-by-month history ---------------------------------
// HRMS shows COUNTS ONLY (required, achieved, completion %). Who joined, for
// which client and job is in ATS (Candidates & Pipeline).
const pct = (a, t) => (t > 0 ? `${Math.round((a * 100) / t)}%` : '—');

export function PersonDetail({ row, month }) {
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
        Required <b>{row.required ?? row.target}</b> · Achieved <b>{row.achieved ?? row.joinings}</b> · Completion <b>{pct(row.joinings, row.target)}</b>
        {row.notCountedCount ? <> · {row.notCountedCount} more had a joining date but did not join</> : null}.
        {' '}Who joined, and for which client, is in ATS.
      </p>
      {(row.joiningList || []).some((j) => j.drop) && (
        <p className="rj-hint">
          {(row.joiningList || []).filter((j) => j.drop).length} of these joinings dropped after joining (a note only: they are still counted, and no past count or incentive is changed)
          {(row.joiningList || []).some((j) => j.drop && j.drop.afterIncentive) ? '. For at least one, the incentive had already been decided: HR to review' : ''}.
        </p>
      )}
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
              <thead><tr><th>Month</th><th>Required</th><th>Achieved</th><th>Completion</th><th>Result</th></tr></thead>
              <tbody>
                {hist.filter((h) => h.listed).map((h) => (
                  <tr key={h.month}>
                    <td>{h.label}</td><td>{h.target}</td><td>{h.joinings}</td><td>{pct(h.joinings, h.target)}</td>
                    <td><span className={`rj-score ${h.tone}`}>{h.toneWord}</span>{h.decision ? <span className="rj-sub"> · {h.decision.decision === 'INCENTIVE' ? `Incentive${h.decision.amount != null ? ` ${inr(h.decision.amount)}` : ''}` : h.decision.word}</span> : null}</td>
                  </tr>
                ))}
                {!hist.some((h) => h.listed) && <tr><td colSpan="5" className="rj-sub">No months on the recruiter list yet.</td></tr>}
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
  const cols = 6 + (hasCarry ? 1 : 0) + (showDecision && v.decisions ? 1 : 0);

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
              <th>Recruiter</th><th>Seat</th><th>Team lead</th><th>Joinings / required</th><th>Completion</th>{hasCarry && <th>Incentive for the month</th>}<th>Not counted</th>
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
                  <td>{r.tlName || '—'}</td>
                  <td><Score row={r} /></td>
                  <td><b>{pct(r.joinings, r.target)}</b>{r.completed !== undefined && <div className="rj-sub">{r.completed ? 'Target completed' : 'Not completed yet'}</div>}</td>
                  {hasCarry && <td>{r.completed !== undefined ? <IncentiveCell row={r} mayDecide={v.decide} /> : <span className="rj-sub">No rule</span>}</td>}
                  <td>{r.notCountedCount ? <span className="rj-tag orange">{r.notCountedCount}</span> : <span className="rj-sub">None</span>}</td>
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
                  <tr className="rj-detail"><td colSpan={cols}><PersonDetail row={r} month={board.month} /></td></tr>
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
    { k: 'joinings', label: `Joinings (target ${s.target})`, v: s.joinings, tone: 'blue' },
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

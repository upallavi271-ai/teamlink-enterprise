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
function JoinList({ list, empty, notCounted }) {
  if (!list.length) return <div className="rj-empty">{empty}</div>;
  return (
    <div className="tbl-wrap">
      <table className="rj-mini">
        <thead><tr><th>Candidate</th><th>Client</th><th>Job</th><th>Joining date</th><th>{notCounted ? 'Why not counted' : 'Status'}</th></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id}>
              <td>{a.candidate}</td>
              <td>{a.client}</td>
              <td>{a.job}{a.jobCode ? <span className="rj-sub"> · {a.jobCode}</span> : null}</td>
              <td>{dayLabel(a.joiningDate)}</td>
              <td><span className={`rj-tag ${a.tone}`}>{a.status}</span>{a.note ? <div className="rj-sub">{a.note}</div> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PersonDetail({ row, month }) {
  const [hist, setHist] = useState(null);
  const [error, setError] = useState('');
  function loadHistory() {
    api.get(`/recruiter-joinings/history/${row.employeeId}`).then((r) => setHist(r.data.months)).catch((e) => setError(errText(e, 'Could not load the history.')));
  }
  return (
    <div>
      <h4>Joinings counted in {monthLabel(month)} ({row.joinings})</h4>
      <JoinList list={row.joiningList} empty={`No joinings in ${monthLabel(month)}.`} />
      {row.notCountedList.length > 0 && (
        <>
          <h4>Not counted ({row.notCountedList.length})</h4>
          <JoinList list={row.notCountedList} notCounted empty="" />
        </>
      )}
      {row.employeeId && (hist ? (
        <>
          <h4>Month by month</h4>
          <div className="rj-hist">
            {hist.map((h) => (
              <div key={h.month} title={h.decision ? h.decision.word : ''}>
                <div className="rj-sub">{h.label.replace(/ \d{4}$/, '').slice(0, 3)} {h.month.slice(2, 4)}</div>
                {h.listed ? <span className={`rj-score ${h.tone}`}>{h.joinings} / {h.target}</span> : <span className="rj-sub">—</span>}
                {h.decision && <div className="rj-sub">{h.decision.decision === 'INCENTIVE' ? `Incentive${h.decision.amount != null ? ` ${inr(h.decision.amount)}` : ''}` : h.decision.word}</div>}
              </div>
            ))}
          </div>
        </>
      ) : <button className="btn btn-sm" onClick={loadHistory}>Show month by month</button>)}
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
  const cols = 5 + (showDecision && v.decisions ? 1 : 0);

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
    const re = data.recalculate && data.recalculate.length ? ` Recalculate the ${data.recalculate.map(monthLabel).join(', ')} payroll draft before submitting it.` : '';
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
              <th>Recruiter</th><th>Seat</th><th>Team lead</th><th>Joinings / target</th><th>Not counted</th>
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
                    <div className="rj-sub">{[r.employeeCode, r.department, r.left ? r.employmentStatus : null].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  <td>{r.seat || '—'}</td>
                  <td>{r.tlName || '—'}</td>
                  <td><Score row={r} /></td>
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

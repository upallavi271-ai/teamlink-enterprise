// Payroll "Edit" (user spec 2026-10-13, item 5: Edit and Recalculate).
//
// One screen for one employee-month:
//   left  = earnings, deductions, days, the reason
//   right = a live "Before -> After" table (Gross, Total deductions, Net pay, CTC) with the
//           differences in green / red and every changed field listed
// The sums are worked out by ONE shared calculation (utils/payrollCalc.js, a copy of the server's);
// the server works them out again on Save and refuses totals that do not match.
//
// A month that is Approved / Posted / Paid / imported cannot be edited here: the screen says why in plain
// words and offers an ADJUSTMENT (arrears / recovery) that is paid in the next open month instead.
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { errText, monthLabel } from './payrollUi';
import { payrollCalc, payrollCalcProblems } from '../../utils/payrollCalc';
import PayrollEditHistory from './PayrollEditHistory.jsx';
import './payrollEdit.css';

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));

const EARN = [
  ['basic', 'Basic'], ['hra', 'HRA'], ['conveyance', 'Conveyance'], ['specialAllowance', 'Special allowance'],
  ['bonus', 'Bonus'], ['incentive', 'Incentive'], ['arrears', 'Other earnings'],
];
const AUTO_DED = [
  ['pfEmployee', 'PF (employee)'], ['esiEmployee', 'ESI (employee)'], ['professionalTax', 'Professional tax'], ['tds', 'TDS'], ['lopDeduction', 'Absent / LOP amount'],
];
const PLAIN_DED = [['loan', 'Loan / Advance'], ['otherDeductions', 'Other deductions']];
const EMPLOYER = [['pfEmployer', 'PF (employer)'], ['esiEmployer', 'ESI (employer)'], ['gratuity', 'Gratuity']];
const SCALARS = ['basic', 'hra', 'conveyance', 'specialAllowance', 'bonus', 'incentive', 'arrears', 'stipend', 'loan', 'otherDeductions', 'workingDays', 'daysLop', 'daysPresent'];
const AUTO = ['lopDeduction', 'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'pfEmployer', 'esiEmployer', 'gratuity'];
const LABELS = {
  basic: 'Basic', hra: 'HRA', conveyance: 'Conveyance', specialAllowance: 'Special allowance', bonus: 'Bonus', incentive: 'Incentive', arrears: 'Other earnings', stipend: 'Stipend',
  pfEmployee: 'PF (employee)', esiEmployee: 'ESI (employee)', professionalTax: 'Professional tax', tds: 'TDS', lopDeduction: 'Absent / LOP amount', loan: 'Loan / Advance',
  otherDeductions: 'Other deductions', workingDays: 'Working days', daysLop: 'LOP days', pfEmployer: 'PF (employer)', esiEmployer: 'ESI (employer)', gratuity: 'Gratuity',
  awlDays: 'Absent-without-leave days',
};

function Delta({ before, after, goodWhenUp = true }) {
  const d = Math.round(after) - Math.round(before);
  if (!d) return <span className="pe-same">no change</span>;
  const good = goodWhenUp ? d > 0 : d < 0;
  return <span className={good ? 'pe-up' : 'pe-down'}>{d > 0 ? '+' : '−'}{inr(Math.abs(d))}</span>;
}

export function AdjustmentForm({ employeeId, sourceMonth, onDone }) {
  const [kind, setKind] = useState('ARREARS');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  async function add() {
    setBusy(true); setError(''); setDone('');
    try {
      const r = await api.post('/payroll/adjustments', { employeeId, sourceMonth, kind, amount: Number(amount), label, reason });
      setDone(`Added. It will be ${kind === 'ARREARS' ? 'paid' : 'taken back'} in the ${monthLabel(r.data.targetMonth)} payroll${r.data.applied ? ' (already on that record)' : ''}.`);
      setAmount(''); setLabel(''); setReason('');
      if (onDone) onDone(r.data);
    } catch (err) { setError(errText(err, 'Could not add the adjustment.')); } finally { setBusy(false); }
  }
  return (
    <div className="pe-compare" data-testid="adjustment-form">
      <b>Need to correct this month?</b>
      <div className="small-muted" style={{ margin: '4px 0 8px' }}>The old payslip and voucher stay as they are. The correction is added to the next open month with its own line.</div>
      <div className="pe-quick" style={{ marginBottom: 8 }}>
        <button type="button" className={kind === 'ARREARS' ? 'on' : ''} onClick={() => setKind('ARREARS')}>Pay more (arrears)</button>
        <button type="button" className={kind === 'RECOVERY' ? 'on' : ''} onClick={() => setKind('RECOVERY')}>Take back (recovery)</button>
      </div>
      <div className="pe-row-add">
        <input type="text" placeholder="Name, e.g. Salary revision arrears" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input type="number" min="1" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <span />
      </div>
      <div className="field" style={{ margin: '4px 0 8px' }}><input type="text" placeholder="Why is this needed?" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {error && <div className="pe-problem">{error}</div>}
      {done && <div className="pe-ok">{done}</div>}
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !(Number(amount) > 0) || reason.trim().length < 3} onClick={add}>{busy ? 'Adding…' : 'Add adjustment'}</button>
    </div>
  );
}

export default function PayrollEditor({ entryId, canAdjust = false, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [vals, setVals] = useState(null);
  const [earn, setEarn] = useState([]);
  const [ded, setDed] = useState([]);
  const [manual, setManual] = useState({});
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [negOk, setNegOk] = useState('');
  const [busy, setBusy] = useState('');
  const [cmp, setCmp] = useState(null);
  const [hist, setHist] = useState(false);
  const [orig, setOrig] = useState(null);

  function init(p) {
    const c = p.components;
    const v = {};
    SCALARS.concat(AUTO).forEach((k) => { v[k] = c[k] === undefined || c[k] === null ? 0 : c[k]; });
    v.awlDays = c.awlDays === null || c.awlDays === undefined ? null : c.awlDays;
    setData(p); setVals(v); setOrig(JSON.parse(JSON.stringify(v)));
    setEarn(c.earnings.filter((x) => !x.adj).map((x) => ({ ...x })));
    setDed(c.deductions.filter((x) => !x.adj).map((x) => ({ ...x })));
    setManual({ ...c.manual }); setReason(''); setNotes(p.notes || ''); setNegOk(p.allowNegative || ''); setCmp(null);
  }
  useEffect(() => {
    api.get(`/payroll/entries/${entryId}/edit`).then((r) => init(r.data)).catch((err) => setError(errText(err, 'Could not open this payroll record.')));
  }, [entryId]);

  const adjE = data ? data.components.earnings.filter((x) => x.adj) : [];
  const adjD = data ? data.components.deductions.filter((x) => x.adj) : [];
  const origRows = useMemo(() => (data ? { earn: data.components.earnings.filter((x) => !x.adj), ded: data.components.deductions.filter((x) => !x.adj) } : null), [data]);

  const comps = useMemo(() => {
    if (!vals) return null;
    const o = {};
    SCALARS.concat(AUTO).forEach((k) => { o[k] = num(vals[k]); });
    return { ...o, manual, extraEarn: [...adjE, ...earn].map((x) => num(x.amount)), extraDed: [...adjD, ...ded].map((x) => num(x.amount)) };
  }, [vals, manual, earn, ded, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useMemo(() => (comps && data ? payrollCalc(comps, data.rules) : null), [comps, data]);
  const problems = useMemo(() => (comps && res ? payrollCalcProblems(comps, res, { allowNegativeReason: negOk.trim() || null }) : []), [comps, res, negOk]);

  if (!data || !vals || !res) {
    return (
      <Modal title="Payroll" onClose={onClose} wide footer={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
        {error ? <div className="error-text">{error}</div> : <div className="small-muted">Loading…</div>}
      </Modal>
    );
  }

  const e = data.entry;
  const stipend = data.rules.payMode === 'Stipend';
  const editable = data.canEdit;
  const setV = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const shown = (k) => (AUTO.includes(k) && !manual[k] ? res[k] : vals[k]);
  const changedField = (k) => Math.round(num(shown(k))) !== Math.round(num(orig[k]));

  function tick(k, on) {
    setManual((m) => ({ ...m, [k]: on }));
    if (on) setV(k, res[k]); // start from what the rule gives
  }
  const setDays = (which, raw) => {
    const wd = num(vals.workingDays);
    if (which === 'paid') setV('daysLop', Math.max(0, wd - num(raw)));
    else if (which === 'awl') {
      const per = data.awl ? Number(data.awl.perDay) || 2 : 2;
      const delta = num(raw) - num(vals.awlDays);
      setVals((s) => ({ ...s, awlDays: raw, daysLop: Math.max(0, num(s.daysLop) + delta * (per - 1)) }));
    } else setV(which, raw);
  };

  // what changed, in words, for the right-hand list
  const changes = [];
  [...EARN, ['stipend', 'Stipend'], ...AUTO_DED, ...PLAIN_DED, ...EMPLOYER, ['workingDays', 'Working days'], ['daysLop', 'LOP days']].forEach(([k]) => {
    if (k === 'stipend' && !stipend) return;
    if (['basic', 'hra', 'conveyance', 'specialAllowance', 'bonus'].includes(k) && stipend) return;
    const a = Math.round(num(orig[k])); const b = Math.round(num(shown(k)));
    if (a !== b) changes.push({ k, label: LABELS[k], a, b, days: k === 'workingDays' || k === 'daysLop' });
  });
  if (vals.awlDays !== null && Number(vals.awlDays) !== Number(orig.awlDays)) changes.push({ k: 'awlDays', label: LABELS.awlDays, a: orig.awlDays, b: num(vals.awlDays), days: true });
  const oe = origRows.earn; const od = origRows.ded;
  earn.forEach((x) => { const o = oe.find((y) => y.id === x.id); if (!o) changes.push({ k: `n${x.id}`, label: `Added earning: ${x.label || '(no name)'}`, a: 0, b: num(x.amount) }); else if (o.amount !== num(x.amount)) changes.push({ k: `c${x.id}`, label: `Earning: ${x.label}`, a: o.amount, b: num(x.amount) }); });
  oe.forEach((o) => { if (!earn.find((x) => x.id === o.id)) changes.push({ k: `r${o.id}`, label: `Removed earning: ${o.label}`, a: o.amount, b: 0 }); });
  ded.forEach((x) => { const o = od.find((y) => y.id === x.id); if (!o) changes.push({ k: `n${x.id}`, label: `Added deduction: ${x.label || '(no name)'}`, a: 0, b: num(x.amount) }); else if (o.amount !== num(x.amount)) changes.push({ k: `c${x.id}`, label: `Deduction: ${x.label}`, a: o.amount, b: num(x.amount) }); });
  od.forEach((o) => { if (!ded.find((x) => x.id === o.id)) changes.push({ k: `r${o.id}`, label: `Removed deduction: ${o.label}`, a: o.amount, b: 0 }); });
  const manualChanged = JSON.stringify(Object.keys(manual).filter((k) => manual[k]).sort()) !== JSON.stringify(Object.keys(data.components.manual).filter((k) => data.components.manual[k]).sort());
  const dirty = changes.length > 0 || manualChanged;
  const before = data.stored;
  const after = { grossPay: res.grossPay, totalDeductions: res.totalDeductions, netPay: res.netPay, ctc: res.ctc };
  const canSave = editable && dirty && reason.trim().length >= 3 && problems.length === 0 && !busy
    && !(res.netPay < 0 && !negOk.trim()) && earn.every((x) => x.label.trim()) && ded.every((x) => x.label.trim());

  async function save() {
    setBusy('save'); setError('');
    const fields = {};
    SCALARS.forEach((k) => { if (k === 'stipend' && !stipend) return; fields[k] = num(vals[k]); });
    AUTO.forEach((k) => { if (manual[k]) fields[k] = num(vals[k]); });
    if (data.awl && vals.awlDays !== null) fields.awlDays = num(vals.awlDays);
    const body = {
      fields, manual, reason: reason.trim(), notes,
      earnings: earn.map((x) => ({ id: x.id, label: x.label.trim(), amount: num(x.amount) })),
      deductions: ded.map((x) => ({ id: x.id, label: x.label.trim(), amount: num(x.amount) })),
      totals: { ...after }, allowNegative: res.netPay < 0, allowNegativeReason: res.netPay < 0 ? negOk.trim() : undefined,
    };
    try {
      const r = await api.put(`/payroll/entries/${entryId}/edit`, body);
      onSaved(`Saved. ${e.employee.name}'s net pay is now ${inr(r.data.after.netPay)} (was ${inr(r.data.before.netPay)}).${r.data.status === 'DRAFT' ? '' : ''}`);
    } catch (err) { setError(errText(err, 'Could not save.')); } finally { setBusy(''); }
  }
  async function compare() {
    setBusy('cmp'); setError('');
    try { const r = await api.post(`/payroll/entries/${entryId}/edit/recalc`, {}); setCmp(r.data); } catch (err) { setError(errText(err, 'Could not recalculate.')); } finally { setBusy(''); }
  }
  async function applyEngine() {
    setBusy('apply'); setError('');
    try {
      const r = await api.post(`/payroll/entries/${entryId}/edit/recalc`, { apply: true, reason: reason.trim() || 'Recalculated from attendance' });
      onSaved(`Recalculated from attendance. Net pay is now ${inr(r.data.after.netPay)} (was ${inr(r.data.before.netPay)}).`);
    } catch (err) { setError(errText(err, 'Could not apply.')); } finally { setBusy(''); }
  }

  const line = (k, label, opts = {}) => {
    const auto = AUTO.includes(k);
    const isManual = !!manual[k];
    const ch = changedField(k);
    return (
      <div key={k} className={`pe-line${auto ? ' has-auto' : ''}${ch ? ' changed' : ''}`} data-field={k}>
        <label htmlFor={`pe-${k}`}>{label}{opts.note && <small>{opts.note}</small>}{auto && editable && <small>{isManual ? '✎ You type this line. It is kept.' : '✎ Automatic. Tap the pencil to type it yourself.'}</small>}</label>
        <input
          id={`pe-${k}`} type="number" min="0" step="1" value={shown(k)}
          disabled={!editable || (auto && !isManual)} onChange={(ev) => setV(k, ev.target.value)}
        />
        {auto && (editable
          ? <button type="button" className={`pe-pencil${isManual ? ' on' : ''}`} title={isManual ? 'You type this line. Click to let the rules work it out again.' : 'I will type this myself'} aria-pressed={isManual} onClick={() => tick(k, !isManual)}>✎</button>
          : <span />)}
      </div>
    );
  };
  const rowsBlock = (kind, rows, setRows, adj) => (
    <>
      {adj.map((x) => (
        <div key={x.id} className="pe-line"><label>{x.label}<span className="pe-adj">From {monthLabel(x.sourceMonth)} adjustment</span></label><input type="number" value={x.amount} disabled /></div>
      ))}
      {rows.map((x) => (
        <div key={x.id} className="pe-row-add">
          <input type="text" className="pe-name" value={x.label} disabled={!editable} placeholder="Name" onChange={(ev) => setRows((s) => s.map((y) => (y.id === x.id ? { ...y, label: ev.target.value } : y)))} />
          <input type="number" min="0" value={x.amount} disabled={!editable} onChange={(ev) => setRows((s) => s.map((y) => (y.id === x.id ? { ...y, amount: ev.target.value } : y)))} />
          {editable ? <button type="button" className="pe-x" title="Remove this line" onClick={() => setRows((s) => s.filter((y) => y.id !== x.id))}>×</button> : <span />}
        </div>
      ))}
      {editable && <button type="button" className="btn btn-sm" onClick={() => setRows((s) => [...s, { id: `n${Date.now().toString(36)}${s.length}`, label: '', amount: '' }])}>+ Add another {kind}</button>}
    </>
  );

  const perDay = res.perDay;
  return (
    <>
      <Modal
        title={`Edit pay: ${e.employee ? e.employee.name : ''} · ${monthLabel(e.month)}`}
        onClose={onClose}
        wide
        footer={(
          <>
            <span className="pe-foot-net">Net pay <b>{inr(before.netPay)}</b> → <b>{inr(res.netPay)}</b> <Delta before={before.netPay} after={res.netPay} /></span>
            <button className="btn btn-sm" onClick={() => setHist(true)}>History</button>
            {editable && <button className="btn btn-sm" disabled={!!busy} onClick={compare}>{busy === 'cmp' ? 'Checking…' : 'Recalculate from attendance'}</button>}
            {editable && <button className="btn btn-sm" disabled={!dirty || !!busy} onClick={() => init(data)}>Reset my edits</button>}
            <button className="btn btn-sm" onClick={onClose}>Close</button>
            {editable && <button className="btn btn-primary btn-sm" disabled={!canSave} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}
          </>
        )}
      >
        {data.lock && <div className="pe-lock" data-testid="edit-lock"><b>This month cannot be edited.</b> {data.lock.message}</div>}
        {canAdjust && data.lock && <AdjustmentForm employeeId={e.employee.id} sourceMonth={e.month} onDone={() => { if (onSaved) onSaved('Adjustment added.', true); }} />}
        {data.edited && !data.lock && <div className="small-muted" style={{ marginBottom: 8 }}>This record was edited by hand. A normal “Recalculate payroll” leaves it as it is.</div>}
        {error && <div className="pe-problem">{error}</div>}
        <div className="pe-wrap">
          <div className="pe-col">
            <h4>Earnings</h4>
            {stipend ? line('stipend', 'Stipend') : EARN.filter(([k]) => k !== 'arrears' && k !== 'incentive').map(([k, l]) => line(k, l))}
            {line('incentive', 'Incentive')}
            {line('arrears', 'Other earnings', { note: 'arrears, one-off pay' })}
            {rowsBlock('earning', earn, setEarn, adjE)}

            <h4>Deductions</h4>
            {AUTO_DED.map(([k, l]) => line(k, l, k === 'lopDeduction' ? { note: `${res.daysLop} day(s) × ${inr(perDay)} per day` } : {}))}
            {PLAIN_DED.map(([k, l]) => line(k, l))}
            {rowsBlock('deduction', ded, setDed, adjD)}

            <h4>Employer side (for CTC)</h4>
            {EMPLOYER.map(([k, l]) => line(k, l))}

            <h4>Days</h4>
            <div className="pe-days">
              <div className={`pe-line${changedField('workingDays') ? ' changed' : ''}`}><label htmlFor="pe-wd">Working days</label><input id="pe-wd" type="number" min="1" max="31" step="0.5" disabled={!editable} value={vals.workingDays} onChange={(ev) => setDays('workingDays', ev.target.value)} /></div>
              <div className={`pe-line${changedField('daysLop') ? ' changed' : ''}`}><label htmlFor="pe-paid">Paid days</label><input id="pe-paid" type="number" min="0" step="0.5" disabled={!editable} value={Math.max(0, num(vals.workingDays) - num(vals.daysLop))} onChange={(ev) => setDays('paid', ev.target.value)} /></div>
              <div className={`pe-line${changedField('daysLop') ? ' changed' : ''}`}><label htmlFor="pe-lop">LOP days</label><input id="pe-lop" type="number" min="0" step="0.5" disabled={!editable} value={vals.daysLop} onChange={(ev) => setDays('daysLop', ev.target.value)} /></div>
              {data.awl && (
                <div className="pe-line"><label htmlFor="pe-awl">Absent without leave days<small>each counts {data.awl.perDay} LOP days</small></label><input id="pe-awl" type="number" min="0" step="1" disabled={!editable} value={vals.awlDays === null ? 0 : vals.awlDays} onChange={(ev) => setDays('awl', ev.target.value)} /></div>
              )}
            </div>
            <div className="pe-perday">One day = {inr(perDay)} ({inr(res.baseGross)} ÷ {num(vals.workingDays)} days){data.cycle ? ` · pay period ${data.cycle.rangeText}` : ''}.</div>

            {editable && (
              <>
                <h4>Why are you changing this?</h4>
                <div className="field" style={{ margin: 0 }}>
                  <input type="text" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Write the reason (needed to save)" maxLength={200} aria-label="Reason" />
                </div>
                <div className="pe-quick">
                  {data.quickReasons.map((q) => <button key={q} type="button" className={reason === q ? 'on' : ''} onClick={() => setReason(q)}>{q}</button>)}
                </div>
                <div className="field" style={{ margin: '8px 0 0' }}>
                  <input type="text" value={notes} onChange={(ev) => setNotes(ev.target.value)} placeholder="Note for the approver (optional)" maxLength={300} aria-label="Note" />
                </div>
              </>
            )}
          </div>

          <div className="pe-col pe-sum" data-testid="before-after">
            <table>
              <thead><tr><th /><th>Before</th><th>After</th><th>Change</th></tr></thead>
              <tbody>
                <tr><td>Gross pay</td><td>{inr(before.grossPay)}</td><td>{inr(after.grossPay)}</td><td><Delta before={before.grossPay} after={after.grossPay} /></td></tr>
                <tr><td>Total deductions</td><td>{inr(before.totalDeductions)}</td><td>{inr(after.totalDeductions)}</td><td><Delta before={before.totalDeductions} after={after.totalDeductions} goodWhenUp={false} /></td></tr>
                <tr className="big"><td>Net pay</td><td>{inr(before.netPay)}</td><td>{inr(after.netPay)}</td><td><Delta before={before.netPay} after={after.netPay} /></td></tr>
                <tr><td>CTC this month<div className="small-muted" style={{ fontWeight: 400, fontSize: 11.5 }}>pay earned + employer PF / ESI / gratuity</div></td><td>{inr(before.ctc)}</td><td>{inr(after.ctc)}</td><td><Delta before={before.ctc} after={after.ctc} /></td></tr>
              </tbody>
            </table>
            <div style={{ padding: '8px 12px' }}>
              {changes.length === 0 ? <div className="small-muted">Nothing changed yet. Type in a box on the left and the numbers update here.</div> : (
                <ul className="pe-changed-list">
                  {changes.map((c) => <li key={c.k}><b>{c.label}</b>: {c.days ? c.a : inr(c.a)} → {c.days ? c.b : inr(c.b)}</li>)}
                </ul>
              )}
              {Object.keys(manual).filter((k) => manual[k]).length > 0 && <div className="small-muted" style={{ marginTop: 6 }}>✎ Lines you type yourself are kept when the rest is recalculated: {Object.keys(manual).filter((k) => manual[k]).map((k) => LABELS[k]).join(', ')}.</div>}
              {problems.map((p, i) => <div key={i} className="pe-problem">{p.message}</div>)}
              {res.netPay < 0 && (
                <div className="field" style={{ margin: '6px 0 0' }}>
                  <label className="small-muted">Allow net pay below 0. Say why:</label>
                  <input type="text" value={negOk} onChange={(ev) => setNegOk(ev.target.value)} placeholder="e.g. Loan recovery agreed with the employee" />
                </div>
              )}
              {cmp && (
                <div className="pe-compare" data-testid="recalc-compare">
                  {cmp.same ? <b>The attendance numbers are the same as this record. Nothing would change.</b> : (
                    <>
                      <b>Recalculating from attendance would change:</b>
                      <ul className="pe-changed-list">{cmp.changes.map((c) => <li key={c.field}><b>{c.label}</b>: {inr(c.old)} → {inr(c.new)}</li>)}</ul>
                      <div>Net pay {inr(cmp.before.netPay)} → <b>{inr(cmp.after.netPay)}</b> · Gross {inr(cmp.before.grossPay)} → {inr(cmp.after.grossPay)}</div>
                      <div className="small-muted">This replaces your typed lines and added rows with what the attendance and the salary structure give.</div>
                    </>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    {!cmp.same && <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={applyEngine}>{busy === 'apply' ? 'Applying…' : 'Apply these numbers'}</button>}
                    <button className="btn btn-sm" onClick={() => setCmp(null)}>Keep mine</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>
      {hist && <PayrollEditHistory entryId={entryId} onClose={() => setHist(false)} />}
    </>
  );
}

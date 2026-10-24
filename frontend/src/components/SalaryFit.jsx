// ---------------------------------------------------------------------------
// SALARY FIT chips + the two REQUIRED salary boxes (user note 2026-10-10).
//
//   <SalaryFitChips fit onAdd compact />   "83% fit - Above budget" + "+25% hike", icon AND words (never colour alone).
//        fit comes from the SERVER, already cut for the viewer: the BDE team gets the % (rounded) and the label only.
//   <SalaryFields form set errors />       Current + Expected salary, required, with a per-year / per-month switch and a
//        line that says how the number will be read ("Read as ₹5.4L a year (₹45,000 a month)").
//
// The % is defined once, in backend/src/utils/salaryFit.js: 100% when the expected pay is inside the client's budget (or
// below it - flagged "Below range"), otherwise budget maximum / expected pay. Hike % = (expected - current) / current.
// ---------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import api from '../api';
import Modal from './Modal.jsx';
import { validateSalaries, parseAmount, plainBoth } from '../utils/salaryFit';
import './SalaryFit.css';

const TONE = { green: 'sfit-green', amber: 'sfit-amber', red: 'sfit-red', grey: 'sfit-grey', blue: 'sfit-blue' };

export function fitTitle(fit) {
  if (!fit) return '';
  if (fit.state === 'no-salary') return 'The expected salary is not saved yet.';
  if (fit.state === 'no-budget') return fit.budgetPrompt || 'The client has not given a budget for this requirement yet.';
  const a = fit.approx ? 'about ' : '';
  if (fit.band === 'within') return fit.belowRange ? 'Asks for less than the client\'s minimum: fits the budget (below range).' : 'Asks for pay inside the client\'s budget: 100% fit.';
  return `Asks for more than the client's maximum. Fit = the budget maximum divided by the expected pay (${a}${fit.pct}%).${fit.budgetText ? ` Client budget: ${fit.budgetText}.` : ''}`;
}

export function SalaryFitChips({
  fit, onAdd, compact = false, showBudget = false,
}) {
  if (!fit) return null;
  const chips = [];
  if (fit.state === 'no-salary') {
    chips.push(onAdd
      ? <button key="m" type="button" className="sfit-chip sfit-grey sfit-btn" onClick={(e) => { e.stopPropagation(); onAdd(); }} title="Salary is needed before this person goes to the client"><span className="sfit-ico" aria-hidden="true">+</span>Add salary</button>
      : <span key="m" className="sfit-chip sfit-grey" title={fit.prompt || fitTitle(fit)}><span className="sfit-ico" aria-hidden="true">+</span>Salary missing</span>);
  } else if (fit.state === 'no-budget') {
    chips.push(<span key="b" className="sfit-chip sfit-grey" title={fitTitle(fit)}><span className="sfit-ico" aria-hidden="true">–</span>Client budget not set</span>);
  } else {
    chips.push(
      <span key="f" className={`sfit-chip ${TONE[fit.tone] || 'sfit-grey'}`} title={fitTitle(fit)}>
        <span className="sfit-ico" aria-hidden="true">{fit.icon}</span>
        <span>{`${fit.approx ? '~' : ''}${fit.pct}% fit`}</span>
        {!compact && <span>{`· ${fit.label}`}</span>}
      </span>,
    );
    if (compact) chips.push(<span key="l" className={`sfit-chip ${TONE[fit.tone] || 'sfit-grey'}`} title={fitTitle(fit)}>{fit.label}</span>);
    if (fit.belowRange) chips.push(<span key="r" className="sfit-chip sfit-blue" title="Asks for less than the client's minimum"><span className="sfit-ico" aria-hidden="true">↓</span>Below range</span>);
  }
  if (fit.hikeLabel && fit.state !== 'no-salary') {
    chips.push(<span key="h" className="sfit-chip sfit-grey" title="Hike = (expected - current) / current">{fit.hikeLabel}</span>);
  }
  if (onAdd && fit.state !== 'no-salary' && (fit.missing === 'current' || fit.missing === 'both')) {
    chips.push(<button key="mc" type="button" className="sfit-chip sfit-grey sfit-btn" onClick={(e) => { e.stopPropagation(); onAdd(); }}>+ Add current salary</button>);
  }
  return (
    <span className="sfit" aria-label={`Salary fit: ${fit.label}${fit.pct != null ? `, ${fit.pct} percent` : ''}`}>
      {chips}
      {showBudget && fit.budgetText ? <span className="sfit-sub">{`Client budget: ${fit.budgetText}`}</span> : null}
    </span>
  );
}

// A bigger block for the profile header and the Send-to-client steps.
export function SalaryFitBox({ fit, onAdd, title = 'Salary fit' }) {
  if (!fit) return null;
  return (
    <div className="sfit-box">
      <div className="sfit-title">{title}</div>
      <SalaryFitChips fit={fit} onAdd={onAdd} showBudget />
      {fit.pct != null && (
        <div className="sfit-bar" role="img" aria-label={`${fit.pct} percent`}><i className={TONE[fit.tone] || ''} style={{ width: `${Math.max(3, fit.pct)}%` }} /></div>
      )}
      {(fit.expectedSalary != null || fit.currentSalary != null) && (
        <div className="sfit-sub">
          {[fit.currentSalary != null ? `Now ${fit.currentSalary === 0 ? 'Fresher (0)' : `₹${fit.currentSalary}L`}` : null, fit.expectedSalary != null ? `Wants ₹${fit.expectedSalary}L` : null].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ---- the two required boxes --------------------------------------------------------
function One({
  name, label, placeholder, value, unit, onValue, onUnit, error, required, kind,
}) {
  const p = value ? parseAmount(value, { unit: unit || undefined }) : null;
  let read = '';
  if (p && p.ok && !p.range) {
    read = p.fresher && kind === 'current' ? 'Read as Fresher (0).' : `Read as ${plainBoth(p.lpa)}${p.assumed && !unit ? '. Press "per month" or "per year" if this is wrong' : ''}.`;
  }
  return (
    <div className={`sfld-one${error ? ' bad' : ''}`}>
      <span className="sfld-lbl">{label}</span>
      <div className="sfld-row">
        <input
          id={`sf-${name}`}
          name={name}
          inputMode="text"
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          aria-required="true"
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={`sf-${name}-m`}
          onChange={(e) => onValue(e.target.value)}
        />
        <span className="sfld-unit" role="group" aria-label={`${label}: how it is written`}>
          <button type="button" className={unit === 'year' ? 'on' : ''} aria-pressed={unit === 'year'} onClick={() => onUnit(unit === 'year' ? '' : 'year')}>per year</button>
          <button type="button" className={unit === 'month' ? 'on' : ''} aria-pressed={unit === 'month'} onClick={() => onUnit(unit === 'month' ? '' : 'month')}>per month</button>
        </span>
      </div>
      <div id={`sf-${name}-m`}>
        {error
          ? <div className="sfld-err" role="alert">{error}</div>
          : <div className="sfld-read">{read || (kind === 'current' ? 'Write 0 if the person is a fresher.' : 'What the person wants. e.g. 6 LPA or 50000 per month.')}</div>}
      </div>
    </div>
  );
}

// What the server would say about these two boxes (same words, same rules).
export function salaryCheck(form) {
  return validateSalaries({
    currentSalary: form.currentSalary,
    expectedSalary: form.expectedSalary,
    currentSalaryUnit: form.currentSalaryUnit || undefined,
    expectedSalaryUnit: form.expectedSalaryUnit || undefined,
  });
}

export function SalaryFields({
  form, set, errors = {}, required = true,
}) {
  const live = useMemo(() => salaryCheck(form), [form.currentSalary, form.expectedSalary, form.currentSalaryUnit, form.expectedSalaryUnit]); // eslint-disable-line react-hooks/exhaustive-deps
  const warn = live.ok ? live.warnings : [];
  return (
    <div className="sfld">
      <One
        kind="current"
        name="currentSalary"
        label="Current salary (CTC)"
        required={required}
        placeholder="e.g. 4.5 LPA or 45000 per month"
        value={form.currentSalary || ''}
        unit={form.currentSalaryUnit || ''}
        onValue={(v) => set({ currentSalary: v })}
        onUnit={(u) => set({ currentSalaryUnit: u })}
        error={errors.currentSalary}
      />
      <One
        kind="expected"
        name="expectedSalary"
        label="Expected salary"
        required={required}
        placeholder="e.g. 6 LPA or 50000 per month"
        value={form.expectedSalary || ''}
        unit={form.expectedSalaryUnit || ''}
        onValue={(v) => set({ expectedSalary: v })}
        onUnit={(u) => set({ expectedSalaryUnit: u })}
        error={errors.expectedSalary}
      />
      {warn.map((w) => <div key={w} className="sfld-warn" role="status">{`Please check: ${w}`}</div>)}
    </div>
  );
}

// ---- "Add salary": the gentle fix for an old record (and for the Send-to-client step) -----------------------------
// Saves through the ordinary edit (PUT /candidates/:id), which checks and cleans the numbers on the server.
export function AddSalaryDialog({
  candidateId, name, current = '', expected = '', onClose, onSaved, why,
}) {
  const [form, setForm] = useState({
    currentSalary: current || '', expectedSalary: expected || '', currentSalaryUnit: '', expectedSalaryUnit: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  async function save() {
    const v = salaryCheck(form);
    if (!v.ok) { setErrors(v.errors); setMsg(''); return; }
    setErrors({}); setBusy(true); setMsg('');
    try {
      await api.put(`/candidates/${candidateId}`, {
        currentSalary: form.currentSalary, expectedSalary: form.expectedSalary, currentSalaryUnit: form.currentSalaryUnit || undefined, expectedSalaryUnit: form.expectedSalaryUnit || undefined,
      });
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      const d = err.response && err.response.data;
      if (d && d.errors) setErrors(d.errors);
      setMsg((d && d.error) || 'Could not save the salary. Please try again.');
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Add salary${name ? ` — ${name}` : ''}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save salary'}</button>
        </>
      )}
    >
      <div className="small-muted" style={{ marginBottom: 10 }}>{why || 'Both are needed before the person goes to the client.'}</div>
      <SalaryFields form={form} set={set} errors={errors} />
      {msg && <div className="sfld-err" role="alert" style={{ marginTop: 8 }}>{msg}</div>}
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini, SectionLabel, Modal } from '../proto.jsx';
import Combo from '../Combo.jsx';
import SalaryStructureCard, { rupees } from './SalaryStructureCard.jsx';

// ---------------------------------------------------------------------------
// EXTRA SALARY STRUCTURES (founder 2026-11-28): "+ Add structure", choose the components and their percentage, edit and delete them.
// Payroll > Salary Structure. The server works out every figure (backend utils/salaryTemplates.js); this screen only collects the
// components and shows the preview. An employee is put on a structure from their own Edit / Set CTC window.
// ---------------------------------------------------------------------------

const EARNING_CALCS = [['pctCtc', '% of CTC'], ['pctBasic', '% of Basic'], ['fixed', 'Fixed ₹'], ['rest', 'Rest of CTC']];
const DEDUCTION_CALCS = [['pctGross', '% of Gross'], ['pctBasic', '% of Basic'], ['fixed', 'Fixed ₹']];
const isBasic = (name) => /^basic( salary| pay)?$/i.test(String(name || '').trim());

const howText = (c) => {
  if (c.calc === 'rest') return 'rest of CTC';
  if (c.calc === 'fixed') return rupees(c.value);
  const of = c.calc === 'pctCtc' ? 'CTC' : c.calc === 'pctBasic' ? 'Basic' : 'Gross';
  return `${c.value}% of ${of}`;
};
export const structureSummary = (t) => [
  ...t.components.map((c) => `${c.name} ${howText(c)}${c.kind === 'deduction' ? ' (deduction)' : ''}`),
  t.pf?.on ? `PF ${t.pf.employeePct}% + ${t.pf.employerPct}%` : 'No PF',
  t.gratuity?.on ? `Gratuity ${t.gratuity.pct}%` : 'No gratuity',
  t.pt?.on ? 'PT' : 'No PT',
].join(' · ');

let rowSeq = 0;
// `base` = the Basic row itself: its name and type cannot change and it cannot be deleted.
const withKey = (c) => { rowSeq += 1; return { ...c, key: rowSeq, base: isBasic(c.name), value: c.calc === 'rest' ? '' : String(c.value ?? '') }; };

function blank(defaults) {
  return {
    name: '',
    components: [
      { name: 'Basic', kind: 'earning', calc: 'pctCtc', value: 40 },
      { name: 'HRA', kind: 'earning', calc: 'pctBasic', value: 40 },
      { name: 'Special Allowance', kind: 'earning', calc: 'rest' },
    ],
    pf: { on: true, employeePct: defaults.employeePct, employerPct: defaults.employerPct, cap: defaults.cap },
    gratuity: { on: true, pct: defaults.gratuityPct },
    pt: { on: true },
  };
}

function StructureBuilder({ existing, defaults, onClose, onSaved }) {
  const start = existing || blank(defaults);
  const [name, setName] = useState(start.name);
  const [rows, setRows] = useState(() => start.components.map(withKey));
  const [pf, setPf] = useState(() => ({ ...start.pf }));
  const [gratuity, setGratuity] = useState(() => ({ ...start.gratuity }));
  const [pt, setPt] = useState(() => ({ ...start.pt }));
  const [ctc, setCtc] = useState('25000');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const definition = () => ({
    name,
    components: rows.map(({ name: n, kind, calc, value }) => ({ name: n, kind, calc, value })),
    pf, gratuity, pt,
  });
  const signature = JSON.stringify([rows, pf, gratuity, pt, ctc]);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.post('/payroll/structures/preview', { definition: definition(), monthlyCtc: Number(ctc) || 0 })
        .then((res) => { if (n === seq.current) setPreview(res.data); })
        .catch((err) => { if (n === seq.current) setPreview({ error: err.response?.data?.error || 'Could not work out the preview.', breakup: null }); });
    }, 300);
    return () => clearTimeout(t);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (key, change) => setRows((list) => list.map((r) => {
    if (r.key === key) {
      const next = { ...r, ...change };
      if (change.kind && !(change.kind === 'earning' ? EARNING_CALCS : DEDUCTION_CALCS).some(([c]) => c === next.calc)) next.calc = 'fixed';
      if (change.calc) next.value = '';
      return next;
    }
    // only one component takes the rest of the CTC
    if (change.calc === 'rest' && r.calc === 'rest') return { ...r, calc: 'fixed', value: '' };
    return r;
  }));
  const add = (kind) => setRows((list) => [...list, withKey({ name: '', kind, calc: kind === 'earning' ? 'pctCtc' : 'fixed', value: '' })]);
  const remove = (key) => setRows((list) => list.filter((r) => r.key !== key));

  async function save() {
    setError(''); setBusy(true);
    try {
      if (existing) await api.put(`/payroll/structures/${existing.id}`, definition());
      else await api.post('/payroll/structures', definition());
      onSaved(existing ? `"${name.trim()}" saved.` : `"${name.trim()}" added. To use it, open an employee's Edit or Set CTC below and choose it.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the structure.');
    } finally { setBusy(false); }
  }

  const numberField = (label, value, onChange) => (
    <div className="field">
      <label>{label}</label>
      <input type="number" min="0" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
  const check = (label, checked, onChange) => (
    <label className="st-check"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /> {label}</label>
  );

  return (
    <Modal
      title={existing ? `Edit structure — ${existing.name}` : 'Add structure'}
      onClose={onClose}
      wide
      footer={(
        <>
          {error && <span className="error-text" style={{ marginRight: 'auto' }}>{error}</span>}
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save structure'}</button>
        </>
      )}
    >
      <div className="field">
        <label>Structure name</label>
        <input value={name} maxLength={40} autoFocus placeholder="For example: Field staff" onChange={(e) => setName(e.target.value)} />
      </div>

      <SectionLabel style={{ margin: '6px 0' }}>Components</SectionLabel>
      <div className="st-rows" data-testid="st-rows">
        <div className="st-row st-head" aria-hidden="true"><span>Component name</span><span>Type</span><span>Worked out as</span><span>% or ₹</span><span /></div>
        {rows.map((r) => {
          const basic = r.base;
          const calcs = basic || isBasic(r.name) ? EARNING_CALCS.filter(([c]) => c === 'pctCtc' || c === 'fixed') : r.kind === 'earning' ? EARNING_CALCS : DEDUCTION_CALCS;
          const locked = basic ? 'Basic is needed in every structure' : r.calc === 'rest' ? 'Choose another component as "Rest of CTC" first' : '';
          return (
            <div className="st-row" key={r.key} data-testid="st-row">
              <input aria-label="Component name" value={r.name} maxLength={40} readOnly={basic} placeholder={r.kind === 'earning' ? 'For example: Travel allowance' : 'For example: Insurance'} onChange={(e) => patch(r.key, { name: e.target.value })} />
              <Combo aria-label="Type" value={r.kind} disabled={basic} onChange={(e) => patch(r.key, { kind: e.target.value })}>
                <option value="earning">Earning</option>
                <option value="deduction">Deduction</option>
              </Combo>
              <Combo aria-label="Worked out as" value={r.calc} onChange={(e) => patch(r.key, { calc: e.target.value })}>
                {calcs.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
              </Combo>
              <input aria-label="Percentage or amount" type="number" min="0" step="any" value={r.value} disabled={r.calc === 'rest'} placeholder={r.calc === 'rest' ? 'auto' : r.calc === 'fixed' ? '₹' : '%'} onChange={(e) => patch(r.key, { value: e.target.value })} />
              <button type="button" className="btn btn-sm st-del" disabled={!!locked} title={locked || 'Delete this component'} aria-label={`Delete ${r.name || 'component'}`} onClick={() => remove(r.key)}>✕</button>
            </div>
          );
        })}
      </div>
      <div className="qa-row" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-sm" onClick={() => add('earning')}>+ Add earning</button>
        <button type="button" className="btn btn-sm" onClick={() => add('deduction')}>+ Add deduction</button>
      </div>

      <SectionLabel style={{ margin: '16px 0 6px' }}>PF, gratuity and professional tax</SectionLabel>
      {check('PF (Provident Fund)', pf.on, (on) => setPf({ ...pf, on }))}
      {pf.on && (
        <div className="prb-grid4 st-sub">
          {numberField('Employee % of Basic', pf.employeePct, (v) => setPf({ ...pf, employeePct: v }))}
          {numberField('Company % of Basic', pf.employerPct, (v) => setPf({ ...pf, employerPct: v }))}
          {numberField('Monthly limit ₹ (0 = none)', pf.cap, (v) => setPf({ ...pf, cap: v }))}
        </div>
      )}
      {check('Gratuity', gratuity.on, (on) => setGratuity({ ...gratuity, on }))}
      {gratuity.on && <div className="prb-grid4 st-sub">{numberField('Gratuity % of Basic', gratuity.pct, (v) => setGratuity({ ...gratuity, pct: v }))}</div>}
      {check('Professional tax (Telangana slab)', pt.on, (on) => setPt({ on }))}
      <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        ESI and TDS are set on each employee's salary, as before. A deduction added here is the same amount every month (not reduced for unpaid days).
      </div>

      <SectionLabel style={{ margin: '16px 0 6px' }}>Check with an example</SectionLabel>
      <div className="field" style={{ maxWidth: 220 }}>
        <label>Monthly CTC (₹)</label>
        <input type="number" min="0" step="500" value={ctc} onChange={(e) => setCtc(e.target.value)} />
      </div>
      {preview?.error && <div className="notice amber" data-testid="st-preview-error"><span>{preview.error}</span></div>}
      {preview?.breakup && <SalaryStructureCard b={preview.breakup} title={name.trim() || 'New structure'} subtitle="Example only" />}
    </Modal>
  );
}

export default function SalaryStructures({ isAdmin, onChanged }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | structure | null
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    api.get('/payroll/structures').then((res) => setData(res.data)).catch((err) => setError(err.response?.data?.error || 'Could not load the salary structures.'));
  }
  useEffect(load, []);

  async function remove(t) {
    const used = t.usedBy ? ` ${t.usedBy} employee(s) are on it now; their saved salaries stay exactly as they are.` : '';
    if (!window.confirm(`Delete the salary structure "${t.name}"?${used}`)) return;
    setError(''); setMessage('');
    try {
      await api.delete(`/payroll/structures/${t.id}`);
      setMessage(`"${t.name}" deleted.`);
      load(); onChanged?.();
    } catch (err) { setError(err.response?.data?.error || 'Could not delete the structure.'); }
  }

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Extra salary structures">
        {isAdmin && data && <button className="btn btn-primary btn-sm" onClick={() => { setMessage(''); setEditing('new'); }}>+ Add structure</button>}
      </PanelHead>
      <div style={{ padding: '10px 18px 0', fontSize: 12 }} className="cell-muted">
        Your own structures with your own components. Employees stay on the Standard Package until you choose one of these on their Edit or Set CTC window.
      </div>
      {message && <div className="small-muted" style={{ padding: '8px 18px 0' }} role="status">{message}</div>}
      {error && <div className="error-text" style={{ padding: '8px 18px 0' }}>{error}</div>}
      {data && data.structures.length === 0 && <EmptyMini>No extra structure yet.</EmptyMini>}
      {data && data.structures.map((t) => (
        <div className="st-item" key={t.id} data-testid="st-item">
          <div style={{ minWidth: 0 }}>
            <b>{t.name}</b> <span className="cell-muted" style={{ fontSize: 11.5 }}>· {t.usedBy} employee(s)</span>
            <div className="cell-muted st-summary">{structureSummary(t)}</div>
          </div>
          {isAdmin && (
            <div className="st-actions">
              <button className="btn btn-sm" onClick={() => { setMessage(''); setEditing(t); }}>Edit</button>
              <button className="btn btn-sm" onClick={() => remove(t)}>Delete</button>
            </div>
          )}
        </div>
      ))}
      <div style={{ height: 12 }} />
      {editing && data && (
        <StructureBuilder
          existing={editing === 'new' ? null : editing}
          defaults={data.defaults}
          onClose={() => setEditing(null)}
          onSaved={(text) => { setEditing(null); setMessage(text); load(); onChanged?.(); }}
        />
      )}
    </Panel>
  );
}

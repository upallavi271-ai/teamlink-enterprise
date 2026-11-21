import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import { Notice, Section, Table, useLoad, useAction, Pills, row } from '../kit.jsx';

// ---------------------------------------------------------------------------
// ATS settings -> Forms & workflows: custom sections and fields on the job and client forms (13.02) and the blueprints - what must be
// there before a person enters a step, per department (13.03). Backend: utils/atsPlus/admin.js.
// ---------------------------------------------------------------------------
function FormEditor() {
  const { data, err, reload } = useLoad('/ats-plus/forms');
  const { run, busy, flash } = useAction(reload);
  const [ent, setEnt] = useState('Requirement');
  const [sections, setSections] = useState([]);
  useEffect(() => { if (data) setSections(JSON.parse(JSON.stringify((data.forms[ent] || { sections: [] }).sections))); }, [data, ent]);
  const setF = (si, fi, k, v) => setSections(sections.map((s, i) => (i !== si ? s : { ...s, fields: s.fields.map((f, j) => (j === fi ? { ...f, [k]: v } : f)) })));
  const canEdit = data && data.canEdit;
  return (
    <Section title="Custom forms and layouts" note="Add sections and fields to the job and client forms. They show as 'More details' on the job / client page, in this order. The candidate form has its own custom fields.">
      <Notice tone="red">{err}</Notice>{flash}
      <Pills value={ent} onChange={setEnt} options={[['Requirement', 'Job (requirement) form'], ['Client', 'Client form']]} />
      <div className="small-muted" style={{ marginBottom: 6 }}>Candidate form: <Link to="/admin/candidate-fields">Administration → Candidate fields</Link></div>
      {sections.map((s, si) => (
        <div key={si} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={row}><input aria-label="Section title" value={s.title} disabled={!canEdit} onChange={(e) => setSections(sections.map((x, i) => (i === si ? { ...x, title: e.target.value } : x)))} />
            {canEdit && <><button type="button" className="btn btn-sm" disabled={si === 0} onClick={() => { const n = [...sections]; [n[si - 1], n[si]] = [n[si], n[si - 1]]; setSections(n); }}>Up</button>
              <button type="button" className="btn btn-sm" onClick={() => setSections(sections.filter((_, i) => i !== si))}>Remove section</button></>}</div>
          {s.fields.map((f, fi) => (
            <div key={fi} style={{ ...row, marginTop: 4 }}>
              <input aria-label="Field label" placeholder="Label" value={f.label} disabled={!canEdit} onChange={(e) => setF(si, fi, 'label', e.target.value)} />
              <select aria-label="Type" value={f.type} disabled={!canEdit} onChange={(e) => setF(si, fi, 'type', e.target.value)}>{(data ? data.types : []).map((t) => <option key={t} value={t}>{{ text: 'Text', textarea: 'Long text', number: 'Number', date: 'Date', select: 'Pick list', yesno: 'Yes / No' }[t]}</option>)}</select>
              {f.type === 'select' && <input aria-label="Choices" placeholder="Choices, comma separated" value={Array.isArray(f.options) ? f.options.join(', ') : (f.options || '')} disabled={!canEdit} onChange={(e) => setF(si, fi, 'options', e.target.value)} />}
              <label><input type="checkbox" checked={!!f.required} disabled={!canEdit} onChange={(e) => setF(si, fi, 'required', e.target.checked)} /> needed</label>
              {canEdit && <button type="button" className="btn btn-sm" onClick={() => setSections(sections.map((x, i) => (i === si ? { ...x, fields: x.fields.filter((_, j) => j !== fi) } : x)))}>Remove</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => setSections(sections.map((x, i) => (i === si ? { ...x, fields: [...x.fields, { label: '', type: 'text', required: false }] } : x)))}>+ Field</button>}
        </div>
      ))}
      {canEdit && <div style={row}><button type="button" className="btn btn-sm" onClick={() => setSections([...sections, { title: 'New section', fields: [] }])}>+ Section</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put(`/ats-plus/forms/${ent}`, { sections }), 'Form saved.')}>Save form</button></div>}
    </Section>
  );
}

function Blueprints() {
  const { data, err, reload } = useLoad('/ats-plus/blueprints');
  const { run, busy, flash } = useAction(reload);
  const [rules, setRules] = useState([]);
  useEffect(() => { if (data) setRules(data.rules.map((r) => ({ ...r }))); }, [data]);
  const set = (i, k, v) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Section title="Workflow blueprints" note="What must be there before a person ENTERS a step, per department (or every department). Every way of moving a person obeys it: the board, the step menu, bulk moves and the AI agent. Which steps a department uses and who approves them stay in Pipeline & checks.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <Table rows={rules} rowKey={(r, i) => i} empty="No blueprint: every step works as before."
        cols={[
          { key: 'd', label: 'Department', render: (r) => { const i = rules.indexOf(r); return <select aria-label="Department" value={r.department} disabled={!data.canEdit} onChange={(e) => set(i, 'department', e.target.value)}><option value="*">Every department</option>{data.departments.map((d) => <option key={d} value={d}>{d}</option>)}</select>; } },
          { key: 's', label: 'Before entering', render: (r) => { const i = rules.indexOf(r); return <select aria-label="Step" value={r.stage} disabled={!data.canEdit} onChange={(e) => set(i, 'stage', e.target.value)}>{data.stages.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select>; } },
          { key: 'k', label: 'Needs', render: (r) => { const i = rules.indexOf(r); return <span style={row}><select aria-label="Needs" value={r.kind} disabled={!data.canEdit} onChange={(e) => set(i, 'kind', e.target.value)}>{Object.entries(data.kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {r.kind === 'comment' && <input aria-label="Words" type="number" min="1" style={{ width: 60 }} value={r.words || 5} disabled={!data.canEdit} onChange={(e) => set(i, 'words', e.target.value)} />}
            {r.kind === 'doc' && <select aria-label="Document" value={r.docType || ''} disabled={!data.canEdit} onChange={(e) => set(i, 'docType', e.target.value)}><option value="">any</option>{['Resume', 'ID', 'Certificate', 'Offer', 'Joining'].map((d) => <option key={d}>{d}</option>)}</select>}</span>; } },
          { key: 'x', label: '', render: (r) => data.canEdit && <button type="button" className="btn btn-sm" onClick={() => setRules(rules.filter((x) => x !== r))}>Remove</button> },
        ]} />}
      {data && data.canEdit && <div style={row}><button type="button" className="btn btn-sm" onClick={() => setRules([...rules, { department: '*', stage: data.stages[0].code, kind: 'comment', words: 5 }])}>+ Rule</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/blueprints', { rules }), 'Blueprint saved.')}>Save blueprint</button>
        <Link to="/admin/pipeline">Pipeline & checks →</Link></div>}
    </Section>
  );
}

export default function FormsTab() {
  return <><FormEditor /><Blueprints /></>;
}

import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { Notice, Section, Table, useLoad, useAction, Field, row } from './kit.jsx';

// ---------------------------------------------------------------------------
// OFFERS - the clause library (11.06), the conditional fields on one offer, and bulk offers (11.07). Backend: utils/atsPlus/offers.js.
// The clauses are appended to every letter under "Terms" when their conditions fit the job and the offer.
// ---------------------------------------------------------------------------

// inside the letter preview: which clauses apply, and the fields they ask for
export function OfferClauseFields({ row: r, onChanged }) {
  const { data, reload } = useLoad(`/ats-plus/offers/${r.id}/clauses`);
  const [vals, setVals] = useState({});
  const { run, busy, flash } = useAction(async () => { await reload(); if (onChanged) onChanged(); });
  if (!data || (!data.used.length && !data.fields.length)) return null;
  return (
    <div className="card" style={{ padding: 10, marginTop: 8 }}>
      <b>Clauses on this offer</b>
      <div className="small-muted">{data.used.map((u) => `${u.title} (${u.why.join(', ')})`).join(' · ')}</div>
      {flash}
      {data.fields.length > 0 && (
        <div style={{ ...row, marginTop: 6 }}>
          {data.fields.map((f) => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>{f.label}{f.required ? ' *' : ''}
              <input value={vals[f.key] ?? f.value ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} aria-label={f.label} />
            </label>
          ))}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put(`/ats-plus/offers/${r.id}/clause-fields`, { values: vals }), 'Saved into the letter.')}>Save</button>
        </div>
      )}
      {data.missing.length > 0 && <Notice tone="amber">Still to fill: {data.missing.join(', ')}</Notice>}
    </div>
  );
}

export function BulkOffersButton({ onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Bulk offers</button>
      {open && <BulkOffers onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}
function BulkOffers({ onClose, onDone }) {
  const { data, err } = useLoad('/ats-plus/offers/bulk/candidates');
  const [pick, setPick] = useState({});
  const [f, setF] = useState({ offeredCtc: '', joiningDate: '', offerNotes: '' });
  const [res, setRes] = useState(null);
  const [letters, setLetters] = useState(null);
  const { run, busy, flash } = useAction();
  const ids = Object.keys(pick).filter((k) => pick[k]);
  const prepare = () => run(() => api.post('/ats-plus/offers/bulk/prepare', { rows: ids.map((id) => ({ applicationId: id, offeredCtc: pick[id] && pick[id] !== true ? pick[id] : undefined })), offeredCtc: f.offeredCtc || undefined, joiningDate: f.joiningDate || undefined, offerNotes: f.offerNotes || undefined, confirmCtc: true }), (d) => d.message).then((d) => { if (d) { setRes(d); if (onDone) onDone(); } });
  const print = () => api.post('/ats-plus/offers/bulk/letters', { ids }).then((r) => {
    setLetters(r.data.rows);
    const w = window.open('', '_blank');
    if (w) { w.document.write(`<pre style="font-family:inherit;white-space:pre-wrap">${r.data.rows.filter((x) => x.ok).map((x) => x.text.replace(/</g, '&lt;')).join('\n\n<div style="page-break-after:always"></div>\n')}</pre>`); w.document.close(); w.print(); }
  });
  return (
    <Modal title="Bulk offers" size="wide" onClose={onClose}>
      <div className="small-muted">For campus or bulk hiring. Tick the people at Selected, give one CTC and joining date (or a CTC per person). Each offer goes through the same checks as one offer and then waits for approval.</div>
      <Notice tone="red">{err}</Notice>{flash}
      {data && <Table rows={data.rows} empty="Nobody is at Selected in your list."
        cols={[
          { key: 'p', label: '', render: (r) => <input type="checkbox" aria-label={`Pick ${r.name}`} checked={!!pick[r.id]} onChange={(e) => setPick({ ...pick, [r.id]: e.target.checked ? (pick[r.id] || true) : false })} /> },
          { key: 'name', label: 'Person' }, { key: 'job', label: 'Job' }, { key: 'client', label: 'Client' },
          { key: 'c', label: 'Own CTC (optional)', render: (r) => <input type="number" aria-label={`CTC for ${r.name}`} style={{ width: 110 }} disabled={!pick[r.id]} value={pick[r.id] && pick[r.id] !== true ? pick[r.id] : ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value || true })} /> },
          { key: 'res', label: 'Result', render: (r) => { const x = res && res.rows.find((y) => y.applicationId === r.id); return x ? (x.ok ? 'Prepared' : x.message) : ''; } },
        ]} />}
      <div className="grid-2" style={{ marginTop: 8 }}>
        <Field label="CTC for everyone (₹ a year)"><input type="number" value={f.offeredCtc} onChange={(e) => setF({ ...f, offeredCtc: e.target.value })} /></Field>
        <Field label="Joining date"><input type="date" value={f.joiningDate} onChange={(e) => setF({ ...f, joiningDate: e.target.value })} /></Field>
      </div>
      <Field label="Note on every offer (optional)"><input value={f.offerNotes} onChange={(e) => setF({ ...f, offerNotes: e.target.value })} /></Field>
      <div style={row}>
        <button type="button" className="btn btn-primary" disabled={busy || !ids.length} onClick={prepare}>Prepare {ids.length || ''} offer(s)</button>
        <button type="button" className="btn" disabled={!ids.length} onClick={print}>Print the letters</button>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      {letters && <div className="small-muted">{letters.filter((x) => x.ok).length} letter(s) opened for printing.</div>}
    </Modal>
  );
}

// Administration -> ATS settings -> Offers & onboarding
const COND = [['departments', 'Departments'], ['hiringTypes', 'Hiring types'], ['employmentTypes', 'Employment types (Full time, Contract ...)'], ['workModes', 'Work modes'], ['locations', 'Locations (part of the name)'], ['clientIds', 'Client ids']];
export function ClauseLibrary() {
  const { data, err, reload } = useLoad('/ats-plus/offers/clauses');
  const { run, busy, flash } = useAction(reload);
  const empty = { title: '', text: '', conditions: { always: false, minCtc: '', maxCtc: '' }, fields: [], active: true };
  const [f, setF] = useState(empty); const [edit, setEdit] = useState(null);
  const setC = (k, v) => setF({ ...f, conditions: { ...f.conditions, [k]: v } });
  const save = () => run(() => (edit ? api.put(`/ats-plus/offers/clauses/${edit}`, f) : api.post('/ats-plus/offers/clauses', f)), 'Clause saved.').then((d) => { if (d) { setF(empty); setEdit(null); } });
  return (
    <Section title="Offer clause library" note="Clauses are added to an offer letter under Terms when their conditions fit (e.g. Relocation for IT jobs outside Hyderabad, a bond above a CTC). A clause can ask for fields - write {{field:key}} in its text.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <Table rows={data.rows} empty="No clauses yet."
        cols={[{ key: 'title', label: 'Clause' }, { key: 'status', label: 'On' }, { key: 'w', label: 'When', render: (r) => (r.conditions.always ? 'every offer' : COND.filter(([k]) => (r.conditions[k] || []).length).map(([k, l]) => `${l}: ${r.conditions[k].join(', ')}`).concat(r.conditions.minCtc != null ? [`CTC from ${r.conditions.minCtc}`] : []).concat(r.conditions.maxCtc != null ? [`CTC up to ${r.conditions.maxCtc}`] : []).join('; ') || '—') },
          { key: 'fields', label: 'Asks for', render: (r) => (r.fields || []).map((x) => x.label).join(', ') || '—' },
          { key: 'e', label: '', render: (r) => data.canEdit && <span style={row}><button type="button" className="btn btn-sm" onClick={() => { setEdit(r.id); setF({ title: r.title, text: r.text, active: r.status !== 'OFF', fields: r.fields || [], conditions: { ...r.conditions, minCtc: r.conditions.minCtc ?? '', maxCtc: r.conditions.maxCtc ?? '' } }); }}>Edit</button>
            {r.status !== 'OFF' && <button type="button" className="btn btn-sm" onClick={() => run(() => api.delete(`/ats-plus/offers/clauses/${r.id}`), 'Switched off.')}>Switch off</button>}</span> }]} />}
      {data && data.canEdit && (
        <div className="card" style={{ padding: 10, marginTop: 10 }}>
          <b>{edit ? 'Change the clause' : 'Add a clause'}</b>
          <Field label="Name"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Text" hint="{{name}} = the candidate; {{field:key}} = a field below."><textarea rows={3} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
          <div className="grid-2">
            {COND.map(([k, l]) => <Field key={k} label={l} hint="comma separated; empty = any"><input value={(f.conditions[k] || []).join(', ')} onChange={(e) => setC(k, e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>)}
            <Field label="CTC from (₹)"><input type="number" value={f.conditions.minCtc} onChange={(e) => setC('minCtc', e.target.value)} /></Field>
            <Field label="CTC up to (₹)"><input type="number" value={f.conditions.maxCtc} onChange={(e) => setC('maxCtc', e.target.value)} /></Field>
          </div>
          <label style={row}><input type="checkbox" checked={!!f.conditions.always} onChange={(e) => setC('always', e.target.checked)} /> On every offer (no condition)</label>
          <div style={{ marginTop: 6 }}><b style={{ fontSize: 13 }}>Fields this clause asks for</b>
            {f.fields.map((x, i) => <div key={i} style={row}><input aria-label="Field key" placeholder="key" value={x.key} onChange={(e) => setF({ ...f, fields: f.fields.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)) })} /><input aria-label="Field label" placeholder="Label" value={x.label} onChange={(e) => setF({ ...f, fields: f.fields.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} /><label><input type="checkbox" checked={!!x.required} onChange={(e) => setF({ ...f, fields: f.fields.map((y, j) => (j === i ? { ...y, required: e.target.checked } : y)) })} /> needed</label></div>)}
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, fields: [...f.fields, { key: '', label: '', required: true }] })}>+ Field</button>
          </div>
          <div style={{ ...row, marginTop: 8 }}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>Save clause</button>{edit && <button type="button" className="btn btn-sm" onClick={() => { setEdit(null); setF(empty); }}>Cancel</button>}</div>
        </div>
      )}
    </Section>
  );
}

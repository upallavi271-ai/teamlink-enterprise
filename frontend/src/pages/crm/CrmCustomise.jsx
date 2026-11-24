// ---------------------------------------------------------------------------
// CRM SETTINGS > CUSTOMISE THE CRM (wave C, 2026-11-24) - a Sales manager / Admin changes the CRM without code. Each part saves by itself:
//   Fields          custom fields on leads / accounts / contacts / deals (types, required, encrypted, section)
//   Layouts         the sections and order of each form; fields hidden from a Salesperson / Viewer; read-only for a Salesperson
//   Rules           validation rules that block bad data on save
//   Record types    record types of your own (Branches, Contracts ...) with their fields
//   Lead routing    who gets a new lead (rules by source, city, state, industry, product ...) - OFF until switched on
//   Lead capture    email, chat box, Facebook / LinkedIn / Google lead forms, IndiaMART, TradeIndia, JustDial - each OFF until switched on
//   Money & units   currencies and their rates, business units, the number format
//   Data & privacy  data retention (OFF until switched on), the DND list and check, what is encrypted
//   Year & brand    the financial year, holidays, the logo / colour on invoices and proposals
//   Test copy       download the whole set-up as a file and load it into another TeamLink (dry run first)
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, dateTimeOf, download } from './crmShared.jsx'; // eslint-disable-line import/no-cycle
import { refreshSetup } from './crmPlusC.jsx';

const KINDS = [['lead', 'Leads'], ['account', 'Accounts'], ['contact', 'Contacts'], ['deal', 'Deals']];
const Hint = ({ children }) => <p className="small-muted" style={{ marginTop: 0 }}>{children}</p>;
const Check = ({ checked, onChange, children }) => <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0', fontWeight: 500 }}><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 'auto' }} /> {children}</label>;
const line = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 };
function useLoad(url) {
  const [d, setD] = useState(null);
  const load = () => api.get(url).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This could not be read.') }));
  useEffect(() => { load(); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return [d, setD, load];
}

// ---- fields -----------------------------------------------------------------------------------------------------
function FieldsPart() {
  const { toast } = useCrm();
  const [kind, setKind] = useState('lead');
  const [d, , load] = useLoad(`/crm/plusc/fields?kind=${kind}&all=1`);
  const [setupD] = useLoad('/crm/plusc/setup');
  const empty = { label: '', type: 'text', options: '', required: false, sensitive: false, section: '', helpText: '' };
  const [f, setF] = useState(empty);
  async function save() {
    try { await api.post('/crm/plusc/fields', { ...f, kind, options: f.options }); toast(f.id ? 'Field saved.' : 'Field added.'); setF(empty); load(); refreshSetup(); } catch (e) { toast(errOf(e, 'The field could not be saved.')); }
  }
  async function off(x) { try { await api.delete(`/crm/plusc/fields/${x.id}`); toast('Field removed (its values stay on the records).'); load(); refreshSetup(); } catch (e) { toast(errOf(e, 'This could not be done.')); } }
  async function on(x) { try { await api.post('/crm/plusc/fields', { ...x, options: x.options, active: true }); load(); refreshSetup(); } catch (e) { toast(errOf(e, 'This could not be done.')); } }
  const types = (setupD && setupD.types) || [];
  return (
    <>
      <Hint>Add the details your company keeps that the CRM does not have. They show on the form and the record (More tab), in the downloads and in the filters of a mass update. A field marked <b>encrypted</b> is kept encrypted in the database and shown masked to anyone who cannot change the record (for PAN, bank or ID numbers).</Hint>
      <div className="tabs" role="tablist" style={{ marginBottom: 8 }}>{KINDS.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={kind === k} className={`tab${kind === k ? ' active' : ''}`} onClick={() => { setKind(k); setF(empty); }} onKeyDown={(e) => { if (e.key === 'Enter') setKind(k); }}>{l}</div>)}</div>
      {d && d.fields && d.fields.map((x) => (
        <div key={x.id} style={{ ...line, opacity: x.active ? 1 : 0.55 }}>
          <span style={{ flex: 1, minWidth: 0 }}><b>{x.label}</b> <span className="small-muted">· {x.typeWord}{x.required ? ' · required' : ''}{x.sensitive ? ' · encrypted 🔒' : ''}{x.section ? ` · ${x.section}` : ''}{x.options.length ? ` · ${x.options.join(', ')}` : ''}{!x.active ? ' · switched off' : ''}</span></span>
          {x.active ? <><button type="button" className="btn btn-sm" onClick={() => setF({ ...x, options: x.options.join('\n') })}>Edit</button><button type="button" className="btn btn-sm" onClick={() => off(x)}>Remove</button></> : <button type="button" className="btn btn-sm" onClick={() => on(x)}>Switch on</button>}
        </div>
      ))}
      {d && d.fields && !d.fields.length && <div className="small-muted">No custom fields on {kind}s yet.</div>}
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="field"><label>{f.id ? 'Field name' : 'New field name'}</label><input type="text" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Budget band, PAN, Employees" /></div>
        <div className="field"><label>Type</label><select value={f.type} disabled={!!f.id && f.sensitive} onChange={(e) => setF({ ...f, type: e.target.value })}>{types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
        {['select', 'multi'].includes(f.type) && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Choices (one a line)</label><textarea rows={3} value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /></div>}
        <div className="field"><label>Section on the form</label><input type="text" value={f.section || ''} onChange={(e) => setF({ ...f, section: e.target.value })} placeholder="More details" /></div>
        <div className="field"><label>Help line</label><input type="text" value={f.helpText || ''} onChange={(e) => setF({ ...f, helpText: e.target.value })} /></div>
      </div>
      <Check checked={f.required} onChange={(v) => setF({ ...f, required: v })}>Required (a new record cannot be saved without it)</Check>
      {!f.id && <Check checked={f.sensitive} onChange={(v) => setF({ ...f, sensitive: v })}>Encrypted - sensitive data (text, email, phone or link fields)</Check>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={!f.label.trim()} onClick={save}>{f.id ? 'Save field' : '+ Add field'}</button>
        {f.id && <button type="button" className="btn btn-sm" onClick={() => setF(empty)}>Cancel</button>}
      </div>
    </>
  );
}

// ---- layouts ----------------------------------------------------------------------------------------------------
function LayoutsPart() {
  const { toast } = useCrm();
  const [kind, setKind] = useState('lead');
  const [s, , reload] = useLoad('/crm/plusc/setup');
  const [lay, setLay] = useState(null);
  useEffect(() => {
    if (!s || !s.builtIn) return;
    const L = (s.layouts || {})[kind];
    const all = [...Object.keys(s.builtIn[kind] || {}), ...(s.fields || []).filter((f) => f.kind === kind).map((f) => f.key)];
    setLay(L ? { sections: L.sections.map((x) => ({ ...x, fields: [...x.fields] })), hidden: { rep: [...(L.hidden.rep || [])], viewer: [...(L.hidden.viewer || [])] }, readOnly: { rep: [...(L.readOnly.rep || [])] } } : { sections: [{ name: 'Details', fields: all }], hidden: { rep: [], viewer: [] }, readOnly: { rep: [] } });
  }, [s, kind]);
  if (!s || !lay) return <div className="small-muted">Loading…</div>;
  const word = (k) => (s.builtIn[kind] || {})[k] || ((s.fields || []).find((f) => f.kind === kind && f.key === k) || {}).label || k;
  const allKeys = [...Object.keys(s.builtIn[kind] || {}), ...(s.fields || []).filter((f) => f.kind === kind).map((f) => f.key)];
  const placed = new Set(lay.sections.flatMap((x) => x.fields));
  const missing = allKeys.filter((k) => !placed.has(k));
  const setSec = (i, patch) => setLay({ ...lay, sections: lay.sections.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i, k, dir) => { const list = [...lay.sections[i].fields]; const at = list.indexOf(k); const to = at + dir; if (to < 0 || to >= list.length) return; [list[at], list[to]] = [list[to], list[at]]; setSec(i, { fields: list }); };
  const toSection = (from, k, to) => { const secs = lay.sections.map((x) => ({ ...x, fields: x.fields.filter((y) => y !== k) })); secs[to].fields.push(k); setLay({ ...lay, sections: from == null ? secs : secs }); };
  const toggle = (bucket, role, k) => { const list = new Set(lay[bucket][role]); if (list.has(k)) list.delete(k); else list.add(k); setLay({ ...lay, [bucket]: { ...lay[bucket], [role]: [...list] } }); };
  async function save(reset) {
    try { await api.put(`/crm/plusc/layouts/${kind}`, reset ? { reset: true } : lay); toast(reset ? 'Back to the standard form.' : 'Layout saved.'); reload(); refreshSetup(); } catch (e) { toast(errOf(e, 'The layout could not be saved.')); }
  }
  return (
    <>
      <Hint>Arrange each form in sections, hide fields a Salesperson or a Viewer does not need, and make fields read-only for Salespeople (the server refuses their change, not only the screen). A required field is never hidden.</Hint>
      <div className="tabs" role="tablist" style={{ marginBottom: 8 }}>{KINDS.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={kind === k} className={`tab${kind === k ? ' active' : ''}`} onClick={() => setKind(k)} onKeyDown={(e) => { if (e.key === 'Enter') setKind(k); }}>{l}</div>)}</div>
      {lay.sections.map((sec, i) => (
        <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input type="text" value={sec.name} onChange={(e) => setSec(i, { name: e.target.value })} aria-label="Section name" style={{ maxWidth: 240 }} />
            {lay.sections.length > 1 && <button type="button" className="btn btn-sm" onClick={() => { const rest = lay.sections.filter((_, j) => j !== i); rest[0].fields.push(...sec.fields); setLay({ ...lay, sections: rest }); }}>Remove section</button>}
          </div>
          {sec.fields.map((k) => (
            <div key={k} style={{ ...line, padding: '3px 0' }}>
              <span style={{ flex: 1, minWidth: 120 }}>{word(k)}</span>
              <button type="button" className="btn btn-sm" onClick={() => move(i, k, -1)} aria-label={`Move ${word(k)} up`}>↑</button>
              <button type="button" className="btn btn-sm" onClick={() => move(i, k, 1)} aria-label={`Move ${word(k)} down`}>↓</button>
              {lay.sections.length > 1 && <select value={i} onChange={(e) => toSection(i, k, Number(e.target.value))} aria-label="Section" style={{ width: 'auto', padding: '1px 4px', fontSize: 12 }}>{lay.sections.map((x, j) => <option key={j} value={j}>{x.name || `Section ${j + 1}`}</option>)}</select>}
              <label style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontWeight: 500, margin: 0, fontSize: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={lay.hidden.rep.includes(k)} onChange={() => toggle('hidden', 'rep', k)} /> hide for salespeople</label>
              <label style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontWeight: 500, margin: 0, fontSize: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={lay.hidden.viewer.includes(k)} onChange={() => toggle('hidden', 'viewer', k)} /> hide for viewers</label>
              <label style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontWeight: 500, margin: 0, fontSize: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={lay.readOnly.rep.includes(k)} onChange={() => toggle('readOnly', 'rep', k)} /> read-only for salespeople</label>
            </div>
          ))}
        </div>
      ))}
      {missing.length > 0 && <div className="small-muted" style={{ marginBottom: 6 }}>Not placed yet (shown at the end): {missing.map(word).join(', ')} <button type="button" className="crm-linkbtn" onClick={() => { const secs = [...lay.sections]; secs[0] = { ...secs[0], fields: [...secs[0].fields, ...missing] }; setLay({ ...lay, sections: secs }); }}>place them</button></div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => setLay({ ...lay, sections: [...lay.sections, { name: 'New section', fields: [] }] })}>+ Section</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => save(false)}>Save layout</button>
        <button type="button" className="btn btn-sm" onClick={() => save(true)}>Back to the standard form</button>
      </div>
    </>
  );
}

// ---- validation rules ---------------------------------------------------------------------------------------------
function RulesPart() {
  const { toast } = useCrm();
  const [s] = useLoad('/crm/plusc/setup');
  const [d, , load] = useLoad('/crm/plusc/rules');
  const empty = { kind: 'lead', field: '', op: 'required', value: '', message: '', whenField: '', whenValue: '' };
  const [f, setF] = useState(empty);
  if (!s || !d) return <div className="small-muted">Loading…</div>;
  const fieldsOf = (k) => [...Object.entries(s.builtIn[k] || {}).map(([key, label]) => ({ key, label })), ...(s.fields || []).filter((x) => x.kind === k).map((x) => ({ key: x.key, label: x.label }))];
  const word = (k, key) => (fieldsOf(k).find((x) => x.key === key) || {}).label || key;
  async function save() { try { await api.post('/crm/plusc/rules', f); toast('Rule saved.'); setF(empty); load(); } catch (e) { toast(errOf(e, 'The rule could not be saved.')); } }
  async function remove(x) { try { await api.delete(`/crm/plusc/rules/${x.id}`); load(); } catch (e) { toast(errOf(e, 'This could not be done.')); } }
  const needsValue = !['required'].includes(f.op);
  return (
    <>
      <Hint>A rule stops a save that breaks it, with your message - on the screens, the imports and the API. Example: on Leads, City must be filled only when Source is Referral; on Accounts, GSTIN must match a pattern.</Hint>
      {(d.rules || []).map((x) => (
        <div key={x.id} style={line}>
          <span style={{ flex: 1 }}><b>{KINDS.find(([k]) => k === x.kind)[1]}:</b> {word(x.kind, x.field)} {x.opWord}{x.op !== 'required' ? ` ${x.value}` : ''}{x.whenField ? <span className="small-muted"> - only when {word(x.kind, x.whenField)} is {x.whenValue}</span> : null}{x.message ? <span className="small-muted"> · “{x.message}”</span> : null}</span>
          <button type="button" className="btn btn-sm" onClick={() => remove(x)}>Remove</button>
        </div>
      ))}
      {!(d.rules || []).length && <div className="small-muted">No rules yet.</div>}
      <div className="grid-3" style={{ marginTop: 10 }}>
        <div className="field"><label>Records</label><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, field: '', whenField: '' })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label>Field</label><select value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option value="">— pick —</option>{fieldsOf(f.kind).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
        <div className="field"><label>Check</label><select value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}>{s.ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {needsValue && <div className="field"><label>{f.op === 'pattern' ? 'Pattern (regular expression)' : ['oneOf', 'notOneOf'].includes(f.op) ? 'Values (comma-separated)' : 'Number'}</label><input type="text" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></div>}
        <div className="field"><label>Only when (optional)</label><select value={f.whenField} onChange={(e) => setF({ ...f, whenField: e.target.value })}><option value="">— always —</option>{fieldsOf(f.kind).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
        {f.whenField && <div className="field"><label>…is</label><input type="text" value={f.whenValue} onChange={(e) => setF({ ...f, whenValue: e.target.value })} /></div>}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Message shown</label><input type="text" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="e.g. A referral lead needs its city." /></div>
      </div>
      <button type="button" className="btn btn-primary btn-sm" disabled={!f.field} onClick={save}>+ Add rule</button>
    </>
  );
}

// ---- record types of your own ---------------------------------------------------------------------------------------------
function ObjectsPart() {
  const { toast } = useCrm();
  const [d, , load] = useLoad('/crm/plusc/objects?all=1');
  const [s] = useLoad('/crm/plusc/setup');
  const empty = { name: '', plural: '', linkTo: 'account', fields: [{ label: '', type: 'text', options: '', required: false }] };
  const [f, setF] = useState(null);
  async function save() { try { await api.post('/crm/plusc/objects', f); toast('Record type saved.'); setF(null); load(); refreshSetup(); } catch (e) { toast(errOf(e, 'This could not be saved.')); } }
  const setField = (i, patch) => setF({ ...f, fields: f.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      <Hint>A kind of record the CRM does not have - Branches, Contracts, Assets, Site visits ... - with its own fields. Its records are kept in Accounts &amp; Contacts &gt; More records and on the record it is linked to.</Hint>
      {d && (d.objects || []).map((o) => <div key={o.id} style={line}><span style={{ flex: 1 }}><b>{o.plural}</b> <span className="small-muted">· linked to {o.linkTo || 'nothing'} · {o.fields.map((x) => x.label).join(', ')}{!o.active ? ' · switched off' : ''}</span></span><button type="button" className="btn btn-sm" onClick={() => setF({ ...o, fields: o.fields.map((x) => ({ ...x, options: (x.options || []).join('\n') })) })}>Edit</button></div>)}
      {!f && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setF(empty)}>+ Record type</button>}
      {f && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <div className="grid-3">
            <div className="field"><label>Name (one)</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Branch" /></div>
            <div className="field"><label>Name (many)</label><input type="text" value={f.plural || ''} onChange={(e) => setF({ ...f, plural: e.target.value })} placeholder="Branches" /></div>
            <div className="field"><label>Linked to</label><select value={f.linkTo} onChange={(e) => setF({ ...f, linkTo: e.target.value })}><option value="account">Accounts</option><option value="lead">Leads</option><option value="deal">Deals</option><option value="contact">Contacts</option><option value="">Nothing</option></select></div>
          </div>
          {f.fields.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
              <input type="text" value={x.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Field name" aria-label="Field name" style={{ maxWidth: 200 }} />
              <select value={x.type} onChange={(e) => setField(i, { type: e.target.value })} aria-label="Type" style={{ width: 'auto' }}>{((s && s.types) || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
              {['select', 'multi'].includes(x.type) && <input type="text" value={x.options} onChange={(e) => setField(i, { options: e.target.value })} placeholder="Choices, comma-separated" aria-label="Choices" style={{ maxWidth: 220 }} />}
              <label style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontWeight: 500, margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!x.required} onChange={(e) => setField(i, { required: e.target.checked })} /> required</label>
              <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, fields: f.fields.filter((_, j) => j !== i) })} aria-label="Remove field">×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, fields: [...f.fields, { label: '', type: 'text', options: '', required: false }] })}>+ Field</button>
            {f.id && <Check checked={f.active !== false} onChange={(v) => setF({ ...f, active: v })}>In use</Check>}
            <button type="button" className="btn btn-primary btn-sm" disabled={!f.name.trim()} onClick={save}>Save record type</button>
            <button type="button" className="btn btn-sm" onClick={() => setF(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

// ---- lead routing -----------------------------------------------------------------------------------------------------------
function RoutingPart() {
  const { toast } = useCrm();
  const [d, setD] = useLoad('/crm/plusc/assign-rules');
  const empty = { name: '', match: [{ field: 'source', op: 'is', value: '' }], ownerIds: [] };
  const [f, setF] = useState(null);
  const [test, setTest] = useState({ source: '', city: '', state: '', industry: '' });
  const [testOut, setTestOut] = useState(undefined);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const run = async (fn) => { try { const r = await fn(); setD(r.data); return true; } catch (e) { toast(errOf(e, 'This could not be saved.')); return false; } };
  const setM = (i, patch) => setF({ ...f, match: f.match.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      <Hint>Who gets a new lead. The first rule (top to bottom) whose lines all match gives the lead, in turn among its people; no match keeps today&apos;s way (the round robin if it is on, else nobody until a Sales manager gives it). Used for the website form, every captured lead and a &quot;+ Lead&quot; saved with the owner empty.</Hint>
      <Check checked={d.on} onChange={(v) => run(() => api.put('/crm/plusc/assign-rules/switch', { on: v }))}><b>Use these rules for new leads</b> (off until you switch it on)</Check>
      {d.rules.map((x, i) => (
        <div key={x.id} style={{ ...line, opacity: x.active ? 1 : 0.55 }}>
          <span style={{ flex: 1 }}><b>{i + 1}. {x.name}</b> <span className="small-muted">· when {x.match.map((m) => `${d.fields[m.field] || m.field} ${d.ops[m.op]} ${m.value}`).join(' and ')} → {x.ownerIds.map((id) => (d.people.find((p) => p.id === id) || { name: '(left the team)' }).name).join(', ')} · {x.hits} so far</span></span>
          <button type="button" className="btn btn-sm" onClick={() => setF({ ...x })}>Edit</button>
          <button type="button" className="btn btn-sm" onClick={() => run(() => api.delete(`/crm/plusc/assign-rules/${x.id}`))}>Remove</button>
        </div>
      ))}
      {!f && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setF(empty)}>+ Rule</button>}
      {f && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <div className="field"><label>Rule name</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Portal leads to the inside-sales team" /></div>
          {f.match.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
              <span className="small-muted" style={{ alignSelf: 'center' }}>{i ? 'and' : 'When'}</span>
              <select value={m.field} onChange={(e) => setM(i, { field: e.target.value })} aria-label="Field" style={{ width: 'auto' }}>{Object.entries(d.fields).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select value={m.op} onChange={(e) => setM(i, { op: e.target.value })} aria-label="Check" style={{ width: 'auto' }}>{Object.entries(d.ops).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input type="text" value={m.value} onChange={(e) => setM(i, { value: e.target.value })} placeholder="value (several: comma-separated)" aria-label="Value" style={{ maxWidth: 240 }} />
              {f.match.length > 1 && <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, match: f.match.filter((_, j) => j !== i) })} aria-label="Remove line">×</button>}
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, match: [...f.match, { field: 'city', op: 'is', value: '' }] })}>+ and …</button>
          <div className="small-muted" style={{ margin: '8px 0 4px' }}>Give the lead to (in turn):</div>
          <div style={{ display: 'flex', gap: '4px 12px', flexWrap: 'wrap' }}>{d.people.map((p) => <label key={p.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontWeight: 500, margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.ownerIds.includes(p.id)} onChange={(e) => setF({ ...f, ownerIds: e.target.checked ? [...f.ownerIds, p.id] : f.ownerIds.filter((x) => x !== p.id) })} /> {p.name}</label>)}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={async () => { if (await run(() => api.post('/crm/plusc/assign-rules', f))) { setF(null); toast('Rule saved.'); } }}>Save rule</button>
            <button type="button" className="btn btn-sm" onClick={() => setF(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="section-label">Try it</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {['source', 'city', 'state', 'industry'].map((k) => <input key={k} type="text" value={test[k]} onChange={(e) => setTest({ ...test, [k]: e.target.value })} placeholder={d.fields[k]} aria-label={d.fields[k]} style={{ maxWidth: 140 }} />)}
        <button type="button" className="btn btn-sm" onClick={() => api.post('/crm/plusc/assign-rules/test', test).then((r) => setTestOut(r.data.owner)).catch((e) => toast(errOf(e, 'This could not be tried.')))}>Who would get it?</button>
        {testOut !== undefined && <span style={{ alignSelf: 'center', fontSize: 13 }}>{testOut ? <>→ <b>{testOut.name}</b> (rule “{testOut.rule}”)</> : 'No rule matches.'}</span>}
      </div>
    </>
  );
}

// ---- lead capture ----------------------------------------------------------------------------------------------------------------
function CapturePart() {
  const { toast } = useCrm();
  const [d, setD] = useLoad('/crm/plusc/capture');
  const [sn, setSn] = useState(null);
  useEffect(() => { api.get('/crm/plusc/capture/snippet').then((r) => setSn(r.data)).catch(() => setSn(null)); }, [d && d.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const save = async (patch) => { try { const r = await api.put('/crm/plusc/capture', patch); setD(r.data); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } };
  const copy = (t) => { try { navigator.clipboard.writeText(t); toast('Copied.'); } catch { toast('Select the text and copy it.'); } };
  const NEEDS = { facebook: !d.ready.facebook && 'needs the Meta keys (Administration > Integrations > CRM lead ads)', indiamart: !d.ready.indiamart && 'needs the IndiaMART CRM key (Administration > Integrations > CRM India portals)', tradeindia: !d.ready.tradeindia && 'needs the TradeIndia keys (Administration > Integrations > CRM India portals)' };
  const pushSources = ['email', 'chat', 'facebook', 'linkedin', 'google', 'justdial', 'webhook'];
  return (
    <>
      <Hint>Leads that come in by themselves land in Leads with their source, go through the lead rules, and the same phone or email again becomes a note on the lead already there. Every source is off until you tick it.</Hint>
      {pushSources.map((k) => (
        <div key={k} style={line}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 600, margin: 0, flex: 1, minWidth: 200 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!d.on[k]} onChange={(e) => save({ on: { [k]: e.target.checked } })} /> {d.words[k]}</label>
          <span className="small-muted" style={{ fontSize: 12 }}>{d.counts[k] ? `${d.counts[k]} in 30 days` : ''}{NEEDS[k] ? ` ${NEEDS[k]}` : ''}</span>
          {sn && (k === 'facebook' ? <button type="button" className="btn btn-sm" onClick={() => copy(sn.facebook)}>Copy callback URL</button> : <button type="button" className="btn btn-sm" onClick={() => copy(sn.urls[k])} title={sn.urls[k]}>Copy address</button>)}
        </div>
      ))}
      {['indiamart', 'tradeindia'].map((k) => (
        <div key={k} style={line}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 600, margin: 0, flex: 1, minWidth: 200 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!d.pull[k]} onChange={(e) => save({ pull: { [k]: e.target.checked } })} /> {d.words[k]} - read every {d.pullMinutes} minutes</label>
          <span className="small-muted" style={{ fontSize: 12 }}>{d.lastPull[k] ? `last read ${dateTimeOf(d.lastPull[k])}` : ''}{NEEDS[k] ? ` ${NEEDS[k]}` : ''}</span>
          <button type="button" className="btn btn-sm" onClick={() => api.post(`/crm/plusc/capture/pull/${k}`).then((r) => { toast(`${r.data.fetched} read, ${r.data.added} new lead${r.data.added === 1 ? '' : 's'}.`); }).catch((e) => toast(errOf(e, 'This could not be read.')))}>Read now</button>
        </div>
      ))}
      <div className="field" style={{ maxWidth: 240, marginTop: 8 }}><label>Read the portals every</label><select value={d.pullMinutes} onChange={(e) => save({ pullMinutes: Number(e.target.value) })}>{[5, 15, 30, 60, 180].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></div>
      <div className="section-label">The key</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{d.key}</code>
        <button type="button" className="btn btn-sm" onClick={() => { if (window.confirm('Make a new key? Every address given out with the old one stops working.')) api.post('/crm/plusc/capture/key').then((r) => { setD(r.data); toast('A new key is ready.'); }).catch((e) => toast(errOf(e, 'This could not be changed.'))); }}>New key</button> {/* eslint-disable-line no-alert */}
      </div>
      {sn && (<>
        <div className="section-label">Chat box for your website</div>
        <Hint>Paste this at the end of your website&apos;s pages. A visitor&apos;s message comes in as a lead with source Chat (tick &quot;Website chat box&quot; above).</Hint>
        <textarea readOnly rows={5} value={sn.snippet} style={{ fontFamily: 'monospace', fontSize: 11.5 }} aria-label="Chat box code" />
        <button type="button" className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => copy(sn.snippet)}>Copy the code</button>
      </>)}
      <div className="section-label">Recent</div>
      {!d.recent.length && <div className="small-muted">Nothing came in yet.</div>}
      {d.recent.slice(0, 12).map((x) => <div key={x.id} style={{ ...line, padding: '3px 0', fontSize: 12 }}><span className="small-muted" style={{ minWidth: 110 }}>{dateTimeOf(x.at)}</span><b>{d.words[x.source] || x.source}</b><span>{x.status}</span><span className="small-muted" style={{ overflowWrap: 'anywhere' }}>{x.detail}</span></div>)}
    </>
  );
}

// ---- money & units ------------------------------------------------------------------------------------------------------------------
function MoneyPart() {
  const { toast } = useCrm();
  const [d, setD] = useLoad('/crm/plusc/prefs');
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const save = async (patch) => { try { const r = await api.put('/crm/plusc/prefs', patch); setD(r.data); refreshSetup(); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } };
  const setCur = (i, patch) => setD({ ...d, currencies: d.currencies.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setUnit = (i, patch) => setD({ ...d, units: d.units.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <div className="section-label" style={{ marginTop: 0 }}>Currencies</div>
      <Hint>A deal can be priced in one of these. The rate (₹ for 1 unit) of the day is kept with the deal, so reports, targets and the invoice stay in rupees; changing a rate here does not move a deal already priced.</Hint>
      {d.currencies.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
          <input type="text" value={c.code} onChange={(e) => setCur(i, { code: e.target.value.toUpperCase().slice(0, 3) })} aria-label="Code" style={{ width: 70 }} />
          <input type="text" value={c.symbol} onChange={(e) => setCur(i, { symbol: e.target.value })} aria-label="Symbol" style={{ width: 70 }} />
          <span style={{ alignSelf: 'center' }}>= ₹</span><input type="number" min={0} step="0.01" value={c.rate} onChange={(e) => setCur(i, { rate: e.target.value })} aria-label={`Rate of ${c.code}`} style={{ width: 110 }} />
          <button type="button" className="btn btn-sm" onClick={() => setD({ ...d, currencies: d.currencies.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-sm" onClick={() => setD({ ...d, currencies: [...d.currencies, { code: '', symbol: '', rate: '' }] })}>+ Currency</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => save({ currencies: d.currencies })}>Save currencies</button>
      </div>
      <div className="section-label">Business units</div>
      <Hint>Several companies or divisions in one CRM. A lead, account or deal belongs to one unit (filter every list by it); a deal&apos;s invoice is raised from its unit&apos;s name, GSTIN and address.</Hint>
      <Check checked={d.unitsOn} onChange={(v) => save({ unitsOn: v })}>Use business units</Check>
      {d.units.map((u, i) => (
        <div key={u.id || i} className="card" style={{ padding: 8, marginBottom: 6 }}>
          <div className="grid-3">
            <div className="field"><label>Name</label><input type="text" value={u.name} onChange={(e) => setUnit(i, { name: e.target.value })} /></div>
            <div className="field"><label>GSTIN</label><input type="text" value={u.gstin || ''} onChange={(e) => setUnit(i, { gstin: e.target.value })} /></div>
            <div className="field"><label>State</label><input type="text" value={u.state || ''} onChange={(e) => setUnit(i, { state: e.target.value })} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Address</label><input type="text" value={u.address || ''} onChange={(e) => setUnit(i, { address: e.target.value })} /></div>
            <div className="field"><label>Email</label><input type="text" value={u.email || ''} onChange={(e) => setUnit(i, { email: e.target.value })} /></div>
            <div className="field"><label>Phone</label><input type="text" value={u.phone || ''} onChange={(e) => setUnit(i, { phone: e.target.value })} /></div>
            <div className="field"><label>Bank details</label><input type="text" value={u.bank || ''} onChange={(e) => setUnit(i, { bank: e.target.value })} /></div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setD({ ...d, units: d.units.filter((_, j) => j !== i) })}>Remove unit</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-sm" onClick={() => setD({ ...d, units: [...d.units, { name: '' }] })}>+ Unit</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => save({ units: d.units })}>Save units</button>
      </div>
      <div className="section-label">Number format</div>
      <div className="field" style={{ maxWidth: 300 }}><select value={d.locale.numbers} onChange={(e) => save({ locale: { numbers: e.target.value } })} aria-label="Number format"><option value="en-IN">Indian: ₹12,34,567</option><option value="en-US">International: ₹1,234,567</option></select></div>
      <div className="small-muted">The CRM&apos;s screen words follow the app&apos;s language (English / తెలుగు / हिन्दी, top bar).</div>
    </>
  );
}

// ---- data & privacy ------------------------------------------------------------------------------------------------------------
function PrivacyPart() {
  const { toast } = useCrm();
  const [r, setR] = useLoad('/crm/plusc/retention');
  const [dnd, setDnd] = useLoad('/crm/plusc/dnd');
  const [sum] = useLoad('/crm/plusc/privacy');
  const file = useRef(null);
  const [form, setForm] = useState(null);
  useEffect(() => { if (r && r.retention) setForm({ ...r.retention }); }, [r]);
  async function saveR(patch) { try { const x = await api.put('/crm/plusc/retention', { ...form, ...patch }); setR(x.data); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } }
  async function runNow() { if (!window.confirm('Run data retention now? Records it removes for good cannot be brought back.')) return; try { const x = await api.post('/crm/plusc/retention/run'); toast(`${x.data.result.leadsToBin} leads to the recycle bin, ${x.data.result.purged} removed for good.`); setR(null); api.get('/crm/plusc/retention').then((y) => setR(y.data)); } catch (e) { toast(errOf(e, 'This could not be run.')); } } // eslint-disable-line no-alert
  async function upload(f) {
    if (!f) return;
    try { const x = await api.post(`/crm/plusc/dnd/upload?replace=${window.confirm('Replace the DND numbers uploaded before? (Cancel = add to them)') ? 1 : 0}`, f, { headers: { 'Content-Type': 'application/octet-stream' } }); setDnd(x.data); toast(`${x.data.added} numbers on the DND list.`); } catch (e) { toast(errOf(e, 'The file could not be read.')); } finally { if (file.current) file.current.value = ''; } // eslint-disable-line no-alert
  }
  return (
    <>
      <div className="section-label" style={{ marginTop: 0 }}>Data retention</div>
      {r && r.error && <div className="notice">{r.error}</div>}
      {form && r && r.preview && (
        <>
          <Hint>Old data goes by itself once a day (02:00). Leads go to the recycle bin first; the bin is emptied after its days. 0 = never.</Hint>
          <Check checked={form.on} onChange={(v) => saveR({ on: v })}><b>Data retention is on</b></Check>
          <div className="grid-2">
            <div className="field"><label>Empty the recycle bin after (days)</label><input type="number" min={1} value={form.binDays} onChange={(e) => setForm({ ...form, binDays: e.target.value })} /></div>
            <div className="field"><label>Junk leads to the bin after (days)</label><input type="number" min={0} value={form.junkLeadDays} onChange={(e) => setForm({ ...form, junkLeadDays: e.target.value })} /></div>
            <div className="field"><label>Lost leads to the bin after (days)</label><input type="number" min={0} value={form.lostLeadDays} onChange={(e) => setForm({ ...form, lostLeadDays: e.target.value })} /></div>
            <div className="field"><label>Wipe activity notes older than (days)</label><input type="number" min={0} value={form.activityDays} onChange={(e) => setForm({ ...form, activityDays: e.target.value })} /></div>
          </div>
          <div className="small-muted" style={{ marginBottom: 6 }}>With these numbers it would now move {r.preview.junk} Junk and {r.preview.lost} Lost leads to the bin, remove {r.preview.bin} bin items for good and wipe {r.preview.activities} old notes.{r.retention.lastRunAt ? ` Last run ${dateTimeOf(r.retention.lastRunAt)}.` : ''}</div>
          <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary btn-sm" onClick={() => saveR({})}>Save</button><button type="button" className="btn btn-sm" disabled={!form.on} onClick={runNow}>Run now</button></div>
        </>
      )}
      <div className="section-label">Do-Not-Disturb (TRAI NCPR)</div>
      {dnd && !dnd.error && (
        <>
          <Hint>A sales call from the CRM to a number on the DND list is stopped. Upload the DND numbers you get from the NCPR or your telephony provider (Excel, CSV or text); with the provider&apos;s DND check connected (Administration &gt; Integrations &gt; CRM DND check) every new number is asked too.</Hint>
          <Check checked={dnd.dnd.blockCalls} onChange={(v) => api.put('/crm/plusc/dnd', { blockCalls: v }).then((x) => setDnd(x.data))}>Stop CRM calls to DND numbers</Check>
          <Check checked={dnd.dnd.providerOn} onChange={(v) => api.put('/crm/plusc/dnd', { providerOn: v }).then((x) => setDnd(x.data))}>Ask the provider&apos;s DND check {dnd.providerReady ? '(connected)' : '(not connected yet)'}</Check>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="small-muted">{dnd.listed} numbers on the list.</span><button type="button" className="btn btn-sm" onClick={() => file.current && file.current.click()}>Upload DND file</button><input ref={file} type="file" accept=".csv,.xlsx,.xls,.txt" style={{ display: 'none' }} onChange={(e) => upload(e.target.files && e.target.files[0])} aria-label="DND file" /></div>
        </>
      )}
      <div className="section-label">What is protected</div>
      {sum && !sum.error && <div className="small-muted">{sum.encryptedFields} encrypted field{sum.encryptedFields === 1 ? '' : 's'} {sum.keyConfigured ? '(the server key is set)' : '- the server key INTEGRATION_SECRET_KEY is not set, so no field can be encrypted yet'} · {sum.consentRecords} consent records · {sum.optOuts} opted out · {sum.openRequests} open data requests · {sum.inBin} in the recycle bin. Secrets and backups are encrypted as before.</div>}
    </>
  );
}

// ---- year & branding ------------------------------------------------------------------------------------------------------------
function YearPart() {
  const { toast } = useCrm();
  const [d, setD] = useLoad('/crm/plusc/prefs');
  const [h, setH] = useState({ date: '', name: '' });
  const logo = useRef(null);
  const [logoUrl, setLogoUrl] = useState('');
  useEffect(() => { if (d && d.branding && d.branding.logo) api.get('/crm/plusc/prefs/logo', { responseType: 'blob' }).then((r) => setLogoUrl(URL.createObjectURL(r.data))).catch(() => setLogoUrl('')); else setLogoUrl(''); }, [d && d.branding && d.branding.logo && d.branding.logo.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const save = async (patch) => { try { const r = await api.put('/crm/plusc/prefs', patch); setD(r.data); refreshSetup(); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); } };
  async function upload(f) {
    if (!f) return;
    const fd = new FormData(); fd.append('file', f, f.name);
    try { const r = await api.post('/crm/plusc/prefs/logo', fd); setD(r.data); toast('Logo saved.'); } catch (e) { toast(errOf(e, 'The logo could not be saved.')); } finally { if (logo.current) logo.current.value = ''; }
  }
  return (
    <>
      <div className="section-label" style={{ marginTop: 0 }}>Financial year</div>
      <div className="field" style={{ maxWidth: 280 }}><label>The year starts in</label><select value={d.fiscal.startMonth} onChange={(e) => save({ fiscal: { startMonth: Number(e.target.value) } })}>{d.months.map((m, i) => <option key={m} value={i + 1}>{m}{i === 3 ? ' (India: April to March)' : ''}</option>)}</select></div>
      <div className="small-muted">The dashboard and reports then offer &quot;This financial quarter&quot; and &quot;This financial year&quot;.</div>
      <div className="section-label">Holidays</div>
      {d.fiscal.holidays.map((x) => <div key={x.date} style={line}><span style={{ minWidth: 100 }}>{x.date}</span><span style={{ flex: 1 }}>{x.name}</span><button type="button" className="btn btn-sm" onClick={() => save({ fiscal: { holidays: d.fiscal.holidays.filter((y) => y.date !== x.date) } })}>Remove</button></div>)}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} aria-label="Holiday date" style={{ width: 'auto' }} />
        <input type="text" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} placeholder="e.g. Diwali" aria-label="Holiday name" style={{ maxWidth: 200 }} />
        <button type="button" className="btn btn-sm" disabled={!h.date} onClick={() => { save({ fiscal: { holidays: [...d.fiscal.holidays, h] } }); setH({ date: '', name: '' }); }}>+ Holiday</button>
      </div>
      <div className="small-muted">Holidays show on Follow-ups &gt; Calendar.</div>
      <div className="section-label">Branding on invoices and proposals</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {logoUrl ? <img src={logoUrl} alt="Company logo" style={{ height: 36, border: '1px solid var(--line-soft)', padding: 2, background: '#fff' }} /> : <span className="small-muted">TeamLink&apos;s logo is used.</span>}
        <button type="button" className="btn btn-sm" onClick={() => logo.current && logo.current.click()}>Upload logo (PNG / JPEG, 1 MB)</button>
        <input ref={logo} type="file" accept=".png,.jpg,.jpeg" style={{ display: 'none' }} onChange={(e) => upload(e.target.files && e.target.files[0])} aria-label="Logo file" />
        {d.branding.logo && <button type="button" className="btn btn-sm" onClick={() => save({ branding: { removeLogo: true } })}>Remove</button>}
      </div>
      <div className="grid-2" style={{ marginTop: 8 }}>
        <div className="field"><label>Colour of the headings</label><input type="color" value={d.branding.color} onChange={(e) => setD({ ...d, branding: { ...d.branding, color: e.target.value } })} style={{ height: 34 }} /></div>
        <div className="field"><label>Line under the company name</label><input type="text" value={d.branding.tagline || ''} onChange={(e) => setD({ ...d, branding: { ...d.branding, tagline: e.target.value } })} /></div>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => save({ branding: { color: d.branding.color, tagline: d.branding.tagline } })}>Save branding</button>
    </>
  );
}

// ---- test copy ------------------------------------------------------------------------------------------------------------------
function PackagePart() {
  const { toast } = useCrm();
  const file = useRef(null);
  const [pkg, setPkg] = useState(null);
  const [plan, setPlan] = useState(null);
  async function pick(f) {
    if (!f) return;
    const text = await f.text();
    setPkg(text);
    try { const r = await api.post('/crm/plusc/package', text, { headers: { 'Content-Type': 'application/octet-stream' } }); setPlan(r.data); } catch (e) { toast(errOf(e, 'This file could not be read.')); setPkg(null); } finally { if (file.current) file.current.value = ''; }
  }
  async function apply() {
    try { const r = await api.post('/crm/plusc/package?apply=1', pkg, { headers: { 'Content-Type': 'application/octet-stream' } }); toast('Loaded.'); setPlan(r.data); setPkg(null); refreshSetup(); } catch (e) { toast(errOf(e, 'This could not be loaded.')); }
  }
  const P = plan && plan.plan;
  return (
    <>
      <Hint>Try a change on a test copy of TeamLink first: download this CRM&apos;s whole set-up (settings, fields, rules, layouts, record types, lead rules - no data, no keys, no team), load it into the test copy, change it there, then load the result back here. A file is always checked first and says what would change. (A separate test server itself is set up by the founder.)</Hint>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => download('/crm/plusc/package', `crm-configuration.json`).catch(() => toast('The download did not work.'))}>Download the set-up</button>
        <button type="button" className="btn btn-sm" onClick={() => file.current && file.current.click()}>Load a set-up file…</button>
        <input ref={file} type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => pick(e.target.files && e.target.files[0])} aria-label="Set-up file" />
      </div>
      {P && (
        <div className="card" style={{ padding: 10, marginTop: 8, fontSize: 13 }}>
          <div>{plan.dryRun ? 'This file would change:' : 'Loaded:'}</div>
          <div className="small-muted">Settings: {P.settings.length ? P.settings.join(', ') : 'nothing'} · Fields: {P.fields.add} new, {P.fields.change} updated · Rules: {P.rules.add} new, {P.rules.change} updated · Record types: {P.objects.add} new, {P.objects.change} updated · Lead rules: {P.leadRules.add} new, {P.leadRules.change} updated</div>
          {plan.dryRun && pkg && <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={apply}>Load it</button>}
        </div>
      )}
    </>
  );
}

const PARTS = [['fields', 'Fields', FieldsPart], ['layouts', 'Layouts', LayoutsPart], ['rules', 'Rules', RulesPart], ['objects', 'Record types', ObjectsPart], ['routing', 'Lead routing', RoutingPart], ['capture', 'Lead capture', CapturePart], ['money', 'Money & units', MoneyPart], ['privacy', 'Data & privacy', PrivacyPart], ['year', 'Year & brand', YearPart], ['package', 'Test copy', PackagePart]];
export default function CrmCustomise() {
  const [part, setPart] = useState('fields');
  const Part = (PARTS.find((p) => p[0] === part) || PARTS[0])[2];
  return (
    <div className="card" style={{ padding: 12, margin: '12px 0' }}>
      <div className="section-label" style={{ marginTop: 0 }}>Customise the CRM</div>
      <div className="tabs" role="tablist" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {PARTS.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={part === k} className={`tab${part === k ? ' active' : ''}`} onClick={() => setPart(k)} onKeyDown={(e) => { if (e.key === 'Enter') setPart(k); }}>{l}</div>)}
      </div>
      <Part />
    </div>
  );
}

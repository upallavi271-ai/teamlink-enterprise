// ---------------------------------------------------------------------------
// CRM WAVE C - THE NEW TABS INSIDE THE EXISTING CRM SCREENS (2026-11-24; the CRM stays at five sidebar items):
//   Accounts & Contacts > More records      the records of your own types (Branches, Contracts ...)
//   Accounts & Contacts > Customer health   every customer with a 0-100 health score and its reasons, worst first
//   Accounts & Contacts > Data care         recycle bin, duplicates (find + merge), import accounts / contacts, mass changes, data requests
//   Dashboard > Adoption                    who uses the CRM, how much (Sales managers / Admins)
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, dateOf, dateTimeOf, download, RecLink } from './crmShared.jsx'; // eslint-disable-line import/no-cycle
import { usePlusSetup, CustomInput } from './crmPlusC.jsx';
import { HealthPill, MergeDialog, ObjectRecordForm } from './CrmRecordMore.jsx'; // eslint-disable-line import/no-cycle

const line = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 };
const WORD = { lead: 'Lead', account: 'Account', contact: 'Contact', deal: 'Deal' };
const SubTabs = ({ tabs, tab, setTab }) => (
  <div className="tabs" role="tablist" style={{ marginBottom: 10 }}>
    {tabs.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{l}</div>)}
  </div>
);

// ---- More records (record types of your own) ---------------------------------------------------------------------
export function MoreRecords() {
  const { me, toast, openRecord } = useCrm();
  const setup = usePlusSetup();
  const objects = (setup && setup.objects) || [];
  const [oid, setOid] = useState('');
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);
  const [accounts, setAccounts] = useState([]);
  useEffect(() => { if (!oid && objects.length) setOid(objects[0].id); }, [objects.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = () => (oid ? api.get(`/crm/plusc/objects/${oid}/records`, { params: { q: q || undefined } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This list could not be read.') })) : null);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [oid, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/crm/accounts').then((r) => setAccounts(r.data.rows || [])).catch(() => setAccounts([])); }, []);
  const def = objects.find((o) => o.id === oid);
  async function save() {
    try {
      const body = { name: form.name, values: form.values, ...(def.linkTo === 'account' ? { accountId: form.accountId || '' } : {}) };
      if (form.id) await api.put(`/crm/plusc/object-records/${form.id}`, { ...body, objectId: oid }); else await api.post(`/crm/plusc/objects/${oid}/records`, body);
      toast('Saved.'); setForm(null); load();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function remove(x) {
    if (!window.confirm(`Delete ${x.name}?`)) return; // eslint-disable-line no-alert
    try { await api.delete(`/crm/plusc/object-records/${x.id}`); load(); } catch (e) { toast(errOf(e, 'This could not be deleted.')); }
  }
  if (!setup) return <div className="small-muted">Loading…</div>;
  if (!objects.length) return <div className="empty"><h3>No record types yet</h3>{me.canAssign ? 'Add one in ⚙ Settings > Customise the CRM > Record types (for example Branches, Contracts, Site visits).' : 'A Sales manager adds them in CRM settings.'}</div>;
  return (
    <div>
      <div className="filter-row">
        <select value={oid} onChange={(e) => setOid(e.target.value)} aria-label="Record type" style={{ width: 'auto' }}>{objects.map((o) => <option key={o.id} value={o.id}>{o.plural}</option>)}</select>
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" style={{ minWidth: 200 }} />
        {me.canCreate && def && <button type="button" className="btn btn-primary" onClick={() => setForm({ name: '', values: {}, accountId: '' })}>+ {def.name}</button>}
      </div>
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && d.rows && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Name</th>{def && def.linkTo === 'account' && <th>Account</th>}{def && def.fields.slice(0, 4).map((f) => <th key={f.key}>{f.label}</th>)}<th>Owner</th><th /></tr></thead>
            <tbody>
              {!d.rows.length && <tr><td colSpan={8}><div className="empty">None yet.</div></td></tr>}
              {d.rows.map((x) => (
                <tr key={x.id}>
                  <td><b>{x.name}</b></td>
                  {def.linkTo === 'account' && <td>{x.accountId ? <button type="button" className="crm-linkbtn" onClick={() => openRecord('account', x.accountId)}>{x.accountName || 'Open'}</button> : '—'}</td>}
                  {def.fields.slice(0, 4).map((f) => <td key={f.key}>{x.values[f.key] == null ? '—' : Array.isArray(x.values[f.key]) ? x.values[f.key].join(', ') : x.values[f.key] === true ? 'Yes' : String(x.values[f.key])}</td>)}
                  <td className="small-muted">{x.ownerName || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{x.canEdit && <><button type="button" className="btn btn-sm" onClick={() => setForm({ id: x.id, name: x.name, values: { ...x.values }, accountId: x.accountId || '' })}>Edit</button> <button type="button" className="btn btn-sm" onClick={() => remove(x)}>Delete</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && def && (
        <ObjectRecordForm def={def} form={form} setForm={setForm} onSave={save} extra={def.linkTo === 'account' ? <div className="field"><label>Account</label><select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div> : null} />
      )}
    </div>
  );
}

// ---- Customer health ----------------------------------------------------------------------------------------------
export function CustomerHealth() {
  const { openRecord } = useCrm();
  const [band, setBand] = useState('');
  const [all, setAll] = useState(false);
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api.get('/crm/plusc/health', { params: { band: band || undefined, all: all ? '1' : undefined } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This list could not be read.') })); }, [band, all]);
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>A score out of 100 for each customer: weeks without a call / meeting / email, open and late support tickets, overdue invoices and lost deals bring it down; a recent win and open deals bring it up. Worst first - call the ones at risk.</p>
      <div className="filter-row">
        {['', 'At risk', 'Watch', 'Healthy'].map((b) => <button key={b || 'all'} type="button" className={`btn btn-sm${band === b ? ' btn-primary' : ''}`} onClick={() => setBand(b)}>{b || 'All'}{d && d.counts && b ? ` (${d.counts[b]})` : ''}</button>)}
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 500, margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={all} onChange={(e) => setAll(e.target.checked)} /> Prospects too</label>
      </div>
      {!d && <div className="small-muted">Loading…</div>}
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && d.rows && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Health</th><th>Why</th><th>Owner</th></tr></thead>
            <tbody>
              {!d.rows.length && <tr><td colSpan={4}><div className="empty">No customers here.</div></td></tr>}
              {d.rows.map((x) => (
                <tr key={x.id} className="row-link" onClick={() => openRecord('account', x.id)}>
                  <td><b>{x.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{[x.code, x.city].filter(Boolean).join(' · ')}</div></td>
                  <td><HealthPill band={x.band} score={x.score} /></td>
                  <td className="small-muted" style={{ fontSize: 12 }}>{x.signals.filter((s) => s.bad).map((s) => s.text).join(' · ') || 'All good'}</td>
                  <td>{x.ownerName || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Data care: recycle bin ------------------------------------------------------------------------------------------
function RecycleBin() {
  const { toast, openRecord, changed } = useCrm();
  const [kind, setKind] = useState('');
  const [d, setD] = useState(null);
  const load = () => api.get('/crm/plusc/bin', { params: { kind: kind || undefined } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The recycle bin could not be read.') }));
  useEffect(() => { load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  async function restore(x) {
    try { const r = await api.post(`/crm/plusc/bin/${x.id}/restore`); toast(`${x.name || WORD[x.kind]} is back.`); load(); if (changed) changed(); if (r.data.kind !== 'contact') openRecord(r.data.kind, r.data.id); } catch (e) { toast(errOf(e, 'This could not be put back.')); }
  }
  async function purge(x) {
    if (!window.confirm(`Delete ${x.name || 'this'} for good? It cannot be brought back.`)) return; // eslint-disable-line no-alert
    try { await api.delete(`/crm/plusc/bin/${x.id}`); load(); } catch (e) { toast(errOf(e, 'This could not be deleted.')); }
  }
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>Deleted leads, accounts, contacts and deals stay here with what went with them (activities, follow-ups) until they are put back or removed for good{d && d.keepDays ? ` - after ${d.keepDays} days by the data retention rule` : ''}.</p>
      <div className="filter-row"><select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" style={{ width: 'auto' }}><option value="">Everything</option><option value="lead">Leads</option><option value="account">Accounts</option><option value="contact">Contacts</option><option value="deal">Deals</option></select></div>
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && d.rows && !d.rows.length && <div className="empty"><h3>The recycle bin is empty</h3></div>}
      {d && d.rows && d.rows.map((x) => (
        <div key={x.id} style={line}>
          <span style={{ flex: 1, minWidth: 0 }}><span className="status review">{WORD[x.kind]}</span> <b>{x.name || '(no name)'}</b> <span className="small-muted" style={{ fontSize: 12 }}>deleted {dateTimeOf(x.deletedAt)}{x.deletedByName ? ` by ${x.deletedByName}` : ''}{x.why ? ` · ${x.why}` : ''}</span></span>
          <button type="button" className="btn btn-sm" onClick={() => restore(x)}>Restore</button>
          {d.canEmpty && <button type="button" className="btn btn-sm" onClick={() => purge(x)}>Delete for good</button>}
        </div>
      ))}
    </div>
  );
}

// ---- Data care: duplicates ------------------------------------------------------------------------------------------------
function Duplicates() {
  const { me, changed } = useCrm();
  const [kind, setKind] = useState('lead');
  const [d, setD] = useState(null);
  const [merge, setMerge] = useState(null); // { keep, other }
  const load = () => { setD(null); api.get('/crm/plusc/duplicates', { params: { kind } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This could not be read.') })); };
  useEffect(() => { load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const mayMerge = me.canAssign || (me.rights && me.rights.delete);
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>Records that look like the same company or person: the same company name, phone or email. Merge keeps one, moves everything from the other to it, and sends the other to the recycle bin.</p>
      <div className="filter-row"><select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" style={{ width: 'auto' }}><option value="lead">Leads</option><option value="account">Accounts</option><option value="contact">Contacts</option></select></div>
      {!d && <div className="small-muted">Looking…</div>}
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && d.groups && !d.groups.length && <div className="empty"><h3>No duplicates found</h3></div>}
      {d && d.groups && d.groups.map((g) => (
        <div key={g.key} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div className="small-muted" style={{ marginBottom: 4 }}>{g.why}</div>
          {g.rows.map((x, i) => (
            <div key={x.id} style={line}>
              <span style={{ flex: 1, minWidth: 0 }}>{kind === 'contact' ? <b>{x.name}</b> : <RecLink kind={kind} id={x.id}>{x.name}</RecLink>} <span className="small-muted" style={{ fontSize: 12 }}>{[x.code, x.phone, x.email, x.city, x.status, x.ownerName && `owner ${x.ownerName}`, `added ${dateOf(x.createdAt)}`].filter(Boolean).join(' · ')}</span></span>
              {mayMerge && i > 0 && <button type="button" className="btn btn-sm" onClick={() => setMerge({ keep: g.rows[0], other: x })}>Merge into the first</button>}
            </div>
          ))}
        </div>
      ))}
      {merge && <MergeDialogDirect kind={kind} keep={merge.keep} other={merge.other} onClose={() => setMerge(null)} onMerged={() => { setMerge(null); load(); if (changed) changed(); }} />}
    </div>
  );
}
// the merge dialog with both records already picked
function MergeDialogDirect({ kind, keep, other, onClose, onMerged }) {
  const [keepRow, setKeepRow] = useState(null);
  useEffect(() => { api.get(`/crm/plusc/merge`, { params: { kind, keepId: keep.id, mergeId: other.id } }).then((r) => setKeepRow({ ...r.data.keep, __other: r.data.other })).catch(() => setKeepRow({ ...keep, company: keep.name })); }, [kind, keep.id, other.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!keepRow) return null;
  return <MergeDialog kind={kind} keep={keepRow} presetOther={keepRow.__other || other} onClose={onClose} onMerged={onMerged} />;
}

// ---- Data care: import accounts / contacts ------------------------------------------------------------------------------------------
function ImportRecords() {
  const { me, toast, changed } = useCrm();
  const [kind, setKind] = useState('account');
  const [file, setFile] = useState(null);
  const [dry, setDry] = useState(null);
  const [create, setCreate] = useState(true);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  async function send(dryRun) {
    if (!file) return;
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const r = await api.post(`/crm/plusc/import/${kind}s?dryRun=${dryRun ? 1 : 0}&name=${encodeURIComponent(file.name)}&createAccounts=${create ? 1 : 0}`, buf, { headers: { 'Content-Type': 'application/octet-stream' } });
      if (dryRun) setDry(r.data); else { toast(`${r.data.created} ${kind}s added${r.data.accountsMade ? ` (+${r.data.accountsMade} companies)` : ''}, ${r.data.skipped.length} skipped.`); setDry(null); setFile(null); if (changed) changed(); }
    } catch (e) { toast(errOf(e, 'The file could not be imported.')); setDry(e.response && e.response.data && e.response.data.headings ? { error: errOf(e, ''), headings: e.response.data.headings } : null); } finally { setBusy(false); }
  }
  if (!(me.rights && me.rights.import)) return <div className="empty"><h3>Import needs the import right</h3>Ask a Sales manager.</div>;
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>An Excel or CSV file with a heading row. Accounts: Company, Industry, City, Website, Phone, Email, GSTIN, State, Pincode, Address, Tags, Parent (a parent company in the same file or already here), and any custom field by its name. Contacts: Name, Company, Designation, Role, Phone, Email, Tags. Duplicates are skipped. (Leads have their own import on Leads.)</p>
      <div className="filter-row">
        <select value={kind} onChange={(e) => { setKind(e.target.value); setDry(null); }} aria-label="What to import" style={{ width: 'auto' }}><option value="account">Accounts</option><option value="contact">Contacts</option></select>
        <button type="button" className="btn" onClick={() => input.current && input.current.click()}>{file ? file.name : 'Choose the file…'}</button>
        <input ref={input} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={(e) => { setFile(e.target.files && e.target.files[0]); setDry(null); }} aria-label="Import file" />
        {kind === 'contact' && <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 500, margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={create} onChange={(e) => setCreate(e.target.checked)} /> Add missing companies</label>}
        <button type="button" className="btn" disabled={!file || busy} onClick={() => send(true)}>Check the file</button>
      </div>
      {dry && dry.error && <div className="notice">{dry.error}{dry.headings ? ` Headings in the file: ${dry.headings.join(', ')}` : ''}</div>}
      {dry && dry.dryRun && (
        <div className="card" style={{ padding: 10 }}>
          <div style={{ fontSize: 13.5 }}><b>{dry.ready}</b> of {dry.rows} rows are ready{dry.newAccounts && dry.newAccounts.length ? `; ${dry.newAccounts.length} new companies would be made` : ''}. Columns found: {Object.entries(dry.columns).map(([k, h]) => `${k} = "${h}"`).join(', ')}{Object.keys(dry.customColumns || {}).length ? `; custom: ${Object.values(dry.customColumns).join(', ')}` : ''}.</div>
          {dry.skipped.length > 0 && <div className="small-muted" style={{ marginTop: 4, maxHeight: 160, overflow: 'auto' }}>{dry.skipped.slice(0, 50).map((s) => <div key={`${s.row}${s.reason}`}>Row {s.row}{s.name ? ` (${s.name})` : ''}: {s.reason}</div>)}</div>}
          <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={!dry.ready || busy} onClick={() => send(false)}>{busy ? 'Importing…' : `Import ${dry.ready}`}</button>
        </div>
      )}
    </div>
  );
}

// ---- Data care: mass changes ------------------------------------------------------------------------------------------------------------
const BULK_FIELDS = { lead: [['industry', 'Industry'], ['city', 'City'], ['source', 'Source'], ['rating', 'Rating']], account: [['industry', 'Industry'], ['city', 'City'], ['source', 'Source'], ['state', 'State']], contact: [['designation', 'Designation'], ['role', 'Role']], deal: [['expectedClose', 'Expected close'], ['nextStep', 'Next step']] };
function MassChange() {
  const { me, toast, changed } = useCrm();
  const setup = usePlusSetup();
  const [kind, setKind] = useState('lead');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [action, setAction] = useState('update');
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/${kind}s`, { params: { q: q || undefined, tag: tag || undefined, status: kind === 'lead' ? 'all' : undefined } }).then((r) => setRows(r.data.rows || [])).catch(() => setRows([]));
  useEffect(() => { setPicked(new Set()); const t = setTimeout(load, q || tag ? 300 : 0); return () => clearTimeout(t); }, [kind, q, tag]); // eslint-disable-line react-hooks/exhaustive-deps
  const custom = ((setup && setup.fields) || []).filter((f) => f.kind === kind && f.active && !f.sensitive);
  const cdef = custom.find((f) => f.key === field);
  const nameOf = (x) => x.company || x.name || x.title;
  async function go() {
    if (!picked.size) return;
    let body = { kind, ids: [...picked], action };
    if (action === 'update') {
      if (field === 'ownerId') body.set = { ownerId: value };
      else if (field === 'unitId') body.set = { unitId: value };
      else if (cdef) body.set = { custom: { [field]: value } };
      else body.set = { [field]: value };
    }
    if (action === 'tagAdd' || action === 'tagRemove') body = { ...body, tags: value };
    // eslint-disable-next-line no-alert
    if (action === 'delete' && !window.confirm(`Delete ${picked.size} ${kind}s? They go to the recycle bin.`)) return;
    setBusy(true);
    try { const r = await api.post('/crm/plusc/bulk', body); toast(`${r.data.changed} changed${r.data.skipped.length ? `, ${r.data.skipped.length} skipped (${[...new Set(r.data.skipped.map((s) => s.reason))].slice(0, 2).join('; ')})` : ''}.`); setPicked(new Set()); load(); if (changed) changed(); } catch (e) { toast(errOf(e, 'This could not be done.')); } finally { setBusy(false); }
  }
  const all = rows && rows.length > 0 && rows.every((x) => picked.has(x.id));
  const fieldOptions = [...BULK_FIELDS[kind], ...(me.canAssign ? [['ownerId', 'Owner']] : []), ...(setup && setup.unitsOn && kind !== 'contact' ? [['unitId', 'Business unit']] : []), ...custom.map((f) => [f.key, f.label])];
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>Change many records at once - each one goes through the normal save, so your rights, the validation rules and who owns what still apply (a record you may not change is skipped and said).</p>
      <div className="filter-row">
        <select value={kind} onChange={(e) => { setKind(e.target.value); setField(''); }} aria-label="Kind" style={{ width: 'auto' }}><option value="lead">Leads</option><option value="account">Accounts</option><option value="contact">Contacts</option><option value="deal">Deals</option></select>
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" style={{ minWidth: 180 }} />
        <input type="text" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag" aria-label="Tag filter" style={{ width: 120 }} />
      </div>
      <div className="results-bar" style={{ flexWrap: 'wrap', gap: 6 }}>
        <b>{picked.size} ticked</b>
        <select value={action} onChange={(e) => { setAction(e.target.value); setValue(''); }} aria-label="What to do" style={{ width: 'auto' }}>
          <option value="update">Set a field</option><option value="tagAdd">Add a tag</option><option value="tagRemove">Remove a tag</option>
          {kind === 'lead' && me.canAssign && <option value="assignRules">Re-run the lead rules</option>}
          {(me.canAssign || (me.rights && me.rights.delete)) && <option value="delete">Delete (to the recycle bin)</option>}
        </select>
        {action === 'update' && <select value={field} onChange={(e) => { setField(e.target.value); setValue(''); }} aria-label="Field" style={{ width: 'auto' }}><option value="">— field —</option>{fieldOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        {action === 'update' && field === 'ownerId' && <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Owner" style={{ width: 'auto' }}><option value="">—</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        {action === 'update' && field === 'unitId' && <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Unit" style={{ width: 'auto' }}><option value="">— none —</option>{setup.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        {action === 'update' && field === 'rating' && <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Rating" style={{ width: 'auto' }}><option value="">—</option>{me.lists.ratings.map((x) => <option key={x} value={x}>{x}</option>)}</select>}
        {action === 'update' && field === 'source' && <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Source" style={{ width: 'auto' }}><option value="">—</option>{me.lists.sources.map((x) => <option key={x} value={x}>{x}</option>)}</select>}
        {action === 'update' && field === 'role' && <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Role" style={{ width: 'auto' }}><option value="">—</option>{me.lists.contactRoles.map((x) => <option key={x} value={x}>{x}</option>)}</select>}
        {action === 'update' && cdef && <span style={{ minWidth: 160 }}><CustomInput d={cdef} value={value} onChange={setValue} /></span>}
        {action === 'update' && field && !cdef && !['ownerId', 'unitId', 'rating', 'source', 'role'].includes(field) && <input type={field === 'expectedClose' ? 'date' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} aria-label="New value" style={{ width: 160 }} />}
        {(action === 'tagAdd' || action === 'tagRemove') && <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="tag" aria-label="Tag" style={{ width: 140 }} />}
        <button type="button" className={`btn btn-sm${action === 'delete' ? '' : ' btn-primary'}`} style={action === 'delete' ? { color: 'var(--red)', borderColor: 'var(--red)' } : undefined} disabled={busy || !picked.size || (action === 'update' && !field) || ((action === 'tagAdd' || action === 'tagRemove') && !value)} onClick={go}>{busy ? 'Working…' : 'Apply'}</button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th><input type="checkbox" style={{ width: 'auto' }} checked={all} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((x) => x.id)) : new Set())} aria-label="Tick all" /></th><th>Name</th><th>Details</th><th>Tags</th><th>Owner</th></tr></thead>
          <tbody>
            {rows == null && <tr><td colSpan={5} className="small-muted">Loading…</td></tr>}
            {rows && !rows.length && <tr><td colSpan={5}><div className="empty">Nothing here.</div></td></tr>}
            {(rows || []).slice(0, 500).map((x) => (
              <tr key={x.id}>
                <td><input type="checkbox" style={{ width: 'auto' }} checked={picked.has(x.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(x.id); else n.delete(x.id); setPicked(n); }} aria-label={`Tick ${nameOf(x)}`} /></td>
                <td><b>{nameOf(x)}</b></td>
                <td className="small-muted" style={{ fontSize: 12 }}>{[x.code, x.city, x.industry, x.accountName, x.stage || x.status || x.kind].filter(Boolean).join(' · ')}</td>
                <td className="small-muted" style={{ fontSize: 12 }}>{x.tags || ''}</td>
                <td className="small-muted">{x.ownerName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Data care: data requests -------------------------------------------------------------------------------------------------------
function DataRequests() {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ type: 'export', person: '', note: '' });
  const load = () => api.get('/crm/plusc/dsr').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This list could not be read.') }));
  useEffect(() => { if (me.canAssign) load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me.canAssign) return <div className="empty"><h3>Data requests are handled by a Sales manager or an Admin</h3></div>;
  async function open() { try { await api.post('/crm/plusc/dsr', f); toast('Request opened.'); setF({ type: 'export', person: '', note: '' }); load(); } catch (e) { toast(errOf(e, 'This could not be opened.')); } }
  async function erase(x) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Erase ${x.person} from the CRM now?\n\nNames, phone numbers, emails, notes and custom values on their leads and contacts are wiped, and their files deleted. They stay on the do-not-contact list so they are never messaged again. CRM invoices are kept (tax law). This cannot be undone.`)) return;
    try { await api.post(`/crm/plusc/dsr/${x.id}/erase`, { confirm: true }); toast('Erased.'); load(); } catch (e) { toast(errOf(e, 'This could not be done.')); }
  }
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>When a person asks what the CRM holds about them (export) or asks to be deleted (erase) - DPDP Act 2023 / GDPR. Answer within 30 days.</p>
      <div className="filter-row">
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Request" style={{ width: 'auto' }}><option value="export">Export their data</option><option value="erase">Erase their data</option></select>
        <input type="text" value={f.person} onChange={(e) => setF({ ...f, person: e.target.value })} placeholder="Their email or mobile" aria-label="Email or mobile" style={{ minWidth: 220 }} />
        <input type="text" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="How they asked (optional)" aria-label="Note" style={{ minWidth: 200 }} />
        <button type="button" className="btn btn-primary" disabled={!f.person.trim()} onClick={open}>Open request</button>
      </div>
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && d.rows && !d.rows.length && <div className="empty">No requests yet.</div>}
      {d && d.rows && d.rows.map((x) => {
        const found = (x.detail && x.detail.found) || {};
        return (
          <div key={x.id} style={line}>
            <span style={{ flex: 1, minWidth: 0 }}><span className={`status ${x.status === 'Done' ? 'joined' : 'pending'}`}>{x.status}</span> <b>{x.type === 'erase' ? 'Erase' : 'Export'}: {x.person}</b> <span className="small-muted" style={{ fontSize: 12 }}>opened {dateOf(x.createdAt)}{x.byName ? ` by ${x.byName}` : ''}{x.status !== 'Done' && x.dueBy ? ` · answer by ${dateOf(x.dueBy)}` : ''}{x.doneAt ? ` · done ${dateOf(x.doneAt)}` : ''} · found {found.leads || 0} leads, {found.contacts || 0} contacts, {found.activities || 0} activities{x.note ? ` · ${x.note}` : ''}</span></span>
            <button type="button" className="btn btn-sm" onClick={() => download(`/crm/plusc/dsr/${x.id}/export`, `crm-data-${x.person}.json`).then(load).catch(() => toast('The download did not work.'))}>Download their data</button>
            {x.type === 'erase' && x.status !== 'Done' && <button type="button" className="btn btn-sm" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => erase(x)}>Erase now</button>}
          </div>
        );
      })}
    </div>
  );
}

export function DataCare() {
  const [tab, setTab] = useState('bin');
  return (
    <div>
      <SubTabs tab={tab} setTab={setTab} tabs={[['bin', 'Recycle bin'], ['dups', 'Duplicates'], ['import', 'Import'], ['bulk', 'Mass changes'], ['dsr', 'Data requests']]} />
      {tab === 'bin' && <RecycleBin />}
      {tab === 'dups' && <Duplicates />}
      {tab === 'import' && <ImportRecords />}
      {tab === 'bulk' && <MassChange />}
      {tab === 'dsr' && <DataRequests />}
    </div>
  );
}

// ---- Dashboard > Adoption ---------------------------------------------------------------------------------------------------------------
export function Adoption() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api.get('/crm/plusc/adoption', { params: { days } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The report could not be read.') })); }, [days]);
  const max = d && d.daily ? Math.max(1, ...d.daily.map((x) => x.users)) : 1;
  return (
    <div>
      <div className="filter-row">
        {[7, 30, 90].map((n) => <button key={n} type="button" className={`btn btn-sm${days === n ? ' btn-primary' : ''}`} onClick={() => setDays(n)}>Last {n} days</button>)}
      </div>
      {!d && <div className="small-muted">Loading…</div>}
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && d.rows && (
        <>
          <div className="grid-3" style={{ marginBottom: 12 }}>
            <div className="card" style={{ padding: 12 }}><div className="small-muted">Using the CRM</div><div style={{ fontSize: 22, fontWeight: 700 }}>{d.summary.active} of {d.summary.team}</div><div className="small-muted">{d.summary.activePercent}% of the team</div></div>
            <div className="card" style={{ padding: 12 }}><div className="small-muted">Not opened for 7+ days</div><div style={{ fontSize: 22, fontWeight: 700, color: d.summary.notUsing ? 'var(--red)' : undefined }}>{d.summary.notUsing}</div></div>
            <div className="card" style={{ padding: 12 }}>
              <div className="small-muted">People each day</div>
              <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 44, marginTop: 4 }} role="img" aria-label="People using the CRM each day">
                {d.daily.map((x) => <div key={x.day} title={`${x.day}: ${x.users} people, ${x.changes} changes`} style={{ flex: 1, minWidth: 2, height: `${Math.max(4, (x.users / max) * 100)}%`, background: 'var(--teal, #0f766e)', borderRadius: 2 }} />)}
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Person</th><th>Score</th><th>Days used</th><th>Changes</th><th>Added</th><th>Logged</th><th>Follow-ups done</th><th>Late</th><th>Downloads</th><th>Last seen</th></tr></thead>
              <tbody>
                {d.rows.map((x) => (
                  <tr key={x.userId}>
                    <td><b>{x.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{x.role === 'manager' ? 'Sales manager' : x.role === 'viewer' ? 'Viewer' : x.role === 'admin' ? 'Admin' : 'Salesperson'}</div></td>
                    <td><b>{x.score}</b></td>
                    <td>{x.daysActive}</td><td>{x.changes}</td><td>{x.recordsAdded}</td><td>{x.activitiesLogged}</td><td>{x.followUpsDone}</td>
                    <td style={{ color: x.followUpsLate ? 'var(--red)' : undefined }}>{x.followUpsLate}</td><td>{x.downloads}</td>
                    <td className="small-muted" style={{ color: x.notUsing ? 'var(--red)' : undefined }}>{x.lastSeen ? `${dateOf(x.lastSeen)}${x.quietDays >= 7 ? ` (${x.quietDays} days ago)` : ''}` : 'Never'}</td>
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

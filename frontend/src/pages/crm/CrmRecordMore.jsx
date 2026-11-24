// ---------------------------------------------------------------------------
// CRM WAVE C - THE "MORE" AND "PRIVACY" TABS OF A RECORD (2026-11-24), and Merge.
//   More     the fields your company added, tags, files; on an account: parent / subsidiaries, account team, org chart, customer health,
//            "Fill from the web" and the record types linked to it; on a deal: the people on it with their roles, its currency
//   Privacy  consent per channel (email, SMS, WhatsApp, calls), the DND status, and (Sales manager / Admin) export / erase this person
//   Merge    two leads / accounts / contacts into one: pick the value that wins, everything moves to the kept record, the other goes to the bin
// Server rules: backend/src/crm/plusc/*.js.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, dateTimeOf, money, download, RecLink } from './crmShared.jsx'; // eslint-disable-line import/no-cycle
import { usePlusSetup, TagInput, TagChips, fmtBytes, foreignMoney, CustomInput } from './crmPlusC.jsx';

const FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp';
const Box = ({ title, right, children }) => (
  <div className="card" style={{ padding: 12, marginBottom: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
      <div className="section-label" style={{ margin: 0 }}>{title}</div>
      {right && <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{right}</span>}
    </div>
    {children}
  </div>
);
const Row = ({ children }) => <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>{children}</div>;
const showValue = (d, v) => { if (v == null || v === '') return '—'; if (d.type === 'checkbox') return v ? 'Yes' : 'No'; if (Array.isArray(v)) return v.join(', '); if (d.type === 'url') return <a href={/^https?:/i.test(v) ? v : `https://${v}`} target="_blank" rel="noopener noreferrer">{v}</a>; return String(v); };

// ---- files on a lead / account / contact ---------------------------------------------------------------------------
export function FilesBox({ kind, id, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [cat, setCat] = useState('Document');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = () => api.get(`/crm/plusc/files/${kind}/${id}`).then((r) => setD(r.data)).catch(() => setD({ files: [], dealFiles: [], canEdit: false, categories: [] }));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function upload(file) {
    if (!file) return;
    if (file.size > ((d && d.maxBytes) || 10485760)) { toast(`That file is ${fmtBytes(file.size)}; at most 10 MB.`); return; }
    const fd = new FormData(); fd.append('category', cat); fd.append('file', file, file.name);
    setBusy(true);
    try { await api.post(`/crm/plusc/files/${kind}/${id}`, fd); toast(`${file.name} is kept on the record.`); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The file could not be uploaded.')); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove(f) {
    if (!window.confirm(`Delete ${f.name}?`)) return; // eslint-disable-line no-alert
    try { await api.delete(`/crm/plusc/file/${f.id}`); toast('File deleted.'); load(); } catch (e) { toast(errOf(e, 'The file could not be deleted.')); }
  }
  if (!d) return null;
  return (
    <Box
      title={`Files (${d.files.length})`}
      right={d.canEdit && (<>
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="What the file is" style={{ width: 'auto', padding: '2px 6px', fontSize: 13 }}>{d.categories.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current && input.current.click()}>{busy ? 'Uploading…' : '+ Upload'}</button>
        <input ref={input} type="file" accept={FILE_ACCEPT} style={{ display: 'none' }} onChange={(e) => upload(e.target.files && e.target.files[0])} aria-label="Choose a file" />
      </>)}
    >
      {!d.files.length && !d.dealFiles.length && <div className="small-muted">No files yet. PDF, Word, Excel or a picture, up to 10 MB.</div>}
      {d.files.map((f) => (
        <Row key={f.id}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><b>{f.name}</b> <span className="small-muted" style={{ fontSize: 11.5 }}>{f.category} · {fmtBytes(f.size)} · {dateOf(f.createdAt)}{f.byName ? ` · ${f.byName}` : ''}</span></span>
          <button type="button" className="btn btn-sm" onClick={() => download(`/crm/plusc/file/${f.id}`, f.name).catch(() => toast('The file could not be downloaded.'))}>Download</button>
          {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => remove(f)} aria-label={`Delete ${f.name}`}>Delete</button>}
        </Row>
      ))}
      {d.dealFiles.length > 0 && <div className="small-muted" style={{ marginTop: 8 }}>On its deals:</div>}
      {d.dealFiles.map((f) => (
        <Row key={f.id}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><b>{f.name}</b> <span className="small-muted" style={{ fontSize: 11.5 }}>{f.category} · <RecLink kind="deal" id={f.dealId}>{f.dealTitle}</RecLink> · {dateOf(f.createdAt)}</span></span>
          <button type="button" className="btn btn-sm" onClick={() => download(`/crm/deal-files/${f.id}`, f.name).catch(() => toast('The file could not be downloaded.'))}>Download</button>
        </Row>
      ))}
    </Box>
  );
}

// ---- tags ---------------------------------------------------------------------------------------------------------
function TagsBox({ kind, id, tags, canEdit, onChanged }) {
  const { toast } = useCrm();
  const [edit, setEdit] = useState(null);
  async function save() {
    try { await api.put(`/crm/${kind}s/${id}`, { tags: edit }); toast('Tags saved.'); setEdit(null); onChanged(); } catch (e) { toast(errOf(e, 'The tags could not be saved.')); }
  }
  return (
    <Box title="Tags" right={canEdit && edit == null && <button type="button" className="btn btn-sm" onClick={() => setEdit(tags.join(', '))}>Edit tags</button>}>
      {edit == null ? (tags.length ? <TagChips tags={tags} /> : <span className="small-muted">No tags. Tags group records for a list, a campaign or a report (e.g. VIP, Expo 2026).</span>) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}><TagInput value={edit} onChange={setEdit} kind={kind} /></div>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button>
          <button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button>
        </div>
      )}
    </Box>
  );
}

// ---- an account: parent / subsidiaries -----------------------------------------------------------------------------
function GroupNode({ n, depth }) {
  return (
    <div style={{ marginLeft: depth ? 18 : 0, borderLeft: depth ? '2px solid var(--line-soft)' : 'none', paddingLeft: depth ? 8 : 0 }}>
      <div style={{ padding: '4px 0', fontSize: 13, fontWeight: n.here ? 700 : 500 }}>
        {n.canOpen && !n.here ? <RecLink kind="account" id={n.id}>{n.name}</RecLink> : n.name}
        {n.here && <span className="small-muted"> (this one)</span>}
        <span className="small-muted" style={{ fontSize: 11.5 }}> · open {money(n.own.open)} · won {money(n.own.won)}{n.children.length ? ` · group won ${money(n.total.won)}` : ''}</span>
      </div>
      {n.children.map((c) => <GroupNode key={c.id} n={c} depth={depth + 1} />)}
    </div>
  );
}
function HierarchyBox({ accountId, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [pick, setPick] = useState(null);
  const load = () => api.get(`/crm/plusc/hierarchy/${accountId}`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function setParent(parentId) {
    try { await api.put(`/crm/accounts/${accountId}`, { parentId }); toast(parentId ? 'Parent company set.' : 'Parent company removed.'); setPick(null); load(); onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!d) return null;
  return (
    <Box
      title="Parent company and subsidiaries"
      right={d.canEdit && (pick == null ? <button type="button" className="btn btn-sm" onClick={() => setPick(d.parentId || '')}>{d.parentId ? 'Change parent' : 'Set parent company'}</button> : (
        <>
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Parent company" style={{ width: 'auto', maxWidth: 240 }}><option value="">— no parent —</option>{d.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setParent(pick)}>Save</button>
          <button type="button" className="btn btn-sm" onClick={() => setPick(null)}>Cancel</button>
        </>
      ))}
    >
      {!d.chain.length && !d.tree.children.length ? <span className="small-muted">Not part of a group. Set the parent company if this is a subsidiary or a branch of another account.</span> : <GroupNode n={d.tree} depth={0} />}
    </Box>
  );
}

// ---- an account: the team -----------------------------------------------------------------------------------------
function TeamBox({ accountId }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [add, setAdd] = useState({ userId: '', role: 'Sales' });
  const load = () => api.get(`/crm/plusc/team/${accountId}`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    if (!add.userId) return;
    try { const r = await api.post(`/crm/plusc/team/${accountId}`, add); setD(r.data); setAdd({ userId: '', role: 'Sales' }); toast('Added to the account team.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function remove(m) {
    try { const r = await api.delete(`/crm/plusc/team/${accountId}/${m.userId}`); setD(r.data); toast(`${m.name} is off the team.`); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!d) return null;
  return (
    <Box title="Account team">
      <div className="small-muted" style={{ marginBottom: 4 }}>Owner: <b>{d.owner.name || '—'}</b>. Team members may open this account (read only); the owner keeps it.</div>
      {d.members.map((m) => (
        <Row key={m.userId}><span style={{ flex: 1 }}><b>{m.name}</b> <span className="small-muted">· {m.role}</span></span>{d.canEdit && <button type="button" className="btn btn-sm" onClick={() => remove(m)} aria-label={`Remove ${m.name}`}>Remove</button>}</Row>
      ))}
      {d.canEdit && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <select value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })} aria-label="Person" style={{ width: 'auto', minWidth: 160 }}><option value="">Add a person…</option>{d.people.filter((p) => p.id !== d.owner.id && !d.members.some((m) => m.userId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })} aria-label="Role" style={{ width: 'auto' }}>{d.roles.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <button type="button" className="btn btn-sm" disabled={!add.userId} onClick={save}>Add</button>
        </div>
      )}
    </Box>
  );
}

// ---- an account: the org chart -------------------------------------------------------------------------------------
function OrgNode({ p, depth, contacts, canEdit, onSet }) {
  return (
    <div style={{ marginLeft: depth ? 20 : 0, borderLeft: depth ? '2px solid var(--line-soft)' : 'none', paddingLeft: depth ? 8 : 0 }}>
      <div style={{ padding: '4px 0', fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span><b>{p.name}</b>{p.designation ? ` · ${p.designation}` : ''}{p.role ? <span className="small-muted"> · {p.role}</span> : null}</span>
        {canEdit && (
          <select value={p.reportsToId || ''} onChange={(e) => onSet(p, e.target.value)} aria-label={`${p.name} reports to`} style={{ width: 'auto', padding: '1px 4px', fontSize: 12 }}>
            <option value="">reports to nobody here</option>
            {contacts.filter((c) => c.id !== p.id).map((c) => <option key={c.id} value={c.id}>reports to {c.name}</option>)}
          </select>
        )}
      </div>
      {p.reports.map((c) => <OrgNode key={c.id} p={c} depth={depth + 1} contacts={contacts} canEdit={canEdit} onSet={onSet} />)}
    </div>
  );
}
function OrgChart({ accountId, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const load = () => api.get(`/crm/plusc/org-chart/${accountId}`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = []; const walk = (list) => list.forEach((x) => { flat.push(x); walk(x.reports); });
  if (d) walk(d.roots);
  async function setBoss(p, bossId) {
    try { await api.put(`/crm/contacts/${p.id}`, { reportsToId: bossId }); toast('Saved.'); load(); onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!d) return null;
  return (
    <Box title={`Org chart (${d.count} ${d.count === 1 ? 'person' : 'people'})`}>
      {!d.count ? <span className="small-muted">No contacts yet. Add the people you talk to; then say who reports to whom.</span> : d.roots.map((p) => <OrgNode key={p.id} p={p} depth={0} contacts={flat} canEdit={d.canEdit} onSet={setBoss} />)}
    </Box>
  );
}

// ---- an account: customer health --------------------------------------------------------------------------------------
export const BAND_STYLE = { Healthy: { background: 'rgba(22,163,74,.12)', color: '#15803d' }, Watch: { background: 'rgba(217,119,6,.14)', color: '#b45309' }, 'At risk': { background: 'rgba(220,38,38,.12)', color: '#b42318' } };
export const HealthPill = ({ band, score }) => <span className="status" style={{ ...BAND_STYLE[band], fontWeight: 700 }}>{band}{score != null ? ` · ${score}` : ''}</span>;
function HealthCard({ accountId }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/crm/plusc/health/${accountId}`).then((r) => setD(r.data)).catch(() => setD(null)); }, [accountId]);
  if (!d) return null;
  return (
    <Box title="Customer health" right={<HealthPill band={d.band} score={d.score} />}>
      {d.signals.map((s) => <div key={s.text} style={{ fontSize: 13, padding: '2px 0', color: s.bad ? 'var(--red)' : undefined }}>{s.bad ? '▼' : '▲'} {s.text}</div>)}
    </Box>
  );
}

// ---- an account: fill from the web ---------------------------------------------------------------------------------------
const ENRICH_WORDS = { website: 'Website', industry: 'Industry', phone: 'Phone', state: 'State', employees: 'Company size', social: 'Social pages' };
function EnrichBox({ accountId, canEdit, social, employees, enrichedAt, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [tick, setTick] = useState({});
  const [busy, setBusy] = useState(false);
  async function look() {
    setBusy(true);
    try { const r = await api.post(`/crm/plusc/enrich/${accountId}`); setD(r.data); setTick(Object.fromEntries(Object.keys(r.data.suggestions).map((k) => [k, true]))); } catch (e) { toast(errOf(e, 'Nothing could be read.')); } finally { setBusy(false); }
  }
  async function apply() {
    const fields = Object.fromEntries(Object.entries(d.suggestions).filter(([k]) => tick[k]));
    try { await api.post(`/crm/plusc/enrich/${accountId}/apply`, { fields }); toast('Filled in.'); setD(null); onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  const soc = Object.entries(social || {});
  return (
    <Box title="Company details from the web" right={canEdit && <button type="button" className="btn btn-sm" disabled={busy} onClick={look}>{busy ? 'Reading…' : 'Fill from the web'}</button>}>
      {(soc.length > 0 || employees) && <div style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap' }}>{employees && <span>Size: <b>{employees}</b></span>}{soc.map(([k, v]) => <a key={k} href={v} target="_blank" rel="noopener noreferrer">{k === 'x' ? 'X / Twitter' : k.charAt(0).toUpperCase() + k.slice(1)}</a>)}</div>}
      {enrichedAt && <div className="small-muted" style={{ fontSize: 11.5 }}>Filled {dateTimeOf(enrichedAt)}</div>}
      {!d && !soc.length && !employees && <div className="small-muted">Reads the company&apos;s own website (from its website or work email), its GSTIN, and a company-data service once its key is saved in Administration &gt; Integrations.</div>}
      {d && (
        <div style={{ marginTop: 6 }}>
          {d.found.site && <div className="small-muted" style={{ fontSize: 12 }}>{d.found.site.title}{d.found.site.description ? ` — ${d.found.site.description}` : ''}</div>}
          {d.found.gstState && <div className="small-muted" style={{ fontSize: 12 }}>GSTIN: state {d.found.gstState}, PAN {d.found.pan}</div>}
          {d.found.siteError && <div className="small-muted" style={{ fontSize: 12 }}>{d.found.siteError}</div>}
          {d.provider && !d.provider.configured && <div className="small-muted" style={{ fontSize: 12 }}>No company-data service is connected (Administration &gt; Integrations &gt; CRM company data).</div>}
          {!Object.keys(d.suggestions).length && <div className="small-muted">Nothing new to fill in.</div>}
          {Object.entries(d.suggestions).map(([k, v]) => (
            <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500, margin: '4px 0' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!tick[k]} onChange={(e) => setTick({ ...tick, [k]: e.target.checked })} />
              {ENRICH_WORDS[k] || k}: <b style={{ overflowWrap: 'anywhere' }}>{k === 'social' ? Object.keys(JSON.parse(v)).join(', ') : v}</b>
            </label>
          ))}
          {Object.keys(d.suggestions).length > 0 && <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={apply}>Fill in the ticked</button>}
        </div>
      )}
    </Box>
  );
}

// ---- a deal: the people on it ----------------------------------------------------------------------------------------------
function DealPeople({ dealId, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [add, setAdd] = useState({ contactId: '', role: 'Influencer' });
  const load = () => api.get(`/crm/plusc/deal-contacts/${dealId}`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(primary) {
    if (!add.contactId) return;
    try { const r = await api.post(`/crm/plusc/deal-contacts/${dealId}`, { ...add, primary }); setD(r.data); setAdd({ contactId: '', role: 'Influencer' }); toast('Added to the deal.'); onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function remove(c) {
    try { const r = await api.delete(`/crm/plusc/deal-contacts/${dealId}/${c.contactId}`); setD(r.data); onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!d) return null;
  return (
    <Box title={`People on this deal (${d.contacts.length})`}>
      {!d.contacts.length && <div className="small-muted">Nobody yet. Add the decision maker, the people who influence it and the billing contact.</div>}
      {d.contacts.map((c) => (
        <Row key={c.contactId}>
          <span style={{ flex: 1, minWidth: 0 }}><b>{c.name}</b>{c.designation ? ` · ${c.designation}` : ''} <span className="status review" style={{ fontWeight: 600 }}>{c.role}</span>{c.primary && <span className="small-muted"> · main contact</span>}<div className="small-muted" style={{ fontSize: 11.5 }}>{[c.phone, c.email].filter(Boolean).join(' · ')}</div></span>
          {d.canEdit && <button type="button" className="btn btn-sm" onClick={() => remove(c)} aria-label={`Take ${c.name} off the deal`}>Remove</button>}
        </Row>
      ))}
      {d.canEdit && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <select value={add.contactId} onChange={(e) => setAdd({ ...add, contactId: e.target.value })} aria-label="Contact" style={{ width: 'auto', minWidth: 160 }}><option value="">Add a person…</option>{d.options.filter((o) => !d.contacts.some((c) => c.contactId === o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}{o.designation ? ` · ${o.designation}` : ''}</option>)}</select>
          <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })} aria-label="Role on the deal" style={{ width: 'auto' }}>{d.roles.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <button type="button" className="btn btn-sm" disabled={!add.contactId} onClick={() => save(false)}>Add</button>
          <button type="button" className="btn btn-sm" disabled={!add.contactId} onClick={() => save(true)} title="Add and make them the deal's main contact">Add as main</button>
        </div>
      )}
      {!d.options.length && d.canEdit && <div className="small-muted" style={{ marginTop: 4 }}>Add contacts to the deal&apos;s account first.</div>}
    </Box>
  );
}

// ---- records of your own types linked here ----------------------------------------------------------------------------------
function LinkedObjects({ kind, id, objects, canEdit }) {
  const { toast } = useCrm();
  const setup = usePlusSetup();
  const [open, setOpen] = useState(null); // an object type id
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);
  const def = open && setup ? (setup.objects || []).find((o) => o.id === open) : null;
  const load = (oid) => api.get(`/crm/plusc/objects/${oid}/records`, { params: { [`${kind}Id`]: id } }).then((r) => setRows(r.data.rows)).catch(() => setRows([]));
  useEffect(() => { if (open) load(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      if (form.id) await api.put(`/crm/plusc/object-records/${form.id}`, { objectId: open, name: form.name, values: form.values });
      else await api.post(`/crm/plusc/objects/${open}/records`, { name: form.name, values: form.values, [`${kind}Id`]: id });
      toast('Saved.'); setForm(null); load(open);
    } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!objects.length) return null;
  return (
    <Box title="Records of your own types" right={objects.map((o) => <button key={o.id} type="button" className={`btn btn-sm${open === o.id ? ' btn-primary' : ''}`} onClick={() => setOpen(open === o.id ? null : o.id)}>{o.plural} ({o.count})</button>)}>
      {!open && <span className="small-muted">Open a type to see or add its records.</span>}
      {open && def && (
        <>
          {rows.map((x) => (
            <Row key={x.id}>
              <span style={{ flex: 1, minWidth: 0 }}><b>{x.name}</b> <span className="small-muted" style={{ fontSize: 12 }}>{def.fields.map((f) => (x.values[f.key] != null && x.values[f.key] !== '' ? `${f.label}: ${Array.isArray(x.values[f.key]) ? x.values[f.key].join(', ') : x.values[f.key] === true ? 'Yes' : x.values[f.key]}` : null)).filter(Boolean).join(' · ')}</span></span>
              {x.canEdit && <button type="button" className="btn btn-sm" onClick={() => setForm({ id: x.id, name: x.name, values: { ...x.values } })}>Edit</button>}
            </Row>
          ))}
          {!rows.length && <div className="small-muted">None yet.</div>}
          {canEdit && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setForm({ name: '', values: {} })}>+ {def.name}</button>}
          {form && <ObjectRecordForm def={def} form={form} setForm={setForm} onSave={save} />}
        </>
      )}
    </Box>
  );
}
export function ObjectRecordForm({ def, form, setForm, onSave, extra }) {
  return (
    <Modal title={`${form.id ? 'Edit' : 'New'} ${def.name.toLowerCase()}`} onClose={() => setForm(null)} foot={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={onSave}>Save</button></>}>
      <div className="grid-2">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Name *</label><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        {def.fields.map((f) => (
          <div key={f.key} className="field" style={f.type === 'long' || f.type === 'multi' ? { gridColumn: '1 / -1' } : undefined}>
            <label>{f.label}{f.required ? ' *' : ''}</label>
            <CustomInput d={f} value={form.values[f.key]} onChange={(v) => setForm({ ...form, values: { ...form.values, [f.key]: v } })} />
          </div>
        ))}
        {extra}
      </div>
    </Modal>
  );
}

// ---- THE MORE TAB ------------------------------------------------------------------------------------------------------------
export function RecordMore({ kind, id, onChanged }) {
  const setup = usePlusSetup();
  const [x, setX] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get(`/crm/plusc/record/${kind}/${id}`).then((r) => { setX(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'This could not be read.')));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { load(); if (onChanged) onChanged(); };
  if (err) return <div className="notice" role="alert">{err}</div>;
  if (!x) return <div className="small-muted">Loading…</div>;
  const cur = kind === 'deal' && x.currency ? foreignMoney({ currency: x.currency.code, amountForeign: x.currency.amount }, setup) : null;
  return (
    <div>
      {x.onTeamOnly && <div className="notice" style={{ marginBottom: 10 }}>You are on this account&apos;s team: you can read it; its owner changes it.</div>}
      {(x.fields.length > 0 || x.unit || cur) && (
        <Box title="Details your company added">
          {x.unit && <div style={{ fontSize: 13, padding: '2px 0' }}><span className="small-muted">Business unit:</span> <b>{x.unit}</b></div>}
          {cur && <div style={{ fontSize: 13, padding: '2px 0' }}><span className="small-muted">Priced in {x.currency.code}:</span> <b>{cur}</b> <span className="small-muted">at {x.currency.rate} = {money(x.currency.inr)}</span></div>}
          <div className="grid-2">
            {x.fields.map((d) => <div key={d.key} style={{ fontSize: 13, padding: '2px 0' }}><span className="small-muted">{d.label}{d.sensitive ? ' 🔒' : ''}:</span> {showValue(d, x.custom[d.key])}</div>)}
          </div>
          {x.fields.length > 0 && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>Change these with Edit.</div>}
        </Box>
      )}
      <TagsBox kind={kind} id={id} tags={x.tags} canEdit={x.canEdit} onChanged={changed} />
      {kind === 'deal' && <DealPeople dealId={id} onChanged={changed} />}
      {kind === 'account' && <HealthCard accountId={id} />}
      {kind === 'account' && <HierarchyBox accountId={id} onChanged={changed} />}
      {kind === 'account' && <TeamBox accountId={id} />}
      {kind === 'account' && <OrgChart accountId={id} onChanged={changed} />}
      {kind === 'account' && <EnrichBox accountId={id} canEdit={x.canEdit} social={x.social} employees={x.employees} enrichedAt={x.enrichedAt} onChanged={changed} />}
      {kind !== 'deal' ? <FilesBox kind={kind} id={id} onChanged={changed} /> : <div className="small-muted" style={{ marginBottom: 12 }}>The deal&apos;s quotation and files are on its Proposals tab.</div>}
      <LinkedObjects kind={kind} id={id} objects={x.objects} canEdit={x.canEdit} />
    </div>
  );
}

// ---- THE PRIVACY TAB ------------------------------------------------------------------------------------------------------------
export function RecordPrivacy({ kind, id }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null); // { channel, status }
  const load = () => api.get(`/crm/plusc/consent/${kind}/${id}`).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'This could not be read.') }));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try { const r = await api.post(`/crm/plusc/consent/${kind}/${id}`, form); setD(r.data); setForm(null); toast(form.status === 'given' ? 'Consent recorded.' : 'Withdrawn: no more messages on that channel.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function request(type) {
    const person = d.email || d.phone;
    if (!person) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(type === 'erase' ? `Open an ERASE request for ${person}? Nothing is wiped until you confirm it in Accounts & Contacts > Data care > Data requests.` : `Open an export request for ${person}?`)) return;
    try { await api.post('/crm/plusc/dsr', { type, person }); toast('Request opened: Accounts & Contacts > Data care > Data requests.'); } catch (e) { toast(errOf(e, 'The request could not be opened.')); }
  }
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice" role="alert">{d.error}</div>;
  const STATUS = { Given: 'joined', Withdrawn: 'rejected', 'Not asked': 'review', 'No address': 'review' };
  return (
    <div>
      <Box title="Consent (DPDP / GDPR)">
        <div className="small-muted" style={{ marginBottom: 6 }}>What {d.name || 'this person'} agreed to, per channel. &quot;Withdrawn&quot; stops every CRM message on that channel at once (campaigns, the automatic follow-through, Email / WhatsApp from a record).</div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Channel</th><th>To</th><th>Status</th><th>Purpose / where from</th><th>When</th>{d.canEdit && <th />}</tr></thead>
            <tbody>
              {Object.values(d.channels).map((c) => (
                <tr key={c.channel}>
                  <td><b>{c.word}</b></td>
                  <td className="small-muted">{c.value || '—'}</td>
                  <td><span className={`status ${STATUS[c.status] || 'review'}`}>{c.status}</span></td>
                  <td className="small-muted">{[c.purpose, c.source].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="small-muted">{c.at ? dateOf(c.at) : '—'}</td>
                  {d.canEdit && <td style={{ whiteSpace: 'nowrap' }}>{c.value && (<>
                    <button type="button" className="btn btn-sm" onClick={() => setForm({ channel: c.channel, status: 'given', purpose: d.purposes[0], source: d.sources[0], note: '' })}>Given</button>{' '}
                    <button type="button" className="btn btn-sm" onClick={() => setForm({ channel: c.channel, status: 'withdrawn', purpose: '', source: d.sources[0], note: '' })}>Withdrawn</button>
                  </>)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Box>
      <Box title="Do-Not-Disturb (TRAI)">
        {d.phone ? (d.dnd ? <span className="status rejected">On the DND list: TeamLink does not place a sales call to {d.phone}</span> : <span className="small-muted">{d.phone} is not on the DND list TeamLink has. A call checks again (with the provider when it is connected).</span>) : <span className="small-muted">No 10-digit mobile number on this record.</span>}
      </Box>
      {me.canAssign && (
        <Box title="This person's data">
          <div className="small-muted" style={{ marginBottom: 6 }}>When {d.name || 'the person'} asks what you hold about them, or asks you to delete it.</div>
          <button type="button" className="btn btn-sm" disabled={!d.email && !d.phone} onClick={() => request('export')}>Export their data</button>{' '}
          <button type="button" className="btn btn-sm" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} disabled={!d.email && !d.phone} onClick={() => request('erase')}>Erase on request…</button>
        </Box>
      )}
      {form && (
        <Modal title={`Consent ${form.status === 'given' ? 'given' : 'withdrawn'}: ${d.channels[form.channel].word}`} onClose={() => setForm(null)} foot={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
          {form.status === 'given' && <div className="field"><label>For what</label><select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>{d.purposes.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>}
          <div className="field"><label>How we know</label><select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>{d.sources.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
          <div className="field"><label>Note</label><input type="text" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. said on the call of 24 Nov" /></div>
        </Modal>
      )}
    </div>
  );
}

// ---- MERGE ---------------------------------------------------------------------------------------------------------------------
const MERGE_WORDS = { company: 'Company', contactName: 'Contact person', designation: 'Designation', phone: 'Phone', email: 'Email', industry: 'Industry', city: 'City', source: 'Source', rating: 'Rating', expectedValue: 'Expected value', notes: 'Notes', name: 'Name', website: 'Website', gstin: 'GSTIN', address: 'Address', state: 'State', pincode: 'Pincode', role: 'Role' };
export function MergeDialog({ kind, keep, presetOther, onClose, onMerged }) {
  const { toast } = useCrm();
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [other, setOther] = useState(presetOther || null);
  const [preview, setPreview] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (other) return undefined;
    const t = setTimeout(() => api.get(`/crm/${kind}s`, { params: { q: q || (keep.phone ? String(keep.phone).replace(/\D/g, '').slice(-10) : (keep.company || keep.name || '').split(' ')[0]), status: kind === 'lead' ? 'all' : undefined } }).then((r) => setFound((r.data.rows || []).filter((x) => x.id !== keep.id).slice(0, 20))).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q, other]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (other) api.get('/crm/plusc/merge', { params: { kind, keepId: keep.id, mergeId: other.id } }).then((r) => { setPreview(r.data); setPick({}); }).catch((e) => toast(errOf(e, 'These two cannot be merged.'))); }, [other]); // eslint-disable-line react-hooks/exhaustive-deps
  async function merge() {
    setBusy(true);
    try { await api.post('/crm/plusc/merge', { kind, keepId: keep.id, mergeId: other.id, pick }); toast('Merged. The other record is in the recycle bin.'); onMerged(); } catch (e) { toast(errOf(e, 'The merge did not work.')); } finally { setBusy(false); }
  }
  const nameOf = (x) => x.company || x.name || x.title;
  return (
    <Modal
      title={`Merge into ${nameOf(keep)}`}
      size="wide"
      onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button>{preview && <button type="button" className="btn btn-primary" disabled={busy || !preview.canMerge} onClick={merge}>{busy ? 'Merging…' : 'Merge'}</button>}</>}
    >
      {!other && (
        <>
          <div className="field"><label>Find the duplicate</label><input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or email" autoFocus /></div>
          {!found.length && <div className="small-muted">No other {kind} found yet. Type to search.</div>}
          {found.map((x) => (
            <Row key={x.id}><span style={{ flex: 1 }}><b>{nameOf(x)}</b> <span className="small-muted">{[x.code, x.phone, x.email, x.city, x.ownerName].filter(Boolean).join(' · ')}</span></span><button type="button" className="btn btn-sm" onClick={() => setOther(x)}>Pick</button></Row>
          ))}
        </>
      )}
      {other && preview && (
        <>
          <div className="small-muted" style={{ marginBottom: 8 }}>Pick the value to keep. A blank on the kept record is filled from the other one by itself. Everything on <b>{nameOf(other)}</b> (activities, follow-ups, files{kind === 'account' ? ', contacts, deals, invoices, tickets' : ''}) moves over; it then goes to the recycle bin.</div>
          {!preview.canMerge && <div className="notice" style={{ marginBottom: 8 }}>You can change only one of the two, or your rights do not allow deleting. Ask a Sales manager.</div>}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Field</th><th>Keep: {nameOf(preview.keep)}</th><th>From: {nameOf(preview.other)}</th></tr></thead>
              <tbody>
                {preview.fields.filter((f) => preview.keep[f] || preview.other[f]).map((f) => (
                  <tr key={f}>
                    <td className="small-muted">{MERGE_WORDS[f] || f}</td>
                    <td><label style={{ display: 'flex', gap: 6, fontWeight: 500, margin: 0 }}><input type="radio" style={{ width: 'auto' }} name={`m-${f}`} checked={pick[f] !== 'other'} onChange={() => setPick({ ...pick, [f]: 'keep' })} /> {String(preview.keep[f] ?? '—').slice(0, 80)}</label></td>
                    <td><label style={{ display: 'flex', gap: 6, fontWeight: 500, margin: 0 }}><input type="radio" style={{ width: 'auto' }} name={`m-${f}`} disabled={preview.other[f] == null || preview.other[f] === ''} checked={pick[f] === 'other'} onChange={() => setPick({ ...pick, [f]: 'other' })} /> {String(preview.other[f] ?? '—').slice(0, 80)}</label></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="crm-linkbtn" style={{ marginTop: 6 }} onClick={() => { setOther(null); setPreview(null); }}>← pick another</button>
        </>
      )}
    </Modal>
  );
}

// ---- a contact's own window (contacts open inside their account): tags, files, privacy, its fields -----------------------------------
export function ContactMore({ contact, onClose, onChanged }) {
  const [tab, setTab] = useState('more');
  const { me } = useCrm();
  const [merging, setMerging] = useState(false);
  return (
    <Modal title={contact.name} size="wide" onClose={onClose}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="tabs" role="tablist" style={{ margin: 0 }}>
          {[['more', 'More'], ['privacy', 'Privacy']].map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{l}</div>)}
        </div>
        {(me.canAssign || (me.rights && me.rights.delete)) && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setMerging(true)}>Merge…</button>}
      </div>
      {tab === 'more' && <RecordMore kind="contact" id={contact.id} onChanged={onChanged} />}
      {tab === 'privacy' && <RecordPrivacy kind="contact" id={contact.id} />}
      {merging && <MergeDialog kind="contact" keep={contact} onClose={() => setMerging(false)} onMerged={() => { setMerging(false); if (onChanged) onChanged(); onClose(); }} />}
    </Modal>
  );
}

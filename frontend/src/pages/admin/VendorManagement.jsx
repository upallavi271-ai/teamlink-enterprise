import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { checkGstin, clean as cleanId } from '../../utils/gstin';
import './VendorManagement.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> VENDORS (Vendor Management), 2026-10-09. The "Vendors" tab of
// the Vendor logins page (never a sidebar entry). The SAME vendor master as
// Office & Accounts -> Add Vendor: one record, one set of rules.
//   list (search + cascading filters) - Add vendor - open one vendor:
//   details/edit - logins (secure link) - bills and payments - documents shared
//   with the vendor - old bills to link - switch off / on (never deleted).
// Server: routes/vendorMaster.js (+ routes/vendorLogins.js for the logins).
// ---------------------------------------------------------------------------
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const two = (n) => String(n).padStart(2, '0');
const when = (s) => { if (!s) return '—'; const d = new Date(s); return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const BLANK = { name: '', companyName: '', contactPerson: '', email: '', phone: '', gstin: '', pan: '', category: '', paymentTerms: '', address: '', notes: '' };
const TERMS = ['Immediate', 'Advance', 'Net 7', 'Net 15', 'Net 30', 'Net 45', 'Net 60'];

export default function VendorManagement({ onSaved, onError, onOpenLogins, onLink }) {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', status: '', category: '', login: '' });
  const [qDeb, setQDeb] = useState('');
  const [form, setForm] = useState(null); // { row | null }
  const [openId, setOpenId] = useState(null);

  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    api.get('/vendor-master', { params: { q: qDeb || undefined, status: f.status || undefined, category: f.category || undefined, login: f.login || undefined } })
      .then((r) => { setData(r.data); }).catch((e) => onError(errText(e, 'Could not load the vendors.')));
  }, [qDeb, f.status, f.category, f.login, onError]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const fc = data?.facets || {};
  const filtered = !!(f.q || f.status || f.category || f.login);

  return (
    <div className="vm-wrap">
      <div className="vm-top">
        <div className="vp-filters" role="search">
          <input className="vp-search" type="search" placeholder="Search name, code, contact, email, phone, GSTIN" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search vendors" />
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status">
            <option value="">Active or switched off</option>
            {(fc.status || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
          </select>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Category">
            <option value="">All categories</option>
            {(fc.category || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
          </select>
          <select value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} aria-label="Login">
            <option value="">With or without a login</option>
            {(fc.login || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
          </select>
          {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', status: '', category: '', login: '' })}>Clear</button>}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setForm({ row: null })}>+ Add vendor</button>
      </div>

      {!data ? <div className="empty-mini">Loading…</div> : !rows.length ? (
        <div className="vp-empty">
          {data.total ? <><h3>No vendor matches these filters</h3><p>Clear the filters to see all {data.total}.</p></>
            : <><h3>No vendors yet</h3><p>Press “+ Add vendor”. A vendor added here also shows in Office &amp; Accounts, and the other way round.</p></>}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Code</th><th>Vendor</th><th>Contact</th><th>GSTIN</th><th>Category</th><th>Status</th><th className="num">Logins</th><th className="num">Bills to pay</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.isActive ? '' : 'vm-off'}>
                  <td>{r.vendorCode || <span className="cell-muted">—</span>}</td>
                  <td><strong>{r.name}</strong>{r.companyName && r.companyName !== r.name && <div className="cell-muted">{r.companyName}</div>}</td>
                  <td>{r.contactPerson || '—'}{r.phone && <div className="cell-muted">{r.phone}</div>}</td>
                  <td>{r.gstin || <span className="cell-muted">—</span>}</td>
                  <td>{r.category || <span className="cell-muted">—</span>}</td>
                  <td><span className={`vp-tag vp-${r.isActive ? 'green' : 'grey'}`}>{r.statusText}</span></td>
                  <td className="num">{r.logins}</td>
                  <td className="num">{r.unpaidBills}</td>
                  <td><button type="button" className="btn btn-sm btn-primary" onClick={() => setOpenId(r.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PostingCard onSaved={onSaved} onError={onError} />

      {form && (
        <VendorForm
          row={form.row}
          onClose={() => setForm(null)}
          onSaved={(msg, vendor) => { setForm(null); onSaved(msg); load(); if (vendor && !form.row) setOpenId(vendor.id); }}
        />
      )}
      {openId && (
        <VendorDetail
          id={openId}
          onClose={() => { setOpenId(null); load(); }}
          onChanged={load}
          onSaved={onSaved}
          onError={onError}
          onOpenLogins={onOpenLogins}
          onLink={onLink}
        />
      )}
    </div>
  );
}

// ---- add / edit ---------------------------------------------------------------
function VendorForm({ row, onClose, onSaved }) {
  const isNew = !row;
  const [v, setV] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, row[k] || ''])) : { ...BLANK }));
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fieldErr, setFieldErr] = useState({});
  const [warn, setWarn] = useState(null); // a possible duplicate the user can confirm
  const set = (k) => (e) => { setV({ ...v, [k]: e.target.value }); setFieldErr({ ...fieldErr, [k]: undefined }); setWarn(null); };
  useEffect(() => { api.get('/vendor-master/categories').then((r) => setCats(r.data.map((c) => c.name))).catch(() => {}); }, []);

  async function save(confirmDuplicate) {
    setErr('');
    if (!v.name.trim()) { setFieldErr({ name: 'Write the vendor name.' }); return; }
    const g = cleanId(v.gstin);
    if (g) { const c = checkGstin(g); if (!c.ok) { setFieldErr({ gstin: c.error }); return; } }
    setBusy(true);
    const body = { ...v, gstin: g, pan: cleanId(v.pan), confirmDuplicate: confirmDuplicate === true };
    try {
      const res = isNew ? await api.post('/vendor-master', body) : await api.patch(`/vendor-master/${row.id}`, body);
      onSaved(res.data.message, res.data.vendor);
    } catch (e) {
      const d = e.response?.data || {};
      if (e.response?.status === 409 && d.warning) setWarn(d);
      else if (d.field) setFieldErr({ [d.field]: d.error });
      else setErr(errText(e, 'The vendor could not be saved.'));
      setBusy(false);
    }
  }
  const field = (k, label, props = {}) => (
    <div className={`vm-f${fieldErr[k] ? ' vm-bad' : ''}${props.full ? ' vm-full' : ''}`}>
      <label htmlFor={`vm-${k}`}>{label}</label>
      {props.area
        ? <textarea id={`vm-${k}`} rows={2} value={v[k]} maxLength={props.max || 500} onChange={set(k)} />
        : <input id={`vm-${k}`} value={v[k]} maxLength={props.max || 160} onChange={k === 'gstin' || k === 'pan' ? (e) => set(k)({ target: { value: e.target.value.toUpperCase().replace(/\s+/g, '') } }) : set(k)} list={props.list} type={props.type || 'text'} placeholder={props.ph} />}
      {fieldErr[k] && <em className="vm-err">{fieldErr[k]}</em>}
    </div>
  );
  return (
    <Modal
      title={isNew ? 'Add vendor' : `Edit · ${row.name}`}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {warn
            ? <button type="button" className="btn btn-primary" onClick={() => save(true)} disabled={busy}>Yes, it is a different vendor — save</button>
            : <button type="button" className="btn btn-primary" onClick={() => save(false)} disabled={busy}>{busy ? 'Saving…' : 'Save vendor'}</button>}
        </>
      )}
    >
      <div className="vm-grid">
        {field('name', 'Vendor name *', { max: 120, ph: 'e.g. Sri Sai Stationers' })}
        {field('companyName', 'Company name', { max: 160 })}
        {field('contactPerson', 'Contact person', { max: 120 })}
        {field('phone', 'Phone', { max: 30, type: 'tel' })}
        {field('email', 'Email', { max: 160, type: 'email' })}
        {field('gstin', 'GSTIN', { max: 15, ph: '15 characters, optional' })}
        {field('pan', 'PAN', { max: 10, ph: '10 characters, optional' })}
        {field('category', 'Category', { max: 60, list: 'vm-cats', ph: 'e.g. Internet, Rent, Stationery' })}
        <datalist id="vm-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        {field('paymentTerms', 'Payment terms', { max: 200, list: 'vm-terms', ph: 'e.g. Net 30' })}
        <datalist id="vm-terms">{TERMS.map((t) => <option key={t} value={t} />)}</datalist>
        {field('address', 'Address', { area: true, full: true })}
        {field('notes', 'Notes (only your team sees these)', { area: true, full: true, max: 1000 })}
      </div>
      {warn && <div className="notice amber" style={{ marginTop: 10 }}><span>{warn.error}</span></div>}
      {err && <div className="notice red" style={{ marginTop: 10 }}><span>{err}</span></div>}
    </Modal>
  );
}

// ---- one vendor ---------------------------------------------------------------
function VendorDetail({ id, onClose, onChanged, onSaved, onError, onOpenLogins, onLink }) {
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(false);
  const [loginFor, setLoginFor] = useState(false);
  const [offAsk, setOffAsk] = useState(false);
  const fileRef = useRef(null);
  const [doc, setDoc] = useState({ title: '', docType: 'Other', note: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    api.get(`/vendor-master/${id}`).then((r) => setD(r.data)).catch((e) => onError(errText(e, 'Could not open the vendor.')));
  }, [id, onError]);
  useEffect(() => { load(); }, [load]);
  const done = (m) => { setMsg(m); onSaved(m); load(); onChanged(); };
  const v = d?.vendor;

  async function link(login) {
    try {
      const res = await api.post(`/vendor-logins/${login.id}/invite`, {});
      onLink({ email: login.email, link: res.data.inviteLink, expiresAt: res.data.inviteExpiresAt, emailed: res.data.emailed });
      done(res.data.message);
    } catch (e) { onError(errText(e, 'Could not make the link.')); }
  }
  async function linkBills() {
    try { const res = await api.post(`/vendor-master/${id}/link-bills`, { all: true }); done(res.data.message); } catch (e) { onError(errText(e, 'Could not link the bills.')); }
  }
  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setMsg('Choose a file first (PDF, JPG or PNG).'); return; }
    setBusy(true);
    const fd = new FormData();
    fd.append('title', doc.title); fd.append('docType', doc.docType); fd.append('note', doc.note); fd.append('file', file);
    try {
      const res = await api.post(`/vendor-master/${id}/documents`, fd);
      setDoc({ title: '', docType: 'Other', note: '' }); if (fileRef.current) fileRef.current.value = '';
      done(res.data.message);
    } catch (e) { setMsg(errText(e, 'Could not share the file.')); } finally { setBusy(false); }
  }
  async function stopShare(x) {
    if (!window.confirm(`Stop sharing “${x.title}” with this vendor?`)) return;
    try { const res = await api.delete(`/vendor-master/${id}/documents/${x.id}`); done(res.data.message); } catch (e) { onError(errText(e, 'Could not stop sharing.')); }
  }
  async function openDoc(x) {
    try {
      const res = await api.get(`/vendor-master/${id}/documents/${x.id}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { onError(errText(e, 'Could not open the file.')); }
  }

  return (
    <Modal title={v ? `${v.name}${v.vendorCode ? ` · ${v.vendorCode}` : ''}` : 'Vendor'} size="xwide" onClose={onClose}>
      {!d ? <div className="empty-mini">Loading…</div> : (
        <div className="vm-detail">
          {msg && <div className="notice green"><span>{msg}</span></div>}
          {!v.isActive && <div className="notice amber"><span>This vendor is switched off{v.deactivationReason ? ` (${v.deactivationReason})` : ''}. It cannot get new bills and its logins are signed out. Nothing is deleted.</span></div>}

          <section>
            <div className="vm-sec-h"><h4>Details</h4><button type="button" className="btn btn-sm" onClick={() => setEdit(true)}>Edit</button></div>
            <dl className="vm-dl">
              {[['Company name', v.companyName], ['Contact person', v.contactPerson], ['Phone', v.phone], ['Email', v.email], ['GSTIN', v.gstin], ['PAN', v.pan], ['Category', v.category], ['Payment terms', v.paymentTerms], ['Address', v.address], ['Notes', v.notes]]
                .map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x || '—'}</dd></div>)}
            </dl>
          </section>

          <section>
            <div className="vm-sec-h"><h4>Bills and payments</h4></div>
            <div className="vm-tiles">
              <div><span>Billed (after TDS)</span><b>{inr(d.invoiceSummary.invoiced)}</b></div>
              <div><span>Paid</span><b className="vm-green">{inr(d.invoiceSummary.paid)}</b></div>
              <div><span>Still to pay</span><b className="vm-orange">{inr(d.invoiceSummary.outstanding)}</b></div>
              <div><span>TDS deducted</span><b>{inr(d.invoiceSummary.tds)}</b></div>
            </div>
            {d.unlinkedBills.count > 0 && (
              <div className="notice amber" style={{ margin: '8px 0' }}>
                <span>{d.unlinkedBills.count} older bill(s) were typed with this vendor&apos;s name but are not linked to it yet. </span>
                <button type="button" className="btn btn-sm btn-primary" onClick={linkBills} disabled={!v.isActive}>Link these bills to {v.name}</button>
              </div>
            )}
            {!d.invoices.length ? <div className="vp-none">No bills for this vendor yet.</div> : (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Bill no.</th><th>Date</th><th className="num">Amount</th><th className="num">GST</th><th className="num">TDS</th><th className="num">To pay</th><th>Status</th><th>Paid on</th><th className="num">Still to pay</th></tr></thead>
                  <tbody>
                    {d.invoices.map((r) => (
                      <tr key={r.key}>
                        <td>{r.billNumber || r.billCode || '—'}{r.source === 'Vendor Portal' && <div className="cell-muted">sent by the vendor</div>}</td>
                        <td>{when(r.billDate)}</td>
                        <td className="num">{inr(r.amount)}</td><td className="num">{inr(r.gst)}</td><td className="num">{inr(r.tds)}</td><td className="num">{inr(r.netPayable)}</td>
                        <td><span className={`vp-tag vp-${r.paid ? 'green' : (r.status === 'REJECTED' || r.status === 'WITHDRAWN' ? 'grey' : 'yellow')}`}>{r.statusText}</span></td>
                        <td>{when(r.paymentDate)}</td>
                        <td className="num">{inr(r.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <div className="vm-sec-h"><h4>Vendor login</h4>
              <span>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setLoginFor(true)} disabled={!v.isActive}>+ Create login</button>{' '}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onClose(); onOpenLogins(); }}>Assets and other login settings</button>
              </span>
            </div>
            {!d.logins.length ? <div className="vp-none">No login yet. Create one — the vendor gets a secure link and chooses their own password.</div> : (
              <ul className="vm-list">
                {d.logins.map((l) => (
                  <li key={l.id}>
                    <span><b>{l.name}</b> · {l.email} <span className={`vp-tag vp-${l.status !== 'Active' ? 'grey' : (l.locked ? 'red' : 'green')}`}>{l.status !== 'Active' ? 'Switched off' : (l.locked ? 'Locked' : 'Active')}</span>
                      <span className="cell-muted"> · last sign-in {when(l.lastLoginAt)}</span></span>
                    {l.status === 'Active' && <button type="button" className="btn btn-sm" onClick={() => link(l)}>{l.lastLoginAt ? 'Send reset link' : 'Send invite link'}</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="vm-sec-h"><h4>Documents shared with this vendor</h4></div>
            <div className="vm-share">
              <input type="file" ref={fileRef} accept=".pdf,.jpg,.jpeg,.png" aria-label="File to share" />
              <input value={doc.title} maxLength={120} placeholder="Name (e.g. Agreement 2026)" onChange={(e) => setDoc({ ...doc, title: e.target.value })} aria-label="Document name" />
              <select value={doc.docType} onChange={(e) => setDoc({ ...doc, docType: e.target.value })} aria-label="Type">{d.docTypes.map((t) => <option key={t}>{t}</option>)}</select>
              <button type="button" className="btn btn-primary" onClick={upload} disabled={busy}>{busy ? 'Sharing…' : 'Share with vendor'}</button>
            </div>
            {!d.documents.length ? <div className="vp-none">Nothing shared yet.</div> : (
              <ul className="vm-list">
                {d.documents.map((x) => (
                  <li key={x.id}>
                    <span><b>{x.title}</b> <span className="cell-muted">· {x.docType} · {x.name} · shared {when(x.createdAt)} by {x.sharedByName || '—'}</span></span>
                    <span><button type="button" className="btn btn-sm" onClick={() => openDoc(x)}>Open</button>{' '}<button type="button" className="btn btn-sm btn-ghost" onClick={() => stopShare(x)}>Stop sharing</button></span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="vm-danger">
            {v.isActive
              ? <button type="button" className="btn btn-danger" onClick={() => setOffAsk(true)}>Switch this vendor off</button>
              : <button type="button" className="btn btn-primary" onClick={async () => { try { const res = await api.post(`/vendor-master/${id}/activate`, {}); done(res.data.message); } catch (e) { onError(errText(e, 'Could not switch on.')); } }}>Switch this vendor on again</button>}
            <span className="cell-muted"> A vendor is never deleted — switching off keeps every bill and record.</span>
          </section>

          {edit && <VendorForm row={v} onClose={() => setEdit(false)} onSaved={(m) => { setEdit(false); done(m); }} />}
          {loginFor && <NewLogin vendor={v} onClose={() => setLoginFor(false)} onDone={(res) => { setLoginFor(false); if (res.inviteLink) onLink({ email: res.login.email, link: res.inviteLink, expiresAt: res.inviteExpiresAt, emailed: res.emailed }); done(res.message); }} />}
          {offAsk && <SwitchOff vendor={v} onClose={() => setOffAsk(false)} onDone={(m) => { setOffAsk(false); done(m); }} />}
        </div>
      )}
    </Modal>
  );
}

function NewLogin({ vendor, onClose, onDone }) {
  const [name, setName] = useState(vendor.contactPerson || '');
  const [email, setEmail] = useState(vendor.email || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setErr('');
    if (!name.trim() || !email.trim()) { setErr('Write the contact name and email.'); return; }
    setBusy(true);
    try { const res = await api.post('/vendor-logins', { vendorId: vendor.id, name, email, invite: true }); onDone(res.data); } catch (e) { setErr(errText(e, 'Could not create the login.')); setBusy(false); }
  }
  return (
    <Modal title={`Create login · ${vendor.name}`} onClose={onClose} footer={(<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Creating…' : 'Create and get the secure link'}</button></>)}>
      <div className="vm-grid">
        <div className="vm-f"><label htmlFor="nl-n">Contact name</label><input id="nl-n" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
        <div className="vm-f"><label htmlFor="nl-e">Email (their username)</label><input id="nl-e" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      </div>
      <div className="small-muted" style={{ marginTop: 8 }}>You will get a secure link to send to the vendor. They choose their own password; the link works once and runs out in 3 days. Add assets for them later under “Assets and other login settings”.</div>
      {err && <div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div>}
    </Modal>
  );
}

function SwitchOff({ vendor, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  async function go() {
    try { const res = await api.post(`/vendor-master/${vendor.id}/deactivate`, { reason }); onDone(res.data.message); } catch (e) { setErr(errText(e, 'Could not switch off.')); }
  }
  return (
    <Modal title={`Switch off · ${vendor.name}`} onClose={onClose} footer={(<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-danger" onClick={go}>Switch off</button></>)}>
      <div className="small-muted">The vendor and all its logins are signed out at once and cannot sign in. Every bill and record is kept. You can switch it on again.</div>
      <label htmlFor="so-r" style={{ display: 'block', marginTop: 8 }}>Why?</label>
      <input id="so-r" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. contract ended" />
      {err && <div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div>}
    </Modal>
  );
}

// ---- journal posting switch ------------------------------------------------------
function PostingCard({ onSaved, onError }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/vendor-master/journal-posting/status').then((r) => setS(r.data)).catch(() => {}); }, []);
  if (!s) return null;
  async function toggle(on) {
    setBusy(true);
    try { const r = await api.put('/vendor-master/journal-posting/status', { enabled: on }); setS((x) => ({ ...x, ...r.data })); onSaved(r.data.message); } catch (e) { onError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true);
    try { const r = await api.post('/vendor-master/journal-posting/sync', {}); onSaved(r.data.message); } catch (e) { onError(errText(e, 'Could not post.')); } finally { setBusy(false); }
  }
  return (
    <div className="card vm-post">
      <label className="vl-switch">
        <input type="checkbox" checked={!!s.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        <span><strong>Post vendor bills to the accounts journal</strong><br />
          <span className="cell-muted">Off by default. When on, a bill linked to a vendor is booked when it is approved and again when it is paid (expense + GST against “Vendor Payable”, TDS to “TDS Payable - Vendors”, payment out of Bank). Vendors never see the journal.</span></span>
      </label>
      {s.enabled && <button type="button" className="btn btn-sm" onClick={run} disabled={busy}>Post any missing bills now</button>}
    </div>
  );
}

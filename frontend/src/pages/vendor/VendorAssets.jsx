import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import Modal from '../../components/Modal.jsx';
import vendorApi, {
  setVendorToken, vendorToken, vendorError, vendorDownload, VENDOR_NOTICE_KEY,
} from '../../vendorApi';
import { PW_HINT } from './VendorLogin.jsx';
import './vendorPortal.css';

// /vendor/assets — the vendor's ONLY page (P3, v2). "These are my assigned
// assets": a top bar, the filters, the table, and a drawer per asset. No
// sidebar, no dashboard. What the vendor may change is decided by the server
// (Allow editing / Show purchase value on their login). Search, filters,
// sort and pages all run on the server inside the vendor's scope.

const inr = (n) => (n == null || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
// Dates read DD-MM-YYYY everywhere on the portal (spec v2 §18).
const two = (n) => String(n).padStart(2, '0');
const day = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
};
const when = (s) => (s ? `${day(s)} ${two(new Date(s).getHours())}:${two(new Date(s).getMinutes())}` : '—');
const today = () => new Date().toISOString().slice(0, 10);
const daysTo = (s) => (s ? Math.round((new Date(`${s}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000) : null);
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// Colours: green good, yellow waiting, red problem, blue going on, grey closed.
const ASSET_TONE = { Available: 'green', Assigned: 'blue', 'In Repair': 'yellow', Retired: 'grey', Sold: 'grey', 'Written off': 'grey' };
const BILL_TONE = { PENDING_REVIEW: 'yellow', VERIFIED: 'blue', APPROVED: 'green', PAID: 'green', REJECTED: 'red', WITHDRAWN: 'grey' };
const REPAIR_TONE = { Reported: 'yellow', 'In Repair': 'blue', Completed: 'green', Cancelled: 'grey' };
const Tag = ({ tone, children }) => <span className={`vp-tag vp-${tone || 'grey'}`}>{children}</span>;

function Expiry({ value, label }) {
  if (!value) return null;
  const d = daysTo(value);
  const tone = d < 0 ? 'red' : (d <= 30 ? 'yellow' : null);
  return (
    <div className="vp-exp">
      <span className="vp-exp-l">{label}</span> {day(value)}
      {tone && <Tag tone={tone}>{d < 0 ? 'Expired' : `${d} days left`}</Tag>}
    </div>
  );
}

const BLANK = { q: '', category: '', status: '', dateField: 'purchase', from: '', to: '' };
const COLS = [
  ['assetCode', 'Asset ID'], ['name', 'Asset name'], ['category', 'Category'], ['serialNumber', 'Serial no.'], ['purchaseDate', 'Purchase date'],
  ['invoiceNo', 'Invoice no.'], ['warrantyUntil', 'Warranty / AMC ends'], ['location', 'Location'], ['status', 'Status'], ['updatedAt', 'Last updated'],
];

export default function VendorAssets() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [f, setF] = useState(BLANK);
  const [qDeb, setQDeb] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'assetCode', dir: 'asc' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [toast, setToast] = useState('');

  const signOut = useCallback(async (notice) => {
    try { await vendorApi.post('/logout'); } catch { /* already out */ }
    setVendorToken(null);
    if (notice) { try { sessionStorage.setItem(VENDOR_NOTICE_KEY, notice); } catch { /* ignore */ } }
    navigate('/vendor-login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!vendorToken()) { navigate('/vendor-login', { replace: true }); return; }
    vendorApi.get('/me').then((r) => {
      if (r.data.mustChangePassword) navigate('/vendor-login', { replace: true });
      else { setMe(r.data); if (r.data.idleMinutes) setIdleMinutes(r.data.idleMinutes); }
    }).catch(() => {});
  }, [navigate]);

  // Idle for the server's limit without a click or a key: signed out here too.
  const last = useRef(Date.now());
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    const evs = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last.current > idleMinutes * 60000) signOut(`Your session expired after ${idleMinutes} minutes without activity. Please sign in again.`);
    }, 30000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [signOut, idleMinutes]);

  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  useEffect(() => { setPage(1); }, [qDeb, f.category, f.status, f.dateField, f.from, f.to, sort.key, sort.dir]);

  const load = useCallback(() => {
    if (!me) return;
    setLoading(true);
    vendorApi.get('/assets', {
      params: {
        q: qDeb || undefined, category: f.category || undefined, status: f.status || undefined,
        dateField: f.dateField, from: f.from || undefined, to: f.to || undefined, page, sort: sort.key, dir: sort.dir,
      },
    }).then((r) => { setData(r.data); setError(''); })
      .catch((err) => setError(vendorError(err, 'Could not load your assets.')))
      .finally(() => setLoading(false));
  }, [me, qDeb, f.category, f.status, f.dateField, f.from, f.to, page, sort]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  const rows = data?.rows || [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = !!(f.q || f.category || f.status || f.from || f.to);
  const showCost = !!data?.canViewCost;
  const sortable = new Set(data?.sortable || []);
  const sortBy = (key) => { if (!sortable.has(key)) return; setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' })); };
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const invoiceOf = (a) => (showCost ? (a.invoiceNo || '—') : '—');

  return (
    <div className="vp-page">
      <header className="vp-top">
        <div className="vp-brand"><TeamLinkMark width={104} /><span className="vp-top-title">Vendor Portal</span></div>
        <div className="vp-top-right">
          <span className="vp-top-name" title={me?.email}>{me?.vendorName}{me?.name ? <small> · {me.name}</small> : null}</span>
          <button type="button" className="btn btn-sm" onClick={() => setPwOpen(true)}>Change password</button>
          <button type="button" className="btn btn-sm" onClick={() => signOut()}>Logout</button>
        </div>
      </header>

      <main className="vp-main">
        <div className="vp-head">
          <h1>Your assets</h1>
          <div className="page-sub">
            These are the assets assigned to you. Tap one to see its details{data?.canEdit ? ', update it, or send a bill' : ''}.
            {data && !data.canEdit && ' Your login is view-only.'}
          </div>
        </div>

        <div className="vp-filters" role="search">
          <input className="vp-search" type="search" placeholder={showCost ? 'Search asset ID, name, serial no., invoice no.' : 'Search asset ID, name, serial no.'} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search" />
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Category">
            <option value="">All categories</option>
            {(data?.facets?.category || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
          </select>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status">
            <option value="">All statuses</option>
            {(data?.facets?.status || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
          </select>
          <div className="vp-dates">
            <select value={f.dateField} onChange={(e) => setF({ ...f, dateField: e.target.value })} aria-label="Which date">
              <option value="purchase">Purchase date</option>
              <option value="warranty">Warranty ends</option>
              <option value="amc">AMC ends</option>
              <option value="updated">Last updated</option>
            </select>
            <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From date" />
            <span className="vp-to">to</span>
            <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To date" />
          </div>
          {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF(BLANK)}>Clear</button>}
        </div>

        {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}

        {!loading && data && !rows.length ? (
          <div className="vp-empty">
            {data.assignedTotal
              ? <><h3>No asset matches these filters</h3><p>Clear the filters to see all {data.assignedTotal} of your assets.</p></>
              : <><h3>No assets are assigned to you yet.</h3><p>Please contact TeamLink Accounts.</p></>}
          </div>
        ) : (
          <>
            <div className="tbl-wrap vp-table">
              <table>
                <thead>
                  <tr>
                    {COLS.map(([key, label]) => (
                      <th key={key} className={sortable.has(key) ? 'vp-sort' : ''} onClick={() => sortBy(key)} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                        {label}{arrow(key)}
                      </th>
                    ))}
                    {showCost && <th className="num vp-sort" onClick={() => sortBy('purchaseCost')}>Purchase value{arrow('purchaseCost')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {loading && !rows.length && <tr><td colSpan={showCost ? 11 : 10} className="cell-muted">Loading your assets…</td></tr>}
                  {rows.map((a) => (
                    <tr key={a.id} className="vp-row" onClick={() => setOpenId(a.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(a.id); }}>
                      <td><strong>{a.assetCode}</strong></td>
                      <td>{a.name}</td>
                      <td>{a.category || '—'}</td>
                      <td>{a.serialNumber || '—'}</td>
                      <td>{day(a.purchaseDate)}</td>
                      <td>{invoiceOf(a)}</td>
                      <td>
                        {a.warrantyUntil || a.amcUntil ? (
                          <><Expiry value={a.warrantyUntil} label="Warranty" /><Expiry value={a.amcUntil} label="AMC" /></>
                        ) : '—'}
                      </td>
                      <td>{a.location || '—'}</td>
                      <td><Tag tone={ASSET_TONE[a.status]}>{a.status}</Tag></td>
                      <td>{day(a.updatedAt)}</td>
                      {showCost && <td className="num">{inr(a.purchaseCost)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phones: the same rows as cards. */}
            <div className="vp-cards">
              {rows.map((a) => (
                <button type="button" key={a.id} className="vp-card" onClick={() => setOpenId(a.id)}>
                  <div className="vp-card-top"><strong>{a.assetCode}</strong><Tag tone={ASSET_TONE[a.status]}>{a.status}</Tag></div>
                  <div className="vp-card-name">{a.name}</div>
                  <div className="vp-card-meta">{a.category || '—'}{a.serialNumber ? ` · S/N ${a.serialNumber}` : ''}{a.location ? ` · ${a.location}` : ''}</div>
                  <Expiry value={a.warrantyUntil} label="Warranty" />
                  <Expiry value={a.amcUntil} label="AMC" />
                  {showCost && <div className="vp-card-meta">Purchase value {inr(a.purchaseCost)}</div>}
                </button>
              ))}
            </div>

            {data && data.total > data.pageSize && (
              <div className="vp-pager">
                <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Back</button>
                <span>Page {page} of {pages} · {data.total} assets</span>
                <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button>
              </div>
            )}
            {data && data.total <= data.pageSize && rows.length > 0 && <div className="vp-count">{data.total} {data.total === 1 ? 'asset' : 'assets'}</div>}
          </>
        )}
      </main>

      {openId && (
        <AssetDrawer id={openId} onClose={() => setOpenId(null)} onSaved={(msg) => { setToast(msg); load(); }} />
      )}
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); setToast('Password changed.'); }} />}
      {toast && <div className="vp-toast" role="status">{toast}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
function PasswordModal({ onClose, onDone }) {
  const [v, setV] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setError('');
    if (v.newPassword !== v.confirmPassword) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try { await vendorApi.post('/change-password', v); onDone(); } catch (err) { setError(vendorError(err, 'Could not change the password.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="Change password" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Change password'}</button></>}>
      <div className="vp-form">
        <label htmlFor="cpCur">Current password</label>
        <input id="cpCur" type="password" autoComplete="current-password" value={v.currentPassword} onChange={(e) => setV({ ...v, currentPassword: e.target.value })} />
        <label htmlFor="cpNew">New password</label>
        <input id="cpNew" type="password" autoComplete="new-password" value={v.newPassword} onChange={(e) => setV({ ...v, newPassword: e.target.value })} />
        <div className="small-muted" style={{ fontSize: 12 }}>{PW_HINT} Not one of your last 3.</div>
        <label htmlFor="cpNew2">New password again</label>
        <input id="cpNew2" type="password" autoComplete="new-password" value={v.confirmPassword} onChange={(e) => setV({ ...v, confirmPassword: e.target.value })} />
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function AssetDrawer({ id, onClose, onSaved }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [billOpen, setBillOpen] = useState(null); // { parent } | null
  const [billEdit, setBillEdit] = useState(null);
  const [docOpen, setDocOpen] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    vendorApi.get(`/assets/${id}`).then((r) => { setD(r.data); setError(''); })
      .catch((err) => setError(vendorError(err, 'Could not open this asset.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !billOpen && !docOpen && !billEdit) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, billOpen, docOpen, billEdit]);

  const a = d?.asset;
  const download = (url, name) => vendorDownload(url, name).catch((err) => setError(vendorError(err, 'Could not download the file.')));
  async function withdraw(b) {
    if (!window.confirm(`Withdraw bill ${b.billNumber}? Accounts will not look at it. You can send a new bill later.`)) return;
    setBusyId(b.id);
    try { const r = await vendorApi.post(`/bills/${b.id}/withdraw`); onSaved(r.data.message); load(); } catch (err) { setError(vendorError(err, 'Could not withdraw.')); } finally { setBusyId(''); }
  }

  return (
    <div className="vp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="vp-drawer" role="dialog" aria-label="Asset details">
        <div className="vp-drawer-head">
          <div>
            <div className="vp-drawer-code">{a?.assetCode || '…'}</div>
            <h2>{a?.name || 'Loading…'}</h2>
          </div>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <div className="notice red" style={{ margin: '0 0 10px' }}><span>{error}</span></div>}
        {!a && !error && <div className="empty-mini">Loading…</div>}
        {a && (
          <div className="vp-drawer-body">
            {d.canEdit && (
              <div className="vp-actions">
                <button type="button" className="btn btn-primary" onClick={() => setBillOpen({ parent: null })}>+ Add Bill</button>
                <button type="button" className="btn" onClick={() => setEditing(true)}>Update details</button>
                <button type="button" className="btn" onClick={() => setDocOpen(true)}>Upload document</button>
              </div>
            )}

            <section className="vp-sec">
              <h3>Asset details</h3>
              {editing ? (
                <EditForm asset={a} onCancel={() => setEditing(false)} onSaved={(msg) => { setEditing(false); load(); onSaved(msg); }} onStale={() => { load(); }} />
              ) : (
                <dl className="vp-dl">
                  <dt>Asset ID</dt><dd>{a.assetCode}</dd>
                  <dt>Name</dt><dd>{a.name}</dd>
                  <dt>Category</dt><dd>{a.category || '—'}{a.assetType ? ` · ${a.assetType}` : ''}</dd>
                  <dt>Serial no.</dt><dd>{a.serialNumber || '—'}</dd>
                  <dt>Purchase date</dt><dd>{day(a.purchaseDate)}</dd>
                  {d.canViewCost && <><dt>Invoice no.</dt><dd>{a.invoiceNo || '—'}</dd></>}
                  <dt>Warranty ends</dt><dd>{a.warrantyUntil ? <Expiry value={a.warrantyUntil} label="" /> : '—'}</dd>
                  <dt>AMC ends</dt><dd>{a.amcUntil ? <Expiry value={a.amcUntil} label="" /> : '—'}</dd>
                  <dt>Location</dt><dd>{a.location || '—'}</dd>
                  <dt>Status</dt><dd><Tag tone={ASSET_TONE[a.status]}>{a.status}</Tag></dd>
                  <dt>Service remarks</dt>
                  <dd className="vp-pre">{a.serviceRemarks || '—'}{a.serviceRemarks && d.serviceRemarksBy && <div className="cell-muted">by {d.serviceRemarksBy.by} · {when(d.serviceRemarksBy.at)}</div>}</dd>
                  {d.canViewCost && <><dt>Purchase value</dt><dd>{inr(a.purchaseCost)}</dd></>}
                  <dt>Last updated</dt><dd>{day(a.updatedAt)}</dd>
                </dl>
              )}
            </section>

            <section className="vp-sec">
              <h3>Documents</h3>
              {d.documents.length ? (
                <ul className="vp-list">
                  {d.documents.map((doc) => (
                    <li key={doc.id}>
                      <div><strong>{doc.docType}</strong> · {doc.name}<div className="cell-muted">{day(doc.createdAt)}{doc.byYou ? ' · uploaded by you' : ''}</div></div>
                      <button type="button" className="btn btn-sm" onClick={() => download(`/assets/${a.id}/documents/${doc.id}/file`, doc.name)}>Download</button>
                    </li>
                  ))}
                </ul>
              ) : <div className="vp-none">No documents yet.{d.canEdit ? ' Use "Upload document" to add a warranty card, AMC contract or service report.' : ''}</div>}
            </section>

            <section className="vp-sec">
              <h3>Service history</h3>
              {d.serviceHistory.length ? (
                <ul className="vp-list">
                  {d.serviceHistory.map((r) => (
                    <li key={r.id}>
                      <div>
                        <strong>{r.repairType}</strong> · {r.issue || 'No details'}
                        <div className="cell-muted">{r.repairNo} · reported {day(r.dateReported)}{r.repairDate ? ` · done ${day(r.repairDate)}` : ''}{r.underWarranty ? ' · under warranty' : ''}{r.byYou ? ' · by you' : ''}</div>
                      </div>
                      <Tag tone={REPAIR_TONE[r.status]}>{r.status}</Tag>
                    </li>
                  ))}
                </ul>
              ) : <div className="vp-none">No service or repair recorded for this asset yet.</div>}
            </section>

            <section className="vp-sec">
              <h3>Your bills for this asset</h3>
              {d.bills.length ? (
                <ul className="vp-list">
                  {d.bills.map((b) => (
                    <li key={b.id}>
                      <div>
                        <strong>{b.billNumber}</strong> · {day(b.billDate)} · {inr(b.total)}
                        <div className="cell-muted">{b.billCode}{b.version > 1 ? ` · version ${b.version}` : ''} · sent {day(b.submittedAt)}{b.tds ? ` · TDS ${inr(b.tds)}` : ''}</div>
                        {b.rejectionReason && <div className="vp-reason">Why rejected: {b.rejectionReason}</div>}
                        <div className="vp-files">
                          {b.document && <button type="button" className="link-btn" onClick={() => download(`/bills/${b.id}/document`, b.document.name)}>Bill file</button>}
                          {b.supporting.map((s) => <button type="button" key={s.index} className="link-btn" onClick={() => download(`/bills/${b.id}/supporting/${s.index}`, s.name)}>{s.name}</button>)}
                        </div>
                        {d.canEdit && (b.canEdit || b.canWithdraw || b.canResubmit) && (
                          <div className="vp-bill-acts">
                            {b.canEdit && <button type="button" className="btn btn-sm" onClick={() => setBillEdit(b)}>Edit</button>}
                            {b.canWithdraw && <button type="button" className="btn btn-sm btn-danger" disabled={busyId === b.id} onClick={() => withdraw(b)}>Withdraw</button>}
                            {b.canResubmit && <button type="button" className="btn btn-sm btn-primary" onClick={() => setBillOpen({ parent: b })}>Send corrected bill</button>}
                          </div>
                        )}
                      </div>
                      <Tag tone={BILL_TONE[b.status]}>{b.statusText}</Tag>
                    </li>
                  ))}
                </ul>
              ) : <div className="vp-none">No bills sent for this asset yet.{d.canEdit ? ' Use "+ Add Bill" to send one.' : ''}</div>}
            </section>
          </div>
        )}
      </aside>
      {billOpen && a && (
        <BillModal asset={a} parent={billOpen.parent} onClose={() => setBillOpen(null)} onSaved={(msg) => { setBillOpen(null); load(); onSaved(msg); }} />
      )}
      {billEdit && a && (
        <BillEditModal asset={a} bill={billEdit} onClose={() => setBillEdit(null)} onSaved={(msg) => { setBillEdit(null); load(); onSaved(msg); }} />
      )}
      {docOpen && a && (
        <DocModal asset={a} onClose={() => setDocOpen(false)} onSaved={(msg) => { setDocOpen(false); load(); onSaved(msg); }} />
      )}
    </div>
  );
}

function EditForm({ asset, onCancel, onSaved, onStale }) {
  const [v, setV] = useState({
    serialNumber: asset.serialNumber || '', warrantyUntil: asset.warrantyUntil || '', amcUntil: asset.amcUntil || '', serviceRemarks: asset.serviceRemarks || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await vendorApi.patch(`/assets/${asset.id}`, { ...v, updatedAt: asset.updatedAt });
      onSaved(r.data.changed?.length ? 'Saved.' : 'Nothing changed.');
    } catch (err) {
      setError(vendorError(err, 'Could not save.'));
      if (err.response?.status === 409 && err.response.data?.stale) onStale();
    } finally { setBusy(false); }
  }
  return (
    <form className="vp-form" onSubmit={save}>
      <div className="small-muted" style={{ marginBottom: 8 }}>You can update only these four things. Every change is recorded.</div>
      <label htmlFor="vpSn">Serial number</label>
      <input id="vpSn" value={v.serialNumber} maxLength={120} onChange={(e) => setV({ ...v, serialNumber: e.target.value })} />
      <div className="vp-two">
        <div><label htmlFor="vpW">Warranty ends</label><input id="vpW" type="date" min={asset.purchaseDate || undefined} value={v.warrantyUntil} onChange={(e) => setV({ ...v, warrantyUntil: e.target.value })} /></div>
        <div><label htmlFor="vpA">AMC ends</label><input id="vpA" type="date" min={asset.purchaseDate || undefined} value={v.amcUntil} onChange={(e) => setV({ ...v, amcUntil: e.target.value })} /></div>
      </div>
      <label htmlFor="vpR">Service remarks</label>
      <textarea id="vpR" rows={3} maxLength={1000} value={v.serviceRemarks} onChange={(e) => setV({ ...v, serviceRemarks: e.target.value })} />
      {error && <div className="error-text">{error}</div>}
      <div className="vp-form-foot">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

const FILE_HINT = 'PDF, JPG or PNG, up to 10 MB each.';
const num = (x) => Number(String(x || '').replace(/[,\s]/g, '')) || 0;

function BillModal({ asset, parent, onClose, onSaved }) {
  const [v, setV] = useState({
    billNumber: parent ? parent.billNumber : '', billDate: parent ? parent.billDate : today(),
    amount: parent ? parent.amount : '', gst: parent ? parent.gst : '', tds: parent ? parent.tds : '', remarks: parent ? (parent.remarks || '') : '',
  });
  const [file, setFile] = useState(null);
  const [extra, setExtra] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(newKey); // one key per opening: a double click sends ONE bill
  const total = num(v.amount) + num(v.gst) - num(v.tds);
  async function send() {
    setError('');
    if (!v.billNumber.trim()) { setError('Enter the bill / invoice number.'); return; }
    if (!(num(v.amount) > 0)) { setError('Enter the bill amount before GST.'); return; }
    if (num(v.tds) > num(v.amount)) { setError('TDS cannot be more than the amount before GST.'); return; }
    if (!file) { setError('Attach the bill (PDF, JPG or PNG).'); return; }
    if (!window.confirm(`Send bill ${v.billNumber.trim()} for ${inr(total)}? Once Accounts verifies it you cannot edit it.`)) return;
    setBusy(true);
    try {
      const fd = new FormData();
      Object.entries(v).forEach(([k, x]) => fd.append(k, x));
      fd.append('file', file);
      const url = parent ? `/bills/${parent.id}/resubmit` : `/assets/${asset.id}/bills`;
      const r = await vendorApi.post(url, fd, { headers: { 'Idempotency-Key': key } });
      let failed = 0;
      for (const x of extra) {
        const sd = new FormData();
        sd.append('file', x);
        // eslint-disable-next-line no-await-in-loop
        try { await vendorApi.post(`/bills/${r.data.bill.id}/supporting`, sd); } catch { failed += 1; }
      }
      const warn = r.data.warning ? ` ${r.data.warning}` : '';
      onSaved(failed ? `Bill sent. ${failed} supporting file(s) could not be added.${warn}` : `${r.data.message}${warn}`);
    } catch (err) { setError(vendorError(err, 'Could not send the bill.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`${parent ? 'Send corrected bill' : 'Add bill'} · ${asset.assetCode}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send bill'}</button>
        </>
      )}
    >
      <div className="vp-form">
        <div className="small-muted" style={{ marginBottom: 8 }}>
          For {asset.name}. The company's Accounts team checks it before paying.
          {parent && <> This replaces the rejected bill {parent.billCode}{parent.rejectionReason ? ` (reason: ${parent.rejectionReason})` : ''}.</>}
        </div>
        <div className="vp-two">
          <div><label htmlFor="bNo">Bill / invoice number</label><input id="bNo" value={v.billNumber} maxLength={60} onChange={(e) => setV({ ...v, billNumber: e.target.value })} /></div>
          <div><label htmlFor="bDt">Bill date</label><input id="bDt" type="date" min={asset.purchaseDate || undefined} max={today()} value={v.billDate} onChange={(e) => setV({ ...v, billDate: e.target.value })} /></div>
        </div>
        <div className="vp-three">
          <div><label htmlFor="bAm">Amount before GST (₹)</label><input id="bAm" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></div>
          <div><label htmlFor="bGst">GST (₹)</label><input id="bGst" inputMode="decimal" value={v.gst} onChange={(e) => setV({ ...v, gst: e.target.value })} /></div>
          <div><label htmlFor="bTds">TDS, if any (₹)</label><input id="bTds" inputMode="decimal" value={v.tds} onChange={(e) => setV({ ...v, tds: e.target.value })} /></div>
        </div>
        <div className="vp-total">To be paid (amount + GST − TDS): <strong>{inr(total)}</strong> <span className="cell-muted">· the server works this out again</span></div>
        <label htmlFor="bRm">Description / remarks</label>
        <textarea id="bRm" rows={2} maxLength={1000} value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />
        <label htmlFor="bFile">The bill</label>
        <input id="bFile" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label htmlFor="bExtra">Supporting documents (optional, up to 5)</label>
        <input id="bExtra" type="file" multiple accept="application/pdf,image/png,image/jpeg" onChange={(e) => setExtra([...(e.target.files || [])].slice(0, 5))} />
        <div className="small-muted" style={{ fontSize: 12 }}>{FILE_HINT}</div>
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

function BillEditModal({ asset, bill, onClose, onSaved }) {
  const [v, setV] = useState({ billNumber: bill.billNumber, billDate: bill.billDate, amount: bill.amount, gst: bill.gst, tds: bill.tds, remarks: bill.remarks || '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const total = num(v.amount) + num(v.gst) - num(v.tds);
  async function save() {
    setBusy(true); setError('');
    try {
      await vendorApi.patch(`/bills/${bill.id}`, v);
      if (file) { const fd = new FormData(); fd.append('file', file); await vendorApi.post(`/bills/${bill.id}/document`, fd); }
      onSaved('Bill updated.');
    } catch (err) { setError(vendorError(err, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Edit bill ${bill.billNumber}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="vp-form">
        <div className="small-muted" style={{ marginBottom: 8 }}>You can change it until Accounts verifies it.</div>
        <div className="vp-two">
          <div><label htmlFor="eNo">Bill / invoice number</label><input id="eNo" value={v.billNumber} maxLength={60} onChange={(e) => setV({ ...v, billNumber: e.target.value })} /></div>
          <div><label htmlFor="eDt">Bill date</label><input id="eDt" type="date" min={asset.purchaseDate || undefined} max={today()} value={v.billDate} onChange={(e) => setV({ ...v, billDate: e.target.value })} /></div>
        </div>
        <div className="vp-three">
          <div><label htmlFor="eAm">Amount before GST (₹)</label><input id="eAm" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></div>
          <div><label htmlFor="eGst">GST (₹)</label><input id="eGst" inputMode="decimal" value={v.gst} onChange={(e) => setV({ ...v, gst: e.target.value })} /></div>
          <div><label htmlFor="eTds">TDS, if any (₹)</label><input id="eTds" inputMode="decimal" value={v.tds} onChange={(e) => setV({ ...v, tds: e.target.value })} /></div>
        </div>
        <div className="vp-total">To be paid: <strong>{inr(total)}</strong></div>
        <label htmlFor="eRm">Description / remarks</label>
        <textarea id="eRm" rows={2} maxLength={1000} value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />
        <label htmlFor="eFile">Replace the bill file (optional)</label>
        <input id="eFile" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

const DOC_TYPES = ['Warranty card', 'AMC contract', 'Service report', 'Invoice copy', 'Photo', 'Other'];
function DocModal({ asset, onClose, onSaved }) {
  const [docType, setDocType] = useState('Warranty card');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    if (!file) { setError('Choose the file to upload.'); return; }
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('docType', docType);
      fd.append('file', file);
      await vendorApi.post(`/assets/${asset.id}/documents`, fd);
      onSaved('Document uploaded.');
    } catch (err) { setError(vendorError(err, 'Could not upload.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Upload document · ${asset.assetCode}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        </>
      )}
    >
      <div className="vp-form">
        <div className="vp-lbl">What is it?</div>
        <div className="vp-choice">
          {DOC_TYPES.map((t) => (
            <button type="button" key={t} className={`vp-chip${docType === t ? ' on' : ''}`} onClick={() => setDocType(t)}>{t}</button>
          ))}
        </div>
        <label htmlFor="dF">File</label>
        <input id="dF" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <div className="small-muted" style={{ fontSize: 12 }}>{FILE_HINT}</div>
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

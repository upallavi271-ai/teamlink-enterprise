import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import '../vendor/vendorPortal.css';
import './VendorLogins.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION → COMPANY SETUP → VENDOR LOGINS (P3 2026-10-05, v2 2026-10-06).
// A tab of Company Setup (nav.js SETUP_TABS), never a sidebar entry.
// Logins (search + filters, Edit / Assets / Unlock / Reset / Deactivate /
// Audit) · Link assets · History (filters + CSV) · Settings (the "Vendor
// emails" switch, the feature flag, the policy). Server: routes/vendorLogins.js.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'logins', label: 'Logins' },
  { key: 'link', label: 'Link assets to vendors' },
  { key: 'audit', label: 'History' },
  { key: 'settings', label: 'Settings' },
];
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const two = (n) => String(n).padStart(2, '0');
const when = (s) => { if (!s) return 'Never'; const d = new Date(s); return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const TONE = { Active: 'green', Locked: 'red', 'Switched off': 'grey', 'Vendor switched off': 'grey' };
const PW_HINT = 'At least 10 characters, with a capital letter, a small letter, a number and a symbol.';

export default function VendorLogins() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'logins';
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState(null);
  const [filter, setFilter] = useState({ q: '', vendorId: '', status: '', locked: '' });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [saved, setSaved] = useState('');
  const [edit, setEdit] = useState(null); // { row | null, assetsOnly? }
  const [reset, setReset] = useState(null);
  const [secret, setSecret] = useState(null); // { email, password, emailed }
  const [auditFor, setAuditFor] = useState(null);

  useEffect(() => { const t = setTimeout(() => setQDeb(filter.q), 250); return () => clearTimeout(t); }, [filter.q]);
  const load = useCallback(() => {
    Promise.all([
      api.get('/vendor-logins', { params: { q: qDeb || undefined, vendorId: filter.vendorId || undefined, status: filter.status || undefined, locked: filter.locked || undefined } }),
      api.get('/vendor-logins/options'),
    ])
      .then(([a, b]) => { setData(a.data); setOpts(b.data); setError(''); })
      .catch((e) => { if (e.response?.status === 403) setDenied(true); else setError(errText(e, 'Could not load vendor logins.')); });
  }, [qDeb, filter.vendorId, filter.status, filter.locked]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!saved) return undefined; const t = setTimeout(() => setSaved(''), 4000); return () => clearTimeout(t); }, [saved]);

  if (denied) {
    return (
      <div>
        <div className="page-head"><div><h1>Vendor logins</h1></div></div>
        <div className="notice amber"><span>Only Admin (or a login that manages users) can manage vendor logins.</span></div>
      </div>
    );
  }

  async function act(r, path, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const res = await api.post(`/vendor-logins/${r.id}/${path}`);
      setSaved(res.data.message); load();
    } catch (e) { setError(errText(e, 'Could not do that.')); }
  }
  const rows = data?.rows || [];
  const fc = data?.facets || {};
  const filtered = !!(filter.q || filter.vendorId || filter.status || filter.locked);

  return (
    <div className="vl-page">
      <div className="page-head">
        <div>
          <h1>Vendor logins</h1>
          <div className="page-sub">Give a vendor its own login. They see only the assets you pick here, and can send bills to Accounts.</div>
        </div>
        {tab === 'logins' && <button type="button" className="btn btn-primary" onClick={() => setEdit({ row: null })}>+ Add vendor login</button>}
      </div>
      {data && data.portalEnabled === false && <div className="notice amber" style={{ marginBottom: 10 }}><span>The Vendor Portal is switched OFF on this server (VENDOR_PORTAL_ENABLED). Vendors cannot sign in until it is switched on. You can still prepare logins here.</span></div>}

      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <button type="button" key={t.key} role="tab" className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setParams({ tab: t.key }, { replace: true })}>{t.label}</button>
        ))}
      </div>

      {saved && <div className="notice green" style={{ marginBottom: 10 }}><span>{saved}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {secret && (
        <div className="notice amber vl-secret">
          <span>
            Password for <strong>{secret.email}</strong>: <code>{secret.password}</code>{' '}
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(secret.password)}>Copy</button>{' '}
            Shown only now{secret.emailed ? ' (also emailed to the vendor)' : ''}. It works for 7 days. They must change it when they first sign in at <code>/vendor-login</code>.{' '}
            <button type="button" className="link-btn" onClick={() => setSecret(null)}>Hide</button>
          </span>
        </div>
      )}

      {tab === 'logins' && (
        <>
          <div className="vp-filters" role="search">
            <input className="vp-search" type="search" placeholder="Search vendor, contact name, email" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label="Search" />
            <select value={filter.vendorId} onChange={(e) => setFilter({ ...filter, vendorId: e.target.value })} aria-label="Vendor">
              <option value="">All vendors</option>
              {(fc.vendor || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </select>
            <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} aria-label="Status">
              <option value="">All statuses</option>
              {(fc.status || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </select>
            <select value={filter.locked} onChange={(e) => setFilter({ ...filter, locked: e.target.value })} aria-label="Locked">
              <option value="">Locked or not</option>
              {(fc.locked || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </select>
            {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter({ q: '', vendorId: '', status: '', locked: '' })}>Clear</button>}
          </div>
          {!data ? <div className="empty-mini">Loading…</div> : !rows.length ? (
            <div className="vp-empty">
              {data.total ? <><h3>No login matches these filters</h3><p>Clear the filters to see all {data.total}.</p></>
                : <><h3>No vendor logins yet</h3><p>Press “+ Add vendor login”, pick the vendor and the assets they look after.</p></>}
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Vendor</th><th>Contact name</th><th>Email / username</th><th>Status</th><th>Last login</th>
                    <th className="num">Assets</th><th>Allow editing</th><th>Show purchase value</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.vendorName}</strong></td>
                      <td>{r.name}</td>
                      <td>
                        {r.email}
                        {r.mustChangePassword && <div className={`cell-muted${r.tempPasswordExpired ? ' vl-red' : ''}`}>{r.tempPasswordExpired ? 'Temporary password expired — reset it' : `Must set a new password${r.tempPasswordExpiresAt ? ` (by ${when(r.tempPasswordExpiresAt).slice(0, 10)})` : ''}`}</div>}
                      </td>
                      <td><span className={`vp-tag vp-${TONE[r.statusText] || 'grey'}`}>{r.statusText}</span>{r.locked && <div className="cell-muted">until {when(r.lockedUntil)}</div>}</td>
                      <td>{when(r.lastLoginAt)}{r.lastLoginIp && <div className="cell-muted">{r.lastLoginIp}</div>}</td>
                      <td className="num">{r.assignedAssets}</td>
                      <td>{r.canEdit ? 'On' : 'Off'}</td>
                      <td>{r.canViewCost ? 'On' : 'Off'}</td>
                      <td className="vl-acts">
                        <button type="button" className="btn btn-sm" onClick={() => setEdit({ row: r })}>Edit</button>
                        <button type="button" className="btn btn-sm" onClick={() => setEdit({ row: r, assetsOnly: true })}>Assets</button>
                        {r.locked && <button type="button" className="btn btn-sm btn-primary" onClick={() => act(r, 'unlock')}>Unlock</button>}
                        <button type="button" className="btn btn-sm" onClick={() => setReset(r)}>Reset password</button>
                        {r.status === 'Active'
                          ? <button type="button" className="btn btn-sm btn-danger" onClick={() => act(r, 'deactivate')}>Deactivate</button>
                          : <button type="button" className="btn btn-sm" onClick={() => act(r, 'activate')}>Activate</button>}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setAuditFor(r); setParams({ tab: 'audit' }, { replace: true }); }}>Audit log</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'link' && <LinkAssets vendors={opts?.vendors || []} onDone={(m) => { setSaved(m); load(); }} onError={setError} />}
      {tab === 'audit' && <AuditList logins={rows} vendors={opts?.vendors || []} initialUser={auditFor} onClearUser={() => setAuditFor(null)} />}
      {tab === 'settings' && <Settings onSaved={setSaved} onError={setError} />}

      {edit && opts && (
        <LoginModal
          row={edit.row}
          assetsOnly={!!edit.assetsOnly}
          opts={opts}
          onClose={() => setEdit(null)}
          onSaved={(res) => {
            setEdit(null);
            setSaved(res.message || 'Saved.');
            if (res.tempPassword) setSecret({ email: res.login?.email, password: res.tempPassword, emailed: res.emailed });
            load();
          }}
        />
      )}
      {reset && (
        <ResetModal
          row={reset}
          onClose={() => setReset(null)}
          onSaved={(res) => {
            setReset(null);
            setSaved(res.message);
            if (res.tempPassword) setSecret({ email: reset.email, password: res.tempPassword, emailed: res.emailed });
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Switch({ checked, onChange, label, hint }) {
  return (
    <label className="vl-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><strong>{label}</strong><br /><span className="cell-muted">{hint}</span></span>
    </label>
  );
}

function LoginModal({ row, assetsOnly, opts, onClose, onSaved }) {
  const isNew = !row;
  const [v, setV] = useState({
    vendorId: row?.vendorId || '', name: row?.name || '', email: row?.email || '', status: row?.status || 'Active',
    canEdit: !!row?.canEdit, canViewCost: !!row?.canViewCost, autoPassword: true, emailPassword: false, password: '',
  });
  const [mode, setMode] = useState(row && row.categories.length && !row.assetIds.length ? 'categories' : 'assets');
  const [assetIds, setAssetIds] = useState(new Set(row?.assetIds || []));
  const [cats, setCats] = useState(new Set(row?.categories || []));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const vendor = opts.vendors.find((x) => x.id === v.vendorId);
  const own = useMemo(() => opts.assets.filter((a) => v.vendorId && a.vendorId === v.vendorId), [opts.assets, v.vendorId]);
  const unlinked = useMemo(() => opts.assets.filter((a) => !a.vendorId), [opts.assets]);
  const match = (a) => !q || [a.assetCode, a.name, a.category, a.vendorText].some((x) => String(x || '').toLowerCase().includes(q.toLowerCase()));
  const pickedUnlinked = unlinked.filter((a) => assetIds.has(a.id));
  const ownCats = useMemo(() => {
    const m = new Map();
    own.forEach((a) => m.set(a.category, (m.get(a.category) || 0) + 1));
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
  }, [own]);
  const toggle = (set, setSet, id) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); setSet(n); };

  async function save() {
    setError('');
    if (!v.vendorId) { setError('Pick the vendor.'); return; }
    if (!assetsOnly) {
      if (!v.name.trim()) { setError('Enter the contact name.'); return; }
      if (!v.email.trim()) { setError('Enter the email.'); return; }
      if (isNew && !v.autoPassword && v.password.length < 10) { setError(`Type a password. ${PW_HINT} Or let the app make one.`); return; }
    }
    setBusy(true);
    const body = {
      ...(assetsOnly ? {} : { vendorId: v.vendorId, name: v.name, email: v.email, status: v.status, canEdit: v.canEdit, canViewCost: v.canViewCost }),
      assetIds: mode === 'assets' ? [...assetIds] : [], categories: mode === 'categories' ? [...cats] : [],
      linkUnlinked: mode === 'assets' && pickedUnlinked.length > 0,
      ...(isNew ? { autoPassword: v.autoPassword, emailPassword: v.autoPassword && v.emailPassword, password: v.autoPassword ? undefined : v.password } : {}),
    };
    try {
      const res = isNew ? await api.post('/vendor-logins', body) : await api.patch(`/vendor-logins/${row.id}`, body);
      onSaved(res.data);
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }

  return (
    <Modal
      title={isNew ? 'Add vendor login' : (assetsOnly ? `Assets · ${row.email}` : `Edit · ${row.email}`)}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : (isNew ? 'Create login' : 'Save')}</button>
        </>
      )}
    >
      <div className="vp-form vl-form">
        {!assetsOnly && (
          <>
            <div className="vp-two">
              <div>
                <label htmlFor="vlV">Vendor</label>
                <select id="vlV" value={v.vendorId} disabled={!isNew} onChange={(e) => { setV({ ...v, vendorId: e.target.value }); setAssetIds(new Set()); setCats(new Set()); }}>
                  <option value="">Pick from the vendor list…</option>
                  {opts.vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                {!opts.vendors.length && <div className="cell-muted">No active vendors. Add one in Office &amp; Accounts → Add Vendor.</div>}
              </div>
              <div>
                <label htmlFor="vlN">Contact name</label>
                <input id="vlN" value={v.name} maxLength={120} placeholder={vendor?.contactPerson || ''} onChange={(e) => setV({ ...v, name: e.target.value })} />
              </div>
            </div>
            <div className="vp-two">
              <div>
                <label htmlFor="vlE">Email / username</label>
                <input id="vlE" type="email" value={v.email} placeholder={vendor?.email || ''} onChange={(e) => setV({ ...v, email: e.target.value })} />
              </div>
              <div>
                <div className="vp-lbl">Status</div>
                <div className="vp-choice">
                  <button type="button" className={`vp-chip${v.status === 'Active' ? ' on' : ''}`} onClick={() => setV({ ...v, status: 'Active' })}>Active</button>
                  <button type="button" className={`vp-chip${v.status === 'Inactive' ? ' on' : ''}`} onClick={() => setV({ ...v, status: 'Inactive' })}>Switched off</button>
                </div>
              </div>
            </div>
            {isNew && (
              <>
                <div className="vp-lbl">Temporary password</div>
                <div className="vp-choice">
                  <button type="button" className={`vp-chip${v.autoPassword ? ' on' : ''}`} onClick={() => setV({ ...v, autoPassword: true })}>Make one for me</button>
                  <button type="button" className={`vp-chip${!v.autoPassword ? ' on' : ''}`} onClick={() => setV({ ...v, autoPassword: false })}>I will type it</button>
                </div>
                {!v.autoPassword && <input type="password" autoComplete="new-password" value={v.password} placeholder={PW_HINT} onChange={(e) => setV({ ...v, password: e.target.value })} style={{ marginTop: 6 }} />}
                {v.autoPassword && <Switch checked={v.emailPassword} onChange={(x) => setV({ ...v, emailPassword: x })} label="Email it to the vendor" hint="Only works when Vendor emails are ON (Settings tab). The password is also shown to you once." />}
                <div className="cell-muted" style={{ fontSize: 12, marginTop: 4 }}>It works for 7 days. The vendor must change it the first time they sign in.</div>
              </>
            )}
          </>
        )}

        <div className="vp-lbl">Which assets can they see?</div>
        <div className="vp-choice">
          <button type="button" className={`vp-chip${mode === 'assets' ? ' on' : ''}`} onClick={() => setMode('assets')}>Pick assets</button>
          <button type="button" className={`vp-chip${mode === 'categories' ? ' on' : ''}`} onClick={() => setMode('categories')}>Whole categories</button>
        </div>
        {!v.vendorId ? <div className="vp-none" style={{ marginTop: 6 }}>Pick the vendor first.</div> : mode === 'categories' ? (
          <div className="vl-pick">
            {ownCats.length ? ownCats.map((c) => (
              <label key={c.value} className="vl-pick-row">
                <input type="checkbox" checked={cats.has(c.value)} onChange={() => toggle(cats, setCats, c.value)} />
                <span>{c.value} <span className="cell-muted">({c.count} of this vendor's assets)</span></span>
              </label>
            )) : <div className="vp-none">This vendor has no linked assets yet. Use “Pick assets” to link some, or the “Link assets to vendors” tab.</div>}
            <div className="cell-muted" style={{ fontSize: 12, padding: '6px 8px' }}>Only this vendor's own assets in a category are shown — never another vendor's. A new asset of this vendor in the category shows up by itself.</div>
          </div>
        ) : (
          <div className="vl-pick">
            <input type="search" placeholder="Search asset ID, name, category" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '6px 0' }} />
            <div className="vl-pick-h">This vendor's assets ({own.length})</div>
            {own.filter(match).map((a) => (
              <label key={a.id} className="vl-pick-row">
                <input type="checkbox" checked={assetIds.has(a.id)} onChange={() => toggle(assetIds, setAssetIds, a.id)} />
                <span><strong>{a.assetCode}</strong> {a.name} <span className="cell-muted">· {a.category} · {a.status}</span></span>
              </label>
            ))}
            {!own.length && <div className="cell-muted" style={{ padding: '4px 8px' }}>None linked yet.</div>}
            <div className="vl-pick-h">Not linked to any vendor yet ({unlinked.length}) — ticking one links it to {vendor?.name || 'this vendor'}</div>
            {unlinked.filter(match).slice(0, 300).map((a) => (
              <label key={a.id} className="vl-pick-row">
                <input type="checkbox" checked={assetIds.has(a.id)} onChange={() => toggle(assetIds, setAssetIds, a.id)} />
                <span><strong>{a.assetCode}</strong> {a.name} <span className="cell-muted">· {a.category}{a.vendorText ? ` · bought from “${a.vendorText}”` : ''}</span></span>
              </label>
            ))}
          </div>
        )}
        {pickedUnlinked.length > 0 && mode === 'assets' && (
          <div className="notice amber" style={{ marginTop: 8 }}><span>{pickedUnlinked.length} picked asset(s) will be linked to {vendor?.name} in the asset register.</span></div>
        )}

        {!assetsOnly && (
          <>
            <div className="vp-lbl">What can they do?</div>
            <Switch checked={v.canEdit} onChange={(x) => setV({ ...v, canEdit: x })} label="Allow editing" hint="Off = view only. On = they may update serial no., warranty date, AMC date, service remarks, upload documents and send bills." />
            <Switch checked={v.canViewCost} onChange={(x) => setV({ ...v, canViewCost: x })} label="Show purchase value" hint="Off = they never see what the company paid (nor the purchase invoice no.). On = only the purchase value and invoice no. are shown." />
          </>
        )}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

function ResetModal({ row, onClose, onSaved }) {
  const [auto, setAuto] = useState(true);
  const [emailIt, setEmailIt] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true); setError('');
    try {
      const res = await api.post(`/vendor-logins/${row.id}/reset-password`, auto ? { autoPassword: true, emailPassword: emailIt } : { autoPassword: false, password: pw });
      onSaved(res.data);
    } catch (e) { setError(errText(e, 'Could not reset.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Reset password · ${row.email}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
        </>
      )}
    >
      <div className="vp-form">
        <div className="small-muted">They are signed out now, the lock (if any) is cleared, and they must set a new password when they sign in (within 7 days).</div>
        <div className="vp-choice" style={{ marginTop: 10 }}>
          <button type="button" className={`vp-chip${auto ? ' on' : ''}`} onClick={() => setAuto(true)}>Make one for me</button>
          <button type="button" className={`vp-chip${!auto ? ' on' : ''}`} onClick={() => setAuto(false)}>I will type it</button>
        </div>
        {!auto && <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={PW_HINT} style={{ marginTop: 8 }} />}
        {auto && <Switch checked={emailIt} onChange={setEmailIt} label="Email it to the vendor" hint="Only works when Vendor emails are ON (Settings tab)." />}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function Settings({ onSaved, onError }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/vendor-logins/settings').then((r) => setS(r.data)).catch((e) => onError(errText(e, 'Could not load the settings.'))); }, [onError]);
  async function toggle(on) {
    setBusy(true);
    try { const r = await api.put('/vendor-logins/settings', { emailsEnabled: on }); setS(r.data); onSaved(r.data.message); } catch (e) { onError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  if (!s) return <div className="empty-mini">Loading…</div>;
  const p = s.policy || {};
  return (
    <div className="vl-settings">
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Vendor emails</h3>
        <div className="small-muted" style={{ margin: '6px 0 10px' }}>
          One switch for every email the Vendor Portal sends: the temporary password to a vendor (when you tick it), "your bill was approved / rejected" to the vendor, and "a vendor bill is waiting" to the Accounts reviewers.
          Off: nothing is emailed; in-app notices and the portal itself still work.
        </div>
        <div className="vp-choice">
          <button type="button" className={`vp-chip${!s.emailsEnabled ? ' on' : ''}`} disabled={!s.canEdit || busy} onClick={() => toggle(false)}>Off (default)</button>
          <button type="button" className={`vp-chip${s.emailsEnabled ? ' on' : ''}`} disabled={!s.canEdit || busy} onClick={() => toggle(true)}>On</button>
        </div>
        {s.updatedAt && <div className="cell-muted" style={{ marginTop: 6 }}>Last changed {when(s.updatedAt)}{s.updatedByName ? ` by ${s.updatedByName}` : ''}</div>}
        {!s.canEdit && <div className="cell-muted" style={{ marginTop: 6 }}>Only Super Admin or Admin can change this.</div>}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Vendor Portal {s.portalEnabled ? <span className="vp-tag vp-green">ON</span> : <span className="vp-tag vp-grey">OFF</span>}</h3>
        <div className="small-muted" style={{ marginTop: 6 }}>
          Set on the server with VENDOR_PORTAL_ENABLED (1 = on, 0 = off). Unset: on everywhere except production. Off = vendors cannot sign in and the portal APIs answer 404; nothing else in TeamLink changes.
        </div>
      </div>
      <div className="card">
        <h3>Sign-in rules for vendors</h3>
        <dl className="vp-dl" style={{ marginTop: 8 }}>
          <dt>Password</dt><dd>At least {p.passwordMin} characters, capital, small, number, symbol; not one of the last 3.</dd>
          <dt>Wrong passwords</dt><dd>{p.maxFailed} in a row lock the login for {p.lockMinutes} minutes (Unlock button, or it opens by itself).</dd>
          <dt>Session</dt><dd>Signed out after {p.idleMinutes} minutes without activity, and after {p.maxHours} hours in any case.</dd>
          <dt>Temporary password</dt><dd>Works for {p.tempPasswordDays} days; must be changed at the first sign-in.</dd>
          <dt>Files</dt><dd>PDF, JPG or PNG, up to {p.uploadMaxMb} MB each.</dd>
        </dl>
        <div className="cell-muted" style={{ marginTop: 6 }}>Changed through server settings (VENDOR_* variables), not here.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function LinkAssets({ vendors, onDone, onError }) {
  const [d, setD] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState('');
  const [show, setShow] = useState('exact');
  const load = useCallback(() => {
    api.get('/vendor-logins/link-suggestions').then((r) => setD(r.data)).catch((e) => onError(errText(e, 'Could not load the suggestions.')));
  }, [onError]);
  useEffect(() => { load(); }, [load]);
  async function link(r) {
    const vendorId = pick[r.assetId] || r.suggested?.id;
    if (!vendorId) return;
    setBusy(r.assetId);
    try { const res = await api.post('/vendor-logins/link-asset', { assetId: r.assetId, vendorId }); onDone(`${r.assetCode}: ${res.data.message}`); load(); } catch (e) { onError(errText(e, 'Could not link.')); } finally { setBusy(''); }
  }
  if (!d) return <div className="empty-mini">Loading…</div>;
  const rows = d.rows.filter((r) => r.match === show);
  return (
    <div>
      <div className="notice blue" style={{ marginBottom: 10 }}>
        <span>
          Suggestions only — nothing changes until you press <strong>Link</strong> on a row.
          Old assets keep the vendor name typed on them; linking ties the asset to the vendor list so that vendor's login can be given it.
        </span>
      </div>
      <div className="vp-choice" style={{ marginBottom: 10 }}>
        <button type="button" className={`vp-chip${show === 'exact' ? ' on' : ''}`} onClick={() => setShow('exact')}>Same name ({d.summary.exact})</button>
        <button type="button" className={`vp-chip${show === 'maybe' ? ' on' : ''}`} onClick={() => setShow('maybe')}>Maybe ({d.summary.maybe})</button>
        <button type="button" className={`vp-chip${show === 'none' ? ' on' : ''}`} onClick={() => setShow('none')}>No match ({d.summary.none})</button>
        <span className="cell-muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>Already linked: {d.summary.alreadyLinked} · No vendor typed: {d.summary.noVendorText}</span>
      </div>
      {!rows.length ? <div className="vp-none">Nothing in this group.</div> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Asset</th><th>Vendor typed on the asset</th><th>Vendor list</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.assetId}>
                  <td><strong>{r.assetCode}</strong> {r.assetName}<div className="cell-muted">{r.category}</div></td>
                  <td>{r.vendorText}</td>
                  <td>
                    <select value={pick[r.assetId] || r.suggested?.id || ''} onChange={(e) => setPick({ ...pick, [r.assetId]: e.target.value })}>
                      <option value="">Pick a vendor…</option>
                      {(r.candidates.length ? [...r.candidates, ...vendors.filter((x) => !r.candidates.some((c) => c.id === x.id))] : vendors)
                        .map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td><button type="button" className="btn btn-sm btn-primary" disabled={busy === r.assetId || !(pick[r.assetId] || r.suggested?.id)} onClick={() => link(r)}>Link</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AuditList({ logins, vendors, initialUser, onClearUser }) {
  const [rows, setRows] = useState(null);
  const [actions, setActions] = useState([]);
  const [f, setF] = useState({ vendorUserId: initialUser?.id || '', vendorId: '', assetId: '', action: '', from: '', to: '' });
  const [err, setErr] = useState('');
  useEffect(() => { if (initialUser) setF((x) => ({ ...x, vendorUserId: initialUser.id })); }, [initialUser]);
  const params = { vendorUserId: f.vendorUserId || undefined, vendorId: f.vendorId || undefined, assetId: f.assetId || undefined, action: f.action || undefined, from: f.from || undefined, to: f.to || undefined };
  useEffect(() => {
    api.get('/vendor-logins/audit', { params })
      .then((r) => { setRows(r.data.rows); setActions(r.data.actions || []); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the history.')));
  }, [f.vendorUserId, f.vendorId, f.assetId, f.action, f.from, f.to]); // eslint-disable-line react-hooks/exhaustive-deps
  async function exportCsv() {
    try {
      const res = await api.get('/vendor-logins/audit.csv', { params, responseType: 'blob' });
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = href; a.download = 'vendor-audit.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
    } catch (e) { setErr(errText(e, 'Could not export.')); }
  }
  const filtered = Object.values(f).some(Boolean);
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 8 }}>Everything vendors and staff did on the Vendor Portal: sign-ins, edits, uploads, downloads, bills, permission changes. Nothing here can be changed or deleted.</div>
      <div className="vp-filters">
        <select value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })} aria-label="Vendor">
          <option value="">Every vendor</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={f.vendorUserId} onChange={(e) => { setF({ ...f, vendorUserId: e.target.value }); if (!e.target.value) onClearUser(); }} aria-label="Vendor login">
          <option value="">Every vendor login</option>
          {logins.map((l) => <option key={l.id} value={l.id}>{l.vendorName} · {l.name}</option>)}
          {initialUser && !logins.some((l) => l.id === initialUser.id) && <option value={initialUser.id}>{initialUser.vendorName} · {initialUser.name}</option>}
        </select>
        <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} aria-label="What">
          <option value="">Everything</option>
          {actions.map((a) => <option key={a.value} value={a.value}>{a.value} ({a.count})</option>)}
        </select>
        <input type="search" placeholder="Asset id" value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })} aria-label="Asset id" style={{ flex: '0 1 160px' }} />
        <div className="vp-dates">
          <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From" />
          <span className="vp-to">to</span>
          <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" />
        </div>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setF({ vendorUserId: '', vendorId: '', assetId: '', action: '', from: '', to: '' }); onClearUser(); }}>Clear</button>}
        <button type="button" className="btn btn-sm" onClick={exportCsv}>⬇ Export CSV</button>
      </div>
      {err && <div className="notice red"><span>{err}</span></div>}
      {!rows ? <div className="empty-mini">Loading…</div> : !rows.length ? <div className="vp-none">Nothing recorded yet.</div> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Role</th><th>What</th><th>Asset</th><th>Field / bill</th><th>Old</th><th>New</th><th>From</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.createdAt)}</td>
                  <td>{r.actorName || r.vendorUserName || '—'}{r.vendorName && <div className="cell-muted">{r.vendorName}</div>}</td>
                  <td>{r.role}</td>
                  <td>{r.action}{r.status && <div className="cell-muted">{r.status}</div>}</td>
                  <td>{r.assetCode || '—'}<div className="cell-muted">{r.assetName}</div></td>
                  <td>{r.field || r.billCode || '—'}{r.documentName && <div className="cell-muted">{r.documentName}</div>}</td>
                  <td className="vl-val">{r.oldValue || '—'}</td>
                  <td className="vl-val">{r.newValue || '—'}</td>
                  <td className="vl-val cell-muted" title={r.userAgent || ''}>{r.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import VendorManagement from './VendorManagement.jsx';
import '../vendor/vendorPortal.css';
import './VendorLogins.css';
import Combo from '../../components/Combo.jsx';
import VendorLoginDrawer from './VendorLoginDrawer.jsx';
import { LoginStatus, LoginEmail, LoginActions } from './VendorLoginActions.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION → COMPANY SETUP → VENDOR LOGINS (P3 2026-10-05, v2 2026-10-06).
// A tab of Company Setup (nav.js SETUP_TABS), never a sidebar entry.
// Logins (search + filters; per login: account status, invitation status, attempts, last attempt, delivery; Send / Resend invitation, Retry,
// Send password reset, Edit email, Emails, Edit, Unlock, Deactivate, Audit) · Link assets · History (filters + CSV) · Settings (the "Vendor
// emails" switch, support contact, the three email wordings, the feature flag, the policy). Server: routes/vendorLogins.js.
// (2026-10-19: the Vendor Portal now shows only Dashboard, Invoices, Payments and Purchase Orders.)
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'vendors', label: 'Vendors' },
  { key: 'logins', label: 'Logins' },
  { key: 'link', label: 'Link assets to vendors' },
  { key: 'audit', label: 'History' },
  { key: 'settings', label: 'Settings' },
];
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const two = (n) => String(n).padStart(2, '0');
const when = (s) => { if (!s) return 'Never'; const d = new Date(s); return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`; };

export default function VendorLogins() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'vendors';
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState(null);
  const [filter, setFilter] = useState({ q: '', vendorId: '', status: '', locked: '', account: '' });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [saved, setSaved] = useState('');
  const [edit, setEdit] = useState(null); // { row | null, assetsOnly? }
  const [secret, setSecret] = useState(null); // { email, link, expiresAt, emailed } | { email, password } (older)
  const [auditFor, setAuditFor] = useState(null);

  useEffect(() => { const t = setTimeout(() => setQDeb(filter.q), 250); return () => clearTimeout(t); }, [filter.q]);
  const load = useCallback(() => {
    Promise.all([
      api.get('/vendor-logins', { params: { q: qDeb || undefined, vendorId: filter.vendorId || undefined, status: filter.status || undefined, locked: filter.locked || undefined, account: filter.account || undefined } }),
      api.get('/vendor-logins/options'),
    ])
      .then(([a, b]) => { setData(a.data); setOpts(b.data); setError(''); })
      .catch((e) => { if (e.response?.status === 403) setDenied(true); else setError(errText(e, 'Could not load vendor logins.')); });
  }, [qDeb, filter.vendorId, filter.status, filter.locked, filter.account]);
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
  // Open portal: a single-use, 60-second handoff; the vendor portal opens in a NEW tab,
  // view-only, and this staff session is not touched.
  async function openPortal(r) {
    try {
      const res = await api.post(`/vendor-logins/${r.id}/open-portal`);
      const w = window.open(`/vendor-login#preview=${encodeURIComponent(res.data.token)}`, '_blank');
      if (w) w.opener = null;
      if (!w) setError('Your browser blocked the new tab. Allow pop-ups for this site and press Preview portal again.');
      else setSaved(`Preview of ${r.vendorName}'s portal opened in a new tab (view only).`);
    } catch (e) { setError(errText(e, 'Could not open the portal.')); }
  }
  // After Create / Send invitation / Resend / Retry / Send password reset / Edit email: show what REALLY happened (green = the mail server accepted it,
  // red = it failed), and - only when email itself is not set up - the one-time backup link.
  function mailDone(res) {
    const failed = res.emailed === false && !res.duplicate && /not sent|failed/i.test(res.message || '');
    if (failed) { setSaved(''); setError(res.message); } else { setError(''); setSaved(res.message || 'Done.'); }
    if (res.inviteLink) setSecret({ email: res.login?.email, link: res.inviteLink, expiresAt: res.inviteExpiresAt, emailed: false });
    load();
  }
  const signInUrl = `${window.location.origin}/login`; // the ONE login page; vendors land in the Vendor Portal
  const rows = data?.rows || [];
  const modLabel = new Map(((opts && opts.registry && opts.registry.modules) || []).map((m) => [m.key, m.label]));
  const fc = data?.facets || {};
  const filtered = !!(filter.q || filter.vendorId || filter.status || filter.locked || filter.account);

  return (
    <div className="vl-page">
      <div className="page-head">
        <div>
          <h1>Vendors</h1>
          <div className="page-sub">Your vendor list, their logins, their bills and payments, and the documents you share with them.</div>
        </div>
        {tab === 'logins' && <button type="button" id="vl-add-login-btn" className="btn btn-primary" onClick={() => setEdit({ row: null })}>+ Add vendor login</button>}
      </div>
      {data && data.portalEnabled === false && <div className="notice amber" style={{ marginBottom: 10 }}><span>The Vendor Portal is switched OFF on this server (VENDOR_PORTAL_ENABLED). Vendors cannot sign in until it is switched on. You can still prepare logins here.</span></div>}

      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <button type="button" key={t.key} role="tab" className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setParams({ tab: t.key }, { replace: true })}>{t.label}</button>
        ))}
      </div>

      {saved && <div className="notice green" style={{ marginBottom: 10 }}><span>{saved}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {data && data.mail && !data.mail.ready && (
        <div className="notice amber" style={{ marginBottom: 10 }}>
          <span><strong>Invitation emails cannot be sent yet.</strong> {data.mail.problem} A login can still be created; it waits with &ldquo;Invitation Failed&rdquo; until you press Retry sending.{' '}
            <button type="button" className="link-btn" onClick={() => setParams({ tab: 'settings' }, { replace: true })}>Open Settings</button></span>
        </div>
      )}
      {secret && secret.link && (
        <div className="notice amber vl-secret">
          <span>
            <strong>Backup only: email is not set up.</strong> Link for <strong>{secret.email}</strong>: <code className="vl-link">{secret.link}</code>{' '}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => navigator.clipboard?.writeText(secret.link)}>Copy link</button>{' '}
            It is shown only now and is not saved anywhere. It works once and runs out on {when(secret.expiresAt)}. The vendor chooses their own password.{' '}
            <button type="button" className="link-btn" onClick={() => setSecret(null)}>Hide</button>
          </span>
        </div>
      )}
      {secret && secret.password && (
        <div className="notice amber vl-secret">
          <span>
            Password for <strong>{secret.email}</strong>: <code>{secret.password}</code>{' '}
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(secret.password)}>Copy</button>{' '}
            Shown only now and never emailed. It works for 7 days. Better next time: use “Send secure link”.{' '}
            The vendor signs in on the normal login page, <code>{signInUrl}</code>, with this email and the password, and is asked to choose a new one.{' '}
            <button type="button" className="link-btn" onClick={() => setSecret(null)}>Hide</button>
          </span>
        </div>
      )}

      {tab === 'vendors' && <VendorManagement onSaved={setSaved} onError={setError} onOpenLogins={() => setParams({ tab: 'logins' }, { replace: true })} onLink={(x) => setSecret(x)} onMailDone={mailDone} />}

      {tab === 'logins' && (
        <>
          <div className="vp-filters" role="search">
            <input className="vp-search" type="search" placeholder="Search vendor, contact name, email" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label="Search" />
            <Combo value={filter.vendorId} onChange={(e) => setFilter({ ...filter, vendorId: e.target.value })} aria-label="Vendor">
              <option value="">All vendors</option>
              {(fc.vendor || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </Combo>
            <Combo value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} aria-label="Status">
              <option value="">All statuses</option>
              {(fc.status || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </Combo>
            <Combo value={filter.account} onChange={(e) => setFilter({ ...filter, account: e.target.value })} aria-label="Account">
              <option value="">Any account state</option>
              {(fc.account || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </Combo>
            <Combo value={filter.locked} onChange={(e) => setFilter({ ...filter, locked: e.target.value })} aria-label="Locked">
              <option value="">Locked or not</option>
              {(fc.locked || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
            </Combo>
            {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter({ q: '', vendorId: '', status: '', locked: '', account: '' })}>Clear</button>}
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
                    <th>Vendor</th><th>Contact name</th><th>Login email</th><th>Account and invitation</th><th>Last sign-in</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.vendorName}</strong></td>
                      <td>{r.name}</td>
                      <td><LoginEmail row={r} contactEmail={r.vendorContactEmail} /></td>
                      <td><LoginStatus row={r} /></td>
                      <td>{when(r.lastLoginAt)}{r.lastLoginIp && <div className="cell-muted">{r.lastLoginIp}</div>}</td>
                      <td>
                        <LoginActions row={r} vendorId={r.vendorId} contactEmail={r.vendorContactEmail} onDone={mailDone} onError={setError} />
                        <div className="vla-acts" style={{ marginTop: 4 }}>
                          {r.status === 'Active' && <button type="button" className="btn btn-sm" onClick={() => openPortal(r)}>Preview portal</button>}
                          <button type="button" className="btn btn-sm" onClick={() => setEdit({ row: r })}>Edit</button>
                          {r.locked && <button type="button" className="btn btn-sm btn-primary" onClick={() => act(r, 'unlock')}>Unlock</button>}
                          {r.status === 'Active'
                            ? <button type="button" className="btn btn-sm btn-danger" onClick={() => act(r, 'deactivate')}>Switch off</button>
                            : <button type="button" className="btn btn-sm" onClick={() => act(r, 'activate')}>Switch on</button>}
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setAuditFor(r); setParams({ tab: 'audit' }, { replace: true }); }}>Audit log</button>
                        </div>
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
        <VendorLoginDrawer
          row={edit.row}
          assetsOnly={!!edit.assetsOnly}
          opts={opts}
          onClose={() => setEdit(null)}
          onSaved={(res) => {
            setEdit(null);
            mailDone({ ...res, message: res.message || 'Saved.' });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
function Settings({ onSaved, onError }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/vendor-logins/settings').then((r) => setS(r.data)).catch((e) => onError(errText(e, 'Could not load the settings.'))); }, [onError]);
  async function toggle(on) {
    setBusy(true);
    try { const r = await api.put('/vendor-logins/settings', { emailsEnabled: on }); setS(r.data); onSaved(r.data.message); } catch (e) { onError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const [contact, setContact] = useState(null);
  useEffect(() => { if (s && contact === null) setContact({ supportEmail: s.supportEmail || '', supportPhone: s.supportPhone || '', brandName: s.brandName || '' }); }, [s, contact]);
  async function saveContact() {
    setBusy(true);
    try { const r = await api.put('/vendor-logins/settings', contact); setS(r.data); onSaved('Saved. The next vendor emails use these details.'); } catch (e) { onError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  if (!s) return <div className="empty-mini">Loading…</div>;
  const p = s.policy || {};
  return (
    <div className="vl-settings">
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Vendor emails</h3>
        <div className="small-muted" style={{ margin: '6px 0 10px' }}>
          One switch for every email the Vendor Portal sends: the welcome / password / email-change emails to a vendor, "your bill was approved / rejected" to the vendor, and "a vendor bill is waiting" to the Accounts reviewers.
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
        <h3>Welcome, password and email-change emails</h3>
        <div className="small-muted" style={{ margin: '6px 0 10px' }}>
          When you create a login, TeamLink emails the vendor: login ID, a temporary password and a secure link. Nobody copies a link or password by hand.
        </div>
        {s.mail && (
          <dl className="vp-dl">
            <dt>Ready to send?</dt><dd>{s.mail.ready ? <span className="vp-tag vp-green">Yes</span> : <span className="vp-tag vp-red">No</span>} {!s.mail.ready && <span className="vla-red">{s.mail.problem}</span>}</dd>
            <dt>Email (SMTP)</dt><dd>{s.mail.smtpConfigured ? `Set up${s.mail.fromAddress ? ` - sends from ${s.mail.fromAddress}` : ''}` : <span className="vla-red">Not set up. {s.mail.smtpReason} Fill it in under Administration &gt; Integrations &gt; Email (SMTP).</span>}</dd>
            <dt>Vendor Portal address in the email</dt><dd>{s.mail.portalUrl} <span className="cell-muted">(from the server setting APP_BASE_URL)</span></dd>
            <dt>Test mode</dt><dd>{s.mail.testMode ? 'ON - nothing is really sent (test server).' : 'Off - emails are really sent.'}</dd>
            <dt>Delivery reports</dt><dd>{s.mail.deliveryNote}</dd>
          </dl>
        )}
        {contact && (
          <div className="vp-form" style={{ marginTop: 10 }}>
            <div className="vp-two">
              <div><label htmlFor="vsEm">Support email shown in the emails</label><input id="vsEm" type="email" value={contact.supportEmail} disabled={!s.canEdit} onChange={(e) => setContact({ ...contact, supportEmail: e.target.value })} placeholder={s.mail?.supportEmail || ''} /></div>
              <div><label htmlFor="vsPh">Support phone shown in the emails</label><input id="vsPh" value={contact.supportPhone} disabled={!s.canEdit} onChange={(e) => setContact({ ...contact, supportPhone: e.target.value })} placeholder={s.mail?.supportPhone || ''} /></div>
            </div>
            <div className="cell-muted">Left empty, the company email and phone from Company Setup are used{s.mail && !s.mail.supportEmail && !s.mail.supportPhone ? ' (none is set yet, so the emails say "reply to this email")' : ''}.</div>
            {s.canEdit && <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 6 }} disabled={busy} onClick={saveContact}>Save contact details</button>}
          </div>
        )}
        <h4 style={{ margin: '14px 0 6px', fontSize: 13 }}>The wording of these emails</h4>
        <ul className="vm-list">
          {(s.emails || []).map((e) => (
            <li key={e.purpose}><span><b>{e.label}</b></span><a className="btn btn-sm" href={`/admin/message-templates?audience=vendor`}>Edit wording</a></li>
          ))}
        </ul>
        <div className="cell-muted">Only an Admin can change the wording. The secure link and the temporary password must stay in the welcome email.</div>
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
          <dt>Temporary password</dt><dd>The one in the welcome email works until the invitation runs out (3 days) and must be changed at the first sign-in.</dd>
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
                    <Combo value={pick[r.assetId] || r.suggested?.id || ''} onChange={(e) => setPick({ ...pick, [r.assetId]: e.target.value })}>
                      <option value="">Pick a vendor…</option>
                      {(r.candidates.length ? [...r.candidates, ...vendors.filter((x) => !r.candidates.some((c) => c.id === x.id))] : vendors)
                        .map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Combo>
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
        <Combo value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })} aria-label="Vendor">
          <option value="">Every vendor</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </Combo>
        <Combo value={f.vendorUserId} onChange={(e) => { setF({ ...f, vendorUserId: e.target.value }); if (!e.target.value) onClearUser(); }} aria-label="Vendor login">
          <option value="">Every vendor login</option>
          {logins.map((l) => <option key={l.id} value={l.id}>{l.vendorName} · {l.name}</option>)}
          {initialUser && !logins.some((l) => l.id === initialUser.id) && <option value={initialUser.id}>{initialUser.vendorName} · {initialUser.name}</option>}
        </Combo>
        <Combo value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} aria-label="What">
          <option value="">Everything</option>
          {actions.map((a) => <option key={a.value} value={a.value}>{a.value} ({a.count})</option>)}
        </Combo>
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

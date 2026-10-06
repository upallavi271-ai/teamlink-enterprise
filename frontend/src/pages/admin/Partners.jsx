import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { saveBlob } from '../office/officeUtil';
import './Partners.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION → COMPANY SETUP → PARTNERS (B7, 2026-10-06).
// A tab of Company Setup (nav.js SETUP_TABS), never a sidebar entry.
// Partners: agencies / freelancers with their fee, TDS, guarantee and
// candidate-ownership terms · Logins: who signs in at /partner-login ·
// Settings: the "Partner emails" switch (OFF by default) · History.
// Server: routes/partners.js (Admin, or an Accounts approver).
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'partners', label: 'Partners' },
  { key: 'logins', label: 'Logins' },
  { key: 'settings', label: 'Settings' },
  { key: 'audit', label: 'History' },
];
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const when = (s) => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never');
const day = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const TONE = { Active: 'green', Paused: 'grey', Locked: 'red', 'Switched off': 'grey', 'Temporary password expired': 'yellow' };
const PW_HINT = 'At least 10 characters with a capital letter, a small letter, a number and a symbol.';

export default function Partners() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'partners';
  const [data, setData] = useState(null);
  const [logins, setLogins] = useState(null);
  const [opts, setOpts] = useState(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState('');
  const [saved, setSaved] = useState('');
  const [edit, setEdit] = useState(null); // { row|null }
  const [loginEdit, setLoginEdit] = useState(null);
  const [secret, setSecret] = useState(null);
  const [auditFor, setAuditFor] = useState(null);

  const load = useCallback(() => {
    Promise.all([api.get('/partners'), api.get('/partners/logins'), api.get('/partners/options')])
      .then(([a, b, c]) => { setData(a.data); setLogins(b.data); setOpts(c.data); setError(''); })
      .catch((e) => { if (e.response?.status === 403 || e.response?.status === 503) setDenied(errText(e, 'Not available.')); else setError(errText(e, 'Could not load partners.')); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!saved) return undefined; const t = setTimeout(() => setSaved(''), 5000); return () => clearTimeout(t); }, [saved]);

  if (denied) {
    return (
      <div>
        <div className="page-head"><div><h1>Partners</h1></div></div>
        <div className="notice amber"><span>{denied}</span></div>
      </div>
    );
  }

  async function act(url, okMsg) {
    try { const r = await api.post(url); setSaved(r.data.message || okMsg); load(); } catch (e) { setError(errText(e, 'Could not do that.')); }
  }
  const rows = data?.rows || [];

  return (
    <div className="pa-page">
      <div className="page-head">
        <div>
          <h1>Partners</h1>
          <div className="page-sub">Agencies and freelancers who send you candidates. Set their fee, TDS and guarantee here, give them a login, then share jobs with them from the job page.</div>
        </div>
        {tab === 'partners' && opts?.canManage && <button type="button" className="btn btn-primary" onClick={() => setEdit({ row: null })}>+ Add partner</button>}
        {tab === 'logins' && opts?.canManage && <button type="button" className="btn btn-primary" onClick={() => setLoginEdit({ row: null })}>+ Add partner login</button>}
      </div>

      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <button type="button" key={t.key} role="tab" className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setParams({ tab: t.key }, { replace: true })}>{t.label}</button>
        ))}
      </div>

      {saved && <div className="notice green" style={{ marginBottom: 10 }}><span>{saved}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={() => setError('')}>Dismiss</button></span></div>}
      {secret && (
        <div className="notice amber pa-secret">
          <span>
            Password for <strong>{secret.email}</strong>: <code>{secret.password}</code>{' '}
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(secret.password)}>Copy</button>{' '}
            Shown only now. Give it to the partner. They sign in at <code>/partner-login</code> and must change it the first time (it works for 7 days).{' '}
            <button type="button" className="link-btn" onClick={() => setSecret(null)}>Hide</button>
          </span>
        </div>
      )}

      {tab === 'partners' && (
        !data ? <div className="empty-mini">Loading…</div> : !rows.length ? (
          <div className="empty-mini" style={{ padding: 30, textAlign: 'center' }}>
            <h3>No partners yet</h3>
            <p className="small-muted">Press “+ Add partner”: name, type, fee terms, TDS, guarantee days. Then add a login and share a job with them.</p>
          </div>
        ) : (
          <>
            <div className="pa-cards">
              <div className="pa-card"><b>{rows.filter((r) => r.status === 'Active').length}</b><span>Active partners</span></div>
              <div className="pa-card"><b>{rows.reduce((a, r) => a + (r.submitted || 0), 0)}</b><span>Candidates sent, all time</span></div>
              <div className="pa-card"><b>{rows.reduce((a, r) => a + (r.joined || 0), 0)}</b><span>Joined through partners</span></div>
              <div className="pa-card"><b>{inr(rows.reduce((a, r) => a + (r.payout || 0), 0))}</b><span>Payouts approved + paid</span></div>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Partner</th><th>Type</th><th>Fee</th><th>GST / TDS</th><th>Guarantee · pay · owns</th><th>Departments</th><th>Agreement</th><th>Status</th>
                    <th className="num">Sent</th><th className="num">Joined</th><th className="num">Payouts</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.name}</strong><div className="cell-muted">{r.code}{r.contactName ? ` · ${r.contactName}` : ''}{r.email ? ` · ${r.email}` : ''}</div></td>
                      <td>{r.type}</td>
                      <td>{r.feeText}</td>
                      <td>{r.gstRegistered ? 'GST 18%' : 'No GST'}<div className="cell-muted">TDS {r.tdsSection && r.tdsSection !== 'None' ? `${r.tdsSection} ${r.tdsPercent}%` : 'none'}</div></td>
                      <td>{r.guaranteeDays} d · {r.paymentTermsDays} d · {r.ownershipDays} d</td>
                      <td>{r.departments.length ? r.departments.join(', ') : <span className="cell-muted">Any</span>}</td>
                      <td>
                        {r.agreement ? (
                          <>
                            {r.agreement.name ? <button type="button" className="link-btn" onClick={() => api.get(`/partners/${r.id}/agreement/file`, { responseType: 'blob' }).then((res) => saveBlob(res, r.agreement.name)).catch(() => setError('Could not download.'))}>{r.agreement.name}</button> : <span className="cell-muted">No file</span>}
                            <div className={`cell-muted${r.agreementExpired ? ' pa-red' : ''}`}>{r.agreement.from ? `${day(r.agreement.from)} → ${r.agreement.to ? day(r.agreement.to) : 'open'}` : ''}{r.agreementExpired ? ' · expired' : ''}</div>
                          </>
                        ) : <span className="cell-muted">None</span>}
                      </td>
                      <td><span className={`pa-tag pa-${TONE[r.status] || 'grey'}`}>{r.status}</span><div className="cell-muted">{r.logins} login{r.logins === 1 ? '' : 's'} · {r.shares} job{r.shares === 1 ? '' : 's'}</div></td>
                      <td className="num">{r.submitted}</td>
                      <td className="num">{r.joined}</td>
                      <td className="num">{inr(r.payout)}</td>
                      <td className="pa-acts">
                        {opts?.canManage && <button type="button" className="btn btn-sm" onClick={() => setEdit({ row: r })}>Edit</button>}
                        {opts?.canManage && (r.status === 'Active'
                          ? <button type="button" className="btn btn-sm btn-danger" onClick={() => act(`/partners/${r.id}/pause`)}>Pause</button>
                          : <button type="button" className="btn btn-sm" onClick={() => act(`/partners/${r.id}/activate`)}>Activate</button>)}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setAuditFor(r); setParams({ tab: 'audit' }, { replace: true }); }}>History</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {tab === 'logins' && (
        !logins ? <div className="empty-mini">Loading…</div> : !logins.length ? (
          <div className="empty-mini" style={{ padding: 30, textAlign: 'center' }}><h3>No partner logins yet</h3><p className="small-muted">Press “+ Add partner login”, pick the partner, and hand over the password shown once.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Partner</th><th>Contact name</th><th>Email / username</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
              <tbody>
                {logins.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.partnerName}</strong></td>
                    <td>{r.name}</td>
                    <td>{r.email}{r.mustChangePassword && <div className="cell-muted">Must set a new password</div>}</td>
                    <td><span className={`pa-tag pa-${TONE[r.statusText] || 'grey'}`}>{r.statusText}</span></td>
                    <td>{when(r.lastLoginAt)}{r.lastLoginIp && <div className="cell-muted">{r.lastLoginIp}</div>}</td>
                    <td className="pa-acts">
                      <button type="button" className="btn btn-sm" onClick={() => setLoginEdit({ row: r })}>Edit</button>
                      <button type="button" className="btn btn-sm" onClick={async () => { if (!window.confirm(`Reset the password for ${r.email}? They are signed out and get a new temporary password.`)) return; try { const res = await api.post(`/partners/logins/${r.id}/reset-password`); setSecret({ email: r.email, password: res.data.tempPassword }); setSaved(res.data.message); load(); } catch (e) { setError(errText(e, 'Could not reset.')); } }}>Reset password</button>
                      {r.status === 'Active'
                        ? <button type="button" className="btn btn-sm btn-danger" onClick={() => act(`/partners/logins/${r.id}/deactivate`)}>Deactivate</button>
                        : <button type="button" className="btn btn-sm" onClick={() => act(`/partners/logins/${r.id}/activate`)}>Activate</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'settings' && <Settings isAdmin={!!opts?.isAdmin} onSaved={setSaved} onError={setError} />}
      {tab === 'audit' && <AuditList partners={rows} initial={auditFor} onClear={() => setAuditFor(null)} />}

      {edit && opts && (
        <PartnerModal row={edit.row} opts={opts} onClose={() => setEdit(null)} onSaved={(res) => { setEdit(null); setSaved(res.message || 'Saved.'); load(); }} />
      )}
      {loginEdit && (
        <LoginModal row={loginEdit.row} partners={rows} onClose={() => setLoginEdit(null)} onSaved={(res) => { setLoginEdit(null); setSaved(res.message || 'Saved.'); if (res.tempPassword) setSecret({ email: res.login?.email, password: res.tempPassword }); load(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function PartnerModal({ row, opts, onClose, onSaved }) {
  const isNew = !row;
  const dflt = opts.tdsDefaults || {};
  const [v, setV] = useState({
    type: row?.type || 'Agency', name: row?.name || '', contactName: row?.contactName || '', email: row?.email || '', phone: row?.phone || '',
    gstin: row?.gstin || '', pan: row?.pan || '', gstRegistered: !!row?.gstRegistered,
    tdsSection: row?.tdsSection || dflt.Agency?.section || '194C', tdsPercent: row?.tdsPercent ?? (dflt.Agency?.percent ?? 2),
    feeType: row?.feeType || 'PERCENT', feePercent: row?.feePercent ?? 8.33, feeFixed: row?.feeFixed ?? '',
    paymentTermsDays: row?.paymentTermsDays ?? 30, guaranteeDays: row?.guaranteeDays ?? 90, ownershipDays: row?.ownershipDays ?? 365,
    departments: row?.departments || [], specialisations: (row?.specialisations || []).join(', '), showClientName: !!row?.showClientName,
    agreementFrom: row?.agreement?.from || '', agreementTo: row?.agreement?.to || '', notes: row?.notes || '',
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const setType = (t) => setV((s) => ({ ...s, type: t, ...(isNew && dflt[t] ? { tdsSection: dflt[t].section, tdsPercent: dflt[t].percent } : {}) }));
  const toggleDept = (d) => set('departments', v.departments.includes(d) ? v.departments.filter((x) => x !== d) : [...v.departments, d]);
  // The worked example (what Accounts will see on a payout).
  const ctc = 1000000;
  const fee = v.feeType === 'FIXED' ? Number(v.feeFixed || 0) : (ctc * Number(v.feePercent || 0)) / 100;
  const gst = v.gstRegistered ? fee * 0.18 : 0;
  const tds = v.tdsSection && v.tdsSection !== 'None' ? (fee * Number(v.tdsPercent || 0)) / 100 : 0;

  async function save() {
    setError('');
    if (!v.name.trim()) { setError('Enter the partner name.'); return; }
    setBusy(true);
    try {
      const body = { ...v, specialisations: v.specialisations.split(',').map((x) => x.trim()).filter(Boolean) };
      const res = isNew ? await api.post('/partners', body) : await api.patch(`/partners/${row.id}`, body);
      const id = res.data.partner.id;
      if (file) {
        const fd = new FormData();
        fd.append('agreementFrom', v.agreementFrom); fd.append('agreementTo', v.agreementTo); fd.append('file', file);
        await api.post(`/partners/${id}/agreement`, fd);
      }
      onSaved(res.data);
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }

  return (
    <Modal
      title={isNew ? 'Add partner' : `Edit · ${row.name}`}
      size="wide"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : (isNew ? 'Add partner' : 'Save')}</button></>}
    >
      <div className="pa-form">
        <div className="pa-choice">
          {(opts.types || ['Agency', 'Freelancer']).map((t) => <button key={t} type="button" className={`pa-chip${v.type === t ? ' on' : ''}`} onClick={() => setType(t)}>{t === 'Agency' ? 'Agency (a company)' : 'Freelancer (a person)'}</button>)}
        </div>
        <div className="pa-two">
          <div><label htmlFor="paN">{v.type === 'Agency' ? 'Agency name' : 'Freelancer name'}</label><input id="paN" value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={160} /></div>
          <div><label htmlFor="paC">Contact person</label><input id="paC" value={v.contactName} onChange={(e) => set('contactName', e.target.value)} /></div>
        </div>
        <div className="pa-two">
          <div><label htmlFor="paE">Email</label><input id="paE" type="email" value={v.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div><label htmlFor="paP">Phone</label><input id="paP" value={v.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        </div>
        <div className="pa-three">
          <div><label htmlFor="paPan">PAN</label><input id="paPan" value={v.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} placeholder="ABCDE1234F" /></div>
          <div><label htmlFor="paG">GSTIN (if registered)</label><input id="paG" value={v.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder="36ABCDE1234F1Z5" /></div>
          <div>
            <div style={{ margin: '10px 0 4px', fontSize: 12.5, fontWeight: 600 }}>GST on the fee?</div>
            <div className="pa-choice">
              <button type="button" className={`pa-chip${!v.gstRegistered ? ' on' : ''}`} onClick={() => set('gstRegistered', false)}>No GST</button>
              <button type="button" className={`pa-chip${v.gstRegistered ? ' on' : ''}`} onClick={() => set('gstRegistered', true)}>Add 18% GST</button>
            </div>
          </div>
        </div>

        <div style={{ margin: '14px 0 4px', fontSize: 12.5, fontWeight: 600 }}>Fee per joining</div>
        <div className="pa-choice">
          <button type="button" className={`pa-chip${v.feeType === 'PERCENT' ? ' on' : ''}`} onClick={() => set('feeType', 'PERCENT')}>% of the candidate&apos;s annual CTC</button>
          <button type="button" className={`pa-chip${v.feeType === 'FIXED' ? ' on' : ''}`} onClick={() => set('feeType', 'FIXED')}>Fixed amount</button>
        </div>
        <div className="pa-three">
          {v.feeType === 'PERCENT'
            ? <div><label htmlFor="paFp">Fee %</label><input id="paFp" type="number" step="0.01" min="0" max="100" value={v.feePercent} onChange={(e) => set('feePercent', e.target.value)} /></div>
            : <div><label htmlFor="paFf">Fixed fee (₹)</label><input id="paFf" type="number" min="0" value={v.feeFixed} onChange={(e) => set('feeFixed', e.target.value)} /></div>}
          <div>
            <label htmlFor="paTs">TDS section</label>
            <select id="paTs" value={v.tdsSection || 'None'} onChange={(e) => { const s = e.target.value; set('tdsSection', s); if (s === 'None') set('tdsPercent', 0); }}>
              {(opts.tdsSections || ['194J', '194C', '194H', 'None']).map((s) => <option key={s} value={s}>{s === 'None' ? 'No TDS' : s}</option>)}
            </select>
          </div>
          <div><label htmlFor="paTp">TDS %</label><input id="paTp" type="number" step="0.5" min="0" max="30" value={v.tdsPercent} disabled={v.tdsSection === 'None'} onChange={(e) => set('tdsPercent', e.target.value)} /></div>
        </div>
        <div className="pa-calc">
          Example on a ₹10,00,000 CTC joining: fee {inr(fee)}{gst ? ` + GST ${inr(gst)}` : ''}{tds ? ` − TDS ${inr(tds)}` : ''} = <b>{inr(fee + gst - tds)}</b> paid to the partner.
          {isNew && ' Defaults: Agency 194C 2%, Freelancer 194J 10% — change if your CA says otherwise.'}
        </div>

        <div className="pa-three">
          <div><label htmlFor="paGd">Guarantee (days)</label><input id="paGd" type="number" min="0" max="365" value={v.guaranteeDays} onChange={(e) => set('guaranteeDays', e.target.value)} /><div className="cell-muted">Payout waits this long after joining.</div></div>
          <div><label htmlFor="paPd">Payment terms (days)</label><input id="paPd" type="number" min="0" max="365" value={v.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} /><div className="cell-muted">Due date after approval.</div></div>
          <div><label htmlFor="paOd">Candidate ownership (days)</label><input id="paOd" type="number" min="0" max="1095" value={v.ownershipDays} onChange={(e) => set('ownershipDays', e.target.value)} /><div className="cell-muted">First to send a person owns them this long.</div></div>
        </div>

        <div style={{ margin: '14px 0 4px', fontSize: 12.5, fontWeight: 600 }}>Departments they may send to <span className="cell-muted">(none ticked = any)</span></div>
        <div className="pa-choice">
          {(opts.departments || []).map((d) => <button key={d} type="button" className={`pa-chip${v.departments.includes(d) ? ' on' : ''}`} onClick={() => toggleDept(d)}>{d}</button>)}
        </div>
        <label htmlFor="paSp">Specialisations (optional, comma separated)</label>
        <input id="paSp" value={v.specialisations} onChange={(e) => set('specialisations', e.target.value)} placeholder="Dermatology, Java, Sales" />
        <label className="pa-switch">
          <input type="checkbox" checked={v.showClientName} onChange={(e) => set('showClientName', e.target.checked)} />
          <span><strong>Show the client&apos;s name on shared jobs</strong><br /><span className="cell-muted">Off = the partner sees the job card without the client. Can also be set per job when sharing.</span></span>
        </label>

        <div style={{ margin: '14px 0 4px', fontSize: 12.5, fontWeight: 600 }}>Agreement</div>
        <div className="pa-three">
          <div><label htmlFor="paAf">From</label><input id="paAf" type="date" value={v.agreementFrom} onChange={(e) => set('agreementFrom', e.target.value)} /></div>
          <div><label htmlFor="paAt">To</label><input id="paAt" type="date" value={v.agreementTo} onChange={(e) => set('agreementTo', e.target.value)} /></div>
          <div><label htmlFor="paFile">File (PDF / photo)</label><input id="paFile" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />{row?.agreement?.name && !file && <div className="cell-muted">Now: {row.agreement.name}</div>}</div>
        </div>
        <label htmlFor="paNo">Notes</label>
        <textarea id="paNo" rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

function LoginModal({ row, partners, onClose, onSaved }) {
  const isNew = !row;
  const [v, setV] = useState({ partnerId: row?.partnerId || '', name: row?.name || '', email: row?.email || '', status: row?.status || 'Active', autoPassword: true, password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setError('');
    if (!v.partnerId) { setError('Pick the partner.'); return; }
    if (!v.name.trim()) { setError('Enter the contact name.'); return; }
    if (!v.email.trim()) { setError('Enter the email.'); return; }
    if (isNew && !v.autoPassword && v.password.length < 10) { setError(`Type a password. ${PW_HINT} Or let the app make one.`); return; }
    setBusy(true);
    try {
      const body = isNew ? { partnerId: v.partnerId, name: v.name, email: v.email, autoPassword: v.autoPassword, password: v.autoPassword ? undefined : v.password } : { name: v.name, email: v.email, status: v.status };
      const res = isNew ? await api.post('/partners/logins', body) : await api.patch(`/partners/logins/${row.id}`, body);
      onSaved(res.data);
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={isNew ? 'Add partner login' : `Edit · ${row.email}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : (isNew ? 'Create login' : 'Save')}</button></>}>
      <div className="pa-form">
        <label htmlFor="plP">Partner</label>
        <select id="plP" value={v.partnerId} disabled={!isNew} onChange={(e) => setV({ ...v, partnerId: e.target.value })}>
          <option value="">Pick the partner…</option>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
        </select>
        <div className="pa-two">
          <div><label htmlFor="plN">Contact name</label><input id="plN" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
          <div><label htmlFor="plE">Email / username</label><input id="plE" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></div>
        </div>
        {!isNew && (
          <div className="pa-choice" style={{ marginTop: 10 }}>
            <button type="button" className={`pa-chip${v.status === 'Active' ? ' on' : ''}`} onClick={() => setV({ ...v, status: 'Active' })}>Active</button>
            <button type="button" className={`pa-chip${v.status === 'Inactive' ? ' on' : ''}`} onClick={() => setV({ ...v, status: 'Inactive' })}>Switched off</button>
          </div>
        )}
        {isNew && (
          <>
            <div style={{ margin: '10px 0 4px', fontSize: 12.5, fontWeight: 600 }}>Temporary password</div>
            <div className="pa-choice">
              <button type="button" className={`pa-chip${v.autoPassword ? ' on' : ''}`} onClick={() => setV({ ...v, autoPassword: true })}>Make one for me</button>
              <button type="button" className={`pa-chip${!v.autoPassword ? ' on' : ''}`} onClick={() => setV({ ...v, autoPassword: false })}>I will type it</button>
            </div>
            {!v.autoPassword && <input type="password" autoComplete="new-password" value={v.password} placeholder={PW_HINT} onChange={(e) => setV({ ...v, password: e.target.value })} style={{ marginTop: 6 }} />}
            <div className="cell-muted" style={{ fontSize: 12, marginTop: 4 }}>Shown to you once. Works for 7 days. The partner must change it the first time they sign in at /partner-login.</div>
          </>
        )}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

function Settings({ isAdmin, onSaved, onError }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/partners/settings').then((r) => setS(r.data)).catch((e) => onError(errText(e, 'Could not load the settings.'))); }, [onError]);
  async function toggle(on) {
    setBusy(true);
    try { const r = await api.put('/partners/settings', { emailsEnabled: on }); setS(r.data); onSaved(r.data.message); } catch (e) { onError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  if (!s) return <div className="empty-mini">Loading…</div>;
  return (
    <div className="pa-settings">
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Partner emails</h3>
        <div className="small-muted" style={{ margin: '6px 0 10px' }}>
          One switch for every email the Partner Portal sends: "your candidate moved to interview / joined", "payout approved / paid", "a job was shared with you".
          Off (default): nothing is emailed; partners still see every notice inside their portal.
        </div>
        <div className="pa-choice">
          <button type="button" className={`pa-chip${!s.emailsEnabled ? ' on' : ''}`} disabled={!isAdmin || busy} onClick={() => toggle(false)}>Off (default)</button>
          <button type="button" className={`pa-chip${s.emailsEnabled ? ' on' : ''}`} disabled={!isAdmin || busy} onClick={() => toggle(true)}>On</button>
        </div>
        {s.updatedAt && <div className="cell-muted" style={{ marginTop: 6 }}>Last changed {when(s.updatedAt)}{s.updatedByName ? ` by ${s.updatedByName}` : ''}</div>}
        {!isAdmin && <div className="cell-muted" style={{ marginTop: 6 }}>Only Super Admin or Admin can change this.</div>}
      </div>
      <div className="card">
        <h3>How partners work</h3>
        <dl className="pa-dl">
          <dt>Sign-in</dt><dd>/partner-login. 5 wrong passwords lock the login for 30 minutes; signed out after 30 minutes idle; password reset only here.</dd>
          <dt>They see</dt><dd>Only the jobs you shared with them, their own candidates with the step they are at, and their own payouts. Nothing else.</dd>
          <dt>Duplicates</dt><dd>A person already with TeamLink (or sent earlier by another partner) is refused with the date. The first partner to send a person owns them for the ownership days.</dd>
          <dt>Payout</dt><dd>Drafted when the candidate joins and the client invoice exists; on hold until the guarantee ends; approved by a second person in Invoices → Partner payouts; booked as an office cost “Partner payout”.</dd>
        </dl>
      </div>
    </div>
  );
}

function AuditList({ partners, initial, onClear }) {
  const [pid, setPid] = useState(initial?.id || '');
  const [rows, setRows] = useState(null);
  useEffect(() => { setPid(initial?.id || ''); }, [initial]);
  useEffect(() => {
    api.get('/partners/audit', { params: { partnerId: pid || undefined } }).then((r) => setRows(r.data)).catch(() => setRows([]));
  }, [pid]);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <select value={pid} onChange={(e) => { setPid(e.target.value); if (!e.target.value) onClear?.(); }}>
          <option value="">All partners</option>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="small-muted">Every partner action, ownership decision, payout, approval and payment — newest first.</span>
      </div>
      {!rows ? <div className="empty-mini">Loading…</div> : !rows.length ? <div className="empty-mini">Nothing recorded yet.</div> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>What</th><th>Who</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(r.at)}</td>
                  <td><strong>{r.action}</strong><div className="cell-muted">{r.entity}</div></td>
                  <td>{r.by}</td>
                  <td style={{ fontSize: 12.5 }}>{r.from && <div className="cell-muted">From: {r.from}</div>}{r.to && <div>{r.to}</div>}{r.reason && <div className="cell-muted">{r.reason}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

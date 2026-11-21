import { useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// LOGIN & COMPANY EMAIL on the employee page (founder 2026-11-06), for HR / Admin. The personal email stays for documents and password recovery; the company email
// becomes the login. Saving moves the login, signs the person out, and tells them on their personal email (utils/companyEmail.js). With cPanel connected on the server,
// "Create mailbox" also makes the mailbox. Data: GET / POST /employees/:id/company-email.
// SIGN-IN DETAILS (founder 2026-11-09): a password HR types or generates (Teamlink@ + month and year of joining) for the new mailbox,
// and "Send credentials": it becomes the TeamLink and webmail password and both links go to the personal email
// (POST /employees/:id/company-email/credentials). TeamLink asks for a new password at the first sign-in.
// ---------------------------------------------------------------------------
export default function CompanyEmailCard({ employeeId, onChanged }) {
  const [s, setS] = useState(null);
  const [email, setEmail] = useState('');
  const [personal, setPersonal] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [secret, setSecret] = useState('');
  const [pw, setPw] = useState('');
  const [to, setTo] = useState('');
  const [sentMsg, setSentMsg] = useState('');
  const [sendError, setSendError] = useState('');
  const [pe, setPe] = useState('');
  const [peMsg, setPeMsg] = useState('');
  const [peError, setPeError] = useState('');

  function load() {
    return api.get(`/employees/${employeeId}/company-email`).then((r) => {
      setS(r.data);
      setEmail(r.data.companyEmail || r.data.suggestion || '');
      setPersonal(r.data.personalEmail || '');
      // their own email from the profile (never a company address); none = the details go to their phone
      setTo((t) => t || (r.data.personalSuggestion && r.data.personalSuggestion.email) || '');
      setPw((p) => p || (r.data.companyEmail ? r.data.generatedPassword : ''));
    }).catch(() => setS(null));
  }
  useEffect(() => { load(); }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;

  async function save(createMailbox) {
    setBusy(true); setError(''); setMsg(''); setSecret('');
    try {
      const r = await api.post(`/employees/${employeeId}/company-email`, { email, personalEmail: personal, createMailbox, ...(createMailbox && pw ? { password: pw } : {}) });
      setMsg(r.data.message || 'Saved.');
      setSecret(r.data.mailboxPassword || '');
      setEditing(false);
      await load();
      if (onChanged) await onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'That did not save. Please try again.');
    } finally { setBusy(false); }
  }

  async function savePersonalOnly() {
    setBusy(true); setPeError(''); setPeMsg('');
    try {
      const r = await api.post(`/employees/${employeeId}/personal-email`, { personalEmail: pe });
      setPeMsg(r.data.message || 'Saved.');
      setPe('');
      await load();
    } catch (e) {
      setPeError(e.response?.data?.error || 'That did not save. Please try again.');
    } finally { setBusy(false); }
  }

  async function sendCredentials() {
    const where = to.trim() || `their phone ${s.phoneMasked} (WhatsApp, else SMS)`;
    if (!window.confirm(`This makes "${pw}" the TeamLink password${s.cpanel.on ? ' and the webmail password' : ''} for ${s.companyEmail}, and sends both links with it to ${where}. TeamLink asks them for a new password at the first sign-in. Go ahead?`)) return;
    setBusy(true); setSendError(''); setSentMsg('');
    try {
      const r = await api.post(`/employees/${employeeId}/company-email/credentials`, { password: pw, to });
      setSentMsg(r.data.message || 'Sent.');
    } catch (e) {
      setSendError(e.response?.data?.error || 'That did not go. Please try again.');
    } finally { setBusy(false); }
  }

  const showForm = !s.companyEmail || editing;
  const companyDomain = s.companyEmail ? s.companyEmail.split('@')[1] : '';
  const toOnCompanyDomain = !!(companyDomain && to && to.toLowerCase().endsWith(`@${companyDomain}`));
  const passwordBox = (label) => (
    <label className="field">
      <span>{label}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={`e.g. ${s.generatedPassword}`} autoComplete="off" aria-label={label} style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={() => setPw(s.generatedPassword)}>Generate</button>
      </div>
    </label>
  );
  const noPersonal = !s.personalEmail;
  return (
    <>
      <h3 style={{ fontSize: 13, margin: '14px 0 8px' }}>Login &amp; company email</h3>
      <div className="kv"><span className="k">Personal email</span><span>{s.personalEmail || (s.companyEmail ? '—' : s.workingEmail || '—')}</span></div>
      <div className="kv"><span className="k">Company email</span><span>{s.companyEmail || 'Not given yet'}</span></div>
      <div className="kv"><span className="k">Signs in with</span><span>{s.loginEmail || 'No login yet'}</span></div>
      {s.assignedAt && <div className="kv"><span className="k">Given by</span><span>{`${s.assignedBy || 'HR'} · ${new Date(s.assignedAt).toLocaleString('en-GB')}`}</span></div>}
      {showForm ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {noPersonal && s.companyEmail === null && !s.workingEmail && (
            <label className="field"><span>Personal email</span><input type="email" value={personal} onChange={(e) => setPersonal(e.target.value)} placeholder="their own email" /></label>
          )}
          {noPersonal && s.companyEmail && (
            <label className="field"><span>Personal email (for password recovery)</span><input type="email" value={personal} onChange={(e) => setPersonal(e.target.value)} placeholder="their own email" /></label>
          )}
          <label className="field">
            <span>Company email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={s.domains.length ? `name@${s.domains[0]}` : 'name@company.com'} aria-label="Company email" />
          </label>
          {s.cpanel.on && passwordBox('Mailbox password (empty: a random one)')}
          <div className="small-muted">
            {s.cpanel.on ? 'Make the mailbox from here, or use one already made in cPanel.' : 'Make the mailbox in cPanel first, then write it here.'}
            {' '}The person is signed out and uses this email from their next sign-in; their password stays the same. They are told on their personal email.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {s.cpanel.on && <button type="button" className="btn btn-sm btn-primary" disabled={busy || !email.trim()} onClick={() => save(true)}>{busy ? 'Working…' : 'Create mailbox and assign'}</button>}
            <button type="button" className={`btn btn-sm${s.cpanel.on ? '' : ' btn-primary'}`} disabled={busy || !email.trim()} onClick={() => save(false)}>{busy ? 'Saving…' : 'Assign company email'}</button>
            {editing && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setEditing(false); setEmail(s.companyEmail || ''); setError(''); }}>Cancel</button>}
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setEditing(true)}>Change company email</button>
      )}
      {s.companyEmail && !editing && (
        <div id="signin-details" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ fontSize: 13, margin: 0 }}>Sign-in details</h3>
          {passwordBox(s.cpanel.on ? 'Password for TeamLink and webmail' : 'Password for TeamLink')}
          <label className="field"><span>Send to (their own email)</span><input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={s.phoneMasked ? `empty: by WhatsApp / SMS to ${s.phoneMasked}` : 'their own email'} /></label>
          {s.personalSuggestion && to === s.personalSuggestion.email && <div className="small-muted">{`Taken from ${s.personalSuggestion.from}.`}</div>}
          {!to.trim() && s.phoneMasked && <div className="small-muted">{`No own email on the profile, so the details go to their phone ${s.phoneMasked} by WhatsApp (SMS if WhatsApp does not go).`}</div>}
          {toOnCompanyDomain && <div className="notice amber">{`${to} is a company address. They can read it only after signing in to webmail with this password, so tell them the password too.`}</div>}
          <div className="small-muted">
            {`The mail has the TeamLink HRMS link${s.cpanel.on ? ', the webmail link' : ''}, the email and this password. TeamLink asks them for a new password at the first sign-in.`}
          </div>
          <div><button type="button" className="btn btn-sm btn-primary" disabled={busy || !pw || (!to.trim() && !s.phoneMasked)} onClick={sendCredentials}>{busy ? 'Sending…' : 'Send credentials'}</button></div>
          {sendError && <div className="error-text">{sendError}</div>}
          {sentMsg && <div className="notice green">{sentMsg}</div>}
        </div>
      )}
      {noPersonal && !(showForm && (s.companyEmail || (s.companyEmail === null && !s.workingEmail))) && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field">
            <span>Personal email (for password recovery)</span>
            <input type="email" value={pe} onChange={(e) => { setPe(e.target.value); setPeError(''); setPeMsg(''); }} placeholder="their own email, e.g. name@gmail.com" aria-label="Personal email for password recovery" />
          </label>
          <div className="small-muted">If they forget their password they can type this address on the Forgot password page and the reset link comes here. Their login stays as it is.</div>
          <div><button type="button" className="btn btn-sm" disabled={busy || !pe.trim()} onClick={savePersonalOnly}>{busy ? 'Saving…' : 'Save personal email'}</button></div>
          {peError && <div className="error-text">{peError}</div>}
          {peMsg && <div className="notice green">{peMsg}</div>}
        </div>
      )}
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      {msg && <div className="notice green" style={{ marginTop: 6 }}>{msg}</div>}
      {secret && <div className="notice amber" style={{ marginTop: 6 }}>{`The mail could not carry the mailbox password, so give it to them yourself. It is shown only now: ${secret}`}</div>}
    </>
  );
}

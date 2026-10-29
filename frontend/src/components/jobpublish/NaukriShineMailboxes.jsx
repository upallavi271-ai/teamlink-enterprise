import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import JpModal from './JpModal.jsx';
import { useVisiblePoll, when } from './jpKit.js';
import './jobpublish.css';
import './naukriShineMailboxes.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION > INTEGRATIONS > "Naukri & Shine mailboxes"  (founder, 2026-10-29)
//   One card per board: Department -> Recruiter (active recruiters of that department, searchable by name,
//   employee ID or email) -> the mailbox and its app password -> Connect. The server logs in to the mailbox
//   for real BEFORE anything is saved; "Connected" is only shown when it did. The app password goes to the
//   server once and never comes back.
//   Below: Connected mailboxes (Sync now, Reconnect, View logs, Reassign, Disconnect).
//   The engine is the Job Portal's import (routes/portalMailboxes.js on the server).
// ---------------------------------------------------------------------------
const BOARD = { naukri: 'Naukri', shine: 'Shine' };
const PROVIDERS = [['gmail', 'Gmail'], ['outlook', 'Outlook / Microsoft 365'], ['other', 'Other (IMAP)']];
const FIXED = { gmail: { host: 'imap.gmail.com', port: 993 }, outlook: { host: 'outlook.office365.com', port: 993 } };
const PROVIDER_LABEL = { gmail: 'Gmail', outlook: 'Outlook / Microsoft 365', other: 'IMAP' };
const NO_DEPT = '__none';
const EMPTY = { department: '', recruiterId: '', address: '', provider: 'gmail', username: '', appPassword: '', host: '', port: '' };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TONE = { connected: 'ok', processing: 'run', disconnected: 'off', error: 'bad' };
const MAIL_TONE = { processed: 'ok', duplicate: 'off', needs_review: 'warn', needs_mapping: 'warn', failed: 'bad', new: 'run', ignored: 'off' };

const errOf = (e) => {
  const x = e && e.response && e.response.data && e.response.data.error;
  return { code: x && x.code, message: (x && x.message) || (e && e.message) || 'That did not work. Please try again.', details: (x && x.details) || {} };
};
const inDept = (r, dept) => (dept === NO_DEPT ? !String(r.department || '').trim() : String(r.department || '').trim().toLowerCase() === String(dept).toLowerCase());

function Chip({ c }) {
  return <span className={`nsm-chip ${TONE[c.status] || 'off'}`}>{c.statusLabel || c.status}</span>;
}

function Field({ id, label, req, err, hint, children }) {
  return (
    <div className={`nsm-f${err ? ' bad' : ''}`}>
      <label htmlFor={id}>{label}{req && <b className="nsm-req" aria-hidden="true"> *</b>}{req && <span className="nsm-sr"> (required)</span>}</label>
      {children}
      {err ? <span className="nsm-err" id={`${id}-err`} role="alert">{err}</span> : hint ? <span className="nsm-hint">{hint}</span> : null}
    </div>
  );
}

function MailboxCard({ src, data, onConnected }) {
  const [f, setF] = useState(EMPTY);
  const [errs, setErrs] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const going = useRef(false);
  const id = (k) => `nsm-${src}-${k}`;
  const set = (k) => (e) => { const v = e.target.value; setF((o) => ({ ...o, [k]: v, ...(k === 'department' ? { recruiterId: '' } : {}) })); setErrs((o) => ({ ...o, [k]: '' })); };
  const recs = (data.recruiters || []).filter((r) => r.active && f.department && inDept(r, f.department));
  const hasNoDept = (data.recruiters || []).some((r) => r.active && !String(r.department || '').trim());
  const fixed = FIXED[f.provider];
  const mine = (data.connections || []).filter((c) => c.source === src);
  const aria = (k) => (errs[k] ? { 'aria-invalid': true, 'aria-describedby': `${id(k)}-err` } : {});

  async function connect(takeOver) {
    if (going.current) return; // one click = one login attempt
    const e = {};
    if (!f.department) e.department = 'Select a department.';
    if (!f.recruiterId) e.recruiterId = 'Select a recruiter.';
    else if (!recs.some((r) => r.id === f.recruiterId)) e.recruiterId = 'Choose an active recruiter from the selected department.';
    if (!EMAIL.test(f.address.trim())) e.address = 'Enter a valid email address.';
    if (!f.appPassword) e.appPassword = 'Enter the app password.';
    if (f.provider === 'other' && !f.host.trim()) e.host = 'Enter the incoming mail server.';
    if (f.provider === 'other' && f.port && !(Number(f.port) >= 1 && Number(f.port) <= 65535)) e.port = 'Enter a port between 1 and 65535.';
    setErrs(e); setMsg(null);
    if (Object.keys(e).length) return;
    going.current = true; setBusy(true);
    try {
      const body = {
        source: src, recruiterId: f.recruiterId, address: f.address.trim(), provider: f.provider, appPassword: f.appPassword,
        department: f.department !== NO_DEPT ? f.department : undefined, username: f.username.trim() || undefined,
        ...(f.provider === 'other' ? { host: f.host.trim(), port: f.port ? Number(f.port) : undefined } : {}),
        ...(takeOver ? { takeOver: true } : {}),
      };
      const { data: out } = await api.post('/portal-mailboxes', body);
      setF(EMPTY); setShow(false); // the password leaves the page
      setMsg({ ok: true, text: out.message || 'Connected.' });
      onConnected();
    } catch (err) {
      const x = errOf(err);
      if (x.code === 'MAILBOX_PERSONAL') {
        going.current = false; setBusy(false);
        if (window.confirm(`${x.message}\n\nTake it over?`)) { connect(true); return; }
        setMsg({ ok: false, text: x.message }); return;
      }
      setF((o) => ({ ...o, appPassword: '' }));
      setErrs(x.details || {});
      setMsg({ ok: false, text: x.message });
    } finally { going.current = false; setBusy(false); }
  }

  return (
    <section className={`nsm-card ${src}`} aria-labelledby={id('title')}>
      <div className="nsm-card-hd">
        <span className={`nsm-logo ${src}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" focusable="false"><path fill="currentColor" d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2.3V17h16V7.3l-8 5.2-8-5.2zM5.6 7l6.4 4.2L18.4 7H5.6z" /></svg>
        </span>
        <div><h3 id={id('title')}>{BOARD[src]} mailbox</h3><p>Reads the {BOARD[src]} response emails in this mailbox and adds them as {BOARD[src]} applications to the chosen recruiter.</p></div>
      </div>
      {msg && <div className={msg.ok ? 'jp-ok' : 'jp-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      <div className="nsm-grid">
        <Field id={id('department')} label="Select Department" req err={errs.department}>
          <Combo id={id('department')} value={f.department} onChange={set('department')} departments={false} placeholder="Select department" {...aria('department')}>
            <option value="">Select department</option>
            {(data.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
            {hasNoDept && <option value={NO_DEPT}>No department set</option>}
          </Combo>
        </Field>
        <Field id={id('recruiterId')} label="Select Recruiter" req err={errs.recruiterId} hint={f.department ? 'Type a name, employee ID or email.' : 'Choose the department first.'}>
          <Combo id={id('recruiterId')} value={f.recruiterId} onChange={set('recruiterId')} disabled={!f.department} placeholder={f.department ? 'Search recruiter' : 'Select a department first'} emptyText="No active recruiter matches" {...aria('recruiterId')}>
            <option value="">Select recruiter</option>
            {recs.map((r) => <option key={r.id} value={r.id}>{r.name}{r.employeeId ? ` · ${r.employeeId}` : ''}{r.email ? ` · ${r.email}` : ''}</option>)}
          </Combo>
        </Field>
        <Field id={id('address')} label={`${BOARD[src]} Mailbox Email`} req err={errs.address}>
          <input id={id('address')} type="email" autoComplete="off" placeholder="responses@company.com" value={f.address} onChange={set('address')} {...aria('address')} />
        </Field>
        <Field id={id('provider')} label="Email Provider">
          <Combo id={id('provider')} value={f.provider} onChange={(e) => { setF((o) => ({ ...o, provider: e.target.value || 'gmail' })); setErrs({}); }}>
            {PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Combo>
        </Field>
        <Field id={id('username')} label="Username" hint="Leave empty to sign in with the mailbox email.">
          <input id={id('username')} autoComplete="off" placeholder={f.address || 'Same as the mailbox email'} value={f.username} onChange={set('username')} />
        </Field>
        <Field id={id('appPassword')} label="App Password" req err={errs.appPassword}
          hint={f.provider === 'gmail' ? 'Gmail: Google Account → Security → 2-Step Verification → App passwords (IMAP on).' : 'Use an app password if the account has two-step sign-in.'}>
          <div className="nsm-pw">
            <input id={id('appPassword')} type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false}
              placeholder={f.provider === 'gmail' ? '16-character Google app password' : 'App password'} value={f.appPassword} onChange={set('appPassword')} {...aria('appPassword')} />
            <button type="button" className="nsm-eye" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={`${show ? 'Hide' : 'Show'} the app password`}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </Field>
        <Field id={id('host')} label="Incoming Mail Server" req={f.provider === 'other'} err={errs.host}>
          <input id={id('host')} placeholder="imap.company.com" value={fixed ? fixed.host : f.host} readOnly={!!fixed} onChange={set('host')} {...aria('host')} />
        </Field>
        <Field id={id('port')} label="Incoming Mail Port" err={errs.port}>
          <input id={id('port')} type="number" min="1" max="65535" placeholder="993" value={fixed ? fixed.port : f.port} readOnly={!!fixed} onChange={set('port')} {...aria('port')} />
        </Field>
        <div className="nsm-f"><span className="nsm-label">Connection security</span><div className="nsm-fixed">SSL/TLS (IMAP over SSL)</div></div>
        <div className="nsm-f"><span className="nsm-label">Connection status</span>
          <div className="nsm-fixed">
            {mine.length ? mine.map((c) => <div key={c.id}><Chip c={c} /> <span className="nsm-sub">{c.address}{c.recruiterName ? ` · ${c.recruiterName}` : ''}</span></div>)
              : <span className="nsm-chip off">Not connected</span>}
          </div>
        </div>
      </div>
      <div className="nsm-card-ft">
        <span className="nsm-hint">The login is checked with the mail server before anything is saved. The password is stored encrypted and never shown again.</span>
        <button type="button" className="btn btn-primary" disabled={busy || data.canStoreCredentials === false} aria-busy={busy} onClick={() => connect(false)}>{busy ? 'Verifying login…' : 'Connect'}</button>
      </div>
    </section>
  );
}

export default function NaukriShineMailboxes() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState({});
  const [flash, setFlash] = useState(null);
  const [modal, setModal] = useState(null);

  const load = useCallback(async () => {
    try { const { data: d } = await api.get('/portal-mailboxes'); setData(d); setErr(''); } catch (e) { setErr(errOf(e).message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const syncing = !!(data && (data.connections || []).some((c) => c.status === 'processing'));
  useVisiblePoll(load, syncing, 2500);

  const recName = (rid) => { const r = ((data && data.recruiters) || []).find((x) => x.id === rid); return r ? r.name : rid; };
  async function act(c, kind) {
    if (kind === 'disconnect' && !window.confirm(`Disconnect the ${c.sourceLabel} mailbox ${c.address}?\n\nThe saved app password is erased and no more email is read. Candidates already imported stay with their recruiter.`)) return;
    setBusy((b) => ({ ...b, [c.id]: true })); setFlash(null);
    try {
      const { data: r } = await api.post(`/portal-mailboxes/${encodeURIComponent(c.id)}/${kind}`, {});
      setFlash({ ok: !r.error, text: kind === 'sync'
        ? (r.error ? `Sync failed: ${r.error}` : `Sync done: ${r.emailsRead || 0} read, ${r.imported || 0} imported, ${r.duplicates || 0} duplicates skipped, ${r.pendingReview || 0} for review${r.failed ? `, ${r.failed} failed` : ''}.`)
        : (r.message || 'Disconnected.') });
    } catch (e) { setFlash({ ok: false, text: errOf(e).message }); }
    setBusy((b) => ({ ...b, [c.id]: false }));
    load();
  }
  async function openLogs(c) {
    setModal({ kind: 'logs', c, loading: true });
    try { const { data: r } = await api.get(`/portal-mailboxes/${encodeURIComponent(c.id)}/logs`); setModal({ kind: 'logs', c, emails: r.emails || [], events: r.events || [] }); } catch (e) { setModal({ kind: 'logs', c, err: errOf(e).message }); }
  }

  if (!data && !err) return <div className="jp-note" role="status">Loading the Naukri and Shine mailboxes…</div>;
  if (!data) return <div className="jp-wrap"><div className="jp-err" role="alert">{err}</div><button type="button" className="btn" onClick={load}>Try again</button></div>;
  const rows = data.connections || [];
  return (
    <div className="nsm-wrap">
      <p className="jp-note" style={{ margin: 0 }}>Connect the mailbox that receives Naukri responses and the one that receives Shine responses. Each one adds its applications to the recruiter you choose. Posting jobs to Naukri and Shine is set up on the Job portals tab.</p>
      {data.canStoreCredentials === false && <div className="jp-err" role="alert">The Job Portal server cannot store mailbox passwords yet: INTEGRATION_SECRET_KEY is not set there (at least 16 characters). Until it is, Connect is refused.</div>}
      <div className="nsm-cards">
        <MailboxCard src="naukri" data={data} onConnected={load} />
        <MailboxCard src="shine" data={data} onConnected={load} />
      </div>
      <div className="nsm-tablehd"><h3>Connected mailboxes</h3><button type="button" className="btn" onClick={load}>Refresh</button></div>
      <div role="status" aria-live="polite">{flash && <div className={flash.ok ? 'jp-ok' : 'jp-err'}>{flash.text}</div>}</div>
      {err && <div className="jp-err" role="alert">{err}</div>}
      {!rows.length ? <div className="nsm-empty">No Naukri or Shine mailbox is connected yet. Use the cards above.</div> : (
        <div className="nsm-tablewrap">
          <table className="nsm-table">
            <thead><tr>{['Source', 'Department', 'Recruiter', 'Mailbox Email', 'Provider', 'Connection Status', 'Last Successful Sync', 'Emails Processed', 'Imported', 'Duplicates', 'Pending Review', 'Failed', 'Actions'].map((t) => <th key={t} scope="col">{t}</th>)}</tr></thead>
            <tbody>
              {rows.map((c) => {
                const b = !!busy[c.id]; const off = c.status === 'disconnected';
                return (
                  <tr key={c.id}>
                    <td><span className={`nsm-src ${c.source}`}>{c.sourceLabel}</span></td>
                    <td>{c.recruiterDepartment || '—'}</td>
                    <td><b>{c.recruiterName || '—'}</b></td>
                    <td>{c.address}</td>
                    <td>{PROVIDER_LABEL[c.provider] || c.provider || '—'}{c.host && <div className="nsm-sub">{c.host}{c.port ? `:${c.port}` : ''}</div>}</td>
                    <td><Chip c={c} />{c.lastError && <div className="nsm-rowerr" title={c.lastError}>{c.lastError.length > 90 ? `${c.lastError.slice(0, 90)}…` : c.lastError}</div>}</td>
                    <td>{when(c.lastSuccessfulSyncAt) || '—'}</td>
                    <td className="num">{c.emailsProcessed}</td>
                    <td className="num">{c.candidatesImported}</td>
                    <td className="num">{c.duplicatesSkipped}</td>
                    <td className="num">{c.pendingReview}</td>
                    <td className="num">{c.failedImports}</td>
                    <td>
                      <div className="nsm-acts">
                        <button type="button" className="btn btn-primary btn-sm" disabled={b || off || c.status === 'processing'} onClick={() => act(c, 'sync')}>{b ? 'Syncing…' : 'Sync now'}</button>
                        <button type="button" className="btn btn-sm" disabled={b} onClick={() => setModal({ kind: 'reconnect', c, pw: '' })}>Reconnect</button>
                        <button type="button" className="btn btn-sm" onClick={() => openLogs(c)}>View logs</button>
                        <button type="button" className="btn btn-sm" disabled={b} onClick={() => setModal({ kind: 'reassign', c, recruiterId: '', ok: false })}>Reassign</button>
                        <button type="button" className="btn btn-sm nsm-danger" disabled={b || off} onClick={() => act(c, 'disconnect')}>Disconnect</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="jp-note">Each mailbox reads only its own job board&apos;s emails, and only for the recruiter chosen for it. Emails that cannot be matched safely are kept for review instead of being guessed. Syncing again never imports the same email twice.</p>
      {modal && <MailboxDialog modal={modal} setModal={setModal} data={data} recName={recName} done={(text) => { setModal(null); setFlash({ ok: true, text }); load(); }} />}
    </div>
  );
}

function MailboxDialog({ modal, setModal, data, recName, done }) {
  const m = modal; const c = m.c;
  const close = () => setModal(null);
  const patch = (x) => setModal((o) => ({ ...o, ...x }));
  async function reconnect() {
    if (!m.pw && !c.hasCredential) { patch({ err: 'Enter the app password.' }); return; }
    patch({ busy: true, err: '' });
    try { const { data: r } = await api.post(`/portal-mailboxes/${encodeURIComponent(c.id)}/reconnect`, m.pw ? { appPassword: m.pw } : {}); done(r.message || 'Reconnected.'); } catch (e) { patch({ busy: false, pw: '', err: errOf(e).message }); }
  }
  async function reassign() {
    if (!m.recruiterId) { patch({ err: 'Select the new recruiter.' }); return; }
    if (!m.ok) { patch({ err: 'Tick the box to confirm the reassignment.' }); return; }
    patch({ busy: true, err: '' });
    try { const { data: r } = await api.post(`/portal-mailboxes/${encodeURIComponent(c.id)}/reassign`, { recruiterId: m.recruiterId, confirm: true }); done(r.message || 'Reassigned.'); } catch (e) { patch({ busy: false, err: errOf(e).message }); }
  }
  if (m.kind === 'reconnect') {
    return (
      <JpModal title={`Reconnect ${c.sourceLabel} mailbox`} onClose={close} foot={<><button type="button" className="btn" onClick={close}>Cancel</button><button type="button" className="btn btn-primary" disabled={m.busy} onClick={reconnect}>{m.busy ? 'Verifying login…' : 'Reconnect'}</button></>}>
        {m.err && <div className="jp-err" role="alert">{m.err}</div>}
        <p className="jp-note">{c.address}: the login is tested again before it is marked connected. {c.hasCredential ? 'Leave the password empty to use the saved one, or enter a new app password.' : 'The saved password was erased when it was disconnected, so enter the app password.'}</p>
        <label className="jp-field" htmlFor="nsm-re-pw">App Password<input id="nsm-re-pw" type="password" autoComplete="new-password" value={m.pw} onChange={(e) => patch({ pw: e.target.value })} /></label>
      </JpModal>
    );
  }
  if (m.kind === 'reassign') {
    const recs = (data.recruiters || []).filter((r) => r.active && r.id !== c.recruiterId);
    return (
      <JpModal title={`Reassign ${c.sourceLabel} mailbox`} onClose={close} foot={<><button type="button" className="btn" onClick={close}>Cancel</button><button type="button" className="btn btn-primary" disabled={m.busy} onClick={reassign}>Reassign</button></>}>
        {m.err && <div className="jp-err" role="alert">{m.err}</div>}
        <p className="jp-note"><b>{c.address}</b> is connected to <b>{c.recruiterName || '—'}</b>. New emails from now on go to the recruiter you choose. Candidates already imported stay with {c.recruiterName || 'their recruiter'}: nothing is moved.</p>
        <label className="jp-field" htmlFor="nsm-re-rec">New recruiter
          <Combo id="nsm-re-rec" value={m.recruiterId} onChange={(e) => patch({ recruiterId: e.target.value })} placeholder="Search recruiter">
            <option value="">Select recruiter</option>
            {recs.map((r) => <option key={r.id} value={r.id}>{r.name}{r.department ? ` · ${r.department}` : ''}{r.employeeId ? ` · ${r.employeeId}` : ''}</option>)}
          </Combo>
        </label>
        <label className="nsm-check"><input type="checkbox" checked={!!m.ok} onChange={(e) => patch({ ok: e.target.checked })} /> I understand: only new imports go to the new recruiter. This change is recorded in the audit log.</label>
      </JpModal>
    );
  }
  const EVENT = { 'intake.mailbox_connected': 'Connected', 'intake.mailbox_reconnected': 'Reconnected', 'intake.mailbox_disconnected': 'Disconnected', 'intake.mailbox_reassigned': 'Reassigned', 'intake.mailbox_synced': 'Synced' };
  return (
    <JpModal title={`${c.sourceLabel} mailbox logs: ${c.address}`} size="is-wide" onClose={close} foot={<button type="button" className="btn" onClick={close}>Close</button>}>
      {m.loading && <div className="jp-note" role="status">Loading…</div>}
      {m.err && <div className="jp-err" role="alert">{m.err}</div>}
      {m.emails && (
        <>
          <h4 className="nsm-h4">Emails</h4>
          {m.emails.length ? (
            <div className="nsm-tablewrap"><table className="nsm-table">
              <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Status</th><th>Details</th><th>Candidate</th></tr></thead>
              <tbody>{m.emails.map((x) => <tr key={x.id || `${x.receivedAt}-${x.subject}`}><td>{when(x.receivedAt) || '—'}</td><td>{x.from || '—'}</td><td>{x.subject || '—'}</td><td><span className={`nsm-chip ${MAIL_TONE[x.status] || 'off'}`}>{x.statusLabel || x.status}</span></td><td className="nsm-reason">{x.reason || ''}</td><td>{x.candidateName || '—'}</td></tr>)}</tbody>
            </table></div>
          ) : <div className="nsm-empty">No email has been read from this mailbox yet.</div>}
          <h4 className="nsm-h4">Connection history</h4>
          {(m.events || []).length ? (
            <ul className="nsm-events">{m.events.map((ev, i) => {
              const d = ev.detail || {};
              const extra = ev.action === 'intake.mailbox_reassigned' ? ` - from ${recName(d.from)} to ${recName(d.to)}`
                : ev.action === 'intake.mailbox_synced' ? ` - ${d.seen || 0} read, ${d.imported || 0} imported, ${d.duplicates || 0} duplicates, ${d.review || 0} for review, ${d.failed || 0} failed`
                  : ev.action === 'intake.mailbox_connected' && d.recruiterId ? ` - to ${recName(d.recruiterId)}` : '';
              return <li key={i}><b>{EVENT[ev.action] || ev.action}</b>{extra} <span>{when(ev.at)}</span></li>;
            })}</ul>
          ) : <div className="nsm-empty">Nothing yet.</div>}
        </>
      )}
    </JpModal>
  );
}

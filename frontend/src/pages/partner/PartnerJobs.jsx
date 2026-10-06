import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import Modal from '../../components/Modal.jsx';
import partnerApi, {
  setPartnerToken, partnerToken, partnerError, PARTNER_NOTICE_KEY,
} from '../../partnerApi';
import './partnerPortal.css';

// /partner/jobs — the partner's ONLY page (B7). Three tabs: Jobs shared with
// you (open one → the job card + "Send a candidate"), My candidates (every
// submission with its step), Payouts. No sidebar. What the partner may see is
// decided by the server (routes/partnerPortal.js).

const inr = (n) => (n == null || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const day = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
// Colours: green good, yellow waiting, red problem, blue going on, grey closed.
const SUB_TONE = { Submitted: 'yellow', Duplicate: 'red', Screening: 'blue', Interview: 'blue', Selected: 'blue', Joined: 'green', Rejected: 'red', Dropped: 'grey' };
const PAY_TONE = { Draft: 'yellow', Approved: 'blue', Paid: 'green', Cancelled: 'grey' };
const Tag = ({ tone, children }) => <span className={`pp-tag pp-${tone || 'grey'}`}>{children}</span>;
const IDLE_MS = 30 * 60 * 1000;
const PW_HINT = 'At least 10 characters with a capital letter, a small letter, a number and a symbol.';

export default function PartnerJobs() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('jobs');
  const [jobs, setJobs] = useState(null);
  const [subs, setSubs] = useState(null);
  const [pays, setPays] = useState(null);
  const [notices, setNotices] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const signOut = useCallback(async (notice) => {
    try { await partnerApi.post('/logout'); } catch { /* already out */ }
    setPartnerToken(null);
    if (notice) { try { sessionStorage.setItem(PARTNER_NOTICE_KEY, notice); } catch { /* ignore */ } }
    navigate('/partner-login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!partnerToken()) { navigate('/partner-login', { replace: true }); return; }
    partnerApi.get('/me').then((r) => {
      if (r.data.mustChangePassword) navigate('/partner-login', { replace: true });
      else setMe(r.data);
    }).catch(() => {});
  }, [navigate]);

  // 30 minutes without a click or a key: signed out (the server does the same).
  const last = useRef(Date.now());
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    const evs = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last.current > IDLE_MS) signOut('You were signed out after 30 minutes without activity. Please sign in again.');
    }, 30000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [signOut]);

  const load = useCallback(() => {
    if (!me) return;
    Promise.all([partnerApi.get('/jobs'), partnerApi.get('/submissions'), partnerApi.get('/payouts'), partnerApi.get('/notices')])
      .then(([a, b, c, d]) => { setJobs(a.data); setSubs(b.data); setPays(c.data); setNotices(d.data); setError(''); })
      .catch((err) => setError(partnerError(err, 'Could not load your portal.')));
  }, [me]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); }, [toast]);

  async function openNotices() {
    setTab('notices');
    if (notices && notices.unread) {
      try { await partnerApi.post('/notices/read'); setNotices({ ...notices, unread: 0, rows: notices.rows.map((n) => ({ ...n, read: true })) }); } catch { /* ignore */ }
    }
  }

  const jobRows = jobs?.rows || [];
  const subRows = subs?.rows || [];
  const counts = subs?.counts || {};
  const payRows = pays?.rows || [];

  return (
    <div className="pp-page">
      <header className="pp-top">
        <div className="pp-brand"><TeamLinkMark width={104} /><span className="pp-top-title">Partner Portal</span></div>
        <div className="pp-top-right">
          <span className="pp-top-name" title={me?.email}>{me?.partnerName}{me?.name ? <small> · {me.name}</small> : null}</span>
          <button type="button" className="btn btn-sm pp-bell" onClick={openNotices} aria-label="Notices">🔔{notices?.unread ? <em>{notices.unread}</em> : null}</button>
          <button type="button" className="btn btn-sm" onClick={() => setPwOpen(true)}>Password</button>
          <button type="button" className="btn btn-sm" onClick={() => signOut()}>Logout</button>
        </div>
      </header>

      <main className="pp-main">
        <div className="pp-head">
          <h1>{tab === 'jobs' ? 'Jobs shared with you' : tab === 'subs' ? 'My candidates' : tab === 'pays' ? 'My payouts' : 'Notices'}</h1>
          <div className="page-sub">
            {tab === 'jobs' && 'Tap a job to read it and send a candidate. Only jobs TeamLink shared with you are here.'}
            {tab === 'subs' && 'Every candidate you sent, with where they are now. TeamLink updates this at each step.'}
            {tab === 'pays' && 'One payout per joining: fee, GST (if you are GST-registered), TDS, and the net amount. Paid after the guarantee period.'}
            {tab === 'notices' && 'What changed, newest first.'}
          </div>
        </div>

        <div className="pp-tabs" role="tablist">
          <button type="button" role="tab" className={`pp-tab${tab === 'jobs' ? ' on' : ''}`} onClick={() => setTab('jobs')}>Jobs{jobs ? <em>{jobRows.length}</em> : null}</button>
          <button type="button" role="tab" className={`pp-tab${tab === 'subs' ? ' on' : ''}`} onClick={() => setTab('subs')}>My candidates{subs ? <em>{subRows.length}</em> : null}</button>
          <button type="button" role="tab" className={`pp-tab${tab === 'pays' ? ' on' : ''}`} onClick={() => setTab('pays')}>Payouts{pays ? <em>{payRows.length}</em> : null}</button>
        </div>

        {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}

        {tab === 'jobs' && (
          !jobs ? <div className="small-muted">Loading…</div> : !jobRows.length ? (
            <div className="pp-empty"><h3>No job is shared with you right now</h3><p>TeamLink will share jobs here. You will get a notice when one arrives.</p></div>
          ) : (
            <div className="pp-cards">
              {jobRows.map((j) => (
                <button type="button" key={j.id} className="pp-job" onClick={() => setOpenId(j.id)}>
                  <div className="pp-meta">{j.reqCode || 'Job'}{j.client ? ` · ${j.client}` : ''}</div>
                  <h3>{j.title}</h3>
                  <div className="pp-meta">{[j.department, j.location, j.experience ? `${j.experience} yrs` : null, j.workMode].filter(Boolean).join(' · ')}</div>
                  {j.skills && <div className="pp-meta">Skills: {j.skills}</div>}
                  <div className="pp-foot">
                    <span>{j.openings} opening{j.openings === 1 ? '' : 's'}{j.salary ? ` · ${j.salary}` : ''}</span>
                    <Tag tone={j.mySubmissions ? 'blue' : 'grey'}>{j.mySubmissions ? `You sent ${j.mySubmissions}` : 'Nobody sent yet'}</Tag>
                  </div>
                </button>
              ))}
            </div>
          )
        )}

        {tab === 'subs' && (
          !subs ? <div className="small-muted">Loading…</div> : (
            <>
              <div className="pp-stat">
                <div><b>{subRows.length}</b><span>Sent in total</span></div>
                <div><b>{(counts.Interview || 0) + (counts.Selected || 0)}</b><span>In interview / selected</span></div>
                <div><b>{counts.Joined || 0}</b><span>Joined</span></div>
                <div><b>{counts.Duplicate || 0}</b><span>Duplicates (not counted)</span></div>
              </div>
              {!subRows.length ? <div className="pp-empty"><h3>You have not sent anyone yet</h3><p>Open a job and press “Send a candidate”.</p></div> : (
                <>
                  <div className="tbl-wrap pp-table">
                    <table>
                      <thead><tr><th>Candidate</th><th>Job</th><th>Sent on</th><th>Where they are</th><th>Payout</th></tr></thead>
                      <tbody>
                        {subRows.map((s) => (
                          <tr key={s.id}>
                            <td><strong>{s.name}</strong><div className="cell-muted">{s.code}{s.phone ? ` · ${s.phone}` : ''}</div></td>
                            <td>{s.job}</td>
                            <td>{day(s.submittedAt)}</td>
                            <td><Tag tone={SUB_TONE[s.status]}>{s.status}</Tag><div className="cell-muted">{s.status === 'Duplicate' ? s.duplicateReason : s.statusText}</div></td>
                            <td>{s.payout ? <><Tag tone={PAY_TONE[s.payout.status]}>{s.payout.status}</Tag> <span className="cell-muted">{inr(s.payout.net)}</span></> : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="pp-rows">
                    {subRows.map((s) => (
                      <div key={s.id} className="pp-row">
                        <div className="pp-row-top"><strong>{s.name}</strong><Tag tone={SUB_TONE[s.status]}>{s.status}</Tag></div>
                        <div className="pp-row-meta">{s.job} · sent {day(s.submittedAt)}</div>
                        <div className="pp-row-meta">{s.status === 'Duplicate' ? s.duplicateReason : s.statusText}{s.payout ? ` · Payout ${s.payout.status} ${inr(s.payout.net)}` : ''}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )
        )}

        {tab === 'pays' && (
          !pays ? <div className="small-muted">Loading…</div> : (
            <>
              <div className="pp-stat">
                <div><b>{inr(pays.totals.preparing)}</b><span>Being prepared</span></div>
                <div><b>{inr(pays.totals.payable)}</b><span>Approved, to be paid</span></div>
                <div><b>{inr(pays.totals.paid)}</b><span>Paid to you</span></div>
              </div>
              {!payRows.length ? <div className="pp-empty"><h3>No payout yet</h3><p>A payout appears here when one of your candidates joins.</p></div> : (
                <>
                  <div className="tbl-wrap pp-table">
                    <table>
                      <thead><tr><th>Payout</th><th>Candidate</th><th>Joined</th><th className="num">Fee</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Net</th><th>Status</th><th>Your invoice</th></tr></thead>
                      <tbody>
                        {payRows.map((p) => <PayoutRow key={p.id} p={p} onDone={(m) => { setToast(m); load(); }} onError={setError} />)}
                      </tbody>
                    </table>
                  </div>
                  <div className="pp-rows">
                    {payRows.map((p) => (
                      <div key={p.id} className="pp-row">
                        <div className="pp-row-top"><strong>{p.number}</strong><Tag tone={PAY_TONE[p.status]}>{p.status}</Tag></div>
                        <div className="pp-row-meta">{p.candidateName} · {p.requirementTitle}</div>
                        <div className="pp-row-meta">Fee {inr(p.fee)}{p.gst ? ` + GST ${inr(p.gst)}` : ''}{p.tds ? ` − TDS ${inr(p.tds)}` : ''} = <b>{inr(p.net)}</b></div>
                        <div className="pp-row-meta">{p.statusText}{p.holdUntil && p.status !== 'Paid' ? ` · after ${day(p.holdUntil)}` : ''}{p.paidOn ? ` · paid ${day(p.paidOn)} (${p.paidRef})` : ''}</div>
                        {p.canUploadInvoice && <InvoiceUpload p={p} onDone={(m) => { setToast(m); load(); }} onError={setError} />}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )
        )}

        {tab === 'notices' && (
          !notices ? <div className="small-muted">Loading…</div> : !notices.rows.length ? <div className="pp-empty"><h3>No notices yet</h3></div> : (
            notices.rows.map((n) => (
              <div key={n.id} className={`pp-notice${n.read ? '' : ' unread'}`}><b>{n.title}</b>{n.message && <div>{n.message}</div>}<small>{new Date(n.at).toLocaleString('en-GB')}</small></div>
            ))
          )
        )}
      </main>

      {openId && <JobDrawer id={openId} onClose={() => setOpenId(null)} onSent={(m) => { setToast(m); load(); }} />}
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); setToast('Password changed.'); }} />}
      {toast && <div className="pp-toast" role="status">{toast}</div>}
    </div>
  );
}

function PayoutRow({ p, onDone, onError }) {
  return (
    <tr>
      <td><strong>{p.number}</strong>{p.kind === 'CLAWBACK' && <div className="cell-muted">Recovery</div>}</td>
      <td>{p.candidateName}<div className="cell-muted">{p.requirementTitle}</div></td>
      <td>{day(p.joinedOn)}</td>
      <td className="num">{inr(p.fee)}</td>
      <td className="num">{p.gst ? inr(p.gst) : '—'}</td>
      <td className="num">{p.tds ? `${inr(p.tds)} (${p.tdsSection} ${p.tdsPercent}%)` : '—'}</td>
      <td className="num"><b>{inr(p.net)}</b></td>
      <td><Tag tone={PAY_TONE[p.status]}>{p.status}</Tag><div className="cell-muted">{p.statusText}{p.holdUntil && p.status !== 'Paid' && p.status !== 'Cancelled' ? ` · after ${day(p.holdUntil)}` : ''}{p.paidOn ? ` · ${day(p.paidOn)} · ${p.paidRef}` : ''}</div></td>
      <td>{p.partnerInvoice ? <span className="cell-muted">{p.partnerInvoice.number || p.partnerInvoice.name}</span> : null}{p.canUploadInvoice && <InvoiceUpload p={p} onDone={onDone} onError={onError} />}</td>
    </tr>
  );
}

function InvoiceUpload({ p, onDone, onError }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ invoiceNumber: '', invoiceDate: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!file) { onError('Choose the invoice file (PDF or photo).'); return; }
    setBusy(true);
    const fd = new FormData();
    fd.append('invoiceNumber', v.invoiceNumber); fd.append('invoiceDate', v.invoiceDate); fd.append('file', file);
    try { const r = await partnerApi.post(`/payouts/${p.id}/invoice`, fd); onDone(r.data.message); setOpen(false); } catch (err) { onError(partnerError(err, 'Could not upload.')); } finally { setBusy(false); }
  }
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{p.partnerInvoice ? 'Replace invoice' : 'Add my invoice'}</button>;
  return (
    <Modal title={`Your invoice for ${p.number}`} onClose={() => setOpen(false)} footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Uploading…' : 'Upload'}</button></>}>
      <div className="pp-form">
        <div className="pp-two">
          <div><label htmlFor="piN">Your invoice number</label><input id="piN" value={v.invoiceNumber} onChange={(e) => setV({ ...v, invoiceNumber: e.target.value })} /></div>
          <div><label htmlFor="piD">Invoice date</label><input id="piD" type="date" value={v.invoiceDate} onChange={(e) => setV({ ...v, invoiceDate: e.target.value })} /></div>
        </div>
        <label htmlFor="piF">File (PDF or photo, up to 10 MB)</label>
        <input id="piF" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>Optional. The payout is the record; your invoice is attached to it for Accounts.</div>
      </div>
    </Modal>
  );
}

function PasswordModal({ onClose, onDone }) {
  const [v, setV] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setError('');
    if (v.newPassword !== v.confirmPassword) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try { await partnerApi.post('/change-password', v); onDone(); } catch (err) { setError(partnerError(err, 'Could not change the password.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="Change password" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Change password'}</button></>}>
      <div className="pp-form">
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
// One job: the card TeamLink allows + "Send a candidate" + your submissions for it.
function JobDrawer({ id, onClose, onSent }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(false);
  const load = useCallback(() => {
    partnerApi.get(`/jobs/${id}`).then((r) => { setD(r.data); setError(''); }).catch((err) => setError(partnerError(err, 'Could not open this job.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !form) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, form]);
  const j = d?.job;
  return (
    <div className="pp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="pp-drawer" role="dialog" aria-label="Job details">
        <div className="pp-drawer-head">
          <div>
            <div className="pp-drawer-code">{j?.reqCode || 'Job'}{j?.client ? ` · ${j.client}` : ''}</div>
            <h2>{j?.title || 'Loading…'}</h2>
          </div>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <div className="notice red" style={{ margin: 10 }}><span>{error}</span></div>}
        {j && (
          <div className="pp-drawer-body">
            <div style={{ marginBottom: 14 }}>
              <button type="button" className="btn btn-primary" onClick={() => setForm(true)}>+ Send a candidate</button>
            </div>
            <section className="pp-sec">
              <h3>About the job</h3>
              <dl className="pp-dl">
                <dt>Department</dt><dd>{j.department || '—'}{j.specialisation ? ` · ${j.specialisation}` : ''}</dd>
                <dt>Location</dt><dd>{j.location || '—'}{j.workMode ? ` · ${j.workMode}` : ''}</dd>
                <dt>Experience</dt><dd>{j.experience ? `${j.experience} years` : '—'}</dd>
                <dt>Must-have skills</dt><dd>{j.skills || '—'}</dd>
                {j.goodToHaveSkills && <><dt>Good to have</dt><dd>{j.goodToHaveSkills}</dd></>}
                <dt>Education</dt><dd>{j.education || '—'}</dd>
                <dt>Salary</dt><dd>{j.salary || 'Not shown'}</dd>
                <dt>Openings</dt><dd>{j.openings}</dd>
                <dt>Notice period</dt><dd>{j.noticePeriodMax ? `up to ${j.noticePeriodMax}` : '—'}</dd>
                {j.closingDate && <><dt>Closes on</dt><dd>{day(j.closingDate)}</dd></>}
              </dl>
            </section>
            {j.jobDescription && <section className="pp-sec"><h3>Job description</h3><div className="pp-pre">{j.jobDescription}</div></section>}
            {j.responsibilities && <section className="pp-sec"><h3>Responsibilities</h3><div className="pp-pre">{j.responsibilities}</div></section>}
            <section className="pp-sec">
              <h3>Candidates you sent for this job</h3>
              {d.submissions.length ? (
                <ul className="pp-list">
                  {d.submissions.map((s) => (
                    <li key={s.id}>
                      <span><b>{s.name}</b><br /><small className="cell-muted">{day(s.submittedAt)} · {s.status === 'Duplicate' ? s.duplicateReason : s.statusText}</small></span>
                      <Tag tone={SUB_TONE[s.status]}>{s.status}</Tag>
                    </li>
                  ))}
                </ul>
              ) : <div className="pp-none">Nobody yet.</div>}
            </section>
          </div>
        )}
      </aside>
      {form && j && <SubmitModal job={j} onClose={() => setForm(false)} onSent={(m) => { setForm(false); load(); onSent(m); }} />}
    </div>
  );
}

function SubmitModal({ job, onClose, onSent }) {
  const [v, setV] = useState({ name: '', phone: '', email: '', currentCtc: '', expectedCtc: '', noticePeriod: '30 Days', location: '', skills: '', note: '', consent: false });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dup, setDup] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function send() {
    setError(''); setDup(null);
    if (!v.name.trim()) { setError('Enter the candidate name.'); return; }
    if (!v.phone.trim()) { setError('Enter the mobile number.'); return; }
    if (!v.email.trim()) { setError('Enter the email.'); return; }
    if (!file) { setError('Attach the resume (PDF or Word).'); return; }
    if (!v.consent) { setError('Tick the consent box first — the candidate must have agreed.'); return; }
    setBusy(true);
    const fd = new FormData();
    Object.entries(v).forEach(([k, val]) => fd.append(k, typeof val === 'boolean' ? (val ? 'yes' : 'no') : val));
    fd.append('resume', file);
    try {
      const r = await partnerApi.post(`/jobs/${job.id}/submit`, fd);
      onSent(r.data.message);
    } catch (err) {
      const d = err.response?.data;
      if (d?.duplicate) setDup(d.error); else setError(partnerError(err, 'Could not send the candidate.'));
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Send a candidate — ${job.title}`}
      size="wide"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>{!dup && <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send candidate'}</button>}</>}
    >
      {dup ? (
        <div>
          <div className="notice red"><span><b>{dup}</b></span></div>
          <p style={{ fontSize: 13 }}>This person is already with TeamLink, so they cannot be counted as yours for this job. Nothing was added. You can send someone else.</p>
        </div>
      ) : (
        <div className="pp-form">
          <div className="pp-two">
            <div><label htmlFor="scN">Candidate name</label><input id="scN" value={v.name} onChange={set('name')} maxLength={120} /></div>
            <div><label htmlFor="scP">Mobile</label><input id="scP" value={v.phone} onChange={set('phone')} placeholder="10 digits" /></div>
          </div>
          <div className="pp-two">
            <div><label htmlFor="scE">Email</label><input id="scE" type="email" value={v.email} onChange={set('email')} /></div>
            <div><label htmlFor="scL">Current location</label><input id="scL" value={v.location} onChange={set('location')} /></div>
          </div>
          <div className="pp-two">
            <div><label htmlFor="scC">Current CTC (per year, ₹)</label><input id="scC" inputMode="numeric" value={v.currentCtc} onChange={set('currentCtc')} placeholder="650000" /></div>
            <div><label htmlFor="scX">Expected CTC (per year, ₹)</label><input id="scX" inputMode="numeric" value={v.expectedCtc} onChange={set('expectedCtc')} placeholder="800000" /></div>
          </div>
          <div className="pp-two">
            <div>
              <label htmlFor="scNP">Notice period</label>
              <select id="scNP" value={v.noticePeriod} onChange={set('noticePeriod')}>
                {['Immediate', '15 Days', '30 Days', '45 Days', '60 Days', '90 Days'].map((o) => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div><label htmlFor="scS">Key skills</label><input id="scS" value={v.skills} onChange={set('skills')} placeholder="comma separated" /></div>
          </div>
          <label htmlFor="scR">Resume (PDF or Word, up to 10 MB)</label>
          <input id="scR" type="file" accept=".pdf,.doc,.docx,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <label htmlFor="scNote">Note for the recruiter (optional)</label>
          <textarea id="scNote" rows={2} value={v.note} onChange={set('note')} maxLength={1000} />
          <label className="pp-consent">
            <input type="checkbox" checked={v.consent} onChange={set('consent')} />
            <span><b>The candidate agreed to share their details with TeamLink</b> and knows they are being proposed for this job. We record this with your name, the date and time.</span>
          </label>
          <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>Duplicate check: a person already with TeamLink (or sent earlier by another partner) is refused with the date, and is not counted as yours.</div>
          {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </Modal>
  );
}

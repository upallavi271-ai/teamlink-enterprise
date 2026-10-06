// ---------------------------------------------------------------------------
// REFER A CANDIDATE (ATS-100 B6.1) — for every TeamLink employee.
// Shown on HRMS → My profile (and ATS Reports → Campaigns → Referrals).
//
//   My link     <site>/careers?ref=<code> (opens the job portal; anyone who
//               applies through it is counted as my referral)
//   The form    name · mobile · email · job (optional) · resume (optional) ·
//               note · "they know I am sharing their details"
//   My list     each person with Submitted / Interview / Joined
//
// Data: GET /api/sourcing/referrals/me, POST /api/sourcing/referrals.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import '../candidate/CandidateRecord.css';

const errText = (err, fallback) => err?.response?.data?.error || fallback;
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
export const referralLink = (code, requirementId) => (requirementId
  ? `${origin()}/jobs/?ref=${encodeURIComponent(code)}#/job/tl_${encodeURIComponent(requirementId)}`
  : `${origin()}/careers?ref=${encodeURIComponent(code)}`);

function Copy({ text, label = 'Copy link' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { window.prompt('Copy this link', text); }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function ReferForm({ jobs, onDone }) {
  const [f, setF] = useState({ name: '', phone: '', email: '', requirementId: '', note: '' });
  const [agreed, setAgreed] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function send(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const fd = new FormData();
    Object.entries(f).forEach(([k, v]) => { if (v) fd.append(k, v); });
    if (agreed) fd.append('agreed', 'yes');
    if (file) fd.append('resume', file);
    try {
      const res = await api.post('/sourcing/referrals', fd);
      onDone(res.data.message || 'Saved.');
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not send. Please try again.') }); } finally { setBusy(false); }
  }
  return (
    <form className="crx-form crx-grid" onSubmit={send}>
      <label className="field"><span>Their full name</span><input value={f.name} onChange={set('name')} required /></label>
      <label className="field"><span>Mobile</span><input value={f.phone} onChange={set('phone')} inputMode="tel" required /></label>
      <label className="field"><span>Email (optional)</span><input value={f.email} onChange={set('email')} type="email" /></label>
      <label className="field">
        <span>Job (optional)</span>
        <select value={f.requirementId} onChange={set('requirementId')}>
          <option value="">Any job — let the team decide</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{[j.title, j.location].filter(Boolean).join(' · ')}</option>)}
        </select>
      </label>
      <label className="field"><span>Resume (optional — PDF or Word)</span><input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files[0] || null)} /></label>
      <label className="field"><span>Why are they a good fit? (optional)</span><input value={f.note} onChange={set('note')} /></label>
      <label className="crx-inline crx-span">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        This person knows I am sharing their details with TeamLink.
      </label>
      <div className="crx-row crx-span">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send referral'}</button>
        <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
      </div>
      {msg && <div className={`crx-flash bad crx-span`}>{msg.text}</div>}
    </form>
  );
}

export default function ReferPanel({ title = 'Refer a friend' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => api.get('/sourcing/referrals/me').then((res) => { setData(res.data); setError(''); })
    .catch((err) => setError(err?.response?.status === 403 ? '' : errText(err, 'Could not load your referrals.')));
  useEffect(() => { load(); }, []);
  if (error) return <div className="card section"><h3 style={{ fontSize: 13 }}>{title}</h3><div className="small-muted">{error}</div></div>;
  if (!data) return null;
  const n = data.counts;
  return (
    <div className="card section">
      <div className="crx-title">
        <h3 style={{ fontSize: 14, margin: 0 }}>{title}</h3>
        {!open && <button type="button" className="btn btn-primary btn-sm" onClick={() => { setOpen(true); setMsg(''); }}>Refer a candidate</button>}
      </div>
      <div className="small-muted">Know someone who fits one of our jobs? Send their details, or share your own link.</div>
      {msg && <div className="crx-flash" role="status">{msg}</div>}
      {open && <ReferForm jobs={data.jobs || []} onDone={(text) => { setOpen(false); if (text) { setMsg(text); load(); } }} />}

      <div className="crx-row crx-mt">
        <span className="small-muted">Your link:</span>
        <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{referralLink(data.code)}</code>
        <Copy text={referralLink(data.code)} />
      </div>

      <div className="c360t-label crx-mt">
        {n.total ? `Your referrals: ${n.total} · ${n.interview} at interview · ${n.joined} joined` : 'Your referrals'}
      </div>
      {n.total === 0 && <div className="small-muted">No referrals yet. When someone you refer applies, they show here.</div>}
      {data.referrals.map((r) => (
        <div key={r.id} className="crx-item">
          <div className="crx-main">
            <b>{r.candidateName}</b>
            <span className="small-muted">{[r.job ? r.job.title : 'No job picked yet', day(r.createdAt), r.via === 'LINK' ? 'through your link' : null].filter(Boolean).join(' · ')}</span>
          </div>
          <StatusChip tone={r.status.tone}>{r.status.label}</StatusChip>
          {r.bonus && (
            <StatusChip tone={r.bonus.status === 'APPROVED' ? 'green' : r.bonus.status === 'REJECTED' ? 'grey' : 'yellow'}>
              {`Bonus ₹${Number(r.bonus.amount || 0).toLocaleString('en-IN')} · ${r.bonus.status === 'APPROVED' ? 'approved' : r.bonus.status === 'REJECTED' ? 'not approved' : 'waiting'}`}
            </StatusChip>
          )}
        </div>
      ))}
    </div>
  );
}

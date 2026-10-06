// ---------------------------------------------------------------------------
// CAMPAIGNS · CAMPUS DRIVES · REFERRALS (ATS-100 B6) — under ATS Reports →
// Campaigns. Three separate buttons (no dropdown); one section open at a time.
//
//   Campaign costs      what each utm_campaign cost + a link maker
//   Campus drives       college + drive date (+ cost), people from each
//   Referrals & bonuses every referral with its status; a bonus amount is
//                       recorded (Super Admin / Admin / HR) and approved by
//                       Super Admin only — never added to payroll here.
// Data: /api/sourcing/* (backend routes/sourcing.js).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import ReferPanel from './ReferPanel.jsx';
import '../candidate/CandidateRecord.css';

const errText = (err, fallback) => err?.response?.data?.error || fallback;
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const rupees = (v) => (v == null || v === '' ? '—' : `₹${Number(v).toLocaleString('en-IN')}`);

function Flash({ msg }) {
  if (!msg) return null;
  return <div className={`crx-flash ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>;
}

// --- campaign costs + link maker ------------------------------------------------
function LinkMaker() {
  const [jobs, setJobs] = useState([]);
  const [f, setF] = useState({ job: '', source: 'facebook', medium: 'social', campaign: '' });
  useEffect(() => { api.get('/sourcing/referrals/me').then((r) => setJobs(r.data.jobs || [])).catch(() => setJobs([])); }, []);
  const q = new URLSearchParams();
  if (f.source) q.set('utm_source', f.source.trim());
  if (f.medium) q.set('utm_medium', f.medium.trim());
  if (f.campaign) q.set('utm_campaign', f.campaign.trim());
  const link = `${window.location.origin}/jobs/?${q.toString()}${f.job ? `#/job/tl_${encodeURIComponent(f.job)}` : ''}`;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="crx-form">
      <div className="c360t-label">Make a campaign link</div>
      <div className="crx-grid">
        <label className="field"><span>Campaign name</span><input value={f.campaign} onChange={set('campaign')} placeholder="e.g. diwali-nurses-2026" /></label>
        <label className="field">
          <span>Job (optional)</span>
          <select value={f.job} onChange={set('job')}>
            <option value="">All jobs</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{[j.title, j.location].filter(Boolean).join(' · ')}</option>)}
          </select>
        </label>
        <label className="field"><span>Where you post it (utm_source)</span><input value={f.source} onChange={set('source')} /></label>
        <label className="field"><span>How (utm_medium)</span><input value={f.medium} onChange={set('medium')} /></label>
      </div>
      {f.campaign && (
        <div className="crx-row">
          <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{link}</code>
          <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard.writeText(link).catch(() => window.prompt('Copy this link', link))}>Copy link</button>
        </div>
      )}
    </div>
  );
}

function CampaignCosts() {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState({});
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState({ name: '', cost: '' });
  const load = () => api.get('/sourcing/campaigns').then((r) => setData(r.data)).catch((err) => setMsg({ bad: true, text: errText(err, 'Could not load campaigns.') }));
  useEffect(() => { load(); }, []);
  if (!data) return <Flash msg={msg} />;
  async function save(row) {
    setMsg(null);
    try {
      await api.post('/sourcing/campaigns', { ...row, cost: edit[row.key] ?? row.cost });
      setMsg({ text: 'Saved.' }); setEdit({ ...edit, [row.key]: undefined }); load();
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); }
  }
  return (
    <div>
      <Flash msg={msg} />
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Campaign</th><th style={{ textAlign: 'right' }}>Applications</th><th>Cost</th>{data.canManage && <th />}</tr></thead>
          <tbody>
            {data.campaigns.map((c) => (
              <tr key={c.key}>
                <td>{c.name}</td>
                <td style={{ textAlign: 'right' }}>{c.applications}</td>
                <td>
                  {data.canManage
                    ? <input style={{ width: 120 }} inputMode="decimal" value={edit[c.key] ?? (c.cost ?? '')} placeholder="₹" onChange={(e) => setEdit({ ...edit, [c.key]: e.target.value })} />
                    : rupees(c.cost)}
                </td>
                {data.canManage && <td><button type="button" className="btn btn-sm" onClick={() => save(c)}>Save</button></td>}
              </tr>
            ))}
            {data.campaigns.length === 0 && <tr><td colSpan="4" className="small-muted">No campaign links used yet. Make one below and share it.</td></tr>}
          </tbody>
        </table>
      </div>
      {data.canManage && (
        <div className="crx-row crx-mt">
          <input className="crx-input" style={{ maxWidth: 240 }} placeholder="Campaign name (utm_campaign)" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          <input className="crx-input" style={{ maxWidth: 140 }} placeholder="Cost ₹" inputMode="decimal" value={adding.cost} onChange={(e) => setAdding({ ...adding, cost: e.target.value })} />
          <button type="button" className="btn btn-sm btn-primary" onClick={async () => { await save({ key: '__new', name: adding.name, cost: adding.cost }); setAdding({ name: '', cost: '' }); }}>Add campaign cost</button>
        </div>
      )}
      <LinkMaker />
    </div>
  );
}

// --- campus drives ---------------------------------------------------------------
function CampusDrives() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [f, setF] = useState({ collegeName: '', driveDate: '', location: '', cost: '' });
  const load = () => api.get('/sourcing/campus-drives').then((r) => setData(r.data)).catch((err) => setMsg({ bad: true, text: errText(err, 'Could not load drives.') }));
  useEffect(() => { load(); }, []);
  if (!data) return <Flash msg={msg} />;
  const showCost = data.drives.some((d) => d.cost !== undefined) || data.canManage;
  async function add(e) {
    e.preventDefault(); setMsg(null);
    try { await api.post('/sourcing/campus-drives', f); setF({ collegeName: '', driveDate: '', location: '', cost: '' }); setMsg({ text: 'Saved.' }); load(); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); }
  }
  return (
    <div>
      <Flash msg={msg} />
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>College</th><th>Drive date</th><th style={{ textAlign: 'right' }}>People</th><th style={{ textAlign: 'right' }}>Added to jobs</th><th style={{ textAlign: 'right' }}>Joined</th>{showCost && <th>Cost</th>}</tr></thead>
          <tbody>
            {data.drives.map((d) => (
              <tr key={d.id}>
                <td>{d.collegeName}{d.location ? <span className="small-muted">{` · ${d.location}`}</span> : null}</td>
                <td>{day(d.driveDate)}</td>
                <td style={{ textAlign: 'right' }}>{d.candidates}</td>
                <td style={{ textAlign: 'right' }}>{d.applications}</td>
                <td style={{ textAlign: 'right' }}>{d.joined}</td>
                {showCost && <td>{rupees(d.cost)}</td>}
              </tr>
            ))}
            {data.drives.length === 0 && <tr><td colSpan="6" className="small-muted">No campus drives yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {data.canManage && (
        <form className="crx-row crx-mt" onSubmit={add}>
          <input className="crx-input" style={{ maxWidth: 240 }} placeholder="College name" value={f.collegeName} onChange={(e) => setF({ ...f, collegeName: e.target.value })} />
          <input className="crx-input" style={{ maxWidth: 160 }} type="date" value={f.driveDate} onChange={(e) => setF({ ...f, driveDate: e.target.value })} />
          <input className="crx-input" style={{ maxWidth: 160 }} placeholder="City (optional)" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          <input className="crx-input" style={{ maxWidth: 120 }} placeholder="Cost ₹" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
          <button type="submit" className="btn btn-sm btn-primary">Add drive</button>
        </form>
      )}
      <div className="small-muted crx-mt">To add a person from a drive: Candidates → Add Candidate → Source "Campus" → pick the drive.</div>
    </div>
  );
}

// --- referrals + bonuses -----------------------------------------------------------
function Referrals() {
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState({});
  const [msg, setMsg] = useState(null);
  const load = () => api.get('/sourcing/referrals').then((r) => setData(r.data)).catch((err) => setMsg({ bad: true, text: errText(err, 'Could not load referrals.') }));
  useEffect(() => { load(); }, []);
  async function act(path, body, okText) {
    setMsg(null);
    try { const r = await api.post(path, body); setMsg({ text: r.data.message || okText }); load(); } catch (err) {
      if (err?.response?.data?.needsConfirm && window.confirm(`${err.response.data.error}\n\nApprove anyway?`)) { act(path, { ...body, selfApprove: true }, okText); return; }
      setMsg({ bad: true, text: errText(err, 'Could not save.') });
    }
  }
  if (!data) return <Flash msg={msg} />;
  const { canRecordBonus, canApproveBonus } = data.rights;
  return (
    <div>
      <Flash msg={msg} />
      <div className="small-muted" style={{ marginBottom: 6 }}>{data.note}</div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Person</th><th>Referred by</th><th>Job</th><th>Status</th><th>Bonus</th>{(canRecordBonus || canApproveBonus) && <th />}</tr></thead>
          <tbody>
            {data.referrals.map((r) => (
              <tr key={r.id}>
                <td>{r.candidateName}</td>
                <td>{r.referrerName}</td>
                <td className="cell-muted">{r.job ? r.job.title : 'No job yet'}</td>
                <td><StatusChip tone={r.status.tone}>{r.status.label}</StatusChip></td>
                <td>
                  {r.bonus ? (
                    <StatusChip tone={r.bonus.status === 'APPROVED' ? 'green' : r.bonus.status === 'REJECTED' ? 'grey' : 'yellow'}>
                      {`${rupees(r.bonus.amount)} · ${r.bonus.status === 'APPROVED' ? 'Approved' : r.bonus.status === 'REJECTED' ? 'Not approved' : 'Waiting for Super Admin'}`}
                    </StatusChip>
                  ) : '—'}
                </td>
                {(canRecordBonus || canApproveBonus) && (
                  <td>
                    <div className="crx-row">
                      {canRecordBonus && (!r.bonus || r.bonus.status !== 'APPROVED') && (
                        <>
                          <input style={{ width: 90 }} placeholder="₹" inputMode="decimal" value={amount[r.id] ?? ''} onChange={(e) => setAmount({ ...amount, [r.id]: e.target.value })} />
                          <button type="button" className="btn btn-sm" onClick={() => act(`/sourcing/referrals/${r.id}/bonus`, { amount: amount[r.id] }, 'Saved.')}>Save bonus</button>
                        </>
                      )}
                      {canApproveBonus && r.bonus && r.bonus.status === 'PROPOSED' && (
                        <>
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => act(`/sourcing/referrals/${r.id}/bonus/decide`, { decision: 'APPROVED' }, 'Approved.')}>Approve</button>
                          <button type="button" className="btn btn-sm" onClick={() => act(`/sourcing/referrals/${r.id}/bonus/decide`, { decision: 'REJECTED' }, 'Rejected.')}>Reject</button>
                        </>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {data.referrals.length === 0 && <tr><td colSpan="6" className="small-muted">No referrals yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PARTS = [['campaigns', 'Campaign costs'], ['drives', 'Campus drives'], ['referrals', 'Referrals & bonuses'], ['mine', 'Refer a candidate']];

export default function SourcingManager() {
  const [part, setPart] = useState(null);
  return (
    <div className="card section" style={{ marginTop: 14 }}>
      <div className="crx-title">
        <h3 style={{ fontSize: 14, margin: 0 }}>Manage sources</h3>
      </div>
      <div className="crx-choice">
        {PARTS.map(([k, label]) => (
          <button key={k} type="button" className={`crx-pill${part === k ? ' on' : ''}`} aria-pressed={part === k} onClick={() => setPart(part === k ? null : k)}>{label}</button>
        ))}
      </div>
      <div className="crx-mt">
        {part === 'campaigns' && <CampaignCosts />}
        {part === 'drives' && <CampusDrives />}
        {part === 'referrals' && <Referrals />}
        {part === 'mine' && <ReferPanel title="Refer a candidate" />}
      </div>
    </div>
  );
}

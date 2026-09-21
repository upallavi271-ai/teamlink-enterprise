// Shared furniture for the Interviews & Joining screens (Interview Feedback,
// Offers, Joining, Internal Hiring). Nothing here decides anything: the API
// refuses, these helpers only render.

import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';

export const fmtDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
export const money = (n) => (n === '' || n == null ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);

// The module's five tabs. The nav links here too; this strip keeps the group
// navigable from inside any one of them.
export const INTJOIN_TABS = [
  { to: '/ats/calendar', label: 'Interview Calendar' },
  { to: '/ats/interview-feedback', label: 'Interview Feedback' },
  { to: '/ats/offers', label: 'Offers' },
  { to: '/ats/joining', label: 'Joining' },
  { to: '/ats/internal-hiring', label: 'Internal Hiring' },
];

// One loader + one action runner, so every screen fails the same way.
export function useWorkspace(url) {
  const [data, setData] = useState({ rows: [], filterOptions: {} });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    api.get(url)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load this workspace.'));
  }
  useEffect(load, [url]);

  async function act(fn, successMessage) {
    setError(''); setNotice(''); setBusy(true);
    try {
      const res = await fn();
      if (successMessage) setNotice(successMessage);
      else if (res && res.data && res.data.message) setNotice(res.data.message);
      load();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'That action could not be completed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { data, error, notice, busy, act, load, setError, setNotice };
}

export function Banner({ error, notice }) {
  return (
    <>
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section" style={{ marginBottom: 14 }}>{notice}</div>}
    </>
  );
}

// styles.css has no modal, so every form on these screens opens as an inline
// card below the table — the same pattern the Interview Calendar uses.
export function Panel({ title, subtitle, children, onClose }) {
  return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><h3>{title}</h3>{subtitle && <div className="page-sub">{subtitle}</div>}</div>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
      {children}
    </div>
  );
}

export function HiringTypeChip({ value }) {
  const internal = value === 'TeamLink Internal Hire';
  return (
    <span className={'status ' + (internal ? 'interview' : 'offer')} title={internal
      ? 'TeamLink Internal Hire: Selected → Internal Offer → Accepted → Hired → HRMS employee. Never invoiced.'
      : 'Client Placement: Selected → Offer → Joined Client → Accounts → Invoice → Receivable. Never an HRMS employee.'}
    >
      {internal ? 'Internal Hire' : 'Client Placement'}
    </span>
  );
}

// The shared filter set for Interviews & Joining: Department, Client,
// Requirement, Candidate, Recruiter, TL, BDE, Hiring Type + a date range.
export const EMPTY_INTJOIN_FILTERS = {
  q: '', department: '', client: '', requirement: '', candidate: '',
  recruiter: '', tl: '', bde: '', hiringType: '', from: '', to: '',
};

export function IntJoinFilters({ filters, setFilter, opts, onClear, count, children }) {
  const sel = (key, blank, list) => (
    <Combo value={filters[key]} onChange={(e) => setFilter({ [key]: e.target.value })}>
      <option value="">{blank}</option>
      {(list || []).map((v) => <option key={v}>{v}</option>)}
    </Combo>
  );
  return (
    <div className="filter-row" style={{ flexWrap: 'wrap' }}>
      <input
        type="text"
        placeholder="Search candidate, requirement…"
        value={filters.q}
        onChange={(e) => setFilter({ q: e.target.value })}
      />
      {sel('department', 'All departments', opts.departments)}
      {sel('client', 'All clients', opts.clients)}
      {sel('requirement', 'All requirements', opts.requirements)}
      {sel('candidate', 'All candidates', opts.candidates)}
      {sel('recruiter', 'All recruiters', opts.recruiters)}
      {sel('tl', 'All TLs', opts.tls)}
      {sel('bde', 'All BDEs', opts.bdes)}
      {sel('hiringType', 'All hiring types', opts.hiringTypes)}
      {children}
      <label className="small-muted">From <input type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
      <label className="small-muted">To <input type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
      <button className="btn btn-sm" onClick={onClear}>Clear</button>
      <span className="small-muted">{count} row(s)</span>
    </div>
  );
}

// The date-range half of the filter, applied to whichever date the screen is
// about (the interview slot, the joining date, …).
export function inRange(value, from, to) {
  if (!from && !to) return true;
  if (!value) return false;
  const d = new Date(value).toISOString().slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

export function matchesShared(row, filters, dateValue) {
  const q = (filters.q || '').trim().toLowerCase();
  if (filters.department && row.requirement.department !== filters.department) return false;
  if (filters.client && row.requirement.client?.name !== filters.client) return false;
  if (filters.requirement && row.requirement.title !== filters.requirement) return false;
  if (filters.candidate && row.candidate.name !== filters.candidate) return false;
  if (filters.recruiter && row.requirement.recruiter?.name !== filters.recruiter) return false;
  if (filters.tl && row.requirement.tl !== filters.tl) return false;
  if (filters.bde && row.requirement.bde?.name !== filters.bde) return false;
  if (filters.hiringType && row.hiringType !== filters.hiringType) return false;
  if (!inRange(dateValue, filters.from, filters.to)) return false;
  if (q && !`${row.candidate.name} ${row.requirement.title}`.toLowerCase().includes(q)) return false;
  return true;
}

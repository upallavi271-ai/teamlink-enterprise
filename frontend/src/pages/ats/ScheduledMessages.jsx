import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ListPageHeader, { StatusTabs, ListToolbar } from '../../components/ui/ListPageHeader.jsx';
import MultiSelect, { csvToList } from '../../components/ats/MultiSelect.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import { PRESETS, presetDates, istToday, dateProblem } from '../../utils/dateRanges.js';
import { when } from '../../components/reminders/remUtil.js';
import {
  OccurrenceTable, SCHED_WORD, SCHED_TONE, progressOf, scheduleAction,
} from '../../components/reminders/ScheduleList.jsx';
import ScheduleBulkModal from '../../components/reminders/ScheduleBulkModal.jsx';
import '../../components/reminders/reminders.css';

// ---------------------------------------------------------------------------
// COMMUNICATION -> SCHEDULED MESSAGES (founder 2026-11-20): every message schedule to candidates in one place.
//   cards     Total, Completed, Upcoming, Failed (and Active, Paused)
//   tabs      All / Upcoming / Active / Completed / Paused / Failed / Cancelled
//   filters   recruiter, candidate (search), requirement, date range, channel, status, kind (checkboxes: several at a time)
//   table     candidate (name, mobile, email), requirement, recruiter, channel, frequency, progress, status, first, next, total, sent,
//             delivered, failed, last sent, created by, Pause / Resume / Edit / Cancel; a row opens every message of the schedule
//   Excel     the same rows, with the filters
// Who: recruiter own candidates, TL / STL the team, Manager / Admin everyone, the BDE side the numbers only (backend: routes/messageSchedules.js).
// ---------------------------------------------------------------------------
const TABS = [['all', 'All'], ['upcoming', 'Upcoming'], ['active', 'Active'], ['completed', 'Completed'], ['paused', 'Paused'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];
const RANGES = [['', 'Any date'], ['next_7', 'Next 7 days'], ['next_30', 'Next 30 days'], ...PRESETS.filter(([k]) => k && k !== 'custom'), ['custom', 'Custom']];
const addDay = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function rangeDates(range, from, to) {
  if (range === 'next_7') return { from: istToday(), to: addDay(istToday(), 6) };
  if (range === 'next_30') return { from: istToday(), to: addDay(istToday(), 29) };
  return presetDates(range, from, to);
}

function Card({ label, value, tone, onClick, active }) {
  return (
    <button type="button" className={`smp-card${active ? ' on' : ''}`} onClick={onClick} data-testid={`smp-card-${label.toLowerCase()}`}>
      <span className="small-muted">{label}</span>
      <b className={tone ? `smp-${tone}` : ''}>{Number(value || 0).toLocaleString('en-IN')}</b>
    </button>
  );
}

export default function ScheduledMessages() {
  const [tab, setTab] = useState('all');
  const [f, setF] = useState({ recruiter: '', requirement: '', channel: '', status: '', kind: '', candidate: '', range: '', from: '', to: '' });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const dates = rangeDates(f.range, f.from, f.to);
  const dateErr = f.range === 'custom' ? dateProblem(f.from, f.to) : '';
  const params = useMemo(() => ({
    tab, recruiter: f.recruiter || undefined, requirement: f.requirement || undefined, channel: f.channel || undefined, status: f.status || undefined, kind: f.kind || undefined,
    candidate: f.candidate.trim() || undefined, from: dates.from || undefined, to: dates.to || undefined,
  }), [tab, f, dates.from, dates.to]);
  useEffect(() => {
    if (dateErr) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api.get('/ats/scheduled-messages', { params }).then((r) => { if (live) { setD(r.data); setErr(''); } }).catch((e) => { if (live) setErr(e.response?.data?.error || 'Could not load the scheduled messages.'); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [JSON.stringify(params), tick, dateErr]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const act = async (s, kind) => {
    setBusy(s.id); setNote('');
    try { const r = await scheduleAction(s, kind); if (r) { setNote(`${s.candidate.name}: ${kind === 'pause' ? 'paused' : kind === 'resume' ? 'resumed' : 'cancelled'}.`); reload(); } } catch (e) { setNote(e.response?.data?.error || 'Could not do that.'); } finally { setBusy(''); }
  };
  async function download() {
    try {
      const r = await api.get('/ats/scheduled-messages/export', { params: { ...params, format: 'xlsx' }, responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data); a.download = `scheduled-messages-${tab}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch { setNote('The Excel file could not be made. Try again.'); }
  }
  const c = (d && d.counts) || {};
  const facets = (d && d.facets) || {};
  const filterCount = ['recruiter', 'requirement', 'channel', 'status', 'kind'].filter((k) => f[k]).length + (f.range ? 1 : 0);
  const chips = [
    ...['recruiter', 'requirement', 'channel', 'status', 'kind'].filter((k) => f[k]).map((k) => ({
      key: k, label: { recruiter: 'Recruiter', requirement: 'Requirement', channel: 'Channel', status: 'Status', kind: 'Kind' }[k],
      value: csvToList(f[k]).map((v) => ((facets[k] || []).find((o) => o.value === v) || { label: v }).label).join(', '), onRemove: () => set({ [k]: '' }),
    })),
    ...(f.range ? [{ key: 'range', label: 'Date', value: (RANGES.find((r) => r[0] === f.range) || ['', f.range])[1], onRemove: () => set({ range: '', from: '', to: '' }) }] : []),
  ];
  const countOnly = d && d.countOnly;
  return (
    <div className="page smp-page">
      <ListPageHeader
        title="Scheduled Messages"
        question="Communication: which message goes to which candidate, when, and did it arrive?"
        data={!countOnly && <button type="button" className="btn btn-sm" onClick={download}>Download Excel</button>}
      />
      <div className="smp-cards" aria-label="Counts">
        <Card label="Total" value={c.total} onClick={() => setTab('all')} active={tab === 'all'} />
        <Card label="Completed" value={c.completed} tone="green" onClick={() => setTab('completed')} active={tab === 'completed'} />
        <Card label="Upcoming" value={c.upcoming} tone="blue" onClick={() => setTab('upcoming')} active={tab === 'upcoming'} />
        <Card label="Failed" value={c.failed} tone="red" onClick={() => setTab('failed')} active={tab === 'failed'} />
        <Card label="Active" value={c.active} tone="green" onClick={() => setTab('active')} active={tab === 'active'} />
        <Card label="Paused" value={c.paused} tone="amber" onClick={() => setTab('paused')} active={tab === 'paused'} />
      </div>
      <StatusTabs label="Schedule status" tabs={TABS.map(([key, label]) => ({ key, label, count: key === 'all' ? c.total : c[key] }))} value={tab} onChange={setTab} />
      {countOnly ? (
        <div className="notice" style={{ marginTop: 8 }}>{d.note}</div>
      ) : (
        <>
          <ListToolbar
            search={f.candidate}
            onSearch={(v) => set({ candidate: v })}
            placeholder="Candidate name or mobile"
            filterCount={filterCount}
            chips={chips}
            onClearAll={() => setF({ recruiter: '', requirement: '', channel: '', status: '', kind: '', candidate: f.candidate, range: '', from: '', to: '' })}
            panel={(
              <>
                <MultiSelect label="Recruiter" value={f.recruiter} onChange={(v) => set({ recruiter: v })} options={facets.recruiter || []} />
                <MultiSelect label="Requirement" value={f.requirement} onChange={(v) => set({ requirement: v })} options={facets.requirement || []} />
                <MultiSelect label="Channel" value={f.channel} onChange={(v) => set({ channel: v })} options={facets.channel || []} />
                <MultiSelect label="Status" value={f.status} onChange={(v) => set({ status: v })} options={facets.status || []} />
                <MultiSelect label="Kind" value={f.kind} onChange={(v) => set({ kind: v })} options={facets.kind || []} />
                <label className="smp-range">
                  <span className="small-muted">Date (any message of the schedule)</span>
                  <select aria-label="Date range" value={f.range} onChange={(e) => set({ range: e.target.value })}>{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  {f.range === 'custom' && (
                    <span className="rem-actions">
                      <input type="date" aria-label="From" value={f.from} onChange={(e) => set({ from: e.target.value })} />
                      <input type="date" aria-label="To" value={f.to} onChange={(e) => set({ to: e.target.value })} />
                    </span>
                  )}
                  {dateErr && <span className="rem-bad">{dateErr}</span>}
                </label>
              </>
            )}
          />
          {note && <div className="notice" role="status" style={{ margin: '6px 0' }}>{note}</div>}
          {err && <div className="error-text">{err}</div>}
          <div className="tbl-wrap smp-table-wrap">
            <table className="smp-table" data-testid="smp-table">
              <thead>
                <tr>
                  <th>Candidate</th><th>Requirement</th><th>Recruiter</th><th>Channel</th><th>Frequency</th><th>Progress</th><th>Status</th>
                  <th>First scheduled</th><th>Next</th><th>Total</th><th>Sent</th><th>Delivered</th><th>Failed</th><th>Last sent</th><th>Created by</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {d && d.rows.map((s) => (
                  <Fragment key={s.id}>
                    <tr className={`smp-row${open === s.id ? ' open' : ''}`} onClick={() => setOpen(open === s.id ? null : s.id)} data-testid="smp-row">
                      <td>
                        <Link to={`/candidates/${s.candidateId}?tab=scheduled`} onClick={(e) => e.stopPropagation()}><b>{s.candidate.name}</b></Link>
                        <div className="small-muted" style={{ fontSize: 11 }}>{[s.candidate.phone, s.candidate.email].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>{s.requirement || '—'}</td>
                      <td>{s.recruiter || '—'}</td>
                      <td>{s.channel}</td>
                      <td>{s.automatic ? <><span>{s.triggerLabel}</span><div className="small-muted" style={{ fontSize: 11 }}>{`Automatic · ${s.frequencyLabel}`}</div></> : s.frequencyLabel}</td>
                      <td><b>{progressOf(s)}</b></td>
                      <td><StatusChip tone={SCHED_TONE[s.status] || 'grey'}>{SCHED_WORD[s.status] || s.status}</StatusChip>{s.stopReason && <div className="small-muted" style={{ fontSize: 11 }}>{s.stopReason}</div>}</td>
                      <td className="cell-muted smp-time">{when(s.firstAt)}</td>
                      <td className="cell-muted smp-time">{s.nextAt ? when(s.nextAt) : '—'}</td>
                      <td>{s.totalPlanned == null ? 'Until stopped' : s.totalPlanned}</td>
                      <td>{s.counts.sent}</td>
                      <td>{s.counts.delivered}</td>
                      <td className={s.counts.failed ? 'rem-bad' : ''}>{s.counts.failed}</td>
                      <td className="cell-muted smp-time">{s.lastSentAt ? when(s.lastSentAt) : '—'}</td>
                      <td className="cell-muted">{s.createdBy || '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="rem-actions">
                          {['upcoming', 'active'].includes(s.status) && <button type="button" className="btn btn-sm" disabled={busy === s.id} onClick={() => act(s, 'pause')}>Pause</button>}
                          {s.status === 'paused' && <button type="button" className="btn btn-sm btn-primary" disabled={busy === s.id} onClick={() => act(s, 'resume')}>Resume</button>}
                          {!s.automatic && ['upcoming', 'active', 'paused'].includes(s.status) && <button type="button" className="btn btn-sm" disabled={busy === s.id} onClick={() => setEditing(s)}>Edit</button>}
                          {['upcoming', 'active', 'paused'].includes(s.status) && <button type="button" className="btn btn-sm btn-ghost" disabled={busy === s.id} onClick={() => act(s, 'cancel')}>Cancel</button>}
                        </div>
                      </td>
                    </tr>
                    {open === s.id && (
                      <tr className="smp-detail"><td colSpan={16}>
                        {s.body && <div className="sm-words" style={{ marginBottom: 6 }}>{s.channel === 'Email' && s.subject ? `Subject: ${s.subject}\n` : ''}{s.body}</div>}
                        <OccurrenceTable id={s.id} refreshKey={tick} />
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {d && !d.rows.length && <tr><td colSpan={16} className="small-muted">No scheduled messages here. Schedule one from a candidate&apos;s profile (Schedule a message) or tick candidates on Candidates &amp; Pipeline.</td></tr>}
                {!d && !err && <tr><td colSpan={16} className="small-muted">Loading…</td></tr>}
              </tbody>
            </table>
          </div>
          {d && d.total > d.rows.length && <div className="small-muted" style={{ marginTop: 4 }}>{`Showing ${d.rows.length} of ${d.total}. Narrow the filters, or download Excel for all.`}</div>}
        </>
      )}
      {editing && <ScheduleBulkModal schedule={editing} onClose={() => setEditing(null)} onDone={() => { setNote(`${editing.candidate.name}: the schedule is changed.`); reload(); }} />}
    </div>
  );
}

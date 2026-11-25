import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './Probation.css';

// ---------------------------------------------------------------------------
// PROBATION AND CONFIRMATION (founder 2026-11-25, from the HR audit questionnaire). HRMS > Probation.
// ADDITIVE: it only talks to /api/probation (backend/src/routes/probation.js, utils/probation.js) and changes no employee record.
// Everything is OFF until HR switches tracking on. HR / Admin see everybody and decide (confirm, extend, end service);
// a Team Lead sees only their own team and adds a review.
// ---------------------------------------------------------------------------

const TABS = [
  ['inProbation', 'In probation'], ['due30', 'Due in 30 days'], ['overdue', 'Overdue'], ['extended', 'Extended'],
  ['confirmed', 'Confirmed'], ['ending', 'Service ending'], ['notTracked', 'Not tracked'], ['all', 'All'],
];
const REC = ['Confirm', 'Extend', 'End service'];
const OPEN = ['In probation', 'Extended'];

const fmt = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const errOf = (e, fallback) => (e.response && e.response.data && e.response.data.error) || fallback;
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function leftWords(r) {
  if (r.daysLeft === null || r.daysLeft === undefined) return '';
  if (r.daysLeft < 0) return `${-r.daysLeft} day${r.daysLeft === -1 ? '' : 's'} overdue`;
  if (r.daysLeft === 0) return 'ends today';
  return `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`;
}
function Pill({ r }) {
  const cls = r.overdue ? 'bad' : r.dueSoon ? 'warn' : r.status === 'Confirmed' ? 'good' : r.status === 'Service ending' ? 'bad' : r.status === 'Not tracked' ? 'mute' : 'plain';
  return <span className={`prb-pill prb-${cls}`}>{r.status}</span>;
}

async function openLetter(id, on) {
  const res = await api.get(`/probation/${id}/letter`, { params: on ? { on } : {}, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---- one person ---------------------------------------------------------------------------------------------------------
function Detail({ id, canDecide, onBack, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({});
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const load = useCallback(() => {
    api.get(`/probation/${id}`).then((r) => setD(r.data)).catch((e) => setError(errOf(e, 'This record could not be opened.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  function start(m) {
    setMode(m); setError(''); setMsg('');
    if (m === 'review') setF({ recommendation: 'Confirm', score: '', note: '' });
    else if (m === 'confirm') setF({ confirmedOn: d && d.record.endDate && d.record.endDate < today() ? d.record.endDate : today(), note: '', makeLetter: true });
    else if (m === 'extend') setF({ months: 1, reason: '' });
    else if (m === 'track') setF({ startDate: d ? d.record.startDate : today(), months: '' });
    else setF({ note: '' });
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setMsg('');
    const path = { review: 'review', confirm: 'confirm', extend: 'extend', end: 'end', reopen: 'reopen', track: 'track' }[mode];
    const body = mode === 'review' ? { recommendation: f.recommendation, score: f.score === '' ? null : Number(f.score), note: f.note }
      : mode === 'confirm' ? { confirmedOn: f.confirmedOn, note: f.note, makeLetter: !!f.makeLetter }
        : mode === 'extend' ? { months: Number(f.months), reason: f.reason }
          : mode === 'track' ? { startDate: f.startDate, months: f.months === '' ? undefined : Number(f.months) }
            : { note: f.note };
    try {
      const r = await api.post(`/probation/${id}/${path}`, body);
      setMsg(r.data.letterNote || r.data.next || ({ review: 'Review saved.', confirm: 'Confirmed. The confirmation letter is saved in the employee’s documents.', extend: 'Probation extended.', end: 'Decision saved.', reopen: 'Decision undone.', track: 'Tracking started.' }[mode]));
      setMode(null); load(); onChanged();
    } catch (er) { setError(errOf(er, 'This could not be saved.')); }
    setBusy(false);
  }
  async function remakeLetter() {
    setBusy(true); setError(''); setMsg('');
    try { await api.post(`/probation/${id}/letter`); setMsg('The letter was made again and saved in the employee’s documents.'); load(); onChanged(); } catch (er) { setError(errOf(er, 'The letter could not be made.')); }
    setBusy(false);
  }
  async function preview(on) {
    setError('');
    try { await openLetter(id, on); } catch (er) { setError('The letter could not be opened. Try again.'); }
  }

  if (!d && !error) return <div className="small-muted">Opening…</div>;
  if (!d) return <div><button type="button" className="btn btn-sm" onClick={onBack}>← Back</button><div className="error-text" role="alert">{error}</div></div>;
  const r = d.record;
  const open = OPEN.includes(r.status);
  return (
    <div className="prb-detail">
      <div className="prb-detail-head">
        <button type="button" className="btn btn-sm" onClick={onBack}>← Back to the list</button>
        <h2><Link to={`/employees/${r.employeeId}`}>{r.name}</Link> <span className="small-muted">{r.employeeCode || ''}</span></h2>
        <Pill r={r} />
      </div>
      {msg && <div className="prb-ok" role="status">{msg}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}

      <div className="prb-facts">
        <div><span>Department</span><b>{r.department || '—'}{r.team ? ` · ${r.team}` : ''}</b></div>
        <div><span>Designation</span><b>{r.designation || '—'}</b></div>
        <div><span>Probation began</span><b>{fmt(r.startDate)}</b></div>
        <div><span>Last day of probation</span><b>{fmt(r.endDate)}{open ? ` · ${leftWords(r)}` : ''}</b></div>
        {r.originalEndDate !== r.endDate && <div><span>First end date</span><b>{fmt(r.originalEndDate)}</b></div>}
        <div><span>Team Lead (reviewer)</span><b>{r.reviewer || 'Not found — set the Team Lead on the employee'}</b></div>
        {r.confirmedOn && <div><span>Confirmed with effect from</span><b>{fmt(r.confirmedOn)}</b></div>}
        {r.decisionNote && <div className="prb-wide"><span>Decision note</span><b>{r.decisionNote}{r.decidedBy ? ` — ${r.decidedBy}` : ''}</b></div>}
        {r.review && (
          <div className="prb-wide"><span>Latest review ({stamp(r.review.at)}, {r.review.by})</span>
            <b>{r.review.recommendation}{r.review.score !== null && r.review.score !== undefined ? ` · score ${r.review.score}/100` : ''}{r.review.note ? ` — ${r.review.note}` : ''}</b>
          </div>
        )}
      </div>

      {!mode && (
        <div className="prb-actions">
          {open && <button type="button" className="btn btn-sm" onClick={() => start('review')}>Add review</button>}
          {open && canDecide && <button type="button" className="btn btn-sm btn-primary" onClick={() => start('confirm')}>Confirm</button>}
          {open && canDecide && <button type="button" className="btn btn-sm" onClick={() => start('extend')}>Extend</button>}
          {open && canDecide && <button type="button" className="btn btn-sm" onClick={() => start('end')}>End service</button>}
          {['Confirmed', 'Service ending'].includes(r.status) && canDecide && <button type="button" className="btn btn-sm" onClick={() => start('reopen')}>Undo this decision</button>}
          {r.status === 'Not tracked' && canDecide && <button type="button" className="btn btn-sm btn-primary" onClick={() => start('track')}>Start tracking</button>}
          {r.status === 'Confirmed' && canDecide && <button type="button" className="btn btn-sm" onClick={() => preview()}>Open the letter</button>}
          {r.status === 'Confirmed' && canDecide && <button type="button" className="btn btn-sm" disabled={busy} onClick={remakeLetter}>Make the letter again</button>}
        </div>
      )}

      {mode && (
        <form className="prb-form" onSubmit={submit}>
          <h3>{{ review: 'Add a review', confirm: 'Confirm this person', extend: 'Extend the probation', end: 'End of service', reopen: 'Undo the decision', track: 'Start tracking this person' }[mode]}</h3>
          {mode === 'review' && (
            <>
              <label>Your recommendation
                <select value={f.recommendation} onChange={(e) => set('recommendation', e.target.value)}>{REC.map((x) => <option key={x}>{x}</option>)}</select>
              </label>
              <label>Score (0 to 100, optional)
                <input type="number" min="0" max="100" value={f.score} onChange={(e) => set('score', e.target.value)} />
              </label>
              <label className="prb-wide">Notes {f.recommendation === 'Confirm' ? '(optional)' : '(required)'}
                <textarea rows="3" value={f.note} onChange={(e) => set('note', e.target.value)} />
              </label>
            </>
          )}
          {mode === 'confirm' && (
            <>
              <label>Confirmed with effect from
                <input type="date" value={f.confirmedOn} onChange={(e) => set('confirmedOn', e.target.value)} required />
              </label>
              <label className="prb-check"><input type="checkbox" checked={f.makeLetter} onChange={(e) => set('makeLetter', e.target.checked)} /> Make the confirmation letter and save it in the employee’s documents</label>
              <label className="prb-wide">Note (optional)
                <textarea rows="2" value={f.note} onChange={(e) => set('note', e.target.value)} />
              </label>
              <div className="prb-wide small-muted">The salary is not changed here. If the offer promised a raise on confirmation, revise it in Payroll, then Structure.{' '}
                <button type="button" className="prb-link" onClick={() => preview(f.confirmedOn)}>Look at the letter first</button>
              </div>
            </>
          )}
          {mode === 'extend' && (
            <>
              <label>Extend by (months)
                <input type="number" min="1" max="12" value={f.months} onChange={(e) => set('months', e.target.value)} required />
              </label>
              <label className="prb-wide">Reason (required)
                <textarea rows="2" value={f.reason} onChange={(e) => set('reason', e.target.value)} required />
              </label>
              <div className="prb-wide small-muted">The new last day will be {fmt(addMonthsStr(r.endDate, Number(f.months) || 0))}. The old date stays in the history.</div>
            </>
          )}
          {mode === 'end' && (
            <>
              <label className="prb-wide">Reason (required)
                <textarea rows="2" value={f.note} onChange={(e) => set('note', e.target.value)} required />
              </label>
              <div className="prb-wide small-muted">This only records the decision. It does not start the exit: open Exit Center for that.</div>
            </>
          )}
          {mode === 'reopen' && (
            <label className="prb-wide">Why is this undone? (required)
              <textarea rows="2" value={f.note} onChange={(e) => set('note', e.target.value)} required />
            </label>
          )}
          {mode === 'track' && (
            <>
              <label>Probation began on
                <input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} required />
              </label>
              <label>Length (months, empty = the usual)
                <input type="number" min="1" max="12" value={f.months} onChange={(e) => set('months', e.target.value)} />
              </label>
            </>
          )}
          <div className="prb-wide prb-form-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setMode(null); setError(''); }}>Cancel</button>
          </div>
        </form>
      )}

      <h3 className="prb-h3">History</h3>
      <ul className="prb-history">
        {d.events.map((ev) => (
          <li key={ev.id}>
            <b>{ev.kind}</b> <span className="small-muted">{stamp(ev.at)} · {ev.by || 'System'}</span>
            {(ev.fromEnd || ev.toEnd) && <div className="small-muted">{ev.fromEnd ? `Last day ${fmt(ev.fromEnd)} → ` : 'Last day '}{fmt(ev.toEnd)}</div>}
            {(ev.recommendation || ev.score !== null) && <div>{ev.recommendation}{ev.score !== null && ev.score !== undefined ? ` · score ${ev.score}/100` : ''}</div>}
            {ev.note && <div>{ev.note}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
function addMonthsStr(day, n) {
  if (!day) return null;
  const [y, m, dd] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dd, last));
  return first.toISOString().slice(0, 10);
}

// ---- settings (HR / Admin) ---------------------------------------------------------------------------------------------------
function Settings({ enabled, onClose, onChanged }) {
  const [s, setS] = useState(null);
  const [months, setMonths] = useState(3);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/probation/settings').then((r) => { setS(r.data); setMonths(r.data.months); setText(r.data.letterText); }).catch((e) => setError(errOf(e, 'The settings could not be loaded.')));
  }, []);
  async function save(extra, done) {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.put('/probation/settings', { months: Number(months), letterText: text, ...extra });
      setS(r.data.settings); setMsg(done || 'Saved.');
      if (r.data.sync) {
        const y = r.data.sync;
        setMsg(y.created
          ? `Probation tracking is ON. ${y.inProbation} people are in probation, and ${y.notTracked} who joined earlier are marked Not tracked.`
          : `Probation tracking is ON. Everybody already has a probation record (${y.total} people).`);
      }
      onChanged();
    } catch (e) { setError(errOf(e, 'This could not be saved.')); }
    setBusy(false);
  }
  async function syncNow() {
    setBusy(true); setError(''); setMsg('');
    try { const r = await api.post('/probation/sync'); setMsg(`Checked. ${r.data.created} new people added.`); onChanged(); } catch (e) { setError(errOf(e, 'The check failed.')); }
    setBusy(false);
  }
  if (!s && !error) return <div className="small-muted">Opening settings…</div>;
  return (
    <div className="prb-settings">
      <div className="prb-detail-head"><h2>Probation settings</h2><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
      {msg && <div className="prb-ok" role="status">{msg}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      {s && (
        <>
          <div className="prb-setrow">
            <div>
              <b>Probation tracking is {s.enabled ? 'ON' : 'OFF'}</b>
              <div className="small-muted">{s.enabled ? `Switched on${s.enabledByName ? ` by ${s.enabledByName}` : ''}. New joiners are picked up every night and reminders go to the Team Lead and HR.` : 'While it is off nothing is tracked and nobody is reminded. Employee records are never changed either way.'}</div>
            </div>
            {s.enabled
              ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm('Switch probation tracking off? Records and history are kept; reminders stop.')) save({ enabled: false }, 'Probation tracking is OFF.'); }}>Switch off</button>
              : <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { if (window.confirm(`Switch probation tracking on?\n\nEveryone who joined in the last ${months} months gets a probation end date. Everyone who joined earlier is marked Not tracked and never shows as overdue. Nobody is reminded until their dates come near.`)) save({ enabled: true }); }}>Switch on</button>}
          </div>
          <label className="prb-field">Usual probation length (months)
            <input type="number" min="1" max="12" value={months} onChange={(e) => setMonths(e.target.value)} />
            <span className="small-muted">Used for new records. Records that already exist keep their own dates.</span>
          </label>
          <label className="prb-field">Confirmation letter text
            <textarea rows="9" value={text} onChange={(e) => setText(e.target.value)} />
            <span className="small-muted">Separate paragraphs with an empty line. You can use {'{{name}}'}, {'{{designation}}'}, {'{{department}}'}, {'{{company}}'}, {'{{startDate}}'}, {'{{endDate}}'} and {'{{confirmedOn}}'}. The letterhead and signatory are the same as the exit letters.</span>
          </label>
          <div className="prb-form-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save({})}>{busy ? 'Saving…' : 'Save settings'}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setText(s.defaultLetter)}>Put back the standard letter</button>
            {enabled && <button type="button" className="btn btn-sm" disabled={busy} onClick={syncNow}>Check for new joiners now</button>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- the page ------------------------------------------------------------------------------------------------------------------
export default function Probation() {
  const [bucket, setBucket] = useState('inProbation');
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    api.get('/probation/summary', { params: { bucket, dept, q } })
      .then((r) => setData(r.data))
      .catch((e) => setError(errOf(e, 'The probation list could not be loaded. Try again in a minute.')))
      .finally(() => setLoading(false));
  }, [bucket, dept, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  async function download(format) {
    setBusy(format);
    try {
      const res = await api.get('/probation/export', { params: { format, bucket, dept, q }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `Probation - ${bucket}.${format}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { setError('The file could not be made. Try again.'); }
    setBusy('');
  }

  const rows = data ? data.rows : [];
  return (
    <div className="prb">
      <div className="page-head">
        <div>
          <h1>Probation</h1>
          <div className="page-sub">Who is on probation, when it ends, the Team Lead’s review and HR’s decision: confirm, extend or end service.</div>
        </div>
        <div className="prb-head-actions">
          <button type="button" className="btn btn-sm" disabled={!!busy || !rows.length} onClick={() => download('xlsx')}>{busy === 'xlsx' ? 'Making…' : 'Download Excel'}</button>
          {data && data.canDecide && <button type="button" className="btn btn-sm" onClick={() => { setShowSettings(true); setOpenId(null); }}>Settings</button>}
        </div>
      </div>

      {error && <div className="error-text" role="alert">{error}</div>}

      {showSettings && <Settings enabled={!!(data && data.enabled)} onClose={() => setShowSettings(false)} onChanged={load} />}

      {!showSettings && openId && <Detail id={openId} canDecide={!!(data && data.canDecide)} onBack={() => setOpenId(null)} onChanged={load} />}

      {!showSettings && !openId && (
        <>
          {data && !data.enabled && (
            <div className="prb-off" role="status">
              <b>Probation tracking is switched OFF.</b> Nothing is being tracked and nobody is being reminded.{' '}
              {data.canDecide ? <>Open <button type="button" className="prb-link" onClick={() => setShowSettings(true)}>Settings</button> to switch it on.</> : 'Ask HR to switch it on.'}
            </div>
          )}
          <div className="prb-tabs" role="tablist" aria-label="Probation lists">
            {TABS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={bucket === key} className={`prb-tab${bucket === key ? ' on' : ''}${key === 'overdue' && data && data.counts.overdue ? ' alert' : ''}`} onClick={() => setBucket(key)}>
                {label}{data ? <span className="prb-n">{data.counts[key]}</span> : null}
              </button>
            ))}
          </div>
          <div className="prb-filters">
            <input type="search" placeholder="Search name or code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {data && data.departments.map((x) => <option key={x}>{x}</option>)}
            </select>
          </div>

          {loading && !data && <div className="small-muted">Loading…</div>}
          {data && !rows.length && <div className="small-muted prb-empty">{data.enabled ? 'Nobody in this list.' : 'Nothing here until probation tracking is switched on.'}</div>}
          {!!rows.length && (
            <div className="tbl-wrap">
              <table className="prb-table">
                <thead><tr><th>Name</th><th>Department</th><th>Began</th><th>Last day</th><th>Team Lead</th><th>Review</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.overdue ? 'prb-row-bad' : r.dueSoon ? 'prb-row-warn' : ''}>
                      <td><b>{r.name}</b><div className="small-muted">{r.employeeCode || ''}{r.designation ? ` · ${r.designation}` : ''}</div></td>
                      <td>{r.department || '—'}{r.team ? <div className="small-muted">{r.team}</div> : null}</td>
                      <td>{fmt(r.startDate)}</td>
                      <td>{fmt(r.endDate)}{OPEN.includes(r.status) && <div className={`small-muted${r.overdue ? ' prb-late' : ''}`}>{leftWords(r)}</div>}</td>
                      <td>{r.reviewer || <span className="small-muted">Not found</span>}</td>
                      <td>{r.review ? <>{r.review.recommendation}{r.review.score !== null && r.review.score !== undefined ? <div className="small-muted">score {r.review.score}</div> : null}</> : <span className="small-muted">{OPEN.includes(r.status) ? 'No review yet' : '—'}</span>}</td>
                      <td><Pill r={r} /></td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setOpenId(r.id)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

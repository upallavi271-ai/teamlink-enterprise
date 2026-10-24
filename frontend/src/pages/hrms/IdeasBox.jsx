import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { downloadCsv } from '../../utils/csv';
import { dmy } from './TimesheetTasks.jsx';

// ---------------------------------------------------------------------------
// IDEAS FOR THE R&D TEAM (founder, 2026-10-24): every employee posts 4 ideas a month, and every idea must be their own - if somebody already
// posted the same idea the server refuses it (routes/ideas.js; it never shows the other person's idea or name). The R&D team, HR and Admin
// also see everybody's ideas, mark them, and see who has not posted their 4 yet. A button on the Timesheet opens this; no sidebar entry.
// ---------------------------------------------------------------------------
const apiError = (err, fallback) => (err && err.response && err.response.data && err.response.data.error) || fallback;
const monthWords = (m) => {
  if (!/^\d{4}-\d{2}$/.test(String(m))) return m === 'all' ? 'All months' : String(m || '');
  return new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const TONE = { New: 'orange', 'Looking at it': 'blue', Accepted: 'green', 'Not now': 'grey', Done: 'green' };
const Chip = ({ status }) => <span className={`tt-chip-state ${TONE[status] || ''}`} style={{ fontSize: 12, fontWeight: 600 }}>{status}</span>;

function Dots({ posted, quota }) {
  return (
    <span aria-hidden="true" style={{ letterSpacing: 4 }}>
      {Array.from({ length: quota }, (_, i) => <span key={i} style={{ color: i < posted ? 'var(--green, #1a7f4b)' : 'var(--muted, #9aa4b2)' }}>{i < posted ? '●' : '○'}</span>)}
    </span>
  );
}

// ---- my ideas + the form --------------------------------------------------------------------------
function MyIdeas({ onPosted }) {
  const [data, setData] = useState(null);
  const [month, setMonth] = useState('');
  const [f, setF] = useState({ title: '', details: '' });
  const [errs, setErrs] = useState({});
  const [error, setError] = useState('');
  const [copy, setCopy] = useState(null); // null = not asked yet, else { copy, own }
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState('');

  const load = useCallback((m) => api.get('/ideas/mine', { params: m ? { month: m } : {} })
    .then((r) => { setData(r.data); if (!m) setMonth(r.data.month); onPosted && onPosted(r.data); })
    .catch((e) => setError(apiError(e, 'Your ideas could not be loaded.'))), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(''); }, [load]);

  // Ask the server while they type: is this idea already taken? (It answers yes or no, nothing else.)
  useEffect(() => {
    setCopy(null);
    if (f.title.trim().length < 5 || f.details.trim().length < 15) return undefined;
    const t = setTimeout(() => { api.post('/ideas/check', f).then((r) => setCopy(r.data)).catch(() => {}); }, 500);
    return () => clearTimeout(t);
  }, [f.title, f.details]); // eslint-disable-line react-hooks/exhaustive-deps

  async function post(e) {
    e.preventDefault();
    const next = {};
    if (f.title.trim().length < 5) next.title = 'Give your idea a short name (at least 5 letters).';
    if (f.details.trim().length < 15) next.details = 'Explain it in a few words: what is it and how will it help?';
    setErrs(next); setError(''); setDone('');
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const r = await api.post('/ideas', f);
      setF({ title: '', details: '' }); setCopy(null);
      setDone(r.data.left > 0 ? `Posted. ${r.data.left} more to post this month.` : 'Posted. That is all 4 for this month. Thank you!');
      await load(month === data.current ? '' : data.current);
    } catch (er) {
      const d = er.response && er.response.data;
      if (d && d.field) setErrs({ [d.field]: d.error }); else setError(apiError(er, 'The idea could not be posted.'));
    } finally { setSaving(false); }
  }

  if (!data) return <div className="small-muted">{error || 'Loading…'}</div>;
  const months = [data.current, ...Array.from({ length: 5 }, (_, i) => { const d = new Date(`${data.current}-15T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (i + 1)); return d.toISOString().slice(0, 7); })];
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        Post <b>{data.quota} ideas every month</b> for the R&D team. Each idea must be your own: if somebody has already posted the same idea, it is not accepted, so think of something different.
      </div>
      <div style={{ marginBottom: 12, fontSize: 15 }}>
        This month: <b>{data.posted} of {data.quota}</b> posted <Dots posted={data.posted} quota={data.quota} />
      </div>
      {!data.canPost && <div className="notice amber" style={{ display: 'block', marginBottom: 10 }}>This login has no employee record, so it cannot post ideas.</div>}
      {data.canPost && data.left > 0 && (
        <form onSubmit={post} noValidate style={{ marginBottom: 16 }}>
          {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
          <label className="field"><span>Name of your idea</span>
            <input value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="For example: Auto-reminder for pending interview feedback" />
            {errs.title && <p className="error-text">{errs.title}</p>}
          </label>
          <label className="field"><span>Explain it</span>
            <textarea rows="4" value={f.details} maxLength={2000} onChange={(e) => setF({ ...f, details: e.target.value })} placeholder="What is the idea, what problem does it solve, and how will it help the company?" />
            {errs.details && <p className="error-text">{errs.details}</p>}
          </label>
          {copy && copy.copy && <div className="error-text" role="alert" style={{ marginBottom: 8 }}>{copy.own ? 'You have already posted an idea like this one.' : 'Somebody has already posted an idea like this one.'} Please write a different idea of your own.</div>}
          <button className="btn btn-primary" type="submit" disabled={saving || !!(copy && copy.copy)}>{saving ? 'Posting…' : 'Post my idea'}</button>
          {done && <span className="small-muted" style={{ marginLeft: 10 }}>{done}</span>}
        </form>
      )}
      {data.canPost && data.left === 0 && <div className="notice green" style={{ display: 'block', marginBottom: 12 }}>All {data.quota} ideas for this month are posted. Thank you!</div>}

      <div className="tt-bar" style={{ marginBottom: 8, alignItems: 'center' }}>
        <b>My ideas</b>
        <Combo value={month} onChange={(e) => { setMonth(e.target.value); load(e.target.value === data.current ? '' : e.target.value); }}>
          {months.map((m) => <option key={m} value={m}>{monthWords(m)}</option>)}
        </Combo>
      </div>
      {!data.ideas.length ? <div className="small-muted">No ideas posted in {monthWords(data.month)}.</div> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Idea</th><th>Posted</th><th>R&D says</th></tr></thead>
            <tbody>
              {data.ideas.map((i) => (
                <tr key={i.id}>
                  <td><b>{i.title}</b><div className="small-muted" style={{ whiteSpace: 'pre-wrap' }}>{i.details}</div></td>
                  <td>{dmy(String(i.postedAt).slice(0, 10))}</td>
                  <td><Chip status={i.status} />{i.rdNote && <div className="small-muted">{i.rdNote}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- everybody's ideas (R&D team, HR, Admin) -------------------------------------------------------
function AllIdeas() {
  const [month, setMonth] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [qs, setQs] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [behind, setBehind] = useState(false);
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { const t = setTimeout(() => setQs(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => api.get('/ideas/all', { params: { month: month || undefined, status: status || undefined, q: qs || undefined } })
    .then((r) => { setData(r.data); setError(''); if (!month) setMonth(r.data.month); })
    .catch((e) => setError(apiError(e, 'The ideas could not be loaded.'))), [month, status, qs]);
  useEffect(() => { load(); }, [load]);

  async function mark(row, nextStatus, note) {
    setBusy(row.id);
    try { await api.patch(`/ideas/${row.id}`, { status: nextStatus, note }); await load(); } catch (e) { setError(apiError(e, 'Could not save.')); } finally { setBusy(''); }
  }
  if (!data) return <div className="small-muted">{error || 'Loading…'}</div>;
  const people = (data.people || []).filter((p) => !behind || p.missing > 0);
  const label = monthWords(data.month);
  return (
    <div>
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="tt-bar" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <Combo value={month} onChange={(e) => setMonth(e.target.value)}>
          {[...(data.months.some((m) => m.month === data.current) ? [] : [{ month: data.current, count: 0 }]), ...data.months].map((m) => <option key={m.month} value={m.month}>{monthWords(m.month)} ({m.count})</option>)}
          <option value="all">All months</option>
        </Combo>
        <Combo value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          {data.statuses.map((s) => <option key={s} value={s}>{s}{data.byStatus[s] ? ` (${data.byStatus[s]})` : ''}</option>)}
        </Combo>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ideas or names" style={{ minWidth: 200 }} />
        <button type="button" className="btn btn-sm" disabled={!data.rows.length}
          onClick={() => downloadCsv(`ideas-${data.month}.csv`, ['Month', 'Posted on', 'Name', 'Department', 'Idea', 'Explanation', 'Status', 'R&D note'], data.rows.map((r) => [r.month, String(r.postedAt).slice(0, 10), r.author, r.department, r.title, r.details, r.status, r.rdNote || '']))}>
          ⬇ Download these ideas (CSV)
        </button>
      </div>
      <div className="small-muted" style={{ marginBottom: 8 }}>{data.rows.length} idea{data.rows.length === 1 ? '' : 's'} · {label}</div>
      {!data.rows.length ? <div className="small-muted" style={{ marginBottom: 14 }}>No ideas here.</div> : (
        <div className="tbl-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead><tr><th>Idea</th><th>By</th><th>Posted</th><th>Status</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ maxWidth: 420 }}>
                    <button type="button" className="link-btn" onClick={() => setOpen(open === r.id ? '' : r.id)} aria-expanded={open === r.id}><b>{r.title}</b></button>
                    {open === r.id && <div className="small-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.details}</div>}
                    {r.rdNote && <div className="small-muted">Note: {r.rdNote}</div>}
                  </td>
                  <td>{r.author}<div className="small-muted">{r.department}</div></td>
                  <td>{dmy(String(r.postedAt).slice(0, 10))}</td>
                  <td>
                    <Combo value={r.status} disabled={busy === r.id} onChange={(e) => {
                      const note = window.prompt('A short note for the person who posted it (optional):', r.rdNote || '');
                      if (note === null) return;
                      mark(r, e.target.value, note);
                    }}>
                      {data.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                    </Combo>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.people && (
        <>
          <div className="tt-bar" style={{ marginBottom: 8, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <b>Who has posted their {data.quota} · {label}</b>
            <label className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={behind} onChange={(e) => setBehind(e.target.checked)} /> Only people who still owe ideas
            </label>
            <button type="button" className="btn btn-sm" disabled={!people.length}
              onClick={() => downloadCsv(`ideas-posted-${data.month}.csv`, ['Name', 'Employee ID', 'Department', 'Ideas posted', 'Still to post'], people.map((p) => [p.name, p.employeeCode, p.department, p.posted, p.missing]))}>
              ⬇ Download who posted (CSV)
            </button>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Name</th><th>Department</th><th>Posted</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={`${p.employeeCode}-${p.name}`}>
                    <td>{p.name}<div className="small-muted">{p.employeeCode}</div></td>
                    <td>{p.department}</td>
                    <td><b>{p.posted} of {data.quota}</b> <Dots posted={p.posted} quota={data.quota} />{p.missing > 0 && <span className="small-muted"> · {p.missing} to go</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// The button for the Timesheet, and the window it opens. (No sidebar entry: this is part of the Timesheet.)
export default function IdeasBox() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const [tab, setTab] = useState('mine');
  const refresh = useCallback(() => api.get('/ideas/mine').then((r) => setInfo(r.data)).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);
  const behind = info && info.canPost && info.left > 0;
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} title={`Post your ${info ? info.quota : 4} ideas for the R&D team this month`}>
        💡 Ideas{info && info.canPost ? ` (${info.posted}/${info.quota})` : ''}{behind ? ' ●' : ''}
      </button>
      {open && (
        <Modal title="Ideas for the R&D team" size="wide" onClose={() => { setOpen(false); refresh(); }} foot={<button className="btn" type="button" onClick={() => { setOpen(false); refresh(); }}>Close</button>}>
          {info && info.mayReview && (
            <div className="tt-views" role="tablist" style={{ marginBottom: 12 }}>
              <button type="button" role="tab" className={`tt-view${tab === 'mine' ? ' on' : ''}`} onClick={() => setTab('mine')}>My ideas</button>
              <button type="button" role="tab" className={`tt-view${tab === 'all' ? ' on' : ''}`} onClick={() => setTab('all')}>Everybody's ideas</button>
            </div>
          )}
          {tab === 'all' && info && info.mayReview ? <AllIdeas /> : <MyIdeas onPosted={setInfo} />}
        </Modal>
      )}
    </>
  );
}

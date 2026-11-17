import { Fragment, useCallback, useEffect, useState } from 'react';
import api from '../../api';
import StatCard, { StatRow } from '../../components/ui/StatCard.jsx';

// ---------------------------------------------------------------------------
// Shared pieces of Reports -> "Candidate experience" and "Client health" (backend routes/atsExperience.js):
// the NPS table, the download buttons, and the complaints / escalations list with its form.
// ---------------------------------------------------------------------------
export const errText = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dash = (v, suffix = '') => (v === null || v === undefined || v === '' ? '—' : `${v}${suffix}`);

export async function downloadFile(url, params, fallback) {
  try {
    const res = await api.get(url, { params, responseType: 'blob' });
    const cd = res.headers['content-disposition'] || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallback;
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return '';
  } catch { return 'Could not download the file.'; }
}
export function Downloads({ name, params = {}, onError }) {
  const go = async (format) => { const m = await downloadFile(`/ats-experience/export/${name}`, { ...params, format }, `${name}.${format}`); if (m && onError) onError(m); };
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <button type="button" className="btn btn-sm" onClick={() => go('xlsx')}>Excel</button>
      <button type="button" className="btn btn-sm" onClick={() => go('csv')}>CSV</button>
    </span>
  );
}

const npsTone = (n) => (n === null || n === undefined ? 'grey' : n >= 30 ? 'green' : n >= 0 ? 'yellow' : 'red');
export function NpsTiles({ o, stars = true }) {
  if (!o) return null;
  return (
    <StatRow>
      <StatCard label="NPS" value={o.nps === null ? null : `${o.nps > 0 ? '+' : ''}${o.nps}`} tone={npsTone(o.nps)} help="Promoters (9-10) minus detractors (0-6), as a % of the answers. From -100 to +100." />
      {stars && <StatCard label="Average stars" value={o.avgStars === null ? null : `${o.avgStars} / 5`} />}
      <StatCard label="Surveys sent" value={o.sent} zeroText="None yet" />
      <StatCard label="Answers" value={o.responses} hint={o.responseRate === null ? '' : `${o.responseRate}% answered`} zeroText="None yet" />
      <StatCard label="Promoters / passives / detractors" value={`${o.promoters} / ${o.passives} / ${o.detractors}`} />
    </StatRow>
  );
}
export function NpsTable({ title, first, rows, stars = true }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>{title}</h3>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>{first}</th><th className="num">Sent</th><th className="num">Answers</th><th className="num">NPS</th><th className="num">Promoters</th><th className="num">Passives</th><th className="num">Detractors</th>{stars && <th className="num">Avg stars</th>}</tr></thead>
          <tbody>
            {(rows || []).map((g) => (
              <tr key={g.key}><td>{g.label}</td><td className="num">{g.sent}</td><td className="num">{g.responses}</td><td className="num"><b>{dash(g.nps)}</b></td><td className="num">{g.promoters}</td><td className="num">{g.passives}</td><td className="num">{g.detractors}</td>{stars && <td className="num">{dash(g.avgStars)}</td>}</tr>
            ))}
            {!(rows || []).length && <tr><td colSpan={stars ? 8 : 7} className="small-muted">No answers in this period yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DateRange({ value, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label className="small-muted">From <input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /></label>
      <label className="small-muted">To <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></label>
    </span>
  );
}

// A small search box that picks an application (candidate · job) or a client in the login's area.
export function Picker({ kind, value, onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (kind === 'applications' && q.trim().length < 2) { setRows([]); return undefined; }
    const t = setTimeout(() => { api.get(`/ats-experience/pick/${kind}`, { params: { q } }).then((x) => setRows(x.data.rows || [])).catch(() => setRows([])); }, 250);
    return () => clearTimeout(t);
  }, [q, kind]);
  return (
    <div>
      <input placeholder={kind === 'applications' ? 'Type the candidate\'s name or phone…' : 'Type the client\'s name…'} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
      {rows.length > 0 && (
        <select size={Math.min(6, rows.length)} value={value || ''} onChange={(e) => onPick(e.target.value, rows.find((r) => r.id === e.target.value))} style={{ width: '100%', marginTop: 4 }}>
          {rows.map((r) => <option key={r.id} value={r.id}>{r.label || r.name}</option>)}
        </select>
      )}
    </div>
  );
}

const STATUS_TONE = { Open: '#b45309', 'In progress': '#1d4ed8', Resolved: '#15803d' };
// The complaints (side = candidate) or client escalations (side = client) list: filters, a new one, status changes, history.
export function ComplaintsPanel({ side, compact = false }) {
  const [f, setF] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ id: '', subject: '', details: '' });
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => {
    api.get('/ats-experience/complaints', { params: { side, status: f || undefined } }).then((x) => { setD(x.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the list.')));
  }, [side, f]);
  useEffect(load, [load]);
  const word = side === 'client' ? 'escalation' : 'complaint';
  async function add(e) {
    e.preventDefault();
    try {
      await api.post('/ats-experience/complaints', { side, [side === 'client' ? 'clientId' : 'applicationId']: form.id, subject: form.subject, details: form.details });
      setAdding(false); setForm({ id: '', subject: '', details: '' }); setMsg(`The ${word} is logged and its owner is told.`); load();
    } catch (x) { setErr(errText(x, `Could not log the ${word}.`)); }
  }
  async function move(c, status) {
    try {
      await api.patch(`/ats-experience/complaints/${c.id}`, { status, note });
      setNote(''); setOpen(null); setMsg(`#${c.id} is now ${status}.`); load();
    } catch (x) { setErr(errText(x, 'Could not save.')); }
  }
  const counts = (d && d.counts) || {};
  const chips = [['', 'All'], ['Open', `Open (${counts.Open || 0})`], ['In progress', `In progress (${counts['In progress'] || 0})`], ['late', `Late (${counts.late || 0})`], ['mine', `Mine (${counts.mine || 0})`], ['Resolved', `Resolved (${counts.Resolved || 0})`]];
  return (
    <div>
      {err && <div className="notice red"><span>{err}</span></div>}
      {msg && <div className="notice green"><span>{msg}</span></div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {chips.map(([k, l]) => <button key={k || 'all'} type="button" className={`btn btn-sm${f === k ? ' btn-primary' : ''}`} onClick={() => setF(k)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        {!compact && <Downloads name="complaints" params={{ side, status: f || undefined }} onError={setErr} />}
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : `+ Log a ${word}`}</button>
      </div>
      <p className="small-muted" style={{ margin: '0 0 10px' }}>
        {side === 'client'
          ? 'A client escalation follows the client\'s escalation matrix: level 1, then level 2, then level 3, each after its own hours if it is not resolved.'
          : 'A candidate complaint belongs to the recruiter and is due in 48 hours. If it is late, it goes to the team lead.'}
      </p>
      {adding && (
        <form className="card" onSubmit={add} style={{ marginBottom: 12, display: 'grid', gap: 8 }}>
          <label><span className="small-muted">{side === 'client' ? 'Client' : 'Candidate and job'}</span><Picker kind={side === 'client' ? 'clients' : 'applications'} value={form.id} onPick={(id) => setForm({ ...form, id })} /></label>
          <label><span className="small-muted">What is it about?</span><input required maxLength={200} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} style={{ width: '100%' }} /></label>
          <label><span className="small-muted">Details (optional)</span><textarea maxLength={4000} rows={3} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} style={{ width: '100%' }} /></label>
          <div><button type="submit" className="btn btn-sm btn-primary" disabled={!form.id || !form.subject.trim()}>Log it</button></div>
        </form>
      )}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>#</th><th>Raised</th><th>{side === 'client' ? 'Client' : 'Candidate'}</th><th>About</th><th>Status</th><th className="num">Level</th><th>Owner</th><th>Due</th><th /></tr></thead>
          <tbody>
            {(d ? d.rows : []).map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td>{c.id}</td>
                  <td>{day(c.createdAt)}<div className="small-muted">{c.source}</div></td>
                  <td>{side === 'client' ? c.client : c.person}<div className="small-muted">{side === 'client' ? '' : [c.requirement, c.client].filter(Boolean).join(' · ')}</div></td>
                  <td>{c.subject}</td>
                  <td><b style={{ color: STATUS_TONE[c.status] }}>{c.status}</b>{c.late && <div style={{ color: '#b91c1c', fontSize: 12 }}>Late</div>}</td>
                  <td className="num">{c.level}</td>
                  <td>{c.owner || '—'}</td>
                  <td>{c.status === 'Resolved' ? `Resolved ${day(c.resolvedAt)}` : when(c.dueAt)}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => { setOpen(open === c.id ? null : c.id); setNote(''); }}>{open === c.id ? 'Close' : 'Open'}</button></td>
                </tr>
                {open === c.id && (
                  <tr>
                    <td colSpan={9} style={{ background: 'var(--paper, #fafbfd)' }}>
                      {c.details && <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{c.details}</p>}
                      {c.levels && <p className="small-muted" style={{ margin: '0 0 8px' }}>Matrix: {c.levels.map((l) => `Level ${l.level}: ${l.name || 'nobody named'} (${l.hours} h)`).join(' → ')}</p>}
                      {c.resolution && <p style={{ margin: '0 0 8px' }}><b>Resolution:</b> {c.resolution}</p>}
                      <ul className="small-muted" style={{ margin: '0 0 8px', paddingLeft: 18 }}>{(c.history || []).map((h, i) => <li key={i}>{when(h.at)} · {h.by}: {h.what}</li>)}</ul>
                      {c.status !== 'Resolved' && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <input placeholder="Note (needed to resolve)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
                          {c.status === 'Open' && <button type="button" className="btn btn-sm" onClick={() => move(c, 'In progress')}>In progress</button>}
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => move(c, 'Resolved')}>Resolved</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {d && !d.rows.length && <tr><td colSpan={9} className="small-muted">Nothing here.</td></tr>}
            {!d && <tr><td colSpan={9} className="small-muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The surveys sent (side candidate | client): status, the answer, and the link of an unanswered one (to copy and send by hand).
export function SurveysList({ side }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => { api.get('/ats-experience/surveys', { params: { side } }).then((x) => setD(x.data)).catch((e) => setErr(errText(e, 'Could not load the surveys.'))); }, [side]);
  const copy = (r) => { try { navigator.clipboard.writeText(r.link); setCopied(r.id); } catch { /* the link is on screen */ } };
  return (
    <div>
      {err && <div className="notice red"><span>{err}</span></div>}
      <p className="small-muted" style={{ margin: '0 0 8px' }}>{side === 'client' ? 'Sent after each joining and once a quarter to the client contact.' : 'Sent once after the interview, once after the offer and once after joining - never twice for the same step.'} {d ? `${d.total} in all.` : ''}</p>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Sent</th><th>Survey</th><th>{side === 'client' ? 'Client' : 'Candidate'}</th><th>{side === 'client' ? 'BDE' : 'Recruiter'}</th><th>How it went out</th><th>Answer</th></tr></thead>
          <tbody>
            {(d ? d.rows : []).map((r) => (
              <tr key={r.id}>
                <td>{day(r.createdAt)}</td>
                <td>{r.event}{r.period ? ` ${r.period}` : ''}</td>
                <td>{side === 'client' ? r.client : r.person}<div className="small-muted">{side === 'client' ? '' : [r.requirement, r.client].filter(Boolean).join(' · ')}</div></td>
                <td>{(side === 'client' ? r.bde : r.recruiter) || '—'}</td>
                <td className="small-muted" style={{ maxWidth: 260 }}>{r.sendStatus || '—'}</td>
                <td>{r.answeredAt
                  ? <span>{r.stars ? `${'★'.repeat(r.stars)} · ` : ''}<b>{r.nps}</b>/10{r.comment ? <div className="small-muted">{r.comment}</div> : null}</span>
                  : <button type="button" className="btn btn-sm" onClick={() => copy(r)}>{copied === r.id ? 'Link copied' : 'Copy link'}</button>}
                </td>
              </tr>
            ))}
            {d && !d.rows.length && <tr><td colSpan={6} className="small-muted">No surveys yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

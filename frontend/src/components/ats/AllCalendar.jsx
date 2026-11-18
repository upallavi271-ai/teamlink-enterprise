import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';

// ---------------------------------------------------------------------------
// ONE CALENDAR (audit 428): interviews, joining dates, follow-ups and tasks of the logged-in person (or their whole area) in a month or
// week grid. Colour by type; a click opens the thing. Backend: GET /api/ats/all-calendar (routes/atsCalendarAll.js).
// ---------------------------------------------------------------------------
const TYPES = [
  ['interview', 'Interviews', '#2563eb'],
  ['joining', 'Joinings', '#16a34a'],
  ['followup', 'Follow-ups', '#d97706'],
  ['task', 'Tasks', '#7c3aed'],
];
const COLOR = Object.fromEntries(TYPES.map(([k, , c]) => [k, c]));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7)); // Monday

export default function AllCalendar() {
  const nav = useNavigate();
  const [mode, setMode] = useState('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [who, setWho] = useState('me');
  const [off, setOff] = useState({});
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const range = useMemo(() => {
    if (mode === 'week') { const s = startOfWeek(anchor); return { from: s, to: addDays(s, 6) }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = startOfWeek(first);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { from: s, to: addDays(startOfWeek(last), 6) };
  }, [mode, anchor]);

  const load = useCallback(() => {
    setError('');
    api.get('/ats/all-calendar', { params: { from: ymd(range.from), to: ymd(range.to), who } })
      .then((r) => setData(r.data)).catch((e) => { setData(null); setError(e.response?.data?.error || 'The calendar could not be loaded.'); });
  }, [range, who]);
  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => {
    const out = []; for (let d = new Date(range.from); d <= range.to; d = addDays(d, 1)) out.push(new Date(d)); return out;
  }, [range]);
  const byDay = useMemo(() => {
    const m = new Map();
    ((data && data.events) || []).filter((e) => !off[e.type]).forEach((e) => { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); });
    return m;
  }, [data, off]);
  const today = ymd(new Date());
  const step = (n) => setAnchor((a) => (mode === 'week' ? addDays(a, 7 * n) : new Date(a.getFullYear(), a.getMonth() + n, 1)));
  const title = mode === 'week' ? `${range.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${range.to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" className="btn btn-sm" onClick={() => step(-1)} aria-label="Earlier">‹</button>
        <b style={{ minWidth: 190, textAlign: 'center' }}>{title}</b>
        <button type="button" className="btn btn-sm" onClick={() => step(1)} aria-label="Later">›</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAnchor(new Date())}>Today</button>
        <div className="iv4-seg" role="tablist" aria-label="Calendar size">
          {[['week', 'Week'], ['month', 'Month']].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? 'is-on' : ''} onClick={() => setMode(id)}>{label}</button>)}
        </div>
        <div className="iv4-seg" role="tablist" aria-label="Whose calendar">
          {[['me', 'Mine'], ['team', 'My area']].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={who === id} className={who === id ? 'is-on' : ''} onClick={() => setWho(id)}>{label}</button>)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {TYPES.map(([k, label, c]) => (
          <label key={k} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={!off[k]} onChange={() => setOff((o) => ({ ...o, [k]: !o[k] }))} />
            <span style={{ width: 10, height: 10, borderRadius: 3, background: c, display: 'inline-block' }} />
            {label}{data && data.counts[k] ? <span className="small-muted"> ({data.counts[k]})</span> : null}
          </label>
        ))}
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="small-muted" style={{ textAlign: 'center' }}>{d}</div>)}
        {days.map((d) => {
          const key = ymd(d);
          const list = byDay.get(key) || [];
          const dim = mode === 'month' && d.getMonth() !== anchor.getMonth();
          const cap = mode === 'week' ? 40 : 3;
          return (
            <div key={key} style={{ minHeight: mode === 'week' ? 200 : 96, border: `1px solid ${key === today ? '#2563eb' : 'var(--line, #ddd)'}`, borderRadius: 6, padding: 4, opacity: dim ? 0.5 : 1, background: key === today ? 'rgba(37,99,235,.06)' : undefined }}>
              <div className="small-muted" style={{ fontSize: 11 }}>{d.getDate()}</div>
              {list.slice(0, cap).map((e) => (
                <button key={e.id} type="button" title={`${e.time ? `${e.time} · ` : ''}${e.title}${e.sub ? ` — ${e.sub}` : ''}`} onClick={() => nav(e.path)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderLeft: `3px solid ${COLOR[e.type]}`, background: 'var(--bg-soft, #f5f6f8)', borderRadius: 3, margin: '2px 0', padding: '1px 4px', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                  {e.time ? `${e.time} ` : ''}{e.title}
                </button>
              ))}
              {list.length > cap && <button type="button" className="link-btn" style={{ fontSize: 11 }} onClick={() => { setAnchor(d); setMode('week'); }}>+{list.length - cap} more</button>}
            </div>
          );
        })}
      </div>
      {data && data.events.length === 0 && <div className="small-muted" style={{ marginTop: 8 }}>Nothing in this {mode}.</div>}
    </div>
  );
}

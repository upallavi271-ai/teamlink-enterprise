// ---------------------------------------------------------------------------
// INTERVIEW PANEL PICKER (B4, 2026-10-06) — who takes the interview.
// Pick TeamLink people (search) and / or add outside people (name + email).
// value / onChange: [{ userId, name } | { name, email }]
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import './panel.css';

export default function PanelPicker({ value, onChange, max = 8 }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState([]);
  const [open, setOpen] = useState(false);
  const [outside, setOutside] = useState(null); // { name, email } while adding
  const list = value || [];

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      api.get('/ats/interviews/panel-options', { params: q.trim() ? { q: q.trim() } : {} })
        .then((r) => setOpts(r.data.rows || [])).catch(() => setOpts([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const has = (p) => list.some((x) => (p.userId ? x.userId === p.userId : !x.userId && x.name.toLowerCase() === p.name.toLowerCase()));
  const add = (p) => { if (!has(p) && list.length < max) onChange([...list, p]); setQ(''); setOpen(false); };
  const remove = (i) => onChange(list.filter((_, j) => j !== i));
  const emailOk = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  return (
    <div className="pnl">
      {list.length > 0 && (
        <div className="pnl-chips">
          {list.map((p, i) => (
            <span key={`${p.userId || p.name}-${i}`} className={`pnl-chip${p.userId ? '' : ' is-out'}`}>
              <b>{p.name}</b>
              <span className="pnl-kind">{p.userId ? 'TeamLink' : (p.email || 'outside')}</span>
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => remove(i)}>×</button>
            </span>
          ))}
        </div>
      )}
      {list.length < max && (
        <div className="pnl-add">
          <input
            type="search"
            placeholder="Add a TeamLink person — type a name"
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            aria-label="Add a TeamLink interviewer"
          />
          {open && (
            <div className="pnl-opts">
              {opts.filter((o) => !has({ userId: o.id })).map((o) => (
                <button key={o.id} type="button" onClick={() => add({ userId: o.id, name: o.name })}>
                  <b>{o.name}</b><span>{String(o.role || '').replace(/_/g, ' ').toLowerCase()}</span>
                </button>
              ))}
              {!opts.length && <div className="pnl-none">Nobody found.</div>}
              <button type="button" className="pnl-close" onClick={() => setOpen(false)}>Close</button>
            </div>
          )}
          {!outside && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOutside({ name: '', email: '' })}>+ Outside person</button>}
        </div>
      )}
      {outside && (
        <div className="pnl-out">
          <input placeholder="Name, e.g. Dr Mehta" value={outside.name} onChange={(e) => setOutside({ ...outside, name: e.target.value })} aria-label="Outside interviewer name" />
          <input type="email" placeholder="Email (optional)" value={outside.email} onChange={(e) => setOutside({ ...outside, email: e.target.value })} aria-label="Outside interviewer email" />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={outside.name.trim().length < 2 || !emailOk(outside.email.trim())}
            onClick={() => { add({ name: outside.name.trim(), email: outside.email.trim() || null }); setOutside(null); }}
          >
            Add
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOutside(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE HRMS DASHBOARD'S DRILL LISTS (user, 2026-10-06: "the dashboard reports must
// show the CORRECT data, in a detailed way too").
//
// Every tile is a button. Clicking it opens its list IN PLACE, right under the
// tile row (no page change): who is behind the number — name, ID, department,
// designation, seat, status, joining date, last working day, reporting manager
// (attendance tiles: in / out time and the plain reason). Search, sort, 25 per
// page, and a separate Excel button. The list count is the tile number: both
// come from the same server computation (routes/hrmsDashboard.js GET /list), and
// the panel says so out loud if they ever differ.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ScrollTable from '../../components/ScrollTable.jsx';
import './dashboard-drill.css';
import '../attendance/half-leave-chip.css';
import Combo from '../../components/Combo.jsx';

// The Half day list: where the leave for the other half stands, as a plain colour chip.
const HL_TONE = { Approved: 'green', 'Pending approval': 'orange', Rejected: 'red', 'No leave applied': 'red' };
const cell = (c, v) => (c.kind === 'halfleave' && v ? <span className={`hl-chip tone-${HL_TONE[v] || 'red'}`}>Half day leave: {v}</span> : show(c, v));

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-09-28" -> "28 Sep 2026"; "2026-09-02 (last attendance)" keeps its tail.
function fmtDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(String(v || ''));
  return m ? `${Number(m[3])} ${MO[Number(m[2]) - 1]} ${m[1]}${m[4]}` : (v || '');
}
// "09:05" -> "9:05 AM".
function fmtTime(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}
const show = (col, v) => {
  const t = col.kind === 'time' ? fmtTime(v) : col.kind === 'date' ? fmtDate(v) : v;
  return t === '' || t == null ? '—' : t;
};

// A "?" with a plain-words explanation: shows on hover, and on tap / keyboard focus.
export function Help({ text }) {
  return <span className="hd-help" tabIndex={0} role="img" aria-label={text} data-tip={text}>?</span>;
}

// The tile row. cell = { id, value, label, tile, part?, scope?, help?, sub?, parts?: [{ label, n, part }], tone? }
export function Tiles({ cells, drill, section, onPick }) {
  const isOn = (c) => !!drill && drill.section === section && drill.tile === c.tile && (drill.part || '') === (c.part || '') && (drill.scope || '') === (c.scope || '');
  // A chip may open another tile's list (p.tile): "Full day 1 -> On leave" opens the On leave people.
  const partOf = (c, p) => ({ ...c, tile: p.tile || c.tile, part: p.part });
  return (
    <div className="stat-row hd-tiles">
      {cells.map((c) => (
        <div key={c.id || c.label} className={`stat-cell hd-tile${isOn(c) ? ' on' : ''}${c.tone ? ` tone-${c.tone}` : ''}`}>
          <button type="button" className="hd-tile-main" aria-pressed={isOn(c)} onClick={() => onPick(section, c, c.value)}
            title="Click to see who is counted">
            <span className="v">{c.value}</span>
            <span className="l">{c.label}</span>
          </button>
          {c.help && <Help text={c.help} />}
          {c.sub && <div className="hd-sub">{c.sub}</div>}
          {c.parts && (
            <div className="hd-parts">
              {c.parts.map((p) => (
                <button key={p.label} type="button" className={`hd-part${isOn(partOf(c, p)) ? ' on' : ''}${p.tone ? ` tone-${p.tone}` : ''}`} onClick={() => onPick(section, partOf(c, p), p.n)} title={p.title || undefined}>
                  {p.label} <b>{p.n}</b>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// The list. `params` = the dashboard's filters + date range; `expected` = the number on the tile.
export function DrillPanel({ drill, expected, params, onClose, onSwitch, switches, moreTo, moreLabel }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: '', dir: 1 });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const box = useRef(null);
  const seq = useRef(0);
  const query = { ...params, tile: drill.tile, ...(drill.part ? { part: drill.part } : {}), ...(drill.scope ? { scope: drill.scope } : {}) };
  const sig = JSON.stringify(query);

  useEffect(() => {
    const mine = ++seq.current;
    setData(null); setError(''); setSaved('');
    api.get('/hrms/dashboard/list', { params: query })
      .then((res) => { if (mine === seq.current) setData(res.data); })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'Could not load this list. Please try again.'); });
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the list into view when it opens (it opens under the tiles, in place).
  useEffect(() => { if (box.current && box.current.scrollIntoView) box.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [drill.section, drill.tile]);
  useEffect(() => { setQ(''); setSort({ key: '', dir: 1 }); }, [drill.tile]);

  const cols = (data && data.columns) || [];
  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    let list = data.rows;
    if (s) list = list.filter((r) => cols.some((c) => `${show(c, r[c.key])}`.toLowerCase().includes(s) || `${r[c.key] ?? ''}`.toLowerCase().includes(s)));
    if (sort.key) {
      const col = cols.find((c) => c.key === sort.key);
      const val = (r) => (col && col.kind === 'num' ? (r[sort.key] === '' ? null : Number(r[sort.key])) : String(r[sort.key] ?? '').toLowerCase());
      list = [...list].sort((a, b) => {
        const x = val(a); const y = val(b);
        if (x === '' || x == null) return (y === '' || y == null) ? 0 : 1; // empty last, either way
        if (y === '' || y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
    }
    return list;
  }, [data, q, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = usePaged(rows, 25);
  const click = (key) => setSort((cur) => (cur.key === key ? { key, dir: -cur.dir } : { key, dir: 1 }));

  async function excel() {
    setBusy(true); setSaved(''); setError('');
    try {
      const res = await api.get('/hrms/dashboard/list', { params: { ...query, format: 'xlsx' }, responseType: 'blob' });
      const name = `hrms-${drill.tile}${drill.part ? `-${String(drill.part).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}-${(data && (data.asOf || data.today)) || ''}.xlsx`;
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(href), 2000);
      setSaved(`Saved ${name}`);
    } catch (e) {
      setError(e.response?.status === 403 ? 'You do not have permission to export.' : 'Could not make the Excel file. Please try again.');
    } finally { setBusy(false); }
  }

  const t = drill.tile;
  const noun = /^leave|^taskLeave|^taskReg/.test(t) ? 'requests' : t.startsWith('task') ? 'items' : 'people';
  const differs = data && expected != null && data.total !== expected;

  return (
    <div className="hd-drill" ref={box}>
      <div className="hd-drill-head">
        <div className="hd-drill-title">
          <b>{data ? data.title : 'Loading…'}</b>
          {data && <span className="hd-count"> — {data.total} {data.total === 1 ? ({ people: 'person', requests: 'request', items: 'item' })[noun] : noun}</span>}
        </div>
        <div className="hd-drill-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={!data || busy} onClick={excel}>{busy ? 'Making file…' : 'Excel'}</button>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      {switches && (
        <div className="hd-switch" role="group" aria-label="Which list">
          {switches.map((s) => (
            <button key={s.label} type="button" className={`btn btn-sm${(drill.part || '') === (s.part || '') ? ' btn-primary' : ''}`} onClick={() => onSwitch(s)}>
              {s.label} <b>{s.n}</b>
            </button>
          ))}
        </div>
      )}
      {saved && <div className="hd-saved">{saved}</div>}
      {error && <div className="notice red">{error}</div>}
      {data && data.note && <div className="hd-note">{data.note}</div>}
      {differs && <div className="notice red">This list shows {data.total} but the tile says {expected}. Please refresh the page; if it stays like this, tell the admin.</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {data && (
        <>
          <div className="hd-tools">
            <input type="search" placeholder="Search name, ID, department…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this list" />
            <label className="hd-sortpick">
              Sort by
              <Combo value={sort.key} onChange={(e) => setSort({ key: e.target.value, dir: 1 })}>
                <option value="">Default</option>
                {cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Combo>
              {sort.key && <button type="button" className="btn btn-sm" onClick={() => setSort((s) => ({ ...s, dir: -s.dir }))}>{sort.dir === 1 ? 'A → Z' : 'Z → A'}</button>}
            </label>
            {q && <span className="small-muted">{rows.length} match{rows.length === 1 ? '' : 'es'}</span>}
          </div>
          <ScrollTable maxHeight="60vh">
            <table className="hd-table">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.key} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="hd-th" onClick={() => click(c.key)}>{c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.slice.map((r, i) => (
                  <tr key={`${r.id || ''}|${r.from || r.date || r.kind || ''}|${i}`}>
                    {cols.map((c, ci) => (
                      <td key={c.key} data-label={c.label} className={c.key === 'why' ? 'hd-why' : ci === 0 ? 'hd-first' : ''} style={c.kind === 'date' || c.kind === 'time' ? { whiteSpace: 'nowrap' } : undefined}>
                        {ci === 0 ? <b>{show(c, r[c.key])}</b> : cell(c, r[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={cols.length || 1} className="hd-empty">{q ? 'Nothing matches your search.' : 'Nobody in this list.'}</td></tr>}
              </tbody>
            </table>
          </ScrollTable>
          {page.total > 0 && <Pager page={page} noun={noun} />}
          {moreTo && <div className="hd-more"><Link to={moreTo}>{moreLabel || 'Open the full page'}</Link></div>}
        </>
      )}
    </div>
  );
}

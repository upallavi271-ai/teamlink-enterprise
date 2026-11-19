import { stageLabel } from '../../atsVocab';
import './history.css';

// ---------------------------------------------------------------------------
// The pieces the two History screens share (requirement: HistoryTab.jsx, client: ClientHistory.jsx).
// Plain words; the step names come from stageLabel() so a name the Admin renamed in Company Setup shows here too.
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (d) => {
  const s = String(d || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
};
export const num = (n) => Number(n || 0).toLocaleString('en-IN');
export const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// A date with the small "estimated" marker when the system had to take the nearest date it had.
export function Day({ v, est, empty = '—' }) {
  const d = v && typeof v === 'object' ? v.day : v;
  const e = est !== undefined ? est : v && typeof v === 'object' ? v.est : false;
  if (!d) return <span className="hx-muted">{empty}</span>;
  return <span>{fmtDay(d)}{e && <sup className="hx-est" title="Date estimated: the exact day was not recorded, the nearest recorded day is shown">est.</sup>}</span>;
}

export const stepLabel = (t) => (t.key === 'joined' ? `${stageLabel('JOINED')} (still working)` : t.stage ? stageLabel(t.stage) : t.plainLabel);

// The row of numbered tiles: each is clickable (it opens the list behind it).
export function FunnelTiles({ tiles, active, onPick }) {
  return (
    <div className="hx-tiles" role="list">
      {tiles.map((t) => (
        <button
          type="button"
          role="listitem"
          key={t.key}
          className={`hx-tile${active === t.key ? ' on' : ''}${t.key === 'dropped' || t.key === 'left' ? ' bad' : ''}${t.sub ? ' sub' : ''}${t.key === 'joined' ? ' good' : ''}`}
          onClick={() => onPick && onPick(active === t.key ? '' : t.key)}
          title="Show the people behind this number"
        >
          <span className="hx-no">{t.no}</span>
          <b className="hx-n">{num(t.count)}</b>
          <span className="hx-l">{stepLabel(t)}</span>
          {t.pct !== null && t.pct !== undefined && (
            <span className="hx-pct">{t.key === 'left' ? `${t.pct}% of those who joined` : t.prevKey === 'sourced' && (t.key === 'dropped' || t.key === 'inprocess') ? `${t.pct}% of sourced` : `${t.pct}% of the step before`}</span>
          )}
          {(t.first || t.last) && <span className="hx-dates">{t.first === t.last ? fmtDay(t.first) : `${fmtDay(t.first)} to ${fmtDay(t.last)}`}</span>}
          {t.estimated > 0 && <span className="hx-dates">{t.estimated} date{t.estimated === 1 ? '' : 's'} estimated</span>}
        </button>
      ))}
    </div>
  );
}

export function Definition({ text, joined, joinedText }) {
  return (
    <details className="hx-def">
      <summary>What do “Dropped” and “Joined” mean?</summary>
      <p>{text}</p>
      {joined && <p className="hx-muted">{joined}</p>}
      {joinedText && <p>{joinedText}</p>}
    </details>
  );
}

export function JoinedNote({ detail }) {
  if (!detail) return null;
  const bits = [];
  if (detail.uncounted) bits.push(`${detail.uncounted} at the Joined step ${detail.uncounted === 1 ? 'is' : 'are'} not counted: no joining day, or credited to someone else`);
  return bits.length ? <div className="hx-muted" style={{ marginBottom: 8 }}>{bits.join('. ')}.</div> : null;
}

export function DropSummary({ s }) {
  if (!s || !s.total) return null;
  return (
    <div className="hx-drops">
      <div className="hx-box">
        <h4>Why they dropped</h4>
        {s.byType.map((t) => <div className="hx-line" key={t.type}><span>{t.label}</span><b>{t.count}</b></div>)}
      </div>
      <div className="hx-box">
        <h4>At which step</h4>
        {s.byStage.map((t) => <div className="hx-line" key={t.stage || '?'}><span>{t.stage ? stageLabel(t.stage) : t.label}</span><b>{t.count}</b></div>)}
      </div>
      <div className="hx-box">
        <h4>Reasons given</h4>
        {s.byReason.slice(0, 8).map((t) => <div className="hx-line" key={t.reason}><span>{t.reason}</span><b>{t.count}</b></div>)}
      </div>
    </div>
  );
}

// from / to / this month-quarter-year / recruiter
export function Filters({ f, setF, recruiters = [] }) {
  const set = (k, v) => setF({ ...f, [k]: v });
  const period = (p) => setF({ ...f, period: p, from: '', to: '' });
  return (
    <div className="hx-filters">
      <label>From <input type="date" value={f.from || ''} onChange={(e) => setF({ ...f, from: e.target.value, period: '' })} /></label>
      <label>To <input type="date" value={f.to || ''} onChange={(e) => setF({ ...f, to: e.target.value, period: '' })} /></label>
      {[['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This year']].map(([k, l]) => (
        <button key={k} type="button" className={`btn btn-sm${f.period === k ? ' btn-primary' : ''}`} onClick={() => period(f.period === k ? '' : k)}>{l}</button>
      ))}
      {recruiters.length > 0 && (
        <label>Recruiter
          <select value={f.recruiter || ''} onChange={(e) => set('recruiter', e.target.value)}>
            <option value="">Everyone</option>
            {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      )}
      {(f.from || f.to || f.period || f.recruiter) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ ...f, from: '', to: '', period: '', recruiter: '' })}>Clear</button>}
    </div>
  );
}

export const cleanParams = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== null && v !== undefined));

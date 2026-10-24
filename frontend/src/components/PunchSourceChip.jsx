import './PunchSourceChip.css';

// WHERE A PUNCH CAME FROM (user 2026-10-13: web check-in AND biometric import data must both be visible).
// The labels come from the server (backend/src/utils/punchSources.js) - this file only draws them.
const FILTERS = [['', 'All'], ['web', 'Web check-in'], ['biometric', 'Biometric'], ['pulse', 'Pulse import'], ['hr', 'Typed by HR']];
const GROUP_TEXT = { web: 'Web check-in', biometric: 'Biometric', pulse: 'Pulse import', hr: 'Typed by HR' };

// One chip for one punch: source = 'web' | 'biometric' | 'bioimport' | 'pulse' | 'hr'.
export default function PunchSourceChip({ source, label }) {
  return <span className={`psc-chip psc-${source}`} title={`Source: ${label}`}>{label}</span>;
}

// "Web check-in 1 · Biometric 3" for a person-day (counts = { web, biometric, pulse, hr }).
export function SourceChips({ counts }) {
  const keys = ['web', 'biometric', 'pulse', 'hr'].filter((k) => counts && counts[k]);
  if (!keys.length) return <span className="cell-muted">—</span>;
  return (
    <span className="psc-chips">
      {keys.map((k) => <span key={k} className={`psc-chip psc-${k}`}>{GROUP_TEXT[k]} <b>{counts[k]}</b></span>)}
    </span>
  );
}

// The Source filter: separate buttons (no dropdown). totals = { all, web, biometric, pulse, hr } = days with such a punch.
export function SourceFilter({ value, onChange, totals }) {
  const t = totals || {};
  return (
    <div className="psc-filter" role="group" aria-label="Source of the punches" data-testid="source-filter">
      <span className="psc-label">Show punches from:</span>
      {FILTERS.filter(([k]) => !k || k !== 'hr' || (t.hr || 0) > 0 || value === 'hr').map(([k, label]) => (
        <button key={k || 'all'} type="button" className={value === k ? 'on' : ''} onClick={() => onChange(k)} aria-pressed={value === k}>
          {label}<b>{t[k || 'all'] ?? 0}</b>
        </button>
      ))}
    </div>
  );
}

export function PunchToggle({ open, onClick, count }) {
  return (
    <button type="button" className={`psc-toggle${open ? ' on' : ''}`} onClick={onClick} aria-expanded={!!open}>
      {open ? 'Hide punches' : `All punches (${count})`}
    </button>
  );
}

const t12 = (t) => {
  const [h, m, s] = String(t).split(':');
  const hh = Number(h);
  return `${((hh + 11) % 12) + 1}:${m}${s ? `:${s}` : ''} ${hh >= 12 ? 'PM' : 'AM'}`;
};

// Every raw punch of a day, all sources, in time order; the ones the day rule used are marked.
export function PunchDetails({ list }) {
  if (!list || !list.length) return <div className="psc-detail small-muted">No punches this day.</div>;
  return (
    <div className="psc-detail" data-testid="punch-details">
      <div className="psc-detail-wrap">
        <table>
          <thead><tr><th>Time</th><th>In / Out</th><th>Source</th><th>How</th><th>Distance</th><th>Face</th><th>Used for the day</th></tr></thead>
          <tbody>
            {list.map((p, i) => (
              <tr key={`${p.time}-${p.source}-${i}`}>
                <td>{t12(p.time)}</td>
                <td>{p.direction === 'Out' ? 'Check-out' : 'Check-in'}</td>
                <td><PunchSourceChip source={p.source} label={p.sourceLabel} /></td>
                <td>{p.method || '—'}</td>
                <td title={p.accuracyM != null ? `GPS accuracy about ${p.accuracyM} m` : ''}>{p.distanceM != null ? (p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(1)} km` : `${p.distanceM} m`) : '—'}</td>
                <td className={p.face && p.face !== 'matched' ? 'psc-face-flag' : ''} title={p.faceReason || ''}>{p.face ? `Face: ${p.face}` : '—'}</td>
                <td className={p.usedAs ? 'psc-used' : ''}>{p.usedAs === 'first-in' ? 'First in' : p.usedAs === 'last-out' ? 'Last out' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="psc-note">Every punch is shown, even when a web check-in and a biometric punch are at the same time. Only the status of the day uses them together.</div>
    </div>
  );
}

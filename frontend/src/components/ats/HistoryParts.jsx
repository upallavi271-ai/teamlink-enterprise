import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { stageLabel } from '../../atsVocab';
import { PRESETS, presetDates, matchPreset, dateProblem } from '../../utils/dateRanges.js';
import MultiSelect from './MultiSelect.jsx';
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
// A funnel card picked: its people in a popup over the page (founder 2026-11-25). Esc, the X or a click outside closes it.
export function StepPopup({ tile, total, shown, loading, onClose, children }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!tile) return null;
  return createPortal(
    <div className="hx-pop-back" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hx-pop" role="dialog" aria-modal="true" aria-label={stepLabel(tile)} data-testid="step-popup">
        <div className="hx-pop-head">
          <div>
            <div className="hx-muted">Card {tile.no}</div>
            <h3 style={{ margin: 0 }}>{stepLabel(tile)} ({loading ? '…' : num(total)})</h3>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close ✕</button>
        </div>
        <div className="hx-pop-body">
          {loading ? <div className="small-muted">Loading the people…</div>
            : total === 0 ? <div className="small-muted">Nobody at this step for these filters.</div>
              : children}
          {!loading && total > shown && <div className="hx-muted" style={{ marginTop: 6 }}>Showing {num(shown)} of {num(total)}. Download the Excel for all of them.</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

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
const STATUS_OPTIONS = [{ value: 'inprocess', label: 'In process' }, { value: 'selected', label: 'Selected' }, { value: 'joined', label: 'Joined (still working)' }, { value: 'dropped', label: 'Dropped' }, { value: 'left', label: 'Left after joining' }];
export function Filters({ f, setF, recruiters = [], clients = [], requirements = [], statuses = false }) {
  const set = (k, v) => setF({ ...f, [k]: v });
  return (
    <div className="hx-filters">
      <label>From <input type="date" value={f.from || ''} onChange={(e) => setF({ ...f, from: e.target.value, period: '' })} /></label>
      <label>To <input type="date" value={f.to || ''} onChange={(e) => setF({ ...f, to: e.target.value, period: '' })} /></label>
      {/* the same quick picks as every date filter (utils/dateRanges.js): they fill From and To */}
      <label>Period
        <select aria-label="Period quick pick" value={f.period ? '' : matchPreset(f.from || '', f.to || '')} onChange={(e) => { const k = e.target.value; if (k === 'custom') return; const d = presetDates(k); setF({ ...f, period: '', from: d.from || '', to: d.to || '' }); }}>
          {PRESETS.filter(([k]) => k !== 'custom' || (f.from || f.to)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {dateProblem(f.from, f.to) && <span className="hx-muted" role="alert">{dateProblem(f.from, f.to)}</span>}
      {recruiters.length > 0 && (
        <MultiSelect label="Recruiter" allLabel="Everyone" value={f.recruiter || ''} onChange={(csv) => set('recruiter', csv)} options={recruiters.map((r) => ({ value: r.id, label: r.name }))} />
      )}
      {clients.length > 0 && (
        <MultiSelect label="Client" allLabel="All clients" value={f.client || ''} onChange={(csv) => set('client', csv)} options={clients.map((c) => ({ value: c.id, label: c.name }))} />
      )}
      {requirements.length > 0 && (
        <MultiSelect label="Requirement" allLabel="All requirements" value={f.requirement || ''} onChange={(csv) => set('requirement', csv)} options={requirements.map((r) => ({ value: r.id, label: r.name }))} />
      )}
      {statuses && (
        <MultiSelect label="Status" allLabel="Any status" value={f.status || ''} onChange={(csv) => set('status', csv)} options={STATUS_OPTIONS} />
      )}
      {(f.from || f.to || f.period || f.recruiter || f.client || f.requirement || f.status) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ ...f, from: '', to: '', period: '', recruiter: '', client: '', requirement: '', status: '' })}>Clear all</button>}
    </div>
  );
}

export const cleanParams = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== null && v !== undefined));

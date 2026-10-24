// ---------------------------------------------------------------------------
// THE FIT BREAKDOWN (2026-10-13): "Fit 82% = Resume 90 · AI 80 · Location 100 · Salary 60"
// as four small labelled chips (icon + text), one look everywhere the Fit shows:
// candidate list, board, profile, Matching candidates, job list.
//
// The SERVER decides what a login may see (utils/fitBreakdown.js):
//   full        four chips with their numbers (the Salary chip is a fit %, never rupees)
//   restricted  (BDE / BDE TL) one chip: "Salary: Within budget / Slightly above / Above budget /
//               Not known", and the total rounded ("about 80%"). No numbers for the parts.
// This file only draws what it is given.
//
//   <FitBreakdown b={breakdown} compact showTotal />
//   useFitBreakdown(applicationId)   the breakdown of one application for the rows on screen
//                                    (batched: one request for a whole page, cached for a minute)
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import './FitBreakdown.css';

const TONE = {
  green: 'fb-green', yellow: 'fb-amber', amber: 'fb-amber', red: 'fb-red', grey: 'fb-grey',
};

function chipText(chip) {
  if (chip.pct != null) return `${chip.label} ${chip.pct}`;
  if (chip.word) return `${chip.label}: ${chip.word}`;
  return chip.label;
}

function Chip({ chip, compact }) {
  const tip = [chip.help, chip.share != null && chip.counted ? `Counts for ${chip.share}% of this Fit.` : null, chip.why, chip.pct != null && chip.word ? chip.word : null].filter(Boolean).join(' ');
  return (
    <span className={`fb-chip ${TONE[chip.tone] || 'fb-grey'}${compact ? ' fb-sm' : ''}${chip.counted === false && chip.pct != null ? ' fb-off' : ''}`} title={tip}>
      <span className="fb-ic" aria-hidden="true">{chip.icon}</span>
      {chipText(chip)}
      {chip.pct != null && chip.word ? <span className="fb-sub">{` · ${chip.word.toLowerCase()}`}</span> : null}
    </span>
  );
}

const totalTone = (n) => (n >= 70 ? 'fb-green' : n >= 50 ? 'fb-amber' : 'fb-red');

export default function FitBreakdown({
  b, compact = false, showTotal = true, showFormula = false,
}) {
  if (!b) return null;
  return (
    <div className={`fb${compact ? ' fb-compact' : ''}`}>
      {showTotal && (
        <span className={`fb-total ${totalTone(b.total)}`} title={b.text}>
          {b.restricted ? `Fit about ${b.total}%` : `Fit ${b.total}%`}
          {b.label ? <span className="fb-label">{` · ${b.label}`}</span> : null}
        </span>
      )}
      <span className="fb-chips">
        {(b.chips || []).map((c) => <Chip key={c.key} chip={c} compact={compact} />)}
      </span>
      {!compact && b.note && <div className="fb-note">{b.note}</div>}
      {showFormula && !b.restricted && <div className="fb-formula">{b.text}</div>}
    </div>
  );
}

// ---- the batched loader -----------------------------------------------------
const TTL = 60 * 1000;
const cache = new Map(); // applicationId -> { at, b }  (b = null: nothing to show for this one)
const waiting = new Set();
const inflight = new Set();
const subs = new Set();
let timer = null;
const notify = () => subs.forEach((f) => f());

function flush() {
  timer = null;
  const ids = [...waiting].slice(0, 60);
  ids.forEach((id) => { waiting.delete(id); inflight.add(id); });
  if (!ids.length) return;
  api.post('/candidate-resumes/fit-breakdowns', { applicationIds: ids })
    .then((res) => {
      const items = (res.data && res.data.items) || {};
      ids.forEach((id) => cache.set(id, { at: Date.now(), b: items[id] || null }));
    })
    .catch(() => { ids.forEach((id) => cache.set(id, { at: Date.now(), b: null })); })
    .finally(() => { ids.forEach((id) => inflight.delete(id)); notify(); });
  if (waiting.size) timer = setTimeout(flush, 30);
}
function want(id) {
  const hit = cache.get(id);
  if ((hit && Date.now() - hit.at < TTL) || inflight.has(id) || waiting.has(id)) return;
  waiting.add(id);
  if (!timer) timer = setTimeout(flush, 80);
}

// undefined = still loading; null = there is nothing to show; else the breakdown.
export function useFitBreakdown(applicationId) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!applicationId) return undefined;
    const sub = () => force((n) => n + 1);
    subs.add(sub);
    want(applicationId);
    return () => { subs.delete(sub); };
  }, [applicationId]);
  if (!applicationId) return null;
  const hit = cache.get(applicationId);
  return hit ? hit.b : undefined;
}

// Forget what was loaded (after Fit settings or a salary changed).
export function resetFitBreakdowns() { cache.clear(); notify(); }

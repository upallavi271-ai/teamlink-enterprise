import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { fmtNum } from '../atskit/AtsKit.jsx';
import './candidatesV4.css';

// ---------------------------------------------------------------------------
// CANDIDATES & PIPELINE v4 (2026-10-08) — the pieces only pages/Candidates.jsx
// uses for the reference layout. PRESENTATION + one read: every number comes
// from GET /candidates (the pipeline's own server counts) or from data the
// page already loaded (requirements, facets, cards). Nothing is invented.
// ---------------------------------------------------------------------------

// The pipeline strip: seven steps over the server's stage keys. Each step is
// a plain "st:a,b" stage filter — the same filter the Step facet sets.
export const STRIP_STEPS = [
  { id: 'recruiter', label: 'Recruiter check', keys: ['recruiter_review'], icon: 'user', tone: 'blue', hint: 'A person applied and the recruiter is checking them' },
  { id: 'lead', label: 'TL / BDE check', keys: ['tl_review', 'bde_review'], icon: 'check', tone: 'violet', hint: 'Waiting for the team lead or the client manager (BDE) check' },
  { id: 'sent', label: 'Sent to client', keys: ['client_submitted'], icon: 'send', tone: 'green', hint: 'We sent the person to the client, and the client is looking' },
  { id: 'short', label: 'Client shortlisted', keys: ['client_shortlisted'], icon: 'star', tone: 'amber', hint: 'The client shortlisted the person' },
  { id: 'interview', label: 'Interview', keys: ['interview_scheduled', 'interview_completed', 'feedback_pending'], icon: 'calendar', tone: 'pink', hint: 'Interview booked or done, feedback awaited' },
  { id: 'offer', label: 'Selected / offer', keys: ['selected', 'offer'], icon: 'handshake', tone: 'blue', hint: 'Selected, and the job offer is made' },
  { id: 'joined', label: 'Joined', keys: ['joined', 'hrms'], icon: 'briefcase', tone: 'green', hint: 'The person started the job' },
];
export const stripFilter = (s) => `st:${s.keys.join(',')}`;
const normFilter = (v) => (String(v || '').startsWith('st:') ? String(v).slice(3).split(',').sort().join(',') : '');
export function stripStepOf(stageFilter) {
  const got = normFilter(stageFilter);
  if (!got) return '';
  const s = STRIP_STEPS.find((x) => [...x.keys].sort().join(',') === got);
  return s ? s.id : '';
}

// Overview counts over everything in the login's area with the screen's
// other filters on — no step / queue / tab filter, so a tile or a step never
// zeroes itself after it is clicked. One row is asked for (pageSize 1).
export function usePipelineOverview(params, { enabled = true } = {}) {
  const [out, setOut] = useState(null);
  const {
    stage, quick, sub, view, page, pageSize, sort, dir, idsOnly, all, ...rest
  } = params || {}; // eslint-disable-line no-unused-vars
  const key = JSON.stringify(rest);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api.get('/candidates', { params: { ...rest, paged: '1', view: 'pipeline', sub: 'all', page: 1, pageSize: 1 } })
      .then((res) => {
        if (!live) return;
        const c = (res.data && res.data.counts) || {};
        const by = {};
        (Array.isArray(c.stageOptions) ? c.stageOptions : []).forEach((o) => { if (o && o.key) by[o.key] = Number(o.count) || 0; });
        const steps = {};
        STRIP_STEPS.forEach((s) => { steps[s.id] = s.keys.reduce((n, k) => n + (by[k] || 0), 0); });
        setOut({
          subs: c.subs || {}, quick: c.quick || {}, byKey: by, steps,
        });
      })
      .catch(() => { if (live) setOut(null); });
    return () => { live = false; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return out;
}

// --- Top requirements needing attention ----------------------------------
// From GET /requirements (already loaded by the page): live jobs with people
// past their step's SLA, a target date that is late or within 3 days, or
// profiles waiting for review. Most urgent first; top 5 drawn.
export function useAttentionRequirements(requirements) {
  return useMemo(() => {
    const list = (Array.isArray(requirements) ? requirements : []).filter((r) => {
      if (!r || r.live === false) return false;
      const sla = r.sla || {};
      return Number(sla.overdue) > 0 || sla.state === 'overdue' || sla.state === 'due-soon' || Number(r.pendingReview) > 0;
    });
    const rank = (r) => {
      const sla = r.sla || {};
      return [
        -(Number(sla.overdue) || 0),
        sla.state === 'overdue' ? 0 : sla.state === 'due-soon' ? 1 : 2,
        -(Number(r.pendingReview) || 0),
        sla.daysLeft == null ? 1e6 : Number(sla.daysLeft),
      ];
    };
    const sorted = [...list].sort((a, b) => {
      const x = rank(a); const y = rank(b);
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    });
    return { total: list.length, top: sorted.slice(0, 5) };
  }, [requirements]);
}

export function TopRequirements({ rows, onPick, activeId }) {
  if (!rows.length) return <div className="ak-empty">No jobs need attention right now.</div>;
  return (
    <table className="ak-table cv4-reqs">
      <thead>
        <tr>
          <th>Req ID</th>
          <th>Job</th>
          <th className="num" title="People on this job past their step's time limit">Late</th>
          <th className="num" title="Profiles waiting for review on this job">Review</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const sla = r.sla || {};
          const late = Number(sla.overdue) || 0;
          return (
            <tr
              key={r.id}
              className={`ak-row-click${activeId === r.id ? ' cv4-on' : ''}`}
              onClick={() => onPick(r)}
              title={[r.title, r.internal ? 'TeamLink internal' : r.client && r.client.name, r.nextAction].filter(Boolean).join(' · ')}
            >
              <td className="cv4-code">{r.reqCode || '—'}</td>
              <td className="cv4-reqtitle">
                <span>{r.title}</span>
                <small>{[r.department, sla.state === 'overdue' && !late ? 'past target date' : sla.state === 'due-soon' ? `target in ${sla.daysLeft}d` : null].filter(Boolean).join(' · ') || '—'}</small>
              </td>
              <td className={`num${late ? ' ak-bad' : ''}`}>{late}</td>
              <td className="num">{fmtNum(Number(r.pendingReview) || 0)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- Candidate insights donut ------------------------------------------------
// Categorical slots in a fixed order (validated: scripts/validate_palette.js —
// "On hold" is a deliberate neutral). Every slice is also named in the legend
// with its count and share, so identity never rests on colour alone.
export const DONUT_COLORS = ['#2F6FE4', '#1BA3A1', '#8B5CF6', '#E59A1A', '#22A06B', '#5B6B80', '#D9483B'];

export function StageDonut({
  slices, centerLabel = 'Total', active,
}) {
  const [hover, setHover] = useState('');
  const total = slices.reduce((n, s) => n + (Number(s.value) || 0), 0);
  const R = 52;
  const W = 16;
  const C = 2 * Math.PI * R;
  const gap = total > 0 && slices.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  let acc = 0;
  const arcs = slices.map((s, i) => {
    const v = Number(s.value) || 0;
    const len = total ? (v / total) * C : 0;
    const a = {
      ...s, color: DONUT_COLORS[i % DONUT_COLORS.length], dash: Math.max(0, len - gap), offset: -acc,
    };
    acc += len;
    return a;
  });
  const hov = arcs.find((a) => a.key === hover);
  return (
    <div className="cv4-donut">
      <div className="cv4-donut-fig">
        <svg viewBox="0 0 140 140" width="132" height="132" role="img" aria-label={`${centerLabel}: ${fmtNum(total)}`}>
          <circle cx="70" cy="70" r={R} fill="none" stroke="#EEF2F7" strokeWidth={W} />
          {total > 0 && arcs.map((a) => (a.dash > 0 ? (
            <circle
              key={a.key}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth={hover === a.key ? W + 3 : W}
              strokeDasharray={`${a.dash} ${C - a.dash}`}
              strokeDashoffset={a.offset}
              transform="rotate(-90 70 70)"
              onMouseEnter={() => setHover(a.key)}
              onMouseLeave={() => setHover('')}
              onClick={a.onClick}
              style={{ cursor: a.onClick ? 'pointer' : 'default' }}
            >
              <title>{`${a.label}: ${fmtNum(a.value)} (${Math.round((a.value / total) * 100)}%)`}</title>
            </circle>
          ) : null))}
        </svg>
        <div className="cv4-donut-c">
          <b>{fmtNum(hov ? hov.value : total)}</b>
          <span>{hov ? hov.label : centerLabel}</span>
        </div>
      </div>
      <ul className="cv4-legend">
        {arcs.map((a) => {
          const pct = total ? Math.round((a.value / total) * 100) : 0;
          const body = (
            <>
              <i style={{ background: a.color }} aria-hidden="true" />
              <span className="cv4-legend-l">{a.label}</span>
              <span className="cv4-legend-v">{fmtNum(a.value)}</span>
              <span className="cv4-legend-p">{`${pct}%`}</span>
            </>
          );
          return (
            <li key={a.key} className={`${active === a.key ? 'is-on' : ''}${hover === a.key ? ' is-hover' : ''}`} onMouseEnter={() => setHover(a.key)} onMouseLeave={() => setHover('')}>
              {a.onClick ? <button type="button" onClick={a.onClick} aria-pressed={active === a.key}>{body}</button> : <div>{body}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Top-N rows of a facet (value · label · count), biggest first.
export function topFacet(options, n = 5) {
  return (Array.isArray(options) ? options : [])
    .filter((o) => o && Number(o.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count))
    .slice(0, n);
}

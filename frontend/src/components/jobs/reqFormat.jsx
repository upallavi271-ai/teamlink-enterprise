import { Link } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Small shared renderers for the Jobs / Requirements workspace (list, quick
// drawer, detail page) — one wording everywhere (ATS review #2 §6 / §7).
// ---------------------------------------------------------------------------

// §6 PRIORITY — the stored values are Low / Medium / High / Urgent (the form's
// list, atsVocab PRIORITIES). "Urgent" is SHOWN as Critical; nothing is
// re-coded in the data.
export const PRIORITY_DISPLAY = {
  Urgent: { icon: '🔴', label: 'Critical', cls: 'crit' },
  High: { icon: '🟠', label: 'High', cls: 'high' },
  Medium: { icon: '🟡', label: 'Medium', cls: 'med' },
  Low: { icon: '⚪', label: 'Low', cls: 'low' },
};
export const PRIORITY_CHOICES = [
  { value: 'Urgent', label: '🔴 Critical' },
  { value: 'High', label: '🟠 High' },
  { value: 'Medium', label: '🟡 Medium' },
  { value: 'Low', label: '⚪ Low' },
];
export const priorityLabel = (p) => (PRIORITY_DISPLAY[p] ? PRIORITY_DISPLAY[p].label : (p || '—'));

export function PriorityChip({ value }) {
  const d = PRIORITY_DISPLAY[value];
  if (!d) return <span className="small-muted">{value || '—'}</span>;
  return (
    <span className={`reqprio reqprio-${d.cls}`} title={value === 'Urgent' ? 'Critical (stored as Urgent)' : d.label}>
      <span aria-hidden="true">{d.icon}</span>
      {` ${d.label}`}
    </span>
  );
}

export const nf = (v) => Number(v || 0).toLocaleString('en-IN');
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
// "26 Sep" — spelled out by hand: Chrome's en-GB writes "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtShort = (d) => {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return `${x.getDate()} ${MONTHS[x.getMonth()]}${x.getFullYear() !== new Date().getFullYear() ? ` ${x.getFullYear()}` : ''}`;
};
export const fmtWhen = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

// "Age: 18 days"
export const ageText = (days) => (days === null || days === undefined ? '—' : `Age: ${nf(days)} day${days === 1 ? '' : 's'}`);

// "SLA: 3 days overdue" / "SLA: due in 5 days" / "SLA: due today" /
// "12 candidates past SLA". Returns { text, cls, title } or null.
export function slaInfo(sla) {
  if (!sla || !sla.state) return null;
  const parts = [];
  if (sla.daysLeft !== null && sla.daysLeft !== undefined) {
    const d = sla.daysLeft;
    parts.push(d < 0 ? `SLA: ${nf(-d)} day${d === -1 ? '' : 's'} overdue` : d === 0 ? 'SLA: due today' : `SLA: due in ${nf(d)} day${d === 1 ? '' : 's'}`);
  }
  if (sla.overdue) parts.push(`${nf(sla.overdue)} candidate${sla.overdue === 1 ? '' : 's'} past SLA`);
  const cls = sla.state === 'overdue' ? 'overdue' : sla.state === 'due-soon' ? 'pending' : 'active';
  const title = [
    sla.due ? `Target / closing date ${sla.due}` : 'No target or closing date set',
    sla.overdue ? `${sla.overdue} candidate(s) past their stage SLA` : 'No candidate past their stage SLA',
  ].join(' · ');
  return { text: parts.join(' · ') || 'SLA: on track', cls, title };
}

// "26 Sep · Kiran Kumar"
export function lastActivityText(la) {
  if (!la) return null;
  return `${fmtShort(la.at)}${la.by ? ` · ${la.by}` : ''}`;
}

// §7 — the five counts, in order. `key` is the field of row.pipeline.
export const COUNT_TILES = [
  { key: 'candidates', label: 'Candidates', hint: 'Every candidate on this requirement, incl. rejected / hold' },
  { key: 'shortlisted', label: 'Shortlisted', hint: 'Now at Client Shortlisted' },
  { key: 'interview', label: 'Interview', hint: 'Now at Interview Scheduled / Completed' },
  { key: 'selected', label: 'Selected', hint: 'Selected, Offer or Offer Accepted — not yet joined' },
  { key: 'joined', label: 'Joined', hint: 'Joined / Hired' },
];

export function CountTiles({ pipeline, onPick }) {
  const p = pipeline || {};
  return (
    <div className="reqtiles">
      {COUNT_TILES.map((t) => (
        <button key={t.key} type="button" className="reqtile" title={t.hint} onClick={onPick ? () => onPick(t.key) : undefined} disabled={!onPick}>
          <b>{nf(p[t.key])}</b>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ATS review #3 §4 — THE REQUIREMENT 360 PIPELINE:
//   New → Recruiter Review → TL Review → Client Review → Interview → Selected → Joined
// `pipeline.steps` comes from the server (routes/requirements.js
// pipelineCounts — the ONE definition the list row, the drawer and the detail
// page share). Each step opens the Candidates page on this requirement at
// those stages (/candidates?requirementId=…&stage=A,B — Candidates reads
// both; note its stage filter matches the candidate's CURRENT stage).
// ---------------------------------------------------------------------------
export const candidatesLink = (requirementId, stages) => {
  const q = new URLSearchParams({ requirementId });
  if (stages && stages.length) q.set('stage', stages.join(','));
  return `/candidates?${q.toString()}`;
};

export function PipelineSteps({ requirementId, pipeline, compact = false }) {
  const steps = (pipeline && pipeline.steps) || [];
  if (!steps.length) return null;
  const p = pipeline || {};
  return (
    <div className={`reqpipe${compact ? ' compact' : ''}`}>
      <div className="small-muted" style={{ fontSize: 11, marginBottom: 4 }}>
        {p.hiring === 'internal'
          ? 'Internal hiring — Screening → HR Review → Dept Head / TL → Interview → Feedback → Selected → Offer → Joining → HRMS'
          : 'Client hiring — Screening → Recruiter Review → TL Review → BDE Review → Client Submission → Client Decision → Interview → Feedback → Selected → Offer → Offer Accepted → Joining'}
      </div>
      <ol className="reqpipe-steps" aria-label="Candidates pipeline">
        {steps.map((s, i) => (
          <li key={s.key}>
            <Link
              to={candidatesLink(requirementId, s.stages)}
              className={`reqpipe-step${s.count ? ' has' : ''}`}
              title={`${s.label}: ${s.count} candidate(s) at this step now — open them in Candidates`}
            >
              <b>{nf(s.count)}</b>
              <span>{s.label}</span>
            </Link>
            {i < steps.length - 1 && <span className="reqpipe-arrow" aria-hidden="true">→</span>}
          </li>
        ))}
      </ol>
      <div className="reqpipe-foot">
        <Link to={candidatesLink(requirementId)}>{`All ${nf(p.candidates)} candidate(s)`}</Link>
        {p.hold ? <Link to={candidatesLink(requirementId, ['HOLD'])}>{` · ${nf(p.hold)} on hold`}</Link> : null}
        {p.rejected ? <Link to={candidatesLink(requirementId, ['REJECTED'])}>{` · ${nf(p.rejected)} rejected`}</Link> : null}
      </div>
    </div>
  );
}

// §24 — the workflow statuses in the app-wide colours (StatusChip). The word
// alone does not say it ("Sourcing", "Recruiter Assigned" match no rule), so
// the tone is passed explicitly: live = green, waiting = amber, closed = grey.
const LIVE_CODES = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
export const reqStatusTone = (code) => (LIVE_CODES.includes(code) ? 'green'
  : ['ON_HOLD', 'AGREEMENT_CHECK', 'DRAFT'].includes(code) ? 'amber' : 'grey');

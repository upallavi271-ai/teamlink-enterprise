import { useEffect, useState } from 'react';
import api from '../../api';
import './guide.css';

// ---------------------------------------------------------------------------
// "A NEW PERSON GETS IT IN 20–30 SECONDS" (user, 2026-10-05).
//
//   <Help text="Candidates still moving through steps" />   a small ? tip
//   <HowItWorks uid={user.id} page="candidates" steps={…} active={id} onPick={…} />
//        Job → Candidate → Sent to client → Interview → Offer → Joined,
//        each step with its count; a click filters the list. "Hide" is
//        remembered per user (localStorage, try/catch — works without it).
//   <FirstTips uid={user.id} page="candidates" tips={['…', '…', '…']} />
//        a first-visit 1-2-3 tip, shown until "Got it", never again after.
//   usePipelineSteps(params)  the step counts, from GET /candidates (the
//        pipeline's own stage counts, so they match the list exactly).
// ---------------------------------------------------------------------------

function readFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key, on) {
  try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* not remembered */ }
}

// Everyday words for labels the server still names the old way (report
// tiles, table headings, notes). Labels only — never people / client names.
const WHOLE = {
  Submitted: 'Sent to client', TL: 'TL', 'In Pipeline': 'In progress', 'In pipeline': 'In progress',
};
const PLAIN_RULES = [
  [/\bTL Review\b/g, 'Team lead check'], [/\bBDE Review\b/g, 'Client manager check'], [/\bRecruiter Review\b/g, 'Recruiter check'],
  [/\bClient Submitted\b/g, 'Sent to client'], [/\bSubmissions\b/g, 'Sent to client'], [/\bsubmissions\b/g, 'people sent to the client'],
  [/\bCandidate Pipeline\b/g, 'Candidates in progress'], [/\b([Ii])n pipeline\b/g, '$1n progress'], [/\bPipeline\b/g, 'Progress'], [/\bpipeline\b/g, 'progress'],
  [/\bStages\b/g, 'Steps'], [/\bStage\b/g, 'Step'], [/\bstages\b/g, 'steps'], [/\bstage\b/g, 'step'],
  [/\bRequirements\b/g, 'Jobs'], [/\bRequirement\b/g, 'Job'], [/\brequirements\b/g, 'jobs'], [/\brequirement\b/g, 'job'],
  [/\bDays past SLA\b/g, 'Days late'], [/\bSLA & Aging\b/g, 'Late & waiting'], [/\bSLA\b/g, 'time allowed'],
  [/\bOverdue\b/g, 'Late'], [/\boverdue\b/g, 'late'],
  [/\bin scope\b/g, 'in your area'], [/\bScope\b/g, 'Your area'],
  [/\bFeedback pending\b/g, 'Waiting for feedback'], [/\b([Aa])ging\b/g, (m, a) => (a === 'A' ? 'Waiting time' : 'waiting time')],
];
export function plainWords(s) {
  if (typeof s !== 'string' || !s) return s;
  if (WHOLE[s]) return WHOLE[s];
  return PLAIN_RULES.reduce((t, [re, to]) => t.replace(re, to), s);
}

// A short ? tooltip. `focusable={false}` inside a button (StatCard).
export function Help({ text, focusable = true, className = '' }) {
  if (!text) return null;
  return (
    <span
      className={`gd-help ${className}`}
      data-tip={text}
      title={text}
      aria-label={focusable ? text : undefined}
      aria-hidden={focusable ? undefined : 'true'}
      role={focusable ? 'note' : undefined}
      tabIndex={focusable ? 0 : undefined}
      onClick={(e) => { if (focusable) e.stopPropagation(); }}
    >
      ?
    </span>
  );
}

// The hiring flow, in plain words. `keys` are the pipeline's stage keys
// (backend routes/candidates.js stageKeyOf) each step adds up.
export const PIPELINE_STEPS = [
  { id: 'job', icon: '💼', label: 'Job', hint: 'A client (or our company) wants people for a job' },
  { id: 'candidate', icon: '🙋', label: 'Candidate', hint: 'A person applied and we are checking them (recruiter, then team lead)', keys: ['recruiter_review', 'tl_review', 'bde_review'] },
  { id: 'sent', icon: '📤', label: 'Sent to client', hint: 'We sent the person to the client, and the client is looking', keys: ['client_submitted', 'client_shortlisted'] },
  { id: 'interview', icon: '🗓️', label: 'Interview', hint: 'The client interviews the person, then gives feedback', keys: ['interview_scheduled', 'interview_completed', 'feedback_pending'] },
  { id: 'offer', icon: '🤝', label: 'Offer', hint: 'Selected, and the job offer is made', keys: ['selected', 'offer'] },
  { id: 'joined', icon: '🎉', label: 'Joined', hint: 'The person started the job — done!', keys: ['joined', 'hrms'] },
];
// "st:a,b,c" — the pipeline's stage filter for one step.
export function stepStageFilter(id) {
  const s = PIPELINE_STEPS.find((x) => x.id === id);
  return s && s.keys ? `st:${s.keys.join(',')}` : '';
}
export function stepOfStageFilter(v) {
  const st = String(v || '');
  if (!st.startsWith('st:')) return '';
  const got = st.slice(3).split(',').sort().join(',');
  const s = PIPELINE_STEPS.find((x) => x.keys && [...x.keys].sort().join(',') === got);
  return s ? s.id : '';
}

// Step counts over everything in the login's area with the screen's other
// filters on (no step / queue / tab filter). null while unknown or refused.
export function usePipelineSteps(params, { enabled = true } = {}) {
  const [counts, setCounts] = useState(null);
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
        const opts = (res.data && res.data.counts && res.data.counts.stageOptions) || [];
        const by = {};
        opts.forEach((o) => { by[o.key] = Number(o.count) || 0; });
        const out = {};
        PIPELINE_STEPS.forEach((s) => { if (s.keys) out[s.id] = s.keys.reduce((n, k) => n + (by[k] || 0), 0); });
        setCounts(out);
      })
      .catch(() => { if (live) setCounts(null); });
    return () => { live = false; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return counts;
}

const nf = (n) => Number(n).toLocaleString('en-IN');

export function HowItWorks({
  uid, page, steps = PIPELINE_STEPS, counts, active = '', onPick, title = 'How it works',
}) {
  const key = `tl.guide.hiw.${page}.${uid || 'anon'}`;
  const [hidden, setHidden] = useState(() => readFlag(key));
  useEffect(() => { setHidden(readFlag(key)); }, [key]);
  if (hidden) {
    return (
      <div className="gd-hiw-off">
        <button type="button" className="link-btn" onClick={() => { writeFlag(key, false); setHidden(false); }}>Show how it works</button>
      </div>
    );
  }
  return (
    <section className="gd-hiw" aria-label={title}>
      <div className="gd-hiw-head">
        <b>{title}</b>
        <span className="gd-hiw-sub">Every person moves left to right. Click a step to see who is there.</span>
        <button type="button" className="gd-x" aria-label="Hide how it works" title="Hide (you can show it again)" onClick={() => { writeFlag(key, true); setHidden(true); }}>Hide ×</button>
      </div>
      <ol className="gd-hiw-steps">
        {steps.map((s, i) => {
          const n = counts && counts[s.id] !== undefined && counts[s.id] !== null ? Number(counts[s.id]) : null;
          const on = active === s.id;
          return (
            <li key={s.id} className="gd-hiw-li">
              <button
                type="button"
                className={`gd-step${on ? ' is-on' : ''}`}
                aria-pressed={on}
                title={`${s.hint}${onPick ? (on ? ' — click again to show everyone' : ' — click to see them') : ''}`}
                onClick={onPick ? () => onPick(on ? '' : s.id) : undefined}
                disabled={!onPick}
              >
                <span className="gd-step-ic" aria-hidden="true">{s.icon}</span>
                <span className="gd-step-l">{s.label}</span>
                {n !== null && (n > 0
                  ? <span className="gd-step-n">{nf(n)}</span>
                  : <span className="gd-step-none">none yet</span>)}
              </button>
              {i < steps.length - 1 && <span className="gd-arrow" aria-hidden="true">→</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function FirstTips({
  uid, page, tips = [], title = 'New here? 3 quick tips',
}) {
  const key = `tl.guide.tips.${page}.${uid || 'anon'}`;
  const [done, setDone] = useState(() => readFlag(key));
  useEffect(() => { setDone(readFlag(key)); }, [key]);
  if (done || !tips.length) return null;
  const close = () => { writeFlag(key, true); setDone(true); };
  return (
    <aside className="gd-tips" role="note" aria-label={title}>
      <div className="gd-tips-head">
        <b>{title}</b>
        <button type="button" className="gd-x" aria-label="Close the tips" onClick={close}>×</button>
      </div>
      <ol className="gd-tips-list">
        {tips.map((t, i) => (
          <li key={i}>
            <span className="gd-tips-n" aria-hidden="true">{i + 1}</span>
            <span>{t}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-sm btn-primary" onClick={close}>Got it</button>
    </aside>
  );
}

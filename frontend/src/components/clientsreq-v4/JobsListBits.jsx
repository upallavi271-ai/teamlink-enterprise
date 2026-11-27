import { useEffect, useState } from 'react';
import { deptLabel } from '../../atsVocab'; // Manufacturing shows as Non IT MFG (2026-10-29)
import { isOpenJob } from '../jobs/reqStatus.jsx'; // Open = not Closed: a job waiting for the agreement can still get its recruiter

// ---------------------------------------------------------------------------
// Small pieces of the Jobs list (Clients & Requirements -> Jobs): the same
// words and tags in the table row and in the "Selected requirement" panel.
// Pure presentation: nothing here decides what a login may do.
// ---------------------------------------------------------------------------

// A media query as a boolean (re-renders when the window crosses it).
export function useMedia(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    if (m.addEventListener) m.addEventListener('change', fn); else m.addListener(fn);
    window.addEventListener('resize', fn);
    return () => {
      window.removeEventListener('resize', fn);
      if (m.removeEventListener) m.removeEventListener('change', fn); else m.removeListener(fn);
    };
  }, [query]);
  return on;
}

// Department as a small coloured tag. The colour comes from the name, so the
// same department is the same colour everywhere (and a new one needs no code).
const TAGS = [
  ['#E8F0FE', '#1A56DB'], ['#E3F5EC', '#14804A'], ['#FFF1E0', '#B45309'], ['#F3E8FF', '#6B21A8'],
  ['#E0F4F4', '#0E7C7B'], ['#FDE8EC', '#B4233E'], ['#EEF1F6', '#475569'], ['#FFF8DB', '#8A6A00'],
];
const tagFor = (name) => {
  let h = 0;
  String(name || '').toLowerCase().split('').forEach((ch) => { h = (h * 31 + ch.charCodeAt(0)) % 997; });
  return TAGS[h % TAGS.length];
};
export function DeptTag({ name }) {
  if (!name) return null;
  const [bg, fg] = tagFor(name);
  return <span className="jl-dept" style={{ background: bg, color: fg }} title={`Department: ${deptLabel(name)}`}>{deptLabel(name)}</span>;
}

// A person's name as plain text; when nobody is named: "Not assigned" in a
// soft red (missing team lead) or amber (missing recruiter). A closed job that
// never had one just shows a dash.
// "+4" never hides who the others are (founder 2026-11-27: who are the remaining people behind +1 / +4?):
//   full   every name, one under the other (the Selected requirement panel has the room)
//   else   the first name and a "+4" button: hover shows the names, a press opens a small list of them
export function PersonName({ name, extra, others = null, full = false, tone = 'red', live = true }) {
  const [open, setOpen] = useState(false);
  const rest = Array.isArray(others) ? others.filter((x) => x && x !== name) : [];
  const n = rest.length || Number(extra) || 0;
  if (name) {
    if (full && rest.length) {
      return (
        <span className="jl-person jl-person-all">
          {[name, ...rest].map((x) => <span key={x}>{x}</span>)}
        </span>
      );
    }
    return (
      <span className="jl-person">
        {name}
        {n > 0 && (rest.length ? (
          <span className="jl-person-wrap">
            <button
              type="button"
              className="jl-person-more jl-person-btn"
              title={`Also: ${rest.join(', ')}`}
              aria-expanded={open}
              aria-label={`${n} more: ${rest.join(', ')}`}
              onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
              onBlur={() => setOpen(false)}
            >
              {`+${n}`}
            </button>
            {open && (
              <span className="jl-person-pop" role="note">
                <b>Also on it</b>
                {rest.map((x) => <span key={x}>{x}</span>)}
              </span>
            )}
          </span>
        ) : <span className="jl-person-more">{` +${n}`}</span>)}
      </span>
    );
  }
  if (!live) return <span className="cell-muted">—</span>;
  return <span className={`jl-missing jl-missing-${tone}`}>Not assigned</span>;
}

// "Open · 15d · On time": the second line under the status chip.
export function ageSlaLine(r, sla, ageText, nf) {
  const age = r.ageDays === null || r.ageDays === undefined ? null : `${nf(r.ageDays)}d open`;
  const when = sla ? sla.text : (age ? 'No deadline' : null);
  if (!age && !when) return null;
  return { text: [age, when].filter(Boolean).join(' · '), cls: sla ? sla.cls : '' };
}

// THE ONE main action of a row, in plain words, from what the job needs:
// no team lead -> "Assign a team lead", no recruiter -> "Assign a recruiter",
// otherwise what the server named for this role (Add candidate, Send to
// client, Create invoice ...) and, when that is only "Edit" / "View", "Open job".
// `mayAssign` is the server's answer for this row; the API enforces it anyway.
// A Recruiter or Accounts login never gets the assign buttons promoted to the main one. kinds = what this login assigns (reqActions.js assignKinds).
export function rowPrimary(r, role = '', kinds = ['assign-tl', 'assign-recruiter']) {
  const server = r.primaryAction || { key: 'open', label: 'View' };
  const promote = !r.mayAssign || ['recruiter', 'accounts'].includes(role) ? false : isOpenJob(r);
  if (promote && r.needs === 'tl' && kinds.includes('assign-tl')) return { key: 'assign-tl', label: 'Assign a team lead', strong: true };
  if (promote && r.needs === 'recruiter' && kinds.includes('assign-recruiter')) return { key: 'assign-recruiter', label: 'Assign a recruiter', strong: true };
  if (['open', 'edit', 'assign-recruiter', 'assign-tl'].includes(server.key)) return { key: 'open', label: 'Open requirement', strong: false };
  const words = {
    'add-candidate': 'Add a person', 'view-candidates': 'See people', 'submit-client': 'Send to BDE TL', 'generate-invoice': 'Create invoice',
  };
  return { key: server.key, label: words[server.key] || server.label, strong: true };
}

// One sentence for the NEXT STEP box.
export function nextStepSentence(r, primary, waiting) {
  if (isOpenJob(r) && r.needs === 'tl') return primary.key === 'assign-tl' ? 'This requirement has no team lead yet. Pick one so work can start.' : 'This requirement has no team lead yet.';
  if (isOpenJob(r) && r.needs === 'recruiter') return primary.key === 'assign-recruiter' ? 'This requirement has a team lead but no recruiter yet. Pick one to find people.' : 'This requirement has a team lead but no recruiter yet. The team lead gives it to recruiters.';
  if (waiting) return `${waiting}.`;
  switch (primary.key) {
    case 'add-candidate': return 'Add people for this requirement.';
    case 'submit-client': return 'People are ready to send to the BDE TL.';
    case 'generate-invoice': return 'Someone joined. The invoice can be made.';
    case 'view-candidates': return 'This requirement is not open now. You can still see its people.';
    default: return !isOpenJob(r) ? 'This requirement is not open. Open it to see the details.' : 'Nothing is waiting. Open the requirement to see the details.';
  }
}

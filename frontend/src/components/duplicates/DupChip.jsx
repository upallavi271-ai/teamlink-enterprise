import { openDupPanel } from './openDup.jsx';
import './Duplicates.css';

// The small red chip on a candidate row / card / profile: "Duplicate: resolve first".
// dup = { level, count, status, holds } from the list (server: utils/candidateDupes.js attachFlags).
// A click opens the "Check duplicates" window for that person.
export function DupChip({ dup, candidateId, onChanged, label }) {
  if (!dup || !candidateId) return null;
  const holds = !!dup.holds;
  const text = label || (holds ? 'Duplicate: resolve first' : 'Maybe a duplicate');
  return (
    <button
      type="button"
      className={`dupx-chip ${holds ? 'is-red' : 'is-amber'}`}
      title={holds ? 'This person looks like another profile. They cannot move on until you check it.' : 'This person may be the same as another profile. This does not stop anything.'}
      onClick={(e) => { e.stopPropagation(); openDupPanel({ candidateId, onChanged }); }}
    >
      {text}
    </button>
  );
}

// "Already in ATS (matched by phone)" — a Job Portal applicant who was already a candidate here.
export function AlreadyInAtsChip({ info }) {
  if (!info) return null;
  return <span className="dupx-chip is-blue" title="This person applied on the job portal and was already in the ATS. The application was added to the existing profile.">{info.text}</span>;
}

// A full-width line at the top of a profile: red when the person is held, with the one button.
export function DupBanner({ dup, candidateId, name, onChanged }) {
  if (!dup) return null;
  return (
    <div className={`dupx-banner${dup.holds ? '' : ' is-amber'}`} role="alert">
      <span>
        <b>{dup.holds ? 'Duplicate: resolve first.' : 'Maybe a duplicate.'}</b>
        {' '}
        {dup.holds
          ? `${name || 'This person'} looks like another profile, so they stay at the first step until you check it.`
          : `${name || 'This person'} may be the same as another profile. Nothing is stopped.`}
      </span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => openDupPanel({ candidateId, onChanged })}>Check duplicates</button>
    </div>
  );
}

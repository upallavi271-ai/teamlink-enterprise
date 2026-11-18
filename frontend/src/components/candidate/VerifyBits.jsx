// ---------------------------------------------------------------------------
// SMALL PIECES OF THE VERIFY WORK (founder audit 2026-11-18): the confidence chip beside a parsed field, the resume sentence with the value highlighted, and
// one flag shown side by side ("what the resume says" / "what is saved").
//   <ConfChip level />            high / medium / low
//   <Highlight line needle />     the resume sentence with the matching words marked
//   <FlagRow flag onResolve />    one flag: message, resume says vs saved, the sentence, and the buttons that decide it
// The server decides who may do what (utils/resumeVerify.js, routes/dataVerify.js); the buttons only offer what the login can do.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import './VerifyBits.css';

const WORD = { high: 'Sure', medium: 'Likely', low: 'Not sure' };
const TITLE = {
  high: 'High confidence: the resume labels this value and says it once.',
  medium: 'Medium confidence: read from a phrase or a place without a label.',
  low: 'Low confidence: a guess, or the resume gives two different values. Please check it.',
};
export function ConfChip({ level, label }) {
  if (!level) return null;
  return <span className={`vb-chip vb-${level}`} title={TITLE[level]}>{label || WORD[level]}</span>;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// marks every piece of `needle` (split into its words and numbers) that the sentence contains
export function Highlight({ line, needle }) {
  if (!line) return null;
  const bits = String(needle || '').split(/[\s/,]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
  if (!bits.length) return <span className="vb-line">{line}</span>;
  const re = new RegExp(`(${bits.map(esc).join('|')})`, 'gi');
  const parts = String(line).split(re);
  return (
    <span className="vb-line">
      {parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

const KIND_WORD = {
  low_confidence: 'Not sure', implausible: 'Does not look right', conflict: 'Two different values', inconsistent: 'Does not agree with the profile', education: 'Education check',
};
const STATE_WORD = {
  OPEN: 'To check', WAIT_TL: 'Waiting for the team lead', APPROVED: 'Approved', CORRECTED: 'Corrected', DISMISSED: 'Not a problem',
};
export function FlagRow({ flag, canApprove, canCorrect, onResolve, busy }) {
  const [mode, setMode] = useState(null); // 'correct'
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const open = flag.status === 'OPEN' || flag.status === 'WAIT_TL';
  const correctable = ['name', 'email', 'phone', 'dob', 'experienceYears', 'currentSalary', 'expectedSalary', 'noticePeriod', 'location', 'education', 'currentDesignation', 'currentCompany'].includes(flag.field);
  const waits = flag.status === 'WAIT_TL';
  const decide = async (action, extra = {}) => { await onResolve(flag, { action, ...extra }); setMode(null); setValue(''); setNote(''); };
  return (
    <div className={`vb-flag vb-k-${flag.kind}${open ? '' : ' is-done'}`}>
      <div className="vb-head">
        <b>{flag.label}</b>
        <span className="vb-kind">{KIND_WORD[flag.kind] || flag.kind}</span>
        {!open && <span className="vb-state">{STATE_WORD[flag.status] || flag.status}{flag.resolvedByName ? ` · ${flag.resolvedByName}` : ''}</span>}
        {waits && <span className="vb-state wait">{STATE_WORD.WAIT_TL}</span>}
      </div>
      <div className="vb-msg">{flag.message}</div>
      {(flag.resumeSays || flag.saved) && (
        <div className="vb-side">
          <div><div className="vb-k">The resume says</div><div className="vb-v">{flag.resumeSays || '—'}</div></div>
          <div><div className="vb-k">Saved on the profile</div><div className="vb-v">{flag.saved || '—'}</div></div>
        </div>
      )}
      {flag.evidence && (
        <div className="vb-ev"><span className="vb-k">From the resume: </span><Highlight line={flag.evidence} needle={flag.resumeSays} /></div>
      )}
      {(flag.evidences || []).slice(1, 3).map((e, i) => <div key={i} className="vb-ev"><span className="vb-k">Also: </span><Highlight line={e} needle={flag.resumeSays} /></div>)}
      {open && onResolve && (
        <div className="vb-actions">
          {mode !== 'correct' && (
            <>
              {canCorrect && correctable && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setMode('correct'); setValue(flag.resumeSays && !/ \/ /.test(flag.resumeSays) ? flag.resumeSays : ''); }}>Correct it</button>}
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || (waits && !canApprove)} onClick={() => decide('approve')} title={canApprove ? 'The value is right as it is' : 'You can mark it checked; the team lead approves it'}>{canApprove ? 'Approve' : 'Mark checked'}</button>
              {canApprove && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => decide('dismiss')} title="Not a real problem">Not a problem</button>}
            </>
          )}
          {mode === 'correct' && (
            <div className="vb-fix">
              <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={`Right ${flag.label.toLowerCase()}`} aria-label={`Correct ${flag.label}`} />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" aria-label="Note" />
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || !value.trim()} onClick={() => decide('correct', { value, note })}>Save the correction</button>
              <button type="button" className="btn btn-sm" onClick={() => setMode(null)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ConfChip;

import { useBrowserCall } from './CallProvider.jsx';

// "Call" beside a candidate's number. Calls straight from the browser on a phone line (office Synway SIM by default), not through the recruiter's own phone.
// Hidden when this login may not use browser calling (switched Off, role not allowed) or the number is not shown to it.
// With more than one line, the small ▾ opens "Call using" first; a plain click uses the line picked last time.
export default function CallButton({ candidateId, applicationId, name, hasNumber = true, compact = false, size = '' }) {
  const { available, state, call, pickAndCall, info, lines, line } = useBrowserCall();
  if (!available || !hasNumber || !candidateId) return null;
  const busy = ['starting', 'calling', 'ringing', 'connected'].includes(state.phase);
  const on = line ? line.name : 'the SIM line';
  return (
    <>
      <button
        type="button"
        className={compact || size === 'sm' ? 'btn btn-sm' : 'btn'}
        style={{ padding: compact ? '1px 8px' : undefined, marginLeft: size === 'sm' ? 0 : 6 }}
        disabled={busy}
        title={info && info.testMode ? `Call from your browser on ${on} (Test mode: only test numbers)` : `Call from your browser on ${on}`}
        onClick={(e) => { e.stopPropagation(); call({ candidateId, applicationId, name }); }}
      >
        {'☎'} Call
      </button>
      {lines && lines.length > 1 && (
        <button
          type="button"
          className="btn btn-sm"
          style={{ padding: '1px 5px', marginLeft: 2 }}
          disabled={busy}
          title="Pick the line (Call using)"
          aria-label="Pick the line to call on"
          onClick={(e) => { e.stopPropagation(); pickAndCall({ candidateId, applicationId, name }); }}
        >
          {'▾'}
        </button>
      )}
    </>
  );
}

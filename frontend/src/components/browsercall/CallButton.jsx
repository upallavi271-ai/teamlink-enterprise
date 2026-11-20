import { useBrowserCall } from './CallProvider.jsx';

// "Call" beside a candidate's number. Calls straight from the SIP line (browser -> Asterisk -> Synway SIM), not through the recruiter's own phone.
// Hidden when this login may not use browser calling (switched Off, role not allowed) or the number is not shown to it.
export default function CallButton({ candidateId, applicationId, name, hasNumber = true, compact = false }) {
  const { available, state, call, info } = useBrowserCall();
  if (!available || !hasNumber || !candidateId) return null;
  const busy = ['starting', 'calling', 'ringing', 'connected'].includes(state.phase);
  return (
    <button
      type="button"
      className={compact ? 'btn btn-sm' : 'btn'}
      style={{ padding: compact ? '1px 8px' : undefined, marginLeft: 6 }}
      disabled={busy}
      title={info && info.testMode ? 'Call from your browser (Test mode: only test numbers)' : 'Call from your browser (SIM line)'}
      onClick={(e) => { e.stopPropagation(); call({ candidateId, applicationId, name }); }}
    >
      {'☎'} Call
    </button>
  );
}

// ---------------------------------------------------------------------------
// THE SAME-CLIENT RULE (user decision #5) — shown on the Rejection reasons
// report. When a client already rejected a person, sending them to that
// client again either warns and asks (default) or is blocked. Everyone sees
// the rule; only a Super Admin / Admin can change it (checked on the server).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import './Rejections.css';

export default function SameClientRule() {
  const [rule, setRule] = useState(null);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/rejections/settings').then((r) => setRule(r.data)).catch(() => setRule(null));
  }, []);
  if (!rule) return null;
  async function choose(sameClient) {
    if (sameClient === rule.sameClient) return;
    setError('');
    setSaid('');
    try {
      const r = await api.put('/rejections/settings', { sameClient });
      setRule(r.data);
      setSaid('Saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the rule. Please try again.');
    }
  }
  const text = rule.sameClient === 'block'
    ? 'Blocked: a person a client already rejected cannot be sent to that client again.'
    : 'Warn and ask: sending a person to a client that already rejected them shows a warning and needs a "yes".';
  return (
    <div className="notice rjx-rule">
      <span><b>Same client again:</b>{` ${text}`}</span>
      {rule.canEdit && (
        <span className="rjx-row">
          <button type="button" className={`btn btn-sm${rule.sameClient === 'warn' ? ' btn-primary' : ''}`} onClick={() => choose('warn')}>Warn and ask</button>
          <button type="button" className={`btn btn-sm${rule.sameClient === 'block' ? ' btn-primary' : ''}`} onClick={() => choose('block')}>Block</button>
        </span>
      )}
      {said && <span className="rjx-ok" role="status">{said}</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

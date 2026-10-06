// ---------------------------------------------------------------------------
// "CREATE MEETING LINK" (B4, 2026-10-06). A real Google Meet / Microsoft Teams
// link from the account in Administration → Integrations → Calendar Sync.
// Without an account: "Built — needs an account" + the exact setup steps.
// Never a made-up link. The paste-a-link field stays where it is.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import './panel.css';

export default function MeetingLinkButton({ applicationId, onMade }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null); // { ok, text, steps }
  const [showSteps, setShowSteps] = useState(false);
  async function make() {
    setBusy(true); setOut(null);
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/meeting-link`);
      setOut({ ok: true, text: r.data.message, link: r.data.meetingLink });
      if (onMade) onMade(r.data);
    } catch (e) {
      const d = e.response?.data || {};
      setOut({ ok: false, needsAccount: !!d.needsAccount, text: d.error || 'No link was made. Please try again.', steps: d.setup ? d.setup.steps : null, missing: d.setup ? d.setup.missing : null });
    } finally { setBusy(false); }
  }
  return (
    <div className="mlk">
      <button type="button" className="btn btn-sm" disabled={busy} onClick={make}>{busy ? 'Creating…' : '🔗 Create meeting link'}</button>
      {out && out.ok && <div className="mlk-ok" role="status">{out.text} <a href={out.link} target="_blank" rel="noreferrer">Open</a></div>}
      {out && !out.ok && (
        <div className={`mlk-msg${out.needsAccount ? ' is-setup' : ' is-err'}`} role="status">
          <div>{out.text}</div>
          {out.steps && (
            <>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowSteps(!showSteps)}>{showSteps ? 'Hide the setup steps' : 'Show the setup steps (for the Admin)'}</button>
              {showSteps && Object.entries(out.steps).map(([p, steps]) => (
                <div key={p} className="mlk-steps">
                  <b>{p === 'google' ? 'Google Meet' : 'Microsoft Teams'}</b>
                  <ol>{steps.map((s) => <li key={s}>{s}</li>)}</ol>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

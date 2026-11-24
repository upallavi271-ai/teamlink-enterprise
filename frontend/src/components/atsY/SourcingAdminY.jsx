import api from '../../api';
import { Card, Flash, Empty, useGet, useRun } from '../mktb/kit.jsx';

// ---------------------------------------------------------------------------
// Administration > ATS settings > AI governance > "Sourcing & AI connectors" (ATS wave 2 Y, backend /api/ats/y/settings):
// the Admin switches of the notetaker, outside look-ups, job-change bells, prospecting, the MCP write tools and LinkedIn RSC (ALL OFF until
// an Admin turns them on), and what each outside account needs. The accounts themselves are typed in Administration > Integrations.
// ---------------------------------------------------------------------------
const Y = '/ats/y';
const SHORT = { notetakerBot: 'AI notetaker joins meetings', outsideLookups: 'Outside look-ups (people data)', jobChangeAlerts: 'Job-change bells', prospecting: 'Prospecting (ATS Clients)', mcpWrite: 'MCP write tools (note, follow-up, step)', rscSync: 'LinkedIn RSC sync' };

export default function SourcingAdminY() {
  const s = useGet(`${Y}/settings`);
  const { busy, msg, run } = useRun();
  if (s.error) return <div className="notice">{s.error}</div>;
  if (!s.data) return <Empty>Loading…</Empty>;
  const d = s.data;
  return (
    <div data-testid="atsy-admin">
      <Card title="Sourcing & AI switches" note="Each of these sends data out, joins a meeting, tells people something or lets an outside tool change records. All start OFF. Every change is in the audit log.">
        {Object.keys(d.switches).map((k) => (
          <label key={k} className="mkb-row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={!!d.switches[k]} disabled={busy || !d.mayEdit} aria-label={SHORT[k] || k} style={{ marginTop: 3 }}
              onChange={(e) => run(() => api.put(`${Y}/settings`, { key: k, value: e.target.checked }), `${SHORT[k] || k}: ${e.target.checked ? 'ON' : 'OFF'}.`).then(s.reload)} />
            <span className="mkb-grow"><b>{SHORT[k] || k}</b><div className="small-muted">{d.labels[k]}</div></span>
          </label>
        ))}
        <Flash msg={msg} />
      </Card>
      <Card title="Connectors" note="The outside accounts are typed once in Administration > Integrations (the keys are encrypted and never shown again). Until then each feature says what is missing and nothing is called.">
        <ul className="mkb-list">
          {d.connectors.map((c) => (
            <li key={c.id}>
              <span className="mkb-grow"><b>{c.label}</b>{c.why && <div className="small-muted">{c.why}</div>}</span>
              <span className={`mkb-chip ${/^(Working|Installed|Account)/.test(c.state) ? 'good' : 'new'}`}>{c.state}</span>
            </li>
          ))}
        </ul>
        <a className="btn btn-sm" href="/admin/integrations">Open Integrations</a>
      </Card>
    </div>
  );
}

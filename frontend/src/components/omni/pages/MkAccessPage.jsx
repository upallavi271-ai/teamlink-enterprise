import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Banner } from '../ui.jsx';

// AI MARKETING > WHO CAN SEE THIS (2026-11-16, simple like Green Start; an Admin's page): for each kind of login, what it sees and may do in AI Marketing. The table is made from the real
// rules (outreach/access.js mkRoleTable), so it is always right. The AI limits and the other company switches are on "AI usage", opened from here.
export default function MkAccessPage() {
  const { go } = useOmni();
  const [roles, setRoles] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); omni.get('/gs/marketing/roles').then((x) => setRoles(x.roles || [])).catch((e) => setErr(errOf(e, 'The table could not be read.'))); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !roles) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!roles) return <div className="card panel">Loading…</div>;
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Who can see this" lead="Every login sees only its own part. Marketing = the logins you tick as Marketing in Omni-Channel > Settings.">
        <Btn primary onClick={() => go('mkusage')}>AI limits, approval and client switches</Btn>
      </PageHead>
      <Panel title="Who sees what in AI Marketing">
        <div style={{ overflowX: 'auto' }}>
          <table className="mk-table"><thead><tr><th>LOGIN</th><th>SEES IN AI MARKETING</th><th>MAY</th></tr></thead>
            <tbody>{roles.map((r) => (
              <tr key={r.kind}>
                <td style={{ whiteSpace: 'nowrap' }}><b>{r.who}</b></td>
                <td style={{ fontSize: 12 }}>{r.sees.length ? r.sees.join(' · ') : <span style={{ color: 'var(--muted)' }}>Nothing: AI Marketing is not shown</span>}</td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.settings ? 'Everything, and the settings' : r.writes ? 'Write and make; an approver approves' : r.approves ? 'Approve or send back' : r.outside ? 'Approve their own work' : 'Nothing here'}</td>
              </tr>
            ))}</tbody></table>
        </div>
      </Panel>
    </div>
  );
}

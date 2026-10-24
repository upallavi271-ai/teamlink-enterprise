import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHead, Tabs, GsModal, Btn } from '../ui.jsx';
import { useOmni } from '../omniContext.js';
import TeamMembers from '../admin/TeamMembers.jsx';
import TeamRoles from '../admin/TeamRoles.jsx';
import TeamAudit from '../admin/TeamAudit.jsx';

// Team & Roles (prototype: "Workspace access"): Members, Roles & permissions, Audit log. Visible to Admin, Department Head and Team Lead (the server's
// pagesFor decides). The data comes from /api/outreach/gs/admin/team/*.
export default function TeamPage() {
  const { acc } = useOmni();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const tab = ['members', 'roles', 'audit'].includes(sp.get('tab')) ? sp.get('tab') : 'members';
  const [invite, setInvite] = useState(false);
  const admin = !!(acc && acc.isAdmin);
  const setTab = (t) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  return (
    <div>
      <PageHead eyebrow="Workspace access" title="Team & Roles" lead="Who can reach this workspace, and exactly what each role is allowed to do.">
        <Btn primary onClick={() => setInvite(true)}>＋ Invite member</Btn>
      </PageHead>
      <Tabs tabs={[['members', 'Members'], ['roles', 'Roles & permissions'], ['audit', 'Audit log']]} value={tab} onChange={setTab} />
      {tab === 'members' && <TeamMembers onInvite={() => setInvite(true)} />}
      {tab === 'roles' && <TeamRoles />}
      {tab === 'audit' && <TeamAudit />}
      {invite && (
        <GsModal title="Invite a team member" sub="One person, one login" width={460} onClose={() => setInvite(false)}
          foot={<><Btn onClick={() => setInvite(false)}>Close</Btn>{admin && <Btn primary onClick={() => navigate('/admin/users')}>Open Administration &gt; Users</Btn>}</>}>
          <p style={{ fontSize: 12, lineHeight: 1.7, margin: 0 }}>In TeamLink every employee is one person with one login. People are added, given a role and switched off in <b>Administration &gt; Users</b>. As soon as their role can use Omni-Channel they appear in this list by themselves.</p>
          <p style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--muted)' }}>{admin ? 'Nothing is sent from here: no invitation email is made up.' : 'Ask an Admin to add the person. Nothing is sent from here.'}</p>
        </GsModal>
      )}
    </div>
  );
}

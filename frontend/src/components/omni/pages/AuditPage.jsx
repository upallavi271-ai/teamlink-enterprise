import { PageHead } from '../ui.jsx';
import TeamAudit from '../admin/TeamAudit.jsx';

// SETTINGS & AUDIT LOG > Audit log: who did what in Omni-Channel (templates, approvals, campaigns, sends, replies matched by a person). No phone number and no email is ever shown.
// An Admin sees everything and may download it; a Department Head / Team Lead sees what their own people did.
export default function AuditPage() {
  return (
    <div>
      <PageHead eyebrow="Settings & Audit Log" title="Audit log" lead="Every template change and approval, every campaign (made, approved, scheduled, paused, cancelled, sent or rehearsed), and every reply a person matched or dismissed." />
      <TeamAudit />
    </div>
  );
}

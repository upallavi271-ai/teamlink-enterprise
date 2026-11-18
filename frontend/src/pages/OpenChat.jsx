import { Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { can } from '../permissions';

// ---------------------------------------------------------------------------
// /open/chat/:kind/:id - where "a WhatsApp reply from <person>" leads (the notification only knows WHO wrote, not which screen THIS login may use).
//   an employee   Admin / Super Admin (may open the Organization Chart) -> its WhatsApp chats, on that person
//                 a lead with the Team page                              -> Recruiter & BDE > Follow-ups > WhatsApp chats, on that person
//                 anybody else                                           -> Follow-ups > WhatsApp chats, on that person
// The chat itself, and who may see it, is decided by the server as everywhere else (/api/wa-chats); this only picks the door.
// ---------------------------------------------------------------------------
export default function OpenChat() {
  const { kind, id } = useParams();
  const { user } = useAuth();
  if (!user) return <div className="loading-screen">Loading…</div>;
  const who = encodeURIComponent(`EMPLOYEE:${id}`);
  if (kind === 'employee') {
    if (can(user, null, 'administration', 'Organization Structure', 'view')) return <Navigate replace to={`/admin/org-chart?view=whatsapp&chat=${who}`} />;
    if (can(user, null, 'recruiterbde', 'Team View', 'view')) return <Navigate replace to={`/ats/team?view=followups&sub=chats&chat=${who}`} />;
    return <Navigate replace to={`/ats/followups?sub=chats&chat=${who}`} />;
  }
  if (kind === 'candidate') return <Navigate replace to={`/candidates/${id}?tab=conversation`} />;
  if (kind === 'client') return <Navigate replace to={`/clients/${id}`} />;
  return <Navigate replace to="/admin/notifications" />;
}

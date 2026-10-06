import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { visibleItems } from '../../nav';
import ListPageHeader from '../../components/ui/ListPageHeader.jsx';
import './ReportBits.css';

// ---------------------------------------------------------------------------
// REPORTS & TEAM → SETTINGS (ATS layout v3 §5, 2026-10-03) — LINKS ONLY.
//
// "If already in Administration, keep them there and only link." Every ATS
// setting already has its page (Administration → Company Setup tabs, Role
// Catalog, Integrations, the Offers and Agreements screens). This page is a
// short list of plain cards that open them — nothing is copied, nothing is
// saved here. A card shows only when this login may open its page (the same
// permission rules the sidebar uses, nav.js visibleItems); the page itself
// still refuses anyone else on the server.
// ---------------------------------------------------------------------------
const isAdmin = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const card = (icon, to, title, hint, perms, when) => ({
  icon, to, label: title, hint, perms: perms || null, ...(when ? { when } : {}),
});

const GROUPS = [
  {
    id: 'org',
    title: 'People and departments',
    cards: [
      card('🗂️', '/admin/departments', 'Departments & teams', 'Add a department or team, and who leads it.', [['administration', 'Departments & Teams', 'view']]),
      card('🔀', '/ats/team?view=org', 'Move people between teams', 'Give a team lead departments, move a recruiter — with history.', null, isAdmin),
      card('🔐', '/admin/roles', 'Roles', 'Admin, Dept Head, BDE, Recruiter — who may see and do what.', [['administration', 'Role Catalog', 'view']]),
    ],
  },
  {
    id: 'lists',
    title: 'Lists and rules',
    cards: [
      card('📋', '/admin/master-lists', 'Master lists', 'Rejection reasons, sources, specializations and the other pick lists.', [['administration', 'Company Setup', 'view']]),
      card('⏰', '/admin/step-timing', 'Step timing and alerts', 'How many days each step may take before it is Late — e.g. "alert if no reply in 3 days".', null, isAdmin),
      card('🔔', '/admin/step-timing', 'Notification rules', 'Who is told when work is late, and how long the bell keeps messages.', null, isAdmin),
      card('🎯', '/admin/fit', 'Fit settings', 'How the Fit % between a person and a job is worked out.', null, isAdmin),
    ],
  },
  {
    id: 'messages',
    title: 'Messages and templates',
    cards: [
      card('📨', '/ats/offers', 'Offer letter template', 'Open Offers and press "Edit letter template".', [['interviews', 'Offers', 'edit']]),
      card('📝', '/agreements', 'Agreement template', 'Open Agreements and press the settings button.', [['clients', 'Agreement Lifecycle', 'edit']]),
      card('✉️', '/admin/integrations', 'Email sending', 'The email account messages go out from, and a test email.', [['administration', 'Integrations', 'view']]),
    ],
  },
];

export default function ReportsSettings() {
  const { user } = useAuth() || {};
  const groups = GROUPS
    .map((g) => ({ ...g, cards: visibleItems(user, g.cards) }))
    .filter((g) => g.cards.length);
  return (
    <div className="rphome rpset">
      <ListPageHeader title="Settings" question="The ATS settings live in Administration. Pick one to open it." />
      {!groups.length && (
        <div className="notice">There are no settings you can change. Ask your admin if something needs changing.</div>
      )}
      {groups.map((g) => (
        <section key={g.id}>
          <h2>{g.title}</h2>
          <div className="rphome-grid">
            {g.cards.map((c) => (
              <Link key={`${c.to}-${c.label}`} to={c.to} className="rphome-card">
                <span className="rphome-ic" aria-hidden="true">{c.icon}</span>
                <span>
                  <span className="rphome-t">{c.label} <span aria-hidden="true">→</span></span>
                  <span className="rphome-a">{c.hint}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

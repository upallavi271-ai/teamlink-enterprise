// Who sees the "Omni-Channel" sidebar entry. This only DRAWS the entry: the server (backend/src/outreach/access.js) decides what each
// login may open or do inside it. Everyone in recruitment sees it (Recruiter, TL / STL, BDE, BDE TL, Manager, AM, Admin, Super Admin) plus
// the HR desk / Internal HR (their Internal tab). Accountants see it for Insights > Credits only. Not for Clients, Candidates, Vendors, Partners.
export function omniAllowed(user) {
  if (!user || !user.products) return false;
  const roles = [user.role, user.atsRole].filter(Boolean);
  if (roles.some((r) => ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].includes(r))) return false;
  // Finance (Accounts role) opens only Insights > Credits (the server decides; /api/outreach/me answers for them)
  const fin = !!user.products.accounts && [user.accountsRole, user.role].includes('ACCOUNTANT');
  if (!user.products.ats) return fin;
  if (user.hrDesk || (user.internalHr && user.internalHr.member)) return true;
  if (fin) return true;
  return roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'TL', 'STL', 'BDE', 'RECRUITER', 'HR'].includes(r));
}
export const OMNI_PATH = '/omni-channel'; // the old /omni still works (it redirects)

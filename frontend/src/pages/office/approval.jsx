// The approval lifecycle on screen: the status badge, what this login may do
// (asked of the API — routes/office.js GET /access), and the session cache of
// the row-click details.
import { useEffect, useState } from 'react';
import api from '../../api';
import { can, productRole } from '../../permissions';

// Office & Expenses is Super Admin, Admin and Accounts only — the API refuses
// everyone else (routes/office.js: SET.ACCOUNTS + the matrix's view). This is
// the same answer on screen, for the page itself and for the Dashboard's
// Reminders card (which reads GET /office-expenses/due-dates); it only avoids
// offering something that would answer 403.
const OFFICE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'];
export function canViewOffice(user) {
  return OFFICE_ROLES.includes(productRole(user, 'accounts'))
    && can(user, 'accounts', 'accounts', 'Office & Expenses', 'view');
}

export const APPROVAL = {
  PENDING: { label: 'Pending', long: 'Pending approval', cls: 'oe-appr-pending' },
  APPROVED: { label: 'Approved', long: 'Approved', cls: 'oe-appr-approved' },
  PAID: { label: 'Paid', long: 'Paid', cls: 'oe-appr-paid' },
  REJECTED: { label: 'Rejected', long: 'Rejected', cls: 'oe-appr-rejected' },
  // One-page spec: paid back to whoever paid it — money out, like Paid.
  REIMBURSED: { label: 'Reimbursed', long: 'Reimbursed', cls: 'oe-appr-reimbursed' },
};
export const APPROVAL_OPTIONS = [
  ['All', 'All'], ['PENDING', 'Pending approval'], ['APPROVED', 'Approved'], ['PAID', 'Paid'], ['REIMBURSED', 'Reimbursed'], ['REJECTED', 'Rejected'],
];

export function ApprovalBadge({ s, title }) {
  const a = APPROVAL[s] || APPROVAL.PENDING;
  return <span className={`oe-appr ${a.cls}`} title={title || a.long}>{a.label}</span>;
}

// Loaded once per page visit; the API is still what refuses.
export function useOfficeAccess() {
  const [a, setA] = useState({});
  useEffect(() => {
    let live = true;
    api.get('/office-expenses/access').then((r) => { if (live) setA(r.data || {}); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return a;
}

// Row details, cached for the session once loaded; any change clears them.
const cache = new Map();
export const detailCache = {
  get: (id) => cache.get(id),
  set: (id, v) => cache.set(id, v),
  drop: (id) => cache.delete(id),
  clear: () => cache.clear(),
};

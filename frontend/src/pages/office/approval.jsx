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

// Accounts spec S1.3c (2026-10-05): Paid and Pending only. A stored row that
// still carries Approved / Rejected / Reimbursed (none on 2026-10-05) is
// shown as "Other (old status)" — nothing is rewritten.
const OLD = { label: 'Other (old status)', cls: 'oe-appr-old' };
export const APPROVAL = {
  PENDING: { label: 'Pending', long: 'Pending — not paid yet', cls: 'oe-appr-pending' },
  PAID: { label: 'Paid', long: 'Paid', cls: 'oe-appr-paid' },
  APPROVED: { ...OLD, long: 'Other (old status) — stored as Approved, not paid yet' },
  REJECTED: { ...OLD, long: 'Other (old status) — stored as Rejected, out of the books' },
  REIMBURSED: { ...OLD, long: 'Other (old status) — stored as Reimbursed, money out' },
};
export const APPROVAL_OPTIONS = [['All', 'All'], ['PENDING', 'Pending'], ['PAID', 'Paid']];

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

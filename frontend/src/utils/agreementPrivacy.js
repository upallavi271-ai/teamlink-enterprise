// AGREEMENTS ARE NOT FOR TLs / STLs / RECRUITERS / HR (user, 2026-10-12: "TLs ki, recruiters ki agreements visible
// avvakudadu"). The server never sends them an agreement word (backend utils/agreementPrivacy.js); this is the screen's
// side: whoever the permission matrix gives no 'Agreement Lifecycle' view must not be shown an agreement label,
// chip, tab, tile or hint. (Super Admin, Admin, Manager, Assistant Manager, BDE, BDE TL and Accounts hold the view.)
import { can } from '../permissions';
import { useAuth } from '../context/AuthContext.jsx';

export const HOLD_MESSAGE = 'This requirement is on hold. Ask your Business Development manager.';
export const agreementBlind = (user) => !!user && !can(user, 'ats', 'clients', 'Agreement Lifecycle', 'view');
export function useAgreementBlind() {
  const { user } = useAuth();
  return agreementBlind(user);
}

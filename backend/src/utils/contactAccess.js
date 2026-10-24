// ---------------------------------------------------------------------------
// CONTACT ACCESS — who may Call / Mail / WhatsApp / SMS whom.
//
// CONTACTING IS ITS OWN RIGHT (user, 2026-10-10): separate from "edit" and "approve".
// A Manager or an Assistant Manager (view + approve roles) follow up team escalations; a BDE
// follows up the candidates shared with their clients; an Accountant sends payment reminders.
// None of them need the right to edit a candidate, so the old rule ("contact = Candidate
// Master / edit") made them read-only for no good reason.
//
//   switchOn(user)   the Role Catalog switch  candidates / "Contact (Mail / WhatsApp / SMS / Call)" / view
//                    (Administration -> Role Catalog). Read for the person's own product role.
//   ruleFor(user, audience)
//        -> { audience, allowed, mode, kind, purposes, reason }
//        audience  candidates | clients | employees
//        mode      'direct'  the person may see the number / address and use their own phone
//                  'masked'  the SERVER resolves the number / address; the screen shows only the
//                            name and a hint like 98••••3210; calls go through TeamLink
//                            (Exotel) or "ask the recruiter to call"; nothing is opened in the
//                            sender's own app (that would need the number)
//        kind      'primary' the contact person   |  'billing' the client's billing contact
//        purposes  null = any template / own words;  [keys] = only these templates (Accountant)
//        reason    a plain sentence when not allowed
//   bulkAllowed(user, audience)  sending to MANY at once: the same rule plus the old edit rights,
//                    and never in masked mode (a list would expose the people)
//   scrubFor(text)   a message body shown to a masked viewer with numbers / e-mail addresses hidden
//
// SCOPE is not decided here: messageContext.recipientsFor() keeps every request inside the caller's
// own people (candidateWhere / clientWhere / employeeWhere).
// ---------------------------------------------------------------------------

const core = require('./messagingCore');

const FEATURE = 'Contact (Mail / WhatsApp / SMS / Call)';
const AUDIENCES = ['candidates', 'clients', 'employees'];
// The only templates an Accountant may send (to a client's BILLING contact).
const BILLING_PURPOSES = ['CLIENT_PAYMENT_REMINDER', 'CLIENT_INVOICE_NOTICE'];

const lazy = {
  perm: () => require('./permissions'), // eslint-disable-line global-require
  scope: () => require('./scope'), // eslint-disable-line global-require
};

const isExternal = (u) => !u || !u.id || ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);

// The Role Catalog switch for THIS person. It is read from the person's own role row (ATS role first, then HRMS,
// then Accounts) so that an HR login without ATS, or an Accountant, is judged by the same switch.
async function switchOn(user) {
  if (isExternal(user)) return false;
  const P = lazy.perm();
  // ATS role first; a login with no ATS role but an Accounts role (the Accountant) is judged by that; else HRMS (HR).
  const order = ['ats', 'accounts', 'hrms'];
  for (const product of order) {
    const role = P.roleForProduct(user, product);
    if (!role) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const acc = await P.accessFor(role, 'candidates', 'ats');
    return !!(acc && acc.features && acc.features[FEATURE] && acc.features[FEATURE].view);
  }
  // Super Admin / Admin logins always carry a role above; nothing else reaches here.
  return false;
}

const SWITCH_OFF = 'Contacting people is switched off for your role. A Super Admin turns it on in Administration > Role Catalog > "Contact (Mail / WhatsApp / SMS / Call)".';

function rolesOf(user) {
  const S = lazy.scope();
  const s = S.atsScopeOf(user);
  return { s, ats: s.atsRole, hrms: s.hrmsRole, global: !!s.global, bde: S.clientViewRole(user) === 'bde', bdeTl: S.isBdeTl(user) };
}

// Is the person an HR login (in HRMS or in ATS)?
const isHr = (r) => r.ats === 'HR' || r.hrms === 'HR';

async function ruleFor(user, audience) {
  const deny = (reason) => ({ audience, allowed: false, mode: 'direct', kind: 'primary', purposes: null, reason });
  if (!AUDIENCES.includes(audience)) return deny('Unknown kind of person.');
  if (isExternal(user)) return deny('Not available to this login.');
  if (!(await switchOn(user))) return deny(SWITCH_OFF);
  const r = rolesOf(user);
  const caps = user.caps || {};
  const named = (x) => (x && x !== 'NONE' ? x : null);
  const atsRole = named(r.ats);

  if (audience === 'candidates') {
    if (r.global || ['MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'HR'].includes(atsRole)) {
      // The BDE team never receives a candidate's number / e-mail; the same goes for any role the
      // Role Catalog switch "Candidate Contact & Salary" is OFF for.
      const masked = r.bde || r.bdeTl || caps.candidateContact === false;
      return { audience, allowed: true, mode: masked ? 'masked' : 'direct', kind: 'primary', purposes: null, reason: null };
    }
    if (atsRole === 'ACCOUNTANT') return deny('Accounts sends payment reminders to a client\'s billing contact. Candidates are contacted by the recruiting team.');
    return deny('Your role does not follow up candidates.');
  }

  if (audience === 'clients') {
    if (r.global || atsRole === 'BDE' || r.bdeTl || atsRole === 'MANAGER') {
      return { audience, allowed: true, mode: 'direct', kind: 'primary', purposes: null, reason: null };
    }
    // The Assistant Manager does not see client phone numbers or e-mail addresses: contact goes THROUGH TeamLink.
    if (atsRole === 'ASSISTANT_MANAGER') return { audience, allowed: true, mode: 'masked', kind: 'primary', purposes: null, reason: null };
    if (atsRole === 'ACCOUNTANT') {
      return {
        audience, allowed: true, mode: 'direct', kind: 'billing', purposes: BILLING_PURPOSES,
        reason: null,
      };
    }
    return deny('Client contacts are handled by the client managers (BDE). Ask the BDE of this client.');
  }

  // employees
  if (r.global || isHr(r) || ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(atsRole) || ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(named(r.hrms))) {
    return { audience, allowed: true, mode: 'direct', kind: 'primary', purposes: null, reason: null };
  }
  return deny('Only HR, team leads and managers contact employees.');
}

// WhatsApp to EMPLOYEES (HRMS, founder 2026-10-24): the Super Admin / Admin and the HR desk only. A team lead or manager keeps Call / Mail to
// their people but does not send WhatsApp announcements from the company numbers.
const WA_EMPLOYEE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'HR'];
function mayWhatsAppEmployees(user) {
  if (!user || isExternal(user)) return false;
  return [user.role, user.hrmsRole, user.atsRole].some((r) => WA_EMPLOYEE_ROLES.includes(r));
}
const WA_EMPLOYEE_DENIED = 'WhatsApp to employees is for the Super Admin and HR.';

// Sending to MANY at once. The old edit rights stay (a list is a bigger act than one message), and a masked
// role never bulk-sends (the list would show the people).
async function bulkAllowed(user, audience) {
  const rule = await ruleFor(user, audience);
  if (!rule.allowed || rule.mode === 'masked' || rule.purposes) return false;
  const { can } = lazy.perm();
  if (audience === 'candidates') return can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  if (audience === 'clients') return can(user, 'ats', 'clients', 'Client Detail', 'edit');
  return can(user, 'hrms', 'hrms', 'Employee Management', 'edit');
}

// ---- masking -----------------------------------------------------------------
const maskAddress = (channel, raw) => (channel === 'Email' ? core.maskEmail(raw) : core.maskMobile(raw)) || '••••';
// "98••••3210" style hint for a phone, "a•••@domain" for an address.
function maskedHint(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  return t.includes('@') ? core.maskEmail(t) : core.maskMobile(t);
}
// A text shown to a masked viewer: phone numbers and e-mail addresses written inside are hidden.
function scrubFor(text) {
  return String(text == null ? '' : text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[address hidden]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number hidden]');
}

// Express guard for the old per-candidate routes (quick-log, contact): contact right instead of "edit".
function requireContact(audience = 'candidates') {
  return async (req, res, next) => {
    try {
      const rule = await ruleFor(req.user, audience);
      if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login' });
      req.contactRule = rule;
      return next();
    } catch (err) { return next(err); }
  };
}

module.exports = {
  mayWhatsAppEmployees, WA_EMPLOYEE_DENIED,
  FEATURE, AUDIENCES, BILLING_PURPOSES, switchOn, ruleFor, bulkAllowed, maskAddress, maskedHint, scrubFor, requireContact, SWITCH_OFF,
};

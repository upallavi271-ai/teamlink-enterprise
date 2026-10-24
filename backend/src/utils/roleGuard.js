// ---------------------------------------------------------------------------
// ROLE GUARD (security fix 2026-10-13) - the ONE place that decides who may
// change who holds which role. Every write path that touches a login's role /
// hrmsRole / atsRole / accountsRole / atsDepartment calls checkRoleChange()
// BEFORE writing and noteRoleChange() AFTER.
//
//   Super Admin : may do everything, except change their OWN role and except
//                 take the last Super Admin below Super Admin.
//   Admin       : may give / take Manager, Asst Manager, HR and everything below.
//                 May NOT give or take Admin / Super Admin, may NOT edit a
//                 login that is a Super Admin or an Admin.
//   everybody else (HR, STL, TL, ...) : may only change roles BELOW the
//                 privileged set; may never give Admin / Super Admin /
//                 Manager / Asst Manager / HR, and never touch a login that
//                 holds one of those.
//   Nobody changes their own role.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const TOP = ['SUPER_ADMIN', 'ADMIN'];
const DESK = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'];
const ROLE_FIELDS = ['role', 'hrmsRole', 'atsRole', 'accountsRole'];

// A delegate with HR super access (utils/hrSuper.js) looks like a Super Admin but is NOT one here.
const isSuper = (u) => !!u && u.role === 'SUPER_ADMIN' && !u.hrSuper;
const holds = (u, list) => !!u && ROLE_FIELDS.some((f) => list.includes(u[f]));

// Role fields the write would CHANGE (value present and different).
function changedFields(current, next) {
  const out = [];
  ROLE_FIELDS.forEach((f) => {
    if (next[f] === undefined) return;
    const want = next[f] || null;
    const have = current ? (current[f] || null) : null;
    if (want !== have) out.push(f);
  });
  if (next.atsDepartment !== undefined && current && (next.atsDepartment || null) !== (current.atsDepartment || null)) out.push('atsDepartment');
  return out;
}

async function superAdminCount(exceptId) {
  return prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'Active', ...(exceptId ? { id: { not: exceptId } } : {}) } });
}

// Returns a plain-words refusal, or null when the write is allowed.
// actor: req.user. current: the login row being changed (null when creating).
// next: the role fields about to be written (any of ROLE_FIELDS + atsDepartment).
async function checkRoleChange({ actor, current, next }) {
  if (!actor) return 'Please sign in again.';
  const changed = changedFields(current, next || {});
  if (!changed.length) return null;
  const roleChange = changed.filter((f) => ROLE_FIELDS.includes(f));
  // A custom role with company-wide reach counts as desk-level.
  const customDesk = new Set();
  for (const f of roleChange) {
    const v = next[f];
    if (!v || v === 'NONE' || DESK.includes(v)) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await require('./roleRegistry').roleByCode(String(v)).catch(() => null); // eslint-disable-line global-require
    if (r && require('./roleRegistry').isPrivilegedRole(r)) customDesk.add(v); // eslint-disable-line global-require
  }
  const grants = (list) => roleChange.some((f) => list.includes(next[f]) || (list === DESK && customDesk.has(next[f])));
  const currentTop = holds(current, TOP);

  if (current && current.id === actor.id) return 'You cannot change your own role. Ask a Super Admin.';
  // HR super access (founder, 2026-10-14): the role "Internal HR" and the Admin / Super Admin roles are handed out by a real Super Admin / Admin only.
  if (actor.hrSuper && roleChange.some((f) => next[f] === require('./hrSuper').ROLE_CODE)) return 'Only a Super Admin or an Admin can give the Internal HR role.'; // eslint-disable-line global-require
  if (!isSuper(actor) && actor.role !== 'ADMIN' && !actor.hrSuper && roleChange.some((f) => next[f] === require('./hrSuper').ROLE_CODE)) return 'Only a Super Admin or an Admin can give the Internal HR role.'; // eslint-disable-line global-require

  if (isSuper(actor)) {
    // Never leave the company without a Super Admin.
    if (current && current.role === 'SUPER_ADMIN' && next.role !== undefined && next.role !== 'SUPER_ADMIN') {
      if ((await superAdminCount(current.id)) < 1) return 'There must always be at least one Super Admin. Make another Super Admin first.';
    }
    return null;
  }
  // Below a Super Admin: nobody touches a Super Admin login.
  if (current && (holds(current, ['SUPER_ADMIN']))) return 'Only a Super Admin can change a Super Admin.';
  if (grants(['SUPER_ADMIN', 'ADMIN'])) return 'Only a Super Admin can give the Admin or Super Admin role.';
  if (current && currentTop) return 'Only a Super Admin can change an Admin.';

  if (actor.role === 'ADMIN' || actor.hrSuper) return null;

  // HR, STL, TL, Manager ... : nothing at or above the desk level, either way.
  if (grants(DESK)) return 'You cannot give this role. Ask a Super Admin or an Admin.';
  if (current && holds(current, DESK)) return 'You cannot change the role of this person. Ask a Super Admin or an Admin.';
  return null;
}

// Audit every role change (who, whom, old -> new) and tell the Super Admins about Admin / Super Admin grants.
async function noteRoleChange({ actor, current, next, source }) {
  try {
    const changed = changedFields(current, next || {}).filter((f) => ROLE_FIELDS.includes(f));
    if (!changed.length) return;
    const from = changed.map((f) => `${f}=${current ? (current[f] || '-') : '-'}`).join(', ');
    const to = changed.map((f) => `${f}=${next[f] || '-'}`).join(', ');
    const target = current || {};
    await logAudit({
      userId: actor.id, actorName: actor.name, action: `Role change${target.name ? ` for ${target.name}` : ''}${source ? ` (${source})` : ''}`,
      entity: 'User', entityId: target.id || null, fromValue: from, toValue: to,
    });
    const topGrant = changed.some((f) => TOP.includes(next[f]));
    if (topGrant) {
      const sas = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true } });
      const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
      await notifyUsers(sas.map((u) => u.id), {
        title: 'Admin access was given',
        message: `${actor.name || 'Someone'} gave ${target.name || 'a new login'} the role ${changed.map((f) => next[f]).filter((v) => TOP.includes(v)).join(' / ')}.`,
        exceptUserId: actor.id,
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[roleGuard] note failed:', e && e.message);
  }
}

// May this actor set / reset another login's password with a typed password
// (the old path)? Super Admin: anyone but themselves. Admin: not a Super Admin,
// not another Admin. Others: not anyone holding a desk-level role.
function checkPasswordTarget({ actor, target }) {
  if (!actor || !target) return 'Please sign in again.';
  if (isSuper(actor)) return null;
  if (holds(target, ['SUPER_ADMIN'])) return 'Only a Super Admin can reset the password of a Super Admin.';
  if (holds(target, ['ADMIN'])) return 'Only a Super Admin can reset the password of an Admin.';
  return null;
}

module.exports = { TOP, DESK, ROLE_FIELDS, checkRoleChange, noteRoleChange, checkPasswordTarget, changedFields, holds, isSuper, superAdminCount };

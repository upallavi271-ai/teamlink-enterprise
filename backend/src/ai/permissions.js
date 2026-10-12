// ---------------------------------------------------------------------------
// STEP "Check Permission". The agent has EXACTLY the permissions of the logged-in
// user: the same can() engine and Role Catalog the screens use (so a Super Admin
// can do whatever a Super Admin can, a Manager is still view + approve only,
// and a Recruiter still cannot delete a client). Nothing here widens anything;
// the route the tool then replays checks again.
//
//   1. the AI grant       Role Catalog -> "AI Assistant & Agent" -> Agent
//   2. not "View as"      a Super Admin viewing as someone is read-only
//   3. not an outside login (Client / Candidate)
//   4. a plain employee   may do their OWN leave tools and nothing else
//   5. the product        the login must hold the tool's product (ATS / HRMS / Accounts)
//   6. can(...)           the tool's own feature/action grant
//   7. the tool's `roles` extra rule, if it has one
// ---------------------------------------------------------------------------

const permissions = require('../utils/permissions');
const aiAccess = require('../utils/aiAccess');

const { can } = permissions;

const PRODUCT_NAME = { ats: 'Recruitment (ATS)', hrms: 'HRMS', accounts: 'Accounts' };

// Plain words for who is asking.
function roleWords(user) {
  const roles = [user.atsRole, user.hrmsRole, user.accountsRole, user.role]
    .filter((r) => r && r !== 'NONE')
    .map((r) => String(r).replace(/_/g, ' ').toLowerCase());
  const uniq = [...new Set(roles)];
  return uniq.length ? uniq.slice(0, 2).join(' / ') : 'your role';
}

// A plain employee: holds no ATS or Accounts role and sees only their own HRMS records.
function isSelfServiceOnly(user) {
  const held = aiAccess.productsHeld(user);
  return !held.ats && !held.accounts && !!(user.caps && user.caps.hrmsSelfOnly);
}

async function grantCheck(user, perm, params) {
  if (typeof perm === 'function') {
    const out = await perm(user, params);
    if (out && typeof out === 'object') return out;
    return { ok: !!out };
  }
  const allowed = await can(user, perm.product || null, perm.module, perm.feature, perm.action);
  return { ok: !!allowed };
}

// -> { ok:true } | { ok:false, code, message }
async function checkTool(user, tool, { viewAs = false } = {}) {
  if (viewAs) {
    return { ok: false, code: 'view_as', message: 'You are viewing as someone else, which is read-only. Nothing can be changed from here.' };
  }
  const access = user.ai || await aiAccess.aiAccessFor(user);
  if (!access.agent) {
    return { ok: false, code: 'ai_agent_denied', message: 'Your role cannot use the AI Agent. Ask your Super Admin to switch it on for you in Role Catalog.' };
  }
  if (aiAccess.isExternal(user)) {
    return { ok: false, code: 'external', message: 'The AI Agent is for TeamLink staff logins only.' };
  }
  const held = aiAccess.productsHeld(user);
  if (isSelfServiceOnly(user) && !tool.selfService) {
    return {
      ok: false,
      code: 'employee_only_own',
      message: `As an employee you can ask me to do your OWN leave (apply, check the balance, cancel a pending one) and read your own attendance, payslip, leave and timesheet. "${tool.label}" is not something your role can do.`,
    };
  }
  if (!held[tool.module]) {
    return { ok: false, code: 'no_product', message: `Your login does not have ${PRODUCT_NAME[tool.module]}, so I cannot ${tool.label.toLowerCase()} for you. Nothing was changed.` };
  }
  let g;
  try { g = await grantCheck(user, tool.permission, null); } catch { g = { ok: false }; }
  if (!g.ok) {
    return {
      ok: false,
      code: 'no_permission',
      message: g.message || `Your role (${roleWords(user)}) cannot ${tool.label.toLowerCase()}. I can only do what you can do yourself in the app. Ask your Super Admin or Admin if you think you should be able to. Nothing was changed.`,
    };
  }
  if (tool.roles) {
    let r;
    try { r = await tool.roles(user); } catch { r = false; }
    if (r !== true && !(r && r.ok === true)) {
      return { ok: false, code: 'role_rule', message: (r && r.message) || `Your role (${roleWords(user)}) cannot ${tool.label.toLowerCase()}. Nothing was changed.` };
    }
  }
  return { ok: true };
}

// Permission that depends on the details (a stage only some roles own).
async function checkParams(user, tool, params) {
  if (typeof tool.permission === 'function') {
    let g;
    try { g = await grantCheck(user, tool.permission, params); } catch { g = { ok: false }; }
    return g.ok ? { ok: true } : { ok: false, code: 'no_permission', message: g.message || `Your role cannot ${tool.label.toLowerCase()} like this. Nothing was changed.` };
  }
  return { ok: true };
}

module.exports = { checkTool, checkParams, roleWords, isSelfServiceOnly, PRODUCT_NAME };

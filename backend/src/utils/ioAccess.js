// ---------------------------------------------------------------------------
// WHO MAY IMPORT / EXPORT WHAT on the ATS screens (spec 2026-10-03 §B, "Who
// may import/export"):
//
//   Role               Import                       Export
//   Super Admin, Admin all (direct)                 all
//   Manager            their departments (direct)   their departments
//   Asst Manager, STL  no                           their teams / section
//   TL                 candidates (team)            team
//   Recruiter          candidates (own)             own data only — and NO
//                                                   Clients import / export
//                                                   (user decision 2026-10-03:
//                                                   a recruiter sees the client
//                                                   NAME and the requirement only)
//   BDE                client / job REQUESTS        own clients
//   Internal HR        internal candidates / jobs   internal
//   Client, Candidate  no                           own (their portals, not here)
//
// await ioAccessFor(user, module, kind?) -> { import, importMode: 'direct'|'request'|null,
//                                export, exportScope, sensitive, revenue }
//
// The Role Catalog work exports the authoritative ioAccessFor from
// utils/permissions.js; when it is there it is used, and this table is only
// the fallback. TODO(role-catalog): delete the local table once
// permissions.ioAccessFor ships everywhere.
//
// This decides WHETHER. WHICH ROWS is always the screen's own scoped query
// (utils/scope.js) — an export can never hold a row the screen would not
// show, and an import row outside the caller's scope is an error.
// The kind's own permission (can()) is still required for a direct import,
// so the Manager / Assistant Manager view-only rule in can() stands.
// ---------------------------------------------------------------------------
const { atsViewRole, scopeOf } = require('./scope');

// Screen "module" -> the import kinds it may offer.
const CANDIDATE_KINDS = ['candidates', 'applications', 'resumes', 'interviews', 'interview-feedback', 'offers', 'joining', 'followups'];

const ROLE_OF = (user) => {
  const s = scopeOf(user);
  const held = [s.role, s.atsRole].filter(Boolean);
  if (held.includes('SUPER_ADMIN')) return 'SUPER_ADMIN';
  if (held.includes('ADMIN')) return 'ADMIN';
  if (held.includes('MANAGER')) return 'MANAGER';
  if (held.includes('ASSISTANT_MANAGER')) return 'ASSISTANT_MANAGER';
  const v = atsViewRole(user);
  return {
    admin: 'ADMIN', mgmt: 'MANAGER', stl: 'STL', tl: 'TL', recruiter: 'RECRUITER', bde: 'BDE', hr: 'HR', accounts: 'ACCOUNTANT', client: 'CLIENT', candidate: 'CANDIDATE',
  }[v] || null;
};

const EXPORT_SCOPE = {
  SUPER_ADMIN: 'all', ADMIN: 'all', MANAGER: 'departments', ASSISTANT_MANAGER: 'teams', STL: 'section',
  TL: 'team', RECRUITER: 'own', BDE: 'own-clients', HR: 'internal', ACCOUNTANT: 'billing', CLIENT: 'own', CANDIDATE: 'own',
};

// Which import kinds a role may bring in, and how.
function importModeFor(role, kind) {
  if (['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(role)) return 'direct';
  if (role === 'BDE') return ['clients', 'requirements', 'agreements'].includes(kind) ? 'request' : null;
  if (role === 'TL' || role === 'RECRUITER') return CANDIDATE_KINDS.includes(kind) ? 'direct' : null;
  if (role === 'HR') return [...CANDIDATE_KINDS, 'requirements', 'internal-hiring'].includes(kind) ? 'direct' : null;
  return null;
}

// Which screens a role may export at all.
function mayExportModule(role, module) {
  if (!role) return false;
  if (['CLIENT', 'CANDIDATE'].includes(role)) return false; // their portals, not these screens
  if (role === 'RECRUITER' && ['clients', 'agreements'].includes(module)) return false;
  if (role === 'ACCOUNTANT') return ['requirements', 'joining', 'dashboard', 'reports'].includes(module);
  return true;
}

function localIoAccessFor(user, module, kind = null) {
  const role = ROLE_OF(user);
  const importMode = kind ? importModeFor(role, kind) : null;
  return {
    role,
    import: !!importMode,
    importMode,
    export: mayExportModule(role, module),
    exportScope: EXPORT_SCOPE[role] || 'own',
    // PAN / Aadhaar / bank details: HR, Admin, Super Admin only.
    sensitive: ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(role),
    // Revenue / fee columns: Admin and Super Admin only.
    revenue: ['SUPER_ADMIN', 'ADMIN'].includes(role),
  };
}

// The Role Catalog's module ids for the screens permissions.ioAccessFor knows
// (its IO_MODULES). Any other screen (offers, joining, follow-ups, the
// dashboard …) is answered by the table above alone.
const SHARED_MODULE = {
  requirements: 'requirements', clients: 'clients', agreements: 'clients', candidates: 'candidates',
  interviews: 'interviews', feedback: 'interviews', team: 'recruiterbde',
};
// Imports the Role Catalog defines (a Bulk Import feature). Bulk schedule
// (interviews) and bulk reassign (team) are the spec's imports it has no
// feature for — those stay with the table above + the kind's own permission.
const SHARED_IMPORT = ['requirements', 'clients', 'candidates'];

async function ioAccessFor(user, module, kind = null) {
  const local = localIoAccessFor(user, module, kind);
  const sharedId = SHARED_MODULE[module];
  let shared = null;
  if (sharedId) {
    try {
      // eslint-disable-next-line global-require
      const perms = require('./permissions');
      if (typeof perms.ioAccessFor === 'function') shared = await perms.ioAccessFor(user, sharedId, kind);
    } catch { shared = null; }
  }
  if (!shared || typeof shared !== 'object') return local;
  // The Role Catalog answer wins (configurable per role); a field it does not
  // give — and an import it has no feature for — falls back to the table.
  const out = { ...local, ...shared };
  // Which Role Catalog import a kind is: only these kinds have one.
  const IMPORT_OF_KIND = {
    requirements: 'requirements', clients: 'clients', agreements: 'clients', candidates: 'candidates', applications: 'candidates', resumes: 'candidates',
  };
  if (!kind || !SHARED_IMPORT.includes(IMPORT_OF_KIND[kind])) {
    out.import = local.import; out.importMode = local.importMode;
  }
  // A recruiter never imports or exports Clients, whatever else says so.
  if (local.role === 'RECRUITER' && ['clients', 'agreements'].includes(module)) {
    out.export = false; out.import = false; out.importMode = null;
  }
  if (kind && !out.importMode && out.import) out.importMode = local.importMode || 'direct';
  return out;
}

// Approvers of an import REQUEST: Super Admin, Admin, Manager.
function mayApproveImport(user) {
  return ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(ROLE_OF(user));
}

module.exports = { ioAccessFor, localIoAccessFor, mayApproveImport, roleOf: ROLE_OF, CANDIDATE_KINDS };

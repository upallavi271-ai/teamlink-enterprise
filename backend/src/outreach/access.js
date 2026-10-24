// ---------------------------------------------------------------------------
// OMNI-CHANNEL: WHO MAY DO WHAT (the server decides; the screens only hide buttons).
//   admin     Super Admin / Admin: everything (settings, templates, opt-in, erase, industries, every contact).
//   bde, bdetl, tl (TL and STL)   import contacts, make segments, opt people out: the contacts THEY own. Phone / email masked for bde and bdetl.
//   view      Manager, Assistant Manager: look at every contact (read only, no import, no changes).
//   recruiter look at the segments of their own department (or their own), contacts masked. Nothing else.
//   hr        HR desk / Internal HR (incl. the Internal HR TL): the Internal tab only (internal contacts, internal templates).
//   none      Accountant, Client, Candidate, Vendor, Partner.
// Internal contacts are visible to admin and hr ONLY; internal contacts are never targetable by job promotions (segments.js).
// ---------------------------------------------------------------------------
const scope = require('../utils/scope');

const external = (u) => [u.role, u.atsRole].some((r) => ['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].includes(r));
function kind(user) {
  if (!user || external(user)) return 'none';
  const v = scope.atsViewRole(user);
  if (v === 'admin') return 'admin';
  if (user.hrDesk || (user.internalHr && user.internalHr.member)) return 'hr';
  if (scope.isBdeTl(user)) return 'bdetl';
  if (v === 'bde') return 'bde';
  if (v === 'tl' || v === 'stl') return 'tl';
  if (v === 'mgmt') return 'view';
  if (v === 'recruiter') return 'recruiter';
  if (v === 'hr') return 'hr';
  if (marketingIds.has(user.id)) return 'marketing'; // v2: the Marketing capability (an Admin gives it to a person in Configuration > Permissions; default off)
  return 'none';
}
// the people an Admin gave the Marketing capability (AppSetting 'omni.permissions'); kept in memory, refreshed by warm() on each request
let marketingIds = new Set();
let warmAt = 0;
async function warm() {
  if (Date.now() - warmAt < 10000) return;
  warmAt = Date.now();
  try {
    const row = await require('../db').appSetting.findUnique({ where: { key: 'omni.permissions' } }); // eslint-disable-line global-require
    const v = row ? JSON.parse(row.value) : {};
    marketingIds = new Set(Array.isArray(v.marketingUserIds) ? v.marketingUserIds : []);
  } catch { /* keep the last list */ }
}
function setMarketingIds(ids) { marketingIds = new Set(ids || []); warmAt = Date.now(); }
// ONE table of who may do what (the functions below, the page's 'tabs' and the read-only Roles table in Settings are all made from it).
// Phase 3 campaigns are for the jobs in a login's own area (the campaign code checks the job); the HR desk may send internal campaigns only when an
// Admin ticked "Internal HR may send" (campaigns.js checks that setting); the message log download is only for the logins that see real addresses AND may export.
const KINDS = ['admin', 'bdetl', 'bde', 'tl', 'view', 'recruiter', 'hr', 'marketing'];
const KIND_WORDS = { admin: 'Admin / Super Admin', bdetl: 'BDE TL', bde: 'BDE', tl: 'Team Lead / Senior TL', view: 'Manager / Assistant Manager', recruiter: 'Recruiter', hr: 'HR desk / Internal HR (incl. Internal HR TL)', marketing: 'Marketing (given by an Admin)' };
const RULES = {
  mayRun: ['admin', 'bdetl', 'bde', 'tl'], // the people who bring in contacts and run promotions (candidate leads)
  mayRunInternal: ['admin', 'hr'], // who may bring in / change INTERNAL contacts
  seesInternal: ['admin', 'hr'],
  seesLeads: ['admin', 'bdetl', 'bde', 'tl', 'view', 'recruiter', 'marketing'],
  seesAllLeads: ['admin', 'view'],
  masked: ['bde', 'bdetl', 'recruiter', 'marketing'],
  mayOptIn: ['admin'],
  mayOptOut: ['admin', 'bdetl', 'bde', 'tl', 'hr'],
  mayCampaign: ['admin', 'bdetl', 'bde', 'tl'],
  seesCampaigns: ['admin', 'bdetl', 'bde', 'tl', 'view', 'recruiter', 'hr'],
  mayExportLog: ['admin', 'view'],
  canEditTemplates: ['admin', 'bdetl', 'bde', 'tl', 'marketing'],
  canEditInternalTemplates: ['admin', 'hr'],
  manageScheduled: ['admin', 'hr'], // Internal (HR) > Scheduled messages
  seesSettings: ['admin'], // Settings: Channels, Sender details, Sending rules, Consent log, Roles
  mayExportConsent: ['admin'],
  seesDistribution: ['admin', 'bdetl', 'bde', 'tl', 'view', 'recruiter'],
  // v3 (2026-10-17, WhiteStart base)
  mayLibraryUpload: ['admin', 'bdetl', 'bde', 'tl', 'hr', 'marketing'], // Library: save files and links (everybody who uses Omni-Channel may look at their department's)
  mayImportAts: ['admin', 'tl'], // Contacts > Import from ATS (a BDE never gets candidate phone / email / salary, so the BDE team cannot copy them)
  mayApprove: ['admin', 'tl', 'bdetl'], // Campaigns: approve or send back a campaign a BDE made
  mayForms: ['admin', 'bdetl', 'bde', 'tl'], // Contacts > Forms (public capture forms)
  mayCustomFields: ['admin'], // Contacts > Custom fields
};
const has = (id) => (u) => RULES[id].includes(kind(u));
const isAdmin = (u) => kind(u) === 'admin';
const mayUse = (u) => kind(u) !== 'none';
// GREEN START (the founder's own Omni-Channel product, green-start-app/): it has NO phone / email masking, so by default only the logins that
// already see real contact details may open it (Admin, Manager / AM, TL / STL, HR). BDE, BDE TL, Recruiter and Marketing keep the native
// Omni-Channel. GREENSTART_ALL_ROLES=1 (backend/.env) opens it for everybody who may use Omni-Channel (founder's decision).
const mayGreenStart = (u) => mayUse(u) && (/^(1|true|yes|on)$/i.test(String(process.env.GREENSTART_ALL_ROLES || '').trim()) || ['admin', 'tl', 'view', 'hr'].includes(kind(u)));
const mayRun = has('mayRun');
const mayRunInternal = has('mayRunInternal');
const seesInternal = has('seesInternal');
const seesLeads = has('seesLeads');
const seesAllLeads = has('seesAllLeads');
const masked = has('masked');
const mayOptIn = has('mayOptIn');
const mayOptOut = has('mayOptOut');
const mayAdminSettings = isAdmin;
const mayCampaign = has('mayCampaign');
const seesCampaigns = (u) => kind(u) !== 'none';
const mayExportLog = has('mayExportLog');
const manageScheduled = has('manageScheduled');
const seesSettings = has('seesSettings');
const mayExportConsent = has('mayExportConsent');
const seesDistribution = has('seesDistribution');
// may this login import / create things of this contact type?
function mayWrite(u, type) {
  return type === 'internal' ? mayRunInternal(u) : mayRun(u);
}
function mayRead(u, type) {
  return type === 'internal' ? seesInternal(u) : seesLeads(u);
}
// the departments of a login (for the recruiter's own segments)
function departmentsOf(u) {
  try { return (scope.atsScopeOf(u).departments || []).map((d) => String(d).toLowerCase()); } catch { return []; }
}
// the top-level modes this login sees: 'promo' = Job Promotions, 'internal' = Internal (HR), 'settings' = Settings (Admin only)
function modesFor(u) {
  const m = [];
  if (seesLeads(u)) m.push('promo');
  if (seesInternal(u)) m.push('internal');
  if (seesSettings(u)) m.push('settings');
  return m;
}
// the tabs this login sees (older screens still read this list)
function tabsFor(u) {
  const k = kind(u);
  if (k === 'none') return [];
  const t = [];
  if (seesLeads(u)) t.push('contacts', 'templates');
  if (seesInternal(u)) t.push('internal');
  if (k === 'admin') t.push('channels');
  return t;
}
function summary(u) {
  const k = kind(u);
  return {
    kind: k, tabs: tabsFor(u), modes: modesFor(u), canImport: mayRun(u), canImportInternal: mayRunInternal(u), masked: masked(u), isAdmin: k === 'admin',
    canOptIn: mayOptIn(u), canOptOut: mayOptOut(u), seesInternal: seesInternal(u), seesLeads: seesLeads(u),
    canCampaign: mayCampaign(u), seesCampaigns: seesCampaigns(u), canExportLog: mayExportLog(u), canEditTemplates: has('canEditTemplates')(u), canEditInternalTemplates: has('canEditInternalTemplates')(u),
    canManageScheduled: manageScheduled(u), seesSettings: seesSettings(u), canExportConsent: mayExportConsent(u), seesDistribution: seesDistribution(u),
  };
}
// the read-only "who can see what" table for Settings > Roles: built from RULES, so it can never disagree with what the server really does
const ROLE_ROWS = [
  ['seesLeads', 'Look at job-promotion contacts, audiences, templates and campaigns'],
  ['mayRun', 'Import contacts, add people, make audiences and send requirement campaigns'],
  ['seesAllLeads', 'See every contact (not only their own)'],
  ['masked', 'Phone numbers and emails hidden'],
  ['mayOptOut', 'Mark a person as opted out'],
  ['mayOptIn', 'Opt a person in again (with a reason)'],
  ['seesInternal', 'Internal (HR): staff contacts, groups, messages'],
  ['mayRunInternal', 'Internal (HR): import staff, write staff templates'],
  ['manageScheduled', 'Internal (HR): scheduled messages (birthday, reminders)'],
  ['mayExportLog', 'Download the message log'],
  ['seesDistribution', 'Distribution: where requirements are posted'],
  ['seesSettings', 'Settings (channels, sender details, sending rules, consent log)'],
  ['mayExportConsent', 'Download the consent log'],
  ['mayLibraryUpload', 'Library: save files and links for messages'],
  ['mayImportAts', 'Contacts: copy ATS candidates in (Import from ATS)'],
  ['mayApprove', 'Campaigns: approve or send back a campaign'],
  ['mayForms', 'Contacts: make capture forms'],
  ['mayCustomFields', 'Contacts: add custom fields'],
];
function rolesTable() {
  return {
    roles: KINDS.map((k) => ({ kind: k, words: KIND_WORDS[k] })),
    rows: ROLE_ROWS.map(([id, words]) => ({ id, words, allowed: Object.fromEntries(KINDS.map((k) => [k, RULES[id].includes(k)])) })),
    notes: [
      'Managers and Assistant Managers can look and download, but cannot change anything.',
      'The HR desk can only send staff messages after an Admin ticks "Internal HR may send" (Campaigns > Sending settings).',
      'A BDE, BDE TL or Team Lead sees only the contacts they brought in. A Recruiter sees only the audiences of their own department, with phone numbers and emails hidden.',
      'Roles themselves (who is a BDE, a Team Lead ...) are edited in the Role Catalog under Administration.',
    ],
  };
}

// ---- v2 (2026-10-17): ONE answer to "which departments are mine and what may I open" (GET /api/outreach/me, and every v2 route) ----------
// all = sees every department (Admin; Manager / Assistant Manager may LOOK at all); otherwise only `departments` (lower-case spellings).
function deptScope(u) {
  const k = kind(u);
  if (k === 'admin' || k === 'view') return { all: true, departments: [] };
  return { all: false, departments: k === 'none' ? [] : departmentsOf(u) };
}
// may this login see something that belongs to department `d` (free text; empty = no department = everybody who may use the module)?
function mayDepartment(u, d) {
  const sc = deptScope(u);
  if (sc.all) return true;
  const t = String(d || '').trim().toLowerCase();
  return !t || sc.departments.includes(t);
}
// credits: Admin sets the rules and sees everybody; a department lead (TL / STL / BDE TL) and Manager / AM see their department's people; everybody else only themselves
const seesTeamActivity = (u) => ['admin', 'tl', 'view', 'bdetl'].includes(kind(u));
const mayCreditSettings = isAdmin;
const mayExportActivity = seesTeamActivity;
// v2 levels (the founder's five roles + HR, Finance, Marketing): ONE word per login, used by the dashboard, the hubs and the analytics scope
const isFinance = (u) => { if (!u || external(u)) return false; if (kind(u) !== 'none') return false; return scope.atsViewRole(u) === 'accounts' || [u.accountsRole, u.role].includes('ACCOUNTANT'); };
function level(u) {
  const k = kind(u);
  if (k === 'admin') return 'admin';
  if (k === 'marketing') return 'marketing';
  if (k === 'none') return isFinance(u) ? 'finance' : 'none';
  if (k === 'hr') return 'hr';
  if (k === 'view') return 'depthead';
  if (k === 'tl') return scope.atsViewRole(u) === 'stl' ? 'depthead' : 'teamlead';
  if (k === 'bdetl') return 'teamlead';
  return k; // bde, recruiter
}
const LEVEL_WORDS = { admin: 'Super Admin / Admin', depthead: 'Department Head', teamlead: 'Team Lead', recruiter: 'Recruiter', bde: 'BDE', hr: 'HR (internal)', finance: 'Finance (Accounts)', marketing: 'Marketing', none: 'No access' };
// the five hubs and the sub-tabs of Insights each level sees (the server checks the same table on every route)
function hubsFor(u) { return hubsForLevel(level(u)); }
function hubsForLevel(l) {
  // v3 hubs (the sidebar children): dashboard, inbox, campaigns, templates, contacts, automation, insights, library, configuration.
  // `communication` is the old name of `inbox` (kept so older code and links still work). `myActivity` = Insights > My activity (every level except Finance).
  const all = { dashboard: true, inbox: true, communication: true, campaigns: true, templates: true, contacts: true, automation: true, insights: ['reports'], library: true, configuration: false, myActivity: true };
  if (l === 'admin') return { ...all, insights: ['performance', 'credits', 'roi', 'reports'], configuration: true };
  if (l === 'depthead' || l === 'teamlead') return { ...all, insights: ['performance', 'roi', 'reports'] };
  if (l === 'recruiter' || l === 'bde') return { ...all, insights: ['reports'] };
  if (l === 'hr') return { ...all, insights: ['reports'] };
  if (l === 'finance') return { dashboard: false, inbox: false, communication: false, campaigns: false, templates: false, contacts: false, automation: false, insights: ['credits'], library: false, configuration: false, myActivity: false };
  if (l === 'marketing') return { ...all, inbox: false, communication: false, insights: ['roi', 'reports'] };
  return { dashboard: false, inbox: false, communication: false, campaigns: false, templates: false, contacts: false, automation: false, insights: [], library: false, configuration: false, myActivity: false };
}
const mayExportReport = (u) => ['admin', 'view', 'tl', 'bdetl', 'marketing'].includes(kind(u));
const mayCreditsView = (u) => level(u) === 'admin' || level(u) === 'finance';
// v3 PAGES (the Green Start prototype sidebar, 2026-10-17): the page ids this login may open. Ids = the prototype's data-page values.
//   overview inbox console campaigns templates studio crm customers segments forms botdata automation botbuilder analytics billing
//   team superadmin settings  + the external-service shells: social fbchannel igchannel fbcatalogs shopify adsmanager googlecampaigns googleads ganalytics
// Finance sees Billing only. The external shells are for Admin, Department Head and Marketing (they need accounts / keys an Admin connects).
const mayExternalShells = (u) => ['admin', 'depthead', 'marketing'].includes(level(u));
const maySendConsole = (u) => ['admin', 'bde', 'bdetl', 'tl', 'marketing', 'hr'].includes(kind(u));
function pagesFor(u) {
  const l = level(u);
  if (l === 'none') return [];
  if (l === 'finance') return ['billing'];
  const h = hubsForLevel(l);
  const out = [];
  const add = (c, ...ids) => { if (c) ids.forEach((i) => out.push(i)); };
  add(h.dashboard, 'overview');
  add(h.inbox, 'inbox');
  add(h.inbox, 'review'); // Inbox & Replies > Needs review (replies that could not be matched with confidence)
  add(h.campaigns && maySendConsole(u), 'console');
  add(h.campaigns, 'campaigns', 'appcampaigns'); // appcampaigns = campaigns made from the ATS / Job Portal / HRMS / Accounts screens
  add(mayExternalShells(u), 'social');
  add(h.insights.length > 0 || h.myActivity, 'analytics');
  add(h.templates, 'tplshared', 'templates', 'studio'); // tplshared = the shared Template library tab
  add(h.contacts, 'crm', 'customers', 'segments', 'forms');
  add(h.automation, 'automation', 'botbuilder', 'botdata');
  add(mayExternalShells(u), 'fbchannel', 'igchannel', 'fbcatalogs', 'shopify', 'adsmanager', 'googlecampaigns', 'googleads', 'ganalytics');
  add(h.dashboard, 'connections'); // Channel Connections > Connection status + Sync health (reads only; no key is ever shown)
  add(true, 'billing');
  add(['admin', 'depthead', 'teamlead'].includes(l), 'team', 'audit');
  add(l === 'admin', 'superadmin', 'settings');
  return out;
}
function me(u) {
  const k = kind(u);
  const sc = deptScope(u);
  return {
    ...summary(u),
    kind: k,
    modeAccess: modesFor(u),
    allDepartments: sc.all,
    departments: sc.departments,
    canSettings: seesSettings(u),
    canCredits: mayCreditSettings(u),
    canTeamActivity: seesTeamActivity(u),
    canExportActivity: mayExportActivity(u),
    canInternal: seesInternal(u),
    canPromo: seesLeads(u),
    creditsExempt: k === 'admin',
    level: level(u), levelWords: LEVEL_WORDS[level(u)], hubs: hubsFor(u), pages: pagesFor(u), marketing: k === 'marketing' || marketingIds.has(u.id),
    greenStart: mayGreenStart(u), canExportReport: mayExportReport(u), canCreditsView: mayCreditsView(u),
    canLibraryUpload: has('mayLibraryUpload')(u), canImportAts: has('mayImportAts')(u), canApprove: has('mayApprove')(u), canForms: has('mayForms')(u), canCustomFields: has('mayCustomFields')(u),
  };
}

module.exports = { mayGreenStart, hubsForLevel, has, pagesFor, maySendConsole, warm, setMarketingIds, level, hubsFor, isFinance, mayExportReport, mayCreditsView, LEVEL_WORDS, deptScope, mayDepartment, seesTeamActivity, mayCreditSettings, mayExportActivity, me, kind, isAdmin, mayUse, mayRun, mayRunInternal, seesInternal, seesLeads, seesAllLeads, masked, mayOptIn, mayOptOut, mayAdminSettings, mayCampaign, seesCampaigns, mayExportLog, mayWrite, mayRead, departmentsOf, tabsFor, modesFor, summary, manageScheduled, seesSettings, mayExportConsent, seesDistribution, rolesTable, RULES, KINDS };

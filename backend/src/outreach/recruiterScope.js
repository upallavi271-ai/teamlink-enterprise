// ---------------------------------------------------------------------------
// OMNI-CHANNEL: A RECRUITER SEES THREE THINGS ONLY (founder 2026-11-14/16): Dashboard (Overview), Channels (Inbox & Replies, Channel Connections) and
// Campaign Center (Campaigns). No Templates, Promotions, Contacts & Audiences, Automation, Reports, Settings, Team, Billing, AI Marketing.
//   - pagesFor() in outreach/access.js uses RECRUITER_PAGES, so the sidebar and the address redirect (omniPages.js resolveRoute: a page the server
//     does not list falls back to the first allowed one, also when the address is typed) follow it.
//   - guard(area) is the SERVER side: mounted on /api/outreach, /api/omni and /api/omni-wa, it refuses every route a recruiter has no page for (403).
//     Needing a screen is not the same as being allowed to change what it shows: the campaign screen reads templates, audiences and contacts to pick a
//     target, so those are open for READING only. The routes' own checks (department, owner, masking) still apply on top.
// Only kind 'recruiter' (access.js kind()). Admin, TL, STL, managers, BDE, HR and the rest are untouched. OMNI_RECRUITER_SCOPE=0 switches it off.
// ---------------------------------------------------------------------------
const RECRUITER_PAGES = ['overview', 'inbox', 'review', 'whatsapp', 'connections', 'campaigns', 'appcampaigns', 'credituse'];

const enabled = () => !/^(0|false|no|off)$/i.test(String(process.env.OMNI_RECRUITER_SCOPE || '').trim());
const GET = ['GET', 'HEAD'];
const ANY = null; // any method (the route's own role check still decides)
// per area: [methods | ANY, regex on the path under the mount point]
const ALLOW = {
  outreach: [
    [GET, /^\/(me|access|overview|dashboard|channels|sending|connections|distribution|badges|wallet|workspaces)$/],
    [GET, /^\/insights\/credit-use(\.csv)?$/], [GET, /^\/hub\/templates$/], [GET, /^\/gs\/studio\/content\/[^/]+$/],
    [GET, /^\/campaigns(\/.*)?$/], [GET, /^\/messages(\/campaigns)?$/],
    [GET, /^\/(segments|contacts|templates|industries)(\/[^/]+(\/preview|\/timeline)?)?$/],
    [['POST'], /^\/(campaigns|campaigns\/plan|campaigns\/check|campaigns\/test-send|segments\/preview|templates\/preview)$/],
    [['POST'], /^\/campaigns\/[^/]+\/send$/], [['DELETE'], /^\/campaigns\/[^/]+$/],
    [ANY, /^\/gs\/(overview|campaigns|inbox)(\/|$)/],
  ],
  omni: [
    [GET, /^\/(me|connections|sync-health)$/], [GET, /^\/library\/templates(\/[^/]+(\/versions)?)?$/], [['POST'], /^\/library\/check$/],
    [ANY, /^\/(app-campaigns|replies|sources)(\/|$)/],
  ],
  omniwa: [
    [GET, /^\/(promo-jobs|promotions|stream|connection)$/], [ANY, /^\/conversations(\/|$)/], [['POST'], /^\/already-contacted$/],
  ],
};
// the path under the mount point, query cut off, trailing slash cut off
const subPath = (req) => String(req.path || '/').replace(/\/+$/, '') || '/';

/** May a recruiter make this request? (pure; the tests call it) */
function mayCall(area, method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '/').replace(/\/+$/, '') || '/';
  return (ALLOW[area] || []).some(([methods, re]) => (!methods || methods.includes(m)) && re.test(p));
}

const isRecruiter = (user) => { try { return enabled() && require('./access').kind(user) === 'recruiter'; } catch { return false; } }; // eslint-disable-line global-require

function guard(area) {
  return (req, res, next) => {
    if (!isRecruiter(req.user)) return next();
    if (mayCall(area, req.method, subPath(req))) return next();
    return res.status(403).json({ error: 'Your role opens Dashboard, Channels and Campaign Center in Omni-Channel.', code: 'ROLE_SCOPE' });
  };
}

module.exports = { RECRUITER_PAGES, guard, mayCall, enabled, isRecruiter };

// ---------------------------------------------------------------------------
// TEAMLINK WHATSAPP NUMBERS INSIDE OMNI-CHANNEL SETTINGS (founder 2026-11-02: "setting loo ekkada whastapp numbers anii
// kanipinchaliii eekkadey assign cheesey laga undaliii departments kiii ... mesage send chestuntey errors m kanipinchodhuu").
//
// Omni-Channel (Green Start) Settings > Communication Providers > WhatsApp shows a card "TeamLink WhatsApp numbers": every number,
// its ONE department, the Omni-Channel workspace it sits in and, in plain words, what is wrong with it. An Admin / Super Admin
// changes the department right there. The card's page runs on Green Start's own address, so it calls these two routes
// straight from the browser:
//   GET /api/omni-gs/teamlink-numbers                    the numbers, the departments to pick from
//   PUT /api/omni-gs/teamlink-numbers/:id/department     { department }  ->  waNumbers.setAccess (departments only: people and
//                                                        roles given the number stay) -> omniDeptLogins moves the number to
//                                                        that department's workspace a few seconds later, as on TeamLink's screen
// WHO: the browser's Omni-Channel pass (cookie tl_gs, utils/greenStartEmbed.js — HttpOnly, signed, SameSite=Lax) names the
// TeamLink user; only an active Admin / Super Admin gets an answer (403 otherwise, and Green Start then shows no card).
// The PUT also needs the X-TeamLink-Omni header (no plain form can send it, so another site cannot make the browser change
// a number). Mounted ahead of the site-wide CORS (index.js): it answers its own CORS for the Green Start address only —
// localhost / LAN on the PC, a *.<GREENSTART_COOKIE_DOMAIN> address (greenstart.teamlinks.in) on the live site, or
// GREENSTART_PUBLIC_URL. No token or secret is ever returned.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const GE = require('../utils/greenStartEmbed');
const WN = require('../utils/waNumbers');
const T = require('../utils/messageTemplates');
const { resolveIdentity } = require('../utils/identity');

const BASE = '/api/omni-gs/teamlink-numbers';
const router = express.Router();

const strip = (o) => String(o || '').trim().replace(/\/+$/, '');
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i;
function greenStartOrigin(origin) {
  const o = strip(origin);
  if (!o) return false;
  if (strip(process.env.GREENSTART_PUBLIC_URL) && o === strip(process.env.GREENSTART_PUBLIC_URL)) return true;
  if (process.env.NODE_ENV !== 'production' && LOCAL.test(o)) return true;
  const dom = GE.cookieDomain().replace(/^\./, '').toLowerCase();
  try {
    const u = new URL(o);
    return !!dom && u.protocol === 'https:' && (u.hostname.toLowerCase() === dom || u.hostname.toLowerCase().endsWith(`.${dom}`));
  } catch { return false; }
}

router.use(BASE, (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    if (!greenStartOrigin(origin)) return res.status(403).json({ error: 'Not from Omni-Channel.' });
    res.setHeader('Access-Control-Allow-Origin', strip(origin));
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TeamLink-Omni');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }
  return next();
});

// The Admin behind the Omni-Channel pass, or a refusal.
async function adminOf(req, res) {
  const userId = GE.userOfToken(GE.readCookie(req, GE.COOKIE));
  if (!userId) { res.status(401).json({ error: 'Open Omni-Channel from TeamLink first.' }); return null; }
  const u = await resolveIdentity(userId).catch(() => null);
  if (!u || u.status !== 'Active' || !T.isAdmin(u)) { res.status(403).json({ error: 'Only an Admin or Super Admin can give WhatsApp numbers to departments.' }); return null; }
  return u;
}
const getSetting = async (key, dflt) => {
  try { const row = await prisma.appSetting.findUnique({ where: { key } }); return row ? JSON.parse(row.value) : dflt; } catch { return dflt; }
};

// Plain words for what stops a number from sending (null = nothing).
function problemOf(n, deptRun) {
  if (n.active === false) return 'Switched off in TeamLink. Nothing is sent from it.';
  if (n.status && ['disconnected', 'verification_required'].includes(n.status.code)) {
    return `${n.status.label}: ${n.status.text || 'check its token in TeamLink (Administration > Integrations > WhatsApp).'}`;
  }
  if (n.departments.length > 1) return `Given to ${n.departments.length} departments. Pick ONE, and it gets that department's Omni-Channel workspace.`;
  if (!n.departments.length && !n.isDefault) return 'No department yet. Pick one, and only that department uses this number.';
  if (deptRun && deptRun.state === 'failed') return deptRun.words;
  return null;
}

router.get(BASE, async (req, res, next) => {
  try {
    if (!(await adminOf(req, res))) return undefined;
    const list = await WN.adminList();
    const map = await getSetting('omni.gs.waMap', {});
    const last = await getSetting('omni.gs.deptLogins', {});
    const sync = await getSetting('omni.gs.integrationSync', {});
    // omniDeptLogins' last run: { last: { at, rows: [{ dept, number: 'A, B', workspace: 'W1, W2', workspaceIds, state, words }] } }
    const rows = Array.isArray(last && last.last && last.last.rows) ? last.last.rows : [];
    const runOf = (label) => rows.find((d) => String(d.number || '').split(', ').includes(label)) || null;
    const wsName = (id) => {
      for (const d of rows) {
        const i = Array.isArray(d.workspaceIds) ? d.workspaceIds.indexOf(id) : -1;
        if (i >= 0) return String(d.workspace || '').split(', ')[i] || null;
      }
      const w = ((sync && sync.last && sync.last.workspaces) || []).find((x) => x.id === id);
      return w ? w.name : null;
    };
    const numbers = list.numbers.map((n) => {
      const run = runOf(n.label);
      const m = map[n.id];
      return {
        id: n.id, label: n.label, displayNumber: n.displayNumber || '', isDefault: !!n.isDefault, active: n.active !== false,
        departments: n.departments || [], department: (n.departments || []).length === 1 ? n.departments[0] : null,
        everyone: !!n.everyone,
        status: n.status ? { code: n.status.code, label: n.status.label, tone: n.status.tone } : null,
        metaName: (n.status && n.status.verifiedName) || '', // the name Meta shows for the number (founder 2026-11-17)
        workspace: m && m.workspaceId ? wsName(m.workspaceId) : null,
        problem: problemOf({ ...n, departments: n.departments || [] }, run),
      };
    });
    return res.json({ numbers, departments: list.departments, checkedAt: (last && last.last && last.last.at) || null });
  } catch (e) { return next(e); }
});

router.put(`${BASE}/:id/department`, express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    if (String(req.headers['x-teamlink-omni'] || '') !== '1') return res.status(400).json({ error: 'Send this from the Omni-Channel settings page.' });
    const user = await adminOf(req, res);
    if (!user) return undefined;
    const dept = String((req.body || {}).department || '').trim().slice(0, 60);
    let id = String(req.params.id);
    if (id === 'legacy') { // the old single connection is not a row yet: move it into the list first (nothing is copied)
      const moved = await WN.importMain(user);
      if (moved.error) return res.status(moved.status || 400).json({ error: moved.error });
      id = moved.row.id;
    }
    const row = await WN.getRowFresh(id);
    if (!row) return res.status(404).json({ error: WN.WORDS.NOT_FOUND });
    const have = await WN.accessOf(id).catch(() => []);
    const out = await WN.setAccess(user, id, {
      departments: dept ? [dept] : [],
      userIds: have.filter((a) => a.kind === 'USER').map((a) => a.refId),
      roles: have.filter((a) => a.kind === 'ROLE' && a.refId !== '*').map((a) => a.refId),
      everyone: have.some((a) => a.kind === 'ROLE' && a.refId === '*'),
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    require('../utils/omniDeptLogins').schedule('department set in Omni-Channel settings'); // eslint-disable-line global-require
    return res.json({
      ok: true,
      message: dept
        ? `${row.label} is now ${dept}'s number. In about a minute it moves to ${dept}'s Omni-Channel workspace.`
        : `${row.label} has no department now.`,
    });
  } catch (e) { return next(e); }
});

module.exports = router;

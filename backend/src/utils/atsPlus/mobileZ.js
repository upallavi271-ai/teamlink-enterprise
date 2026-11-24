// ---------------------------------------------------------------------------
// THE ATS ON THE PHONE (market benchmark 15.13, ATS wave 2 Z 2026-11-25). TeamLink installs from the browser as an app today
// (frontend/public/tl-app.webmanifest, tl-app-sw.js, docs/mobile-app.md); the manifest now has shortcuts to the ATS screens
// (ATS follow-ups, Candidates & Pipeline, Interview Calendar, Clients & Requirements) beside the CRM ones.
// A STORE app (Google Play / Apple App Store) is the same site wrapped (a Trusted Web Activity on Android, a web view on iOS) and needs:
//   - the founder's Google Play developer account and the app's signing key  -> /.well-known/assetlinks.json proves the site and the app
//   - the founder's Apple developer account (Team ID) and a bundle ID          -> /.well-known/apple-app-site-association
// This keeps those details (Admin, ATS settings > Organisation > Phone app) and serves the two files from them, so the store build only
// needs the accounts. Nothing here is secret: both files are public by design.
//   GET  /api/ats-plus/mobilez            the status (installable now, ATS shortcuts, store readiness) + the saved details
//   PUT  /api/ats-plus/mobilez            { androidPackage, androidSha256: [..], iosTeamId, iosBundleId } (Admin)
//   GET  /.well-known/assetlinks.json     GET /.well-known/apple-app-site-association     (public; 404 until filled)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const express = require('express');
const { logAudit } = require('../audit');
const S = require('./store');

const KEY = 'mobileAppZ';
const PKG = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
async function settings() { return S.settings.get(KEY, { androidPackage: '', androidSha256: [], iosTeamId: '', iosBundleId: '' }); }
function manifest() {
  const p = path.resolve(__dirname, '..', '..', '..', '..', 'frontend', 'public', 'tl-app.webmanifest');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
const ATS_PATHS = ['/ats/followups', '/candidates', '/ats/calendar', '/requirements'];

const router = express.Router();
router.get('/mobilez', S.internal, S.wrap(async (req, res) => {
  const s = await settings(); const m = manifest();
  const shortcuts = ((m && m.shortcuts) || []).map((x) => ({ name: x.name, url: x.url, ats: ATS_PATHS.some((p) => String(x.url).startsWith(p)) }));
  res.json({
    installable: !!m, shortcuts, atsShortcuts: shortcuts.filter((x) => x.ats).length,
    android: { ready: !!(s.androidPackage && s.androidSha256.length), package: s.androidPackage || null, fingerprints: s.androidSha256.length, file: '/.well-known/assetlinks.json', needs: 'The founder\'s Google Play developer account and the app\'s signing key (SHA-256 fingerprint).' },
    ios: { ready: !!(s.iosTeamId && s.iosBundleId), teamId: s.iosTeamId || null, bundleId: s.iosBundleId || null, file: '/.well-known/apple-app-site-association', needs: 'The founder\'s Apple developer account (Team ID) and the app\'s bundle ID.' },
    saved: S.isAdmin(req.user) ? s : undefined, canEdit: S.isAdmin(req.user) && !req.viewAs,
  });
}));
router.put('/mobilez', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {};
  const pkg = String(b.androidPackage || '').trim();
  if (pkg && !PKG.test(pkg)) return res.status(400).json({ error: 'The Android package looks like in.teamlink.app (small letters, dots).' });
  const fps = (Array.isArray(b.androidSha256) ? b.androidSha256 : String(b.androidSha256 || '').split(/[\s,]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  const bad = fps.find((x) => !FP.test(x));
  if (bad) return res.status(400).json({ error: `Not a SHA-256 fingerprint: ${bad.slice(0, 20)}… (32 pairs like AB:CD:…, from Play Console > App integrity).` });
  const team = String(b.iosTeamId || '').trim().toUpperCase();
  if (team && !/^[A-Z0-9]{10}$/.test(team)) return res.status(400).json({ error: 'The Apple Team ID is 10 letters / digits.' });
  const bundle = String(b.iosBundleId || '').trim();
  if (bundle && !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundle)) return res.status(400).json({ error: 'The bundle ID looks like in.teamlink.app.' });
  const next = { androidPackage: pkg, androidSha256: [...new Set(fps)].slice(0, 5), iosTeamId: team, iosBundleId: bundle };
  await S.settings.set(KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: 'Phone app store details saved', entity: 'AtsPlusSetting', entityId: KEY, toValue: `${pkg || '-'} · ${next.androidSha256.length} fingerprint(s) · ${bundle || '-'}` });
  res.json(next);
}));

// the two public files (index.js mounts this router at the site root)
const wellKnown = express.Router();
wellKnown.get('/.well-known/assetlinks.json', S.wrap(async (req, res) => {
  const s = await settings();
  if (!s.androidPackage || !s.androidSha256.length) return res.status(404).json([]);
  res.set('Cache-Control', 'public, max-age=3600');
  return res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: s.androidPackage, sha256_cert_fingerprints: s.androidSha256 } }]);
}));
wellKnown.get('/.well-known/apple-app-site-association', S.wrap(async (req, res) => {
  const s = await settings();
  if (!s.iosTeamId || !s.iosBundleId) return res.status(404).json({});
  res.set('Cache-Control', 'public, max-age=3600');
  return res.type('application/json').send(JSON.stringify({ applinks: { apps: [], details: [{ appIDs: [`${s.iosTeamId}.${s.iosBundleId}`], components: [{ '/': '/*' }] }] }, webcredentials: { apps: [`${s.iosTeamId}.${s.iosBundleId}`] } }));
}));

module.exports = { router, wellKnown, settings };

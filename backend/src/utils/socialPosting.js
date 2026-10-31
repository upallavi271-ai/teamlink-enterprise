// ---------------------------------------------------------------------------
// SOCIAL ACCOUNTS -> JOB POSTING (2026-10-31). "Post job" can go to Instagram, Threads and LinkedIn the same way it goes to Facebook:
// the DEFAULT account of each platform in Administration > Integrations > Social Media is copied to the job-posting connection of that
// place (jobPublish/credentials.js, portal instagram / threads / linkedinpost) and checked with the platform (read-only: nothing is posted).
// Facebook has its own path (routes/admin.js applySocial), so it is not touched here.
//
//   mirror(user)   run after every change of the account list. A changed default replaces the saved connection and is re-checked; a platform
//                  with no default loses its saved connection. The posting switch ("an Admin switches it on") is NEVER turned on here.
// ---------------------------------------------------------------------------
const SA = require('./socialAccounts');
const Cred = require('../jobPublish/credentials');
const { decryptSecret } = require('./secrets');

const PAIRS = [['instagram', 'instagram'], ['threads', 'threads'], ['linkedin', 'linkedinpost']];

async function mirror(user) {
  const all = await SA.readAll();
  const out = [];
  for (const [platform, portal] of PAIRS) {
    const def = all.find((a) => a.platform === platform && a.isDefault) || null;
    const token = def && def.tokenEnc ? decryptSecret(def.tokenEnc) : null;
    // eslint-disable-next-line no-await-in-loop
    const cur = await Cred.read(portal);
    if (!def || !token) {
      if (cur.ok) { await Cred.remove(portal, user); out.push({ portal, change: 'removed' }); } // eslint-disable-line no-await-in-loop
      continue; // eslint-disable-line no-continue
    }
    if (cur.ok && cur.username === def.externalId && cur.password === token) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const saved = await Cred.save(portal, { username: def.externalId, password: token }, user);
    if (saved.error) { out.push({ portal, change: 'refused', words: saved.error }); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const checked = await Cred.requestVerify(portal, user).catch(() => null);
    out.push({ portal, change: 'saved', ok: !!(checked && checked.result && checked.result.ok), words: checked && checked.result ? checked.result.summary : null });
  }
  return out;
}

module.exports = { mirror, PAIRS };

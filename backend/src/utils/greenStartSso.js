// ---------------------------------------------------------------------------
// The company Green Start (Omni-Channel) account and its one-click sign-in ticket (moved here from routes/greenStartEmbed.js on
// 2026-10-30 so utils/greenStartIntegrations.js can sign in server-to-server with the same ticket; the route behaves as before).
// Green Start's own one-click sign-in from TeamLink (green-start-app/docs/integrations/TEAMLINK_SSO.md): a signed, single-use,
// 60-second ticket. Needs GREENSTART_SSO_SECRET here (the same value as Green Start's TEAMLINK_SSO_SECRET).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const SSO_EMAIL_KEY = 'omni.gs.ssoEmail';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const secretSet = () => String(process.env.GREENSTART_SSO_SECRET || '').length >= 32;

async function ssoEmail() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SSO_EMAIL_KEY } });
    const v = row ? String(JSON.parse(row.value) || '').trim() : '';
    if (v) return v;
  } catch { /* fall back to the env */ }
  return String(process.env.GREENSTART_SSO_EMAIL || '').trim();
}
function greenStartTicket({ email, name, externalUserId }) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ iss: 'teamlink', aud: 'greenstart', email, name, ...(externalUserId ? { externalUserId: String(externalUserId) } : {}), iat: now, exp: now + 60, jti: crypto.randomUUID() });
  const signature = crypto.createHmac('sha256', process.env.GREENSTART_SSO_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

module.exports = { SSO_EMAIL_KEY, EMAIL_RE, secretSet, ssoEmail, greenStartTicket };

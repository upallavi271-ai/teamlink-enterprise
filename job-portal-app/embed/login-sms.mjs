/*
 * THE CANDIDATE LOGIN SMS WITH A PASSWORD SETUP LINK (2026-11-20).
 *
 * The portal makes a candidate's account and sends the login by email / SMS / WhatsApp (api/src/notify/invite.js). Its SMS carried a temporary
 * password. For the approved DLT template "TeamLink Job Portal login credentials" the SMS carries two things instead: the candidate's LOGIN ID
 * and their own PASSWORD SETUP LINK (the portal's own /reset-password?token=..., valid for days, single use). No password is sent by SMS then.
 *
 * Every SMS that carries a NEW login passes through the TeamLink wrapper (teamlink-integration.mjs installLoginText). Here that message is
 * handed to TeamLink (POST {TEAMLINK_API_URL}/api/public/job-portal/login-sms, the bridge secret), which sends the approved template through
 * the existing SMS Push integration (backend/src/utils/loginSms.js): once per number and login ID per 24 hours, delivery report kept.
 *
 * If TeamLink says "off" (the template id or its approved text is not saved yet) or cannot be reached, nothing changes: the SMS goes as before
 * (login + temporary password). The setup link is only made when TeamLink is ready for it, so no unused tokens pile up.
 * The portal's code is not changed. Nothing here ever throws; the link is only passed on, never logged.
 */
const log = (...a) => console.log(new Date().toISOString(), '[teamlink]', ...a); // eslint-disable-line no-console
const DAYS = Math.max(1, Math.min(14, Number(process.env.LOGIN_SETUP_LINK_DAYS || 7)));

const digits10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const isPhoneLogin = (v) => /^\d{10}$/.test(String(v || ''));

/** Does this outgoing SMS carry a NEW login (a temporary password) to a number? */
export function isLoginSms(args) {
  const v = args && args.vars;
  return !!(v && !Array.isArray(v) && typeof v === 'object' && v.temporary_password && v.login_email && args.to);
}

/**
 * The candidate's own setup link: a password-reset token for THEIR account, valid DAYS days, spent by choosing a password.
 * deps: { withUser, newSessionToken, origin }. -> https url, or null when the account cannot be found.
 */
export async function makeSetupLink(loginEmail, deps) {
  const account = isPhoneLogin(loginEmail) ? `${loginEmail}@phone.invalid` : String(loginEmail || '').trim();
  if (!account) return null;
  const { token, hash } = deps.newSessionToken();
  const expires = new Date(Date.now() + DAYS * 86400000);
  const row = await deps.withUser(null, async (c) => (await c.query('select * from auth_password_reset_start($1,$2,$3,$4)', [account, hash, expires, null])).rows[0]);
  if (!row) return null;
  const base = String(deps.origin || '').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Sends the login SMS through TeamLink. -> { handled: true, result } when TeamLink accepted it (or had already sent it), else { handled: false }.
 * deps: { api, secret, makeLink(loginEmail), fetchImpl?, timeoutMs? }
 */
export async function sendLoginSetupSms(args, deps) {
  if (!isLoginSms(args) || !deps || !deps.api || !deps.secret) return { handled: false };
  const v = args.vars;
  let url = null;
  try { url = await deps.makeLink(v.login_email); } catch (err) { log('login sms: no setup link made:', String((err && err.message) || err).slice(0, 120)); return { handled: false }; }
  if (!url) return { handled: false };
  let ans = null;
  try {
    const res = await (deps.fetchImpl || fetch)(`${String(deps.api).replace(/\/+$/, '')}/api/public/job-portal/login-sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-job-portal-secret': deps.secret },
      body: JSON.stringify({ to: String(args.to), loginId: String(v.login_email), url }),
      signal: AbortSignal.timeout(deps.timeoutMs || 25000),
    });
    ans = await res.json().catch(() => null);
  } catch { ans = null; }
  if (!ans) { log('login sms: TeamLink could not be reached (the usual SMS goes)'); return { handled: false }; }
  if (ans.status === 'sent' || ans.status === 'duplicate') {
    log(`login sms: ${ans.status}`);
    return { handled: true, result: { status: 'sent', provider: 'teamlink-dlt-login', ref: ans.providerRef || null } };
  }
  log(`login sms: ${ans.status}${ans.reason ? ` (${String(ans.reason).slice(0, 140)})` : ''}; the usual SMS goes`);
  return { handled: false };
}

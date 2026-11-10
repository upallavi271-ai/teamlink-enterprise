/*
 * THE CANDIDATE LOGIN ALSO GOES BY RCS (founder 2026-11-10: "candidate account create ayina ventane RCS lo login credentials vellali").
 *
 * The portal makes the account and its temporary password itself (api/src/notify/invite.js: invitation, "resend credentials", the
 * Naukri / Shine intake, Forgot password for somebody with no login yet) and sends the login by email, SMS and WhatsApp. Every SMS
 * that carries a NEW password passes through the TeamLink wrapper (teamlink-integration.mjs installLoginText). Right after that SMS,
 * this hands the same login to TeamLink (POST {TEAMLINK_API_URL}/api/public/job-portal/rcs-login, the bridge secret), which sends it
 * with the APPROVED RCS login template through rcssms.in (backend/src/utils/rcsCandidateLogin.js): once per account event, Sent /
 * Delivered / Failed kept, the password never stored in plain text.
 *
 * ONE RULE FOR THE PORTAL: a "resend credentials" writes the new password only when a message really left. When the SMS failed but
 * the RCS was accepted by rcssms.in, the SMS channel answers { status: 'sent', provider: 'teamlink-rcs' } - so the password the
 * candidate got by RCS is the one that works. Otherwise the SMS answer is passed on unchanged.
 *
 * The portal's code is not changed. The password is only passed on, never logged or kept here. Nothing here ever throws.
 */
const log = (...a) => console.log(new Date().toISOString(), '[teamlink]', ...a); // eslint-disable-line no-console

/** Does this outgoing message carry a NEW login (a temporary password) to a number? */
export function isLoginMessage(args) {
  const v = args && args.vars;
  return !!(v && !Array.isArray(v) && typeof v === 'object' && v.temporary_password && v.login_email && args.to);
}

/** Hands the login to TeamLink's RCS sender. -> TeamLink's answer, or null when TeamLink could not be reached. */
export async function sendRcsLogin(args, { api, secret, fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  if (!isLoginMessage(args) || !api || !secret) return null;
  const v = args.vars;
  try {
    const res = await fetchImpl(`${String(api).replace(/\/+$/, '')}/api/public/job-portal/rcs-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-job-portal-secret': secret },
      body: JSON.stringify({
        to: String(args.to),
        vars: { candidate_name: v.candidate_name || v.to_name || '', login_email: v.login_email, temporary_password: v.temporary_password, portal_link: v.portal_link || '' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/** After the SMS: the RCS login, and the answer the portal should see. */
export async function withRcsLogin(args, smsResult, opts = {}) {
  if (!isLoginMessage(args)) return smsResult;
  const ans = await sendRcsLogin(args, opts);
  if (!ans) log('rcs login: TeamLink could not be reached (the SMS answer stands)');
  else if (ans.status !== 'off') log(`rcs login: ${ans.status}${ans.reason ? ` (${String(ans.reason).slice(0, 160)})` : ''}`);
  if (ans && ans.ok && ans.status === 'sent' && !(smsResult && smsResult.status === 'sent')) {
    return { status: 'sent', provider: 'teamlink-rcs', ref: ans.msgId || null };
  }
  return smsResult;
}

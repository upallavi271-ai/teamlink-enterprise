// ---------------------------------------------------------------------------
// AD LEADS INTO THE TEAM CRM (founder 2026-11-04: "leads go into the team CRM only").
//
// People who fill a Meta or Google ad form land in Omni-Channel (Green Start) > Lead Management. Here TeamLink takes each new lead from the feed there
// (GET /ads/leads/feed, gs-api/src/modules/ads/leads) into its own CRM, Omni-Channel > All Customers, as a candidate_lead contact, and tells Green Start it has it
// (POST /ads/leads/feed/ack), so a lead is taken once. Only the CRM: nothing goes to the ATS or to client enquiries, and nobody is messaged.
//
//   same person     a phone or email already in the CRM: no copy is made, the lead is only acknowledged (Lead Management shows the repeat)
//   department      "Teamlink Medical" -> Medical, from the workspace the lead came to
//   consent         not declared: an ad form is not a consent to marketing here; the CRM's own consent rules decide who may be messaged
//   when            every 5 minutes, through the same one-click sign-in as the other Green Start syncs (utils/greenStartSso.js)
// Off when Green Start is switched off (GREENSTART_ENABLED=false) or one-click sign-in is not set up; a failure is only words in status(), never a stop.
// ---------------------------------------------------------------------------
const SSO = require('./greenStartSso');

const apiBase = () => `http://127.0.0.1:${parseInt(process.env.GREENSTART_API_PORT, 10) || 4020}/api/v1`;
const enabled = () => String(process.env.GREENSTART_ENABLED || 'true').toLowerCase() !== 'false';
const BATCH = 100;

let last = { at: null, ok: null, words: 'not run yet', added: 0 };
let running = false;

async function call(method, path, { token, ws, body } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ws ? { 'x-workspace-id': ws } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch { const e = new Error('Omni-Channel (Green Start) is not running on this server.'); e.down = true; throw e; }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok || (data && data.success === false)) {
    const e = new Error(String((data && (data.message || (data.error && data.error.message))) || `HTTP ${res.status}`).slice(0, 200)); e.status = res.status; throw e;
  }
  return data && typeof data === 'object' && 'success' in data && 'data' in data ? data.data : data;
}

async function signIn() {
  if (!SSO.secretSet()) throw new Error('One-click sign-in to Omni-Channel is not set up on this server.');
  const email = await SSO.ssoEmail();
  if (!SSO.EMAIL_RE.test(email)) throw new Error('The company Omni-Channel account is not picked yet.');
  const out = await call('POST', '/auth/teamlink', { body: { ticket: SSO.greenStartTicket({ email, name: 'TeamLink', externalUserId: 'teamlink-ad-leads' }) } });
  if (!out || !out.accessToken) throw new Error('Omni-Channel asked for a second sign-in step for the company account.');
  return out.accessToken;
}

// the department a workspace stands for: "Teamlink Medical", "Nonit Consultants · Medical dept", "... - 2" -> Medical (utils/omniWsNames.js); other names -> none
const departmentOf = (workspaceName) => require('./omniWsNames').deptOfName(workspaceName); // eslint-disable-line global-require

// one lead -> what the CRM stores; null when it has neither a usable phone nor email
function contactOf(lead, workspaceName, K) {
  const phone = K.phoneOf(lead.phone); const email = K.emailOf(lead.email);
  if (!phone.ok && !email.ok) return null;
  const answers = (Array.isArray(lead.answers) ? lead.answers : []).map((a) => `${a.label}: ${a.value}`);
  const city = (Array.isArray(lead.answers) ? lead.answers : []).find((a) => /^city$/i.test(String(a.label)));
  return {
    type: 'candidate_lead', name: lead.name, phone: phone.ok ? phone : null, email: email.ok ? email : null, city: city ? city.value : undefined,
    source: `${lead.source}${lead.campaignName ? `: ${lead.campaignName}` : ''}`, department: departmentOf(workspaceName),
    notes: [lead.formName ? `Form: ${lead.formName}.` : '', ...answers].filter(Boolean).join(' ') || undefined, industries: [],
  };
}

// the feed of one workspace: store what is new, acknowledge what the CRM now has (a repeat counts as had). A person the CRM cannot store stays out of the ack only
// when the database refused them, so they are tried again.
async function takeWorkspace({ token, ws, name }, K, api = call) {
  let added = 0; let repeats = 0; let unusable = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const leads = await api('GET', `/ads/leads/feed?limit=${BATCH}`, { token, ws });
    if (!Array.isArray(leads) || !leads.length) break;
    const done = [];
    for (const lead of leads) { // eslint-disable-line no-restricted-syntax
      const data = contactOf(lead, name, K);
      if (!data) { unusable++; done.push(lead.id); continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const dups = await K.findByKeys(data.phone ? data.phone.key : null, data.email ? data.email.key : null);
      if (dups.length) { repeats++; done.push(lead.id); continue; } // eslint-disable-line no-continue
      try {
        await K.insert(null, data, { declared: false }); // eslint-disable-line no-await-in-loop
        added++; done.push(lead.id);
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) { repeats++; done.push(lead.id); } // two leads of one batch: the first won
      }
    }
    if (!done.length) break; // nothing could be stored: the next run tries again
    await api('POST', '/ads/leads/feed/ack', { token, ws, body: { ids: done } }); // eslint-disable-line no-await-in-loop
    if (leads.length < BATCH) break;
  }
  return { added, repeats, unusable };
}

async function sync() {
  if (running) return { skipped: 'already running' };
  if (require('./sandbox').isSandbox()) return { skipped: 'sandbox' }; // eslint-disable-line global-require
  if (!enabled()) return { skipped: 'Green Start is switched off on this server' };
  running = true;
  try {
    const S = require('../outreach/store'); // eslint-disable-line global-require
    if (!(await S.ready())) { last = { at: new Date().toISOString(), ok: false, words: 'Omni-Channel CRM is being set up', added: 0 }; return { skipped: last.words }; }
    const K = require('../outreach/contacts'); // eslint-disable-line global-require
    const token = await signIn();
    const list = await call('GET', '/workspaces', { token });
    const wss = (Array.isArray(list) ? list : (list && list.items) || []).map((w) => ({ id: w.id, name: String(w.name || '') }));
    let added = 0; let repeats = 0;
    for (const w of wss) { // eslint-disable-line no-restricted-syntax
      const r = await takeWorkspace({ token, ws: w.id, name: w.name }, K); // eslint-disable-line no-await-in-loop
      added += r.added; repeats += r.repeats;
    }
    last = { at: new Date().toISOString(), ok: true, words: added || repeats ? `${added} ad lead(s) added to the CRM, ${repeats} already there` : 'no new ad leads', added };
    return { added, repeats };
  } catch (err) {
    last = { at: new Date().toISOString(), ok: false, words: String((err && err.message) || err).slice(0, 200), added: 0 };
    return { error: last.words };
  } finally { running = false; }
}

const status = () => ({ ...last });

let timer = null;
function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  setTimeout(() => { sync().catch(() => {}); }, 150 * 1000);
  timer = setInterval(() => { sync().catch(() => {}); }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { sync, status, startSchedule, takeWorkspace, contactOf, departmentOf };

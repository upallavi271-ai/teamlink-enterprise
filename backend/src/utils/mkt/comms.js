// ---------------------------------------------------------------------------
// MARKET WAVE C - COMMUNICATION (08.01 / 08.04 / 08.05 / 08.06 / 08.10 / 08.11 / 08.12)
//   validateEmail     syntax, the domain's mail server (MX), throw-away (disposable) domains, typos of the big providers
//   tracking          opens (a 1-pixel image) and clicks (each link goes through TeamLink once) of candidate emails TeamLink sends,
//                     OFF by default; the privacy note is on the switch, on the candidate page and in the email's last line
//   draft             AI drafts of a candidate email / message or a reply to their last message (never sent by itself)
//   sequences         email / SMS / WhatsApp steps through the message-schedule engine (utils/messageSchedules.js) and LinkedIn /
//                     phone steps as tasks for the recruiter; the waits between them; the whole run stops when the candidate replies
//   call notes        a call recording / transcript -> notice period, CTC, expected CTC, experience, location, company as
//                     SUGGESTIONS the recruiter accepts one by one
//   mailbox           a person's own IMAP + SMTP mailbox: send from it, read replies into the candidate's conversation
// ---------------------------------------------------------------------------
const dns = require('dns');
const prisma = require('../../db');
const C = require('./core');

const { q, x, nowIso, newId, txt, json } = C;

// ================================================================== 08.11 email validation
const DISPOSABLE = new Set(('mailinator.com guerrillamail.com guerrillamail.net 10minutemail.com 10minutemail.net tempmail.com temp-mail.org temp-mail.io throwawaymail.com yopmail.com yopmail.net '
  + 'trashmail.com trashmail.de getnada.com nada.email sharklasers.com dispostable.com maildrop.cc mailnesia.com mintemail.com fakeinbox.com spamgourmet.com emailondeck.com '
  + 'mohmal.com tempail.com tempr.email discard.email moakt.com mailcatch.com mytemp.email burnermail.io inboxkitten.com mailpoof.com 33mail.com spambox.us tempinbox.com '
  + 'emailfake.com fakemail.net mailsac.com mail.tm etempmail.com tmail.ws tmpmail.org tmpmail.net luxusmail.org 1secmail.com 1secmail.net 1secmail.org dropmail.me '
  + 'harakirimail.com mvrht.com emltmp.com wegwerfmail.de byom.de minuteinbox.com crazymailing.com mailforspam.com mt2015.com zetmail.com anonaddy.me').split(/\s+/));
const TYPOS = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'yaho.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'rediffmial.com': 'rediffmail.com', 'redifmail.com': 'rediffmail.com' };
const ROLE = /^(info|admin|support|sales|hr|careers|jobs|contact|noreply|no-reply|office|accounts|hello)@/i;
const SYNTAX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
let resolver = (domain) => dns.promises.resolveMx(domain);
function setResolver(fn) { resolver = fn || ((d) => dns.promises.resolveMx(d)); } // tests
const mxCache = new Map();
async function mxOf(domain) {
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  let v;
  try {
    const rows = await Promise.race([resolver(domain), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 4000))]);
    v = { checked: true, found: Array.isArray(rows) && rows.length > 0, hosts: (rows || []).sort((a, b) => a.priority - b.priority).slice(0, 3).map((r) => r.exchange) };
  } catch (e) {
    v = ['ENOTFOUND', 'ENODATA', 'ENOTIMP', 'ESERVFAIL'].includes(e.code) && e.code !== 'ESERVFAIL' ? { checked: true, found: false, hosts: [] } : { checked: false, found: null, hosts: [], note: 'The mail-server lookup did not answer; checked again later.' };
  }
  if (v.checked) mxCache.set(domain, { at: Date.now(), v });
  return v;
}
async function validateEmail(raw, { mx = true } = {}) {
  const email = String(raw || '').trim().toLowerCase();
  const reasons = [];
  const out = { email, syntax: false, disposable: false, role: false, suggestion: null, mx: { checked: false, found: null, hosts: [] }, verdict: 'invalid', reasons };
  if (!email) { reasons.push('No email address.'); return out; }
  if (email.length > 254 || !SYNTAX.test(email) || email.includes('..')) { reasons.push('The address is not written correctly.'); return out; }
  out.syntax = true;
  const domain = email.split('@')[1];
  if (TYPOS[domain]) { out.suggestion = email.replace(/@.+$/, `@${TYPOS[domain]}`); reasons.push(`Looks like a typing slip: did you mean ${out.suggestion}?`); }
  if (DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith(`.${d}`))) { out.disposable = true; reasons.push('A throw-away (disposable) email service: mail there is usually never read.'); }
  if (ROLE.test(email)) { out.role = true; reasons.push('A shared / role address (info@, hr@ ...), not a person.'); }
  if (mx && !C.isSandbox()) out.mx = await mxOf(domain);
  else if (mx) out.mx = { checked: false, found: null, hosts: [], note: 'The mail-server (MX) lookup is skipped on the test server.' };
  if (out.mx.checked && !out.mx.found) reasons.push(`The domain ${domain} has no mail server: email to it cannot be delivered.`);
  out.verdict = (out.mx.checked && !out.mx.found) || TYPOS[domain] ? 'invalid' : (out.disposable || out.role ? 'risky' : 'valid');
  if (out.verdict === 'valid') reasons.push(out.mx.checked ? 'Looks good: written correctly and the domain receives mail.' : 'Written correctly (the mail server was not checked).');
  return out;
}

// ================================================================== 08.04 open / click tracking
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PRIVACY = 'TeamLink can see when this email is opened and which links are clicked, to know whether it reached you.';
async function trackingOn() { return C.switchOn('emailTracking'); }
// -> { html, token } ; the text stays as it was (mail apps that show text only are not tracked)
async function wrapEmail({ to, subject, text, candidateId }) {
  await C.ensure();
  const token = C.randToken(16);
  const base = C.publicBase(null);
  const links = [];
  const body = esc(text).replace(/https?:\/\/[^\s<>"']+/g, (m) => {
    const url = m.replace(/&amp;/g, '&');
    const i = links.push(url) - 1;
    return `<a href="${base}/api/public/mkt/t/c/${token}/${i}">${m}</a>`;
  }).replace(/\r?\n/g, '<br>');
  await x('INSERT INTO "MktEmailTrack" ("token","candidateId","toAddress","subject","links","sentAt") VALUES (?,?,?,?,?,?)', token, candidateId || null, txt(to, 200), txt(subject, 300), JSON.stringify(links), nowIso());
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">${body}<p style="margin-top:18px;font-size:11px;color:#6b7280">${esc(PRIVACY)}</p><img src="${base}/api/public/mkt/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0"></div>`;
  return { html, token };
}
async function dropTrack(token) { await x('DELETE FROM "MktEmailTrack" WHERE "token" = ?', token); }
const BOT_UA = /bot|crawl|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urlscan/i;
async function trackRow(token) { await C.ensure(); return (await q('SELECT * FROM "MktEmailTrack" WHERE "token" = ?', String(token || '').slice(0, 40)))[0] || null; }
async function recordOpen(token, ua) {
  const r = await trackRow(token);
  if (!r || BOT_UA.test(String(ua || ''))) return false;
  if (Date.now() - new Date(r.sentAt).getTime() < 3000) return false; // a scanner fetching it the moment it was sent
  const t = nowIso();
  await x('UPDATE "MktEmailTrack" SET "openCount" = "openCount" + 1, "firstOpenAt" = COALESCE("firstOpenAt", ?), "lastOpenAt" = ? WHERE "token" = ?', t, t, r.token);
  return true;
}
async function recordClick(token, i, { ua, method } = {}) {
  const r = await trackRow(token);
  if (!r) return null;
  const url = json(r.links, [])[Number(i)];
  if (!url) return null;
  if (method !== 'HEAD' && !BOT_UA.test(String(ua || '')) && Date.now() - new Date(r.sentAt).getTime() > 3000) {
    const t = nowIso();
    await x('UPDATE "MktEmailTrack" SET "clickCount" = "clickCount" + 1, "firstClickAt" = COALESCE("firstClickAt", ?), "lastClickAt" = ?, "firstOpenAt" = COALESCE("firstOpenAt", ?), "openCount" = CASE WHEN "openCount" = 0 THEN 1 ELSE "openCount" END WHERE "token" = ?', t, t, t, r.token);
  }
  return url;
}
async function trackingFor(candidateId) {
  await C.ensure();
  return (await q('SELECT "subject","toAddress","sentAt","openCount","firstOpenAt","lastOpenAt","clickCount","firstClickAt" FROM "MktEmailTrack" WHERE "candidateId" = ? ORDER BY "sentAt" DESC LIMIT 30', candidateId))
    .map((r) => ({ subject: r.subject, sentAt: r.sentAt, opened: Number(r.openCount) > 0, opens: Number(r.openCount), firstOpenAt: r.firstOpenAt, lastOpenAt: r.lastOpenAt, clicks: Number(r.clickCount), firstClickAt: r.firstClickAt }));
}

// ================================================================== 08.12 AI drafting
const PURPOSES = {
  follow_up: { label: 'Follow up (no reply yet)', subject: 'Following up on {{job}}', body: 'Hi {{first}},\n\nI am following up on the {{job}} role we discussed. Are you still interested? A short reply is enough and I will share the next steps.\n\nThanks,\n{{me}}' },
  interview_invite: { label: 'Invite to interview', subject: 'Interview for {{job}}', body: 'Hi {{first}},\n\nGood news: you are shortlisted for the {{job}} role. Please share two or three times that suit you this week for the interview.\n\nThanks,\n{{me}}' },
  reminder: { label: 'Interview reminder', subject: 'Reminder: your interview for {{job}}', body: 'Hi {{first}},\n\nA reminder of your interview for {{job}}{{when}}. Please be ready 10 minutes early and keep your resume handy.\n\nAll the best,\n{{me}}' },
  documents: { label: 'Ask for documents', subject: 'Documents for {{job}}', body: 'Hi {{first}},\n\nTo take your application for {{job}} forward, please send your latest payslips, offer / relieving letters and an ID proof.\n\nThanks,\n{{me}}' },
  job_pitch: { label: 'Tell them about a job', subject: 'A job that may suit you: {{job}}', body: 'Hi {{first}},\n\nI came across your profile and think the {{job}} role could suit you. Would you like the details? Reply "yes" and I will call you.\n\nThanks,\n{{me}}' },
  rejection: { label: 'Not selected (kind)', subject: 'Your application for {{job}}', body: 'Hi {{first}},\n\nThank you for your time on the {{job}} role. This time we are going ahead with other profiles. We will keep you in mind for roles that match your experience.\n\nBest wishes,\n{{me}}' },
  reply: { label: 'Reply to their last message', subject: 'Re: {{job}}', body: 'Hi {{first}},\n\nThank you for your message. I will check and get back to you shortly.\n\nThanks,\n{{me}}' },
};
async function draft({ candidate, application, user, purpose = 'follow_up', channel = 'Email', lastMessage = '', note = '' }) {
  const p = PURPOSES[purpose] ? purpose : 'follow_up';
  const first = String((candidate && candidate.name) || '').trim().split(/\s+/)[0] || 'there';
  const job = (application && application.requirement && application.requirement.title) || 'the role';
  const when = application && application.interviewAt ? ` on ${new Date(application.interviewAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}` : '';
  const me = (user && user.name) || 'TeamLink';
  const fill = (s) => s.replace(/\{\{first\}\}/g, first).replace(/\{\{job\}\}/g, job).replace(/\{\{when\}\}/g, when).replace(/\{\{me\}\}/g, me);
  const code = { subject: channel === 'Email' ? fill(PURPOSES[p].subject) : null, body: fill(PURPOSES[p].body), source: 'TeamLink template (no AI)' };
  // facts to the model: the job title, the step, the purpose, the time; NOT the name, contact, pay or the client
  const facts = [`Purpose: ${PURPOSES[p].label}.`, `Job title: ${job}.`, application && application.stage ? `Their step: ${application.stage}.` : '', when ? `Interview time:${when}.` : '', note ? `Recruiter's note: ${C.maskPii(note, [candidate && candidate.name])}` : '', lastMessage ? `Their last message: "${C.maskPii(lastMessage, [candidate && candidate.name]).slice(0, 1500)}"` : ''].filter(Boolean).join('\n');
  const limit = channel === 'SMS' ? 'at most 300 characters, no subject' : channel === 'WhatsApp' ? 'at most 600 characters, friendly, no subject' : 'a short email (60-120 words) with a subject';
  const ai = await C.aiJson(`You draft recruiter messages to job candidates in India: polite, short, plain English, ${limit}. Start with "Hi {{first}}," and end with "{{me}}" on its own line. Never invent facts (salary, dates, company names) that are not given. Answer JSON only: {"subject": "...", "body": "..."}.`, facts, { maxTokens: 500 });
  if (ai && ai.value && ai.value.body) {
    const body = fill(txt(ai.value.body, channel === 'SMS' ? 320 : 3000));
    return { subject: channel === 'Email' ? fill(txt(ai.value.subject, 160) || code.subject) : null, body, source: `AI (${ai.provider}) - check it before sending`, purposes: Object.entries(PURPOSES).map(([k, v]) => ({ key: k, label: v.label })) };
  }
  return { ...code, purposes: Object.entries(PURPOSES).map(([k, v]) => ({ key: k, label: v.label })) };
}

// ================================================================== 08.05 / 08.06 sequences
const SEQ_CHANNELS = ['Email', 'SMS', 'WhatsApp', 'LinkedIn', 'Call'];
const MANUAL = ['LinkedIn', 'Call'];
function cleanSteps(list) {
  const steps = [];
  for (const [i, s] of (Array.isArray(list) ? list : []).entries()) {
    const channel = SEQ_CHANNELS.includes(s && s.channel) ? s.channel : null;
    if (!channel) return { error: `Step ${i + 1}: pick Email, SMS, WhatsApp, LinkedIn or Call.` };
    const waitDays = Number(s.waitDays || 0);
    if (!(Number.isInteger(waitDays) && waitDays >= 0 && waitDays <= 30)) return { error: `Step ${i + 1}: wait 0 to 30 days.` };
    const body = txt(s.body, channel === 'SMS' ? 320 : 3000);
    if (!body) return { error: `Step ${i + 1}: write the ${MANUAL.includes(channel) ? 'task (what to do)' : 'message'}.` };
    steps.push({ channel, waitDays, subject: channel === 'Email' ? txt(s.subject, 160) || 'About your job application' : null, body });
  }
  if (!steps.length) return { error: 'Add at least one step.' };
  if (steps.length > 10) return { error: 'At most 10 steps.' };
  return { value: steps };
}
const shapeSeq = (r) => ({ id: r.id, name: r.name, steps: json(r.steps, []), active: Number(r.active) === 1, createdBy: r.createdBy, createdAt: r.createdAt });
async function listSequences() { await C.ensure(); return (await q('SELECT * FROM "MktSeq" ORDER BY "createdAt" DESC')).map(shapeSeq); }
async function saveSequence(b, user, id = null) {
  await C.ensure();
  const name = txt(b.name, 100);
  if (!name) return { status: 400, error: 'Give the sequence a name.' };
  const v = cleanSteps(b.steps);
  if (v.error) return { status: 400, error: v.error };
  const t = nowIso();
  if (id) {
    const n = await x('UPDATE "MktSeq" SET "name"=?,"steps"=?,"active"=?,"updatedAt"=? WHERE "id"=?', name, JSON.stringify(v.value), b.active === false ? 0 : 1, t, id);
    if (!n) return { status: 404, error: 'Sequence not found.' };
    return { sequence: shapeSeq((await q('SELECT * FROM "MktSeq" WHERE "id" = ?', id))[0]) };
  }
  const nid = newId();
  await x('INSERT INTO "MktSeq" ("id","name","steps","active","createdBy","createdById","createdAt","updatedAt") VALUES (?,?,?,1,?,?,?,?)', nid, name, JSON.stringify(v.value), C.who(user), user.id, t, t);
  return { sequence: shapeSeq((await q('SELECT * FROM "MktSeq" WHERE "id" = ?', nid))[0]) };
}
// a step's time: inside 10:00-18:00 India time (inside every company's sending window), at least 15 minutes ahead
function stepTime(fromMs, waitDays) {
  let t = new Date(fromMs + waitDays * 86400e3 + (waitDays === 0 ? 15 * 60000 : 0));
  const ist = new Date(t.getTime() + 5.5 * 3600e3);
  const h = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  const day = ist.toISOString().slice(0, 10);
  if (h < 10) t = new Date(`${day}T10:00:00+05:30`);
  else if (h >= 18) t = new Date(new Date(`${day}T10:00:00+05:30`).getTime() + 86400e3);
  return t;
}
const fillVars = (s, cand, app, user) => String(s || '').replace(/\{\{first\}\}|\{\{firstName\}\}/g, String(cand.name || '').split(/\s+/)[0] || 'there').replace(/\{\{job\}\}|\{\{role\}\}/g, (app && app.requirement && app.requirement.title) || 'the role').replace(/\{\{me\}\}/g, (user && user.name) || 'TeamLink');
async function enrol({ sequenceId, candidate, application, user }) {
  if (!(await C.switchOn('sequences'))) return { status: 409, error: C.SWITCH_OFF('sequences') };
  await C.ensure();
  const seq = (await q('SELECT * FROM "MktSeq" WHERE "id" = ? AND "active" = 1', String(sequenceId || '')))[0];
  if (!seq) return { status: 404, error: 'Pick a sequence that is switched on.' };
  const running = (await q('SELECT "id" FROM "MktSeqRun" WHERE "candidateId" = ? AND "status" = \'running\'', candidate.id))[0];
  if (running) return { status: 409, error: 'This candidate is already in a sequence. Stop it first.' };
  const MS = require('../messageSchedules'); // eslint-disable-line global-require
  const steps = json(seq.steps, []);
  let at = Date.now();
  const out = [];
  for (const [i, s] of steps.entries()) {
    const due = stepTime(at, s.waitDays);
    at = due.getTime();
    const body = fillVars(s.body, candidate, application, user);
    if (MANUAL.includes(s.channel)) { out.push({ i, channel: s.channel, dueAt: due.toISOString(), status: 'task', body }); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const r = await MS.create(user, { candidateId: candidate.id, applicationId: application ? application.id : undefined, channel: s.channel, subject: s.subject ? fillVars(s.subject, candidate, application, user) : undefined, body, kind: 'one-time', startAt: due.toISOString(), timezone: 'Asia/Kolkata' });
    const sid = r.created && r.created[0] && r.created[0].scheduleId;
    out.push({ i, channel: s.channel, dueAt: due.toISOString(), status: sid ? 'scheduled' : 'refused', scheduleId: sid || null, reason: sid ? null : (r.error || (r.refused && r.refused[0] && r.refused[0].reason) || 'Not scheduled') });
  }
  if (!out.some((s) => s.status !== 'refused')) {
    return { status: 409, error: `No step could be planned: ${out.map((s) => s.reason).filter(Boolean)[0] || 'check the candidate\'s contact details'}` };
  }
  const id = newId();
  await x('INSERT INTO "MktSeqRun" ("id","sequenceId","candidateId","applicationId","status","steps","startedAt","createdBy","createdById") VALUES (?,?,?,?,\'running\',?,?,?,?)', id, seq.id, candidate.id, application ? application.id : null, JSON.stringify(out), nowIso(), C.who(user), user.id);
  return { run: await runRow(id) };
}
async function runRow(id) {
  const r = (await q('SELECT r.*, s."name" FROM "MktSeqRun" r LEFT JOIN "MktSeq" s ON s."id" = r."sequenceId" WHERE r."id" = ?', id))[0];
  return r ? { id: r.id, name: r.name, candidateId: r.candidateId, applicationId: r.applicationId, status: r.status, steps: json(r.steps, []), startedAt: r.startedAt, stoppedAt: r.stoppedAt, stopReason: r.stopReason, createdBy: r.createdBy, createdById: r.createdById } : null;
}
async function runsFor(candidateId) { await C.ensure(); const rows = await q('SELECT "id" FROM "MktSeqRun" WHERE "candidateId" = ? ORDER BY "startedAt" DESC LIMIT 10', candidateId); return Promise.all(rows.map((r) => runRow(r.id))); }
async function stopRun(runId, reason, status = 'stopped') {
  const run = await runRow(runId);
  if (!run || run.status !== 'running') return { status: 409, error: 'This sequence is not running.' };
  const ids = run.steps.filter((s) => s.scheduleId && s.status === 'scheduled').map((s) => s.scheduleId);
  const MS = require('../messageSchedules'); // eslint-disable-line global-require
  await MS.stopIds(ids, 'cancelled', `Sequence stopped: ${reason}`).catch(() => 0);
  const steps = run.steps.map((s) => (['scheduled', 'task'].includes(s.status) && new Date(s.dueAt) > new Date() ? { ...s, status: 'cancelled' } : s));
  await x('UPDATE "MktSeqRun" SET "status" = ?, "steps" = ?, "stoppedAt" = ?, "stopReason" = ? WHERE "id" = ? AND "status" = \'running\'', status, JSON.stringify(steps), nowIso(), txt(reason, 200), runId);
  return { run: await runRow(runId) };
}
async function onCandidateReply(candidateId, channel) {
  await C.ensure();
  const rows = await q('SELECT "id" FROM "MktSeqRun" WHERE "candidateId" = ? AND "status" = \'running\'', String(candidateId));
  for (const r of rows) await stopRun(r.id, `the candidate replied${channel ? ` on ${channel}` : ''}`, 'replied'); // eslint-disable-line no-await-in-loop
  return rows.length;
}
async function doneTask(runId, i, user, note) {
  const run = await runRow(runId);
  if (!run) return { status: 404, error: 'Not found.' };
  const steps = run.steps.map((s) => (s.i === Number(i) && s.status === 'task' ? { ...s, status: 'done', doneAt: nowIso(), doneBy: C.who(user), note: txt(note, 300) || null } : s));
  if (JSON.stringify(steps) === JSON.stringify(run.steps)) return { status: 400, error: 'That step is not an open task.' };
  await x('UPDATE "MktSeqRun" SET "steps" = ? WHERE "id" = ?', JSON.stringify(steps), runId);
  return { run: await runRow(runId) };
}
// the LinkedIn / phone tasks that are due, for this person's candidates
async function myTasks(user) {
  await C.ensure();
  const rows = await q('SELECT r."id" FROM "MktSeqRun" r WHERE r."status" = \'running\' AND r."createdById" = ? ORDER BY r."startedAt" DESC LIMIT 200', user.id);
  const out = [];
  for (const { id } of rows) {
    const run = await runRow(id); // eslint-disable-line no-await-in-loop
    run.steps.filter((s) => s.status === 'task' && new Date(s.dueAt) <= new Date(Date.now() + 2 * 86400e3)).forEach((s) => out.push({ runId: run.id, sequence: run.name, candidateId: run.candidateId, ...s }));
  }
  const names = out.length ? await prisma.candidate.findMany({ where: { id: { in: [...new Set(out.map((o) => o.candidateId))] } }, select: { id: true, name: true } }) : [];
  return out.map((o) => ({ ...o, candidateName: (names.find((n) => n.id === o.candidateId) || {}).name })).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

// ================================================================== 08.10 call transcript -> suggestions
const FIELDS = { noticePeriod: 'Notice period', currentSalary: 'Current CTC', expectedSalary: 'Expected CTC', experienceYears: 'Total experience (years)', location: 'Current location', currentCompany: 'Current company', preferredLocation: 'Preferred location', currentDesignation: 'Current designation' };
function money(s) {
  const m = /(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|l\b|k\b|thousand|per month|pm|cr|crore)?/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]); const u = String(m[2] || '').toLowerCase();
  if (/k|thousand/.test(u) || /per month|pm|month/i.test(s)) return /k|thousand/.test(u) ? `${n}K per month` : `${n} per month`;
  if (/cr/.test(u)) return `${n} Cr`;
  if (/l/.test(u) || (n > 0 && n < 100)) return `${n} LPA`;
  return n >= 10000 ? `${n}` : `${n} LPA`;
}
function codeExtract(transcript) {
  const D = require('../../calling/dialogue'); // eslint-disable-line global-require
  const sents = String(transcript || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
  const out = {};
  const put = (k, v, ev) => { if (v != null && v !== '' && !out[k]) out[k] = { value: String(v).slice(0, 80), evidence: ev.slice(0, 200) }; };
  sents.forEach((s, i) => {
    const near = `${s} ${sents[i + 1] || ''}`;
    if (/notice/i.test(s)) { const n = D.readNotice(near); put('noticePeriod', n.days === 0 ? 'Immediate' : (n.text ? n.text.replace(/^(\d+)$/, '$1 days') : null), s); }
    if (/immediate(ly)? (joiner|join|available)|can join immediately/i.test(s)) put('noticePeriod', 'Immediate', s);
    if (/(expect|expectation|looking for)/i.test(s) && /(\d)/.test(s) && /(lpa|lakh|lac|ctc|salary|package|k\b|per month)/i.test(near)) put('expectedSalary', money(s.slice(s.search(/expect|expectation|looking for/i))), s);
    if (/(current|present|getting|drawing|now earning|my) (ctc|salary|package)|current(ly)? (i am )?(getting|drawing|earning)/i.test(s) && /\d/.test(s)) put('currentSalary', money(s.slice(s.search(/ctc|salary|package|getting|drawing|earning/i))), s);
    const ex = /(\d{1,2}(?:\.\d)?)\s*\+?\s*(years|yrs)\s*(of)?\s*(total\s*)?(experience|exp)/i.exec(s) || /experience (of|is)\s*(\d{1,2}(?:\.\d)?)\s*(years|yrs)/i.exec(s);
    if (ex) put('experienceYears', Number(ex[1] && /\d/.test(ex[1]) ? ex[1] : ex[2]), s);
    const loc = /(currently|right now|presently)?\s*(based|staying|living|located)\s+(in|at)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/.exec(s) || /\bI am (in|from) ([A-Z][a-zA-Z]+)/.exec(s);
    if (loc) put('location', loc[4] || loc[2], s);
    const pref = /(prefer|preferred|relocate to|open to)\s+([A-Z][a-zA-Z]+(?:\s(?:or|and)\s[A-Z][a-zA-Z]+)?)/.exec(s);
    if (pref) put('preferredLocation', pref[2], s);
    const co = /(working (at|with|for)|employed (at|with)|currently (at|with)|my company is)\s+([A-Z][\w&.-]+(?:\s[A-Z][\w&.-]+){0,3})/.exec(s);
    if (co) put('currentCompany', co[5], s);
    const des = /(working as|my (role|designation) is|i am an?)\s+([a-zA-Z ]{3,40}?)(?=\s(at|with|in|for)\b|[.,]|$)/i.exec(s);
    if (des && /(engineer|developer|manager|analyst|executive|lead|consultant|nurse|doctor|teacher|accountant|designer|officer|associate|specialist)/i.test(des[3])) put('currentDesignation', des[3].trim(), s);
  });
  return out;
}
async function extractCall({ candidate, transcript, source, fileStored, applicationId, user }) {
  await C.ensure();
  const t = String(transcript || '').trim();
  if (t.length < 20) return { status: 400, error: 'Paste the call transcript (or upload the recording) first.' };
  const code = codeExtract(t);
  const ai = await C.aiJson(`From a recruiter's phone call transcript with a job candidate, pull out facts the CANDIDATE said. JSON only, null when not said, never guess: {"noticePeriod":"e.g. 30 days / Immediate","currentSalary":"e.g. 6 LPA","expectedSalary":"e.g. 8 LPA","experienceYears":number,"location":"city","currentCompany":"...","preferredLocation":"city","currentDesignation":"...","summary":"2 sentences"}`, C.maskPii(t, []).slice(0, 12000), { maxTokens: 500 });
  const merged = {};
  Object.keys(FIELDS).forEach((k) => {
    const a = ai && ai.value && ai.value[k] != null && String(ai.value[k]).trim() && !/^\[(name|number|email|link|id)\]$/.test(String(ai.value[k])) ? { value: String(ai.value[k]).slice(0, 80), evidence: code[k] ? code[k].evidence : null, by: `AI (${ai.provider})` } : null;
    const c = code[k] ? { ...code[k], by: 'TeamLink (from the words)' } : null;
    const pick = c && a && String(c.value).toLowerCase() === String(a.value).toLowerCase() ? { ...c, by: 'AI and TeamLink agree' } : (a || c);
    if (pick) merged[k] = pick;
  });
  if (merged.experienceYears && !Number.isFinite(Number(merged.experienceYears.value))) delete merged.experienceYears;
  const suggestions = Object.entries(merged).map(([field, v]) => ({ field, label: FIELDS[field], value: field === 'experienceYears' ? Number(v.value) : v.value, current: candidate[field] == null ? null : candidate[field], evidence: v.evidence, by: v.by, status: String(candidate[field] == null ? '' : candidate[field]).toLowerCase() === String(v.value).toLowerCase() ? 'same' : 'pending' }));
  const id = newId();
  const summary = ai && ai.value && ai.value.summary ? txt(ai.value.summary, 600) : null;
  await x('INSERT INTO "MktCallNote" ("id","candidateId","applicationId","transcript","transcriptSource","fileStored","suggestions","summary","createdBy","createdById","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, candidate.id, applicationId || null, txt(t, 200000), source || 'Typed / pasted', fileStored || null, JSON.stringify(suggestions), summary, C.who(user), user.id, nowIso());
  return { note: await callNote(id) };
}
async function callNote(id) {
  const r = (await q('SELECT * FROM "MktCallNote" WHERE "id" = ?', String(id)))[0];
  return r ? { id: r.id, candidateId: r.candidateId, transcriptSource: r.transcriptSource, transcript: String(r.transcript || '').slice(0, 4000), suggestions: json(r.suggestions, []), summary: r.summary, createdBy: r.createdBy, createdAt: r.createdAt } : null;
}
async function callNotesFor(candidateId) { await C.ensure(); const rows = await q('SELECT "id" FROM "MktCallNote" WHERE "candidateId" = ? ORDER BY "createdAt" DESC LIMIT 10', candidateId); return Promise.all(rows.map((r) => callNote(r.id))); }
async function decideSuggestion(noteId, field, accept, user, { value } = {}) {
  const n = await callNote(noteId);
  if (!n) return { status: 404, error: 'Not found.' };
  const s = n.suggestions.find((x2) => x2.field === field);
  if (!s || s.status !== 'pending') return { status: 409, error: 'That suggestion was already decided.' };
  let newValue = value !== undefined && value !== null && String(value).trim() !== '' ? value : s.value;
  if (accept) {
    if (field === 'experienceYears') { newValue = Number(newValue); if (!(Number.isFinite(newValue) && newValue >= 0 && newValue <= 60)) return { status: 400, error: 'Experience is 0 to 60 years.' }; } else newValue = txt(newValue, 80);
    const before = await prisma.candidate.findUnique({ where: { id: n.candidateId }, select: { [field]: true } });
    await prisma.candidate.update({ where: { id: n.candidateId }, data: { [field]: newValue } });
    try { require('../candidateListCache').markCandidateDirty(n.candidateId); } catch { /* optional */ } // eslint-disable-line global-require
    await require('../audit').logAudit({ userId: user.id, action: `${FIELDS[field]} set from a call transcript`, entity: 'Candidate', entityId: n.candidateId, field, fromValue: String(before && before[field] != null ? before[field] : '-'), toValue: String(newValue) }).catch(() => {}); // eslint-disable-line global-require
  }
  const suggestions = n.suggestions.map((x2) => (x2.field === field ? { ...x2, status: accept ? 'accepted' : 'dismissed', value: accept ? newValue : x2.value, decidedBy: C.who(user), decidedAt: nowIso() } : x2));
  await x('UPDATE "MktCallNote" SET "suggestions" = ? WHERE "id" = ?', JSON.stringify(suggestions), noteId);
  return { note: await callNote(noteId) };
}

// ================================================================== 08.01 a person's own mailbox
const shapeBox = (r) => (r ? { address: r.address, imapHost: r.imapHost, imapPort: Number(r.imapPort) || 993, smtpHost: r.smtpHost, smtpPort: Number(r.smtpPort) || 465, username: r.username, saved: !!r.secretEnc, status: r.status, lastCheckAt: r.lastCheckAt, lastError: r.lastError, updatedAt: r.updatedAt } : null);
async function mailbox(userId) { await C.ensure(); return shapeBox((await q('SELECT * FROM "MktMailbox" WHERE "userId" = ?', userId))[0]); }
const HOST = /^[a-z0-9.-]{3,120}$/i;
async function saveMailbox(userId, b) {
  await C.ensure();
  const address = String(b.address || '').trim().toLowerCase();
  if (!SYNTAX.test(address)) return { status: 400, error: 'Write the mailbox address, e.g. you@company.com.' };
  const imapHost = String(b.imapHost || '').trim(); const smtpHost = String(b.smtpHost || '').trim();
  if (!HOST.test(imapHost) || !HOST.test(smtpHost)) return { status: 400, error: 'Write the IMAP and SMTP server names, e.g. imap.gmail.com and smtp.gmail.com.' };
  const imapPort = Number(b.imapPort) || 993; const smtpPort = Number(b.smtpPort) || 465;
  if (![993, 143].includes(imapPort) || ![465, 587, 25].includes(smtpPort)) return { status: 400, error: 'IMAP port is 993 (or 143); SMTP port is 465 or 587.' };
  const had = (await q('SELECT * FROM "MktMailbox" WHERE "userId" = ?', userId))[0];
  let secretEnc = had && had.secretEnc;
  if (b.password) { try { secretEnc = C.enc(String(b.password)); } catch (e) { return { status: 400, error: e.message }; } }
  if (!secretEnc) return { status: 400, error: 'Write the password (an app password for Gmail / Outlook).' };
  await x(`INSERT INTO "MktMailbox" ("userId","address","imapHost","imapPort","smtpHost","smtpPort","username","secretEnc","status","updatedAt") VALUES (?,?,?,?,?,?,?,?,'saved',?)
    ON CONFLICT("userId") DO UPDATE SET "address"=excluded."address","imapHost"=excluded."imapHost","imapPort"=excluded."imapPort","smtpHost"=excluded."smtpHost","smtpPort"=excluded."smtpPort","username"=excluded."username","secretEnc"=excluded."secretEnc","status"='saved',"lastError"=NULL,"updatedAt"=excluded."updatedAt"`,
  userId, address, imapHost, imapPort, smtpHost, smtpPort, txt(b.username, 160) || address, secretEnc, nowIso());
  return { mailbox: await mailbox(userId) };
}
async function removeMailbox(userId) { await C.ensure(); await x('DELETE FROM "MktMailbox" WHERE "userId" = ?', userId); }
function smtpFor(row) {
  if (C.isSandbox()) return require('../sandbox').fakeMailTransport(); // eslint-disable-line global-require
  const nodemailer = require('nodemailer'); // eslint-disable-line global-require
  return nodemailer.createTransport({ host: row.smtpHost, port: Number(row.smtpPort), secure: Number(row.smtpPort) === 465, auth: { user: row.username || row.address, pass: C.dec(row.secretEnc) || '' }, connectionTimeout: 15000 });
}
// send one candidate email from the person's own mailbox; the reply comes back to their mailbox and (with inbox sync on) into TeamLink
async function sendFromMailbox(user, { candidate, applicationId, subject, text }) {
  await C.ensure();
  const row = (await q('SELECT * FROM "MktMailbox" WHERE "userId" = ?', user.id))[0];
  if (!row) return { status: 409, error: 'Connect your mailbox first (Outreach tools > My mailbox).' };
  const to = String(candidate.email || '').trim();
  const v = await validateEmail(to, { mx: false });
  if (!v.syntax) return { status: 400, error: 'This candidate has no correct email address.' };
  if (require('../mailer').isReservedTestAddress(to)) return { status: 400, error: `${to} is a reserved test address - never sent.` }; // eslint-disable-line global-require
  const subj = txt(subject, 200) || 'About your job application';
  const body = txt(text, 8000);
  if (!body) return { status: 400, error: 'Write the message.' };
  let html; let tracked = false;
  if (await trackingOn()) { const w = await wrapEmail({ to, subject: subj, text: body, candidateId: candidate.id }); html = w.html; tracked = true; }
  let info;
  try { info = await smtpFor(row).sendMail({ from: row.address, to, subject: subj, text: body, ...(html ? { html } : {}) }); } catch (e) {
    await x('UPDATE "MktMailbox" SET "lastError" = ? WHERE "userId" = ?', txt(e.message, 300), user.id);
    return { status: 502, error: `Your mailbox did not send it: ${txt(e.message, 160)}` };
  }
  await prisma.candidateMessage.create({ data: { candidateId: candidate.id, applicationId: applicationId || null, channel: 'Email', template: 'PERSONAL_MAILBOX', templateLabel: 'From my mailbox', trigger: 'Manual (my mailbox)', recipient: to, subject: subj, body, status: 'SENT', statusDetail: info && info.response ? String(info.response).slice(0, 200) : null, senderUserId: user.id, senderName: user.name, senderEmail: row.address, providerRef: info && info.messageId, sentAt: new Date() } });
  await require('../conversations').recordOut({ personType: 'CANDIDATE', personId: candidate.id, personName: candidate.name, channel: 'Email', subject: subj, body, address: to, senderUserId: user.id, senderName: user.name }).catch(() => null); // eslint-disable-line global-require
  return { ok: true, sandbox: !!(info && /sandbox/.test(String(info.response || info.messageId))), tracked };
}
// read the person's mailbox (the shared IMAP reader, with their own settings and checkpoint)
async function pollMailbox(userId, { transport, messages } = {}) {
  await C.ensure();
  const row = (await q('SELECT * FROM "MktMailbox" WHERE "userId" = ?', userId))[0];
  if (!row) return { status: 409, error: 'No mailbox connected.' };
  const cfg = { host: row.imapHost, port: Number(row.imapPort) || 993, address: row.address, password: C.dec(row.secretEnc) || '', username: row.username, configured: true, problems: [], reason: '' };
  const out = await require('../imapInbox').pollOnce({ transport, messages, cfg, ckKey: `mailbox.checkpoint.${userId}`, lastKey: `mailbox.lastpoll.${userId}` }); // eslint-disable-line global-require
  await x('UPDATE "MktMailbox" SET "lastCheckAt" = ?, "lastError" = ?, "status" = ? WHERE "userId" = ?', nowIso(), out.errors && out.errors.length ? txt(out.errors[0], 300) : null, out.errors && out.errors.length ? 'error' : 'connected', userId);
  return out;
}
let timer = null;
function startInboxSync() {
  if (timer || C.isSandbox()) return;
  timer = setInterval(async () => {
    try {
      if (!(await C.switchOn('inboxSync'))) return;
      await C.ensure();
      const rows = await q('SELECT "userId" FROM "MktMailbox" WHERE "secretEnc" IS NOT NULL');
      for (const r of rows) await pollMailbox(r.userId).catch(() => null); // eslint-disable-line no-await-in-loop
      await require('../imapInbox').pollOnce().catch(() => null); // eslint-disable-line global-require
    } catch (e) { console.error('[mkt] inbox sync:', e.message); } // eslint-disable-line no-console
  }, 5 * 60000);
  if (timer.unref) timer.unref();
}

module.exports = {
  DISPOSABLE, validateEmail, setResolver, PRIVACY, trackingOn, wrapEmail, dropTrack, recordOpen, recordClick, trackingFor, PURPOSES, draft,
  SEQ_CHANNELS, cleanSteps, listSequences, saveSequence, enrol, runsFor, runRow, stopRun, onCandidateReply, doneTask, myTasks, stepTime,
  FIELDS, codeExtract, extractCall, callNotesFor, callNote, decideSuggestion, mailbox, saveMailbox, removeMailbox, sendFromMailbox, pollMailbox, startInboxSync,
};

// OMNICHANNEL TEST 2 - webhooks -> Inbox, scope / counts / unread / assign, timeline order, best channel + rules,
// quiet hours, caps, STOP, consent, mailbox (mock IMAP), "if no reply". SANDBOX ONLY.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, cleanup, L } = require('./fx');
const E = require('./env');
const { check, sleep } = L;
const P = L.prisma;
const BACK = L.BACK;
const imap = require(path.join(BACK, 'src/utils/imapInbox'));
const jobs = [];

const hm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const conv = (type, id) => P.$queryRawUnsafe('SELECT * FROM "Conversation" WHERE "personType" = ? AND "personId" = ?', type, id).then((r) => r[0] || null);
const mime = (o) => [
  `From: ${o.from}`, 'To: inbox@zz-sandbox.in', `Subject: ${o.subject || 'Re: hello'}`, `Message-ID: ${o.id}`, ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
  ...(o.auto ? ['Auto-Submitted: auto-replied'] : []), 'Date: Sat, 10 Oct 2026 10:00:00 +0530', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', '', o.body || 'Yes, I can come on Monday.', '', 'On Fri, 9 Oct 2026, TeamLink wrote:', '> the earlier message that must not be repeated',
].join('\r\n');

(async () => {
  let W;
  try {
    W = await build();
    const U = W.u;
    // a recruiter of ANOTHER department who is not on this job
    U.other = await L.mkUser('other', { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { department: 'Medical' });
    await E.setup(U.sa);
    const ph = W.c1.c.phone; const e164 = `91${ph}`; const cphone = W.client.contactPhone; const cE164 = `91${cphone}`;
    const sleepMs = () => sleep(40);

    // ---------------- 1. WhatsApp reply webhook -> conversation ------------------------------------
    const raw = JSON.stringify(E.wrap({ messages: [{ from: e164, id: 'wamid.ZZBAD', timestamp: '1', type: 'text', text: { body: 'x' } }] }));
    const bad = await fetch(`${L.API}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: raw });
    check('1 WhatsApp webhook with a bad signature -> 403', bad.status === 403);
    const w1 = await E.waInbound(e164, 'Yes I am interested', 'wamid.ZZIN1');
    check('1 signed WhatsApp reply accepted', w1.status === 200 && w1.body.replies === 1, JSON.stringify(w1));
    await E.waInbound(e164, 'Yes I am interested', 'wamid.ZZIN1');
    const recvCount = await P.candidateMessage.count({ where: { candidateId: W.c1.c.id, status: 'RECEIVED', providerRef: 'wamid.ZZIN1' } });
    check('1 the same WhatsApp message delivered twice is stored once', recvCount === 1, recvCount);
    let cv = await conv('CANDIDATE', W.c1.c.id);
    check('1 the person\'s conversation: unread 1, last channel WhatsApp, owner = the job\'s recruiter', cv && Number(cv.unread) === 1 && cv.lastChannel === 'WhatsApp' && cv.ownerUserId === U.rec.id, cv);
    const bell = await P.notification.findFirst({ where: { userId: U.rec.id, title: { contains: 'New reply from' } } });
    check('1 the recruiter is told in the bell', !!bell, bell && bell.title);

    // ---------------- 2. SMS reply webhook -------------------------------------------------------------
    const sBad = await fetch(`${L.API}/webhooks/sms-inbound/msg91?key=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: e164, message: 'x' }) });
    check('2 SMS reply with a wrong key -> 403', sBad.status === 403);
    const s1 = await E.smsInbound(e164, 'Call me tomorrow after 5');
    check('2 SMS reply accepted and stored', s1.status === 200 && s1.body.stored === 1, JSON.stringify(s1));
    const s2 = await E.smsInbound('9111111111', 'who is this');
    check('2 an SMS from a number we do not know is not attached to anybody', s2.status === 200 && s2.body.stored === 0);
    cv = await conv('CANDIDATE', W.c1.c.id);
    check('2 unread now 2, last channel SMS', Number(cv.unread) === 2 && cv.lastChannel === 'SMS', cv);

    // a client contact writes from the number on the client card
    await E.waInbound(cE164, 'Please send two more profiles', 'wamid.ZZCL1');
    const ccv = await conv('CLIENT', W.client.id);
    check('2 a client contact\'s WhatsApp reply lands in the CLIENT conversation (new table)', ccv && Number(ccv.unread) === 1 && ccv.ownerUserId === U.bde.id, ccv);
    await E.smsInbound(W.empRow.phone, 'I will join the meeting');
    const ecv = await conv('EMPLOYEE', W.empRow.id);
    check('2 an employee\'s SMS reply lands in the EMPLOYEE conversation', ecv && Number(ecv.unread) === 1, ecv);

    // ---------------- 3. the Inbox: scope, counts, unread ------------------------------------------------
    const inbox = async (u, q = '') => (await L.get(u, `/conversations/inbox?${q}`));
    let r = await inbox(U.rec, 'state=unread');
    check('3 recruiter: the candidate with 2 unread is in the Inbox (and only theirs)', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].personId === W.c1.c.id && r.body.rows[0].unread === 2, JSON.stringify(r.body.rows && r.body.rows.map((x) => [x.name, x.unread])));
    check('3 row = person + last message + channel + time + unread', r.body.rows[0].snippet && r.body.rows[0].channel === 'SMS' && r.body.rows[0].lastAt, r.body.rows[0]);
    r = await inbox(U.other, 'state=all');
    check('3 a recruiter of another department sees nothing of it', r.status === 200 && r.body.rows.length === 0 && r.body.unreadTotal === 0, r.body.rows && r.body.rows.length);
    const ucOther = await L.get(U.other, '/conversations/unread-count');
    check('3 ...and their badge is 0', ucOther.body.conversations === 0);
    const ucRec = await L.get(U.rec, '/conversations/unread-count');
    check('3 recruiter badge = 1 conversation (2 messages)', ucRec.body.conversations === 1 && ucRec.body.messages === 2, ucRec.body);
    r = await inbox(U.tl, 'state=unread');
    check('3 TL (same team) sees the candidate conversation', r.body.rows.some((x) => x.personId === W.c1.c.id), r.body.rows && r.body.rows.length);
    r = await inbox(U.bde, 'state=unread');
    const names = (r.body.rows || []).map((x) => x.personType);
    check('3 BDE sees the client conversation and the candidate shared with the client', names.includes('CLIENT') && names.includes('CANDIDATE'), names);
    const bc = (r.body.rows || []).find((x) => x.personType === 'CANDIDATE');
    check('3 BDE row text has no number', bc && !JSON.stringify(bc).includes(ph), bc && bc.snippet);
    const emp = await inbox(U.emp, 'state=all');
    check('3 a plain Employee has no Inbox', emp.status === 200 && emp.body.allowed === false && emp.body.rows.length === 0);
    const acct = await inbox(U.acct, 'state=all');
    check('3 the Accountant sees client conversations only', acct.status === 200 && acct.body.rows.every((x) => x.personType === 'CLIENT'), acct.body.rows && acct.body.rows.map((x) => x.personType));
    const hrI = await inbox(U.hr, 'state=all');
    check('3 HR sees the employee conversation (not the client\'s candidates)', hrI.body.rows.some((x) => x.personType === 'EMPLOYEE') && !hrI.body.rows.some((x) => x.personType === 'CLIENT'), hrI.body.rows && hrI.body.rows.map((x) => x.personType));
    // cascading counts
    r = await inbox(U.sa, 'state=open&q=ZZTEST%20OC');
    const f0 = r.body.facets;
    check('3 facets: channels WhatsApp + SMS both listed with counts', f0.channel.some((x) => x.value === 'SMS' && x.count >= 1) && f0.channel.some((x) => x.value === 'WhatsApp' && x.count >= 1), f0.channel);
    r = await inbox(U.sa, 'state=open&type=CANDIDATE&q=ZZTEST%20OC');
    check('3 pick "Candidate" and the channel list shrinks to the candidate\'s SMS (WhatsApp option disappears)', r.body.facets.channel.every((x) => x.value === 'SMS') && r.body.facets.channel.length === 1, r.body.facets.channel);
    check('3 ...and the Who list still shows all three kinds (counts follow the OTHER filters)', r.body.facets.type.length >= 3, r.body.facets.type);
    r = await inbox(U.sa, 'state=open&channel=WhatsApp&q=ZZTEST%20OC');
    check('3 pick WhatsApp and only the client conversation is listed', r.body.rows.length >= 1 && r.body.rows.every((x) => x.channel === 'WhatsApp'), r.body.rows.map((x) => x.channel));
    r = await inbox(U.sa, 'state=open&department=Education&assigned=me');
    check('3 filter "assigned to me" for a Super Admin who owns nothing -> empty, not an error', r.status === 200 && r.body.rows.length === 0);
    r = await inbox(U.sa, `state=open&from=${Date.now() + 86400000}`);
    check('3 date filter (from tomorrow) -> nothing', r.status === 200 && r.body.rows.length === 0);

    // ---------------- 4. read / done / assign ---------------------------------------------------------------
    r = await L.get(U.tl, `/conversations/person/candidates/${W.c1.c.id}`);
    check('4 TL opens the conversation: timeline has the WhatsApp and the SMS reply', r.status === 200 && r.body.timeline.filter((m) => m.direction === 'in').length === 2, r.status);
    cv = await conv('CANDIDATE', W.c1.c.id);
    check('4 opening it as a non-owner does NOT clear the unread count', Number(cv.unread) === 2);
    r = await L.get(U.rec, `/conversations/person/candidates/${W.c1.c.id}`);
    cv = await conv('CANDIDATE', W.c1.c.id);
    check('4 the person it is assigned to opens it -> read (unread 0)', Number(cv.unread) === 0 && r.body.thread.unread === 0);
    const dn = await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/done`, { done: true });
    check('4 Mark done', dn.status === 200 && dn.body.done === true);
    r = await inbox(U.rec, 'state=open');
    const rd = await inbox(U.rec, 'state=done');
    check('4 done leaves the open list and shows under Done', !r.body.rows.some((x) => x.personId === W.c1.c.id) && rd.body.rows.some((x) => x.personId === W.c1.c.id));
    await E.waInbound(e164, 'One more thing', 'wamid.ZZIN2');
    cv = await conv('CANDIDATE', W.c1.c.id);
    check('4 a new reply re-opens a done conversation and counts as unread', cv.doneAt == null && Number(cv.unread) === 1);
    const asg = await L.get(U.rec, `/conversations/assignees?audience=candidates&id=${W.c1.c.id}`);
    const tlRow = (asg.body.people || []).find((p) => p.id === U.tl.id);
    check('4 the person picker offers people of the area (the TL) and not another department', !!tlRow && !(asg.body.people || []).some((p) => p.id === U.other.id), (asg.body.people || []).map((p) => p.name));
    const give = await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/assign`, { userId: U.tl.id });
    check('4 Assign to the TL', give.status === 200 && give.body.ownerUserId === U.tl.id, give.text);
    const giveBad = await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/assign`, { userId: U.other.id });
    check('4 cannot give it to a person outside the area (403)', giveBad.status === 403, giveBad.status);
    const tlBell = await P.notification.findFirst({ where: { userId: U.tl.id, title: { contains: 'gave you a conversation' } } });
    check('4 the TL is told in the bell', !!tlBell);
    r = await inbox(U.tl, 'state=unread&assigned=me');
    check('4 "Assigned to me" lists it for the TL', r.body.rows.some((x) => x.personId === W.c1.c.id));
    const noAccess = await L.get(U.other, `/conversations/person/candidates/${W.c1.c.id}`);
    check('4 a recruiter of another department cannot open it (403)', noAccess.status === 403);
    await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/assign`, { userId: U.rec.id });

    // ---------------- 5. timeline order ---------------------------------------------------------------------
    const t0 = W.c0;
    const send1 = await L.post(U.rec, '/conversations/send', { audience: 'candidates', id: t0.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: t0.a.id });
    if (send1.body && send1.body.jobId) jobs.push(send1.body.jobId);
    await sleep(60);
    await E.waInbound(`91${t0.c.phone}`, 'Got it, thanks', 'wamid.ZZT0A');
    await sleep(60);
    await E.smsInbound(`91${t0.c.phone}`, 'Which address?');
    await sleep(60);
    await L.post(U.rec, '/followups/quick-log', { candidateId: t0.c.id, applicationId: t0.a.id, channel: 'Call' });
    const tl0 = await L.get(U.rec, `/conversations/person/candidates/${t0.c.id}`);
    const seq = (tl0.body.timeline || []).map((m) => `${m.channel}/${m.direction}`);
    check('5 one timeline in time order: Mail out, WhatsApp in, SMS in, Call', JSON.stringify(seq) === JSON.stringify(['Email/out', 'WhatsApp/in', 'SMS/in', 'Call/out']), seq);
    const ats = (tl0.body.timeline || []).map((m) => new Date(m.at).getTime());
    check('5 times ascend', ats.every((x, i) => i === 0 || x >= ats[i - 1]));
    check('5 each item carries who sent it, the template and the delivery state', tl0.body.timeline[0].who && tl0.body.timeline[0].template && tl0.body.timeline[0].state === 'sent', tl0.body.timeline[0]);

    // delivery ticks show on the message
    const outRow = await P.candidateMessage.findFirst({ where: { candidateId: t0.c.id, channel: 'Email', status: 'SENT' } });
    await P.candidateMessage.update({ where: { id: outRow.id }, data: { status: 'DELIVERED' } });
    const tl0b = await L.get(U.rec, `/conversations/person/candidates/${t0.c.id}`);
    check('5 delivered state reaches the timeline', tl0b.body.timeline[0].state === 'delivered' && /Delivered/.test(tl0b.body.timeline[0].stateWord));

    // ---------------- 6. BEST CHANNEL: order, fallback, rules ---------------------------------------------------
    const best = (u, id, extra) => L.post(u, '/conversations/send', { audience: 'candidates', id, channel: 'Best', applicationId: W.c1.a.id, ...(extra || {}) });
    const track = (res) => { if (res.body && res.body.jobId) jobs.push(res.body.jobId); return res; };
    // a) window open -> WhatsApp first
    let b = track(await best(U.rec, W.c1.c.id, { body: 'Thanks, we will call you.', subject: 'Re' }));
    check('6a window open: WhatsApp first (plain text allowed in the 24 h window)', b.body.ok && b.body.channel === 'WhatsApp' && b.body.attempts.length === 1, JSON.stringify(b.body.attempts));
    // b) window closed -> WhatsApp blocked (needs an approved template), SMS used
    await P.appSetting.deleteMany({ where: { key: { startsWith: 'wa.window.' } } });
    b = track(await best(U.rec, W.c1.c.id, { body: 'Thanks, we will call you.', subject: 'Re' }));
    check('6b no window / no approved template: WhatsApp skipped with the reason, SMS used', b.body.ok && b.body.channel === 'SMS' && b.body.attempts[0].channel === 'WhatsApp' && b.body.attempts[0].status === 'blocked' && /template/i.test(b.body.attempts[0].reason), JSON.stringify(b.body.attempts));
    const smsRow = await P.candidateMessage.findFirst({ where: { candidateId: W.c1.c.id, channel: 'SMS', status: 'SENT' }, orderBy: { createdAt: 'desc' } });
    check('6b the history says which channel was used and why', smsRow && /Best channel/.test(smsRow.statusDetail) && /WhatsApp not used/.test(smsRow.statusDetail), smsRow && smsRow.statusDetail);
    // c) STOP on SMS -> Email
    await E.smsInbound(e164, 'STOP');
    b = track(await best(U.rec, W.c1.c.id, { body: 'Thanks, we will call you.', subject: 'Re' }));
    check('6c they replied STOP on SMS: SMS is blocked, Mail is used', b.body.ok && b.body.channel === 'Email' && b.body.attempts.some((a) => a.channel === 'SMS' && /STOP/.test(a.reason)), JSON.stringify(b.body.attempts));
    const stopOne = await L.post(U.rec, '/conversations/send', { audience: 'candidates', id: W.c1.c.id, channel: 'SMS', body: 'hello', subject: 's', applicationId: W.c1.a.id });
    check('6c a direct SMS to someone who said STOP is refused with the reason', stopOne.body.ok === false && /STOP/.test(stopOne.body.error || ''), stopOne.text.slice(0, 200));
    const stopInTl = await L.get(U.rec, `/conversations/person/candidates/${W.c1.c.id}`);
    check('6c the STOP message is marked in the timeline', stopInTl.body.timeline.some((m) => m.stop), 'no stop');
    // d) preferred channel first
    await P.appSetting.deleteMany({ where: { key: { startsWith: 'msg.optout.' } } });
    await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/preferred`, { channel: 'SMS' });
    b = track(await best(U.rec, W.c1.c.id, { purposeKey: 'FU_INTERVIEW_REMINDER' }));
    check('6d preferred channel SMS is tried first (WhatsApp not even tried)', b.body.ok && b.body.channel === 'SMS' && b.body.attempts.length === 1, JSON.stringify(b.body.attempts));
    await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/preferred`, { channel: 'Email' });
    b = track(await best(U.rec, W.c1.c.id, { purposeKey: 'FU_INTERVIEW_REMINDER' }));
    check('6d preferred channel Mail first', b.body.ok && b.body.channel === 'Email', JSON.stringify(b.body.attempts));
    await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/preferred`, { channel: null });
    // e) consent withdrawn -> every channel blocked, copy fallback
    await P.candidate.update({ where: { id: W.c0.c.id }, data: { doNotContact: true, consentStatus: 'WITHDRAWN' } });
    b = await best(U.rec, W.c0.c.id, { purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c0.a.id });
    check('6e consent withdrawn: nothing is sent on any channel', b.body.ok === false && b.body.attempts.length === 3 && b.body.attempts.every((a) => a.status === 'blocked' && /consent|not to be contacted/i.test(a.reason)), JSON.stringify(b.body.attempts));
    check('6e ...and the screen gets the words to copy (fallback)', b.body.fallback && b.body.fallback.text, b.text.slice(0, 300));
    await P.candidate.update({ where: { id: W.c0.c.id }, data: { doNotContact: false, consentStatus: null } });
    // f) the "Candidate emails" switch
    await P.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: JSON.stringify({ enabled: false }) } });
    b = await best(U.rec, W.c1.c.id, { purposeKey: 'FU_INTERVIEW_REMINDER' });
    check('6f "Candidate emails" switch OFF: nothing goes, reason given', b.body.ok === false && b.body.attempts.every((a) => /switch/i.test(a.reason)), JSON.stringify(b.body.attempts));
    await P.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: JSON.stringify({ enabled: true, dayBefore: false, hourBefore: false }) } });
    // g) nothing is connected
    const savedWa = await P.integration.findUnique({ where: { id: 'whatsapp' } }); const savedSms = await P.integration.findUnique({ where: { id: 'sms' } });
    await P.integration.update({ where: { id: 'whatsapp' }, data: { enabled: false } }); await P.integration.update({ where: { id: 'sms' }, data: { enabled: false } });
    b = track(await best(U.rec, W.c1.c.id, { purposeKey: 'FU_INTERVIEW_REMINDER' }));
    check('6g WhatsApp and SMS not connected: it goes by Mail and says why', b.body.ok && b.body.channel === 'Email' && b.body.attempts.filter((a) => a.status === 'blocked').length === 2 && b.body.attempts.every((a) => a.channel === 'Email' || /not set up|not connected/i.test(a.reason)), JSON.stringify(b.body.attempts));
    await P.integration.update({ where: { id: 'whatsapp' }, data: { enabled: savedWa.enabled } }); await P.integration.update({ where: { id: 'sms' }, data: { enabled: savedSms.enabled } });

    // ---------------- 7. quiet hours -------------------------------------------------------------------------------
    const now = new Date();
    const from = hm(new Date(now.getTime() - 3600000)); const to = hm(new Date(now.getTime() + 3600000));
    const qNo = await L.put(U.rec, '/conversations/settings', { quiet: { enabled: true, from, to } });
    check('7 only an Admin changes the quiet hours (403 for a recruiter)', qNo.status === 403);
    const qOk = await L.put(U.admin, '/conversations/settings', { quiet: { enabled: true, from, to } });
    check('7 Admin sets quiet hours around now', qOk.status === 200 && qOk.body.quiet.from === from, qOk.text);
    const qBad = await L.put(U.admin, '/conversations/settings', { quiet: { from: '25:99' } });
    check('7 a wrong time is refused', qBad.status === 400);
    let q1 = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'BULK_NEW_OPENING', applicationId: W.c1.a.id });
    if (q1.body && q1.body.jobId) jobs.push(q1.body.jobId);
    check('7 a promotional message (new-opening) is held in quiet hours', q1.body.result && q1.body.result.status === 'blocked' && /Quiet hours/.test(q1.body.result.reason), q1.text.slice(0, 200));
    let q2 = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c1.a.id });
    if (q2.body && q2.body.jobId) jobs.push(q2.body.jobId);
    check('7 an interview reminder is NEVER held', q2.body.result && q2.body.result.status === 'sent', q2.text.slice(0, 200));
    let q3 = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'BULK_NEW_OPENING', urgent: true, applicationId: W.c1.a.id });
    if (q3.body && q3.body.jobId) jobs.push(q3.body.jobId);
    check('7 "urgent" lets it through', q3.body.result && q3.body.result.status === 'sent', q3.text.slice(0, 200));
    let q4 = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', subject: 'Hello', body: 'A line written by hand', applicationId: W.c1.a.id });
    if (q4.body && q4.body.jobId) jobs.push(q4.body.jobId);
    check('7 a message written by hand to one person is not held', q4.body.result && q4.body.result.status === 'sent', q4.text.slice(0, 200));
    await L.put(U.admin, '/conversations/settings', { quiet: { enabled: false } });
    let q5 = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'BULK_NEW_OPENING', applicationId: W.c1.a.id });
    if (q5.body && q5.body.jobId) jobs.push(q5.body.jobId);
    check('7 quiet hours OFF: the promotional message goes', q5.body.result && q5.body.result.status === 'sent', q5.text.slice(0, 200));

    // ---------------- 8. daily caps -------------------------------------------------------------------------------------
    const lim = await L.get(U.admin, '/messaging/limits');
    const used = lim.body.usedToday.Email;
    await L.put(U.admin, '/messaging/limits', { Email: { perMinute: 600, perDay: used + 1 }, SMS: { perMinute: 600, perDay: 5000 }, WhatsApp: { perMinute: 600, perDay: 5000 } });
    const c1s = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c1.a.id });
    const c2s = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c1.a.id });
    [c1s, c2s].forEach((x) => { if (x.body && x.body.jobId) jobs.push(x.body.jobId); });
    check('8 the daily cap: the message inside the cap goes, the next is blocked with the reason', c1s.body.result.status === 'sent' && c2s.body.result.status === 'blocked' && /limit/i.test(c2s.body.result.reason), [c1s.body.result, c2s.body.result]);
    await L.put(U.admin, '/messaging/limits', { Email: { perMinute: 600, perDay: 5000 } });

    // ---------------- 9. mailbox (mock IMAP) -> replies in the conversation ---------------------------------------------
    const st0 = await L.get(U.rec, '/conversations/mailbox/status');
    check('9 no inbox connected: the screen can say "Connect an inbox to see replies"', st0.body.configured === false && /inbox/i.test(st0.body.reason || ''), st0.body);
    const pg = await L.get(U.rec, `/conversations/person/candidates/${W.c1.c.id}`);
    check('9 ...and the conversation reports mailboxConnected = false', pg.body.mailboxConnected === false);
    const cfgI = await L.put(U.sa, '/admin/integrations/email-inbox/configure', { values: { 'IMAP host': 'imap.zz-sandbox.in', Port: '993', 'Mailbox address': 'inbox@zz-sandbox.in', 'Password / app key': 'zz-pass' } });
    check('9 a shared inbox can be connected (fake values)', cfgI.status === 200, cfgI.text.slice(0, 200));
    const st1 = await L.get(U.rec, '/conversations/mailbox/status');
    check('9 status: configured', st1.body.configured === true, st1.body);
    // parser
    const parsed = imap.parseMail(mime({ from: 'Anita <Anita.R@Example-Mail.in>', id: '<p1@mail>', body: 'Sure, Monday works.', subject: '=?UTF-8?B?UmU6IEludGVydmlldw==?=' }));
    check('9 parseMail: sender, subject (encoded word), message id, and only the NEW words (quote cut)', parsed.from === 'anita.r@example-mail.in' && parsed.subject === 'Re: Interview' && parsed.messageId === '<p1@mail>' && parsed.text === 'Sure, Monday works.', parsed);
    const multi = imap.parseMail(['From: a@b.in', 'Message-ID: <m2@x>', 'Content-Type: multipart/alternative; boundary="BB"', '', '--BB', 'Content-Type: text/html; charset=utf-8', '', '<p>html version</p>', '--BB', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=C3=A9 plain', '--BB--'].join('\r\n'));
    check('9 parseMail: multipart -> the plain text part, quoted-printable decoded', multi.text === 'Café plain', multi.text);
    // reply matching with a mocked IMAP: three ways to match + three ignores
    const out1 = await P.candidateMessage.create({ data: { candidateId: W.c1.c.id, channel: 'Email', template: 'MANUAL', trigger: 'Manual', recipient: W.c1.c.email, subject: 'About your interview', body: 'x', status: 'SENT', providerRef: '<zz-out-1@zz.local>', sentAt: new Date(), senderUserId: U.rec.id, senderName: U.rec.name } });
    const msgs = [
      { uid: 11, raw: mime({ from: 'someone.else@gmail.zz', id: '<in-1@m>', inReplyTo: '<zz-out-1@zz.local>', body: 'This is Anita writing from my other address.' }) },
      { uid: 12, raw: mime({ from: W.c0.c.email, id: '<in-2@m>', body: 'Reply without headers, matched by the sender address.' }) },
      { uid: 13, raw: mime({ from: W.client.contactEmail, id: '<in-3@m>', body: 'Client contact here: please send profiles.' }) },
      { uid: 14, raw: mime({ from: W.client.billingContactEmail, id: '<in-4@m>', body: 'Billing: invoice received.' }) },
      { uid: 15, raw: mime({ from: 'robot@x.in', id: '<in-5@m>', auto: true, body: 'Out of office' }) },
      { uid: 16, raw: mime({ from: 'inbox@zz-sandbox.in', id: '<in-6@m>', body: 'from ourselves' }) },
      { uid: 17, raw: mime({ from: 'stranger@nowhere.zz', id: '<in-7@m>', body: 'who am I' }) },
      { uid: 18, raw: mime({ from: W.c0.c.email, id: '<in-2@m>', body: 'duplicate of message 2' }) },
    ];
    const unreadBefore = Number((await conv('CANDIDATE', W.c1.c.id)).unread);
    const poll = await imap.pollOnce({ messages: msgs });
    check('9 mock IMAP: 8 read, 4 matched and stored, the rest ignored (auto-reply, ourselves, stranger, duplicate)', poll.read === 8 && poll.matched === 4 && poll.stored === 4 && poll.ignored === 4, poll);
    const rIn1 = await P.candidateMessage.findFirst({ where: { candidateId: W.c1.c.id, status: 'RECEIVED', providerRef: '<in-1@m>' } });
    check('9 matched by In-Reply-To although the sender address is a different one', !!rIn1 && /other address/.test(rIn1.body) && rIn1.channel === 'Email');
    const rIn2 = await P.candidateMessage.findFirst({ where: { candidateId: W.c0.c.id, status: 'RECEIVED', providerRef: '<in-2@m>' } });
    check('9 matched by the sender address', !!rIn2);
    check('9 the candidate conversation: unread went up by 1 (the e-mail reply)', Number((await conv('CANDIDATE', W.c1.c.id)).unread) === unreadBefore + 1);
    const clientIn = await P.$queryRawUnsafe('SELECT "body","channel","address" FROM "ConversationMessage" WHERE "personId" = ? AND "direction" = ? ORDER BY "createdAt"', W.client.id, 'IN');
    check('9 both client addresses (primary and billing) reach the CLIENT conversation', clientIn.filter((x) => x.channel === 'Email').length === 2, clientIn);
    const poll2 = await imap.pollOnce({ messages: msgs });
    check('9 polling the same mailbox again stores nothing twice', poll2.stored === 0, poll2);
    const api1 = await L.post(U.sa, '/conversations/mailbox/poll', { testMessages: [{ uid: 21, raw: mime({ from: W.empRow.email || 'x@x.in', id: '<in-9@m>', body: 'employee mail' }) }] });
    check('9 the sandbox poll endpoint works end to end', api1.status === 200 && api1.body.read === 1, api1.text.slice(0, 200));
    const plainNo = await L.post(U.rec, '/conversations/mailbox/poll', { testMessages: [] });
    check('9 a recruiter with the Contact right may ask for a read now', plainNo.status === 200);
    const pg2 = await L.get(U.rec, `/conversations/person/candidates/${W.c1.c.id}`);
    check('9 the e-mail reply is in the timeline as Mail from them', pg2.body.timeline.some((m) => m.channel === 'Email' && m.direction === 'in' && /other address/.test(m.body)));

    // ---------------- 10. "if no reply in N hours/days" ----------------------------------------------------------------------
    const made = await L.post(U.rec, '/followups', { applicationId: W.c1.a.id, dueDate: '2031-06-01' });
    const aw = track(await L.post(U.rec, '/conversations/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c1.a.id, awaitReply: { value: 2, unit: 'days', next: 'SMS' } }));
    check('10 sent with "if no reply in 2 days, try SMS"', aw.body.ok && aw.body.waiting && aw.body.waiting.until, aw.text.slice(0, 200));
    let fuRow = await P.applicationFollowUp.findFirst({ where: { applicationId: W.c1.a.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
    const dueWant = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 2 * 86400000));
    check('10 the follow-up\'s due date moved to then, with the next step written on it', fuRow && fuRow.dueDate === dueWant && /No reply on Mail: try SMS/.test(fuRow.nextAction), fuRow && [fuRow.dueDate, fuRow.nextAction]);
    cv = await conv('CANDIDATE', W.c1.c.id);
    check('10 the conversation shows it is waiting for a reply', cv.awaitUntil != null && cv.awaitNext === 'SMS');
    let ib = await inbox(U.rec, 'state=waiting');
    check('10 filter "Waiting for a reply" lists it', ib.body.rows.some((x) => x.personId === W.c1.c.id && x.waiting));
    await E.waInbound(e164, 'Sorry, only just saw this', 'wamid.ZZIN3');
    cv = await conv('CANDIDATE', W.c1.c.id);
    fuRow = await P.applicationFollowUp.findFirst({ where: { applicationId: W.c1.a.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
    check('10 a reply stops the waiting and tells the follow-up', cv.awaitUntil == null && /Reply received/.test(fuRow.nextAction), fuRow && fuRow.nextAction);
    // no reply: the wait ends, the owner is told once
    await L.post(U.rec, `/conversations/person/candidates/${W.c1.c.id}/await`, { value: 1, unit: 'hours', next: 'Remind' });
    await P.$executeRawUnsafe('UPDATE "Conversation" SET "awaitUntil" = ? WHERE "personType" = ? AND "personId" = ?', Date.now() - 1000, 'CANDIDATE', W.c1.c.id);
    await L.get(U.rec, '/conversations/unread-count');
    await L.get(U.rec, '/conversations/unread-count');
    const nn = await P.notification.count({ where: { userId: U.rec.id, title: { contains: 'No reply from' } } });
    check('10 nothing came back: the owner gets ONE bell notification', nn === 1, nn);

    // ---------------- 11. a BDE writes to a client contact through the Inbox ------------------------------------------------
    await E.waInbound(cE164, 'Thanks, one more question', 'wamid.ZZCL2');
    const bs = track(await L.post(U.bde, '/conversations/send', { audience: 'clients', id: W.client.id, channel: 'Best', purposeKey: 'FU_CLIENT_REQUIREMENT_FOLLOW_UP', requirementId: W.req.id }));
    check('11 BDE answers the client on the best channel (WhatsApp, the client wrote on it just now)', bs.body.ok && bs.body.channel === 'WhatsApp', bs.text.slice(0, 300));
    const cl = await L.get(U.bde, `/conversations/person/clients/${W.client.id}`);
    check('11 client conversation timeline: their replies and our message in order', cl.body.timeline.length >= 4 && cl.body.timeline.some((m) => m.direction === 'out' && m.channel === 'WhatsApp'), cl.body.timeline.length);
    const tlNoClient = await L.get(U.tl, `/conversations/person/clients/${W.client.id}`);
    check('11 a TL cannot open a client conversation (403)', tlNoClient.status === 403);
    const hrSend = track(await L.post(U.hr, '/conversations/send', { audience: 'employees', id: W.empRow.id, channel: 'Best', purposeKey: 'EMPLOYEE_NOTICE' }));
    check('11 HR writes to an employee on the best channel', hrSend.body.ok, hrSend.text.slice(0, 300));
    // the history of a client message is also on its audit/conversation
    const clRows = await P.$queryRawUnsafe('SELECT "channel","direction","status" FROM "ConversationMessage" WHERE "personId" = ?', W.client.id);
    check('11 every client contact is stored (in and out)', clRows.some((x) => x.direction === 'OUT') && clRows.some((x) => x.direction === 'IN'));

    // ---------------- 12. earlier channel facts the screens rely on --------------------------------------------------------------
    const chs = await L.get(U.rec, '/conversations/channels');
    check('12 channel strip: Mail and (fake) WhatsApp / SMS connected, Call = phone link', chs.body.channels.WhatsApp.configured && chs.body.channels.SMS.configured && chs.body.channels.Call.phoneLink && chs.body.channels.Email.repliesConnected === true, JSON.stringify(chs.body.channels).slice(0, 400));
  } catch (e) {
    console.log('FATAL', e);
    check('no crash', false, e.message);
  } finally {
    try { await P.integration.deleteMany({ where: { id: 'email-inbox' } }); } catch { /* */ }
    try { await E.restore(); } catch (e) { console.log('restore', e.message); }
    jobs.forEach((j) => { for (const ext of ['json', 'delivery', 'cancel']) { try { fs.unlinkSync(path.join(os.homedir(), '.teamlink-sandbox', 'message-jobs', `${j}.${ext}`)); } catch { /* */ } } });
    if (W) console.log(await cleanup());
    console.log(JSON.stringify(L.results()));
    process.exit(0);
  }
})();

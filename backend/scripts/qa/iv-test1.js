// INTERVIEW "NOW TELL THEM" - API tests on the SANDBOX (roles, channels, fallbacks, privacy, notify, reschedule, cancel).
const { build, cleanup, L } = require('./iv-fx');
const E = require('./env');
const { check } = L;
const P = L.prisma;

const bookBody = (date, extra) => ({ round: 1, date, time: '11:45', mode: 'Online', meetingLink: 'https://meet.google.com/abc-defg-hij', panel: [], ...(extra || {}) });
const ymd = (daysAhead) => new Date(Date.now() + daysAhead * 86400000 + 330 * 60000).toISOString().slice(0, 10);

(async () => {
  let W; const saved = {};
  try {
    W = await build();
    const U = W.u;
    // ---- start from "nothing connected": remember and remove the SMS / WhatsApp accounts --------------------------------
    for (const id of ['sms', 'whatsapp']) saved[id] = await P.integration.findUnique({ where: { id } });
    await P.integration.updateMany({ where: { id: { in: ['sms', 'whatsapp'] } }, data: { connected: false, enabled: false, values: null, state: 'Not Connected' } });
    saved.sw = await P.appSetting.findUnique({ where: { key: 'interview-reminders' } });
    saved.lim = await P.appSetting.findUnique({ where: { key: 'message-limits' } });
    await P.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: JSON.stringify({ enabled: true }) }, update: { value: JSON.stringify({ enabled: true }) } });
    await L.put(U.sa, '/messaging/limits', { Email: { perMinute: 600, perDay: 5000 }, SMS: { perMinute: 600, perDay: 5000 }, WhatsApp: { perMinute: 600, perDay: 5000 } });

    const A = await W.mkc('Anita', 'CLIENT_SHORTLISTED', { phone: '9000012345' });
    const panelU = [{ userId: U.rec2.id }];
    // ===== 1. BOOK (via the popup) =====================================================================================
    const book = await L.post(U.admin, `/ats/interviews/${A.a.id}/book`, bookBody(ymd(3), { panel: panelU, viaPopup: true }));
    check('1 book ok (viaPopup)', book.status === 200 && book.body.kind === 'scheduled', book.body);
    const msgs0 = await P.candidateMessage.count({ where: { candidateId: A.c.id } });
    check('1 popup booking: no automatic step message and no automatic candidate email (the window tells them)', msgs0 === 0, `${msgs0} rows`);
    const notes0 = await P.notification.findMany({ where: { userId: { in: [U.tl.id, U.bde.id, U.rec2.id] }, recipient: { startsWith: 'interview|scheduled|' } } });
    check('1 team got the automatic app notice (tl, bde, panel)', notes0.length >= 3, notes0.map((n) => n.userId));

    // ===== 2. THE WINDOW PER ROLE ===========================================================================================
    const ROLES = ['rec', 'tl', 'bde', 'bdetl', 'admin', 'sa', 'mgr'];
    const T = {};
    for (const r of ROLES) T[r] = await L.get(U[r], `/ats/interviews/${A.a.id}/tell`);
    for (const r of ROLES) check(`2 ${r}: window opens`, T[r].status === 200 && T[r].body.candidate, `${T[r].status} ${T[r].text.slice(0, 200)}`);
    const direct = ['rec', 'tl', 'admin', 'sa', 'mgr'];
    const masked = ['bde', 'bdetl'];
    direct.forEach((r) => {
      const c = T[r].body.candidate;
      check(`2 ${r}: sees the number (direct) and four buttons`, !c.masked && c.phone === '9000012345' && ['Call', 'WhatsApp', 'SMS', 'Email'].every((k) => c.channels[k]), c);
    });
    masked.forEach((r) => {
      const c = T[r].body.candidate;
      const raw = T[r].text;
      check(`2 ${r}: masked, hint only`, c.masked === true && !!c.phoneHint && !!c.emailHint && c.phone === undefined && c.email === undefined, c);
      check(`2 ${r}: the payload carries NO candidate phone or email anywhere`, !raw.includes('9000012345') && !raw.includes(A.c.email), raw.slice(0, 200));
    });
    check('2 canNotify: only whoever books (BDE / BDE TL / Admin / SA) yes; Recruiter / TL / Manager no (user, 2026-10-12)', ['bde', 'bdetl', 'admin', 'sa'].every((r) => T[r].body.canNotify === true) && ['rec', 'tl', 'mgr'].every((r) => T[r].body.canNotify === false));
    const pb = T.rec.body.parties.map((p) => p.roleLine).join(' | ');
    check('2 the four parties: recruiter, TL, BDE and the interviewer are listed', /Recruiter/.test(pb) && /Team lead/.test(pb) && /Client manager \(BDE\)/.test(pb) && /Interviewer/.test(pb), pb);
    const tlRow = T.rec.body.parties.find((p) => p.name.includes('IV tl'));
    check('2 already-told shown: "App notice sent automatically" for the TL and for the recruiter (the booker is the BDE / Admin now: not in the list)', tlRow && tlRow.notified && /App notice/.test(tlRow.notified.how) && !!T.rec.body.parties.find((p) => p.you).notified, T.rec.body.parties);
    // ---- the words: no client name for the candidate, real details --------------------------------------------------------
    const prev = T.rec.body.candidate.preview.text;
    const clientName = W.client.name;
    check('2 candidate wording says "our client", never the client name', /our client/.test(prev) && !prev.includes(clientName), prev);
    check('2 wording has round, when, where (join link), interviewer, who to ask, reply OK', /Round: 1/.test(prev) && /When: /.test(prev) && /join here: https:\/\/meet\.google\.com\/abc-defg-hij/.test(prev) && /Interviewer: .*IV rec2/.test(prev) && /ZZTEST IV rec, 9000000/.test(prev) && /reply OK/i.test(prev), prev);
    // ---- not connected: honest fallbacks ---------------------------------------------------------------------------------
    const chs = T.rec.body.candidate.channels;
    check('2 nothing connected: WhatsApp + SMS fall back (own app / copy), Mail sends (fake transport)', chs.WhatsApp.state === 'fallback' && chs.SMS.state === 'fallback' && chs.Email.state === 'send', Object.fromEntries(Object.entries(chs).map(([k, v]) => [k, `${v.state} ${v.reason || ''}`])));
    check('2 BDE not connected: "ask the recruiter" instead of opening an app', T.bde.body.candidate.channels.WhatsApp.state === 'fallback' && T.bde.body.candidate.channels.WhatsApp.ask === true && T.bde.body.candidate.channels.Call.ask === true, T.bde.body.candidate.channels);

    // ===== 3. THE MESSAGING MODULE: preview + send, per channel ==========================================================
    for (const channel of ['Email', 'SMS', 'WhatsApp']) {
      const pv = await L.post(U.rec, '/messaging/preview', { audience: 'candidates', ids: [A.c.id], channels: [channel], kind: 'individual', purposeKey: 'INTERVIEW_BOOKED', applicationId: A.a.id });
      const first = pv.body && pv.body.first;
      check(`3 ${channel} preview through /messaging/preview is filled and client-free`, pv.status === 200 && first && !first.text.includes(clientName) && /our client/.test(first.text) && !/\{\{/.test(first.text), pv.body);
    }
    // connect fake SMS + WhatsApp, approve the WhatsApp wording for this purpose
    await E.setup(U.sa);
    const wt = await P.messageTemplate.findFirst({ where: { purpose: 'INTERVIEW_BOOKED', channel: 'WhatsApp', language: 'English' } });
    const st = await L.put(U.admin, `/messaging/templates/${wt.id}`, { waTemplateName: 'interview_booked', waStatus: 'Approved', waLanguageCode: 'en', changeNote: 'test' });
    check('3 admin marks the WhatsApp wording Approved', st.status === 200, st.body);
    const T2 = await L.get(U.rec, `/ats/interviews/${A.a.id}/tell`);
    check('3 all three channels now "send from here"', ['WhatsApp', 'SMS', 'Email'].every((k) => T2.body.candidate.channels[k].state === 'send'), Object.fromEntries(Object.entries(T2.body.candidate.channels).map(([k, v]) => [k, `${v.state} ${v.reason || ''}`])));
    for (const channel of ['Email', 'SMS', 'WhatsApp']) {
      const sd = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: A.c.id, channel, kind: 'individual', purposeKey: 'INTERVIEW_BOOKED', applicationId: A.a.id });
      check(`3 ${channel} send via the messaging module: Sent (fake transport)`, sd.status === 200 && sd.body.result && sd.body.result.status === 'sent' && sd.body.result.sandbox === true, sd.body);
    }
    const rows3 = await P.candidateMessage.findMany({ where: { candidateId: A.c.id }, orderBy: { createdAt: 'asc' } });
    check('3 each send is logged on the candidate history with the interview label', ['Email', 'SMS', 'WhatsApp'].every((c) => rows3.some((r) => r.channel === c && r.status === 'SENT' && r.templateLabel === 'Interview booked')), rows3.map((r) => `${r.channel}:${r.status}:${r.templateLabel}`));
    check('3 no logged candidate text carries the client name', rows3.every((r) => !String(r.body || '').includes(clientName) && !String(r.subject || '').includes(clientName)));
    const T3 = await L.get(U.rec, `/ats/interviews/${A.a.id}/tell`);
    check('3 the window now shows per-channel status (Sent) and "already told"', T3.body.candidate.alreadyTold === true && T3.body.candidate.told.some((t) => t.channel === 'WhatsApp' && t.word === 'Sent'), T3.body.candidate.told);

    // ===== 4. SEND ON ALL AVAILABLE CHANNELS =================================================================================
    const B = await W.mkc('Bina', 'CLIENT_SHORTLISTED', { phone: '9000012346' });
    await L.post(U.admin, `/ats/interviews/${B.a.id}/book`, bookBody(ymd(4), { viaPopup: true, panel: panelU }));
    const all = await L.post(U.rec, `/ats/interviews/${B.a.id}/tell/send-all`, { kind: 'scheduled' });
    check('4 send-all: Mail + WhatsApp + SMS all sent', all.status === 200 && ['Email', 'WhatsApp', 'SMS'].every((k) => all.body.attempts.find((a) => a.channel === k && a.status === 'sent')), all.body);
    const all2 = await L.post(U.rec, `/ats/interviews/${B.a.id}/tell/send-all`, { kind: 'scheduled' });
    check('4 send-all a second time: nobody is told twice ("already")', all2.body.attempts.every((a) => a.status === 'already') && all2.body.sent === 0, all2.body);
    const all3 = await L.post(U.rec, `/ats/interviews/${B.a.id}/tell/send-all`, { kind: 'scheduled', again: true });
    check('4 send-all with "again" sends again on purpose', all3.body.sent === 3, all3.body);
    // BDE (masked) sends through the server
    const Cc = await W.mkc('Charu', 'CLIENT_SHORTLISTED', { phone: '9000012347' });
    await L.post(U.admin, `/ats/interviews/${Cc.a.id}/book`, bookBody(ymd(4), { viaPopup: true, panel: panelU }));
    const allB = await L.post(U.bde, `/ats/interviews/${Cc.a.id}/tell/send-all`, { kind: 'scheduled' });
    check('4 BDE: send-all works through the server (masked) and the answer carries no number', allB.status === 200 && allB.body.sent === 3 && !allB.text.includes('9000012347') && !allB.text.includes(Cc.c.email), allB.text.slice(0, 300));
    const bj = await L.post(U.bde, '/messaging/send', { audience: 'candidates', id: Cc.c.id, channel: 'SMS', kind: 'individual', purposeKey: 'INTERVIEW_BOOKED', applicationId: Cc.a.id });
    check('4 BDE via /messaging/send: masked address in the answer', bj.status === 200 && bj.body.masked === true && bj.body.result && !String(bj.body.result.address).includes('9000012347'), bj.body);

    // ===== 5. BLOCKS: consent, STOP, switch ==============================================================================
    const D = await W.mkc('Dev', 'CLIENT_SHORTLISTED', { phone: '9000012348' });
    await L.post(U.admin, `/ats/interviews/${D.a.id}/book`, bookBody(ymd(4), { viaPopup: true, panel: panelU }));
    await P.candidate.update({ where: { id: D.c.id }, data: { consentStatus: 'WITHDRAWN' } });
    const TD = await L.get(U.rec, `/ats/interviews/${D.a.id}/tell`);
    check('5 consent withdrawn: window says so, every channel blocked with the plain reason', TD.body.candidate.doNotContact === true && ['WhatsApp', 'SMS', 'Email'].every((k) => TD.body.candidate.channels[k].state === 'blocked' && /not to be contacted/.test(TD.body.candidate.channels[k].reason)) && TD.body.candidate.channels.Call.state === 'blocked', TD.body.candidate.channels);
    const aD = await L.post(U.rec, `/ats/interviews/${D.a.id}/tell/send-all`, { kind: 'scheduled' });
    check('5 consent withdrawn: send-all sends nothing', aD.body.sent === 0 && aD.body.attempts.every((a) => a.status === 'blocked'), aD.body);
    await P.candidate.update({ where: { id: D.c.id }, data: { consentStatus: 'GRANTED' } }).catch(() => P.candidate.update({ where: { id: D.c.id }, data: { consentStatus: null } }));
    await P.appSetting.upsert({ where: { key: 'msg.optout.WhatsApp.919000012348' }, create: { key: 'msg.optout.WhatsApp.919000012348', value: JSON.stringify({ at: new Date().toISOString(), text: 'STOP' }) }, update: {} });
    const TS = await L.get(U.rec, `/ats/interviews/${D.a.id}/tell`);
    check('5 STOP on WhatsApp: that button says so, Mail still works', TS.body.candidate.channels.WhatsApp.state === 'blocked' && /STOP/.test(TS.body.candidate.channels.WhatsApp.reason) && TS.body.candidate.channels.Email.state === 'send', TS.body.candidate.channels.WhatsApp);
    await P.appSetting.deleteMany({ where: { key: 'msg.optout.WhatsApp.919000012348' } });
    await P.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: JSON.stringify({ enabled: false }) } });
    const TO = await L.get(U.rec, `/ats/interviews/${D.a.id}/tell`);
    check('5 "Candidate emails" switch off: Mail is blocked with the reason', TO.body.candidate.channels.Email.state === 'blocked' && /Candidate emails/.test(TO.body.candidate.channels.Email.reason) && TO.body.candidate.switchOn === false, TO.body.candidate.channels.Email);
    await P.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: JSON.stringify({ enabled: true }) } });

    // ===== 6. THE TEAM ===================================================================================================
    const N = await L.post(U.admin, `/ats/interviews/${A.a.id}/tell/notify`, { kind: 'scheduled', who: 'all' });
    check('6 Notify all (by the booker, Admin: not one of the four): recruiter, TL, BDE and interviewer ALL get bell + mail', N.status === 200 && N.body.results.length === 4 && N.body.results.filter((r) => r.bell && r.email && r.email.ok).length === 4, N.body);
    const bells = await P.notification.findMany({ where: { recipient: { startsWith: `interview-notify|scheduled|${A.a.id}|` } } });
    check('6 bell rows written (one per person)', bells.length === 4, bells.length);
    const bellBde = bells.find((b) => b.userId === U.bde.id);
    check('6 staff text names the client; carries no candidate phone/email', bellBde && bellBde.message.includes(clientName) && !bellBde.message.includes('9000012345') && !bellBde.message.includes(A.c.email), bellBde && bellBde.message);
    const N1 = await L.post(U.bde, `/ats/interviews/${A.a.id}/tell/notify`, { kind: 'scheduled', who: [U.tl.id] });
    check('6 the BDE can tell one person', N1.status === 200 && N1.body.results.length === 1 && N1.body.results[0].bell, N1.body);
    const Nm = await L.post(U.mgr, `/ats/interviews/${A.a.id}/tell/notify`, { kind: 'scheduled', who: 'all' });
    check('6 Manager (view + approve only): cannot notify', Nm.status === 403, Nm.body);
    const Nh = await L.post(U.hr, `/ats/interviews/${A.a.id}/tell/notify`, { kind: 'scheduled', who: 'all' });
    check('6 outside the area: refused', [403, 404].includes(Nh.status), Nh.status);
    const T6 = await L.get(U.rec, `/ats/interviews/${A.a.id}/tell`);
    check('6 window shows "You told them" after Notify', T6.body.parties.some((p) => p.notified && /You told them/.test(p.notified.how)), T6.body.parties);

    // ===== 7. COPIED / DONE / STATUS =======================================================================================
    check('7 BDE cannot copy the words (masked): refused', (await L.post(U.bde, `/ats/interviews/${Cc.a.id}/tell/copied`, { kind: 'scheduled', channel: 'SMS' })).status === 403);
    const E3 = await W.mkc('Esha', 'CLIENT_SHORTLISTED', { phone: '9000012349' });
    await L.post(U.admin, `/ats/interviews/${E3.a.id}/book`, bookBody(ymd(5), { viaPopup: true, panel: panelU }));
    const cp2 = await L.post(U.rec, `/ats/interviews/${E3.a.id}/tell/copied`, { kind: 'scheduled', channel: 'SMS' });
    const T7 = await L.get(U.rec, `/ats/interviews/${E3.a.id}/tell`);
    check('7 "copied" is logged and counts as told (Copied)', cp2.status === 200 && T7.body.candidate.told.some((t) => t.channel === 'SMS' && t.word === 'Copied' && t.told), T7.body.candidate.told);
    const dn = await L.post(U.rec, `/ats/interviews/${E3.a.id}/tell/done`, { kind: 'scheduled' });
    check('7 done reports told', dn.status === 200 && dn.body.told === true, dn.body);
    const stt = await L.post(U.rec, '/ats/interviews/tell/status', { applicationIds: [A.a.id, E3.a.id, D.a.id] });
    check('7 bulk status: who was told', stt.status === 200 && stt.body.rows.length === 3 && stt.body.rows.find((r) => r.applicationId === E3.a.id).told === true, stt.body);

    // ===== 8. THE OLD PATH (no popup) never names the client to the candidate ============================================
    const F = await W.mkc('Farah', 'CLIENT_SHORTLISTED', { phone: '9000012350' });
    const old = await L.post(U.admin, `/ats/interviews/${F.a.id}/book`, bookBody(ymd(5), { panel: panelU }));
    check('8 booking without the popup flag still works', old.status === 200, old.body);
    const wa = (old.body.whatsapp || []).find((w) => w.to === 'candidate');
    check('8 the wa.me text for the candidate has no client name', wa && !wa.text.includes(clientName) && /our client/.test(wa.text), wa && wa.text);
    const em = await P.candidateMessage.findMany({ where: { candidateId: F.c.id } });
    check('8 the candidate messages (old path) have no client name', em.length > 0 && em.every((r) => !String(r.body || '').includes(clientName) && !String(r.subject || '').includes(clientName)), em.map((r) => r.body));
    const sn = await P.notification.findFirst({ where: { userId: U.tl.id, recipient: `interview|scheduled|${F.a.id}` } });
    check('8 staff notices still name the client', sn && sn.message.includes(clientName), sn && sn.message);

    // ===== 9. RESCHEDULE + CANCEL ========================================================================================
    const newAt = `${ymd(6)}T15:30`;
    const rs = await L.post(U.admin, `/ats/interviews/${A.a.id}/reschedule`, { interviewAt: new Date(`${newAt}:00+05:30`).toISOString(), reason: 'Panel busy', viaPopup: true });
    check('9 reschedule ok', rs.status === 200, rs.body);
    const TR = await L.get(U.rec, `/ats/interviews/${A.a.id}/tell`);
    check('9 window opens as "rescheduled" with the new time', TR.body.kind === 'rescheduled' && /3:30 pm/.test(TR.body.interview.when) && TR.body.purposeLabel === 'Interview moved', TR.body.interview);
    check('9 moved-wording: "new time", the new slot, no client, no internal reason', /new time/i.test(TR.body.candidate.preview.text) && /3:30 pm/.test(TR.body.candidate.preview.text) && !TR.body.candidate.preview.text.includes(clientName) && !/Panel busy/.test(TR.body.candidate.preview.text), TR.body.candidate.preview.text);
    check('9 not told yet about the move (earlier booking messages do not count)', TR.body.candidate.alreadyTold === false, TR.body.candidate.told);
    const rsMsgs = await P.candidateMessage.count({ where: { candidateId: A.c.id, createdAt: { gte: new Date(Date.now() - 20000) }, templateLabel: { contains: 'moved' } } });
    check('9 reschedule via the popup sent no automatic candidate email', rsMsgs === 0);
    const sendR = await L.post(U.rec, '/messaging/send', { audience: 'candidates', id: A.c.id, channel: 'Email', kind: 'individual', purposeKey: 'INTERVIEW_MOVED', applicationId: A.a.id });
    check('9 moved message sends through the messaging module', sendR.status === 200 && sendR.body.result.status === 'sent', sendR.body);
    const TR2 = await L.get(U.rec, `/ats/interviews/${A.a.id}/tell`);
    check('9 then it counts as told', TR2.body.candidate.alreadyTold === true);
    const cx = await L.post(U.admin, `/ats/interviews/${B.a.id}/cancel`, { reason: 'Client changed plan - internal reason XYZ', viaPopup: true });
    check('9 cancel ok', cx.status === 200, cx.body);
    const TC = await L.get(U.rec, `/ats/interviews/${B.a.id}/tell`);
    check('9 window opens as "cancelled"', TC.body.kind === 'cancelled' && TC.body.purposeLabel === 'Interview cancelled', TC.body.kind);
    check('9 cancel wording: "cancelled", no client, no internal reason', /cancelled/.test(TC.body.candidate.preview.text) && !TC.body.candidate.preview.text.includes(clientName) && !/XYZ/.test(TC.body.candidate.preview.text), TC.body.candidate.preview.text);
    const NC = await L.post(U.admin, `/ats/interviews/${B.a.id}/tell/notify`, { kind: 'cancelled', who: 'all' });
    check('9 team told about the cancel', NC.status === 200 && NC.body.results.some((r) => r.bell), NC.body);

    // ===== 10. SETTINGS =============================================================================================
    const g = await L.get(U.rec, '/ats/interview-reminder-plan');
    check('10 anyone on the calendar can read the plan', g.status === 200 && g.body.plan.candidate.channels.length === 3 && g.body.plan.digestAt === '08:30' && g.body.canEdit === false, g.body);
    check('10 recruiter cannot change it', (await L.put(U.rec, '/ats/interview-reminder-plan', { digestAt: '09:00' })).status === 403);
    const pu = await L.put(U.hr, '/ats/interview-reminder-plan', { digestAt: '09:00', parties: { bde: { whatsapp: true } } });
    check('10 HR can change it', pu.status === 200 && pu.body.plan.digestAt === '09:00' && pu.body.plan.parties.bde.whatsapp === true && pu.body.plan.parties.tl.whatsapp === false, pu.body);
    check('10 a bad time is refused in plain words', (await L.put(U.sa, '/ats/interview-reminder-plan', { digestAt: '25:99' })).status === 400);
    await L.put(U.sa, '/ats/interview-reminder-plan', { digestAt: '08:30', parties: { bde: { whatsapp: false } } });
  } catch (e) { console.log('ERR', e); } finally {
    try {
      await E.restore();
      for (const id of ['sms', 'whatsapp']) {
        if (saved[id]) await P.integration.update({ where: { id }, data: { values: saved[id].values, connected: saved[id].connected, enabled: saved[id].enabled, state: saved[id].state } }).catch(() => {});
      }
      await P.appSetting.deleteMany({ where: { key: 'interview-reminder-plan' } });
      if (saved.lim) await P.appSetting.update({ where: { key: 'message-limits' }, data: { value: saved.lim.value } }).catch(() => {});
    } catch (e) { console.log('restore', e.message); }
    const tmpl = await P.messageTemplate.findFirst({ where: { purpose: 'INTERVIEW_BOOKED', channel: 'WhatsApp', language: 'English' } }).catch(() => null);
    if (tmpl) await P.messageTemplate.update({ where: { id: tmpl.id }, data: { waStatus: 'None', waTemplateName: null } }).catch(() => {});
    console.log('CLEAN', JSON.stringify(await cleanup()));
    console.log('RESULT', JSON.stringify(L.results()));
    await P.$disconnect();
  }
})();

// Item 6: the BDE team must never obtain a candidate's phone / e-mail through interview booking.
module.exports = async function secBooking({ check, call, mkUser, mint, made, prisma, RUN }) {
  console.log('\n--- 6: BDE interview booking sentinel scan ---');
  const PHONE = '9011223355';
  const EMAIL = `zz-sec-sentinel-${RUN}@example.test`;
  const ids = { clients: [], reqs: [], cands: [], apps: [] };
  made.extra.push(async () => {
    const A = ids.apps;
    if (A.length) {
      for (const m of ['candidateMessage']) await prisma[m].deleteMany({ where: { OR: [{ applicationId: { in: A } }, { candidateId: { in: ids.cands } }] } }).catch(() => {});
      for (const m of ['interviewFeedback', 'applicationStageEvent', 'interviewEvent', 'applicationFollowUp']) await prisma[m].deleteMany({ where: { applicationId: { in: A } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: A } } });
    }
    await prisma.candidate.deleteMany({ where: { id: { in: ids.cands } } });
    await prisma.requirement.deleteMany({ where: { id: { in: ids.reqs } } });
    await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  });
  const tl = await mkUser('BKBdeTl', { role: 'TL', atsRole: 'TL', atsAccess: true, atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  const bde = await mkUser('BKBde', { role: 'EMPLOYEE', atsRole: 'BDE', atsAccess: true, atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { designation: 'BDE', department: 'BDE', tl: tl.u.name });
  const rec = await mkUser('BKRec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'Recruiter', department: 'Education' });
  const adm = await mkUser('BKAdmin', { role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Admin' });
  const client = await prisma.client.create({ data: { name: `ZZTEST Sec BK Client ${RUN}`, location: 'ZZ', ownerDepartment: 'Education', bdeOwner: bde.u.name, clientType: 'Client' } });
  ids.clients.push(client.id);
  const rq = await prisma.requirement.create({ data: { title: `ZZTEST Sec BK Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: rec.u.id, bdeId: bde.u.id, tlId: tl.u.id, openings: 1 } });
  ids.reqs.push(rq.id);
  const T = { bde: await mint(bde.u), tl: await mint(tl.u), adm: await mint(adm.u), rec: await mint(rec.u) };
  const day = (n) => new Date(Date.now() + n * 86400000 + 330 * 60000).toISOString().slice(0, 10);
  const mkApp = async (tag) => {
    const c = await prisma.candidate.create({ data: { name: `ZZTEST Sec BK Cand ${tag} ${RUN}`, email: EMAIL.replace('sentinel', `sentinel${tag}`), phone: PHONE, currentSalary: '7L', expectedSalary: '9L', location: 'ZZ' } });
    ids.cands.push(c.id);
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: rq.id, stage: 'CLIENT_SHORTLISTED' } });
    ids.apps.push(a.id);
    return a;
  };
  const leaks = (r) => ['9011223355', '919011223355', 'wa.me/91', 'sentinel'].filter((s) => String(r.text || '').toLowerCase().includes(s.toLowerCase()));
  const ctx = (r) => { const t = String(r.text || ''); const i = t.toLowerCase().search(/9011223355|wa\.me\/91|sentinel/); return i < 0 ? '' : t.slice(Math.max(0, i - 120), i + 80); };
  const scan = (name, r) => check(`${name}: no candidate phone / wa.me / e-mail in the answer (HTTP ${r.status})`, leaks(r).length === 0, `${leaks(r)} ${ctx(r)}`);

  for (const who of ['bde', 'tl']) {
    const a = await mkApp(who);
    const book = await call('POST', `/api/ats/interviews/${a.id}/book`, T[who], { date: day(2), time: '11:00', mode: 'Online', meetingLink: 'https://meet.google.com/zzs-ecte-stt', interviewer: 'ZZ Panel', viaPopup: true });
    check(`${who}: booking is allowed or refused by role (${book.status})`, [200, 403].includes(book.status), book.text.slice(0, 120));
    scan(`${who} book`, book);
    if (book.status === 200 && book.body && book.body.whatsapp) {
      const cw = book.body.whatsapp.find((l) => l.to === 'candidate');
      check(`${who}: the candidate entry carries no phone and no wa.me link`, !cw || (!cw.phone && !cw.url), cw);
    }
    scan(`${who} bookable search by phone`, await call('GET', `/api/ats/interviews/bookable?q=${PHONE}`, T[who]));
    const bk = await call('GET', `/api/ats/interviews/bookable?q=${PHONE}`, T[who]);
    check(`${who}: searching by the phone number finds nobody`, bk.status !== 200 || !(bk.body.rows || []).some((r) => r.candidate && String(r.candidate.name).includes(`BK Cand ${who}`)), bk.text.slice(0, 120));
    const wl = await call('POST', `/api/ats/interviews/${a.id}/whatsapp-log`, T[who], { to: 'candidate' });
    scan(`${who} whatsapp-log`, wl);
    check(`${who}: the candidate WhatsApp log is refused`, wl.status === 403, wl.status);
    scan(`${who} tell window`, await call('GET', `/api/ats/interviews/${a.id}/tell?kind=scheduled`, T[who]));
    scan(`${who} tell notify`, await call('POST', `/api/ats/interviews/${a.id}/tell/notify`, T[who], { kind: 'scheduled', who: 'all' }));
    const cp = await call('POST', `/api/ats/interviews/${a.id}/tell/copied`, T[who], { kind: 'scheduled', channel: 'WhatsApp' });
    scan(`${who} tell copied`, cp);
    check(`${who}: "copied the words" is refused`, cp.status === 403, cp.status);
    scan(`${who} tell send-all`, await call('POST', `/api/ats/interviews/${a.id}/tell/send-all`, T[who], { kind: 'scheduled' }));
    scan(`${who} tell status`, await call('POST', '/api/ats/interviews/tell/status', T[who], { applicationIds: [a.id] }));
    scan(`${who} reschedule`, await call('POST', `/api/ats/interviews/${a.id}/reschedule`, T[who], { interviewAt: `${day(3)}T12:00:00+05:30`, reason: 'ZZTEST sec' }));
    scan(`${who} calendar`, await call('GET', '/api/ats/calendar', T[who]));
    scan(`${who} interview prep`, await call('GET', `/api/ats/interviews/${a.id}/prep`, T[who]));
    scan(`${who} ask-book`, await call('GET', `/api/ats/interviews/${a.id}/ask-book`, T[who]));
    scan(`${who} candidate communications`, await call('GET', `/api/candidates/${a.candidateId}/communications`, T[who]));
    scan(`${who} candidate record`, await call('GET', `/api/candidates/${a.candidateId}`, T[who]));
    scan(`${who} application`, await call('GET', `/api/applications/${a.id}`, T[who]));
    scan(`${who} conversation timeline`, await call('GET', `/api/conversations/person/candidates/${a.candidateId}`, T[who]));
    scan(`${who} messaging preview`, await call('POST', '/api/messaging/preview', T[who], { audience: 'candidates', id: a.candidateId, channel: 'WhatsApp', applicationId: a.id }));
    scan(`${who} follow-ups`, await call('GET', '/api/followups', T[who]));
    scan(`${who} notifications`, await call('GET', '/api/admin/notifications', T[who]));
    const nb = await prisma.notification.findMany({ where: { userId: (who === 'bde' ? bde : tl).u.id }, select: { title: true, message: true } });
    check(`${who}: stored notification bodies hold no phone / wa.me / e-mail`, !JSON.stringify(nb).match(/9011223355|wa\.me|sentinel/i), nb.length);
  }
  // control: a login that MAY see the number does get it on a booking (proves the scan can see a leak)
  const ac = await mkApp('adm');
  const bookA = await call('POST', `/api/ats/interviews/${ac.id}/book`, T.adm, { date: day(2), time: '12:00', mode: 'In Person', location: 'ZZ Office', interviewer: 'ZZ Panel', viaPopup: true });
  check('control: Admin booking DOES carry the phone (the scan is able to see a leak)', bookA.status === 200 && leaks(bookA).length > 0, `${bookA.status} ${bookA.text.slice(0, 100)}`);
};

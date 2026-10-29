#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONE COMPANY, MANY LOCATIONS (user, 2026-10-22). SANDBOX ONLY - a copy of the database, never dev.db.
//
//   cd backend
//   node -e "<VACUUM INTO prisma/zz-clientloc.db>"   (or: npm run sandbox -- --copy-only, then TL_TEST_DB=sandbox.db)
//   PORT=4061 DATABASE_URL=file:<abs>/prisma/zz-clientloc.db TEST_MODE=1 node src/index.js
//   TL_API=http://localhost:4061 TL_TEST_DB=zz-clientloc.db node scripts/client-add-location-test.js
//
// Adding a client whose name exists already is a QUESTION, not an error:
//   409 + question (the matching clients with id / name / location / agreement / requirements / why) -> the form asks
//   "Do you still want to add another one (another location / branch)?". Confirmed (confirmSeparate, or the older
//   allowDuplicate) it becomes its OWN client. Same name needs a Location; same name AND same location needs one line why.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('CL');
const { prisma, call, check } = Z;
const CLOC = require('../src/utils/clientLocations');

(async () => {
  await Z.preclean();
  try {
    const { RUN } = Z;
    const ok = (r) => r.status >= 200 && r.status < 300;
    const sa = await Z.mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const bdeTl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: bdeTl.name });
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const acc = await Z.mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' }, {});
    const T = { sa: await Z.mint(sa), bde: await Z.mint(bde), rec: await Z.mint(rec), acc: await Z.mint(acc) };

    const NAME = `ZZTEST CL Palnadu Hospital ${RUN}`;
    const UNIQUE = `ZZTEST CL Lonely Clinic ${RUN}`;
    const PHONE = `98${String(Math.floor(10000000 + Math.random() * 89999999))}`;
    const GST = '36AABCZ1234C1Z5';
    const post = (body, tok = T.sa) => call('POST', '/api/clients', tok, { mode: 'draft', ownerDepartment: 'Education', ...body });
    const snap = async (id) => JSON.stringify(await prisma.client.findUnique({ where: { id } }));
    const audits = (id) => prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } });

    // ===== 1. a unique name goes in as before - no question =====
    const u = await post({ name: UNIQUE, location: 'Guntur' });
    check('A1 a unique name is added at once (201), no question', u.status === 201 && !u.body.question, [u.status, u.body && u.body.error]);
    Z.made.clients.push(u.body.id);

    // ===== 2. the first Palnadu Hospital =====
    const a = await post({ name: NAME, location: 'Narasaraopet', state: 'Andhra Pradesh', contactPhone: PHONE, gst: GST });
    check('A2 the first Palnadu Hospital is added (201)', a.status === 201, [a.status, a.body && a.body.error]);
    Z.made.clients.push(a.body.id);
    const before = await snap(a.body.id);
    const aliasesBefore = await prisma.clientAlias.count({ where: { clientId: a.body.id } });

    // ===== 3. same name, DIFFERENT location: added at once, no question (founder 2026-10-29: "same client, different
    //            locations - add chesthuntey already exists ani raakudadhu") - the audit row still links the two =====
    const q0 = await post({ name: NAME, location: 'Guntur', state: 'Andhra Pradesh' });
    check('B0 same name at another location -> 201 at once, no "already exists"', q0.status === 201, [q0.status, q0.body && q0.body.error]);
    const q0a = q0.body && q0.body.id ? (await audits(q0.body.id)).find((x) => /^Added as another location of /.test(x.action)) : null;
    check('B0b ... and its audit row says which client it is another location of', !!q0a && q0a.fromValue === a.body.id, q0a);
    if (q0.body && q0.body.id) { await prisma.auditLog.deleteMany({ where: { entityId: q0.body.id } }); await prisma.client.delete({ where: { id: q0.body.id } }); }
    // with NO location typed it is still a QUESTION (409), never a bare string
    const q1 = await post({ name: NAME });
    const Q = q1.body && q1.body.question;
    check('B1 same name, no location -> 409', q1.status === 409, [q1.status, q1.body]);
    check('B2 the body is structured: question with level sameName + matches[]', !!Q && Q.level === 'sameName' && Array.isArray(Q.matches) && Q.matches.length === 1, Q);
    const m0 = Q && Q.matches[0];
    check('B3 the match card has id, name, location, agreement status, requirements count and the reasons', !!m0 && m0.id === a.body.id && m0.name === NAME && m0.location === 'Narasaraopet' && !!m0.agreementStatus && m0.requirementsCount === 0 && Array.isArray(m0.reasons) && m0.reasons.some((r) => r.label === 'Same name'), m0);
    check('B4 the text asks plainly: "This client already exists (name, location) ... add another one (another location / branch)?"', /This client already exists \(.*Narasaraopet\)\. Do you still want to add another one/.test(Q.text) && /^This client already exists \(.*Narasaraopet\)\. Do you still want to add another one \(another location \/ branch\)\?$/.test(q1.body.error), [Q && Q.text, q1.body.error]);
    check('B5 buttons + footer line are the plain ones; no "Possible duplicate" / "blocked"', Q.yesLabel === 'Yes, add another location' && Q.noLabel === 'No, open the existing client' && Q.hint === 'A client with this name already exists. Choose Yes to add another location.' && !/Possible duplicate|blocked/i.test(JSON.stringify(Q)), Q);
    check('B6 no location was typed, so the question asks for one', Q.needsLocation === true && Q.needsReason === false, Q);
    check('B7 the older "duplicates" list is still in the body (old callers)', Array.isArray(q1.body.duplicates) && q1.body.duplicates.length >= 1 && q1.body.blocking === true, null);
    check('B8 nothing was created by the refused save', (await prisma.client.count({ where: { name: NAME } })) === 1, null);
    // with no location typed
    const q2 = await post({ name: NAME });
    check('B9 same name and NO location typed: the question says the location is needed (needsLocation)', q2.status === 409 && q2.body.question.needsLocation === true, q2.body && q2.body.question);

    // ===== 4. confirmed without a location -> 400 "Tell us the location ..." =====
    const e1 = await post({ name: NAME, confirmSeparate: true });
    check('C1 confirmed but no location -> 400 "Tell us the location so we can tell them apart."', e1.status === 400 && e1.body.error === 'Tell us the location so we can tell them apart.' && e1.body.errors[0].field === 'location', [e1.status, e1.body]);
    check('C2 ... also for "Save for later" and for the old allowDuplicate flag', (await post({ name: NAME, allowDuplicate: true, location: '   ' })).status === 400, null);

    // ===== 5. confirmed + location -> a separate client =====
    const b = await post({ name: NAME, location: 'Guntur', state: 'Andhra Pradesh', confirmSeparate: true });
    check('D1 confirmed + location -> 201, a NEW client', b.status === 201 && b.body.id && b.body.id !== a.body.id, [b.status, b.body && b.body.error]);
    Z.made.clients.push(b.body.id);
    const bRow = await prisma.client.findUnique({ where: { id: b.body.id } });
    check('D2 it is its own row: own Client ID, same name printed exactly, its own location', bRow.name === NAME && bRow.location === 'Guntur' && bRow.clientCode && bRow.clientCode !== (await prisma.client.findUnique({ where: { id: a.body.id } })).clientCode, bRow);
    check('D3 the existing client is untouched (every field the same)', (await snap(a.body.id)) === before, null);
    check('D4 no alias was made between the two locations', (await prisma.clientAlias.count({ where: { clientId: b.body.id } })) === 0 && (await prisma.clientAlias.count({ where: { clientId: a.body.id } })) === aliasesBefore, null);
    const ab = await audits(b.body.id);
    const link = ab.find((x) => /^Added as another location of /.test(x.action));
    const aCode = (await prisma.client.findUnique({ where: { id: a.body.id } })).clientCode;
    check('D5 audit row "Added as another location of CL-XXXX" with the old client linked, who and when', !!link && link.action === `Added as another location of ${aCode}` && link.fromValue === a.body.id && link.toValue.includes(`/clients/${a.body.id}`) && link.userId === sa.id && !!link.createdAt, link);
    check('D6 no "created despite duplicate" row for this normal case', !ab.some((x) => /despite possible duplicate/.test(x.action)), ab.map((x) => x.action));
    check('D7 the existing client got no audit row from this add', (await audits(a.body.id)).every((x) => !/another location/.test(x.action)), null);

    const put1 = await call('PUT', `/api/clients/${b.body.id}`, T.sa, { gst: GST });
    check('D8 editing a location to carry the same GST as its sibling location saves (no stop)', ok(put1), [put1.status, put1.body && put1.body.error]);

    // ===== 6. the old flag name still works (compat) =====
    const c = await post({ name: NAME, location: 'Vijayawada', allowDuplicate: true });
    check('E1 the older allowDuplicate flag also confirms (201)', c.status === 201, [c.status, c.body && c.body.error]);
    Z.made.clients.push(c.body.id);
    // three same-name now: the question lists every one
    const q3 = await post({ name: NAME });
    check('E2 three clients with that name exist: the question lists all of them', q3.status === 409 && q3.body.question.matches.length === 3 && /and 1 more/.test(q3.body.question.text), q3.body && q3.body.question && q3.body.question.text);

    // ===== 7. same name + same location (+ same phone) -> the stronger question =====
    const s1 = await post({ name: NAME, location: 'Narasaraopet', state: 'Andhra Pradesh', contactPhone: PHONE });
    const SQ = s1.body && s1.body.question;
    check('F1 same name + same location + same phone -> 409 level likelySame', s1.status === 409 && SQ.level === 'likelySame' && SQ.needsReason === true, [s1.status, SQ]);
    check('F2 the wording: "A client with the same name, location and phone number already exists ... Are you sure it is a different one?"', /^A client with the same name, location and phone number already exists \(.*\)\. Are you sure it is a different one\?$/.test(SQ.text) && SQ.yesLabel === 'Add as separate client', SQ.text);
    check('F3 the matched card is the same-location one and says so', SQ.matches[0].id === a.body.id && SQ.matches[0].sameLocation === true && SQ.matches[0].reasons.some((r) => r.label === 'Same phone number'), SQ.matches[0]);
    const s2 = await post({ name: NAME, location: 'Narasaraopet', state: 'Andhra Pradesh', contactPhone: PHONE, confirmSeparate: true });
    check('F4 confirmed but no reason -> 400 "Write one line on why this is a different client." (still no hard block)', s2.status === 400 && s2.body.errors[0].field === 'separateReason' && s2.body.code === 'NEEDS_REASON', [s2.status, s2.body]);
    const REASON = 'Second hospital building, own MD, own agreement';
    const s3 = await post({ name: NAME, location: 'Narasaraopet', state: 'Andhra Pradesh', contactPhone: PHONE, confirmSeparate: true, separateReason: REASON });
    check('F5 confirmed + reason -> 201 (always addable)', s3.status === 201, [s3.status, s3.body && s3.body.error]);
    Z.made.clients.push(s3.body.id);
    const s3a = (await audits(s3.body.id)).find((x) => /^Added as another location of /.test(x.action));
    check('F6 the reason is kept in the audit row', !!s3a && s3a.reason === REASON, s3a);
    // same name + same location but a different phone: still the stronger question
    const s4 = await post({ name: NAME, location: 'narasaraopet', state: 'Andhra Pradesh' });
    check('F7 same name + same location (spelling/case ignored), no phone: also asks "are you sure" with a reason', s4.status === 409 && s4.body.question.level === 'likelySame', s4.body && s4.body.question && s4.body.question.level);

    // ===== 8. GSTIN: same GST at another location is just a confirm, no DB unique index in the way =====
    const g1 = await post({ name: `ZZTEST CL Palnadu Group ${RUN}`, location: 'Tenali', gst: GST });
    check('G1 a different name with the same GST number asks first (level sameId, no location needed)', g1.status === 409 && g1.body.question.level === 'sameId' && g1.body.question.needsLocation === false && /GST number/.test(g1.body.question.title), g1.body && g1.body.question);
    const g2 = await post({ name: `ZZTEST CL Palnadu Group ${RUN}`, location: 'Tenali', gst: GST, confirmSeparate: true });
    check('G2 confirmed -> 201 (the GST number is not unique in the database)', g2.status === 201, [g2.status, g2.body && g2.body.error]);
    Z.made.clients.push(g2.body.id);
    const g3 = await post({ name: NAME, location: 'Chilakaluripet', state: 'Andhra Pradesh', gst: GST, confirmSeparate: true });
    check('G3 same name + same GST at another location, confirmed -> 201', g3.status === 201, [g3.status, g3.body && g3.body.error]);
    Z.made.clients.push(g3.body.id);
    const gAudit = (await audits(g2.body.id)).map((x) => x.action);
    check('G4 the GST-only add keeps the older audit wording (not "another location")', gAudit.includes('Client created despite possible duplicate') && !gAudit.some((x) => /another location/.test(x)), gAudit);

    // ===== 8b. "Save & create agreement" works with the confirm too =====
    const full = { mode: 'create', createAgreement: true, ownerDepartment: 'Education', industry: 'Healthcare', contactName: 'ZZ Contact', contactEmail: `zz-cl-${RUN}@example.test`, contactPhone: '9812345678', bdeOwner: sa.name, agreementFeePercent: '8.33', paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice', guaranteePeriod: '30 Days' };
    const f1 = await call('POST', '/api/clients', T.sa, { ...full, name: NAME });
    check('G5 "Save & create agreement" with no location is also the friendly question (409), nothing saved', f1.status === 409 && !!f1.body.question, [f1.status, f1.body && f1.body.error]);
    const f2 = await call('POST', '/api/clients', T.sa, { ...full, name: NAME, location: 'Macherla' });
    check('G6 ... and with the confirm it saves AND makes the agreement for that location', f2.status === 201 && !!f2.body.agreementId && f2.body.location === 'Macherla', [f2.status, f2.body && (f2.body.error || f2.body.agreementId)]);
    if (f2.body && f2.body.id) Z.made.clients.push(f2.body.id);

    // ===== 9. the live check (the form calls it before saving) =====
    const ck = await call('POST', '/api/clients/check-duplicate', T.sa, { name: NAME, location: 'Narasaraopet', contactPhone: PHONE });
    check('H1 check-duplicate returns the same question for the form', ck.status === 200 && ck.body.question && ck.body.question.level === 'likelySame' && Array.isArray(ck.body.matches), [ck.status, ck.body && ck.body.question && ck.body.question.level]);
    const ck2 = await call('POST', '/api/clients/check-duplicate', T.sa, { name: UNIQUE + ' x' });
    check('H2 a name nobody has: no question', ck2.status === 200 && ck2.body.question === null, ck2.body);

    // ===== 10. permissions are unchanged =====
    check('I1 a recruiter still cannot add a client (403, before any question)', (await post({ name: NAME, location: 'Hyderabad' }, T.rec)).status === 403, null);
    check('I2 an accountant still cannot add a client (403)', (await post({ name: NAME, location: 'Hyderabad' }, T.acc)).status === 403, null);
    check('I3 ... and cannot run the check', (await call('POST', '/api/clients/check-duplicate', T.rec, { name: NAME })).status === 403, null);
    const bq = await post({ name: NAME, location: 'Eluru' }, T.bde);
    check('I4 a BDE adding the same name at another location: added at once, or the older desk rule - never a bare error', bq.status === 201 || bq.status === 403 || bq.status === 400, [bq.status, bq.body]);
    if (bq.status === 201 && bq.body.id) Z.made.clients.push(bq.body.id);

    // ===== 11. edits: another location of the same company never blocks the save =====
    const put2 = await call('PUT', `/api/clients/${b.body.id}`, T.sa, { contactPhone: PHONE });
    check('J2 the same phone as a sibling location saves too', ok(put2), [put2.status, put2.body && put2.body.error]);
    const put3 = await call('PUT', `/api/clients/${u.body.id}`, T.sa, { gst: GST });
    check('J3 an UNRELATED client taking that GST still gets the friendly question (409 + question), then saves when confirmed', put3.status === 409 && !!put3.body.question && ok(await call('PUT', `/api/clients/${u.body.id}`, T.sa, { gst: GST, confirmSeparate: true })), [put3.status, put3.body && put3.body.error]);

    // ===== 12. how the same-name clients are told apart =====
    const pk = await call('GET', `/api/clients/picker?q=${encodeURIComponent(`ZZTEST CL Palnadu Hospital ${RUN}`)}&limit=50`, T.sa);
    const labelOf = (id) => (pk.body.rows.find((r) => r.id === id) || {}).placeLabel;
    check('K1 the picker gives "Name - Location" to the same-name clients (two at one place also get the client number)', String(labelOf(a.body.id)).startsWith(`${NAME} - Narasaraopet (`) && labelOf(b.body.id) === `${NAME} - Guntur`, pk.body.rows.map((r) => r.placeLabel));
    check('K2 a unique name has no label (nothing changes for it)', !((await call('GET', `/api/clients/picker?q=${encodeURIComponent(UNIQUE)}`, T.sa)).body.rows[0] || {}).label, null);
    const pk2 = await call('GET', `/api/clients/picker?q=${encodeURIComponent(`palnadu hospital ${RUN} narasaraopet`)}&limit=50`, T.sa);
    check('K3 searching "palnadu hospital <run> narasaraopet" finds the Narasaraopet one (name + location)', pk2.body.rows.some((r) => r.id === a.body.id) && !pk2.body.rows.some((r) => r.id === b.body.id), pk2.body.rows.map((r) => r.placeLabel));
    const pk3 = await call('GET', `/api/clients/picker?q=${encodeURIComponent('guntur')}&limit=50`, T.sa);
    check('K4 one word still searches NAMES only (a place word alone does not widen the picker)', !pk3.body.rows.some((r) => r.id === b.body.id), null);
    const lst = await call('GET', '/api/clients', T.sa);
    const row = (id) => lst.body.find((r) => r.id === id) || {};
    check('K5 the Clients list rows carry the label and the location for same-name clients; a unique one has none', String(row(a.body.id).placeLabel).startsWith(`${NAME} - Narasaraopet`) && row(b.body.id).location === 'Guntur' && !row(u.body.id).placeLabel, [row(a.body.id).placeLabel, row(u.body.id).placeLabel]);
    const al = await call('GET', '/api/clients/aliases', T.sa);
    check('K6 /clients/aliases ships the same-name labels for every dropdown', Array.isArray(al.body.places) && al.body.places.some((p) => p.id === a.body.id && String(p.label).startsWith(`${NAME} - Narasaraopet`)) && !al.body.places.some((p) => p.id === u.body.id), al.body.places && al.body.places.length);

    // requirements of the two locations are told apart in the Requirements filter
    const mkJob = async (client, tag) => { const j = await prisma.requirement.create({ data: { title: `ZZTEST CL Job ${tag} ${RUN}`, clientId: client, status: 'OPEN', department: 'Education', openings: 1 } }); Z.made.reqs.push(j.id); return j; };
    await mkJob(a.body.id, 'A'); await mkJob(b.body.id, 'B');
    const fac = await call('GET', '/api/ats-io/facets/requirements?search=ZZTEST%20CL%20Job', T.sa);
    const fo = (fac.body.facets && fac.body.facets.clientId) || [];
    check('L1 the Requirements client filter shows the two locations as two options with their counts', fo.some((o) => o.value === a.body.id && String(o.label).startsWith(`${NAME} - Narasaraopet`)) && fo.some((o) => o.value === b.body.id && o.label === `${NAME} - Guntur`), fo);
    const q4 = await post({ name: NAME, location: 'Rajahmundry' });
    check('L2 the question card shows the requirements count of the existing client', q4.body.question.matches.find((m) => m.id === a.body.id).requirementsCount === 1, q4.body.question.matches.map((m) => m.requirementsCount));

    // ===== 13. pure logic =====
    const L = CLOC.placeLabelsFor([
      { id: 'x1', name: "St. Martin's Engineering College", location: 'Survey No. 563, Near Forest Academy, Dulapally, Kompally, Secunderabad, Telangana', clientCode: 'CL-1' },
      { id: 'x2', name: "St. Martin's Engineering College", location: 'Kompally, Secunderabad, Telangana', clientCode: 'CL-2' },
      { id: 'x3', name: 'KG Reddy College of Engineering', location: 'Moinabad' },
      { id: 'x4', name: 'KG Reddy college of engineering', location: 'Chilkur Village' },
      { id: 'x5', name: 'Same Place Ltd', location: 'Pune', clientCode: 'CL-5' },
      { id: 'x6', name: 'Same Place Pvt Ltd', location: 'Pune', clientCode: 'CL-6' },
      { id: 'x7', name: 'Nobody Else', location: 'Pune' },
      { id: 'x8', name: 'No Place Co', location: '' },
      { id: 'x9', name: 'No Place Co', location: '', state: 'Kerala' },
      { id: 'x10', name: 'Long Co', location: 'Plot 12, Road No 5, Banjara Hills, Hyderabad, Telangana' },
      { id: 'x11', name: 'Long Co', location: 'Warangal' },
    ]);
    check('M1 labels only for names that more than one client carries', L.size === 10 && !L.has('x7'), [...L.entries()]);
    check('M2 two long addresses that would look alike show more of the address (no number needed)', L.get('x1') === "St. Martin's Engineering College - Survey No. 563, Near Forest Academy, Dulapally, Kompally, Secunderabad, Telangana" && L.get('x2') === "St. Martin's Engineering College - Kompally, Secunderabad, Telangana", [L.get('x1'), L.get('x2')]);
    check('M3 spelling / case / Pvt Ltd do not hide a same-name pair', L.get('x3') === 'KG Reddy College of Engineering - Moinabad' && L.get('x4') === 'KG Reddy college of engineering - Chilkur Village', [L.get('x3'), L.get('x4')]);
    check('M4 two labels that would look the same get the client number', L.get('x5') === 'Same Place Ltd - Pune (CL-5)' && L.get('x6') === 'Same Place Pvt Ltd - Pune (CL-6)', [L.get('x5'), L.get('x6')]);
    check('M5 no location: the state, else just the name', L.get('x8') === 'No Place Co' && L.get('x9') === 'No Place Co - Kerala', [L.get('x8'), L.get('x9')]);
    check('M7 a long address that is not confusing with another is cut from the street end', L.get('x10') === 'Long Co - Banjara Hills, Hyderabad, Telangana' && L.get('x11') === 'Long Co - Warangal', [L.get('x10'), L.get('x11')]);
    check('M6 samePlace ignores case/punctuation, and different states are different places', CLOC.samePlace('Narasaraopet', 'AP', 'narasaraopet.', 'ap') && CLOC.samePlace('Pune', '', 'Pune', 'Maharashtra') && !CLOC.samePlace('Aurangabad', 'Maharashtra', 'Aurangabad', 'Bihar') && !CLOC.samePlace('', '', '', ''), null);

    console.log('\n--- cleanup ---');
  } finally {
    const left = await Z.cleanup();
    Z.check('N1 every ZZTEST CL row is gone (users, clients, requirements, audit)', Object.values(left).every((n) => n === 0), left);
    await Z.finish();
  }
})().catch(async (e) => { console.error(e); try { await Z.cleanup(); } catch { /* ignore */ } process.exit(1); });

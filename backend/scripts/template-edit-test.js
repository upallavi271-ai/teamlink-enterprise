#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TEMPLATE EDIT (2026-10-14). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/template-edit-test.js
//
// New endpoint covered: PUT /api/requirements/templates/:tid  ("My job templates" - Edit).
//   * the person who saved it can change the name / the job details, and it is audited
//   * an Admin can change anyone's template
//   * another BDE (not the owner, not an Admin) gets 403 in plain words
//   * a recruiter (no "Create Requirement" right) gets 403
//   * validation answers in plain words: short name 400, no job title 400, same name as another 409, nothing to change 400
//   * the used templates are never deleted by an edit (same id, still listed)
// Also re-checks that the older edit endpoints keep their role gates (Admin-only offer letter template).
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('AT');
const { prisma, call, check } = Z;

(async () => {
  await Z.preclean();
  const madeTpl = [];
  try {
    const ok = (r) => r.status >= 200 && r.status < 300;
    const uAdmin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
    const uBde2 = await Z.mkUser('bde2', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
    const uRec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const T = { admin: await Z.mint(uAdmin), bde: await Z.mint(uBde), bde2: await Z.mint(uBde2), rec: await Z.mint(uRec) };

    const nameA = `ZZTEST AT Maths ${Z.RUN}`;
    const nameB = `ZZTEST AT Science ${Z.RUN}`;
    const mk = async (tok, name) => {
      const r = await call('POST', '/api/requirements/templates', tok, { name, fields: { title: `ZZTEST AT ${name}`, location: 'ZZ Town', openings: 1 } });
      if (r.body && r.body.id) madeTpl.push(r.body.id);
      return r;
    };
    const a = await mk(T.bde, nameA);
    check('A1 a BDE saves a job template', ok(a) && !!a.body.id, [a.status, a.body]);
    const b = await mk(T.admin, nameB);
    check('A2 an Admin saves another one', ok(b) && !!b.body.id, [b.status, b.body]);
    const tid = a.body.id;

    const put = (tok, id, body) => call('PUT', `/api/requirements/templates/${id}`, tok, body);

    // --- an authorised role can edit, and it is audited
    const e1 = await put(T.bde, tid, { name: `${nameA} v2`, fields: { title: 'ZZTEST AT Maths teacher', location: 'ZZ City', openings: 2 } });
    check('E1 the owner changes the name and the job details (200)', e1.status === 200 && e1.body.name === `${nameA} v2` && e1.body.fields.location === 'ZZ City' && e1.body.id === tid, [e1.status, e1.body]);
    const list1 = await call('GET', '/api/requirements/templates', T.bde);
    const row = (list1.body || []).find((t) => t.id === tid);
    check('E2 the edit is saved: same id, new words, still in the list', !!row && row.name === `${nameA} v2` && row.fields.title === 'ZZTEST AT Maths teacher', row);
    const aud = await prisma.auditLog.findMany({ where: { entityId: tid, action: 'Requirement template changed' } });
    check('E3 the edit is in the audit log (who, old name, new name)', aud.length === 1 && aud[0].userId === uBde.id && aud[0].fromValue === nameA && aud[0].toValue === `${nameA} v2`, aud);
    const e2 = await put(T.bde, tid, { name: `${nameA} v3` });
    check('E4 only the name can be changed (job details stay)', e2.status === 200 && e2.body.fields.title === 'ZZTEST AT Maths teacher', [e2.status, e2.body]);
    const e3 = await put(T.admin, tid, { fields: { title: 'ZZTEST AT Maths (admin)', location: 'ZZ Admin Town' } });
    check('E5 an Admin can change a template saved by someone else', e3.status === 200 && e3.body.fields.location === 'ZZ Admin Town', [e3.status, e3.body]);

    // --- unauthorised roles get 403 in plain words
    const f1 = await put(T.bde2, tid, { name: 'ZZTEST AT hijack' });
    check('F1 another BDE (not the owner) is refused with 403 and a plain sentence', f1.status === 403 && /Only .* or an Admin can change this template/.test((f1.body || {}).error || ''), [f1.status, f1.body]);
    const f2 = await put(T.rec, tid, { name: 'ZZTEST AT hijack' });
    check('F2 a recruiter (no right to create jobs) is refused with 403', f2.status === 403, [f2.status, f2.body]);
    const list2 = await call('GET', '/api/requirements/templates', T.admin);
    check('F3 refused edits changed nothing', (list2.body || []).find((t) => t.id === tid).name === `${nameA} v3`, null);

    // --- validation in plain words
    const v1 = await put(T.bde, tid, { name: 'x' });
    check('V1 a one-letter name: 400 "Give the template a name"', v1.status === 400 && /Give the template a name/.test(v1.body.error) && v1.body.field === 'name', [v1.status, v1.body]);
    const v2 = await put(T.bde, tid, { fields: { location: 'nowhere' } });
    check('V2 job details without a title: 400 "Fill in the job title"', v2.status === 400 && /requirement title/.test(v2.body.error) && v2.body.field === 'title', [v2.status, v2.body]);
    const v3 = await put(T.admin, tid, { name: nameB.toUpperCase() });
    check('V3 the same name as another template: 409 "pick another name"', v3.status === 409 && /pick another name/.test(v3.body.error), [v3.status, v3.body]);
    const v4 = await put(T.bde, tid, {});
    check('V4 nothing to change: 400 in plain words', v4.status === 400 && /Nothing to change/.test(v4.body.error), [v4.status, v4.body]);
    const v5 = await put(T.bde, 'jt-does-not-exist', { name: 'ZZTEST AT ghost name' });
    check('V5 a template that is gone: 404 plain sentence', v5.status === 404 && /gone already/.test(v5.body.error), [v5.status, v5.body]);

    // --- older edit endpoints keep their gates (not widened)
    const o1 = await call('PUT', '/api/ats/offers/letter-template', T.bde, { text: 'ZZTEST AT hijack text that is long enough to pass the length check' });
    check('G1 the offer letter template is still Admin-only (BDE refused)', o1.status === 403, [o1.status, o1.body]);
    const o2 = await call('GET', '/api/ats/offers/letter-template', T.bde);
    check('G2 ... and a non-admin sees it read-only (canEdit false)', o2.status === 200 && o2.body.canEdit === false, [o2.status, o2.body && o2.body.canEdit]);
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      // remove the templates this test saved from the shared list (sandbox), leave everyone else's
      const row = await prisma.appSetting.findUnique({ where: { key: 'job-templates' } });
      if (row) {
        const list = JSON.parse(row.value || '[]').filter((t) => !madeTpl.includes(t.id) && !/ZZTEST AT/.test(t.name || ''));
        await prisma.appSetting.update({ where: { key: 'job-templates' }, data: { value: JSON.stringify(list) } });
      }
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: madeTpl } }, { toValue: { contains: 'ZZTEST AT' } }] } });
      const left = await Z.cleanup([]);
      const rest = await prisma.appSetting.findUnique({ where: { key: 'job-templates' } });
      const stray = rest ? JSON.parse(rest.value || '[]').filter((t) => /ZZTEST AT/.test(t.name || '')).length : 0;
      console.log('leftovers after cleanup:', JSON.stringify({ ...left, templates: stray }));
      Z.check('Z cleanup: nothing ZZTEST AT is left in the sandbox', Object.values(left).every((n) => n === 0) && stray === 0, left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();

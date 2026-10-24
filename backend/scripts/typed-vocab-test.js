#!/usr/bin/env node
// Typed language / purpose on Message templates, typed vendor document type helper. COPY DATABASE ONLY:
//   COPY_DB=/path/to/copy.db node scripts/typed-vocab-test.js
const path = require('path');
const db = process.env.COPY_DB;
if (!db || /prisma[\/]dev\.db$/i.test(path.resolve(db))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
process.env.DATABASE_URL = `file:${path.resolve(db).split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
const prisma = require('../src/db');
const T = require('../src/utils/messageTemplates');
let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) pass += 1; else fail += 1; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? `  -> ${JSON.stringify(d).slice(0, 300)}` : ''}`); };
(async () => {
  const any = await prisma.user.findFirst();
  const admin = { id: any.id, name: any.name, role: 'ADMIN', hrmsRole: 'ADMIN' };
  const made = [];
  try {
    ok('templates are supported in the copy', T.supported());
    ok('cleanLanguage keeps listed spelling', T.cleanLanguage('telugu') === 'Telugu' && T.cleanLanguage(' HINDI ') === 'Hindi');
    ok('cleanLanguage strips html + caps length', T.cleanLanguage('<b>Tamil</b>') === 'Tamil' && T.cleanLanguage('x'.repeat(80)).length === 30);
    ok('empty language -> English', T.languageOrEnglish('') === 'English' && T.languageOrEnglish(null) === 'English');
    const base = { channel: 'SMS', audience: 'candidate', body: 'Hello {{name}}', name: 'ZZTEST tamil' };
    let r = await T.create(admin, { ...base, purpose: 'CUSTOM', purposeLabel: 'ZZTEST Salary discussion', language: 'tamil' });
    ok('typed language is stored (not English)', r.template && r.template.language === 'tamil', r);
    if (r.template) made.push(r.template.id);
    r = await T.create(admin, { ...base, purpose: 'CUSTOM', purposeLabel: 'ZZTEST Salary discussion', language: 'Tamil' });
    ok('same language typed with other capitals reuses the first spelling', r.template && r.template.language === 'tamil', r);
    if (r.template) made.push(r.template.id);
    r = await T.create(admin, { ...base, purpose: 'CUSTOM', purposeLabel: 'zztest  SALARY discussion', language: 'English' });
    ok('same purpose typed with other capitals joins it and keeps its spelling', r.template && r.template.purposeLabel === 'ZZTEST Salary discussion' && r.template.purpose === 'CUSTOM_ZZTEST_SALARY_DISCUSSION', r);
    if (r.template) made.push(r.template.id);
    r = await T.create(admin, { ...base, purpose: 'CUSTOM', purposeLabel: '   ', language: 'English' });
    ok('empty purpose name still refused', r.error && r.status === 400);
    r = await T.create(admin, { ...base, purpose: 'CUSTOM', purposeLabel: '!!!', language: 'English' });
    ok('a purpose name with no letters refused', r.error && r.status === 400);
    const extra = await T.extraLanguages();
    ok('extraLanguages lists the typed one', extra.includes('tamil'), extra);
    const rows = await T.list({ language: 'tamil' });
    ok('list filter by typed language works', rows.length >= 2 && rows.every((x) => x.language === 'tamil'), rows.length);
    const eng = await T.list({ language: 'English', q: 'ZZTEST' });
    ok('English filter still works', eng.length >= 1 && eng.every((x) => x.language === 'English'));
    const res = await T.resolve({ purpose: 'CUSTOM_ZZTEST_SALARY_DISCUSSION', channel: 'SMS', language: 'tamil' });
    ok('resolve picks the typed-language template', res && res.language === 'tamil', res && res.language);
    const res2 = await T.resolve({ purpose: 'CUSTOM_ZZTEST_SALARY_DISCUSSION', channel: 'SMS', language: 'Kannada' });
    ok('resolve falls back to English for a language with no template', res2 && res2.language === 'English');
    const audits = await prisma.auditLog.count({ where: { action: 'Message template created', toValue: { contains: 'tamil' } } }).catch(() => -1);
    ok('creating is audited with the language', audits !== 0, audits);
  } catch (e) { fail += 1; console.log('FAIL  exception', e.stack); } finally {
    await prisma.messageTemplate.deleteMany({ where: { id: { in: made } } }).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

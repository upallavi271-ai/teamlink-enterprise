#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SALARY MISSING REPORT - READ-ONLY.
//
//   node scripts/salary-missing-report.js            counts, by recruiter and by source
//   node scripts/salary-missing-report.js --csv out.csv   also write the list (one row per person)
//   DATABASE_URL=file:./sandbox.db node scripts/salary-missing-report.js      (any other copy)
//
// "Missing" = the current or the expected salary is blank, or written in a way that cannot be read
// ("As per norms", "NA"), using the same reader as the app (src/utils/salaryFit.js missingOf).
// A "Fresher" / 0 current salary counts as GIVEN. Nothing is written to the database: only SELECTs run.
// The recruiter is the one on the person's most recent job (the job's recruiter, else the follow-up owner), else "No requirement yet".
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const csvOut = (() => { const i = process.argv.indexOf('--csv'); return i > -1 ? process.argv[i + 1] : null; })();
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = `file:${path.resolve(__dirname, '..', 'prisma', 'dev.db').replace(/\\/g, '/')}`;
// eslint-disable-next-line import/no-dynamic-require, global-require
const { PrismaClient } = require(path.resolve(__dirname, '..', 'node_modules', '@prisma', 'client'));
const SAL = require('../src/utils/salaryFit');

const prisma = new PrismaClient();
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

(async () => {
  const people = await prisma.candidate.findMany({
    select: { id: true, name: true, email: true, phone: true, source: true, currentSalary: true, expectedSalary: true, createdAt: true },
  });
  const apps = await prisma.application.findMany({
    select: { id: true, candidateId: true, createdAt: true, requirement: { select: { recruiter: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  // imported work carries the recruiter on the follow-up (ownerName), not on the job
  const fus = await prisma.applicationFollowUp.findMany({ where: { ownerName: { not: null } }, select: { applicationId: true, ownerName: true }, orderBy: { createdAt: 'desc' } });
  const fuOwner = new Map();
  fus.forEach((x) => { if (!fuOwner.has(x.applicationId)) fuOwner.set(x.applicationId, x.ownerName); });
  const recOf = new Map();
  apps.forEach((a) => {
    if (recOf.has(a.candidateId)) return;
    recOf.set(a.candidateId, (a.requirement && a.requirement.recruiter && a.requirement.recruiter.name) || fuOwner.get(a.id) || 'Recruiter not named');
  });

  const kinds = new Map(); const byRecruiter = new Map(); const bySource = new Map();
  const rows = [];
  people.forEach((c) => {
    const miss = SAL.missingOf(c);
    if (!miss) return;
    bump(kinds, miss);
    const rec = recOf.get(c.id) || 'No requirement yet';
    const src = c.source || '(no source)';
    bump(byRecruiter, rec); bump(bySource, src);
    rows.push({ id: c.id, name: c.name, phone: c.phone || '', email: c.email || '', source: src, recruiter: rec, missing: miss, currentSalary: c.currentSalary || '', expectedSalary: c.expectedSalary || '' });
  });

  const total = people.length;
  console.log(`People: ${total.toLocaleString('en-IN')}   Salary missing: ${rows.length.toLocaleString('en-IN')} (${total ? Math.round((rows.length / total) * 100) : 0}%)`);
  console.log('\nWhat is missing');
  [['both', 'Current and expected'], ['current', 'Only current'], ['expected', 'Only expected']].forEach(([k, label]) => console.log(`  ${label.padEnd(22)} ${(kinds.get(k) || 0).toLocaleString('en-IN')}`));
  console.log('\nBy recruiter (their most recent job)');
  sorted(byRecruiter).slice(0, 40).forEach(([k, n]) => console.log(`  ${String(k).slice(0, 38).padEnd(40)} ${n.toLocaleString('en-IN')}`));
  console.log('\nBy source');
  sorted(bySource).slice(0, 40).forEach(([k, n]) => console.log(`  ${String(k).slice(0, 38).padEnd(40)} ${n.toLocaleString('en-IN')}`));

  if (csvOut) {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['id', 'name', 'phone', 'email', 'source', 'recruiter', 'missing', 'currentSalary', 'expectedSalary'];
    fs.writeFileSync(csvOut, `${[head.join(',')].concat(rows.map((r) => head.map((h) => esc(r[h])).join(','))).join('\r\n')}\r\n`);
    console.log(`\nList written to ${csvOut}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

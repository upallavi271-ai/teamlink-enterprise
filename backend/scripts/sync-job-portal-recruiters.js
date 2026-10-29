// ---------------------------------------------------------------------------
// Job Portal recruiter logins for every CURRENT holder of an HRMS Recruiter / TL / STL seat (utils/jobPortalRecruiters.js) - by hand.
//
//   node scripts/sync-job-portal-recruiters.js            DRY RUN: who would get a portal login (nothing changes)
//   node scripts/sync-job-portal-recruiters.js --apply    make them
//
// Needs the backend running (the embedded portal answers on JOB_PORTAL_PORT). The same thing runs by itself on every Job
// Portal sync and before the mailbox screen lists the recruiters.
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const prisma = require('../src/db');
const { ensure } = require('../src/utils/jobPortalRecruiters');

const apply = process.argv.includes('--apply');
(async () => {
  const out = await ensure({ apply });
  const of = (k) => out.results.filter((r) => r.result === k);
  const line = (r) => `  - ${r.name || ''} (${(r.seats || []).join(', ') || r.atsRole || ''}${r.department ? `, ${r.department}` : ''}) ${r.email}${r.reason ? `  - ${r.reason}` : ''}`;
  console.log(apply ? 'APPLIED' : 'DRY RUN (nothing changed; add --apply to make them)');
  console.log(`current holders of HRMS Recruiter / TL / STL seats: ${out.results.length}`);
  console.log(`already in the Job Portal: ${of('exists').length}${of('exists').filter((r) => !r.active).length ? ` (${of('exists').filter((r) => !r.active).length} with the portal login switched off)` : ''}`);
  const make = of(apply ? 'created' : 'would-create');
  console.log(`${apply ? 'portal login made' : 'would get a portal login'}: ${make.length}`);
  if (make.length) console.log(make.map(line).join('\n'));
  const moved = of(apply ? 'updated' : 'would-update');
  console.log(`${apply ? 'department / employee id set from the HRMS seat' : 'would get the department / employee id of their HRMS seat'}: ${moved.length}`);
  if (moved.length) console.log(moved.map((r) => `  - ${r.name} ${r.email}: ${r.from || '(none)'} -> ${r.to || '(none)'}`).join('\n'));
  if (of('clash').length) console.log(`left alone - the email signs in to the portal as something else (${of('clash').length}):\n${of('clash').map(line).join('\n')}`);
  // who the mailbox screen offers, per department (the seat holders in HRMS today)
  const depts = new Map();
  for (const r of out.results.filter((x) => x.result !== 'clash' && x.result !== 'skipped')) {
    const d = r.department || '(no department)';
    if (!depts.has(d)) depts.set(d, []);
    depts.get(d).push(`${r.name} [${(r.seats || []).join(', ')}]`);
  }
  console.log('\noffered in Integrations -> Naukri & Shine mailboxes (HRMS seat holders today):');
  for (const [d, names] of [...depts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${d}: ${names.join(' | ')}`);
  if (of('skipped').length) console.log(`skipped (${of('skipped').length}):\n${of('skipped').map(line).join('\n')}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(`Could not reach the Job Portal: ${e.message}`); await prisma.$disconnect().catch(() => {}); process.exit(1); });

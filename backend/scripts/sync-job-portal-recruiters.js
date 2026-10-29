// ---------------------------------------------------------------------------
// Job Portal recruiter logins for every HRMS Recruiter / TL / STL (utils/jobPortalRecruiters.js) - by hand.
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
  const line = (r) => `  - ${r.name || ''} (${r.atsRole || ''}) ${r.email}${r.reason ? `  - ${r.reason}` : ''}`;
  console.log(apply ? 'APPLIED' : 'DRY RUN (nothing changed; add --apply to make them)');
  console.log(`HRMS Recruiters / TLs / STLs: ${out.results.length}`);
  console.log(`already in the Job Portal: ${of('exists').length}${of('exists').filter((r) => !r.active).length ? ` (${of('exists').filter((r) => !r.active).length} with the portal login switched off)` : ''}`);
  const make = of(apply ? 'created' : 'would-create');
  console.log(`${apply ? 'portal login made' : 'would get a portal login'}: ${make.length}`);
  if (make.length) console.log(make.map(line).join('\n'));
  if (of('clash').length) console.log(`left alone - the email signs in to the portal as something else (${of('clash').length}):\n${of('clash').map(line).join('\n')}`);
  if (of('skipped').length) console.log(`skipped (${of('skipped').length}):\n${of('skipped').map(line).join('\n')}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(`Could not reach the Job Portal: ${e.message}`); await prisma.$disconnect().catch(() => {}); process.exit(1); });

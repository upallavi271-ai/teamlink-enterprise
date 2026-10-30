// ---------------------------------------------------------------------------
// Naukri / Shine mail responses -> ATS Applications (utils/mailImports.js).
//   node scripts/mail-imports-check.js            DRY RUN: which requirement each response would go to, and what waits (no change)
//   node scripts/mail-imports-check.js --apply    add them now (the server also does this after "Sync now" and hourly)
// Needs the backend running (the embedded Job Portal answers on JOB_PORTAL_PORT).
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const prisma = require('../src/db');
const M = require('../src/utils/mailImports');
const { portalFetch } = require('../src/utils/jobPortalBridge');

(async () => {
  const days = Number((process.argv.find((a) => /^--days=\d+$/.test(a)) || '--days=60').split('=')[1]);
  if (process.argv.includes('--apply')) {
    const out = await M.pull({ sinceDays: days });
    console.log(`APPLIED (last ${days} days): ${out.read} responses read, ${out.added} added to ATS Applications, ${out.already} already there, ${out.waiting} waiting, ${out.failed} failed`);
    for (const w of out.waitingTitles) console.log(`  waiting: "${w.title}" (${w.count})`);
    await prisma.$disconnect();
    return;
  }
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const apps = ((await portalFetch(`/integrations/teamlink/mail-applications?since=${encodeURIComponent(since)}&limit=5000`, { timeoutMs: 60000 })) || {}).applications || [];
  const reqs = await prisma.requirement.findMany({ select: { id: true, title: true, department: true, status: true, recruiterId: true, recruiterIds: true, createdAt: true } });
  const index = reqs.map((r) => ({ ...r, norm: M.normTitle(r.title) })).filter((r) => r.norm);
  const users = await prisma.user.findMany({ where: { email: { in: [...new Set(apps.map((a) => String(a.application.recruiterEmail || '').toLowerCase()).filter(Boolean))] } }, select: { id: true, email: true } });
  const userOf = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const seats = new Map((await require('../src/utils/jobPortalRecruiters').people().catch(() => [])).map((p) => [p.email, p.department]));
  const by = new Map(); const waiting = new Map();
  for (const a of apps) {
    const r = M.match(index, a.application.jobTitle, { userId: userOf.get(String(a.application.recruiterEmail || '').toLowerCase()) || null, department: seats.get(String(a.application.recruiterEmail || '').toLowerCase()) || null });
    if (r) { const k = `"${a.application.jobTitle}" -> ${r.title} [${r.status}]`; by.set(k, (by.get(k) || 0) + 1); } else waiting.set(a.application.jobTitle, (waiting.get(a.application.jobTitle) || 0) + 1);
  }
  console.log(`DRY RUN (last ${days} days; nothing changed): ${apps.length} mail responses on the Job Portal`);
  console.log(`would go to an ATS requirement: ${[...by.values()].reduce((x, y) => x + y, 0)}`);
  for (const [k, n] of [...by.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${n} x ${k}`);
  console.log(`waiting (no requirement with that title): ${[...waiting.values()].reduce((x, y) => x + y, 0)}`);
  for (const [t, n] of [...waiting.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${n} x "${t}"`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(`STOPPED: ${e.message}`); await prisma.$disconnect().catch(() => {}); process.exit(1); });

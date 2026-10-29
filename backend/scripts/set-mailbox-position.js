// ---------------------------------------------------------------------------
// A Naukri / Shine mailbox belongs to an HRMS position (utils/mailboxSeats.js) - by hand, for the existing mailboxes.
//
//   node scripts/set-mailbox-position.js                                     list the mailboxes and the positions (nothing changes)
//   node scripts/set-mailbox-position.js --mailbox <email> --seat <code>     DRY RUN: what would change
//   node scripts/set-mailbox-position.js --mailbox <email> --seat <code> --apply
//
// The same connection and its saved app password stay; only who gets its new imports changes (the position's holder today, and
// every later holder by itself). Candidates imported earlier stay with their recruiter. Needs the backend running.
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const prisma = require('../src/db');
const S = require('../src/utils/mailboxSeats');
const { portalFetch } = require('../src/utils/jobPortalBridge');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? String(process.argv[i + 1] || '').trim() : ''; };
const apply = process.argv.includes('--apply');
const CONN = '/integrations/teamlink/mailboxes/intake/source-connections';

(async () => {
  await require('../src/utils/jobPortalRecruiters').ensureQuietly(); // every seat holder has a portal login first
  const [conns, map, seats] = await Promise.all([portalFetch(CONN, { timeoutMs: 20000 }), S.loadMap(), S.seatsWithRecruiters()]);
  const list = conns.connections || [];
  const want = arg('--mailbox').toLowerCase();
  const seatCode = arg('--seat');
  if (!want || !seatCode) {
    console.log('MAILBOXES (source | email | recruiter now | position)');
    for (const c of list) console.log(`  ${c.sourceLabel || c.source} | ${c.address} | ${c.recruiterName || '-'} | ${map[c.id] ? map[c.id].seat : 'not linked to a position'}${c.status === 'disconnected' ? ' | disconnected' : ''}`);
    console.log('\nPOSITIONS (department | team | position | holder today)');
    for (const x of seats) console.log(`  ${x.department || '-'} | ${x.team || '-'} | ${x.code} | ${x.holder ? x.holder.name : 'empty'}`);
    console.log('\nNext: add --mailbox <email> --seat <position> (dry run), then --apply.');
    await prisma.$disconnect();
    return;
  }
  const hits = list.filter((c) => String(c.address || '').toLowerCase() === want || c.id === want);
  if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} mailboxes have that email - give the connection id instead` : `no mailbox ${want}`);
  const c = hits[0];
  const seat = seats.find((x) => x.code.toLowerCase() === seatCode.toLowerCase());
  if (!seat) throw new Error(`${seatCode} is not an active Recruiter / TL position in HRMS`);
  const moveTo = seat.holderRecruiterId && seat.holderRecruiterId !== c.recruiterId ? seat.holder.name : null;
  console.log(`${apply ? 'APPLY' : 'DRY RUN (nothing changed; add --apply)'}: ${c.sourceLabel || c.source} mailbox ${c.address}`);
  console.log(`  position: ${map[c.id] ? map[c.id].seat : '(not linked)'} -> ${seat.code} (${seat.department || '-'}${seat.team ? `, ${seat.team}` : ''})`);
  console.log(`  recruiter for new imports: ${c.recruiterName || '-'} -> ${moveTo || (seat.holder ? `${seat.holder.name} (already)` : `${c.recruiterName || '-'} (nobody holds ${seat.code} today)`)}`);
  console.log('  connection, app password and settings: unchanged; candidates imported earlier: stay where they are');
  if (!apply) { await prisma.$disconnect(); return; }
  await S.setSeat(c.id, seat.code, { name: 'set-mailbox-position script' });
  const r = (await S.reconcile({ apply: true, actor: null, onlyId: c.id }))[0];
  console.log(`DONE: ${c.address} belongs to ${seat.code}${r && r.result === 'moved' ? `; new imports now go to ${r.toName}` : ''}${r && r.result === 'failed' ? `; moving it did not work yet (${r.error}) - tried again on the next refresh` : ''}.`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(`STOPPED: ${e.message}`); await prisma.$disconnect().catch(() => {}); process.exit(1); });

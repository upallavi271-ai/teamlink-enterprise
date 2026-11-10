// EDUCATION TEAMS BY SEAT (founder 2026-11-10: "edu1 to edu5 usha team - edu team a, edu6 to edu10 sirisha team - edu team b").
// Pure logic, no database: node scripts/edu-team-seat-test.js
const W = require('../src/utils/workers');

let bad = 0;
const check = (what, ok) => { console.log(`${ok ? '  ok ' : '  BAD'}  ${what}`); if (!ok) bad += 1; };

const users = [
  { id: 'u1', name: 'D.Leela Usha Sri', status: 'Active' },
  { id: 'u2', name: 'Masabattula Sai Sirisha', status: 'Active' },
  { id: 'u3', name: 'Mamatha Dara', status: 'Active' },
  { id: 'u4', name: 'Popuri Anjali', status: 'Inactive' },
  { id: 'r1', name: 'Uma S', status: 'Active' },
];
const P = W.makeResolver(users);
P.eduSeatAt = (u) => (u === 'r1' ? 'EDU-7' : null);
const tlOf = (fus, req = {}) => { const w = W.attribute(req, fus, [], P); return w.tl ? w.tl.label : null; };
const fu = (x) => ({ ownerName: 'Somebody', createdAt: new Date(), ...x });

check('EDU-1 .. EDU-5 are Edu Team A, EDU-6 .. EDU-10 Edu Team B, others none',
  [1, 2, 3, 4, 5].every((n) => W.eduTeamOfSeat(`EDU-${n}`).team === 'Edu Team A')
  && [6, 7, 8, 9, 10].every((n) => W.eduTeamOfSeat(`EDU-${n}`).team === 'Edu Team B')
  && W.eduTeamOfSeat('Edu 3').team === 'Edu Team A' && W.eduTeamOfSeat('EDU-11') === null && W.eduTeamOfSeat('MED-1') === null && W.eduTeamOfSeat('EDU TL') === null);
check('a Team A seat with no TL written: Usha', tlOf([fu({ ownerPositionCode: 'EDU-3' })]) === 'D.Leela Usha Sri');
check('a Team A seat with the other team\'s TL written: Usha', tlOf([fu({ ownerPositionCode: 'EDU-3', tlName: 'M.Sai Sirisha' })]) === 'D.Leela Usha Sri');
check('a Team B seat with the manager written as TL: Sirisha', tlOf([fu({ ownerPositionCode: 'EDU-8', tlName: 'mamatha' })]) === 'Masabattula Sai Sirisha');
check('a former TL written on the work is kept (history)', tlOf([fu({ ownerPositionCode: 'EDU-8', tlName: 'Popuri Anjali' })]) === 'Popuri Anjali');
check('no seat on the work: the recruiter\'s own seat then decides (Uma S in EDU-7: Sirisha)', tlOf([fu({ ownerName: 'Uma S' })]) === 'Masabattula Sai Sirisha');
check('the job\'s seat decides when the follow-up has none', tlOf([fu({})], { positionCode: 'EDU-2' }) === 'D.Leela Usha Sri');
check('the sheets\' "D.Usha" is D.Leela Usha Sri', tlOf([fu({ tlName: 'D.Usha' })]) === 'D.Leela Usha Sri');
check('another department\'s seat is left alone', tlOf([fu({ ownerPositionCode: 'MED-1', tlName: 'mamatha' })]) === 'mamatha');

console.log(bad ? `\n${bad} check(s) failed` : '\nAll checks passed');
process.exit(bad ? 1 : 0);

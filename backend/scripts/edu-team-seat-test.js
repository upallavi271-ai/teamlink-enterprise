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

// A JOINING COUNTS UNDER THE CREDITED RECRUITER'S OWN TEAM LEAD (founder 2026-11-25: "evari team recruiter joinings valla team lead kiindha ravaali")
const Q = W.makeResolver([...users, { id: 'r2', name: 'N Saikumar', status: 'Active' }, { id: 'r3', name: 'Ravi Medical', status: 'Active' }, { id: 'r4', name: 'No Team', status: 'Active' }]);
Q.eduSeatAt = (u, at) => (u === 'r2' ? (new Date(at) < new Date('2026-10-23') ? 'EDU-2' : 'EDU-9') : null);
Q.tlOf = (u) => ({ r2: 'D.Leela Usha Sri', r3: 'Mamatha Dara' }[u] || null);
const tlFor = (uid, at) => { const t = W.teamLeadOf(Q, Q(uid), at); return t ? t.label : null; };
check('Saikumar in seat EDU-9 (Sirisha\'s team) on an Usha requirement: the joining is Sirisha\'s', tlFor('r2', '2026-11-12T10:00:00+05:30') === 'Masabattula Sai Sirisha');
check('the seat on that day decides: Saikumar in EDU-2 back then: Usha', tlFor('r2', '2026-10-01T10:00:00+05:30') === 'D.Leela Usha Sri');
check('no Education seat: the recruiter\'s TL in HRMS', tlFor('r3', '2026-11-12') === 'Mamatha Dara');
check('no seat and no TL on file: not known (the old TL stays)', tlFor('r4', '2026-11-12') === null && W.teamLeadOf(Q, null, null) === null && W.teamLeadOf(Q, { key: 'n:x', userId: null, label: 'x' }, null) === null);
check('the credit time is the move to Selected, else the joining day', W.joinCreditTime([{ toStage: 'SELECTED', createdAt: '2026-10-05' }, { toStage: 'JOINED', createdAt: '2026-11-02' }], '2026-11-01') === '2026-10-05' && W.joinCreditTime([], '2026-11-01') === '2026-11-01');

console.log(bad ? `\n${bad} check(s) failed` : '\nAll checks passed');
process.exit(bad ? 1 : 0);

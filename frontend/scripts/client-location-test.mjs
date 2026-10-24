// Pure-logic test: "Name - Location" labels + the wording of the "already exists" question. No browser, no network.
//   cd frontend && node scripts/client-location-test.mjs
import {
  placeLabelsFor, shortPlace, samePlace, registerClientPlaces, clientLabel, clientLabelOf, chipText, gateConfirm,
  pendingLine, cardFacts, NEEDS_LOCATION, NEEDS_REASON, nameKey,
} from '../src/utils/clientLocation.js';
import { matchesText } from '../src/components/searchMatch.js';

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`); };

const rows = [
  { id: 'a1', name: 'Palnadu Hospital', location: 'Narasaraopet', clientCode: 'CL-1' },
  { id: 'a2', name: 'Palnadu Hospital', location: 'Guntur', clientCode: 'CL-2' },
  { id: 'u1', name: 'Lonely Clinic', location: 'Hyderabad' },
  { id: 's1', name: "St. Martin's Engineering College", location: 'Survey No. 563, Near Forest Academy, Dulapally, Kompally, Secunderabad, Telangana', clientCode: 'S1' },
  { id: 's2', name: "St. Martin's Engineering College", location: 'Kompally, Secunderabad, Telangana', clientCode: 'S2' },
  { id: 'k1', name: 'KG Reddy College of Engineering & Technology', location: 'monaibad' },
  { id: 'k2', name: 'KG Reddy college of engineering & technology', location: 'ChilkurVillage, Moinabad' },
  { id: 'p1', name: 'Twin Care Ltd', location: 'Pune', clientCode: 'T1' },
  { id: 'p2', name: 'Twin Care Pvt Ltd', location: 'pune', clientCode: 'T2' },
];
const L = placeLabelsFor(rows);
check('L1 unique names get no label (nothing changes for them)', !L.has('u1'), [...L.keys()]);
check('L2 same-name clients read "Name - Location"', L.get('a1') === 'Palnadu Hospital - Narasaraopet' && L.get('a2') === 'Palnadu Hospital - Guntur', [L.get('a1'), L.get('a2')]);
check('L3 case / spelling of the name does not hide a pair (KG Reddy)', L.get('k1') === 'KG Reddy College of Engineering & Technology - monaibad' && L.has('k2'), [L.get('k1'), L.get('k2')]);
check('L4 two long addresses that look alike once cut show more of the address', L.get('s1').includes('Survey No. 563') && L.get('s2') === "St. Martin's Engineering College - Kompally, Secunderabad, Telangana", [L.get('s1'), L.get('s2')]);
check('L5 the same name AND place gets the client number', L.get('p1') === 'Twin Care Ltd - Pune (T1)' && L.get('p2') === 'Twin Care Pvt Ltd - pune (T2)', [L.get('p1'), L.get('p2')]);
check('L6 nameKey ignores Pvt / Ltd / punctuation / case', nameKey('Twin Care Pvt. Ltd') === nameKey('twin care LTD'), null);
check('L7 shortPlace cuts the street end first', shortPlace('Plot 12, Road No 5, Banjara Hills, Hyderabad, Telangana') === 'Banjara Hills, Hyderabad, Telangana', shortPlace('Plot 12, Road No 5, Banjara Hills, Hyderabad, Telangana'));
check('L8 samePlace: case / punctuation ignored; two different states are two places; empty is never "same"', samePlace('Narasaraopet', 'AP', 'narasaraopet.', 'ap') && !samePlace('Aurangabad', 'MH', 'Aurangabad', 'Bihar') && !samePlace('', '', '', ''), null);

registerClientPlaces([...L.entries()].map(([id, label]) => ({ id, label })));
check('R1 clientLabel: the registry gives the label for a client id', clientLabel({ id: 'a1', name: 'Palnadu Hospital' }) === 'Palnadu Hospital - Narasaraopet', clientLabel({ id: 'a1', name: 'Palnadu Hospital' }));
check('R2 a unique client is shown exactly as before', clientLabel({ id: 'u1', name: 'Lonely Clinic' }) === 'Lonely Clinic', null);
check('R3 a row that carries its own placeLabel wins; clientLabelOf works for an id + name pair', clientLabel({ id: 'zz', name: 'X', placeLabel: 'X - Y' }) === 'X - Y' && clientLabelOf('a2', 'Palnadu Hospital') === 'Palnadu Hospital - Guntur', null);
check('R4 nothing breaks for a missing client', clientLabel(null) === '' && clientLabel({ name: 'Only Name' }) === 'Only Name', null);
registerClientPlaces([]);
check('R5 after sign-out the labels are gone', clientLabel({ id: 'a1', name: 'Palnadu Hospital' }) === 'Palnadu Hospital', null);

// search: the label text is what a dropdown matches against
check('S1 "palnadu narasaraopet" matches the Narasaraopet label and not the Guntur one', matchesText('Palnadu Hospital - Narasaraopet', 'palnadu narasaraopet') && !matchesText('Palnadu Hospital - Guntur', 'palnadu narasaraopet'), null);
check('S2 "palnadu" alone matches both; "guntur" finds only the Guntur one', matchesText('Palnadu Hospital - Guntur', 'palnadu') && matchesText('Palnadu Hospital - Narasaraopet', 'palnadu') && !matchesText('Palnadu Hospital - Narasaraopet', 'guntur'), null);

// the wording
const qSame = { level: 'sameName', hint: 'A client with this name already exists. Choose Yes to add another location.' };
const qLikely = { level: 'likelySame' };
check('W1 sameName without a location: "Tell us the location so we can tell them apart."', gateConfirm(qSame, { location: '' }).error === 'Tell us the location so we can tell them apart.' && NEEDS_LOCATION === gateConfirm(qSame, { location: '  ' }).error && gateConfirm(qSame, { location: '' }).field === 'location', null);
check('W2 sameName with a location: fine, no reason needed', gateConfirm(qSame, { location: 'Guntur' }).ok === true, null);
check('W3 likelySame needs one line of reason', gateConfirm(qLikely, { location: 'Guntur', reason: '' }).error === NEEDS_REASON && gateConfirm(qLikely, { location: 'Guntur', reason: 'second building' }).ok, null);
check('W4 the line under the form is the plain one (no "blocked", no "Possible duplicate")', pendingLine(qSame) === 'A client with this name already exists. Choose Yes to add another location.' && !/blocked|duplicate/i.test(pendingLine(qLikely)), pendingLine(qLikely));
check('W5 the chips are plain words', chipText({ code: 'NAME' }) === 'Same name' && chipText({ code: 'PHONE' }) === 'Same phone number' && chipText({ code: 'GSTIN' }) === 'Same GST number' && chipText({ code: 'ALIAS' }) === 'Same name as an older spelling', null);
const facts = cardFacts({ location: 'Narasaraopet', agreementStatus: 'ACTIVE', requirementsCount: 3 }, (s) => s.toLowerCase());
check('W6 the card says location, agreement and requirements', facts.join('|') === 'Narasaraopet|Agreement: active|3 requirements' && cardFacts({ requirementsCount: 1 })[2] === '1 requirement' && cardFacts({})[0] === 'No location written yet', facts);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

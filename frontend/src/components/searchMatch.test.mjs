import assert from 'node:assert/strict';
import { matchesText, filterBy, noMatchText } from './searchMatch.js';

assert.equal(matchesText('Hyderabad, Telangana', 'HYD'), true);
assert.equal(matchesText('Hyderabad, Telangana', '  tel  gana '), true);
assert.equal(matchesText('Hyderabad, Telangana', 'hyd tel'), true);
assert.equal(matchesText('BDE MED-1', 'med 1'), true);
assert.equal(matchesText('BDE MED-1', 'med1'), true);
assert.equal(matchesText('Open', 'clo'), false);
assert.equal(matchesText('Anything', '   '), true);
assert.deepEqual(filterBy(['Open', 'Closed', 'Active'], 'cl'), ['Closed']);
assert.deepEqual(filterBy([{ l: 'Orbit Software' }], 'soft', (o) => o.l).length, 1);
assert.equal(noMatchText('  zz  q '), 'No match for "zz q"');
assert.equal(noMatchText(''), 'No match');
console.log('searchMatch tests passed');

// Old client names: found by the old name, label unchanged (matching only).
import { registerClientAliases, clientAliasText } from './searchMatch.js';
assert.equal(matchesText('Prabs VCare Health Clinic', 'vcare'), true); // it is in the official name anyway
assert.equal(matchesText('Zen Hospital', 'zenith'), false);
registerClientAliases([{ name: 'Zen Hospital', aliases: ['Zenith Multi Speciality'] }, { name: 'Prabs VCare Health Clinic', aliases: ['Care One'] }]);
assert.equal(matchesText('Zen Hospital', 'zenith'), true);
assert.equal(matchesText('Zen Hospital · CL-123456', 'zen mult'), true);
assert.equal(matchesText('Zen Hospital (12)', 'zenithmulti'), true);
assert.equal(matchesText('Zen Hospital Annex', 'zenith'), false);   // another client that merely starts with the same words
assert.equal(matchesText('Someone Else', 'zenith'), false);
assert.equal(matchesText('prabs vcare health clinic', 'care one'), true);
assert.equal(clientAliasText('Zen Hospital'), 'Zenith Multi Speciality');
assert.equal(clientAliasText('Unknown'), '');
registerClientAliases([]);
assert.equal(matchesText('Zen Hospital', 'zenith'), false);
console.log('client alias tests passed');

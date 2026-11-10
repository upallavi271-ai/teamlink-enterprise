#!/usr/bin/env node
/**
 * A short form of a name is the same person (utils/workers.js shortFormFits / makeResolver), founder 2026-11-10:
 * "M.Sai Sirisha" in the joining sheets is the login "Masabattula Sai Sirisha". No database is touched.
 *   node scripts/short-name-test.js
 */
const W = require('../src/utils/workers');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra)}` : ''}`); } };

check('"M.Sai Sirisha" is "Masabattula Sai Sirisha"', W.shortFormFits('M.Sai Sirisha', 'Masabattula Sai Sirisha'));
check('"M. Sai Sirisha" and "m sai sirisha" too', W.shortFormFits('M. Sai Sirisha', 'Masabattula Sai Sirisha') && W.shortFormFits('m sai sirisha', 'Masabattula Sai Sirisha'));
check('"G.Gouthami" is "Gundala Gouthami"', W.shortFormFits('G.Gouthami', 'Gundala Gouthami'));
check('a different initial is not', !W.shortFormFits('K.Sai Sirisha', 'Masabattula Sai Sirisha'));
check('no initial (just "Sai Sirisha") is not matched', !W.shortFormFits('Sai Sirisha', 'Masabattula Sai Sirisha'));
check('a word left over is not ("D.Usha" vs "D.Leela Usha Sri")', !W.shortFormFits('D.Usha', 'Dasari Leela Usha Sri'));
check('words out of order are not', !W.shortFormFits('M.Sirisha Sai', 'Masabattula Sai Sirisha'));
check('"Bhanu teja" (no surname) is "Gundala Bhanu Teja"', W.partOfName('Bhanu teja', 'Gundala Bhanu Teja') && W.shortFormOf('Bhanu teja', ['Gundala Bhanu Teja', 'Ravi Teja']) === 'gundala bhanu teja');
check('a single first name is never matched ("Sravanthi")', W.shortFormOf('Sravanthi', ['sravanthi Anumolu']) === null);
check('two people with that part of the name: nobody is picked', W.shortFormOf('Sai Sirisha', ['Masabattula Sai Sirisha', 'Kota Sai Sirisha']) === null);
check('two people who fit: nobody is picked', W.shortFormOf('M.Sai Sirisha', ['Masabattula Sai Sirisha', 'Mekala Sai Sirisha']) === null);

const users = [
  { id: 'u1', name: 'Masabattula Sai Sirisha', status: 'Active' },
  { id: 'u2', name: 'Gundala chandra Keerthana', status: 'Active' },
  { id: 'u3', name: 'Mekala Sai Sirisha', status: 'Inactive' },
];
const person = W.makeResolver(users);
check('two fit, one is active: the active login is picked', (person(null, 'M.Sai Sirisha') || {}).key === 'u:u1', person(null, 'M.Sai Sirisha'));
const solo = W.makeResolver(users.slice(0, 2));
check('the sheet\'s name and the login are ONE key on the counts', solo(null, 'M.Sai Sirisha').key === solo('u1').key && solo(null, 'Masabattula Sai Sirisha').key === 'u:u1');
check('the exact name still wins, and an unknown name stays its own', solo(null, 'Gundala chandra Keerthana').key === 'u:u2' && solo(null, 'B Koushik').key === 'n:b koushik');

console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
process.exit(failed ? 1 : 0);

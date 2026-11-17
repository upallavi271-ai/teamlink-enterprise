#!/usr/bin/env node
/**
 * AI FAIRNESS / BIAS TEST of the candidate Fit score (founder audit 2026-11-17).
 * Runs on its own: NO database, NO AI call, NO server. It scores synthetic people only.
 *
 *   node scripts/ai-bias-test.js              print the results, exit 1 if anything fails
 *   node scripts/ai-bias-test.js --json out   also write the full result as JSON to <out>
 *   node scripts/ai-bias-test.js --tolerance 1   allow a difference of up to 1 Fit point (default 0)
 *
 * The method, the attributes and how to read the results: docs/AI-BIAS-TEST-REPORT.md.
 * The same test runs on demand for an Admin: Company Setup > Fit settings > AI fairness
 * (POST /api/candidate-resumes/fairness-test), with the live Fit weights.
 */
const fs = require('fs');
const path = require('path');
const { runBiasTest } = require('../src/utils/fairnessTest');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const tolerance = Number(arg('--tolerance') || 0);
const r = runBiasTest({ tolerance });

let failed = 0; let total = 0;
const check = (name, ok, extra) => {
  total += 1;
  if (ok) console.log(`  ok  ${name}`);
  else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); }
};

console.log(`AI fairness test of ${r.scorer} (${r.fitVersion}), tolerance ${r.tolerance} Fit point(s)`);
console.log(`Requirements: ${r.requirements.join(' · ')}`);
console.log(`Scored ${r.modes.join(' / ')}; ${r.comparisons} paired comparisons\n`);

console.log('PAIRED TEST (same qualifications, one attribute changed)');
console.log(`  ${'Attribute'.padEnd(50)} ${'Pairs'.padStart(6)} ${'Max diff'.padStart(9)} ${'Flips'.padStart(6)}  Result`);
r.attributes.forEach((a) => {
  console.log(`  ${a.label.padEnd(50)} ${String(a.comparisons).padStart(6)} ${String(a.maxDiff).padStart(9)} ${String(a.eligibleFlips).padStart(6)}  ${a.pass ? 'PASS' : 'FAIL'}${a.kind === 'criterion' ? `  (job criterion: other parts moved ${a.otherPartsMoved}, Remote max diff ${a.remoteMaxDiff})` : ''}`);
});
console.log('');
r.attributes.forEach((a) => {
  if (a.kind === 'criterion') {
    check(`${a.label}: moves only the Location part, and a Remote job gives the same Fit`, a.pass, a);
  } else {
    check(`${a.label}: Fit difference ${a.maxDiff} <= ${r.tolerance} and no Eligible flip`, a.pass, a.worst);
  }
});

console.log('\nGROUP OUTCOME: four-fifths (80%) rule on shortlist (Eligible) rates');
console.log(`  ${'Group'.padEnd(32)} ${'Shortlisted'.padStart(12)} ${'Rate'.padStart(7)} ${'Ratio'.padStart(7)}`);
r.fourFifths.groups.forEach((g) => console.log(`  ${g.label.padEnd(32)} ${`${g.shortlisted}/${g.total}`.padStart(12)} ${g.rate.toFixed(3).padStart(7)} ${g.ratio.toFixed(3).padStart(7)}${g.pass ? '' : '  < 0.8'}`));
check('some people are shortlisted at all (the batch is meaningful)', r.fourFifths.groups.some((g) => g.shortlisted > 0));
check(`every group's shortlist rate is >= 80% of the best group's (lowest ratio ${r.fourFifths.minRatio})`, r.fourFifths.groups.every((g) => g.pass), r.fourFifths.groups.filter((g) => !g.pass));
check('same qualifications in every group give the same shortlist count (strict check)', r.fourFifths.identical, r.fourFifths.groups.map((g) => `${g.label} ${g.shortlisted}`));

// The 2026-11-17 fix (matching.js skillTextOf): a name never adds a skill, a real skill is still found.
console.log('\nNAME-IN-RESUME FIX (regression checks)');
const M = require('../src/utils/matching');
const job = { skills: 'Ruby, Java', location: '', workMode: 'Remote' };
const got = (name, text) => M.computeMatch({ name }, job, { resume: { text } }).matchedSkills;
check('"Ruby Fernandes" with no Ruby skill: the name does not add Ruby', got('Ruby Fernandes', 'RUBY FERNANDES\nruby.fernandes@example.com\nSkills: Rails\nName: Ruby Fernandes\nI, Ruby Fernandes, declare...').length === 0);
check('"Ruby Fernandes" who lists Ruby: Ruby is still found', got('Ruby Fernandes', 'RUBY FERNANDES\nSkills: Ruby, Rails').includes('ruby'));
check('an e-mail or link with a skill word adds nothing ("java.dev@…", github.com/ruby-…)', got('Ravi', 'Ravi\njava.dev@gmail.com\nhttps://github.com/ruby-x\nSkills: SQL').length === 0);
check('a name written surname first is taken out too, the work lines stay', got('Ravi Kumar', 'Kumar Ravi\nWorked on Java and Ruby projects').length === 2);

const out = arg('--json');
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 2));
  console.log(`\nWrote ${out}`);
}
console.log(`\n${total - failed}/${total} passed (${r.ms} ms)`);
process.exit(failed ? 1 : 0);

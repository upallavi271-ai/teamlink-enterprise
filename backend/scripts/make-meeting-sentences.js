#!/usr/bin/env node
// Makes backend/src/marketing/meetingSentences.json: every sentence the Plans meeting page can ask the server to speak (marketing/meetingVoice.js speaks ONLY these, so the public
// voice address can never be used to read other text). It reads the page's own words (frontend/src/components/omni/marketing/meetingContent.js and meetingBudget.js) and cuts them into
// sentences exactly as the page does (meetingLogic.js sentencesOf). Run it again after the words change:   cd backend && node scripts/make-meeting-sentences.js
// (scripts/omni-mk-meeting-test.js checks that the file still covers every sentence the page can speak.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.resolve(__dirname, '../../frontend/src/components/omni/marketing');
const OUT = path.resolve(__dirname, '../src/marketing/meetingSentences.json');
const sentencesOf = (text) => (String(text || '').match(/[^.!?।]+[.!?।]*\s*/g) || []).map((x) => x.trim()).filter(Boolean);

// the page's files are ES modules: copy them (same names) to a temporary folder marked as ES modules and import them
async function loadFrontend(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sent-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  fs.readdirSync(DIR).filter((f) => /^meeting.*\.js$/.test(f)).forEach((f) => fs.copyFileSync(path.join(DIR, f), path.join(tmp, f)));
  const out = {};
  for (const n of names) out[n] = await import(pathToFileURL(path.join(tmp, `${n}.js`)).href); // eslint-disable-line no-await-in-loop
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the temp folder is cleaned by the system */ }
  return out;
}
async function build() {
  const { meetingContent: C, meetingBudget: B, meetingPlans: PL } = await loadFrontend(['meetingContent', 'meetingBudget', 'meetingPlans']);
  const out = { en: new Set(), te: new Set(), hi: new Set() };
  const add = (lang, text) => sentencesOf(text).forEach((s) => { if (!/[\[\]]/.test(s)) out[lang].add(s); }); // a sentence with [N] / [X] / [link] is filled in at run time: not spoken by the server
  for (const lang of Object.keys(out)) {
    C.SLIDES.forEach((s) => add(lang, s.voice[lang]));
    C.FAQ.forEach((f) => add(lang, f.answer[lang]));
    ['L1', 'L2', 'L3', 'L4'].forEach((k) => add(lang, C.STANDARD[k][lang]));
  }
  // the budget answers are written per language in meetingBudget.js: put each sentence under the language it is in
  for (const lang of Object.keys(out)) {
    Object.values(B.REPLY).forEach((r) => add(lang, r[lang]));
    add(lang, B.TAIL[lang]);
    [PL.PRICE, PL.DETAILS, PL.COMPARE].forEach((set) => Object.values(set).forEach((r) => add(lang, r[lang])));
  }
  return { en: [...out.en], te: [...out.te], hi: [...out.hi] };
}
if (require.main === module) {
  build().then((j) => {
    fs.writeFileSync(OUT, `${JSON.stringify(j, null, 1)}\n`);
    console.log('written', OUT, `en ${j.en.length}, te ${j.te.length}, hi ${j.hi.length} sentences`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { build, sentencesOf, loadFrontend };

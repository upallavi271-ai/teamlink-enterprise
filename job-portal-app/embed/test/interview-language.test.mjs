// TEAMLINK - the AI interview in the candidate's language (founder 2026-11-05). No database, no model, no voice engine.
//   node --test job-portal-app/embed/test/interview-language.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { fromTable, speakable, translateQuestion, answerToEnglish, hear, say, soundOf } from '../interview-language.mjs';

const HERE = import.meta.dirname;
const PORTAL = join(HERE, '..', '..', 'job_portal-main', 'api', 'src', 'ai');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';
const style = await import(pathToFileURL(join(PORTAL, 'interview-style.js')).href);
const plan = await import(pathToFileURL(join(PORTAL, 'interview.js')).href);

const TE = /[ఀ-౿]/; const HI = /[ऀ-ॿ]/;
const JOBS = [
  { title: 'Staff Nurse', skills: ['IV cannulation', 'Patient care', 'Wound dressing', 'ICU', 'Vital signs', 'BLS'], description: 'Manage patient records. Assist doctors in the ward.', responsibilities: ['Manage the ward roster'], requirements: ['Payroll processing and vendor management for the hospital unit'] },
  { title: 'Recruiter', skills: ['Sourcing', 'Node.js', 'Naukri'], description: '' },
  { title: 'Teacher', skills: [], description: '' },
];
const CANDS = [
  {},
  { title: 'Senior Nurse', currentCompany: 'Apollo', skills: ['Patient care'], projects: ['Ward audit'], education: 'BSc Nursing' },
  { title: 'Trainer', skills: ['Sourcing', 'Excel'], projects: [{ name: 'Campus hiring drive' }, { name: 'Vendor portal' }], summary: 'x' },
];

test('every question the portal rules planner writes is in the table, in Telugu and Hindi', () => {
  const missed = new Set(); let n = 0;
  for (const job of JOBS) {
    for (const candidate of CANDS) {
      for (const q of plan.planFromJob({ job, candidate })) {
        n += 1;
        for (const [lang, rx] of [['te', TE], ['hi', HI]]) {
          const t = fromTable(q.question, lang);
          if (!t || !rx.test(t)) missed.add(q.question);
        }
      }
    }
  }
  assert.ok(n > 30);
  assert.deepEqual([...missed], []);
});

test('the follow-ups and the fixed replies are in the table; a skill name stays in place', () => {
  for (const t of [...style.FOLLOW_UP_TEMPLATES, style.NO_EXPERIENCE_REPLY, style.REPHRASE_REPLY]) {
    assert.ok(TE.test(fromTable(t, 'te') || ''), t); assert.ok(HI.test(fromTable(t, 'hi') || ''), t);
  }
  const q = style.skillQuestion('Node.js', 0);
  assert.ok(fromTable(q, 'te').includes('Node.js'));
});

test('a sentence not in the table: a model with real script is used, anything else stays in English', async () => {
  const q = 'Why do you like hospitals so much?';
  assert.equal(fromTable(q, 'te'), null);
  const good = await translateQuestion('.', q, 'te', { ask: async () => 'మీకు ఆసుపత్రులు ఎందుకు ఇష్టం?' });
  assert.deepEqual(good, { text: 'మీకు ఆసుపత్రులు ఎందుకు ఇష్టం?', done: true });
  const bad = await translateQuestion('.', 'Why not something else?', 'te', { ask: async () => 'Sure! Here it is.' });
  assert.equal(bad.done, false); assert.equal(bad.text, 'Why not something else?');
  const none = await translateQuestion('.', 'And one more?', 'hi', { ask: async () => null });
  assert.equal(none.done, false);
});

test('an answer goes to English only when a real translation came back', async () => {
  const ok = await answerToEnglish('.', 'నేను ఐదు సంవత్సరాలు పని చేశాను', 'te', { ask: async () => 'I worked for five years' });
  assert.deepEqual(ok, { ok: true, text: 'I worked for five years' });
  const same = await answerToEnglish('.', 'నేను నర్సుగా పని చేశాను', 'te', { ask: async () => 'నేను నర్సుగా పని చేశాను' });
  assert.equal(same.ok, false);
  const none = await answerToEnglish('.', 'मैंने काम किया है', 'hi', { ask: async () => { throw new Error('down'); } });
  assert.equal(none.ok, false); assert.equal(none.text, 'मैंने काम किया है');
});

test('the voice gets no English letters', () => {
  for (const lang of ['te', 'hi']) {
    const s = speakable(fromTable(style.skillQuestion('Sourcing in HR, Node.js', 0), lang), lang);
    assert.ok(!/[A-Za-z]/.test(s), s);
  }
  assert.ok(speakable('Sourcing', 'te').startsWith('స'));
  assert.ok(speakable('HR', 'hi').includes('एच'));
});

test('hear and say reach TeamLink with the bridge secret; no engines = ready:false', async () => {
  const api = { url: 'http://tl', secret: 's3' };
  let seen;
  const f1 = async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ ready: true, lang: 'Telugu', changed: true, text: ' నేను ' }) }; };
  assert.deepEqual(await hear(api, Buffer.alloc(9), 'en', { fetch: f1 }), { ready: true, lang: 'te', changed: true, text: 'నేను' });
  assert.match(seen.u, /interview-voice\?op=hear&lang=English$/); assert.equal(seen.o.headers['x-job-portal-secret'], 's3');
  assert.deepEqual(await hear(api, Buffer.alloc(9), 'en', { fetch: async () => ({ ok: true, json: async () => ({ ready: false }) }) }), { ready: false });
  assert.deepEqual(await hear(api, Buffer.alloc(9), 'en', { fetch: async () => { throw new Error('off'); } }), { ready: false });
  const wav = Buffer.from('RIFFwav');
  const r = await say(api, 'నమస్తే అండి', 'te', { fetch: async () => ({ ok: true, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => wav }) });
  assert.equal(r.ready, true); assert.deepEqual(soundOf(r.key), wav);
  assert.deepEqual(await say(api, 'వేరే మాట', 'te', { fetch: async () => ({ ok: true, headers: { get: () => 'application/json' } }) }), { ready: false });
});

/* ---- the browser half, on a stand-in page ---- */
function page({ preferredLanguage = 'en', hearReply = { ready: true, lang: 'en', changed: false } } = {}) {
  const calls = []; const spoken = []; const played = [];
  class SR {
    constructor() { this.started = 0; SR.last = this; }

    start() { this.started += 1; SR.langs.push(this.lang); }

    stop() {}

    abort() { if (this.onend) this.onend(); }
  }
  SR.langs = [];
  const post = async (p, b) => { calls.push({ p, b }); return { saved: true, ...(b.seq === 2 ? { followUp: 'What was the outcome?' } : {}) }; };
  const win = {
    TL_API_BASE: '/jobs/api', webkitSpeechRecognition: SR,
    TL: { api: { post }, __aiivSession: { appId: 'a1', interviewId: 'iv1', speech: { tts: 'browser' }, questions: [{ seq: 1, q: 'Could you share a specific example?' }, { seq: 2, q: 'What was the outcome?' }] } },
    AIIV: { appId: 'a1', phase: 'interview', listening: true, idx: 0, part: 'main', sttText: '', sttFinal: '' },
    STATE: { session: { id: 'c1', role: 'candidate' } }, DATA: { candidateById: () => ({ preferredLanguage }) },
    speechSynthesis: { speak: (u) => spoken.push(u), cancel() {}, getVoices: () => [] },
    Audio: class { constructor(u) { played.push(u); } play() { setTimeout(() => this.onended && this.onended(), 0); return Promise.resolve(); } pause() {} },
  };
  const elements = {};
  const doc = {
    readyState: 'complete', addEventListener() {}, head: { appendChild() {} }, getElementById: (id) => elements[id] || null,
    body: { appendChild(el) { if (el.id) elements[el.id] = el; } },
    createElement: () => { const el = { dataset: {}, style: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector: () => ({}), querySelectorAll: () => [], remove() { delete elements[el.id]; } }; return el; },
  };
  const fetcher = async (u, o) => {
    const b = JSON.parse(o.body); calls.push({ p: u, b });
    let out = {};
    if (u.endsWith('/translate')) out = { items: b.texts.map((t) => ({ text: fromTable(t, b.lang) || t, done: !!fromTable(t, b.lang) })) };
    if (u.endsWith('/hear')) out = hearReply;
    if (u.endsWith('/say')) out = { ready: true, key: 'k1' };
    if (u.endsWith('/to-english')) out = b.text.includes('లేదు') ? { ok: false } : { ok: true, text: 'I did this work' };
    return { ok: true, json: async () => out };
  };
  win.window = win; win.document = doc; win.fetch = fetcher;
  win.setInterval = () => 0; win.setTimeout = setTimeout; win.clearTimeout = clearTimeout; win.console = console;
  win.localStorage = { getItem: () => null, setItem() {} }; win.sessionStorage = win.localStorage;
  win.location = { hash: '', pathname: '/jobs/' }; win.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  win.addEventListener = () => {}; win.removeEventListener = () => {};
  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(join(HERE, '..', 'interview-addon.js'), 'utf8'), ctx);
  return { win, calls, spoken, played, SR, T: win.__tlInterviewAddonTest };
}
const settle = (ms = 15) => new Promise((r) => { setTimeout(r, ms); });

test('browser: every interview starts in English (founder 2026-11-11), even with Telugu as the Preferred language; no language buttons', async () => {
  const P = page({ preferredLanguage: 'te' });
  P.T.langTick(); await settle();
  assert.equal(P.T.LG.cur, 'en');
  assert.equal(P.win.TL.__aiivSession.questions[0].q, 'Could you share a specific example?');
  assert.equal(P.win.document.getElementById('tllang'), null, 'no bar with English / Telugu / Hindi buttons');
  const r0 = new P.win.webkitSpeechRecognition(); r0.start();
  assert.equal(P.SR.langs.at(-1), 'en-IN');
});

test('browser: the candidate speaking Telugu moves the recogniser and the questions to Telugu', async () => {
  const P = page({ preferredLanguage: 'te' });
  P.T.langTick(); await settle();
  P.T.switchTo('te', ''); await settle();
  assert.equal(P.T.LG.cur, 'te');
  assert.equal(P.win.TL.__aiivSession.questions[0].q, fromTable('Could you share a specific example?', 'te'));
  assert.equal(P.win.TL.__aiivSession.questions[0].__en, 'Could you share a specific example?');
  const r = new P.win.webkitSpeechRecognition(); r.start();
  assert.equal(P.SR.langs.at(-1), 'te-IN');
});

test('browser: English words stay English; a clear Telugu or Hindi answer moves it', () => {
  const { fromWords } = page().T;
  assert.equal(fromWords('I have five years of experience in nursing and patient care', 'en'), null);
  assert.equal(fromWords('nenu nurse ga chesanu naa peru ramesh ikkada undi', 'en'), 'te');
  assert.equal(fromWords('mera naam ramesh hai main nurse hoon aur kaam kiya', 'en'), 'hi');
  assert.equal(fromWords('నేను ఐదు సంవత్సరాలు పని చేశాను ఆసుపత్రిలో బాగా', 'en'), 'te');
  assert.equal(fromWords('I am speaking in English now about my work', 'te'), 'en');
  assert.equal(fromWords('two words', 'en'), null);
});

test('browser: a switch in the middle of an answer restarts capture in that language and writes the words again', async () => {
  const P = page();
  P.T.langTick(); await settle();
  const r = new P.win.webkitSpeechRecognition(); r.lang = 'en-IN'; r.start();
  P.win.AIIV.rec = r; P.win.AIIV.sttText = 'nay new garbled'; P.win.AIIV.confSum = 0.2; P.win.AIIV.confN = 1;
  P.T.switchTo('te', 'నేను నర్సుగా పని చేశాను');
  await settle(250);
  assert.equal(P.win.AIIV.sttText, 'నేను నర్సుగా పని చేశాను');
  assert.equal(P.win.AIIV.confN, 0);
  assert.equal(P.SR.langs.at(-1), 'te-IN');
  assert.ok(P.calls.some((c) => String(c.p).endsWith('/translate')));
});

test('browser: the answer saved is English and marked; no translator = flagged for a person; the follow-up comes translated', async () => {
  const P = page({ preferredLanguage: 'te' });
  P.T.langTick(); await settle(); P.T.switchTo('te', ''); await settle();
  const { api } = P.win.TL;
  const r = await api.post('/ai-interviews/iv1/answer', { seq: 1, transcript: 'నేను ఈ పని చేశాను' });
  assert.equal(r.saved, true);
  const saved = () => P.calls.filter((c) => c.p === '/ai-interviews/iv1/answer').at(-1).b;
  assert.equal(saved().transcript, 'I did this work (Spoken in Telugu; translated to English by machine.)');
  await api.post('/ai-interviews/iv1/answer', { seq: 3, transcript: 'నాకు తెలియదు లేదు' });
  assert.equal(saved().confidence, 0.5); assert.match(saved().transcript, /లేదు/);
  const f = await api.post('/ai-interviews/iv1/answer', { seq: 2, transcript: 'I did it' });
  assert.equal(f.followUp, fromTable('What was the outcome?', 'te'));
  assert.equal(saved().transcript, 'I did it');
});

test('browser: a Telugu line goes to the server voice, an English line to the browser voice', async () => {
  const P = page({ preferredLanguage: 'te' });
  P.T.langTick(); await settle(); P.T.switchTo('te', ''); await settle();
  let ended = 0;
  P.win.speechSynthesis.speak({ text: 'దాని ఫలితం ఏమిటి?', onend: () => { ended += 1; } });
  await settle();
  assert.deepEqual(P.played, ['/jobs/api/tl-interview/audio/k1']);
  assert.equal(ended, 1); assert.equal(P.spoken.length, 0);
  P.win.speechSynthesis.speak({ text: 'What was the outcome?' });
  assert.equal(P.spoken.length, 1);
});

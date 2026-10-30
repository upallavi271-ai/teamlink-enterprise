// ---------------------------------------------------------------------------
// job-portal-app/embed/interview-addon.js and interview-coach.mjs - the AI interview add-on, tested without a browser or a real
// candidate: the add-on runs in a small stand-in page (fake speech recogniser, fake microphone, fake portal API); the coach runs
// against a stand-in portal folder (fake session + config) and a fake database answer.
//   node scripts/interview-addon-test.js
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const EMBED = path.join(__dirname, '..', '..', 'job-portal-app', 'embed');
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

// ---- a stand-in page ----
function page() {
  const timers = []; const intervals = [];
  const appended = [];
  const el = (tag) => ({ tag, className: '', id: '', innerHTML: '', textContent: '', dataset: {}, style: {}, setAttribute() {}, remove() { const i = appended.indexOf(this); if (i >= 0) appended.splice(i, 1); }, querySelector() { return { onclick: null }; }, appendChild() {} });
  const document = {
    readyState: 'complete', head: { appendChild(x) { appended.push(x); } }, body: { appendChild(x) { appended.push(x); } },
    createElement: el, getElementById: (id) => appended.find((x) => x.id === id) || null, addEventListener() {},
  };
  class FakeRec {
    constructor() { FakeRec.made.push(this); this.starts = 0; this.stops = 0; this.throwNext = false; }
    start() { if (this.throwNext) { this.throwNext = false; throw new Error('InvalidStateError'); } this.starts += 1; this.startedWith = { lang: this.lang, continuous: this.continuous, interimResults: this.interimResults }; }
    stop() { this.stops += 1; }
    abort() { this.stops += 1; }
  }
  FakeRec.made = [];
  const win = {
    webkitSpeechRecognition: FakeRec, TL_API_BASE: '/jobs/api', location: { hash: '' }, history: { back() {} },
    sessionStorage: { _: {}, getItem(k) { return this._[k] || null; }, setItem(k, v) { this._[k] = String(v); } },
    addEventListener() {}, fetch: async () => ({ status: 200, json: async () => ({}) }),
  };
  const ctx = {
    window: win, document, location: win.location, history: win.history, sessionStorage: win.sessionStorage, fetch: (...a) => win.fetch(...a),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: (id) => { intervals[id - 1] = null; },
    Float32Array, Math, Date, Promise, String, Number, Array, JSON, Error, console,
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EMBED, 'interview-addon.js'), 'utf8'), ctx);
  return { ctx, win, FakeRec, timers, intervals, appended, runTimers() { const t = timers.splice(0); t.forEach((x) => x.fn()); }, runIntervals() { intervals.forEach((f) => f && f()); } };
}

(async () => {
  // ================= 1. live capture keeps going =================
  {
    const P = page();
    const SR = P.win.webkitSpeechRecognition;
    ok('the page gets the stand-in recogniser', SR !== P.FakeRec && SR.__tlWrapped === true);
    const r = new SR();
    r.lang = 'en-IN'; r.continuous = true; r.interimResults = true;
    const heard = []; let pageEnd = 0; let pageErr = null;
    r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i += 1) if (e.results[i].isFinal) heard.push(e.results[i][0].transcript); };
    r.onend = () => { pageEnd += 1; };
    r.onerror = (ev) => { pageErr = ev.error; };
    r.start();
    const inner = P.FakeRec.made[0];
    ok('it starts the real recogniser with the page\'s settings', inner.starts === 1 && inner.startedWith.lang === 'en-IN' && inner.startedWith.continuous === true);
    inner.onresult({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, length: 1, 0: { transcript: 'I worked on react for', confidence: 0 } } } });
    inner.onerror({ error: 'no-speech' });
    inner.onend();
    ok('words still in progress when the browser cut the session are kept', heard.includes('I worked on react for'), JSON.stringify(heard));
    ok('an unplanned end does not reach the page (no double start)', pageEnd === 0);
    P.runTimers();
    ok('...and the capture starts again by itself', inner.starts === 2);
    inner.throwNext = true;
    inner.onend();
    P.runTimers();
    ok('a recogniser that will not start again is replaced by a fresh one', P.FakeRec.made.length === 2 && P.FakeRec.made[1].starts === 1);
    const inner2 = P.FakeRec.made[1];
    inner2.onerror({ error: 'network' }); inner2.onend(); P.runTimers();
    inner2.onerror({ error: 'network' }); inner2.onend(); P.runTimers();
    inner2.onerror({ error: 'network' }); inner2.onend(); P.runTimers();
    ok('three network failures in a minute: the candidate is told to use Chrome / Edge', P.appended.some((x) => /Google Chrome or Microsoft Edge/.test(x.innerHTML)));
    inner2.onresult({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, length: 1, 0: { transcript: 'half a word', confidence: 0 } } } });
    const before = inner2.starts;
    r.stop();
    inner2.onend();
    P.runTimers();
    ok('Submit / time up (a deliberate stop): no restart and no late words into the next answer', inner2.starts === before && !heard.includes('half a word') && pageEnd === 1);
    const r2 = new SR(); r2.onerror = (ev) => { pageErr = ev.error; }; r2.start();
    const inner3 = P.FakeRec.made[P.FakeRec.made.length - 1];
    inner3.onerror({ error: 'not-allowed' }); inner3.onend(); P.runTimers();
    ok('microphone refused: the page hears it, nothing restarts', pageErr === 'not-allowed' && inner3.starts === 1);
  }

  // ================= 2. another voice while answering =================
  {
    const P = page();
    const T = P.win.__tlInterviewAddonTest;
    const sine = (hz) => (buf) => { for (let i = 0; i < buf.length; i += 1) buf[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / 48000); };
    const p1 = T.pitch((() => { const b = new Float32Array(2048); sine(150)(b); return b; })(), 48000);
    const p2 = T.pitch((() => { const b = new Float32Array(2048); sine(320)(b); return b; })(), 48000);
    const p0 = T.pitch(new Float32Array(2048), 48000);
    ok('pitch: a 150 Hz voice reads ~150 Hz, a 320 Hz voice ~320 Hz, silence nothing', Math.abs(p1.hz - 150) < 6 && Math.abs(p2.hz - 320) < 12 && p0 === null, `${Math.round(p1.hz)} / ${Math.round(p2.hz)}`);
    let fill = sine(150);
    const analyser = { fftSize: 2048, getFloatTimeDomainData: (b) => fill(b) };
    const posts = []; const warns = []; const stops = [];
    let answer = { action: 'warn', strike: 1, message: 'Warning 1 of 2: another voice was heard.' };
    P.win.TL = { __aiivSession: { appId: 'app1', interviewId: 'iv1' }, api: { post: async (url, body) => { posts.push({ url, body }); return answer; } } };
    P.win.AIIV = { appId: 'app1', phase: 'interview', listening: true, stream: {}, audioCtx: { sampleRate: 48000, createMediaStreamSource: () => ({ connect() {} }), createAnalyser: () => analyser } };
    P.win.tlIntegrityWarn = (strike, message) => warns.push([strike, message]);
    P.win.tlProctorStop = (kind, message) => stops.push([kind, message]);
    for (let i = 0; i < 40; i += 1) T.tick();                     // the candidate's own voice is learned
    for (let i = 0; i < 60; i += 1) T.tick();                     // the candidate keeps answering
    ok('the candidate alone, answering: no warning', posts.length === 0, `baseline ${Math.round(T.V.baseHz)} Hz`);
    fill = sine(330);                                             // another person talks in the background
    for (let i = 0; i < 30; i += 1) T.tick();
    await new Promise((r) => setImmediate(r));
    ok('another voice for 3 s while answering -> reported to the portal\'s integrity check', posts.length === 1 && posts[0].url === '/ai-interviews/iv1/integrity' && posts[0].body.type === 'additional_voice');
    ok('...and the portal\'s "Warning 1 of 2" is shown', warns.length === 1 && warns[0][0] === 1);
    for (let i = 0; i < 30; i += 1) T.tick();
    ok('within 20 s of a warning: not reported again (one moment = one strike)', posts.length === 1);
    T.V.lastReport = Date.now() - 21000;
    answer = { action: 'suspend', strike: 2, message: 'The interview was stopped: another voice was heard again.', retakeAvailableAt: null };
    for (let i = 0; i < 30; i += 1) T.tick();
    await new Promise((r) => setImmediate(r));
    ok('the second time: the server says stop -> 2 of 2 shown and the interview stops', posts.length === 2 && warns.length === 2 && stops.length === 1 && stops[0][0] === 'additional_voice');
    P.win.AIIV.listening = false; T.V.lastReport = 0;
    for (let i = 0; i < 40; i += 1) T.tick();
    ok('between answers this check is quiet (the portal\'s own quiet-room check covers that time)', posts.length === 2);
  }

  // ================= 4. recordings land before the interview closes; 3. the result on the last screen =================
  {
    const P = page();
    let drained = false; let finished = null;
    P.win.TL = { finishAiSession: async (rec, ses) => { finished = { drainedFirst: drained, id: ses.interviewId }; return { status: 'completed' }; } };
    let release;
    P.win.TLVI = { uploads: { drained: () => new Promise((r) => { release = () => { drained = true; r(); }; }) }, completeHtml: () => '<div class="tlvi"><p>Done.</p><div class="tlvi-actions"><button>My Applications</button></div></div>' };
    P.runIntervals();
    const done = P.win.TL.finishAiSession({}, { interviewId: 'iv9' });
    await new Promise((r) => setImmediate(r));
    ok('finish waits for the answer recordings', finished === null);
    release(); await done;
    ok('...then closes the interview', finished && finished.drainedFirst === true && finished.id === 'iv9');
    const html = P.win.TLVI.completeHtml({});
    ok('the closing screen gets the result block', /id="tlCoach"/.test(html) && html.indexOf('tlCoach') < html.indexOf('tlvi-actions'));
  }

  // ================= the coach (server) =================
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-coach-'));
    const root = path.join(tmp, 'job_portal-main');
    fs.mkdirSync(path.join(root, 'api', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'api', 'src', 'config.js'), "export const config = { sessionCookie: 'tl_session', aiApiKey: '' };\n");
    fs.writeFileSync(path.join(root, 'api', 'src', 'auth.js'), "export async function resolveSession(t) { return t === 'cand' ? { role: 'candidate', profileId: 'c1' } : t === 'rec' ? { role: 'recruiter' } : null; }\n");
    const coach = await import(pathToFileURL(path.join(EMBED, 'interview-coach.mjs')).href);
    let status = 'completed';
    const withUser = async (s, fn) => fn({
      query: async (sql, params) => {
        if (/from ai_interviews/.test(sql)) return { rows: params[1] === 'c1' && params[0] === 'iv1' ? [{ id: 'iv1', status, overall_percentage: 52, technical_score: 48, behavioral_score: 60, communication_score: 55, jd_relevance: 50, resume_relevance: 40, content_scored: true, completed_at: '2026-10-30T05:00:00Z', job_title: 'React Developer', job_skills: ['React', 'Redux', 'TypeScript'] }] : [] };
        return { rows: [
          { seq: 1, category: 'technical', question: 'How do you manage state in React?', answered: true, answer_summary: 'I use hooks', score: 30, comm_score: 40, justification: '' },
          { seq: 2, category: 'behavioral', question: 'Tell me about a hard deadline.', answered: false, answer_summary: '', score: 0, comm_score: null, justification: '' },
          { seq: 3, category: 'technical', question: 'What is a component?', answered: true, answer_summary: 'A component is a reusable piece of the screen that takes props and returns what to show, and I built many of them in my last project for the billing pages using React and TypeScript.', score: 85, comm_score: 80, justification: '' },
        ] };
      },
    });
    const req = (cookie) => ({ headers: { cookie } });
    let r = await coach.coachFor({ root, req: req(''), withUser, interviewId: 'iv1' });
    ok('coach: not signed in -> 401', r.status === 401);
    r = await coach.coachFor({ root, req: req('tl_session=rec'), withUser, interviewId: 'iv1' });
    ok('coach: a recruiter / admin -> 403 (they have the portal\'s full report)', r.status === 403);
    r = await coach.coachFor({ root, req: req('tl_session=cand'), withUser, interviewId: 'other' });
    ok('coach: someone else\'s interview -> 404', r.status === 404);
    status = 'in_progress';
    r = await coach.coachFor({ root, req: req('tl_session=cand'), withUser, interviewId: 'iv1' });
    ok('coach: not finished yet -> 409 "being prepared"', r.status === 409);
    status = 'completed';
    r = await coach.coachFor({ root, req: req('a=b; tl_session=cand'), withUser, interviewId: 'iv1' });
    const q = (n) => r.body.questions.find((x) => x.seq === n);
    ok('coach: the candidate gets the portal\'s own score (52%) and every question', r.status === 200 && r.body.overall === 52 && r.body.questions.length === 3 && r.body.engine === 'rules');
    ok('coach: a short, weak answer -> what went wrong + what to change', /did not cover/.test(q(1).mistake) && /3-4 sentences/.test(q(1).suggestion) && /Redux/.test(q(1).suggestion), q(1).suggestion);
    ok('coach: an answer not heard -> says so and how to fix it', /No answer was captured/.test(q(2).mistake) && /speak clearly|Speak clearly/i.test(q(2).suggestion));
    ok('coach: a good answer -> "Good answer."', q(3).mistake === 'Good answer.');
    ok('coach: three tips, the first about the unanswered question', r.body.tips.length === 3 && /not answered or not heard/.test(r.body.tips[0]));
    ok('coach: cached for the next visit', fs.existsSync(path.join(tmp, 'run', 'coach-cache.json')));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

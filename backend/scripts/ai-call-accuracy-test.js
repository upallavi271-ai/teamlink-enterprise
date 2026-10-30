#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AI PHONE CALL - ANSWER ACCURACY (founder 2026-10-29, fixes 1-8): the candidate's cases A-T, read as text, plus the
// hearing rules (unclear audio, silence, a language guessed from noise) and one whole silent call through the gateway on a
// COPY of dev.db (deleted at the end).
//
//   cd backend && node scripts/ai-call-accuracy-test.js
//
// Text level only (plus the gateway's timers): real phone audio is still to be tried on a real call.
// ---------------------------------------------------------------------------
process.env.AI_VOICE_SILENCE_MS = process.env.AI_VOICE_SILENCE_MS || '4000';
const path = require('path'); const fs = require('fs'); const net = require('net'); const crypto = require('crypto');

const B = path.resolve(__dirname, '..');
const S = require(path.join(B, 'src/calling/scripts'));
const { Dialogue, classify } = require(path.join(B, 'src/calling/dialogue'));

let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 400) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = S.buildData({ candidate: { name: 'Ravi Kumar' }, requirement: { title: 'Staff Nurse', location: 'Hyderabad' }, app: {} });
const mk = (purpose = 'Screening', language = 'English', d = data) => new Dialogue({ purpose, language, data: d });
const P = S.phrases('English');
async function to(d, step, answers) { // walk a Screening call to a step with plain answers
  d.start();
  for (const a of answers) await d.hear(a); // eslint-disable-line no-await-in-loop
  if (step) ok(d.st.step === step, `   (setup reached step ${step})`, d.st.step);
}

(async () => {
  // ---- A. "Do you have two minutes?" - "Yes, I have." ---------------------------------------------------------------
  let d = mk(); await to(d, 'convenient', ['yes speaking']);
  let r = await d.hear('Yes, I have.');
  ok(d.st.step === 'intro' && /job open|opening for/i.test(r.say), 'A  "Yes, I have." to "two minutes?" -> the job is explained', r.say);

  // ---- K. the real misheard answer: "Yes, I can't tell you so much about it." -------------------------------------
  d = mk(); await to(d, 'convenient', ['yes speaking']);
  r = await d.hear("Yes, I can't tell you so much about it.");
  ok(r.say === P.yesOrNo && d.st.step === 'convenient' && !d.st.callback, 'K  yes + "can\'t" is never read as no: "Sorry, was that a yes or a no?" (no call-back invented)', r.say);
  r = await d.hear('yes');
  ok(d.st.step === 'intro', 'K2 ... "yes" then goes on', d.st.step);

  // ---- B / H. not interested: one polite question, then accepted ----------------------------------------------------
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  r = await d.hear("No, I'm not interested");
  ok(r.say === P.whyNot && !r.done, 'H  "not interested": ONE optional question (this job, or not looking now?)', r.say);
  r = await d.hear('not looking for a change right now');
  ok(r.done && d.outcome().outcome === 'Not Interested' && /not looking for a change/.test(d.outcome().summary), 'H2 ... then accepted; their own words are the reason', d.outcome().summary);
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  await d.hear('no'); r = await d.hear('no');
  ok(r.done && d.outcome().outcome === 'Not Interested' && !d.st.declineReason, 'H3 "no" to the why-question: accepted, nothing made up as the reason', d.st.declineReason);

  // ---- J. salary objection at the why-question ----------------------------------------------------------------------
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  await d.hear('not interested'); r = await d.hear('the salary is too low');
  ok(r.done && /salary is too low/.test(d.outcome().summary) && !/lakh|LPA|₹/i.test(r.say), 'J  "salary too low" is kept as their reason; no salary is promised', d.outcome().summary);

  // ---- C. conditional: "It depends on the salary" -----------------------------------------------------------------------
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  r = await d.hear('It depends on the salary');
  ok(/don't have that detail|confirm that with the team/i.test(r.say) && d.st.interest === null && !r.done, 'C  "depends on the salary": answered honestly (no salary on file), interest NOT recorded either way', [r.say, d.st.interest]);
  r = await d.hear('maybe');
  ok(d.st.interest === 'unsure' && d.st.step === 'human_offer', 'C2 "maybe" = unsure, offered a recruiter (never Interested / Not Interested)', d.st);

  // ---- G. interview availability: "I'll check" -------------------------------------------------------------------------
  const iv = S.buildData({ candidate: { name: 'Ravi Kumar' }, requirement: { title: 'Staff Nurse', location: 'Hyderabad' }, app: { interviewAt: new Date(Date.now() + 86400000), interviewMode: 'Online' } });
  d = mk('Interview Notification', 'English', iv); d.start(); await d.hear('yes speaking');
  if (d.st.step === 'avail') {
    r = await d.hear("I'll check");
    ok(r.say === P.checkFollowUp && d.st.attendance === null, 'G  "I\'ll check": NOT confirmed, asked when to call back', [r.say, d.st.attendance]);
    r = await d.hear('tomorrow evening');
    ok(r.done && d.outcome().outcome === 'No Response' && d.outcome().callbackWhen === 'tomorrow evening', 'G2 ... the time they gave is noted; the outcome is not "Confirmed"', d.outcome());
  } else ok(false, 'G  could not reach the interview question', d.st.step);

  // ---- I. clear opt-out ------------------------------------------------------------------------------------------------
  d = mk(); await to(d, 'intro', ['yes speaking', 'yes']);
  r = await d.hear("Don't call me again");
  ok(r.done && d.outcome().doNotCallRequested === true, 'I  "Don\'t call me again" ends at once and asks for no more calls', d.outcome());

  // ---- L. repeat ----------------------------------------------------------------------------------------------------------
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  r = await d.hear('Sorry, can you repeat that?');
  ok(d.st.step === 'interest' && r.say.startsWith(P.sureRepeat) && r.say.includes(P.interestQ), 'L  "repeat that?": the same question again, nothing recorded', r.say);

  // ---- can't hear the AI -----------------------------------------------------------------------------------------------
  r = await d.hear("I can't hear you");
  ok(d.st.step === 'audio_check' && r.say === P.canHear, 'Lb "I can\'t hear you": the assistant checks the line, does not go on with the job', r.say);
  r = await d.hear('yes now I can');
  ok(d.st.step === 'interest' && r.say.includes(P.interestQ), 'Lc ... "yes": the interrupted question again', r.say);

  // ---- M / R. several details in one answer, no repeated question -------------------------------------------------------
  d = mk(); await to(d, 'qExp', ['yes speaking', 'yes', 'yes', 'yes interested']);
  r = await d.hear('I have three years of experience, I am working in Hyderabad');
  ok(d.st.answers.experienceYears === 3 && d.st.step === 'qLoc', 'M  "three years" is kept; the next question is a NEW one (not experience again)', d.st.answers);

  // ---- S. wrong number ---------------------------------------------------------------------------------------------------
  d = mk(); d.start(); r = await d.hear('No, wrong number');
  ok(r.done && d.outcome().wrongPerson && !/Staff Nurse/.test(r.say), 'S  wrong person: ends, nothing about the job is said', r.say);

  // ---- T. callback time: a real time is kept, noise is not -------------------------------------------------------------
  d = mk(); await to(d, 'convenient', ['yes speaking']);
  await d.hear('I am busy');
  r = await d.hear('आपस्पटोल');
  ok(!r.done && r.say === S.phrases(d.language).laterWhenAgain && !d.st.callbackWhen, 'T  noise is never saved as the call-back time: asked once more', [r.say, d.st.callbackWhen]);
  r = await d.hear('tomorrow 5 pm');
  ok(r.done && d.outcome().callbackWhen === 'tomorrow 5 pm' && d.outcome().outcome === 'Call Back Later', 'T2 ... "tomorrow 5 pm" is noted', d.outcome());
  d = mk(); await to(d, 'convenient', ['yes speaking']); await d.hear('No');
  r = await d.hear('First November');
  ok(r.done && d.outcome().callbackWhen === 'First November', 'T3 a date by month ("First November", real call 2026-10-29) is noted, not asked again', d.outcome());

  // ---- unclear audio (the gateway marks it): never an answer, 3 tries --------------------------------------------------
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  r = await d.hear('yes', { heard: 'unclear' });
  ok(r.say.startsWith(P.notClear) && d.st.interest === null, 'U1 an unclear "yes" is NOT taken as yes: "I couldn\'t hear you clearly" + the question', r.say);
  r = await d.hear('', { heard: 'unclear' });
  ok(r.say.startsWith(P.breaking), 'U2 second time: "your voice is breaking up"', r.say);
  r = await d.hear('', { heard: 'unclear' });
  ok(r.done && d.outcome().outcome === 'Unclear' && d.st.interest === null && /not heard clearly/.test(d.outcome().summary), 'U3 third time: a polite end, outcome Unclear, nothing assumed', d.outcome());
  const turns = d.transcript().filter((x) => x.who === 'candidate');
  ok(turns.some((x) => x.heard === 'unclear' && x.understood === 'not_clear' && x.text === 'yes'), 'U4 the history keeps the exact words heard and marks them "not heard clearly"', turns);

  // ---- silence: never an answer, 2 check-ins, then the end ---------------------------------------------------------------
  d = mk(); await to(d, 'interest', ['yes speaking', 'yes', 'yes']);
  r = await d.hear('', { heard: 'none' });
  ok(r.say.startsWith(P.stillThere) && d.st.interest === null, 'V1 silence: "Hello, are you still there?" + the question (not a no / yes)', r.say);
  await d.hear('', { heard: 'none' }); r = await d.hear('', { heard: 'none' });
  ok(r.done && d.outcome().outcome === 'Unclear' && d.st.interest === null, 'V2 third silence: a polite end, outcome Unclear', d.outcome());

  // ---- language -----------------------------------------------------------------------------------------------------------
  d = mk(); await to(d, 'convenient', ['yes speaking']);
  r = await d.hear('Telugu lo cheppandi');
  ok(d.language === 'Telugu' && !r.say.includes(S.phrases('Telugu').langSwitched) && /[ఀ-౿]/.test(r.say), 'D  "Telugu lo cheppandi": switches to Telugu at once, without announcing it', [d.language, r.say]);
  r = await d.hear('can you explain in English?');
  ok(d.language === 'English', 'D2 "can you explain in English?": back to English', d.language);
  d = mk(); await to(d, 'convenient', ['yes speaking']);
  await d.hear('आपस्पटोल', { heard: 'unclear' });
  ok(d.language === 'English', 'D3 an unclear word in Hindi letters never switches the language', d.language);

  // ---- the yes / no reading on its own ----------------------------------------------------------------------------------
  const cases = [['Yes', 'yes'], ['Yeah', 'yes'], ['Yes, I do', 'yes'], ['Yes, I have', 'yes'], ['No', 'no'], ['Nope', 'no'], ["No, I don't", 'no'],
    ['Not interested', 'no'], ['I am interested', 'yes'], ['Maybe', 'maybe'], ["I don't know", 'maybe'], ['I will check', 'maybe'], ['Call me later', 'later'],
    ['I am busy', 'later'], ['Not now', 'later'], ['Tell me more', 'info_q'], ['అవును', 'yes'], ['లేదు', 'no'], ['हाँ', 'yes'], ['नहीं', 'no'],
    ["Yes, I can't", 'mixed'], ['Yes, I can', 'yes'], ['No problem', 'yes']];
  const wrong = cases.filter(([t, w]) => classify(t).intent !== w).map(([t, w]) => `${t}: ${classify(t).intent} (want ${w})`);
  ok(!wrong.length, `Y  ${cases.length} short answers read right (${cases.length - wrong.length}/${cases.length})`, wrong);

  // ---- the requirement as written in the ATS (2026-10-30): facts read from the description, nothing guessed ----------
  const descA = ['Requirements:', 'M.Tech CSE 4 members', 'PhD CSE 1 person', 'MCA 12 members', '13-08-2026', 'CSE - 40k', 'Physics - 20 -  25k',
    'Fresher & 1 to 2 Experience Candidates Only Eligible', '', 'Location: Located on the way LB NAGAR TO MEHADIPANAM ROAD. BUS ROUTE NO 300', '',
    'From the Edu - 2 requirement sheet (row 17).'].join('\n');
  const rd = S.buildData({ candidate: { name: 'Ravi Kumar' }, requirement: { title: 'Faculty requirement', description: descA }, app: {} });
  ok(rd.jobTitle === 'Faculty' && rd.location === 'LB Nagar to Mehadipanam Road' && rd.experience === '1 to 2 years', 'R1 title, place and experience are read from the description', rd);
  ok(rd.needs === 'M.Tech CSE, PhD CSE, MCA' && rd.salary === 'CSE 40 thousand, Physics 20 to 25 thousand', 'R2 the subjects and the pay lines are read word for word (dates, counts, sheet notes left out)', [rd.needs, rd.salary]);
  const rs = S.buildData({ candidate: { name: 'Ravi Kumar' }, requirement: { title: 'Nurse', location: 'Guntur', salary: '3 LPA', description: 'Location: Vizag\nPay 20k' }, app: {} });
  ok(rs.location === 'Guntur' && rs.salary === '3 LPA', 'R3 a filled field always wins over the description', rs);
  const rn = S.buildData({ candidate: { name: 'Ravi Kumar' }, requirement: { title: 'Staff Nurse' }, app: {} });
  ok(!rn.location && !rn.needs && !rn.salary && !rn.experience, 'R4 no description, no fields: nothing is made up', rn);
  const NS = require(path.join(B, 'src/calling/voice/speakScript'));
  const said = NS.native('జాబ్ LB Nagar to Mehadipanam Road లో. M.Tech CSE, PhD. AI & ML.', 'Telugu');
  ok(!/[A-Za-z]/.test(said) && /ఎల్ బీ/.test(said) && /ఎం టెక్/.test(said) && /సీ ఎస్ ఈ/.test(said) && /పీహెచ్‌డీ/.test(said), 'R5 Telugu voice gets letter names / degrees / places, not letter-by-letter guesses', said);
  const P0 = require(path.join(B, 'src/calling/voice/gateway')).polish;
  const tone = Buffer.alloc(16000); for (let i = 0; i < 8000; i += 1) tone.writeInt16LE(i < 1600 || i > 6400 ? 0 : Math.round(32767 * Math.sin(i / 3)), i * 2);
  const pol = P0(tone); let pk = 0; for (let i = 0; i < pol.length / 2; i += 1) pk = Math.max(pk, Math.abs(pol.readInt16LE(i * 2)));
  ok(pk <= 26000 && pol.length < tone.length * 0.75, 'R6 the voice is trimmed of its silent ends and never clips (peak <= 26000)', { pk, len: pol.length });

  // ---- the gateway's hearing rules -------------------------------------------------------------------------------------
  const G = require(path.join(B, 'src/calling/voice/gateway'));
  ok(G.clarityOf('Yes, I have', { logprob: -0.25, noSpeech: 0.05, ratio: 1.1 }) === 'clear', 'W1 a sure Whisper answer is clear');
  ok(G.clarityOf("Yes, I can't tell you so much about it.", { logprob: -1.3, noSpeech: 0.2, ratio: 1.2 }) === 'unclear', 'W2 a guess (logprob -1.3) is unclear');
  ok(G.clarityOf('Thank you.', { logprob: -0.8, noSpeech: 0.85, ratio: 1 }) === 'unclear', 'W3 words made up from noise (no-speech 0.85) are unclear');
  ok(G.clarityOf('', null) === 'unclear' && G.clarityOf('avunu', null) === 'clear', 'W4 no words for real speech = unclear; Telugu / Hindi (no sureness) = clear when there are words');
  ok(!G.nativeAnswer('ఫస్ట్ నవంబర్', 'Telugu') && !G.nativeAnswer('यस आई हैव', 'Hindi') && G.nativeAnswer('అవును', 'Telugu') && G.nativeAnswer('हाँ ठीक है', 'Hindi'), 'W6 English words written in Telugu / Hindi letters ("First November" -> ఫస్ట్ నవంబర్) never switch an English call; real Telugu / Hindi words do');
  ok(!G.believable('आपस्पटोल') && G.believable('అవును') && G.believable('मैं हैदराबाद में रहता हूँ'), 'W5 a language switch by sound needs words that make sense');

  // ---- a whole SILENT call through the gateway (copy of dev.db) ----------------------------------------------------------
  const COPY = path.join(B, 'prisma', 'zz-accuracy-test.db');
  const { PrismaClient } = require(path.join(B, 'node_modules/@prisma/client'));
  const src = new PrismaClient(); try { fs.unlinkSync(COPY); } catch { /* */ }
  await src.$executeRawUnsafe(`VACUUM INTO '${COPY.split(path.sep).join('/')}'`); await src.$disconnect();
  process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`; process.env.TEST_MODE = '1';
  try {
    const prisma = require(path.join(B, 'src/db'));
    const DB = require(path.join(B, 'src/calling/schema'));
    const A = require(path.join(B, 'src/calling/voice/audioSocket'));
    const E = require(path.join(B, 'src/calling/voice/engines'));
    const app = await prisma.application.findFirst({ where: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } }, orderBy: { createdAt: 'desc' } });
    const eng = E.scripted([]); eng.tts = async (text) => E.silence(Math.min(400, 5 * String(text).length));
    const server = await G.start({ port: 0, engines: eng });
    const id = `aic_${crypto.randomBytes(9).toString('hex')}`; const uuid = crypto.randomUUID(); const t = new Date().toISOString();
    await DB.run(`INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","dedupeKey","language","scriptJson","initiatedVia","callSid","attempts","maxAttempts","createdAt","updatedAt")
      VALUES (?,?,?,'calling',?,?,?,?,?,?,?,?,1,1,?,?)`, id, 'test', 'Screening', app.id, app.candidateId, app.requirementId, `sip:${id}`, 'English', JSON.stringify({ fields: {} }), 'sip', uuid, t, t);
    const t0 = Date.now();
    await new Promise((resolve) => {
      const s = net.connect(server.address().port, '127.0.0.1');
      const quiet = setInterval(() => { if (!s.destroyed) s.write(A.encode(A.KIND.AUDIO, E.silence(20))); }, 20); // a quiet line, nobody talks
      s.on('connect', () => s.write(A.encode(A.KIND.UUID, A.uuidBytes(uuid))));
      s.on('data', () => {});
      s.on('close', () => { clearInterval(quiet); resolve(); });
      setTimeout(() => { if (!s.destroyed) s.destroy(); }, 40000);
    });
    await sleep(800);
    const row = await DB.one('SELECT "status","outcome","transcript" FROM "AiCall" WHERE "id" = ?', id);
    const tr = JSON.parse(row.transcript || '[]');
    const said = tr.filter((x) => x.who === 'assistant').map((x) => x.text);
    ok(said.some((x) => x.startsWith(P.stillThere)) && said.some((x) => x.startsWith(P.stillThere2)) && said.some((x) => x === P.noAnswerClose), `X1 a silent person: two "are you still there?" check-ins, then a polite end (${Math.round((Date.now() - t0) / 1000)} s)`, said);
    ok(row.status === 'completed' && row.outcome === 'Unclear' && tr.filter((x) => x.who === 'candidate').every((x) => x.heard === 'none'), 'X2 the call is saved: outcome Unclear, the history marks "no reply" (nothing made up)', { status: row.status, outcome: row.outcome });
    server.close(); await prisma.$disconnect();
  } catch (e) { fail += 1; console.log('ERROR', e.stack); }
  try { fs.unlinkSync(COPY); } catch { /* */ }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed (text-level + the gateway timers; real phone audio is not part of this test)`);
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AI PHONE CALL, END TO END WITH REAL VOICES (2026-10-30: "mottham ai calling complete ayyi, proper ga work ayyeyelaga chudu")
//
//   cd backend && node scripts/ai-call-voice-e2e.js [scenario ...]
//
// Plays the part of Asterisk: connects to the AI voice gateway over AudioSocket exactly as a phone call does, and the
// "candidate" SPEAKS - each reply is made into 8 kHz phone audio with the real voices (Piper Telugu / English, Kokoro Hindi)
// and streamed at real-time pace. The gateway hears it with the real listeners (Whisper, IndicConformer), talks back with
// the real voices, and saves the call. Nobody is phoned; it runs on a COPY of dev.db (deleted at the end).
// Checks per scenario: the outcome, the language, the answers read, the questions answered from the ATS, and the time from
// the end of each reply to the assistant's first sound.
// ---------------------------------------------------------------------------
const path = require('path'); const fs = require('fs'); const net = require('net'); const crypto = require('crypto');

const B = path.resolve(__dirname, '..');
const COPY = path.join(B, 'prisma', 'zz-voice-e2e.db');
let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 600) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = {
  telugu: {
    start: 'English',
    replies: ['అవును, నేనే మాట్లాడుతున్నా', 'సరే చెప్పండి', 'చెప్పు', 'సాలరీ ఎంత ఉంటుంది?', 'అవును, ఇంట్రెస్ట్ ఉంది', 'మూడు ఏళ్ళు', 'వరంగల్', 'ముప్పై రోజులు', 'అవును'],
    voice: 'Telugu',
    expect: { outcome: 'Interested', language: 'Telugu', years: 3, salaryAnswered: true },
  },
  hindi: {
    start: 'English',
    replies: ['हाँ जी, मैं ही बोल रहा हूँ', 'हाँ बोलिए', 'बताइए', 'टाइमिंग क्या है?', 'हाँ, इंटरेस्ट है', 'दो साल', 'हैदराबाद', 'पंद्रह दिन', 'हाँ'],
    voice: 'Hindi',
    expect: { outcome: 'Interested', language: 'Hindi', years: 2, timingsAnswered: true },
  },
  english: {
    start: 'English',
    replies: ['Yes, speaking.', 'Yes, go ahead.', 'Tell me.', 'What is the salary?', 'Yes, I am interested.', 'Five years.', 'Bangalore.', 'Immediately.', 'Yes.'],
    voice: 'English',
    expect: { outcome: 'Interested', language: 'English', years: 5, salaryAnswered: true },
  },
  later: {
    start: 'Telugu',
    replies: ['అవును', 'ఇప్పుడు బిజీగా ఉన్నా, రేపు సాయంత్రం ఆరు గంటలకి కాల్ చేయండి'],
    voice: 'Telugu',
    expect: { outcome: 'Call Back Later', language: 'Telugu' },
  },
};

(async () => {
  const { PrismaClient } = require(path.join(B, 'node_modules/@prisma/client'));
  const src = new PrismaClient(); try { fs.unlinkSync(COPY); } catch { /* */ }
  await src.$executeRawUnsafe(`VACUUM INTO '${COPY.split(path.sep).join('/')}'`); await src.$disconnect();
  require(path.join(B, 'node_modules/dotenv')).config({ path: path.join(B, '.env'), override: false });
  process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`; process.env.TEST_MODE = '1';
  process.env.AI_CALL_BRAIN = 'off'; // the Claude account has no credits: the call runs on the script + ATS answers
  let server;
  try {
    const prisma = require(path.join(B, 'src/db'));
    const DB = require(path.join(B, 'src/calling/schema'));
    const E = require(path.join(B, 'src/calling/voice/engines'));
    const V = require(path.join(B, 'src/calling/voice/speakScript'));
    const G = require(path.join(B, 'src/calling/voice/gateway'));
    const A = require(path.join(B, 'src/calling/voice/audioSocket'));
    const engines = E.fromEnv();
    console.log('engines:', engines.name);
    const port = 19000 + Math.floor(Math.random() * 500);
    server = G.start({ port, engines });
    await sleep(500);

    // the job: a real requirement with a pay list in its description (Assistant Professor -> 1.2 lakh, timings 9 to 4)
    const requirement = await prisma.requirement.findFirst({ where: { title: { startsWith: 'Assistant Professor' }, description: { contains: 'Assistant professor -1.2L' } } })
      || await prisma.requirement.findFirst({ where: { status: 'OPEN' } });
    console.log('requirement:', requirement.title);
    const RUN = Date.now().toString(36);
    const wanted = process.argv.slice(2).filter((x) => SCENARIOS[x]);
    for (const name of (wanted.length ? wanted : Object.keys(SCENARIOS))) {
      const sc = SCENARIOS[name];
      console.log(`\n=== ${name} (${sc.voice} speaker, call starts in ${sc.start})`);
      const cand = await prisma.candidate.create({ data: { name: 'Keerthi Rao', email: `zz-e2e-${name}-${RUN}@example.test`, phone: '9100654424', consentStatus: 'GIVEN', consentPurposes: 'Recruitment' } });
      const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: requirement.id, stage: 'NEW' } });
      const uuid = crypto.randomUUID();
      const id = `aic_e2e_${name}_${RUN}`;
      const at = new Date().toISOString();
      await DB.run(`INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","dedupeKey","language","initiatedVia","callSid","attempts","maxAttempts","createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, 'test', 'Screening', 'calling', app.id, cand.id, requirement.id, `e2e-${id}`, sc.start, 'sip', uuid, 1, 1, at, at);

      // ---- the phone line ----
      const sock = net.connect(port, '127.0.0.1');
      const reader = new A.Reader();
      let lastAudio = 0; let firstAfter = null; let waitingSince = null; const delays = [];
      sock.on('data', (chunk) => {
        for (const m of reader.feed(chunk)) {
          if (m.kind === A.KIND.AUDIO) {
            const now = Date.now(); lastAudio = now;
            if (waitingSince && firstAfter == null) { firstAfter = now - waitingSince; delays.push(firstAfter); waitingSince = null; }
          }
        }
      });
      let closed = false; sock.on('close', () => { closed = true; });
      await new Promise((r) => sock.once('connect', r));
      sock.write(A.encode(A.KIND.UUID, A.uuidBytes(uuid)));
      // the line carries silence between turns (as a real line does: frames keep coming)
      const silence = Buffer.alloc(A.FRAME_BYTES);
      const pump = setInterval(() => { if (!closed && !sock.destroyed && !talking) sock.write(A.encode(A.KIND.AUDIO, silence)); }, A.FRAME_MS);
      let talking = false;
      let spokeAt = 0; // when the candidate last finished speaking
      const assistantDone = async () => { // wait for the assistant to START answering after our reply, then to go quiet for 900 ms
        const t0 = Date.now();
        while (!closed && lastAudio <= spokeAt && Date.now() - t0 < 30000) await sleep(50); // eslint-disable-line no-await-in-loop
        while (!closed && Date.now() - lastAudio < 900 && Date.now() - t0 < 60000) await sleep(100); // eslint-disable-line no-await-in-loop
      };
      const speak = async (text) => {
        const pcm = await engines.tts(V.native(text, sc.voice), sc.voice);
        talking = true;
        for (let i = 0; i + A.FRAME_BYTES <= pcm.length && !closed; i += A.FRAME_BYTES) { sock.write(A.encode(A.KIND.AUDIO, pcm.subarray(i, i + A.FRAME_BYTES))); await sleep(A.FRAME_MS); } // eslint-disable-line no-await-in-loop
        talking = false;
        spokeAt = Date.now();
        firstAfter = null; waitingSince = Date.now(); // from the end of the reply (includes the gateway's end-pause)
      };
      await assistantDone();
      for (const reply of sc.replies) {
        if (closed) break;
        await speak(reply); // eslint-disable-line no-await-in-loop
        await sleep(300); // eslint-disable-line no-await-in-loop
        await assistantDone(); // eslint-disable-line no-await-in-loop
      }
      await sleep(1500);
      clearInterval(pump);
      if (!closed) { sock.write(A.encode(A.KIND.HANGUP)); sock.end(); }
      await sleep(2500); // the gateway saves the result

      // ---- what happened ----
      const row = await DB.one('SELECT * FROM "AiCall" WHERE "id" = ?', id);
      let turns = []; try { turns = JSON.parse(row.transcript || '[]'); } catch { turns = []; }
      if (!turns.length) { try { turns = (JSON.parse(row.botStateJson || '{}').transcript) || []; } catch { /* */ } }
      turns.forEach((t) => console.log(`  ${t.who === 'assistant' ? 'AI ' : 'YOU'}: ${String(t.text || '').slice(0, 170)}${t.who !== 'assistant' ? `   [${[t.lang, t.heard, t.understood, t.answered].filter(Boolean).join(', ')}]` : ''}`));
      const answers = (() => { try { return JSON.parse(row.answersJson || '{}'); } catch { return {}; } })();
      const said = turns.filter((t) => t.who === 'assistant').map((t) => t.text).join(' ');
      const avg = delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null;
      console.log(`  outcome: ${row.outcome} | language: ${row.language} | answers: ${JSON.stringify(answers)} | reply delay avg ${avg} ms, max ${delays.length ? Math.max(...delays) : '-'} ms`);
      const x = sc.expect;
      ok(row.status === 'completed' && row.outcome === x.outcome, `${name}: outcome ${x.outcome}`, [row.status, row.outcome]);
      ok(row.language === x.language, `${name}: the call ends in ${x.language}`, row.language);
      if (x.years != null) ok(answers.experienceYears === x.years, `${name}: experience read as ${x.years}`, answers);
      if (x.salaryAnswered) ok(turns.some((t) => t.answered === 'from the ATS' || t.answered === 'recruiter answer'), `${name}: the salary question answered from the ATS`, turns.filter((t) => t.answered));
      if (x.timingsAnswered) ok(turns.some((t) => t.answered), `${name}: the timings question answered (from the ATS, or kept for the team)`, turns.filter((t) => t.answered));
      ok(avg != null && avg < 4500, `${name}: the assistant answers within 4.5 s on average after the person stops (${avg} ms)`, delays);
    }
  } catch (e) {
    fail += 1; console.log('FAIL crashed', e && e.stack);
  } finally {
    if (server && server.close) server.close();
    try { await require(path.join(B, 'src/db')).$disconnect(); } catch { /* */ }
    for (const f of [COPY, `${COPY}-journal`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

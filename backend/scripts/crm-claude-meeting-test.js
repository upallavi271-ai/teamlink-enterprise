#!/usr/bin/env node
/**
 * THE AI MEETING AND THE CRM WHATSAPP ASSISTANT ASK CLAUDE (founder 2026-11-17: "Yes, use Claude"), the rest of TeamLink stays local.
 * Stand-ins for both providers (utils/ai.js setTestProviders): which provider a call goes to, the model and effort sent, the refusal fallback,
 * a Claude error / refusal answered another way, the setting off -> local, which provider answered each turn (not shown to the lead).
 * SANDBOX ONLY: a COPY of the sandbox database, in this process; nothing reaches a model or a phone.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-claude-meeting-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = process.env.TEST_SOURCE_DB || path.resolve(__dirname, '..', 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-claude-${process.pid}.db`).split(path.sep).join('/');
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY}'`);
src.close();
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', TEST_MODE: '1', TEST_ALLOW_AI: '1', AI_PROVIDER: 'ollama', DATABASE_URL: `file:${COPY}` });
const prisma = require('../src/db');
const DB = require('../src/crm/schema');
const S = require('../src/crm/service');
const AI = require('../src/utils/ai');
const PS = require('../src/crm/productSales');
const SA = require('../src/crm/salesAgent');
const { resolveIdentity } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
let claudeCalls = []; let localCalls = [];
let claudeDoes = 'answer'; // answer | error | refusal | badfallback
const reply = (text) => JSON.stringify({ reply: text, unanswered: false, wantsHuman: false });
AI.setTestProviders({
  claude: async (body, opts) => {
    claudeCalls.push({ body, opts });
    if (claudeDoes === 'error') { const e = new Error('overloaded'); e.status = 529; throw e; }
    if (claudeDoes === 'badfallback' && body.fallbacks) { const e = new Error('fallbacks: this beta is not enabled for this account'); e.status = 400; throw e; }
    if (claudeDoes === 'refusal') return { model: body.model, stop_reason: 'refusal', content: [], usage: { input_tokens: 900, output_tokens: 5 } };
    const sys = String(body.system || '');
    const text = /Summarise this sales meeting/.test(sys) ? JSON.stringify({ summary: 'Asked how clients use the ATS.', interest: 'high', budget: 'unknown', authority: 'unknown', need: 'client portal', timeline: 'unknown', objections: [], nextStep: 'Send the proposal' })
      : /Telugu/.test(sys) ? reply('క్లయింట్ తన పోర్టల్‌లో అవసరాలు పెడుతుంది, మీరు పంపిన ప్రొఫైళ్లను చూసి షార్ట్‌లిస్ట్ చేస్తుంది.')
        : reply('TeamLink ATS gives each client its own portal to raise requirements and review profiles.');
    return { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2400, output_tokens: 80 } };
  },
  ollama: async ({ system }) => { localCalls.push(system.slice(0, 60)); return /Summarise/.test(system) ? JSON.stringify({ summary: 'local summary', interest: 'medium' }) : reply('The local model says the client uses its portal.'); },
});
const fresh = () => { claudeCalls = []; localCalls = []; };

(async () => {
  await DB.ensure();
  await PS.ensure();
  const row = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  const admin = await resolveIdentity(row.id);
  await SA.save(admin, { on: true, maxPerDay: 20 });
  check('1 the setting "Use Claude" is on by default', (await SA.load()).useClaude === true);
  const now = new Date().toISOString();
  const mkLead = async (company, products) => { const id = S.newId('lead'); await S.insert('CrmLead', { id, company, contactName: 'Pallavi', status: 'New', stage: 'New', source: 'Other', products, phone: `95${String(Date.now()).slice(-8)}`, createdAt: now, updatedAt: now }); return DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', id); };
  const L = await mkLead(`ZZTEST CLAUDE ${process.pid}`, 'ATS');
  const tok = PS.makeToken('meet', L.id, ['ATS'], 1);
  await PS.meetingFor(tok);
  const lastMeta = async () => { const [mt] = await prisma.$queryRawUnsafe('SELECT "transcript" FROM "CrmAiMeeting" WHERE "leadId" = ?', L.id); const t = JSON.parse(mt.transcript); return t[t.length - 1]; };

  // a written answer: no model at all
  fresh();
  const w = await PS.meetingSay(tok, 'how the clients will come into the ats', 'en-IN');
  check('2 a question with a written answer: answered at once, no model called, marked "written"', /BDE/.test(w.reply) && !claudeCalls.length && !localCalls.length && (await lastMeta()).meta.provider === 'written', { w, c: claudeCalls.length, l: localCalls.length });

  // Telugu: Claude, Opus 5.5, low effort, the refusal fallback, one try in 20 s
  fresh();
  const t1 = await PS.meetingSay(tok, 'clients ATS lo em chestharu?', 'te-IN');
  const c1 = claudeCalls[0] || {};
  check('3 a Telugu question goes to Claude: model claude-opus-5-5, output_config.effort low, server-side refusal fallback, 20 s and no retries', c1.body && c1.body.model === 'claude-opus-5-5' && c1.body.output_config && c1.body.output_config.effort === 'low' && c1.body.fallbacks === 'default' && c1.opts.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && c1.opts.timeout === 20000 && c1.opts.maxRetries === 0 && !localCalls.length, c1);
  check('4 no thinking switch and no temperature are sent (Claude Opus 5.5 refuses both)', c1.body && !('thinking' in c1.body) && !('temperature' in c1.body));
  const m1 = await lastMeta();
  check('5 the Telugu answer is from Claude, and the turn records provider, model, effort and tokens for the team', /[ఀ-౿]/.test(t1.reply) && m1.meta.provider === 'claude' && m1.meta.model === 'claude-opus-5-5' && m1.meta.effort === 'low' && m1.meta.inputTokens === 2400 && m1.meta.outputTokens === 80, m1);
  const page = await PS.meetingFor(tok);
  check('6 the lead never sees which provider answered (the meeting page reads only who and text)', page && page.meeting.transcript.some((x) => x.meta));

  // Claude fails: an error, then a refusal
  fresh(); claudeDoes = 'error';
  const e1 = await PS.meetingSay(tok, 'క్లయింట్ ఫీడ్‌బ్యాక్ ఎలా ఇస్తారు?', 'te-IN');
  const me1 = await lastMeta();
  check('7 Claude errors: the turn is answered by the local model, and the error is recorded', claudeCalls.length >= 1 && localCalls.length >= 1 && /local model/.test(e1.reply) && me1.meta.provider === 'local' && /overloaded|provider/i.test(me1.meta.claudeError || ''), { e1, meta: me1.meta });
  fresh(); claudeDoes = 'refusal';
  const r1 = await PS.meetingSay(tok, 'Does the client get a login to see candidates and give interview feedback?', 'en-IN');
  const mr1 = await lastMeta();
  check('8 a refusal: answered from the written answers (before the slow local model)', !localCalls.length && /portal/i.test(r1.reply) && /refusal|declined/i.test(mr1.meta.claudeError || ''), { r1, meta: mr1.meta, local: localCalls.length });
  fresh(); claudeDoes = 'badfallback';
  await PS.meetingSay(tok, 'ATS lo reports emi untayi?', 'te-IN');
  check('9 an account without the refusal-fallback beta: the call is sent again without it (and it is not asked for again)', claudeCalls.length === 2 && claudeCalls[0].body.fallbacks === 'default' && !claudeCalls[1].body.fallbacks, claudeCalls.map((c) => !!c.body.fallbacks));
  fresh();
  await PS.meetingSay(tok, 'interview calendar untunda?', 'te-IN');
  check('10 ...and the next calls go without it at once (a retry for a repeated answer included)', claudeCalls.length >= 1 && claudeCalls.every((c) => !c.body.fallbacks), claudeCalls.map((c) => !!c.body.fallbacks));
  claudeDoes = 'answer';

  // the summary at medium effort
  fresh();
  await PS.meetingEnd(tok, 'yes');
  const sumCall = claudeCalls.find((c) => /Summarise this sales meeting/.test(c.body.system));
  const [mt] = await prisma.$queryRawUnsafe('SELECT "summary" FROM "CrmAiMeeting" WHERE "leadId" = ?', L.id);
  const summ = JSON.parse(mt.summary);
  check('11 the end-of-meeting summary goes to Claude at medium effort, and records which provider wrote it', sumCall && sumCall.body.output_config.effort === 'medium' && summ.ai && summ.ai.provider === 'claude' && /ATS/.test(summ.text), { e: sumCall && sumCall.body.output_config, ai: summ.ai });

  // the setting off: the local model
  await SA.save(admin, { useClaude: false });
  const L2 = await mkLead(`ZZTEST CLAUDE OFF ${process.pid}`, 'ATS');
  const tok2 = PS.makeToken('meet', L2.id, ['ATS'], 1);
  await PS.meetingFor(tok2);
  fresh();
  await PS.meetingSay(tok2, 'clients ATS lo em chestharu?', 'te-IN');
  check('12 "Use Claude" off: Claude is not called, the local model answers', !claudeCalls.length && localCalls.length >= 1);
  await SA.save(admin, { useClaude: true });

  // the WhatsApp assistant
  fresh();
  const sent = [];
  const out = await SA.respond({ channel: 'WhatsApp', lead: L2, message: 'Does the client get its own login?' }, { deps: { sendWa: async (to, text) => { sent.push(text); return { ok: true, providerRef: 'wamid.T1' }; } } });
  const wc = claudeCalls[0] || {};
  check('13 the WhatsApp assistant asks Claude at low effort for a product lead, and the reply is sent', wc.body && wc.body.model === 'claude-opus-5-5' && wc.body.output_config.effort === 'low' && /interested in TeamLink ATS/.test(wc.body.system) && out.answered && sent.length === 1, { out, e: wc.body && wc.body.output_config });
  fresh(); claudeDoes = 'error';
  const out2 = await SA.respond({ channel: 'WhatsApp', lead: L2, message: 'And can they give interview feedback there?' }, { deps: { sendWa: async (to, text) => { sent.push(text); return { ok: true, providerRef: 'wamid.T2' }; } } });
  check('14 Claude down: the WhatsApp reply comes from the local model, it still goes out', localCalls.length >= 1 && out2.answered, { out2, local: localCalls.length });
  claudeDoes = 'answer';
  fresh();
  const ack = await SA.respond({ channel: 'WhatsApp', lead: L2, message: 'ok' }, { deps: { sendWa: async () => ({ ok: true }) } });
  check('15 "ok" still never reaches a model (and books nothing)', !claudeCalls.length && !localCalls.length && !!ack.skipped, ack);

  // the rest of TeamLink stays local
  fresh();
  await AI.chatJson('Classify this resume.', [{ role: 'user', content: 'Java developer' }]);
  check('16 any other AI call (AI_PROVIDER=ollama) stays on the local model', !claudeCalls.length && localCalls.length === 1);

  await prisma.$disconnect();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });

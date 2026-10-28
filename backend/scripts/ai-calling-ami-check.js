#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SELF-HOSTED (SYNWAY) CALLING - CHECK THE REAL ASTERISK. READ ONLY: it places NO call (no Originate is ever sent).
//   cd backend && node scripts/ai-calling-ami-check.js
// Uses the settings saved in Admin > Integrations > AI Calling (provider Self-hosted (Synway)) and the database in backend/.env:
// reaches AMI, logs in, Ping, Asterisk version, the AudioSocket modules, the Synway trunk (and that it points at the gateway IP),
// the [teamlink-ai] dialplan; then the AI side from .env (scripts/ai-calling-local-check.js checks Ollama / Vexyl STT / TTS).
// The AMI secret is never printed. Exit code 1 when a check fails.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const settingsStore = require(path.join(BACK, 'src/calling/settings'));
const AMI = require(path.join(BACK, 'src/calling/local/ami'));
const LOCAL = require(path.join(BACK, 'src/calling/local/config'));

(async () => {
  const s = await settingsStore.load({ fresh: true });
  console.log(`AI Calling provider: ${s.provider === 'synway' ? 'Self-hosted (Synway)' : 'Exotel'} · switch ${s.mode}`);
  if (s.provider !== 'synway') { console.log('The provider is not Self-hosted (Synway): choose it in Admin > Integrations > AI Calling and save first.'); process.exit(1); }
  console.log(`Asterisk ${s.amiHost || '(not set)'}:${s.amiPort} · AMI user ${s.amiUser || '(not set)'} · secret ${s.amiSecret ? 'set' : 'NOT set'} · trunk ${s.trunk} -> gateway ${s.gatewayIp || '(not set)'} · context ${s.dialContext} · dials ${s.dialFormat}`);
  const r = await AMI.testConnection(s);
  r.checks.forEach((c) => console.log(`  ${c.ok ? (c.warn ? 'note' : 'ok  ') : 'FAIL'}  ${c.name}: ${c.note}`));
  const L = LOCAL.cfg();
  console.log(`AI bridge (AudioSocket): ${L.audioSocket.port ? `${L.audioSocket.host}:${L.audioSocket.port}` : 'OFF - set AI_CALL_AUDIOSOCKET_PORT'}`);
  (s.problems || []).forEach((p) => console.log(`  still missing: ${p}`));
  console.log(r.ok && s.configured ? '\nReady: Asterisk and the Synway trunk are set up. No call was placed.' : `\nNot ready: ${r.ok ? s.problems[0] : r.message}`);
  process.exit(r.ok && s.configured ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });

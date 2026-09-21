/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// The AI agent harness.
//
// WHAT THIS PROVES, WITHOUT AN API KEY
// The Anthropic client is replaced by a scripted stub, so every branch of the
// loop can be exercised deterministically against the REAL database, the REAL
// permission engine and the REAL tools:
//
//   1. unconfigured        no key -> configured:false with a reason, no crash
//   2. single tool call    the tool runs, the answer comes back
//   3. multi-step          search -> read the id it returned -> answer, in
//                          three model turns, with the tool results the model
//                          actually saw
//   4. permission refusal  a low-privilege login gets `denied` from the tool,
//                          and the whole conversation still completes
//   5. scope refusal       a record outside a user's scope is refused even
//                          when the tool itself is permitted
//   6. malformed output    unknown tool, junk input, a content block this
//                          server does not understand, an unserialisable
//                          result, an SDK error -> a message, never a throw
//   7. iteration cap       a model that only ever calls tools is stopped
//   8. actions off         a write tool is not offered and is refused
//   9. actions on          propose -> confirm token -> execute -> audit row,
//                          and a second redemption of the same token fails
//  10. action re-check     a token proposed by one user cannot be redeemed by
//                          another
//
// WHAT IT CANNOT PROVE
// That a real Claude model chooses the right tools and writes a good answer.
// That needs a real key. Everything up to and including "the model asked for
// tool X with input Y" is covered here; the quality of X and Y is not.
//
// Run:  node backend/test/aiAgent.harness.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const Module = require('module');

// --- The stub -------------------------------------------------------------
// Installed BEFORE utils/aiAgent.js is required, so the module-level
// `require('@anthropic-ai/sdk')` picks it up. The stub reproduces the shapes
// the loop reads: content blocks, stop_reason, usage, and the typed errors.
class StubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class AuthenticationError extends StubError {}
class RateLimitError extends StubError {}
class NotFoundError extends StubError {}
class PermissionDeniedError extends StubError {}
class APIConnectionError extends StubError {}
class APIConnectionTimeoutError extends APIConnectionError {}

// The script the stub plays back, set per scenario.
let script = [];
let seen = [];

class StubAnthropic {
  constructor(opts) { this.opts = opts; }

  get messages() {
    return {
      create: async (req) => {
        // Deep copy: the loop pushes onto the same messages array each turn,
        // so keeping the reference would make every request look identical.
        seen.push(JSON.parse(JSON.stringify(req)));
        const step = script.shift();
        if (!step) throw new Error('harness: the stub ran out of scripted turns');
        if (typeof step === 'function') return step(req, seen.length - 1);
        if (step instanceof Error) throw step;
        return step;
      },
    };
  }
}
StubAnthropic.AuthenticationError = AuthenticationError;
StubAnthropic.RateLimitError = RateLimitError;
StubAnthropic.NotFoundError = NotFoundError;
StubAnthropic.PermissionDeniedError = PermissionDeniedError;
StubAnthropic.APIConnectionError = APIConnectionError;
StubAnthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;

const realResolve = Module._resolveFilename;
const STUB_ID = path.join(__dirname, '__stub_anthropic__');
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: StubAnthropic };
Module._resolveFilename = function patched(request, ...rest) {
  if (request === '@anthropic-ai/sdk') return STUB_ID;
  return realResolve.call(this, request, ...rest);
};

// --- Now load the app -----------------------------------------------------
const prisma = require('../src/db');
const aiAgent = require('../src/utils/aiAgent');
const actions = require('../src/utils/aiAgentActions');
const { resolveIdentity } = require('../src/utils/identity');
const { can } = require('../src/utils/permissions');
const { writeValues } = require('../src/utils/integrationStore');

// Helpers to build a model turn.
const text = (s) => ({ content: [{ type: 'text', text: s }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({
  content: [{ type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5 },
});

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`);
  }
}
function section(name) { console.log(`\n${name}`); }

// The tool results the model was handed, pulled back out of what the stub saw.
// Each request carries the whole transcript so far, so only the LAST one is
// read — otherwise every earlier turn's results would be counted again.
function toolResultsFrom(requests) {
  const out = [];
  const last = requests.length ? [requests[requests.length - 1]] : [];
  last.forEach((r) => (r.messages || []).forEach((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      m.content.forEach((b) => {
        if (b.type === 'tool_result') {
          try { out.push(JSON.parse(b.content)); } catch { out.push({ unparsable: b.content }); }
        }
      });
    }
  }));
  return out;
}

async function run(user, question, turns) {
  // The per-minute cap is a guard against a person, not against a harness.
  aiAgent.resetRateLimits();
  script = turns.slice();
  seen = [];
  const result = await aiAgent.ask({ user, question });
  return { result, requests: seen, results: toolResultsFrom(seen) };
}

async function main() {
  console.log('AI agent harness — stubbed model, real database, real permissions\n');

  // Who we test as.
  const logins = {};
  for (const email of ['admin@teamlink.test', 'client@teamlink.test', 'candidate@teamlink.test']) {
    // eslint-disable-next-line no-await-in-loop
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) { console.log(`  SKIP  no ${email} in this database`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const identity = await resolveIdentity(u.id);
    // eslint-disable-next-line no-await-in-loop
    identity.caps = {
      hrmsManage: await can(identity, 'hrms', 'hrms', 'Employee Management', 'view'),
      payrollManage: await can(identity, 'hrms', 'hrms', 'Payroll & Compensation', 'view'),
      atsAct: await can(identity, 'ats', 'candidates', 'Pipeline Stages', 'edit'),
      atsOversight: await can(identity, 'ats', 'recruiterbde', 'Team View', 'view'),
      accountsManage: await can(identity, 'accounts', 'accounts', 'Invoices', 'edit'),
    };
    identity.caps.hrmsSelfOnly = !identity.caps.hrmsManage;
    logins[email.split('@')[0]] = identity;
  }
  const admin = logins.admin;
  const client = logins.client;
  const candidate = logins.candidate;
  if (!admin) { console.log('No admin login — seed the database first.'); process.exit(1); }

  // ---------------------------------------------------------------------
  section('1. Unconfigured — the honest path');
  const cfg = await aiAgent.agentConfig();
  const liveKey = cfg.configured;
  if (liveKey) {
    console.log('  NOTE  a real key IS configured in this database; the unconfigured branch is simulated below only.');
  } else {
    const st = await aiAgent.status(admin);
    check('status() says not configured', st.configured === false);
    check('status() gives a reason', typeof st.reason === 'string' && st.reason.length > 0, st.reason);
    check('status() still lists the tool surface', Array.isArray(st.tools) && st.tools.length >= 18, st.tools && st.tools.length);
    const out = await aiAgent.ask({ user: admin, question: 'anything' });
    check('ask() returns notConfigured, not an error', out.notConfigured === true && out.ok === false);
    check('ask() never returns a key', !JSON.stringify(out).includes('sk-ant'));
  }

  // Everything below needs a configured channel. Rather than stubbing the
  // config, the harness CONFIGURES IT FOR REAL — same Integrations write path,
  // same encrypted credential store, same readConfig() — with a key that is
  // never sent anywhere because the SDK itself is the stub. This is what
  // proves the unconfigured/configured switch works, not just the loop.
  async function configureChannel({ act }) {
    const { values } = await writeValues(aiAgent.CHANNEL, {
      'Anthropic API key': 'sk-ant-harness-not-a-real-key',
      Model: 'claude-opus-5',
      'Max answer tokens': '1500',
      'Questions per user per hour': '500',
      'Allow the assistant to act (with confirmation)': act ? 'Yes' : 'No',
    });
    await prisma.integration.upsert({
      where: { id: aiAgent.CHANNEL },
      update: {
        values: JSON.stringify(values), enabled: true, connected: true, state: 'Connected',
      },
      create: {
        id: aiAgent.CHANNEL,
        values: JSON.stringify(values),
        enabled: true,
        connected: true,
        state: 'Connected',
      },
    });
    aiAgent.resetClient();
    const c = await aiAgent.agentConfig();
    if (!c.configured) throw new Error(`harness: channel did not configure — ${c.reason}`);
    if (!!c.actionsEnabled !== !!act) throw new Error('harness: the actions toggle did not take');
  }
  await configureChannel({ act: false });
  check('the encrypted store round-trips the key', (await aiAgent.agentConfig()).apiKey === 'sk-ant-harness-not-a-real-key');
  check('actions default to OFF', (await aiAgent.agentConfig()).actionsEnabled === false);

  // ---------------------------------------------------------------------
  section('2. One tool call, one answer');
  {
    const { result, requests, results } = await run(admin, 'What is waiting on me?', [
      call('my_pending_actions', {}),
      text('You have items waiting.'),
    ]);
    check('answered', result.ok === true && result.answer === 'You have items waiting.', result);
    check('the tool actually ran', results.length === 1 && typeof results[0].totalOpen === 'number', results[0]);
    check('toolsUsed reported', result.toolsUsed.length === 1 && result.toolsUsed[0].name === 'my_pending_actions');
    check('tools were offered to the model', Array.isArray(requests[0].tools) && requests[0].tools.length >= 18, requests[0].tools && requests[0].tools.length);
    check('the system prompt carries no data', !/Software Engineer|@teamlink\.test/i.test(requests[0].system || ''));
  }

  // ---------------------------------------------------------------------
  section('3. Multi-step: search, then read what the search returned');
  {
    let capturedId = null;
    const { result, results } = await run(admin, 'Tell me about my newest open role', [
      call('search_requirements', { openOnly: true }),
      (req) => {
        // Reads the previous tool result exactly as a model would.
        const last = req.messages[req.messages.length - 1];
        const payload = JSON.parse(last.content[0].content);
        capturedId = payload.requirements && payload.requirements[0] && payload.requirements[0].id;
        return call('get_requirement', { requirementId: capturedId });
      },
      text('Here is that requirement.'),
    ]);
    check('three model turns, two tool calls', result.toolsUsed.length === 2, result.toolsUsed);
    check('step 2 used the id step 1 returned', !!capturedId, capturedId);
    check('the second tool returned the requirement', !!(results[1] && results[1].requirement), results[1]);
    check('answered after both steps', result.ok === true);
  }

  // ---------------------------------------------------------------------
  section('4. Permission refusal — a candidate asking about requirements');
  if (candidate) {
    const { result, results } = await run(candidate, 'Show me all the open requirements', [
      call('search_requirements', {}),
      text('I cannot see requirements for your login.'),
    ]);
    const r = results[0] || {};
    const refusedOrEmpty = r.denied === true || (r.count === 0);
    check('the tool refused or returned nothing', refusedOrEmpty, r);
    check('no requirement leaked', !(r.requirements && r.requirements.length), r.count);
    check('the conversation still completed', result.ok === true);

    const acc = await run(candidate, 'What is outstanding?', [
      call('accounts_summary', {}),
      text('You cannot see invoices.'),
    ]);
    check('accounts_summary refused for a candidate', acc.results[0] && acc.results[0].denied === true, acc.results[0]);

    const dir = await run(candidate, 'Who is in my team?', [
      call('my_team_directory', {}),
      text('No directory for you.'),
    ]);
    check('my_team_directory refused for a candidate', dir.results[0] && dir.results[0].denied === true, dir.results[0]);
  } else { console.log('  SKIP  no candidate login'); }

  // ---------------------------------------------------------------------
  section('5. Scope refusal — a client reaching past their own company');
  if (client) {
    // A requirement that is NOT this client's: taken from the admin's view.
    const foreign = await prisma.requirement.findFirst({
      where: { OR: [{ internal: true }, { clientId: { not: client.clientId } }] },
      select: { id: true, title: true },
    });
    if (foreign) {
      const { results } = await run(client, `Tell me about requirement ${foreign.id}`, [
        call('get_requirement', { requirementId: foreign.id }),
        text('That is not visible to you.'),
      ]);
      const r = results[0] || {};
      check('out-of-scope requirement refused', r.denied === true, r);
      check('no title leaked in the refusal', !JSON.stringify(r).includes(foreign.title), r);
    } else { console.log('  SKIP  no requirement outside this client'); }

    const inv = await run(client, 'What do I owe?', [
      call('accounts_summary', {}),
      text('Here are your figures.'),
    ]);
    const rows = await prisma.invoice.findMany({ where: { clientId: { not: client.clientId } }, select: { id: true } });
    const all = await prisma.invoice.count();
    check('a client sees only their own invoices', inv.results[0] && (inv.results[0].denied === true
      || inv.results[0].invoiceCount === all - rows.length), { got: inv.results[0] && inv.results[0].invoiceCount, all, others: rows.length });
  } else { console.log('  SKIP  no client login'); }

  // ---------------------------------------------------------------------
  section('6. Malformed and hostile model output');
  {
    const unknown = await run(admin, 'x', [call('no_such_tool', {}), text('ok')]);
    check('unknown tool -> a message, not a throw', unknown.result.ok === true && /Unknown tool/.test(JSON.stringify(unknown.results[0])), unknown.results[0]);

    const junk = await run(admin, 'x', [call('get_requirement', 'not-an-object'), text('ok')]);
    check('non-object tool input survives', junk.result.ok === true, junk.result);

    const nullInput = await run(admin, 'x', [call('search_candidates', null), text('ok')]);
    check('null tool input survives', nullInput.result.ok === true, nullInput.result);

    const weird = await run(admin, 'x', [
      { content: [{ type: 'server_tool_use', id: 'z', name: 'whatever', input: {} }], stop_reason: 'end_turn', usage: {} },
    ]);
    check('a content block this server does not know -> empty answer, no throw', weird.result.ok === true, weird.result);

    const noContent = await run(admin, 'x', [{ stop_reason: 'end_turn', usage: {} }]);
    check('a response with no content array -> a message, not a throw', noContent.result.ok === false && /could not read/.test(noContent.result.error), noContent.result);

    const refused = await run(admin, 'x', [{ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage: {} }]);
    check('a model refusal is reported as itself', refused.result.ok === false && /declined/.test(refused.result.error), refused.result);

    for (const [Klass, expect] of [[AuthenticationError, /401/], [RateLimitError, /429/], [NotFoundError, /404/], [APIConnectionError, /Could not reach/]]) {
      // eslint-disable-next-line no-await-in-loop
      const e = await run(admin, 'x', [new Klass(0, 'boom')]);
      check(`${Klass.name} -> a readable message`, e.result.ok === false && expect.test(e.result.error), e.result.error);
      check(`${Klass.name} never echoes the key`, !JSON.stringify(e.result).includes('sk-ant'));
    }

    const plainThrow = await run(admin, 'x', [new Error('socket hang up')]);
    check('an untyped SDK error is still caught', plainThrow.result.ok === false && typeof plainThrow.result.error === 'string');
  }

  // ---------------------------------------------------------------------
  section('7. Iteration cap');
  {
    const forever = [];
    for (let i = 0; i < aiAgent.MAX_TOOL_ITERATIONS + 3; i += 1) forever.push(call('list_clients', {}));
    const { result, requests } = await run(admin, 'loop', forever);
    check('stopped at the cap', result.ok === false && /more lookups/.test(result.error), result.error);
    check(`exactly ${aiAgent.MAX_TOOL_ITERATIONS} model calls`, requests.length === aiAgent.MAX_TOOL_ITERATIONS, requests.length);
  }

  // ---------------------------------------------------------------------
  section('8. Actions OFF (the default)');
  {
    const { result, requests, results } = await run(admin, 'move someone on', [
      call('move_candidate_stage', { applicationId: 'x', stage: 'HOLD' }),
      text('I cannot do that.'),
    ]);
    const offered = (requests[0].tools || []).map((t) => t.name);
    check('no write tool is offered to the model', !offered.includes('move_candidate_stage'), offered.filter((n) => /move_|schedule_|create_task/.test(n)));
    check('the system prompt says read-only', /You are read-only/.test(requests[0].system));
    check('calling one anyway is refused', results[0] && results[0].denied === true, results[0]);
    check('the conversation still completed', result.ok === true);

    const act = await aiAgent.act({ user: admin, token: 'anything' });
    check('/ai/act refuses while actions are off', act.ok === false && act.status === 403, act);
  }

  // ---------------------------------------------------------------------
  section('9. Actions ON — propose, confirm, execute, audit');
  await configureChannel({ act: true });
  actions.clearPending();
  {
    const st = await aiAgent.status(admin);
    check('status() reports the armed actions', st.actionsEnabled === true && st.actions.length === 3, st.actions);

    // A real application the admin can move.
    const app = await prisma.application.findFirst({
      where: { stage: { notIn: ['JOINED', 'HIRED', 'REJECTED'] } },
      include: { candidate: true, requirement: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!app) { console.log('  SKIP  no movable application in this database'); } else {
      const target = app.stage === 'HOLD' ? 'RECRUITER_REVIEW' : 'HOLD';
      const { result, requests, results } = await run(admin, `Put ${app.candidate.name} on hold`, [
        call('move_candidate_stage', { applicationId: app.id, stage: target, comment: 'harness' }),
        text('Queued for your confirmation.'),
      ]);
      const offered = (requests[0].tools || []).map((t) => t.name);
      check('write tools are offered now', offered.includes('move_candidate_stage'), offered.length);
      check('the system prompt describes the confirm flow', /press Confirm/i.test(requests[0].system));
      check('the tool result is a PROPOSAL', results[0] && results[0].proposed === true, results[0]);
      check('the model is NOT given the token', results[0] && results[0].confirmToken === undefined, Object.keys(results[0] || {}));
      check('the panel IS given the token', result.pendingActions.length === 1 && !!result.pendingActions[0].token);
      check('the proposal has a human summary', /→|from|to/i.test(result.pendingActions[0].summary) || result.pendingActions[0].summary.length > 10, result.pendingActions[0].summary);

      const before = await prisma.application.findUnique({ where: { id: app.id }, select: { stage: true } });
      check('NOTHING was written by the proposal', before.stage === app.stage, before.stage);

      const token = result.pendingActions[0].token;

      // Another login must not be able to redeem it.
      if (client) {
        const stolen = await aiAgent.act({ user: client, token });
        check('a token cannot be redeemed by another user', stolen.ok === false, stolen);
      }

      const done = await aiAgent.act({ user: admin, token });
      check('confirming executes it', done.ok === true, done.error);
      const after = await prisma.application.findUnique({ where: { id: app.id }, select: { stage: true } });
      check('the stage really moved', after.stage === target, after.stage);

      const audit = await prisma.auditLog.findFirst({
        where: { entity: 'AiAssistantAction' }, orderBy: { createdAt: 'desc' },
      });
      check('an audit row records the confirmation', !!audit && /move_candidate_stage/.test(audit.action), audit && audit.action);
      const bizAudit = await prisma.auditLog.findFirst({
        where: { entity: 'Application', entityId: app.id, action: 'Application stage changed' },
        orderBy: { createdAt: 'desc' },
      });
      check('the route\'s own audit row was written too', !!bizAudit && bizAudit.toValue === target, bizAudit && bizAudit.toValue);
      const stageEvent = await prisma.applicationStageEvent.findFirst({
        where: { applicationId: app.id, toStage: target }, orderBy: { createdAt: 'desc' },
      });
      check('the pipeline-history row was written (same code path as the route)', !!stageEvent);

      const again = await aiAgent.act({ user: admin, token });
      check('the token is single-use', again.ok === false && /expired or was already used/.test(again.error), again.error);

      // Put it back.
      await prisma.application.update({ where: { id: app.id }, data: { stage: app.stage } });
    }

    // A login that cannot act is not offered the tools even with actions armed.
    if (candidate) {
      const { requests, results } = await run(candidate, 'move someone', [
        call('move_candidate_stage', { applicationId: 'x', stage: 'HOLD' }),
        text('no'),
      ]);
      const offered = (requests[0].tools || []).map((t) => t.name);
      check('a candidate is offered no write tool even when armed', !offered.includes('move_candidate_stage'), offered.filter((n) => /move_|schedule_|create_task/.test(n)));
      check('and a direct call is refused', results[0] && results[0].denied === true, results[0]);
    }

    // Scope: an application outside the user's reach cannot even be proposed.
    if (client) {
      const foreignApp = await prisma.application.findFirst({
        where: { requirement: { OR: [{ internal: true }, { clientId: { not: client.clientId } }] } },
        select: { id: true },
      });
      if (foreignApp) {
        const p = await actions.proposeAction(client, 'move_candidate_stage', { applicationId: foreignApp.id, stage: 'HOLD' });
        check('proposing on an out-of-scope application is refused', p.denied === true, p);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nHARNESS CRASHED:', err);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(2);
});

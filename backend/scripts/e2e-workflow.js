// ---------------------------------------------------------------------------
// END-TO-END WORKFLOW TEST — the whole spine, through the real API.
//
//   CLIENT -> AGREEMENT -> ACTIVE -> REQUIREMENT -> CANDIDATE -> APPLICATION
//   -> the pipeline, stage by stage -> SELECTED -> JOINED -> INVOICE
//
// EVERYTHING GOES THROUGH HTTP, never straight to the database. A test that
// writes rows itself proves the database accepts rows; it proves nothing about
// permissions, validation, stage ownership, the agreement gate, the hiring-type
// branch or the invoice trigger — which is the entire question being asked.
//
// Every object it makes is prefixed ZZE2E and deleted at the end, in reverse
// dependency order. Run it with --keep to leave them for inspection.
//
//   node scripts/e2e-workflow.js
//   node scripts/e2e-workflow.js --keep
// ---------------------------------------------------------------------------

const BASE = process.env.TL_API || 'http://127.0.0.1:4010/api';
const EMAIL = process.env.TL_EMAIL || 'admin@teamlink.com';
const PW = process.env.TL_PASSWORD || 'password123';
const KEEP = process.argv.includes('--keep');
const TAG = 'ZZE2E';

let token = null;
const results = [];
const made = { client: null, gateRequirement: null, requirement: null, candidate: null, application: null, invoice: null };

const c = { pass: '✓', fail: '✗', skip: '-' };

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  const text = await res.text();
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, body: payload };
}

// A step records what happened rather than throwing: one broken stage should
// not hide the six after it, which is the whole point of running this.
async function step(name, fn, { expect = 'ok' } = {}) {
  try {
    const out = await fn();
    const ok = expect === 'ok' ? out.ok : (out.status === expect);
    results.push({ name, ok, detail: ok ? (out.note || '') : `HTTP ${out.status} ${JSON.stringify(out.body).slice(0, 180)}` });
    console.log(`  ${ok ? c.pass : c.fail} ${name}${ok && out.note ? '  — ' + out.note : ''}`);
    if (!ok) console.log(`      HTTP ${out.status}  ${JSON.stringify(out.body).slice(0, 220)}`);
    return out;
  } catch (err) {
    results.push({ name, ok: false, detail: String(err.message || err).slice(0, 200) });
    console.log(`  ${c.fail} ${name}\n      ${String(err.message || err).slice(0, 200)}`);
    return { ok: false, body: null };
  }
}

(async () => {
  console.log('END-TO-END WORKFLOW TEST\n' + '='.repeat(64));

  // --- 0. sign in ----------------------------------------------------------
  console.log('\n0. AUTHENTICATION');
  const login = await step('sign in as ' + EMAIL, async () => {
    const r = await api('POST', '/auth/login', { email: EMAIL, password: PW });
    if (r.ok) token = r.body.token;
    return { ...r, note: r.ok ? `role ${r.body.user?.role}` : '' };
  });
  if (!login.ok) { console.log('\nCannot continue without a session.'); process.exit(1); }

  // --- 1. client -----------------------------------------------------------
  console.log('\n1. CLIENT');
  const client = await step('create client', async () => {
    const r = await api('POST', '/clients', {
      name: `${TAG} Orbit Software`,
      contactName: 'Test Contact',
      contactEmail: 'zze2e.client@example.invalid',
      contactPhone: '9876500001',
      // The full save requires a location; only a draft may skip it.
      state: 'Telangana',
      district: 'Hyderabad',
      city: 'Hyderabad',
      industry: 'IT',
    });
    if (r.ok) made.client = r.body.id;
    return { ...r, note: r.ok ? r.body.id : '' };
  });
  if (!made.client) { console.log('\nNo client — the rest depends on it.'); await cleanup(); process.exit(1); }

  // One payload, used twice: once when it must be refused and once when it
  // must succeed. If these differed, the gate test could fail for a reason
  // that has nothing to do with the gate — which is exactly what happened.
  const VALID_REQUIREMENT = () => ({
    title: `${TAG} Java Developer`,
    clientId: made.client,
    department: 'IT',
    location: 'Hyderabad',
    openings: 2,
    experienceMin: 2,
    experienceMax: 5,
    description: 'Java, Spring Boot, REST APIs. Written by the end-to-end test.',
    skills: 'Java, Spring Boot, REST',
  });

  // --- 2. the agreement gate ----------------------------------------------
  console.log('\n2. AGREEMENT GATE  (a requirement must be refused until the agreement is ACTIVE)');
  await step('requirement PARKED at Agreement Check, not live', async () => {
    const r = await api('POST', '/requirements', VALID_REQUIREMENT());
    if (r.ok) made.gateRequirement = r.body.id;
    const st = r.body?.status;
    const parked = st === 'AGREEMENT_CHECK';
    return {
      ...r,
      ok: r.ok && parked,
      note: !r.ok ? 'refused outright' : (parked ? 'status AGREEMENT_CHECK — saved but not live' : `WENT LIVE as ${st} — the gate did not hold`),
    };
  });

  await step('generate agreement', async () => {
    const r = await api('POST', `/clients/${made.client}/agreement/generate`, {});
    return { ...r, note: r.ok ? (r.body.agreementId || 'generated') : '' };
  });
  await step('send agreement to the client', async () => {
    const r = await api('POST', `/clients/${made.client}/agreement/send`, {});
    return { ...r, note: r.ok ? 'out for signature' : '' };
  });
  await step('confirm agreement (makes it ACTIVE)', async () => {
    const r = await api('POST', `/clients/${made.client}/agreement/confirm`, { signedBy: 'Test Signatory', signedByTitle: 'Director' });
    return { ...r, note: r.ok ? `status ${r.body.agreementStatus || 'SIGNED'}` : '' };
  });

  // --- 3. requirement ------------------------------------------------------
  console.log('\n3. REQUIREMENT');
  const req = await step('create requirement (now allowed)', async () => {
    const r = await api('POST', '/requirements', VALID_REQUIREMENT());
    if (r.ok) made.requirement = r.body.id;
    return { ...r, note: r.ok ? r.body.id : '' };
  });
  if (!made.requirement) { console.log('\nNo requirement — stopping.'); await cleanup(); process.exit(1); }

  // --- 4. candidate --------------------------------------------------------
  console.log('\n4. CANDIDATE');
  await step('create candidate', async () => {
    const r = await api('POST', '/candidates', {
      name: `${TAG} Arjun Reddy`,
      email: 'zze2e.candidate@example.invalid',
      phone: '9876500002',
      department: 'IT', specialization: 'Java',
      skills: 'Java, Spring Boot',
      totalExperience: 3, currentLocation: 'Hyderabad', source: 'Naukri',
    });
    if (r.ok) made.candidate = r.body.id;
    return { ...r, note: r.ok ? r.body.id : '' };
  });
  if (!made.candidate) { console.log('\nNo candidate — stopping.'); await cleanup(); process.exit(1); }

  // --- 5. application ------------------------------------------------------
  console.log('\n5. APPLICATION');
  await step('create application (candidate x requirement)', async () => {
    const r = await api('POST', '/applications', { candidateId: made.candidate, requirementId: made.requirement });
    if (r.ok) made.application = r.body.id;
    return { ...r, note: r.ok ? `stage ${r.body.stage}` : '' };
  });
  if (!made.application) { console.log('\nNo application — stopping.'); await cleanup(); process.exit(1); }

  // --- 6. the pipeline -----------------------------------------------------
  console.log('\n6. PIPELINE  (every stage, in order)');
  const PIPELINE = [
    'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED',
    'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED',
    'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED',
  ];
  for (const stage of PIPELINE) {
    // eslint-disable-next-line no-await-in-loop
    await step(`-> ${stage}`, async () => {
      const r = await api('PATCH', `/applications/${made.application}/stage`, { stage });
      return { ...r, note: r.ok ? '' : '' };
    });
  }

  // --- 7. the hiring-type branch ------------------------------------------
  console.log('\n7. HIRING-TYPE BRANCH  (client placement must NOT accept the offer stages)');
  await step('OFFER refused for a client placement', async () => {
    const r = await api('PATCH', `/applications/${made.application}/stage`, { stage: 'OFFER' });
    return { ...r, ok: !r.ok, note: r.ok ? 'IT WAS ALLOWED — the branch did not hold' : `refused: ${String(r.body?.error).slice(0, 90)}` };
  });
  await step('JOINED allowed for a client placement', async () => {
    const r = await api('PATCH', `/applications/${made.application}/stage`, { stage: 'JOINED' });
    return { ...r, note: r.ok ? '' : '' };
  });

  // --- 8. the accounts handoff --------------------------------------------
  console.log('\n8. ACCOUNTS HANDOFF  (joining should raise an invoice by itself)');
  await step('invoice raised automatically on JOINED', async () => {
    const r = await api('GET', `/invoices?clientId=${made.client}`);
    const list = Array.isArray(r.body) ? r.body : (r.body?.rows || []);
    const mine = list.filter((i) => i.clientId === made.client);
    if (mine[0]) made.invoice = mine[0].id;
    return { ok: mine.length > 0, status: r.status, body: r.body, note: mine.length ? `invoice ${mine[0].invoiceNumber || mine[0].id}` : 'no invoice found for this client' };
  });

  // --- 9. history ----------------------------------------------------------
  console.log('\n9. HISTORY  (every move recorded)');
  await step('pipeline history written on the candidate', async () => {
    const r = await api('GET', `/candidates/${made.candidate}`);
    const b = r.body || {};
    const events = b.stageEvents || b.history || b.pipelineHistory || [];
    return {
      ...r,
      ok: r.ok && Array.isArray(events) && events.length >= PIPELINE.length,
      note: r.ok ? `${events.length} stage events (expected at least ${PIPELINE.length})` : '',
    };
  });

  await step('candidate survives — rejection/history never deletes them', async () => {
    const r = await api('GET', `/candidates/${made.candidate}`);
    return { ...r, note: r.ok ? `${r.body?.name} still in the master` : '' };
  });

  // --- summary -------------------------------------------------------------
  console.log('\n' + '='.repeat(64));
  const pass = results.filter((r) => r.ok).length;
  console.log(`RESULT: ${pass} / ${results.length} passed`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\nFAILED STEPS:');
    failed.forEach((f) => console.log(`  ${c.fail} ${f.name}\n      ${f.detail}`));
  }

  await cleanup();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e.message); await cleanup(); process.exit(1); });

// Reverse dependency order, and every failure swallowed: cleanup must not be
// the reason a test run reports a problem.
async function cleanup() {
  if (KEEP) { console.log('\n--keep: test data left in place.'); return; }
  console.log('\ncleaning up…');
  const prisma = require('../src/db');
  try {
    if (made.application) {
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: made.application } });
      await prisma.applicationFollowUp.deleteMany({ where: { applicationId: made.application } });
      await prisma.interviewEvent.deleteMany({ where: { applicationId: made.application } }).catch(() => {});
      await prisma.application.delete({ where: { id: made.application } });
    }
    if (made.client) await prisma.invoice.deleteMany({ where: { clientId: made.client } });
    if (made.candidate) await prisma.candidate.delete({ where: { id: made.candidate } });
    // Both requirements: the one parked by the gate test and the live one.
    for (const id of [made.requirement, made.gateRequirement].filter(Boolean)) {
      await prisma.application.deleteMany({ where: { requirementId: id } });
      await prisma.requirement.delete({ where: { id } }).catch(() => {});
    }
    if (made.client) await prisma.client.delete({ where: { id: made.client } });
    const left = await prisma.client.count({ where: { name: { startsWith: TAG } } });
    console.log(`  done — ${TAG} clients remaining: ${left}`);
  } catch (err) {
    console.log('  cleanup incomplete: ' + String(err.message).slice(0, 160));
    console.log('  remove by hand with:  DELETE FROM Client WHERE name LIKE \'ZZE2E%\';');
  }
}

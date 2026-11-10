// node --test job-portal-app/embed/test/resume-import.test.mjs
// Import Resumes (founder 2026-11-10): matched -> attached; new -> candidate made, resume attached, login sent; files read a few at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeImport } from '../resume-import.mjs';

function fakePortal({ people = {}, unreadable = [] } = {}) {
  const log = { inserts: [], updates: [], stored: [], invited: [], screened: [], reading: 0, mostAtOnce: 0 };
  const P = {
    db: {
      withUser: async (session, fn) => fn({
        query: async (sql, args) => {
          if (/^\s*insert into candidates/i.test(sql)) { log.inserts.push({ session, args }); people[args[2] || args[3]] = { candidateId: args[0], name: args[1], by: 'new' }; return { rows: [] }; }
          if (/update candidates/i.test(sql)) { log.updates.push(args[4]); return { rows: [] }; }
          if (/from applications/i.test(sql)) return { rows: [{ id: `app-${args[0]}` }] };
          return { rows: [] };
        },
      }),
    },
    errors: { badRequest: (m) => Object.assign(new Error(m), { status: 400 }) },
    storage: { storeResume: async ({ candidateId, originalName }) => { log.stored.push(candidateId); return { displayName: originalName, path: `p/${candidateId}`, mime: 'application/pdf', size: 10 }; } },
    extract: {
      extractResumeText: async (buf, name) => {
        log.reading += 1; log.mostAtOnce = Math.max(log.mostAtOnce, log.reading);
        await new Promise((r) => setTimeout(r, 15));
        log.reading -= 1;
        if (unreadable.includes(name)) throw new Error('it is not a document');
        return { text: String(buf), chars: 100, parser: 'fake' };
      },
    },
    fields: {
      extractFields: (text) => { const [name, email, phone] = text.split('|'); return { fields: { name, email, phone }, found: 3 }; },
      parseConfidence: () => 0.9,
    },
    apply: { applyExtractedFields: async () => {} },
    match: { matchResumeToCandidate: async (_s, f) => people[f.email] || people[f.phone] || null },
    screening: { screenApplication: async (id) => { log.screened.push(id); return { score: 70 }; } },
    invite: { inviteCandidates: async (list) => { log.invited.push(...list); return { invited: list.length, skipped: 0 }; } },
  };
  return { P, log };
}
const file = (name, text) => ({ originalname: name, buffer: Buffer.from(text) });
const recruiter = { userId: 'u1', role: 'recruiter', profileId: 'rec1' };

test('a known person is attached; a new person is made, attached and sent a login; the rest is explained', async () => {
  const { P, log } = fakePortal({ people: { 'ravi@example.test': { candidateId: 'cand_ravi', name: 'Ravi', by: 'email' } }, unreadable: ['photo.pdf'] });
  const run = makeImport(P);
  const out = await run(recruiter, [
    file('ravi.pdf', 'Ravi|ravi@example.test|'),
    file('sita.pdf', 'Sita Devi|sita@example.test|9876543210'),
    file('phoneonly.pdf', 'Kiran||9123456789'),
    file('nocontact.pdf', 'Somebody||'),
    file('photo.pdf', 'x'),
  ]);
  assert.equal(out.matched, 1);
  assert.equal(out.created, 2);
  assert.equal(out.unmatched, 1);
  assert.equal(out.refused, 1);
  assert.equal(out.detail.matched[0].candidateId, 'cand_ravi');
  assert.deepEqual(out.detail.created.map((c) => [c.candidateName, c.loginTo]), [['Sita Devi', 'email'], ['Kiran', 'phone']]);
  assert.match(out.detail.unmatched[0].reason, /no email address or phone number/);
  // the new ones belong to the recruiter who imported them, from "Import Resumes"
  assert.equal(log.inserts.length, 2);
  assert.equal(log.inserts[0].args[4], 'rec1');
  assert.equal(log.inserts[0].args[5], 'Resume Import');
  // every placed resume is stored and written on its candidate
  assert.equal(log.stored.length, 3);
  assert.equal(log.updates.length, 3);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.invited.map((p) => p.name), ['Sita Devi', 'Kiran'], 'logins go to the new candidates only');
  assert.deepEqual(log.screened, ['app-cand_ravi'], 'the matched candidate is scored again, after the answer');
});

test('two resumes of one new person make one candidate', async () => {
  const { P, log } = fakePortal();
  const out = await makeImport(P)(recruiter, [file('a.pdf', 'Asha|asha@example.test|'), file('b.pdf', 'Asha|asha@example.test|')]);
  assert.equal(out.created, 1);
  assert.equal(out.matched, 1);
  assert.equal(log.inserts.length, 1);
});

test('files are read a few at a time, not one by one', async () => {
  const { P, log } = fakePortal();
  const files = Array.from({ length: 10 }, (_, i) => file(`f${i}.pdf`, `P${i}|p${i}@example.test|`));
  await makeImport(P)(recruiter, files);
  assert.equal(log.mostAtOnce, 4);
});

test('an admin import has no owner; no files is refused in plain words', async () => {
  const { P, log } = fakePortal();
  await makeImport(P)({ userId: 'a1', role: 'admin', profileId: null }, [file('n.pdf', 'Nina|nina@example.test|')]);
  assert.equal(log.inserts[0].args[4], null);
  await assert.rejects(makeImport(P)(recruiter, []), /Choose the resume files/);
});

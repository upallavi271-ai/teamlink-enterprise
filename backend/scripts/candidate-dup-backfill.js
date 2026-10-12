#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CANDIDATE DUPLICATES — one-time backfill: index every existing candidate and raise the flags.
//
//   node scripts/candidate-dup-backfill.js [--db <file>] [--json <out.json>]        DRY RUN (default): changes nothing
//   node scripts/candidate-dup-backfill.js --db <file> --apply                       write keys, resume signatures and flags
//   node scripts/candidate-dup-backfill.js --db <file> --undo <undo-file.json>       take back exactly what --apply wrote
//
// DRY RUN  works on a COPY (VACUUM INTO a temp file, so the real dev.db is only read) and prints:
//          how many candidates have which key, the duplicate pairs by level (CERTAIN / LIKELY / POSSIBLE), how many of
//          those profiles are still at the first step (what the gate would hold), how many have no application yet,
//          how many are older (already past the first step), the shared / placeholder keys that were ignored, and a sample.
// --apply  1. takes a backup of the database (prisma/backups/), 2. writes CandidateDupKey / CandidateDupSig rows (ids start
//          "bk"), 3. writes the flags (door "Backfill …", status OPEN) — existing rows are never touched, 4. records the
//          one-time "index is complete" marker (AppSetting candidate-duplicates.index), 5. writes the undo file next to
//          the backup. Nobody is notified; nothing is merged, moved, rejected or deleted.
//          On the REAL dev.db it refuses unless --really-real AND TL_ALLOW_REAL_APPLY=1 are both given.
//   --portal [--portal-url <url>]   also compare the Job Portal's applicants with the ATS candidates (READ ONLY: one GET to the
//          running portal's TeamLink integration endpoint with the sync token from .env; the portal's own database is never
//          opened). --portal-file <json> does the same from a saved copy of that answer.
// --undo   removes the rows listed in the undo file (flags only while still untouched/OPEN) and the marker.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db') || DEV_DB);
const isReal = path.resolve(dbArg).toLowerCase() === path.resolve(DEV_DB).toLowerCase();
const APPLY = has('--apply');
const UNDO = val('--undo');

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL dev.db. It needs --really-real and TL_ALLOW_REAL_APPLY=1 (ask the user first). Use --db <copy> to try it on a copy.');
  process.exit(2);
}

async function main() {
  const { PrismaClient } = require('@prisma/client'); // eslint-disable-line global-require
  let workDb = dbArg;
  let tmpCopy = null;
  if (!APPLY && !UNDO) {
    // dry run: analyse a copy, so the database itself is only read
    tmpCopy = path.join(os.tmpdir(), `dup-dryrun-${Date.now()}.db`);
    const src = new PrismaClient({ datasources: { db: { url: `file:${dbArg.replace(/\\/g, '/')}` } } });
    await src.$executeRawUnsafe(`VACUUM INTO '${tmpCopy.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    await src.$disconnect();
    workDb = tmpCopy;
  }
  process.env.DATABASE_URL = `file:${workDb.replace(/\\/g, '/')}`;
  const prisma = require('../src/db'); // eslint-disable-line global-require
  const FP = require('../src/utils/candidateFingerprint'); // eslint-disable-line global-require
  const { nameAgreementOf } = require('../src/utils/candidateDedupe'); // eslint-disable-line global-require
  const crypto = require('crypto'); // eslint-disable-line global-require

  const q = async (sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; }); return o; });
  const ex = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
  const ms = (v) => (v == null ? 0 : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v) || 0)));
  const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
  const FIRST = ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'];

  const tables = (await q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('CandidateDupFlag','CandidateDupKey','CandidateDupSig')")).length;
  if (tables !== 3) { console.error('The duplicate tables are not in this database (migration 20261010200000_candidate_duplicates).'); process.exit(3); }

  // ----------------------------------------------------------------------- UNDO
  if (UNDO) {
    const u = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
    const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    let k = 0; let f = 0; let s = 0;
    for (const part of chunk(u.keyIds, 500)) k += await ex(`DELETE FROM CandidateDupKey WHERE id IN (${part.map(() => '?').join(',')})`, ...part); // eslint-disable-line no-await-in-loop
    for (const part of chunk(u.flagIds, 500)) f += await ex(`DELETE FROM CandidateDupFlag WHERE status = 'OPEN' AND id IN (${part.map(() => '?').join(',')})`, ...part); // eslint-disable-line no-await-in-loop
    for (const part of chunk(u.sigIds, 500)) s += await ex(`DELETE FROM CandidateDupSig WHERE candidateId IN (${part.map(() => '?').join(',')})`, ...part); // eslint-disable-line no-await-in-loop
    await ex("DELETE FROM AppSetting WHERE key = 'candidate-duplicates.index'");
    console.log(`Undone: ${k} keys, ${f} flags (still OPEN), ${s} signatures removed; index marker cleared.`);
    process.exit(0);
  }

  // ----------------------------------------------------------------------- READ
  const t0 = Date.now();
  const cands = await q('SELECT id, name, phone, email, dob, location, institute, currentCompany, source, createdAt, profileStatus FROM Candidate');
  const byId = new Map(cands.map((c) => [c.id, c]));
  const resumes = new Map();
  const addResume = (id, sha, text) => {
    const cur = resumes.get(id) || { shas: new Set(), sig: null, chars: 0 };
    if (sha) cur.shas.add(String(sha).toLowerCase());
    if (text && !cur.sig) { const sg = FP.resumeSignature(text); if (sg) { cur.sig = sg.sig; cur.chars = String(text).length; } }
    resumes.set(id, cur);
  };
  try { (await q("SELECT candidateId, sha256, text FROM CandidateResume WHERE hiddenAt IS NULL AND kind = 'ORIGINAL'")).forEach((r) => addResume(r.candidateId, r.sha256, r.text)); } catch { /* none */ }
  try { (await q("SELECT candidateId, sha256 FROM CandidateDocument WHERE deletedAt IS NULL AND sha256 IS NOT NULL AND docType = 'Resume'")).forEach((r) => addResume(r.candidateId, r.sha256, null)); } catch { /* none */ }
  const stagesOf = new Map();
  (await q('SELECT candidateId, stage FROM Application')).forEach((a) => { if (!stagesOf.has(a.candidateId)) stagesOf.set(a.candidateId, []); stagesOf.get(a.candidateId).push(a.stage); });

  // ----------------------------------------------------------------------- KEYS
  const keysOf = new Map(); // id -> fps
  const sharers = new Map(); // kind|value -> [ids]
  const kindCount = {};
  cands.forEach((c) => {
    const r = resumes.get(c.id);
    const fps = FP.fingerprintsOf(c, r ? { shas: [...r.shas], sig: r.sig } : {});
    keysOf.set(c.id, fps);
    fps.forEach((k) => {
      const key = `${k.kind}\u0001${k.value}`;
      if (!sharers.has(key)) sharers.set(key, []);
      sharers.get(key).push(c.id);
      kindCount[k.kind] = (kindCount[k.kind] || 0) + 1;
    });
  });
  const skipped = []; // shared / placeholder keys
  const pairs = new Map(); // pairKey -> { a, b, kinds:Set }
  sharers.forEach((ids, key) => {
    if (ids.length < 2) return;
    const [kind, value] = key.split('\u0001');
    if (ids.length > (FP.MAX_SHARERS[kind] || 8)) { skipped.push({ kind, value: kind === 'PHONE' || kind === 'EMAIL' ? `${value.slice(0, 3)}…${value.slice(-2)}` : value.slice(0, 30), count: ids.length }); return; }
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const pk = [ids[i], ids[j]].sort().join('|');
        if (!pairs.has(pk)) pairs.set(pk, { a: ids[i], b: ids[j], kinds: new Set() });
        pairs.get(pk).kinds.add(kind);
      }
    }
  });

  // ----------------------------------------------------------------------- CLASSIFY
  const flags = [];
  const stat = { CERTAIN: 0, LIKELY: 0, POSSIBLE: 0 };
  const byReason = {};
  const agree = { same: 0, variant: 0, different: 0 };
  pairs.forEach((p, pk) => {
    const A = byId.get(p.a); const B = byId.get(p.b);
    if (!A || !B) return;
    const kinds = new Set(p.kinds);
    let similarity = 0;
    if (kinds.has('RESUME_BAND')) {
      similarity = FP.sigSimilarity((resumes.get(p.a) || {}).sig, (resumes.get(p.b) || {}).sig);
      if (similarity < 0.75) kinds.delete('RESUME_BAND');
    }
    const ag = nameAgreementOf([A.name, B.name], new Set([FP.normName(A.name), FP.normName(B.name)]));
    const cls = FP.classify(kinds, { nameAgreement: ag, similarity });
    if (!cls) return;
    const aNewer = ms(A.createdAt) !== ms(B.createdAt) ? ms(A.createdAt) > ms(B.createdAt) : A.id > B.id;
    const sub = aNewer ? A : B; const mat = aNewer ? B : A;
    const sst = stagesOf.get(sub.id) || [];
    const inFirst = !sst.length || sst.some((s) => FIRST.includes(s));
    flags.push({
      pairKey: pk, sub, mat, level: cls.level, reasons: cls.reasons, nameAgreement: ag, similarity, inFirst, noApp: !sst.length,
      detail: JSON.stringify({ nameAgreement: ag, similarity: similarity ? Math.round(similarity * 100) : undefined }),
    });
    stat[cls.level] += 1;
    if (cls.level !== 'POSSIBLE') agree[ag] += 1;
    const rk = cls.reasons.join('+'); byReason[rk] = (byReason[rk] || 0) + 1;
  });

  // ----------------------------------------------------------------------- REPORT
  const blocking = flags.filter((f) => f.level !== 'POSSIBLE');
  const subjectsBlocking = new Set(blocking.map((f) => f.sub.id));
  const holdNow = blocking.filter((f) => f.inFirst);
  const subjectsHeld = new Set(holdNow.map((f) => f.sub.id));
  const firstStepApps = [...stagesOf.entries()].filter(([, s]) => s.some((x) => FIRST.includes(x))).length;
  const nothing = cands.filter((c) => !String(c.phone || '').trim() && !String(c.email || '').trim()).length;
  const report = {
    database: dbArg, copyAnalysed: !!tmpCopy, candidates: cands.length, seconds: Math.round((Date.now() - t0) / 100) / 10,
    keysPerKind: kindCount,
    candidatesWithNeitherPhoneNorEmail: nothing,
    sharedKeysIgnored: skipped.length, sharedKeysTop: skipped.sort((a, b) => b.count - a.count).slice(0, 10),
    pairs: { total: flags.length, ...stat },
    certainOrLikelyPairs: blocking.length,
    profilesWithCertainOrLikely: subjectsBlocking.size,
    gateWouldHoldNow: { pairs: holdNow.length, profiles: subjectsHeld.size, ofWhichNoApplicationYet: new Set(holdNow.filter((f) => f.noApp).map((f) => f.sub.id)).size },
    olderPairsPastFirstStep: blocking.length - holdNow.length,
    candidatesWithAnApplicationAtFirstStep: firstStepApps,
    nameAgreementOnCertainOrLikely: agree,
    byReason,
    possibleAtFirstStep: flags.filter((f) => f.level === 'POSSIBLE' && f.inFirst).length,
    sample: blocking.slice(0, 8).map((f) => ({ level: f.level, reasons: f.reasons, newer: f.sub.name, existing: f.mat.name, nameAgreement: f.nameAgreement, atFirstStep: f.inFirst })),
  };
  console.log(JSON.stringify(report, null, 2));
  const writeJson = () => { const out = val('--json'); if (out) fs.writeFileSync(out, JSON.stringify({ report, pairs: blocking.map((f) => ({ level: f.level, reasons: f.reasons, newer: f.sub.id, existing: f.mat.id, newerName: f.sub.name, existingName: f.mat.name, nameAgreement: f.nameAgreement, inFirst: f.inFirst })) }, null, 1)); };

  // ----------------------------------------------------------------------- JOB PORTAL <-> ATS (read only)
  if (has('--portal') || val('--portal-file')) {
    const phoneIx = new Map(); const emailIx = new Map();
    keysOf.forEach((fps, id) => fps.forEach((k) => {
      const m = k.kind === 'PHONE' ? phoneIx : (k.kind === 'EMAIL' ? emailIx : null);
      if (!m) return;
      if (!m.has(k.value)) m.set(k.value, []);
      m.get(k.value).push(id);
    }));
    const portal = { reachable: false };
    let apps = null;
    try {
      if (val('--portal-file')) apps = JSON.parse(fs.readFileSync(val('--portal-file'), 'utf8')).applications || [];
      else {
        const env = {};
        try { fs.readFileSync(path.join(BACK, '.env'), 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }); } catch { /* no .env */ }
        const base = (val('--portal-url') || env.JOB_PORTAL_API_URL || `http://127.0.0.1:${env.JOB_PORTAL_PORT || 4323}`).replace(/\/+$/, '');
        if (!env.JOB_PORTAL_SYNC_TOKEN) throw new Error('JOB_PORTAL_SYNC_TOKEN is not set in backend/.env');
        const r = await fetch(`${base}/api/integrations/teamlink/applications?since=1970-01-01T00:00:00Z&limit=2000`, { headers: { 'x-teamlink-token': env.JOB_PORTAL_SYNC_TOKEN }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`the portal answered ${r.status}`);
        apps = (await r.json()).applications || [];
      }
    } catch (e) { portal.error = `Job Portal not reachable (${e.message}). Start the portal (the ATS embeds it at /jobs) and run again, or pass --portal-file <saved answer>.`; }
    if (apps) {
      portal.reachable = true;
      const people = new Map(); // portal candidate id -> { name, phones, email }
      apps.forEach((a) => {
        const c = a.candidate || {};
        const id = c.id || `${c.email || ''}|${c.phone || ''}`;
        if (!people.has(id)) people.set(id, { id, name: c.name, phones: FP.normPhones(c.phone), email: FP.normEmail(c.email) });
      });
      let byPhone = 0; let byEmail = 0; let either = 0; let several = 0; let notIn = 0;
      const sample = [];
      const inside = new Map(); // contact -> portal ids (the same person twice inside the portal itself)
      people.forEach((p) => {
        const hitsP = new Set(); const hitsE = new Set();
        p.phones.forEach((k) => (phoneIx.get(k) || []).forEach((id) => hitsP.add(id)));
        if (p.email) (emailIx.get(p.email) || []).forEach((id) => hitsE.add(id));
        const all = new Set([...hitsP, ...hitsE]);
        if (hitsP.size) byPhone += 1;
        if (hitsE.size) byEmail += 1;
        if (all.size) either += 1; else notIn += 1;
        if (all.size > 1) several += 1;
        if (all.size && sample.length < 8) sample.push({ portalName: p.name, atsNames: [...all].slice(0, 3).map((id) => byId.get(id).name), matchedBy: hitsP.size ? 'phone' : 'email' });
        [...p.phones.map((k) => `p:${k}`), ...(p.email ? [`e:${p.email}`] : [])].forEach((k) => { if (!inside.has(k)) inside.set(k, new Set()); inside.get(k).add(p.id); });
      });
      Object.assign(portal, {
        portalApplications: apps.length, portalPeople: people.size,
        alreadyInAts: either, matchedByPhone: byPhone, matchedByEmail: byEmail, matchingMoreThanOneAtsProfile: several, notInAts: notIn,
        samePersonTwiceInsidePortal: [...inside.values()].filter((v) => v.size > 1).length,
        sample,
        note: 'Only applications on jobs synced from the ATS are reachable (newest 2,000). A portal registration that never applied is not visible through the integration.',
      });
    }
    report.portalVsAts = portal;
    console.log('\nJOB PORTAL <-> ATS (read only):');
    console.log(JSON.stringify(portal, null, 2));
  }

  writeJson();
  if (!APPLY) {
    console.log('\nDRY RUN — nothing was changed. Add --apply to write the index and the flags (a backup is taken first).');
    if (tmpCopy) { await prisma.$disconnect(); try { fs.rmSync(tmpCopy, { force: true }); fs.rmSync(`${tmpCopy}-wal`, { force: true }); fs.rmSync(`${tmpCopy}-shm`, { force: true }); } catch { /* temp */ } }
    process.exit(0);
  }

  // ----------------------------------------------------------------------- APPLY
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACK, 'prisma', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(workDb)}.before-dup-backfill-${stamp}.db`);
  await ex(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  console.log(`Backup written: ${backup}`);
  const undo = { db: workDb, backup, at: new Date().toISOString(), keyIds: [], flagIds: [], sigIds: [] };
  const now = Date.now();
  const haveKey = new Set((await q('SELECT candidateId, kind, value FROM CandidateDupKey')).map((k) => `${k.candidateId}\u0001${k.kind}\u0001${k.value}`));
  const haveSig = new Set((await q('SELECT candidateId FROM CandidateDupSig')).map((k) => k.candidateId));
  const havePair = new Set((await q('SELECT pairKey FROM CandidateDupFlag')).map((k) => k.pairKey));
  const rowsK = [];
  keysOf.forEach((fps, id) => fps.forEach((k) => { if (!haveKey.has(`${id}\u0001${k.kind}\u0001${k.value}`)) rowsK.push([newId('bk'), id, k.kind, k.value, now]); }));
  const batch = async (table, cols, rows, size) => {
    for (let i = 0; i < rows.length; i += size) {
      const part = rows.slice(i, i + size);
      // eslint-disable-next-line no-await-in-loop
      await ex(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}`, ...part.flat());
    }
  };
  await batch('CandidateDupKey', ['id', 'candidateId', 'kind', 'value', 'createdAt'], rowsK, 150);
  rowsK.forEach((r) => undo.keyIds.push(r[0]));
  const rowsS = [];
  resumes.forEach((r, id) => { if ((r.sig || r.shas.size) && !haveSig.has(id)) rowsS.push([id, r.sig || null, [...r.shas][0] || null, r.chars || null, now]); });
  await batch('CandidateDupSig', ['candidateId', 'resumeSig', 'resumeSha', 'resumeChars', 'updatedAt'], rowsS, 150);
  rowsS.forEach((r) => undo.sigIds.push(r[0]));
  const rowsF = [];
  flags.forEach((f) => {
    if (havePair.has(f.pairKey)) return;
    if (f.level === 'POSSIBLE' && !f.inFirst) return; // old name-only hints are not worth a row
    const id = newId('df');
    rowsF.push([id, f.pairKey, f.sub.id, f.mat.id, f.level, JSON.stringify(f.reasons), f.detail, 'Backfill', 'OPEN', now, now]);
    undo.flagIds.push(id);
  });
  await batch('CandidateDupFlag', ['id', 'pairKey', 'candidateId', 'matchCandidateId', 'level', 'reasons', 'detail', 'door', 'status', 'createdAt', 'updatedAt'], rowsF, 80);
  await ex(`INSERT INTO AppSetting (key, value, updatedByName, updatedAt) VALUES ('candidate-duplicates.index', ?, 'Backfill', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  JSON.stringify({ backfilledAt: new Date().toISOString(), candidates: cands.length, flags: rowsF.length }), now);
  const undoFile = path.join(backupDir, `dup-backfill-undo-${stamp}.json`);
  fs.writeFileSync(undoFile, JSON.stringify(undo));
  console.log(`APPLIED: ${rowsK.length} keys, ${rowsS.length} resume signatures, ${rowsF.length} flags.`);
  console.log(`Undo with: node scripts/candidate-dup-backfill.js --db "${workDb}" --undo "${undoFile}"`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });

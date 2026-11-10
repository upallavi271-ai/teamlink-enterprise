/*
 * IMPORT RESUMES THAT ALSO ADD THE NEW PEOPLE (founder 2026-11-10: "candidates unte match ayi resumes aa candidates ki attach avali,
 * lekapothey resumes anevi candidates ni create chesi vallaki aa resumes tho login credentials send avali, link kuda vellali teamlink dhi";
 * and "chala slow ga read avuthundhi").
 *
 *   POST /api/tl-resumes/import   (served by the TeamLink router in front of the portal, embed/teamlink-integration.mjs)
 *     a resume of somebody already in the portal  -> attached to them, as the portal's own "Match and attach" does
 *     a resume of somebody new                    -> a candidate is made from what the resume says (name + email or phone),
 *                                                    the resume attached, and a portal login is sent with the TeamLink link
 *                                                    (the portal's own invite: email, SMS, WhatsApp; never twice)
 *     a resume with no name, or no email and no phone -> listed, nothing made
 *
 * FASTER: the files are read four at a time (reading a PDF is the slow part), and the scores of a matched candidate's applications
 * are worked out again AFTER the answer, not while the recruiter waits; the logins go out after the answer too.
 *
 * The portal's code is not changed: its own modules do every step (reading, matching, storing, the database rules of the person who
 * is signed in, the invite), and its own session, CSRF and role checks guard the route.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const READ_AT_ONCE = 4;
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clean = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

let chain = null;

async function load(root) {
  const at = (p) => import(pathToFileURL(join(root, 'api', 'src', p)).href);
  const req = createRequire(join(root, 'api', 'package.json'));
  const [config, db, errors, auth, storage, extract, fields, apply, match, screening, invite] = await Promise.all([
    at('config.js'), at('db.js'), at('errors.js'), at('auth.js'), at('storage.js'), at('resume/extract.js'), at('resume/fields.js'),
    at('resume/apply.js'), at('resume/match.js'), at('ai/screening.js'), at('notify/invite.js'),
  ]);
  return { config: config.config, db, errors, auth, storage, extract, fields, apply, match, screening, invite, multer: req('multer'), cookieParser: req('cookie-parser') };
}

// a few at a time, results in the files' order
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i); // eslint-disable-line no-await-in-loop
    }
  }));
  return out;
}

export function makeImport(P) {
  const { withUser } = P.db;
  const { badRequest } = P.errors;
  const ENGINE = { userId: '', role: 'admin', profileId: null };

  async function attach(session, candidateId, file, doc, parsed) {
    const stored = await P.storage.storeResume({ candidateId, buffer: file.buffer, originalName: file.originalname || 'resume' });
    const confidence = P.fields.parseConfidence({ fields: parsed.fields, chars: doc.chars });
    await withUser(session, async (c) => {
      await c.query(
        `update candidates
            set resume_file=$1, resume_storage_path=$2, resume_mime=$3,
                resume_size=$4, resume_uploaded_at=now(), resume_parsed_at=now(),
                resume_parser=$6, resume_chars=$7, resume_fields_detected=$8,
                resume_parse_confidence=$9, resume_parse_error=null, resume_text=$10
          where id=$5`,
        [stored.displayName, stored.path, stored.mime, stored.size, candidateId,
         doc.parser, doc.chars, parsed.found, confidence, String(doc.text || '').slice(0, 200000)]);
      await P.apply.applyExtractedFields(c, candidateId, parsed.fields);
    });
    return stored;
  }

  // a matched candidate's open applications are scored again: after the answer, so nobody waits for the AI
  function rescreenLater(candidateId) {
    setImmediate(async () => {
      try {
        const apps = await withUser(ENGINE, async (c) => (await c.query(
          `select id from applications where candidate_id=$1 and stage not in ('rejected','joined')`, [candidateId])).rows);
        for (const a of apps) await P.screening.screenApplication(a.id, { actor: 'system', force: true }); // eslint-disable-line no-await-in-loop
      } catch (err) { console.error('[tl-resumes] re-screening failed:', err.message); }
    });
  }

  return async function run(session, files) {
    if (!files.length) throw badRequest('Choose the resume files to add.');
    const matched = []; const created = []; const unmatched = []; const refused = [];

    // 1. read every file, a few at a time
    const read = await pool(files, READ_AT_ONCE, async (file) => {
      try {
        const doc = await P.extract.extractResumeText(file.buffer, file.originalname || 'resume');
        return { file, doc, parsed: P.fields.extractFields(doc.text) };
      } catch (err) { return { file, error: err.message || 'it could not be read' }; }
    });

    // 2. place them one by one, so two resumes of one new person make one candidate
    const toInvite = [];
    for (const r of read) {
      const name = r.file.originalname || 'resume';
      if (r.error) { refused.push({ file: name, reason: r.error }); continue; }
      const f = r.parsed.fields || {};
      const hit = await P.match.matchResumeToCandidate(session, f); // eslint-disable-line no-await-in-loop
      try {
        if (hit) {
          const stored = await attach(session, hit.candidateId, r.file, r.doc, r.parsed); // eslint-disable-line no-await-in-loop
          rescreenLater(hit.candidateId);
          matched.push({ file: name, candidateId: hit.candidateId, candidateName: hit.name, matchedBy: hit.by, fileName: stored.displayName, fieldsDetected: r.parsed.found });
          continue;
        }
        const person = clean(f.name, 120);
        const email = clean(f.email, 200).toLowerCase();
        const phone = clean(f.phone || f.altPhone, 32);
        if (!person || (!email && !phone)) {
          unmatched.push({
            file: name,
            read: { name: f.name || undefined, email: f.email || undefined, phone: f.phone || undefined, currentCompany: f.currentCompany || undefined, location: f.location || undefined },
            reason: person ? 'no email address or phone number could be read from it, so nobody can be added or sent a login'
              : 'no name could be read from it',
          });
          continue;
        }
        const id = newId('cand');
        // the person who imports owns the new candidate, as in the portal's spreadsheet import
        await withUser(session, async (c) => c.query( // eslint-disable-line no-await-in-loop
          `insert into candidates (id, name, email, phone, owner_recruiter_id, source, source_details)
           values ($1,$2,$3,$4,$5, candidate_source_canonical($6), $7)`,
          [id, person, email || null, phone || null, session.role === 'recruiter' ? session.profileId : null, 'Resume Import', 'Import Resumes']));
        const stored = await attach(session, id, r.file, r.doc, r.parsed); // eslint-disable-line no-await-in-loop
        toInvite.push({ id, name: person, email: email || null, phone: phone || null });
        created.push({ file: name, candidateId: id, candidateName: person, email: email || null, phone: phone || null, fileName: stored.displayName, loginTo: email ? 'email' : 'phone' });
      } catch (err) {
        refused.push({ file: name, reason: err.message || 'it could not be added' });
      }
    }

    // 3. the logins, with the TeamLink link, after the answer: a slow message provider must not hold the screen
    if (toInvite.length) {
      P.invite.inviteCandidates(toInvite, { invitedBy: session.userId || 'import', addedBy: null })
        .then((s) => console.log(`[tl-resumes] logins: ${s.invited} sent, ${s.skipped} not sent`))
        .catch((err) => console.error('[tl-resumes] logins failed:', err.message));
    }
    return {
      files: files.length, matched: matched.length, created: created.length, unmatched: unmatched.length, refused: refused.length,
      detail: { matched, created, unmatched, refused },
    };
  };
}

// The express chain: the portal's own cookie parser, session, CSRF and role checks, then the upload, then the import.
export async function handler(root) {
  if (chain) return chain;
  const P = await load(root);
  const run = makeImport(P);
  const { ApiError, CODES, badRequest } = P.errors;
  const bulk = P.multer({ storage: P.multer.memoryStorage(), limits: { fileSize: P.config.maxUploadBytes, files: 40 } });
  const steps = [
    P.cookieParser(),
    P.auth.attachSession(),
    P.auth.csrfProtection(),
    P.auth.requireAuth(),
    P.auth.requireRole('recruiter', 'bde', 'admin'),
    (req, res, next) => bulk.array('resumes', 40)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, CODES.FILE_TOO_LARGE, `One of those files is too large. The limit is ${Math.round(P.config.maxUploadBytes / 1024 / 1024)}MB each.`));
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return next(badRequest('Too many files at once - 40 is the limit.'));
      return next(new ApiError(400, CODES.UPLOAD_FAILED, 'Those files could not be uploaded.'));
    }),
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      run(req.session, req.files || []).then((out) => res.status(201).json(out), next);
    },
  ];
  chain = (req, res, done) => {
    let i = 0;
    const next = (err) => {
      if (err) return done(err);
      const step = steps[i++];
      if (!step) return done();
      try { return step(req, res, next); } catch (e) { return done(e); }
    };
    next();
  };
  return chain;
}

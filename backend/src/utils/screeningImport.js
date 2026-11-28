// A COLLEGE / PROFILE SCREENING SHEET on Interview Calendar > Import: a college
// name, a candidate name and an interview date, with no e-mail, phone or
// requirement code. Whatever such a row needs and is not on file (the college as
// a client, its screening requirement, the candidate, the pipeline row) is made
// here, then the ordinary interview import writes the interview. The preview
// writes nothing; it only says what Confirm will add.
//
// A candidate with no contact is known by name + college (externalRef), so the
// same file twice does not add the same people twice. A name alone is never
// used: two people called Priya are not one person.
const prisma = require('../db');

const SCREENING_TITLE = 'Interview Screening';

function isScreeningRow(d) {
  return !d._candidate && !d._requirement && !!d._candidateName && !!d._client;
}

// "4 Years" -> 4, "6 Months" -> 0.5, "Fresher" -> 0, anything else -> null.
function yearsOf(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('fresher')) return 0;
  const m = /(\d+(?:\.\d+)?)\s*\+?\s*(month)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? Math.round((n / 12) * 100) / 100 : n;
}

// THE DEPARTMENT OF A NEW CLIENT (founder 2026-11-28: Education clients are the Education BDE's, Medical the
// Medical BDE's, MFG the MFG BDE's, every client the BDE TL's). Never a default: a hospital imported by the BDE TL
// was filed under Education and showed in the Education logins. In this order:
//   the row's Department column -> the importer's one BDE desk -> the importer's own department ->
//   the name ("... Hospital", "Dental", "Medical" -> Medical; "College", "School", "University" -> Education).
// Nothing found: the row is refused with the reason, so nobody's client lands in another team.
const MEDICAL_NAME = /hospital|medical|dental|clinic|health ?care|nursing home|diagnostic/i;
const EDUCATION_NAME = /college|school|university|polytechnic|academy|vidyalaya|engineering|pharmacy/i;
function departmentForNew(ctx, data, college) {
  const { canonicalDepartment } = require('./bdeDesk'); // eslint-disable-line global-require
  const real = (v) => { const d = canonicalDepartment(v); return d && d !== 'BDE' ? d : null; };
  const named = real(data._department);
  if (named) return { dept: named, from: 'the Department column' };
  const desks = ((ctx.s && ctx.s.bdeDeskDepartments) || []).map(real).filter(Boolean);
  if ([...new Set(desks)].length === 1) return { dept: desks[0], from: 'your BDE desk' };
  const own = real(ctx.s && ctx.s.atsDepartment);
  if (own) return { dept: own, from: 'your department' };
  if (MEDICAL_NAME.test(college)) return { dept: 'Medical', from: 'the name (hospital / medical / dental / clinic)' };
  if (EDUCATION_NAME.test(college)) return { dept: 'Education', from: 'the name (college / school / university)' };
  return null;
}

// Whoever may import interview schedules (the route checks that) may have this
// sheet add what it needs: no separate "add client / job / candidate" right.
async function ensureScreeningRefs({ ctx, data, note, HANDLERS, isDry }) {
  const { ix, user, dry } = ctx;
  if (!data._date) throw new Error('no Interview Date on this row');
  const college = String(data._client).trim();
  const name = String(data._candidateName).trim();
  const title = String(data._requirementTitle || '').trim() || SCREENING_TITLE;
  // 1. the college, as a client
  let clientId = ix.client.get(ix.ckey(college)) || ix.clientByAlias(college);
  if (!clientId) {
    const dep = departmentForNew(ctx, data, college);
    if (!dep) throw new Error(`"${college}" is not a client yet and its department is not known: add a Department column (Education, Medical or Manufacturing)`);
    await HANDLERS.client({ data: { name: college, ownerDepartment: dep.dept }, ix, dry });
    clientId = ix.client.get(ix.ckey(college));
    note(`new client "${college}" (${dep.dept}, from ${dep.from})`);
  }

  // 2. its requirement (made once, then reused)
  const reqKey = `${ix.ckey(college)}|${ix.ckey(title)}`;
  if (!ctx.screeningReqs) ctx.screeningReqs = new Map();
  let code = ctx.screeningReqs.get(reqKey);
  if (!code) {
    const onFile = isDry(clientId) ? [] : await prisma.requirement.findMany({ where: { clientId }, select: { id: true, title: true, reqCode: true } });
    const hit = onFile.find((r) => r.reqCode && ix.ckey(r.title) === ix.ckey(title));
    if (hit) code = hit.reqCode;
    else {
      if (dry) {
        code = `NEW:${reqKey}`;
        ix.requirement.set(ix.norm(code), `dry:${reqKey}`);
      } else {
        const client = await prisma.client.findUnique({ where: { id: clientId }, select: { agreementStatus: true, ownerDepartment: true } });
        const bde = ctx.s && /BDE/.test(ctx.s.atsRole || '') ? user.name : null;
        const active = String((client && client.agreementStatus) || '').toUpperCase() === 'ACTIVE';
        await HANDLERS.requirement({
          data: {
            _client: college, title, openings: 1, status: active ? 'OPEN' : 'AGREEMENT_CHECK', _bde: bde,
            department: (client && client.ownerDepartment) || (departmentForNew(ctx, data, college) || {}).dept || null,
          },
          ix, dry: false,
        });
        const id = ix.requirement.get(`t|${ix.ckey(college)}|${ix.norm(title)}`);
        const made = await prisma.requirement.findUnique({ where: { id }, select: { reqCode: true } });
        code = made.reqCode;
        ix.requirement.set(ix.norm(code), id);
      }
      note(`new requirement "${title}" for ${college}`);
    }
    ctx.screeningReqs.set(reqKey, code);
  }

  // 3. the candidate
  const externalRef = `SCR:${ix.ckey(college)}:${ix.ckey(name)}`;
  const ref = `ref:${externalRef}`;
  let candidateId = ix.candidate.get(ix.norm(ref));
  if (!candidateId) {
    if (dry) candidateId = `dry:${ref}`;
    else {
      const row = await prisma.candidate.create({
        data: {
          name, externalRef, source: null, institute: college,
          education: data._qualification || null, specialization: data._branch || null,
          experienceYears: yearsOf(data._candidateExperience),
          location: data._presentLocation || null, currentSalary: data._presentSalary || null,
          expectedSalary: data._expectedSalary || null, noticePeriod: data._noticePeriod || null,
        },
      });
      await require('./candidateDates').mark(row.id, 'unknown', { byName: user.name || null, via: 'interview import' }); // eslint-disable-line global-require
      candidateId = row.id;
    }
    ix.candidate.set(ix.norm(ref), candidateId);
    note(`new candidate "${name}"`);
  }

  // 4. on that requirement's pipeline
  const requirementId = ix.requirement.get(ix.norm(code));
  const onIt = isDry(candidateId) || isDry(requirementId) ? 0
    : await prisma.application.count({ where: { candidateId, requirementId } });
  if (!onIt && !ix.appKeys.has(`${candidateId}|${requirementId}`)) {
    await HANDLERS.application({
      data: { _candidate: ref, _requirement: code, stage: 'INTERVIEW_SCHEDULED' },
      ix, dry, note, actor: user,
    });
    ix.appKeys.add(`${candidateId}|${requirementId}`);
  }

  data._candidate = ref;
  data._requirement = code;
  // planned = the application exists only in the preview: there is nothing to compare with yet
  return { planned: dry && !onIt };
}

module.exports = { isScreeningRow, ensureScreeningRefs, yearsOf, departmentForNew };

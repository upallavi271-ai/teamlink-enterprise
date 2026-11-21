// ---------------------------------------------------------------------------
// MARKET WAVE B - JOB REQUIREMENTS (02.09 / 02.10 / 02.12 / 02.13 / 02.14 / 02.16).
//
//   02.09 CLIENT PIPELINE     per CLIENT: a step not used / a step that needs a TL / STL / Manager / Admin approval, plus the client's own
//                             interview rounds and notes. Checked before the department's pipeline (utils/deptPipelines.js gate).
//   02.10 SCREENING           questions on a job (yes/no, number, choice, text) with knockout answers. The job portal asks them on Apply;
//                             a recruiter can record them from a call. A failing answer FLAGS the application; with "hold" the
//                             application is put On hold and goes to the human review queue (undo there).
//   02.12 SKILLS FROM JD      the skills vocabulary (utils/resumeParse.js) found in the description, must-have vs good-to-have by section;
//                             the AI may add only words that are really in the text.
//   02.13 INTAKE ASSISTANT    a call note / client e-mail -> a requirement draft (utils/requestAutoFill.js rules + client + department +
//                             skills); the person checks it in the normal Add requirement form. Nothing is saved here.
//   02.14 ALWAYS-ON SEARCH    each job keeps its matching people (utils/matching.js); people new since the last look are flagged.
//   02.16 POSTING RULES       which sites a job is posted to, by department / client / employment type (most specific rule wins).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('./store');

const V = () => require('../atsVocab'); // eslint-disable-line global-require
const DP = () => require('../deptPipelines'); // eslint-disable-line global-require

// ---- 02.09 client pipeline ------------------------------------------------------------------------------------------------------
async function clientPipeline(clientId) {
  const rows = await S.q('SELECT "stage","enabled","approverRole" FROM "MktClientPipeline" WHERE "clientId" = ?', clientId);
  const [proc] = await S.q('SELECT * FROM "MktClientProcess" WHERE "clientId" = ?', clientId);
  const cfg = {};
  rows.forEach((r) => { cfg[r.stage] = { enabled: Number(r.enabled) !== 0, approverRole: r.approverRole || null }; });
  return { clientId, stages: DP().view(cfg), configured: rows.length > 0, rounds: S.parse(proc && proc.rounds, []), notes: (proc && proc.notes) || '', approvers: DP().APPROVERS, labels: V().STAGE_LABELS };
}
async function saveClientPipeline(clientId, body, user) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!client) return { error: 'Client not found.', status: 404 };
  const bad = []; const rows = [];
  Object.entries(body.stages && typeof body.stages === 'object' ? body.stages : {}).forEach(([code, v]) => {
    if (!V().STAGE_CODES.includes(code)) return;
    const enabled = !(v && (v.enabled === false || v.enabled === 'false' || v.enabled === 0));
    const approverRole = v && DP().APPROVERS.includes(v.approverRole) ? v.approverRole : null;
    if (!enabled && DP().MANDATORY.includes(code)) { bad.push(V().STAGE_LABELS[code] || code); return; }
    if (enabled && !approverRole) return;
    rows.push({ code, enabled, approverRole });
  });
  if (bad.length) return { error: `These steps are used by the offer, joining and client flows and cannot be switched off: ${bad.join(', ')}.` };
  const rounds = (Array.isArray(body.rounds) ? body.rounds : String(body.rounds || '').split(/\n/)).map((r) => S.clean(r, 80)).filter(Boolean).slice(0, 10);
  await S.x('DELETE FROM "MktClientPipeline" WHERE "clientId" = ?', clientId);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await S.x('INSERT INTO "MktClientPipeline" ("clientId","stage","enabled","approverRole","byName","at") VALUES (?,?,?,?,?,?)', clientId, r.code, r.enabled ? 1 : 0, r.approverRole, user.name, S.now());
  }
  await S.x('INSERT INTO "MktClientProcess" ("clientId","rounds","notes","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("clientId") DO UPDATE SET "rounds"=excluded."rounds","notes"=excluded."notes","byName"=excluded."byName","at"=excluded."at"',
    clientId, JSON.stringify(rounds), S.clean(body.notes, 1500), user.name, S.now());
  clientCache.delete(clientId);
  return { ...(await clientPipeline(clientId)), clientName: client.name, off: rows.filter((r) => !r.enabled).map((r) => r.code), approval: rows.filter((r) => r.approverRole).map((r) => `${r.code}:${r.approverRole}`) };
}
async function clientsConfigured() {
  const rows = await S.q('SELECT "clientId", COUNT(*) AS n FROM "MktClientPipeline" GROUP BY "clientId"');
  const procs = await S.q('SELECT "clientId" FROM "MktClientProcess" WHERE "rounds" <> \'[]\' OR ("notes" IS NOT NULL AND "notes" <> \'\')');
  const ids = [...new Set([...rows.map((r) => r.clientId), ...procs.map((r) => r.clientId)])];
  const names = new Map((await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return ids.map((id) => ({ clientId: id, name: names.get(id) || id, steps: S.num((rows.find((r) => r.clientId === id) || {}).n) }));
}
const clientCache = new Map();
async function clientCfg(clientId) {
  const hit = clientCache.get(clientId);
  if (hit && Date.now() - hit.at < 15000) return hit.cfg;
  const rows = await S.q('SELECT "stage","enabled","approverRole" FROM "MktClientPipeline" WHERE "clientId" = ?', clientId);
  const cfg = {};
  rows.forEach((r) => { cfg[r.stage] = { enabled: Number(r.enabled) !== 0, approverRole: r.approverRole || null }; });
  clientCache.set(clientId, { at: Date.now(), cfg });
  return cfg;
}
const RANK = { RECRUITER: 1, BDE: 1, TL: 2, STL: 3, ASSISTANT_MANAGER: 4, MANAGER: 5, ADMIN: 6, SUPER_ADMIN: 7 };
const APPROVER_RANK = { TL: 2, STL: 3, MANAGER: 5, ADMIN: 6 };
// the gate (called first by utils/deptPipelines.js gate): null = no client rule for this step
async function clientGate(existing, toStage, user, { viaFlow = false } = {}) {
  try {
    if (viaFlow || !toStage || ['HOLD', 'REJECTED'].includes(toStage) || existing.stage === toStage) return null;
    const r = existing.requirement || {};
    if (!r.clientId || r.internal) return null;
    const row = (await clientCfg(r.clientId))[toStage];
    if (!row) return null;
    if (require('../permissions').stageGlobal(user)) return { pass: true }; // eslint-disable-line global-require
    const label = V().STAGE_LABELS[toStage] || toStage;
    const clientName = (r.client && r.client.name) || 'This client';
    if (row.enabled === false && !DP().MANDATORY.includes(toStage)) {
      return { status: 409, body: { error: `${clientName} does not use the "${label}" step. Move the candidate to the next step this client uses.`, code: 'CLIENT_STAGE_OFF', stage: toStage } };
    }
    const rank = Math.max(0, ...[user.atsRole, user.role].filter(Boolean).map((x) => RANK[x] || 0));
    if (row.approverRole && rank < (APPROVER_RANK[row.approverRole] || 99)) {
      await require('../notify').notifyUsers([r.tlId, r.stlId].filter(Boolean), { title: `Approval asked: ${label}`, message: `${user.name || 'A recruiter'} asks to move ${existing.candidate ? existing.candidate.name : 'a candidate'} (${r.title || 'a requirement'}) to "${label}". ${clientName} needs ${row.approverRole} approval for this step.`, exceptUserId: user.id }).catch(() => {}); // eslint-disable-line global-require
      return { status: 403, body: { error: `For ${clientName}, moving a candidate to "${label}" needs ${row.approverRole === 'TL' ? 'a TL' : `a ${row.approverRole.toLowerCase()}`} (or above). Your team lead has been told.`, code: 'APPROVAL_REQUIRED', stage: toStage } };
    }
    return { pass: true }; // the client's own rule allows it: the department rule for this step does not apply
  } catch (e) {
    console.error('[client-pipeline]', e.message); // eslint-disable-line no-console
    return null;
  }
}

// ---- 02.10 screening / knockout questions ---------------------------------------------------------------------------------------
const Q_TYPES = ['yesno', 'number', 'choice', 'text'];
function cleanQuestions(list) {
  const out = []; const errors = [];
  (Array.isArray(list) ? list : []).slice(0, 15).forEach((raw, i) => {
    const text = S.clean(raw && raw.text, 200);
    if (!text) return;
    const type = Q_TYPES.includes(raw.type) ? raw.type : 'yesno';
    const options = type === 'choice' ? [...new Set((Array.isArray(raw.options) ? raw.options : String(raw.options || '').split(',')).map((o) => S.clean(o, 60)).filter(Boolean))].slice(0, 12) : [];
    if (type === 'choice' && options.length < 2) errors.push(`Question ${i + 1} needs at least two choices.`);
    let knockout = null;
    const k = raw.knockout;
    if (k && k.op && k.value !== undefined && k.value !== '') {
      if (type === 'yesno' && ['eq'].includes(k.op)) knockout = { op: 'eq', value: /^(yes|true|1)$/i.test(String(k.value)) ? 'yes' : 'no' };
      else if (type === 'number' && ['min', 'max'].includes(k.op) && Number.isFinite(Number(k.value))) knockout = { op: k.op, value: Number(k.value) };
      else if (type === 'choice' && k.op === 'in') {
        const ok = (Array.isArray(k.value) ? k.value : String(k.value).split(',')).map((v) => S.clean(v, 60)).filter((v) => options.includes(v));
        if (ok.length) knockout = { op: 'in', value: ok };
      }
    }
    out.push({ id: S.clean(raw.id, 40) || `q${i + 1}`, text, type, options, required: raw.required !== false, knockout });
  });
  return { questions: out, errors };
}
async function screening(requirementId) {
  const [row] = await S.q('SELECT * FROM "MktScreenQ" WHERE "requirementId" = ?', requirementId);
  return { requirementId, questions: S.parse(row && row.questions, []), action: (row && row.action) || 'flag', byName: row && row.byName, at: row && row.at };
}
async function saveScreening(requirementId, body, user) {
  const { questions, errors } = cleanQuestions(body.questions);
  if (errors.length) return { error: errors.join(' ') };
  const action = body.action === 'hold' ? 'hold' : 'flag';
  await S.x('INSERT INTO "MktScreenQ" ("requirementId","questions","action","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("requirementId") DO UPDATE SET "questions"=excluded."questions","action"=excluded."action","byName"=excluded."byName","at"=excluded."at"',
    requirementId, JSON.stringify(questions), action, user.name, S.now());
  return screening(requirementId);
}
// what the public apply form sees: never the knockout answers
async function publicQuestions(requirementId) {
  const s = await screening(requirementId);
  return s.questions.map((qq) => ({ id: qq.id, text: qq.text, type: qq.type, options: qq.options, required: qq.required }));
}
function evaluate(questions, answers) {
  const failed = []; const missing = []; const clean = {};
  questions.forEach((qq) => {
    const raw = answers ? answers[qq.id] : undefined;
    const v = raw == null ? '' : String(raw).trim().slice(0, 300);
    if (!v) { if (qq.required) missing.push(qq.text); return; }
    clean[qq.id] = v;
    const k = qq.knockout;
    if (!k) return;
    let bad = false;
    if (k.op === 'eq') bad = (/^(yes|y|true|1)$/i.test(v) ? 'yes' : 'no') !== k.value;
    if (k.op === 'min') bad = !(Number(v) >= k.value);
    if (k.op === 'max') bad = !(Number(v) <= k.value);
    if (k.op === 'in') bad = !k.value.includes(v);
    if (bad) failed.push({ id: qq.id, text: qq.text, answer: v, rule: k.op === 'eq' ? `must be ${k.value}` : k.op === 'min' ? `at least ${k.value}` : k.op === 'max' ? `at most ${k.value}` : `one of ${k.value.join(', ')}` });
  });
  return { answers: clean, failed, missing };
}
const EARLY = ['NEW', 'AI_INTERVIEW_REQUIRED', 'RECRUITER_REVIEW'];
async function recordAnswers(application, answers, { source = 'Recruiter', user = null, strict = false } = {}) {
  const sc = await screening(application.requirementId);
  if (!sc.questions.length) return { none: true };
  const ev = evaluate(sc.questions, answers || {});
  if (strict && ev.missing.length) return { error: `Please answer: ${ev.missing.join('; ')}` };
  await S.x('INSERT INTO "MktScreenAnswer" ("applicationId","requirementId","candidateId","answers","failed","source","byName","at") VALUES (?,?,?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "answers"=excluded."answers","failed"=excluded."failed","source"=excluded."source","byName"=excluded."byName","at"=excluded."at"',
    application.id, application.requirementId, application.candidateId, JSON.stringify(ev.answers), JSON.stringify(ev.failed), source, user ? user.name : source, S.now());
  let held = false;
  if (ev.failed.length && sc.action === 'hold') {
    const app = await prisma.application.findUnique({ where: { id: application.id }, select: { id: true, stage: true, candidateId: true } });
    if (app && EARLY.includes(app.stage)) {
      const why = ev.failed.map((f) => `${f.text}: "${f.answer}" (${f.rule})`).join('; ');
      await prisma.application.update({ where: { id: app.id }, data: { stage: 'HOLD' } });
      await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: app.candidateId, fromStage: app.stage, toStage: 'HOLD', action: 'On hold: screening answer', comment: why.slice(0, 500), actorName: 'Screening rule', actorRole: 'SYSTEM', reasonCategory: 'Screening knockout', reasonDetail: why.slice(0, 500) } });
      await require('./gov').addReview({ kind: 'Knockout hold', refType: 'Application', refId: app.id, applicationId: app.id, candidateId: app.candidateId, summary: why, aiDecision: 'Put on hold', undo: { type: 'stage', applicationId: app.id, fromStage: 'HOLD', toStage: app.stage } }); // eslint-disable-line global-require
      held = true;
    }
  }
  return { ...ev, held, action: sc.action };
}
async function answersFor(applicationIds) {
  if (!applicationIds.length) return new Map();
  const rows = await S.q(`SELECT * FROM "MktScreenAnswer" WHERE "applicationId" IN (${applicationIds.map(() => '?').join(',')})`, ...applicationIds);
  return new Map(rows.map((r) => [r.applicationId, { answers: S.parse(r.answers, {}), failed: S.parse(r.failed, []), source: r.source, at: r.at, byName: r.byName }]));
}

// ---- 02.12 skills from the JD ---------------------------------------------------------------------------------------------------
const GOOD_HEAD = /(good|nice)\s*to\s*have|preferred|desirable|added advantage|plus\b|bonus|optional/i;
const MUST_HEAD = /must|mandatory|required|requirements|key skills|skills|qualifications|what we look for/i;
async function extractSkills(text, { useAi = true } = {}) {
  const RP = require('../resumeParse'); // eslint-disable-line global-require
  const t = String(text || '').slice(0, 12000);
  if (t.trim().length < 10) return { error: 'Add a job description first (a few lines at least).' };
  const vocab = await RP.skillVocabulary();
  const lines = t.split(/\n+/);
  const must = new Set(); const good = new Set();
  let mode = 'must';
  lines.forEach((line) => {
    const low = line.toLowerCase();
    if (line.length < 60 && GOOD_HEAD.test(line)) mode = 'good';
    else if (line.length < 60 && MUST_HEAD.test(line)) mode = 'must';
    const inlineGood = GOOD_HEAD.test(line) && line.length >= 60;
    vocab.forEach((term) => {
      if (term.length < 2 || term.length > 40) return;
      if (term.length <= 2 && !/^(c|r|go|ai|ml|qa|ui|ux|hr|it|bi)$/.test(term)) return;
      if (RP.textHasTerm(low, term)) (mode === 'good' || inlineGood ? good : must).add(term);
    });
  });
  good.forEach((s) => { if (must.has(s)) good.delete(s); });
  let source = 'rules';
  if (useAi) {
    try {
      const ai = require('../fastAi'); // eslint-disable-line global-require
      const r = await ai.chat('You read a job description and list its skills. Reply with JSON only: {"mustHave": string[], "goodToHave": string[]}. Use short lowercase skill names that appear in the text. No sentences.', [{ role: 'user', content: t.slice(0, 6000) }], { json: true, maxTokens: 400, temperature: 0, purpose: 'Skills from JD', fallbackToApp: false, deadlineMs: 15000 });
      const out = require('../ai').parseJsonLoose(r.text); // eslint-disable-line global-require
      if (out && typeof out === 'object') {
        const lowText = t.toLowerCase();
        const keep = (arr) => (Array.isArray(arr) ? arr : []).map((v) => String(v).toLowerCase().trim()).filter((v) => v && v.length <= 40 && lowText.includes(v));
        keep(out.mustHave).forEach((v) => { if (!good.has(v)) must.add(v); });
        keep(out.goodToHave).forEach((v) => { if (!must.has(v)) good.add(v); });
        source = 'rules+ai';
      }
    } catch { /* the rules' answer stands */ }
  }
  const tidy = (set) => [...set].filter((s) => ![...set].some((o) => o !== s && o.includes(s) && o.length <= s.length + 8 && s.length < 4)).slice(0, 25);
  return { mandatory: tidy(must), goodToHave: tidy(good), source };
}

// ---- 02.13 intake assistant -------------------------------------------------------------------------------------------------------
const DEPT_HINTS = [
  ['Medical', /\b(nurs|icu|doctor|physician|hospital|clinic|pharma|medical|patient|ot technician|lab technician|radiolog|dental|mbbs|gnm)/i],
  ['Education', /\b(teacher|teaching|lecturer|professor|school|college|faculty|principal|tutor|curriculum)/i],
  ['Manufacturing', /\b(cnc|plc|production|plant|factory|machin|welding|quality control|maintenance engineer|shop floor|assembly)/i],
  ['IT', /\b(java|python|developer|software|react|node|angular|devops|cloud|aws|sql|tester|qa engineer|full stack|data scien)/i],
];
function stripMail(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*(from|to|cc|bcc|sent|date|subject)\s*:/i.test(l)) { if (/^\s*subject\s*:/i.test(l)) out.push(l.replace(/^\s*subject\s*:\s*/i, '')); continue; } // eslint-disable-line no-continue
    if (/^\s*(regards|thanks( and regards)?|best regards|warm regards|sincerely|sent from my)\b/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}
async function intake(text, user) {
  const raw = stripMail(text);
  if (raw.length < 10) return { error: 'Paste the call note or the client\'s e-mail (a few lines at least).' };
  const G = require('./gov'); // eslint-disable-line global-require
  const masked = G.maskText(raw).text.replace(/\[(EMAIL|PHONE|ID|PAN|AADHAAR)_\d+\]/g, ' ');
  let places = [];
  try { places = ((await require('../jobLocations').list()).locations || []).map((p) => p.name); } catch { places = []; } // eslint-disable-line global-require
  const RAF = require('../requestAutoFill'); // eslint-disable-line global-require
  const out = await RAF.fill(masked.slice(0, 1500), { places });
  if (out.error) return { error: out.error };
  const f = out.fields || {};
  // the client: a client in this login's reach whose name is in the text
  const { clientPickerWhere } = require('../scope'); // eslint-disable-line global-require
  const clients = await prisma.client.findMany({ where: clientPickerWhere(user), select: { id: true, name: true, ownerDepartment: true }, take: 3000 });
  const low = raw.toLowerCase();
  const client = clients.filter((c) => c.name && c.name.length >= 3 && low.includes(c.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0] || null;
  const skills = await extractSkills(raw, { useAi: false });
  const mand = [...new Set([...(skills.mandatory || []), ...String(f.skills || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s.length <= 30)])].slice(0, 15);
  const dept = (client && client.ownerDepartment) || (DEPT_HINTS.find(([, re]) => re.test(raw)) || [])[0] || '';
  const exp = String(f.experience || '').match(/\d+(?:\.\d+)?/g) || [];
  const notice = (raw.match(/\b(immediate|immediately|15 days|30 days|45 days|60 days|90 days|1 month|2 months|3 months)\b/i) || [])[0] || '';
  const draft = {
    title: f.title || '',
    clientId: client ? client.id : '',
    clientName: client ? client.name : '',
    department: dept,
    openings: f.openings || 1,
    skills: mand.join(', '),
    goodToHaveSkills: (skills.goodToHave || []).join(', '),
    expMin: exp[0] !== undefined ? Number(exp[0]) : '',
    expMax: exp[1] !== undefined ? Number(exp[1]) : (exp[0] !== undefined ? Number(exp[0]) + 3 : ''),
    location: f.location || '',
    workMode: f.workMode || '',
    employmentType: f.employmentType || '',
    jobPreference: /contract|temporary|temp\b/i.test(raw) ? 'Contract' : 'Permanent',
    noticePeriodMax: /immediate/i.test(notice) ? 'Immediate' : (notice ? notice.replace(/1 month/i, '30 Days').replace(/2 months/i, '60 Days').replace(/3 months/i, '90 Days').replace(/days/i, 'Days') : ''),
    jobDescription: out.jobDescription || '',
    responsibilities: out.responsibilities || '',
    salaryNote: f.salaryMonthlyMin || f.salaryMonthlyMax ? `Rs ${f.salaryMonthlyMin || '?'} - ${f.salaryMonthlyMax || '?'} a month (from the note)` : '',
  };
  const missing = [['title', 'job title'], ['clientId', 'client'], ['skills', 'skills'], ['location', 'location']].filter(([k]) => !draft[k]).map(([, l]) => l);
  return { draft, missing, by: out.by === 'ai' ? 'rules+ai' : 'rules', note: 'Check every field in the form before saving. Contact details in the note were left out.' };
}

// ---- 02.14 always-on job search ---------------------------------------------------------------------------------------------------
const MATCH_SELECT = {
  id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true, skills: true, education: true,
  availability: true, currentSalary: true, expectedSalary: true, jobPreference: true, noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true,
  specialisationId: true, currentDesignation: true, createdAt: true,
};
async function watchRun(requirement, user, { markSeen = false } = {}) {
  const M = require('../matching'); // eslint-disable-line global-require
  const { candidateWhere } = require('../scope'); // eslint-disable-line global-require
  const [cands, linked] = await Promise.all([
    prisma.candidate.findMany({ where: user ? candidateWhere(user) : {}, select: MATCH_SELECT }),
    prisma.application.findMany({ where: { requirementId: requirement.id }, select: { candidateId: true } }),
  ]);
  const ranked = M.rankCandidates(cands, requirement, { excludeIds: new Set(linked.map((a) => a.candidateId)), threshold: M.MATCH_THRESHOLD });
  const [row] = await S.q('SELECT * FROM "MktJobWatch" WHERE "requirementId" = ?', requirement.id);
  const seen = new Set(S.parse(row && row.seen, []));
  const first = !row;
  const fresh = ranked.filter((c) => !seen.has(c.id));
  const nextSeen = first || markSeen ? [...new Set([...seen, ...ranked.map((c) => c.id)])].slice(-5000) : [...seen];
  await S.x('INSERT INTO "MktJobWatch" ("requirementId","on","lastRunAt","seen","newIds","total","byName") VALUES (?,1,?,?,?,?,?) ON CONFLICT("requirementId") DO UPDATE SET "lastRunAt"=excluded."lastRunAt","seen"=excluded."seen","newIds"=excluded."newIds","total"=excluded."total"',
    requirement.id, S.now(), JSON.stringify(nextSeen), JSON.stringify(first || markSeen ? [] : fresh.map((c) => c.id).slice(0, 500)), ranked.length, user ? user.name : 'system');
  const newSet = new Set(first || markSeen ? [] : fresh.map((c) => c.id));
  return {
    requirementId: requirement.id, total: ranked.length, newCount: newSet.size, lastRunAt: S.now(), firstRun: first,
    rows: ranked.slice(0, 25).map((c) => ({ id: c.id, name: c.name, location: c.location, experienceYears: c.experienceYears, designation: c.currentDesignation, fit: c.match.overall, isNew: newSet.has(c.id) }))
      .sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.fit - a.fit),
  };
}
async function watchState(requirementId) {
  const [row] = await S.q('SELECT "lastRunAt","total","newIds" FROM "MktJobWatch" WHERE "requirementId" = ?', requirementId);
  return row ? { lastRunAt: row.lastRunAt, total: S.num(row.total), newCount: S.parse(row.newIds, []).length } : null;
}
// background: every 6 hours, open jobs that have a watch; bells only with the Admin switch ON
async function watchSweep() {
  const rows = await S.q('SELECT "requirementId" FROM "MktJobWatch" WHERE "on" = 1');
  let jobs = 0; let told = 0;
  const alerts = await S.setting('alerts.jobWatch');
  for (const r of rows.slice(0, 200)) {
    // eslint-disable-next-line no-await-in-loop
    const req = await prisma.requirement.findUnique({ where: { id: r.requirementId } });
    if (!req || !['OPEN', 'RECRUITER_ASSIGNED'].includes(req.status)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const out = await watchRun(req, null);
    jobs += 1;
    if (alerts && out.newCount > 0) {
      told += 1;
      // eslint-disable-next-line no-await-in-loop
      await require('../notify').notifyUsers([req.recruiterId, req.tlId].filter(Boolean), { title: `New matches: ${req.title}`, message: `${out.newCount} new people match this requirement. Open it > Hiring tools > Always-on search.`, open: `/requirements/${req.id}` }).catch(() => {}); // eslint-disable-line global-require
    }
  }
  return { jobs, told };
}

// ---- 02.16 posting rules ----------------------------------------------------------------------------------------------------------
async function postingRules() {
  const rows = await S.q('SELECT * FROM "MktPostingRule" ORDER BY "at" DESC');
  const ids = rows.map((r) => r.clientId).filter(Boolean);
  const names = new Map((ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
  return rows.map((r) => ({ ...r, active: Number(r.active) !== 0, sources: String(r.sources || '').split(',').filter(Boolean), clientName: r.clientId ? names.get(r.clientId) || null : null }));
}
async function savePostingRule(body, user) {
  const sources = [...new Set((Array.isArray(body.sources) ? body.sources : String(body.sources || '').split(',')).map((s) => S.clean(s, 60)).filter(Boolean))].slice(0, 20);
  if (!sources.length) return { error: 'Tick at least one place to post.' };
  const department = S.clean(body.department, 60); const clientId = S.clean(body.clientId, 60); const employmentType = S.clean(body.employmentType, 40);
  if (!department && !clientId && !employmentType) return { error: 'Pick a department, a client or a job type (or more than one) for the rule.' };
  const id = body.id ? String(body.id) : S.newId();
  await S.x(`INSERT INTO "MktPostingRule" ("id","name","department","clientId","employmentType","sources","active","byName","at") VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT("id") DO UPDATE SET "name"=excluded."name","department"=excluded."department","clientId"=excluded."clientId","employmentType"=excluded."employmentType","sources"=excluded."sources","active"=excluded."active","byName"=excluded."byName","at"=excluded."at"`,
  id, S.clean(body.name, 80) || [department, employmentType].filter(Boolean).join(' / ') || 'Rule', department, clientId, employmentType, sources.join(','), body.active === false ? 0 : 1, user.name, S.now());
  return { id, sources };
}
async function deletePostingRule(id) { await S.x('DELETE FROM "MktPostingRule" WHERE "id" = ?', id); return { ok: true }; }
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
async function ruleFor(requirement) {
  const rules = (await postingRules()).filter((r) => r.active);
  const fits = rules.filter((r) => (!r.clientId || r.clientId === requirement.clientId) && (!r.department || same(r.department, requirement.department)) && (!r.employmentType || same(r.employmentType, requirement.employmentType)));
  const score = (r) => (r.clientId ? 4 : 0) + (r.department ? 2 : 0) + (r.employmentType ? 1 : 0);
  fits.sort((a, b) => score(b) - score(a));
  const rule = fits[0] || null;
  return { rule, current: String(requirement.postingSources || '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'None'), why: rule ? `Rule "${rule.name}" (${[rule.clientName && `client ${rule.clientName}`, rule.department && `department ${rule.department}`, rule.employmentType && rule.employmentType].filter(Boolean).join(', ')})` : 'No rule fits this requirement.' };
}

module.exports = {
  clientPipeline, saveClientPipeline, clientsConfigured, clientGate,
  screening, saveScreening, publicQuestions, evaluate, recordAnswers, answersFor, cleanQuestions,
  extractSkills, intake, stripMail, watchRun, watchState, watchSweep, postingRules, savePostingRule, deletePostingRule, ruleFor,
};

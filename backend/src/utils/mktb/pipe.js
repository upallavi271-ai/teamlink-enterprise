// ---------------------------------------------------------------------------
// MARKET WAVE B - PIPELINE (04.05 / 04.06 / 04.09 / 04.12 / 04.13 / 04.14 / 04.16).
//
//   04.06 PITCH AGENT        a submission note for one application: written from the facts (and by the AI when it answers, masked);
//                            always a DRAFT until a person approves it (the approver may edit it). Nothing is sent.
//   04.05 PACKET             one PDF for the client: the approved note + screening answers + the formatted resume (no contact details).
//   04.09 AUTO-REJECT        rules (min experience, max notice, max expected salary, min Fit, failed knockout), global or per job;
//                            OFF by default (autoReject.on). Dry run shows who would be rejected. Each real one goes to the human
//                            review queue, where "Overturn" puts the application back.
//   04.12 PLACEMENT APPROVAL with placementApproval.on, each joining waits for an Admin / BDE TL to approve the placement. Invoices and
//                            Accounts are not touched (blocking the invoice on it is a founder decision).
//   04.13 TEMP-TO-PERM       contract placements: conversion due date, converted on, new CTC, conversion fee (recorded; billing it is
//                            a founder / Accounts decision).
//   04.14 BACKDOOR HIRES     utils/backdoorHire.js signals copied into the review queue (MktFraudFlag kind "Possible backdoor hire").
//   04.16 BLINDING           a panelist who has not submitted sees no other panelist's scores (feedbackBlind.on, default ON).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('./store');

const csv = (s) => String(s || '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
const lower = (s) => String(s || '').toLowerCase();

async function appInScope(applicationId, user) {
  const { applicationWhere } = require('../scope'); // eslint-disable-line global-require
  return prisma.application.findFirst({ where: { AND: [applicationWhere(user), { id: applicationId }] }, include: { candidate: true, requirement: { include: { client: { select: { id: true, name: true } } } } } });
}

// ---- 04.06 pitch -----------------------------------------------------------------------------------------------------------------
function rulePitch(app) {
  const c = app.candidate; const r = app.requirement;
  const need = csv(r.skills).map(lower);
  const have = new Set(csv(c.skills).map(lower));
  const hit = need.filter((s) => have.has(s) || [...have].some((h) => h.includes(s)));
  const lines = [
    `Dear ${r.internal ? 'team' : 'Hiring Manager'},`,
    '',
    `Please find the profile of ${c.name} for the ${r.title} role${r.client && !r.internal ? ` at ${r.client.name}` : ''}.`,
    [c.experienceYears != null ? `${c.experienceYears} years of experience` : null, c.currentDesignation ? `currently ${c.currentDesignation}` : null, c.currentCompany ? `at ${c.currentCompany}` : null].filter(Boolean).join(', ') + '.',
    hit.length ? `Matches the must-have skills: ${hit.join(', ')}${need.length > hit.length ? ` (${hit.length} of ${need.length})` : ''}.` : (c.skills ? `Key skills: ${csv(c.skills).slice(0, 6).join(', ')}.` : ''),
    c.location ? `Based in ${c.location}${c.preferredLocation ? `, open to ${c.preferredLocation}` : ''}.` : '',
    c.noticePeriod ? `Notice period: ${c.noticePeriod}.` : '',
    app.matchScore != null ? `Our fit score for this role: ${app.matchScore}%.` : '',
    '',
    'We have spoken to the candidate and confirmed interest. Happy to arrange an interview at your convenience.',
  ];
  return lines.filter((l, i, a) => l !== '' || (a[i - 1] !== '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function draftPitch(applicationId, user, { useAi = true } = {}) {
  const app = await appInScope(applicationId, user);
  if (!app) return { error: 'Application not found in your scope.', status: 404 };
  let text = rulePitch(app); let source = 'rules';
  if (useAi) {
    try {
      const a = await require('../fastAi').chat('You write a short submission note from a recruitment agency to a client about one candidate. Use ONLY the facts in the draft. Keep it under 150 words, warm and professional. Never add contact details, age, gender, religion or salary. Return only the note.', [{ role: 'user', content: text }], { maxTokens: 350, temperature: 0.2, purpose: 'Submission note', fallbackToApp: false, deadlineMs: 15000 }); // eslint-disable-line global-require
      if (a && a.text && a.text.length > 60) { text = String(a.text).trim().slice(0, 2500); source = 'ai'; }
    } catch { /* the rules note stands */ }
  }
  const id = S.newId();
  await S.x('INSERT INTO "MktPitch" ("id","applicationId","text","source","status","byName","at") VALUES (?,?,?,?,\'Draft\',?,?)', id, applicationId, text, source, user.name, S.now());
  return { id, applicationId, text, source, status: 'Draft' };
}
async function pitchesOf(applicationId) {
  return S.q('SELECT * FROM "MktPitch" WHERE "applicationId" = ? ORDER BY "at" DESC LIMIT 10', applicationId);
}
async function decidePitch(id, decision, text, user) {
  const [p] = await S.q('SELECT * FROM "MktPitch" WHERE "id" = ?', id);
  if (!p) return { error: 'Draft not found.', status: 404 };
  const app = await appInScope(p.applicationId, user);
  if (!app) return { error: 'Application not found in your scope.', status: 404 };
  if (p.status !== 'Draft') return { error: `This note is already ${p.status.toLowerCase()}.`, status: 409 };
  if (!['Approved', 'Rejected'].includes(decision)) return { error: 'Approve or reject the draft.' };
  const body = decision === 'Approved' ? (S.clean(text, 3000) || p.text) : p.text;
  await S.x('UPDATE "MktPitch" SET "status"=?,"text"=?,"approvedByName"=?,"approvedAt"=? WHERE "id"=?', decision, body, user.name, S.now(), id);
  if (decision === 'Approved' && text && S.clean(text, 3000) !== p.text) await require('./gov').addFlag({ kind: 'Override', feature: 'Submission note', refType: 'Pitch', refId: id, reason: 'Edited before approval', output: p.text, corrected: body }, user); // eslint-disable-line global-require
  return { ok: true, status: decision, applicationId: p.applicationId, candidateId: app.candidateId };
}

// ---- 04.05 packet ---------------------------------------------------------------------------------------------------------------
async function packet(applicationId, user) {
  const app = await appInScope(applicationId, user);
  if (!app) return { error: 'Application not found in your scope.', status: 404 };
  const C = require('./cands'); const J = require('./jobs'); // eslint-disable-line global-require
  const [approved] = await S.q('SELECT * FROM "MktPitch" WHERE "applicationId" = ? AND "status" = \'Approved\' ORDER BY "approvedAt" DESC LIMIT 1', applicationId);
  const answers = (await J.answersFor([applicationId])).get(applicationId) || null;
  const qs = (await J.screening(app.requirementId)).questions;
  const content = await C.resumeContent(app.candidateId, { useAi: false });
  const brand = process.env.COMPANY_BRAND || 'TeamLink';
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Submission ${content.ref} - ${app.requirement.title}`, Author: brand } });
  const chunks = []; doc.on('data', (b) => chunks.push(b));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.rect(0, 0, doc.page.width, 64).fill('#1f3a5f');
  doc.fillColor('#ffffff').fontSize(18).text(brand, 48, 22);
  doc.fontSize(9).text(`Candidate submission - ${app.requirement.title}${app.requirement.client && !app.requirement.internal ? ` - ${app.requirement.client.name}` : ''}`, 48, 44);
  doc.fillColor('#111111'); doc.y = 90;
  doc.fontSize(14).text(`${content.name}   (Ref ${content.ref})`);
  doc.fontSize(10).fillColor('#555555').text(content.headline || ''); doc.fillColor('#111111').moveDown();
  doc.fontSize(12).fillColor('#1f3a5f').text('SUBMISSION NOTE'); doc.fontSize(10).fillColor('#111111').moveDown(0.3);
  doc.text(approved ? approved.text : rulePitch(app));
  if (!approved) doc.moveDown(0.3).fontSize(8).fillColor('#a05a00').text('(Draft note - not yet approved)').fillColor('#111111').fontSize(10);
  if (answers && qs.length) {
    doc.moveDown().fontSize(12).fillColor('#1f3a5f').text('SCREENING ANSWERS'); doc.fontSize(10).fillColor('#111111').moveDown(0.3);
    qs.forEach((qq) => doc.text(`${qq.text}: ${answers.answers[qq.id] != null ? answers.answers[qq.id] : '-'}`));
  }
  doc.addPage();
  doc.fontSize(12).fillColor('#1f3a5f').text('PROFILE'); doc.fontSize(10).fillColor('#111111').moveDown(0.3);
  doc.text(content.summary || '-'); doc.moveDown(0.5);
  if (content.skills.length) doc.text(`Key skills: ${content.skills.join(', ')}`).moveDown(0.5);
  content.experience.forEach((e) => { doc.font('Helvetica-Bold').text(`${e.title || 'Role'}${e.company ? ` - ${e.company}` : ''}`); doc.font('Helvetica').text([e.from, e.to].filter(Boolean).join(' to ')); doc.moveDown(0.2); });
  if (content.education.length) { doc.moveDown(0.3).text(`Education: ${content.education.map((e) => [e.degree, e.institute, e.year].filter(Boolean).join(', ')).join('; ')}`); }
  doc.fontSize(8).fillColor('#888888').text(`Prepared by ${brand}. Phone, e-mail and address are withheld.`, 48, doc.page.height - 60, { align: 'center', width: doc.page.width - 96 });
  doc.end();
  return { buffer: await done, fileName: `Submission-${content.ref}.pdf`, approved: !!approved };
}

// ---- 04.09 auto-reject rules -------------------------------------------------------------------------------------------------------
const RULE_KINDS = {
  minExp: { label: 'Experience below (years)', test: (app, v) => app.candidate.experienceYears != null && app.candidate.experienceYears < Number(v), why: (app, v) => `${app.candidate.experienceYears} years is below ${v}` },
  maxNoticeDays: { label: 'Notice period above (days)', test: (app, v) => { const d = require('./cands').noticeDaysOf(app.candidate.noticePeriod); return d != null && d > Number(v); }, why: (app, v) => `notice ${app.candidate.noticePeriod} is above ${v} days` }, // eslint-disable-line global-require
  maxExpectedLakh: { label: 'Expected salary above (lakh / year)', test: (app, v) => { const n = Number(String(app.candidate.expectedSalary || '').replace(/[^\d.]/g, '')); const l = n > 1000 ? n / 100000 : n; return !!n && l > Number(v); }, why: (app, v) => `expects ${app.candidate.expectedSalary}, above ${v} lakh` },
  minFit: { label: 'Fit % below', test: (app, v) => app.matchScore != null && app.matchScore < Number(v), why: (app, v) => `Fit ${app.matchScore}% is below ${v}%` },
  knockout: { label: 'Failed a knockout screening question', test: (app, v, ctx) => !!(ctx.answers.get(app.id) && ctx.answers.get(app.id).failed.length), why: (app, v, ctx) => `failed: ${ctx.answers.get(app.id).failed.map((f) => f.text).join('; ')}` },
};
async function autoRules(scope = null) {
  const rows = await S.q(`SELECT * FROM "MktAutoRule" ${scope ? 'WHERE "scope" = ?' : ''} ORDER BY "at" DESC`, ...(scope ? [scope] : []));
  return rows.map((r) => ({ ...r, active: Number(r.active) !== 0, label: (RULE_KINDS[r.kind] || {}).label || r.kind }));
}
async function saveAutoRule(body, user) {
  if (!RULE_KINDS[body.kind]) return { error: 'Pick what the rule checks.' };
  if (body.kind !== 'knockout' && !Number.isFinite(Number(body.value))) return { error: 'Type a number for the rule.' };
  const scope = body.scope && body.scope !== 'global' ? String(body.scope) : 'global';
  const id = body.id || S.newId();
  await S.x('INSERT INTO "MktAutoRule" ("id","scope","kind","value","active","byName","at") VALUES (?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET "kind"=excluded."kind","value"=excluded."value","active"=excluded."active","byName"=excluded."byName","at"=excluded."at"',
    id, scope, body.kind, body.kind === 'knockout' ? '1' : String(Number(body.value)), body.active === false ? 0 : 1, user.name, S.now());
  return { id };
}
async function deleteAutoRule(id) { await S.x('DELETE FROM "MktAutoRule" WHERE "id" = ?', id); return { ok: true }; }
async function runAutoReject({ dryRun = true, requirementId = null, user = null } = {}) {
  const on = await S.setting('autoReject.on');
  if (!dryRun && !on) return { error: 'Auto-reject is OFF. An Admin turns it on in AI governance > Automations; use Dry run to preview.', status: 409 };
  const rules = (await autoRules()).filter((r) => r.active && (r.scope === 'global' || !requirementId || r.scope === requirementId));
  if (!rules.length) return { dryRun, rules: 0, rows: [], note: 'No active rules.' };
  const since = new Date(Date.now() - 30 * 864e5);
  const apps = await prisma.application.findMany({
    where: { stage: 'NEW', createdAt: { gte: since }, ...(requirementId ? { requirementId } : {}), requirement: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] } } },
    include: { candidate: { select: { id: true, name: true, experienceYears: true, noticePeriod: true, expectedSalary: true } }, requirement: { select: { id: true, title: true, clientId: true } } },
    take: 2000,
  });
  const J = require('./jobs'); // eslint-disable-line global-require
  const ctx = { answers: await J.answersFor(apps.map((a) => a.id)) };
  const rows = [];
  for (const a of apps) {
    const hit = rules.filter((r) => (r.scope === 'global' || r.scope === a.requirementId) && RULE_KINDS[r.kind].test(a, r.value, ctx));
    if (!hit.length) continue; // eslint-disable-line no-continue
    const why = hit.map((r) => RULE_KINDS[r.kind].why(a, r.value, ctx)).join('; ');
    rows.push({ applicationId: a.id, candidateId: a.candidateId, name: a.candidate.name, requirement: a.requirement.title, why });
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.application.update({ where: { id: a.id }, data: { stage: 'REJECTED' } });
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: a.candidateId, fromStage: 'NEW', toStage: 'REJECTED', action: 'Rejected by an automatic rule', comment: why.slice(0, 500), actorName: 'Auto-reject rule', actorRole: 'SYSTEM', actorSide: 'Internal', reasonCategory: 'Auto-reject rule', reasonDetail: why.slice(0, 500), requirementId: a.requirementId, requirementTitle: a.requirement.title } });
      // eslint-disable-next-line no-await-in-loop
      await require('./gov').addReview({ kind: 'Auto-reject', refType: 'Application', refId: a.id, applicationId: a.id, candidateId: a.candidateId, summary: `${a.candidate.name} (${a.requirement.title}): ${why}`, aiDecision: 'Rejected', undo: { type: 'stage', applicationId: a.id, fromStage: 'REJECTED', toStage: 'NEW' } }); // eslint-disable-line global-require
    }
  }
  if (!dryRun && rows.length) await require('../audit').logAudit({ userId: user ? user.id : null, action: `Auto-reject ran: ${rows.length} rejected`, entity: 'Requirement', entityId: requirementId || 'all', toValue: rows.slice(0, 5).map((r) => r.name).join(', ') }); // eslint-disable-line global-require
  return { dryRun, rules: rules.length, checked: apps.length, rows };
}

// ---- 04.12 placement approval -------------------------------------------------------------------------------------------------------
async function placements(user, { status = null } = {}) {
  const { applicationWhere } = require('../scope'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({
    where: { AND: [applicationWhere(user), { stage: { in: ['JOINED', 'HIRED'] } }, { OR: [{ joinedAt: { gte: new Date(Date.now() - 120 * 864e5) } }, { updatedAt: { gte: new Date(Date.now() - 120 * 864e5) } }] }] },
    select: { id: true, joinedAt: true, joiningDate: true, offeredCtc: true, candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, internal: true, client: { select: { name: true, guaranteePeriod: true, agreementFeePercent: true } } } } },
    orderBy: { updatedAt: 'desc' }, take: 300,
  });
  const rows = apps.length ? await S.q(`SELECT * FROM "MktPlacement" WHERE "applicationId" IN (${apps.map(() => '?').join(',')})`, ...apps.map((a) => a.id)) : [];
  const P = new Map(rows.map((r) => [r.applicationId, r]));
  const out = apps.filter((a) => !a.requirement.internal).map((a) => { const p = P.get(a.id); return { applicationId: a.id, candidateId: a.candidate.id, name: a.candidate.name, requirement: a.requirement.title, client: a.requirement.client && a.requirement.client.name, joined: a.joiningDate || a.joinedAt, ctc: a.offeredCtc, guarantee: a.requirement.client && a.requirement.client.guaranteePeriod, feePercent: a.requirement.client && a.requirement.client.agreementFeePercent, status: p ? p.status : 'Waiting', decidedByName: p ? p.decidedByName : null, decidedAt: p ? p.decidedAt : null, note: p ? p.note : null }; });
  return { on: await S.setting('placementApproval.on'), rows: status ? out.filter((r) => r.status === status) : out };
}
async function decidePlacement(applicationId, decision, note, user) {
  const { isBdeTl, atsViewRole } = require('../scope'); // eslint-disable-line global-require
  if (atsViewRole(user) !== 'admin' && !isBdeTl(user)) return { error: 'An Admin or a BDE TL approves placements.', status: 403 };
  const app = await appInScope(applicationId, user);
  if (!app || !['JOINED', 'HIRED'].includes(app.stage)) return { error: 'A joined placement in your scope is needed.', status: 404 };
  if (!['Approved', 'Rejected'].includes(decision)) return { error: 'Approve or reject.' };
  if (decision === 'Rejected' && !S.clean(note, 300)) return { error: 'Say why the placement is not approved.' };
  await S.x('INSERT INTO "MktPlacement" ("applicationId","status","requestedByName","requestedAt","decidedByName","decidedAt","note") VALUES (?,?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "status"=excluded."status","decidedByName"=excluded."decidedByName","decidedAt"=excluded."decidedAt","note"=excluded."note"',
    applicationId, decision, null, null, user.name, S.now(), S.clean(note, 300));
  await require('../audit').logAudit({ userId: user.id, action: `Placement ${decision.toLowerCase()}`, entity: 'Application', entityId: applicationId, toValue: `${app.candidate.name} · ${app.requirement.title}${note ? ` · ${note}` : ''}`.slice(0, 300) }); // eslint-disable-line global-require
  return { ok: true, status: decision };
}

// ---- 04.13 temp-to-perm ---------------------------------------------------------------------------------------------------------------
const CONTRACT = /contract|temp|temporary|c2h|contract to hire|fixed term/i;
async function contracts(user) {
  const { applicationWhere } = require('../scope'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({
    where: { AND: [applicationWhere(user), { stage: { in: ['JOINED', 'HIRED'] } }] },
    select: { id: true, joiningDate: true, joinedAt: true, offeredCtc: true, candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, jobPreference: true, employmentType: true, client: { select: { name: true } } } } },
    orderBy: { updatedAt: 'desc' }, take: 1000,
  });
  const list = apps.filter((a) => CONTRACT.test(`${a.requirement.jobPreference} ${a.requirement.employmentType}`));
  const rows = list.length ? await S.q(`SELECT * FROM "MktConversion" WHERE "applicationId" IN (${list.map(() => '?').join(',')})`, ...list.map((a) => a.id)) : [];
  const M = new Map(rows.map((r) => [r.applicationId, r]));
  const today = new Date().toISOString().slice(0, 10);
  return list.map((a) => { const m = M.get(a.id) || {}; return { applicationId: a.id, candidateId: a.candidate.id, name: a.candidate.name, requirement: a.requirement.title, client: a.requirement.client && a.requirement.client.name, type: a.requirement.jobPreference || a.requirement.employmentType, joined: a.joiningDate || a.joinedAt, ctc: a.offeredCtc, dueOn: m.dueOn || null, status: m.status || 'Contract', convertedOn: m.convertedOn || null, newCtc: m.newCtc == null ? null : Number(m.newCtc), fee: m.fee == null ? null : Number(m.fee), note: m.note || null, due: !!(m.dueOn && m.dueOn <= today && (m.status || 'Contract') === 'Contract') }; });
}
async function saveConversion(applicationId, body, user) {
  const app = await appInScope(applicationId, user);
  if (!app || !['JOINED', 'HIRED'].includes(app.stage)) return { error: 'A joined contract placement in your scope is needed.', status: 404 };
  const status = ['Contract', 'Converted', 'Ended'].includes(body.status) ? body.status : 'Contract';
  const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
  if (status === 'Converted' && !date(body.convertedOn)) return { error: 'Give the conversion date.' };
  const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  await S.x('INSERT INTO "MktConversion" ("applicationId","dueOn","convertedOn","newCtc","fee","status","note","byName","at") VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "dueOn"=excluded."dueOn","convertedOn"=excluded."convertedOn","newCtc"=excluded."newCtc","fee"=excluded."fee","status"=excluded."status","note"=excluded."note","byName"=excluded."byName","at"=excluded."at"',
    applicationId, date(body.dueOn), date(body.convertedOn), n(body.newCtc), n(body.fee), status, S.clean(body.note, 300), user.name, S.now());
  await require('../audit').logAudit({ userId: user.id, action: `Temp-to-perm: ${status}`, entity: 'Application', entityId: applicationId, toValue: `${app.candidate.name}${body.convertedOn ? ` converted ${body.convertedOn}` : ''}${n(body.fee) != null ? ` fee ${n(body.fee)}` : ''}` }); // eslint-disable-line global-require
  return { ok: true, status };
}

// ---- 04.14 backdoor hires into the review queue -----------------------------------------------------------------------------------------
async function backdoorScan() {
  const BH = require('../backdoorHire'); // eslint-disable-line global-require
  const rows = await BH.detect({ months: 12 });
  let added = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    added += S.num(await S.x('INSERT OR IGNORE INTO "MktFraudFlag" ("id","key","candidateId","otherCandidateId","kind","detail","createdAt") VALUES (?,?,?,?,?,?,?)', S.newId(), `Backdoor|${r.candidateId}|${r.clientId}`, r.candidateId, null, 'Possible backdoor hire', S.clean(`Shared with ${r.clientName} for ${r.requirementTitle} on ${new Date(r.sharedAt).toISOString().slice(0, 10)}, not joined through us (${r.lastStage}). ${r.detail}`, 400), S.now()));
  }
  return { found: rows.length, added };
}

// ---- 04.16 feedback blinding (called by utils/interviewPanel.js panelsFor) --------------------------------------------------------------
async function blindPanels(map) {
  try {
    if (!map || !map.size || !(await S.setting('feedbackBlind.on'))) return map;
    const ctx = require('./gov').context(); // eslint-disable-line global-require
    if (!ctx.userId) return map;
    map.forEach((members, appId) => {
      const me = (members || []).find((m) => m.userId && m.userId === ctx.userId);
      if (!me || me.feedback) return;
      map.set(appId, members.map((m) => (m === me || !m.feedback ? m : { ...m, feedback: null, blinded: true })));
    });
  } catch { /* never breaks the interview screens */ }
  return map;
}

module.exports = {
  draftPitch, pitchesOf, decidePitch, rulePitch, packet, RULE_KINDS, autoRules, saveAutoRule, deleteAutoRule, runAutoReject,
  placements, decidePlacement, contracts, saveConversion, backdoorScan, blindPanels, appInScope,
};

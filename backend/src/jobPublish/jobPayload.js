// ---------------------------------------------------------------------------
// THE JOB, AS A PORTAL GETS IT.
//
// build(requirementId, portal) turns a Requirement into ONE neutral payload every adapter fills a form from:
//   * the TEXT is what "Write the job posts" writes (utils/jobText.js: client name hidden, internal notes left out,
//     inclusive wording) or the poster's own saved version of it (utils/jobPostWriter.js);
//   * the COMPANY shown is TeamLink Consultants (the same rule as the Indeed feed and the by-hand text): a client is
//     never named on a public board;
//   * NEVER in it: candidate data, agreement wording, internal notes, the client's name (a last check refuses a post
//     that still names the client);
//   * the values a portal's form needs as a CODE or a fixed word (employment type, experience, salary, city, industry)
//     come from PortalMapping (src/jobPublish/mappings.js); an unmapped value goes as it is, with a warning.
// The payload hash decides "has the job changed since it was posted?".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { PUBLIC_COMPANY } = require('../utils/jobBoards/common');
const M = require('./mappings');

// What each portal's form insists on (a post without these would be rejected by the portal).
const REQUIRED = {
  naukri: ['title', 'description', 'location', 'experience', 'skills'],
  foundit: ['title', 'description', 'location', 'experience'],
  shine: ['title', 'description', 'location', 'experience'],
  linkedin: ['title', 'description'],
  career: ['title', 'description'],
  telegram: ['title'], // the message itself is built from the Posting Kit (jobDist/text.js)
  facebook: ['title'],
};
const FIELD_WORDS = { title: 'Job title', description: 'Job description', location: 'Job location', experience: 'Experience', skills: 'Key skills', salary: 'Salary' };

const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const csv = (v) => clean(v).split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
const BOARD_FOR = { naukri: 'naukri', shine: 'shine', foundit: 'shine', linkedin: 'linkedin', career: 'indeed', telegram: 'linkedin', facebook: 'linkedin' };

// Lines that talk about the agreement never go on a public post (agreement privacy).
const AGREEMENT_LINE = /agreement|\be-?sign/i;
function dropAgreementLines(text) {
  const lines = String(text || '').split('\n');
  const kept = lines.filter((l) => !AGREEMENT_LINE.test(l));
  return { text: kept.join('\n'), dropped: lines.length - kept.length };
}

const stable = (o) => JSON.stringify(o, Object.keys(o).sort());
const hashOf = (p) => crypto.createHash('sha256').update(stable({
  t: p.title, d: p.description, s: p.skills.join('|'), e: p.experience.text, l: p.location.text, et: p.employmentType.ats, wm: p.workMode.ats,
  sa: p.salary.text, o: p.openings, i: p.industry.ats, c: p.companyName,
})).digest('hex').slice(0, 32);

// -> { ok, payload, hash, missing: [{ key, label }], warnings: [], blocked: reason|null }
async function build(requirementId, portal, opts = {}) {
  const r = await prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } });
  if (!r) return { ok: false, blocked: 'This requirement no longer exists.', missing: [], warnings: [] };
  const jt = require('../utils/jobText'); // eslint-disable-line global-require
  const W = require('../utils/jobPostWriter'); // eslint-disable-line global-require
  const slug = require('../utils/jobSlug'); // eslint-disable-line global-require
  const warnings = [];
  const mapping = opts.mapping || await M.forPortal(portal);
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const gen = await jt.generate(r, {}, base);
  const board = BOARD_FOR[portal] || 'indeed';
  const b = gen.boards[board] || gen.boards.indeed;
  // the poster's own saved version wins (it is what they read and approved)
  const saved = await W.savedBoardText(r.id, board).catch(() => null);
  // the poster's saved MASTER text (jobposts.saved.<id>.texts.master) is used when no text was saved for this board
  const savedAll = saved && saved.text ? null : await W.loadSaved(r.id).catch(() => null);
  const savedMaster = savedAll && savedAll.texts && clean(savedAll.texts.master) ? savedAll.texts.master : '';
  let description = clean((saved && saved.text) || savedMaster || (b && b.text) || gen.master.text);
  let title = clean((saved && saved.title) || (b && b.title) || '');
  // The raw title can carry the client's name: use the written title; fall back to the raw one only when nothing was written.
  if (!title) title = clean(r.title);
  description = W.stripBlanks(description);
  const ag = dropAgreementLines(description);
  if (ag.dropped) { description = ag.text.trim(); warnings.push('Lines about the agreement were left out of the post.'); }
  const skills = csv((saved && saved.tags) || (portal === 'naukri' && b && b.tags ? b.tags.join(', ') : '') || r.skills);

  const exp = mapping.experience(clean(r.experience));
  const sal = mapping.salary(clean(r.salary));
  const loc = mapping.location(clean(r.location));
  const emp = mapping.employmentType(clean(r.employmentType) || 'Full Time');
  const mode = mapping.workMode(clean(r.workMode));
  const ind = mapping.industry(clean(r.department));
  const fa = mapping.functionalArea(clean(r.department));
  [['experience', exp, clean(r.experience)], ['salary', sal, clean(r.salary)], ['location', loc, clean(r.location)], ['employmentType', emp, clean(r.employmentType)],
    ['industry', ind, clean(r.department)]].forEach(([k, v, raw]) => { if (raw && !v.matched) warnings.push(`No ${portal} mapping for ${k} "${raw}": it is sent as typed.`); });

  const companyName = r.internal ? 'TeamLink Consultants' : PUBLIC_COMPANY;
  const payload = {
    requirementId: r.id,
    reqCode: r.reqCode || null,
    portal,
    internal: !!r.internal,
    title,
    companyName,
    description,
    skills,
    experience: { text: clean(r.experience), min: exp.min, max: exp.max, mapped: exp.value, code: exp.code },
    location: { text: clean(r.location), city: loc.city, mapped: loc.value, code: loc.code },
    employmentType: { ats: clean(r.employmentType) || 'Full Time', mapped: emp.value, code: emp.code },
    workMode: { ats: clean(r.workMode), mapped: mode.value, code: mode.code },
    salary: { text: /\d/.test(clean(r.salary)) ? clean(r.salary) : '', minLakhs: sal.minLakhs, maxLakhs: sal.maxLakhs, mapped: sal.value, code: sal.code },
    openings: r.openings || 1,
    industry: { ats: clean(r.department), mapped: ind.value },
    functionalArea: { ats: clean(r.department), mapped: fa.value },
    education: clean(r.education),
    contactEmail: (gen.facts && gen.facts.contactEmail) || '',
    closingDate: clean(r.closingDate),
    applyUrl: `${base}${slug.careersPath(r, { naukri: 'Naukri', shine: 'Shine', foundit: 'Foundit', linkedin: 'LinkedIn' }[portal] || '')}`,
    live: require('../utils/atsVocab').requirementIsLive(r.status),
    status: r.status,
  };

  const have = {
    title: !!payload.title, description: payload.description.length >= 30, location: !!payload.location.text, experience: !!payload.experience.text, skills: skills.length > 0, salary: !!payload.salary.text,
  };
  const missing = (REQUIRED[portal] || []).filter((k) => !have[k]).map((k) => ({ key: k, label: FIELD_WORDS[k] || k }));

  // LAST CHECK: a public post never names the client.
  const names = r.internal || !r.client ? [] : [r.client.name, r.client.legalName].map(clean).filter((n) => n.length >= 3);
  const textOnly = `${payload.title}\n${payload.description}`.replace(/https?:\/\/\S+/g, ' ').toLowerCase();
  const leaked = names.filter((n) => textOnly.includes(n.toLowerCase()));
  let blocked = null;
  if (leaked.length) blocked = 'The job text names the client. Take the client name out of the title and text (Write the job posts), then post again.';
  return { ok: !blocked, payload, hash: hashOf(payload), missing, warnings, blocked, requirement: r };
}

module.exports = { build, hashOf, REQUIRED, FIELD_WORDS };

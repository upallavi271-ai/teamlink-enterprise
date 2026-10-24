// Helpers shared by several tools (the loader skips files that start with "_").
const entities = require('../lib/entities');
const T = require('../lib/tooling');

const CLEAN = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// First name span = the person; the rest = words about the job / client.
function personAndExtra(input) {
  const spans = T.nameSpans(input);
  return { person: spans[0] || '', extra: spans.slice(1).join(' ') };
}

// Which application (candidate on a job) does the user mean?
//   -> { one } or { ret } (ret = a clarify / refuse the tool returns as is)
async function pickApplication(ctx, input, { question = 'Which candidate?', needOpen = false } = {}) {
  const chosen = input.choices && input.choices.application;
  if (chosen) {
    const a = await entities.applicationById(ctx.user, chosen);
    return a ? { one: a } : { ret: T.refuse('I cannot find that candidate in your list any more.') };
  }
  const { person, extra } = personAndExtra(input);
  if (!person) return { ret: T.clarify(question, { need: 'person' }) };
  const res = await entities.findApplications(ctx.user, person, { extra });
  if (!res.rows.length) {
    return { ret: T.refuse(`I cannot find a candidate called "${person}" among the people you work with. Check the spelling, or say the full name.`) };
  }
  let rows = res.rows;
  if (needOpen) {
    const open = rows.filter((r) => r.open);
    if (open.length) rows = open;
  }
  const dec = entities.decide({ rows, full: res.full });
  if (dec.one) return { one: dec.one };
  // The same person on one job only? then it is that one.
  if (rows.length > 1 && new Set(rows.map((r) => r.id)).size === 1) return { one: rows[0] };
  return {
    ret: T.which(
      rows.length === 1 ? `Do you mean ${rows[0].label}?` : `I found ${rows.length} matches for "${person}". Which one?`,
      rows,
      'application',
    ),
  };
}

// Which job (requirement)? words from the spans, a code like REQ-0012, or a picked choice.
async function pickRequirement(ctx, input, { text, question = 'Which requirement?' } = {}) {
  const chosen = input.choices && input.choices.requirement;
  if (chosen) {
    const r = await entities.requirementById(ctx.user, chosen);
    return r ? { one: r } : { ret: T.refuse('I cannot find that requirement in your list any more.') };
  }
  const code = (input.slots.codes || []).find((c) => /^REQ/i.test(c)) || null;
  const words = CLEAN(text !== undefined ? text : T.nameSpans(input).join(' '));
  if (!code && !words) return { ret: T.clarify(question, { need: 'requirement' }) };
  const res = await entities.findRequirements(ctx.user, words, { code });
  if (!res.rows.length) return { ret: T.refuse(`I cannot find a requirement matching "${code || words}" in your list.`) };
  const dec = entities.decide(res);
  if (dec.one) return { one: dec.one };
  return { ret: T.which(`I found ${res.rows.length} requirements that fit. Which one?`, res.rows, 'requirement') };
}

async function pickClient(ctx, input, { text, purpose = 'edit', question = 'Which client?' } = {}) {
  const chosen = input.choices && input.choices.client;
  if (chosen) {
    const c = await entities.clientById(ctx.user, chosen, { purpose });
    return c ? { one: c } : { ret: T.refuse('I cannot find that client in your list any more.') };
  }
  const words = CLEAN(text !== undefined ? text : T.nameSpans(input).join(' '));
  if (!words) return { ret: T.clarify(question, { need: 'client' }) };
  const res = await entities.findClients(ctx.user, words, { purpose });
  if (!res.rows.length) return { ret: T.refuse(`I cannot find a client called "${words}" in your list.`) };
  const dec = entities.decide(res);
  if (dec.one) return { one: dec.one };
  return { ret: T.which(`I found ${res.rows.length} clients that fit. Which one?`, res.rows, 'client') };
}

async function pickEmployee(ctx, input, { text, question = 'Which employee?' } = {}) {
  const chosen = input.choices && input.choices.employee;
  if (chosen) {
    const e = await entities.employeeById(ctx.user, chosen);
    return e ? { one: e } : { ret: T.refuse('I cannot find that employee in your list any more.') };
  }
  const words = CLEAN(text !== undefined ? text : T.nameSpans(input)[0] || '');
  if (!words) return { ret: T.clarify(question, { need: 'person' }) };
  const res = await entities.findEmployees(ctx.user, words);
  if (!res.rows.length) return { ret: T.refuse(`I cannot find an employee called "${words}" among the people you can see.`) };
  const dec = entities.decide(res);
  if (dec.one) return { one: dec.one };
  return { ret: T.which(`I found ${res.rows.length} people that fit. Which one?`, res.rows, 'employee') };
}

// Pull "label value" style fields out of free text: "phone 98..." etc.
function fieldAfter(text, label, stop = []) {
  const stops = ['and', 'with', 'phone', 'mobile', 'email', 'mail', 'location', 'city', 'industry', 'contact', 'skills', 'department', 'dept', 'designation', 'team', 'experience', 'company', ...stop].join('|');
  const re = new RegExp(`\\b${label}\\s*(?:is|=|:|to|as)?\\s+(.+?)(?=\\s+(?:${stops})\\b|[,;]|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? CLEAN(m[1]).replace(/[.]+$/, '') : '';
}

module.exports = {
  CLEAN, personAndExtra, pickApplication, pickRequirement, pickClient, pickEmployee, fieldAfter,
};

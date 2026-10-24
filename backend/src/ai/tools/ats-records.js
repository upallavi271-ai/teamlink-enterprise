// ATS record tools: clients, requirements (jobs), candidates, recruiter assignment,
// and messages to candidates. Every one replays the app's own route as the user:
//   POST/PUT /api/clients         POST/PUT/DELETE /api/requirements
//   POST/PUT /api/candidates      POST /api/requirements/:id/assign
//   POST /api/messaging/send      (preview first: GET-like POST /messaging/preview)
const { defineTool } = require('../registry');
const T = require('../lib/tooling');
const entities = require('../lib/entities');
const { problemOf } = require('../lib/http');
const { niceDate } = require('../lib/dates');
const permissions = require('../../utils/permissions');
const SALARY = require('../../utils/salaryFit'); // current + expected salary are required on every new candidate (2026-10-10)
const S = require('./_shared');
const F = require('./_fields');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const same = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();

// Read a record back through its own route; fall back to what the route answered.
async function readBack(ctx, path, fallback) {
  const r = await ctx.read.get(path);
  if (r.ok && r.data) return { data: r.data, via: 'route' };
  return { data: fallback || null, via: 'response' };
}

// ----------------------------------------------------------------------------
// assign_recruiter
// ----------------------------------------------------------------------------
defineTool({
  name: 'assign_recruiter',
  module: 'ats',
  label: 'Assign a recruiter to a requirement',
  description: 'Make one recruiter the recruiter on one requirement.',
  parameters: {
    recruiter: { type: 'person', required: true, description: 'The recruiter.' },
    job: { type: 'requirement', required: true, description: 'The requirement (title, code or client).' },
  },
  permission: { product: 'ats', module: 'requirements', feature: 'Requirement Detail', action: 'assign' },
  confirm: 'default',
  examples: ['Assign Priya to the Java Developer requirement', 'Give the Java Developer opening to Anil'],
  async validate(ctx, input) {
    const spans = T.nameSpans(input);
    let recruiter = null;
    let reqSpans = spans;
    if (input.choices && input.choices.recruiter) {
      recruiter = { id: input.choices.recruiter };
    } else {
      for (const span of spans) {
        // eslint-disable-next-line no-await-in-loop
        const res = await entities.findRecruiterUsers(span);
        if (res.rows.length && res.full) {
          const dec = entities.decide(res);
          if (dec.one) { recruiter = dec.one; reqSpans = spans.filter((s) => s !== span); break; }
          return T.which(`I found ${res.rows.length} recruiters called "${span}". Which one?`, res.rows, 'recruiter');
        }
      }
    }
    // The job
    const job = await S.pickRequirement(ctx, input, { text: reqSpans.join(' '), question: 'Which requirement is it for? Give its title, code or client.' });
    if (job.ret) return job.ret;
    const req = job.one;
    // The recruiter picker: the assign screen's own list, least busy first.
    const qs = `recruiters=1${req.department ? `&department=${encodeURIComponent(req.department)}` : ''}`;
    const bench = await ctx.read.get(`/requirements/assignable-people?${qs}`);
    if (!bench.ok) return T.refuse(problemOf(bench, 'You cannot see the list of recruiters you may assign.'));
    const people = ((bench.data && bench.data.groups) || []).flatMap((g) => g.people || []);
    if (!recruiter) {
      if (!people.length) return T.refuse('There are no recruiters in your list to assign.');
      const best = [...people].sort((a, b) => (a.load || 0) - (b.load || 0)).slice(0, 5);
      return T.clarify(`Who should be the recruiter on ${req.title}? Least busy first:`, {
        need: 'recruiter',
        options: best.map((p) => ({ label: `${p.name} - ${p.load || 0} on their plate${p.leastBusy ? ' (least busy)' : ''}`, choice: { recruiter: p.id, requirement: req.id } })),
      });
    }
    const person = people.find((p) => p.id === recruiter.id);
    if (!person) return T.refuse(`${recruiter.name || 'That person'} is not in the list of recruiters you can assign on ${req.title}.`);
    if (req.recruiterId === person.id) return T.refuse(`${person.name} is already the recruiter on ${req.title}. Nothing to change.`);
    return T.done({
      params: { requirementId: req.id, recruiterId: person.id, recruiterName: person.name, previousRecruiterId: req.recruiterId || null },
      summary: `Assign ${person.name} as the recruiter on ${req.title}${req.client ? ` (${req.client})` : ''}.`,
      display: T.card('Assign Recruiter', [
        ['Requirement', req.title], ['Code', req.reqCode], ['Client', req.client], ['Recruiter', person.name], ['Their workload', `${person.load || 0} (open requirements ${person.openJobs || 0}, people in process ${person.inProcess || 0})`],
        ['Replaces', req.recruiterId ? 'the current recruiter' : null],
      ]),
    });
  },
  async rules(ctx, p) {
    const req = await entities.requirementById(ctx.user, p.requirementId);
    if (!req) return { ok: false, message: 'I cannot find that requirement in your list any more. Nothing was changed.' };
    if ((req.recruiterId || null) !== (p.previousRecruiterId || null)) return { ok: false, message: 'Someone changed the recruiter on this requirement since I asked you. Nothing was changed - ask again.' };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post(`/requirements/${encodeURIComponent(p.requirementId)}/assign`, { recruiterId: p.recruiterId });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.recruiterName} is now the recruiter.`, data: r.data };
  },
  async verify(ctx, p) {
    const req = await entities.requirementById(ctx.user, p.requirementId);
    const ok = !!req && req.recruiterId === p.recruiterId;
    return { ok, message: ok ? `${req.title} now shows ${p.recruiterName} as the recruiter.` : 'The recruiter on the requirement is different from what was asked.', evidence: req ? { recruiterId: req.recruiterId } : null };
  },
  audit: (p) => `Assigned recruiter ${p.recruiterId} to requirement ${p.requirementId}`,
});

// ----------------------------------------------------------------------------
// create_client / update_client / delete_client
// ----------------------------------------------------------------------------
function clientFieldsFrom(input, spans) {
  const t = input.text;
  const out = {};
  const phone = (input.slots.phones || [])[0];
  const email = (input.slots.emails || [])[0];
  if (phone) out.contactPhone = phone;
  if (email) out.contactEmail = email;
  const person = F.grab(t, ['contact person', 'contact name', 'contact', 'poc', 'spoc'], { stops: F.DEFAULT_STOPS.filter((s) => s !== 'contact') });
  if (person && !/^\d/.test(person) && !person.includes('@')) out.contactName = person.replace(/\s+\d[\d\s]*$/, '').trim();
  const loc = F.grab(t, ['location', 'city', 'based in', 'located in']);
  if (loc) out.location = loc;
  const ind = F.grab(t, ['industry']);
  if (ind) out.industry = ind;
  // "... in Hyderabad" / "at Pune" when no explicit location word
  if (!out.location) {
    const sp = (spans || input.slots.spans || []).find((s) => ['in', 'at', 'from'].includes(s.prev) && !s.text.match(/\d/));
    if (sp) out.location = sp.text;
  }
  return out;
}

defineTool({
  name: 'create_client',
  module: 'ats',
  label: 'Add a new client',
  description: 'Add a client company, saved for later (company name, and optionally city, contact and industry).',
  parameters: {
    name: { type: 'text', required: true, description: 'The company name.' },
    location: { type: 'text', required: false, description: 'City.' },
    contactName: { type: 'text', required: false, description: 'Contact person.' },
    contactPhone: { type: 'phone', required: false, description: 'Contact mobile.' },
    contactEmail: { type: 'email', required: false, description: 'Contact email.' },
    industry: { type: 'text', required: false, description: 'Industry.' },
  },
  permission: { product: 'ats', module: 'clients', feature: 'Add Client', action: 'create' },
  confirm: 'default',
  examples: ['Create a client Sunrise Pharma', 'Add new client Acme Industries'],
  async validate(ctx, input) {
    const spans = input.slots.spans || [];
    const first = spans.find((s) => !['in', 'at', 'from'].includes(s.prev) && s.prev !== 'contact') || spans[0];
    const typed = (input.slots.answers && input.slots.answers.name) || '';
    const name = S.CLEAN(typed || F.afterKeyword(input.text, ['client', 'customer', 'company']) || (first && first.text) || '');
    if (!name || name.length < 2) return T.clarify('What is the company name?', { need: 'name' });
    if (name.length > 120) return T.refuse('That company name is too long. Please give the short company name.');
    const fields = clientFieldsFrom(input, spans.filter((s) => s !== first));
    if (fields.contactEmail && !EMAIL_RE.test(fields.contactEmail)) return T.refuse(`"${fields.contactEmail}" does not look like an email address.`);
    const exists = await entities.findClients(ctx.user, name);
    const exact = exists.rows.find((c) => same(c.name, name));
    if (exact) return T.refuse(`A client called "${exact.name}" is already there. Open that one instead of adding a new one.`);
    return T.done({
      params: { name, ...fields },
      summary: `Add the client "${name}" (saved for later)${fields.location ? ` in ${fields.location}` : ''}.`,
      display: T.card('Add Client', [
        ['Company', name], ['City', fields.location], ['Contact person', fields.contactName], ['Contact phone', fields.contactPhone], ['Contact email', fields.contactEmail], ['Industry', fields.industry],
      ], 'It is saved for later - the agreement and the rest of the details are filled in on the Clients screen.'),
    });
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/clients', { mode: 'draft', asDraft: true, ...p });
    if (!r.ok) {
      if (r.status === 409 && r.data && r.data.duplicates) {
        const names = r.data.duplicates.slice(0, 3).map((d) => d.name || d.clientName || d.label).filter(Boolean).join(', ');
        return { ok: false, message: `This looks like a client that already exists${names ? ` (${names})` : ''}. I did not add a duplicate.` };
      }
      return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    }
    return { ok: true, message: `Client "${p.name}" added (saved for later).`, data: { id: r.data.id, name: r.data.name }, open: r.data.id ? `/clients/${r.data.id}` : null };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    if (!id) return { ok: false, message: 'The app did not give the new client an id.' };
    const back = await readBack(ctx, `/clients/${encodeURIComponent(id)}`, null);
    const ok = !!back.data && same(back.data.name, p.name);
    return { ok, message: ok ? `"${p.name}" is on the client list.` : 'I could not find the new client when I looked.', evidence: { id, via: back.via } };
  },
  audit: (p) => `Created client "${p.name}" (saved for later)`,
});

const CLIENT_UPDATE_FIELDS = [
  { key: 'contactName', label: 'Contact person' },
  { key: 'contactPhone', label: 'Contact phone' },
  { key: 'contactEmail', label: 'Contact email' },
  { key: 'location', label: 'City' },
  { key: 'industry', label: 'Industry' },
];

defineTool({
  name: 'update_client',
  module: 'ats',
  label: 'Change a client\'s details',
  description: 'Change a client\'s contact person, phone, email, city or industry.',
  parameters: {
    client: { type: 'client', required: true, description: 'The client.' },
    changes: { type: 'fields', required: true, description: 'What to change: contact person, phone, email, city, industry.' },
  },
  permission: { product: 'ats', module: 'clients', feature: 'Client Detail', action: 'edit' },
  confirm: 'default',
  examples: ['Update client Acme contact phone to 9876543210', "Change Acme's contact person to Suresh"],
  async validate(ctx, input) {
    const spans = T.nameSpans(input);
    let client;
    if (input.choices && input.choices.client) {
      client = await entities.clientById(ctx.user, input.choices.client);
      if (!client) return T.refuse('I cannot find that client in your list any more.');
    } else {
      if (!spans.length) return T.clarify('Which client?', { need: 'client' });
      const hit = await F.locate(spans, (s) => entities.findClients(ctx.user, s));
      if (!hit) return T.refuse(`I cannot find a client called "${spans[0]}" in your list.`);
      const dec = entities.decide(hit.res);
      if (!dec.one) return T.which(`I found ${hit.res.rows.length} clients that fit "${hit.span}". Which one?`, hit.res.rows, 'client');
      client = dec.one;
    }
    const fields = clientFieldsFrom(input, spans.filter((s) => !same(s, client.name)).map((t) => ({ text: t, prev: '' })));
    const asked = {};
    CLIENT_UPDATE_FIELDS.forEach((f) => { if (fields[f.key]) asked[f.key] = fields[f.key]; });
    // location is only changed when the user said so explicitly
    if (asked.location && !/\b(location|city|based in|located in)\b/i.test(input.text)) delete asked.location;
    if (!Object.keys(asked).length) {
      return T.clarify(`What should I change on ${client.name}? (contact person, phone, email, city or industry - e.g. "phone 9876543210")`, { need: 'changes' });
    }
    if (asked.contactEmail && !EMAIL_RE.test(asked.contactEmail)) return T.refuse(`"${asked.contactEmail}" does not look like an email address.`);
    const changes = {};
    const rows = [['Client', client.name]];
    CLIENT_UPDATE_FIELDS.forEach((f) => {
      if (asked[f.key] === undefined) return;
      if (same(client[f.key], asked[f.key])) return;
      changes[f.key] = asked[f.key];
      rows.push([`${f.label} - now`, client[f.key] || '(empty)']);
      rows.push([`${f.label} - new`, asked[f.key]]);
    });
    if (!Object.keys(changes).length) return T.refuse(`${client.name} already has those details. Nothing to change.`);
    return T.done({
      params: { clientId: client.id, clientName: client.name, changes },
      summary: `Change ${client.name}: ${Object.entries(changes).map(([k, v]) => `${CLIENT_UPDATE_FIELDS.find((f) => f.key === k).label} to ${v}`).join(', ')}.`,
      display: T.card('Change Client', rows),
    });
  },
  async rules(ctx, p) {
    const c = await entities.clientById(ctx.user, p.clientId);
    return c ? { ok: true } : { ok: false, message: 'I cannot find that client in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.put(`/clients/${encodeURIComponent(p.clientId)}`, p.changes);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.clientName} updated.`, data: r.data };
  },
  async verify(ctx, p) {
    const back = await readBack(ctx, `/clients/${encodeURIComponent(p.clientId)}`, null);
    if (!back.data) return { ok: false, message: 'I could not read the client back.' };
    const bad = Object.entries(p.changes).filter(([k, v]) => !same(back.data[k], v)).map(([k]) => k);
    return { ok: !bad.length, message: bad.length ? `These did not save: ${bad.join(', ')}.` : 'The new details are on the client.', evidence: { checked: Object.keys(p.changes) } };
  },
  audit: (p) => `Updated client ${p.clientId}: ${Object.keys(p.changes).join(', ')}`,
});

defineTool({
  name: 'delete_client',
  module: 'ats',
  label: 'Delete a client',
  description: 'Delete a client record.',
  parameters: { client: { type: 'client', required: true, description: 'The client.' } },
  permission: { product: 'ats', module: 'clients', feature: 'Client Detail', action: 'delete' },
  confirm: 'always',
  impact: 'Deleting a client cannot be undone.',
  status: 'unavailable',
  unavailableReason: 'The app has no delete for clients yet (a client is paused or archived, never deleted), so I cannot do this. Nothing was changed.',
  examples: ['Delete client Acme', 'Remove the client Sunrise Pharma'],
  async validate() { return T.refuse('Not available yet.'); },
  audit: 'Delete client (not available)',
});

// ----------------------------------------------------------------------------
// create_requirement / update_requirement / delete_requirement
// ----------------------------------------------------------------------------
function openingsFrom(input) {
  const m = String(input.text || '').match(/\b(\d{1,3})\s*(?:openings?|vacanc(?:y|ies)|positions?|posts?|people|persons)\b/i)
    || String(input.text || '').match(/\bopenings?\s*(?:to|=|:|of)?\s*(\d{1,3})\b/i);
  return m ? Number(m[1]) : null;
}

defineTool({
  name: 'create_requirement',
  module: 'ats',
  label: 'Add a new requirement',
  description: 'Add a requirement for a client, not live yet: title, client, openings, city.',
  parameters: {
    title: { type: 'text', required: true, description: 'The requirement title.' },
    client: { type: 'client', required: true, description: 'The client it is for.' },
    openings: { type: 'number', required: false, description: 'How many people are needed.' },
    location: { type: 'text', required: false, description: 'City.' },
  },
  // 2026-10-13: creating a job is the BDE team's and above (utils/jobCreateRule.js). Admin adds it as a draft; a BDE / BDE TL /
  // Manager / Asst Manager send it as a request (a draft a lead opens); HR adds TeamLink's own jobs; nobody else.
  permission: (user, params) => {
    const JC = require('../../utils/jobCreateRule'); // eslint-disable-line global-require
    const kind = JC.kindOf(user);
    const out = JC.canCreateJob(user, { internal: params ? !!params.internal : kind === 'hr' });
    return out.allowed ? { ok: true } : { ok: false, message: `${JC.REFUSAL} Nothing was changed.` };
  },
  confirm: 'default',
  examples: ['Create a requirement for Java Developer at Acme', 'Raise a requirement QA Engineer for Orbit Tech 3 openings'],
  async validate(ctx, input) {
    const spansAll = input.slots.spans || [];
    const internalOnly = ctx.user.atsRole === 'HR';
    // "requirement for Java Developer at Acme": the words after job / requirement / vacancy are the title.
    const kwTitle = F.afterKeyword(input.text, ['requirement', 'job', 'opening', 'vacancy', 'position'], { lead: 'for|as' });
    const inTitle = (s) => !!kwTitle && kwTitle.toLowerCase().includes(String(s.text).toLowerCase());
    const spans = kwTitle ? spansAll.filter((s) => !inTitle(s)) : spansAll;
    // the client usually follows "at / for / of": try that text first
    const atM = String(input.text || '').match(/\b(?:at|for|of|with)\s+(.+?)(?=\s+\d+\s+(?:openings?|vacanc|positions?|posts?)|\s+in\s+[A-Z]|[,.;]|$)/i);
    const atText = atM && (!kwTitle || !kwTitle.toLowerCase().includes(atM[1].toLowerCase())) ? S.CLEAN(atM[1]) : '';
    let client = null;
    let clientSpan = null;
    if (input.choices && input.choices.client) {
      client = await entities.clientById(ctx.user, input.choices.client, { purpose: 'pick' });
      if (!client) return T.refuse('I cannot find that client in your list any more.');
    } else if (!internalOnly) {
      const answered = input.slots.answers && input.slots.answers.client;
      const tryList = answered ? [{ text: answered }] : [...(atText ? [{ text: atText }] : []), ...spans];
      for (const sp of tryList) {
        // eslint-disable-next-line no-await-in-loop
        const res = await entities.findClients(ctx.user, sp.text, { purpose: 'pick' });
        if (res.rows.length && res.full) {
          const dec = entities.decide(res);
          if (dec.one) { client = dec.one; clientSpan = sp; break; }
          return T.which(`I found ${res.rows.length} clients that fit "${sp.text}". Which one is the requirement for?`, res.rows, 'client');
        }
      }
    }
    const titleSpans = spans.filter((s) => s !== clientSpan && !['in', 'at'].includes(s.prev));
    const typedTitle = input.slots.answers && input.slots.answers.title;
    const title = S.CLEAN(typedTitle || kwTitle || titleSpans.map((s) => s.text).join(' '));
    if (!title) return T.clarify('What is the requirement title?', { need: 'title' });
    if (!client && !internalOnly) {
      return T.clarify(`Which client is the "${title}" requirement for? Give the client name.`, { need: 'client' });
    }
    const openings = openingsFrom(input) || 1;
    if (openings < 1 || openings > 999) return T.refuse('Openings must be a whole number from 1 to 999.');
    const loc = F.grab(input.text, ['location', 'city', 'based in']) || (spans.find((s) => s.prev === 'in' && s !== clientSpan) || {}).text || '';
    const params = {
      title, clientId: client ? client.id : null, clientName: client ? client.name : 'TeamLink (internal)', openings, location: loc || null, internal: internalOnly,
    };
    return T.done({
      params,
      summary: `Add the requirement "${title}" for ${params.clientName} (${openings} opening${openings > 1 ? 's' : ''}), not live yet.`,
      display: T.card('Add Requirement', [['Requirement', title], ['Client', params.clientName], ['Openings', openings], ['City', loc]],
        'It is saved but not live - nothing is posted anywhere. Finish the description on the Requirements screen when you are ready to publish.'),
    });
  },
  async execute(ctx, p, meta) {
    void meta;
    const body = {
      title: p.title, status: 'DRAFT', openings: p.openings, ...(p.location ? { location: p.location } : {}), ...(p.internal ? { internal: true } : { clientId: p.clientId }),
    };
    const r = await ctx.api.post('/requirements', body, { idempotencyKey: ctx.idempotencyKey });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Requirement "${p.title}" added (not live yet)${r.data.reqCode ? ` (${r.data.reqCode})` : ''}.`, data: { id: r.data.id, reqCode: r.data.reqCode, status: r.data.status }, open: r.data.id ? `/requirements/${r.data.id}` : null };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    if (!id) return { ok: false, message: 'The app did not give the new requirement an id.' };
    const back = await readBack(ctx, `/requirements/${encodeURIComponent(id)}`, null);
    const ok = !!back.data && same(back.data.title, p.title);
    return { ok, message: ok ? `"${p.title}" is on the requirements list.` : 'I could not find the new requirement when I looked.', evidence: { id, via: back.via } };
  },
  audit: (p) => `Created requirement "${p.title}" for ${p.clientName} (not live yet)`,
});

const REQ_FIELDS = [
  { key: 'openings', label: 'Openings', re: ['openings', 'opening count', 'vacancies', 'positions'], kind: 'int' },
  { key: 'location', label: 'City', re: ['location', 'city'], kind: 'text' },
  { key: 'priority', label: 'Priority', re: ['priority'], kind: 'priority' },
  { key: 'experience', label: 'Experience', re: ['experience'], kind: 'text' },
];

defineTool({
  name: 'update_requirement',
  module: 'ats',
  label: 'Change a requirement\'s details',
  description: 'Change a requirement\'s openings, city, priority, experience or closing date.',
  parameters: {
    job: { type: 'requirement', required: true, description: 'The requirement.' },
    changes: { type: 'fields', required: true, description: 'What to change.' },
  },
  permission: { product: 'ats', module: 'requirements', feature: 'Requirement Detail', action: 'edit' },
  confirm: 'default',
  examples: ['Update the Java Developer requirement openings to 5', 'Change location of the Sales Manager requirement to Pune'],
  async validate(ctx, input) {
    const text = input.text;
    // what to change
    const asked = {};
    const op = openingsFrom(input) || ((text.match(/\bopenings?\b[^0-9]{0,20}(\d{1,3})/i) || [])[1] ? Number(text.match(/\bopenings?\b[^0-9]{0,20}(\d{1,3})/i)[1]) : null);
    if (op) asked.openings = op;
    const loc = F.grab(text, ['location', 'city']);
    if (loc) asked.location = loc;
    const pr = (text.match(/\bpriority\b[^a-z]{0,10}(?:to|as|is)?\s*(low|medium|high|urgent)\b/i) || text.match(/\b(low|medium|high|urgent)\s+priority\b/i) || [])[1];
    if (pr) asked.priority = pr[0].toUpperCase() + pr.slice(1).toLowerCase();
    const exp = F.grab(text, ['experience']);
    if (exp) asked.experience = exp;
    const closing = (input.slots.dates || [])[0];
    if (closing && /\b(closing|close|last date|deadline|target)\b/i.test(text)) asked.closingDate = closing;
    // which job: remove the words that belong to the new values
    const spans = T.nameSpans(input).filter((s) => !same(s, asked.location || ''));
    const job = await S.pickRequirement(ctx, input, { text: spans.join(' '), question: 'Which requirement do you want to change? Give its title, code or client.' });
    if (job.ret) return job.ret;
    const req = job.one;
    if (!Object.keys(asked).length) return T.clarify(`What should I change on ${req.title}? (openings, city, priority, experience or closing date)`, { need: 'changes' });
    if (asked.closingDate && asked.closingDate < ctx.today) return T.refuse('The closing date is in the past. Pick today or a later day.');
    const changes = {};
    const rows = [['Requirement', req.title], ['Client', req.client]];
    const label = { openings: 'Openings', location: 'City', priority: 'Priority', experience: 'Experience', closingDate: 'Closing date' };
    const now = { openings: req.openings, location: req.location, priority: req.priority, closingDate: req.closingDate };
    Object.entries(asked).forEach(([k, v]) => {
      if (String(now[k] == null ? '' : now[k]).toLowerCase() === String(v).toLowerCase()) return;
      changes[k] = v;
      rows.push([`${label[k]} - now`, now[k] == null || now[k] === '' ? '(empty)' : (k === 'closingDate' ? niceDate(String(now[k]).slice(0, 10)) : now[k])]);
      rows.push([`${label[k]} - new`, k === 'closingDate' ? niceDate(v) : v]);
    });
    if (!Object.keys(changes).length) return T.refuse(`${req.title} already has those details. Nothing to change.`);
    return T.done({
      params: { requirementId: req.id, title: req.title, changes },
      summary: `Change ${req.title}: ${Object.entries(changes).map(([k, v]) => `${label[k]} to ${v}`).join(', ')}.`,
      display: T.card('Change Requirement', rows),
    });
  },
  async rules(ctx, p) {
    const req = await entities.requirementById(ctx.user, p.requirementId);
    return req ? { ok: true } : { ok: false, message: 'I cannot find that requirement in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.put(`/requirements/${encodeURIComponent(p.requirementId)}`, { ...p.changes, editReason: 'Changed by the AI Agent at the user\'s request' });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.title} updated.`, data: r.data };
  },
  async verify(ctx, p) {
    const back = await readBack(ctx, `/requirements/${encodeURIComponent(p.requirementId)}`, null);
    if (!back.data) return { ok: false, message: 'I could not read the requirement back.' };
    const bad = Object.entries(p.changes).filter(([k, v]) => String(back.data[k] == null ? '' : back.data[k]).slice(0, 10).toLowerCase() !== String(v).slice(0, 10).toLowerCase()).map(([k]) => k);
    return { ok: !bad.length, message: bad.length ? `These did not save: ${bad.join(', ')}.` : 'The new details are on the requirement.', evidence: { checked: Object.keys(p.changes) } };
  },
  audit: (p) => `Updated requirement ${p.requirementId}: ${Object.keys(p.changes).join(', ')}`,
});

defineTool({
  name: 'delete_requirement',
  module: 'ats',
  label: 'Delete a requirement',
  description: 'Delete a requirement. Only possible while nobody is attached to it.',
  parameters: { job: { type: 'requirement', required: true, description: 'The requirement.' } },
  permission: { product: 'ats', module: 'requirements', feature: 'Requirement Detail', action: 'delete' },
  confirm: 'always',
  impact: 'Deleting a requirement cannot be undone.',
  examples: ['Delete the Java Developer requirement', 'Remove requirement REQ-0012'],
  async validate(ctx, input) {
    const job = await S.pickRequirement(ctx, input, { question: 'Which requirement do you want to delete? Give its title, code or client.' });
    if (job.ret) return job.ret;
    const req = job.one;
    return T.done({
      params: { requirementId: req.id, title: req.title, reqCode: req.reqCode },
      summary: `Delete the requirement ${req.title}${req.client ? ` (${req.client})` : ''}.`,
      display: T.card('Delete Requirement', [['Requirement', req.title], ['Code', req.reqCode], ['Client', req.client], ['Status', req.status]], 'This cannot be undone.'),
    });
  },
  async rules(ctx, p) {
    const req = await entities.requirementById(ctx.user, p.requirementId);
    return req ? { ok: true } : { ok: false, message: 'That requirement is already gone, or is not in your list. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.delete(`/requirements/${encodeURIComponent(p.requirementId)}`);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Requirement "${p.title}" deleted.`, data: r.data };
  },
  async verify(ctx, p) {
    const r = await ctx.read.get(`/requirements/${encodeURIComponent(p.requirementId)}`);
    const gone = r.status === 404 || r.status === 403 || (r.ok && r.data && r.data.deleted);
    return { ok: gone, message: gone ? 'The requirement is no longer on the list.' : 'The requirement is still there.', evidence: { status: r.status } };
  },
  audit: (p) => `Deleted requirement ${p.reqCode || p.requirementId} "${p.title}"`,
});

// ----------------------------------------------------------------------------
// create_candidate / update_candidate
// ----------------------------------------------------------------------------
defineTool({
  name: 'create_candidate',
  module: 'ats',
  label: 'Add a new candidate',
  description: 'Add a candidate: name, mobile, email, at least one skill, and current + expected salary.',
  parameters: {
    name: { type: 'text', required: true, description: 'Full name.' },
    phone: { type: 'phone', required: true, description: 'Mobile number.' },
    email: { type: 'email', required: true, description: 'Email.' },
    skills: { type: 'text', required: true, description: 'At least one skill.' },
    currentSalary: { type: 'text', required: true, description: 'Current salary, like 4.5 LPA or 45000 per month (0 if a fresher).' },
    expectedSalary: { type: 'text', required: true, description: 'Expected salary, like 6 LPA or 50000 per month.' },
    location: { type: 'text', required: false, description: 'City.' },
    currentCompany: { type: 'text', required: false, description: 'Current company.' },
  },
  permission: { product: 'ats', module: 'candidates', feature: 'Add Candidate', action: 'create' },
  confirm: 'default',
  examples: ['Add candidate Rahul Sharma phone 9876543210 email rahul@example.com'],
  async validate(ctx, input) {
    const spans = input.slots.spans || [];
    const answers = input.slots.answers || {};
    const nameSpan = spans.find((s) => !['in', 'at', 'from'].includes(s.prev)) || spans[0];
    const name = S.CLEAN(answers.name || F.afterKeyword(input.text, ['candidate', 'applicant']) || (nameSpan && nameSpan.text) || '');
    if (!name) return T.clarify('What is the candidate\'s full name?', { need: 'name' });
    const phone = (input.slots.phones || [])[0] || ((answers.phone || '').replace(/\D/g, '').slice(-10).length === 10 ? answers.phone.replace(/\D/g, '').slice(-10) : '');
    const email = (input.slots.emails || [])[0] || '';
    let skills = F.grab(input.text, ['skills', 'skill', 'knows', 'with experience in'], { stops: F.DEFAULT_STOPS.filter((s) => s !== 'with') }) || (answers.skills || '');
    if (!phone) return T.clarify(`What is ${name}'s mobile number (10 digits)?`, { need: 'phone' });
    if (!email) return T.clarify(`What is ${name}'s email address?`, { need: 'email' });
    if (!EMAIL_RE.test(email)) return T.refuse(`"${email}" does not look like an email address.`);
    skills = S.CLEAN(skills).replace(/\band\b/gi, ',').replace(/\s*,\s*/g, ', ').replace(/^,\s*|,\s*$/g, '');
    if (!skills) return T.clarify(`Tell me at least one skill of ${name} (for example "Java, SQL").`, { need: 'skills' });
    // SALARY (the app asks for both on every new candidate): read it from the sentence, else ask - never guess a number.
    const salaryOf = (words, answer) => {
      const m = String(input.text || '').match(new RegExp(`\\b(?:${words})\\b\\s*(?:is|=|:|-)?\\s*([^,;]+?)(?=\\s+(?:expected|expecting|current|email|phone|mobile|skills?|location|city|company)\\b|[,;]|$)`, 'i'));
      return S.CLEAN((m && m[1]) || answer || '');
    };
    const currentSalary = salaryOf('current\\s+(?:salary|ctc)', answers.currentSalary);
    if (!currentSalary) return T.clarify(`What is ${name}'s current salary (for example 4.5 LPA or 45000 per month; 0 if a fresher)?`, { need: 'currentSalary' });
    const expectedSalary = salaryOf('expected\\s+(?:salary|ctc)', answers.expectedSalary);
    if (!expectedSalary) return T.clarify(`What salary does ${name} expect (for example 6 LPA or 50000 per month)?`, { need: 'expectedSalary' });
    const sal = SALARY.validateSalaries({ currentSalary, expectedSalary });
    if (!sal.ok) return T.clarify(sal.errors.currentSalary || sal.errors.expectedSalary, { need: sal.errors.currentSalary ? 'currentSalary' : 'expectedSalary' });
    const location = F.grab(input.text, ['location', 'city']) || (spans.find((s) => s.prev === 'in' && s !== nameSpan) || {}).text || '';
    const company = F.grab(input.text, ['current company', 'company', 'works at']);
    return T.done({
      params: { name, phone, email, skills, currentSalary, expectedSalary, ...(location ? { location } : {}), ...(company ? { currentCompany: company } : {}) },
      summary: `Add the candidate ${name} (${phone}, ${email}).`,
      display: T.card('Add Candidate', [['Name', name], ['Mobile', phone], ['Email', email], ['Skills', skills], ['Current salary', sal.values.currentSalary], ['Expected salary', sal.values.expectedSalary], ['City', location], ['Company', company]]),
    });
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/candidates', { ...p, source: 'AI Agent' });
    if (!r.ok) {
      if (r.status === 409) return { ok: false, message: `${problemOf(r, 'This candidate may already be on file.')} I did not add a second copy.` };
      return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    }
    return { ok: true, message: `Candidate ${p.name} added.`, data: { id: r.data.id, name: r.data.name, phone: r.data.phone, email: r.data.email }, open: r.data.id ? `/candidates/${r.data.id}` : null };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    if (!id) return { ok: false, message: 'The app did not give the new candidate an id.' };
    const back = await readBack(ctx, `/candidates/${encodeURIComponent(id)}`, result.data);
    const d = back.data && (back.data.candidate || back.data);
    const ok = !!d && same(d.name, p.name) && same(d.email, p.email);
    return { ok, message: ok ? `${p.name} is on the candidate list.` : 'I could not find the new candidate when I looked.', evidence: { id, via: back.via } };
  },
  audit: (p) => `Created candidate "${p.name}"`,
});

const CAND_FIELDS = [
  { key: 'phone', label: 'Mobile' }, { key: 'email', label: 'Email' }, { key: 'location', label: 'City' }, { key: 'currentCompany', label: 'Company' },
  { key: 'skills', label: 'Skills' }, { key: 'noticePeriod', label: 'Notice period' }, { key: 'currentDesignation', label: 'Designation' },
];

defineTool({
  name: 'update_candidate',
  module: 'ats',
  label: 'Change a candidate\'s details',
  description: 'Change a candidate\'s mobile, email, city, company, skills, notice period or designation.',
  parameters: {
    candidate: { type: 'person', required: true, description: 'The candidate.' },
    changes: { type: 'fields', required: true, description: 'What to change.' },
  },
  permission: { product: 'ats', module: 'candidates', feature: 'Candidate Master', action: 'edit' },
  confirm: 'default',
  examples: ['Update candidate Rahul phone to 9876543210', "Change candidate Priya's email to priya@mail.com"],
  async validate(ctx, input) {
    const text = input.text;
    const asked = {};
    if ((input.slots.phones || [])[0]) asked.phone = input.slots.phones[0];
    if ((input.slots.emails || [])[0]) asked.email = input.slots.emails[0];
    const loc = F.grab(text, ['location', 'city']);
    if (loc) asked.location = loc;
    const comp = F.grab(text, ['current company', 'company']);
    if (comp) asked.currentCompany = comp;
    const sk = F.grab(text, ['skills', 'skill'], { stops: F.DEFAULT_STOPS.filter((s) => s !== 'with') });
    if (sk) asked.skills = S.CLEAN(sk).replace(/\band\b/gi, ',').replace(/\s*,\s*/g, ', ');
    const np = F.grab(text, ['notice period', 'notice']);
    if (np) asked.noticePeriod = /^\d+$/.test(np) ? `${np} Days` : np;
    const des = F.grab(text, ['designation', 'current designation']);
    if (des) asked.currentDesignation = des;
    if (asked.email && !EMAIL_RE.test(asked.email)) return T.refuse(`"${asked.email}" does not look like an email address.`);
    const spans = T.nameSpans(input).filter((s) => ![asked.location, asked.currentCompany, asked.currentDesignation, asked.noticePeriod].some((v) => v && same(v, s)));
    let cand;
    if (input.choices && input.choices.candidate) {
      cand = await entities.candidateById(ctx.user, input.choices.candidate);
      if (!cand) return T.refuse('I cannot find that candidate in your list any more.');
    } else {
      if (!spans.length) return T.clarify('Which candidate?', { need: 'person' });
      const hit = await F.locate(spans, (s) => entities.findCandidates(ctx.user, s));
      if (!hit) return T.refuse(`I cannot find a candidate called "${spans[0]}" among the people you work with.`);
      const dec = entities.decide(hit.res);
      if (!dec.one) return T.which(`I found ${hit.res.rows.length} candidates that fit "${hit.span}". Which one?`, hit.res.rows, 'candidate');
      cand = dec.one;
    }
    if (!Object.keys(asked).length) return T.clarify(`What should I change on ${cand.name}? (mobile, email, city, company, skills, notice period or designation)`, { need: 'changes' });
    const changes = {};
    const rows = [['Candidate', cand.name]];
    CAND_FIELDS.forEach((f) => {
      if (asked[f.key] === undefined || same(cand[f.key], asked[f.key])) return;
      changes[f.key] = asked[f.key];
      rows.push([`${f.label} - now`, cand[f.key] === undefined ? '(hidden for your role)' : (cand[f.key] || '(empty)')]);
      rows.push([`${f.label} - new`, asked[f.key]]);
    });
    if (!Object.keys(changes).length) return T.refuse(`${cand.name} already has those details. Nothing to change.`);
    return T.done({
      params: { candidateId: cand.id, name: cand.name, changes },
      summary: `Change ${cand.name}: ${Object.entries(changes).map(([k, v]) => `${CAND_FIELDS.find((f) => f.key === k).label} to ${v}`).join(', ')}.`,
      display: T.card('Change Candidate', rows),
    });
  },
  async rules(ctx, p) {
    const c = await entities.candidateById(ctx.user, p.candidateId);
    return c ? { ok: true } : { ok: false, message: 'I cannot find that candidate in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.put(`/candidates/${encodeURIComponent(p.candidateId)}`, p.changes);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.name} updated.`, data: r.data };
  },
  async verify(ctx, p) {
    const c = await entities.candidateById(ctx.user, p.candidateId);
    if (!c) return { ok: false, message: 'I could not read the candidate back.' };
    // A field this login may not read (e-mail / phone without the Contact switch) comes back absent: not a failure.
    const bad = Object.entries(p.changes).filter(([k, v]) => c[k] !== undefined && !same(c[k], v)).map(([k]) => k);
    return { ok: !bad.length, message: bad.length ? `These did not save: ${bad.join(', ')}.` : 'The new details are on the candidate.', evidence: { checked: Object.keys(p.changes) } };
  },
  audit: (p) => `Updated candidate ${p.candidateId}: ${Object.keys(p.changes).join(', ')}`,
});

// ----------------------------------------------------------------------------
// send_candidate_communication - uses the message templates + channel readiness
// ----------------------------------------------------------------------------
const CHANNELS = ['Email', 'WhatsApp', 'SMS'];
const PURPOSE_HINTS = [
  [/interview/, ['INTERVIEW']],
  [/document|docs|certificate/, ['DOCUMENT']],
  [/offer/, ['OFFER']],
  [/join/, ['JOINING', 'JOIN']],
  [/job|opening|vacan|position|role/, ['JOB', 'OPPORTUNITY', 'SHARE']],
  [/availab|confirm|interest/, ['AVAILAB', 'CONFIRM', 'INTEREST']],
  [/reject|regret|not selected/, ['REJECT', 'REGRET']],
];

async function pickTemplatePurpose(ctx, channel, text, choicePurpose) {
  const r = await ctx.read.get(`/messaging/templates/usable?channel=${encodeURIComponent(channel)}&audience=candidates`);
  if (!r.ok) return { error: problemOf(r, 'The message templates cannot be read for your login.') };
  const list = (r.data && r.data.templates) || [];
  if (!list.length) return { error: 'There are no message templates set up for candidates yet (Administration -> Message templates).' };
  const byPurpose = new Map();
  list.forEach((t) => { if (!byPurpose.has(t.purpose)) byPurpose.set(t.purpose, t); });
  if (choicePurpose && byPurpose.has(choicePurpose)) return { purpose: choicePurpose, template: byPurpose.get(choicePurpose) };
  const low = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [purpose, t] of byPurpose) {
    const hay = `${purpose} ${t.purposeLabel} ${t.name}`.toLowerCase();
    let score = 0;
    PURPOSE_HINTS.forEach(([re, keys]) => { if (re.test(low) && keys.some((k) => hay.includes(k.toLowerCase()))) score += 2; });
    // direct word overlap with the purpose label
    String(t.purposeLabel || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).forEach((w) => { if (low.includes(w)) score += 1; });
    if (score > bestScore) { bestScore = score; best = purpose; }
  }
  if (best) return { purpose: best, template: byPurpose.get(best) };
  return { ask: [...byPurpose.values()].slice(0, 6) };
}

defineTool({
  name: 'send_candidate_communication',
  module: 'ats',
  label: 'Send a message to a candidate',
  description: 'Send a candidate an email, WhatsApp or SMS using one of the approved message templates.',
  parameters: {
    candidate: { type: 'person', required: true, description: 'The candidate.' },
    channel: { type: 'enum', required: true, description: 'Email, WhatsApp or SMS.' },
    purpose: { type: 'template', required: false, description: 'What the message is about (interview, documents, offer ...).' },
  },
  permission: { product: 'ats', module: 'candidates', feature: 'Candidate Master', action: 'edit' },
  confirm: 'always',
  impact: 'A message goes OUT to the candidate, so it always needs your Confirm.',
  examples: ['Send Rahul a WhatsApp about the interview', 'Email Priya the interview details'],
  async validate(ctx, input) {
    const picked = await S.pickApplication(ctx, input, { question: 'Which candidate should I message?', needOpen: true });
    let app = picked.one || null;
    let cand = null;
    if (!app) {
      // a candidate with no job yet can still be messaged
      const { person } = S.personAndExtra(input);
      if (input.choices && input.choices.candidate) cand = await entities.candidateById(ctx.user, input.choices.candidate);
      else if (person) {
        const res = await entities.findCandidates(ctx.user, person);
        const dec = entities.decide(res);
        if (dec.one) cand = dec.one;
        else if (dec.many) return T.which(`I found ${res.rows.length} candidates that fit "${person}". Which one?`, res.rows, 'candidate');
      }
      if (!cand) return picked.ret;
    }
    const candidateId = app ? app.candidateId : cand.id;
    const candidateName = app ? app.candidate : cand.name;
    const channel = (input.choices && input.choices.channel) || (input.slots.channels || [])[0] || null;
    if (!channel || !CHANNELS.includes(channel)) {
      return T.clarify(`How should I contact ${candidateName}?`, { need: 'channel', options: CHANNELS.map((c) => ({ label: c, choice: { channel: c, ...(app ? { application: app.id } : { candidate: candidateId }) } })) });
    }
    const tp = await pickTemplatePurpose(ctx, channel, input.text, input.choices && input.choices.purpose);
    if (tp.error) return T.refuse(tp.error);
    if (tp.ask) {
      return T.clarify(`Which message should I send ${candidateName}?`, {
        need: 'purpose',
        options: tp.ask.map((t) => ({ label: t.purposeLabel, choice: { purpose: t.purpose, channel, ...(app ? { application: app.id } : { candidate: candidateId }) } })),
      });
    }
    // Look before you send: the app's own preview (who gets what, and whether the channel is ready).
    const pv = await ctx.read.probe('/messaging/preview', {
      audience: 'candidates', ids: [candidateId], channels: [channel], purposeKey: tp.purpose, language: 'English', kind: 'individual', applicationId: app ? app.id : undefined, requirementId: app ? app.requirementId : undefined,
    });
    if (!pv.ok) return T.refuse(problemOf(pv, 'I could not prepare that message.'));
    const first = pv.data.first;
    if (!first) return T.refuse('I could not prepare that message.');
    if (first.status !== 'queued') {
      return T.refuse(`I cannot send this ${channel} to ${candidateName}: ${String(first.reason || 'it would be blocked').replace(/[.\s]+$/, '')}. Nothing was sent.`);
    }
    return T.done({
      params: { candidateId, applicationId: app ? app.id : null, requirementId: app ? app.requirementId : null, channel, purposeKey: tp.purpose, language: 'English', candidateName, to: first.address },
      summary: `Send ${candidateName} a ${channel} message (${tp.template.purposeLabel}).`,
      display: T.card('Message Candidate', [
        ['To', `${candidateName} (${first.address})`], ['Channel', channel], ['Message type', tp.template.purposeLabel],
        ['Subject', first.subject], ['Message', first.text],
      ], `${channel} is ready to send. The wording comes from your approved templates.`),
    });
  },
  async rules(ctx, p) {
    const pv = await ctx.read.probe('/messaging/preview', {
      audience: 'candidates', ids: [p.candidateId], channels: [p.channel], purposeKey: p.purposeKey, language: p.language, kind: 'individual', applicationId: p.applicationId || undefined, requirementId: p.requirementId || undefined,
    });
    const first = pv.ok && pv.data && pv.data.first;
    if (!first || first.status !== 'queued') return { ok: false, message: `This ${p.channel} can no longer be sent${first && first.reason ? `: ${String(first.reason).replace(/[.\s]+$/, '')}` : ''}. Nothing was sent.` };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/messaging/send', {
      audience: 'candidates', id: p.candidateId, channel: p.channel, purposeKey: p.purposeKey, language: p.language, applicationId: p.applicationId || undefined, requirementId: p.requirementId || undefined,
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not send it.') };
    const res = r.data.result;
    if (!res) return { ok: false, message: 'The app is still working on it. Check the candidate\'s history in a minute.', data: { jobId: r.data.jobId } };
    if (res.status !== 'sent') return { ok: false, message: `The ${p.channel} was ${res.status}${res.reason ? `: ${res.reason}` : ''}.`, data: { jobId: r.data.jobId } };
    return { ok: true, message: `${p.channel} sent to ${p.candidateName}${res.sandbox ? ' (test server: nothing really went out)' : ''}.`, data: { jobId: r.data.jobId, status: res.status } };
  },
  async verify(ctx, p, result) {
    const jobId = result.data && result.data.jobId;
    if (!jobId) return { ok: false, message: 'No send record to check.' };
    const r = await ctx.read.get(`/messaging/bulk/${encodeURIComponent(jobId)}`);
    const row = r.ok && r.data && Array.isArray(r.data.recipients) ? r.data.recipients[0] : null;
    const ok = !!row && row.status === 'sent';
    return { ok, message: ok ? 'The send record says: sent.' : 'The send record does not say sent.', evidence: { jobId, status: row ? row.status : null } };
  },
  audit: (p) => `Sent a ${p.channel} (${p.purposeKey}) to candidate ${p.candidateId}`,
});

void permissions;

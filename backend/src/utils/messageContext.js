// ---------------------------------------------------------------------------
// MESSAGE CONTEXT — who a message is for and what real values fill its
// {{tokens}}. One function per kind of person, all held to the CALLER'S scope
// (the ids a browser sends are only a request).
//
//   recipientsFor(user, audience, ids, { applicationId, requirementId })
//     -> [{ id, name, email, mobile, whatsapp, doNotContact, tokens }]
//
//   candidates   name + the job / client / interview of their application
//                (the one asked for, else the most recent one the caller may see)
//   clients      the client's contact person (name, email, phone, WhatsApp)
//   employees    name, email, phone
//
// senderTokens(user) fills {{recruiterName}} {{recruiterPhone}} {{recruiterEmail}}
// from the SENDER'S own employee record — never a company default.
// ---------------------------------------------------------------------------

const prisma = require('../db');

const COMPANY = 'TeamLink Consultants';
const IST = 'Asia/Kolkata';
const fmt = (d, opts) => new Date(d).toLocaleString('en-IN', { timeZone: IST, ...opts });
const dateOnly = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
const timeOnly = (d) => fmt(d, { hour: 'numeric', minute: '2-digit', hour12: true });

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v >= 1000 ? `Rs ${v.toLocaleString('en-IN')}` : `${v} LPA`;
}

async function senderTokens(user) {
  let emp = null;
  try { emp = user ? await prisma.employee.findUnique({ where: { userId: user.id } }) : null; } catch { emp = null; }
  return {
    recruiterName: (emp && emp.name) || (user && user.name) || null,
    recruiterPhone: (emp && emp.phone) || null,
    recruiterEmail: (emp && emp.email) || (user && user.email) || null,
    company: COMPANY,
    today: dateOnly(new Date()),
  };
}

function jobLinkOf(req) {
  try {
    // eslint-disable-next-line global-require
    const { publicUrl } = require('./jobBoards/http');
    // eslint-disable-next-line global-require
    const { careersPath } = require('./jobSlug');
    return publicUrl(careersPath(req)) || null;
  } catch { return null; }
}

function appTokens(app) {
  if (!app) return {};
  const r = app.requirement || {};
  const out = {
    role: r.title || null,
    client: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
    jobLink: r.id ? jobLinkOf(r) : null,
    mode: app.interviewMode || null,
    interviewer: app.interviewer || null,
    meetingLink: app.interviewMeetingLink || null,
    venue: app.interviewLocation || null,
    deadline: app.aiInterviewDeadline || null,
    offerCtc: money(app.offeredCtc),
    joiningDate: app.joiningDate || null,
  };
  if (app.interviewAt) {
    out.interviewAt = `${dateOnly(app.interviewAt)}, ${timeOnly(app.interviewAt)}`;
    out.interviewDate = dateOnly(app.interviewAt);
    out.interviewTime = timeOnly(app.interviewAt);
  }
  // INTERVIEW WORDS (booking window + reminders, 2026-10-10): the round, ONE "where" line
  // (join link, or the address) and who the candidate can ask. All plain text, no client name.
  if (app.interviewStatus || app.interviewAt) {
    out.interviewRound = String(app.interviewRound || 1);
    const m = String(app.interviewMode || '').toLowerCase();
    if (m.includes('person')) out.interviewWhere = `In person${app.interviewLocation ? ` at ${app.interviewLocation}` : ''}`;
    else if (m.includes('tele') || m.includes('phone')) out.interviewWhere = 'By phone call';
    else out.interviewWhere = app.interviewMeetingLink ? `Online - join here: ${app.interviewMeetingLink}` : 'Online (we will send the link before the interview)';
  }
  return out;
}

// Who the candidate can ask about the interview: the job's recruiter (name + phone), never the BDE.
// -> "Priya, 98xxxxxx10" or "your TeamLink recruiter".
async function recruiterLineFor(app) {
  try {
    const r = (app && app.requirement) || {};
    const ids = [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim())].filter(Boolean);
    if (!ids.length) return 'your TeamLink recruiter';
    const u = await prisma.user.findUnique({ where: { id: ids[0] }, select: { name: true, employee: { select: { name: true, phone: true } } } });
    if (!u) return 'your TeamLink recruiter';
    const name = (u.employee && u.employee.name) || u.name;
    const phone = u.employee && u.employee.phone ? String(u.employee.phone).trim() : '';
    return phone ? `${name}, ${phone}` : name;
  } catch { return 'your TeamLink recruiter'; }
}

// The slot a RESCHEDULED interview moved away from ("was Sat, 17 Oct, 11:45 am").
async function oldSlotOf(app) {
  try {
    if (!app || app.interviewStatus !== 'RESCHEDULED') return null;
    const ev = await prisma.interviewEvent.findFirst({ where: { applicationId: app.id, status: 'RESCHEDULED', fromSlot: { not: null } }, orderBy: { createdAt: 'desc' }, select: { fromSlot: true } });
    const d = ev && ev.fromSlot ? new Date(ev.fromSlot) : null;
    return d && !Number.isNaN(d.getTime()) ? `${dateOnly(d)}, ${timeOnly(d)}` : null;
  } catch { return null; }
}

const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || null;

async function recipientsFor(user, audience, ids, { applicationId, requirementId, contactKind } = {}) {
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const s = scope.atsScopeOf(user);
  if (audience === 'candidates') {
    const where = s.global ? { id: { in: ids } } : { AND: [{ id: { in: ids } }, { applications: { some: scope.applicationWhere(user) } }] };
    // eslint-disable-next-line global-require
    const dnc = require('./candidateRecord').supported();
    const rows = await prisma.candidate.findMany({ where, select: { id: true, name: true, email: true, phone: true, ...(dnc ? { doNotContact: true, consentStatus: true } : {}) } });
    const appWhere = {
      AND: [
        { candidateId: { in: rows.map((c) => c.id) } },
        ...(s.global ? [] : [scope.applicationWhere(user)]),
        ...(applicationId ? [{ id: applicationId }] : []),
        ...(requirementId ? [{ requirementId }] : []),
      ],
    };
    const apps = rows.length ? await prisma.application.findMany({ where: appWhere, include: { requirement: { include: { client: true } } }, orderBy: { updatedAt: 'desc' } }) : [];
    const byCand = new Map();
    apps.forEach((a) => { if (!byCand.has(a.candidateId)) byCand.set(a.candidateId, a); });
    // CANDIDATES NEVER SEE THE CLIENT'S NAME (the standing rule; automatic stage messages already say
    // "our client"): a message to a candidate says "our client", or TeamLink for an internal job.
    // Staff-facing messages (clients / employees) are not touched.
    const contactOf = new Map();
    for (const a of byCand.values()) {
      // eslint-disable-next-line no-await-in-loop
      contactOf.set(a.id, { line: await recruiterLineFor(a), old: await oldSlotOf(a), prep: await require('./interviewPrep').prepNote(a).catch(() => null) }); // eslint-disable-line global-require
    }
    return rows.map((c) => {
      const app = byCand.get(c.id);
      const extra = app ? contactOf.get(app.id) || {} : {};
      const t = app ? appTokens(app) : {};
      if (app) t.client = app.requirement && app.requirement.internal ? 'TeamLink Internal' : 'our client';
      return {
        id: c.id, name: c.name, email: c.email, mobile: c.phone, whatsapp: c.phone,
        doNotContact: !!(c.doNotContact || c.consentStatus === 'WITHDRAWN'),
        applicationId: app ? app.id : null,
        tokens: {
          name: c.name, firstName: firstOf(c.name), ...t, ...(app ? { interviewContact: extra.line } : {}), ...(extra.old ? { interviewOld: extra.old } : {}), ...(extra.prep ? { prepNote: extra.prep } : {}),
        },
      };
    });
  }
  if (audience === 'clients') {
    // eslint-disable-next-line global-require
    const profile = require('./clientProfile');
    const rows = await prisma.client.findMany({
      where: { AND: [{ id: { in: ids } }, scope.clientWhere(user)] },
      select: {
        id: true, name: true, contactName: true, contactEmail: true, contactPhone: true, contactWhatsApp: true,
        billingContactName: true, billingContactEmail: true, billingContactPhone: true, commPrimary: true,
        agreementStatus: true, agreementDocument: true, agreementSentAt: true, esignToken: true, agreementEsignTxnId: true,
        ...(profile.hasColumn('agreementLinkMeta') ? { agreementLinkMeta: true } : {}),
      },
    });
    // A job can be named for a client message ("About your job {{role}}").
    const job = requirementId ? await prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } }).catch(() => null) : null;
    // {{agreementLink}}: the client's CURRENT signing link, only while it is live, and only for a login
    // that may share it (the same rule as the agreement link card: Super Admin / Admin). Otherwise it
    // stays a {{detail}} that the sender sees and fills by hand — a link is never made by sending a message.
    let mayLink = false;
    try { mayLink = await require('./permissions').can(user, 'ats', 'clients', 'Agreement Lifecycle', 'create'); } catch { mayLink = false; } // eslint-disable-line global-require
    const linkOf = (c) => {
      if (!mayLink) return null;
      try {
        const signing = require('./agreementSigning'); // eslint-disable-line global-require
        const token = signing.tokenFor(c);
        if (!token || !signing.linkState(c).ok || !signing.OUT_FOR_SIGNATURE.includes(signing.statusOf(c))) return null;
        return require('./agreementLifecycle').signingUrl(null, token); // eslint-disable-line global-require
      } catch { return null; }
    };
    // The Accountant writes to the client's BILLING contact only (payment reminders); nobody else's address is used for them.
    const billing = contactKind === 'billing';
    return rows.map((c) => ({
      id: c.id,
      name: billing ? `${c.billingContactName || 'Billing contact'} (${c.name})` : (c.contactName ? `${c.contactName} (${c.name})` : c.name),
      email: billing ? c.billingContactEmail : c.contactEmail,
      mobile: billing ? c.billingContactPhone : c.contactPhone,
      whatsapp: billing ? c.billingContactPhone : (c.contactWhatsApp || c.contactPhone),
      doNotContact: false, commPrimary: c.commPrimary || null,
      tokens: {
        name: billing ? (c.billingContactName || c.name) : (c.contactName || c.name), firstName: firstOf(billing ? (c.billingContactName || c.name) : (c.contactName || c.name)), client: c.name, agreementLink: billing ? null : linkOf(c),
        ...(job && job.clientId === c.id ? appTokens({ requirement: job }) : {}),
      },
    }));
  }
  const rows = await prisma.employee.findMany({
    where: { AND: [{ id: { in: ids } }, scope.employeeWhere(user)] },
    select: { id: true, name: true, email: true, phone: true },
  });
  return rows.map((e) => ({
    id: e.id, name: e.name, email: e.email, mobile: e.phone, whatsapp: e.phone, doNotContact: false,
    tokens: { name: e.name, firstName: firstOf(e.name) },
  }));
}

module.exports = { recipientsFor, senderTokens, appTokens, recruiterLineFor, oldSlotOf, COMPANY };

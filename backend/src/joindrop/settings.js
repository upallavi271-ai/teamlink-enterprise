// ---------------------------------------------------------------------------
// JOINING & DROP - the Admin switches (Administration -> Step timing -> "Joinings and drops").
//
// One AppSetting row, "joindrop-settings". For each of the three moments - a candidate JOINED, a joined candidate DROPPED, the client's
// REPLACEMENT DECISION - one switch per party and per way (bell, email; the candidate: email, WhatsApp).
//
// The defaults are the founder's:
//   joined      client, recruiter, TL, BDE: bell + email.  Candidate: a welcome by email + WhatsApp (still behind the "Candidate emails" switch).
//               HR: bell only (email is OFF until an Admin turns it on).
//   dropped     client (when the report did not come from them), recruiter, TL, BDE, HR: bell + email.
//               Candidate: OFF (sensitive; an Admin may switch it on).
//   decision    recruiter, TL, BDE, HR: bell + email (the client entered it, so the client is not told).
//
// Two more switches:
//   defaultGuaranteeDays  the standard replacement period (30) used only when a client has no replacement period of its own. Admin only.
//                   (A drop INSIDE the period always opens one "Find a replacement" task at once: the founder's rule, not a switch.)
//   hrPeople        THE HR SIDE: the employee codes of the people who see Joining & Drop for client placements (names, dates, reasons only: never
//                   phone / email / pay), who are the "HR" that is told (bell; email by the switches) and who review and send the candidate drop
//                   notice. Default: TL309 (the HR head) and nobody else. Every other HR login sees none of it and is told none of it.
//                   Same convention as the agreement HR approver list. Admin / Super Admin edit the list.
//
// Email only leaves when the Notification emails master switch (Attendance -> Who gets told) is ON: otherwise the bell and the tasks still
// happen and the screen says "emails are switched off".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');

const KEY = 'joindrop-settings';

const PARTIES = {
  join: ['client', 'recruiter', 'tl', 'bde', 'candidate', 'hr'],
  drop: ['client', 'recruiter', 'tl', 'bde', 'candidate', 'hr'],
  decision: ['recruiter', 'tl', 'bde', 'hr'],
};
const PARTY_WORDS = {
  client: 'The client', recruiter: 'The recruiter', tl: 'The team lead (TL)', bde: 'The BDE', candidate: 'The candidate', hr: 'HR head (the HR list)',
};
const MOMENT_WORDS = {
  join: 'When a candidate joins', drop: 'When a joined candidate drops', decision: 'When the client decides about a replacement',
};

function defaults() {
  const on = { bell: true, email: true };
  return {
    join: {
      client: { ...on }, recruiter: { ...on }, tl: { ...on }, bde: { ...on },
      candidate: { email: true, whatsapp: true }, hr: { bell: true, email: false },
    },
    drop: {
      client: { ...on }, recruiter: { ...on }, tl: { ...on }, bde: { ...on },
      candidate: { email: false, whatsapp: false }, hr: { ...on },
    },
    decision: {
      recruiter: { ...on }, tl: { ...on }, bde: { ...on }, hr: { ...on },
    },
    defaultGuaranteeDays: 30,
    hrPeople: ['TL309'],
  };
}

const WAYS = { candidate: ['email', 'whatsapp'] };
const waysOf = (party) => WAYS[party] || ['bell', 'email'];

async function get() {
  const base = defaults();
  let saved = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    saved = row ? JSON.parse(row.value) || {} : {};
  } catch { saved = {}; }
  const out = { ...base };
  ['join', 'drop', 'decision'].forEach((m) => {
    out[m] = {};
    PARTIES[m].forEach((p) => {
      const b = base[m][p];
      const s = (saved[m] && saved[m][p]) || {};
      out[m][p] = {};
      waysOf(p).forEach((w) => { out[m][p][w] = typeof s[w] === 'boolean' ? s[w] : b[w]; });
    });
  });
  const dd = Number(saved.defaultGuaranteeDays);
  out.defaultGuaranteeDays = Number.isInteger(dd) && dd >= 1 && dd <= 730 ? dd : 30;
  const list = Array.isArray(saved.hrPeople) ? saved.hrPeople : base.hrPeople;
  out.hrPeople = [...new Set(list.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))].slice(0, 20);
  return out;
}

async function save(patch, user) {
  const cur = await get();
  const next = JSON.parse(JSON.stringify(cur));
  const p = patch || {};
  ['join', 'drop', 'decision'].forEach((m) => {
    if (!p[m] || typeof p[m] !== 'object') return;
    PARTIES[m].forEach((party) => {
      const s = p[m][party];
      if (!s || typeof s !== 'object') return;
      waysOf(party).forEach((w) => { if (typeof s[w] === 'boolean') next[m][party][w] = s[w]; });
    });
  });
  if (p.defaultGuaranteeDays !== undefined) {
    const n = Number(p.defaultGuaranteeDays);
    if (!Number.isInteger(n) || n < 1 || n > 730) { const e = new Error('The standard replacement period must be a whole number of days from 1 to 730.'); e.status = 400; throw e; }
    next.defaultGuaranteeDays = n;
  }
  if (p.hrPeople !== undefined) {
    const raw = Array.isArray(p.hrPeople) ? p.hrPeople : String(p.hrPeople).split(/[,\s]+/);
    const codes = [...new Set(raw.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))];
    if (codes.length > 20 || codes.some((c) => c.length > 40 || /[^A-Z0-9_.-]/.test(c))) { const e = new Error('The HR list holds up to 20 employee codes (letters and numbers), for example TL309.'); e.status = 400; throw e; }
    next.hrPeople = codes;
  }
  const value = JSON.stringify(next);
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value, ...who }, update: { value, ...who } });
  const word = (m) => PARTIES[m].map((party) => `${party}:${waysOf(party).filter((w) => next[m][party][w]).join('+') || 'off'}`).join(' ');
  await logAudit({
    userId: user ? user.id : null, action: 'Joining and drop notice settings changed', entity: 'AppSetting', entityId: KEY,
    toValue: `joined [${word('join')}] dropped [${word('drop')}] decision [${word('decision')}] · standard replacement period ${next.defaultGuaranteeDays} days · HR side (employee codes): ${next.hrPeople.join(', ') || 'nobody'}`.slice(0, 900),
  });
  return next;
}

module.exports = { KEY, PARTIES, PARTY_WORDS, MOMENT_WORDS, defaults, get, save, waysOf };

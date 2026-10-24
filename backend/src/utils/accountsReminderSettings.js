// ---------------------------------------------------------------------------
// WHO GETS EACH ACCOUNTS REMINDER - the Admin decides (founder follow-up, 2026-10-21).
//
// The rule "Accounts reminders go to the Accountant" (utils/accountsRecipients.js) is now the DEFAULT of a table, not a hard rule:
// one row per reminder kind, and an Admin / Super Admin can set, per kind, who receives it, the ways it is sent, the timing where
// the kind is time-based, and an On / Off switch. Nothing changes until the Admin edits a row: every kind starts as it behaved before
// (Accountant role only, same ways, same times).
//
// STORAGE: AppSetting `accounts.reminderRecipients` = { version, updatedAt, updatedBy, kinds: { <kind>: { on, roles, people, owner,
// channels, timing } } }. Only kinds the Admin changed are stored; "Reset to default" removes the entry. The resolver reads it AT SEND TIME
// (no restart). The proof reminder's own switch and times stay in `proofReminders.settings` (enabled, time1, time2): this screen reads and
// writes them there, so there is one source of truth for them.
//
// WHO CAN BE CHOSEN: a ROLE (Accountant, Admin, Super Admin, Manager, ...) and / or specific PEOPLE (active logins with Accounts access).
// A person with no Accounts access at all is refused with the reason. A person who has Accounts but cannot open the related screen is only
// a WARNING (they get the message but cannot act). A deactivated person is skipped at send time and shows as a warning on the row.
//
// NOBODY LEFT: a kind that is ON but resolves to nobody sends nothing to anyone else; the Admin gets ONE deduplicated notice
// ("No accountant is set up" for a default row, "No one will receive <reminder>" for a changed row).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const KEY = 'accounts.reminderRecipients';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROLE_OPTIONS = [
  { code: 'ACCOUNTANT', label: 'Accountant' },
  { code: 'ADMIN', label: 'Admin' },
  { code: 'SUPER_ADMIN', label: 'Super Admin' },
  { code: 'MANAGER', label: 'Manager' },
  { code: 'ASSISTANT_MANAGER', label: 'Assistant Manager' },
  { code: 'HR', label: 'HR' },
  { code: 'BDE', label: 'BDE' },
];
const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS.map((r) => [r.code, r.label]));
const CH = { bell: 'Bell', email: 'Email', whatsapp: 'WhatsApp', task: 'Task (with a bell)', dashboard: 'Dashboard card' };

// The default named person of the Accounts reminders (founder, 2026-10-21: "send it to Purna Chandra"): the HR head, found by EMPLOYEE CODE
// (never by name), set here in code so no database write is needed. The Admin can remove or replace him in the screen; saving a row stores
// the Admin's own list, which then overrides this default. He may have no Accounts access: he still gets the information (plain text, no link).
const PURNA = ['TL309'];
const OWNER_PROOF = "Also the person who recorded the payment (their own proofs go to them first)";
// perm = [product, module, feature]: the screen the reminder is about. strict = the Accountant role is re-checked against it at send time.
const KINDS = [
  {
    key: 'proofBell', defaultCodes: PURNA, title: 'Payment proof is missing (emergency bell)', group: 'Emergency',
    desc: "A bell reminder for one missing proof. It is NOT needed day to day: the daily summary above is automatic. This is only used by the emergency 'Remind accountant' call, which is no longer on the Accounts screens.",
    perm: ['accounts', 'accounts', 'Accounts Dashboard'], strict: true,
    channels: [{ id: 'bell', fixed: true }], owner: OWNER_PROOF, ownerDefault: true,
    timing: [{ id: 'repeatDays', label: 'Do not remind about the same proof again for (days)', type: 'int', min: 1, max: 30, def: 1 }],
  },
  {
    key: 'proofDaily', defaultCodes: PURNA, title: 'Daily Accounts summary (morning and evening)', group: 'Proof',
    desc: 'Goes out by itself every day, India time: proofs still missing, vendor bills and payouts waiting, invoices and bills overdue, tax dates. One message per person, only when something is pending. Nobody has to press anything.',
    perm: ['accounts', 'accounts', 'Accounts Dashboard'], strict: true,
    channels: [{ id: 'whatsapp' }, { id: 'email' }, { id: 'bell' }], owner: OWNER_PROOF, ownerDefault: true,
    timing: [{ id: 'time1', label: 'Morning time (India time)', type: 'time', def: '09:30' }, { id: 'time2', label: 'Evening time (India time)', type: 'time', def: '17:00' }],
    proofEngine: true,
  },
  {
    key: 'vendorBill', defaultCodes: PURNA, title: 'Vendor bill is waiting for a check', group: 'Vendors',
    desc: 'A vendor sent a bill for one of its assets. Open Office & Accounts, Bills from vendors.',
    perm: ['accounts', 'accounts', 'Office & Expenses'], strict: true, channels: [{ id: 'bell', fixed: true }, { id: 'email' }], vendorMail: true,
  },
  {
    key: 'vendorInvoice', defaultCodes: PURNA, title: 'Vendor invoice, monthly bill or receipt is waiting', group: 'Vendors',
    desc: 'A vendor sent an invoice, a monthly bill or a receipt from the Vendor Portal.',
    perm: ['accounts', 'accounts', 'Office & Expenses'], strict: true, channels: [{ id: 'bell', fixed: true }, { id: 'email' }], vendorMail: true,
  },
  {
    key: 'repairInvoice', defaultCodes: PURNA, title: 'Repair invoice was sent to Accounts', group: 'Vendors',
    desc: "A repair vendor sent its invoice to Accounts' check list. It is not paid and not posted.",
    perm: ['accounts', 'accounts', 'Office & Expenses'], strict: true, channels: [{ id: 'bell', fixed: true }],
  },
  {
    key: 'repairCost', defaultCodes: PURNA, title: 'Repair cost or invoice was changed', group: 'Vendors',
    desc: "A repair vendor changed the cost or the invoice (shows as 'Changed in HRMS' if already posted).",
    perm: ['accounts', 'accounts', 'Office & Expenses'], strict: true, channels: [{ id: 'bell', fixed: true }],
  },
  {
    key: 'partnerPayout', defaultCodes: PURNA, title: 'Partner payout is waiting to be approved', group: 'Other',
    desc: 'A partner-sourced candidate joined, so a payout was made. Invoices, Partner payouts.',
    perm: ['accounts', 'accounts', 'Office & Expenses'], strict: true, channels: [{ id: 'bell', fixed: true }],
  },
  {
    key: 'invoiceReady', defaultCodes: PURNA, title: 'Invoice is ready to prepare (after a joining)', group: 'Other',
    desc: 'A candidate joined a client, so an invoice is waiting in Accounts, Invoices.',
    perm: ['accounts', 'accounts', 'Invoices'], strict: false, channels: [{ id: 'bell', fixed: true }, { id: 'email' }],
  },
  {
    key: 'creditNote', title: 'Check a credit note or refund (after a drop)', group: 'Other',
    desc: 'A joined candidate dropped inside the replacement period and the client wants no replacement. A task is made. Nothing is raised by itself.',
    perm: ['accounts', 'accounts', 'Invoices'], strict: false, channels: [{ id: 'task', fixed: true }],
    owner: "Also the BDE of that client", ownerDefault: true,
  },
  {
    key: 'agreementSigned', title: 'Client agreement was signed', group: 'Other',
    desc: "The client e-signed the agreement. The client's own logins always hear about it.",
    perm: ['ats', 'clients', 'Agreement Lifecycle'], strict: false, channels: [{ id: 'bell', fixed: true }],
    owner: "Also the BDEs of that client's jobs", ownerDefault: true,
  },
];
const BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));
const kindDef = (k) => BY_KEY[k] || null;

const defaultsOf = (def) => ({
  on: true,
  roles: ['ACCOUNTANT'],
  people: [],
  owner: !!def.ownerDefault,
  channels: def.channels.map((c) => c.id),
  timing: Object.fromEntries((def.timing || []).filter((t) => !def.proofEngine).map((t) => [t.id, t.def])),
});

// ---- storage ---------------------------------------------------------------
async function getDoc() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const v = row && row.value ? JSON.parse(row.value) : null;
    return v && typeof v === 'object' && v.kinds && typeof v.kinds === 'object' ? v : { version: 0, kinds: {} };
  } catch { return { version: 0, kinds: {} }; }
}
async function putDoc(doc, user) {
  const next = { version: (Number(doc.version) || 0) + 1, updatedAt: new Date().toISOString(), updatedBy: user ? (user.name || user.id) : null, kinds: doc.kinds || {} };
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: KEY },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    create: { key: KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  return next;
}
const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

// The named default people (employee codes -> their login). An employee with no login is simply not there.
async function defaultPeopleIds(def) {
  const codes = def.defaultCodes || [];
  if (!codes.length) return [];
  const rows = await prisma.employee.findMany({ where: { employeeCode: { in: codes } }, select: { userId: true } }).catch(() => []);
  return rows.map((r) => r.userId).filter(Boolean);
}

// The row as it applies now: defaults, overridden by the stored entry. The proof reminder's switch and times come from its own settings.
async function effective(key, doc) {
  const def = kindDef(key);
  const d = defaultsOf(def);
  const stored = (doc || await getDoc()).kinds[key];
  if (!stored) d.people = await defaultPeopleIds(def);
  const out = {
    ...d,
    ...(stored ? {
      on: stored.on !== false,
      roles: arr(stored.roles).filter((r) => ROLE_LABEL[r]),
      people: arr(stored.people),
      owner: stored.owner === undefined ? d.owner : !!stored.owner,
      channels: def.channels.filter((c) => c.fixed || stored.channels === undefined || arr(stored.channels).includes(c.id)).map((c) => c.id),
      timing: { ...d.timing, ...(stored.timing && typeof stored.timing === 'object' ? stored.timing : {}) },
    } : {}),
    custom: !!stored,
  };
  // 'peopleCustom': the Admin changed WHO gets it (not only the ways or the times). Only then does the row override the record-by-record rules.
  const defPeople = stored ? await defaultPeopleIds(def) : [];
  out.peopleCustom = !!stored && (JSON.stringify([...out.roles].sort()) !== JSON.stringify(['ACCOUNTANT']) || JSON.stringify([...out.people].sort()) !== JSON.stringify([...defPeople].sort()));
  if (def.proofEngine) {
    const PR = require('./proofReminders'); // eslint-disable-line global-require
    const s = await PR.getSettings();
    out.on = s.enabled === true;
    out.timing = { time1: s.time1, time2: s.time2 };
  }
  return out;
}

// ---- who it resolves to now ---------------------------------------------------
async function roleMembers(code, def, allowTest) {
  const AR = require('./accountsRecipients'); // eslint-disable-line global-require
  if (code === 'ACCOUNTANT') {
    return AR.accountants({ allowTest, feature: def.strict ? def.perm[2] : null, product: def.perm[0], module: def.perm[1] });
  }
  const where = code === 'ADMIN' || code === 'SUPER_ADMIN'
    ? { OR: [{ role: code }, { accountsRole: code }] }
    : { OR: [{ role: code }, { atsRole: code }, { hrmsRole: code }, { accountsRole: code }] };
  const rows = await prisma.user.findMany({ where: { status: 'Active', ...where }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } });
  return rows.filter((u) => (AR.testAllowed(allowTest) || !AR.isTest(u)));
}

async function resolve(key, { allowTest } = {}) {
  const AR = require('./accountsRecipients'); // eslint-disable-line global-require
  const def = kindDef(key);
  const st = await effective(key);
  const base = { kind: key, def, setting: st, custom: st.custom, peopleCustom: st.peopleCustom, on: st.on, owner: st.owner, channels: st.channels, timing: st.timing, skipped: [] };
  if (!st.on) return { ...base, users: [], accountants: [], none: true, alsoAdmin: false };
  const seen = new Map();
  const add = (u) => { if (!seen.has(u.id)) seen.set(u.id, { id: u.id, name: u.name, email: u.email }); };
  let accountants = [];
  for (const code of st.roles) {
    // eslint-disable-next-line no-await-in-loop
    const m = await roleMembers(code, def, allowTest);
    if (code === 'ACCOUNTANT') accountants = m;
    m.forEach(add);
  }
  let skipped = [];
  if (st.people.length) {
    const rows = await prisma.user.findMany({ where: { id: { in: st.people } }, select: { id: true, name: true, email: true, status: true } });
    const wantTest = AR.testAllowed(allowTest);
    rows.forEach((u) => { if (u.status !== 'Active') skipped.push(u.name); else if (wantTest || !AR.isTest(u)) add(u); });
    skipped = [...new Set(skipped)];
  }
  // The founder's earlier single tick (proofReminders.settings.alsoAdmin) still works for a row the Admin has not changed.
  const opted = !st.peopleCustom && await AR.alsoAdmin();
  if (opted) (await AR.admins({ allowTest })).forEach(add);
  const users = [...seen.values()];
  return { ...base, users, accountants, skipped, none: users.length === 0, alsoAdmin: opted };
}

// ---- validation -------------------------------------------------------------
const FAIL = (error) => ({ error });
const NO_ACCOUNTS = 'Can receive the message but cannot open Accounts screens.';
async function validate(key, input, { allowTest } = {}) {
  const def = kindDef(key);
  if (!def) return FAIL('Unknown reminder.');
  const b = input && typeof input === 'object' ? input : {};
  const cur = await effective(key);
  const warnings = [];
  const roles = b.roles === undefined ? cur.roles : arr(b.roles);
  if (roles.some((r) => !ROLE_LABEL[r])) return FAIL('One of the roles is not known.');
  const people = b.people === undefined ? cur.people : [...new Set(arr(b.people))];
  const on = b.on === undefined ? cur.on : (b.on === true || b.on === 'true');
  const owner = b.owner === undefined ? cur.owner : (b.owner === true || b.owner === 'true');
  const wanted = b.channels === undefined ? cur.channels : arr(b.channels);
  if (wanted.some((c) => !def.channels.find((x) => x.id === c))) return FAIL('One of the ways to send is not available for this reminder.');
  const channels = def.channels.map((c) => c.id).filter((c) => wanted.includes(c) || def.channels.find((x) => x.id === c).fixed);
  if (on && !roles.length && !people.length) return FAIL('Choose at least one person or role.');
  if (on && !channels.length) return FAIL('Choose at least one way to send.');
  // timing
  const timing = {};
  for (const t of (def.timing || [])) {
    const raw = b.timing && b.timing[t.id] !== undefined ? b.timing[t.id] : (cur.timing || {})[t.id];
    if (t.type === 'time') {
      if (!HHMM.test(String(raw || ''))) return FAIL(`${t.label}: write the time like 10:00 (24-hour).`);
      timing[t.id] = String(raw);
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < t.min || n > t.max) return FAIL(`${t.label}: a whole number from ${t.min} to ${t.max}.`);
      timing[t.id] = n;
    }
  }
  // people: active logins with Accounts access
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const { can } = require('./permissions'); // eslint-disable-line global-require
  const AR = require('./accountsRecipients'); // eslint-disable-line global-require
  if (people.length) {
    const rows = await prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true, email: true, status: true } });
    const known = new Map(rows.map((u) => [u.id, u]));
    const previously = new Set(cur.people);
    for (const id of people) {
      const u = known.get(id);
      if (!u) return FAIL('One of the chosen people is not a login any more.');
      if (u.status !== 'Active') { if (!previously.has(id)) return FAIL(`${u.name} is switched off, so cannot be chosen.`); continue; } // eslint-disable-line no-continue
      if (!AR.testAllowed(allowTest) && AR.isTest(u)) return FAIL(`${u.name} is a test login and cannot be chosen.`);
      // eslint-disable-next-line no-await-in-loop
      const ident = await resolveIdentity(id).catch(() => null);
      if (!ident) return FAIL(`${u.name} has no working login, so cannot be chosen.`);
      // eslint-disable-next-line no-await-in-loop
      const emp = await prisma.employee.findFirst({ where: { userId: id }, select: { phone: true, email: true } });
      if (!u.email && !(emp && (emp.phone || emp.email))) return FAIL(`${u.name} has no WhatsApp number and no email on file, so nothing can reach them.`);
      if (!(ident.products && ident.products.accounts)) warnings.push(`${u.name}: ${NO_ACCOUNTS}`);
      // eslint-disable-next-line no-await-in-loop
      else if (!(await can(ident, def.perm[0], def.perm[1], def.perm[2], 'view').catch(() => false))) warnings.push(`${u.name} cannot open this screen. They will get the message but cannot act on it.`);
    }
  }
  return { value: { on, roles, people, owner: def.owner ? owner : false, channels, timing }, warnings };
}

// ---- names for the audit and the screen --------------------------------------
async function nameOf(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true } });
  return new Map(rows.map((u) => [u.id, u]));
}
async function describe(value, def) {
  const names = await nameOf(value.people || []);
  const roles = (value.roles || []).map((r) => ROLE_LABEL[r] || r);
  const people = (value.people || []).map((id) => (names.get(id) ? names.get(id).name : 'someone removed'));
  const ways = (value.channels || []).map((c) => CH[c] || c);
  const timing = Object.entries(value.timing || {}).map(([k, v]) => `${k} ${v}`);
  return `${value.on ? 'ON' : 'OFF'}; roles: ${roles.join(', ') || 'none'}; people: ${people.join(', ') || 'none'}${def.owner ? `; ${value.owner ? 'also the owner' : 'not the owner'}` : ''}; ways: ${ways.join(', ') || 'none'}${timing.length ? `; ${timing.join(', ')}` : ''}`;
}

// ---- save / reset ---------------------------------------------------------------
async function save(key, input, user, { allowTest } = {}) {
  const def = kindDef(key);
  const v = await validate(key, input, { allowTest });
  if (v.error) return { status: 400, body: { error: v.error } };
  const before = await effective(key);
  const doc = await getDoc();
  const stored = { on: v.value.on, roles: v.value.roles, people: v.value.people, owner: v.value.owner, channels: v.value.channels };
  if (def.proofEngine) {
    const PR = require('./proofReminders'); // eslint-disable-line global-require
    const r = await PR.saveSettings({ enabled: v.value.on, time1: v.value.timing.time1, time2: v.value.timing.time2 }, user, { allowTest });
    if (r.error) return { status: 400, body: { error: r.error } };
  } else if (Object.keys(v.value.timing).length) stored.timing = v.value.timing;
  doc.kinds = { ...doc.kinds, [key]: stored };
  await putDoc(doc, user);
  const after = await effective(key);
  await logAudit({
    userId: user.id, actorName: user.name || null, action: 'Accounts reminder recipients changed', entity: 'AccountsReminderSettings', entityId: key, fieldLabel: def.title,
    fromValue: (await describe(before, def)).slice(0, 480), toValue: (await describe(after, def)).slice(0, 480),
  }).catch(() => null);
  return { status: 200, body: { ok: true, warnings: v.warnings, row: await rowOf(key, user) } };
}
async function reset(key, user) {
  const def = kindDef(key);
  if (!def) return { status: 404, body: { error: 'Unknown reminder.' } };
  const before = await effective(key);
  const doc = await getDoc();
  const kinds = { ...doc.kinds }; delete kinds[key];
  doc.kinds = kinds;
  await putDoc(doc, user);
  if (def.proofEngine) {
    const PR = require('./proofReminders'); // eslint-disable-line global-require
    await PR.saveSettings({ time1: def.timing[0].def, time2: def.timing[1].def }, user);
  }
  const after = await effective(key);
  await logAudit({
    userId: user.id, actorName: user.name || null, action: 'Accounts reminder recipients reset to default', entity: 'AccountsReminderSettings', entityId: key, fieldLabel: def.title,
    fromValue: (await describe(before, def)).slice(0, 480), toValue: (await describe(after, def)).slice(0, 480),
  }).catch(() => null);
  return { status: 200, body: { ok: true, row: await rowOf(key, user) } };
}
// PRESETS (the founder's earlier single tick lives on as a preset): 'also-admin' = Accountant + Admin + Super Admin on every
// kind that is not about the client's own agreement or the dashboard; 'accountant-only' = back to the defaults.
async function preset(name, user) {
  const keys = KINDS.filter((k) => !['agreementSigned', 'dashboardCard'].includes(k.key)).map((k) => k.key);
  if (name === 'accountant-only') {
    const doc = await getDoc();
    keys.forEach((k) => { delete doc.kinds[k]; });
    await putDoc(doc, user);
    await logAudit({ userId: user.id, actorName: user.name || null, action: 'Accounts reminder recipients: preset', entity: 'AccountsReminderSettings', fieldLabel: 'Preset', toValue: 'Back to the defaults (Purna Chandra and the Accountant role)' }).catch(() => null);
    return { status: 200, body: { ok: true } };
  }
  if (name === 'also-admin') {
    const doc = await getDoc();
    for (const k of keys) {
      const cur = doc.kinds[k] || {};
      // eslint-disable-next-line no-await-in-loop
      const keep = doc.kinds[k] ? arr(cur.people) : await defaultPeopleIds(kindDef(k));
      doc.kinds[k] = { ...cur, on: cur.on !== false, roles: ['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN'], people: keep, channels: cur.channels };
      if (doc.kinds[k].channels === undefined) delete doc.kinds[k].channels;
    }
    await putDoc(doc, user);
    await logAudit({ userId: user.id, actorName: user.name || null, action: 'Accounts reminder recipients: preset', entity: 'AccountsReminderSettings', fieldLabel: 'Preset', toValue: 'Accountant, Admin and Super Admin get every Accounts reminder' }).catch(() => null);
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { error: 'Unknown preset.' } };
}

// ---- the screen's rows -------------------------------------------------------------
async function channelHealth(def, selected) {
  const out = {};
  const need = (id) => selected.includes(id) || def.channels.find((c) => c.id === id);
  if (def.vendorMail && need('email')) {
    const on = await require('./vendorConfig').loadSettings().then((s) => s.emailsEnabled).catch(() => false); // eslint-disable-line global-require
    out.email = on ? { ok: true } : { ok: false, note: "The 'Vendor emails' switch is OFF, so no email is sent. Turn it on in Administration, Vendor Management." };
  } else if (def.key === 'invoiceReady') {
    const on = await require('./interviewNotices').candidateEmailsOn().catch(() => false); // eslint-disable-line global-require
    out.email = on ? { ok: true } : { ok: false, note: 'Emails are switched OFF in the company settings, so no email is sent.' };
  } else if (def.proofEngine) {
    let ch = {};
    try { ch = await require('./messaging').channelStatus(); } catch { ch = {}; } // eslint-disable-line global-require
    const hn = await require('./hrmsNotify').getSettings().catch(() => null); // eslint-disable-line global-require
    out.whatsapp = ch.WhatsApp && ch.WhatsApp.configured ? { ok: true } : { ok: false, note: 'WhatsApp is not ready (not connected), so no WhatsApp is sent. Email still goes.' };
    out.email = !(ch.Email && ch.Email.configured) ? { ok: false, note: 'Mail is not set up, so no email is sent.' }
      : (hn && hn.emailsOn !== true ? { ok: false, note: "The 'Notification emails' switch is OFF, so no email is sent. Turn it on in Administration, Notifications." } : { ok: true });
  }
  return out;
}
async function rowOf(key, viewer) {
  const AR = require('./accountsRecipients'); // eslint-disable-line global-require
  const def = kindDef(key);
  const doc = await getDoc();
  const st = await effective(key, doc);
  const names = await nameOf(st.people);
  const people = st.people.map((id) => {
    const u = names.get(id);
    return { id, name: u ? u.name : 'Someone who was removed', active: !!(u && u.status === 'Active') };
  });
  const r = await resolve(key);
  const warnings = [];
  people.filter((p) => !p.active).forEach((p) => warnings.push(`${p.name} is switched off, so they are skipped.`));
  if (st.on && r.none) warnings.push(st.peopleCustom ? `No one will receive this reminder: ${def.title}.` : 'No accountant is set up, so no one will receive this reminder.');
  if (st.on) {
    // roles: members who cannot open the screen
    const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
    const { can } = require('./permissions'); // eslint-disable-line global-require
    let cannot = 0;
    for (const u of r.users.filter((x) => !r.accountants.find((a) => a.id === x.id)).slice(0, 25)) {
      // eslint-disable-next-line no-await-in-loop
      const ident = await resolveIdentity(u.id).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      if (!ident || !(await can(ident, def.perm[0], def.perm[1], def.perm[2], 'view').catch(() => false))) cannot += 1;
    }
    if (cannot) warnings.push(`${cannot} of the people chosen cannot open this screen. They will get the message but cannot act on it.`);
    // people with no Accounts access at all, and missing WhatsApp number / email (named, never the number or the address)
    const emps = r.users.length ? await prisma.employee.findMany({ where: { userId: { in: r.users.map((u) => u.id) } }, select: { userId: true, phone: true, email: true } }) : [];
    for (const u of r.users) {
      const e = emps.find((x) => x.userId === u.id) || {};
      if (st.channels.includes('whatsapp') && !e.phone) warnings.push(`No WhatsApp number on file for ${u.name}.`);
      if (st.channels.includes('email') && !(u.email || e.email)) warnings.push(`No email on file for ${u.name}.`);
      if (!r.accountants.find((a) => a.id === u.id)) {
        // eslint-disable-next-line no-await-in-loop
        const ident = await resolveIdentity(u.id).catch(() => null);
        if (!(ident && ident.products && ident.products.accounts)) warnings.push(`${u.name}: ${NO_ACCOUNTS}`);
      }
    }
  }
  const health = await channelHealth(def, st.channels);
  return {
    key, title: def.title, description: def.desc, group: def.group, on: st.on, custom: st.custom,
    roles: st.roles.map((c) => ({ code: c, label: ROLE_LABEL[c] })), people,
    owner: def.owner ? { label: def.owner, on: st.owner } : null,
    channels: def.channels.map((c) => ({ id: c.id, label: CH[c.id], fixed: !!c.fixed, on: st.channels.includes(c.id), health: health[c.id] || null })),
    timing: (def.timing || []).map((t) => ({ id: t.id, label: t.label, type: t.type, min: t.min, max: t.max, value: (st.timing || {})[t.id] !== undefined ? st.timing[t.id] : t.def, def: t.def })),
    receiving: r.users.map((u) => u.name), warnings,
    isAdmin: !!viewer,
  };
}
async function rows(viewer) { return Promise.all(KINDS.map((k) => rowOf(k.key, viewer))); }

// ---- people picker (type to search) ------------------------------------------------
async function searchPeople(q, { allowTest } = {}) {
  const AR = require('./accountsRecipients'); // eslint-disable-line global-require
  const text = String(q || '').trim();
  const rowsU = await prisma.user.findMany({
    where: { status: 'Active', ...(text ? { OR: [{ name: { contains: text } }, { email: { contains: text } }] } : {}) },
    select: { id: true, name: true, role: true, accountsRole: true, accountsAccess: true },
    orderBy: { name: 'asc' },
    take: 60,
  });
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const out = [];
  for (const u of rowsU.filter((x) => AR.testAllowed(allowTest) || !AR.isTest(x))) {
    // eslint-disable-next-line no-await-in-loop
    const ident = await resolveIdentity(u.id).catch(() => null);
    out.push({ id: u.id, name: u.name, role: ROLE_LABEL[u.accountsRole] || ROLE_LABEL[u.role] || null, hasAccounts: !!(ident && ident.products && ident.products.accounts) });
    if (out.length >= 30) break;
  }
  return out;
}

// ---- "Send me a test": only the Admin who clicked, through the real channel, respecting the switches -------------------------------------------------
async function sendTest(key, user, { transports } = {}) {
  const def = kindDef(key);
  if (!def) return { status: 404, body: { error: 'Unknown reminder.' } };
  const st = await effective(key);
  const out = {};
  const { pushNotification } = require('./notify'); // eslint-disable-line global-require
  await pushNotification({ userId: user.id, title: `[TEST] ${def.title}`, message: `This is only a test of "${def.title}". Nobody else was sent anything. ${def.desc}` });
  out.bell = 'Sent to your bell';
  if (def.proofEngine) {
    const PR = require('./proofReminders'); // eslint-disable-line global-require
    const r = await PR.sendTest({ user, ...(transports ? { transports } : {}) });
    out.message = r.body && r.body.message ? r.body.message : null;
  } else if (st.channels.includes('email') && def.channels.find((c) => c.id === 'email')) {
    const h = (await channelHealth(def, st.channels)).email;
    if (h && !h.ok) out.email = `Not sent: ${h.note}`;
    else if (!user.email) out.email = 'Not sent: your login has no email address.';
    else {
      const r = await require('./mailer').sendMail({ to: user.email, subject: `[TEST] ${def.title}`, text: `This is only a test of "${def.title}". Nobody else was sent anything.\n\n${def.desc}\n\n- TeamLink`, useEmployeeFrom: false }).catch((e) => ({ ok: false, error: e.message })); // eslint-disable-line global-require
      out.email = r && r.ok ? 'Sent to your email' : `Not sent: ${String((r && r.error) || 'mail problem').slice(0, 120)}`;
    }
  }
  return { status: 200, body: { ok: true, message: 'A test was sent only to you.', result: out } };
}

module.exports = {
  KEY, KINDS, ROLE_OPTIONS, kindDef, effective, resolve, validate, save, reset, preset, rows, rowOf, searchPeople, sendTest, getDoc,
};

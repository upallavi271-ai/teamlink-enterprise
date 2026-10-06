// ---------------------------------------------------------------------------
// AGREEMENT SETTINGS (spec section 6, 2026-10-03) — Admin settings, no schema
// change: one row in the existing AppSetting table, key "agreementDefaults".
//
//   feePercent      placement fee, % of annual CTC        (default 8.33)
//   guaranteeDays   replacement guarantee, days            (default 30)
//   paymentDays     client pays within N days of invoice   (default 6)
//   templateName    which template a new draft uses — today only the
//                   TeamLink standard document (utils/agreement.js)
//   templateNote    PLACEHOLDER text until the user decides #9 (template,
//                   fee fields, guarantee, signatory, e-sign provider)
//   signatoryName / signatoryTitle   who signs for TeamLink (placeholder)
//   esignProvider   'Later' — no outside e-sign provider is connected
//   renewalDays     in-app renewal alerts N days before the end   ([30, 7])
//   renewalEmail    ALSO e-mail the renewal alert — OFF by default
//   linkDays        how long a new agreement link works        (default 14)
//
// Every new client gets an agreement DRAFT built from these values (POST
// /clients). Changing them never rewrites an existing client's agreement.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'agreementDefaults';
const PLACEHOLDER = 'PLACEHOLDER — waiting for your decision #9: confirm the agreement template text, the fee fields, the guarantee period, who signs for TeamLink, and the e-sign provider.';
const DEFAULTS = {
  feePercent: 8.33,
  guaranteeDays: 30,
  paymentDays: 6,
  // 2026-10-05: the user's "Vendor Services Agreement" (utils/vendorAgreement.js).
  templateName: 'Vendor Services Agreement',
  templateNote: PLACEHOLDER,
  signatoryName: '[Signatory name — to be confirmed]',
  signatoryTitle: '[Signatory title — to be confirmed]',
  esignProvider: 'Later',
  renewalDays: [30, 7],
  renewalEmail: false,
  linkDays: 14,
  // "Make it Active" reminders once the client signed (2026-10-05):
  // the bell to the BDE(s) + Admins + Super Admins at this time, every N days,
  // until it is Active; ALSO an email to those staff only when switched on.
  activeReminderTime: '10:00',
  activeReminderEveryDays: 1,
  activeReminderEmail: false,
};

let cached = null;
let cachedAt = 0;

function parse(row) {
  try { return row && row.value ? JSON.parse(row.value) : {}; } catch { return {}; }
}

function clean(v) {
  const out = { ...DEFAULTS, ...v };
  const fee = Number(out.feePercent);
  out.feePercent = Number.isFinite(fee) && fee > 0 && fee <= 100 ? Math.round(fee * 100) / 100 : DEFAULTS.feePercent;
  const g = Math.round(Number(out.guaranteeDays));
  out.guaranteeDays = Number.isFinite(g) && g >= 0 && g <= 730 ? g : DEFAULTS.guaranteeDays;
  const p = Math.round(Number(out.paymentDays));
  out.paymentDays = Number.isFinite(p) && p >= 0 && p <= 365 ? p : DEFAULTS.paymentDays;
  const days = (Array.isArray(out.renewalDays) ? out.renewalDays : [])
    .map((d) => Math.round(Number(d))).filter((d) => Number.isFinite(d) && d >= 1 && d <= 365);
  out.renewalDays = days.length ? [...new Set(days)].sort((a, b) => b - a).slice(0, 4) : DEFAULTS.renewalDays;
  out.renewalEmail = out.renewalEmail === true;
  const ld = Math.round(Number(out.linkDays));
  out.linkDays = Number.isFinite(ld) && ld >= 1 && ld <= 90 ? ld : DEFAULTS.linkDays;
  out.activeReminderTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(out.activeReminderTime || '')) ? out.activeReminderTime : DEFAULTS.activeReminderTime;
  const ae = Math.round(Number(out.activeReminderEveryDays));
  out.activeReminderEveryDays = Number.isFinite(ae) && ae >= 1 && ae <= 30 ? ae : DEFAULTS.activeReminderEveryDays;
  out.activeReminderEmail = out.activeReminderEmail === true;
  ['templateName', 'templateNote', 'signatoryName', 'signatoryTitle', 'esignProvider'].forEach((k) => {
    out[k] = String(out[k] == null ? '' : out[k]).trim().slice(0, 1000);
  });
  if (!out.templateName) out.templateName = DEFAULTS.templateName;
  // The old stored default "Standard Recruitment / Staffing" means the TeamLink
  // standard, which is now the Vendor Services Agreement.
  {
    // eslint-disable-next-line global-require
    const vendor = require('./vendorAgreement');
    out.templateName = vendor.templateIdOf(out.templateName) === 'STAFFING' ? vendor.STAFFING_TEMPLATE : vendor.VENDOR_TEMPLATE;
  }
  if (!out.esignProvider) out.esignProvider = 'Later';
  return out;
}

async function agreementSettings({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 15000) return cached;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  cached = { ...clean(parse(row)), updatedAt: row ? row.updatedAt : null, updatedByName: row ? row.updatedByName : null };
  cachedAt = Date.now();
  return cached;
}

// Returns { settings, before } or { error } in plain words.
async function saveAgreementSettings(patch, user) {
  const before = await agreementSettings({ fresh: true });
  const next = { ...before };
  delete next.updatedAt; delete next.updatedByName;
  const p = patch || {};
  if (p.feePercent !== undefined) {
    const n = Number(p.feePercent);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return { error: 'The fee must be a number between 0 and 100 (for example 8.33).' };
    next.feePercent = n;
  }
  if (p.guaranteeDays !== undefined) {
    const n = Number(p.guaranteeDays);
    if (!Number.isInteger(n) || n < 0 || n > 730) return { error: 'The guarantee period must be whole days, from 0 to 730.' };
    next.guaranteeDays = n;
  }
  if (p.paymentDays !== undefined) {
    const n = Number(p.paymentDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) return { error: 'Payment days must be whole days, from 0 to 365.' };
    next.paymentDays = n;
  }
  if (p.renewalDays !== undefined) {
    const list = (Array.isArray(p.renewalDays) ? p.renewalDays : String(p.renewalDays).split(/[,\s]+/))
      .filter((x) => String(x).trim() !== '').map(Number);
    if (!list.length || list.some((d) => !Number.isInteger(d) || d < 1 || d > 365)) {
      return { error: 'Renewal alert days must be whole days from 1 to 365, for example "30, 7".' };
    }
    next.renewalDays = list;
  }
  if (p.renewalEmail !== undefined) next.renewalEmail = p.renewalEmail === true;
  if (p.activeReminderTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.activeReminderTime))) return { error: 'The reminder time looks wrong — for example 10:00.' };
    next.activeReminderTime = String(p.activeReminderTime);
  }
  if (p.activeReminderEveryDays !== undefined) {
    const n = Number(p.activeReminderEveryDays);
    if (!Number.isInteger(n) || n < 1 || n > 30) return { error: 'Remind every 1 to 30 days.' };
    next.activeReminderEveryDays = n;
  }
  if (p.activeReminderEmail !== undefined) next.activeReminderEmail = p.activeReminderEmail === true;
  if (p.linkDays !== undefined) {
    const n = Number(p.linkDays);
    if (!Number.isInteger(n) || n < 1 || n > 90) return { error: 'The agreement link must work for 1 to 90 days (for example 14).' };
    next.linkDays = n;
  }
  ['templateName', 'templateNote', 'signatoryName', 'signatoryTitle', 'esignProvider'].forEach((k) => {
    if (p[k] !== undefined) next[k] = p[k];
  });
  const settings = clean(next);
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(settings), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
    update: { value: JSON.stringify(settings), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
  });
  cached = null;
  return { settings: await agreementSettings({ fresh: true }), before };
}

// The text forms the client record stores.
const guaranteeText = (days) => (Number(days) === 0 ? 'No replacement' : `${Number(days)} Days`);
const paymentTermsText = (days) => `Invoice 6 days after joining; payment due within ${Number(days)} days of invoice`;
const paymentDueText = (days) => `${Number(days)} days after invoice`;

// The commercial fields a NEW client's draft starts with.
function draftTermsFrom(s) {
  // eslint-disable-next-line global-require
  const { hasColumn } = require('./clientProfile');
  return {
    agreementFeePercent: s.feePercent,
    guaranteePeriod: guaranteeText(s.guaranteeDays),
    paymentTerms: paymentTermsText(s.paymentDays),
    paymentDue: paymentDueText(s.paymentDays),
    agreementTemplate: s.templateName,
    // The template's own defaults (2026-10-05): invoice 6 days after joining,
    // % of annual CTC, GST 18%.
    invoiceTrigger: 'After joining + 6 days',
    gstPercent: 18,
    ...(hasColumn('feeType') ? { feeType: 'PERCENT_CTC' } : {}),
    ...(hasColumn('gstApplicable') ? { gstApplicable: 'Yes' } : {}),
  };
}

module.exports = {
  KEY, DEFAULTS, PLACEHOLDER, agreementSettings, saveAgreementSettings, draftTermsFrom,
  guaranteeText, paymentTermsText, paymentDueText,
};

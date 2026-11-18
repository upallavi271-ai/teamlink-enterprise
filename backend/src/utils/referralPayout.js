// ---------------------------------------------------------------------------
// REFERRAL PAYOUT ON JOINING (ATS audit 2026-11-18, Q391 / Q404 / Q406 / Q616).
//
// Before: a referral bonus existed only when somebody remembered to type one (Referrals > Record bonus), and nothing happened when the
// referred person joined. Now:
//   RULES   Referrals > "Bonus rules" (Super Admin / Admin / HR): switched on or off, a default amount, and an amount per department
//           (Medical 5,000, IT 3,000 ...). Kept in AppSetting 'referralPayoutRules'.
//   JOINING utils/joining.js onApplicationJoined() calls onJoined(): every referral of that candidate for that job (or with no job named)
//           that has no bonus yet gets the rule's amount PROPOSED automatically, and the Super Admin is asked to approve it - the same
//           approval as a typed bonus (routes/sourcing.js /referrals/:id/bonus/decide). With no amount in the rules, HR and the Super
//           Admin are told that a referred person joined and a bonus amount is waiting. Nothing is ever paid or approved automatically.
// Never throws: a joining must never fail because of a referral.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { notifyUsers } = require('./notify');
const { logAudit } = require('./audit');

const KEY = 'referralPayoutRules';
const DEFAULTS = { enabled: true, defaultAmount: 0, byDepartment: {} };
let cached = null; let cachedAt = 0;

const money = (v) => { const n = Math.round(Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''))); return Number.isFinite(n) && n > 0 ? Math.min(n, 1000000) : 0; };
function clean(v) {
  const o = v && typeof v === 'object' ? v : {};
  const by = {};
  Object.entries(o.byDepartment && typeof o.byDepartment === 'object' ? o.byDepartment : {}).forEach(([k, amt]) => {
    const name = String(k || '').trim().slice(0, 60);
    const n = money(amt);
    if (name && n) by[name] = n;
  });
  return { enabled: o.enabled !== false, defaultAmount: money(o.defaultAmount), byDepartment: by };
}

async function rules({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 15000) return cached;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let parsed = DEFAULTS;
  try { parsed = row ? JSON.parse(row.value) : DEFAULTS; } catch { parsed = DEFAULTS; }
  cached = { ...clean(parsed), updatedAt: row ? row.updatedAt : null, updatedByName: row ? row.updatedByName : null };
  cachedAt = Date.now();
  return cached;
}

async function saveRules(input, user) {
  const settings = clean(input);
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(settings), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
    update: { value: JSON.stringify(settings), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
  });
  cached = null;
  await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: 'Referral bonus rules saved', entity: 'AppSetting', entityId: KEY, toValue: JSON.stringify(settings).slice(0, 300) }).catch(() => {});
  return rules({ fresh: true });
}

// the amount for one department (spellings like Educational / Education count as one), else the default
function amountFor(r, department) {
  const d = String(department || '').trim().toLowerCase();
  const hit = Object.entries(r.byDepartment || {}).find(([k]) => { const kk = k.toLowerCase(); return d && (kk === d || kk.startsWith(d.slice(0, 5)) || d.startsWith(kk.slice(0, 5))); });
  return hit ? hit[1] : (r.defaultAmount || 0);
}

async function admins(roles) {
  const users = await prisma.user.findMany({ where: { OR: [{ role: { in: roles } }, { atsRole: { in: roles } }, { hrmsRole: { in: roles } }] }, select: { id: true, name: true, email: true } }).catch(() => []);
  return users.filter((u) => !/zztest|example\.test/i.test(`${u.name} ${u.email}`)).map((u) => u.id);
}

async function onJoined({ applicationId, userId = null }) {
  try {
    const r = await rules();
    if (!r.enabled) return { skipped: 'rules off' };
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true, candidateId: true, requirementId: true, candidate: { select: { name: true } }, requirement: { select: { title: true, department: true } } },
    });
    if (!app) return null;
    const refs = await prisma.candidateReferral.findMany({
      where: {
        candidateId: app.candidateId,
        bonusStatus: null,
        OR: [{ applicationId: app.id }, { requirementId: app.requirementId }, { requirementId: null, applicationId: null }],
      },
    });
    if (!refs.length) return { referrals: 0 };
    const amount = amountFor(r, app.requirement && app.requirement.department);
    const who = (app.candidate && app.candidate.name) || 'A referred candidate';
    const job = (app.requirement && app.requirement.title) || 'a job';
    let proposed = 0;
    for (const ref of refs) {
      if (amount > 0) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.candidateReferral.update({
          where: { id: ref.id },
          data: {
            bonusAmount: amount, bonusStatus: 'PROPOSED', bonusNote: `Proposed automatically when ${who} joined (${job}), from the bonus rules.`,
            bonusProposedById: userId, bonusProposedByName: 'Bonus rules (automatic)', bonusProposedAt: new Date(),
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await logAudit({ userId, actorName: 'Bonus rules (automatic)', action: 'Referral bonus proposed on joining', entity: 'CandidateReferral', entityId: ref.id, toValue: `₹${amount} for ${ref.referrerName}` }).catch(() => {});
        proposed += 1;
      }
    }
    if (proposed) {
      await notifyUsers(await admins(['SUPER_ADMIN']), { title: 'Referral bonus to approve', message: `${who} joined (${job}). ₹${amount.toLocaleString('en-IN')} for ${refs.map((x) => x.referrerName).join(', ')} is waiting for your approval in Referrals.` }).catch(() => {});
    } else {
      await notifyUsers(await admins(['SUPER_ADMIN', 'HR', 'ADMIN']), { title: 'Referred candidate joined', message: `${who} joined (${job}), referred by ${refs.map((x) => x.referrerName).join(', ')}. No bonus amount is set in the bonus rules: record one in Referrals.` }).catch(() => {});
    }
    return { referrals: refs.length, proposed, amount };
  } catch (err) {
    console.error('[referral-payout]', err.message); // eslint-disable-line no-console
    return null;
  }
}

module.exports = { rules, saveRules, onJoined, amountFor, KEY };

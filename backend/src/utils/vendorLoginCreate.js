// ---------------------------------------------------------------------------
// CREATE A VENDOR LOGIN IN ONE TRANSACTION (2026-10-14).
// Press "Create login" and ALL of this is saved together or none of it:
//   the login (vendorId, status), its modules + permission ticks, its asset access (and the asset -> vendor links the
//   admin ticked knowingly), the single-use secure invite link, and the WELCOME EMAIL ATTEMPT row (utils/vendorMail.js claimAttempt).
//   If any step fails, nothing is left behind - and no email is sent, because the email is sent by the caller only AFTER this commits.
// Everything inside uses the transaction client (SQLite has one writer: a second connection would wait for it).
// Audit rows are written by the caller AFTER the commit. `hooks` exist for the tests (they throw to prove the rollback).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const VP = require('./vendorPortal');
const VC = require('./vendorConfig');
const INV = require('./vendorInvite');
const VM = require('./vendorModules');
const MAIL = require('./vendorMail');

async function createLoginAtomic(a, hooks = {}) {
  // The password is a random value nobody ever sees: the vendor chooses their own through the secure link.
  // With an invitation the new login gets a TEMPORARY PASSWORD (utils/vendorMail.js generateTempPassword): only its bcrypt hash is stored; the
  // plain text goes back to the caller in memory, for the one welcome email. Without an invitation, a random value nobody sees.
  const tempPassword = a.invite !== false ? MAIL.generateTempPassword({ email: a.email, name: a.name }) : null;
  const passwordHash = await bcrypt.hash(tempPassword || crypto.randomBytes(48).toString('base64url'), 10);
  await MAIL.ensure(); // the email-attempt table (self-provisioned) must exist before the transaction starts
  const tempExpiry = new Date(Date.now() + VC.CFG.tempPasswordDays * 86400000);
  return prisma.$transaction(async (tx) => {
    const vu = await tx.vendorUser.create({
      data: {
        vendorId: a.vendor.id, name: a.name, email: a.email, passwordHash, status: a.status,
        canEdit: a.canEdit === true, canViewCost: a.canViewCost === true, mustChangePassword: true, tempPasswordExpiresAt: tempExpiry, createdById: a.user ? a.user.id : null,
      },
    });
    if (a.modules) await VM.saveModules(vu.id, a.modules.keys, a.modules.perms, tx);
    if (hooks.afterModules) await hooks.afterModules(vu, tx);
    const linked = [];
    for (const asset of a.toLink || []) {
      // eslint-disable-next-line no-await-in-loop
      const cur = await tx.asset.findUnique({ where: { id: asset.id } });
      if (!cur || cur.vendorId) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await tx.asset.update({ where: { id: asset.id }, data: { vendorId: a.vendor.id, history: VP.pushAssetHistory(cur.history, a.actorName, `Linked to vendor ${a.vendor.name} (vendor master)`) } });
      linked.push(asset.id);
    }
    await tx.vendorAssetAccess.deleteMany({ where: { vendorUserId: vu.id } });
    for (const assetId of a.assetIds || []) await tx.vendorAssetAccess.create({ data: { vendorUserId: vu.id, assetId } }); // eslint-disable-line no-await-in-loop
    for (const category of a.categories || []) await tx.vendorAssetAccess.create({ data: { vendorUserId: vu.id, category } }); // eslint-disable-line no-await-in-loop
    if (hooks.afterAccess) await hooks.afterAccess(vu, tx);
    let link = null;
    let attempt = null;
    if (a.invite !== false) {
      link = await INV.createLink(vu.id, 'invite', a.user, tx);
      await tx.vendorUser.update({ where: { id: vu.id }, data: { tempPasswordExpiresAt: link.expiresAt } });
      // The ONE welcome-email attempt of this new login (its unique key is the "one email per attempt" guard).
      attempt = (await MAIL.claimAttempt({ vu, kind: 'invite', toEmail: vu.email, tokenId: link.id, linkExpiresAt: link.expiresAt, actor: a.user, via: 'admin', idemKey: a.idemKey || '', credMark: MAIL.credMark(vu.id, tempPassword) }, tx)).row;
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(vu, tx);
    return { vu, link, linked, attempt, tempPassword };
  }, { timeout: 30000, maxWait: 10000 });
}

module.exports = { createLoginAtomic };

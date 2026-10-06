// ---------------------------------------------------------------------------
// TEAMLINK'S SAVED SIGNATURE + COMPANY STAMP (2026-10-05).
//
// Set once by a Super Admin / Admin (Agreement settings → "TeamLink signature
// & stamp"), then used by default on every agreement: when a link is made
// (pre-signed) and, if still missing, when the client signs (countersign).
// Per agreement it can still be done by hand ("Sign & stamp for TeamLink" on
// the client's Agreement card — routes/agreementSeal.js company-seal).
//
// Stored in AppSetting key "agreementTeamlinkSeal" (no schema change):
//   { signFile, signMethod, signedBy, signedByTitle, stampFile, updatedAt, updatedByName }
// The files live in the upload store (utils/attachments.js). Each agreement
// gets its OWN COPY of the images, so voiding / regenerating one agreement
// (which removes that agreement's files) never touches the saved defaults.
// ---------------------------------------------------------------------------
const fs = require('fs');
const prisma = require('../db');
const attachments = require('./attachments');
const { logAudit } = require('./audit');

const KEY = 'agreementTeamlinkSeal';

async function getSeal() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  try { return row && row.value ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function saveSeal(patch, user) {
  const now = { ...(await getSeal()), ...patch, updatedAt: new Date().toISOString(), updatedByName: user ? user.name || null : null };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(now), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
    update: { value: JSON.stringify(now), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
  });
  return now;
}
function summary(s) {
  return {
    hasSign: !!(s.signFile && attachments.resolveStored(s.signFile)),
    hasStamp: !!(s.stampFile && attachments.resolveStored(s.stampFile)),
    signMethod: s.signMethod || null,
    signedBy: s.signedBy || null,
    signedByTitle: s.signedByTitle || null,
    updatedAt: s.updatedAt || null,
    updatedByName: s.updatedByName || null,
  };
}

// A private copy of a stored image for one agreement.
function copyStored(stored) {
  const file = stored ? attachments.resolveStored(stored) : null;
  if (!file) return null;
  const ext = (stored.match(/\.(png|jpg|webp)$/i) || [])[1];
  const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[String(ext || '').toLowerCase()];
  if (!type) return null;
  return attachments.store({ data: fs.readFileSync(file), contentType: type, filename: `teamlink-${ext}` }).billFile;
}

// Puts the saved TeamLink signature and / or stamp on a client's agreement
// where that side is still missing. Returns the fields written ({} = none).
async function applyDefaults(client, { actorUserId = null, via = 'saved TeamLink signature & stamp' } = {}) {
  if (!client || !client.agreementDocument) return {};
  const s = await getSeal();
  // eslint-disable-next-line global-require
  const us = await require('./agreement').consultantParty();
  const data = {};
  if (!client.agreementCompanySignFile && s.signFile) {
    const f = copyStored(s.signFile);
    if (f) {
      data.agreementCompanySignFile = f;
      data.agreementCompanySignName = s.signMethod || 'Saved TeamLink signature';
      data.agreementCompanySignedBy = us.signatoryName || s.signedBy || client.agreementCompanySignedBy || null;
      data.agreementCompanySealedAt = new Date();
    }
  }
  if (!client.agreementCompanyStampFile && s.stampFile) {
    const f = copyStored(s.stampFile);
    if (f) { data.agreementCompanyStampFile = f; data.agreementCompanyStampName = 'Company stamp'; }
  }
  if (!Object.keys(data).length) return {};
  await prisma.client.update({ where: { id: client.id }, data });
  await logAudit({
    userId: actorUserId, action: 'TeamLink countersign / seal applied', entity: 'Client', entityId: client.id,
    reason: `${[data.agreementCompanySignFile && 'signature', data.agreementCompanyStampFile && 'company stamp'].filter(Boolean).join(' + ')} from the ${via}`,
  });
  return data;
}

module.exports = { KEY, getSeal, saveSeal, summary, applyDefaults, copyStored };

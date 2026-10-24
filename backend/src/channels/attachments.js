// ---------------------------------------------------------------------------
// ATTACHMENTS for a WhatsApp message sent from the ATS: the candidate's resume or an offer letter PDF.
// The browser only names WHAT to attach ({ type: 'resume' | 'offer', ... }); the server finds the file itself, so a
// request can never point at an arbitrary path. One person at a time (never in a bulk send).
//
//   resolve(user, personId, specs) -> { media: [{ path, name, mime, label }] } | { error }
// ---------------------------------------------------------------------------
const prisma = require('../db');
const resumeStore = require('../utils/resumeStore');
const attachments = require('../utils/attachments');

const MAX_FILES = 1;

async function resolve(user, personId, specs) {
  const list = (Array.isArray(specs) ? specs : []).filter(Boolean).slice(0, MAX_FILES);
  const media = [];
  for (const spec of list) {
    if (spec.type === 'resume') {
      // eslint-disable-next-line no-await-in-loop
      const rows = await prisma.candidateResume.findMany({ where: { candidateId: String(personId), hiddenAt: null }, orderBy: { createdAt: 'desc' } });
      const pick = (spec.resumeId && rows.find((r) => r.id === spec.resumeId)) || rows.find((r) => r.kind === 'EDITED' && r.file) || rows.find((r) => r.kind === 'ORIGINAL' && r.file);
      if (!pick) return { error: 'This candidate has no resume file to attach.' };
      const full = resumeStore.resolveResumeFile(pick.file);
      if (!full) return { error: 'The resume file is missing on the server.' };
      media.push({ path: full, name: pick.kind === 'ORIGINAL' ? (pick.fileName || 'resume.pdf') : `${(pick.fileName || 'Resume').replace(/\.[a-z0-9]+$/i, '')}.pdf`, mime: pick.kind === 'ORIGINAL' ? (pick.mime || 'application/pdf') : 'application/pdf', label: 'Resume' });
    } else if (spec.type === 'offer') {
      // eslint-disable-next-line no-await-in-loop
      const v = await prisma.offerVersion.findFirst({ where: { applicationId: String(spec.applicationId || ''), application: { candidateId: String(personId) }, pdfFile: { not: null } }, orderBy: { version: 'desc' } });
      if (!v) return { error: 'There is no offer letter file to attach for this person.' };
      const full = attachments.resolveStored(v.pdfFile);
      if (!full) return { error: 'The offer letter file is missing on the server.' };
      media.push({ path: full, name: `Offer letter v${v.version}.pdf`, mime: 'application/pdf', label: 'Offer letter' });
    } else {
      return { error: 'That kind of file cannot be attached.' };
    }
  }
  return { media };
}

module.exports = { resolve, MAX_FILES };

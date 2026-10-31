// ---------------------------------------------------------------------------
// TEAMLINK SIGNS FIRST, for the tests (founder 2026-10-31: "TeamLink vallu eSign cheyyali kadha first").
// Send to client needs TeamLink's valid DigiLocker copy on file. A test cannot make a real Aadhaar eSign, so
// add(clientId) puts a stand-in: a tiny PDF in the sandbox upload folder plus the "valid eSign" note the upload
// check would write. removeAll() deletes every row and file it made. SANDBOX ONLY (the caller has checked that).
// ---------------------------------------------------------------------------
const os = require('os');
const path = require('path');

const KIND = 'TeamLink eSigned copy (DigiLocker)';

module.exports = function teamlinkSigned(prisma) {
  // the sandbox server keeps its uploads here (scripts/sandbox.js)
  if (!process.env.UPLOAD_DIR) process.env.UPLOAD_DIR = path.join(process.env.TEAMLINK_SANDBOX_FILES || path.join(os.homedir() || os.tmpdir(), '.teamlink-sandbox'), 'uploads');
  const att = require('../../src/utils/attachments'); // eslint-disable-line global-require
  const made = { docs: [], files: [] };
  return {
    async add(clientId) {
      const st = att.store({ contentType: 'application/pdf', filename: 'ZZTEST-teamlink-signed.pdf', data: Buffer.from('%PDF-1.4\n% ZZTEST stand-in for a TeamLink DigiLocker copy\n%%EOF\n') });
      made.files.push(st.billFile);
      const d = await prisma.clientDocument.create({
        data: { clientId, kind: 'AGREEMENT_SIGNED', name: KIND, fileStored: st.billFile, fileName: st.billName, fileMime: st.billMime, fileSize: st.billSize },
      });
      made.docs.push(d.id);
      await prisma.appSetting.create({ data: { key: `agrsigned.${d.id}`, value: JSON.stringify({ label: KIND, kind: KIND, esign: { valid: true, signer: 'ZZTEST signer' } }) } });
      return d.id;
    },
    async removeAll() {
      if (made.docs.length) {
        await prisma.appSetting.deleteMany({ where: { key: { in: made.docs.map((id) => `agrsigned.${id}`) } } }).catch(() => null);
        await prisma.clientDocument.deleteMany({ where: { id: { in: made.docs } } }).catch(() => null);
      }
      made.files.forEach((f) => att.remove(f));
    },
  };
};

// ---------------------------------------------------------------------------
// Vendor file helpers shared by the staff routes (routes/vendorMaster.js) and
// the vendor portal: PDF / JPG / PNG only, size cap, magic-byte check and a
// random stored name inside the private upload folder (utils/attachments.js).
// ---------------------------------------------------------------------------
const attachments = require('./attachments');
const VC = require('./vendorConfig');

const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const FILE_MESSAGE = {
  NO_FILE: 'Choose the file to upload.',
  TOO_LARGE: `That file is bigger than ${Math.round(VC.CFG.uploadMaxBytes / 1048576)} MB. Please upload a smaller PDF or photo.`,
  BAD_TYPE: 'Only a PDF, JPG or PNG file can be uploaded.',
  CONTENT_MISMATCH: "That file doesn't look like a real PDF or photo. Please choose the original file.",
  NOT_MULTIPART: 'Could not read the upload. Please try again.',
};
const fileError = (err) => FILE_MESSAGE[err && err.code] || 'Could not save the file. Please try again.';

async function readUpload(req) {
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('NOT_MULTIPART'), { code: 'NOT_MULTIPART' });
  }
  return attachments.parseMultipart(req, { maxBytes: VC.CFG.uploadMaxBytes });
}
function storeFile(file) {
  if (!file || !file.data || !file.data.length) throw Object.assign(new Error('NO_FILE'), { code: 'NO_FILE' });
  if (!FILE_TYPES[file.contentType]) throw Object.assign(new Error('BAD_TYPE'), { code: 'BAD_TYPE' });
  if (!/\.(pdf|jpe?g|png)$/i.test(String(file.filename || ''))) throw Object.assign(new Error('BAD_TYPE'), { code: 'BAD_TYPE' });
  return attachments.store(file, { maxBytes: VC.CFG.uploadMaxBytes });
}
function sendStored(res, file, mime, name) {
  const full = attachments.resolveStored(file);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server.' });
  res.setHeader('Content-Type', attachments.ALLOWED[mime] ? mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(name)}"`);
  return res.sendFile(full);
}
module.exports = { FILE_TYPES, fileError, readUpload, storeFile, sendStored };

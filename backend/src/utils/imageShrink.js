// ---------------------------------------------------------------------------
// SIGNATURE / STAMP IMAGES KEPT SMALL (2026-10-05): at most 600 px on the
// long side, flattened on white, as a compact PNG. Used when an agreement
// image is stored (routes/agreementSeal.js readUpload) and when the PDF
// embeds one (utils/agreementPdf.js), so a signed PDF stays well under 1 MB
// even when the upload was a 10-megapixel phone photo.
// ---------------------------------------------------------------------------
const fs = require('fs');

const MAX = 600;

// A buffer -> a small PNG buffer (or the original buffer if sharp cannot read it).
async function shrinkBuffer(buf) {
  if (!buf) return buf;
  try {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    return await sharp(buf)
      .rotate()
      .resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer();
  } catch { return buf; }
}

// Shrinks a stored PNG / JPG file in place (its name and type stay the same:
// a .jpg is written back as JPEG).
async function shrinkFile(file) {
  if (!file || !/\.(png|jpe?g)$/i.test(file) || !fs.existsSync(file)) return;
  try {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    const img = sharp(fs.readFileSync(file)).rotate()
      .resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' });
    const out = /\.png$/i.test(file) ? await img.png({ palette: true, compressionLevel: 9 }).toBuffer() : await img.jpeg({ quality: 82 }).toBuffer();
    if (out.length < fs.statSync(file).size) fs.writeFileSync(file, out);
  } catch { /* keep the original */ }
}

module.exports = { shrinkBuffer, shrinkFile, MAX };

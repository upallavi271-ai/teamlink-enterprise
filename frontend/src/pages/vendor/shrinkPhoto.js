// ---------------------------------------------------------------------------
// PHOTOS OF BILLS ARE MADE SMALL BEFORE THEY ARE SENT (founder 2026-10-28: "assets bills dhi photos upload cheyanikii ravadam ledhu").
//
// A phone photo is often 5-15 MB, or HEIC (iPhone / some Samsung phones). That was refused (over 10 MB, "only JPG, PNG, WebP"), and a
// bill of several pages could pass the web server's request size limit. Every PHOTO is now redrawn in the browser as a JPG of at most
// 2200 px on its long side (a bill stays easy to read; about 0.3-1 MB). A PDF is sent as it is. A HEIC photo is converted when the
// browser can open it (Safari can); when it cannot, the person gets a plain way out.
// ---------------------------------------------------------------------------
const MAX_SIDE = 2200;
const QUALITY = 0.82;
const IMAGE_NAME = /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i;

export const isPhoto = (f) => /^image\//i.test(f.type || '') || IMAGE_NAME.test(f.name || '');

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot open')); };
    img.src = url;
  });
}

// File -> Promise<File> (a JPG). Throws { heic: true } when the browser cannot open a HEIC photo.
export async function shrinkPhoto(file) {
  if (!isPhoto(file)) return file;
  const heic = /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
  let img;
  try { img = await loadImage(file); } catch { throw Object.assign(new Error(heic ? 'heic' : 'unreadable'), { heic, unreadable: !heic }); }
  const w = img.naturalWidth || img.width; const h = img.naturalHeight || img.height;
  // already small and already a JPG / PNG / WebP the server takes: keep it as it is
  if (!heic && file.size <= 1.5 * 1048576 && Math.max(w, h) <= MAX_SIDE && /^image\/(jpeg|png|webp)$/i.test(file.type || '')) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // a PNG with see-through parts stays readable
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) return file;
  const base = String(file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
}

// Many files: [File] -> { files, problems } (each photo made small; a photo that cannot be opened is listed with a plain reason).
export async function shrinkAll(list) {
  const files = []; const problems = [];
  for (const f of list) {
    try { files.push(await shrinkPhoto(f)); } // eslint-disable-line no-await-in-loop
    catch (e) {
      problems.push(e && e.heic
        ? `${f.name}: this phone photo type (HEIC) cannot be opened here. Use "Take a photo", or set the phone camera to JPG ("Most compatible") and try again.`
        : `${f.name}: this file could not be opened as a photo.`);
    }
  }
  return { files, problems };
}

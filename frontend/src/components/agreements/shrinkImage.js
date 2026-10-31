// ---------------------------------------------------------------------------
// A stamp / signature picture made small IN THE BROWSER before it is uploaded (2026-10-31: a phone photo of the TeamLink stamp
// was refused on the live server - "The stamp could not be saved" - a large upload is stopped before it reaches TeamLink).
// The server keeps these at 600 px anyway (utils/imageShrink.js), so nothing is lost: the longest side becomes `max` px, PNG
// (a transparent background stays transparent). A small picture goes as it is. If the browser cannot read it, the original goes.
// ---------------------------------------------------------------------------
export default async function shrinkImage(file, { max = 800, keepUnder = 400 * 1024 } = {}) {
  if (!file || !/^image\/(png|jpe?g)$/i.test(file.type || '') ) return file;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    URL.revokeObjectURL(url);
    const big = Math.max(img.naturalWidth, img.naturalHeight);
    if (big <= max && file.size <= keepUnder) return file;
    const k = Math.min(1, max / big);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) return file;
    const name = String(file.name || 'stamp').replace(/\.(png|jpe?g)$/i, '') || 'stamp';
    return new File([blob], `${name}.png`, { type: 'image/png' });
  } catch {
    return file;
  }
}

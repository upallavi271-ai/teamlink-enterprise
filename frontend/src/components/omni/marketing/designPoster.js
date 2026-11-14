// DESIGNED PICTURES (2026-11-14): a finished picture made in the browser, free, with no paid picture AI: a real stock photo (or the brand colours) behind your heading and words, the
// logo, and a call to action. Used by "Create from your content" in AI Video and AI Images. Pure canvas, no network: the caller hands in the images it already loaded.
export const SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080], '3:4': [1080, 1440] };
const FONT = '"Segoe UI", "Nirmala UI", "Noto Sans", "Noto Sans Telugu", "Noto Sans Devanagari", Roboto, Helvetica, Arial, sans-serif';
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (c, d) => (HEX.test(c || '') ? c : d);
const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

// the lines of a text that fit `maxW` (words are never cut; a word wider than the line goes on its own line)
function wrap(ctx, text, maxW) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = []; let cur = '';
  words.forEach((w) => { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } });
  if (cur) lines.push(cur);
  return lines;
}
// the biggest font size (from `max` down to `min`) at which `text` fits in `maxLines` lines
function fit(ctx, text, weight, max, min, maxW, maxLines) {
  for (let s = max; s >= min; s -= 4) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    const l = wrap(ctx, text, maxW);
    if (l.length <= maxLines) return { size: s, lines: l };
  }
  ctx.font = `${weight} ${min}px ${FONT}`;
  return { size: min, lines: wrap(ctx, text, maxW).slice(0, maxLines) };
}
function cover(ctx, img, W, H) {
  const r = Math.max(W / img.width, H / img.height); const w = img.width * r; const h = img.height * r;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}
const pill = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };

// o: { aspect, bg (a loaded image or null), colors { primary, secondary, accent }, logo (a loaded image or null), heading, line, cta, footer, index, total }
// -> Promise<Blob> (a JPEG)
export function designPoster(o) {
  const [W, H] = SIZES[o.aspect] || SIZES['1:1'];
  const portrait = H > W * 1.1; const wide = W > H * 1.1;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const c1 = hex(o.colors && o.colors.primary, '#0f766e'); const c2 = hex(o.colors && o.colors.secondary, '#134e4a'); const acc = hex(o.colors && o.colors.accent, '#f59e0b');
  // 1 the background: the photo, or the brand colours (the angle changes with the scene so a set of pictures does not look the same)
  if (o.bg) cover(ctx, o.bg, W, H);
  else { const k = (o.index || 0) % 3; const g = k === 0 ? ctx.createLinearGradient(0, 0, W, H) : k === 1 ? ctx.createLinearGradient(W, 0, 0, H) : ctx.createLinearGradient(0, H, W, 0); g.addColorStop(0, c1); g.addColorStop(1, c2); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  // 2 a brand-coloured veil, darker at the bottom, so the words can be read on any photo
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, rgba(c2, o.bg ? 0.45 : 0.1)); v.addColorStop(0.55, rgba(c2, o.bg ? 0.55 : 0.2)); v.addColorStop(1, 'rgba(6,12,10,0.82)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = acc; ctx.fillRect(0, 0, Math.round(W * 0.018), H); // the accent bar
  const pad = Math.round(W * 0.075); const maxW = W - pad * 2 - Math.round(W * 0.01);
  // 3 the logo, on a white pill (a logo is drawn for a light page)
  let topY = pad;
  if (o.logo && o.logo.width) {
    const lh = Math.round((portrait ? H : W) * (portrait ? 0.05 : 0.09)); const lw = Math.min(Math.round(W * 0.5), Math.round((o.logo.width / o.logo.height) * lh));
    ctx.fillStyle = 'rgba(255,255,255,0.96)'; pill(ctx, pad, topY, lw + 36, lh + 24, 18); ctx.fill();
    ctx.drawImage(o.logo, pad + 18, topY + 12, lw, lh);
    topY += lh + 24 + Math.round(H * 0.02);
  }
  if (o.total > 1) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = `700 ${Math.round(W * 0.028)}px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText(`${(o.index || 0) + 1} / ${o.total}`, W - pad, topY - Math.round(H * 0.012)); ctx.textAlign = 'left'; }
  // 4 the words, in the middle of what is left
  const hasLine = !!String(o.line || '').trim();
  const hFit = fit(ctx, o.heading, '800', Math.round(W * (wide ? 0.07 : 0.095)), Math.round(W * 0.04), maxW, wide ? 3 : 5);
  const lFit = hasLine ? fit(ctx, o.line, '500', Math.round(W * 0.052), Math.round(W * 0.032), maxW, wide ? 3 : 6) : { size: 0, lines: [] };
  const hLH = Math.round(hFit.size * 1.18); const lLH = Math.round(lFit.size * 1.4); const gap = hasLine ? Math.round(H * 0.03) : 0;
  const block = hFit.lines.length * hLH + gap + lFit.lines.length * lLH;
  const ctaH = o.cta ? Math.round(W * 0.095) : 0;
  const footH = o.footer ? Math.round(W * 0.05) : 0;
  const bottom = H - pad - footH - (footH ? Math.round(H * 0.012) : 0) - ctaH - (ctaH ? Math.round(H * 0.035) : 0);
  let y = Math.max(topY, Math.round(topY + (bottom - topY - block) / 2));
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 14;
  ctx.font = `800 ${hFit.size}px ${FONT}`; hFit.lines.forEach((l) => { y += hLH; ctx.fillText(l, pad, y - Math.round(hLH * 0.2)); });
  y += gap;
  if (hasLine) { ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.font = `500 ${lFit.size}px ${FONT}`; lFit.lines.forEach((l) => { y += lLH; ctx.fillText(l, pad, y - Math.round(lLH * 0.25)); }); }
  ctx.shadowBlur = 0;
  // 5 the call to action and the footer
  let by = H - pad;
  if (footH) { ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.font = `600 ${Math.round(W * 0.03)}px ${FONT}`; ctx.fillText(String(o.footer).slice(0, 90), pad, by); by -= footH + Math.round(H * 0.012); }
  if (ctaH) {
    ctx.font = `800 ${Math.round(W * 0.04)}px ${FONT}`; const tw = Math.min(maxW, Math.round(ctx.measureText(String(o.cta)).width) + Math.round(W * 0.09));
    ctx.fillStyle = acc; pill(ctx, pad, by - ctaH, tw, ctaH, ctaH / 2); ctx.fill();
    ctx.fillStyle = '#10211a'; ctx.textBaseline = 'middle'; ctx.fillText(String(o.cta), pad + Math.round(W * 0.045), by - ctaH / 2 + 2); ctx.textBaseline = 'alphabetic';
  }
  return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be drawn.'))), 'image/jpeg', 0.92));
}

// an image from a Blob (or a data address), loaded and ready to draw
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    const img = new Image();
    img.onload = () => { if (src instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 5000); resolve(img); };
    img.onerror = () => { if (src instanceof Blob) URL.revokeObjectURL(url); reject(new Error('A picture could not be loaded.')); };
    img.src = url;
  });
}

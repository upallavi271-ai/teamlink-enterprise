// ---------------------------------------------------------------------------
// AI MARKETING > BANNERS (2026-11-21). Founder: "banners must not be simple: they must be complete, at a professional level".
// A banner is DESIGNED here, not generated at random: a layout made like a designer would (a brand-colour gradient with shapes, a big headline that is fitted to the space, a
// sub-line, an offer badge, a call-to-action button, the logo on a plate, a contact strip), optionally over a PICTURE (an AI picture, a product photo, anything uploaded). Free: sharp
// (libvips, with Pango for the text so Telugu / Hindi shape correctly when the server has a Telugu / Devanagari font) and no AI service, so it costs nothing and is the same every time.
//   layouts   split (words on a colour panel, picture on the side) | overlay (full picture, dark gradient, words low-left) | bold (colour gradient and shapes, centred words, no picture needed) | offer (a big
//             offer badge beside the words)
//   sizes     1920x1080 / 1280x720 (16:9: web, YouTube, LinkedIn, Facebook link), 1080x1080 (square), 1080x1350 (4:5 Instagram), 1080x1920 (9:16 Story)
//   then      a banner is saved like any picture (draft -> approval -> approved: stored, public link, picked in a campaign, sent, counted)
// Pure function: makeBanner(spec) -> PNG Buffer. Nothing is stored here.
// ---------------------------------------------------------------------------
const path = require('path');
const sharp = require('sharp');

const FONT_BOLD = path.join(__dirname, '..', '..', 'assets', 'fonts', 'LiberationSans-Bold.ttf');
const FONT_REG = path.join(__dirname, '..', '..', 'assets', 'fonts', 'LiberationSans-Regular.ttf');
const SIZES = {
  '16:9': { w: 1920, h: 1080, label: 'Web / YouTube / LinkedIn (16:9)' },
  '1:1': { w: 1080, h: 1080, label: 'Square (1:1)' },
  '4:5': { w: 1080, h: 1350, label: 'Instagram portrait (4:5)' },
  '9:16': { w: 1080, h: 1920, label: 'Story / Reel cover (9:16)' },
};
const LAYOUTS = { split: 'Split: words and picture side by side', overlay: 'Overlay: full picture with the words on it', bold: 'Bold: brand colours and shapes (no picture needed)', offer: 'Offer: a big badge with the offer' };
const HEX = /^#[0-9a-f]{6}$/i;
const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (t, n) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, n);
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
const readable = (bg) => (lum(bg) > 0.3 ? '#111827' : '#ffffff'); // text colour that stays readable on a colour
const mix = (a, b, t) => { const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; const x = p(a); const y = p(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; };

// a block of text as a transparent PNG, wrapped at `width`; its size is read back so the layout can be fitted
async function textPng(text, { size, color = '#ffffff', bold = true, width, align = 'left', spacing = 0 }) {
  const markup = `<span foreground="${color}" letter_spacing="${Math.round(spacing * 1024)}">${esc(text)}</span>`;
  const buf = await sharp({ text: { text: markup, font: `Liberation Sans ${bold ? 'Bold ' : ''}${size}`, fontfile: bold ? FONT_BOLD : FONT_REG, width: Math.max(40, Math.round(width)), rgba: true, wrap: 'word', align, spacing: Math.round(size * 0.12) } }).png().toBuffer();
  const m = await sharp(buf).metadata();
  return { buf, w: m.width, h: m.height };
}
// the biggest font size (down to `min`) at which the text fits `maxH` high in `width`
async function fit(text, { max, min, width, maxH, color, bold = true, align = 'left' }) {
  let size = max;
  let t = await textPng(text, { size, color, bold, width, align });
  while (t.h > maxH && size > min) { size = Math.max(min, Math.floor(size * 0.9)); t = await textPng(text, { size, color, bold, width, align }); } // eslint-disable-line no-await-in-loop
  return { ...t, size };
}
const svg = (w, h, inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`);

async function cover(buf, w, h) { return sharp(buf).rotate().resize({ width: w, height: h, fit: 'cover', position: 'attention' }).png().toBuffer(); }
async function roundCorners(buf, w, h, r) { return sharp(buf).composite([{ input: svg(w, h, `<rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/>`), blend: 'dest-in' }]).png().toBuffer(); }

/**
 * spec: { size ('16:9'|'1:1'|'4:5'|'9:16'), layout, headline, sub, cta, badge (a short offer text, e.g. "30% OFF"), footer (contact line), colors { primary, secondary, accent }, logo (Buffer), photo (Buffer), brandName }
 * -> { buf (PNG), w, h }
 */
async function makeBanner(spec = {}) {
  const sz = SIZES[spec.size] || SIZES['1:1'];
  const { w, h } = sz;
  const layout = LAYOUTS[spec.layout] ? spec.layout : (spec.photo ? 'overlay' : 'bold');
  const c = spec.colors || {};
  const primary = HEX.test(c.primary || '') ? c.primary : '#0f766e';
  const secondary = HEX.test(c.secondary || '') ? c.secondary : mix(primary, '#000000', 0.45);
  const accent = HEX.test(c.accent || '') ? c.accent : '#f59e0b';
  const headline = clean(spec.headline, 90) || clean(spec.brandName, 40) || 'Your headline';
  const sub = clean(spec.sub, 160); const cta = clean(spec.cta, 28); const badge = clean(spec.badge, 18); const footer = clean(spec.footer, 90);
  const m = Math.round(Math.min(w, h) * 0.07); // margin
  const tall = h > w * 1.15; const wide = w > h * 1.3;
  const layers = [];

  // ---- background ----
  const grad = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient>
    <radialGradient id="r" cx="0.85" cy="0.1" r="0.8"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#r)"/>`;
  const shapes = `<circle cx="${w * 0.92}" cy="${h * 0.12}" r="${Math.min(w, h) * 0.34}" fill="${accent}" fill-opacity="0.16"/><circle cx="${w * 0.06}" cy="${h * 0.96}" r="${Math.min(w, h) * 0.26}" fill="#ffffff" fill-opacity="0.07"/>
    <path d="M0 ${h * 0.82} Q ${w * 0.3} ${h * 0.7} ${w * 0.62} ${h * 0.86} T ${w} ${h * 0.78} V ${h} H0 Z" fill="#000000" fill-opacity="0.12"/><rect x="${m}" y="${m * 0.9}" width="${Math.round(m * 1.6)}" height="${Math.max(6, Math.round(m * 0.1))}" rx="4" fill="${accent}"/>`;
  layers.push({ input: svg(w, h, grad + shapes), left: 0, top: 0 });

  // the area the words may use
  let tx = m; let tw = w - 2 * m; let ty = m * 1.5; let th = h - 3 * m;
  if (layout === 'split' && spec.photo) {
    const pw = Math.round(wide ? w * 0.44 : w * 0.46); const ph = tall ? Math.round(h * 0.42) : h - 2 * m;
    if (tall) {
      const pic = await roundCorners(await cover(spec.photo, w - 2 * m, ph), w - 2 * m, ph, Math.round(m * 0.5));
      layers.push({ input: pic, left: m, top: h - m - ph });
      tw = w - 2 * m; th = h - ph - 3 * m;
    } else {
      const pic = await roundCorners(await cover(spec.photo, pw, ph), pw, ph, Math.round(m * 0.5));
      layers.push({ input: pic, left: w - m - pw, top: Math.round((h - ph) / 2) });
      tw = w - pw - 3 * m;
    }
  } else if (layout === 'overlay' && spec.photo) {
    layers.push({ input: await cover(spec.photo, w, h), left: 0, top: 0 });
    layers.push({ input: svg(w, h, `<defs><linearGradient id="o" x1="0" y1="${tall ? 0.25 : 0}" x2="${tall ? 0 : 1}" y2="1"><stop offset="0" stop-color="${secondary}" stop-opacity="0.05"/><stop offset="1" stop-color="#000000" stop-opacity="0.82"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#o)"/><rect x="0" y="${h - Math.round(m * 0.35)}" width="${w}" height="${Math.round(m * 0.35)}" fill="${accent}"/>`), left: 0, top: 0 });
    tw = wide ? w * 0.62 : w - 2 * m;
  } else if (layout === 'offer') {
    tw = wide ? w * 0.6 : w - 2 * m; th = h * (tall ? 0.52 : 0.62);
  } else { // bold (and the picture-less fallback of the others)
    tw = wide ? w * 0.64 : w - 2 * m;
    if (spec.photo) { // a picture is still welcome: a framed circle
      const d = Math.round(Math.min(w, h) * (tall ? 0.46 : 0.5)); const circ = await sharp(await cover(spec.photo, d, d)).composite([{ input: svg(d, d, `<circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/>`), blend: 'dest-in' }]).png().toBuffer();
      layers.push({ input: svg(d + 16, d + 16, `<circle cx="${(d + 16) / 2}" cy="${(d + 16) / 2}" r="${(d + 16) / 2}" fill="${accent}"/>`), left: tall ? Math.round((w - d) / 2) - 8 : w - m - d - 8, top: tall ? h - m * 2 - d - 8 : Math.round((h - d) / 2) - 8 });
      layers.push({ input: circ, left: tall ? Math.round((w - d) / 2) : w - m - d, top: tall ? h - m * 2 - d : Math.round((h - d) / 2) });
      if (tall) th = h - d - 4 * m; else tw = w - d - 3 * m;
    }
  }

  // ---- the logo, on a white plate (top-left) ----
  let y = ty;
  if (spec.logo) {
    const lh = Math.round(Math.min(w, h) * 0.085); const lw = Math.round(Math.min(w, h) * 0.26);
    const lg = await sharp(spec.logo).resize({ width: lw, height: lh, fit: 'inside', withoutEnlargement: false }).png().toBuffer();
    const lm = await sharp(lg).metadata();
    const pw = lm.width + 28; const ph = lm.height + 20;
    layers.push({ input: svg(pw, ph, `<rect width="${pw}" height="${ph}" rx="${Math.round(ph * 0.28)}" fill="#ffffff" fill-opacity="0.96"/>`), left: tx, top: y });
    layers.push({ input: lg, left: tx + 14, top: y + 10 });
    y += ph + Math.round(m * 0.8);
  } else if (spec.brandName) {
    const bn = await textPng(clean(spec.brandName, 40).toUpperCase(), { size: Math.round(Math.min(w, h) * 0.03), color: '#ffffff', bold: true, width: tw, spacing: 3 });
    layers.push({ input: bn.buf, left: tx, top: y }); y += bn.h + Math.round(m * 0.7);
  }

  // ---- reserve room at the bottom for the button and the contact strip ----
  const ctaH = cta ? Math.round(Math.min(w, h) * 0.09) : 0;
  const footH = footer ? Math.round(Math.min(w, h) * 0.075) : 0;
  const bottomUsed = (ctaH ? ctaH + m * 0.7 : 0) + (footH ? footH + m * 0.5 : 0);
  // ---- headline (fitted), sub-line ----
  const subSize = Math.round(Math.min(w, h) * 0.036);
  const subBlock = sub ? await fit(sub, { max: subSize, min: Math.round(subSize * 0.7), width: tw, maxH: Math.round(th * 0.28), color: '#ffffff', bold: false }) : null;
  const headMax = Math.max(120, Math.round(th - (y - ty) - bottomUsed - (subBlock ? subBlock.h + m * 0.5 : 0)));
  const head = await fit(headline, { max: Math.round(Math.min(w, h) * (tall ? 0.105 : 0.115)), min: Math.round(Math.min(w, h) * 0.04), width: tw, maxH: headMax, color: '#ffffff', bold: true });
  // an accent bar and a soft shadow behind the headline make it read on any picture
  layers.push({ input: svg(Math.round(m * 0.14), head.h, `<rect width="100%" height="100%" rx="4" fill="${accent}"/>`), left: tx, top: y });
  const hx = tx + Math.round(m * 0.14) + Math.round(m * 0.4);
  const shadow = await sharp(head.buf).blur(6).modulate({ brightness: 0 }).linear(0.6, 0).png().toBuffer();
  layers.push({ input: shadow, left: hx + 3, top: y + 4 });
  layers.push({ input: head.buf, left: hx, top: y });
  y += head.h + Math.round(m * 0.45);
  if (subBlock) { layers.push({ input: subBlock.buf, left: hx, top: y }); y += subBlock.h + Math.round(m * 0.5); }

  // ---- the call-to-action button ----
  if (cta) {
    const ct = await textPng(cta.toUpperCase(), { size: Math.round(ctaH * 0.42), color: readable(accent), bold: true, width: tw, spacing: 1.5 });
    const bw = ct.w + Math.round(ctaH * 1.1); const bh = ctaH;
    const by = Math.min(Math.max(y, ty), h - m - footH - (footH ? m * 0.5 : 0) - bh);
    layers.push({ input: svg(bw + 12, bh + 12, `<rect x="6" y="10" width="${bw}" height="${bh}" rx="${bh / 2}" fill="#000000" fill-opacity="0.28"/><rect x="0" y="0" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${accent}"/>`), left: hx - 0, top: by - 0 });
    layers.push({ input: ct.buf, left: hx + Math.round((bw - ct.w) / 2), top: by + Math.round((bh - ct.h) / 2) });
  }

  // ---- the offer badge ----
  if (badge) {
    const d = Math.round(Math.min(w, h) * (layout === 'offer' ? 0.36 : 0.24));
    const bt = await fit(badge.toUpperCase(), { max: Math.round(d * 0.3), min: 18, width: Math.round(d * 0.78), maxH: Math.round(d * 0.5), color: readable(accent), bold: true, align: 'center' });
    const bx = wide ? w - m - d - (spec.photo && layout !== 'overlay' ? 0 : 0) : w - m - d; const byy = layout === 'offer' ? (tall ? h - footH - Math.round(m * 1.8) - d : Math.round((h - d) / 2)) : (tall ? m * 1.2 : m);
    const bxx = layout === 'offer' && wide ? w - m * 1.6 - d : bx;
    layers.push({ input: svg(d + 14, d + 14, `<circle cx="${d / 2 + 7}" cy="${d / 2 + 11}" r="${d / 2}" fill="#000000" fill-opacity="0.3"/><circle cx="${d / 2 + 7}" cy="${d / 2 + 7}" r="${d / 2}" fill="${accent}"/><circle cx="${d / 2 + 7}" cy="${d / 2 + 7}" r="${d / 2 - Math.round(d * 0.05)}" fill="none" stroke="${readable(accent)}" stroke-opacity="0.55" stroke-width="3" stroke-dasharray="4 8"/>`), left: bxx - 7, top: byy - 7 });
    layers.push({ input: bt.buf, left: bxx + Math.round((d - bt.w) / 2), top: byy + Math.round((d - bt.h) / 2) });
  }

  // ---- the contact strip ----
  if (footer) {
    layers.push({ input: svg(w, footH + m, `<rect x="0" y="${m}" width="${w}" height="${footH}" fill="#000000" fill-opacity="0.42"/>`), left: 0, top: h - footH - m });
    const ft = await fit(footer, { max: Math.round(footH * 0.46), min: 14, width: w - 2 * m, maxH: Math.round(footH * 0.8), color: '#ffffff', bold: false, align: 'left' });
    layers.push({ input: ft.buf, left: m, top: h - footH + Math.round((footH - ft.h) / 2) });
  }
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: primary } }).composite(layers.map((l) => ({ ...l, left: Math.max(0, Math.round(l.left)), top: Math.max(0, Math.round(l.top)) }))).png({ compressionLevel: 9 }).toBuffer();
  return { buf, w, h };
}

module.exports = { makeBanner, SIZES, LAYOUTS };

// ---------------------------------------------------------------------------
// AI MARKETING > BANNERS: WIDE and COVER sizes of a designed picture (2026-11-27). Owner: "keep banner, poster, insta post ... what size I want I will select from a drop down, then it should create
// it". The same words, logo, photograph, services and contact details as the poster (bannerPoster.js), arranged for a wide picture (link posts, X, YouTube thumbnail, Google Business post) or for a
// page cover (very wide and low: Facebook, LinkedIn, X header; the YouTube channel banner keeps everything in its centre, which every screen shows).
// ---------------------------------------------------------------------------
const sharp = require('sharp');
const P = require('./bannerPoster');

const { textPng, line, logoReady, iconPng, stepIcon, clean, palette } = P.tools;

function canvas(w, h, H) {
  const layers = [];
  const put = (input, left, top) => layers.push({ input, left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) });
  const shape = (inner, top = 0, height = h) => put(H.svg(w, Math.max(1, Math.round(height)), inner), 0, top);
  const draw = () => sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(layers).png().toBuffer();
  return { put, shape, draw };
}
// the photograph on the right side, melting into the page on its left edge
async function sidePhoto(c, H, photo, x, w, height, fade) {
  const pic = await sharp(photo).rotate().resize({ width: w, height, fit: 'cover', position: 'top' }).ensureAlpha().png().toBuffer();
  const mask = H.svg(w, height, `<defs><linearGradient id="x" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="${fade}" stop-color="#fff" stop-opacity="1"/></linearGradient></defs><rect width="${w}" height="${height}" fill="url(#x)"/>`);
  c.put(await sharp(pic).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer(), x, 0);
}
const words = (spec) => ({
  headline: clean(spec.headline, 40), headline2: clean(spec.headline2, 40), sub: clean(spec.sub, 70), tagline: clean(spec.tagline, 70), cta: clean(spec.cta, 44),
  services: (Array.isArray(spec.services) ? spec.services : []).map((x) => clean(x, 34)).filter(Boolean).slice(0, 6),
  phone: clean(spec.phone, 24), place: clean(spec.location, 44), site: clean(spec.chip, 44), email: clean(spec.email, 48), company: clean(spec.companyName, 40),
});

// ---- WIDE: words in a left column, the photograph on the right, the contact strip along the bottom --------------------------------------------------------------------------
async function makeWide(spec, H) {
  const sz = H.SIZES[spec.size] || H.SIZES['16:9']; const { w, h } = sz;
  const s = Math.min(h / 1080, w / 1600); const n = (v) => Math.round(v * s);
  const { bright, dark, accent } = palette(spec, H); const t = words(spec);
  const c = canvas(w, h, H);
  const contacts = [t.phone && ['phone', t.phone], t.place && ['pin', t.place], t.site && ['globe', t.site], t.email && ['mail', t.email]].filter(Boolean);
  const stripH = contacts.length ? n(104) : 0; const area = h - stripH;
  const split = spec.photo ? Math.round(w * 0.52) : w;
  c.shape(`<defs><radialGradient id="a" cx="0" cy="0" r="0.8"><stop offset="0" stop-color="${bright}" stop-opacity="0.16"/><stop offset="1" stop-color="${bright}" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#a)"/>`);
  if (spec.photo) await sidePhoto(c, H, spec.photo, Math.round(w * 0.48), w - Math.round(w * 0.48), area, 0.22);
  const left = n(70); const room = split - left - n(20);

  // build the column; when it is too tall for the picture everything is made a step smaller
  let parts = []; let total = 0;
  for (const k of [1, 0.9, 0.8, 0.7, 0.6, 0.52]) {
    const m = (v) => Math.max(1, Math.round(v * s * k)); parts = [];
    if (spec.logo) { const logo = await logoReady(spec.logo, Math.min(room, m(620)), m(150)); parts.push({ h: logo.h + m(logo.light ? 30 : 14), draw: (y) => { if (logo.light) c.shape(`<rect x="${left - m(18)}" y="${y}" width="${logo.w + m(36)}" height="${logo.h + m(24)}" rx="${m(16)}" fill="${dark}"/>`); c.put(logo.buf, left, y + (logo.light ? m(12) : 0)); } }); } // eslint-disable-line no-await-in-loop
    else if (t.company) { const x = await line(t.company, { font: 'heavy', size: m(52), color: dark }, room); parts.push({ h: x.h + m(18), draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop
    if (t.tagline) { const x = await line(t.tagline, { font: 'italic', size: m(27), color: dark }, room); parts.push({ h: x.h + m(14), draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop
    if (t.headline) { const x = await line(t.headline, { font: 'heavy', size: m(84), color: dark }, room); parts.push({ h: x.h + m(4), draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop
    if (t.headline2) { const x = await line(t.headline2, { font: 'heavy', size: m(100), color: bright }, room); const wd = Math.max(m(300), x.w * 0.8); parts.push({ h: x.h + m(34), draw: (y) => { c.put(x.buf, left, y); const sy = y + x.h + m(8); c.shape(`<path d="M${left} ${sy + m(12)} Q${left + wd / 2} ${sy - m(14)} ${left + wd} ${sy + m(2)} Q${left + wd / 2} ${sy + m(1)} ${left} ${sy + m(12)} Z" fill="${accent}"/>`); } }); } // eslint-disable-line no-await-in-loop
    if (t.sub) { const x = await line(t.sub, { font: 'semi', size: m(30), color: '#ffffff' }, room - m(60)); const ph = m(58); parts.push({ h: ph + m(22), draw: (y) => { c.shape(`<rect x="${left}" y="${y}" width="${x.w + m(60)}" height="${ph}" rx="${ph / 2}" fill="${dark}"/>`); c.put(x.buf, left + m(30), y + (ph - x.h) / 2); } }); } // eslint-disable-line no-await-in-loop
    if (t.services.length) {
      const cols = 2; const rh = m(56); const cw = Math.floor(room / cols); const items = [];
      for (let i = 0; i < t.services.length; i += 1) items.push({ x: await line(t.services[i], { font: 'bold', size: m(26), color: dark }, cw - m(62)), img: await iconPng(stepIcon(t.services[i], i), m(24), '#ffffff', 2.3) }); // eslint-disable-line no-await-in-loop
      parts.push({ h: Math.ceil(items.length / cols) * rh + m(14), draw: (y) => items.forEach((it, i) => { const x = left + (i % cols) * cw; const cy = y + Math.floor(i / cols) * rh + rh / 2; c.shape(`<circle cx="${x + m(20)}" cy="${cy}" r="${m(20)}" fill="${bright}"/>`); c.put(it.img, x + m(8), cy - m(12)); c.put(it.x.buf, x + m(52), cy - it.x.h / 2); }) });
    }
    if (t.cta) { const x = await line(t.cta, { font: 'bold', size: m(30), color: dark }, room - m(60)); const ph = m(58); parts.push({ h: ph, draw: (y) => { c.shape(`<rect x="${left}" y="${y}" width="${x.w + m(60)}" height="${ph}" rx="${m(16)}" fill="${accent}"/>`); c.put(x.buf, left + m(30), y + (ph - x.h) / 2); } }); } // eslint-disable-line no-await-in-loop
    total = parts.reduce((a, p) => a + p.h, 0);
    if (total <= area - n(40)) break;
  }
  let y = Math.max(n(16), Math.round((area - total) / 2));
  for (const p of parts) { p.draw(y); y += p.h; }

  if (stripH) {
    c.shape(`<rect width="${w}" height="${stripH}" fill="${dark}"/><rect width="${w}" height="${Math.max(2, n(7))}" fill="${accent}"/>`, area, stripH);
    const list = [];
    for (const [key, text] of contacts) { const x = await line(text, { font: key === 'phone' ? 'heavy' : 'medium', size: n(key === 'phone' ? 38 : 28), color: '#ffffff' }, (w - n(120)) / contacts.length - n(60)); list.push({ x, img: await iconPng(key, n(36), '#ffffff', 1.9), width: n(48) + x.w }); } // eslint-disable-line no-await-in-loop
    const gap = Math.max(n(26), (w - list.reduce((a, p) => a + p.width, 0)) / (list.length + 1)); let x = gap;
    for (const p of list) { c.put(p.img, x, area + (stripH - n(36)) / 2 + n(3)); c.put(p.x.buf, x + n(48), area + (stripH - p.x.h) / 2 + n(3)); x += p.width + gap; }
  }
  return { buf: await c.draw(), w, h };
}

// ---- COVER: very wide and low -------------------------------------------------------------------------------------------------------------------------------------------------
async function coverAt(spec, H, w, h, indent) {
  const s = h / 396; const { bright, dark, accent } = palette(spec, H); const t = words(spec);
  const c = canvas(w, h, H);
  c.shape(`<defs><radialGradient id="a" cx="0" cy="0" r="0.8"><stop offset="0" stop-color="${bright}" stop-opacity="0.16"/><stop offset="1" stop-color="${bright}" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="#ffffff"/><rect width="${w}" height="${h}" fill="url(#a)"/>`);
  const barH = Math.round(18 * s);
  if (spec.photo) await sidePhoto(c, H, spec.photo, Math.round(w * 0.58), w - Math.round(w * 0.58), h - barH, 0.3);
  const left = Math.round(w * indent); const room = Math.round(w * (spec.photo ? 0.63 : 0.96)) - left;
  let parts = []; let total = 0;
  for (const k of [1, 0.88, 0.76, 0.64, 0.54, 0.46]) {
    const m = (v) => Math.max(1, Math.round(v * s * k)); parts = [];
    if (spec.logo) { const logo = await logoReady(spec.logo, Math.min(room, m(430)), m(108)); parts.push({ h: logo.h + m(logo.light ? 22 : 10), draw: (y) => { if (logo.light) c.shape(`<rect x="${left - m(12)}" y="${y}" width="${logo.w + m(24)}" height="${logo.h + m(14)}" rx="${m(12)}" fill="${dark}"/>`); c.put(logo.buf, left, y + (logo.light ? m(7) : 0)); } }); } // eslint-disable-line no-await-in-loop
    else if (t.company) { const x = await line(t.company, { font: 'heavy', size: m(38), color: dark }, room); parts.push({ h: x.h + m(10), draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop
    if (t.headline || t.headline2) {
      const a = t.headline ? await textPng(t.headline, { font: 'heavy', size: m(54), color: dark, width: 6000 }) : null; const b = t.headline2 ? await textPng(t.headline2, { font: 'heavy', size: m(54), color: bright, width: 6000 }) : null; // eslint-disable-line no-await-in-loop
      const gap = a && b ? m(18) : 0; const one = (a ? a.w : 0) + gap + (b ? b.w : 0);
      if (one <= room) { const hh = Math.max(a ? a.h : 0, b ? b.h : 0); parts.push({ h: hh + m(16), draw: (y) => { if (a) c.put(a.buf, left, y); if (b) c.put(b.buf, left + (a ? a.w + gap : 0), y); } }); } else {
        for (const [text, color] of [[t.headline, dark], [t.headline2, bright]]) { if (!text) continue; const x = await line(text, { font: 'heavy', size: m(46), color }, room); parts.push({ h: x.h + m(8), draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop, no-continue
      }
    }
    if (t.sub) { const x = await line(t.sub, { font: 'semi', size: m(24), color: '#ffffff' }, room - m(44)); const ph = m(44); parts.push({ h: ph + m(14), draw: (y) => { c.shape(`<rect x="${left}" y="${y}" width="${x.w + m(44)}" height="${ph}" rx="${ph / 2}" fill="${dark}"/>`); c.put(x.buf, left + m(22), y + (ph - x.h) / 2); } }); } // eslint-disable-line no-await-in-loop
    if (t.services.length) { // the services, in one or two lines
      const half = Math.ceil(t.services.length / 2); const rows = t.services.length > 3 ? [t.services.slice(0, half), t.services.slice(half)] : [t.services];
      const texts = rows.map((group) => group.join('   •   ')); let size = m(25);
      for (const text of texts) size = Math.min(size, (await line(text, { font: 'bold', size: m(25), color: bright }, room)).size); // eslint-disable-line no-await-in-loop -- both lines in the same size
      for (const [i, text] of texts.entries()) { const x = await line(text, { font: 'bold', size, color: bright }, room); parts.push({ h: x.h + m(i === texts.length - 1 ? 12 : 6), draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop
    }
    const reach = [t.phone, t.site, t.email].filter(Boolean).join('   |   ');
    if (reach) { const x = await line(reach, { font: 'bold', size: m(23), color: dark }, room); parts.push({ h: x.h, draw: (y) => c.put(x.buf, left, y) }); } // eslint-disable-line no-await-in-loop
    total = parts.reduce((a, p) => a + p.h, 0);
    if (total <= h - barH - Math.round(24 * s)) break;
  }
  let y = Math.max(Math.round(8 * s), Math.round((h - barH - total) / 2));
  for (const p of parts) { p.draw(y); y += p.h; }
  c.shape(`<rect width="${w}" height="${barH}" fill="${dark}"/><rect width="${w}" height="${Math.max(2, Math.round(5 * s))}" fill="${accent}"/>`, h - barH, barH);
  return c.draw();
}
async function makeCover(spec, H) {
  const sz = H.SIZES[spec.size] || H.SIZES['1500:500']; const { w, h } = sz;
  if (sz.safe) { // the YouTube channel banner: phones and computers show only the middle, so everything sits there
    const [sw, sh] = sz.safe; const { bright, dark } = palette(spec, H);
    const c = canvas(w, h, H);
    c.shape(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bright}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>`);
    c.put(await coverAt(spec, H, sw, sh, 0.04), (w - sw) / 2, (h - sh) / 2);
    return { buf: await c.draw(), w, h };
  }
  return { buf: await coverAt(spec, H, w, h, sz.indent || 0.045), w, h };
}

module.exports = { makeWide, makeCover };

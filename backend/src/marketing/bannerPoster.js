// ---------------------------------------------------------------------------
// AI MARKETING > BANNERS > "POSTER" layout (2026-11-27). Owner sent a "Medical Recruitment" flyer: "we have to create like this, or better, for my clients automatically". A bright promotional poster:
// logo and its line, a two-tone headline with a gold sweep, a pill, a large photograph that melts into the page, a role bar with icons, up to five steps with icons, a second photograph beside a motto,
// and a footer (call to action, phone, place, closing line, website, e-mail). Drawn by TeamLink itself (sharp + SVG + Pango text), so every word, number and address is exactly as typed; only the
// photographs come from elsewhere. Font: Poppins (SIL Open Font License, assets/fonts/LICENSE_POPPINS.txt). Icon shapes: Lucide (ISC licence), plus a nurse's cap drawn here.
// The client's LOGO is used exactly as uploaded (never recoloured or reshaped), large, on a clean white page; a very light logo gets a dark plate behind it so it can be read. SERVICES are shown
// clearly: up to three in a row, four to six as large cards in two columns.
//   spec: logo (Buffer), companyName, tagline, headline, headline2, sub (the pill), roles [text], servicesTitle, services [text], motto, motto2, photo (Buffer), photo2 (Buffer), cta, phone, location,
//         closing, chip (website), email, colors { primary (bright), secondary (dark), accent }
// Portrait and square sizes; sections that are empty are left out and the photograph takes their room.
// ---------------------------------------------------------------------------
const path = require('path');
const sharp = require('sharp');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONTS = {
  heavy: ['Poppins-ExtraBold.ttf', 'Poppins Ultra-Bold'], bold: ['Poppins-Bold.ttf', 'Poppins Bold'], semi: ['Poppins-SemiBold.ttf', 'Poppins Semi-Bold'],
  medium: ['Poppins-Medium.ttf', 'Poppins Medium'], italic: ['Poppins-MediumItalic.ttf', 'Poppins Medium Italic'],
};
// Lucide icon shapes (24 x 24, drawn with a round stroke)
const ICONS = {
  stethoscope: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
  nurse: '<path d="M4.5 18 3 9.5C5.4 7.2 8.6 6 12 6s6.600 1.2 9 3.5L19.500 18Z"/><path d="M12 9.2v5.2M9.4 11.800h5.2"/>',
  userSearch: '<circle cx="10" cy="7" r="4"/><path d="M10.3 15H7a4 4 0 0 0-4 4v2"/><circle cx="17" cy="17" r="3"/><path d="m21 21-1.9-1.9"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
  handshake: '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.500a1 1 0 1 0 3-3l-3.88-3.880a3 3 0 0 0-4.24 0l-.88.880a1 1 0 1 1-3-3l2.81-2.810a5.79 5.79 0 0 1 7.06-.870l.47.280a2 2 0 0 0 1.42.250L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.500a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/><path d="M14.05 2a9 9 0 0 1 8 7.94"/><path d="M14.05 6A5 5 0 0 1 18 10"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.700a1.94 1.94 0 0 1-2.060 0L2 7"/>',
  briefcase: '<path d="M12 11v4"/><path d="M14 13h-4"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M18 6v14"/><path d="M6 6v14"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  cap: '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.180a2 2 0 0 0-1.66 0L2.6 9.080a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.660 0z"/><path d="M22 10v6"/><path d="M6 12.500V16a6 3 0 0 0 12 0v-3.5"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
};
const ROLE_RULES = [[/nurs/i, 'nurse'], [/doctor|physician|surgeon|consultant|dentist|medic/i, 'stethoscope'], [/teach|faculty|lectur|student|train|education/i, 'cap'], [/company|hospital|clinic|school|college|business|office/i, 'building'], [/team|staff|candidate|people/i, 'users']];
const STEP_RULES = [[/requirement|understand|brief|need|consult|analys/i, 'userSearch'], [/sourc|search|find|database|reach|outreach/i, 'users'], [/screen|verif|check|assess|test|review|audit|plan/i, 'clipboard'], [/short.?list|select|match|hire|enrol/i, 'userCheck'], [/interview|coordinat|offer|join|onboard|deal|partner|support/i, 'handshake'], [/call|contact/i, 'phone'], [/train|course|class/i, 'cap']];
// the logo ready to place: empty see-through borders taken off, sized to be clearly seen (at most twice its own size, so it stays sharp); `light` = a pale logo that needs a dark plate
async function logoReady(buf, maxW, maxH) {
  let src = await sharp(buf).rotate().png().toBuffer();
  const first = await sharp(src).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  if (first[3] === 0) { try { src = await sharp(src).trim({ threshold: 1 }).png().toBuffer(); } catch { /* an empty picture stays as it is */ } }
  const m = await sharp(src).metadata(); const scale = Math.min(maxW / m.width, maxH / m.height, 2);
  const img = await sharp(src).resize({ width: Math.max(1, Math.round(m.width * scale)), height: Math.max(1, Math.round(m.height * scale)), fit: 'fill' }).png().toBuffer();
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0; let solid = 0;
  for (let i = 0; i < data.length; i += 4) { if (data[i + 3] > 128) { sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255; solid += 1; } }
  // a logo drawn on a see-through background (its first corner is clear, or much of it is) and mostly pale would vanish on the white page
  return { buf: img, w: info.width, h: info.height, light: !!solid && sum / solid > 0.8 && (first[3] === 0 || (info.width * info.height - solid) > solid * 0.15) };
}
const roleIcon = (t) => (ROLE_RULES.find(([re]) => re.test(t)) || [null, 'briefcase'])[1];
const stepIcon = (t, i) => (STEP_RULES.find(([re]) => re.test(t)) || [null, ['userSearch', 'users', 'clipboard', 'userCheck', 'handshake'][i % 5]])[1];

const iconPng = async (key, size, color, sw = 1.9) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(size)}" height="${Math.round(size)}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`)).png().toBuffer();
// the colours of a designed picture: the business's bright colour, a very dark shade of it for words and bars, and the accent
function palette(spec, H) {
  const c = spec.colors || {}; const bright = H.HEX.test(c.primary || '') ? c.primary : '#0b5ed7';
  return { bright, dark: H.mix(bright, '#020a22', 0.66), accent: H.HEX.test(c.accent || '') ? c.accent : '#f5b301', soft: H.mix(bright, '#ffffff', 0.9), rule: H.mix(bright, '#ffffff', 0.68) };
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, n);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function textPng(str, { font = 'semi', size, color, width = 4000, align = 'left' }) {
  const [file, family] = FONTS[font];
  const markup = `<span foreground="${color}">${esc(str)}</span>`;
  const buf = await sharp({ text: { text: markup, font: `${family} ${Math.max(8, Math.round(size))}`, fontfile: path.join(FONT_DIR, file), width: Math.max(40, Math.round(width)), rgba: true, wrap: 'word', align, spacing: Math.round(size * 0.04) } }).png().toBuffer();
  const m = await sharp(buf).metadata();
  return { buf, w: m.width, h: m.height };
}
// a heavy italic without another font file: the upright letters, leaned to the right
async function lean(t) {
  const buf = await sharp(t.buf).affine([[1, -0.18], [0, 1]], { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(); const m = await sharp(buf).metadata();
  return { buf, w: m.width, h: m.height };
}
// one line, made smaller until it fits `maxW`
async function line(str, opts, maxW) {
  const draw = async (size) => { const t = await textPng(str, { ...opts, size, width: 6000 }); return opts.slant ? lean(t) : t; };
  let size = opts.size; let t = await draw(size);
  while (t.w > maxW && size > 9) { size = Math.max(9, Math.floor(size * Math.min(0.96, maxW / t.w + 0.01))); t = await draw(size); } // eslint-disable-line no-await-in-loop
  return { ...t, size };
}
// wrapped, centred, made smaller until it fits the box
async function block(str, opts, maxW, maxH) {
  let size = opts.size; let t = await textPng(str, { ...opts, size, width: maxW, align: 'centre' });
  while ((t.h > maxH || t.w > maxW) && size > 9) { size = Math.max(9, Math.floor(size * 0.93)); t = await textPng(str, { ...opts, size, width: maxW, align: 'centre' }); } // eslint-disable-line no-await-in-loop
  return t;
}

async function makePoster(spec, H) {
  const { SIZES, svg, mix, HEX } = H;
  const sz = SIZES[spec.size] || SIZES['4:5'];
  const { w, h } = sz;
  const k = Math.min(w / 1080, h / 1350); // one design unit: the design is drawn for 1080 x 1350
  const n = (v) => Math.round(v * k);
  const { bright, dark, accent, soft, rule } = palette(spec, H);
  const layers = [];
  const put = (input, left, top) => layers.push({ input, left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) });
  const shape = (inner, top = 0, height = h) => put(svg(w, Math.max(1, Math.round(height)), inner), 0, top);
  const icon = iconPng;
  const insta = spec.variant === 'insta'; // an Instagram post: the logo, the headline, the photograph, the services, the call to action and the contacts (no motto or closing line)
  // a gold sweep, thick in the middle, under a line of words
  const sweep = (x1, x2, y) => { const mid = (x1 + x2) / 2; shape(`<path d="M${x1} ${y + n(13)} Q${mid} ${y - n(17)} ${x2} ${y + n(2)} Q${mid} ${y + n(1)} ${x1} ${y + n(13)} Z" fill="${accent}"/>`); };
  // a line of words with a short rule on each side
  const ruled = async (str, opts, y, color) => {
    const t = await line(str, opts, w - n(300)); const gap = n(18); const len = n(70); const x = (w - t.w) / 2;
    shape(`<g stroke="${color}" stroke-width="${Math.max(1, n(2.4))}" stroke-linecap="round"><line x1="${x - gap - len}" y1="${y + t.h / 2}" x2="${x - gap}" y2="${y + t.h / 2}"/><line x1="${x + t.w + gap}" y1="${y + t.h / 2}" x2="${x + t.w + gap + len}" y2="${y + t.h / 2}"/></g>`);
    put(t.buf, x, y); return t.h;
  };

  const headline = clean(spec.headline, 40); const headline2 = clean(spec.headline2, 40); const pill = clean(spec.sub, 60); const tagline = clean(spec.tagline, 70);
  const roles = (Array.isArray(spec.roles) ? spec.roles : []).map((x) => clean(x, 24)).filter(Boolean).slice(0, 3);
  const steps = (Array.isArray(spec.services) ? spec.services : []).map((x) => clean(x, 34)).filter(Boolean).slice(0, 6); // the business's services, shown clearly in every design
  const servicesTitle = steps.length ? clean(spec.servicesTitle, 30) : '';
  const cards = steps.length > 3; // four to six: large cards in two columns
  const motto = insta ? '' : clean(spec.motto, 44); const motto2 = insta ? '' : clean(spec.motto2, 34);
  const cta = clean(spec.cta, 44); const phone = clean(spec.phone, 24); const place = clean(spec.location, 44); const closing = insta ? '' : clean(spec.closing, 60); const site = clean(spec.chip, 44); const email = clean(spec.email, 48);

  // ---- the footer's rows decide its height ----
  const rows = [cta && ['cta', 66], (phone || place) && ['phone', 60], closing && ['closing', 44], (site || email) && ['web', 46]].filter(Boolean);
  const footerH = rows.length ? n(34 + rows.reduce((a, r) => a + r[1], 0) + 14) : 0;
  const bandH = spec.photo2 ? n(168) : ((motto || motto2) ? n(102) : 0);
  const titleH = servicesTitle ? n(50) : 0;
  const stepsH = !steps.length ? 0 : titleH + (cards ? Math.ceil(steps.length / 2) * n(68) + n(14) : n(150));
  const roleH = roles.length ? n(62) : 0;
  const footerTop = h - footerH; const bandTop = footerTop - bandH; const stepsTop = bandTop - stepsH; const roleTop = stepsTop - (roleH ? roleH + n(8) : 0);

  // ---- header ----
  const head = []; // drawn after the photograph so the words stay on top
  let y = n(24);
  const drawHeader = [];
  let logoPlate = null;
  if (spec.logo) {
    const logo = await logoReady(spec.logo, n(700), n(cards ? 132 : 150));
    if (logo.light) { logoPlate = { x: (w - logo.w) / 2 - n(26), y: y - n(6), w: logo.w + n(52), h: logo.h + n(24) }; y += n(6); }
    drawHeader.push([logo.buf, (w - logo.w) / 2, y]); y += logo.h + n(logo.light ? 24 : 10);
  } else if (spec.companyName) { const t = await line(clean(spec.companyName, 40), { font: 'heavy', size: n(54), color: dark }, w - n(120)); drawHeader.push([t.buf, (w - t.w) / 2, y + n(8)]); y += t.h + n(20); }
  const taglineAt = y; if (tagline) y += n(34);
  let h1 = null; let h1At = 0; let h2 = null; let h2At = 0;
  if (headline) { h1 = await line(headline, { font: 'heavy', size: n(cards ? 74 : 86), color: dark }, w - n(100)); h1At = y + n(10); y = h1At + h1.h; }
  if (headline2) { h2 = await line(headline2, { font: 'heavy', size: n(cards ? 90 : 104), color: bright }, w - n(80)); h2At = y + n(4); y = h2At + h2.h; }
  const sweepAt = y + n(6); y += n(28);
  let pillText = null; const pillAt = y;
  if (pill) { pillText = await line(pill, { font: 'semi', size: n(30), color: '#ffffff' }, w - n(220)); y += n(60); }
  const headerBottom = y;

  // ---- the page and the photograph ----
  const heroTop = Math.max(0, headerBottom - n(6)); const heroBottom = Math.max(heroTop + n(160), (stepsH ? stepsTop : (bandH ? bandTop : footerTop)) + n(4)); const heroH = Math.min(h - heroTop, heroBottom - heroTop);
  shape(`<defs><radialGradient id="a" cx="0" cy="0" r="0.75"><stop offset="0" stop-color="${bright}" stop-opacity="0.16"/><stop offset="1" stop-color="${bright}" stop-opacity="0"/></radialGradient><radialGradient id="b" cx="1" cy="0.1" r="0.7"><stop offset="0" stop-color="${bright}" stop-opacity="0.14"/><stop offset="1" stop-color="${bright}" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#a)"/><rect width="${w}" height="${h}" fill="url(#b)"/>`);
  if (spec.photo) {
    // soft blurred sides, from the same photograph, only beside it: the logo and the headline stay on a clean page
    const sideH = Math.max(1, heroH);
    const blurred = await sharp(spec.photo).rotate().resize({ width: w, height: sideH, fit: 'cover' }).blur(Math.max(0.5, n(26))).ensureAlpha().png().toBuffer();
    const sideMask = svg(w, sideH, `<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.2" stop-color="#fff" stop-opacity="0"/><stop offset="0.8" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0.5"/></linearGradient></defs><rect width="${w}" height="${sideH}" fill="url(#s)"/>`);
    const topFade = svg(w, sideH, `<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.22" stop-color="#fff" stop-opacity="1"/></linearGradient></defs><rect width="${w}" height="${sideH}" fill="url(#t)"/>`);
    const sides = await sharp(blurred).composite([{ input: sideMask, blend: 'dest-in' }]).png().toBuffer();
    put(await sharp(sides).composite([{ input: topFade, blend: 'dest-in' }]).png().toBuffer(), 0, heroTop);
    const pw = Math.round(w * 0.94);
    const hero = await sharp(spec.photo).rotate().resize({ width: pw, height: heroH, fit: 'cover', position: 'top' }).ensureAlpha().png().toBuffer();
    const vert = svg(pw, heroH, `<defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.07" stop-color="#fff" stop-opacity="1"/><stop offset="0.93" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0.9"/></linearGradient></defs><rect width="${pw}" height="${heroH}" fill="url(#v)"/>`);
    const horiz = svg(pw, heroH, `<defs><linearGradient id="x" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.07" stop-color="#fff" stop-opacity="1"/><stop offset="0.93" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="${pw}" height="${heroH}" fill="url(#x)"/>`);
    const faded = await sharp(hero).composite([{ input: vert, blend: 'dest-in' }]).png().toBuffer();
    put(await sharp(faded).composite([{ input: horiz, blend: 'dest-in' }]).png().toBuffer(), (w - pw) / 2, heroTop);
  }
  if (logoPlate) shape(`<rect x="${logoPlate.x}" y="${logoPlate.y}" width="${logoPlate.w}" height="${logoPlate.h}" rx="${n(18)}" fill="${dark}"/>`);
  drawHeader.forEach(([b, x, top]) => put(b, x, top));
  if (tagline) await ruled(tagline, { font: 'italic', size: n(24), color: dark }, taglineAt, dark);
  if (h1) put(h1.buf, (w - h1.w) / 2, h1At);
  if (h2) put(h2.buf, (w - h2.w) / 2, h2At);
  if (h1 || h2) { const wide = Math.max(n(420), ((h2 || h1).w) * 0.82); sweep((w - wide) / 2, (w + wide) / 2, sweepAt); }
  if (pillText) {
    const pw = Math.min(w - n(120), pillText.w + n(84)); const ph = n(56);
    shape(`<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mix(dark, bright, 0.35)}"/></linearGradient></defs><rect x="${(w - pw) / 2}" y="${pillAt}" width="${pw}" height="${ph}" rx="${ph / 2}" fill="url(#p)"/>`);
    put(pillText.buf, (w - pillText.w) / 2, pillAt + (ph - pillText.h) / 2);
  }

  // ---- below the photograph: a white ground ----
  if (stepsH || bandH) {
    const top = stepsH ? stepsTop : bandTop; const melt = Math.min(top, n(56));
    shape(`<defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient></defs><rect width="${w}" height="${melt}" fill="url(#m)"/>`, top - melt, melt);
    shape(`<rect width="${w}" height="${h - top}" fill="#ffffff"/>`, top, h - top);
  }

  // ---- role bar ----
  if (roleH) {
    const parts = [];
    for (const r of roles) { const t = await line(r, { font: 'semi', size: n(28), color: '#ffffff' }, (w - n(240)) / roles.length - n(60)); parts.push({ t, icon: await icon(roleIcon(r), n(44), '#ffffff', 2.1), width: n(44) + n(16) + t.w }); } // eslint-disable-line no-await-in-loop
    const pad = n(54); const sep = n(48);
    const bw = Math.min(w - n(60), parts.reduce((a, p) => a + p.width, 0) + pad * 2 + sep * (parts.length - 1)); const bx = (w - bw) / 2;
    shape(`<rect x="${bx}" y="${roleTop}" width="${bw}" height="${roleH}" rx="${n(18)}" fill="${dark}" stroke="#ffffff" stroke-width="${Math.max(1, n(3))}"/>`);
    let x = bx + pad;
    parts.forEach((p, i) => {
      put(p.icon, x, roleTop + (roleH - n(44)) / 2); put(p.t.buf, x + n(60), roleTop + (roleH - p.t.h) / 2); x += p.width;
      if (i < parts.length - 1) { shape(`<line x1="${x + sep / 2}" y1="${roleTop + n(13)}" x2="${x + sep / 2}" y2="${roleTop + roleH - n(13)}" stroke="#ffffff" stroke-opacity="0.65" stroke-width="${Math.max(1, n(2))}"/>`); x += sep; }
    });
  }

  // ---- the services ----
  if (stepsH) {
    const taken = new Set();
    const keyFor = (text, i) => { let key = stepIcon(text, i); if (taken.has(key)) key = ['userSearch', 'users', 'clipboard', 'userCheck', 'handshake', 'cap', 'briefcase', 'building'].find((x) => !taken.has(x)) || key; taken.add(key); return key; }; // no icon twice on one poster
    if (servicesTitle) {
      const t = await line(servicesTitle, { font: 'heavy', size: n(34), color: dark }, w - n(320)); const ty = stepsTop + n(8);
      const gap = n(20); const len = n(96); const x = (w - t.w) / 2;
      shape(`<g stroke="${accent}" stroke-width="${Math.max(2, n(5))}" stroke-linecap="round"><line x1="${x - gap - len}" y1="${ty + t.h / 2}" x2="${x - gap}" y2="${ty + t.h / 2}"/><line x1="${x + t.w + gap}" y1="${ty + t.h / 2}" x2="${x + t.w + gap + len}" y2="${ty + t.h / 2}"/></g>`);
      put(t.buf, x, ty);
    }
    const top = stepsTop + titleH;
    if (cards) {
      const mx = n(40); const gap = n(18); const cw = (w - mx * 2 - gap) / 2; const rh = n(68); const ch = rh - n(9); const r = n(24);
      for (let i = 0; i < steps.length; i += 1) {
        const alone = i === steps.length - 1 && steps.length % 2 === 1; // an odd last one sits in the middle
        const x = alone ? (w - cw) / 2 : mx + (i % 2) * (cw + gap); const cy = top + Math.floor(i / 2) * rh;
        shape(`<rect x="${x}" y="${cy}" width="${cw}" height="${ch}" rx="${n(16)}" fill="${soft}" stroke="${rule}" stroke-width="${Math.max(1, n(2))}"/><circle cx="${x + n(40)}" cy="${cy + ch / 2}" r="${r}" fill="${bright}"/>`);
        put(await icon(keyFor(steps[i], i), n(32), '#ffffff', 2.2), x + n(24), cy + ch / 2 - n(16)); // eslint-disable-line no-await-in-loop
        const t = await line(steps[i], { font: 'bold', size: n(28), color: dark }, cw - n(100)); // eslint-disable-line no-await-in-loop
        put(t.buf, x + n(82), cy + (ch - t.h) / 2);
      }
    } else {
      const mx = n(34); const col = (w - mx * 2) / steps.length; const r = n(42);
      for (let i = 0; i < steps.length; i += 1) {
        const cx = mx + col * i + col / 2; const cy = top + n(48);
        shape(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bright}"/>`);
        put(await icon(keyFor(steps[i], i), n(48), '#ffffff', 2.1), cx - n(24), cy - n(24)); // eslint-disable-line no-await-in-loop
        const t = await block(steps[i], { font: 'bold', size: n(25), color: dark }, Math.round(col - n(22)), n(56)); // eslint-disable-line no-await-in-loop
        put(t.buf, cx - t.w / 2, top + n(96) + (n(52) - t.h) / 2);
        if (i) shape(`<line x1="${mx + col * i}" y1="${top + n(16)}" x2="${mx + col * i}" y2="${top + n(140)}" stroke="${rule}" stroke-width="${Math.max(1, n(2))}"/>`);
      }
    }
  }

  // ---- the second photograph and the motto ----
  if (bandH) {
    const bh = bandH + n(30); const pw = Math.round(w * 0.5);
    let textLeft = n(40);
    if (spec.photo2) {
      const edge = `M0 0 H${pw * 0.9} C${pw * 1.04} ${bh * 0.3} ${pw * 0.9} ${bh * 0.72} ${pw * 0.72} ${bh} H0 Z`;
      const pic = await sharp(spec.photo2).rotate().resize({ width: pw, height: bh, fit: 'cover', position: 'attention' }).ensureAlpha().png().toBuffer();
      put(await sharp(pic).composite([{ input: svg(pw, bh, `<path d="${edge}" fill="#fff"/>`), blend: 'dest-in' }]).png().toBuffer(), 0, bandTop);
      shape(`<path d="M${pw * 0.9} 0 C${pw * 1.04} ${bh * 0.3} ${pw * 0.9} ${bh * 0.72} ${pw * 0.72} ${bh}" fill="none" stroke="#ffffff" stroke-width="${n(12)}"/><path d="M${pw * 0.9 + n(11)} 0 C${pw * 1.04 + n(11)} ${bh * 0.3} ${pw * 0.9 + n(11)} ${bh * 0.72} ${pw * 0.72 + n(11)} ${bh}" fill="none" stroke="${accent}" stroke-width="${Math.max(2, n(4))}"/>`, bandTop, bh);
      textLeft = pw + n(8);
    }
    const room = w - textLeft - n(28);
    const a = motto ? await line(motto, { font: 'bold', size: n(34), color: dark, slant: true }, room) : null;
    const b = motto2 ? await line(motto2, { font: 'heavy', size: n(46), color: bright, slant: true }, room) : null;
    const total = (a ? a.h : 0) + (b ? b.h + n(8) : 0) + n(18);
    let ty = bandTop + Math.max(n(8), (bandH - total) / 2);
    const mid = textLeft + room / 2;
    if (a) { put(a.buf, mid - a.w / 2, ty); ty += a.h + n(8); }
    if (b) { put(b.buf, mid - b.w / 2, ty); ty += b.h; }
    if (b || a) { const wide = ((b || a).w) * 0.92; sweep(mid - wide / 2, mid + wide / 2, ty + n(6)); }
  }

  // ---- footer ----
  if (footerH) {
    const rise = n(20);
    shape(`<path d="M0 ${rise * 1.1} Q${w / 2} ${-rise * 0.35} ${w} ${rise * 1.1} V${footerH + rise} H0 Z" fill="${bright}" opacity="0.5"/>`, footerTop - rise * 0.5, footerH + rise * 0.5);
    shape(`<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(dark, bright, 0.22)}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs><path d="M0 ${rise * 1.1} Q${w / 2} ${-rise * 0.7} ${w} ${rise * 1.1} V${footerH} H0 Z" fill="url(#f)"/>`, footerTop, footerH);
    let fy = footerTop + n(28);
    // words with an icon in front, several side by side with a thin rule between
    const strip = async (items, y0, rowH) => {
      const list = [];
      for (const it of items) { const t = await line(it.text, { font: it.font, size: it.size, color: '#ffffff' }, (w - n(180)) / items.length - n(56)); list.push({ t, img: await icon(it.icon, it.iconSize, '#ffffff', 1.8), iconSize: it.iconSize, width: it.iconSize + n(14) + t.w }); } // eslint-disable-line no-await-in-loop
      const sep = n(52); const total = list.reduce((a, p) => a + p.width, 0) + sep * (list.length - 1); let x = (w - total) / 2;
      list.forEach((p, i) => {
        put(p.img, x, y0 + (rowH - p.iconSize) / 2); put(p.t.buf, x + p.iconSize + n(14), y0 + (rowH - p.t.h) / 2); x += p.width;
        if (i < list.length - 1) { shape(`<line x1="${x + sep / 2}" y1="${y0 + n(10)}" x2="${x + sep / 2}" y2="${y0 + rowH - n(10)}" stroke="#ffffff" stroke-opacity="0.6" stroke-width="${Math.max(1, n(2))}"/>`); x += sep; }
      });
    };
    for (const [kind, rowH] of rows) {
      if (kind === 'cta') {
        const t = await line(cta, { font: 'bold', size: n(30), color: dark }, w - n(260)); const pw = t.w + n(76); const ph = n(52); // eslint-disable-line no-await-in-loop
        shape(`<rect x="${(w - pw) / 2}" y="${fy}" width="${pw}" height="${ph}" rx="${n(16)}" fill="${accent}"/>`); put(t.buf, (w - t.w) / 2, fy + (ph - t.h) / 2);
      } else if (kind === 'phone') await strip([phone && { text: phone, font: 'heavy', size: n(42), icon: 'phone', iconSize: n(40) }, place && { text: place, font: 'medium', size: n(26), icon: 'pin', iconSize: n(34) }].filter(Boolean), fy, n(56)); // eslint-disable-line no-await-in-loop
      else if (kind === 'closing') await ruled(closing, { font: 'italic', size: n(24), color: '#ffffff' }, fy + n(6), '#ffffff'); // eslint-disable-line no-await-in-loop
      else await strip([site && { text: site, font: 'medium', size: n(24), icon: 'globe', iconSize: n(30) }, email && { text: email, font: 'medium', size: n(24), icon: 'mail', iconSize: n(30) }].filter(Boolean), fy, n(44)); // eslint-disable-line no-await-in-loop
      fy += n(rowH);
    }
  }
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(layers).png().toBuffer();
  return { buf, w, h };
}

module.exports = { makePoster, roleIcon, stepIcon, tools: { textPng, line, logoReady, iconPng, stepIcon, clean, palette } };

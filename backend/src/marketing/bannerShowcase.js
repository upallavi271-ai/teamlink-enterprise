// ---------------------------------------------------------------------------
// AI MARKETING > BANNERS > "SHOWCASE" layout (2026-11-21). Founder: "it must not look simple: like the second picture" (an infographic banner: logo band, two-tone headline, a hero picture,
// "Our services" icons, price cards, who it is for, website chip). Designed here, free, deterministic (sharp + SVG + Pango text), in the brand colours.
//   spec: headline (white), headline2 (accent colour), sub, badge (the glowing chip beside the headline when there is no hero picture, e.g. "AI"), servicesTitle, services [text], plans [{ name, price, unit }],
//         audienceTitle, audience, chip (website), logo (Buffer), photo (hero Buffer), tagline, colors { primary, secondary, accent }
// Wide sizes (16:9) put the headline left and the hero right; tall / square sizes stack them. Sections that are empty are left out, and the rest share the height.
// ---------------------------------------------------------------------------
const sharp = require('sharp');

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 12v-2M11 12V8M14 12v-3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-7"/><path d="M16 7h4v4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/><path d="M12 12l7-7"/>',
  mega: '<path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M15 9a4 4 0 010 6"/><path d="M18 6a8 8 0 010 12"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.8 0 5 2.2 5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  social: '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5"/><path d="M12 17h.01"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 11v6M8 7.5v.01M12 17v-6M12 13c0-1.7 1-2 2-2s2.5.5 2.5 2.5V17"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9.5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M3 13h18"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5L16 9.5"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  heart: '<path d="M12 21s-7-4.4-9-9a5 5 0 019-3 5 5 0 019 3c-2 4.6-9 9-9 9z"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 15a2.5 2.5 0 002.5 2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-15 0 10-6 15-14 15z"/><path d="M5 19c3-5 6-8 10-10"/>',
  cross: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  chat: '<path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-5 4V6a1 1 0 011-1z"/><path d="M8 10h8M8 13h5"/>',
};
// which icon for a service name (the words the team types)
const RULES = [[/brush|floss|clean|hygiene|wash|rinse/i, 'drop'], [/dentist|doctor|visit|check.?up|consult|screening/i, 'cross'], [/sugar|food|diet|eat|water|drink|fruit|vegetable/i, 'leaf'], [/sleep|rest|exercise|walk|yoga|stress/i, 'heart'], [/pigment|dark spot|wrinkle|ageing|aging|sunscreen|sun /i, 'sun'], [/eczema|allerg|itch|fung|infect/i, 'shield'], [/skin|acne|pimple|rash|derm/i, 'drop'], [/hair|dandruff|scalp/i, 'leaf'], [/doctor|clinic|hospital|medical|dental|teeth|patient|consult/i, 'cross'], [/heart|cardio/i, 'heart'], [/social|facebook|instagram|share/i, 'social'], [/seo|search/i, 'search'], [/aeo|answer|question/i, 'question'], [/geo|generative|\bai\b|artificial|chatbot|automation/i, 'chip'], [/google|business profile|map|local/i, 'pin'],
  [/linkedin/i, 'linkedin'], [/content|video|reel|creative|design/i, 'play'], [/email|mail|newsletter/i, 'mail'], [/whatsapp|sms|message|chat/i, 'chat'], [/lead|ads?\b|campaign|promotion/i, 'mega'],
  [/analytics|report|growth|performance/i, 'chart'], [/target|audience/i, 'target'], [/web|site|domain/i, 'globe'], [/hire|recruit|job|staff|talent/i, 'users'], [/call|phone/i, 'phone'], [/brand|trust|secure/i, 'shield']];
const iconFor = (t, i) => { const r = RULES.find(([re]) => re.test(t)); return r ? r[1] : ['star', 'bolt', 'check', 'briefcase'][i % 4]; };
const iconSvg = (key, size, color, sw = 1.7) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[key] || ICONS.star}</svg>`;

async function makeShowcase(spec, H) {
  const { SIZES, textPng, fit, svg, cover, roundCorners, mix, readable, HEX } = H;
  const sz = SIZES[spec.size] || SIZES['16:9'];
  const { w, h } = sz;
  const wide = w > h * 1.3;
  const c = spec.colors || {};
  const primary = HEX.test(c.primary || '') ? c.primary : '#0f766e';
  const deep = mix(primary, '#02101f', 0.72); const mid = mix(primary, '#02101f', 0.45);
  const accent = HEX.test(c.accent || '') ? c.accent : '#fbbf24';
  const onAccent = readable(accent);
  const m = Math.round(w * 0.04);
  const u = w / 1920; // one design unit for sizes
  const layers = [];
  const put = (input, left, top) => layers.push({ input, left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) });
  // the website chip is ALWAYS one line (2026-11-25: a client asked for the link "in one line"): the pill grows to the address, and the text only shrinks when even the widest pill is too small.
  // spec.chipPos 'under-headline' puts it right under the headline lines; anything else leaves it in the "who it is for" strip at the bottom.
  const chipText = String(spec.chip || '').trim(); const chipUnder = !!chipText && spec.chipPos === 'under-headline';
  const chipMake = async (ch, maxPill) => {
    let size = Math.round(ch * 0.42); let t = await textPng(chipText, { size, color: onAccent, bold: true, width: 6000 }); const room = maxPill - Math.round(ch * 1.5);
    while (t.w > room && size > 14) { size = Math.max(14, Math.floor(size * 0.92)); t = await textPng(chipText, { size, color: onAccent, bold: true, width: 6000 }); } // eslint-disable-line no-await-in-loop
    return { t, pill: Math.min(maxPill, t.w + Math.round(ch * 1.5)) };
  };
  const chipPut = async (c, ch, pill, cx, cy) => {
    put(svg(pill, ch, `<rect width="${pill}" height="${ch}" rx="${ch / 2}" fill="${accent}"/>`), cx, cy);
    put(await sharp(Buffer.from(iconSvg('globe', Math.round(ch * 0.5), onAccent, 1.8))).png().toBuffer(), cx + Math.round(ch * 0.4), cy + ch * 0.25);
    put(c.t.buf, cx + Math.round(ch * 1.0), cy + (ch - c.t.h) / 2);
  };

  // ---- background: deep gradient, glow, a faint circuit pattern ----
  const rnd = (n) => { const x = Math.sin(n * 91.7) * 10000; return x - Math.floor(x); };
  let circuit = '';
  for (let i = 0; i < 26; i += 1) {
    const x = rnd(i + 1) * w; const y = rnd(i + 40) * h * 0.55 + h * 0.08; const len = (60 + rnd(i + 80) * 160) * u * 1.4; const vert = rnd(i + 120) > 0.5;
    circuit += `<path d="M${x} ${y} l${vert ? 0 : len} ${vert ? len : 0} l${len * 0.4} ${len * 0.4}" stroke="${accent}" stroke-opacity="0.10" stroke-width="${Math.max(1.5, 2 * u)}" fill="none"/><circle cx="${x}" cy="${y}" r="${Math.max(3, 4 * u)}" fill="${accent}" fill-opacity="0.18"/>`;
  }
  put(svg(w, h, `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${deep}"/></linearGradient>
    <radialGradient id="gl" cx="${wide ? 0.72 : 0.5}" cy="${wide ? 0.25 : 0.3}" r="0.55"><stop offset="0" stop-color="#7dd3fc" stop-opacity="0.38"/><stop offset="1" stop-color="#7dd3fc" stop-opacity="0"/></radialGradient>
    <linearGradient id="bot" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${mix(accent, '#ffffff', 0.4)}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/><rect width="${w}" height="${h}" fill="url(#gl)"/>${circuit}
    <path d="M0 ${h - 70 * u} Q ${w * 0.3} ${h - 130 * u} ${w * 0.6} ${h - 80 * u} T ${w} ${h - 100 * u} V ${h} H0 Z" fill="#000000" fill-opacity="0.25"/>
    <path d="M0 ${h - 22 * u} Q ${w * 0.35} ${h - 60 * u} ${w * 0.7} ${h - 28 * u} T ${w} ${h - 46 * u}" stroke="url(#bot)" stroke-width="${Math.max(3, 6 * u)}" fill="none"/>`), 0, 0);

  // ---- the top band: light swoosh, logo, tagline ----
  const bandH = Math.round((wide ? 175 : 150) * u * (wide ? 1 : 1.25));
  put(svg(w, bandH + 40, `<defs><linearGradient id="tb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#dbeafe"/><stop offset="1" stop-color="#93c5fd" stop-opacity="0.55"/></linearGradient></defs><path d="M0 0 H${w} V${bandH * 0.5} Q ${w * 0.7} ${bandH * 0.9} ${w * 0.4} ${bandH * 0.85} T 0 ${bandH + 10} Z" fill="url(#tb)"/>`), 0, 0);
  let lx = m;
  if (spec.logo) {
    const lg = await sharp(spec.logo).resize({ width: Math.round(w * (wide ? 0.27 : 0.4)), height: Math.round(bandH * 0.62), fit: 'inside' }).png().toBuffer();
    const lm = await sharp(lg).metadata();
    put(lg, m, Math.round((bandH * 0.78 - lm.height) / 2)); lx = m + lm.width + Math.round(w * 0.02);
  }
  // the COMPANY NAME (typed on the banner screen; the brand name when empty): beside the logo, or in its place when there is no logo
  const cname = String(spec.companyName || '').trim();
  if (cname) {
    const maxW = Math.round(w * (wide ? 0.3 : 0.5)) - (spec.logo ? 0 : 0);
    const cn = await fit(cname, { max: Math.round(bandH * (spec.logo ? 0.3 : 0.42)), min: 16, width: maxW, maxH: Math.round(bandH * 0.62), color: '#0b2a5b', bold: true });
    put(cn.buf, lx, Math.round((bandH * 0.78 - cn.h) / 2)); lx += cn.w + Math.round(w * 0.02);
  }
  if (spec.tagline) {
    put(svg(4, Math.round(bandH * 0.5), '<rect width="4" height="100%" fill="#1e3a8a" fill-opacity="0.45"/>'), lx, Math.round(bandH * 0.12));
    const tg = await fit(spec.tagline, { max: Math.round(bandH * 0.25), min: 16, width: Math.round(w * (wide ? 0.34 : 0.4)), maxH: Math.round(bandH * 0.55), color: '#1e3a8a', bold: false });
    put(tg.buf, lx + Math.round(w * 0.015), Math.round(bandH * 0.12 + (bandH * 0.5 - tg.h) / 2));
  }

  // ---- how tall everything else is ----
  const services = (Array.isArray(spec.services) ? spec.services : []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 8);
  const plans = (Array.isArray(spec.plans) ? spec.plans : []).filter((p) => p && (p.name || p.price)).slice(0, 3);
  const hasAud = !!(spec.audience || (chipText && !chipUnder));
  const perRow = wide ? Math.min(services.length, 7) : Math.min(services.length, 4);
  const svcRows = perRow ? Math.ceil(services.length / perRow) : 0;
  const iconD = Math.round((wide ? 84 : 110) * u * (wide ? 1 : 1)); const labelH = Math.round(iconD * 0.62);
  const svcH = svcRows ? (spec.servicesTitle ? Math.round(80 * u * (wide ? 1 : 1.2)) : 0) + svcRows * (iconD + labelH + Math.round(24 * u)) : 0;
  const planH = plans.length ? Math.round((wide ? 150 : 190) * u) : 0;
  const audH = hasAud ? Math.round((wide ? 150 : 170) * u) : 0;
  const gap = Math.round(30 * u);
  const usedBelow = svcH + planH + audH + gap * ([svcH, planH, audH].filter(Boolean).length + 1);
  const topY = bandH + Math.round(10 * u);
  // the head area (headline + hero): wide = its own height, tall = what is left
  const headH = wide ? (svcRows || plans.length ? Math.min(h - topY - usedBelow, Math.round(400 * u)) : h - topY - usedBelow) : Math.max(Math.round(380 * u), h - topY - usedBelow);
  const textW = wide ? Math.round(w * 0.52) : w - 2 * m;

  // ---- headline (white + accent) and sub-line ----
  const headline = String(spec.headline || '').trim() || 'Your headline';
  const head2 = String(spec.headline2 || '').trim();
  let y = topY + Math.round(14 * u);
  const subRoom = spec.sub ? Math.round(headH * 0.2) : 0;
  const h1Room = Math.round((headH - subRoom) * (head2 ? 0.5 : 0.8));
  // one line each: the biggest size at which the line fits the width AND its share of the height
  const oneLine = async (text, color) => {
    let size = Math.round((wide ? 128 : 112) * u * (wide ? 1 : 1.3)); let t = await H.textPng(text, { size, color, bold: true, width: 6000 });
    while ((t.w > textW || t.h > h1Room) && size > 24) { size = Math.max(24, Math.floor(size * 0.92)); t = await H.textPng(text, { size, color, bold: true, width: 6000 }); } // eslint-disable-line no-await-in-loop
    return t;
  };
  const h1 = await oneLine(headline.toUpperCase(), '#ffffff');
  put(h1.buf, m, y); y += h1.h + Math.round(30 * u);
  if (head2) {
    const h2 = await oneLine(head2.toUpperCase(), accent);
    put(h2.buf, m, y); y += h2.h + Math.round(24 * u);
  }
  if (chipUnder) { // the website link right under the headline, on one line
    const ch = Math.round((wide ? 62 : 74) * u * (wide ? 1 : 1.2)); const cm = await chipMake(ch, textW);
    await chipPut(cm, ch, cm.pill, m, y); y += ch + Math.round(22 * u);
  }
  if (spec.sub) {
    const sb = await fit(String(spec.sub).trim(), { max: Math.round(46 * u * (wide ? 1 : 1.3)), min: 18, width: textW, maxH: Math.max(40, topY + headH - y), color: '#ffffff', bold: true });
    put(sb.buf, m, y + Math.round(10 * u)); y += sb.h + Math.round(10 * u);
    put(svg(Math.round(textW * 0.7), 3, `<rect width="100%" height="3" fill="${accent}" fill-opacity="0.55"/>`), m, y + Math.round(8 * u));
  }

  // ---- hero picture (or a glowing chip) ----
  const hx = wide ? Math.round(w * 0.6) : m; const hw = wide ? w - hx - m : w - 2 * m;
  const hy = wide ? topY + Math.round(10 * u) : Math.min(y + Math.round(30 * u), topY + headH - Math.round(250 * u)); const hh = wide ? headH : Math.max(Math.round(250 * u), topY + headH - hy);
  if (spec.photo) {
    put(svg(hw + 40, hh + 40, `<rect x="20" y="20" width="${hw}" height="${hh}" rx="${Math.round(26 * u)}" fill="#7dd3fc" fill-opacity="0.35" filter="url(#b)"/><defs><filter id="b"><feGaussianBlur stdDeviation="${Math.round(18 * u)}"/></filter></defs>`), hx - 20, hy - 20);
    put(await roundCorners(await cover(spec.photo, hw, hh), hw, hh, Math.round(26 * u)), hx, hy);
    put(svg(hw, hh, `<rect x="1.5" y="1.5" width="${hw - 3}" height="${hh - 3}" rx="${Math.round(26 * u)}" fill="none" stroke="#bae6fd" stroke-opacity="0.7" stroke-width="3"/>`), hx, hy);
  } else {
    const d = Math.min(hw * 0.5, hh * 0.78); const cx = hx + hw / 2 - d / 2; const cy = hy + hh / 2 - d / 2;
    put(svg(d + 80, d + 80, `<defs><filter id="g"><feGaussianBlur stdDeviation="${d * 0.07}"/></filter></defs><rect x="40" y="40" width="${d}" height="${d}" rx="${d * 0.2}" fill="#38bdf8" fill-opacity="0.6" filter="url(#g)"/>
      <rect x="40" y="40" width="${d}" height="${d}" rx="${d * 0.2}" fill="#0b2a5b" stroke="#7dd3fc" stroke-width="4"/>${[0.25, 0.5, 0.75].map((f) => `<path d="M${40 + d * f} 40 v-${d * 0.12} M${40 + d * f} ${40 + d} v${d * 0.12} M40 ${40 + d * f} h-${d * 0.12} M${40 + d} ${40 + d * f} h${d * 0.12}" stroke="#7dd3fc" stroke-width="5"/>`).join('')}`), cx - 40, cy - 40);
    const subject = [spec.headline, spec.headline2, spec.sub, ...services].join(' ');
    const techWords = /\bai\b|artificial|software|digital|tech|data|automation|cyber|cloud|app\b/i.test(subject);
    if (spec.badge || techWords) {
      const bt = await fit(String(spec.badge || 'AI').toUpperCase(), { max: Math.round(d * 0.4), min: 20, width: Math.round(d * 0.8), maxH: Math.round(d * 0.6), color: '#ffffff', bold: true, align: 'center' });
      put(bt.buf, cx + (d - bt.w) / 2, cy + (d - bt.h) / 2);
    } else {
      const isz = Math.round(d * 0.62); // the icon of what the post is about
      const headWords = [spec.headline, spec.headline2].join(' '); // the icon follows the HEADLINE (a heart for a heart post); the other words only when the headline names nothing
      const iconKey = RULES.some(([re]) => re.test(headWords)) ? iconFor(headWords, 0) : iconFor(subject, 0);
      put(await sharp(Buffer.from(iconSvg(iconKey, isz, '#ffffff', 1.5))).png().toBuffer(), cx + (d - isz) / 2, cy + (d - isz) / 2);
    }
  }
  y = topY + headH + gap;

  // ---- services: a title pill on a line, then icon columns ----
  if (svcRows) {
    if (spec.servicesTitle) {
      const tt = await textPng(String(spec.servicesTitle).trim(), { size: Math.round(36 * u * (wide ? 1 : 1.25)), color: '#0b2a5b', bold: true, width: Math.round(w * 0.6), align: 'center' });
      const pw = tt.w + Math.round(90 * u); const ph = tt.h + Math.round(22 * u);
      put(svg(w - 2 * m, 4, `<rect y="1" width="100%" height="2" fill="#bae6fd" fill-opacity="0.55"/>`), m, y + ph / 2);
      put(svg(pw, ph, `<rect width="${pw}" height="${ph}" rx="${ph / 2}" fill="#ffffff"/>`), (w - pw) / 2, y);
      put(tt.buf, (w - tt.w) / 2, y + (ph - tt.h) / 2);
      y += Math.round(80 * u * (wide ? 1 : 1.2));
    }
    const colW = (w - 2 * m) / perRow;
    for (let i = 0; i < services.length; i += 1) {
      const r = Math.floor(i / perRow); const k = i % perRow; const inRow = Math.min(perRow, services.length - r * perRow);
      const rowW = inRow * colW; const x0 = m + (w - 2 * m - rowW) / 2 + k * colW; const yy = y + r * (iconD + labelH + Math.round(24 * u));
      put(svg(iconD, iconD, `<circle cx="${iconD / 2}" cy="${iconD / 2}" r="${iconD / 2 - 3}" fill="#0b2a5b" fill-opacity="0.55" stroke="#7dd3fc" stroke-opacity="0.8" stroke-width="3"/>`), x0 + (colW - iconD) / 2, yy);
      put(await sharp(Buffer.from(iconSvg(iconFor(services[i], i), Math.round(iconD * 0.52), '#bae6fd', 1.8))).png().toBuffer(), x0 + (colW - iconD * 0.52) / 2, yy + iconD * 0.24);
      const lb = await fit(services[i], { max: Math.round(27 * u * (wide ? 1 : 1.3)), min: 14, width: Math.round(colW * 0.92), maxH: labelH, color: '#ffffff', bold: false, align: 'center' });
      put(lb.buf, x0 + (colW - lb.w) / 2, yy + iconD + Math.round(8 * u));
      if (k > 0) put(svg(3, iconD + labelH, '<rect width="3" height="100%" fill="#7dd3fc" fill-opacity="0.25"/>'), x0, yy);
    }
    y += svgRowsHeight(svcRows, iconD, labelH, u);
  }

  // ---- price cards ----
  if (plans.length) {
    const cw = Math.min(Math.round((w - 2 * m - (plans.length - 1) * gap) / plans.length), Math.round(500 * u * (wide ? 1 : 1.5)));
    const total = plans.length * cw + (plans.length - 1) * gap; const x0 = (w - total) / 2;
    const topPart = Math.round(planH * 0.42);
    for (let i = 0; i < plans.length; i += 1) {
      const p = plans[i]; const x = x0 + i * (cw + gap);
      put(svg(cw + 12, planH + 14, `<rect x="6" y="10" width="${cw}" height="${planH}" rx="${Math.round(24 * u)}" fill="#000000" fill-opacity="0.35"/><rect x="0" y="0" width="${cw}" height="${planH}" rx="${Math.round(24 * u)}" fill="#ffffff"/><path d="M0 ${topPart} V${Math.round(24 * u)} a${Math.round(24 * u)} ${Math.round(24 * u)} 0 0 1 ${Math.round(24 * u)} -${Math.round(24 * u)} H${cw - Math.round(24 * u)} a${Math.round(24 * u)} ${Math.round(24 * u)} 0 0 1 ${Math.round(24 * u)} ${Math.round(24 * u)} V${topPart} Z" fill="${accent}"/>`), x - 0, y);
      const nm = await fit(String(p.name || ''), { max: Math.round(planH * 0.26), min: 14, width: Math.round(cw * 0.86), maxH: Math.round(topPart * 0.8), color: onAccent, bold: true, align: 'center' });
      put(nm.buf, x + (cw - nm.w) / 2, y + (topPart - nm.h) / 2);
      const price = String(p.price || '').trim(); const unit = String(p.unit || '').trim();
      const pr = await fit(price, { max: Math.round(planH * 0.34), min: 16, width: Math.round(cw * (unit ? 0.62 : 0.86)), maxH: Math.round((planH - topPart) * 0.7), color: '#0b2a5b', bold: true, align: unit ? 'left' : 'center' });
      let ux = 0; let un = null;
      if (unit) { un = await textPng(unit, { size: Math.round(planH * 0.15), color: '#334155', bold: false, width: Math.round(cw * 0.3) }); }
      const tw = pr.w + (un ? un.w + 8 : 0);
      put(pr.buf, x + (cw - tw) / 2, y + topPart + ((planH - topPart) - pr.h) / 2); ux = x + (cw - tw) / 2 + pr.w + 8;
      if (un) put(un.buf, ux, y + topPart + ((planH - topPart) - pr.h) / 2 + pr.h - un.h - 4);
    }
    y += planH + gap;
  }

  // ---- who it is for + the website chip ----
  if (hasAud) {
    put(svg(w, h - y, `<rect x="0" y="0" width="${w}" height="${h - y}" fill="#02101f" fill-opacity="0.35"/><rect x="0" y="0" width="${w}" height="2" fill="#7dd3fc" fill-opacity="0.35"/>`), 0, y);
    const chOne = Math.round(76 * u * (wide ? 1 : 1.2)); const chipBottom = chipText && !chipUnder ? await chipMake(chOne, Math.round(w * (wide ? 0.4 : 0.62))) : null;
    const chipW = chipBottom ? Math.max(Math.round(w * (wide ? 0.2 : 0.36)), chipBottom.pill) : 0;
    const textLeft = m + Math.round(110 * u * (wide ? 1 : 1.2));
    put(await sharp(Buffer.from(iconSvg('users', Math.round(84 * u * (wide ? 1 : 1.2)), '#ffffff', 1.6))).png().toBuffer(), m, y + Math.round(30 * u));
    const aw = w - textLeft - m - chipW - (chipW ? gap : 0);
    let ay = y + Math.round(26 * u);
    if (spec.audienceTitle) { const at = await fit(String(spec.audienceTitle).trim(), { max: Math.round(34 * u * (wide ? 1 : 1.3)), min: 14, width: aw, maxH: Math.round(48 * u * 1.3), color: accent, bold: true }); put(at.buf, textLeft, ay); ay += at.h + Math.round(26 * u * (wide ? 1 : 1.3)); }
    if (spec.audience) { const ad = await fit(String(spec.audience).trim(), { max: Math.round(30 * u * (wide ? 1 : 1.3)), min: 13, width: aw, maxH: Math.max(30, h - ay - Math.round(34 * u)), color: '#ffffff', bold: false }); put(ad.buf, textLeft, ay); }
    if (chipBottom) { const cx = w - m - chipW; const cy = y + Math.round(((h - y) - chOne) / 2) - Math.round(10 * u); await chipPut(chipBottom, chOne, chipW, cx, cy); }
  }
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: deep } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  return { buf, w, h };
}
const svgRowsHeight = (rows, iconD, labelH, u) => rows * (iconD + labelH + Math.round(24 * u)) + Math.round(30 * u);

module.exports = { makeShowcase, ICONS, iconFor };

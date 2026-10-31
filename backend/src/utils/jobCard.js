// ---------------------------------------------------------------------------
// JOB CARD: the picture of a job that Instagram needs (Instagram has no text-only post). A square JPEG drawn with sharp from an SVG:
// "We are hiring", the job title, the place / experience / work mode, the pay only when the poster wants it shown, and where to apply.
// It carries ONLY what is already public on the careers page (never the client's name, the fee or the agreement): the facts come from
// utils/jobText.buildFacts, which already hides the client.
//
// Fonts: the text is drawn with the Liberation Sans files in backend/assets/fonts, so the picture reads the same on any computer
// or server (a server without fonts would otherwise print empty boxes). FONTCONFIG_FILE is pointed at them before the first drawing.
//
// GET /api/public/job-card/<requirement id>.jpg  (public: Instagram's servers fetch it; only for an open, non-internal job)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const prisma = require('../db');

const SIZE = 1080;
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
let ready = false;

function useBundledFonts() {
  if (ready) return;
  ready = true;
  try {
    const dir = path.join(os.tmpdir(), 'teamlink-fontconfig');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'fonts.conf');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fs.writeFileSync(file, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n<dir>${esc(FONT_DIR)}</dir>\n<cachedir>${esc(path.join(dir, 'cache'))}</cachedir>\n</fontconfig>\n`);
    process.env.FONTCONFIG_FILE = file;
  } catch { /* system fonts then */ }
}

const xml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Split a text into lines of at most `max` characters (words are not cut); the last line gets an ellipsis when the text does not fit.
function wrap(text, max, lines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((`${cur} ${w}`).length <= max) cur = `${cur} ${w}`;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) { const keep = out.slice(0, lines); keep[lines - 1] = `${keep[lines - 1].replace(/[\s,.;:-]+$/, '').slice(0, Math.max(1, max - 1))}…`; return keep; }
  return out;
}

// -> an SVG string. f = { title, location, experience, workMode, employmentType, salary, skills[] }, o = { company, apply, salary: bool }
function svgOf(f, o = {}) {
  const title = wrap(f.title || 'New opening', 22, 3);
  const size = title.length >= 3 ? 76 : 92;
  const facts = [f.location && ['Where', String(f.location).split(/[/|]/)[0].trim()], f.experience && ['Experience', f.experience], f.workMode && ['Work mode', f.workMode], f.employmentType && ['Type', f.employmentType], o.salary && f.salary && ['Pay', f.salary]]
    .filter(Boolean).slice(0, 4);
  const skills = (f.skills || []).slice(0, 5).join('  •  ');
  const rows = [];
  let y = 330 + title.length * (size + 14) + 36;
  title.forEach((t, i) => rows.push(`<text x="90" y="${330 + (i + 1) * (size + 14) - 30}" font-size="${size}" font-weight="700" fill="#ffffff">${xml(t)}</text>`));
  facts.forEach(([k, v]) => {
    rows.push(`<text x="90" y="${y}" font-size="30" fill="#9fb4d9">${xml(k.toUpperCase())}</text>`);
    rows.push(`<text x="330" y="${y}" font-size="36" font-weight="700" fill="#ffffff">${xml(wrap(v, 30, 1)[0])}</text>`);
    y += 62;
  });
  if (skills) rows.push(`<text x="90" y="${Math.min(y + 20, 878)}" font-size="30" fill="#c9d6ef">${xml(wrap(skills, 56, 1)[0])}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="Liberation Sans, Arial, Helvetica, sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b2a5b"/><stop offset="1" stop-color="#1a4fa3"/></linearGradient></defs>
<rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>
<rect x="90" y="110" width="330" height="64" rx="32" fill="#ffc94a"/>
<text x="255" y="154" font-size="34" font-weight="700" fill="#0b2a5b" text-anchor="middle">WE ARE HIRING</text>
<text x="90" y="260" font-size="34" fill="#c9d6ef">${xml(o.company || '')}</text>
${rows.join('\n')}
<rect x="0" y="${SIZE - 170}" width="${SIZE}" height="170" fill="#ffffff"/>
<text x="90" y="${SIZE - 96}" font-size="44" font-weight="700" fill="#0b2a5b">Apply now</text>
<text x="90" y="${SIZE - 48}" font-size="30" fill="#33415c">${xml(o.apply || '')}</text>
</svg>`;
}

async function render(f, o = {}) {
  useBundledFonts();
  const sharp = require('sharp'); // eslint-disable-line global-require
  return sharp(Buffer.from(svgOf(f, o))).jpeg({ quality: 90, mozjpeg: false }).toBuffer();
}

// The card of one requirement (facts from the same engine the posts use; the client is never named).
async function cardFor(requirementId, { base = '', salary = false } = {}) {
  const r = await prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } });
  if (!r) return { error: 'not found', status: 404 };
  const jt = require('./jobText'); // eslint-disable-line global-require
  const { requirementIsLive } = require('./atsVocab'); // eslint-disable-line global-require
  if (r.internal || !requirementIsLive(r.status)) return { error: 'This job is not open to the public.', status: 404 };
  const f = await jt.buildFacts(r, {}, base);
  const root = String(base || process.env.APP_BASE_URL || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const { PUBLIC_COMPANY } = require('./jobBoards/common'); // eslint-disable-line global-require
  return { jpeg: await render(f, { company: PUBLIC_COMPANY, apply: root ? `${root}/careers` : 'Apply on our careers page', salary }) };
}

const router = express.Router();
router.get('/:id.jpg', async (req, res) => {
  try {
    const out = await cardFor(String(req.params.id), { salary: String(req.query.s || '') === '1' });
    if (out.error) return res.status(out.status || 404).json({ error: out.error });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' });
    return res.send(out.jpeg);
  } catch { return res.status(500).json({ error: 'The picture could not be made.' }); }
});

module.exports = { router, render, svgOf, cardFor, useBundledFonts };

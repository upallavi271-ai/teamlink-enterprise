// ---------------------------------------------------------------------------
// MULTI-LANGUAGE INTERFACE (market benchmark 13.06): each person's language (English default, Telugu, Hindi), kept on their login so it
// follows them to another browser. The words themselves are in frontend/src/i18n.jsx.
//   GET /i18n/me -> { lang, languages }      PUT /i18n/me { lang }      GET /i18n/usage (Admin) how many people use each language
// ---------------------------------------------------------------------------
const express = require('express');
const S = require('./store');

const LANGS = ['en', 'te', 'hi'];
const router = express.Router();
router.get('/i18n/me', S.wrap(async (req, res) => {
  const v = await S.settings.get(`lang:${req.user.id}`, { lang: 'en' });
  res.json({ lang: LANGS.includes(v.lang) ? v.lang : 'en', languages: LANGS });
}));
router.put('/i18n/me', S.wrap(async (req, res) => {
  if (req.viewAs) return res.status(403).json({ error: 'View As is read-only.' });
  const lang = String((req.body || {}).lang || '');
  if (!LANGS.includes(lang)) return res.status(400).json({ error: 'English, Telugu or Hindi.' });
  await S.settings.set(`lang:${req.user.id}`, { lang }, req.user);
  res.json({ lang });
}));
router.get('/i18n/usage', S.adminOnly, S.wrap(async (req, res) => {
  await S.ensure();
  const rows = await require('../../db').$queryRawUnsafe('SELECT "value" FROM "AtsPlusSetting" WHERE "key" LIKE \'lang:%\''); // eslint-disable-line global-require
  const n = { en: 0, te: 0, hi: 0 };
  rows.forEach((r) => { try { const l = JSON.parse(r.value).lang; if (n[l] !== undefined) n[l] += 1; } catch { /* skip */ } });
  res.json({ usage: n });
}));
module.exports = { router, LANGS };

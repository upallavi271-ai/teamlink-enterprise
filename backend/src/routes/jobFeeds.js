// ---------------------------------------------------------------------------
// /api/public/feeds/:board.xml — job feeds a board PULLS (Save & Post, 2026-10-05).
//
//   GET /api/public/feeds/naukri.xml   the live jobs ticked for Naukri, when the
//                                      Naukri card's posting method is "XML feed"
//
// Naukri publishes no feed format; this uses the common job-feed shape
// (<source><job><title><date><referencenumber><url><company><city>…) that job
// boards read. The exact element names are agreed with Naukri when the feed
// is set up on their side. The client is never named (TeamLink Consultants).
// Being in this feed is NOT "Posted": the job page says "Sent, waiting for
// confirmation" until the board confirms the job is live.
// A read from outside this server is remembered (AppSetting feed.<board>.lastRead)
// so the Integrations card can show when the board last fetched it.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { REQUIREMENT_LIVE_STATUSES } = require('../utils/atsVocab');
// eslint-disable-next-line global-require
const siteTicked = (r, id) => require('../utils/jobPosting').siteTicked(r, id);
const { readConfig } = require('../utils/integrationStore');
const { careersPath } = require('../utils/jobSlug');

const router = express.Router();
const BOARDS = { naukri: { label: 'Naukri', method: 'Posting method (Amplify API / XML feed)' } };

// eslint-disable-next-line no-control-regex
const xmlSafe = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const cdata = (v) => `<![CDATA[${xmlSafe(v).split(']]>').join(']]]]><![CDATA[>')}]]>`;
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const publicBase = (req) => (process.env.APP_BASE_URL ? String(process.env.APP_BASE_URL).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183'));

router.get('/:board.xml', async (req, res) => {
  const board = BOARDS[String(req.params.board || '').toLowerCase()];
  if (!board) return res.status(404).type('text/plain').send('No such feed');
  const cfg = await readConfig(req.params.board.toLowerCase());
  const feedOn = /xml/i.test(String((cfg.values || {})[board.method] || '')) && !(cfg.row && cfg.row.connected === false);
  const jobs = feedOn
    ? (await prisma.requirement.findMany({ where: { status: { in: REQUIREMENT_LIVE_STATUSES } }, orderBy: { createdAt: 'desc' } }))
      .filter((j) => siteTicked(j, req.params.board.toLowerCase()))
    : [];
  const base = publicBase(req);
  const items = jobs.map((j) => `  <job>
    <title>${cdata(j.title)}</title>
    <date>${cdata(new Date(j.portalPublishedAt || j.createdAt).toUTCString())}</date>
    <referencenumber>${cdata(j.id)}</referencenumber>
    <requisitionid>${cdata(j.reqCode || j.id)}</requisitionid>
    <url>${cdata(`${base}${careersPath(j, board.label)}`)}</url>
    <company>${cdata('TeamLink Consultants')}</company>
    <city>${cdata(String(j.location || '').split(/[,/|]/)[0].trim() || 'India')}</city>
    <country>${cdata('IN')}</country>
    <description>${cdata([j.jobDescription || j.description || '', j.responsibilities ? `Responsibilities:\n${j.responsibilities}` : '', j.qualifications ? `Qualifications:\n${j.qualifications}` : ''].filter(Boolean).join('\n\n'))}</description>
    <salary>${cdata(j.salary || '')}</salary>
    <experience>${cdata(j.experience || '')}</experience>
    <jobtype>${cdata(j.employmentType || '')}</jobtype>
    <skills>${cdata(csv(j.skills).join(', '))}</skills>
  </job>`).join('\n');
  // Remember a read by the board (not our own checks from this server).
  const ip = String(req.ip || '');
  if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) {
    const key = `feed.${req.params.board.toLowerCase()}.lastRead`;
    const value = JSON.stringify({ at: new Date().toISOString(), agent: String(req.get('user-agent') || '').slice(0, 120), jobs: jobs.length });
    prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => {});
  }
  res.set('Cache-Control', 'no-store');
  return res.type('application/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>TeamLink Consultants</publisher>
  <publisherurl>${cdata(base)}</publisherurl>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</source>
`);
});

module.exports = router;

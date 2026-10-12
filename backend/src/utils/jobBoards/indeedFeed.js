// ---------------------------------------------------------------------------
// INDEED — the XML feed in Indeed's own format (served at
// /api/public/feeds/indeed.xml, routes/jobFeeds.js).
//
// Spec: https://docs.indeed.com/indeed-apply/xml-feed (checked 2026-10-09)
//   required  <title> <date> <referencenumber> <requisitionid> <url> (with
//             source=Indeed) <company> <city> <state> <country> <email>
//             <description>
//   "required if on career site" <salary> <education> <jobtype> <experience>
//             <expirationdate>; recommended <category>
//   rules     values in CDATA, no HTML entities, every element on every job
//             even when blank, every live job in every fetch, no test jobs.
//   Indeed fetches a crawlable URL 4 times a day.
//
// What goes in: live CLIENT jobs ticked for Indeed (never an internal hire).
// The client is not named: the advertiser is TeamLink Consultants.
//
// Being in this feed is NEVER "Posted": Indeed does not take a feed by itself.
// The link is sent to the Indeed representative / Employer Support, and a
// staffing firm's jobs may need a sponsored campaign (see the Indeed card on
// Administration -> Integrations).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const { REQUIREMENT_LIVE_STATUSES } = require('../atsVocab');
const { readConfig } = require('../integrationStore');
const { careersPath } = require('../jobSlug');

const STATE_OF = {
  hyderabad: 'Telangana', secunderabad: 'Telangana', warangal: 'Telangana', bengaluru: 'Karnataka', bangalore: 'Karnataka', mysuru: 'Karnataka', mysore: 'Karnataka',
  chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu', mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra', delhi: 'Delhi', 'new delhi': 'Delhi',
  noida: 'Uttar Pradesh', lucknow: 'Uttar Pradesh', gurgaon: 'Haryana', gurugram: 'Haryana', kolkata: 'West Bengal', ahmedabad: 'Gujarat', surat: 'Gujarat', jaipur: 'Rajasthan',
  kochi: 'Kerala', trivandrum: 'Kerala', thiruvananthapuram: 'Kerala', vijayawada: 'Andhra Pradesh', visakhapatnam: 'Andhra Pradesh', vizag: 'Andhra Pradesh', guntur: 'Andhra Pradesh',
  tirupati: 'Andhra Pradesh', bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', chandigarh: 'Chandigarh', bhubaneswar: 'Odisha',
};
const JOBTYPE = { 'full time': 'fulltime', 'part time': 'parttime', contract: 'contract', contractual: 'contract', temporary: 'temporary', internship: 'internship', intern: 'internship' };

// XML 1.0 forbids most control characters even inside CDATA.
// eslint-disable-next-line no-control-regex
const xmlSafe = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const cdata = (v) => `<![CDATA[${xmlSafe(v).split(']]>').join(']]]]><![CDATA[>')}]]>`;
const publicBase = (req) => (process.env.APP_BASE_URL
  ? String(process.env.APP_BASE_URL).replace(/\/+$/, '')
  : `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183'));

// The Indeed text the poster saved in "Write the job posts" wins (without its "[ ]" lines). Otherwise
// the job's own text, minus the team's internal tracker notes and with the client's name taken out.
const description = (j, saved) => {
  const W = require('../jobPostWriter'); // eslint-disable-line global-require
  const names = j.client ? [j.client.name, j.client.legalName].map((n) => String(n || '').trim()).filter((n) => n.length >= 3) : [];
  const out = saved && saved.text ? W.stripBlanks(saved.text) : [
    W.publishable(j.jobDescription || j.description || '').text,
    j.responsibilities ? `Responsibilities:\n${j.responsibilities}` : '',
    j.qualifications ? `Qualifications:\n${j.qualifications}` : '',
  ].filter(Boolean).join('\n\n');
  return names.reduce((t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'our client'), out);
};

function jobXml(j, base, email, sourcename, saved) {
  const city = String(j.location || '').split(/[,/|]/)[0].trim();
  const closing = j.closingDate && !Number.isNaN(new Date(j.closingDate).getTime()) ? new Date(j.closingDate).toISOString().slice(0, 10) : '';
  const url = `${base}${careersPath(j, 'Indeed')}&source=Indeed`;
  const work = String(j.workMode || '');
  const remote = /remote/i.test(work) ? 'Fully remote' : (/hybrid/i.test(work) ? 'Hybrid remote' : '');
  return `  <job>
    <title>${cdata((saved && saved.title) || j.title)}</title>
    <date>${cdata(new Date(j.portalPublishedAt || j.createdAt).toISOString())}</date>
    <referencenumber>${cdata(j.id)}</referencenumber>
    <requisitionid>${cdata(j.reqCode || j.id)}</requisitionid>
    <url>${cdata(url)}</url>
    <company>${cdata('TeamLink Consultants')}</company>
    <sourcename>${cdata(sourcename)}</sourcename>
    <city>${cdata(city)}</city>
    <state>${cdata(STATE_OF[city.toLowerCase()] || '')}</state>
    <country>${cdata('IN')}</country>
    <postalcode>${cdata('')}</postalcode>
    <streetaddress>${cdata('')}</streetaddress>
    <email>${cdata(email)}</email>
    <description>${cdata(description(j, saved))}</description>
    <salary>${cdata(j.salary && j.salary !== '—' ? j.salary : '')}</salary>
    <education>${cdata(j.education && !/^any/i.test(j.education) ? j.education : '')}</education>
    <jobtype>${cdata(JOBTYPE[String(j.employmentType || '').toLowerCase()] || '')}</jobtype>
    <experience>${cdata(j.experience || '')}</experience>
    <expirationdate>${cdata(closing)}</expirationdate>
    <category>${cdata(j.department || '')}</category>
    <remotetype>${cdata(remote)}</remotetype>
  </job>`;
}

async function build(base) {
  const cfg = await readConfig('indeed');
  const v = cfg.values || {};
  const email = String(v['Contact email for Indeed'] || '').trim();
  const sourcename = String(v['Source name (as agreed with Indeed)'] || '').trim() || 'TeamLink Consultants';
  const siteTicked = (r) => require('../jobPosting').siteTicked(r, 'indeed'); // eslint-disable-line global-require
  const jobs = (await prisma.requirement.findMany({ where: { status: { in: REQUIREMENT_LIVE_STATUSES }, portalPublished: true }, orderBy: { createdAt: 'desc' }, include: { client: { select: { name: true, legalName: true } } } }))
    .filter((j) => !j.internal && siteTicked(j));
  const savedTexts = await require('../jobPostWriter').savedIndeedTexts().catch(() => ({})); // eslint-disable-line global-require
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>TeamLink Consultants</publisher>
  <publisherurl>${cdata(base)}</publisherurl>
${jobs.map((j) => jobXml(j, base, email, sourcename, savedTexts[j.id])).join('\n')}
</source>
`;
  return { xml, jobs: jobs.length, emailSet: !!email };
}

async function handler(req, res) {
  const out = await build(publicBase(req));
  // A read from outside this server is remembered (the card shows "last read by Indeed").
  if (!/^(::1|127\.|::ffff:127\.)/.test(String(req.ip || ''))) {
    const key = 'feed.indeed.lastRead';
    const value = JSON.stringify({ at: new Date().toISOString(), agent: String(req.get('user-agent') || '').slice(0, 120), jobs: out.jobs });
    prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => {});
  }
  res.set('Cache-Control', 'no-store');
  res.type('application/xml').send(out.xml);
}

module.exports = { handler, build, STATE_OF };

// ---------------------------------------------------------------------------
// /api/naukri/status — what TeamLink can really do with NAUKRI, in plain words.
//
// Researched 2026-10-09 from Naukri / Info Edge / Zwayam pages and partner ATS
// help pages (the URLs are in `docs` below). Naukri publishes NO public API,
// feed specification or developer portal: employers reach it through the paid
// job-posting plan plus the ATS integration module "Zwayam Amplify" (Zwayam is
// an Info Edge company), which Naukri's account manager turns on.
//
// Each capability is reported as one of:
//   Working        built here and doing its job right now
//   Built, needs   built here; only the named account / credential is missing
//   Not available  Naukri offers no way for us to do it — not built, not faked
//
// Nothing here calls Naukri. Counts come from our own database.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../utils/permissions');
const { PORTAL_APPLICATION_SOURCE } = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);

const DOCS = [
  { label: 'Zwayam Amplify: post once, applications land in your ATS', url: 'https://www.zwayam.com/zwayam-amplify' },
  { label: 'Naukri Recruiter Zone: ATS integration (support@naukri.com)', url: 'https://recruiterzone.naukri.com/tag/ats-integration/' },
  { label: 'Info Edge: Zwayam is an Info Edge company', url: 'https://www.infoedge.in/announcements/IEILReg30Zwayam11062021.pdf' },
  { label: 'How another ATS sets it up: Greenhouse', url: 'https://support.greenhouse.io/hc/en-us/articles/16297968058651-Naukri-integration' },
  { label: 'How another ATS sets it up: Lever', url: 'https://help.lever.co/hc/en-us/articles/20087453586333' },
  { label: 'How another ATS sets it up: Zoho Recruit', url: 'https://help.zoho.com/portal/en/kb/recruit/talent-sourcing/job-boards/premium-job-boards/articles/post-jobs-on-naukri-through-zoho-recruit' },
];

router.get('/status', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res, next) => {
  try {
    const board = await require('../utils/jobConnectors').boardStatus('naukri').catch(() => null); // eslint-disable-line global-require
    const sinceMonth = new Date(Date.now() - 30 * 86400000);
    const fromNaukri = { OR: [{ firstSource: 'Naukri' }, { source: 'Naukri' }] };
    const [total, month, last, waiting] = await Promise.all([
      prisma.candidate.count({ where: fromNaukri }),
      prisma.candidate.count({ where: { ...fromNaukri, createdAt: { gte: sinceMonth } } }),
      prisma.candidate.findFirst({ where: fromNaukri, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      // came through the portal's Naukri mailbox reader and not yet checked / sent to a job
      prisma.application.count({ where: { firstSource: 'Naukri', source: PORTAL_APPLICATION_SOURCE, portalImportedAt: null } }),
    ]);
    const postingReady = !!(board && board.ready);
    const feedOn = !!(board && board.feedUrl && /xml/i.test(String(board.method || '')));
    const posting = {
      id: 'posting',
      title: 'Post jobs to Naukri',
      state: postingReady ? (feedOn ? 'Working' : 'Working') : 'Built, needs your Naukri account',
      official: true,
      what: 'Save & Post sends each ticked job to Naukri. Naukri checks every job before it goes live (up to 24 hours), so a job shows "waiting for Naukri" until Naukri confirms. TeamLink never says "Posted" before Naukri does.',
      needs: postingReady ? [] : [
        'A paid Naukri job-posting plan (from your Naukri account manager).',
        'The ATS integration module "Zwayam Amplify" switched on for that plan (ask the account manager or amplify@zwayam.com).',
        'From them: the Amplify API key, the secret key and the job endpoint URL.',
      ],
      steps: postingReady ? [] : [
        'Ask your Naukri account manager to enable "Amplify" (ATS integration) on your plan.',
        'Open Administration → Integrations → Naukri → Configure.',
        'Choose the posting method "Amplify API", paste the API key, secret key and job endpoint URL, then Save & Connect.',
        'Press Check connection. Naukri has no test call, so it only checks that the details are filled in. The first requirement tells the truth.',
        'Tick Naukri when you Save & Post a requirement. The first requirement will show "waiting for Naukri" until Naukri confirms it.',
      ],
      detail: board ? { connection: board.connection, method: board.method || null, lastSuccessAt: board.lastSuccessAt || null, jobs: board.jobs || null, lastError: board.lastError || null, hint: board.ready ? null : (board.hint || null) } : null,
    };
    const feed = {
      id: 'feed',
      title: 'Job feed (XML) that Naukri can read',
      state: feedOn ? 'Working' : 'Switched off',
      official: false,
      what: 'TeamLink keeps an XML list of your live Naukri-ticked requirements at a public link. Naukri publishes no feed format: this only helps if Naukri agrees, for your account, to read it. A requirement in the feed is "sent, waiting for confirmation", never "Posted".',
      feedUrl: board ? board.feedUrl || null : null,
      lastRead: board && board.feedLastRead ? board.feedLastRead : null,
      steps: feedOn ? [] : ['Open Administration → Integrations → Naukri → Configure and choose the posting method "XML feed". Then give the feed link to your Naukri account manager and ask them to read it.'],
    };
    const email = {
      id: 'email-intake',
      title: 'Applicants from Naukri response emails',
      state: total > 0 ? 'Working' : 'Built, needs a mailbox',
      official: false,
      what: 'Naukri emails a recruiter every applicant (a daily "responses received" summary, and one email per applicant with the CV for an Nvite). The Job Portal reads that mailbox every 5 minutes, makes the candidate and the application, and they appear in Candidates → New from job portal (filter "New from Naukri") with Source = Naukri. Email addresses and phone numbers are often hidden by Naukri behind "View contact details", so those candidates may arrive without them.',
      counts: { candidates: total, last30days: month, lastArrivedAt: last ? last.createdAt : null, waitingToBeChecked: waiting },
      steps: total > 0 ? [] : [
        'In Naukri, make sure applicant emails go to one recruiting mailbox (Naukri → Settings → Email preferences / Response notifications).',
        'On the server, set the mailbox password as an environment variable for the Job Portal: MAILBOX_<ADDRESS>_PASSWORD (and _HOST if it is not mail.<your domain>). Gmail / Outlook need an app password.',
        'In the Job Portal (Recruiter → Email intake) add that mailbox and switch auto-sync on.',
        'Send yourself a test: forward one Naukri response email to the mailbox, wait 5 minutes, then open Candidates → New from job portal → Where from → New from Naukri.',
      ],
      link: '/candidates?view=job-portal&source=Naukri',
    };
    const intakeApi = {
      id: 'intake-api',
      title: 'Applicants and CVs straight from Naukri (API)',
      state: 'Not available without Naukri',
      official: true,
      what: 'When Amplify is switched on for your account, Naukri / Zwayam can send applications into an ATS directly. Naukri publishes no specification for this, so TeamLink cannot receive it until Naukri or Zwayam gives you the details at onboarding. Nothing is faked here.',
      steps: ['Ask Naukri / Zwayam for the "applications back to ATS" details when you onboard Amplify. Until then, use the email reader above.'],
    };
    const resdex = {
      id: 'resdex',
      title: 'Search and download CVs from Resdex',
      state: 'Not available',
      official: true,
      what: 'Resdex (Naukri\'s CV database) has no API or export for an ATS. Zwayam advertises its own Resdex connection, which is a separate paid product. TeamLink does not scrape Naukri or use browser add-ons. Download a CV in Naukri and upload it in Candidates (Add candidate / Upload resume) with Source = Naukri.',
      steps: [],
    };
    const messaging = {
      id: 'messaging',
      title: 'Message candidates through Naukri',
      state: 'Not available',
      official: true,
      what: 'Naukri has no public API for sending messages or calls to candidates; that happens inside Naukri with your Naukri credits. Once a candidate is on file here with a phone or email, use Message templates: Email, SMS or WhatsApp from TeamLink.',
      steps: [],
    };
    const hand = {
      id: 'hand',
      title: 'Post by hand with a ready-made job text',
      state: 'Working',
      official: true,
      what: 'Open any requirement, press "Post by hand" on the Naukri row: TeamLink gives the requirement in Naukri\'s order of fields to copy, opens Naukri\'s own page, and after you post it you press "I posted it". The row then reads "Posted by hand" with who and when, never "Posted". Works with a normal Naukri plan.',
      steps: [],
    };
    res.json({ capabilities: [hand, posting, feed, email, intakeApi, resdex, messaging], docs: DOCS, checkedOn: '2026-10-09' });
  } catch (err) { next(err); }
});

module.exports = router;

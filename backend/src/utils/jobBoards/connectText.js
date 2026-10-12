// ---------------------------------------------------------------------------
// THE CONNECT CARD TEXT — what a person must do to get each board working,
// in plain words. Researched 2026-10-09 (sources in TeamLink-Posting-and-
// Channels-Research.md). Prices are third-party and indicative; anything we
// could not verify from the board's own pages says so.
//
// Each route has a `state`:
//   works   works today in TeamLink, nothing to buy
//   built   TeamLink side is built; waiting for the board's account / approval
//   gated   the board does not give this to a company like ours (or not now)
// ---------------------------------------------------------------------------
const CHECKED = '2026-10-09';

const CONNECT = {
  naukri: {
    checkedOn: CHECKED,
    headline: 'Naukri has no open posting API. Today the quickest way is to post by hand; automatic posting needs a paid Naukri plan with their integration module (Zwayam "Amplify").',
    routes: [
      {
        id: 'hand', state: 'works', title: 'Post by hand (works today)',
        text: 'TeamLink prepares the job in Naukri\'s order of fields. A person pastes it into Naukri and presses "I posted it". Indicative price: a Hot Vacancy is about ₹1,650 + GST per job (a third-party figure, check with Naukri).',
      },
      {
        id: 'amplify', state: 'built', title: 'Automatic posting through Naukri Amplify (Zwayam)',
        text: 'TeamLink sends the job; Naukri checks it (up to 24 hours) and it goes live. Needs a paid Naukri recruiter plan, the "integration module" (extra cost, not published) and an API key from your Naukri Account Manager. Whether Naukri gives a key to a company\'s own system (not a known ATS) is not public: ask.',
      },
      {
        id: 'xml', state: 'built', title: 'XML job feed',
        text: 'Naukri once accepted a job feed (xmlposting@naukri.com). Whether it is still offered in 2026 could not be confirmed. TeamLink can serve a feed link if Naukri agrees to read it. A job in the feed shows "sent, waiting for confirmation", never "Posted".',
      },
    ],
    steps: [
      'Phone or mail your Naukri Account Manager. Ask: "I want to post jobs from my own system. Do you give an API key (Amplify integration module) for that? What does it cost? Is the XML feed (xmlposting@naukri.com) still available?"',
      'Ask for it in writing: the API key, the secret key, the job endpoint address, the list of fields Naukri needs, and how applicants come back (to our system, or by email).',
      'Open Configure on this card and paste the API key, secret key and endpoint. Press Save.',
      'Press "Check connection". (Naukri has no test call, so this only checks that the details are filled in. The first job tells the truth.)',
      'Tick Naukri on a job and press Save & Post. The row shows "waiting for Naukri" until Naukri confirms.',
    ],
    fields: [
      { label: 'API key', where: 'Given by Naukri / Zwayam (Amplify). Shown once; paste it here.' },
      { label: 'Secret key', where: 'Given with the API key.' },
      { label: 'Job endpoint URL', where: 'Given at onboarding. Must start with https://' },
      { label: 'Recruiter account email', where: 'The email of your Naukri recruiter login (optional, for our notes).' },
    ],
    leadTime: 'Weeks (sales-led). Not published by Naukri.',
    cost: 'Naukri plan + integration module: not published, ask. Hot Vacancy by hand: about ₹1,650 + GST per job (third-party figure).',
    applicants: 'Applicants from a Naukri job reach TeamLink by email: Naukri sends the response emails to your recruiting mailbox, the Job Portal reads that mailbox every 5 minutes and creates the candidate with Source = Naukri (this already works, built from real Naukri emails). Naukri often hides phone and email behind "View contact details". With Amplify, Naukri can send applicants straight into the system, but Naukri has not published how.',
    notPossible: [
      'Logging in to Naukri by a program, or copying jobs and CVs by a program, is against Naukri\'s terms. TeamLink does not do it.',
      'Resdex (the CV database) has no export for other systems.',
    ],
    docs: [
      { label: 'Greenhouse: how an ATS connects to Naukri', url: 'https://support.greenhouse.io/hc/en-us/articles/16297968058651' },
      { label: 'Zoho Recruit: post jobs through Naukri (Amplify)', url: 'https://help.zoho.com/portal/en/kb/recruit/talent-sourcing/job-boards/premium-job-boards/articles/post-jobs-on-naukri-through-zoho-recruit' },
      { label: 'Naukri: job posting FAQ', url: 'https://company.naukri.com/landing-page/naukri_faq/new/recruiter/job_posting.html' },
      { label: 'Naukri: XML job posting (old page)', url: 'https://recruiterzone.naukri.com/now-job-postings-using-xml-feeds/' },
    ],
    ask: { who: 'Your Naukri Account Manager (or amplify@zwayam.com)', what: 'An Amplify API key + integration module for our own system, the price, and how applicants come back.' },
  },

  shine: {
    checkedOn: CHECKED,
    headline: 'Shine publishes no posting API, feed or bulk upload. Post by hand today; ask Shine whether a partner route exists.',
    routes: [
      {
        id: 'hand', state: 'works', title: 'Post by hand (works today)',
        text: 'TeamLink prepares the job; a person pastes it in Shine and presses "I posted it". Plans (third-party, indicative): about ₹4,999 for 3 postings up to ₹22,999 for 45 postings.',
      },
      {
        id: 'partner', state: 'gated', title: 'Automatic posting',
        text: 'Only one outside system (Zoho Recruit) is known to post to Shine, with the company\'s own Shine login. No public document says how. TeamLink is built to send jobs once Shine gives an "ATS job-posting" account (API key + endpoint). Until then nothing is sent.',
      },
    ],
    steps: [
      'Ask your Shine / HT Media recruiter relationship manager: "Is there an XML, API or bulk-upload route, or an ATS partner programme, to post jobs from our own system?"',
      'If yes: get the API key, the job endpoint address and the field list in writing. Open Configure on this card, paste them and press Save.',
      'Press "Check connection", then tick Shine on a job and press Save & Post.',
      'If no: keep posting by hand. Nothing else is needed.',
    ],
    fields: [
      { label: 'API key', where: 'Given by Shine at onboarding.' },
      { label: 'Job endpoint URL', where: 'Given by Shine. Must start with https://' },
      { label: 'Secret key', where: 'Only if Shine gives one.' },
    ],
    leadTime: 'Unknown. Shine has not published a partner route.',
    cost: 'A paid recruiter plan (about ₹4,999 to ₹22,999, third-party figures). Needs company KYC (registration, GST, PAN).',
    applicants: 'Shine response emails go to your recruiting mailbox. The Job Portal reads them every 5 minutes and creates the candidate with Source = Shine (built from real Shine emails; the CV attached has the contact details).',
    notPossible: ['Logging in to Shine by a program is not done by TeamLink.'],
    docs: [
      { label: 'Zoho Recruit: Shine integration', url: 'https://help.zoho.com/portal/en/kb/recruit/talent-sourcing/job-boards/premium-job-boards/articles/integrate-shine-with-zoho-recruit' },
    ],
    ask: { who: 'Your Shine / HT Media recruiter relationship manager', what: 'Is there an API, XML or ATS partner route to post jobs? If yes, the key, endpoint and field list.' },
  },

  indeed: {
    checkedOn: CHECKED,
    headline: 'Indeed gives two official routes: an XML job feed (TeamLink serves it now; Indeed adds it for you) and the Job Sync API (partner approval, about 6 weeks). Indeed may ask a staffing firm to pay (sponsor) its jobs.',
    routes: [
      {
        id: 'feed', state: 'works', title: 'XML job feed (works today, Indeed must add the link)',
        text: 'TeamLink serves every Indeed-ticked job in Indeed\'s own format at the link below. Copy it, send it to your Indeed representative or Indeed Employer Support, and they add it. Indeed reads it about 4 times a day. Jobs from a staffing firm are usually shown only when sponsored (a budget you set on Indeed).',
      },
      {
        id: 'api', state: 'built', title: 'Job Sync API (automatic, needs Indeed\'s approval)',
        text: 'Sign Indeed\'s Developer Agreement and apply as a partner. About 6 weeks. Then Indeed gives a Client ID and secret and TeamLink posts, updates and removes jobs by itself and reads whether each is live.',
      },
      {
        id: 'hand', state: 'works', title: 'Post by hand',
        text: 'A free Indeed employer account can post a job by hand. In India Indeed does not list free job posts, so expect to pay (sponsor).',
      },
    ],
    steps: [
      'Make an Indeed employer account with a TeamLink company email (employers.indeed.com). Keep that email: it goes into the feed.',
      'Open Configure on this card, choose "XML feed", type the same email in "Contact email for Indeed" and press Save.',
      'Press "Copy link" on the feed link shown above and send it to your Indeed representative (or Employer Support) with: "Please add this job feed to our account."',
      'Ask them how to sponsor the jobs (budget). Then tick Indeed on a job and Save & Post: it appears in the feed within seconds and the row says "sent, waiting for confirmation".',
      'For automatic posting later: sign the Developer Agreement at partners.indeed.com, wait for approval, choose "Job Sync API", paste the Client ID and secret and press "Check connection".',
    ],
    fields: [
      { label: 'Posting method', where: 'Choose "XML feed" now, or "Job Sync API" after approval.' },
      { label: 'Contact email for Indeed', where: 'The email of your Indeed employer account (used by Indeed to check who is posting).' },
      { label: 'Client ID / Client secret', where: 'Indeed Partner Console, after approval (API method only).' },
      { label: 'Source name', where: 'Only if Indeed tells you a name. Default: TeamLink Consultants. It cannot be changed later.' },
    ],
    leadTime: 'Feed: days to weeks (Indeed adds it). Job Sync API: about 6 weeks.',
    cost: 'No fee to connect. Ads are paid on Indeed: daily budget (pay per click) or monthly budget (pay per started application). Rates in rupees are not published. Billing: invoice on the 1st of the month or when spend reaches ₹44,000.',
    applicants: 'Candidates open the job on our career page and apply there (link tagged Source = Indeed). That works today. "Indeed Apply" (apply inside Indeed, CV sent to us) needs the partner approval; TeamLink does not receive it yet.',
    notPossible: [
      'Indeed shows no free job posts in India, and it may require sponsorship for a staffing firm\'s jobs "at its sole discretion".',
      'The feed cannot hide the client\'s name on Indeed itself; TeamLink shows TeamLink Consultants as the company.',
      'Posting the same job again and again is flagged as spam. TeamLink keeps one stable job id.',
    ],
    docs: [
      { label: 'Indeed: XML feed format', url: 'https://docs.indeed.com/indeed-apply/xml-feed' },
      { label: 'Indeed: Job Sync API', url: 'https://docs.indeed.com/job-sync-api/' },
      { label: 'Indeed: become a partner', url: 'https://partners.indeed.com/?becomePartner' },
      { label: 'Indeed: how pricing works in India', url: 'https://in.indeed.com/hire/resources/howtohub/how-pricing-works-on-indeed' },
    ],
    ask: { who: 'Your Indeed representative or Employer Support', what: 'Add our XML feed link to our employer account, and tell us what sponsorship a staffing firm needs.' },
  },

  linkedin: {
    checkedOn: CHECKED,
    headline: 'LinkedIn does not give automatic posting to a company like ours today: its Job Posting API is closed to new partners and its free feed is not for staffing firms. Post by hand (a paid job slot is usually needed).',
    routes: [
      {
        id: 'hand', state: 'works', title: 'Post by hand (works today)',
        text: 'TeamLink prepares the job; a person pastes it in LinkedIn (needs admin of your company page) and presses "I posted it". LinkedIn may ask you to pay (Job Slot or promoted job). Rupee prices are not published.',
      },
      {
        id: 'api', state: 'gated', title: 'Job Posting API / Apply Connect',
        text: 'LinkedIn says it is "not accepting new partnerships" for the Job Posting API. "Apply Connect" needs a LinkedIn Recruiter Corporate licence and LinkedIn\'s certification, with no promise of acceptance. TeamLink has the sender ready; it stays off until LinkedIn gives credentials.',
      },
      {
        id: 'xml', state: 'gated', title: 'Free job feed (Limited Listings)',
        text: 'Jobs from a staffing firm that hides the client\'s name are not accepted in LinkedIn\'s free feeds; they need paid promotion. Not built.',
      },
    ],
    steps: [
      'Make sure the TeamLink company page exists on LinkedIn and that you are an admin.',
      'Decide the budget: a paid Job Slot or promoted job per role (LinkedIn quotes in its own screen).',
      'Post by hand with the "Post by hand" button on the job. Press "I posted it" with the link.',
      'Only if you buy a Recruiter Corporate licence: ask LinkedIn Talent Solutions for Apply Connect access (business.linkedin.com/talent-solutions/ats-partners/partner-application). Then paste the Organization ID, Client ID, Client secret, poster email and API version here.',
    ],
    fields: [
      { label: 'Organization ID', where: 'LinkedIn company page id (numbers).' },
      { label: 'Client ID / Client secret', where: 'From the LinkedIn developer app LinkedIn approves for you.' },
      { label: 'Poster email', where: 'A company-domain email of the person posting.' },
      { label: 'API version', where: 'From LinkedIn\'s documentation, e.g. 202604.' },
    ],
    leadTime: 'Unknown, no promise. Manual posting: minutes.',
    cost: 'Paid Job Slot or promoted job (only dollar prices are public). Apply Connect needs a Recruiter Corporate licence.',
    applicants: 'People apply on our career page (link tagged Source = LinkedIn). That works today. With Apply Connect LinkedIn can send applicants to us; not available until you are approved.',
    notPossible: [
      'Logging in to LinkedIn by a program, or copying profiles or jobs by a program, is against LinkedIn\'s terms. TeamLink does not do it.',
      'A generic name like "Confidential" is not allowed for the company. TeamLink uses TeamLink Consultants.',
    ],
    docs: [
      { label: 'LinkedIn: Job Posting API (closed to new partners)', url: 'https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview' },
      { label: 'LinkedIn: Apply Connect', url: 'https://learn.microsoft.com/en-us/linkedin/talent/apply-connect/apply-connect-overview' },
      { label: 'LinkedIn: free job posts', url: 'https://www.linkedin.com/help/linkedin/answer/a517777' },
      { label: 'LinkedIn: feed rules for staffing firms', url: 'https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds-job-posting-guidelines' },
    ],
    ask: { who: 'LinkedIn Talent Solutions (sales) and the page admin', what: 'Price of a Job Slot in rupees for staffing jobs, and whether Apply Connect is open to us.' },
  },

  'google-jobs': {
    checkedOn: CHECKED,
    headline: 'Google for Jobs is free and works now: every job page on our career site carries the data Google reads. Connecting a Google service account only makes Google hear about a job sooner.',
    routes: [
      {
        id: 'markup', state: 'works', title: 'Job data on our career pages (works today)',
        text: 'Each job page has Google\'s "JobPosting" data. Google finds it by itself in a few days. The list of pages is in our sitemap (link below). Submit the sitemap once in Google Search Console.',
      },
      {
        id: 'indexing', state: 'built', title: 'Tell Google at once (Indexing API)',
        text: 'With a Google Cloud service account added as Owner of the site in Search Console, TeamLink tells Google when a job is added or removed. 200 notices a day by default. Free.',
      },
    ],
    steps: [
      'Open Google Search Console (search.google.com/search-console) and add your website (the address people use for the career pages). Verify it.',
      'Submit the sitemap link shown below.',
      'Optional, faster: in Google Cloud make a project, turn on "Web Search Indexing API", make a service account, download its JSON key, and add the service account\'s email as Owner of the site in Search Console.',
      'Open Configure on this card, paste the whole JSON key and the site address exactly as in Search Console, and press Save.',
      'Press "Check connection". Then Save & Post a job: the row shows "waiting for Google" until Google shows it.',
    ],
    fields: [
      { label: 'Service account private key (JSON)', where: 'The key file you download from Google Cloud. Paste all of it.' },
      { label: 'Search Console property URL', where: 'Exactly as written in Search Console, e.g. https://www.tmlink.in/' },
    ],
    leadTime: 'A few days for Google to show a job. Setting up the service account: about an hour.',
    cost: 'Free.',
    applicants: 'People apply on our career page. Source = Google Jobs.',
    notPossible: ['Google shows jobs only from a page that really lets people apply. Jobs that are closed must be removed; TeamLink does that when a job closes.'],
    docs: [
      { label: 'Google: JobPosting data', url: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting' },
      { label: 'Google: Indexing API', url: 'https://developers.google.com/search/apis/indexing-api/v3/quickstart' },
    ],
    ask: { who: 'Whoever owns your website domain', what: 'Verify the site in Google Search Console.' },
  },
};

module.exports = { CONNECT, CHECKED };

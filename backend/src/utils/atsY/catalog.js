// ---------------------------------------------------------------------------
// ATS WAVE 2 (builder Y): the outside accounts this builder's connectors read, as cards on Administration > Integrations
// (utils/adminCatalog.js appends them; secrets are stored encrypted by utils/integrationStore.js and never sent to the browser).
// Every one needs an account only the founder can open; until it is filled the feature says so and nothing is called.
// ---------------------------------------------------------------------------
const FOUNDIT_FIELDS = [['Recruiter account email', ''], ['API key', 'from foundit (partner account)'], ['Secret key', 'if foundit gives one'],
  ['Job endpoint URL', 'given by foundit at onboarding (https://…)']];

const CATALOG = [
  { id: 'ats-meeting-bot', name: 'AI interview notetaker (meeting bot)', group: 'AI', glyph: '\u{1F4DD}',
    desc: 'A notetaker bot joins a Google Meet / Zoom / Teams interview from its link, records it and gives back the transcript; TeamLink then writes the notes and maps them to the scorecard questions. Works with a Recall.ai style meeting-bot API: open an account with the provider, copy the API key and the regional API address. Off until an Admin switches "AI notetaker" on (AI governance > Sourcing & AI connectors).',
    fields: [['Provider name', 'e.g. Recall.ai'], ['API base URL', 'https://us-east-1.recall.ai'], ['API key', ''], ['Bot name', 'TeamLink Notetaker']],
    hints: ['Provider name', 'API base URL', 'Bot name'] },
  { id: 'naukri-resdex', name: 'Naukri Resdex (CV database search)', group: 'Job Boards', glyph: '\u{1F4C2}',
    desc: 'Search Naukri\'s CV database (Resdex) from Candidates > Hiring tools > Outside search, and bring a profile in with its CV (no duplicates; every download is logged). Naukri publishes no Resdex API: ask your Naukri account manager for Resdex API / partner access on your Resdex plan; they give the API address, key and secret.',
    fields: [['API base URL', 'given by Naukri at onboarding (https://…)'], ['API key', ''], ['Secret key', ''], ['Recruiter account email', ''], ['Daily download limit', '50']],
    hints: ['API base URL', 'Daily download limit'] },
  { id: 'foundit', name: 'foundit (formerly Monster India)', group: 'Job Boards', glyph: '\u{1F4E1}',
    desc: 'Post requirements to foundit (formerly Monster India) from the requirement\'s Job boards card, edit them and take them down. foundit has no public API: ask your foundit employer account manager for an ATS / job-posting API account; they give the API key and the job endpoint. Applications come back through the foundit webhook / pull on Job Portal > Board applications.',
    fields: FOUNDIT_FIELDS },
  { id: 'linkedin-rsc', name: 'LinkedIn Recruiter System Connect (RSC) / Apply Connect', group: 'Job Boards', glyph: '\u{1F91D}',
    desc: 'Recruiter System Connect shows TeamLink\'s candidates, applications and steps inside LinkedIn Recruiter, and Apply Connect sends LinkedIn "Easy Apply" applications straight into the job. Only LinkedIn-approved ATS partners get it: apply through LinkedIn Talent Solutions; LinkedIn then gives the app Client ID / secret and the integration context. Applications arrive on the LinkedIn board webhook (Job Portal > Board applications).',
    fields: [['Client ID', ''], ['Client secret', ''], ['API base URL', 'https://api.linkedin.com'], ['Login address (LinkedIn)', 'https://www.linkedin.com/oauth/v2/accessToken'],
      ['ATS integration context (URN)', 'urn:li:atsIntegrationContext:…'], ['Company page id', '']],
    hints: ['API base URL', 'Login address (LinkedIn)', 'ATS integration context (URN)'] },
  { id: 'people-data', name: 'People & company data provider', group: 'AI', glyph: '\u{1F465}',
    desc: 'A licensed people-data API (for example a profile / contact data provider) for three things: search outside profiles (sourcing), find a verified work e-mail and phone for a profile (contact finding) and fill gaps in a profile (enrichment), and find new client companies for prospecting. TeamLink always looks in its own data first. Off until an Admin switches "Outside look-ups" on. Every look-up is logged.',
    fields: [['Provider name', ''], ['API base URL', 'https://…'], ['API key', ''], ['Monthly lookup limit', '500']],
    hints: ['API base URL', 'Monthly lookup limit'] },
];

module.exports = { CATALOG, FOUNDIT_FIELDS };

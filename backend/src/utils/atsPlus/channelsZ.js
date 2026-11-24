// ---------------------------------------------------------------------------
// ATS WAVE 2 Z (2026-11-25) - the Administration > Integrations cards the ATS reads its outside keys from. utils/integrationStore.js
// keeps every secret encrypted and never sends one back; utils/adminCatalog.js adds these cards to its catalogue. Pure data.
//
//   ats-workspace    Google Workspace / Microsoft 365 app (OAuth client) for the ATS: each interviewer connects their own calendar,
//                    booked interviews go into it (07.01), busy times come back, and client contacts can be read in (14.05)
//   ats-bgv          the background-verification vendor (14.09 / IN-15): SpringVerify, AuthBridge, IDfy, OnGrid ...
//   ats-assessment   the skills / coding test vendor (14.10): HackerEarth, Mercer Mettl, iMocha, HackerRank ...
// ---------------------------------------------------------------------------
const VENDOR_HELP = 'TeamLink sends the order to <API base URL>/orders (JSON with the candidate, the checks and a callback address), signs it with the API key, and takes the result when the vendor calls the callback (checked with the webhook secret) or when TeamLink asks <API base URL>/orders/<id>.';
const CHANNELS = [
  { id: 'ats-workspace', name: 'Google Workspace / Microsoft 365 (ATS)', group: 'Scheduling', glyph: '\u{1F4C6}',
    desc: 'ATS: each interviewer connects their own Google or Outlook calendar (Interview Calendar > Calendar), booked interviews are put in it and moved / taken out with the booking, their busy times are used when times are suggested, and client contacts can be read from their Google / Outlook contacts. Google Cloud Console: OAuth client (Web), Calendar API + People API on. Microsoft Entra: app registration with Calendars.ReadWrite, Contacts.Read, User.Read, offline_access. Add the redirect addresses shown in ATS settings > Integrations > Google / Microsoft 365.',
    fields: [['Google client ID', '....apps.googleusercontent.com'], ['Google client secret', ''], ['Microsoft app (client) ID', 'Application (client) ID'], ['Microsoft client secret', ''], ['Microsoft tenant ID (common = any)', 'common']],
    hints: ['Google client ID', 'Microsoft app (client) ID', 'Microsoft tenant ID (common = any)'] },
  { id: 'ats-bgv', name: 'Background verification vendor (ATS)', group: 'Hiring checks', glyph: '\u{1F50E}',
    desc: `ATS: order background checks (education, employment, address, criminal, identity) from Joining > Onboarding; the status comes back on the candidate. Needs an account with a BGV vendor (SpringVerify, AuthBridge, IDfy, OnGrid ...). ${VENDOR_HELP}`,
    fields: [['Vendor (SpringVerify / AuthBridge / IDfy / OnGrid / Other)', 'SpringVerify'], ['API base URL', 'https://api.vendor.example/v1'], ['API key', ''], ['Webhook secret (checks the vendor result calls)', ''], ['Checks to order (comma list)', 'education,employment,address,criminal,identity']],
    hints: ['Vendor (SpringVerify / AuthBridge / IDfy / OnGrid / Other)', 'API base URL', 'Checks to order (comma list)'] },
  { id: 'ats-assessment', name: 'Assessment vendor (ATS)', group: 'Hiring checks', glyph: '\u{1F9EA}',
    desc: `ATS: send a coding or skills test to a candidate and get the score back on the record. Needs an account with a test vendor (HackerEarth, Mercer Mettl, iMocha, HackerRank ...). ${VENDOR_HELP}`,
    fields: [['Vendor (HackerEarth / Mercer Mettl / iMocha / HackerRank / Other)', 'HackerEarth'], ['API base URL', 'https://api.vendor.example/v1'], ['API key', ''], ['Webhook secret (checks the vendor result calls)', ''], ['Default test ID', '']],
    hints: ['Vendor (HackerEarth / Mercer Mettl / iMocha / HackerRank / Other)', 'API base URL', 'Default test ID'] },
];
const GROUPS = ['Hiring checks'];
module.exports = { CHANNELS, LIVE: CHANNELS.map((c) => c.id), GROUPS };

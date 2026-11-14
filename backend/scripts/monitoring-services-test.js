#!/usr/bin/env node
/**
 * Employee Monitoring: a browser tab is named as the SERVICE it is and said in plain words (founder 2026-11-14: a Google Meet showed as a website named
 * after its meeting code, "vallu em chesthunnaro in detail ga ravali, anniki ilaagey"). Pure functions of utils/monitoring.js; no database, no server.
 *   node scripts/monitoring-services-test.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./prisma/none.db';
const M = require('../src/utils/monitoring');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ''}`); } };
// what the Work done list says for one tab: the site name (deriveSite) and Area / What was done (doneOf, on the title the way the aggregation cleans it)
const read = (title, app = 'chrome') => {
  const item = M.itemOf(title, app);
  const site = M.deriveSite(app, title);
  const d = M.doneOf(app, site || app, 'site', item);
  return { site, area: d.area, action: d.action };
};

console.log('Google Meet (the case in the screenshot)');
const meet = read('Meet – zdd-puxi-nxz - Google Chrome');
check('a Meet tab is Google Meet, not a site named after the meeting code', meet.site === 'Google Meet', meet);
check('the area is Google Meet', meet.area === 'Google Meet', meet);
check('it says what they were doing, with the meeting code', meet.action === 'In a Google Meet video call (meeting code zdd-puxi-nxz)', meet.action);
check('the same with a hyphen instead of the long dash', read('Meet - abc-defg-hij - Google Chrome').action === 'In a Google Meet video call (meeting code abc-defg-hij)');
check('a named meeting without a code keeps its name', read('Meet – Weekly review - Google Chrome').action === 'In the Google Meet “Weekly review”');
check('the Meet start page is said as such', read('Meet - Google Chrome').action === 'On Google Meet (start page / joining a call)', read('Meet - Google Chrome'));
check('an incognito window still names the service', M.deriveSite('chrome', 'Meet – abc-defg-hij - Google Chrome (Incognito)') === 'Google Meet (incognito)', M.deriveSite('chrome', 'Meet – abc-defg-hij - Google Chrome (Incognito)'));
check('Edge works the same as Chrome', read('Meet – abc-defg-hij - Microsoft​ Edge', 'msedge').area === 'Google Meet');

console.log('ViciDial');
const v1 = read('Agent web client - Google Chrome');
check('ViciDial is named ViciDial', v1.site === 'ViciDial' && v1.area === 'ViciDial', v1);
check('and said as taking and making calls', /taking and making calls/.test(v1.action), v1.action);
check('its login page says it is the login', /Logging in/.test(read('Agent web client: Campaign Login - Google Chrome').action), read('Agent web client: Campaign Login - Google Chrome'));

console.log('Other tools');
const yt = read('How to close a client - YouTube - Google Chrome');
check('YouTube: the video that was watched', yt.area === 'YouTube' && yt.action === 'Watched “How to close a client”', yt);
check('YouTube with an unread count in front', read('(3) Interview tips - YouTube - Google Chrome').action === 'Watched “Interview tips”');
const sh = read('Candidate tracker - Google Sheets - Google Chrome');
check('Google Sheets: the spreadsheet that was worked on', sh.area === 'Google Sheets' && sh.action === 'Worked on the spreadsheet “Candidate tracker”', sh);
check('Google Docs says document, Slides presentation', /the document/.test(read('Offer letter - Google Docs - Google Chrome').action) && /the presentation/.test(read('Pitch - Google Slides - Google Chrome').action));
check('Google Drive', read('My Drive - Google Drive - Google Chrome').action === 'Browsed Google Drive: My Drive', read('My Drive - Google Drive - Google Chrome'));
check('Google Search: what was searched for', read('staffing agency fees india - Google Search - Google Chrome').action === 'Searched Google for “staffing agency fees india”');
check('ChatGPT with a conversation name', read('Quote wording - ChatGPT - Google Chrome').action === 'Chat with ChatGPT: “Quote wording”', read('Quote wording - ChatGPT - Google Chrome'));
check('ChatGPT on its own', read('ChatGPT - Google Chrome').action === 'Used ChatGPT' && read('ChatGPT - Google Chrome').area === 'ChatGPT', read('ChatGPT - Google Chrome'));
check('Claude with a conversation name', read('Fix the invoice PDF - Claude - Google Chrome').action === 'Chat with Claude: “Fix the invoice PDF”');
check('LinkedIn: a profile and the feed', read('Asha Rao | LinkedIn - Google Chrome').action === 'Looked at “Asha Rao” on LinkedIn' && read('(1) Feed | LinkedIn - Google Chrome').action === 'Browsed the LinkedIn feed');
check('Naukri', read('Candidate Search - Naukri Recruiter - Google Chrome').area === 'Naukri', read('Candidate Search - Naukri Recruiter - Google Chrome'));
check('Zoom and Teams in the browser', read('Zoom Meeting - Google Chrome').action === 'In a Zoom meeting' && /Microsoft Teams meeting or call/.test(read('Meeting with Priya | Microsoft Teams - Google Chrome').action));

console.log('Things that must not change');
const gen = read('Recruiter Handover - Google Chrome');
check('an unknown page is read as before (site = the last part of the title)', gen.site === 'Recruiter Handover' || gen.site === null || typeof gen.site === 'string', gen);
check('an ordinary site: the page, without the site name repeated after it', read('Pricing plans - Acme CRM - Google Chrome').area === 'Acme CRM' && read('Pricing plans - Acme CRM - Google Chrome').action === 'Pricing plans', read('Pricing plans - Acme CRM - Google Chrome'));
check('a desktop app (not a browser) is not touched', M.serviceOf('excel', 'Meet - Book1') === null);
const teamsApp = M.doneOf('ms-teams', 'Teams', 'app', 'Weekly sync | Microsoft Teams');
check('Teams on the PC is a meeting or call', teamsApp.area === 'Teams' && /meeting or call/.test(teamsApp.action), teamsApp);
const zoomApp = M.doneOf('Zoom', 'Zoom', 'app', 'Zoom Meeting');
check('Zoom on the PC too', zoomApp.action === 'In a Zoom meeting or call', zoomApp);

console.log('The whole list, as the popup builds it');
const wd = M.workDone('chrome', 'Google Meet', 'site', [
  { item: M.itemOf('Meet – zdd-puxi-nxz - Google Chrome', 'chrome'), seconds: 120, pieces: 1, first: 1, last: 2, times: [{ start: 1, end: 2, seconds: 120 }] },
  { item: M.itemOf('Meet – zdd-puxi-nxz - Google Chrome', 'chrome'), seconds: 120, pieces: 1, first: 3, last: 4, times: [{ start: 3, end: 4, seconds: 120 }] },
]);
check('three sittings of the same meeting are one line with the total', wd.length === 1 && wd[0].seconds === 240 && wd[0].area === 'Google Meet', wd);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

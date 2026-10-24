// Pure logic test (no browser, no server): the Omni-Channel sidebar tree (the Green Start prototype's sidebar) per role, the old-address redirects and page resolution.
//   node frontend/scripts/omni-sidebar-test.mjs
import { PAGES, GROUPS, sidebarItems, openPages, omniChildren, pageOfPath, legacyPage, resolvePage, pagePath } from '../src/components/omni/omniPages.js';

let fail = 0;
const check = (name, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(d)}`}`); if (!ok) fail += 1; };
const ALL = Object.keys(PAGES);
const admin = { level: 'admin', pages: ALL };
const recruiter = { level: 'recruiter', pages: ['overview', 'inbox', 'campaigns', 'analytics', 'templates', 'studio', 'crm', 'customers', 'segments', 'forms', 'automation', 'botbuilder', 'botdata', 'billing'] };
const finance = { level: 'finance', pages: ['billing'] };
const none = { level: 'none', pages: [] };

// the tree is the prototype's: names and order
const labels = (acc) => sidebarItems(acc).flatMap((i) => (i.children ? [i.label, ...i.children.map((c) => `  ${c.label}`)] : [i.label]));
const want = ['Dashboard', 'Facebook Catalogs', 'Shopify', 'Channels', '  WhatsApp', '  Facebook', '  Instagram', 'Campaign center', '  Communication', '  Campaigns', '  Social Media', '  Analytics', '  Manage Templates', '  Content Studio', 'CRM', '  CRM Fields', '  All Customers', '  Segments', '  WhatsApp Bot Data', '  Web Forms', 'Ads & Campaigns', '  Ads Manager', '  Google Campaigns', '  Google Ads', '  Google Analytics', 'Automation', '  Automations', '  Bot Builder', 'Administration', '  Team & Roles', '  Billing', '  Super Admin', 'Settings'];
check('Admin: the prototype sidebar, same names, same order', labels(admin).join('|') === want.join('|'), labels(admin));
check('27 pages in the registry, every page is in exactly one group', ALL.length === 27 && GROUPS.flatMap((g) => g.pages).sort().join() === [...ALL].sort().join());
check('Every page has a label, an icon and its own address', ALL.every((p) => PAGES[p].label && PAGES[p].icon && pagePath(p) === `/omni-channel/${p}`));
check('Recruiter: no Super Admin, no Settings, no external shells', !openPages(recruiter).some((p) => ['superadmin', 'settings', 'shopify', 'fbchannel', 'adsmanager'].includes(p)));
check('Finance: Billing only (Administration > Billing)', openPages(finance).join() === 'billing' && labels(finance).join('|') === 'Administration|  Billing', labels(finance));
check('No access (or no answer yet): no Omni-Channel group at all', omniChildren(none).length === 0 && omniChildren(null).length === 0 && omniChildren(undefined).length === 0);
const bd = sidebarItems(admin, { inboxUnread: 7, approvals: 2 });
const inbox = bd.find((i) => i.label === 'Channels').children.find((c) => c.label === 'WhatsApp');
const camp = bd.find((i) => i.label === 'Campaign center').children.find((c) => c.label === 'Campaigns');
check('The WhatsApp child carries the unread number, Campaigns the approvals number', inbox.badge === 7 && camp.badge === 2 && !('badge' in bd[0]));
check('Nobody sees the word Draft in a sidebar label', !/draft/i.test(JSON.stringify(labels(admin))));
check('The highlight follows the URL', pageOfPath('/omni-channel/campaigns') === 'campaigns' && pageOfPath('/omni-channel/campaigns/x') === 'campaigns' && pageOfPath('/omni') === null && pageOfPath('/ats') === null && pageOfPath('/omni-channel/nothing') === null);

// old five-hub addresses and the old ?mode=&tab= links keep working
const L = (seg, q) => legacyPage(seg, q);
check('A new address is left alone', L('customers', '') === null && L('analytics', '?tab=reports') === null);
check('Old hub names go to their new page', L('dashboard', '').page === 'overview' && L('communication', '').page === 'inbox' && L('insights', '').page === 'analytics' && L('configuration', '').page === 'settings');
check('Old Communication tabs: sms / email / calls -> the Communication page', L('communication', '?tab=sms').page === 'console' && L('communication', '?tab=email').page === 'console' && L('communication', '?tab=calls').page === 'console');
check('Old Campaigns tabs: contacts -> All Customers, audiences -> Segments, templates -> Manage Templates, automations -> Automations', L('campaigns', '?tab=contacts').page === 'customers' && L('campaigns', '?tab=audiences').page === 'segments' && L('campaigns', '?tab=templates').page === 'templates' && L('campaigns', '?tab=automations').page === 'automation');
check('Old Campaigns > Campaigns / Promotions stay on Campaigns', L('campaigns', '?tab=campaigns') === null && L('campaigns', '?tab=promotions') === null);
check('Old Insights tabs: credits -> Billing, performance / roi / reports -> Analytics', L('insights', '?tab=credits').page === 'billing' && L('insights', '?tab=performance').page === 'analytics' && L('insights', '?tab=roi').page === 'analytics');
check('Old Configuration tabs: meta / channels / settings -> Settings, permissions -> Team & Roles', L('configuration', '?tab=meta').page === 'settings' && L('configuration', '?tab=permissions').page === 'team');
check('Very old /omni?mode=..&tab=.. links', L(undefined, '?mode=promo&tab=contacts').page === 'customers' && L(undefined, '?mode=internal&tab=people').page === 'customers' && L(undefined, '?mode=settings&tab=roles').page === 'team' && L(undefined, '?mode=settings&tab=credits').page === 'billing' && L(undefined, '').page === 'overview');
check('A page a login may not open falls back to one it may (Finance asked for Settings -> Billing, Recruiter -> Dashboard)', resolvePage(finance, 'settings') === 'billing' && resolvePage(recruiter, 'superadmin') === 'overview' && resolvePage(admin, 'settings') === 'settings' && resolvePage(none, 'overview') === null);
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);

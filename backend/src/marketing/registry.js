// ---------------------------------------------------------------------------
// AI MARKETING: THE MODULE REGISTRY (Omni-Channel > AI Marketing).
// Founder, 2026-11-11: build SIX modules now (of the 30 in the AI Marketing OS list); the other 24 stay on the menu for later.
// Each module is one manifest here + its own file(s) under backend/src/marketing/ + its own screen(s) in frontend omni/marketing/.
// To add a module later (Social Media, SEO, AI Images ...): add a manifest below (or call register() from the module's own file), add its screens to
// omniPages.js + pageComponents.js, add its route file to routes/omniGsMarketing.js. Nothing else has to change: the AI layer (ai.js), the approval
// rules (content.js), the usage log, the audit prefix and the role rules are shared.
// status: 'live' = works now · 'planned' = on the plan, not built yet (the screens say so; nothing is faked).
// ---------------------------------------------------------------------------
const MODULES = [
  { id: 'content', no: 1, label: 'AI Content', phase: 1, status: 'live', page: 'mkcontent', blurb: 'Write WhatsApp, SMS, email, RCS and social messages with AI in your brand voice. Nothing is used until a person approves it.' },
  // 2026-11-14: live (marketing/emailmk.js). Clicks are counted; opens are NOT (plain-text emails carry no tracking picture), and the page says so.
  { id: 'email', no: 2, label: 'Email Marketing', phase: 2, status: 'live', page: 'mkemail', blurb: 'The AI writes subject lines and the email for one open job; an A/B subject test sends A to half and B to half and reports the clicks; approval before the campaign goes out. Nothing is sent from here: you press Send in Campaigns.' },
  // 2026-11-14: WhatsApp and SMS are live (marketing/messaging.js): the AI writes the words of a job campaign, a person picks them, they become draft templates and a campaign that is NEVER sent from here.
  // RCS is not part of it yet: RCS sends from Administration > Integrations > RCS and is not in the Omni campaign sender.
  { id: 'messaging', no: 3, label: 'WhatsApp & SMS campaigns', phase: 2, status: 'live', page: 'mkcampaigns', blurb: 'The AI writes the WhatsApp and SMS words for one open job in your brand voice; you pick and edit them, make the templates (Meta / DLT approval) and save the campaign. Nothing is sent from here: you press Send in Campaigns. RCS comes later.' },
  { id: 'leads', no: 4, label: 'Lead Generation to CRM', phase: 3, status: 'planned', page: null, blurb: 'Score form, website and ad leads hot / warm / cold, give each an owner, send the first reply.' },
  { id: 'workflow', no: 5, label: 'Workflow Automation', phase: 4, status: 'planned', page: null, blurb: 'If / then branching and event triggers for marketing-to-sales journeys, with an AI-writes-person-approves step.' },
  // 2026-11-14: live. Numbers for words, pictures, videos, the calendar, client approvals and AI use (marketing/reports.js); linking to joinings comes later
  { id: 'reports', no: 6, label: 'Analytics & Reporting', phase: 1, status: 'live', page: 'mkreports', blurb: 'Plain numbers for any date range: content, pictures, videos, calendar posts, client approvals and AI use, per person, with a CSV download.' },
  // 2026-11-13 (founder's list item 6): what goes out on which day, with "Plan a week with AI"; posted by hand until the social apps are approved
  { id: 'calendar', no: 7, label: 'Content Calendar', phase: 1, status: 'live', page: 'mkcalendar', blurb: 'Plan Facebook, Instagram, LinkedIn, X, WhatsApp and email posts on a calendar. The AI suggests a week of ideas; you post and mark them done.' },
  // 2026-11-13 (founder's list item 3): Google Gemini pictures in the brand colours, with the logo; approved before use (marketing/images.js)
  { id: 'images', no: 8, label: 'AI Images', phase: 1, status: 'live', page: 'mkimages', blurb: 'Make marketing pictures with AI (free with Cloudflare, or Google Gemini) in your brand colours, with your logo. Approved pictures get a link for posts and the Content Calendar.' },
  // 2026-11-13 (founder's list item 4): a slideshow video made in the browser from approved pictures, with the brand intro and outro (free)
  { id: 'videos', no: 9, label: 'AI Video', phase: 1, status: 'live', page: 'mkvideos', blurb: 'Turn approved pictures into a short MP4 video with your logo, colours, captions and a call to action. Square, Instagram, Reel and banner sizes; approved like pictures.' },
  // 2026-11-14: the agency workflow: a client asks, the team accepts and works, shows options, the client picks one, it is posted (marketing/projects.js)
  { id: 'projects', no: 10, label: 'Client Projects', phase: 1, status: 'live', page: 'mkprojects', blurb: 'A client asks for a creative (a festive video with their logo). Accept it, make options with AI, show them on a private link, the client picks one and adds suggestions, then post it.' },
];
// the other names of the AI Marketing OS list: the menu to pick from later (nothing here is built)
const LATER = ['Social Media Marketing', 'AI Audio', 'SEO', 'GEO', 'AEO', 'LLMO', 'Competitor Intelligence', 'Paid Advertising', 'Website Optimization', 'CRM (marketing view)', 'Sales Automation (marketing view)', 'Influencer', 'Affiliate', 'Reputation Management', 'Local Marketing', 'E-commerce', 'Customer Engagement', 'Trend Intelligence', 'Brand Management (full brand kit)', 'Marketing Administration (billing, plans)', 'Email deliverability tools', 'Website landing pages'];

function register(manifest) {
  if (!manifest || !manifest.id || MODULES.some((m) => m.id === manifest.id)) return false;
  MODULES.push({ status: 'planned', phase: 99, no: MODULES.length + 1, page: null, blurb: '', ...manifest });
  return true;
}
const ids = () => MODULES.map((m) => m.id);
module.exports = { MODULES, LATER, register, ids };

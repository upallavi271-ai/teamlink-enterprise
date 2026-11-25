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
  // 2026-11-16: the founder removed screens nobody used: AI Content, Email marketing, Campaign messages (WhatsApp & SMS) and Workflow automation. Their server code (marketing/content.js, emailmk.js,
  // messaging.js, journeys.js) is still in the project, unchanged (Approvals, the Calendar and Reports still read content.js). Lead generation stays as a SUB-TAB of Client projects (frontend omniPages.js MK_SUBTABS).
  // 2026-11-14: live (marketing/leadgen.js). Scores and owners are built here; the first reply is the CRM's own Autopilot (crm/autopilot.js), shown on the page.
  { id: 'leads', no: 4, label: 'Lead Generation to CRM', phase: 3, status: 'live', page: 'mkleads', blurb: 'Every new website, ad-file or hand-entered lead is scored Hot / Warm / Cold with the reasons, given an owner in turn, and the owner is told. The first reply is the CRM Autopilot, shown per lead.' },
  // 2026-11-14: live. Numbers for words, pictures, videos, the calendar, client approvals and AI use (marketing/reports.js); linking to joinings comes later
  { id: 'reports', no: 6, label: 'Analytics & Reporting', phase: 1, status: 'live', page: 'mkreports', blurb: 'Plain numbers for any date range: content, pictures, videos, client approvals and AI use, per person, with a CSV download.' },
  // 2026-11-16: the founder removed the Content Calendar tab ("not necessary now"). Its server code (marketing/calendar.js, its routes and table) stays, unchanged and unused; its reminder sweep is no longer started (index.js).
  // 2026-11-13 (founder's list item 3): Google Gemini pictures in the brand colours, with the logo; approved before use (marketing/images.js)
  { id: 'images', no: 8, label: 'AI Images', phase: 1, status: 'live', page: 'mkimages', blurb: 'Make marketing pictures with AI (free with Cloudflare, or Google Gemini) in your brand colours, with your logo. Approved pictures get a link for posts.' },
  // 2026-11-13 (founder's list item 4): a slideshow video made in the browser from approved pictures, with the brand intro and outro (free)
  { id: 'videos', no: 9, label: 'AI Video', phase: 1, status: 'live', page: 'mkvideos', blurb: 'Turn approved pictures into a short MP4 video with your logo, colours, captions and a call to action. Square, Instagram, Reel and banner sizes; approved like pictures.' },
  // 2026-11-14: the agency workflow: a client asks, the team accepts and works, shows options, the client picks one, it is posted (marketing/projects.js)
  { id: 'projects', no: 10, label: 'Client Projects', phase: 1, status: 'live', page: 'mkprojects', blurb: 'A client asks for a creative (a festive video with their logo). Accept it, make options with AI, show them on a private link, the client picks one and adds suggestions, then post it.' },
  // 2026-11-25: the AI Agent: a goal becomes a plan, a preview and, after ONE approval, real steps that call the modules above (marketing/agent.js). It duplicates nothing.
  { id: 'agent', no: 11, label: 'AI Agent', phase: 1, status: 'live', page: 'mkagent', blurb: 'Type a goal ("Promote my business for seven days"). The agent asks for what is missing, saves the business facts once, makes a day-by-day plan, shows a preview, and after your approval runs the steps in AI Content, AI Images, Approvals and SEO. Nothing is posted or sent by itself.' },
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

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
  { id: 'email', no: 2, label: 'Email Marketing', phase: 2, status: 'planned', page: null, blurb: 'AI subject lines, A/B subject test, open and click report, approval before a mass email.' },
  { id: 'messaging', no: 3, label: 'WhatsApp, SMS & RCS campaigns', phase: 2, status: 'planned', page: null, blurb: 'AI-written campaign messages with approval, and RCS added to the Omni campaign sender.' },
  { id: 'leads', no: 4, label: 'Lead Generation to CRM', phase: 3, status: 'planned', page: null, blurb: 'Score form, website and ad leads hot / warm / cold, give each an owner, send the first reply.' },
  { id: 'workflow', no: 5, label: 'Workflow Automation', phase: 4, status: 'planned', page: null, blurb: 'If / then branching and event triggers for marketing-to-sales journeys, with an AI-writes-person-approves step.' },
  { id: 'reports', no: 6, label: 'Analytics & Reporting', phase: 5, status: 'planned', page: null, blurb: 'One report from content made to joinings, per module, with AI usage and CSV download.' },
  // 2026-11-13 (founder's list item 6): what goes out on which day, with "Plan a week with AI"; posted by hand until the social apps are approved
  { id: 'calendar', no: 7, label: 'Content Calendar', phase: 1, status: 'live', page: 'mkcalendar', blurb: 'Plan Facebook, Instagram, LinkedIn, X, WhatsApp and email posts on a calendar. The AI suggests a week of ideas; you post and mark them done.' },
  // 2026-11-13 (founder's list item 3): Google Gemini pictures in the brand colours, with the logo; approved before use (marketing/images.js)
  { id: 'images', no: 8, label: 'AI Images', phase: 1, status: 'live', page: 'mkimages', blurb: 'Make marketing pictures with Google Gemini in your brand colours, with your logo. Approved pictures get a link for posts and the Content Calendar.' },
];
// the other names of the AI Marketing OS list: the menu to pick from later (nothing here is built)
const LATER = ['Social Media Marketing', 'AI Videos', 'AI Audio', 'SEO', 'GEO', 'AEO', 'LLMO', 'Competitor Intelligence', 'Paid Advertising', 'Website Optimization', 'CRM (marketing view)', 'Sales Automation (marketing view)', 'Influencer', 'Affiliate', 'Reputation Management', 'Local Marketing', 'E-commerce', 'Customer Engagement', 'Trend Intelligence', 'Brand Management (full brand kit)', 'Marketing Administration (billing, plans)', 'Email deliverability tools', 'Website landing pages'];

function register(manifest) {
  if (!manifest || !manifest.id || MODULES.some((m) => m.id === manifest.id)) return false;
  MODULES.push({ status: 'planned', phase: 99, no: MODULES.length + 1, page: null, blurb: '', ...manifest });
  return true;
}
const ids = () => MODULES.map((m) => m.id);
module.exports = { MODULES, LATER, register, ids };

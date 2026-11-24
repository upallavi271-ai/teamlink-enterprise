// ---------------------------------------------------------------------------
// CRM WAVE C - the Administration > Integrations cards the CRM reads its outside keys from (utils/integrationStore.js keeps the secrets
// encrypted and never sends them back). utils/adminCatalog.js adds these to its catalogue. Pure data: nothing is required here.
// ---------------------------------------------------------------------------
const CHANNELS = [
  { id: 'crm-lead-ads', name: 'CRM lead ads (Meta: Facebook / Instagram)', group: 'Developer', glyph: '📣',
    desc: 'Leads from Facebook and Instagram lead-ad forms go straight into CRM > Leads. In Meta for Developers: your app > Webhooks > Page > leadgen, callback URL = https://<this site>/api/crm/capture/facebook and the Verify token below; give the app a Page access token with leads_retrieval. Then switch "Facebook / Instagram lead ads" on in CRM settings > Customise > Lead capture.',
    fields: [['Page access token', ''], ['App secret', ''], ['Verify token', 'any long random words you choose']],
    hints: ['Verify token'] },
  { id: 'crm-india-portals', name: 'CRM India portals (IndiaMART / TradeIndia)', group: 'Developer', glyph: '🇮🇳',
    desc: 'Buyer enquiries from IndiaMART (Lead Manager > CRM API key) and TradeIndia (My inquiries API: user ID, profile ID and key) are read every few minutes into CRM > Leads once switched on in CRM settings > Customise > Lead capture. JustDial pushes to the address shown there.',
    fields: [['IndiaMART CRM key', ''], ['TradeIndia user ID', ''], ['TradeIndia profile ID', ''], ['TradeIndia key', '']],
    hints: [] },
  { id: 'crm-enrichment', name: 'CRM company data (enrichment)', group: 'Developer', glyph: '🔎',
    desc: 'An outside company-data service for "Fill from the web" on a CRM account (company size, industry, LinkedIn page). Give its lookup address with {domain} where the company\'s web domain goes, the header its key travels in, and the key. Without it, "Fill from the web" still reads the company\'s own website and its GSTIN.',
    fields: [['Lookup URL (use {domain})', 'https://api.provider.example/v1/companies?domain={domain}'], ['Key header name', 'X-API-Key'], ['API key', '']],
    hints: ['Lookup URL (use {domain})', 'Key header name'] },
  { id: 'crm-dnd', name: 'CRM DND check (TRAI NCPR)', group: 'Developer', glyph: '🚫',
    desc: 'A Do-Not-Disturb lookup from your telephony / SMS provider, so a CRM call to a DND number is stopped. Give the check address with {number} (91XXXXXXXXXX) and the key. Without it the CRM uses the DND list you upload (CRM settings > Customise > Data & privacy).',
    fields: [['Check URL (use {number})', 'https://api.provider.example/dnd/{number}'], ['Key header name', 'Authorization'], ['API key', '']],
    hints: ['Check URL (use {number})', 'Key header name'] },
];
module.exports = { CHANNELS, LIVE: CHANNELS.map((c) => c.id) };

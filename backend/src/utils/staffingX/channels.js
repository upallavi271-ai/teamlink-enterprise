// ---------------------------------------------------------------------------
// The Administration > Integrations cards of contract staffing (utils/staffingX/*). utils/adminCatalog.js adds them to its
// catalogue; utils/integrationStore.js keeps the secrets encrypted and never sends them back. Pure data.
// ---------------------------------------------------------------------------
const CHANNELS = [
  { id: 'vms', name: 'VMS (SAP Fieldglass / Beeline / Workday VNDLY)', group: 'Job Boards', glyph: '\u{1F3ED}',
    desc: 'Contract jobs from a client\'s Vendor Management System come into ATS > Clients & Requirements > Contract staff > VMS, and the candidates you send go back to it with their status. Ask the client (or the VMS) for a supplier API account: the base URL, the client ID and secret (Beeline, Fieldglass) or the API token (VNDLY, other), and your supplier ID. The paths of your tenant are in its onboarding pack; leave the three path boxes empty to use the usual ones.',
    fields: [['VMS system (beeline, fieldglass, vndly or generic)', 'one of: beeline, fieldglass, vndly, generic'], ['API base URL', 'https://api.your-vms.example.com'], ['Client ID', ''], ['Client secret', ''],
      ['API key / token', 'the API token (VNDLY / other) or the application key (Fieldglass)'], ['Supplier ID', ''], ['Jobs path (optional)', ''], ['Submit path (optional)', ''], ['Status path (optional)', '']],
    hints: ['API base URL', 'API key / token', 'Jobs path (optional)', 'Submit path (optional)', 'Status path (optional)'] },
  { id: 'accounting-push', name: 'Accounting push (contract billing)', group: 'Finance', glyph: '\u{1F4E4}',
    desc: 'Sends each contract-staffing billing batch (Contract staff > Billing) to your accounting software. EITHER an address (Zapier / n8n / Zoho Flow / your own system): each POST is signed, X-TeamLink-Signature = sha256 HMAC of the body with the signing secret, in the TeamLink, Zoho Books or Xero invoice shape. OR the Zoho Books keys (api-console.zoho.in > Self client > scope ZohoBooks.invoices.CREATE,ZohoBooks.contacts.ALL > refresh token): a DRAFT invoice is made there. Nothing is written into TeamLink Accounts.',
    fields: [['Endpoint URL', 'https://hooks.zapier.com/hooks/catch/...'], ['Signing secret', ''], ['Payload (teamlink, zoho-books or xero)', 'empty = teamlink'],
      ['Zoho Books organization ID', ''], ['Zoho client ID', ''], ['Zoho client secret', ''], ['Zoho refresh token', ''], ['Zoho data centre (in, com, eu)', 'empty = in']],
    hints: ['Endpoint URL', 'Payload (teamlink, zoho-books or xero)', 'Zoho data centre (in, com, eu)'] },
];
module.exports = { CHANNELS, LIVE: CHANNELS.map((c) => c.id) };

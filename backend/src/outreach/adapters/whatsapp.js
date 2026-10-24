// WhatsApp campaign adapter (the Meta Cloud API / QR link / ... that Administration > Integrations chose, through utils/messaging.js).
// Test mode (the global flag, forced ON for a rehearsal campaign) never calls a provider. See text.js.
module.exports = require('./text')({ channel: 'whatsapp', label: 'WhatsApp', messagingName: 'WhatsApp', capKey: 'waDailyCap' });

// SMS campaign adapter (the gateway / Android phone that Administration > Integrations chose, through utils/messaging.js).
// Needs the DLT template id and the sender id of the template. Test mode never calls a provider. See text.js.
module.exports = require('./text')({ channel: 'sms', label: 'SMS', messagingName: 'SMS', capKey: 'smsDailyCap' });

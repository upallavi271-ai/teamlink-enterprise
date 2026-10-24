// CALL "adapter": calls are made by a PERSON. A call campaign makes one call task per person (OutreachMessage channel 'call', status 'queued' = "To call");
// the person rings and logs the result (campaigns.markCall). Nothing here can dial or send: the runner never claims a call row.
module.exports = {
  channel: 'call',
  label: 'Call',
  async status() { return { ready: true, live: true, testMode: false, reason: '' }; },
  async send() { return { status: 'refused', reason: 'manual' }; },
  parseWebhook() { return []; },
};

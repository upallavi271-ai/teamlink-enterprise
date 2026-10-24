// ---------------------------------------------------------------------------
// OMNI-CHANNEL CHANNEL CONNECTIONS + SYNC HEALTH (2026-10-17). Honest, read only, no secret ever leaves the server.
//   channels()  one row per channel: Email, WhatsApp, SMS (and Voice / RCS as "Planned"):
//                 state  connected   a provider is set up AND real sending is switched on          (messages really go out)
//                        test        a provider is set up but "Outreach sending" is off or Test mode is on (rehearsal only: nothing is sent)
//                        not_set_up  no provider is set up: `reason` is the plain sentence from the real configuration check
//                        planned     the channel is not built (RCS), nothing is faked
//                 inbound  can replies reach us? For WhatsApp: the webhook needs the App secret and a verify token, and Meta must have called us at least once
//                          (we say "nothing has arrived yet" instead of "working"). Email: the mailbox reader is set up or not.
//   syncHealth() failed and waiting provider events, replies waiting in Needs review, failed campaign messages, today's duplicates ignored, and the Retry
//                action. Everything is counted from the real tables.
// What an Admin must do to fix a "not set up" is in `fix` (words only; it never contains a key or a token).
// ---------------------------------------------------------------------------
const S = require('../store');
const Comm = require('../communication');
const Router = require('./replyRouter');
const Schema = require('./schema');
const A = require('../access');

async function channels(user) {
  const st = await S.settings();
  const rehearsal = Comm.isRehearsal(st);
  const messaging = require('../../utils/messaging'); // eslint-disable-line global-require
  const delivery = require('../../utils/messageDelivery'); // eslint-disable-line global-require
  let cs = null;
  try { cs = await messaging.channelStatus(); } catch { cs = null; }
  const rows = [];
  const state = (cfg) => (!cfg || !cfg.configured ? 'not_set_up' : (rehearsal ? 'test' : 'connected'));
  const words = {
    connected: 'Connected. Real messages are sent.',
    test: st.master ? 'Set up, but Test mode is on: messages are rehearsed and nothing is sent to anybody.' : 'Set up, but "Outreach sending" is switched off: nothing is sent to anybody.',
    not_set_up: 'Not set up.',
  };
  const isAdmin = A.isAdmin(user);
  // Email
  const e = cs && cs.Email;
  let mailbox = { configured: false };
  try { mailbox = await require('../../utils/imapInbox').status(); } catch { mailbox = { configured: false }; } // eslint-disable-line global-require
  rows.push({
    id: 'email', name: 'Email', state: state(e), words: words[state(e)], reason: e && e.configured ? '' : ((e && e.reason) || 'Email has not been set up.'), provider: e && e.configured ? 'set up' : '',
    inbound: { ready: !!mailbox.configured, words: mailbox.configured ? 'Replies are read from the shared mailbox.' : 'Replies cannot be read yet: the shared mailbox is not set up.', lastAt: null },
    fix: e && e.configured ? '' : 'An Admin sets up Email in Administration > Integrations > Email.',
  });
  // WhatsApp and SMS
  for (const [id, name, key] of [['whatsapp', 'WhatsApp', 'WhatsApp'], ['sms', 'SMS', 'SMS']]) {
    const c = cs && cs[key];
    let inbound = { ready: false, words: 'Not checked.', lastAt: null };
    const seen = await delivery.seenOf(id).catch(() => null);
    if (id === 'whatsapp') {
      let cfg = null;
      try { cfg = await require('../../utils/whatsappCloud').whatsappConfig(); } catch { cfg = null; } // eslint-disable-line global-require
      const ready = !!(cfg && cfg.appSecret && cfg.verifyToken);
      inbound = { ready: ready && !!seen, words: !ready ? 'Replies cannot arrive yet: the webhook needs the App secret and a verify token (Administration > Integrations > WhatsApp Business).' : (seen ? 'Meta has called our webhook, so replies can arrive.' : 'The webhook is set up here, but Meta has not called it yet. Replies arrive only after Meta is pointed at the live site address and subscribed to "messages".'), lastAt: seen ? seen.at : null };
    } else {
      inbound = { ready: !!seen, words: seen ? 'The SMS provider has called our webhook.' : 'No SMS report or reply has arrived yet. The provider must be pointed at our webhook address.', lastAt: seen ? seen.at : null };
    }
    rows.push({
      id, name, state: state(c), words: words[state(c)], reason: c && c.configured ? '' : ((c && c.reason) || `${name} has not been set up.`), provider: c && c.configured ? (c.via || c.detail || c.providerId || 'set up') : '',
      inbound, fix: c && c.configured ? '' : `An Admin sets up ${name} in Administration > Integrations.`,
    });
  }
  rows.push({ id: 'voice', name: 'Voice (calls)', state: 'planned', words: 'Calls are made by a person from a call task. The machine does not call.', reason: '', provider: '', inbound: { ready: false, words: '', lastAt: null }, fix: '' });
  rows.push({ id: 'rcs', name: 'RCS', state: 'planned', words: 'Planned. Nothing is sent on RCS yet.', reason: '', provider: '', inbound: { ready: false, words: '', lastAt: null }, fix: '' });
  return { channels: rows, testMode: st.emailTestMode !== false, sendingOn: st.master === true, rehearsal, isAdmin, note: 'This page only reads the real settings. A channel is "Connected" only when a provider is set up and real sending is switched on.' };
}

async function syncHealth() {
  await Schema.ensure();
  const ev = await Router.health();
  let msgFailed = 0; let msgWaiting = 0; let appFailed = 0;
  try { if (await S.campaignsReady()) { msgFailed = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE status = \'failed\''))[0].n); msgWaiting = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE status IN (\'queued\',\'sending\')'))[0].n); } } catch { /* tables optional */ }
  try { appFailed = S.num((await S.q('SELECT COUNT(*) n FROM "OmniAppCampaignItem" WHERE status = \'failed\''))[0].n); } catch { appFailed = 0; }
  const problems = ev.failed + msgFailed + appFailed;
  return {
    events: ev, campaignMessages: { failed: msgFailed, waiting: msgWaiting }, appCampaignMessages: { failed: appFailed },
    state: problems > 0 ? 'attention' : 'ok', words: problems > 0 ? `${problems} item${problems === 1 ? '' : 's'} need a look.` : 'Nothing is stuck. All provider events were handled.',
  };
}

module.exports = { channels, syncHealth };

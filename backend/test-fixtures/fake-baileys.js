// FAKE WhatsApp library for tests (stands in for @whiskeysockets/baileys). No network, no WhatsApp.
// Loaded only when TEST_MODE=1 and TL_QR_BAILEYS_MODULE points here (channels/qrEngine.js loadLibrary).
// The test drives it through globalThis.__fakeWa:  { sock, sent[], failNext, notOnWhatsApp: Set, creds, emit(event, payload) }
const { EventEmitter } = require('events');

const state = globalThis.__fakeWa = globalThis.__fakeWa || { sent: [], presence: [], failNext: 0, failMessage: 'fake send error', notOnWhatsApp: new Set(), sock: null, sockets: 0 };

function makeWASocket(config) {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (n, f) => ev.on(n, f), emit: (n, p) => ev.emit(n, p) },
    user: null,
    config,
    async sendMessage(jid, content) {
      if (state.failNext > 0) { state.failNext -= 1; throw new Error(state.failMessage); }
      const id = `FAKEWA${state.sent.length + 1}`;
      state.sent.push({ jid, content, id, at: Date.now() });
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate(kind, jid) { state.presence.push({ kind, jid }); },
    async onWhatsApp(jid) { return [{ jid, exists: !state.notOnWhatsApp.has(String(jid).split('@')[0]) }]; },
    async logout() { state.loggedOut = true; },
    end() { state.ended = true; },
  };
  state.sock = sock;
  state.sockets += 1;
  state.creds = config.auth.creds;
  state.emit = (name, payload) => sock.ev.emit(name, payload);
  // pair: what scanning the QR does
  state.pair = (phone = '919000000001') => {
    const me = { id: `${phone}:3@s.whatsapp.net` };
    config.auth.creds.me = me;
    sock.user = me;
    sock.ev.emit('creds.update', {});
    sock.ev.emit('connection.update', { connection: 'open' });
  };
  return sock;
}

module.exports = {
  default: makeWASocket,
  makeWASocket,
  initAuthCreds: () => ({ noiseKey: 'FAKE-NOISE-KEY-SECRET-MATERIAL', signedIdentityKey: 'FAKE-IDENTITY-KEY-SECRET', registrationId: 1234 }),
  BufferJSON: { replacer: (k, v) => v, reviver: (k, v) => v },
  DisconnectReason: { loggedOut: 401, forbidden: 403, connectionReplaced: 440, restartRequired: 515, connectionClosed: 428, timedOut: 408 },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  proto: null,
};

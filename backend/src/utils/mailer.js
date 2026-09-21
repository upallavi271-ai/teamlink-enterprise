// ---------------------------------------------------------------------------
// SMTP — the real one.
//
// Configuration comes from Administration → Integrations, channel `email`,
// through utils/integrationStore.js. The password is decrypted here and used
// here; it is never returned to a caller and never logged.
//
// SENDER IDENTITY — the user's requirement
// "A candidate message must go out from the employee's own email address,
//  taken from the employee record."
//
// CandidateMessage already carries that address (senderEmail, resolved by
// utils/candidateComms.js senderIdentity()). What SMTP will not do is let an
// authenticated mailbox claim an arbitrary envelope sender: the MAIL FROM has
// to be the account we authenticated as, or the provider rejects the message
// and the receiver's SPF check fails. So:
//
//   envelope.from  = the configured "From address" (the authenticated mailbox)
//   header From    = "Employee Name" <employee@domain>   ← what the candidate sees
//   Reply-To       = the employee's address              ← where replies land
//   Sender         = the configured From address         ← honest about who sent it
//
// That is the standard "send on behalf of" shape. It only reaches the inbox
// when the employee's DOMAIN authorises this SMTP host: SPF must include it,
// DKIM must sign for that domain and DMARC must be satisfiable. Where it is
// not — an employee on gmail.com sent through a company relay — DMARC
// alignment fails and the mail is spam-foldered or bounced. The README says
// so, and useEmployeeFrom below is the switch that falls back to the
// configured address in the header too.
// ---------------------------------------------------------------------------

const nodemailer = require('nodemailer');
const { readConfig } = require('./integrationStore');
const { ENV_VAR } = require('./secrets');

const CHANNEL = 'email';

function truthy(v) { return String(v || '').trim() !== ''; }

// Parse the five (now seven) configured fields into something nodemailer takes.
function shapeConfig(values) {
  const host = String(values['SMTP host'] || '').trim();
  const portRaw = String(values.Port || '').trim();
  const port = Number(portRaw) || 587;
  const encryption = String(values['Encryption (SSL / STARTTLS / None)'] || '').trim().toUpperCase();
  // Explicit if configured; otherwise the port decides, which is what every
  // provider's own instructions assume (465 = implicit TLS, 587 = STARTTLS).
  let secure;
  if (encryption === 'SSL' || encryption === 'TLS') secure = true;
  else if (encryption === 'STARTTLS' || encryption === 'NONE') secure = false;
  else secure = port === 465;
  return {
    host,
    port,
    secure,
    allowInsecure: encryption === 'NONE',
    user: String(values.Username || '').trim(),
    pass: String(values['Password / app key'] || ''),
    fromAddress: String(values['From address'] || '').trim(),
    fromName: String(values['Default from name'] || '').trim(),
  };
}

// The one place that decides "is email switched on". Everything — the worker,
// the test button, the candidate Communications tab — reads this.
async function emailConfig() {
  const cfg = await readConfig(CHANNEL);
  const values = shapeConfig(cfg.values || {});
  const problems = [];
  if (!cfg.row) problems.push('The Email (SMTP) channel has never been configured.');
  else {
    if (!truthy(values.host)) problems.push('No SMTP host.');
    if (!truthy(values.fromAddress)) problems.push('No From address.');
    if (cfg.missingKey) {
      problems.push(`A password is stored but this server cannot decrypt it — ${ENV_VAR} is missing or has changed.`);
    }
  }
  // Disconnect really disconnects: a channel that is switched off, or that an
  // administrator disconnected, stops sending, and the waiting rows go back to
  // "recorded, not transmitted".
  if (cfg.row && !cfg.row.enabled) problems.push('The channel is switched off.');
  else if (cfg.row && !cfg.connected) problems.push('The channel is disconnected — reconnect it in Administration → Integrations.');
  return {
    ...values,
    row: cfg.row,
    state: cfg.state,
    // "Configured" means we could actually open a connection and address a
    // message. Credentials are optional: an internal relay may take none.
    configured: problems.length === 0,
    problems,
    reason: problems.join(' '),
  };
}

let cached = null; // { key, transport }

function transportKey(cfg) {
  // Deliberately excludes the password itself — it is keyed by its length so
  // a password change still rebuilds the transport without holding a copy.
  return [cfg.host, cfg.port, cfg.secure, cfg.user, String(cfg.pass || '').length, cfg.fromAddress].join('|');
}

function buildTransport(cfg) {
  const key = transportKey(cfg);
  if (cached && cached.key === key) return cached.transport;
  if (cached && cached.transport) { try { cached.transport.close(); } catch { /* ignore */ } }
  const options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // A catch-all / internal relay commonly presents a self-signed cert. The
    // "None" encryption setting is the explicit opt-in for that; otherwise
    // certificate verification stays on.
    tls: cfg.allowInsecure ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
  if (cfg.user || cfg.pass) options.auth = { user: cfg.user, pass: cfg.pass };
  const transport = nodemailer.createTransport(options);
  cached = { key, transport };
  return transport;
}

// Drop the cached transport — called when Integrations saves new credentials.
function resetTransport() {
  if (cached && cached.transport) { try { cached.transport.close(); } catch { /* ignore */ } }
  cached = null;
}

// Whether a provider failure is worth another attempt. SMTP 4xx is by
// definition temporary; a socket/DNS/timeout failure is too. 5xx is the
// provider saying no, and so is an authentication failure.
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ETLS']);
function isTransient(err) {
  if (!err) return false;
  if (err.responseCode && Number(err.responseCode) >= 500) return false;
  if (err.responseCode && Number(err.responseCode) >= 400) return true;
  if (err.code === 'EAUTH') return false;
  if (err.code === 'EENVELOPE') return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  // Unknown shape — one more try is cheaper than losing the message.
  return true;
}

// The provider's own words, trimmed to something a screen can hold. Never
// includes credentials: nodemailer's error text carries the SMTP dialogue,
// which does not echo the password.
function providerError(err) {
  if (!err) return 'Unknown error';
  const bits = [];
  if (err.code) bits.push(String(err.code));
  if (err.responseCode) bits.push(String(err.responseCode));
  const text = String(err.response || err.message || '').trim().replace(/\s+/g, ' ');
  return `${bits.length ? `${bits.join(' ')} — ` : ''}${text}`.slice(0, 500);
}

// --- Envelope --------------------------------------------------------------
// See the header comment. `senderEmail`/`senderName` come off the message row.
function addressesFor(cfg, { senderEmail, senderName }, { useEmployeeFrom = true } = {}) {
  const service = cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress;
  if (!useEmployeeFrom || !senderEmail) {
    return { from: service, sender: undefined, replyTo: senderEmail || undefined, envelopeFrom: cfg.fromAddress };
  }
  return {
    from: senderName ? { name: senderName, address: senderEmail } : senderEmail,
    sender: cfg.fromAddress,
    replyTo: senderEmail,
    envelopeFrom: cfg.fromAddress,
  };
}

// --- Sending ---------------------------------------------------------------
// Returns { ok, providerRef, error, transient }. Throws nothing: the worker
// and the test button both want the failure as data.
async function sendMail({
  to, subject, text, senderEmail, senderName, useEmployeeFrom = true,
}) {
  const cfg = await emailConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, error: cfg.reason, transient: false };
  if (!to || !String(to).trim()) {
    return { ok: false, error: 'No recipient address on this record.', transient: false };
  }
  const addr = addressesFor(cfg, { senderEmail, senderName }, { useEmployeeFrom });
  try {
    const info = await buildTransport(cfg).sendMail({
      from: addr.from,
      sender: addr.sender,
      replyTo: addr.replyTo,
      to: String(to).trim(),
      subject: subject || '(no subject)',
      text: text || '',
      envelope: { from: addr.envelopeFrom, to: String(to).trim() },
    });
    // A message the provider did not accept for THIS recipient is not sent,
    // whatever else the response says.
    const accepted = (info.accepted || []).map((a) => (typeof a === 'string' ? a : a.address));
    if (!accepted.length) {
      return { ok: false, error: `The provider did not accept ${to}. ${(info.response || '').trim()}`.trim(), transient: false };
    }
    return { ok: true, providerRef: info.messageId || (info.response || '').trim() || null, response: (info.response || '').trim() };
  } catch (err) {
    return { ok: false, error: providerError(err), transient: isTransient(err) };
  }
}

// "Send test email" — proves the configuration end to end and reports the
// provider's real error when it fails.
async function verifyAndSendTest({ to, senderEmail, senderName, by }) {
  const cfg = await emailConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, error: cfg.reason };
  try {
    await buildTransport(cfg).verify();
  } catch (err) {
    return { ok: false, stage: 'connect', error: providerError(err) };
  }
  const sent = await sendMail({
    to,
    subject: 'TeamLink — SMTP test message',
    text: [
      'This is a test message from TeamLink Administration → Integrations.',
      '',
      `Triggered by: ${by || 'a TeamLink administrator'}`,
      `SMTP host: ${cfg.host}:${cfg.port} (${cfg.secure ? 'SSL/TLS' : 'STARTTLS or plain'})`,
      `Envelope sender: ${cfg.fromAddress}`,
      senderEmail ? `Header From: ${senderEmail}` : 'Header From: the configured From address',
      '',
      'If you received this, outbound email works and candidate messages will be transmitted.',
    ].join('\n'),
    senderEmail,
    senderName,
  });
  return sent.ok
    ? { ok: true, stage: 'send', providerRef: sent.providerRef, response: sent.response }
    : { ok: false, stage: 'send', error: sent.error };
}

module.exports = {
  CHANNEL,
  emailConfig,
  sendMail,
  verifyAndSendTest,
  resetTransport,
  isTransient,
  providerError,
};

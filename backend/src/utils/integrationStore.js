// ---------------------------------------------------------------------------
// The integration credential store.
//
// One place — the existing Integration.values JSON column — holds every
// channel's configuration, and this module is the only thing that reads or
// writes it. There is no second credential store.
//
// It adds two things to the plain JSON the catalogue used to keep:
//
//   1. SECRET FIELDS. Any field whose label looks like a credential (password,
//      secret, token, API key, ...) is encrypted with utils/secrets.js before
//      it is written, and is NEVER included in an API response — the browser
//      gets a masked hint instead.
//   2. A SERVER-SIDE READ. readConfig(id) returns the decrypted values for
//      code that actually has to talk to the provider (the mailer, the AI
//      agent). Nothing routes that object to a response.
//
// Only the backend calls readConfig(). Everything that shapes an HTTP response
// calls publicValuesFor().
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { integrationById } = require('./adminCatalog');
const {
  encryptSecret, decryptSecret, maskStored, isEncrypted,
} = require('./secrets');

// A field label is a secret when it names one. The regex is the rule; the
// explicit lists below only override it where a label is ambiguous.
const SECRET_LABEL = /password|secret|token|api key|access key|private key|signing|credential|auth/i;

// Labels that MATCH the regex but are not secrets, per channel. "Max answer
// tokens" is a cost cap, not a credential — it only matches because "tokens"
// contains "token".
const NOT_SECRET = {
  'ai-claude': ['Max answer tokens'],
};

// Labels that do NOT match the regex but must still be treated as secrets.
const ALSO_SECRET = {
  payments: ['Key secret'],
};

function isSecretField(channelId, label) {
  if ((NOT_SECRET[channelId] || []).includes(label)) return false;
  if ((ALSO_SECRET[channelId] || []).includes(label)) return true;
  return SECRET_LABEL.test(String(label || ''));
}

function parseValues(row) {
  try { return row && row.values ? JSON.parse(row.values) : {}; } catch { return {}; }
}

async function integrationRow(id) {
  let row = await prisma.integration.findUnique({ where: { id } });
  if (!row) row = await prisma.integration.create({ data: { id } });
  return row;
}

// --- What the browser may see ----------------------------------------------
// Non-secret fields verbatim; secret fields replaced by a masked hint. The
// plaintext of a secret never crosses this boundary.
function publicValuesFor(channel, row) {
  const stored = parseValues(row);
  const out = {};
  const secretHints = {};
  (channel.fields || []).forEach(([label]) => {
    const value = stored[label];
    if (isSecretField(channel.id, label)) {
      out[label] = '';
      secretHints[label] = maskStored(value);
    } else {
      out[label] = value == null ? '' : String(value);
    }
  });
  // Any value saved under a label the catalogue no longer lists is dropped
  // from the response rather than leaked under an unknown name.
  return { values: out, secretHints, secretFields: (channel.fields || []).filter(([l]) => isSecretField(channel.id, l)).map(([l]) => l) };
}

// --- What the server may see ------------------------------------------------
// Decrypted. Backend only. `missingKey` says a secret is stored but this
// process cannot read it, which is a configuration error worth reporting
// rather than a silent empty string.
async function readConfig(id) {
  const channel = integrationById(id);
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!channel || !row) {
    return { row: null, values: {}, connected: false, enabled: false, missingKey: false };
  }
  const stored = parseValues(row);
  const values = {};
  let missingKey = false;
  Object.entries(stored).forEach(([label, value]) => {
    if (isSecretField(id, label) && isEncrypted(value)) {
      const plain = decryptSecret(value);
      if (plain === null) { missingKey = true; values[label] = ''; } else { values[label] = plain; }
    } else {
      values[label] = value == null ? '' : String(value);
    }
  });
  return {
    row, values, connected: !!row.connected, enabled: !!row.enabled, state: row.state, missingKey,
  };
}

// --- Writing ---------------------------------------------------------------
// `incoming` is what the Configure modal posted. A secret left blank KEEPS the
// stored value — the modal never receives the plaintext, so an empty box means
// "unchanged", not "erase". Sending the literal string "-" clears it.
async function writeValues(id, incoming) {
  const channel = integrationById(id);
  if (!channel) throw new Error('Unknown channel');
  const row = await integrationRow(id);
  const stored = parseValues(row);
  const next = {};
  let filled = 0;

  channel.fields.forEach(([label]) => {
    const secret = isSecretField(id, label);
    const raw = incoming[label] == null ? '' : String(incoming[label]);
    if (!secret) {
      next[label] = raw;
      if (raw.trim()) filled += 1;
      return;
    }
    if (raw.trim() === '-') { next[label] = ''; return; }
    if (!raw.trim()) {
      // Unchanged — carry the stored ciphertext across untouched.
      const keep = stored[label];
      if (keep) { next[label] = keep; filled += 1; }
      return;
    }
    // A new secret. encryptSecret() throws NO_SECRET_KEY when the environment
    // has no key, and the route turns that into a 400 naming the variable.
    next[label] = encryptSecret(raw.trim());
    filled += 1;
  });

  return { values: next, filled };
}

module.exports = {
  isSecretField,
  parseValues,
  integrationRow,
  publicValuesFor,
  readConfig,
  writeValues,
};

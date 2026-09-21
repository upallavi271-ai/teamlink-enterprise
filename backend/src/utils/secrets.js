// ---------------------------------------------------------------------------
// Server-side secret store — encryption at rest for third-party credentials.
//
// Administration → Integrations collects credentials for outside channels
// (SMTP password, Anthropic API key, gateway tokens). Those values are
// SERVER-SIDE ONLY:
//
//   * at rest they are AES-256-GCM ciphertext inside Integration.values, keyed
//     by INTEGRATION_SECRET_KEY from the backend environment;
//   * on the wire to the browser they are replaced by a masked hint
//     ("••••••4f2a") — see utils/integrationStore.js maskedValuesFor();
//   * in logs they never appear at all. Nothing in this file, or in anything
//     that calls it, console.logs a plaintext secret or a key.
//
// THE KEY
// INTEGRATION_SECRET_KEY is either 64 hex characters (a raw 32-byte key) or any
// passphrase, which is stretched with scrypt against a fixed application salt.
// A fixed salt is correct here: the key is a single long-lived application
// secret held in the environment, not a per-user password, so there is no
// rainbow-table population to defend against, and a rotating salt would make
// existing ciphertext unreadable on restart.
//
// NO KEY CONFIGURED
// Encryption then fails LOUDLY rather than silently storing plaintext:
// encryptSecret() throws, and Integrations refuses to save a credential with a
// message naming the env var. Reading still works, so an install that already
// had plaintext values keeps functioning until the key is set.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const ENV_VAR = 'INTEGRATION_SECRET_KEY';
// Versioned prefix so a future algorithm change can be told apart from the
// v1 payloads and from legacy plaintext.
const PREFIX = 'enc:v1:';
const SALT = 'teamlink.integration.secrets.v1';

let cachedKey; // { source, key } — derived once per process.

function keyMaterial() {
  const raw = process.env[ENV_VAR];
  if (!raw || !String(raw).trim()) return null;
  const value = String(raw).trim();
  if (cachedKey && cachedKey.source === value) return cachedKey.key;
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = crypto.scryptSync(value, SALT, 32);
  }
  cachedKey = { source: value, key };
  return key;
}

function secretsConfigured() {
  return !!keyMaterial();
}

// The one sentence every caller uses when the key is missing, so the API, the
// README and the screen all say the same thing.
const NO_KEY_MESSAGE = `Set ${ENV_VAR} in the backend environment before saving a credential — secrets are never stored unencrypted.`;

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// enc:v1:<iv b64>:<authTag b64>:<ciphertext b64>
function encryptSecret(plain) {
  const key = keyMaterial();
  if (!key) {
    const err = new Error(NO_KEY_MESSAGE);
    err.code = 'NO_SECRET_KEY';
    throw err;
  }
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

// Returns the plaintext, or null when the value cannot be read (no key, wrong
// key, tampered ciphertext). A value that was never encrypted — an install
// that predates this store — is returned as-is so nothing breaks on upgrade.
function decryptSecret(value) {
  if (value == null || value === '') return '';
  if (!isEncrypted(value)) return String(value);
  const key = keyMaterial();
  if (!key) return null;
  const parts = String(value).slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered payload. Never log the value.
    return null;
  }
}

// What the browser is allowed to see instead of the secret: proof that
// something is stored, and just enough tail to recognise which key it is.
function maskHint(plain) {
  if (plain == null || plain === '') return '';
  const s = String(plain);
  if (s.length <= 4) return '••••';
  return `••••••${s.slice(-4)}`;
}

// The hint for a STORED value, without handing the plaintext to the caller.
function maskStored(stored) {
  if (stored == null || stored === '') return '';
  const plain = decryptSecret(stored);
  if (plain === null) return '•••••• (stored, but this key cannot read it)';
  return maskHint(plain);
}

module.exports = {
  ENV_VAR,
  NO_KEY_MESSAGE,
  secretsConfigured,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  maskHint,
  maskStored,
};

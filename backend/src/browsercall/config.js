// Manual browser calling: settings (DB) + environment. No secret is ever returned to the browser except a one-session SIP password (provision.js).
const S = require('./schema');
const env = process.env;
const ENV = {
  pjsipFile: env.BROWSER_CALL_PJSIP_FILE || '/etc/asterisk/pjsip_browser_users.conf',
  reloadCmd: env.BROWSER_CALL_RELOAD_CMD || 'asterisk',
  amiHost: env.BROWSER_CALL_AMI_HOST || '127.0.0.1',
  amiPort: Number(env.BROWSER_CALL_AMI_PORT || 5038),
  amiUser: env.BROWSER_CALL_AMI_USER || '',
  amiSecret: env.BROWSER_CALL_AMI_SECRET || '',
  wssUrl: env.BROWSER_CALL_WSS_URL || '', // e.g. wss://teamlink.teamlinks.in/sip-ws
  sipDomain: env.BROWSER_CALL_SIP_DOMAIN || 'teamlink.teamlinks.in',
  extStart: Number(env.BROWSER_CALL_EXT_START || 7001),
  sessionMinutes: Number(env.BROWSER_CALL_SESSION_MIN || 480),
  stun: env.BROWSER_CALL_STUN || 'stun:stun.l.google.com:19302',
};
const DEFAULTS = { mode: 'Off', testNumbers: '', kinds: 'admin,tl,recruiter,hr' };
const MODES = ['Off', 'Test', 'Live'];

async function load() {
  const rows = await S.all('SELECT "key", "value" FROM "BrowserCallSetting"');
  const m = { ...DEFAULTS };
  for (const r of rows) m[r.key] = r.value;
  if (!MODES.includes(m.mode)) m.mode = 'Off';
  return { mode: m.mode, testNumbers: String(m.testNumbers || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10), kinds: String(m.kinds || '').split(',').map((x) => x.trim()).filter(Boolean) };
}
async function save(patch) {
  const put = (k, v) => S.run('INSERT INTO "BrowserCallSetting" ("key","value","updatedAt") VALUES (?,?,?) ON CONFLICT("key") DO UPDATE SET "value"=excluded."value","updatedAt"=excluded."updatedAt"', k, String(v), S.nowIso());
  if (patch.mode !== undefined) { if (!MODES.includes(patch.mode)) throw new Error('Mode must be Off, Test or Live.'); await put('mode', patch.mode); }
  if (patch.testNumbers !== undefined) await put('testNumbers', String(patch.testNumbers).slice(0, 500));
  if (patch.kinds !== undefined) await put('kinds', (Array.isArray(patch.kinds) ? patch.kinds : String(patch.kinds).split(',')).map((x) => String(x).trim()).filter((x) => /^[a-z]+$/.test(x)).join(','));
  return load();
}
module.exports = { ENV, MODES, load, save };

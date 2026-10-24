// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE ONE PLACE FOR EVERY EXOTEL ASSUMPTION.
//
// Every URL path, form field name, status word and header name that talks to
// Exotel is written HERE and nowhere else. If the Exotel dashboard or docs say
// something different, correct it in this file; the rest of the code only
// uses these names.
//
// ALL OF THIS WAS WRITTEN FROM KNOWLEDGE OF EXOTEL'S PUBLIC API, WITHOUT
// INTERNET ACCESS. Rows marked ASSUMPTION must be checked against the
// Exotel dashboard / developer.exotel.com before the first real call. The same
// table is in the report ("ASSUMPTIONS TO VERIFY WITH EXOTEL") and is returned
// by GET /api/ai-calling/admin/assumptions so the Admin screen can show it.
// ---------------------------------------------------------------------------

// The Integrations channel that stores the settings (secrets are encrypted by utils/integrationStore.js).
const CHANNEL_ID = 'exotel-ai';

// Labels = the keys the settings are stored under. A label that contains the words password / secret / token /
// api key is treated as a SECRET by integrationStore (encrypted, never in a response). Keep the words
// "auth", "signing" and "credential" out of the other labels, they would be encrypted too.
const F = {
  mode: 'Calling switch (Off / Test / Live)',
  sid: 'Account SID',
  key: 'API key',
  token: 'API token',
  region: 'Region (Mumbai or Singapore)',
  host: 'API address (leave blank to use the region)',
  callerId: 'Approved caller ID (ExoPhone)',
  appId: 'Voicebot flow App ID',
  flowUrl: 'Voicebot flow URL (optional, replaces the App ID)',
  hook: 'Webhook secret',
  hookIps: 'Webhook allowed IP addresses (optional, comma separated)',
  publicBase: 'Public address of this TeamLink (https://...)',
  testNumbers: 'Test phone numbers (numbers you own, comma separated)',
  hoursFrom: 'Calling hours from (HH:MM, India time)',
  hoursTo: 'Calling hours to (HH:MM, India time)',
  outside: 'Outside calling hours (Queue / Refuse)',
  dailyLimit: 'Daily call limit (all recruiters)',
  userLimit: 'Daily call limit per recruiter (0 = no limit)',
  attempts: 'Most attempts per call (first try + retries)',
  gaps: 'Minutes to wait before each retry (comma separated)',
  languages: 'Languages offered (English, Telugu, Hindi)',
  fallbackLanguage: 'Language when the candidate has none saved',
  voice: 'Default voice',
  reminders: 'Interview reminder calls, hours before (comma separated)',
  callRoles: 'Roles that can place AI calls',
  bulkRoles: 'Roles that can place bulk campaigns',
  consentApplied: 'Allow service calls to people who applied but have no consent record (Yes / No)',
  dndService: 'Allow service calls to numbers marked DND (Yes / No)',
  recording: 'Record calls (Yes / No)',
  keepTranscripts: 'Keep call transcripts (Yes / No)',
  transcriptDays: 'Delete transcripts after (days)',
  recordingDays: 'Delete recordings after (days)',
  writtenEmail: 'Send a written follow-up by email (Yes / No)',
  writtenWhatsapp: 'Send a written follow-up on WhatsApp (Yes / No)',
  shortlistStages: 'Steps that count as Shortlisted (codes, comma separated)',
  maxBulk: 'Most candidates in one campaign',
};

// What the Admin sees as placeholders / defaults, in the order of the form.
const FIELD_LIST = [
  [F.mode, 'Off'],
  [F.sid, 'Exotel > Settings > API Settings'],
  [F.key, ''],
  [F.token, ''],
  [F.region, 'Mumbai'],
  [F.host, 'api.in.exotel.com'],
  [F.callerId, '0XXXXXXXXXX (the ExoPhone Exotel approved)'],
  [F.appId, 'App ID of the Flow with the Voicebot applet'],
  [F.flowUrl, ''],
  [F.hook, 'type any long text'],
  [F.hookIps, ''],
  [F.publicBase, 'https://your-teamlink-address'],
  [F.testNumbers, '98XXXXXXXX'],
  [F.hoursFrom, '09:00'],
  [F.hoursTo, '21:00'],
  [F.outside, 'Queue'],
  [F.dailyLimit, '100'],
  [F.userLimit, '0'],
  [F.attempts, '3'],
  [F.gaps, '30,120'],
  [F.languages, 'English, Telugu, Hindi'],
  [F.fallbackLanguage, 'English'],
  [F.voice, 'Exotel default voice'],
  [F.reminders, '24,2'],
  [F.callRoles, 'SUPER_ADMIN,ADMIN,STL,TL,RECRUITER'],
  [F.bulkRoles, 'SUPER_ADMIN,ADMIN,STL,TL'],
  [F.consentApplied, 'No'],
  [F.dndService, 'No'],
  [F.recording, 'No'],
  [F.keepTranscripts, 'No'],
  [F.transcriptDays, '90'],
  [F.recordingDays, '30'],
  [F.writtenEmail, 'No'],
  [F.writtenWhatsapp, 'No'],
  [F.shortlistStages, 'CLIENT_SHORTLISTED'],
  [F.maxBulk, '50'],
];

// Plain default for every setting (used when the Admin left it blank).
const DEFAULTS = {
  mode: 'Off', region: 'Mumbai', hoursFrom: '09:00', hoursTo: '21:00', outside: 'Queue', dailyLimit: 100, userLimit: 0,
  attempts: 3, gaps: [30, 120], languages: ['English', 'Telugu', 'Hindi'], fallbackLanguage: 'English', voice: '',
  reminders: [24, 2], callRoles: ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL', 'RECRUITER'], bulkRoles: ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL'],
  consentApplied: false, dndService: false, recording: false, keepTranscripts: false, transcriptDays: 90, recordingDays: 30,
  writtenEmail: false, writtenWhatsapp: false, shortlistStages: ['CLIENT_SHORTLISTED'], maxBulk: 50,
};

// --- Exotel hosts, paths, parameter names (ASSUMPTIONS, see the table) -------------------------------------------
const HOSTS = { mumbai: 'api.in.exotel.com', singapore: 'api.exotel.com' }; // ASSUMPTION 1

const PATHS = {
  // ASSUMPTION 3: start an outbound call (form-encoded POST). {sid} = Account SID.
  connect: '/v1/Accounts/{sid}/Calls/connect.json',
  // ASSUMPTION 6: read-only account check (lists 1 call). Places NO call.
  accountCheck: '/v1/Accounts/{sid}/Calls.json?PageSize=1',
  // ASSUMPTION 7: list the account's phone numbers (optional extra check; its failure is not fatal).
  numbers: '/v2_beta/Accounts/{sid}/IncomingPhoneNumbers',
  // ASSUMPTION 4: a call is connected to a Flow (App) with this Url. {sid}, {appId}.
  flowUrl: 'http://my.exotel.com/{sid}/exoml/start_voice/{appId}',
  // hang up a live call (cancel while ringing). ASSUMPTION 3b.
  hangup: '/v1/Accounts/{sid}/Calls/{callSid}.json',
};

// Form field names of the start-call request (ASSUMPTION 4).
const REQ = {
  to: 'From', // the person we call (Exotel "From" = the party dialled first)
  callerId: 'CallerId',
  url: 'Url',
  callType: 'CallType',
  callTypeValue: 'trans',
  timeLimit: 'TimeLimit',
  timeOut: 'TimeOut',
  record: 'Record',
  statusCallback: 'StatusCallback',
  statusEvents: 'StatusCallbackEvents[]',
  statusEventsValue: 'terminal',
  statusContentType: 'StatusCallbackContentType',
  statusContentTypeValue: 'application/json',
  custom: 'CustomField',
};

// Field names in Exotel's JSON answer to the start-call request (ASSUMPTION 5).
const RES = { root: 'Call', sid: 'Sid', status: 'Status' };

// Field names in the status callback Exotel posts to us (ASSUMPTION 8). Several spellings are accepted for each.
const CALLBACK = {
  sid: ['CallSid', 'Sid', 'call_sid'],
  status: ['Status', 'CallStatus', 'call_status'],
  duration: ['ConversationDuration', 'Duration', 'CallDuration', 'duration'],
  recording: ['RecordingUrl', 'recording_url'],
  custom: ['CustomField', 'custom_field'],
  updated: ['DateUpdated', 'EndTime', 'Updated'],
  direction: ['Direction'],
};

// Exotel status word -> our word (ASSUMPTION 8). ranks: a higher rank never goes back to a lower one.
const STATUS_RANK = {
  queued: 0, ringing: 1, 'in-progress': 2, answered: 2,
  completed: 3, busy: 3, 'no-answer': 3, failed: 3, canceled: 3, cancelled: 3,
};
const FINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled', 'cancelled']);
function normalStatus(word) {
  const w = String(word || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (w === 'noanswer') return 'no-answer';
  if (w === 'cancelled') return 'canceled';
  if (w === 'inprogress') return 'in-progress';
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, w) ? w : null;
}

// Webhook proof (ASSUMPTION 9). Exotel does not sign status callbacks (as far as I know), so: shared key in the URL,
// optional IP allow-list, optional HMAC header (used by the tests and by a signing proxy).
const WEBHOOK = {
  keyParam: 'key',
  signatureHeader: 'x-teamlink-signature', // hex HMAC-SHA256 of the raw body with the webhook secret
  timestampHeader: 'x-teamlink-timestamp', // optional, seconds since 1970; older than 10 minutes = replay
  maxAgeSeconds: 600,
  statusPath: '/api/webhooks/exotel-ai/status',
  voicebotHttpPath: '/api/webhooks/exotel-ai/voicebot',
  voicebotWsPath: '/api/webhooks/exotel-ai/voicebot/ws',
};

// Voicebot (WebSocket) event names (ASSUMPTION 10).
const VOICEBOT = {
  events: { connected: 'connected', start: 'start', media: 'media', dtmf: 'dtmf', stop: 'stop', mark: 'mark', clear: 'clear' },
  audio: 'PCM 16-bit little-endian, 8 kHz, mono, base64 inside JSON "media.payload"',
};

// The visible table (Admin screen + report). Keep in step with Plan.md section 5.
const ASSUMPTIONS = [
  { n: 1, what: 'API host', assumed: 'Mumbai accounts: api.in.exotel.com. Singapore accounts: api.exotel.com', confirm: 'Exotel dashboard > Settings > API Settings: the address shown for your account' },
  { n: 2, what: 'Authentication', assumed: 'HTTP Basic with API key as user and API token as password', confirm: 'Settings > API Settings > API Credentials' },
  { n: 3, what: 'Start call', assumed: 'POST /v1/Accounts/<SID>/Calls/connect.json, form-encoded', confirm: 'developer.exotel.com > Voice > Connect call to a flow' },
  { n: 4, what: 'Start call fields', assumed: 'From = candidate number, CallerId = approved ExoPhone, Url = http://my.exotel.com/<SID>/exoml/start_voice/<App ID>, CallType = trans, TimeLimit, StatusCallback + StatusCallbackEvents[]=terminal + StatusCallbackContentType=application/json, CustomField, Record', confirm: 'That an outbound call into a Flow uses From = customer and Url = the Flow, and that CustomField reaches the Voicebot' },
  { n: 5, what: 'Start call answer', assumed: 'JSON {"Call": {"Sid": "...", "Status": "queued"}}', confirm: 'The exact field names in a real answer' },
  { n: 6, what: 'Connection test (no call)', assumed: 'GET /v1/Accounts/<SID>/Calls.json?PageSize=1 (reads one call, places none)', confirm: 'That this read works on your account' },
  { n: 7, what: 'List phone numbers (optional)', assumed: 'GET /v2_beta/Accounts/<SID>/IncomingPhoneNumbers', confirm: 'The real path, or ignore: a failure here is shown as a note, not an error' },
  { n: 8, what: 'Status callback', assumed: 'Fields CallSid, Status (queued, ringing, in-progress, completed, busy, no-answer, failed, canceled), ConversationDuration or Duration, RecordingUrl, CustomField, DateUpdated. completed with 0 seconds is treated as not answered', confirm: 'Exact names, and whether an in-progress event can be asked for' },
  { n: 9, what: 'Callback proof', assumed: 'Exotel does not sign callbacks. TeamLink checks a secret key in the address (?key=), optionally the sender IP, and an HMAC header if one is present', confirm: 'Whether Exotel now offers signing, and the IP addresses Exotel calls from' },
  { n: 10, what: 'Voicebot applet', assumed: 'A Flow with a Voicebot applet pointing to wss://<your address>/api/webhooks/exotel-ai/voicebot/ws. Events connected, start, media, dtmf, stop, mark, clear. Audio PCM 16-bit 8 kHz base64', confirm: 'Voicebot is enabled on your Exotel account, the event names, the sample rate and how CustomField reaches the bot' },
  { n: 11, what: 'Speech to text / text to speech', assumed: 'Exotel Voicebot only streams audio. A speech-to-text and text-to-speech service must be plugged in (not bundled). The conversation logic is in TeamLink and is tested with text', confirm: 'Which speech service you will use for Telugu, Hindi and English' },
  { n: 12, what: 'Trial account', assumed: 'A trial may only call verified numbers, may not include Voicebot, and has limited credit', confirm: 'Your account type, credit balance, KYC / DLT status, outbound permission' },
];

const fillPath = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_m, k) => encodeURIComponent(vars[k] == null ? '' : String(vars[k])));

module.exports = {
  CHANNEL_ID, F, FIELD_LIST, DEFAULTS, HOSTS, PATHS, REQ, RES, CALLBACK, STATUS_RANK, FINAL, normalStatus, WEBHOOK, VOICEBOT, ASSUMPTIONS, fillPath,
};

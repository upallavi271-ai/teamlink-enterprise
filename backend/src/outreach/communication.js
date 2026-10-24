// ---------------------------------------------------------------------------
// OMNI-CHANNEL COMMUNICATION HUB (founder structure plan 2026-10-17): the WhatsApp / SMS / Email / Calls desks.
//   log()        what was sent on one way, read from the credit ledger (every send of the app passes it): who, when, which template, real or
//                Test, result. No addresses and no message text. Held to the login's scope (Admin all, Department Head / Manager by department,
//                Team Lead by team, others only their own).
//   quickSend()  ONE message to ONE of your Omni-Channel contacts on one way. Same safety as everything else: the person must have agreed to
//                that way (opted in), Test mode / "Outreach sending" OFF = rehearsal only (nothing is sent), credits are checked, Admin exempt.
// The inbox, the conversation view and the call logs are the app's one inbox (utils/conversations.js), shown pre-filtered by the screen.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const K = require('./contacts');
const Cr = require('./credits');
const Ins = require('./insights');
const { logAudit } = require('../utils/audit');

const WORD = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', call: 'Call' };

// THE ONE RULE for "may a real message leave the building": only when an Admin has switched "Outreach sending" ON and Test mode OFF, and never in the test sandbox.
// Anything else is a REHEARSAL: rows are written and counted as Test messages, no provider is called. quickSend, the Console and the Inbox's new chat all use this.
function isRehearsal(st) {
  let sandbox = false;
  try { sandbox = require('../utils/sandbox').isSandbox(); } catch { sandbox = false; } // eslint-disable-line global-require
  return !st.master || st.emailTestMode !== false || sandbox;
}

// after a REAL message went out, make it show in the one inbox (so the reply lands in the same chat). Never throws.
async function noteInInbox(user, row, ch, text, label) {
  try {
    const convo = require('../utils/conversations'); // eslint-disable-line global-require
    const hit = ch === 'email' ? await convo.findByEmail(row.address) : await convo.findByPhone(row.address);
    if (!hit) return null;
    // a candidate's own history lives in CandidateMessage (the caller writes it); a client's / employee's row is written by recordOut
    if (hit.type === 'CANDIDATE') {
      await prisma.candidateMessage.create({ data: { candidateId: hit.id, channel: WORD[ch], template: 'OMNI_SINGLE', templateLabel: label, trigger: 'Manual', recipient: row.address, body: text, status: 'SENT', senderUserId: user.id, senderName: user.name } });
    }
    return await convo.recordOut({ personType: hit.type, personId: hit.id, personName: hit.name, channel: WORD[ch], body: text, status: 'SENT', templateLabel: label, senderUserId: user.id, senderName: user.name });
  } catch { return null; }
}

async function log(user, channel, { limit = 100 } = {}) {
  await Cr.ensureTables();
  const ch = String(channel || '').toLowerCase();
  if (!Cr.CHANNELS.includes(ch)) return { error: 'Unknown way.', status: 400 };
  const sc = await Ins.scopeOf(user);
  const where = ['channel = ?']; const params = [ch];
  if (!sc.all) {
    if (sc.departments) { where.push(`LOWER(COALESCE(department,'')) IN (${sc.departments.map(() => '?').join(',') || "''"})`); params.push(...sc.departments); } else if (sc.userIds) { const ids = [...sc.userIds]; where.push(`userId IN (${ids.map(() => '?').join(',')})`); params.push(...ids); } else { where.push('userId = ?'); params.push(sc.onlyUserId); }
  }
  const rows = await prisma.$queryRawUnsafe(`SELECT CAST(at AS TEXT) at, userName, department, mode, result, templateLabel, source FROM "OmniCreditLedger" WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ${Math.min(300, Math.max(1, Number(limit) || 100))}`, ...params);
  return {
    channel: ch, word: WORD[ch], scopeWords: sc.words,
    rows: rows.map((r) => ({ at: S.iso(Number(r.at)), who: r.userName || 'System', department: r.department || '', real: r.mode === 'live', result: r.mode === 'test' ? 'Rehearsed (nothing sent)' : (r.result === 'sent' ? 'Sent' : 'Did not go'), template: r.templateLabel || '', from: ({ messaging: 'Message from a screen', campaign: 'Campaign', sequence: 'Automation', console: 'Communication Console' })[r.source] || r.source || '' })),
  };
}

async function quickSend(user, b) {
  const ch = String(b.channel || '').toLowerCase();
  if (!['whatsapp', 'sms', 'email'].includes(ch)) return { error: 'Choose WhatsApp, SMS or Email.', status: 400 };
  if (!(await S.ready())) return { error: 'Omni-Channel is being set up.', status: 503 };
  const one = await K.getOne(user, String(b.contactId || ''));
  if (!one) return { error: 'This person was not found in your contacts.', status: 404 };
  const st = await S.settings();
  const internal = one.row.contactType === 'internal';
  if (internal ? !(A.isAdmin(user) || (A.kind(user) === 'hr' && st.internalHrMaySend)) : !A.mayCampaign(user)) return { error: 'You can look at the contacts, but only the BDE team, Team Leads, HR (when an Admin allows it) and Admins can send from here.', status: 403 };
  const text = String(b.text || '').trim().slice(0, 1000);
  if (!text) return { error: 'Write the message.', status: 400 };
  const row = (await S.q('SELECT * FROM "OutreachContactChannel" WHERE contactId = ? AND channel = ?', one.row.id, ch))[0];
  if (!row || row.optIn !== 'opted_in') return { error: row && row.optIn === 'opted_out' ? 'This person asked us to stop on this way.' : 'This person has not agreed to get messages on this way yet.', status: 409 };
  if (!row.address) return { error: 'There is no address for this way.', status: 409 };
  const rehearsal = isRehearsal(st);
  const label = S.clip(b.templateLabel, 100) || 'Single message';
  if (rehearsal) {
    await Cr.record({ userId: user.id, channel: ch, mode: 'test', ok: true, templateLabel: label, source: 'messaging' });
    return { ok: 'Rehearsed: Test mode is on, so nothing was sent. It is counted as a Test message.', rehearsed: true };
  }
  const g = await Cr.guard({ userId: user.id, channel: ch, mode: 'live' });
  if (!g.ok) return { error: g.message, status: 402 };
  const res = await require('../utils/messaging').send(WORD[ch], { to: row.address, subject: S.clip(b.subject, 200) || 'A message from TeamLink', text: `${text}\n\nReply STOP to stop.`, vars: [text], kind: 'bulk', actorUserId: user.id, meta: { template: label, purpose: 'single' } }); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel single message', entity: 'OutreachContact', entityId: one.row.id, toValue: `${ch}: ${res.ok ? 'sent' : 'not sent'}` });
  if (res.ok) await noteInInbox(user, row, ch, text, label);
  return res.ok ? { ok: 'Sent.' } : { error: res.error || 'It did not go.', status: 502 };
}

module.exports = { log, quickSend, isRehearsal, noteInInbox, WORD };

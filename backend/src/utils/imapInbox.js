// ---------------------------------------------------------------------------
// THE SHARED INBOX (IMAP) — replies to our mail, brought into the person's conversation.
//
// Administration -> Integrations -> "Shared Inbox (IMAP)" holds the account (IMAP host, port, mailbox address,
// password / app key; the password is stored encrypted like every secret). With no account the conversation shows
// only the mail we SENT and says "Connect an inbox to see replies".
//
//   status()               { configured, reason, lastPoll }
//   pollOnce({ transport }) read new messages, match each to a person, store it as a reply (RECEIVED),
//                          raise unread + tell the owner. Returns { read, matched, stored, ignored, errors }.
//   parseMail(raw)         RFC 822 text -> { messageId, inReplyTo, references[], from, fromName, subject, date, text }
//   matchReply(parsed)     who is it from: (1) In-Reply-To / References = the Message-ID of a mail WE sent
//                          (CandidateMessage.providerRef / ConversationMessage.mailMessageId); (2) the sender address
//                          = a candidate's / client's / employee's e-mail.
//   realTransport()        a small IMAP-over-TLS client (LOGIN, SELECT, UID SEARCH, UID FETCH ... BODY.PEEK[]):
//                          no dependency. Tests inject a mock transport with the same one method.
//
// A message is read ONCE: the last UID is remembered (AppSetting 'mailbox.checkpoint'), and a Message-ID already
// stored is skipped. Mail we sent ourselves, bounces and automatic replies are not stored as replies.
// ---------------------------------------------------------------------------

const tls = require('tls');
const prisma = require('../db');
const { readConfig } = require('./integrationStore');
const convo = require('./conversations');

const CHANNEL = 'email-inbox';
const CKPT = 'mailbox.checkpoint';
const LAST = 'mailbox.lastpoll';
const MAX_PER_POLL = 40;

// ---- configuration ----------------------------------------------------------------
async function config() {
  const cfg = await readConfig(CHANNEL);
  const v = cfg.values || {};
  const host = String(v['IMAP host'] || '').trim();
  const address = String(v['Mailbox address'] || '').trim();
  const password = String(v['Password / app key'] || '');
  const port = Number(String(v.Port || '').trim()) || 993;
  const problems = [];
  if (!cfg.row) problems.push('No inbox has been connected yet.');
  else {
    if (!host) problems.push('No IMAP host.');
    if (!address) problems.push('No mailbox address.');
    if (!password) problems.push(cfg.missingKey ? 'A password is stored but this server cannot read it.' : 'No password.');
    if (!cfg.row.enabled) problems.push('The inbox is switched off.');
    else if (!cfg.connected) problems.push('The inbox is disconnected: reconnect it in Administration > Integrations.');
  }
  return { host, port, address, password, configured: problems.length === 0, problems, reason: problems.join(' ') };
}

async function getSetting(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function putSetting(key, value) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } }).catch(() => {});
}

async function status() {
  const c = await config();
  return { configured: c.configured, reason: c.configured ? null : c.reason, address: c.configured ? c.address : null, lastPoll: await getSetting(LAST) };
}

// ---- reading a message ---------------------------------------------------------------
function unfold(headerBlock) { return headerBlock.replace(/\r?\n[ \t]+/g, ' '); }
function headersOf(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const h = {};
  unfold(head).split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i < 1) return;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in h)) h[k] = line.slice(i + 1).trim();
  });
  return { h, body };
}
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(txt, 'base64').toString('utf8');
      return Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1').toString('utf8');
    } catch { return m; }
  });
}
function decodeBody(body, enc) {
  const e = String(enc || '').toLowerCase();
  try {
    if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (e === 'quoted-printable') {
      const joined = body.replace(/=\r?\n/g, '');
      return Buffer.from(joined.replace(/=([0-9A-Fa-f]{2})/g, (m, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1').toString('utf8');
    }
  } catch { /* fall through */ }
  return body;
}
// the plain-text part (first text/plain; text/html with tags removed when that is all there is)
function textOf(h, body) {
  const ct = String(h['content-type'] || 'text/plain');
  const m = /boundary="?([^";\s]+)"?/i.exec(ct);
  if (/multipart\//i.test(ct) && m) {
    const parts = body.split(`--${m[1]}`).slice(1).filter((p) => !/^--/.test(p.trim()));
    const parsed = parts.map((p) => headersOf(p.replace(/^\r?\n/, '')));
    const plain = parsed.find((p) => /text\/plain/i.test(p.h['content-type'] || 'text/plain') && !/multipart/i.test(p.h['content-type'] || ''));
    if (plain) return decodeBody(plain.body, plain.h['content-transfer-encoding']);
    const nested = parsed.find((p) => /multipart\//i.test(p.h['content-type'] || ''));
    if (nested) return textOf(nested.h, nested.body);
    const html = parsed.find((p) => /text\/html/i.test(p.h['content-type'] || ''));
    if (html) return decodeBody(html.body, html.h['content-transfer-encoding']).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
    return '';
  }
  const txt = decodeBody(body, h['content-transfer-encoding']);
  return /text\/html/i.test(ct) ? txt.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ') : txt;
}
// The new words only: what sits above "On … wrote:", "-----Original Message-----" or the quoted ">" lines.
function newWordsOnly(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*On .{5,200}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^\s*From:\s.+@/i.test(line) && out.length) break;
    if (/^\s*>/.test(line)) continue; // eslint-disable-line no-continue
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
}
const ids = (s) => (String(s || '').match(/<[^<>\s]+>/g) || []);
function addressOf(field) {
  const f = decodeWords(field || '');
  const m = /<([^<>]+@[^<>]+)>/.exec(f) || /([^\s<>"']+@[^\s<>"']+)/.exec(f);
  const name = f.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  return { address: m ? m[1].trim().toLowerCase() : '', name: name && !name.includes('@') ? name : '' };
}

function parseMail(raw) {
  const { h, body } = headersOf(String(raw || ''));
  const from = addressOf(h.from);
  return {
    messageId: (ids(h['message-id'])[0]) || null,
    inReplyTo: (ids(h['in-reply-to'])[0]) || null,
    references: ids(h.references),
    from: from.address, fromName: from.name,
    subject: decodeWords(h.subject || ''),
    date: h.date && !Number.isNaN(new Date(h.date).getTime()) ? new Date(h.date) : new Date(),
    auto: /auto-submitted:\s*auto-(replied|generated)/i.test(String(raw).slice(0, 4000)) || /^(mailer-daemon|postmaster)@/i.test(from.address) || /precedence:\s*(bulk|junk|auto_reply)/i.test(String(raw).slice(0, 4000)),
    text: newWordsOnly(textOf(h, body)),
  };
}

// ---- who is it from ---------------------------------------------------------------------------
async function matchReply(p) {
  const wanted = [p.inReplyTo, ...(p.references || [])].filter(Boolean);
  if (wanted.length) {
    const cm = await prisma.candidateMessage.findFirst({ where: { channel: 'Email', providerRef: { in: wanted } }, select: { candidateId: true, applicationId: true } }).catch(() => null);
    if (cm) {
      const c = await prisma.candidate.findUnique({ where: { id: cm.candidateId }, select: { id: true, name: true } }).catch(() => null);
      if (c) return { type: 'CANDIDATE', id: c.id, name: c.name, by: 'reply-to', applicationId: cm.applicationId };
    }
    if (await convo.ready()) {
      const marks = wanted.map(() => '?').join(',');
      const rows = await prisma.$queryRawUnsafe(`SELECT "personType","personId" FROM "ConversationMessage" WHERE "direction" = 'OUT' AND ("mailMessageId" IN (${marks}) OR "providerRef" IN (${marks})) LIMIT 1`, ...wanted, ...wanted);
      if (rows[0]) {
        const info = await convo.personInfo(rows[0].personType, rows[0].personId);
        if (info) return { type: rows[0].personType, id: rows[0].personId, name: info.name, by: 'reply-to' };
      }
    }
  }
  const hit = await convo.findByEmail(p.from);
  return hit ? { ...hit, by: 'sender' } : null;
}

// ---- a message arrives ---------------------------------------------------------------------------
async function alreadyHave(messageId) {
  if (!messageId) return false;
  if (await prisma.candidateMessage.count({ where: { providerRef: messageId, status: 'RECEIVED' } }).catch(() => 0)) return true;
  if (await convo.ready()) {
    const r = await prisma.$queryRawUnsafe('SELECT 1 AS x FROM "ConversationMessage" WHERE "mailMessageId" = ? AND "direction" = ? LIMIT 1', messageId, 'IN');
    if (r.length) return true;
  }
  return false;
}

async function store(p, who, ownAddress) {
  if (who.type === 'CANDIDATE') {
    await prisma.candidateMessage.create({
      data: {
        candidateId: who.id, applicationId: who.applicationId || null, channel: 'Email', template: 'INBOUND', templateLabel: 'Reply received', trigger: 'Reply',
        recipient: p.from, subject: (p.subject || '').slice(0, 300), body: p.text, status: 'RECEIVED',
        statusDetail: `Reply by e-mail${who.by === 'sender' ? ' (matched by the sender address)' : ''}`, providerRef: p.messageId, sentAt: p.date,
      },
    });
  }
  return convo.recordIn({
    personType: who.type, personId: who.id, personName: who.name, channel: 'Email', subject: p.subject, body: p.text, address: p.from,
    providerRef: p.messageId, mailMessageId: p.messageId, inReplyTo: p.inReplyTo, at: p.date,
    statusDetail: `Reply by e-mail${who.by === 'sender' ? ' (matched by the sender address)' : ''}`, ownAddress,
  });
}

async function pollOnce({ transport, messages } = {}) {
  const out = { read: 0, matched: 0, stored: 0, ignored: 0, errors: [] };
  const cfg = await config();
  let raws = [];
  let maxUid = null;
  try {
    if (messages) {
      raws = messages.map((m, i) => ({ uid: m.uid || i + 1, raw: typeof m === 'string' ? m : m.raw }));
    } else {
      if (!cfg.configured) return { ...out, notConfigured: true, error: cfg.reason };
      const ck = await getSetting(CKPT);
      const t = transport || realTransport();
      const got = await t.fetchNew(cfg, { sinceUid: ck && ck.address === cfg.address ? ck.uid : null, sinceDate: new Date(Date.now() - 3 * 86400000), limit: MAX_PER_POLL });
      raws = got.messages || [];
      maxUid = got.maxUid != null ? got.maxUid : null;
    }
  } catch (err) {
    out.errors.push(String(err && err.message).slice(0, 200));
    await putSetting(LAST, { at: new Date().toISOString(), ...out });
    return out;
  }
  for (const m of raws) {
    out.read += 1;
    try {
      const p = parseMail(m.raw);
      // our own mail, bounces, automatic replies and mail with no sender are not replies
      if (!p.from || (cfg.address && p.from === cfg.address.toLowerCase()) || p.auto) { out.ignored += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (await alreadyHave(p.messageId)) { out.ignored += 1; continue; } // eslint-disable-line no-continue
      // Omni-Channel reply router: the mail is written to the durable event list first (a replay is ignored); a sender that is nobody we know, or that
      // belongs to several records, waits in "Needs review" and is written on NO record
      let R = null; let ev = null;
      try { R = require('../outreach/omni/replyRouter'); ev = await R.begin({ provider: 'email.imap', id: p.messageId, channel: 'Email', from: p.from, text: p.text, at: p.date, name: p.fromName }); } catch { R = null; } // eslint-disable-line global-require
      if (ev && ev.duplicate) { out.ignored += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const who = await matchReply(p);
      if (R && ev && ev.id && who && who.by === 'sender') {
        const v = await R.decide({ email: p.from, channel: 'Email', at: p.date }); // eslint-disable-line no-await-in-loop
        if (v.status === 'ambiguous') { await R.park(ev, v, { channel: 'Email' }); out.ignored += 1; continue; } // eslint-disable-line no-await-in-loop, no-continue
      }
      if (!who) { if (R && ev && ev.id) await R.park(ev, { status: 'none', possible: [] }, { channel: 'Email' }); out.ignored += 1; continue; } // eslint-disable-line no-continue, no-await-in-loop
      out.matched += 1;
      let stored = null;
      try {
        stored = await store(p, who, cfg.address); // eslint-disable-line no-await-in-loop
      } catch (e2) { if (R && ev) await R.fail(ev, e2); throw e2; } // eslint-disable-line no-await-in-loop
      if (stored) out.stored += 1;
      if (R && ev && ev.id) await R.finish(ev, { type: who.type, id: who.id, name: who.name }, { channel: 'Email', text: p.text, at: p.date }); // eslint-disable-line no-await-in-loop
    } catch (err) { out.errors.push(String(err && err.message).slice(0, 200)); }
  }
  if (maxUid != null) await putSetting(CKPT, { address: cfg.address, uid: maxUid });
  await putSetting(LAST, { at: new Date().toISOString(), read: out.read, matched: out.matched, stored: out.stored, ignored: out.ignored, errors: out.errors.length });
  return out;
}

// ---- the IMAP client ---------------------------------------------------------------------------------
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const ymd = (d) => { const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${d.getUTCDate()}-${M[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

function realTransport() {
  return {
    fetchNew(cfg, { sinceUid, sinceDate, limit }) {
      return new Promise((resolve, reject) => {
        if (require('./sandbox').isSandbox()) { reject(new Error('Test server: the real mailbox is not contacted.')); return; } // eslint-disable-line global-require
        const sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: true });
        let buf = Buffer.alloc(0);
        let tag = 0;
        let waiting = null;
        let done = false;
        const fail = (err) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } reject(err instanceof Error ? err : new Error(String(err))); };
        sock.setTimeout(30000, () => fail(new Error('The mailbox did not answer in time.')));
        sock.on('error', fail);
        sock.on('data', (d) => { buf = Buffer.concat([buf, d]); check(); });
        function check() {
          if (!waiting) return;
          const text = buf.toString('latin1');
          const re = new RegExp(`(^|\\r\\n)${waiting.tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`);
          const m = re.exec(text);
          if (!m) return;
          const w = waiting; waiting = null;
          const body = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          if (m[2] !== 'OK') w.reject(new Error(`${m[2]}${m[3]}`.trim())); else w.resolve(body);
        }
        const cmd = (c) => new Promise((res, rej) => { tag += 1; const t = `a${tag}`; waiting = { tag: t, resolve: res, reject: rej }; sock.write(`${t} ${c}\r\n`); check(); });
        // greeting
        const greet = () => new Promise((res) => { const iv = setInterval(() => { if (buf.toString('latin1').includes('\r\n')) { clearInterval(iv); buf = Buffer.alloc(0); res(); } }, 20); });
        (async () => {
          try {
            await greet();
            await cmd(`LOGIN ${q(cfg.address)} ${q(cfg.password)}`);
            await cmd('SELECT INBOX');
            const crit = sinceUid ? `UID ${Number(sinceUid) + 1}:*` : `SINCE ${ymd(sinceDate)}`;
            const found = (await cmd(`UID SEARCH ${crit}`)).toString('latin1');
            let uids = ((/\* SEARCH([\d ]*)/.exec(found) || [])[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
            if (sinceUid) uids = uids.filter((u) => u > Number(sinceUid));
            uids.sort((a, b) => a - b);
            const take = uids.slice(0, limit || 40);
            const messages = [];
            for (const uid of take) {
              // eslint-disable-next-line no-await-in-loop
              const resp = await cmd(`UID FETCH ${uid} (BODY.PEEK[]<0.400000>)`);
              const s = resp.toString('latin1');
              const lit = /\{(\d+)\}\r\n/.exec(s);
              if (!lit) continue; // eslint-disable-line no-continue
              const start = lit.index + lit[0].length;
              messages.push({ uid, raw: resp.slice(start, start + Number(lit[1])).toString('utf8') });
            }
            const maxUid = take.length ? take[take.length - 1] : (uids.length ? null : (sinceUid || null));
            try { await cmd('LOGOUT'); } catch { /* */ }
            done = true; sock.end();
            resolve({ messages, maxUid: take.length === uids.length ? (uids.length ? uids[uids.length - 1] : maxUid) : take[take.length - 1] });
          } catch (err) { fail(err); }
        })();
      });
    },
  };
}

module.exports = { config, status, pollOnce, parseMail, matchReply, newWordsOnly, realTransport };

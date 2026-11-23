// ---------------------------------------------------------------------------
// AI MARKETING > SENDING TO THE CLIENT FOR APPROVAL (2026-11-21). Founder: "when a video is sent to the client for approval it must reach them as the NORMAL VIDEO (or picture), not as a link,
// with clear APPROVE and REJECT buttons; the answer comes back into the request".
//
//   WhatsApp   the video / picture ITSELF goes as a WhatsApp media message with two reply buttons (Approve, Reject) under it: ONE message per option.
//              * inside the 24 hours after the client wrote to the number: an interactive media message (channels/cloud.js);
//              * outside it: Meta only takes a TEMPLATE, so the "approval" template (AI usage > WhatsApp templates: a VIDEO / IMAGE header, the words, two quick-reply buttons) carries the file;
//              * with no such template: nothing link-only is sent. A short note (no link) tells the client their video is ready and to reply YES; the file is HELD and goes out with its buttons the
//                moment they reply (onInbound below). The project shows "waiting for the client to reply" until then.
//   Email      the video / picture is ATTACHED (a video too big for mail is first squeezed to fit with ffmpeg), with Approve and Reject buttons (links to the client page, which opens on that
//              choice; Reject asks for the reason).
//   Answers    a button tap, the page, or a reply with the reason lands in the project through projects.clientApprove / clientReject: the state moves (Approved / Rejected), the owner is
//              notified, the timeline and the Approvals tab show it.
//   Safety     a tap only counts when it comes from the client's own number (the last 10 digits match the project's number); everything is on the project's timeline; nothing is sent to anybody
//              but the client of that project.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const S = require('../outreach/store');

const TW = 'OmniMkApprovalWait';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TW}" ("id" TEXT NOT NULL PRIMARY KEY, "type" TEXT NOT NULL, "kind" TEXT NOT NULL, "refId" TEXT NOT NULL, "optionId" TEXT, "phone" TEXT NOT NULL, "numberId" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "doneAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TW}_phone" ON "${TW}"("phone", "type", "doneAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] approval wait schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const safeName = (t) => String(t || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'file';
const WA_VIDEO_MAX = 15 * 1024 * 1024; // WhatsApp takes 16 MB; a little room
const MAIL_VIDEO_MAX = 12 * 1024 * 1024;

// button ids: mkp|a|<optionId> (Approve) and mkp|r|<optionId> (Reject) for a client project; mkr|a|<reviewId> / mkr|r|<reviewId> for a single item sent for review
const buttonsFor = (prefix, id) => [{ id: `${prefix}|a|${id}`, title: 'Approve' }, { id: `${prefix}|r|${id}`, title: 'Reject' }];
const parseButton = (id) => { const m = /^(mkp|mkr)\|(a|r)\|([A-Za-z0-9_-]{4,60})$/.exec(String(id || '')); return m ? { scope: m[1], approve: m[2] === 'a', ref: m[3] } : null; };

// ---- squeezing a video to fit (free tool: ffmpeg) --------------------------------------------------------------------------------------------------------
function ffmpegFit(src, dst, maxBytes) {
  return new Promise((resolve) => {
    // 2-pass-free approach: pick a bitrate from the length so the file lands under the limit (audio 96k), H.264 baseline-ish, faststart for playing in chat
    const probe = spawn(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]);
    let out = ''; probe.stdout.on('data', (d) => { out += d; });
    probe.on('error', () => resolve(false));
    probe.on('close', () => {
      const dur = Math.max(1, Number(out.trim()) || 30);
      const totalKbps = Math.floor((maxBytes * 8 * 0.92) / dur / 1000);
      const vk = Math.max(200, totalKbps - 96);
      const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${vk}k`, '-maxrate', `${Math.floor(vk * 1.3)}k`, '-bufsize', `${vk * 2}k`, '-pix_fmt', 'yuv420p', '-vf', 'scale=min(1080\\,iw):-2', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst]);
      const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } resolve(false); }, 120000);
      ff.on('error', () => { clearTimeout(t); resolve(false); });
      ff.on('close', (code) => { clearTimeout(t); resolve(code === 0 && fs.existsSync(dst) && fs.statSync(dst).size <= maxBytes); });
    });
  });
}

// the file the channel can carry: { path, name, mime, cleanup } | { skip: why }
async function mediaFile(item, key, max) {
  const f = require('./images').rawFile(item); // eslint-disable-line global-require
  if (!f) return { skip: 'The file is not on the server any more.' };
  const tmp = [];
  const cleanup = () => tmp.forEach((p) => { try { fs.unlinkSync(p); } catch { /* gone */ } });
  if (/^video\//.test(String(item.mime || ''))) {
    if (item.mime === 'video/mp4' && fs.statSync(f.path).size <= max) return { path: f.path, name: `${safeName(item.title)}.mp4`, mime: 'video/mp4', cleanup: () => {} };
    const dst = path.join(os.tmpdir(), `mk-fit-${safeName(key)}-${Date.now()}.mp4`); tmp.push(dst);
    if (await ffmpegFit(f.path, dst, max)) return { path: dst, name: `${safeName(item.title)}.mp4`, mime: 'video/mp4', cleanup };
    cleanup();
    return { skip: item.mime === 'video/mp4' ? 'The video is too big to send and could not be made smaller on this server.' : 'The video could not be prepared as an MP4.' };
  }
  try { // a JPEG of at most 2048 px (WhatsApp 5 MB, mail friendly)
    const buf = await require('sharp')(f.path).rotate().flatten({ background: '#ffffff' }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(); // eslint-disable-line global-require
    const p = path.join(os.tmpdir(), `mk-send-${safeName(key)}-${Date.now()}.jpg`); fs.writeFileSync(p, buf); tmp.push(p);
    return { path: p, name: `${safeName(item.title)}.jpg`, mime: 'image/jpeg', cleanup };
  } catch { return { skip: 'The picture could not be prepared.' }; }
}

// ---- WhatsApp: one media message with buttons ------------------------------------------------------------------------------------------------------------
// -> { ok, mode: 'media'|'template'|'held', error, res }
async function waOne({ e164, file, text, buttons, numberOpts, meta, templatePayload }) {
  const res = await require('./sender').send({ // eslint-disable-line global-require -- a number that cannot send the template is swapped for one that can (marketing/sender.js send)
    to: e164, kind: 'text', text, media: [file], buttons, meta, ...numberOpts,
    ...(templatePayload ? { mediaTemplate: templatePayload.template, vars: templatePayload.vars } : {}),
  });
  if (res && res.ok) return { ok: true, mode: res.viaTemplate ? 'template' : 'media', res };
  if (res && res.code === 'WINDOW_CLOSED') return { ok: false, closed: true, res };
  return { ok: false, error: String((res && res.error) || 'WhatsApp refused it.').slice(0, 220), res };
}

// the words under a client project's option (no link: the buttons are the way to answer)
function captionFor(r, label, brand, firstName, extra) {
  const hi = firstName ? `Hello ${firstName},` : 'Hello,';
  const occ = r.occasion ? ` for ${String(r.occasion).slice(0, 80)}` : '';
  return `${hi} ${label ? `${label}: ` : ''}your creative${occ} from ${brand}.${extra ? ` ${extra}` : ''} Please tap Approve if it is good to go, or Reject and tell us what to change.`.slice(0, 1000);
}

/**
 * Send a client project's options to the client as REAL media with Approve / Reject.
 * ctx = { by, base, numberId, ways: ['whatsapp','email'], pk (Sender.pick result), set (settings) } -> { sent: [{ way, ok, to, mode, error, label }], held: bool }
 */
async function sendProject(r, items, ctx) {
  await ensure();
  const P = require('./projects'); // eslint-disable-line global-require
  const Cfg = require('./settings'); // eslint-disable-line global-require
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const Sender = require('./sender'); // eslint-disable-line global-require
  const brand = (await Cfg.getBrand()).brandName || 'TeamLink';
  const first = P.firstWord(r.contactName);
  const set = ctx.set || await Cfg.getSettings();
  const out = { sent: [], held: false };
  const meta = { audience: 'client', personName: S.clip(r.contactName || r.clientName, 80), purpose: 'AI Marketing: video / picture for the client to approve', module: 'AI Marketing', senderUserId: ctx.by ? ctx.by.id : undefined, senderName: ctx.by ? S.clip(ctx.by.name, 80) : undefined, automatic: !ctx.by };
  const WT = require('./waTemplates'); // eslint-disable-line global-require
  const tpl = WT.payload(set.waTemplates, 'approval', { name: first || 'there', occasion: S.clip(r.occasion, 80) || 'your request' });
  for (const way of ctx.ways) { // eslint-disable-line no-restricted-syntax
    if (way === 'whatsapp') {
      if (!String(r.contactPhone || '').trim()) { out.sent.push({ way: 'WhatsApp', ok: false, local: true, error: 'No WhatsApp number is saved for this client. Add it in Edit.' }); continue; } // eslint-disable-line no-continue
      const nm = core.normalizeMobile(r.contactPhone);
      if (!nm.ok) { out.sent.push({ way: 'WhatsApp', ok: false, local: true, error: 'The client\'s number does not look right. Fix it in Edit.' }); continue; } // eslint-disable-line no-continue
      if (ctx.pk && ctx.pk.error) { out.sent.push({ way: 'WhatsApp', ok: false, local: true, error: ctx.pk.error }); continue; } // eslint-disable-line no-continue
      const to = core.maskMobile(nm.e164);
      let closed = false;
      for (const it of items) { // eslint-disable-line no-restricted-syntax
        const file = await mediaFile(it.item, it.optionId, WA_VIDEO_MAX); // eslint-disable-line no-await-in-loop
        if (!file.path) { out.sent.push({ way: 'WhatsApp', ok: false, to, label: it.label, error: file.skip }); continue; } // eslint-disable-line no-continue
        const w = await waOne({ e164: nm.e164, file, text: captionFor(r, items.length > 1 ? it.label : '', brand, first, S.clip(r.clientMessage, 200)), buttons: buttonsFor('mkp', it.optionId), numberOpts: Sender.opts(ctx.pk || {}), meta, templatePayload: tpl }); // eslint-disable-line no-await-in-loop
        file.cleanup();
        if (w.ok) { out.sent.push({ way: 'WhatsApp', ok: true, to, label: it.label, mode: w.mode, from: Sender.fromWords(w.res).trim() }); continue; } // eslint-disable-line no-continue
        if (w.closed) { closed = true; break; }
        out.sent.push({ way: 'WhatsApp', ok: false, to, label: it.label, error: w.error });
      }
      if (closed) { // nothing link-only goes out: a short note without a link, and the files are held until the client replies
        const bulk = await Sender.send({ to: nm.e164, kind: 'bulk', text: `${first ? `Hello ${first},` : 'Hello,'} your creative${r.occasion ? ` for ${S.clip(r.occasion, 80)}` : ''} from ${brand} is ready. Please reply YES to this message and we will send it here, so you can watch it and approve it with one tap.\n\nReply STOP to stop messages about this request.`, vars: [`your creative${r.occasion ? ` for ${S.clip(r.occasion, 80)}` : ''} from ${brand} is ready. Please reply YES to this message and we will send it here, so you can watch it and approve it with one tap.`], meta, ...Sender.opts(ctx.pk || {}) }); // eslint-disable-line global-require
        if (bulk && bulk.ok) {
          await S.run(`UPDATE "${TW}" SET doneAt = ? WHERE type = 'hold' AND kind = 'project' AND refId = ? AND doneAt IS NULL`, Date.now(), r.id);
          await S.run(`INSERT INTO "${TW}" (id, type, kind, refId, optionId, phone, numberId, createdAt) VALUES (?,?,?,?,?,?,?,?)`, S.newId('aw'), 'hold', 'project', r.id, null, last10(nm.e164), (ctx.pk && ctx.pk.numberId) || null, Date.now());
          out.held = true;
          out.sent.push({ way: 'WhatsApp', ok: true, to, mode: 'held', from: Sender.fromWords(bulk).trim() });
        } else out.sent.push({ way: 'WhatsApp', ok: false, to, error: `The client is outside WhatsApp's 24 hours and no "video to approve" template is set (AI usage > WhatsApp templates). ${P.plainWhy ? P.plainWhy(bulk) : ''}`.trim() });
      }
    } else if (way === 'email') {
      const em = String(r.contactEmail || '').trim();
      if (!em) { out.sent.push({ way: 'Email', ok: false, local: true, error: 'No email address is saved for this client. Add it in Edit.' }); continue; } // eslint-disable-line no-continue
      const site = P.siteFor(ctx.base);
      const token = P.tokenOf(r.id);
      const files = []; const notes = [];
      for (const it of items) { // eslint-disable-line no-restricted-syntax
        const f = await mediaFile(it.item, it.optionId, MAIL_VIDEO_MAX); // eslint-disable-line no-await-in-loop
        if (!f.path) { notes.push(`${it.label}: ${f.skip}`); continue; } // eslint-disable-line no-continue
        files.push({ it, f });
      }
      if (!files.length) { out.sent.push({ way: 'Email', ok: false, to: core.maskEmail(em), error: notes.join(' ') || 'There is nothing to attach.' }); continue; } // eslint-disable-line no-continue
      const link = (o, act) => (site ? `${site}/client-project/${token}?o=${encodeURIComponent(o)}&do=${act}` : '');
      const lines = [`${first ? `Hello ${first},` : 'Hello,'} your creative${r.occasion ? ` for ${S.clip(r.occasion, 80)}` : ''} from ${brand} is attached to this email.`, ''];
      files.forEach(({ it }) => { lines.push(`${items.length > 1 ? `${it.label}: ` : ''}APPROVE: ${link(it.optionId, 'approve') || '(open the page we shared)'}`); lines.push(`${items.length > 1 ? `${it.label}: ` : ''}REJECT (you can tell us why): ${link(it.optionId, 'reject') || '(open the page we shared)'}`); lines.push(''); });
      if (r.clientMessage) lines.push(S.clip(r.clientMessage, 400), '');
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b2a24"><p>${first ? `Hello ${first},` : 'Hello,'} your creative${r.occasion ? ` for <b>${S.clip(r.occasion, 80).replace(/</g, '&lt;')}</b>` : ''} from ${brand.replace(/</g, '&lt;')} is attached to this email. Please watch it and tell us:</p>${files.map(({ it }) => `<p style="margin:14px 0">${items.length > 1 ? `<b>${it.label.replace(/</g, '&lt;')}</b><br>` : ''}<a href="${link(it.optionId, 'approve')}" style="background:#0a8f4d;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:bold;margin-right:8px">Approve</a> <a href="${link(it.optionId, 'reject')}" style="background:#c0392b;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Reject</a></p>`).join('')}${r.clientMessage ? `<p>${S.clip(r.clientMessage, 400).replace(/</g, '&lt;')}</p>` : ''}</div>`;
      const attachments = files.map(({ f }) => ({ filename: f.name, content: fs.readFileSync(f.path), contentType: f.mime }));
      files.forEach(({ f }) => f.cleanup());
      const res = await require('../utils/messaging').send('Email', { to: em, subject: `${brand}: please approve your ${files.some(({ it }) => /^video\//.test(it.item.mime || '')) ? 'video' : 'picture'}${r.occasion ? ` for ${S.clip(r.occasion, 60)}` : ''}`, text: lines.join('\n'), html, attachments, meta }); // eslint-disable-line global-require
      out.sent.push({ way: 'Email', ok: !!(res && res.ok), to: core.maskEmail(em), mode: 'attached', error: res && res.ok ? '' : S.clip((res && res.error) || 'The sender refused it.', 200), note: notes.join(' ') });
    }
  }
  return out;
}

// ---- the client's answer arrives on WhatsApp ----------------------------------------------------------------------------------------------------------------
async function replyText(phone, text, numberId) {
  try {
    await require('../utils/messaging').send('WhatsApp', { to: phone, kind: 'text', text, meta: { audience: 'client', purpose: 'AI Marketing: reply to the client\'s answer', module: 'AI Marketing', automatic: true }, ...(numberId ? { numberId, automatic: true } : { automatic: true }) }); // eslint-disable-line global-require
  } catch { /* a missed thank-you never blocks the answer */ }
}
async function projectOfOption(optionId) {
  await require('./projects').ensure(); // eslint-disable-line global-require
  const o = (await S.q('SELECT * FROM "OmniMkProjectOption" WHERE id = ?', optionId))[0];
  if (!o) return null;
  const r = (await S.q('SELECT * FROM "OmniMkProject" WHERE id = ? AND deletedAt IS NULL', o.projectId))[0];
  return r ? { o, r } : null;
}
/**
 * Called by the WhatsApp webhook for every incoming message (never throws). m = { from, text, buttonId, numberId }.
 * -> { handled: bool, note }
 */
async function onInbound(m) {
  try {
    await ensure();
    const from = last10(m.from);
    if (!from) return { handled: false };
    const P = require('./projects'); // eslint-disable-line global-require
    const btn = parseButton(m.buttonId);
    if (btn && btn.scope === 'mkp') {
      const g = await projectOfOption(btn.ref);
      if (!g) return { handled: false };
      if (last10(g.r.contactPhone) !== from) return { handled: true, note: 'a button tap from a number that is not the client\'s: ignored' };
      const who = P.firstWord(g.r.contactName) ? g.r.contactName : g.r.clientName;
      if (btn.approve) {
        const out = await P.clientApprove(P.tokenOf(g.r.id), { optionId: btn.ref, name: who, comment: '', via: 'WhatsApp button' });
        await replyText(m.from, out.error ? `Thank you. ${out.error}` : 'Thank you! We have recorded your approval and will go ahead.', m.numberId);
        return { handled: true, note: out.error || 'approved' };
      }
      const out = await P.clientReject(P.tokenOf(g.r.id), { optionId: btn.ref, name: who, comment: '', via: 'WhatsApp button' });
      if (!out.error) {
        await S.run(`INSERT INTO "${TW}" (id, type, kind, refId, optionId, phone, numberId, createdAt) VALUES (?,?,?,?,?,?,?,?)`, S.newId('aw'), 'reason', 'project', g.r.id, btn.ref, from, m.numberId || null, Date.now());
        await replyText(m.from, 'Thank you. Please reply here with a few words on what you would like changed.', m.numberId);
      } else await replyText(m.from, `Thank you. ${out.error}`, m.numberId);
      return { handled: true, note: out.error || 'rejected, reason asked' };
    }
    if (btn && btn.scope === 'mkr') {
      const CR = require('./clientReview'); // eslint-disable-line global-require
      const out = await CR.answerByButton(btn.ref, btn.approve, from, m.numberId);
      if (out && out.reply) await replyText(m.from, out.reply, m.numberId);
      return { handled: true, note: out && (out.error || out.note) };
    }
    const text = String(m.text || '').trim();
    if (!text) return { handled: false };
    // a reason for a rejection that is waiting for words (24 hours)
    const wait = (await S.q(`SELECT * FROM "${TW}" WHERE type = 'reason' AND phone = ? AND doneAt IS NULL AND createdAt > ? ORDER BY createdAt DESC LIMIT 1`, from, Date.now() - 86400000))[0];
    if (wait) {
      await S.run(`UPDATE "${TW}" SET doneAt = ? WHERE id = ?`, Date.now(), wait.id);
      if (wait.kind === 'review') {
        const out = await require('./clientReview').setReasonByReply(wait.refId, text); // eslint-disable-line global-require
        await replyText(m.from, 'Thank you, we have noted it and will come back with a new version.', m.numberId);
        return { handled: true, note: out && out.note };
      }
      const out = await P.clientRejectReason(wait.refId, wait.optionId, text);
      await replyText(m.from, 'Thank you, we have noted it and will come back with a new version.', m.numberId);
      return { handled: true, note: out && (out.error || 'reason recorded') };
    }
    // a held delivery: the client replied, so the window is open and the files go now with their buttons
    const held = (await S.q(`SELECT * FROM "${TW}" WHERE type = 'hold' AND phone = ? AND doneAt IS NULL AND createdAt > ? ORDER BY createdAt DESC LIMIT 1`, from, Date.now() - 7 * 86400000))[0];
    if (held) {
      await S.run(`UPDATE "${TW}" SET doneAt = ? WHERE id = ?`, Date.now(), held.id);
      if (held.kind === 'review') { const out = await require('./clientReview').deliverHeld(held.refId, m.from, held.numberId); return { handled: true, note: out && out.note }; } // eslint-disable-line global-require
      const out = await P.deliverHeld(held.refId, m.from, held.numberId);
      return { handled: true, note: out && (out.error || out.note) };
    }
    return { handled: false };
  } catch (e) { console.error('[omni-mk] approval inbound:', e.message); return { handled: false }; } // eslint-disable-line no-console
}

module.exports = { ensure, sendProject, onInbound, buttonsFor, parseButton, mediaFile, waOne, captionFor, last10, TW };

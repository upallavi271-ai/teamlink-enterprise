// ---------------------------------------------------------------------------
// SMS TEMPLATES IN BOTH PLACES (founder 2026-11-03: "sms sender adhi ayite unnadho andhulo unna templates ani ekkada sms dhantlo
// kanipinchali, integrations lo unna sms lo kanipinchali, omnichannel lo unna sms lo kanipinchali").
//
// Both apps send SMS through the SAME sender (TeamLink's SMS Push Platform / MSG91 login is copied into every Omni-Channel workspace by
// utils/greenStartIntegrations.js). An Indian SMS can only carry a DLT-approved template, so a template's DLT template id is what
// identifies it in both places. SMS Push Platform (web.smsgw.in) has NO call that lists the templates of an account (its API only sends
// and reports delivery), so templates are added once - in TeamLink (Administration > Message templates, channel SMS) or in Omni-Channel
// (Templates > SMS, or its DLT import) - and this file copies them across:
//
//   Omni-Channel -> TeamLink  every SMS template with a DLT template id becomes a TeamLink Message template (channel SMS, purpose
//                             "From Omni-Channel", not the default of any automatic message). Same DLT id = ONE row, never a duplicate.
//                             A template made in TeamLink is never overwritten. One an Admin deleted here is not taken in again.
//                             A template without a DLT id yet (waiting for DLT) stays in Omni-Channel only.
//   TeamLink -> Omni-Channel  every active TeamLink SMS template with a DLT id that a workspace does not have yet is added there
//                             (POST /templates, channel sms): Omni-Channel saves it as ready to send. One that came from Omni-Channel is
//                             never sent back.
// Every 10 minutes, right after an SMS template is saved in TeamLink, and on "Get from Omni-Channel" (Integrations > SMS Gateway).
// Nothing here can stop TeamLink: failures become words in the last result (AppSetting sms.omniSync). No token or secret is logged.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const STATE_KEY = 'sms.omniSync';
const GONE_KEY = 'sms.omniRemoved'; // DLT ids of Omni-Channel templates an Admin deleted from TeamLink: not taken in again
const OMNI_PURPOSE = 'CUSTOM_FROM_OMNI_CHANNEL';
const OMNI_LABEL = 'From Omni-Channel';
const OMNI_BY = 'Omni-Channel';
const SENDER_RE = /^[A-Z0-9]{3,11}$/; // Green Start's DLT header rule
const DLT_VAR_RE = /\{#var#\}/gi;

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const put = (key, v) => prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } }).catch(() => {});
async function lastOf(key) { const r = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null); return parse(r && r.value, null); }
const enabled = () => String(process.env.GREENSTART_ENABLED || 'true').toLowerCase() !== 'false';
const dltOf = (v) => String(v || '').trim();
const isAscii = (s) => /^[\x00-\x7F]*$/.test(String(s || '')); // eslint-disable-line no-control-regex
const isFromOmni = (row) => row && row.purpose === OMNI_PURPOSE;

/** A TeamLink SMS template -> Omni-Channel's create body (its SMS template rules: title 2-120, body <= 2000, header 3-11 letters/digits). */
function omniBodyOf(t) {
  const sender = String(t.senderId || '').trim().toUpperCase();
  const body = String(t.body || '').trim().slice(0, 2000);
  const n = String(t.name || t.purposeLabel || '').trim();
  return {
    name: (n.length >= 2 ? n : `TeamLink ${dltOf(t.dltTemplateId)}`).slice(0, 120),
    channel: 'sms', provider: 'TeamLink', category: 'Utility', language: isAscii(body) ? 'en' : 'unicode', body,
    variables: (body.match(DLT_VAR_RE) || []).length, dltTemplateId: dltOf(t.dltTemplateId),
    ...(SENDER_RE.test(sender) ? { senderId: sender } : {}),
  };
}

/** One Omni-Channel SMS template (its wire form) -> the TeamLink fields, or null when it has no DLT id yet. */
function rowOf(t, ws) {
  const dlt = dltOf(t && t.dltTemplateId);
  if (!dlt || String((t && t.channel) || '').toLowerCase() !== 'sms') return null;
  const body = String(t.body || '').trim();
  if (!body) return null;
  return {
    dltTemplateId: dlt.slice(0, 60),
    name: String(t.name || dlt).trim().slice(0, 120),
    body: body.slice(0, 1000),
    senderId: String(t.senderId || '').trim().slice(0, 30) || null,
    language: t.language === 'unicode' || !isAscii(body) ? 'Unicode' : 'English',
    usable: String(t.status || '').toLowerCase() === 'approved',
    workspace: ws.name,
  };
}

let running = null;
async function pull({ why = 'manual' } = {}) {
  if (running) return running;
  running = (async () => {
    const result = { at: new Date().toISOString(), why, ok: false, words: '', added: 0, updated: 0, alreadyHere: 0, removedHere: 0, seen: 0, workspaces: 0, sentToOmni: 0, sendProblems: [] };
    try {
      if (!enabled()) throw new Error('Omni-Channel is switched off on this server (GREENSTART_ENABLED=false).');
      const O = require('./rcsOmniSync'); // eslint-disable-line global-require -- the same company sign-in and Green Start API helper
      const gone = new Set((await lastOf(GONE_KEY)) || []);
      const token = await O.signIn();
      const wss = await O.workspacesOf(token);
      result.workspaces = wss.length;
      const mine = (await prisma.messageTemplate.findMany({ where: { channel: 'SMS', active: true, NOT: [{ dltTemplateId: null }, { dltTemplateId: '' }] } }))
        .filter((t) => !isFromOmni(t));
      for (const ws of wss) {
        const there = new Set(); // DLT ids this workspace already has
        const names = new Set();
        for (let page = 1; page <= 20; page += 1) {
          // eslint-disable-next-line no-await-in-loop
          const res = await O.call('GET', `/templates?channel=sms&pageSize=100&page=${page}`, { token, ws: ws.id });
          const items = (res && res.items) || [];
          for (const t of items) {
            if (t && t.name) names.add(String(t.name));
            const r = rowOf(t, ws);
            if (!r) continue; // eslint-disable-line no-continue
            there.add(r.dltTemplateId);
            result.seen += 1;
            // eslint-disable-next-line no-await-in-loop
            const cur = await prisma.messageTemplate.findFirst({ where: { channel: 'SMS', dltTemplateId: r.dltTemplateId }, orderBy: { createdAt: 'asc' } });
            if (!cur) {
              if (gone.has(r.dltTemplateId)) { result.removedHere += 1; continue; } // eslint-disable-line no-continue
              // eslint-disable-next-line no-await-in-loop
              await prisma.messageTemplate.create({
                data: {
                  purpose: OMNI_PURPOSE, purposeLabel: OMNI_LABEL, audience: 'candidate', channel: 'SMS', language: r.language, name: r.name,
                  body: r.body, active: r.usable, isDefault: false, builtIn: false, version: 1, dltTemplateId: r.dltTemplateId, senderId: r.senderId,
                  createdByName: OMNI_BY, updatedByName: OMNI_BY,
                  versions: { create: [{ version: 1, body: r.body, active: r.usable, dltTemplateId: r.dltTemplateId, senderId: r.senderId, changeNote: `From Omni-Channel (${r.workspace})`, changedByName: OMNI_BY }] },
                },
              });
              result.added += 1;
            } else if (isFromOmni(cur)) {
              // Omni-Channel owns the wording of the templates it made; TeamLink only copies a change (and keeps a version of it)
              if (cur.name !== r.name || cur.body !== r.body || (cur.senderId || null) !== r.senderId || cur.active !== r.usable) {
                const version = cur.version + 1;
                // eslint-disable-next-line no-await-in-loop
                await prisma.messageTemplate.update({
                  where: { id: cur.id },
                  data: {
                    name: r.name, body: r.body, senderId: r.senderId, active: r.usable, version, updatedByName: OMNI_BY,
                    versions: { create: [{ version, body: r.body, active: r.usable, dltTemplateId: r.dltTemplateId, senderId: r.senderId, changeNote: `Changed in Omni-Channel (${r.workspace})`, changedByName: OMNI_BY }] },
                  },
                });
                result.updated += 1;
              }
            } else result.alreadyHere += 1; // made in TeamLink: never overwritten
          }
          if (items.length < 100) break;
        }
        for (const t of mine) {
          const dlt = dltOf(t.dltTemplateId);
          if (there.has(dlt)) continue; // eslint-disable-line no-continue
          const body = omniBodyOf(t);
          if (names.has(body.name)) body.name = `${body.name.slice(0, 108)} (TeamLink)`; // the same title is used there by another template
          try {
            // eslint-disable-next-line no-await-in-loop
            await O.call('POST', '/templates', { token, ws: ws.id, body });
            result.sentToOmni += 1;
            there.add(dlt); names.add(body.name);
          } catch (err) {
            if (/already exists|DUPLICATE/i.test(String(err.message))) continue; // eslint-disable-line no-continue
            result.sendProblems.push(`${t.name} -> ${ws.name}: ${String(err.message).slice(0, 120)}`);
          }
        }
      }
      result.ok = true;
      result.words = `${result.seen} SMS template${result.seen === 1 ? '' : 's'} with a DLT id in Omni-Channel: ${result.added} new here, ${result.updated} updated, ${result.alreadyHere} already in TeamLink`
        + `${result.removedHere ? `, ${result.removedHere} deleted here by an Admin` : ''}.`
        + `${result.sentToOmni ? ` ${result.sentToOmni} TeamLink SMS template${result.sentToOmni === 1 ? '' : 's'} added in Omni-Channel.` : ''}`
        + `${result.sendProblems.length ? ` Not added in Omni-Channel: ${result.sendProblems.slice(0, 3).join(' | ')}${result.sendProblems.length > 3 ? ' ...' : ''}` : ''}`;
    } catch (err) {
      result.words = String((err && err.message) || err).slice(0, 300);
    }
    await put(STATE_KEY, result);
    return result;
  })().finally(() => { running = null; });
  return running;
}

/** After an SMS template is saved in TeamLink: copy it to Omni-Channel soon (a few saves in a row = one run). */
let soon = null;
function pullSoon(why = 'template saved in TeamLink') {
  clearTimeout(soon);
  soon = setTimeout(() => { pull({ why }).catch(() => {}); }, Number(process.env.SMS_OMNI_PULL_DELAY_MS) || 5000);
  if (soon.unref) soon.unref();
}

/** An Admin deleted a template that came from Omni-Channel: remember its DLT id so the next run does not bring it back. */
async function forget(dltTemplateId) {
  const id = dltOf(dltTemplateId);
  if (!id) return;
  const list = new Set((await lastOf(GONE_KEY)) || []);
  list.add(id);
  await put(GONE_KEY, [...list].slice(-1000));
}

let timer = null;
function start() {
  if (require('./sandbox').isSandbox() || timer) return; // eslint-disable-line global-require
  timer = setInterval(() => { pull({ why: 'every 10 minutes' }).catch(() => {}); }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  const first = setTimeout(() => { pull({ why: 'start' }).catch(() => {}); }, 2 * 60 * 1000);
  if (first.unref) first.unref();
}

const lastPull = () => lastOf(STATE_KEY);
module.exports = { pull, pullSoon, forget, start, lastPull, rowOf, omniBodyOf, isFromOmni, OMNI_PURPOSE, OMNI_LABEL, STATE_KEY, GONE_KEY };

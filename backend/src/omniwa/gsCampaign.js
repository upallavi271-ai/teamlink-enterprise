// ---------------------------------------------------------------------------
// WHATSAPP AI AGENT: did a campaign sent INSIDE Omni-Channel (Green Start) reach this number? Those sends are not in TeamLink's promotion log, but the replies come here
// (Meta's webhook points at TeamLink), so the agent asks Green Start's GET /campaigns/recent-recipient, workspace by workspace, once for a person it does not know as promoted.
// A campaign there has no TeamLink job: the agent uses the candidate's latest application, or searches the open jobs. Never throws: no answer = not a promotion.
// ONE NUMBER, ONE WORKSPACE (founder 2026-11-06: "education 2 lo promotion chestey adhi education 2 lone kanipinchali"): each company number has its workspace
// (omni.gs.waMap), and the campaign check and the AI's replies go there and nowhere else, whatever old threads this person has in other workspaces.
// ---------------------------------------------------------------------------
const GI = require('../utils/greenStartIntegrations');

const TOKEN_MS = 20 * 60000;
const WAIT_MS = 8000;
const RETRY_MS = 6000;
let login = null; // { token, wss, at }

async function session() {
  if (login && Date.now() - login.at < TOKEN_MS) return login;
  const { token } = await GI.signIn();
  login = { token, wss: await GI.workspacesOf(token), at: Date.now() };
  return login;
}
// the workspaces this chat may touch. No map at all = the old one-number company: every workspace. A number the map does not know is not in Omni-Channel: none.
async function workspacesFor(numberId, wss) {
  const map = (await GI.readWaMap()) || {};
  if (!Object.keys(map).length) return wss;
  const home = map[numberId] && map[numberId].workspaceId;
  return wss.filter((w) => w.id === home);
}
const inTime = (p) => Promise.race([p, new Promise((_, no) => { setTimeout(() => no(new Error('Omni-Channel did not answer')), WAIT_MS); })]);

// -> { campaignId, campaignName, at } | null
async function recentSend(e164, days, numberId) {
  try {
    const { token, wss } = await inTime(session());
    let best = null;
    for (const ws of await workspacesFor(numberId, wss)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await inTime(GI.call('GET', `/campaigns/recent-recipient?phone=${encodeURIComponent(e164)}&days=${Number(days) || 7}`, { token, ws: ws.id }));
      const at = r && r.found ? new Date(r.sentAt).getTime() : 0;
      if (at && (!best || at > best.at)) best = { campaignId: `gs:${r.campaignId}`, campaignName: r.campaignName, at };
    }
    return best;
  } catch (err) {
    login = null;
    console.error('[omni-wa] Green Start campaign check:', err && err.message); // eslint-disable-line no-console
    return null;
  }
}

// a reply TeamLink sent goes into the person's open thread in Green Start, so Channels > WhatsApp shows both sides. Nothing is sent again. The workspace of the number the
// person wrote to takes it (their reply may still be on its way there: asked once more). Never throws, not awaited: the candidate already has the message.
// The workspace whose thread with this person moved last: their message has just landed there (Green Start files it by the number it came to).
// Used when TeamLink's map does not name the number's workspace (founder 2026-11-09: AI replies reached the phone but not the Green Start chat).
async function newestThread(e164, token, wss) {
  let best = null;
  for (const ws of wss) {
    // eslint-disable-next-line no-await-in-loop
    const r = await inTime(GI.call('GET', `/conversations?channel=whatsapp&search=${encodeURIComponent(String(e164).slice(-10))}&pageSize=5`, { token, ws: ws.id })).catch(() => null);
    const at = Math.max(0, ...((r && r.items) || []).map((c) => new Date(c.lastMessageAt || 0).getTime()).filter(Number.isFinite));
    if (at && (!best || at > best.at)) best = { ws, at };
  }
  return best ? [best.ws] : [];
}
const LAST_KEY = 'omni.gs.mirrorLast';
async function remember(row) {
  try {
    const value = JSON.stringify({ at: new Date().toISOString(), ...row });
    await require('../db').appSetting.upsert({ where: { key: LAST_KEY }, create: { key: LAST_KEY, value }, update: { value } }); // eslint-disable-line global-require
  } catch { /* only for the check script */ }
}
async function mirror(e164, text, providerMessageId, numberId, again = true) {
  const tail = String(e164).slice(-4);
  try {
    const { token, wss } = await inTime(session());
    const map = (await GI.readWaMap()) || {};
    const mapped = map[numberId] && map[numberId].workspaceId ? wss.filter((w) => w.id === map[numberId].workspaceId) : [];
    const home = mapped.length ? mapped : await newestThread(e164, token, wss);
    for (const ws of home) {
      // eslint-disable-next-line no-await-in-loop
      const r = await inTime(GI.call('POST', '/conversations/import-outbound', { token, ws: ws.id, body: { phone: e164, text: String(text).slice(0, 4000), ...(providerMessageId ? { providerMessageId } : {}) } }));
      if (r && r.stored) { await remember({ phone: tail, numberId: numberId || null, by: mapped.length ? 'number map' : 'newest thread', workspace: ws.name, stored: true }); return; }
    }
    if (again && home.length) { setTimeout(() => { mirror(e164, text, providerMessageId, numberId, false); }, RETRY_MS); return; }
    await remember({ phone: tail, numberId: numberId || null, by: mapped.length ? 'number map' : 'newest thread', workspace: home[0] ? home[0].name : null, stored: false, why: home.length ? 'the workspace has no open chat with this person' : 'no workspace has a chat with this person' });
  } catch (err) {
    await remember({ phone: tail, numberId: numberId || null, stored: false, why: String((err && err.message) || 'error').slice(0, 200) });
    console.error('[omni-wa] Green Start thread:', err && err.message); // eslint-disable-line no-console
  }
}
const reset = () => { login = null; };

// THE WORDS OF THE TEMPLATE A GREEN START CAMPAIGN SENT this number (founder 2026-11-11: after a campaign from Omni-Channel "what is the job role" got "not in our message":
// that send is not in TeamLink's log, so the message text was empty). Read from the person's thread there: its template messages, newest first. Never throws: [] = none.
async function sentText(e164, numberId) {
  try {
    const { token, wss } = await inTime(session());
    const out = [];
    for (const ws of await workspacesFor(numberId, wss)) {
      // eslint-disable-next-line no-await-in-loop
      const list = await inTime(GI.call('GET', `/conversations?channel=whatsapp&search=${encodeURIComponent(String(e164).slice(-10))}&pageSize=3`, { token, ws: ws.id })).catch(() => null);
      for (const c of ((list && list.items) || []).slice(0, 2)) {
        // eslint-disable-next-line no-await-in-loop
        const m = await inTime(GI.call('GET', `/conversations/${c.id}/messages?page=1&pageSize=100`, { token, ws: ws.id })).catch(() => null);
        ((m && m.items) || []).filter((x) => x.direction === 'outbound' && (x.type === 'template' || x.templateName) && String(x.text || '').trim())
          .forEach((x) => out.push({ at: new Date(x.createdAt || x.sentAt || 0).getTime() || 0, text: String(x.text).trim() }));
      }
    }
    return out.sort((a, b) => b.at - a.at).map((x) => x.text);
  } catch (err) {
    console.error('[omni-wa] Green Start template text:', err && err.message); // eslint-disable-line no-console
    return [];
  }
}

module.exports = { recentSend, mirror, reset, sentText };

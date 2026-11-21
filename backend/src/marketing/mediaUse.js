// ---------------------------------------------------------------------------
// AI MARKETING > MEDIA FOR CAMPAIGNS (2026-11-21). Founder: "when a campaign is run the images, banners and videos made in AI Marketing must go out with the messages: the sender can pick them
// for the campaign and the recipients receive them; banners must be made, approved, stored, picked in a campaign, sent, and counted".
// Green Start's campaign screen (Communication > Campaigns) asks TeamLink - server to server, signed (routes/omniVoiceBridge.js) - for the APPROVED pictures, banners and videos, shows them to pick, and
// sends the pick with the campaign (a WhatsApp template's media header, the top of an email). It tells TeamLink back what it used, so each item shows how many campaigns carried it and to how many people.
//   list   only APPROVED items (a draft or a waiting one is never offered), never a raw clip; each with a public https link Meta / mail apps can fetch (the same signed link as the Calendar).
//   video  WhatsApp takes an MP4 (H.264); a WebM video is offered with a flag so the screen can say so.
//   use    mk_media_use rows: item, campaign, channel, how many recipients, when. The counts shown in AI Images / AI Video come from here.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Img = require('./images');

const TU = 'OmniMkMediaUse';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TU}" ("id" TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "campaignName" TEXT, "channel" TEXT, "recipients" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${TU}_item_campaign" ON "${TU}"("itemId", "campaignId")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); await Img.ensure(); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] media use schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}
const kindOf = (r) => (Img.isVideoRow(r) ? 'video' : (r.style === 'banner' ? 'banner' : 'picture'));

// -> [{ id, kind, title, aspect, mime, bytes, url, jpegUrl, whatsappReady, note, uses: { campaigns, recipients } }]   base = the site's https address
async function approvedMedia(base) {
  await ensure();
  const site = String(base || '').replace(/\/+$/, '');
  const rows = await S.q(`SELECT * FROM "${Img.TABLE || 'OmniMkImage'}" WHERE deletedAt IS NULL AND status = 'approved' AND (style IS NULL OR style <> 'clip') ORDER BY createdAt DESC LIMIT 300`);
  const uses = new Map((await S.q(`SELECT itemId, COUNT(*) AS c, COALESCE(SUM(recipients),0) AS n FROM "${TU}" GROUP BY itemId`)).map((x) => [x.itemId, { campaigns: S.num(x.c), recipients: S.num(x.n) }]));
  return rows.map((r) => {
    const video = Img.isVideoRow(r);
    const mp4 = r.mime === 'video/mp4';
    const mb = Math.round((S.num(r.bytes) / 1048576) * 10) / 10;
    let note = '';
    if (video && !mp4) note = 'This video is a WebM: WhatsApp needs an MP4. Make it again in AI Video (new videos are saved as MP4).';
    else if (video && S.num(r.bytes) > 16 * 1048576) note = `This video is ${mb} MB: WhatsApp takes up to 16 MB.`;
    return {
      id: r.id, kind: kindOf(r), title: r.title, aspect: r.aspect || '1:1', mime: r.mime, bytes: S.num(r.bytes), mb,
      url: site ? `${site}${Img.publicPathOf(r)}` : '', jpegUrl: site && !video && /^image\/(png|webp)$/.test(r.mime || '') ? `${site}${Img.publicJpegPath(r)}` : (site && !video ? `${site}${Img.publicPathOf(r)}` : ''),
      whatsappReady: !note, note, uses: uses.get(r.id) || { campaigns: 0, recipients: 0 },
    };
  });
}
// Green Start reports what a campaign carried. items = [id], once per (item, campaign)
async function recordUse({ itemIds, campaignId, campaignName, channel, recipients }) {
  await ensure();
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String))].slice(0, 12);
  const cid = S.clip(campaignId, 80);
  if (!ids.length || !cid) return { ok: false, error: 'No items or campaign.' };
  let n = 0;
  for (const id of ids) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(id); // eslint-disable-line no-await-in-loop
    if (!it) continue; // eslint-disable-line no-continue
    await S.run(`INSERT INTO "${TU}" (id, itemId, campaignId, campaignName, channel, recipients, createdAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(itemId, campaignId) DO UPDATE SET recipients = excluded.recipients, channel = excluded.channel, campaignName = excluded.campaignName`, S.newId('mu'), id, cid, S.clip(campaignName, 120) || null, S.clip(channel, 20) || null, Math.max(0, Math.min(10000000, Math.floor(Number(recipients) || 0))), Date.now()); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  return { ok: true, recorded: n };
}
// { itemId -> { campaigns, recipients } } for the lists in AI Images / AI Video
async function countsFor(ids) {
  await ensure();
  const out = {};
  if (!ids || !ids.length) return out;
  const rows = await S.q(`SELECT itemId, COUNT(*) AS c, COALESCE(SUM(recipients),0) AS n FROM "${TU}" GROUP BY itemId`);
  const want = new Set(ids);
  rows.forEach((x) => { if (want.has(x.itemId)) out[x.itemId] = { campaigns: S.num(x.c), recipients: S.num(x.n) }; });
  return out;
}
// totals for the AI Marketing overview
async function totals() {
  await ensure();
  const r = (await S.q(`SELECT COUNT(DISTINCT itemId) AS items, COUNT(DISTINCT campaignId) AS campaigns, COALESCE(SUM(recipients),0) AS n FROM "${TU}"`))[0] || {};
  return { items: S.num(r.items), campaigns: S.num(r.campaigns), recipients: S.num(r.n) };
}

module.exports = { ensure, approvedMedia, recordUse, countsFor, totals, kindOf };

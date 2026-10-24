// ---------------------------------------------------------------------------
// CAMPAIGN ACTIVITY (2026-10-17, Omni-Channel > Campaigns > a campaign > Activity): "everything this campaign has done", from real things only.
// One row per thing a PERSON did to a campaign (made it, asked for approval, approved, sent it back, scheduled, paused, resumed, stopped, resent the failed
// ones, copied it). Messages going out are NOT written here: they are counted from OutreachMessage. Ids, a kind and a short sentence: never a phone / email.
// Self-provisioned table OmniCampaignActivity (migration 20261017110000_omni_gs_campaigns). log() never throws.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniCampaignActivity" ("id" TEXT NOT NULL PRIMARY KEY, "campaignId" TEXT NOT NULL, "groupId" TEXT, "at" DATETIME NOT NULL DEFAULT 0, "kind" TEXT NOT NULL, "text" TEXT NOT NULL, "byId" TEXT, "byName" TEXT)',
  'CREATE INDEX IF NOT EXISTS "OmniCampaignActivity_campaign_idx" ON "OmniCampaignActivity"("campaignId", "at")',
  'CREATE INDEX IF NOT EXISTS "OmniCampaignActivity_group_idx" ON "OmniCampaignActivity"("groupId", "at")',
];
let okAt = 0; let ensuring = null;
async function ensure() {
  if (okAt) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try { for (const sql of DDL) await run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-campaign-activity] table:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));

// row: the OutreachCampaign row (or { id, meta }); kind: created | submitted | approved | changes | scheduled | sent | paused | resumed | stopped | resent | copied | edited | called
async function log(row, kind, text, user, at = Date.now()) {
  try {
    if (!row || !(await ensure())) return null;
    let meta = row.meta; if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const id = `oca${at.toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    await run('INSERT INTO "OmniCampaignActivity" (id, campaignId, groupId, at, kind, text, byId, byName) VALUES (?,?,?,?,?,?,?,?)', id, row.id, (meta && meta.groupId) || null, at, clip(kind, 20), clip(text, 300), user && user.id ? user.id : null, user && user.name ? clip(user.name, 80) : null);
    return id;
  } catch (e) { console.error('[omni-campaign-activity] log:', e && e.message); return null; } // eslint-disable-line no-console
}
// the rows of one campaign group (all its channel rows) or one campaign, oldest first
async function listFor(campaignIds) {
  if (!campaignIds || !campaignIds.length || !(await ensure())) return [];
  const rows = await q(`SELECT id, campaignId, CAST(at AS TEXT) AS at, kind, text, byName FROM "OmniCampaignActivity" WHERE campaignId IN (${campaignIds.map(() => '?').join(',')}) ORDER BY at ASC, id ASC LIMIT 400`, ...campaignIds);
  return rows.map((r) => ({ id: r.id, campaignId: r.campaignId, at: num(r.at), kind: r.kind, text: r.text, byName: r.byName || '' }));
}

module.exports = { ensure, log, listFor, DDL };

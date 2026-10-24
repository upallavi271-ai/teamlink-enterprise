#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// WHATSAPP TOKEN AUDIT (founder, 2026-10-23: "I made a Never-expire token yesterday and TeamLink still said expired").
// READ-ONLY. It never prints, logs or returns a token: every credential is shown as a short one-way fingerprint (sha256, 8 hex) and its length,
// so two places holding the SAME token show the same fingerprint and a stale one shows a different one.
//
//   node scripts/wa-token-audit.js                 what each number would really send with (no network)
//   node scripts/wa-token-audit.js --meta          also asks Meta about each distinct token (debug_token + the number itself): type, expiry,
//                                                  valid or not, scopes, which app; nothing is changed or sent
//   node scripts/wa-token-audit.js --db <file.db>  another database (default: the one in .env)
// It reads exactly what the sender reads (utils/waNumbers.js configOf, utils/whatsappCloud.js legacyConfig): there is no second reading path.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
if (val('--db')) process.env.DATABASE_URL = `file:${path.resolve(val('--db')).split(path.sep).join('/')}`;
process.chdir(BACK);

const prisma = require(path.join(BACK, 'src/db'));
const wa = require(path.join(BACK, 'src/utils/whatsappCloud'));
const WN = require(path.join(BACK, 'src/utils/waNumbers'));

const fp = (t) => (t ? `${crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8)} (${String(t).length} chars)` : '(none)');
const day = (s) => (s ? String(s).slice(0, 19).replace('T', ' ') : '-');
const wrapJson = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? Number(v) : v));

async function graph(base, ver, pathq, token) {
  try {
    const r = await fetch(`${base}/${ver}/${pathq}`, { headers: { authorization: `Bearer ${token}` } });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) { return { ok: false, status: 0, json: null, net: String(e.message).slice(0, 80) }; }
}
const metaSays = (r) => {
  if (r.net) return `network error: ${r.net}`;
  const e = r.json && r.json.error;
  return e ? `HTTP ${r.status} code ${e.code || '?'}${e.error_subcode ? `/${e.error_subcode}` : ''}: ${String(e.message || '').replace(/[A-Za-z0-9_-]{40,}/g, '•••').slice(0, 160)}` : `HTTP ${r.status}`;
};

(async () => {
  try {
    console.log(`Database: ${String(process.env.DATABASE_URL).replace(/^file:/, '')}`);
    console.log(`Graph: ${wa.GRAPH}/${wa.VERSION}`);

    // 1) environment overrides that could shadow what is saved (names only, never values)
    const envNames = Object.keys(process.env).filter((k) => /whats|^wa_|meta|graph|facebook|integration_secret/i.test(k));
    console.log('\n[1] Environment variables that could matter (names only):');
    console.log(envNames.length ? envNames.map((k) => `  ${k}: ${process.env[k] ? 'set' : 'empty'}`).join('\n') : '  none');
    console.log('  Note: the sender reads NO token from the environment. Only INTEGRATION_SECRET_KEY (to decrypt) and WHATSAPP_GRAPH_VERSION are used.');
    const envFiles = ['.env', '.env.local', '.env.production'].map((f) => path.join(BACK, f)).filter((f) => fs.existsSync(f));
    console.log(`  .env files here: ${envFiles.map((f) => path.basename(f)).join(', ') || 'none'}`);

    // 2) every place a token can live
    const integ = await prisma.integration.findUnique({ where: { id: 'whatsapp' } });
    const legacy = await wa.legacyConfig();
    console.log('\n[2] The WhatsApp Business form (Administration > Integrations > Configure):');
    console.log(`  row: ${integ ? `enabled=${!!integ.enabled} connected=${!!integ.connected} state=${integ.state || '-'} updated ${day(integ.updatedAt)}` : 'no row'}`);
    console.log(`  Phone number ID: ${legacy.phoneId || '(empty)'}   token: ${fp(legacy.token)}   usable: ${legacy.configured ? 'yes' : `no - ${legacy.reason}`}`);

    const rows = await WN.listRows();
    console.log(`\n[3] The numbers list (${rows.length} number${rows.length === 1 ? '' : 's'}):`);
    const tokens = new Map(); // fingerprint -> { token, users: [] }
    const keep = (t, who) => { if (!t) return; const k = fp(t); if (!tokens.has(k)) tokens.set(k, { token: t, who: [] }); tokens.get(k).who.push(who); };
    const perNumber = [];
    for (const r of rows) {
      const cfg = await WN.configOf(r.id);
      const sec = r.credSource === 'legacy' ? null : await prisma.appSetting.findUnique({ where: { key: `wa.num.sec.${r.id}` } });
      const used = r.credSource === 'legacy' ? 'the Configure form' : (r.tokenMode === 'shared' ? 'the shared token (Configure form)' : "this number's own saved token");
      console.log(`  - ${r.label} ${r.displayNumber}${r.isDefault ? '  [default]' : ''}${r.active ? '' : '  [switched off]'}`);
      console.log(`      Phone number ID ${r.phoneNumberId}, account ${r.wabaId || '-'}`);
      console.log(`      token source: ${used}; effective token ${fp(cfg && cfg.token)}; usable: ${cfg && cfg.configured ? 'yes' : `no - ${cfg ? cfg.reason : 'not found'}`}`);
      console.log(`      own secret row updated: ${sec ? day(sec.updatedAt) : '-'}; row updated ${day(r.updatedAt)}; last check ${day(r.checkedAt)}: ${r.statusCode} - ${String(r.statusText || '').replace(/[A-Za-z0-9_-]{40,}/g, '•••').slice(0, 120)}`);
      keep(cfg && cfg.token, r.label);
      perNumber.push({ r, cfg });
    }
    const same = [...tokens.entries()].filter(([, v]) => v.who.length > 1);
    console.log(`\n  Distinct tokens in use: ${tokens.size}${same.length ? `   (shared by: ${same.map(([k, v]) => `${k.split(' ')[0]} -> ${v.who.join(' + ')}`).join('; ')})` : ''}`);

    // 3) the test path and the send path use the same reading
    console.log('\n[4] Does "Test connection" read the same credential as a real send?');
    for (const { r, cfg } of perNumber) {
      const testCfg = await wa.whatsappConfig({ numberId: r.id });
      const route = await WN.resolveSender({ requestedNumberId: r.id, automatic: true });
      const sendCfg = route && route.cfg;
      const a = fp(testCfg && testCfg.token); const b = fp(sendCfg && sendCfg.token); const c = fp(cfg && cfg.token);
      const ok = a === b && b === c;
      console.log(`  ${ok ? 'SAME' : 'DIFFERENT'}  ${r.label}: test ${a.split(' ')[0]}, send ${sendCfg ? b.split(' ')[0] : `(${route && route.error ? 'refused: ' + route.error.slice(0, 70) : 'no route'})`}, configured ${c.split(' ')[0]}`);
    }

    // 4) what Meta says
    if (argv.includes('--meta')) {
      console.log('\n[5] What Meta says about each distinct token (read-only):');
      for (const [k, v] of tokens) {
        const dbg = await graph(wa.GRAPH, wa.VERSION, `debug_token?input_token=${encodeURIComponent(v.token)}`, v.token);
        const d = dbg.json && dbg.json.data;
        console.log(`  token ${k.split(' ')[0]} (${v.who.join(' + ')}):`);
        if (d) {
          const exp = d.expires_at === 0 ? 'NEVER expires' : `expires ${new Date(d.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
          console.log(`      type ${d.type || '?'}${d.application ? `, app "${d.application}" (${d.app_id})` : ''}, valid ${!!d.is_valid}, ${exp}${d.data_access_expires_at ? `, data access until ${new Date(d.data_access_expires_at * 1000).toISOString().slice(0, 10)}` : ''}`);
          console.log(`      scopes: ${(d.scopes || []).join(', ') || '-'}`);
          if (d.error && d.error.message) console.log(`      Meta note: ${String(d.error.message).replace(/[A-Za-z0-9_-]{40,}/g, '•••').slice(0, 160)}`);
        } else console.log(`      Meta did not describe it: ${metaSays(dbg)}`);
        for (const { r, cfg } of perNumber.filter((x) => fp(x.cfg && x.cfg.token) === k)) {
          const ph = await graph(wa.GRAPH, wa.VERSION, `${encodeURIComponent(r.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, cfg.token);
          console.log(`      ${r.label}: ${ph.ok && ph.json ? `Meta accepts it for this number (${ph.json.display_phone_number || '?'}, ${ph.json.verified_name || '?'})` : `Meta refuses it for this number - ${metaSays(ph)}`}`);
        }
      }
    } else console.log('\n(Run again with --meta to ask Meta about each token.)');
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).slice(0, 400)); process.exit(1); });

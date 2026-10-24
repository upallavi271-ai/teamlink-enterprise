#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHICH TOKEN DOES WHATSAPP REALLY USE? (founder, 2026-10-23). SANDBOX ONLY, fake tokens only, nothing is sent to Meta.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/wa-token-source-test.js
// Proves: the latest SAVED token is what the sender reads (no stale cache, in another process too); a number on "the shared token" follows the
// Configure form at once; a number on its OWN token does not (and is named when the form is saved); "Test connection" and "send" read the same
// credential; a saved token is never in any response; the red chip of an old token is cleared by a re-check / an accepted message.
// ---------------------------------------------------------------------------
const path = require('path');
const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX; process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const WN = require(path.join(BACK, 'src/utils/waNumbers'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const wa = require(path.join(BACK, 'src/utils/whatsappCloud'));
const RUN = Date.now().toString(36);
const mkTok = (tag) => `ZZTESTTOKEN-${tag}-${RUN}-${'x'.repeat(40)}`;
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.4.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j, text: t };
}
(async () => {
  const made = { users: [], numbers: [] };
  let savedIntegration = null;
  try {
    const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST WT admin ${RUN}`, email: `zz-wt-${RUN}@example.test`, username: `zz-wt-${RUN}@example.test`, role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: true, status: 'Active' } });
    made.users.push(u.id);
    const tok = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    savedIntegration = await prisma.integration.findUnique({ where: { id: 'whatsapp' } });

    // the WhatsApp Business form as the screen would post it: every non-secret value as it is, the secret as typed
    const formWith = async (secret) => {
      const g = await call('GET', '/api/admin/integrations', tok);
      const ch = (g.body.channels || []).find((c) => c.id === 'whatsapp');
      const values = { ...ch.values }; (ch.secretFields || []).forEach((l) => { values[l] = ''; });
      values['Permanent access token'] = secret;
      if (!values['Phone number ID']) values['Phone number ID'] = '999000111222333';
      return values;
    };

    // two test numbers: one on its OWN token, one on the SHARED token
    const phone = (n) => `9${String(Date.now()).slice(-8)}${n}`.slice(0, 15);
    const tokA = mkTok('A');
    const own = await call('POST', '/api/wa-numbers', tok, { label: `ZZTEST own ${RUN}`, displayNumber: `+9198${String(Date.now()).slice(-8)}`, phoneNumberId: phone(1).padEnd(15, '1'), tokenMode: 'own', token: tokA, check: false });
    check('S0 a test number with its own token is added', own.status === 200 || own.status === 201, [own.status, own.body && own.body.error]);
    const ownId = own.body && own.body.id; if (ownId) made.numbers.push(ownId);

    // the shared one needs a shared (Configure form) token first
    const L1 = mkTok('L1');
    let cf = await call('PUT', '/api/admin/integrations/whatsapp/configure', tok, { values: await formWith(L1) });
    check('S1 saving the Configure form answers with what Meta/the numbers said (not just "connected")', cf.status === 200 && cf.body && cf.body.waCheck && typeof cf.body.waCheck.summary === 'string', [cf.status, cf.body && cf.body.error]);
    const sh = await call('POST', '/api/wa-numbers', tok, { label: `ZZTEST shared ${RUN}`, displayNumber: `+9197${String(Date.now()).slice(-8)}`, phoneNumberId: phone(2).padEnd(15, '2'), tokenMode: 'shared', check: false });
    check('S2 a test number on the shared token is added', sh.status === 200 || sh.status === 201, [sh.status, sh.body && sh.body.error]);
    const shId = sh.body && sh.body.id; if (shId) made.numbers.push(shId);
    const tag = (t) => WN.tagOf(t);
    const rowOf = async (id) => ((await call('GET', '/api/wa-numbers', tok)).body.numbers || []).find((n) => n.id === id) || {};

    // --- the latest saved token is the one read, at once, in the API process -----------------------------------------------------
    let r = await rowOf(ownId);
    check('T1 own token: the list shows the tag of the token that was saved', r.tokenTag === tag(tokA) && /own token/.test(r.tokenSource || ''), [r.tokenTag, tag(tokA), r.tokenSource]);
    const tokB = mkTok('B');
    const up = await call('PUT', `/api/wa-numbers/${ownId}`, tok, { token: tokB, check: false });
    r = await rowOf(ownId);
    check('T2 a NEW own token is in use at once (no wait, no restart)', up.status === 200 && r.tokenTag === tag(tokB), [up.status, r.tokenTag, tag(tokB)]);
    r = await rowOf(shId);
    check('T3 a number on the shared token reads the Configure form token', r.tokenTag === tag(L1) && /shared/i.test(r.tokenSource || ''), [r.tokenTag, tag(L1), r.tokenSource]);
    const L2 = mkTok('L2');
    cf = await call('PUT', '/api/admin/integrations/whatsapp/configure', tok, { values: await formWith(L2) });
    r = await rowOf(shId);
    check('T4 after saving a newer token in the Configure form the shared number follows it at once', cf.status === 200 && r.tokenTag === tag(L2), [cf.status, r.tokenTag, tag(L2)]);
    r = await rowOf(ownId);
    check('T5 a number on its OWN token does NOT follow the form (it keeps B) ...', r.tokenTag === tag(tokB), [r.tokenTag, tag(tokB)]);
    check('T6 ... and the Configure answer NAMES it, so nobody is left on an old token unknowingly', /keep their own token/.test(cf.body.waCheck.summary) && cf.body.waCheck.summary.includes(`ZZTEST own ${RUN}`), cf.body.waCheck.summary);

    // --- "Test connection" and "send" read the same credential -----------------------------------------------------------------------
    WN.bust();
    for (const [lbl, id, want] of [['own', ownId, tokB], ['shared', shId, L2]]) {
      const testCfg = await wa.whatsappConfig({ numberId: id });
      const route = await WN.resolveSender({ requestedNumberId: id, automatic: true });
      check(`U-${lbl} the test path, the send path and the saved token are ONE credential`, route.ok && tag(testCfg.token) === tag(route.cfg.token) && tag(route.cfg.token) === tag(want), [tag(testCfg.token), route.cfg && tag(route.cfg.token), tag(want)]);
    }
    const stored = await prisma.appSetting.findUnique({ where: { key: `wa.num.sec.${ownId}` } });
    check('V1 the saved token is stored encrypted, never as the typed text', !!stored && !stored.value.includes(tokB) && /enc:v1:/.test(stored.value), (stored && stored.value || '').slice(0, 60));

    // --- no response ever carries a token -----------------------------------------------------------------------------------------------
    const bag = [JSON.stringify(cf.body), (await call('GET', '/api/wa-numbers', tok)).text, (await call('GET', '/api/admin/integrations', tok)).text, JSON.stringify(up.body), JSON.stringify(own.body)].join('\n');
    check('W1 no full token (own, shared, old) appears in any response', ![tokA, tokB, L1, L2].some((t) => bag.includes(t)), null);

    // --- the old red chip -------------------------------------------------------------------------------------------------------------------
    await prisma.$executeRawUnsafe('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ? WHERE "id" = ?', 'disconnected', 'Meta did not accept the connection. (an old token)', shId);
    WN.bust();
    cf = await call('PUT', '/api/admin/integrations/whatsapp/configure', tok, { values: await formWith(mkTok('L3')) });
    r = await rowOf(shId);
    check('X1 saving a new token re-checks the numbers that read it: the old red chip is gone', r.status && r.status.code !== 'disconnected', r.status);
    await prisma.$executeRawUnsafe('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ? WHERE "id" = ?', 'disconnected', 'old token', ownId);
    await prisma.$executeRawUnsafe('UPDATE "WaNumber" SET "statusCode" = ?, "statusText" = ? WHERE "id" = ?', 'verification_required', 'not verified', shId);
    WN.bust();
    await WN.noteSendOk(ownId); await WN.noteSendOk(shId);
    const a = await WN.getRowFresh(ownId); const b = await WN.getRowFresh(shId);
    check('X2 a message Meta accepted turns a stale "Disconnected" chip green ...', a.statusCode === 'connected', a.statusCode);
    check('X3 ... but never hides a real "verification required"', b.statusCode === 'verification_required', b.statusCode);
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    try {
      for (const id of made.numbers) { await prisma.$executeRawUnsafe('DELETE FROM "WaNumberAccess" WHERE "numberId" = ?', id).catch(() => {}); await prisma.$executeRawUnsafe('DELETE FROM "WaNumber" WHERE "id" = ?', id).catch(() => {}); await prisma.appSetting.delete({ where: { key: `wa.num.sec.${id}` } }).catch(() => {}); }
      await prisma.$executeRawUnsafe('DELETE FROM "WaNumber" WHERE "label" LIKE ?', `ZZTEST %`).catch(() => {});
      if (savedIntegration) await prisma.integration.update({ where: { id: 'whatsapp' }, data: { values: savedIntegration.values, state: savedIntegration.state, enabled: savedIntegration.enabled, connected: savedIntegration.connected, error: savedIntegration.error } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { actorName: { contains: 'ZZTEST WT' } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { OR: [{ id: { in: made.users } }, { email: { contains: 'zz-wt-' } }] } }).catch(() => {});
      WN.bust();
    } catch (e) { console.log('cleanup problem:', e.message.slice(0, 160)); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

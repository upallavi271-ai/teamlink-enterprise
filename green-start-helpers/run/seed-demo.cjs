// TeamLink helper (NOT part of the Green Start zip). The zip's seed looks up a plan called "professional" that its own migrations retire
// (known bug, also found on the 14 Oct copy). We do NOT edit the seed: we put a temporary stand-in plan row in OUR database, run the
// product's own seed (`npx prisma db seed`), then point the demo organisation at the real "premium" plan and remove the stand-in.
const path = require('path');
const { execSync } = require('child_process');
const api = path.resolve(__dirname, '..', 'gs-api');
const { Client } = require(path.join(api, 'node_modules', 'pg'));
const env = require('fs').readFileSync(path.join(api, '.env'), 'utf8');
const url = /^DATABASE_URL="?([^"\r\n]+)"?/m.exec(env)[1].replace(/\?schema=.*$/, '');
(async () => {
  const c = new Client({ connectionString: url }); await c.connect();
  const has = (await c.query(`SELECT 1 FROM plans WHERE key='professional'`)).rowCount;
  if (!has) {
    await c.query(`INSERT INTO plans (id, key, name, tier, "priceMinor", currency, "includedCredits", features, "isActive")
      SELECT gen_random_uuid(), 'professional', 'Professional (seed stand-in)', tier, "priceMinor", currency, "includedCredits", features, false FROM plans WHERE key='premium'`);
  }
  console.log('stand-in plan ready; running the product seed...');
  try { execSync('npx prisma db seed', { cwd: api, stdio: 'inherit' }); }
  finally {
    await c.query(`UPDATE subscriptions SET "planId"=(SELECT id FROM plans WHERE key='premium') WHERE "planId"=(SELECT id FROM plans WHERE key='professional')`);
    if (!has) await c.query(`DELETE FROM plans WHERE key='professional'`);
    await c.end();
  }
  console.log('done');
})().catch((e) => { console.error(e.message); process.exit(1); });

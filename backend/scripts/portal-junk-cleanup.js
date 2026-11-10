#!/usr/bin/env node
// Clean-up of the junk candidates a bulk import saved (name with NO letter at all: "7.56947364E9", "...."). Names in any alphabet are never matched.
//   cd backend && node scripts/portal-junk-cleanup.js --dump=/root/teamlink-backups/junk-candidates.json      (read only: saves the full rows = the backup)
//   cd backend && node scripts/portal-junk-cleanup.js --delete --backup=<that file> --expect=<count shown by the dump>
// Asked through the RUNNING portal (its database takes one connection). Delete refuses unless the backup file exists with that many rows.
const path = require('path');
const fs = require('fs');

require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const has = (k) => process.argv.includes(`--${k}`);

(async () => {
  const { portalFetch } = require('../src/utils/jobPortalBridge'); // eslint-disable-line global-require
  const dumpFile = arg('dump');
  if (dumpFile) {
    const out = await portalFetch('/integrations/teamlink/junk-candidates/dump', { method: 'GET', timeoutMs: 60000 });
    fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
    fs.writeFileSync(dumpFile, JSON.stringify(out, null, 1));
    console.log(`Saved ${out.count} rows to ${dumpFile}`);
    out.rows.forEach((r) => console.log(`  ${r.candidate.id}  name="${r.candidate.name}"  email="${r.candidate.email || ''}"  phone=${r.candidate.phone || '-'}  made=${String(r.candidate.created_at).slice(0, 16)}  login=${r.login ? 'yes, never signed in' : 'none'}`));
    return;
  }
  if (has('delete')) {
    const file = arg('backup'); const expect = Number(arg('expect'));
    if (!file || !fs.existsSync(file)) { console.log('Give --backup=<the file saved by --dump>. Nothing was done.'); process.exit(2); }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = (saved.rows || []).map((r) => r.candidate.id);
    if (!ids.length || ids.length !== expect || saved.count !== expect) { console.log(`The backup has ${ids.length} rows, --expect says ${expect}. Nothing was done.`); process.exit(2); }
    const out = await portalFetch('/integrations/teamlink/junk-candidates/delete', { method: 'POST', body: { ids, expect }, timeoutMs: 120000 });
    console.log(`Deleted ${out.deleted} junk candidates (and their never-used logins).`);
    return;
  }
  console.log('Use --dump=<file> first, then --delete --backup=<file> --expect=<n>.');
})().catch((e) => { console.log(`It did not finish: ${String((e && e.message) || e).slice(0, 300)}`); process.exit(1); });

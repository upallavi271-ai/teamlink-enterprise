#!/usr/bin/env node
// READ ONLY. Candidates in the Job Portal whose NAME is only digits / dots / "e+" (a phone or an Excel date read as a name) or has fewer than two
// letters - what a bulk import used to save as "7.56947364E9". Asked through the RUNNING portal (the live portal's database takes one connection).
//   cd backend && node scripts/portal-junk-candidates.js
const path = require('path');

require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });

const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '-');

(async () => {
  const { portalFetch } = require('../src/utils/jobPortalBridge'); // eslint-disable-line global-require
  let out;
  try {
    out = await portalFetch('/integrations/teamlink/junk-candidates', { method: 'GET', timeoutMs: 30000 });
  } catch (e) {
    const why = String((e && e.message) || e);
    console.log(/404/.test(why) ? 'The Job Portal has not loaded the new check yet (it restarts by itself after the deploy). Try again in 2 minutes.' : `The Job Portal did not answer: ${why}`);
    process.exit(1);
  }
  console.log(`Candidates in the portal: ${out.total}`);
  console.log(`With a junk name (digits / symbols / under two letters): ${out.junk}`);
  console.log('\nBy import (the batch that saved them):');
  (out.byImport || []).forEach((b) => console.log(`  ${b.import_id}   ${b.n} rows   first saved ${when(b.first_at)}`));
  console.log('\nThe 25 newest:');
  (out.examples || []).forEach((k) => console.log(`  ${k.id}  name="${k.name}"  email="${k.email || ''}"  phone=${k.phone || '-'}  made=${when(k.created_at)}  login=${k.has_login ? 'yes' : 'no'}  import=${k.import_id || '-'}`));
})();

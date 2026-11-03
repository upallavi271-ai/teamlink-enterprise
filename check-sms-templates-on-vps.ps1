# ---------------------------------------------------------------------------
# SMS TEMPLATES ON THE LIVE SITE (founder 2026-11-03) - CHECK ONLY, changes nothing.
#
#   .\check-sms-templates-on-vps.ps1
#
# Shows the last "SMS templates with Omni-Channel" copy run (utils/smsOmniSync.js) and the SMS Message templates TeamLink has:
# name, DLT Template ID, sender, active, made in TeamLink or Omni-Channel. No password, token or message text of a person is printed.
# Copy the lines back to Claude.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@72.61.233.104'
$js = @'
const prisma = require('./src/db');
(async () => {
  const last = await prisma.appSetting.findUnique({ where: { key: 'sms.omniSync' } }).catch(() => null);
  const r = last ? JSON.parse(last.value) : null;
  console.log('== Last copy run with Omni-Channel:', r ? `${r.at} (${r.why}) ${r.ok ? 'OK' : 'NOT OK'}: ${r.words}` : 'none yet (the first one runs 2 minutes after the server starts)');
  const rows = await prisma.messageTemplate.findMany({ where: { channel: 'SMS' }, orderBy: [{ purpose: 'asc' }, { name: 'asc' }] });
  const withId = rows.filter((t) => t.dltTemplateId);
  console.log(`== SMS templates in TeamLink: ${rows.length} (with a DLT Template ID: ${withId.length}, from Omni-Channel: ${rows.filter((t) => t.purpose === 'CUSTOM_FROM_OMNI_CHANNEL').length})`);
  for (const t of rows) console.log(` - ${t.name} | DLT ${t.dltTemplateId || 'none'} | sender ${t.senderId || '(settings)'} | ${t.active ? 'active' : 'off'} | ${t.purpose === 'CUSTOM_FROM_OMNI_CHANNEL' ? 'from Omni-Channel' : 'TeamLink'}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('CHECK FAILED:', e.message); process.exit(1); });
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
ssh $VpsHost "cd /opt/teamlink-enterprise/backend && [ -f src/utils/smsOmniSync.js ] || { echo 'The SMS template copy is not deployed yet: run .\deploy-local-to-vps.ps1'; exit 1; }; echo $b64 | base64 -d > /tmp/tl-sms-check.js && cp /tmp/tl-sms-check.js ./.tl-sms-check.js && node ./.tl-sms-check.js; rc=`$?; rm -f ./.tl-sms-check.js /tmp/tl-sms-check.js; exit `$rc"
if ($LASTEXITCODE -ne 0) { throw 'The check did not finish (see the lines above).' }

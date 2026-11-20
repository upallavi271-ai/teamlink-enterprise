// Set a WhatsApp number up as a MARKETING number for the WhatsApp AI and read our website into its knowledge base.
//   node backend/scripts/omni-marketing-setup.js <numberId> <site> [<site> ...]
//   e.g. node scripts/omni-marketing-setup.js wan_mwoj4sob0096ffcae1 https://tmlink.in
// A chat on that number is answered from the promotion we sent and the website knowledge only (omniwa/agent.js askMarketing). Run again to refresh the website.
// Remove it again:  node scripts/omni-marketing-setup.js <numberId> --off
const Cfg = require('../src/omniwa/config');

(async () => {
  const [numberId, ...rest] = process.argv.slice(2);
  if (!numberId) { console.log('Usage: node scripts/omni-marketing-setup.js <numberId> <https://site> [...]   |   <numberId> --off'); process.exit(1); }
  if (rest.includes('--off')) {
    console.log('marketing mode off:', JSON.stringify(await Cfg.setMarketingNumber(numberId, false)));
    process.exit(0);
  }
  const urls = rest.filter((u) => /^https?:\/\//i.test(u));
  console.log('marketing mode on:', JSON.stringify(await Cfg.setMarketingNumber(numberId, true)));
  // the number's OWN instructions (what Bot Builder shows under "Own instructions"): the marketing ones, unless somebody already wrote their own
  const have = (await Cfg.profiles()).find((x) => x.numberId === numberId);
  if (!have || !have.systemPrompt) console.log('own instructions:', JSON.stringify(await Cfg.saveProfile({ name: 'omni-marketing-setup' }, numberId, { enabled: have ? have.enabled : true, systemPrompt: Cfg.MARKETING_PROMPT, fallbackMessage: have ? have.fallbackMessage : '' })));
  else console.log('own instructions: kept (already written)');
  if (urls.length) {
    const r = await Cfg.kbImportWebsite({ name: 'omni-marketing-setup' }, { urls, numberId, maxPages: 40 });
    console.log('website import:', JSON.stringify(r));
    const probe = await Cfg.kbSearch('digital marketing seo social media services', 3, numberId);
    console.log('probe "digital marketing seo social media services":', probe.map((p) => `${p.question} -> ${String(p.answer).slice(0, 80)}`));
  }
  process.exit(0);
})().catch((e) => { console.error(e && e.message); process.exit(1); });

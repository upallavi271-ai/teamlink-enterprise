// Omni-Channel WhatsApp AI: our website read into the knowledge base (omniwa/webKb.js).
//   node backend/test-fixtures/omniWebKb.test.js
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-')), 'copy.db'); // a throw-away copy of the sandbox database
fs.copyFileSync(path.join(__dirname, '..', 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const W = require('../src/omniwa/webKb');

const HOME = `<html><head><title>TeamLink Consultants | Recruitment</title><style>.x{color:red}</style></head><body>
<nav><a href="/services/hrms.html">HRMS</a></nav>
<h1>Recruitment partner</h1><p>TeamLink delivers specialised recruitment across IT, Healthcare, Manufacturing and Education, with a dedicated practice for each.</p>
<h2>Menu</h2><p>Go</p>
<footer><a href="/services/hrms.html">HRMS</a> <a href="/services/hrms.html#pricing">again</a> <a href="/index.html">home</a> <a href="/te/index.html">Telugu</a>
<a href="https://other.example/x">other site</a> <a href="/assets/logo.png">logo</a> <a href="mailto:a@b.c">mail</a> <a href="tel:123">call</a></footer>
</body></html>`;
const HRMS = `<html><body><h1>HRMS</h1><p>The HRMS keeps employee information, attendance, leave management and payroll related processes in one place for your organisation.</p></body></html>`;

// the links: same site only, no files, no Telugu / Hindi copies, no repeats, /index.html is the home page
const links = W.linksOf(HOME, 'https://tmlink.in/');
assert.deepEqual(links.sort(), ['https://tmlink.in/', 'https://tmlink.in/services/hrms.html'].sort());

// a page becomes sections: a heading with its words; a menu word is not knowledge; scripts and navigation never are
const sections = W.sectionsOf(HOME, 'https://tmlink.in/');
assert.equal(sections.length, 1);
assert.match(sections[0].question, /^Home: Recruitment partner/);
assert.match(sections[0].answer, /specialised recruitment across IT, Healthcare/);
assert.match(sections[0].answer, /\(Page: https:\/\/tmlink\.in\/\)$/);
assert.ok(!/color:red|Telugu|HRMS\b.*Go/.test(sections[0].answer));

(async () => {
  const pages = { 'https://tmlink.in/': HOME, 'https://tmlink.in/services/hrms.html': HRMS };
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(url);
    const html = pages[url];
    return html
      ? { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => html }
      : { ok: false, headers: { get: () => 'text/html' }, text: async () => '' };
  };
  const r = await W.crawl(['https://tmlink.in/'], { maxPages: 10, fetchFn });
  assert.deepEqual(r.pages, ['https://tmlink.in/', 'https://tmlink.in/services/hrms.html']);
  assert.equal(r.failed.length, 0);
  assert.equal(r.entries.length, 2);
  assert.ok(r.entries.some((e) => /^Hrms: HRMS/.test(e.question) && /attendance, leave management/.test(e.answer)), JSON.stringify(r.entries));
  assert.equal(new Set(seen).size, seen.length, 'no page is fetched twice');

  // a page limit stops the walk; a failing page is reported, not fatal
  const one = await W.crawl(['https://tmlink.in/'], { maxPages: 1, fetchFn });
  assert.equal(one.pages.length, 1);
  const bad = await W.crawl(['https://tmlink.in/missing.html'], { maxPages: 3, fetchFn });
  assert.deepEqual(bad.failed, ['https://tmlink.in/missing.html']);
  // 2026-11-27: what the site publishes about reaching the business and about itself; nothing from running text, no half numbers
  const C = W.contactOf('<a href="tel:+91%2098765%2043210">call</a><a href="tel:123">x</a><a href="mailto:Hello@Biz.in?subject=Hi">mail</a><a href="mailto:a@b.c">x</a><address>Plot 12, Road No. 3,<br>Banjara Hills, Hyderabad 500034 <a href="tel:+919876543210">98765 43210</a></address><p>Ring 90000 00000 today</p><script type="application/ld+json">{"@type":"LocalBusiness","telephone":"040 1234 5678","address":{"streetAddress":"5 Park Street","addressLocality":"Pune","postalCode":"411001"}}</script>');
  assert.deepEqual(C.phones, ['+91 98765 43210', '040 1234 5678']);
  assert.deepEqual(C.emails, ['hello@biz.in']);
  assert.deepEqual(C.addresses, ['Plot 12, Road No. 3, Banjara Hills, Hyderabad 500034', '5 Park Street, Pune, 411001']);
  const moved = async (url) => {
    const to = { 'https://biz.test/': 'https://www.biz.test/', 'https://away.test/': 'https://somewhere-else.test/' }[url] || url;
    const html = to === 'https://www.biz.test/' ? '<html><head><meta name="description" content="Biz Clinic is a family dental clinic in Pune, open to adults and children."></head><body><h1>Biz Clinic</h1><p>We clean, repair and straighten teeth for families, with appointments on every working day.</p><a href="https://www.biz.test/services">Services</a><a href="/login">login</a><footer><a href="tel:+919876543210">Call</a></footer></body></html>'
      : '<html><body><h1>Services</h1><p>Cleaning, fillings, root canal treatment, braces and dentures are all done at our own clinic.</p></body></html>';
    return { ok: true, url: to, headers: { get: () => 'text/html' }, text: async () => html };
  };
  const w = await W.crawl(['https://biz.test/'], { fetchFn: moved });
  assert.deepEqual(w.pages, ['https://www.biz.test/', 'https://www.biz.test/services'], 'a move to www is followed, the login page is not read');
  assert.equal(w.entries[0].question, 'Contact details: phone number, email and address'); assert.match(w.entries[0].answer, /^Phone: \+919876543210\. \(Page: https:\/\/www\.biz\.test\/\)$/);
  assert.equal(w.entries[1].question, 'Home: about us'); assert.match(w.entries[1].answer, /family dental clinic in Pune/);
  assert.deepEqual((await W.crawl(['https://away.test/'], { fetchFn: moved })).failed, ['https://away.test/'], 'a move to another site is not read');
  // inside addresses are never opened (the real fetch with its guard)
  for (const bad2 of ['http://127.0.0.1:4000/', 'http://localhost/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/']) assert.deepEqual((await W.crawl([bad2])).pages, [], bad2);

  // the screen's "Read website": the entries are saved as website knowledge, the same site read again replaces them, and the assistant answers from them
  const Cfg = require('../src/omniwa/config'); const user = { id: 'u-admin', name: 'Test Admin' };
  assert.equal((await Cfg.kbImportWebsite(user, { urls: 'not a site' })).status, 400);
  assert.match((await Cfg.kbImportWebsite(user, { urls: 'http://127.0.0.1/' })).error, /inside this network|web address/);
  const before = (await Cfg.kbList()).length;
  const one1 = await Cfg.kbImportWebsite(user, { urls: 'biz.test', fetchFn: moved }); assert.ok(one1.ok && one1.pages === 2 && one1.saved >= 3 && one1.failed === 0, JSON.stringify(one1));
  const two = await Cfg.kbImportWebsite(user, { urls: 'biz.test', fetchFn: moved }); assert.equal((await Cfg.kbList()).length, before + two.saved, 'reading again replaces, never doubles');
  const mine = (await Cfg.kbList()).filter((e) => e.updatedByName === 'Website import: biz.test'); assert.ok(mine.length === two.saved && mine.every((e) => e.category === 'website' && e.active));
  const A = require('../src/omniwa/assist'); const entries = mine.map((e) => ({ id: e.id, question: e.question, answer: e.answer, category: e.category, confirmedAt: null }));
  const said = await A.answer('what is your phone number?', { entries, settingsNow: { businessName: 'Biz Clinic' } });
  assert.ok(said.kind === 'answer' && /\+919876543210/.test(said.text), JSON.stringify(said));
  const written = await A.answer('what is your phone number?', { entries: [...entries, { id: 'c1', question: 'Contact', answer: 'Call 020 5555 6666.', category: 'contact', confirmedAt: null }], settingsNow: { businessName: 'Biz Clinic' } });
  assert.ok(/020 5555 6666/.test(written.text) && !/9876543210/.test(written.text), 'a contact entry a person wrote comes first');
  const priced = await A.answer('how much do braces cost?', { entries, settingsNow: { businessName: 'Biz Clinic' } }); assert.ok(priced.kind === 'none' && priced.noPrice, 'a price is still never quoted from the website');

  console.log('omniWebKb: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

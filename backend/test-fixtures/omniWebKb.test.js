// Omni-Channel WhatsApp AI: our website read into the knowledge base (omniwa/webKb.js).
//   node backend/test-fixtures/omniWebKb.test.js
const assert = require('node:assert/strict');
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
  console.log('omniWebKb: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

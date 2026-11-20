// Omni-Channel WhatsApp AI, marketing numbers: what the reply may say about OUR prices (omniwa/guard.js marketingProblem).
//   node backend/test-fixtures/omniMarketingGuard.test.js
const assert = require('node:assert/strict');
const G = require('../src/omniwa/guard');

const facts = 'TeamLink offers SEO, social media, lead generation and website promotion. Quick answer: packages depend on the goals. A starter plan is Rs 5,000 per month.';

// ordinary marketing words are fine, including "package" and "per month"
assert.equal(G.marketingProblem('Our packages depend on your goals. Which service do you need: SEO or social media?', facts), null);
assert.equal(G.marketingProblem('SEO helps your site rank higher, so you get more visitors every month.', facts), null);
// a price that the website states may be repeated
assert.equal(G.marketingProblem('The starter plan is Rs 5,000 per month.', facts), null);
// a price, a discount or a guarantee that is NOT in the facts was invented
assert.match(G.marketingProblem('Our SEO costs Rs 25,000 per month.', facts), /not in the promotion or the website/);
assert.match(G.marketingProblem('Get 40% off if you start today.', facts), /not in the promotion or the website/);
assert.match(G.marketingProblem('We guarantee first page rankings in 30 days.', facts), /guarantee/);
assert.equal(G.marketingProblem('', facts), null);
console.log('omniMarketingGuard: all passed');

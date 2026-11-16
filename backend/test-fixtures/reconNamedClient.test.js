// Rung 3: a narration that names the client (cash deposit included) settles automatically even when the amount is not exact.
//   node backend/test-fixtures/reconNamedClient.test.js
const assert = require('node:assert/strict');
const RM = require('../src/utils/reconMatch');

const client = { id: 'c1', name: 'Sanjivani University' };
const inv = (id, n, d, amount, extra = {}) => ({
  id, invoiceNumber: n, clientId: 'c1', client, invoiceDate: d, dueDate: d, amount, gst: 0, tds: 0, receivedAmount: 0, status: 'Pending', ...extra,
});
const ctx = (invoices, payments = []) => ({ clients: [client], clientAliases: [], rules: [], invoices, payments, expenses: [] });
const txn = (amount, d = 'CAM/6190/CASH DEP-SANJIVANI UNIVERSITY/10-10-26') => ({ type: 'Credit', amount, description: d, reference: '' });

// 1500 against 1000 + 2000: oldest first, 1000 then 500 (Partially Paid)
let r = RM.decideCredit(txn(1500), ctx([inv('b', 'INV-B', '2026-09-01', 2000), inv('a', 'INV-A', '2026-08-01', 1000)]));
assert.equal(r.confidence, 'auto'); assert.equal(r.action.type, 'settle');
assert.deepEqual(r.action.parts, [{ invoiceId: 'a', amount: 1000 }, { invoiceId: 'b', amount: 500 }]);
// more than they owe: still auto, the rest unallocated later
r = RM.decideCredit(txn(5000), ctx([inv('a', 'INV-A', '2026-08-01', 1000)]));
assert.equal(r.confidence, 'auto'); assert.deepEqual(r.action.parts, [{ invoiceId: 'a', amount: 1000 }]);
// exact fit unchanged (one invoice of exactly this amount)
r = RM.decideCredit(txn(1000), ctx([inv('a', 'INV-A', '2026-08-01', 1000), inv('b', 'INV-B', '2026-09-01', 2000)]));
assert.equal(r.confidence, 'auto'); assert.equal(r.action.parts[0].invoiceId, 'a');
// two invoices of exactly this amount: still a person's choice
r = RM.decideCredit(txn(1000), ctx([inv('a', 'INV-A', '2026-08-01', 1000), inv('b', 'INV-B', '2026-09-01', 1000)]));
assert.equal(r.confidence, 'review');
// no client name: nothing automatic
r = RM.decideCredit(txn(1500, 'CAM/6190/CASH DEP-Other/10-10-26'), ctx([inv('a', 'INV-A', '2026-08-01', 1000)]));
assert.notEqual(r.confidence, 'auto');
// Paid with no proof (received 1000, no receipt row): a 600 deposit is the first part of that proof
r = RM.decideCredit(txn(600), ctx([inv('a', 'INV-A', '2026-08-01', 1000, { receivedAmount: 1000, status: 'Paid' })]));
assert.equal(r.confidence, 'auto'); assert.equal(r.action.type, 'evidence'); assert.deepEqual(r.action.parts, [{ invoiceId: 'a', amount: 600 }]);
// more than the unproven money: stays for a person
r = RM.decideCredit(txn(1500), ctx([inv('a', 'INV-A', '2026-08-01', 1000, { receivedAmount: 1000, status: 'Paid' })]));
assert.equal(r.confidence, 'review');
console.log('reconNamedClient: all passed');
process.exit(0);

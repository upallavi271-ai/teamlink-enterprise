// Categorise manually -> Customer payment: the allocation rules (utils/clientPayment.js).
//   node backend/test-fixtures/clientPayment.test.js
const assert = require('node:assert/strict');
const { planClientPayment, defaultAllocation } = require('../src/utils/clientPayment');
const { invoiceAfterReceipt } = require('../src/utils/accounts');

const inv = (id, n, date, amount, extra = {}) => ({
  id, invoiceNumber: n, clientId: 'c1', invoiceDate: date, dueDate: date, amount, gst: 0, tds: 0, receivedAmount: 0, status: 'Pending', ...extra,
});
const A = inv('a', 'INV-1', '2026-08-01', 1000);
const B = inv('b', 'INV-2', '2026-09-01', 2000);
const C = inv('c', 'INV-3', '2026-10-01', 500, { tds: 50 }); // client deducts TDS: owes 450
const other = inv('x', 'INV-9', '2026-07-01', 100, { clientId: 'c2' });
const all = [B, A, C, other];
const ok = (r) => { assert.ok(!r.error, r.error); return r; };

// default fill: oldest first, up to each invoice's outstanding, rest unapplied; other client's invoice not in the list
let d = defaultAllocation([B, A, C], 2500);
assert.deepEqual(d.allocations, [{ invoiceId: 'a', amount: 1000 }, { invoiceId: 'b', amount: 1500 }]);
assert.equal(d.unapplied, 0);
d = defaultAllocation([A, B, C], 5000);
assert.equal(d.unapplied, 1550); // 1000 + 2000 + 450 net of TDS
assert.equal(d.allocations.find((x) => x.invoiceId === 'c').amount, 450);

// exact and partial payment
let r = ok(planClientPayment({ line: { amount: 1300 }, clientId: 'c1', allocations: [{ invoiceId: 'a', amount: 1000 }, { invoiceId: 'b', amount: 300 }], invoices: all }));
assert.equal(r.applied, 1300); assert.equal(r.unapplied, 0);
assert.equal(invoiceAfterReceipt(A, 1000, '2026-10-10').status, 'Paid');
assert.equal(invoiceAfterReceipt(B, 300, '2026-10-10').status, 'Partially Paid');

// unapplied stays on the line as advance
r = ok(planClientPayment({ line: { amount: 1300 }, clientId: 'c1', allocations: [{ invoiceId: 'a', amount: 1000 }], invoices: all }));
assert.equal(r.unapplied, 300);

// never more than the bank amount
assert.match(planClientPayment({ line: { amount: 1300 }, clientId: 'c1', allocations: [{ invoiceId: 'a', amount: 1000 }, { invoiceId: 'b', amount: 301 }], invoices: all }).error, /more than the bank amount/);
// float safety: 0.1 + 0.2 style splits add up exactly
ok(planClientPayment({ line: { amount: 0.3 }, clientId: 'c1', allocations: [{ invoiceId: 'a', amount: 0.1 }, { invoiceId: 'b', amount: 0.2 }], invoices: all }));
// more than the invoice owes (TDS-net outstanding 450 on INV-3)
assert.match(planClientPayment({ line: { amount: 1300 }, clientId: 'c1', allocations: [{ invoiceId: 'c', amount: 500 }], invoices: all }).error, /still outstanding/);
// TDS-net payment settles it
assert.equal(invoiceAfterReceipt(C, 450, '2026-10-10').status, 'Paid');
// another client's invoice, a cancelled one, a duplicate row, a negative, a missing client
assert.match(planClientPayment({ line: { amount: 100 }, clientId: 'c1', allocations: [{ invoiceId: 'x', amount: 100 }], invoices: all }).error, /different client/);
assert.match(planClientPayment({ line: { amount: 100 }, clientId: 'c1', allocations: [{ invoiceId: 'z', amount: 100, }], invoices: [inv('z', 'INV-C', '2026-01-01', 100, { status: 'Cancelled' })] }).error, /cancelled/);
assert.match(planClientPayment({ line: { amount: 200 }, clientId: 'c1', allocations: [{ invoiceId: 'a', amount: 100 }, { invoiceId: 'a', amount: 100 }], invoices: all }).error, /twice/);
assert.match(planClientPayment({ line: { amount: 200 }, clientId: 'c1', allocations: [{ invoiceId: 'a', amount: -5 }], invoices: all }).error, /negative/);
assert.match(planClientPayment({ line: { amount: 200 }, allocations: [], invoices: all }).error, /Choose the client/);
// a line already applied cannot be applied twice
assert.match(planClientPayment({ line: { amount: 1300 }, alreadyPosted: 1000, clientId: 'c1', allocations: [{ invoiceId: 'b', amount: 300 }], invoices: all }).error, /already applied/);
// date: required shape, never in the future
assert.match(planClientPayment({ line: { amount: 100 }, clientId: 'c1', date: '10/10/2026', allocations: [], invoices: all }).error, /date/);
assert.match(planClientPayment({ line: { amount: 100 }, clientId: 'c1', date: '2027-01-01', today: '2026-11-16', allocations: [], invoices: all }).error, /future/);
// all-advance (no invoice rows) is valid: the whole line is unapplied
r = ok(planClientPayment({ line: { amount: 1300 }, clientId: 'c1', date: '2026-10-10', today: '2026-11-16', allocations: [{ invoiceId: 'a', amount: 0 }], invoices: all }));
assert.equal(r.parts.length, 0); assert.equal(r.unapplied, 1300);

// Paid-but-no-proof: the line becomes the proof (no extra money), limited to what is marked received without proof
const P = inv('p', 'INV-P', '2026-06-01', 1000, { receivedAmount: 1000, status: 'Paid', unproven: 1000 });
r = ok(planClientPayment({ line: { amount: 600 }, clientId: 'c1', allocations: [{ invoiceId: 'p', amount: 600, proof: true }], invoices: [P] }));
assert.equal(r.parts[0].proof, true); assert.equal(r.unapplied, 0);
assert.match(planClientPayment({ line: { amount: 1500 }, clientId: 'c1', allocations: [{ invoiceId: 'p', amount: 1500, proof: true }], invoices: [P] }).error, /without proof/);
assert.match(planClientPayment({ line: { amount: 500 }, clientId: 'c1', allocations: [{ invoiceId: 'p', amount: 500 }], invoices: [P] }).error, /still outstanding|more than/);

console.log('clientPayment: all passed');
process.exit(0);

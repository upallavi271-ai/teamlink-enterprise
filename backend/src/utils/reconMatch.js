// ---------------------------------------------------------------------------
// RECON MATCH - the automatic matching ladder (Accounts reconciliation spec 5/6).
//
// PURE FUNCTIONS: nothing here reads or writes the database. routes/bank.js loads
// the context (loadContext) and applies the decision. A decision is one of
//   confidence 'auto'    safe to act on without a person (exact, unambiguous)
//   confidence 'review'  something is known but not certain: the line becomes
//                        "Needs Review" with the reason; NOTHING is written
//   confidence 'none'    nothing recognised
//
// THE LADDER (first rung that says something wins; a conflict anywhere = review):
//   1  exact transaction reference (UTR / cheque no / payment id) + exact amount
//   2  exact invoice number (or saved payment reference) + amount that fits
//   3  exact or normalised-exact vendor / client (name, saved alias) + exact amount
//      (+ date within the tolerance for bills)
//   4  narration / category suggestions - always review, never automatic
//
// NO FUZZY MATCHING. Names are normalised (case, spaces, punctuation, common
// company suffixes such as PVT LTD) and then must appear WHOLE, on word
// boundaries, in the narration. Amounts are compared in integer paise: a
// difference of one paisa is a different amount. There is no rupee tolerance.
//
// ALLOCATION POLICY (documented, see allocationPolicy()):
//   Oldest due first, whole invoices. A credit that names its invoice number goes
//   to that invoice. A credit that names only the client is applied automatically
//   ONLY when exactly one open invoice has a balance equal to the amount. Every
//   other case (several invoices, part payment, extra money) waits as Unallocated
//   for a person, with the oldest-due-first split pre-filled as a suggestion.
// ---------------------------------------------------------------------------
const toPaise = (n) => Math.round((Number(n) || 0) * 100);

const SUFFIX = /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INC|CO|COMPANY|CORP|CORPORATION|THE|INDIA|OPC)\b/g;
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
// "ABC Technologies Pvt. Ltd." -> "ABC TECHNOLOGIES"
const idKey = (s) => norm(s).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
const squash = (s) => norm(s).replace(/ /g, '');

// Whole-phrase, word-boundary containment of a normalised phrase in a normalised text.
function hasPhrase(textNorm, phraseNorm) {
  if (!phraseNorm) return false;
  return ` ${textNorm} `.indexOf(` ${phraseNorm} `) >= 0;
}

const NARR_NOISE = new Set(['NEFT', 'RTGS', 'IMPS', 'UPI', 'CR', 'DR', 'CHQ', 'CHEQUE', 'TRF', 'TRANSFER', 'PAYMENT', 'BY', 'TO', 'FROM', 'REF', 'UTR', 'NO']);

// ---- references ------------------------------------------------------------
// Pull the identifiers out of a narration: NEFT / RTGS UTRs, IMPS / UPI reference
// numbers and cheque numbers. Everything uppercased and alphanumeric only.
function extractRefs(narration, reference, externalId) {
  const out = new Set();
  const add = (v) => {
    const t = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (t.length >= 6 && /\d/.test(t) && !/^(.)\1+$/.test(t) && !/^0+$/.test(t)) out.add(t);
  };
  add(reference);
  add(externalId);
  const n = String(narration || '').toUpperCase();
  (n.match(/\b[A-Z]{4}[A-Z0-9]?\d{9,}\b/g) || []).forEach(add); // NEFT / RTGS UTR e.g. HDFCN52026..., SBIN... , RTGS
  (n.match(/\b\d{12}\b/g) || []).forEach(add); // IMPS / UPI RRN
  (n.match(/\b(?:CHQ|CHEQUE|CHQ\.?\s?NO|INSTRUMENT)\W*(?:NO\W*)?(\d{6,})\b/g) || []).forEach((m) => add((m.match(/\d{6,}/) || [])[0]));
  (n.match(/\bUTR\W*(?:NO\W*)?([A-Z0-9]{8,})\b/g) || []).forEach((m) => add(m.replace(/^UTR\W*(NO\W*)?/, '')));
  return [...out];
}

// ---- invoice numbers --------------------------------------------------------
// A pattern for one invoice number that tolerates different separators:
// TY26-073 matches "TY26-073", "TY26073", "TY26 073" but never "TY26-0731".
function numberPattern(invNo) {
  const groups = String(invNo || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!groups.length) return null;
  return new RegExp(`(?<![A-Z0-9])${groups.join('[^A-Z0-9]{0,2}')}(?![A-Z0-9])`);
}
const strongNumber = (invNo) => {
  const t = squash(invNo);
  return t.length >= 5 && /[A-Z]/.test(t) && /\d/.test(t);
};
const weakNumber = (invNo) => /^\d{4,}$/.test(squash(invNo));

// Invoices whose number is written in the narration (longest match wins when one
// number is the front part of another: TY26-073 inside TY26-073-1).
function invoicesNamed(narrationUpper, invoices) {
  const hits = [];
  invoices.forEach((inv) => {
    if (!inv.invoiceNumber) return;
    const strong = strongNumber(inv.invoiceNumber);
    if (!strong && !weakNumber(inv.invoiceNumber)) return;
    const re = numberPattern(inv.invoiceNumber);
    if (re && re.test(narrationUpper)) hits.push({ inv, strong });
  });
  return hits.filter((h) => !hits.some((o) => o !== h && squash(o.inv.invoiceNumber).length > squash(h.inv.invoiceNumber).length && squash(o.inv.invoiceNumber).startsWith(squash(h.inv.invoiceNumber))));
}

// ---- who is named ------------------------------------------------------------
// clients: [{ id, name, legalName }]; aliases: [{ clientId, alias }]; rules: BankRule rows.
function clientKeys(ctx) {
  if (ctx._clientKeys) return ctx._clientKeys;
  const keys = [];
  const push = (clientId, text, via) => {
    const k = idKey(text);
    if (k.length >= 5 || (k.includes(' ') && k.length >= 4)) keys.push({ clientId, key: k, via });
  };
  ctx.clients.forEach((c) => { push(c.id, c.name, 'name'); if (c.legalName) push(c.id, c.legalName, 'legal name'); });
  (ctx.clientAliases || []).forEach((a) => push(a.clientId, a.alias, 'saved alias'));
  // a person-confirmed narration mapping: BankRule kind 'client' (category = the client's name)
  (ctx.rules || []).filter((r) => r.kind === 'client').forEach((r) => {
    const c = ctx.clients.find((x) => x.name === r.category);
    if (c) { const k = norm(r.match); if (k.length >= 4) keys.push({ clientId: c.id, key: k, via: 'saved mapping' }); }
  });
  ctx._clientKeys = keys;
  return keys;
}

// The ONE client named in the narration, or { ambiguous: [...] }, or null.
function clientNamed(narrNorm, ctx) {
  const hits = new Map();
  clientKeys(ctx).forEach((k) => {
    // a mapping key is matched against the plain narration; a name key against the narration with suffix words removed too
    if (hasPhrase(narrNorm, k.key) || hasPhrase(idKey(narrNorm), k.key)) {
      const prev = hits.get(k.clientId);
      if (!prev || k.key.length > prev.key.length) hits.set(k.clientId, k);
    }
  });
  if (!hits.size) return null;
  const list = [...hits.values()];
  // one name inside another (SAI inside SAI ESTATES): the longest phrase is the one named
  const longest = list.filter((a) => !list.some((b) => b !== a && b.key.length > a.key.length && hasPhrase(b.key, a.key)));
  if (longest.length === 1) return { clientId: longest[0].clientId, key: longest[0].key, via: longest[0].via };
  return { ambiguous: longest.map((x) => x.clientId) };
}

function vendorKeys(ctx) {
  if (ctx._vendorKeys) return ctx._vendorKeys;
  const keys = new Map(); // key -> display name
  const push = (name, via) => {
    const k = idKey(name);
    if (k.length >= 5) keys.set(k, { name: String(name).trim(), via });
  };
  (ctx.vendors || []).forEach((v) => push(v, 'vendor'));
  (ctx.rules || []).filter((r) => (r.kind || 'expense') === 'expense' && r.vendor).forEach((r) => {
    const k = norm(r.match);
    if (k.length >= 4) keys.set(k, { name: r.vendor, via: 'saved mapping' });
  });
  ctx._vendorKeys = keys;
  return keys;
}
function vendorsNamed(narrNorm, ctx) {
  const out = [];
  vendorKeys(ctx).forEach((v, key) => { if (hasPhrase(narrNorm, key) || hasPhrase(idKey(narrNorm), key)) out.push({ key, ...v }); });
  return out.filter((a) => !out.some((b) => b !== a && b.key.length > a.key.length && hasPhrase(b.key, a.key)));
}

// ---- money --------------------------------------------------------------------
const invoiceTotalP = (i) => toPaise(i.amount) + toPaise(i.gst) - toPaise(i.tds);
const outstandingP = (i) => invoiceTotalP(i) - toPaise(i.receivedAmount) - toPaise(i.creditedAmount) - toPaise(i.adjustedAmount) + toPaise(i.debitedAmount);
const isOpen = (i) => i.status !== 'Cancelled' && outstandingP(i) > 50; // 50 paise = the app's "settled" tolerance
// GROSS - TDS is what leaves the bank for a bill (OfficeExpense.monthlyAmount is gross).
const expenseNetP = (e) => toPaise(e.monthlyAmount) - toPaise(e.tdsAmount);

const dayNum = (s) => Math.floor(new Date(`${String(s).slice(0, 10)}T00:00:00Z`).getTime() / 86400000);
const daysApart = (a, b) => (a && b ? Math.abs(dayNum(a) - dayNum(b)) : null);

const oldestDueFirst = (list) => [...list].sort((a, b) => String(a.dueDate || a.invoiceDate || '9999').localeCompare(String(b.dueDate || b.invoiceDate || '9999'))
  || String(a.invoiceDate || '').localeCompare(String(b.invoiceDate || '')) || String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || '')));

function allocationPolicy() {
  return 'Oldest due first, whole invoices. Automatic only when the invoice number is in the narration, or the client is named and exactly one open invoice has a balance equal to the amount. Anything else waits in Unallocated Payments for a person to approve.';
}

// oldest-due-first split of an amount over a list of open invoices (suggestion only)
function suggestSplit(openInvoices, amountP) {
  let left = amountP;
  const parts = [];
  oldestDueFirst(openInvoices).forEach((inv) => {
    if (left <= 0) return;
    const out = outstandingP(inv);
    const take = Math.min(left, out);
    if (take > 0) { parts.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: take / 100, outstanding: out / 100 }); left -= take; }
  });
  return { parts, unallocated: left / 100 };
}

const R = {
  auto: (o) => ({ confidence: 'auto', ...o }),
  review: (reason, o = {}) => ({ confidence: 'review', reviewReason: reason, ...o }),
  none: (why) => ({ confidence: 'none', why }),
};

// ---- credits ---------------------------------------------------------------------
function decideCredit(txn, ctx) {
  const amountP = toPaise(txn.amount);
  const narrNorm = norm(`${txn.description || ''} ${txn.reference || ''}`);
  const narrUpper = String(`${txn.description || ''} ${txn.reference || ''}`).toUpperCase();
  const refs = extractRefs(txn.description, txn.reference, txn.externalId);
  const evidence = [];

  // RUNG 1 - a receipt already recorded with this exact reference.
  const payHits = (ctx.payments || []).filter((p) => {
    const pr = String(p.reference || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return pr.length >= 6 && refs.includes(pr);
  });
  if (payHits.length) {
    const exact = payHits.filter((p) => toPaise(p.amount) === amountP && !p.bankTxnId);
    if (payHits.length === 1 && exact.length === 1) {
      const inv = ctx.invoices.find((i) => i.id === exact[0].invoiceId);
      return R.auto({
        rule: 1, kind: 'receipt-proof', action: { type: 'linkPayment', paymentId: exact[0].id },
        invoiceId: exact[0].invoiceId, invoiceNumber: inv ? inv.invoiceNumber : null, client: inv && inv.client ? inv.client.name : null,
        evidence: [`reference ${payHits[0].reference} is already on a recorded receipt of exactly ${exact[0].amount}`, 'direction: money in'],
      });
    }
    const why = payHits.some((p) => p.bankTxnId) ? 'The reference belongs to a receipt that already has a bank line' : (payHits.length > 1 ? 'The reference is on more than one recorded receipt' : `The reference matches a recorded receipt of ${payHits[0].amount}, but the bank amount is ${txn.amount}`);
    return R.review(why, { rule: 1, kind: 'receipt-proof', conflicts: [why], candidates: { paymentIds: payHits.map((p) => p.id) } });
  }

  // who is named (used by rungs 2 and 3, and to detect conflicts)
  const named = clientNamed(narrNorm, ctx);
  const namedId = named && !named.ambiguous ? named.clientId : null;

  // RUNG 2 - an invoice number written in the narration (or a UTR typed on the invoice's proof).
  const open = ctx.invoices.filter((i) => i.status !== 'Cancelled');
  let hits = invoicesNamed(narrUpper, open).map((h) => h.inv);
  const byProofRef = open.filter((i) => i.proofRef && refs.includes(String(i.proofRef).toUpperCase().replace(/[^A-Z0-9]/g, '')) && String(i.proofRef).replace(/[^A-Za-z0-9]/g, '').length >= 6);
  byProofRef.forEach((i) => { if (!hits.includes(i)) hits.push(i); });
  if (hits.length) {
    const live = hits.filter(isOpen);
    if (hits.length === 1 && live.length === 1) {
      const inv = live[0];
      const out = outstandingP(inv);
      const strong = strongNumber(inv.invoiceNumber) || byProofRef.includes(inv);
      if (named && named.ambiguous) {
        return R.review('The narration names more than one client as well as invoice ' + inv.invoiceNumber, { rule: 2, kind: 'invoice', invoiceId: inv.id, conflicts: ['more than one client in the narration'] });
      }
      if (namedId && namedId !== inv.clientId) {
        return R.review(`The narration names a different client than invoice ${inv.invoiceNumber}`, { rule: 2, kind: 'invoice', invoiceId: inv.id, conflicts: ['client in the narration differs from the invoice client'] });
      }
      if (amountP > out) {
        return R.review(`Pays ${txn.amount} but invoice ${inv.invoiceNumber} has only ${out / 100} outstanding`, {
          rule: 2, kind: 'invoice', invoiceId: inv.id, candidates: { invoiceIds: [inv.id] }, suggested: suggestSplit([inv], amountP), conflicts: ['amount is more than the invoice outstanding'],
        });
      }
      if (!strong && amountP !== out) {
        return R.review(`Invoice number ${inv.invoiceNumber} is a bare number and the amount does not clear it exactly`, { rule: 2, kind: 'invoice', invoiceId: inv.id, candidates: { invoiceIds: [inv.id] } });
      }
      evidence.push(`invoice number ${inv.invoiceNumber} is written in the narration`, amountP === out ? `amount ${txn.amount} clears the invoice exactly` : `amount ${txn.amount} is a part payment of ${out / 100}`, 'direction: money in');
      if (namedId) evidence.push('the client named in the narration is the invoice client');
      return R.auto({
        rule: 2, kind: 'invoice', action: { type: 'settle', parts: [{ invoiceId: inv.id, amount: amountP / 100 }] },
        invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, clientId: inv.clientId, client: inv.client ? inv.client.name : null, partial: amountP < out, evidence,
      });
    }
    const why = hits.length > 1 ? `The narration names ${hits.length} invoices (${hits.map((h) => h.invoiceNumber).join(', ')})` : `Invoice ${hits[0].invoiceNumber} is already settled`;
    const liveList = live.length ? live : hits;
    return R.review(why, { rule: 2, kind: 'invoices', candidates: { invoiceIds: hits.map((h) => h.id) }, suggested: live.length ? suggestSplit(live, amountP) : null });
  }

  // RUNG 3 - the client named, and the amount.
  if (named && named.ambiguous) {
    return R.review('The narration could be more than one client', { rule: 3, kind: 'client', candidates: { clientIds: named.ambiguous } });
  }
  if (namedId) {
    const theirs = ctx.invoices.filter((i) => i.clientId === namedId && isOpen(i));
    const client = ctx.clients.find((c) => c.id === namedId);
    const equal = theirs.filter((i) => outstandingP(i) === amountP);
    if (equal.length === 1) {
      return R.auto({
        rule: 3, kind: 'invoice', action: { type: 'settle', parts: [{ invoiceId: equal[0].id, amount: amountP / 100 }] },
        invoiceId: equal[0].id, invoiceNumber: equal[0].invoiceNumber, clientId: namedId, client: client.name,
        evidence: [`client "${client.name}" is named in the narration (${named.via})`, `exactly one of their open invoices (${equal[0].invoiceNumber}) has a balance of ${amountP / 100}`, 'direction: money in'],
      });
    }
    const split = suggestSplit(theirs, amountP);
    if (equal.length > 1) {
      return R.review(`${client.name} has ${equal.length} open invoices of exactly ${amountP / 100} - pick which one this pays`, { rule: 3, kind: 'client', clientId: namedId, client: client.name, candidates: { invoiceIds: equal.map((i) => i.id) }, suggested: split });
    }
    if (!theirs.length) {
      return R.review(`${client.name} is named but has nothing outstanding - this would be an extra receipt`, { rule: 3, kind: 'client', clientId: namedId, client: client.name });
    }
    const why = split.unallocated > 0 ? `${client.name} named; ${amountP / 100} is more than they owe (${(theirs.reduce((s, i) => s + outstandingP(i), 0)) / 100})` : `${client.name} named; no single invoice balance equals ${amountP / 100} - confirm which invoices this pays`;
    return R.review(why, { rule: 3, kind: 'client', clientId: namedId, client: client.name, candidates: { invoiceIds: theirs.map((i) => i.id) }, suggested: split });
  }

  // RUNG 4 - nothing names a client or an invoice: only a hint, never automatic.
  const exactAmount = ctx.invoices.filter((i) => isOpen(i) && outstandingP(i) === amountP);
  if (exactAmount.length) {
    return R.review(exactAmount.length === 1 ? `Only the amount matches invoice ${exactAmount[0].invoiceNumber} (${exactAmount[0].client ? exactAmount[0].client.name : ''}) - the narration names nobody` : `${exactAmount.length} open invoices have exactly this balance - the narration names nobody`, {
      rule: 4, kind: 'invoice', candidates: { invoiceIds: exactAmount.map((i) => i.id) },
    });
  }
  return R.none('No client, invoice number or reference recognised');
}

// ---- debits ----------------------------------------------------------------------
function decideDebit(txn, ctx) {
  const amountP = toPaise(txn.amount);
  const narrNorm = norm(`${txn.description || ''} ${txn.reference || ''}`);
  const refs = extractRefs(txn.description, txn.reference, txn.externalId);
  const tol = Number.isFinite(ctx.toleranceDays) ? ctx.toleranceDays : 3;
  const free = (ctx.expenses || []).filter((e) => !e.bankTxnId && e.entryKind !== 'hand' && e.approvalStatus !== 'REJECTED');

  // RUNG 1 - the reference is written on the bill itself (bill no / remarks / notes) + exact amount.
  const byRef = refs.length ? free.filter((e) => {
    const t = squash(`${e.billNumber || ''} ${e.remarks || ''} ${e.notes || ''} ${e.description || ''}`);
    return refs.some((r) => t.includes(r));
  }) : [];
  if (byRef.length) {
    const exact = byRef.filter((e) => expenseNetP(e) === amountP);
    if (byRef.length === 1 && exact.length === 1) {
      return R.auto({
        rule: 1, kind: 'expense', action: { type: 'linkBill', billId: exact[0].id }, expenseId: exact[0].id, vendor: exact[0].vendor, category: exact[0].category,
        evidence: [`reference ${refs.find((r) => squash(`${exact[0].billNumber || ''} ${exact[0].remarks || ''} ${exact[0].notes || ''} ${exact[0].description || ''}`).includes(r))} is written on the bill`, `amount ${txn.amount} equals the bill's cash amount exactly`, 'direction: money out'],
      });
    }
    return R.review('The reference is on a bill but the amount does not match exactly (or on several bills)', { rule: 1, kind: 'expense', conflicts: ['reference/amount disagree'], candidates: { billIds: byRef.map((e) => e.id) } });
  }

  // identity: a vendor written in the narration, or a person-confirmed mapping to an expense category
  const vNamed = vendorsNamed(narrNorm, ctx);
  const ruleHits = (ctx.rules || []).filter((r) => (r.kind || 'expense') === 'expense' && norm(r.match).length >= 4 && hasPhrase(narrNorm, norm(r.match)));
  const identity = (e) => {
    const evk = idKey(e.vendor);
    if (evk && vNamed.some((v) => v.key === evk)) return `vendor "${e.vendor}" is written in the narration`;
    if (evk && ruleHits.some((r) => r.vendor && idKey(r.vendor) === evk)) return `a saved mapping links this narration to vendor "${e.vendor}"`;
    if (ruleHits.some((r) => r.category && String(r.category).trim().toLowerCase() === String(e.category || '').trim().toLowerCase())) return `a saved mapping links this narration to category "${e.category}"`;
    return null;
  };
  const sameAmount = free.filter((e) => expenseNetP(e) === amountP);
  const known = sameAmount.map((e) => ({ e, why: identity(e) })).filter((x) => x.why);

  // RUNG 3 - identity + exact amount + date within tolerance.
  const dated = known.map((x) => ({ ...x, apart: daysApart(txn.date, x.e.paymentDate || x.e.expenseDate) }));
  const inWindow = dated.filter((x) => x.apart == null || x.apart <= tol);
  if (inWindow.length === 1) {
    const x = inWindow[0];
    return R.auto({
      rule: 3, kind: 'expense', action: { type: 'linkBill', billId: x.e.id }, expenseId: x.e.id, vendor: x.e.vendor, category: x.e.category,
      evidence: [x.why, `amount ${txn.amount} equals the bill's cash amount exactly`, x.apart == null ? 'the bill has no date to compare' : `bill dated ${x.e.paymentDate || x.e.expenseDate}, statement ${txn.date}: ${x.apart} day(s) apart (tolerance ${tol})`, 'direction: money out'],
    });
  }
  if (inWindow.length > 1) {
    return R.review(`${inWindow.length} bills match this vendor, amount and date window - pick the right one`, { rule: 3, kind: 'expense', candidates: { billIds: inWindow.map((x) => x.e.id) } });
  }
  if (known.length) {
    return R.review(`The vendor and amount match ${known[0].e.expenseCode || 'a bill'}, but its date is ${dated[0].apart} day(s) from the statement (tolerance ${tol})`, { rule: 3, kind: 'expense', candidates: { billIds: known.map((x) => x.e.id) } });
  }

  // RUNG 4 - hints only.
  if (sameAmount.length) {
    return R.review(sameAmount.length === 1 ? `Only the amount matches ${sameAmount[0].expenseCode || 'a bill'} (${sameAmount[0].vendor || sameAmount[0].category}) - the narration does not identify it` : `${sameAmount.length} unlinked bills have exactly this amount - the narration does not identify which`, { rule: 4, kind: 'expense', candidates: { billIds: sameAmount.map((e) => e.id) } });
  }
  if (vNamed.length || ruleHits.length) {
    const who = vNamed[0] ? vNamed[0].name : (ruleHits[0].vendor || ruleHits[0].category);
    return R.review(`Recognised as ${who}, but no unlinked bill of exactly ${amountP / 100} is on file`, { rule: 4, kind: 'expense', suggestedVendor: vNamed[0] ? vNamed[0].name : (ruleHits[0].vendor || null), suggestedCategory: ruleHits[0] ? ruleHits[0].category : null });
  }
  return R.none('No vendor or bill recognised');
}

// A bounced cheque / return / reversal line: only ever a suggestion.
const REVERSAL_WORDS = /\b(CHQ\s*RTN|CHEQUE\s*RETURN|RETURN(ED)?|BOUNCE[D]?|DISHONOU?R|REVERSAL|REVERSED|UNPAID|NACH\s*RTN|REV\b)/i;
function decideReversal(txn, ctx) {
  if (txn.type !== 'Debit' || !REVERSAL_WORDS.test(String(txn.description || ''))) return null;
  const amountP = toPaise(txn.amount);
  const refs = extractRefs(txn.description, txn.reference, txn.externalId);
  const cands = (ctx.credits || []).filter((c) => c.type === 'Credit' && toPaise(c.amount) === amountP && c.id !== txn.id && c.date <= txn.date && (daysApart(c.date, txn.date) <= 90));
  const byRef = refs.length ? cands.filter((c) => extractRefs(c.description, c.reference, c.externalId).some((r) => refs.includes(r))) : [];
  const pick = byRef.length === 1 ? byRef : cands;
  if (!pick.length) return R.review('Reads like a returned / reversed payment, but no earlier credit of the same amount is on file', { rule: 4, kind: 'reversal' });
  return R.review(pick.length === 1 ? `Reads like the return of the credit on ${pick[0].date} (${pick[0].reference || pick[0].description.slice(0, 30)})` : `Reads like a returned payment; ${pick.length} earlier credits have this amount`, {
    rule: byRef.length === 1 ? 1 : 4, kind: 'reversal', candidates: { txnIds: pick.map((c) => c.id) },
  });
}

function decide(txn, ctx) {
  if (txn.type === 'Credit') return decideCredit(txn, ctx);
  return decideReversal(txn, ctx) || decideDebit(txn, ctx);
}

module.exports = {
  norm, idKey, hasPhrase, toPaise, extractRefs, invoicesNamed, clientNamed, vendorsNamed,
  outstandingP, isOpen, expenseNetP, suggestSplit, allocationPolicy, oldestDueFirst, daysApart, decide, decideCredit, decideDebit, decideReversal,
};

// THE PRINTABLE TAX INVOICE (HTML). Pure: a document payload in, { style, inner } out, so the
// Invoice page's window, the printed / "Save as PDF" copy and the emailed / WhatsApp copy are
// all this one function, and scripts/client-invoice-group-test.js can render it without a browser.
// The payload is GET /invoices/:id/document or GET /invoices/group/document (one line per
// candidate). 2026-10-14: the item table lists one line per candidate with the date of joining
// under the name, the header row is dark text on light grey, the table borders stop above the
// totals block, and the page is A4 with a repeating header and no split rows / totals.
import { money2, fmtD } from './invFormat';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// The printable tax invoice. Everything on it comes from
// GET /invoices/:id/document, so the paper copy can never disagree with the
// register. The client copy is what gets emailed; the internal copy adds the
// recruiter and the department and is never sent out.
// ---------------------------------------------------------------------------
// opts.logo: the logo to print when the company has not uploaded its own (the screens pass invoiceLogo.js).
export function invoiceDocumentHtml(d, mode, opts = {}) {
  const forClient = mode !== 'internal';
  const showRec = !forClient && d.lines.some((l) => l.recruiter);
  const gst = d.totals.gst;
  const n = (v) => money2(v).replace('₹', '');
  const taxHead = d.inter
    ? '<th colspan="2" class="grp">IGST</th>'
    : '<th colspan="2" class="grp">CGST</th><th colspan="2" class="grp">SGST</th>';
  const taxSub = d.inter
    ? '<th class="n sm">%</th><th class="n sm">Amt</th>'
    : '<th class="n sm">%</th><th class="n sm">Amt</th><th class="n sm">%</th><th class="n sm">Amt</th>';
  const style = `
  @page{size:A4;margin:10mm}
  *{box-sizing:border-box}
  body{margin:0;font:11px/1.4 Arial,Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .inv{border:1px solid #000;max-width:190mm;margin:0 auto;min-height:272mm;display:flex;flex-direction:column}
  .pageno{max-width:190mm;margin:2mm auto 0;text-align:right;font-size:9px;color:#333}
  table{border-collapse:collapse;width:100%}
  .hd{display:flex;border-bottom:1px solid #000}
  .hd .lg{width:190px;padding:10px;display:flex;align-items:center}
  .hd .lg img{max-width:180px;max-height:56px;object-fit:contain}
  .hd .co{flex:1;padding:10px 8px}
  .hd .co h1{margin:0 0 4px;font-size:14px;font-weight:bold;text-transform:uppercase;max-width:30ch;line-height:1.25}
  .hd .co .l{font-size:10px;line-height:1.5}
  .hd .ti{width:230px;padding:12px 14px;display:flex;align-items:center;justify-content:flex-end}
  .hd .ti span{font-size:26px}
  .meta{display:flex;border-bottom:1px solid #000}
  .meta .l{flex:1;border-right:1px solid #000}
  .meta .r{flex:1;padding:6px 10px;font-size:10.5px}
  .meta table td{padding:3px 10px;font-size:10.5px;vertical-align:top}
  .meta table td.k{color:#333;width:44%}
  .meta table td.v{font-weight:bold}
  .band{background:#e8e8e8;padding:4px 10px;font-weight:bold;font-size:10.5px;border-bottom:1px solid #000}
  .bill{padding:9px 10px;border-bottom:1px solid #000;font-size:10.5px;line-height:1.55}
  .bill .nm{font-weight:bold;font-size:12px;text-transform:uppercase;margin-bottom:2px}
  table.items thead{display:table-header-group}
  table.items tr{break-inside:avoid;page-break-inside:avoid}
  table.items thead th{background:#dde3ea !important;color:#111 !important;border:1px solid #000;padding:5px 6px;font-size:10px;font-weight:bold;text-align:left}
  table.items th.grp{text-align:center}
  table.items th.sm{font-weight:normal;font-size:9.5px}
  table.items td{border:1px solid #000;padding:6px;font-size:10.5px;vertical-align:top;color:#000}
  table.items th:first-child,table.items td:first-child{border-left:0}
  table.items th:last-child,table.items td:last-child{border-right:0}
  table.items tbody tr:last-child td{border-bottom:0}
  .desc b{font-weight:600}
  .desc .sub.in{color:#7A5A08}
  table.items td.n,table.items th.n{text-align:right}
  table.items td.c{text-align:center}
  .desc .sub{color:#555;font-size:9.5px;margin-top:2px}
  td.rec{text-align:center;font-weight:600;font-size:10px}
  .foot{display:flex;border-top:1px solid #000;break-inside:avoid;page-break-inside:avoid}
  .foot .lft,.foot .rgt{align-self:stretch}
  .tot{break-inside:avoid}
  .sign{break-inside:avoid;page-break-inside:avoid}
  @media print{.inv{display:block;min-height:0}.blank{display:none}.foot{border-top:1px solid #000}}
  .foot .lft{flex:1.15;padding:9px 10px;border-right:1px solid #000;position:relative}
  .foot .rgt{width:44%}
  .blank{flex:1 1 auto;min-height:0}
  .inv>*:not(.blank){flex-shrink:0}
  table.items{height:auto}
  table.items tr{height:auto}
  .words b{display:block;font-size:10px;font-weight:normal;color:#333}
  .words i{font-style:italic;font-weight:bold;font-size:10.5px;display:block;margin-top:2px}
  .notes{margin-top:10px;font-size:10px;line-height:1.5}
  .notes b{display:block;font-size:10px;color:#333;font-weight:normal;margin-bottom:2px}
  .tot td{padding:5px 12px;font-size:11px}
  .tot td.n{text-align:right;white-space:nowrap}
  .tot tr.g td{font-weight:bold;border-top:1px solid #000}
  .tot tr.b td{font-weight:bold;font-size:12.5px;border-top:1px solid #000;border-bottom:1px solid #000}
  .sign{min-height:120px;border-top:1px solid #000;text-align:center;padding:6px 4px 10px}
  .sign span{display:block;font-size:10.5px;padding-top:3px;border-top:1px solid #000;width:70%;margin:46px auto 0}
  .tdsnote{padding:6px 10px;border-top:1px solid #000;font-size:9.5px;color:#333}
  `;
  const co = d.company;
  const rows = d.lines.map((l) => `<tr>
    <td class="c">${l.n}</td>
    <td class="desc"><b>${esc(l.description)}</b>${l.joiningDate ? `<div class="sub">Date of joining: ${fmtD(l.joiningDate)}</div>` : ''}${!forClient ? `<div class="sub in">${[l.role, l.department, l.ref ? `ref ${l.ref}` : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}</td>
    ${showRec ? `<td class="rec">${esc(l.recruiter || '—')}</td>` : ''}
    <td class="n">${l.salary != null ? String(Math.round(l.salary)) : ''}</td>
    <td class="n">${esc(l.sac)}</td>
    <td class="n">${Number(l.qty).toFixed(2)}</td>
    <td class="n">${n(l.rate)}</td>
    ${gst > 0 ? (d.inter
    ? `<td class="n">${l.gstPct != null ? l.gstPct : d.gstPct}%</td><td class="n">${n(l.gst)}</td>`
    : `<td class="n">${l.halfPct != null ? l.halfPct : d.halfPct}%</td><td class="n">${n(l.cgst)}</td><td class="n">${l.halfPct != null ? l.halfPct : d.halfPct}%</td><td class="n">${n(l.sgst)}</td>`) : ''}
    <td class="n">${n(l.amount)}</td>
  </tr>`).join('');

  const inner = `<div class="inv">
    <div class="hd">
      <div class="lg">${co.logoUrl || opts.logo ? `<img src="${esc(co.logoUrl || opts.logo)}" alt="TeamLink">` : ''}</div>
      <div class="co">
        <h1>${esc(co.legalName)}</h1>
        <div class="l">${co.addressLines.map(esc).join('<br>')}${co.gstin ? `<br>GSTIN ${esc(co.gstin)}` : ''}</div>
      </div>
      <div class="ti"><span>${d.title}</span></div>
    </div>
    <div class="meta">
      <div class="l"><table>
        <tr><td class="k">#</td><td class="v">: ${esc(d.invoiceNumber)}</td></tr>
        <tr><td class="k">Invoice Date</td><td class="v">: ${fmtD(d.invoiceDate)}</td></tr>
        <tr><td class="k">Due Date</td><td class="v">: ${fmtD(d.dueDate)}</td></tr>
      </table></div>
      <div class="r"><table><tr><td class="k">Place Of Supply</td><td class="v">: ${esc(d.placeOfSupply)}</td></tr></table></div>
    </div>
    ${forClient ? '' : '<div class="band" style="background:#FBF3DE;color:#7A5A08">INTERNAL COPY — recruiter and department shown · not for the client</div>'}
    <div class="band">Bill To</div>
    <div class="bill">
      <div class="nm">${esc(d.client.name)}</div>
      ${d.client.addressLines.map(esc).join(',<br>')}${d.client.addressLines.length ? '<br>' : ''}
      ${d.client.gstin ? `GSTIN ${esc(d.client.gstin)}` : (forClient ? '' : '<span style="color:#B3261E">Client GSTIN not on file — add it in Client Master</span>')}
    </div>
    <table class="items">
      <thead>
        <tr>
          <th rowspan="${gst > 0 ? 2 : 1}" style="width:26px">#</th>
          <th rowspan="${gst > 0 ? 2 : 1}">Item &amp; Description</th>
          ${showRec ? `<th rowspan="${gst > 0 ? 2 : 1}" style="width:74px">Recruiter</th>` : ''}
          <th rowspan="${gst > 0 ? 2 : 1}" class="n" style="width:60px">Salary</th>
          <th rowspan="${gst > 0 ? 2 : 1}" class="n" style="width:66px">HSN/SAC</th>
          <th rowspan="${gst > 0 ? 2 : 1}" class="n" style="width:40px">Qty</th>
          <th rowspan="${gst > 0 ? 2 : 1}" class="n" style="width:76px">Rate</th>
          ${gst > 0 ? taxHead : ''}
          <th rowspan="${gst > 0 ? 2 : 1}" class="n" style="width:82px">Amount</th>
        </tr>
        ${gst > 0 ? `<tr>${taxSub}</tr>` : ''}
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="foot">
      <div class="lft">
        <div class="words"><b>Total In Words</b><i>${esc(d.words.total)}</i></div>
        ${d.words.netAfterTds ? `<div class="words"><b>Net Payable After TDS In Words</b><i>${esc(d.words.netAfterTds)}</i></div>` : ''}
        <div class="notes"><b>Notes</b>
          ${esc(co.bank.accountName)}<br>
          ${co.bank.accountNumber ? `Account Number: ${esc(co.bank.accountNumber)}<br>` : ''}
          ${co.bank.ifsc ? `IFSC: ${esc(co.bank.ifsc)}<br>` : ''}
          ${co.bank.branch ? `Branch: ${esc(co.bank.branch)}<br>` : ''}
          ${co.bank.accountType ? `Account Type: ${esc(co.bank.accountType)}<br>` : ''}
          ${co.bank.upi ? `Virtual Payment Address: ${esc(co.bank.upi)}` : ''}
        </div>
      </div>
      <div class="rgt">
        <table class="tot">
          <tr><td>Sub Total</td><td class="n">${n(d.totals.subTotal)}</td></tr>
          ${gst > 0 ? (d.inter
    ? `<tr><td>IGST${d.gstPct} (${d.gstPct}%)</td><td class="n">${n(d.totals.gst)}</td></tr>`
    : `<tr><td>CGST${d.halfPct} (${d.halfPct}%)</td><td class="n">${n(d.totals.cgst)}</td></tr>
                 <tr><td>SGST${d.halfPct} (${d.halfPct}%)</td><td class="n">${n(d.totals.sgst)}</td></tr>`) : ''}
          <tr class="g"><td>Total</td><td class="n">${money2(d.totals.invoiceValue)}</td></tr>
          ${d.totals.tds > 0 ? `<tr><td>Less: TDS @ ${d.tdsPct}% u/s ${esc(d.tdsSection || '194J')}${d.tdsBase === 'gross' ? ' (on the total)' : ''}</td><td class="n">(${n(d.totals.tds)})</td></tr>
            <tr class="g"><td>Net Payable After TDS</td><td class="n">${money2(d.totals.receivable)}</td></tr>` : ''}
          ${d.totals.paid > 0 ? `<tr><td>Amount Received</td><td class="n">${n(d.totals.paid)}</td></tr>` : ''}
          ${d.totals.credited > 0 ? `<tr><td>Less: Credit Notes</td><td class="n">(${n(d.totals.credited)})</td></tr>` : ''}
          ${d.totals.debited > 0 ? `<tr><td>Add: Debit Notes</td><td class="n">${n(d.totals.debited)}</td></tr>` : ''}
          <tr class="b"><td>Balance Due</td><td class="n">${money2(d.totals.balance)}</td></tr>
        </table>
        <div class="sign"><span>Authorized Signature</span></div>
      </div>
    </div>
    <div class="blank"></div>
    ${d.totals.tds > 0 ? `<div class="tdsnote">TDS @ ${d.tdsPct}% u/s ${esc(d.tdsSection || '194J')} (${money2(d.totals.tds)}) ${d.tdsBase === 'gross' ? 'is worked out on the total including GST, as agreed for this invoice' : 'is deductible on the professional fee only, not on GST'}. Net payable after TDS: ${money2(d.totals.balance)}. Kindly share Form 16A after deduction.</div>` : ''}
  </div>
  <div class="pageno">1</div>`;
  return { style, inner };
}

export { esc };

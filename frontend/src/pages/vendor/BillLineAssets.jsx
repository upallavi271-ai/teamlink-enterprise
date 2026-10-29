// ITEMS ON THIS BILL (founder 2026-10-28; automatic asset detection from imported bills): every line read from the bill (handwritten or
// printed) - the item, brand / model, serial, quantity, amount - the HRMS asset it is, who had that asset on the bill date (HRMS history),
// who has it now (name, employee ID, department) and how sure the match is. Shown to the vendor (My Bills) and to Accounts (review).
// With assetOptions + onLink (Accounts, edit permission) each line can be linked to an asset, marked a new asset pending verification,
// or set back to the automatic reading. Server: backend/src/utils/billLineAssets.js.
import Combo from '../../components/Combo.jsx';

const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '-');
const who = (p) => (p ? `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}${p.department ? ` · ${p.department}` : ''}` : '');
const rs = (n) => (n == null ? null : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const MATCH_TONE = {
  Matched: 'green', 'Linked by hand': 'green', 'Needs review': 'orange', Unmatched: 'grey', 'New asset - pending verification': 'blue',
};
export function MatchChip({ status }) {
  if (!status) return null;
  return <span className={`vp-tag vp-${MATCH_TONE[status] || 'grey'}`}>{status}</span>;
}

// THE PAYMENT of an approved bill (2026-10-28): its status from Accounts + bank statement and every payment's date and amount.
export function PaymentBlock({ p }) {
  if (!p) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <h4 style={{ margin: '0 0 4px' }}>Payment</h4>
      <div><strong>{p.status}</strong>{p.note ? <span className="cell-muted"> &middot; {p.note}</span> : null}</div>
      {(p.payments || []).map((x, i) => <div key={`${x.date}-${i}`}>Paid on <strong>{dmy(x.date)}</strong>: &#8377;{Number(x.amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}{x.reference ? <span className="cell-muted"> (ref {x.reference})</span> : null}</div>)}
      {p.balance > 0 ? <div className="cell-muted">Still to pay: &#8377;{Number(p.balance).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div> : null}
    </div>
  );
}

// The "Asset name / Assigned to / Match status" cells of a bill list row, from the row's `items` summary.
export function ItemCells({ items }) {
  const it = items && items.items ? items.items : [];
  const more = items && items.count > it.length ? <div className="cell-muted">+{items.count - it.length} more</div> : null;
  if (!items) return <><td>-</td><td>-</td><td>-</td></>;
  if (!items.count) return <><td className="cell-muted">No items read</td><td>-</td><td>-</td></>;
  return (
    <>
      <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{it.map((x, i) => <div key={i}>{x.itemName || '-'}{x.assetCode ? <span className="cell-muted"> · {x.assetCode}</span> : null}</div>)}{more}</td>
      <td style={{ whiteSpace: 'normal', minWidth: 130 }}>{it.map((x, i) => <div key={i}>{x.holder ? `${x.holder}${x.employeeCode ? ` (${x.employeeCode})` : ''}` : <span className="cell-muted">{x.assetCode ? 'Unassigned' : '-'}</span>}</div>)}</td>
      <td>{it.map((x, i) => <div key={i}><MatchChip status={x.matchStatus} /></div>)}{items.needsReview ? <div className="cell-muted">{items.needsReview} to check</div> : null}</td>
    </>
  );
}

export default function BillLineAssets({ rows, assetOptions = null, onLink = null, busy = false }) {
  if (!rows || !rows.length) return null;
  const billDate = rows[0].billDate;
  const canLink = !!(onLink && assetOptions);
  return (
    <div style={{ marginTop: 12 }}>
      <h4 style={{ margin: '0 0 6px' }}>Items on this bill{billDate ? ` (bill date ${dmy(billDate)})` : ''}</h4>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Item</th><th>Asset</th><th>{billDate ? `With whom on ${dmy(billDate)}` : 'With whom on the bill date'}</th><th>With whom now</th><th>Match</th>{canLink && <th>Link to an asset</th>}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lineNo}>
                <td style={{ whiteSpace: 'normal', minWidth: 170 }}>
                  <strong>{r.lineNo}. {r.itemName || r.description}</strong>
                  {(r.brand || r.model) && <div className="cell-muted">{[r.brand, r.model].filter(Boolean).join(' ')}</div>}
                  {r.serialNo && <div className="cell-muted">Serial {r.serialNo}</div>}
                  {(r.quantity != null || r.amount != null) && <div className="cell-muted">{r.quantity != null ? `Qty ${r.quantity}` : ''}{r.quantity != null && r.amount != null ? ' · ' : ''}{rs(r.amount) || ''}</div>}
                  {r.itemName && r.description && r.itemName !== r.description && <div className="cell-muted">{r.description}</div>}
                </td>
                <td>{r.asset ? <><strong>{r.asset.code}</strong> &middot; {r.asset.name}<div className="cell-muted">{[r.asset.serial && `Serial ${r.asset.serial}`, r.asset.status].filter(Boolean).join(' · ')}</div><div className="cell-muted">{r.how}</div></> : <span className="cell-muted">{r.matchStatus === 'New asset - pending verification' ? 'To be registered in HRMS Assets' : (r.ambiguous ? 'More than one asset fits - choose the asset' : 'Asset not found on this line')}</span>}</td>
                <td>{!r.asset ? '-' : r.onBillDate ? (r.onBillDate.none ? <span className="cell-muted">Nobody (in stock) since {dmy(r.onBillDate.since)}</span> : <>{r.onBillDate.name}<div className="cell-muted">since {dmy(r.onBillDate.since)}</div></>) : <span className="cell-muted">Not recorded on that date</span>}</td>
                <td>{!r.asset ? '-' : r.now ? <>{who(r.now)}{r.now.since ? <div className="cell-muted">since {dmy(r.now.since)}</div> : null}</> : <span className="cell-muted">Unassigned (in stock)</span>}</td>
                <td><MatchChip status={r.matchStatus} />{r.linkedBy && r.linkedBy.name ? <div className="cell-muted">by {r.linkedBy.name}{r.linkedBy.at ? ` · ${dmy(r.linkedBy.at)}` : ''}</div> : null}</td>
                {canLink && (
                  <td style={{ minWidth: 220 }}>
                    <Combo
                      value=""
                      disabled={busy}
                      aria-label={`Line ${r.lineNo}: link to an asset`}
                      onChange={(e) => { const v = e.target.value; if (!v) return; if (v === '__new') onLink(r.lineNo, 'new'); else if (v === '__clear') onLink(r.lineNo, 'clear'); else onLink(r.lineNo, 'linked', v); }}
                    >
                      <option value="">{r.asset ? 'Change…' : 'Choose the asset…'}</option>
                      <option value="__new">New asset - pending verification</option>
                      {r.linkedBy && <option value="__clear">Clear (back to the automatic reading)</option>}
                      {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.assetCode} · {a.name}{a.serialNumber ? ` · SN ${a.serialNumber}` : ''}{a.holder ? ` · ${a.holder}` : ' · unassigned'}</option>)}
                    </Combo>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

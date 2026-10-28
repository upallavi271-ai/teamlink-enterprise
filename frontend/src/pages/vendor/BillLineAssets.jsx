// ITEMS ON THIS BILL (founder 2026-10-28): every line read from the bill (handwritten or printed), the asset it is, who had that asset
// on the bill date (from HRMS history) and who has it now. Read only - shown to the vendor (My bills) and to Accounts (review screen).
// Server: backend/src/utils/billLineAssets.js.
const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '-');
const who = (p) => (p ? `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}${p.department ? ` · ${p.department}` : ''}` : '');

export default function BillLineAssets({ rows }) {
  if (!rows || !rows.length) return null;
  const billDate = rows[0].billDate;
  return (
    <div style={{ marginTop: 12 }}>
      <h4 style={{ margin: '0 0 6px' }}>Items on this bill{billDate ? ` (bill date ${dmy(billDate)})` : ''}</h4>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Item</th><th>Asset</th><th>{billDate ? `With whom on ${dmy(billDate)}` : 'With whom on the bill date'}</th><th>With whom now</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lineNo}>
                <td style={{ whiteSpace: 'normal', minWidth: 160 }}>{r.lineNo}. {r.description}</td>
                <td>{r.asset ? <><strong>{r.asset.code}</strong> &middot; {r.asset.name}<div className="cell-muted">{r.how}</div></> : <span className="cell-muted">{r.ambiguous ? 'More than one asset fits - choose the asset' : 'Asset not found on this line'}</span>}</td>
                <td>{!r.asset ? '-' : r.onBillDate ? (r.onBillDate.none ? <span className="cell-muted">Nobody (in stock) since {dmy(r.onBillDate.since)}</span> : <>{r.onBillDate.name}<div className="cell-muted">since {dmy(r.onBillDate.since)}</div></>) : <span className="cell-muted">Not recorded on that date</span>}</td>
                <td>{!r.asset ? '-' : r.now ? <>{who(r.now)}{r.now.since ? <div className="cell-muted">since {dmy(r.now.since)}</div> : null}</> : <span className="cell-muted">Not with anyone (in stock)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

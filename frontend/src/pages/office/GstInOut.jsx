// GST INWARD AND OUTWARD (founder 2026-11-28): how much GST clients pay us and how much GST we pay vendors, party by
// party, on Office & Accounts. Figures come from officeFacts() (recon.inOut) in routes/office.js: the client side follows
// the period only, the vendor side follows the period and the page filters.
import { money } from './officeUtil';

function Side({ title, party, countWord, billed, done, pending, data }) {
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <h4 style={{ margin: '0 0 8px' }}>{title}</h4>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
        <div><div className="small-muted">{billed}</div><b style={{ fontSize: 20 }}>{money(data.gst)}</b></div>
        <div><div className="small-muted">{done}</div><b style={{ fontSize: 20, color: 'var(--teal)' }}>{money(data.done)}</b></div>
        <div><div className="small-muted">{pending}</div><b style={{ fontSize: 20, color: data.pending > 0.5 ? 'var(--red)' : undefined }}>{money(data.pending)}</b></div>
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 300 }}>
        <table>
          <thead><tr><th>{party}</th><th className="num">{countWord}</th><th className="num">GST</th><th className="num">{done}</th><th className="num">{pending}</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.name}>
                <td style={{ whiteSpace: 'normal' }}>{r.name}{r.noGstin > 0.5 && <div className="small-muted">No GSTIN on {money(r.noGstin)}</div>}</td>
                <td className="num">{r.n}</td><td className="num">{money(r.gst)}</td><td className="num">{money(r.done)}</td><td className="num">{money(r.pending)}</td>
              </tr>
            ))}
            {!data.rows.length && <tr><td colSpan={5} className="empty-mini">Nothing with GST in this period.</td></tr>}
          </tbody>
          {data.rows.length > 0 && (
            <tfoot><tr><td>Total</td><td className="num">{data.count}</td><td className="num">{money(data.gst)}</td><td className="num">{money(data.done)}</td><td className="num">{money(data.pending)}</td></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export default function GstInOut({ data }) {
  if (!data) return null;
  const { clients, vendors } = data;
  const gap = clients.done - vendors.done;
  return (
    <div data-testid="gst-in-out" style={{ marginTop: 14 }}>
      <h3 style={{ margin: '0 0 8px' }}>GST outward and inward</h3>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
        <Side title="Outward: GST clients pay us" party="Client" countWord="Invoices" billed="GST on invoices" done="Received" pending="Yet to come" data={clients} />
        <Side title="Inward: GST we pay vendors" party="Vendor" countWord="Bills" billed="GST on bills" done="Paid" pending="Yet to pay" data={vendors} />
      </div>
      <p style={{ marginBottom: 0 }}>
        GST received from clients <b>{money(clients.done)}</b> − GST paid to vendors <b>{money(vendors.done)}</b> = <b style={{ color: gap >= 0 ? 'var(--teal)' : 'var(--red)' }}>{money(Math.abs(gap))}</b> {gap >= 0 ? 'more received than paid' : 'more paid than received'}.
        <span className="small-muted"> This compares money moved. The amount due to the Government is on the “GST payable” card.</span>
      </p>
    </div>
  );
}

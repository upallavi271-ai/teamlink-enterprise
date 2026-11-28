// GST INWARD AND OUTWARD, party by party (founder 2026-11-28): how much GST clients pay us and how much GST we pay
// vendors, shown INSIDE the GST position - the client list under Outward, the vendor list under Inward. Figures come from
// officeFacts() (recon.inOut) in routes/office.js: the client side follows the period only, the vendor side follows the
// period and the page filters.
import { money } from './officeUtil';

const WORDS = {
  clients: { party: 'Client', count: 'Invoices', billed: 'GST on invoices', done: 'Received', pending: 'Yet to come', none: 'No invoice with GST in this period.' },
  vendors: { party: 'Vendor', count: 'Bills', billed: 'GST on bills', done: 'Paid', pending: 'Yet to pay', none: 'No expense in this period has a GST amount entered, so there is no vendor GST to show.' },
};

export function GstParties({ kind, data, filtered }) {
  if (!data) return null;
  const w = WORDS[kind];
  return (
    <div data-testid={`gst-parties-${kind}`} style={{ marginTop: 10 }}>
      <div style={{ marginBottom: 6 }}>
        {w.billed} <b>{money(data.gst)}</b> · {w.done} <b style={{ color: 'var(--teal)' }}>{money(data.done)}</b> · {w.pending} <b style={{ color: data.pending > 0.5 ? 'var(--red)' : undefined }}>{money(data.pending)}</b>
      </div>
      {data.rows.length ? (
        <div className="tbl-wrap" style={{ maxHeight: 300 }}>
          <table>
            <thead><tr><th>{w.party}</th><th className="num">{w.count}</th><th className="num">GST</th><th className="num">{w.done}</th><th className="num">{w.pending}</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.name}>
                  <td style={{ whiteSpace: 'normal' }}>{r.name}{r.noGstin > 0.5 && <div className="small-muted">No GSTIN on {money(r.noGstin)}</div>}</td>
                  <td className="num">{r.n}</td><td className="num">{money(r.gst)}</td><td className="num">{money(r.done)}</td><td className="num">{money(r.pending)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>Total</td><td className="num">{data.count}</td><td className="num">{money(data.gst)}</td><td className="num">{money(data.done)}</td><td className="num">{money(data.pending)}</td></tr></tfoot>
          </table>
        </div>
      ) : <div className="small-muted">{kind === 'vendors' && filtered ? 'A filter is on at the top of this page and none of the bills it shows has GST. Clear the filters to see all vendor GST.' : w.none}</div>}
    </div>
  );
}

export function GstGap({ inOut }) {
  if (!inOut) return null;
  const { clients, vendors } = inOut;
  const gap = clients.done - vendors.done;
  return (
    <p style={{ margin: '10px 0 0' }}>
      GST received from clients <b>{money(clients.done)}</b> − GST paid to vendors <b>{money(vendors.done)}</b> = <b style={{ color: gap >= 0 ? 'var(--teal)' : 'var(--red)' }}>{money(Math.abs(gap))}</b> {gap >= 0 ? 'more received than paid' : 'more paid than received'}.
    </p>
  );
}

// Previous / Next for the vendor lists (the server sends page, pages and total).
export default function VendorPager({ data, onPage }) {
  if (!data || data.pages <= 1) return data ? <div className="cell-muted" style={{ marginTop: 6 }}>{data.total} {data.total === 1 ? 'record' : 'records'}</div> : null;
  return (
    <div className="vp-filters" style={{ marginTop: 8, alignItems: 'center' }}>
      <button type="button" className="btn btn-sm" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
      <span className="cell-muted">Page {data.page} of {data.pages} &middot; {data.total} records</span>
      <button type="button" className="btn btn-sm" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>Next</button>
    </div>
  );
}

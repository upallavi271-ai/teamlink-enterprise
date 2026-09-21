import { useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// A clearly-labelled placeholder for an ATS tab whose own screen has not been
// built yet.
//
// The nav entry exists because the module structure is fixed, but the tab must
// never be a blank page or a dead link: it says plainly that the screen is not
// built, says where this work lives in the meantime, and links straight there.
// ---------------------------------------------------------------------------
export default function Placeholder({ title, sub, does, links = [] }) {
  const navigate = useNavigate();
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <div className="page-sub">{sub}</div>
        </div>
      </div>

      <div className="notice amber">
        <span>⚠</span>
        <span>
          <b>This screen is not built yet.</b> The tab is here because it is part of the ATS
          structure — but nothing on this page is live data. Use the links below for this work today.
        </span>
      </div>

      <div className="panel panel-pad">
        <h3 style={{ fontSize: 14 }}>What will live here</h3>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--ink-soft)' }}>
          {does.map((d) => <li key={d} style={{ marginBottom: 4 }}>{d}</li>)}
        </ul>
        {links.length > 0 && (
          <>
            <div className="divider" />
            <div className="qa-row">
              {links.map((l) => (l.external ? (
                <a className="btn btn-sm" key={l.to} href={l.to} target="_blank" rel="noreferrer">{l.label} ↗</a>
              ) : (
                <button className="btn btn-sm" key={l.to} onClick={() => navigate(l.to)}>{l.label}</button>
              )))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

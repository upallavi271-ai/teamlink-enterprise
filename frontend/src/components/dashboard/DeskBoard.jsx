import { useEffect, useState } from 'react';
import sharedGet from '../../utils/sharedGet';
import RoleBoard from './RoleBoard.jsx';

// A role board read from one endpoint and drawn by RoleBoard: the Accounts
// desk on /accounts/dashboard (GET /dashboard/accounts/desk) and the Admin
// board on the home Dashboard for Super Admin / Admin (GET /dashboard/admin-desk).
// Each count's rows come from `${url}/list?set=` — the same server builder.
export default function DeskBoard({ url, title, sub }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    sharedGet(url)
      .then((r) => { if (alive) setBoard(r.data); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'This board could not be loaded.'); });
    return () => { alive = false; };
  }, [url]);
  if (error) return <div className="notice red">{error}</div>;
  if (!board) return <div className="small-muted" style={{ margin: '6px 0 12px' }}>Loading {title || 'the board'}…</div>;
  return (
    <RoleBoard
      board={board}
      listUrl={`${url}/list`}
      head={title ? (
        <div className="panel-head" style={{ padding: 0, border: 0, background: 'none' }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {sub && <span className="small-muted">{sub}</span>}
        </div>
      ) : null}
    />
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { isClientMergeAdmin } from '../pages/ClientDuplicates.jsx';

// "Duplicate clients (N)" on the Clients page header — Super Admin / Admin only
// (hidden for everyone else; the API refuses them too).
export default function ClientDuplicatesButton() {
  const { user } = useAuth();
  const allowed = isClientMergeAdmin(user);
  const [n, setN] = useState(null);
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    api.get('/client-merge/count').then((r) => { if (live) setN(r.data.groups); }).catch(() => {});
    return () => { live = false; };
  }, [allowed]);
  if (!allowed) return null;
  return (
    <Link to="/clients/duplicates" className="btn" title="Review and merge the same company stored under several names">
      Duplicate clients{n != null ? ` (${n})` : ''}
    </Link>
  );
}

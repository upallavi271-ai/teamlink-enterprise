import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isClientUser } from '../../permissions';

// The prototype's teamView() (line 9154).
export default function Team() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);

  useEffect(() => {
    api.get('/ats/team').then((res) => setRows(res.data)).catch(() => setRows([]));
  }, []);

  if (isClientUser(user)) {
    return (
      <div className="empty">
        <h3>Not available for your role</h3>
        <div>Recruiter &amp; BDE workload is internal TeamLink information and isn&apos;t part of your client scope.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Recruiter &amp; BDE</h1>
          <div className="page-sub">Workload and assignment</div>
        </div>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Role</th><th>Open Requirements</th><th>Active Pipeline</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.roleLabel || r.role}</td>
                {r.oversight ? (
                  <td colSpan="2">Oversees all recruiter &amp; BDE activity</td>
                ) : (
                  <>
                    <td>{r.openRequirements}</td>
                    <td>{r.activePipeline}</td>
                  </>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No recruiters or BDEs on file.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

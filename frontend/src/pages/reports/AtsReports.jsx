import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { canExportReports } from '../../permissions';
import Combo from '../../components/Combo.jsx';

export default function AtsReports() {
  const { user } = useAuth();
  const canExport = canExportReports(user, 'ATS Reports');
  const [rows, setRows] = useState([]);
  const [client, setClient] = useState('');   // applied filter
  const [pick, setPick] = useState('');       // what the box is showing

  useEffect(() => {
    api.get('/reports/ats').then((res) => setRows(res.data));
  }, []);

  const shown = client ? rows.filter((r) => r.client === client) : rows;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>ATS Reports</h1>
          <div className="page-sub">Filter-driven recruitment reporting</div>
        </div>
      </div>

      <div className="filter-row">
        <Combo value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">All clients</option>
          {rows.map((r) => <option key={r.client}>{r.client}</option>)}
        </Combo>
        <button className="btn btn-sm btn-primary" onClick={() => setClient(pick)}>Apply</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setPick(''); setClient(''); }}>Clear</button>
        {canExport
          ? (
            <button
              className="btn btn-sm"
              onClick={() => downloadCsv('ats-report.csv',
                ['Client', 'Open', 'In Pipeline', 'Selected', 'Joined', 'Rejected'],
                shown.map((r) => [r.client, r.open, r.inPipeline, r.selected, r.joined, r.rejected]))}
            >
              Export CSV
            </button>
          )
          : <span className="small-muted">Export isn&apos;t included in your role&apos;s permissions</span>}
      </div>

      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Client</th><th>Open</th><th>In Pipeline</th><th>Selected</th><th>Joined</th><th>Rejected</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.client}>
                <td>{r.client}</td><td>{r.open}</td><td>{r.inPipeline}</td><td>{r.selected}</td><td>{r.joined}</td><td>{r.rejected}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>No data for this filter.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

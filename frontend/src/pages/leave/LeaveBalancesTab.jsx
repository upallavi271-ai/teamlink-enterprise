import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, EmptyMini } from '../../components/proto.jsx';
import { MonthlyBalance, MonthlyReport } from './LeaveMonthWise.jsx';
import './LeaveExtras.css';

// ---------------------------------------------------------------------------
// MONTH-WISE BALANCE - ONE VIEW (founder 2026-11-13). It used to be three tabs: One employee - month-wise / All employees - month-wise /
// All employees - current balances. They are one table now (./LeaveMonthWise.jsx MonthlyReport): every employee in scope, every month,
// Credited / Taken / Pending / Closing and Balance now; a click on a name opens that person month by month, a click on a number opens
// the leave behind it with its chain. A login that sees only itself gets its own month-by-month balance.
// ---------------------------------------------------------------------------
export default function LeaveBalancesTab({ canExport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  function load() {
    setError('');
    api.get('/leave/balances').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load leave balances.'));
  }
  useEffect(load, []);
  // More than one person in scope -> HR / TL / Manager / Super Admin: the all-employee table. An employee sees only their own.
  const many = (data?.rows || []).length > 1;
  if (error) return <Panel style={{ marginTop: 16 }}><div className="error-text" style={{ margin: 16 }}>{error} <button className="btn btn-sm" onClick={load}>Retry</button></div></Panel>;
  if (!data) return <Panel style={{ marginTop: 16 }}><EmptyMini>Loading…</EmptyMini></Panel>;
  return (
    <div>
      {many ? <MonthlyReport canExport={canExport} allowRelieved /> : <MonthlyBalance employees={null} />}
    </div>
  );
}

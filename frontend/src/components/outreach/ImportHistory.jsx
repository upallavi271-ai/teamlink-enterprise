import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function ImportHistory({ acc, type }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/outreach/imports', { params: { type } }).then((r) => setList(r.data.imports)).catch((e) => { setErr(e.response?.data?.error || 'The history could not be loaded.'); setList([]); }), [type]);
  useEffect(() => { load(); }, [load]);
  const undo = async (i) => {
    if (!window.confirm('Take back this whole import? People it added are removed and changed people go back to how they were.')) return;
    setErr(''); setMsg('');
    try { const r = await api.post(`/outreach/imports/${i.id}/undo`); setMsg(r.data.ok); load(); } catch (e) { setErr(e.response?.data?.error || 'It could not be taken back.'); }
  };
  const rows = async (i) => {
    setErr('');
    try { const r = await api.get('/outreach/imports/' + i.id + '/rows.csv', { responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = (i.source || i.fileName || 'import') + '-rows-with-problems.csv'; a.click(); } catch (e) { setErr('The file could not be made. Please try again.'); }
  };
  return (
    <div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!list && <div className="oc-note">Loading…</div>}
      {list && list.length === 0 && !err && <div className="oc-empty"><b>No imports yet.</b><div>Every import you do shows here, with what was added and who did it.</div></div>}
      {list && list.length > 0 && (
        <div className="oc-scroll"><table className="oc-table"><thead><tr><th>File</th><th>When</th><th>By</th><th>Rows</th><th>Added</th><th className="oc-hide-m">Changed</th><th className="oc-hide-m">Repeats</th><th className="oc-hide-m">Unusable</th><th className="oc-hide-m">Opted out</th><th /></tr></thead><tbody>
          {list.map((i) => (
            <tr key={i.id}>
              <td><b>{i.source || i.fileName || 'Import'}</b><div className="oc-note">{i.basis}</div></td><td>{when(i.createdAt)}</td><td>{i.createdByName}</td><td>{i.total}</td><td>{i.created}</td>
              <td className="oc-hide-m">{i.updated}</td><td className="oc-hide-m">{i.duplicates}</td><td className="oc-hide-m">{i.invalid}</td><td className="oc-hide-m">{i.optedOut}</td>
              <td>{i.rowsSaved && i.problemRows > 0 && <button type="button" className="btn btn-sm" onClick={() => rows(i)}>Rows with problems ({i.problemRows})</button>} {i.undoneAt ? <span className="oc-pill">Taken back</span> : (i.canUndo && (acc.isAdmin || i.createdById) ? <button type="button" className="btn btn-sm" onClick={() => undo(i)}>Undo</button> : null)}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}

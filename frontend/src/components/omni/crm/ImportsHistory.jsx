import { useCallback, useEffect, useState } from 'react';
import { Btn, Banner, Empty, ConfirmModal, Pill } from '../ui.jsx';
import omni from '../omniApi.js';
import { saveBlob, timeLabel, errText } from './crmUtil.js';

// The "Imports" tab of All Customers: every file (and every ATS copy) brought in, who did it, what was added; "rows with problems" and Undo for 7 days.
export default function ImportsHistory({ type, toast, onChanged }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState(null);
  const load = useCallback(() => omni.get('/imports', { type }).then((r) => setList(r.imports)).catch((e) => { setErr(errText(e, 'The history could not be loaded.')); setList([]); }), [type]);
  useEffect(() => { load(); }, [load]);
  const undo = async () => {
    const i = ask; setAsk(null); setErr('');
    try { const r = await omni.post(`/imports/${i.id}/undo`); toast(r.ok); load(); onChanged(); } catch (e) { setErr(errText(e, 'It could not be taken back.')); }
  };
  const rows = async (i) => { try { saveBlob(await omni.blob(`/imports/${i.id}/rows.csv`), `${i.source || i.fileName || 'import'}-rows-with-problems.csv`); } catch { setErr('The file could not be made. Please try again.'); } };
  return (
    <div className="card table-card">
      {err && <Banner tone="error">{err}</Banner>}
      {!list && <div style={{ padding: 20 }}>Loading…</div>}
      {list && !list.length && <Empty title="No imports yet">Every file you bring in shows here, with what was added and who did it.</Empty>}
      {list && list.length > 0 && (
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 820 }}>
            <thead><tr><th>File</th><th>When</th><th>By</th><th>Rows</th><th>Added</th><th>Changed</th><th>Repeats</th><th>Unusable</th><th>Opted out</th><th /></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td style={{ overflowWrap: 'anywhere' }}><b>{i.source || i.fileName || 'Import'}</b><div style={{ fontSize: 9.5, color: 'var(--muted)' }}>{i.basis}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{timeLabel(i.createdAt)}</td><td>{i.createdByName}</td><td>{i.total}</td><td>{i.created}</td><td>{i.updated}</td><td>{i.duplicates}</td><td>{i.invalid}</td><td>{i.optedOut}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {i.rowsSaved && i.problemRows > 0 && <button type="button" className="tiny-btn" onClick={() => rows(i)}>Rows with problems ({i.problemRows})</button>}{' '}
                    {i.undoneAt ? <Pill tone="draft">Taken back</Pill> : (i.canUndo ? <button type="button" className="tiny-btn" onClick={() => setAsk(i)}>Undo</button> : null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ask && <ConfirmModal title="Take back this whole import?" text="People it added are removed and changed people go back to how they were. This works for 7 days." yes="Undo import" danger onYes={undo} onNo={() => setAsk(null)} />}
    </div>
  );
}

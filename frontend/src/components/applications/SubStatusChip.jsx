// ---------------------------------------------------------------------------
// THE SUB-STATUS NEXT TO A STAGE (founder ATS audit 2026-11-17; Company Setup -> Pipeline & checks).
//   <SubStatusChip app canSet onChanged />
//   app: { id, stage, subStatus: { id, label } | null }. Shows the chip; the owner of the stage (canSet: the login may move a
//   person into this stage) picks another one from the stage's list. The server decides (PUT /api/ats/applications/:id/sub-status)
//   and writes the change to the timeline. Nothing shows when the stage has no sub-statuses and none is set.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { loadStageLabels, subStatusesOf } from '../../utils/stageLabels';

export default function SubStatusChip({ app, canSet = false, onChanged }) {
  const [, setReady] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { loadStageLabels().then(() => setReady((n) => n + 1)); }, []);
  const options = subStatusesOf(app.stage);
  const cur = app.subStatus || null;
  if (!cur && (!canSet || !options.length)) return null;
  async function pick(id) {
    setBusy(true); setError('');
    try {
      await api.put(`/ats/applications/${app.id}/sub-status`, { subStatusId: id || null });
      if (onChanged) onChanged();
    } catch (e) { setError((e.response && e.response.data && e.response.data.error) || 'Could not change it.'); } finally { setBusy(false); }
  }
  if (!canSet || !options.length) return <span className="chip" style={{ marginLeft: 6 }} title={cur.byName ? `Set by ${cur.byName}` : undefined}>{cur.label}</span>;
  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select
        className="chip"
        aria-label="Sub-status"
        value={cur ? cur.id : ''}
        disabled={busy}
        onChange={(e) => pick(e.target.value)}
        style={{ fontSize: 11.5, padding: '1px 4px' }}
      >
        <option value="">{cur ? '(clear)' : '+ sub-status'}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        {cur && !options.some((o) => o.id === cur.id) && <option value={cur.id}>{cur.label}</option>}
      </select>
      {error && <span className="error-text" style={{ fontSize: 11 }}>{error}</span>}
    </span>
  );
}

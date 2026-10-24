import { useRef, useState } from 'react';
import api from '../../api';
import AsyncCombo, { candidateSearcher } from '../AsyncCombo.jsx';
import { usePairCheck, AlreadyAppliedNotice } from './AlreadyApplied.jsx';

// ---------------------------------------------------------------------------
// "ADD A CANDIDATE" on a job's page (founder, 2026-10-16): ONE box that is a
// dropdown AND you can type into (name, CAN-code, phone tail, email), instead of
// a search box that hid everyone already on the job.
//
//   * people already on this job are LISTED, marked 'already on this job (step X)'
//   * the moment a person is picked, the pair is checked (GET /applications/pair-check):
//     already on the job -> the notice says where, with [Open this application];
//     the job / person would refuse (closed, paused, Do not use) -> it says why
//   * the button is locked while it works, so a double click cannot add twice
// onAdd(candidateId) -> Promise<boolean> (true = added)
// ---------------------------------------------------------------------------
export default function AddCandidateCard({ requirementId, onAdd }) {
  const [pick, setPick] = useState(null); // { value, label, name }
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [key, setKey] = useState(0); // remounts the picker after an add
  const check = usePairCheck(pick ? pick.value : '', requirementId);
  const stop = check.exists || !!check.blocked;
  const searcher = useRef(candidateSearcher(api, { requirementId }));

  async function go() {
    if (!pick || lock.current || stop) return;
    lock.current = true;
    setBusy(true);
    try {
      const ok = await onAdd(pick.value, pick.name);
      if (ok) { setPick(null); setKey((k) => k + 1); }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="card section">
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>Add a candidate</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', maxWidth: 760 }}>
        <div style={{ flex: '1 1 340px', minWidth: 240 }}>
          <AsyncCombo
            key={key}
            value={pick ? pick.value : ''}
            selected={pick}
            search={searcher.current}
            placeholder="Pick a person, or type a name, phone, email or CAN code"
            emptyText="Type a name, phone, email or CAN code"
            onChange={(v, row) => setPick(v ? { value: v, label: row ? row.label : (pick && pick.label) || v, name: row ? row.name : (pick && pick.name) } : null)}
          />
        </div>
        <button type="button" className="btn btn-primary" disabled={!pick || busy || stop || check.loading} onClick={go}>
          {busy ? 'Adding...' : 'Add to requirement'}
        </button>
      </div>
      {pick && <AlreadyAppliedNotice check={check} name={pick.name} />}
    </div>
  );
}

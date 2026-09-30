import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { PanelPad, AssignRow, EmptyMini, TwoCol, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import AudiencePicker, { DeliverVia, audienceReady } from '../../components/AudiencePicker.jsx';
import Nominations from './Nominations.jsx';
import InsightsPanel from '../../components/charts/InsightsPanel.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import {
  ComposeModal, Field, AiAssist, ResultNote, useSubmit,
} from '../../components/ComposeForm.jsx';

// The prototype's seeded award types (state.awardTypes, line 622 area).
const AWARD_TYPES = [
  { name: 'Above & Beyond', points: 50 },
  { name: 'Team Player', points: 30 },
];

// The reference compose layout. RECOGNISE is the shared AudiencePicker: one
// colleague, several, a whole department or several, or everyone in scope —
// one recognition (with its points) per person.
function GiveRecognitionModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ type: AWARD_TYPES[0].name, message: '' });
  const [audience, setAudience] = useState({ mode: 'individuals', departments: [], employeeIds: [] });
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    if (!form.type) { setError('Pick an award type.'); return; }
    if (!form.message.trim()) { setError('Write a short message.'); return; }
    if (!audienceReady(audience)) { setError((audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.')); return; }
    const award = AWARD_TYPES.find((a) => a.name === form.type);
    const res = await run(() => api.post('/recognition', {
      title: form.type,
      detail: form.message.trim(),
      points: award ? award.points : 0,
      date: new Date().toISOString().slice(0, 10),
      audience,
      channels,
    }), 'Could not send the recognition');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="Give Recognition" onClose={onClose} onSubmit={submit} submitLabel="Send Recognition" busy={busy} error={error} wide>
      <Field label="Award type" required>
        <Combo value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {AWARD_TYPES.map((a) => <option key={a.name} value={a.name}>{a.name} (+{a.points} pts)</option>)}
        </Combo>
      </Field>
      <AiAssist kind="recognition" title={form.type} text={form.message} onText={(message) => setForm((f) => ({ ...f, message }))} />
      <Field label="Message" required><textarea rows="4" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
      <AudiencePicker value={audience} onChange={setAudience} label="Recognise" required />
      <DeliverVia value={channels} onChange={setChannels} />
    </ComposeModal>
  );
}

export default function Recognition() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const hrView = hasHrmsAdmin(user);
  const isHR = hrView && canManageServices(user);
  const [records, setRecords] = useState([]);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState('');
  // A recognition has no workflow status, so it filters by the person
  // recognised and the award given instead.
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, award: '', from: '', to: '' });

  function load() {
    api.get('/recognition').then((res) => setRecords(res.data));
  }
  useEffect(load, [isHR]);

  const shown = records.filter((r) => textMatches(`${r.detail || ''} ${r.fromName || ''} ${r.title || ''}`, pf.q)
    && peopleMatches(r, pf) && (!pf.award || r.title === pf.award));
  const opts = peopleOptions(records);
  const page = usePaged(shown);
  const clearPf = () => setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));
  const awards = [...new Set([...AWARD_TYPES.map((a) => a.name), ...records.map((r) => r.title).filter(Boolean)])];

  // The leaderboard ranks whoever the filters leave in — a department's own
  // board when one department is picked.
  const leaderboard = {};
  shown.forEach((r) => {
    const name = r.employee?.name || '—';
    leaderboard[name] = (leaderboard[name] || 0) + (Number(r.points) || 0);
  });
  const ranked = Object.entries(leaderboard).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <div className="page-head">
        <div><h1>Rewards &amp; Recognition</h1><div className="page-sub">Peer-to-peer recognition, points and the leaderboard</div></div>
      </div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      {/* Data I/O: the rewards export (recognitions AND nominations —
          everyone in scope, or one employee) and import of recognitions with
          the compulsory sample (backend src/io/recognition.js). Nominations
          are a review workflow and are export-only. */}
      <QaRow style={{ marginBottom: 14 }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Give Recognition</button>}
        <DataIoBar
          ioKey="recognition"
          exportUrl="/insights/rewards/export"
          params={{ ...(pf.department ? { department: pf.department } : {}), ...(pf.from && pf.to ? { from: pf.from, to: pf.to } : {}) }}
          onImported={load}
        />
      </QaRow>
      <ResultNote>{done}</ResultNote>

      {/* hrms-24 §1 / §9 — recognition and nomination trend, department-wise
          recognition and nominations by status for the range, with the
          rewards export (own records only without the export permission). */}
      {/* The one KPI row here is recognition's own; the review tiles belong
          to Performance Reports. */}
      <InsightsPanel
        module="rewards"
        storageKey="tl_range_rewards"
        only={['rw-trend', 'rw-dept', 'rw-status']}
        tileKeys={['recognitions', 'points', 'nominations', 'awarded']}
      />

      <PeopleFilterBar
        filters={pf} setFilters={setPf}
        departments={opts.departments} roles={opts.roles} shown={shown.length} total={records.length}
        search="Message or sender" dates="Date" labels={{ award: 'Award' }}
      >
        <Combo value={pf.award} title="Award" onChange={(e) => setPf((f) => ({ ...f, award: e.target.value }))}>
          <option value="">All awards</option>
          {awards.map((a) => <option key={a}>{a}</option>)}
        </Combo>
      </PeopleFilterBar>

      <TwoCol>
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Recognition Feed</h3>
          {shown.length === 0 ? <ListEmpty lf={{ activeCount: Object.values(pf).some(Boolean) ? 1 : 0, clear: clearPf }} noun="recognitions" /> : page.slice.map((r) => (
            <div key={r.id}>
              <AssignRow flush>
                <span>{r.fromName || 'HR'} → {r.employee?.name} · {r.title} (+{r.points ?? 0})</span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{r.date || ''}</span>
              </AssignRow>
              <div className="small-muted" style={{ margin: '-4px 0 8px' }}>{r.detail || '—'}</div>
            </div>
          ))}
          {page.total > 0 && <Pager page={page} noun="recognitions" />}
        </PanelPad>
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Leaderboard</h3>
          {ranked.length === 0 ? <EmptyMini>No points awarded yet.</EmptyMini> : ranked.map(([name, pts], i) => (
            <AssignRow flush key={name}><span>{i + 1}. {name}</span><b>{pts} pts</b></AssignRow>
          ))}
        </PanelPad>
      </TwoCol>

      {/* hrms-24 §13 — nominations: Nominated → Pending Review → Approved /
          Rejected → Awarded. An award lands in the feed above. */}
      <Nominations onAwarded={load} />

      {open && <GiveRecognitionModal onClose={() => setOpen(false)} onSaved={(r) => { setOpen(false); setDone(`Recognition sent to ${r.label} — ${r.created} employee(s). ${r.deliveryText || ''}`); load(); }} />}
    </div>
  );
}

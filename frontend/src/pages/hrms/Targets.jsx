import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Panel, PanelHead, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilterBar, { EMPTY_PEOPLE_FILTERS, peopleMatches, peopleOptions, textMatches } from '../../components/PeopleFilterBar.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ListEmpty } from '../../components/ui/ListFilters.jsx';
import AudiencePicker, { DeliverVia, audienceReady } from '../../components/AudiencePicker.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import Modal from '../../components/Modal.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import {
  ComposeModal, Field, Row, AiAssist, ResultNote, useSubmit,
} from '../../components/ComposeForm.jsx';

const thisMonth = () => new Date().toISOString().slice(0, 7);

// A target's stored status never moves off Open, so the status that means
// something is how far it has got — read off target vs achieved, the same
// figures the Progress column shows.
const TARGET_STATUSES = ['Not Started', 'In Progress', 'Achieved'];
function targetStatusOf(r) {
  const target = Number(r.amount) || 0;
  const achieved = Number(r.achieved) || 0;
  if (target > 0 && achieved >= target) return 'Achieved';
  return achieved > 0 ? 'In Progress' : 'Not Started';
}

// Active / Exited / Relieved (user, 2026-10-09). Anyone who has not left (Active,
// probation, notice period, exit process) is Active. Targets of people who have
// left stay in the list (and in their history) - nothing is deleted on exit.
const statusGroupOf = (e) => (e && e.employmentStatus === 'Relieved' ? 'Relieved' : e && e.employmentStatus === 'Exited' ? 'Exited' : 'Active');
const SG_ORDER = ['Active', 'Exited', 'Relieved'];
const SG_FIELDS = [{ key: 'sg', get: (r) => statusGroupOf(r.employee) }];
const pctWords = (r) => { const t = Number(r.amount) || 0; return t > 0 ? `${Math.round(((Number(r.achieved) || 0) / t) * 100)}%` : '—'; };

// One person's targets, month by month: target, achieved, completion.
function HistoryModal({ rows, onClose }) {
  const list = [...rows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const e = (list[0] && list[0].employee) || {};
  const hit = list.filter((r) => (Number(r.amount) || 0) > 0 && (Number(r.achieved) || 0) >= Number(r.amount)).length;
  return (
    <Modal title={`Target history — ${e.name || ''}`} onClose={onClose} foot={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        {e.employeeCode ? `${e.employeeCode} · ` : ''}{e.department || ''} · {statusGroupOf(e)}{statusGroupOf(e) !== 'Active' ? ' — their targets are kept for the record' : ''}
        {' · '}Reached the target in {hit} of {list.length} month(s).
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Month</th><th>Goal</th><th>Target</th><th>Achieved</th><th>Completion</th><th>Result</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{r.date || '—'}</td><td>{r.title}</td><td>{Number(r.amount) || 0} {r.unit || ''}</td><td>{Number(r.achieved) || 0} {r.unit || ''}</td>
                <td><b>{pctWords(r)}</b></td><td>{targetStatusOf(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// The reference compose layout. ASSIGN TO is the shared AudiencePicker: one
// person, several people, one or MANY departments, or everyone in scope —
// one target row per person, the same row a single target always was.
function SetTargetModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ title: 'Monthly target', detail: '', month: thisMonth(), amount: 10, achieved: 0, unit: 'placements' });
  const [audience, setAudience] = useState({ mode: 'individuals', departments: [], employeeIds: [] });
  const [channels, setChannels] = useState([]);
  const { busy, error, setError, run } = useSubmit();

  async function submit() {
    if (!form.title.trim()) { setError('Enter the goal.'); return; }
    if (!form.month) { setError('Pick the month.'); return; }
    if (!audienceReady(audience)) { setError((audience.mode === 'departments' ? 'Pick at least one department.' : 'Pick at least one employee.')); return; }
    const res = await run(() => api.post('/targets', {
      title: form.title.trim(),
      detail: form.detail || null,
      date: form.month,
      amount: Number(form.amount) || 0,
      achieved: Number(form.achieved) || 0,
      unit: form.unit,
      audience,
      channels,
    }), 'Could not set the target');
    if (res) onSaved(res.data);
  }

  return (
    <ComposeModal title="Set Monthly Target" onClose={onClose} onSubmit={submit} submitLabel="Set Target" busy={busy} error={error} wide>
      <Field label="Goal" required><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <AiAssist kind="target" title={form.title} text={form.detail} onText={(detail) => setForm((f) => ({ ...f, detail }))} />
      <Field label="Description"><textarea rows="3" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="What counts, and how it is measured" /></Field>
      <Row>
        <Field label="Month" required><input type="month" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} /></Field>
        <Field label="Unit"><input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></Field>
        <Field label="Target" required><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="Achieved so far"><input type="number" value={form.achieved} onChange={(e) => setForm({ ...form, achieved: e.target.value })} /></Field>
      </Row>
      <AudiencePicker value={audience} onChange={setAudience} label="Assign to" required />
      <DeliverVia value={channels} onChange={setChannels} />
    </ComposeModal>
  );
}

export default function Targets() {
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
  const [pf, setPf] = useState({ q: '', ...EMPTY_PEOPLE_FILTERS, month: '' });
  const [sort, setSort] = useState('month');
  const [sg, setSg] = useState('');
  const [histFor, setHistFor] = useState('');

  function load() {
    api.get('/targets').then((res) => setRecords(res.data));
  }
  useEffect(load, [isHR]);

  async function editAchieved(r) {
    const v = prompt(`Achieved (${r.unit || 'units'}) for ${r.employee?.name}`, r.achieved ?? 0);
    if (v === null) return;
    await api.patch(`/targets/${r.id}`, { achieved: Number(v) || 0 });
    load();
  }

  const shown = records.filter((r) => textMatches(`${r.title || ''} ${r.detail || ''} ${r.unit || ''}`, pf.q)
    && peopleMatches(r, pf, undefined, targetStatusOf) && (!pf.month || r.date === pf.month) && (!sg || statusGroupOf(r.employee) === sg));
  const sgFacets = useLocalFacets(records, SG_FIELDS, { sg });
  const opts = peopleOptions(records);
  const pctOf = (r) => ((Number(r.amount) || 0) > 0 ? (Number(r.achieved) || 0) / Number(r.amount) : 0);
  const SORTS = {
    month: (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')),
    progress: (a, b) => pctOf(b) - pctOf(a),
    name: (a, b) => String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')),
  };
  const page = usePaged([...shown].sort(SORTS[sort] || SORTS.month));
  const clearPf = () => { setPf((f) => Object.fromEntries(Object.keys(f).map((k) => [k, '']))); setSg(''); };

  return (
    <div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      <div className="page-head">
        <div><h1>Monthly Targets</h1><div className="page-sub">Recruiter &amp; BDE performance vs target</div></div>
      </div>
      {/* Data I/O: export all / one employee and import with the compulsory
          sample (backend src/io/targets.js — records only, nobody notified). */}
      <QaRow style={{ marginBottom: 14 }}>
        {isHR && <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Set Target</button>}
        <DataIoBar
          ioKey="targets"
          params={{ ...(pf.department ? { department: pf.department } : {}), ...(pf.month ? { month: pf.month } : {}) }}
          onImported={load}
        />
      </QaRow>
      <ResultNote>{done}</ResultNote>

      <Panel>
        <PanelHead title="Monthly Targets" />
        <div style={{ padding: '0 18px' }}>
          <PeopleFilterBar
            filters={pf} setFilters={setPf} people={hrView}
            departments={hrView ? opts.departments : undefined} roles={hrView ? opts.roles : undefined}
            statuses={TARGET_STATUSES} shown={shown.length} total={records.length}
            search="Goal" labels={{ month: 'Month' }}
          >
            <input type="month" aria-label="Month" title="Month" value={pf.month} onChange={(e) => setPf((f) => ({ ...f, month: e.target.value }))} />
            <FacetSelect label="Employee status" allLabel="Active, Exited and Relieved" value={sg} onChange={setSg}
              options={[...(sgFacets.sg || [])].sort((a, b) => SG_ORDER.indexOf(a.value) - SG_ORDER.indexOf(b.value))} />
            <label className="lf-sort">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="month">Month (latest first)</option>
                <option value="progress">Progress (high to low)</option>
                <option value="name">Employee A–Z</option>
              </select>
            </label>
          </PeopleFilterBar>
        </div>
        {shown.length === 0 ? <ListEmpty lf={{ activeCount: Object.values(pf).some(Boolean) ? 1 : 0, clear: clearPf }} noun="targets" title="No targets set yet." /> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Month</th><th>Target</th><th>Achieved</th><th>Progress</th></tr></thead>
              <tbody>
                {page.slice.map((r) => {
                  const target = Number(r.amount) || 0;
                  const achieved = Number(r.achieved) || 0;
                  const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
                  return (
                    <tr key={r.id}>
                      <td>
                        <button type="button" className="link-btn" title="See this person's targets month by month" onClick={() => setHistFor(r.employeeId)}>{r.employee?.name}</button>
                        {statusGroupOf(r.employee) !== 'Active' && <div className="small-muted">{statusGroupOf(r.employee)}</div>}
                      </td>
                      <td className="cell-muted">{r.date || '—'}</td>
                      <td className="cell-muted">{target} {r.unit || ''}</td>
                      <td className="cell-muted">
                        {achieved} {r.unit || ''}
                        {isHR && <> <button className="btn btn-sm" onClick={() => editAchieved(r)}>Edit</button></>}
                      </td>
                      <td><b>{pct}%</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {page.total > 0 && <Pager page={page} noun="targets" />}
      </Panel>

      {histFor && <HistoryModal rows={records.filter((r) => r.employeeId === histFor)} onClose={() => setHistFor('')} />}
      {open && <SetTargetModal onClose={() => setOpen(false)} onSaved={(r) => { setOpen(false); setDone(`Target set for ${r.label} — ${r.created} employee(s). ${r.deliveryText || ''}`); load(); }} />}
    </div>
  );
}

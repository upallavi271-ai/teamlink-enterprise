import { useEffect, useState } from 'react';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import SourcingAdminY from '../atsY/SourcingAdminY.jsx'; // ATS wave 2 Y: the sourcing / AI switches and connectors
import Combo from '../Combo.jsx';
import {
  M, Card, Chips, Flash, Empty, useGet, useRun, day, when,
} from './kit.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION > ATS settings > AI governance & automation (market wave B), /admin/ai-governance. Super Admin / Admin edit;
// a Manager may look at the switches. Tabs (5 main, the rest under More):
//   Overview      the pledge (09.18), what masking does, the switches (every notify / automate switch starts OFF)
//   AI calls      every model call: who, why, model, masked size, outcome (09.16) + usage per login / monthly limit (09.21)
//   Flags         AI outputs people flagged or overrode (09.03)
//   Compliance    the dated compliance audit (09.15) + the paired fairness test of the new scorers (09.17); ISO 42001 note
//   Automations   workflow builder (09.10), global auto-reject rules (04.09), data health (09.11)
//   More: Client pipelines (02.09) · Posting rules (02.16) · Field parsing (03.05) · Scanned resumes (03.02) · MCP (09.14)
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'overview', label: 'Overview', hint: 'The pledge and the switches' },
  { key: 'calls', label: 'AI calls', hint: 'Every AI call: who, why, model, outcome; usage and limits' },
  { key: 'flags', label: 'Flags', hint: 'AI outputs people flagged as wrong, biased or unsafe' },
  { key: 'compliance', label: 'Compliance', hint: 'Compliance audit and fairness tests' },
  { key: 'automations', label: 'Automations', hint: 'Workflows, auto-reject rules, data health' },
  { key: 'clients', label: 'Client pipelines', hint: 'Each client\'s own steps and interview rounds', more: true },
  { key: 'posting', label: 'Posting rules', hint: 'Where each kind of job is posted', more: true },
  { key: 'fields', label: 'Field parsing', hint: 'Read custom fields from resumes', more: true },
  { key: 'ocr', label: 'Scanned resumes', hint: 'Resumes waiting to be read with OCR', more: true },
  { key: 'mcp', label: 'MCP (AI tools)', hint: 'Access for outside AI tools (read; writing only when switched on)', more: true },
  { key: 'sourcingY', label: 'Sourcing & AI connectors', hint: 'Notetaker, outside look-ups, job-change bells, prospecting, MCP write tools, LinkedIn RSC: the switches and the accounts', more: true },
];

function Switches() {
  const s = useGet(`${M}/settings`);
  const { busy, msg, run } = useRun();
  if (s.error) return <div className="notice">{s.error}</div>;
  if (!s.data) return <Empty>Loading…</Empty>;
  return (
    <Card title="Switches" testid="mkb-switches" note="Anything that tells people something or does work by itself starts OFF. You turn it on when you are ready. Every change is in the audit log.">
      {s.data.switches.map((w) => (
        <div key={w.key} className="mkb-row" style={{ alignItems: 'flex-start' }}>
          {w.type === 'bool'
            ? <input type="checkbox" checked={!!w.value} disabled={busy || !s.data.mayEdit} aria-label={w.label} onChange={(e) => run(() => api.put(`${M}/settings`, { key: w.key, value: e.target.checked }), `${w.label}: ${e.target.checked ? 'ON' : 'OFF'}.`).then(s.reload)} style={{ marginTop: 3 }} />
            : <input type="number" min="0" style={{ width: 90 }} defaultValue={w.value} disabled={busy || !s.data.mayEdit} aria-label={w.label} onBlur={(e) => Number(e.target.value) !== Number(w.value) && run(() => api.put(`${M}/settings`, { key: w.key, value: e.target.value }), `${w.label}: ${e.target.value}.`).then(s.reload)} />}
          <span className="mkb-grow"><b>{w.label}</b><div className="small-muted">{w.note}</div></span>
        </div>
      ))}
      <Flash msg={msg} />
    </Card>
  );
}

function Overview() {
  const p = useGet(`${M}/gov/pledge`);
  return (
    <div>
      {p.data && (
        <Card title="Our AI pledge: masking and no training" testid="mkb-pledge">
          <ul>{p.data.pledge.map((l) => <li key={l} style={{ marginBottom: 6 }}>{l}</li>)}</ul>
          <div className="small-muted">What the model sees:</div>
          <div className="mkb-pre">{`Before: ${p.data.demo.before}\nSent:   ${p.data.demo.after}`}</div>
          <Chips items={[{ key: 'pg', label: 'Outside profile data / contact finding', value: p.data.connectors.state }, { key: 'iso', label: 'ISO/IEC 42001', value: p.data.iso42001.state }]} />
          <div className="small-muted">{p.data.connectors.note}</div>
        </Card>
      )}
      <Switches />
    </div>
  );
}

function Calls() {
  const sum = useGet(`${M}/gov/summary`);
  const [purpose, setPurpose] = useState('');
  const calls = useGet(`${M}/gov/calls?limit=200${purpose ? `&purpose=${encodeURIComponent(purpose)}` : ''}`);
  const s = sum.data;
  return (
    <div>
      {s && (
        <Card title={`This month: ${s.total} AI calls, ${s.ok} answered, ${s.maskedValues} values masked`} note={s.limit ? `Limit: ${s.limit} calls per login per month (change it under Overview).` : 'No monthly limit per login (set one under Overview).'}>
          <div className="mkb-two">
            <div>
              <div className="small-muted">By purpose</div>
              <ul className="mkb-list">{s.purposes.map((x) => <li key={x.purpose}><button type="button" className="mkb-link" onClick={() => setPurpose(purpose === x.purpose ? '' : x.purpose)}>{x.purpose}</button><span className="small-muted">{`${x.calls} calls · ${x.ok} ok · ${x.failed} not answered`}</span></li>)}</ul>
            </div>
            <div>
              <div className="small-muted">By login (answered calls)</div>
              <ul className="mkb-list">{s.byUser.map((u) => <li key={u.userId || 'sys'}><span>{u.userName}</span><span className="small-muted">{`${u.calls}${u.left != null ? ` · ${u.left} left` : ''}`}</span></li>)}</ul>
            </div>
          </div>
        </Card>
      )}
      <Card title={`AI call log${purpose ? `: ${purpose}` : ''}`} testid="mkb-calls" note="One row per call. The text itself is never kept: only its size after masking.">
        <div className="table-wrap mkb-table">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Purpose</th><th>Model</th><th>Text sent</th><th>Masked</th><th>Outcome</th></tr></thead>
            <tbody>
              {((calls.data && calls.data.rows) || []).map((r) => (
                <tr key={r.id}><td>{when(r.at)}</td><td>{r.userName || 'system'}</td><td>{r.purpose}</td><td className="small-muted">{[r.provider, r.model].filter(Boolean).join(' · ') || '-'}</td><td>{`${r.inChars} chars`}</td><td>{r.masked ? `${r.masked} (${r.maskedKinds})` : '0'}</td><td><span className={`mkb-chip ${r.outcome === 'ok' ? 'good' : 'bad'}`}>{r.outcome}</span>{r.error && <div className="small-muted">{r.error}</div>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {!((calls.data && calls.data.rows) || []).length && <Empty>No AI calls yet.</Empty>}
      </Card>
    </div>
  );
}

function Flags() {
  const f = useGet(`${M}/gov/flags`);
  const { busy, msg, run } = useRun();
  return (
    <Card title="Flagged and overridden AI outputs" testid="mkb-flags" note="People flag an AI output from any screen (Flag AI output). An edit of an AI draft before approval is kept here as an override.">
      {!((f.data && f.data.rows) || []).length && <Empty>Nothing flagged.</Empty>}
      <ul className="mkb-list">
        {((f.data && f.data.rows) || []).map((x) => (
          <li key={x.id}>
            <span className="mkb-grow"><span className={`mkb-chip ${x.kind === 'Override' ? '' : 'bad'}`}>{x.kind}</span> <b>{x.feature}</b> {x.reason}<div className="small-muted">{`${x.userName} · ${when(x.at)} · ${x.status}${x.closedByName ? ` by ${x.closedByName}` : ''}`}</div>{x.output && <div className="mkb-pre">{String(x.output).slice(0, 400)}</div>}{x.corrected && <div className="mkb-pre">{`Changed to: ${String(x.corrected).slice(0, 400)}`}</div>}</span>
            {x.status === 'Open' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/gov/flags/${x.id}/close`), 'Closed.').then(f.reload)}>Close</button>}
          </li>
        ))}
      </ul>
      <Flash msg={msg} />
    </Card>
  );
}

function Compliance() {
  const a = useGet(`${M}/gov/audits`);
  const [fair, setFair] = useState(null);
  const { busy, msg, run } = useRun();
  const last = a.data && a.data.rows[0];
  return (
    <div>
      <Card title="AI compliance audit" testid="mkb-audit" note="A dated check-list built from the call log, the switches, the review queue and the fairness tests. Run it each month and keep it as evidence." right={<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`${M}/gov/audit`), 'Audit done and kept.').then(a.reload)}>Run the audit now</button>}>
        {last ? (
          <>
            <div className="mkb-row"><span className={`mkb-score ${last.score >= 80 ? 'good' : 'bad'}`}>{`${last.score}%`}</span><span className="small-muted">{`${when(last.at)} by ${last.byName}`}</span></div>
            <ul className="mkb-list">{last.checks.map((c) => <li key={c.key}><span className={`mkb-chip ${c.ok ? 'good' : 'bad'}`}>{c.ok ? 'Pass' : 'Look'}</span><span className="mkb-grow">{c.label}<div className="small-muted">{c.detail}</div></span></li>)}</ul>
            {a.data.rows.length > 1 && <div className="small-muted">{`Earlier: ${a.data.rows.slice(1, 8).map((r) => `${day(r.at)} ${r.score}%`).join(' · ')}`}</div>}
          </>
        ) : <Empty>No audit yet.</Empty>}
      </Card>
      <Card title="Fairness of the new scores (bias test)" note="The profile review and the attrition risk run on pairs of people who differ only in name and gender. The Fit % has its own test in Fit settings > AI fairness. Automatic decisions also wait for a person in Candidates > Hiring tools > Review queue." right={<button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.get(`${M}/gov/fairness`)).then((r) => r && setFair(r.data))}>Run the test</button>}>
        {fair && (
          <>
            <div className="mkb-row"><span className={`mkb-score ${fair.failures ? 'bad' : 'good'}`}>{fair.failures ? `${fair.failures} difference(s)` : 'No differences'}</span><span className="small-muted">{`${fair.pairs} pairs · ${fair.note}`}</span></div>
            <div className="table-wrap mkb-table"><table className="table"><thead><tr><th>Score</th><th>Person A</th><th>Person B</th><th>A</th><th>B</th></tr></thead><tbody>{fair.rows.map((r) => <tr key={`${r.scorer}${r.a}${r.b}${r.scoreA}`}><td>{r.scorer}</td><td>{r.a}</td><td>{r.b}</td><td>{r.scoreA}</td><td>{r.scoreB}</td></tr>)}</tbody></table></div>
          </>
        )}
      </Card>
      <Flash msg={msg} />
    </div>
  );
}

function Workflows() {
  const w = useGet(`${M}/workflows`);
  const [f, setF] = useState({ name: '', trigger: 'stage_entered', tvalue: 'SHARED_WITH_CLIENT', action: 'add_tag', avalue: '', active: false });
  const [res, setRes] = useState(null);
  const pools = useGet(`${M}/pools`);
  const stages = useGet('/ats/stage-labels');
  const { busy, msg, run } = useRun();
  const d = w.data;
  const lab = (stages.data && stages.data.labels) || {};
  const stageList = ((stages.data && stages.data.codes) || Object.keys(lab)).map((code) => ({ code, label: lab[code] || code }));
  return (
    <Card title="Workflow automations: when X, then Y" testid="mkb-workflows" note={d && d.on ? 'Automations are ON: active rules run every 2 minutes, once per event.' : 'Automations are OFF (switch under Overview). Save rules and use Dry run to see what they would do.'}>
      <ul className="mkb-list">
        {((d && d.rows) || []).map((x) => (
          <li key={x.id}>
            <span className="mkb-grow"><b>{x.name}</b><div className="small-muted">{`When: ${d.triggers[x.trigger.type]}${x.trigger.value ? ` (${x.trigger.value})` : ''} · Then: ${d.actions[x.action.type]}${x.action.value ? ` (${x.action.value})` : ''} · ${x.active ? 'active' : 'not active'} · ran ${x.runs} time(s)`}</div></span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/workflows/${x.id}/run`, { dryRun: true })).then((r) => r && setRes(r.data))}>Dry run</button>
            <button type="button" className="btn btn-sm" disabled={busy || !d.on} onClick={() => run(() => api.post(`${M}/workflows/${x.id}/run`, { dryRun: false })).then((r) => { if (r) { setRes(r.data); w.reload(); } })}>Run now</button>
            <button type="button" className="mkb-link" onClick={() => run(() => api.post(`${M}/workflows`, { id: x.id, name: x.name, trigger: x.trigger, action: x.action, cond: x.cond, active: !x.active })).then(w.reload)}>{x.active ? 'Pause' : 'Make active'}</button>
            <button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/workflows/${x.id}`)).then(w.reload)}>Delete</button>
          </li>
        ))}
      </ul>
      {res && <div className="mkb-pre">{`${res.name} (${res.dryRun ? 'dry run' : 'ran'}): ${res.matched} matched.\n${res.rows.slice(0, 20).map((r) => `${r.label}: ${r.outcome}`).join('\n') || 'Nothing to do.'}`}</div>}
      {d && (
        <div className="mkb-q">
          <b>New rule</b>
          <div className="mkb-row">
            <input className="mkb-grow" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Rule name" />
          </div>
          <div className="mkb-row">
            <span>When</span>
            <select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value, tvalue: '' })} aria-label="When">{Object.entries(d.triggers).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {f.trigger === 'stage_entered' && <select value={f.tvalue} onChange={(e) => setF({ ...f, tvalue: e.target.value })} aria-label="Step"><option value="">Step…</option>{stageList.map((s) => <option key={s.code} value={s.code}>{s.label || s.code}</option>)}</select>}
            {['no_activity', 'doc_expiring'].includes(f.trigger) && <input type="number" style={{ width: 80 }} placeholder="days" value={f.tvalue} onChange={(e) => setF({ ...f, tvalue: e.target.value })} aria-label="Days" />}
          </div>
          <div className="mkb-row">
            <span>Then</span>
            <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, avalue: '' })} aria-label="Then">{Object.entries(d.actions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {f.action === 'add_to_pool' ? <select value={f.avalue} onChange={(e) => setF({ ...f, avalue: e.target.value })} aria-label="Pool"><option value="">Pool…</option>{((pools.data && pools.data.rows) || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              : <input className="mkb-grow" placeholder={f.action === 'add_tag' ? 'Tag' : 'Words (optional)'} value={f.avalue} onChange={(e) => setF({ ...f, avalue: e.target.value })} aria-label="Action value" />}
          </div>
          <div className="mkb-row">
            <label className="small-muted"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (runs only while automations are ON)</label>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`${M}/workflows`, { name: f.name, trigger: { type: f.trigger, value: f.tvalue }, action: { type: f.action, value: f.avalue }, active: f.active }), 'Saved.').then((r) => { if (r) { setF({ ...f, name: '', avalue: '' }); w.reload(); } })}>Save rule</button>
          </div>
        </div>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function GlobalRules() {
  const r = useGet(`${M}/auto-rules?scope=global`);
  const [kind, setKind] = useState('minExp');
  const [value, setValue] = useState('');
  const [dry, setDry] = useState(null);
  const { busy, msg, run } = useRun();
  return (
    <Card title="Auto-reject rules for every job" note={r.data && r.data.on ? 'Auto-reject is ON: new applications (last 30 days, still at New) that break a rule are rejected every 10 minutes; each waits in the review queue.' : 'Auto-reject is OFF (switch under Overview). Rules can be set and dry-run.'}>
      <ul className="mkb-list">{((r.data && r.data.rows) || []).map((x) => <li key={x.id}><span>{`${x.label}${x.kind === 'knockout' ? '' : `: ${x.value}`}`}</span><button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/auto-rules/${x.id}`)).then(r.reload)}>Remove</button></li>)}</ul>
      <div className="mkb-row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Rule">{((r.data && r.data.kinds) || []).map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
        {kind !== 'knockout' && <input type="number" style={{ width: 90 }} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" />}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/auto-rules`, { kind, value, scope: 'global' }), 'Saved.').then(() => { setValue(''); r.reload(); })}>Add rule</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/auto-reject/run`, { dryRun: true })).then((x) => x && setDry(x.data))}>Dry run</button>
      </div>
      {dry && <div className="small-muted">{dry.rows.length ? `Would reject ${dry.rows.length}: ${dry.rows.slice(0, 15).map((x) => `${x.name} (${x.why})`).join('; ')}` : `Nobody would be rejected (${dry.checked || 0} new applications checked).`}</div>}
      <Flash msg={msg} />
    </Card>
  );
}

function DataHealth() {
  const h = useGet(`${M}/data-health`);
  const [now, setNow] = useState(null);
  const { busy, msg, run } = useRun();
  const show = now || (h.data && h.data.runs[0]);
  return (
    <Card title="Data health" note="What is wrong in the candidate data. The safe auto-fix (spaces in names, e-mail case, city case) and the nightly run are switches under Overview (both OFF until you turn them on)." right={<span className="mkb-row"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/data-health/run`, {})).then((r) => r && setNow(r.data))}>Check now</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm('Tidy spaces in names, lowercase e-mails and fix city case now?')) run(() => api.post(`${M}/data-health/run`, { fix: true }), (r) => `${r.data.fixed} people tidied.`).then((r) => r && setNow(r.data)); }}>Check and fix the safe things</button></span>}>
      {show ? (
        <>
          <div className="small-muted">{`${when(show.at)} · ${show.people} people${show.fixed ? ` · ${show.fixed} tidied` : ''}`}</div>
          <ul className="mkb-list">{show.items.map((i) => <li key={i.key}><span className="mkb-grow">{i.label}{i.autoFix && <span className="small-muted"> (auto-fix)</span>}</span><b>{i.count}</b></li>)}</ul>
        </>
      ) : <Empty>Not checked yet.</Empty>}
      <Flash msg={msg} />
    </Card>
  );
}

function ClientPipelines() {
  const list = useGet(`${M}/client-pipelines`);
  const [clients, setClients] = useState([]);
  const [cid, setCid] = useState('');
  const cp = useGet(cid ? `${M}/clients/${cid}/pipeline` : null);
  const [stages, setStages] = useState({});
  const [rounds, setRounds] = useState('');
  const [notes, setNotes] = useState('');
  const { busy, msg, run } = useRun();
  useEffect(() => { api.get('/requirements/client-options').then((r) => setClients(Array.isArray(r.data) ? r.data : [])).catch(() => setClients([])); }, []);
  useEffect(() => { if (cp.data) { setStages(cp.data.stages); setRounds((cp.data.rounds || []).join('\n')); setNotes(cp.data.notes || ''); } }, [cp.data]);
  const set = (code, patch) => setStages({ ...stages, [code]: { ...stages[code], ...patch } });
  return (
    <Card title="Client-specific hiring process" testid="mkb-client-pipeline" note="A client can skip steps or need an approval before a step, and has its own interview rounds. These win over the department's pipeline for that client's jobs. Steps the offer / joining / invoice flows need cannot be switched off.">
      {((list.data && list.data.rows) || []).length > 0 && <div className="mkb-row small-muted">{`Set up for: ${list.data.rows.map((r) => r.name).join(', ')}`}</div>}
      <div className="mkb-row">
        <Combo value={cid} onChange={(e) => setCid(e.target.value)} aria-label="Client">
          <option value="">Pick a client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Combo>
      </div>
      {cid && cp.data && (
        <>
          <div className="table-wrap mkb-table">
            <table className="table">
              <thead><tr><th>Step</th><th>Used</th><th>Approval before it</th></tr></thead>
              <tbody>
                {Object.entries(stages).map(([code, v]) => (
                  <tr key={code}>
                    <td>{cp.data.labels[code] || code}</td>
                    <td><input type="checkbox" checked={v.enabled !== false} disabled={v.mandatory} onChange={(e) => set(code, { enabled: e.target.checked })} aria-label={`Use ${code}`} /></td>
                    <td><select value={v.approverRole || ''} onChange={(e) => set(code, { approverRole: e.target.value || null })} aria-label={`Approval for ${code}`}><option value="">None</option>{cp.data.approvers.map((a) => <option key={a} value={a}>{a}</option>)}</select></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="small-muted" htmlFor="mkb-rounds">Interview rounds (one per line)</label>
          <textarea id="mkb-rounds" rows={3} style={{ width: '100%' }} value={rounds} onChange={(e) => setRounds(e.target.value)} />
          <label className="small-muted" htmlFor="mkb-cnotes">Notes for the team (documents, dress code, who interviews)</label>
          <textarea id="mkb-cnotes" rows={3} style={{ width: '100%' }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put(`${M}/clients/${cid}/pipeline`, { stages, rounds: rounds.split('\n'), notes }), 'Saved for this client.').then(list.reload)}>Save</button>
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

const SITES = ['TeamLink Job Portal', 'TeamLink Website', 'Google Jobs', 'Naukri', 'Indeed', 'LinkedIn', 'Shine', 'Facebook', 'WhatsApp', 'Instagram', 'X'];
function PostingRules() {
  const r = useGet(`${M}/posting-rules`);
  const [clients, setClients] = useState([]);
  const [f, setF] = useState({ name: '', department: '', clientId: '', employmentType: '', sources: [] });
  const { busy, msg, run } = useRun();
  useEffect(() => { api.get('/requirements/client-options').then((x) => setClients(Array.isArray(x.data) ? x.data : [])).catch(() => {}); }, []);
  return (
    <Card title="Posting rules" testid="mkb-posting" note="Which sites a job is posted to, by department, client and job type. The most specific rule wins (client, then department, then job type). The requirement's Hiring tools tab offers the rule's sites.">
      <ul className="mkb-list">{((r.data && r.data.rows) || []).map((x) => <li key={x.id}><span className="mkb-grow"><b>{x.name}</b><div className="small-muted">{`${[x.clientName && `client ${x.clientName}`, x.department && `department ${x.department}`, x.employmentType].filter(Boolean).join(' · ')} -> ${x.sources.join(', ')}`}</div></span><button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/posting-rules/${x.id}`)).then(r.reload)}>Delete</button></li>)}</ul>
      <div className="mkb-q">
        <div className="mkb-row">
          <input placeholder="Rule name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Rule name" />
          <input placeholder="Department (e.g. Medical)" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} aria-label="Department" />
          <select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} aria-label="Client"><option value="">Any client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select value={f.employmentType} onChange={(e) => setF({ ...f, employmentType: e.target.value })} aria-label="Job type"><option value="">Any job type</option>{['Full Time', 'Part Time', 'Contract', 'Internship', 'Temporary'].map((t) => <option key={t}>{t}</option>)}</select>
        </div>
        <div className="mkb-row">{SITES.map((s) => <label key={s} className="small-muted"><input type="checkbox" checked={f.sources.includes(s)} onChange={(e) => setF({ ...f, sources: e.target.checked ? [...f.sources, s] : f.sources.filter((x) => x !== s) })} />{` ${s}`}</label>)}</div>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`${M}/posting-rules`, f), 'Saved.').then((x) => { if (x) { setF({ name: '', department: '', clientId: '', employmentType: '', sources: [] }); r.reload(); } })}>Save rule</button>
      </div>
      <Flash msg={msg} />
    </Card>
  );
}

function FieldParsing() {
  const r = useGet(`${M}/field-rules`);
  const [f, setF] = useState({ fieldId: '', method: 'label', pattern: '' });
  const { busy, msg, run } = useRun();
  const d = r.data;
  const M_LABEL = { label: 'A label in the resume ("Blood group: O+")', pattern: 'A pattern (regular expression)', list: 'One of the field\'s choices found in the text', ai: 'Ask the AI (masked)' };
  return (
    <Card title="Custom-field parsing" testid="mkb-fields" note="Teach the resume reader your own fields (made in Administration > Candidate fields). On a candidate's Hiring tools tab the values found are offered; a person saves them.">
      <ul className="mkb-list">{((d && d.rules) || []).map((x) => <li key={x.id}><span className="mkb-grow"><b>{x.label}</b><div className="small-muted">{`${M_LABEL[x.method]}${x.pattern ? `: ${x.pattern}` : ''}`}</div></span><button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/field-rules/${x.id}`)).then(r.reload)}>Delete</button></li>)}</ul>
      {d && !d.fields.length && <Empty>No custom fields yet: add them in Administration &gt; Candidate fields.</Empty>}
      {d && d.fields.length > 0 && (
        <div className="mkb-row">
          <select value={f.fieldId} onChange={(e) => setF({ ...f, fieldId: e.target.value })} aria-label="Field"><option value="">Field…</option>{d.fields.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} aria-label="How">{d.methods.map((m) => <option key={m} value={m}>{M_LABEL[m]}</option>)}</select>
          {f.method !== 'list' && <input className="mkb-grow" placeholder={f.method === 'label' ? 'Label in the resume (empty = the field name)' : f.method === 'pattern' ? 'e.g. Blood group\\s*:\\s*(\\S+)' : 'Hint for the AI (optional)'} value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} aria-label="Pattern" />}
          <button type="button" className="btn btn-sm" disabled={busy || !f.fieldId} onClick={() => run(() => api.post(`${M}/field-rules`, f), 'Saved.').then((x) => { if (x) { setF({ fieldId: '', method: 'label', pattern: '' }); r.reload(); } })}>Add</button>
        </div>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function Ocr() {
  const o = useGet(`${M}/ocr`);
  const { busy, msg, run } = useRun();
  const d = o.data;
  return (
    <Card title="Scanned resumes" testid="mkb-ocr" note="Resumes saved before OCR was installed (a scan or a photo with no text) can be read again, a few at a time.">
      {d && (
        <>
          <Chips items={[{ key: 'w', label: 'Waiting', value: String(d.waiting) }, { key: 'o', label: 'OCR on this server', value: d.ocr.available ? `installed (${(d.ocr.languages || []).join(', ')})` : 'not installed (docs/OCR-SETUP.md)' }]} />
          <button type="button" className="btn btn-sm" disabled={busy || !d.waiting} onClick={() => run(() => api.post(`${M}/ocr/rerun`, { limit: 10 }), (r) => (r.data.notInstalled ? r.data.message : `${r.data.read} of ${r.data.done} read.`)).then(o.reload)}>Read 10 now</button>
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function Mcp() {
  const m = useGet(`${M}/mcp`);
  const [made, setMade] = useState(null);
  const [label, setLabel] = useState('');
  const { busy, msg, run } = useRun();
  const d = m.data;
  return (
    <Card title="MCP server (read-only access for AI tools)" testid="mkb-mcp" note="An AI tool (Claude Desktop, an IDE agent) can search people and read requirements with a token, seeing only what the token's own login may see; contact details are never returned. It can add a note, add a follow-up or move a step only when an Admin turns on the MCP write tools (Sourcing & AI connectors), and only where the token's own login may. Turn it on under Overview.">
      {d && (
        <>
          <Chips items={[{ key: 's', label: 'Status', value: d.on ? 'ON' : 'OFF' }, { key: 'e', label: 'Address', value: `${window.location.origin}/api${d.endpoint.replace(/^\/api/, '')}` }]} />
          <div className="small-muted">{`Tools: ${d.tools.map((t) => t.name).join(', ')}`}</div>
          <div className="mkb-row">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Token name (e.g. My Claude Desktop)" aria-label="Token name" />
            <button type="button" className="btn btn-sm" disabled={busy || !d.on} onClick={() => run(() => api.post(`${M}/mcp/tokens`, { label })).then((r) => { if (r) { setMade(r.data); m.reload(); } })}>Make my token</button>
          </div>
          {made && <div className="mkb-pre">{`${made.token}\n${made.note}`}</div>}
          <ul className="mkb-list">{d.tokens.map((t) => <li key={t.id}><span className="mkb-grow">{t.label}<div className="small-muted">{`made ${day(t.createdAt)} · last used ${t.lastUsedAt ? when(t.lastUsedAt) : 'never'}${t.revokedAt ? ' · revoked' : ''}`}</div></span>{!t.revokedAt && <button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/mcp/tokens/${t.id}`), 'Revoked.').then(m.reload)}>Revoke</button>}</li>)}</ul>
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

export default function AiGovernance() {
  const [tab, setTab] = useState(() => { try { return new URLSearchParams(window.location.search).get('tab') || 'overview'; } catch { return 'overview'; } });
  return (
    <div data-testid="mkb-gov">
      <h1 style={{ margin: '0 0 4px' }}>AI governance &amp; automation</h1>
      <p className="small-muted" style={{ marginTop: 0 }}>Every AI call, what it was for, and the rules and automations of the ATS. Changes are Super Admin / Admin only.</p>
      <TabStrip label="AI governance" value={TABS.some((t) => t.key === tab) ? tab : 'overview'} onChange={setTab} maxMain={5} tabs={TABS} />
      {tab === 'overview' && <Overview />}
      {tab === 'calls' && <Calls />}
      {tab === 'flags' && <Flags />}
      {tab === 'compliance' && <Compliance />}
      {tab === 'automations' && <><Workflows /><GlobalRules /><DataHealth /></>}
      {tab === 'clients' && <ClientPipelines />}
      {tab === 'posting' && <PostingRules />}
      {tab === 'fields' && <FieldParsing />}
      {tab === 'ocr' && <Ocr />}
      {tab === 'mcp' && <Mcp />}
      {tab === 'sourcingY' && <SourcingAdminY />}
    </div>
  );
}

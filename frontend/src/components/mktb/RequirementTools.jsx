import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import {
  M, Card, Chips, Flash, FlagAi, Empty, useGet, useRun, when,
} from './kit.jsx';

// ---------------------------------------------------------------------------
// REQUIREMENT PAGE > More > Hiring tools (market wave B): screening questions (02.10), skills from the JD (02.12), the always-on
// search (02.14), rediscovery (09.05), the posting rule (02.16), auto-reject rules of this job (04.09), the client's own hiring
// process (02.09) and the agents for this job (09.08 / 09.09). Saving skills / sites goes through the normal requirement edit
// (PUT /requirements/:id), so the usual review and rights apply.
// ---------------------------------------------------------------------------
const TYPES = [['yesno', 'Yes / No'], ['number', 'Number'], ['choice', 'Pick one'], ['text', 'Text']];

function ScreeningEditor({ job, data, onSaved, mayEdit }) {
  const [qs, setQs] = useState(() => (data.questions || []).map((q) => ({ ...q, options: (q.options || []).join(', ') })));
  const [action, setAction] = useState(data.action || 'flag');
  const { busy, msg, run } = useRun();
  const set = (i, patch) => setQs(qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const save = () => run(() => api.put(`${M}/jobs/${job.id}/screening`, {
    action,
    questions: qs.map((q, i) => ({ id: q.id || `q${i + 1}`, text: q.text, type: q.type, options: q.options, required: q.required !== false, knockout: q.koOn ? { op: q.koOp || (q.type === 'number' ? 'min' : q.type === 'choice' ? 'in' : 'eq'), value: q.koValue } : null })),
  }), 'Saved. The job portal form asks these now.').then((r) => { if (r) onSaved(); });
  useEffect(() => {
    setQs((data.questions || []).map((q) => ({ ...q, options: (q.options || []).join(', '), koOn: !!q.knockout, koOp: q.knockout && q.knockout.op, koValue: q.knockout ? (Array.isArray(q.knockout.value) ? q.knockout.value.join(', ') : q.knockout.value) : '' })));
  }, [data]);
  return (
    <Card title="Screening questions" testid="mkb-screening" note="Asked on the job portal when a person applies, or typed in by you after a call. A knockout answer flags the application; choose On hold to also pause it (it then waits in the review queue, where it can be undone).">
      {qs.map((q, i) => (
        <div className="mkb-q" key={q.id || i}>
          <div className="mkb-row">
            <input className="mkb-grow" value={q.text} disabled={!mayEdit} placeholder="Question, e.g. Do you have a valid nursing registration?" aria-label={`Question ${i + 1}`} onChange={(e) => set(i, { text: e.target.value })} />
            <select value={q.type} disabled={!mayEdit} aria-label="Answer type" onChange={(e) => set(i, { type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            {mayEdit && <button type="button" className="mkb-link" onClick={() => setQs(qs.filter((_, j) => j !== i))}>Remove</button>}
          </div>
          {q.type === 'choice' && <input value={q.options} disabled={!mayEdit} placeholder="Choices, separated by commas" aria-label="Choices" onChange={(e) => set(i, { options: e.target.value })} />}
          <label className="mkb-row small-muted">
            <input type="checkbox" checked={!!q.koOn} disabled={!mayEdit} onChange={(e) => set(i, { koOn: e.target.checked })} />
            Knockout: the answer must be
            {q.koOn && q.type === 'yesno' && <select value={q.koValue || 'yes'} onChange={(e) => set(i, { koValue: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select>}
            {q.koOn && q.type === 'number' && (
              <>
                <select value={q.koOp || 'min'} onChange={(e) => set(i, { koOp: e.target.value })}><option value="min">at least</option><option value="max">at most</option></select>
                <input type="number" style={{ width: 90 }} value={q.koValue || ''} onChange={(e) => set(i, { koValue: e.target.value })} aria-label="Knockout number" />
              </>
            )}
            {q.koOn && q.type === 'choice' && <input value={q.koValue || ''} placeholder="Allowed choices" onChange={(e) => set(i, { koValue: e.target.value })} aria-label="Allowed choices" />}
            {q.koOn && q.type === 'text' && <span>(text answers have no knockout)</span>}
          </label>
        </div>
      ))}
      {mayEdit && (
        <div className="mkb-row">
          <button type="button" className="btn btn-sm" onClick={() => setQs([...qs, { text: '', type: 'yesno', required: true }])}>Add a question</button>
          <label className="small-muted">On a knockout answer:
            {' '}
            <select value={action} onChange={(e) => setAction(e.target.value)}><option value="flag">Flag only</option><option value="hold">Flag and put On hold</option></select>
          </label>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>Save questions</button>
        </div>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function Answers({ job }) {
  const a = useGet(`${M}/jobs/${job.id}/screening/answers`);
  const rows = (a.data && a.data.rows) || [];
  if (!rows.length) return null;
  return (
    <Card title={`Screening answers (${rows.length})`} note="Answers from the job portal and from calls. Red = failed a knockout question.">
      <ul className="mkb-list">
        {rows.map((r) => (
          <li key={r.applicationId}>
            <Link to={`/candidates/${r.candidateId}`}>{r.name}</Link>
            {r.failed.length ? <span className="mkb-chip bad">{`Failed: ${r.failed.map((f) => f.text).join('; ')}`}</span> : <span className="mkb-chip good">Passed</span>}
            <span className="small-muted">{`${r.source} · ${when(r.at)}`}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SkillsFromJd({ job, onChanged, mayEdit }) {
  const [out, setOut] = useState(null);
  const { busy, msg, run } = useRun();
  const read = () => run(() => api.post(`${M}/jobs/${job.id}/extract-skills`, { useAi: true })).then((r) => r && setOut(r.data));
  const use = () => run(() => api.put(`/requirements/${job.id}`, { skills: out.mandatory.join(', '), goodToHaveSkills: out.goodToHave.join(', ') }), 'Saved on the requirement (a live job may wait for the BDE TL, as with any edit).').then((r) => { if (r) onChanged && onChanged(); });
  return (
    <Card title="Skills from the job description" note="Reads the description and splits must-have from good-to-have skills. Check them before you save.">
      <div className="mkb-row"><button type="button" className="btn btn-sm" disabled={busy} onClick={read}>Read skills from the description</button></div>
      {out && (
        <>
          <Chips items={[{ key: 'm', label: 'Must have', value: out.mandatory.join(', ') || '-' }, { key: 'g', label: 'Good to have', value: out.goodToHave.join(', ') || '-' }]} />
          <div className="mkb-row small-muted">{out.source === 'rules+ai' ? 'Read by the rules and checked by the AI.' : 'Read by the rules (the AI did not answer).'}</div>
          <div className="mkb-row">
            {mayEdit && <button type="button" className="btn btn-sm btn-primary" disabled={busy || !out.mandatory.length} onClick={use}>Use these skills</button>}
            <FlagAi feature="Skills from JD" refType="Requirement" refId={job.id} output={JSON.stringify(out)} />
          </div>
        </>
      )}
      <Flash msg={msg} />
    </Card>
  );
}

function PeopleList({ rows, why }) {
  if (!rows.length) return <Empty>Nobody yet.</Empty>;
  return (
    <ul className="mkb-list">
      {rows.map((r) => (
        <li key={r.id}>
          <span>
            <Link to={`/candidates/${r.id}`}>{r.name}</Link>
            {r.isNew && <span className="mkb-chip new" style={{ marginLeft: 6 }}>New</span>}
            <div className="small-muted">{[r.designation, r.experienceYears != null ? `${r.experienceYears} yrs` : null, r.location, why && r.why].filter(Boolean).join(' · ')}</div>
          </span>
          <b>{`${r.score != null ? r.score : r.fit}%`}</b>
        </li>
      ))}
    </ul>
  );
}

function Watch({ job }) {
  const [data, setData] = useState(null);
  const { busy, msg, run } = useRun();
  const load = (seen) => run(() => api.get(`${M}/jobs/${job.id}/watch${seen ? '?seen=1' : ''}`)).then((r) => r && setData(r.data));
  useEffect(() => { load(false); }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title="Always-on search" testid="mkb-watch" note="This job keeps its own search of the database. People who match since you last looked are marked New." right={data && <span className="small-muted">{`${data.total} match · ${data.newCount} new`}</span>}>
      {data && <PeopleList rows={data.rows} />}
      <div className="mkb-row">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => load(false)}>Look again</button>
        {data && data.newCount > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => load(true)}>Mark all as seen</button>}
      </div>
      <Flash msg={msg} />
    </Card>
  );
}

function Rediscover({ job }) {
  const [data, setData] = useState(null);
  const { busy, msg, run } = useRun();
  return (
    <Card title="Rediscover past candidates" note="People already on file who did well before (shared with a client, interviewed, selected) or went quiet, ranked by fit for this job.">
      <div className="mkb-row"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.get(`${M}/jobs/${job.id}/rediscover`)).then((r) => r && setData(r.data))}>Find them</button></div>
      {data && <PeopleList rows={data.rows} why />}
      <Flash msg={msg} />
    </Card>
  );
}

function PostingRule({ job, rule, onChanged, mayEdit }) {
  const { busy, msg, run } = useRun();
  if (!rule) return null;
  const same = rule.rule && rule.rule.sources.join(',') === rule.current.join(',');
  return (
    <Card title="Where to post (posting rule)" note={rule.why}>
      <Chips items={[{ key: 'c', label: 'Posted on now', value: rule.current.join(', ') || 'nothing' }, ...(rule.rule ? [{ key: 'r', label: 'The rule says', value: rule.rule.sources.join(', ') }] : [])]} />
      {rule.rule && !same && mayEdit && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put(`/requirements/${job.id}`, { postingSources: rule.rule.sources.join(',') }), 'The sites of the rule are ticked. Post from the Postings tab.').then((r) => { if (r) onChanged && onChanged(); })}>Use the rule&apos;s sites</button>}
      <Flash msg={msg} />
    </Card>
  );
}

function AutoRules({ job, rules, kinds, on, onSaved, lead }) {
  const [kind, setKind] = useState('minExp');
  const [value, setValue] = useState('');
  const [dry, setDry] = useState(null);
  const { busy, msg, run } = useRun();
  return (
    <Card title="Auto-reject rules for this job" note={on ? 'Auto-reject is ON (Admin). New applications that break a rule are rejected and wait in the review queue, where they can be undone.' : 'Auto-reject is OFF (the Admin turns it on). You can still set rules and see who they would reject.'}>
      <ul className="mkb-list">
        {rules.map((r) => <li key={r.id}><span>{`${r.label}${r.kind === 'knockout' ? '' : `: ${r.value}`}`}</span>{lead && <button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${M}/auto-rules/${r.id}`)).then(onSaved)}>Remove</button>}</li>)}
        {!rules.length && <li className="small-muted">No rules for this job.</li>}
      </ul>
      {lead && (
        <div className="mkb-row">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Rule">{(kinds || []).map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
          {kind !== 'knockout' && <input type="number" style={{ width: 90 }} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Rule value" />}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/auto-rules`, { kind, value, scope: job.id }), 'Rule saved.').then((r) => { if (r) { setValue(''); onSaved(); } })}>Add rule</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/auto-reject/run`, { dryRun: true, requirementId: job.id })).then((r) => r && setDry(r.data))}>Dry run</button>
        </div>
      )}
      {dry && <div className="small-muted">{dry.rows.length ? `Would reject: ${dry.rows.map((r) => `${r.name} (${r.why})`).join('; ')}` : 'Nobody would be rejected right now.'}</div>}
      <Flash msg={msg} />
    </Card>
  );
}

function Agents({ job }) {
  const [last, setLast] = useState(null);
  const { busy, msg, run } = useRun();
  const go = (kind) => run(() => api.post(`${M}/agents/run`, { kind, requirementId: job.id })).then((r) => r && setLast(r.data));
  return (
    <Card title="Agents for this job" note="An agent only PROPOSES. You approve each step in Candidates > Hiring tools > Agents; nothing is sent to anyone.">
      <div className="mkb-row">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => go('submission')}>Draft submission notes</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => go('followup')}>Find who needs a follow-up</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => go('playbook')}>Rediscover, review and propose</button>
      </div>
      {last && <div className="small-muted">{`${last.kind}: ${last.actions.length} action(s) waiting for approval. `}<Link to="/candidates?view=tools&tool=agents">Open the agents</Link></div>}
      <Flash msg={msg} />
    </Card>
  );
}

export default function RequirementTools({ job, onChanged }) {
  const ov = useGet(`${M}/jobs/${job.id}/overview`);
  const kinds = useKinds();
  if (ov.error) return <div className="notice">{ov.error}</div>;
  if (!ov.data) return <div className="small-muted">Loading…</div>;
  const d = ov.data;
  return (
    <div className="mkb-tools" data-testid="mkb-req-tools">
      {d.clientProcess && (d.clientProcess.rounds.length > 0 || d.clientProcess.notes) && (
        <Card title={`${d.requirement.clientName || 'Client'}: hiring process`} note="Set by the Admin for this client (Administration > AI governance > Client pipelines).">
          {d.clientProcess.rounds.length > 0 && <div className="mkb-row">{d.clientProcess.rounds.map((r, i) => <span key={r} className="mkb-chip">{`${i + 1}. ${r}`}</span>)}</div>}
          {d.clientProcess.notes && <div className="mkb-pre">{d.clientProcess.notes}</div>}
        </Card>
      )}
      <ScreeningEditor job={job} data={d.screening} mayEdit={d.may.edit} onSaved={ov.reload} />
      <Answers job={job} />
      <div className="mkb-two">
        <SkillsFromJd job={job} onChanged={onChanged} mayEdit={d.may.edit} />
        <PostingRule job={job} rule={d.postingRule} onChanged={onChanged} mayEdit={d.may.edit} />
      </div>
      {!d.may.bde && <Watch job={job} />}
      {!d.may.bde && <Rediscover job={job} />}
      <AutoRules job={job} rules={d.autoRules} kinds={kinds} on={d.autoRejectOn} lead={d.may.lead} onSaved={ov.reload} />
      {d.may.edit && <Agents job={job} />}
    </div>
  );
}

function useKinds() {
  const k = useGet(`${M}/auto-rules?scope=none`);
  return (k.data && k.data.kinds) || [];
}

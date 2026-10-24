import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useJobPublish } from '../jobpublish/JobPortalRows.jsx';
import { PortalChip, portalState } from '../jobpublish/PublishChips.jsx';
import NeedsHelp from '../jobpublish/NeedsHelp.jsx';
import { jp, jpError } from '../jobpublish/jpKit.js';
import ApiPortalSetup from './ApiPortalSetup.jsx';
import {
  dx, dxError, isNotMigrated, NOT_ON_WORDS, KIND_WORDS, KIND_HINT, copyText, fmtDate, fmtDateTime, localInput, dateInput, plusDays,
} from './distKit.js';
import '../jobpublish/jobpublish.css';
import './jobdist.css';

// ---------------------------------------------------------------------------
// THE "DISTRIBUTE" TAB OF A JOB (inside the job page; no sidebar entry).
// Every place a job can go is a card:
//   automatic         Own job portal, Google for Jobs, the feed, Telegram, Facebook (the honest chips of the posting engine)
//   copy and post     LinkedIn, Indeed, Naukri, Shine, Foundit, Apna, WorkIndia, Freshersworld, Quikr, OLX, NCS, WhatsApp:
//                     READY TEXT (edit it, Reset to auto), [Copy text], [Open <site>], ITS OWN TRACKED APPLY LINK, [Mark as posted]
//   by hand           College placement cells, Employee referral: the same text and link to send yourself
// A place a person marked is shown as "Posted by <name> (not checked by the system)". Nothing here posts to a job site:
// the automatic ones go through the existing posting engine (/api/job-publish), only when an Admin switched them ON.
// <DistributeTab job={requirement} onChanged />
// ---------------------------------------------------------------------------
const ICON = { green: '✔', blue: '⟳', yellow: '!', red: '✖', grey: '○' };
const Chip = ({ s, label }) => (s ? (
  <span className={`jp-chip jp-${s.tone}`} title={s.detail || undefined}>
    <span aria-hidden="true" className="jp-chip-i">{ICON[s.tone] || '○'}</span>
    <span>{label ? `${label}: ${s.label}` : s.label}</span>
  </span>
) : null);

function MarkForm({ card, user, initial, onSaved, onCancel }) {
  const days = card.expiryDays || 30;
  const [f, setF] = useState(() => ({
    postUrl: (initial && initial.postUrl) || '',
    postedAt: initial && initial.postedAt ? localInput(new Date(initial.postedAt)) : localInput(),
    postedBy: (initial && initial.postedByName) || (user && user.name) || '',
    expiresAt: initial && initial.expiresAt ? dateInput(new Date(initial.expiresAt)) : dateInput(plusDays(days)),
    noExpiry: !!(initial && initial.id && !initial.expiresAt),
    notes: (initial && initial.notes) || '',
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const body = {
        postUrl: f.postUrl.trim(), postedAt: f.postedAt ? new Date(f.postedAt).toISOString() : undefined, postedBy: f.postedBy.trim(), notes: f.notes.trim(), keepText: true,
        ...(f.noExpiry ? { noExpiry: true } : { expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:00`).toISOString() : undefined }),
      };
      const out = await dx.post(`/jobs/${card.jobId}/platforms/${card.key}/posted`, body);
      onSaved(out.ok);
    } catch (x) { setErr(dxError(x)); } finally { setBusy(false); }
  }
  return (
    <form className="dx-form" onSubmit={submit} aria-label={`Mark as posted on ${card.name}`}>
      <b>{`Mark as posted on ${card.name}`}</b>
      <div className="row">
        <label>Link of your post{card.postUrl ? '' : ' (if there is one)'}<input type="url" inputMode="url" value={f.postUrl} placeholder="https://..." onChange={(e) => set('postUrl', e.target.value)} /></label>
        <label>Date and time<input type="datetime-local" value={f.postedAt} onChange={(e) => set('postedAt', e.target.value)} /></label>
        <label>Posted by<input value={f.postedBy} onChange={(e) => set('postedBy', e.target.value)} /></label>
      </div>
      <div className="row">
        <label>Expires on<input type="date" value={f.expiresAt} disabled={f.noExpiry} onChange={(e) => set('expiresAt', e.target.value)} /></label>
        <label className="chk"><input type="checkbox" checked={f.noExpiry} onChange={(e) => set('noExpiry', e.target.checked)} /> It has no expiry date</label>
      </div>
      <label>Notes (only the team sees this)<textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      <p className="dx-hint" style={{ margin: 0 }}>{`TeamLink cannot look inside ${card.name}, so it will show this as "Posted by ${f.postedBy || 'you'} (not checked by the system)". We remind you before it expires.`}</p>
      {err && <div className="dx-err" role="alert">{err}</div>}
      <div className="dx-acts">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function KitBox({ card, can, onChanged, flash }) {
  const k = card.kit;
  const [draft, setDraft] = useState(k.text);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { setDraft(k.text); }, [k.text]);
  const dirty = draft.trim() !== k.text.trim();
  const over = card.maxChars && draft.length > card.maxChars;
  const lostLink = !draft.includes(k.link);
  async function run(key, fn, ok) {
    setBusy(key); setErr('');
    try { await fn(); flash(ok); await onChanged(); } catch (e) { setErr(dxError(e)); } finally { setBusy(''); }
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {card.format === 'jd' && k.title && (
        <div className="dx-link"><span>Title:</span><b style={{ color: '#1d2a3d' }}>{k.title}</b>
          <button type="button" className="btn btn-sm" onClick={async () => flash((await copyText(k.title)) ? 'Title copied.' : 'Could not copy. Select it and copy by hand.')}>Copy title</button>
        </div>
      )}
      <textarea className="dx-text" aria-label={`Ready text for ${card.name}`} value={draft} readOnly={!can.edit} onChange={(e) => setDraft(e.target.value)} />
      <div className="dx-meter">
        <span className={over ? 'over' : ''}>{`${draft.length}${card.maxChars ? ` of ${card.maxChars}` : ''} characters${over ? `: ${draft.length - card.maxChars} too many` : ''}`}</span>
        <span>{k.overridden ? `Edited${k.savedBy ? ` by ${k.savedBy}` : ''}${k.stale ? ': the requirement changed since' : ''}` : 'Written by TeamLink from the requirement'}</span>
      </div>
      {k.notes && k.notes.length > 0 && <div className="dx-hint">{k.notes.join(' ')}</div>}
      {k.blanks > 0 && <div className="dx-warn">{`${k.blanks} spot${k.blanks === 1 ? ' is' : 's are'} still blank [ ]. Fill in ${k.missing.map((m) => m.label.toLowerCase()).join(', ') || 'the missing details'} in the requirement first, then come back.`}</div>}
      {lostLink && <div className="dx-warn">This text has lost its tracking link. Without it we cannot tell how many people came from here. Put the link back, or press Reset to auto.</div>}
      {k.stale && <div className="dx-warn">The requirement changed after this text was edited. Press Reset to auto to get the new text, or keep your edit.</div>}
      <div className="dx-link"><span>Apply link for {card.name}:</span><code>{k.link}</code>
        <button type="button" className="btn btn-sm" onClick={async () => flash((await copyText(k.link)) ? 'Link copied.' : 'Could not copy. Select it and copy by hand.')}>Copy link</button>
      </div>
      <div className="dx-acts">
        <button type="button" className="btn btn-primary" onClick={async () => flash((await copyText(draft)) ? 'Text copied. Now paste it on the site.' : 'Could not copy. Select the text and copy by hand.')}>Copy text</button>
        {card.postUrl && can.edit && <a className="btn" href={card.postUrl} target="_blank" rel="noopener noreferrer">{`Open ${card.name}`}</a>}
        {can.edit && dirty && <button type="button" className="btn btn-sm" disabled={busy === 'save'} onClick={() => run('save', () => dx.put(`/jobs/${card.jobId}/platforms/${card.key}/text`, { text: draft, title: k.title }), 'Saved. Your edit is kept for this requirement.')}>Save my edit</button>}
        {can.edit && (k.overridden || dirty) && <button type="button" className="btn btn-sm" disabled={busy === 'reset'} onClick={() => run('reset', () => dx.del(`/jobs/${card.jobId}/platforms/${card.key}/text`), 'Back to the text TeamLink wrote.')}>Reset to auto</button>}
      </div>
      {err && <div className="dx-err" role="alert">{err}</div>}
    </div>
  );
}

function Card({ card, job, can, user, engineData, onChanged, flash }) {
  const [mark, setMark] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const c = { ...card, jobId: job.id };
  const posting = card.posting;
  const eng = card.engine ? ((engineData.status && engineData.status.portals) || []).find((p) => p.portal === card.engine) : null;
  const info = card.engine ? (engineData.infos || []).find((p) => p.portal === card.engine) : null;
  const es = card.engine ? portalState({ posting: eng, info }) : null;
  const engineLive = !!(eng && eng.status && eng.status !== 'DRAFT');
  const isApi = ['telegram', 'facebook'].includes(card.key);
  const s = card.state;
  const klass = s ? (s.key === 'EXPIRED' ? ' is-expired' : s.key === 'EXPIRING' ? ' is-soon' : ['POSTED', 'AUTO_ON'].includes(s.key) ? ' is-posted' : '') : (es && es.key === 'PUBLISHED' ? ' is-posted' : '');

  async function engineRun(action, label, dryRun = false) {
    setBusy(label); setErr('');
    try {
      const out = await jp.post(`/jobs/${job.id}/${action}`, { portals: [card.engine], dryRun });
      const r = out && out.results && out.results[0];
      flash(r ? `${card.name}: ${r.reason || 'Done.'}` : 'Done.');
      await engineData.reload();
      await onChanged();
    } catch (e) { setErr(jpError(e)); } finally { setBusy(''); }
  }
  async function dxRun(key, fn, ok) {
    setBusy(key); setErr('');
    try { await fn(); flash(ok); await onChanged(); } catch (e) { setErr(dxError(e)); } finally { setBusy(''); }
  }
  const lq = eng && eng.lastQueue;
  const needsHelp = eng && lq && (lq.waiting || (lq.status === 'NEEDS_HUMAN' && lq.help));

  return (
    <article className={`dx-card${klass}`} aria-label={card.name}>
      <div className="dx-head">
        <b>{card.name}</b>
        <span className={`dx-tag ${card.kind}`} title={KIND_HINT[card.kind]}>{KIND_WORDS[card.kind]}</span>
        <span style={{ flex: 1 }} />
        {s && <Chip s={s} />}
        {!s && es && <PortalChip state={es} />}
        {card.kind !== 'auto' && es && engineLive && <PortalChip state={es} label="By TeamLink" />}
      </div>
      {s && s.detail && s.key !== 'POSTED' && <div className="dx-hint">{s.detail}</div>}
      {s && s.key === 'POSTED' && posting && <div className="dx-hint">{posting.state.detail}</div>}
      {card.formatHint && card.kind !== 'auto' && <div className="dx-hint">{card.formatHint}</div>}
      {card.kind === 'auto' && !isApi && <div className="dx-hint">{card.key === 'career' ? 'Goes live at once on our careers page and the Job Portal. Press Post this requirement in "Job posting status" on the Overview, or here.' : card.formatHint}</div>}
      {isApi && <div className="dx-hint">{card.formatHint}</div>}

      {card.key === 'career' && (
        <div className="dx-acts">
          <span className="dx-count">{job.listed ? 'The requirement is live on our careers page.' : 'The requirement is not on our careers page yet.'}</span>
          {can.post && !job.listed && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => engineRun('publish', 'career')}>Put it on the careers page</button>}
        </div>
      )}
      {card.key === 'google' && card.indexing && card.indexing.canTell && (
        <div className="dx-acts"><button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => dxRun('g', () => dx.post(`/jobs/${job.id}/google-indexing`, {}), 'Google was told about this requirement page.')}>Tell Google now</button></div>
      )}

      {needsHelp && <NeedsHelp item={lq} name={card.name} canPost={can.post} onChanged={async () => { await engineData.reload(); await onChanged(); }} />}

      {isApi && card.kit && (
        <>
          {es && ['NOT_CONNECTED', 'OFF'].includes(es.key) && (can.post || can.admin) && (
            <ApiPortalSetup portal={card.key} isAdmin={can.admin} canPoster={can.post} compact onChanged={async () => { await engineData.reload(); await onChanged(); }} />
          )}
          <KitBox card={c} can={can} onChanged={onChanged} flash={flash} />
          {can.post && (
            <div className="dx-acts">
              {!(eng && eng.status === 'PUBLISHED') && <button type="button" className="btn btn-primary" disabled={!!busy || (es && es.key !== 'READY' && es.key !== 'FAILED')} onClick={() => engineRun('publish', 'post')} title="Posts once. Posting the same requirement again does nothing.">{busy === 'post' ? 'Posting...' : `Post to ${card.name}`}</button>}
              {eng && eng.status === 'PUBLISHED' && <button type="button" className="btn" disabled={!!busy} onClick={() => engineRun('update', 'update')} title="Changes the message that is already there. It does not post a second time.">Post update</button>}
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => engineRun('publish', 'dry', true)} title="Builds the message and shows it. Nothing is sent.">Check only (dry run)</button>
              {lq && lq.status === 'DEAD' || (eng && eng.status === 'FAILED' && lq && lq.id) ? <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={async () => { setBusy('retry'); try { await jp.post(`/queue/${lq.id}/retry`); await engineData.reload(); } catch (e) { setErr(jpError(e)); } finally { setBusy(''); } }}>Retry</button> : null}
              {eng && eng.status === 'PUBLISHED' && eng.portalUrl && <a className="btn btn-sm" href={eng.portalUrl} target="_blank" rel="noopener noreferrer">See the post</a>}
            </div>
          )}
          {eng && eng.status === 'PUBLISHED' && job.status === 'CLOSED' && <div className="dx-warn">This requirement is closed. The message stays in the {card.key === 'telegram' ? 'channel' : 'page'} unless you delete it there.</div>}
          {lq && lq.dryRun && lq.status === 'SUCCEEDED' && lq.result && lq.result.note && <details><summary className="dx-hint" style={{ cursor: 'pointer' }}>Last dry run: nothing was sent. See the message</summary><pre className="jp-pre" style={{ whiteSpace: 'pre-wrap' }}>{lq.result.note}</pre></details>}
        </>
      )}

      {!isApi && card.kit && <KitBox card={c} can={can} onChanged={onChanged} flash={flash} />}

      {card.kind !== 'auto' && (
        <>
          {posting && posting.state.key !== 'TAKEN_DOWN' && (
            <div className="dx-link">
              {posting.postUrl && <a href={posting.postUrl} target="_blank" rel="noopener noreferrer">See your post</a>}
              <span>{`Marked ${fmtDateTime(posting.postedAt)}${posting.expiresAt ? ` · expires ${fmtDate(posting.expiresAt)}` : ''}`}</span>
              {posting.notes && <span>{`· ${posting.notes}`}</span>}
            </div>
          )}
          {can.post && !mark && (
            <div className="dx-acts">
              {(!posting || posting.state.key === 'TAKEN_DOWN') && <button type="button" className="btn btn-primary" onClick={() => setMark(true)}>Mark as posted</button>}
              {posting && posting.state.key !== 'TAKEN_DOWN' && <button type="button" className="btn btn-sm" onClick={() => setMark(true)}>{['EXPIRED', 'EXPIRING'].includes(posting.state.key) ? 'I posted it again' : 'Change'}</button>}
              {posting && posting.state.key !== 'TAKEN_DOWN' && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => { if (window.confirm(`Is it really removed from ${card.name}?`)) dxRun('down', () => dx.post(`/jobs/${job.id}/platforms/${card.key}/taken-down`), `Saved. Taken down from ${card.name}.`); }}>I took it down</button>}
              {posting && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => { if (window.confirm('Remove this mark? The place goes back to Not posted.')) dxRun('undo', () => dx.del(`/jobs/${job.id}/platforms/${card.key}/posted`), 'Done. Back to Not posted.'); }}>I marked the wrong place</button>}
            </div>
          )}
          {mark && <MarkForm card={c} user={user} initial={posting} onCancel={() => setMark(false)} onSaved={async (m) => { setMark(false); flash(m); await onChanged(); }} />}
        </>
      )}
      {card.applicants > 0 && <div className="dx-count">{`${card.applicants} applicant${card.applicants === 1 ? '' : 's'} came from this link`}</div>}
      {err && <div className="dx-err" role="alert">{err}</div>}
    </article>
  );
}

export default function DistributeTab({ job, onChanged = null }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notOn, setNotOn] = useState(false);
  const [msg, setMsg] = useState('');
  const engineData = useJobPublish(job.id);
  const load = useCallback(async () => {
    try { setData(await dx.get(`/jobs/${job.id}`)); setError(''); setNotOn(false); } catch (e) { if (isNotMigrated(e)) setNotOn(true); else setError(dxError(e, 'Could not read the Distribute page.')); }
  }, [job.id]);
  useEffect(() => { load(); }, [load]);
  const changed = useCallback(async () => { await load(); if (onChanged) onChanged(); }, [load, onChanged]);
  const flash = useCallback((m) => { setMsg(m); setTimeout(() => setMsg((x) => (x === m ? '' : x)), 6000); }, []);
  const groups = useMemo(() => {
    const cards = (data && data.cards) || [];
    return [
      ['Automatic', cards.filter((c) => c.kind === 'auto')],
      ['Copy the text and post it yourself', cards.filter((c) => c.kind === 'semi')],
      ['Send it by hand', cards.filter((c) => c.kind === 'manual')],
    ].filter((g) => g[1].length);
  }, [data]);

  if (notOn) return <div className="jp-off" role="status"><b>Distribution is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>;
  if (error) return <div className="dx-err" role="alert">{error}</div>;
  if (!data) return <div className="jp-note" role="status">Loading...</div>;
  const can = data.can;
  const sum = data.summary;
  const withApps = data.cards.filter((c) => c.applicants > 0);
  return (
    <div className="dx-wrap">
      <div className="dx-top">
        <h3>Where this requirement goes</h3>
        <div className="dx-sum" aria-label="Summary">
          <span className="is-green">{`Posted on ${sum.posted}`}</span>
          {sum.expired > 0 && <span className="is-red">{`Expired on ${sum.expired}`}</span>}
          {sum.pending > 0 && <span className="is-yellow">{`Not posted yet on ${sum.pending}`}</span>}
        </div>
      </div>
      {!can.post && <div className="dx-hint">You can read this page. Your team lead or the client manager posts the requirement.</div>}
      {!data.job.live && data.job.status !== 'CLOSED' && <div className="dx-warn">This requirement is not open yet, so it cannot be posted. It appears here when it is open.</div>}
      <p className="dx-hint" style={{ margin: 0 }}>Each place has its own apply link. When someone applies through it, the applicant&apos;s source shows the place (LinkedIn, Naukri, Apna ...), and we count them here.</p>
      <div role="status" aria-live="polite">{msg && <div className="dx-ok">{msg}</div>}</div>

      {data.closedChecklist.length > 0 && (
        <section className="dx-closed" aria-label="Take it down from these places">
          <h4>This requirement is closed. Take it down from these places</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.closedChecklist.map((x) => (
              <li key={x.key}>
                <b>{x.name}</b>
                {x.openUrl && <a href={x.openUrl} target="_blank" rel="noopener noreferrer">{`Open ${x.name}`}</a>}
                {x.postUrl && <a href={x.postUrl} target="_blank" rel="noopener noreferrer">See your post</a>}
                {can.post && <button type="button" className="btn btn-sm" onClick={() => { if (window.confirm(`Is it really removed from ${x.name}?`)) dx.post(`/jobs/${job.id}/platforms/${x.key}/taken-down`).then((o) => { flash(o.ok); changed(); }).catch((e) => setMsg(dxError(e))); }}>I took it down</button>}
              </li>
            ))}
          </ul>
          <span className="dx-hint">TeamLink never deletes anything on those sites by itself. You also have a task for each one under My tasks.</span>
        </section>
      )}

      {withApps.length > 0 && (
        <div className="dx-sum" aria-label="Applicants by place">
          {withApps.map((c) => <span key={c.key}>{`${c.name}: ${c.applicants}`}</span>)}
        </div>
      )}

      {groups.map(([title, list]) => (
        <section key={title} aria-label={title}>
          <h4 className="dx-sec">{title}</h4>
          <div className="dx-grid">
            {list.map((card) => <Card key={card.key} card={card} job={data.job} can={can} user={user} engineData={engineData} onChanged={changed} flash={flash} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

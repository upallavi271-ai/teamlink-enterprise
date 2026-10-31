import { Fragment, useEffect, useState } from 'react';
import api from '../../../api';
import StatusChip from '../../ui/StatusChip.jsx';
import { pingLauncher, openWithLauncher } from '../launcherClient.js';
import FieldByFieldCopy from '../FieldByFieldCopy.jsx';
import { parseJd, bulletsOf, WORDS, HAND_BOARDS, copyFields, jdFileText, cardOf } from './postWizard.js';
import './reqsplit.css';

// ---------------------------------------------------------------------------
// THE FOUR SCREENS of the Post step (founder's mock-up, 2026-10-15). Looks only; PostStep.jsx holds the logic.
//   1 Create Job - Select Platform   2 Post to <Platform> (paste / edit the JD)   3 Preview Job Post   4 Posted
// ---------------------------------------------------------------------------
const STEPS = ['Select platform', 'Paste the job text', 'Preview', 'Posted'];

export function Stepper({ step }) {
  return (
    <ol className="pw-steps" aria-label="Steps">
      {STEPS.map((t, i) => (
        <li key={t} className={`pw-step${step === i + 1 ? ' on' : ''}${step > i + 1 ? ' done' : ''}`} aria-current={step === i + 1 ? 'step' : undefined}>
          <span className="pw-stepn">{i + 1}</span><span className="pw-stept">{t}</span>
        </li>
      ))}
    </ol>
  );
}

const Ico = ({ d, size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const PIN = 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z';
const CLOCK = 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z';
const CASE = 'M4 8h16v11H4zM9 8V5h6v3M4 13h16';

// small round-square "logos" built from words and colours (no pictures from other sites)
const LOGO = {
  save: ['Save', 'pw-lg-save'], naukri: ['N', 'pw-lg-naukri'], indeed: ['indeed', 'pw-lg-indeed'], shine: ['shine', 'pw-lg-shine'], linkedin: ['in', 'pw-lg-in'], jobportal: ['JP', 'pw-lg-jp'], website: ['www', 'pw-lg-web'],
  facebook: ['f', 'pw-lg-fb'], instagram: ['IG', 'pw-lg-ig'], linkedinpost: ['in', 'pw-lg-in'], threads: ['@', 'pw-lg-th'],
};
export function Logo({ id }) {
  const [t, cls] = LOGO[id] || [id.slice(0, 2), ''];
  return <span className={`pw-logo ${cls}`} aria-hidden="true">{t}</span>;
}

// ---- screen 1 -----------------------------------------------------------------------------------------------------
// tiles: [{ id, name, hint, state: {key, note, link, retry}, loginBtn }]
export function PlatformScreen({
  job, tiles, selected, selectedCount = selected.length, onToggle, onRetry, onSaveOnly, onNext, onBack, busy, loginPanels = {}, onLogin, notice, children, groupTitles = {},
}) {
  return (
    <div className="pw-card">
      <h3 className="pw-h1">Where do you want to post?</h3>
      <p className="pw-sub">{`Tick the places, then press Post selected.${job && job.title ? ` ${job.reqCode ? `${job.reqCode} · ` : ''}${job.title} is saved.` : ''}`}</p>
      {notice}
      <div className="pw-picks" role="group" aria-label="Where to post">
        {tiles.map((t, ti) => {
          const [label, tone] = WORDS[t.state.key] || WORDS.idle;
          const on = selected.includes(t.id);
          const gt = t.group && groupTitles[t.group] && (ti === 0 || tiles[ti - 1].group !== t.group) ? groupTitles[t.group] : null;
          // a tile that is not posted yet shows how ready its account is (connected, switched on) instead of "Not posted"
          const chip = t.setup && t.state.key === 'idle' ? [t.setup.label, t.setup.tone] : [label, tone];
          return (
            <Fragment key={t.id}>
              {gt && <h4 className="pw-social-h">{gt[0]} <small>{gt[1]}</small></h4>}
              <div className={`pw-pick${on ? ' on' : ''}`}>
                <label className="pw-pickmain">
                  <input type="checkbox" checked={on} onChange={() => onToggle(t.id)} />
                  <Logo id={t.id} />
                  <span className="pw-pickname"><b>{t.name}</b><small>{t.hint}</small></span>
                </label>
                <span className="pw-pickside">
                  {t.mode && <span className={`pw-badge ${t.mode}`}>{t.mode === 'auto' ? 'Automatic' : 'Manual (you post)'}</span>}
                  <StatusChip tone={chip[1]}>{chip[0]}</StatusChip>
                  {t.state.link && <a className="pw-tlink" href={t.state.link} target="_blank" rel="noreferrer">View</a>}
                  {t.state.retry && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onRetry(t.id)}>Retry</button>}
                  {t.loginBtn && <button type="button" className="rsp-link" onClick={() => onLogin(t.id)}>{loginPanels[t.id] ? 'Hide login' : 'Connect login'}</button>}
                </span>
                {t.state.note && ['failed', 'needs_help', 'queued', 'feed'].includes(t.state.key) && <div className="pw-picknote">{t.state.note}</div>}
              </div>
            </Fragment>
          );
        })}
      </div>
      {tiles.filter((t) => loginPanels[t.id]).map((t) => <div key={`lp${t.id}`}>{loginPanels[t.id]}</div>)}
      {children}
      <div className="pw-foot pw-sticky">
        {onBack ? <button type="button" className="btn pw-grey" disabled={busy} onClick={onBack}>Back</button> : <span />}
        <span className="pw-foot-r">
          <button type="button" className="btn pw-outline" disabled={busy} onClick={onSaveOnly} title="Keep the requirement saved and post nothing now">Save for later</button>
          <button type="button" className="btn btn-primary" disabled={busy || !selectedCount} onClick={onNext} title={selectedCount ? '' : 'Tick a place first'}>{selectedCount ? `Post selected (${selectedCount})` : 'Post selected'}</button>
        </span>
      </div>
    </div>
  );
}

// ---- screen 2 -----------------------------------------------------------------------------------------------------
export function ComposeScreen({
  names, text, onText, onUseTemplate, onUseWritten, tools, dry, onDry, dryShown, dryNote, ownOnly, ownNote, err, busy, onBack, onPreview, onPost, posting, manual = null,
}) {
  return (
    <div className="pw-card">
      <div className="pw-headrow">
        <h3 className="pw-h1">{`Post to ${names}`}</h3>
        <div className="pw-tools">
          <button type="button" className="btn pw-outline" disabled={busy} onClick={onUseTemplate} title="Fill the job text again from the saved requirement">Use Template</button>
        </div>
      </div>
      <p className="pw-sub">Paste the Job Description (JD) template below, or change the text. Once it looks right, click <b>Post</b> to publish the requirement.</p>
      <textarea className="pw-ta" value={text} onChange={(e) => onText(e.target.value)} aria-label="Job text" spellCheck="false" rows={14} />
      <div className="pw-links">
        {onUseWritten && <button type="button" className="rsp-link" onClick={onUseWritten}>Use the text TeamLink wrote</button>}
        {tools}
      </div>
      {ownOnly && ownNote && <div className="ps-hint">{ownNote}</div>}
      {manual && <div className="ps-info">Naukri and Shine open in their own tabs. You sign in and post there yourself. TeamLink does not sign in, fill or send anything for you.</div>}
      {manual && manual.askShine && (
        <label className="ps-dry">
          <input type="checkbox" checked={manual.thenShine} onChange={(e) => manual.onThenShine(e.target.checked)} />
          <span><b>After Naukri, open Shine for me next</b><small>Shine opens only after you say the Naukri posting is completed. You post on Shine yourself too.</small></span>
        </label>
      )}
      {dryShown && (
        <label className="ps-dry">
          <input type="checkbox" checked={dry} onChange={(e) => onDry(e.target.checked)} />
          <span><b>Test only: nothing is posted</b><small>{dryNote}</small></span>
        </label>
      )}
      {err && <div className="ps-bad" role="alert">{err}</div>}
      <div className="pw-foot">
        <button type="button" className="btn pw-grey" disabled={busy} onClick={onBack}>Back</button>
        <span className="pw-foot-r">
          <button type="button" className="btn pw-outline" disabled={busy} onClick={onPreview}>Preview</button>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={onPost}>{posting ? 'Posting…' : dryShown && dry ? 'Check only' : 'Post'}</button>
        </span>
      </div>
    </div>
  );
}

// ---- screen 3 -----------------------------------------------------------------------------------------------------
export function PreviewScreen({
  where, text, job, onBack, onPost, busy, posting, err, dryNote,
}) {
  const jd = parseJd(text, job);
  const resp = bulletsOf(jd.responsibilities);
  const skills = bulletsOf(jd.skills);
  return (
    <div className="pw-card">
      <h3 className="pw-h1">Preview Job Post</h3>
      <p className="pw-sub">{`Here's how your requirement will appear on ${where}. Click `}<b>Post</b>{' to publish.'}</p>
      <div className="pw-job">
        <div className="pw-jobhead">
          <span className="pw-brief"><Ico d={CASE} size={30} /></span>
          <div>
            <div className="pw-jobtitle">{jd.title || 'Requirement title'}</div>
            <div className="pw-meta">
              {jd.location && <span><Ico d={PIN} />{jd.location}</span>}
              {jd.experience && <span><Ico d={CLOCK} />{jd.experience}</span>}
              {jd.type && <span><Ico d={CASE} />{jd.type}</span>}
              {jd.mode && <span>{jd.mode}</span>}
            </div>
          </div>
        </div>
        {jd.description && <><h5 className="pw-sech">Job Description</h5><p className="pw-p">{jd.description}</p></>}
        {resp.length > 0 && <><h5 className="pw-sech">Key Responsibilities</h5><ul className="pw-ul">{resp.map((x, i) => <li key={`r${i}`}>{x}</li>)}</ul></>}
        {skills.length > 0 && <><h5 className="pw-sech">Required Skills</h5><ul className="pw-ul">{skills.map((x, i) => <li key={`s${i}`}>{x}</li>)}</ul></>}
        {jd.others.map((o) => <div key={o.title}><h5 className="pw-sech">{o.title}</h5><p className="pw-p">{o.body}</p></div>)}
        {!jd.description && !resp.length && !skills.length && !jd.others.length && <p className="pw-p">The text is empty. Go Back and write the job text.</p>}
      </div>
      {dryNote && <div className="ps-hint">{dryNote}</div>}
      {err && <div className="ps-bad" role="alert">{err}</div>}
      <div className="pw-foot">
        <button type="button" className="btn pw-grey" disabled={busy} onClick={onBack}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onPost}>{posting ? 'Posting…' : 'Post'}</button>
      </div>
    </div>
  );
}

// ---- by hand: copy the text, open the site, then "I posted it" (the ONLY thing that records Posted by hand) -------------------
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(t); return ok;
  }
}
export function HandHelp({ jobId, id, name, fallbackText, onChanged }) {
  const [h, setH] = useState(null);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const can = HAND_BOARDS.includes(id);
  useEffect(() => {
    if (!can) return;
    api.get(`/requirements/${jobId}/posting-sites/${id}/by-hand`).then((r) => setH(r.data)).catch(() => {});
  }, [jobId, id, can]);
  if (!can) return null;
  const text = (h && h.text) || fallbackText || '';
  async function copy() { setMsg((await copyText(text)) ? 'Copied. Paste it on the site.' : 'Could not copy. Select the text and copy it.'); }
  async function done() {
    setBusy(true); setErr(''); setMsg('');
    try { await api.post(`/requirements/${jobId}/posting-sites/${id}/by-hand/done`, { url: url.trim() }); setMsg(`Saved: marked as posted on ${name} by hand.`); if (onChanged) await onChanged(); } catch (e) { setErr(e.response?.data?.error || 'That did not save. Please try again.'); } finally { setBusy(false); }
  }
  const isDone = h && h.state === 'done' && msg;
  return (
    <div className="ps-login pw-hand" role="group" aria-label={`Post on ${name} yourself`}>
      <b className="ps-login-t">{`Saved and ready. Post it on ${name} yourself.`}</b>
      <div className="ps-hint">{`Press Copy text, then Open ${name}, sign in and paste it. Come back and press "I posted it" only after the requirement is really live on ${name}.${id === 'naukri' ? ' If Naukri asks for its "Naukri Launcher" app, install that first.' : ''}`}</div>
      <div className="pw-handbtns">
        <button type="button" className="btn btn-primary" disabled={!text} onClick={copy}>Copy text</button>
        <a className="btn" href={(h && h.openUrl) || '#'} target="_blank" rel="noreferrer" aria-disabled={!(h && h.openUrl)}>{`Open ${name}`}</a>
      </div>
      {h && h.fields && h.fields.length > 0 && <FieldByFieldCopy fields={h.fields} siteName={name} />}
      {!isDone && (
        <div className="pw-handbtns">
          <input className="rsp-in pw-url" placeholder={`Link of the live requirement on ${name} (if you have it)`} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={`Link of the live requirement on ${name}`} />
          <button type="button" className="btn" disabled={busy} onClick={done}>{busy ? 'Saving…' : 'I posted it'}</button>
        </div>
      )}
      {msg && <div className="ps-info" role="status">{msg}</div>}
      {err && <div className="ps-bad" role="alert">{err}</div>}
    </div>
  );
}

// ---- screen 4 -----------------------------------------------------------------------------------------------------
// rows: [{ id, name, state: {key, note, link, retry}, hand: ReactNode|null }]
export function DoneScreen({
  rows, allGood, dry, onRetry, onViewPosted, onAnother, onMore, onDone, busy,
}) {
  const names = rows.map((r) => r.name).join(', ');
  const anyHelp = rows.some((r) => ['needs_help', 'failed', 'not_connected', 'not_available', 'idle'].includes(r.state.key));
  const anyWait = rows.some((r) => ['queued', 'feed'].includes(r.state.key));
  const title = dry ? 'Check finished' : allGood ? 'Requirement Posted Successfully!' : anyHelp ? 'Saved. Not posted yet' : anyWait ? 'Sent. Waiting for the site' : 'Requirement Posted Successfully!';
  const sub = dry ? 'Nothing was posted: this was a check only.' : allGood ? `Your requirement has been posted on ${names}.` : anyHelp ? 'Some places could not be posted by TeamLink right now. See below what to do.' : `Your requirement was sent to ${names}. It shows Posted only when the site confirms it.`;
  const ok = allGood && !dry;
  return (
    <div className="pw-card pw-center">
      <div className={`pw-check${ok ? '' : ' warn'}`} aria-hidden="true">{ok ? '✔' : '!'}</div>
      <h3 className="pw-h1 pw-big">{title}</h3>
      <p className="pw-sub pw-subbig" role="status">{sub}</p>
      <div className="pw-rows">
        {rows.map((r) => {
          const [label, tone] = WORDS[r.state.key] || WORDS.idle;
          return (
            <div className="pw-row" key={r.id}>
              <div className="pw-rowtop">
                <b>{r.name}</b><StatusChip tone={tone}>{label}</StatusChip>
                {r.state.link && <a className="btn btn-sm" href={r.state.link} target="_blank" rel="noreferrer">View requirement</a>}
                {r.state.retry && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onRetry(r.id)}>Retry</button>}
              </div>
              {r.state.note && <div className="ps-hint">{r.state.note}</div>}
              {r.hand}
            </div>
          );
        })}
      </div>
      <div className="pw-next">
        <b><span className="pw-i" aria-hidden="true">i</span>What happens next?</b>
        <ul>
          <li>The status of each place updates here by itself. It says Posted only when the site confirms.</li>
          <li>You can view the status in the <b>Posted Requirements</b> section.</li>
          <li>You will receive notifications for new applications.</li>
        </ul>
      </div>
      <div className="pw-bigbtns">
        <button type="button" className="btn btn-primary" onClick={onViewPosted}>View Posted Requirements</button>
        {onAnother && <button type="button" className="btn pw-grey" onClick={onAnother}>Create Another Requirement</button>}
        <button type="button" className="rsp-link" onClick={onMore}>Post to another place</button>
        <button type="button" className="rsp-link" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

// ---- the saved job as copyable fields (kept on screen while the recruiter fills the site's own form) ----------------------------
// TeamLink does not fill anything into Naukri or Shine: the person copies each field and pastes it there.
export function JobFieldsPanel({ jobId, board = 'naukri', fallbackJob }) {
  const [job, setJob] = useState(fallbackJob || null);
  const [helper, setHelper] = useState({});
  const [done, setDone] = useState('');
  const [launcher, setLauncher] = useState(undefined); // undefined = looking, null = not running on this PC, else its answer
  const [lmsg, setLmsg] = useState('');
  const [lbusy, setLbusy] = useState(false);
  useEffect(() => { let live = true; pingLauncher().then((r) => { if (live) setLauncher(r); }); return () => { live = false; }; }, []);
  useEffect(() => {
    api.get(`/requirements/${jobId}`).then((r) => setJob({ ...(fallbackJob || {}), ...(r.data.requirement || r.data) })).catch(() => {});
    api.get(`/requirements/${jobId}/posting-sites/${board}/by-hand`).then((r) => setHelper(r.data || {})).catch(() => {});
  }, [jobId, board]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = copyFields(job, helper);
  async function copy(k, v) { setDone((await copyText(v)) ? k : ''); setTimeout(() => setDone(''), 1800); }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([jdFileText(rows, helper.text)], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${String((job && job.title) || 'job').replace(/[^A-Za-z0-9]+/g, '-')}-JD.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch { setDone(''); }
  }
  async function runLauncher() {
    setLbusy(true); setLmsg('');
    const r = await openWithLauncher(board, rows);
    setLbusy(false);
    setLmsg(r.ok ? r.message : r.error);
  }
  const canLaunch = launcher && (launcher.boards || []).includes(board);
  return (
    <details className="pw-fields" open>
      <summary>Your saved requirement: let the Launcher type it, or copy each part and paste it on the site</summary>
      {canLaunch ? (
        <div className="ps-info">
          <b>The Launcher is running on this PC.</b>
          {' It opens the site in your Chrome. You sign in and open "post a job", then press the green button on that page and the Launcher types this requirement into the empty boxes. You check it and press the site\'s own Post.'}
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={lbusy || !rows.length} onClick={runLauncher}>{lbusy ? 'Opening…' : `Open ${(cardOf(board) || {}).name || board} with the Launcher`}</button>
          </div>
          {lmsg && <div className="ps-hint" role="status">{lmsg}</div>}
        </div>
      ) : (
        <div className="ps-hint">
          {launcher === undefined
            ? 'Looking for the Launcher on this PC…'
            : 'The Launcher is not running on this PC, so copy a part and paste it into the site\'s own form. (To have the form typed for you: start teamlink-launcher\\Start-Launcher.cmd, then reopen this screen.)'}
        </div>
      )}
      <FieldByFieldCopy fields={helper.fields && helper.fields.length ? helper.fields : rows} siteName={(cardOf(board) || {}).name || board} />
      <div className="pw-fieldrow"><b>Whole job text</b><span className="pw-handbtns">{helper.text && <button type="button" className="btn btn-sm btn-primary" onClick={() => copy('all', helper.text)}>{done === 'all' ? 'Copied' : 'Copy all'}</button>}<button type="button" className="btn btn-sm" disabled={!rows.length && !helper.text} onClick={download}>Download JD</button></span></div>
      {rows.map((r) => (
        <div className="pw-fieldrow" key={r.label}>
          <div className="pw-fieldv"><b>{r.label}</b><span>{r.value}</span></div>
          <button type="button" className="btn btn-sm" onClick={() => copy(r.label, r.value)} aria-label={`Copy ${r.label}`}>{done === r.label ? 'Copied' : 'Copy'}</button>
        </div>
      ))}
      {rows.length === 0 && <div className="ps-hint">The requirement details are loading.</div>}
    </details>
  );
}

// ---- the Naukri -> Shine by-hand workflow screen ---------------------------------------------------------------------------------
// flow = answer of /api/job-flow (rows, resume, urls); every button is the person's own click.
function Sure({ text, yes, no = 'No, go back', busy, onYes, onNo }) {
  return (
    <div className="ps-warn" role="alertdialog" aria-label="Please confirm">
      <b>{text}</b>
      <div className="pw-handbtns" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onYes}>{yes}</button>
        <button type="button" className="btn" disabled={busy} onClick={onNo}>{no}</button>
      </div>
    </div>
  );
}
export function FlowScreen({
  job, flow, msg, err, busy, copied = null, naukriTabOpen, shineTabOpen = true, otherRows = [], onOpenNaukri, onConfirmNaukri, onNotFinished, onOpenShine, onShineDone, onUndo, onBack, onViewPosted, onAnother, onDone,
}) {
  const [url, setUrl] = useState('');
  const [surl, setSurl] = useState('');
  const [ask, setAsk] = useState(''); // 'naukri' | 'shine' | 'undo-naukri' | 'undo-shine': the second, careful question before something is called Posted (or un-Posted)
  const row = (p) => (flow && flow.rows.find((r) => r.platform === p)) || null;
  const n = row('naukri');
  const s = row('shine');
  const nst = n ? n.status : '';
  const sst = s ? s.status : '';
  const naukriConfirmed = nst === 'Naukri Completion Confirmed';
  const shineDone = sst === 'Completed by Recruiter';
  const naukriWaits = ['Naukri Portal Opened', 'Awaiting Naukri Completion'].includes(nst);
  const naukriReady = ['Ready to Open Naukri', 'Failed', 'Action Required'].includes(nst);
  const shineOpen = ['Shine Portal Opened', 'Shine Manual Posting Pending'].includes(sst);
  const shineReady = ['Opening Shine', 'Failed', 'Action Required'].includes(sst);
  const board = naukriConfirmed || s ? 'shine' : 'naukri';
  return (
    <div className="pw-card">
      <h3 className="pw-h1">{shineDone ? 'Requirement Posted Successfully!' : s || naukriConfirmed ? 'Post on Shine' : 'Post on Naukri'}</h3>
      <p className="pw-sub">You post on each site yourself, on its own recruiter page. TeamLink never signs in or posts for you. A place is called Posted only when you press the button that says you posted it.</p>
      {job && <div className="ps-hint">{`Requirement: ${job.reqCode ? `${job.reqCode} · ` : ''}${job.title}`}</div>}
      {copied === true && <div className="ps-good" role="status">✓ The job text is copied. On the site, click in the box and press Ctrl+V to paste.</div>}
      {copied === false && <div className="ps-warn" role="status">We could not copy the text by ourselves. Press <b>Copy all</b> below, then paste it on the site.</div>}

      {n && (
        <div className={`pw-flowstep${naukriConfirmed ? ' done' : ''}`}>
          <b>{`1. Naukri${naukriConfirmed ? ' (done)' : ''}`}</b>
          {naukriReady && (
            <>
              <div className="ps-hint">{n.lastError || 'Naukri has not been opened yet.'}</div>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={onOpenNaukri}>{nst === 'Ready to Open Naukri' ? 'Open Naukri' : 'Open Naukri again'}</button>
            </>
          )}
          {naukriWaits && (
            <>
              <div className="ps-info" role="status">{naukriTabOpen ? 'Naukri is open in another tab.' : 'Naukri was opened in another tab. If you cannot see it, press Open Naukri again.'} Sign in on Naukri, fill the extra fields, check the requirement and submit it there. Come back here when it is done.</div>
              <div className="pw-handbtns">
                <input className="rsp-in pw-url" placeholder="Link of the live requirement on Naukri (if you have it)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link of the live requirement on Naukri" />
              </div>
              <div className="pw-handbtns">
                <button type="button" className="btn btn-primary" disabled={busy || ask === 'naukri'} onClick={() => setAsk('naukri')}>I posted it on Naukri ✓</button>
                <button type="button" className="btn" disabled={busy} onClick={onOpenNaukri}>Open Naukri again</button>
                <button type="button" className="btn" disabled={busy} onClick={onNotFinished}>I did not finish</button>
              </div>
              {ask === 'naukri' && <Sure text="Is it really submitted on Naukri, and do you see it there? Only then it is called Posted here, and Shine opens next." yes="Yes, it is posted on Naukri" no="No, not yet" busy={busy} onYes={() => { setAsk(''); onConfirmNaukri(url.trim()); }} onNo={() => setAsk('')} />}
              <div className="ps-hint">Press the first button only after the requirement is really submitted on Naukri. Shine does not open before that.</div>
            </>
          )}
          {naukriConfirmed && <div className="ps-good" role="status">Naukri: posted by hand (you confirmed it).</div>}
          {naukriConfirmed && !shineDone && onUndo && (ask === 'undo-naukri'
            ? <Sure text="Take Naukri back to Not posted? Use this if you pressed the button by mistake." yes="Yes, undo it" busy={busy} onYes={() => { setAsk(''); onUndo('naukri'); }} onNo={() => setAsk('')} />
            : <button type="button" className="rsp-link" disabled={busy} onClick={() => setAsk('undo-naukri')}>Not posted after all? Undo</button>)}
        </div>
      )}

      {(naukriConfirmed || s) && !shineDone && (
        <div className="pw-flowstep">
          <b>2. Shine</b>
          {(!s || shineReady) && (
            <>
              <div className="ps-hint">{(s && s.lastError) || 'Shine did not open by itself yet.'}</div>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={onOpenShine}>Open Shine</button>
            </>
          )}
          {shineOpen && (
            <>
              <div className="ps-info" role="status">{shineTabOpen ? 'Shine is open in the other tab.' : 'Shine was opened earlier, but its tab is not here now. Press Open Shine again.'} Nothing was sent to Shine. Sign in there, copy the requirement parts from below, and post it yourself.</div>
              <div className="pw-handbtns">
                <input className="rsp-in pw-url" placeholder="Link of the live requirement on Shine (if you have it)" value={surl} onChange={(e) => setSurl(e.target.value)} aria-label="Link of the live requirement on Shine" />
              </div>
              <div className="pw-handbtns">
                <button type="button" className="btn btn-primary" disabled={busy || ask === 'shine'} onClick={() => setAsk('shine')}>I posted it on Shine ✓</button>
                <button type="button" className="btn" disabled={busy} onClick={onOpenShine}>Open Shine again</button>
              </div>
              {ask === 'shine' && <Sure text="Is it really submitted on Shine, and do you see it there? Only then it is called Posted here." yes="Yes, it is posted on Shine" no="No, not yet" busy={busy} onYes={() => { setAsk(''); onShineDone(surl.trim()); }} onNo={() => setAsk('')} />}
            </>
          )}
        </div>
      )}

      {shineDone && <div className="ps-good" role="status">Shine: posted by hand (you confirmed it).</div>}
      {shineDone && onUndo && (ask === 'undo-shine'
        ? <Sure text="Take Shine back to Not posted? Use this if you pressed the button by mistake." yes="Yes, undo it" busy={busy} onYes={() => { setAsk(''); onUndo('shine'); }} onNo={() => setAsk('')} />
        : <button type="button" className="rsp-link" disabled={busy} onClick={() => setAsk('undo-shine')}>Not posted after all? Undo</button>)}
      {msg && <div className="ps-warn" role="status">{msg}</div>}
      {err && <div className="ps-bad" role="alert">{err}</div>}
      {otherRows.length > 0 && (
        <div className="pw-rows">
          {otherRows.map((r) => {
            const [label, tone] = WORDS[r.state.key] || WORDS.idle;
            return <div className="pw-row" key={r.id}><div className="pw-rowtop"><b>{r.name}</b><StatusChip tone={tone}>{label}</StatusChip></div>{r.state.note && <div className="ps-hint">{r.state.note}</div>}</div>;
          })}
        </div>
      )}
      {!shineDone && <JobFieldsPanel jobId={job.id} board={board} fallbackJob={job} />}
      <div className="pw-next">
        <b><span className="pw-i" aria-hidden="true">i</span>What happens next?</b>
        <ul>
          <li>Naukri first. After you press <b>I posted it on Naukri</b>, Shine opens by itself in the tab we prepared.</li>
          <li>Opening a site is not posting. Each site shows Posted (by hand) only after you say so.</li>
          <li>You can leave and come back: TeamLink remembers where you were.</li>
        </ul>
      </div>
      <div className="pw-bigbtns">
        {shineDone && <button type="button" className="btn btn-primary" onClick={onViewPosted}>View Posted Requirements</button>}
        {shineDone && onAnother && <button type="button" className="btn pw-grey" onClick={onAnother}>Create Another Requirement</button>}
        <button type="button" className="rsp-link" onClick={onBack}>Back to the platforms</button>
        <button type="button" className="rsp-link" onClick={onDone}>Done for now</button>
      </div>
    </div>
  );
}

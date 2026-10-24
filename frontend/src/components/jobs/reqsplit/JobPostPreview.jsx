import { useState } from 'react';
import {
  TABS, TAB_KEYS, SMS_LIMIT, resolveText, countWords,
} from './liveTemplate.js';
import MyJobTemplates from './MyJobTemplates.jsx';
import '../../agreements/agreementLink.css';
import './reqsplit.css';

// ---------------------------------------------------------------------------
// JOB POST PREVIEW (right side of Add / Edit job; same look as the agreement preview beside Add client).
//   info tiles (what the person typed) + the ready template, written as they type, four tabs.
//   "Edit text": the text can be changed here. A tab that was changed stops auto-filling and shows "Reset to auto".
// It only SHOWS what the server writer made (components/jobs/reqsplit/liveTemplate.js); nothing here posts.
// ---------------------------------------------------------------------------
function Tile({ k, v }) {
  return (
    <div className="acw-term">
      <div className="k">{k}</div>
      <div className={`v${v ? '' : ' blank'}`}>{v || 'Not set'}</div>
    </div>
  );
}

export default function JobPostPreview({
  tiles = [], live, missing = [], className = '', title = 'Job post preview', onPolish = null, polishing = false, polishHint = '',
}) {
  const [tab, setTab] = useState('jobPost');
  const [editing, setEditing] = useState(false);
  const { state, data, texts } = live;
  const sample = (data && data.sample) || {};
  const ready = missing.length === 0;
  const edited = live.isEdited(tab);
  const keys = TAB_KEYS[tab];
  const sms = resolveText(texts.sms, sample);
  const smsLen = [...sms].length;
  const body = keys.map((k) => texts[k]).join('\n');
  const chars = [...body].length;

  const status = state === 'loading' || state === 'waiting' ? 'Updating…' : state === 'error' ? 'Preview not available right now' : state === 'idle' ? 'Type the requirement title to begin' : 'Fills in as you type';

  return (
    <aside className={`acw-preview rsp ${className}`} aria-label={title}>
      <div className="acw-preview-head">
        <b>{title}</b>
        <span className="acw-status" role="status">{status}</span>
      </div>
      <div className="acw-terms">{tiles.map((t) => <Tile key={t.k} k={t.k} v={t.v} />)}</div>

      <div className="rsp-chiprow">
        {ready
          ? <span className="rsp-chip ok" role="status">✔ Template ready</span>
          : <span className="rsp-chip warn" role="status">{`Fill: ${missing.join(', ')}`}</span>}
        {live.editedAny && <span className="rsp-chip edit">Edited by you</span>}
        {data && data.hidesClient && <span className="rsp-note">The client name is hidden (&ldquo;our client&rdquo;).</span>}
      </div>

      <div className="rsp-tabs" role="tablist" aria-label="Where this text is used">
        {TABS.map(([k, l]) => (
          <button type="button" role="tab" aria-selected={tab === k} key={k} className={`rsp-tab${tab === k ? ' on' : ''}`} onClick={() => { setTab(k); setEditing(false); }}>
            {l}{live.isEdited(k) ? ' •' : ''}
          </button>
        ))}
      </div>

      <div className="rsp-doc">
        {state === 'idle' && !data && <div className="rsp-empty">The text for Naukri, WhatsApp, SMS and email appears here as soon as you type the requirement title.</div>}
        {state === 'hidden' && <div className="rsp-empty">The text preview is not available for your login. The requirement is saved with the standard text.</div>}
        {state === 'error' && !data && <div className="rsp-empty rsp-err" role="alert">{live.error}</div>}
        {!data && (state === 'loading' || state === 'waiting') && <div className="rsp-empty" role="status">Writing the text…</div>}
        {data && state !== 'hidden' && (
          <>
            <div className="rsp-tools">
              <button type="button" className={`btn btn-sm${editing ? ' btn-primary' : ''}`} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit text'}</button>
              <button type="button" className="rsp-link" disabled={!edited} title={edited ? 'Write this text again from the form' : 'This text is already the automatic one'} onClick={() => { live.resetTab(tab); setEditing(false); }}>Reset to auto</button>
              {tab === 'jobPost' && (onPolish
                ? <button type="button" className="btn btn-sm" disabled={polishing || !(data && data.ai && data.ai.available)} onClick={onPolish} title={data && data.ai && !data.ai.available ? (data.ai.reason || 'AI is not connected') : ''}>{polishing ? 'Asking AI…' : 'Polish with AI'}</button>
                : <span className="rsp-note">{polishHint || 'Polish with AI is on the requirement page after you save.'}</span>)}
            </div>
            {edited && <div className="rsp-note">You changed this text, so it no longer updates when you change the form.</div>}
            {tab === 'jobPost' && !editing && <div className="rsp-text rsp-big" tabIndex={0} aria-label="Job post text">{resolveText(texts.jobPost, sample) || '—'}</div>}
            {tab === 'whatsapp' && !editing && <div className="rsp-wabg"><div className="rsp-wa" tabIndex={0}>{resolveText(texts.whatsapp, sample) || '—'}</div></div>}
            {tab === 'sms' && !editing && <div className="rsp-text" tabIndex={0}>{sms || '—'}</div>}
            {tab === 'email' && !editing && (
              <div className="rsp-text" tabIndex={0}>
                <b>{resolveText(texts.emailSubject, sample) || '—'}</b>
                {'\n\n'}
                {resolveText(texts.emailBody, sample) || '—'}
              </div>
            )}
            {editing && tab === 'email' && (
              <>
                <label className="rsp-lab" htmlFor="rsp-subj">Subject</label>
                <input id="rsp-subj" className="rsp-in" value={texts.emailSubject} onChange={(e) => live.setText('emailSubject', e.target.value)} />
              </>
            )}
            {editing && (
              <textarea
                className="rsp-ta"
                aria-label={`${(TABS.find((t) => t[0] === tab) || [])[1]} text`}
                value={tab === 'email' ? texts.emailBody : texts[tab]}
                onChange={(e) => live.setText(tab === 'email' ? 'emailBody' : tab, e.target.value)}
              />
            )}
            <div className="rsp-count">
              {tab === 'sms'
                ? <span className={smsLen > SMS_LIMIT ? 'rsp-over' : ''}>{`${smsLen} of ${SMS_LIMIT} letters`}{smsLen > SMS_LIMIT ? ' — goes as more than one SMS' : ''}</span>
                : <span>{`${countWords(body)} words · ${chars} letters`}</span>}
              {tab === 'whatsapp' && <span>{' · {{firstName}} and {{applyLink}} are filled for each person'}</span>}
            </div>
            {data && data.missing && data.missing.length > 0 && <div className="rsp-note">{`Left out because it is not on the form yet: ${data.missing.map((m) => m.label || m.key).join(', ')}.`}</div>}
            {data && data.warnings && data.warnings.length > 0 && <div className="rsp-note">{data.warnings.join(' ')}</div>}
          </>
        )}
      </div>
      <MyJobTemplates live={live} jobTitle={tiles.find((t) => t.k === 'Title')?.v || ''} />
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>This text is saved with the requirement when you press Save &amp; Post or Save &amp; create. Nothing is posted from here.</div>
    </aside>
  );
}

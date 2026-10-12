import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './jobTextPanel.css';

// ---------------------------------------------------------------------------
// WRITE THE JOB POSTS — a Master JD, one text per site (Naukri, Shine, Indeed,
// LinkedIn + a LinkedIn feed post) and a "check before you post" list, written
// from the job's REAL fields (backend utils/jobText.js). No sidebar entry: it
// opens from Posting sources ("Write the job posts") and inside "Post by hand".
//
//   * "Fill these first": every missing fact stays "[ ]" in the text and has a
//     small box here; typing refreshes the text. "Fill from the job description"
//     offers what the description's own words say (marked "check this"). Nothing is
//     saved into the job unless the poster presses "Save these into the job".
//   * Every text is editable. "Save my changes" keeps the edits for this job
//     (who / when) and "Post by hand" and the Indeed feed then use them.
//     "Back to the text TeamLink wrote" resets one text.
//   * Warnings in plain words when the job's text, or an edited text, asks for an
//     age, gender, marital status, religion or looks, or names the client.
//   * Each text has its own Copy button and a word / character counter
//     (LinkedIn: 250 words; Naukri tags: 10-15).
//   * "Polish with AI" only when a model is connected: same facts only, and a
//     "check what changed" view before anything is used.
// GET /requirements/:id/job-posts, POST …/job-text[/ai|/save], POST …/job-posts[/check]
// ---------------------------------------------------------------------------
const TAB_NAME = { master: 'Master JD', naukri: 'Naukri', shine: 'Shine', indeed: 'Indeed', linkedin: 'LinkedIn', linkedinPost: 'LinkedIn post', checklist: 'Checklist' };
export const ALL_TABS = ['master', 'naukri', 'shine', 'indeed', 'linkedin', 'linkedinPost', 'checklist'];
const FIELDS = {
  master: [{ k: 'master', label: 'Master JD', rows: 16 }],
  naukri: [
    { k: 'naukriTitle', label: 'Job title for Naukri', rows: 1 },
    { k: 'naukri', label: 'Job description for Naukri', rows: 14 },
    { k: 'naukriTags', label: 'Key skills (tags) for the Key Skills box', rows: 3, kind: 'tags' },
  ],
  shine: [{ k: 'shine', label: 'Job text for Shine', rows: 14 }],
  indeed: [
    { k: 'indeedTitle', label: 'Job title for Indeed', rows: 1 },
    { k: 'indeed', label: 'Job text for Indeed', rows: 14 },
  ],
  linkedin: [{ k: 'linkedin', label: 'Job text for LinkedIn', rows: 14, kind: 'linkedin' }],
  linkedinPost: [{ k: 'linkedinPost', label: 'LinkedIn feed post (announce the opening)', rows: 5, kind: 'post' }],
};
const KEY_LABEL = { master: 'Master JD', naukri: 'Naukri text', naukriTitle: 'Naukri title', naukriTags: 'Naukri key skills', shine: 'Shine text', indeed: 'Indeed text', indeedTitle: 'Indeed title', linkedin: 'LinkedIn text', linkedinPost: 'LinkedIn post' };
const LONG = ['responsibilities', 'benefits', 'skills', 'goodToHave'];
const wordsOf = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATUS = { fix: ['Fix this', 'is-fix'], check: ['Check', 'is-check'], ok: ['Looks fine', 'is-ok'] };

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(t); return ok;
  }
}

function CopyButton({ text, label, onCopied, children = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-sm" onClick={async () => { const ok = await copy(text); setDone(ok); if (onCopied) onCopied(ok ? label : ''); setTimeout(() => setDone(false), 1800); }}>{done ? 'Copied' : children}</button>
  );
}

function TextBox({ f, value, generated, saved, stale, edited, onChange, onReset, onCopied }) {
  const w = wordsOf(value);
  const limit = f.kind === 'linkedin' ? 250 : 0;
  const tags = f.kind === 'tags' ? String(value || '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean) : [];
  const counter = f.kind === 'tags' ? `${tags.length} tags (10-15 is best)`
    : f.kind === 'post' ? `${String(value || '').split('\n').filter((x) => x.trim()).length} lines`
      : limit ? `${w} / ${limit} words`
        : f.rows === 1 ? `${String(value || '').length} characters` : `${w} words · ${String(value || '').length} characters`;
  const over = (limit && w > limit) || (f.kind === 'tags' && tags.length > 15);
  const changed = String(value || '') !== String(generated || '');
  const hashtags = f.kind === 'linkedin' ? (String(value || '').match(/#[A-Za-z0-9_]+/g) || []) : [];
  return (
    <div className={`jtp-box${changed ? ' is-edited' : ''}`}>
      <div className="jtp-box-h">
        <b>{f.label}</b>
        <span className={`jtp-count${over ? ' is-over' : ''}`}>{counter}</span>
        <CopyButton text={String(value || '')} label={f.label} onCopied={onCopied} />
      </div>
      <textarea className="jtp-text" rows={f.rows} value={value || ''} aria-label={f.label} onChange={(e) => onChange(f.k, e.target.value)} />
      {f.kind === 'tags' && tags.length > 0 && (
        <div className="jtp-chips" aria-label="Tap a tag to copy it">
          {tags.map((t, i) => <TagChip key={`${t}-${i}`} tag={t} onCopied={onCopied} />)}
          <CopyButton text={tags.join(', ')} label="all tags" onCopied={onCopied}>Copy all tags</CopyButton>
        </div>
      )}
      {f.kind === 'linkedin' && (
        <div className="small-muted">{hashtags.length >= 3 && hashtags.length <= 5 ? `${hashtags.length} hashtags: ${hashtags.join(' ')}` : `${hashtags.length} hashtag${hashtags.length === 1 ? '' : 's'} in the text. 3 to 5 is best.`}</div>
      )}
      <div className="jtp-box-f">
        {saved && !edited && <span className="small-muted">Saved by {saved.byName || 'a team member'}{saved.at ? ` · ${when(saved.at)}` : ''}</span>}
        {edited && <span className="jtp-unsaved">You changed this. Press Save my changes to keep it.</span>}
        {changed && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onReset(f.k)}>Back to the text TeamLink wrote</button>}
      </div>
      {stale && !edited && (
        <div className="jtp-stale">The job changed after this text was saved, so the text TeamLink would write now is different. <button type="button" className="btn btn-sm" onClick={() => onReset(f.k)}>Use the new text</button></div>
      )}
    </div>
  );
}

function TagChip({ tag, onCopied }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={`jtp-chip${done ? ' is-done' : ''}`} onClick={async () => { const ok = await copy(tag); setDone(ok); if (onCopied) onCopied(ok ? tag : ''); setTimeout(() => setDone(false), 1200); }}>{tag}</button>;
}

export default function JobTextPanel({ requirementId, tabs = ALL_TABS, onNote, onSaved }) {
  const [data, setData] = useState(null);
  const [ai, setAi] = useState(null); // an AI draft, when asked for
  const [tab, setTab] = useState(tabs[0]);
  const [ov, setOv] = useState({}); // what the poster typed for the missing facts
  const [guess, setGuess] = useState({}); // keys filled from the job description ("check this")
  const [edits, setEdits] = useState({}); // texts edited on this screen, not saved yet
  const [live, setLive] = useState([]); // wording warnings on the edited / saved texts
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const timer = useRef(null);
  const metaRef = useRef({});
  const lintTimer = useRef(null);
  const base = `/requirements/${requirementId}`;

  const load = (overrides) => api.post(`${base}/job-text`, { overrides })
    .then((r) => { setData(r.data); setError(''); })
    .catch((e) => setError(e.response?.data?.error || 'Could not write the job posts.'));
  useEffect(() => { api.get(`${base}/job-posts`).then((r) => { setData(r.data); setError(''); }).catch((e) => setError(e.response?.data?.error || 'Could not write the job posts.')); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps

  const gen = data ? data.texts : {};
  const savedTexts = (data && data.saved && data.saved.texts) || {};
  // What a box shows: the poster's unsaved edit, else their saved text, else what TeamLink wrote.
  const val = (k) => (k in edits ? edits[k] : (k in savedTexts ? savedTexts[k] : gen[k]));
  const dirtyKeys = Object.keys(edits).filter((k) => edits[k] !== (k in savedTexts ? savedTexts[k] : gen[k]));
  const effective = useMemo(() => {
    const o = {};
    Object.keys(savedTexts).forEach((k) => { o[k] = savedTexts[k]; });
    Object.keys(edits).forEach((k) => { o[k] = edits[k]; });
    return o;
  }, [edits, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wording check on the texts the poster wrote or saved (the generated ones are already clean).
  useEffect(() => {
    clearTimeout(lintTimer.current);
    if (!Object.keys(effective).length) { setLive([]); return undefined; }
    lintTimer.current = setTimeout(() => {
      api.post(`${base}/job-posts/check`, { texts: effective }).then((r) => setLive(r.data.warnings || [])).catch(() => {});
    }, 600);
    return () => clearTimeout(lintTimer.current);
  }, [effective]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = (key, value, fromGuess) => {
    const next = { ...ov, [key]: value };
    setOv(next); setAi(null);
    setGuess((g) => { const n = { ...g }; if (fromGuess) n[key] = true; else delete n[key]; return n; });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(next), 450);
  };
  const useGuesses = (items) => {
    const next = { ...ov };
    const g = { ...guess };
    items.forEach((s) => { next[s.key] = s.value; g[s.key] = true; });
    setOv(next); setGuess(g); setAi(null);
    load(next);
  };
  const edit = (k, v) => setEdits((e) => ({ ...e, [k]: v }));

  async function saveFills() {
    setBusy('fills'); setError('');
    try {
      const r = await api.post(`${base}/job-text/save`, { overrides: ov });
      setNote(r.data.ok); if (onNote) onNote(r.data.ok);
      setOv({}); setGuess({});
      await load({});
    } catch (e) { setError(e.response?.data?.error || 'That did not save.'); } finally { setBusy(''); }
  }
  async function saveEdits() {
    setBusy('texts'); setError('');
    try {
      const texts = {};
      dirtyKeys.forEach((k) => { texts[k] = edits[k]; });
      const r = await api.post(`${base}/job-posts`, { texts, overrides: ov });
      setNote(r.data.ok); if (onNote) onNote(r.data.ok);
      setEdits({});
      setData((d) => ({ ...d, saved: r.data.saved }));
      if (onSaved) onSaved();
    } catch (e) { setError(e.response?.data?.error || 'That did not save.'); } finally { setBusy(''); }
  }
  async function resetKeys(keys) {
    setError('');
    const had = keys.filter((k) => k in savedTexts);
    setEdits((e) => { const n = { ...e }; keys.forEach((k) => delete n[k]); return n; });
    if (!had.length) { setNote('Back to the text TeamLink wrote.'); return; }
    try {
      const texts = {};
      had.forEach((k) => { texts[k] = null; });
      const r = await api.post(`${base}/job-posts`, { texts, overrides: ov });
      setNote(r.data.ok);
      setData((d) => ({ ...d, saved: r.data.saved }));
      if (onSaved) onSaved();
    } catch (e) { setError(e.response?.data?.error || 'That did not work.'); }
  }
  async function polish() {
    setBusy('ai'); setError(''); setNote('');
    try {
      const cur = {};
      Object.keys(gen).forEach((k) => { cur[k] = val(k); });
      const r = await api.post(`${base}/job-text/ai`, { overrides: ov, current: cur });
      setAi(r.data);
    } catch (e) { setError(e.response?.data?.error || 'The AI could not write the text.'); } finally { setBusy(''); }
  }
  function useAi() {
    const keys = Object.keys(ai.diff || {});
    setEdits((e) => { const n = { ...e }; keys.forEach((k) => { n[k] = ai.texts[k]; }); return n; });
    setAi(null);
    setNote('The AI wording is in the boxes. Read it, then press Save my changes.');
  }

  if (!data) return <div className="small-muted">{error || 'Writing the job posts from the job…'}</div>;
  // A box stays on screen while the poster types in it, even after the text no longer counts that fact as missing.
  (data.missing || []).forEach((m) => { metaRef.current[m.key] = m; });
  const stillMissing = new Set((data.missing || []).map((m) => m.key));
  const missing = [...(data.missing || []), ...Object.keys(ov).filter((k) => !stillMissing.has(k) && metaRef.current[k]).map((k) => metaRef.current[k])];
  const required = missing.filter((m) => !m.optional);
  const optional = missing.filter((m) => m.optional);
  const typedAny = Object.values(ov).some((v) => String(v || '').trim());
  const sugg = (data.suggestions || []).filter((s) => !ov[s.key]);
  // The wording item also counts what the poster wrote or saved (live check), not only the job's own fields.
  const checklist = (data.checklist || []).map((c) => (c.key === 'wording' && live.length
    ? { ...c, status: 'fix', detail: `${live.length} warning${live.length === 1 ? '' : 's'} in the texts above (age, gender, marital status, religion, looks or the client name). Change them before you post.` }
    : c));
  const fixCount = checklist.filter((c) => c.status === 'fix').length;
  const savedMeta = (k) => (data.saved && data.saved.texts && k in data.saved.texts ? { byName: (data.saved.keys[k] || {}).byName || data.saved.byName, at: (data.saved.keys[k] || {}).at || data.saved.savedAt } : null);
  const warnings = [
    ...(data.warnings || []).map((w) => ({ ...w, src: true })),
    ...live.map((w) => ({ ...w, src: false })),
  ];
  const showTabs = tabs.filter((t) => t === 'checklist' || FIELDS[t]);

  const renderTab = () => {
    if (tab === 'checklist') {
      return (
        <div className="jtp-check">
          <b>Check these 5 things before you post</b>
          <div className="small-muted">Built from this job&rsquo;s real gaps. {fixCount ? `${fixCount} need${fixCount === 1 ? 's' : ''} fixing.` : 'Nothing is missing. Still read each one.'}</div>
          <ol className="jtp-check-list">
            {checklist.map((c) => (
              <li key={c.key} className={`jtp-check-item ${STATUS[c.status][1]}`}>
                <span className="jtp-chip-s">{STATUS[c.status][0]}</span>
                <div><b>{c.label}</b><div>{c.detail}</div></div>
              </li>
            ))}
          </ol>
        </div>
      );
    }
    return (FIELDS[tab] || []).map((f) => (
      <TextBox
        key={f.k}
        f={f}
        value={val(f.k)}
        generated={gen[f.k]}
        saved={savedMeta(f.k)}
        stale={!!(data.saved && data.saved.stale && data.saved.stale[f.k])}
        edited={dirtyKeys.includes(f.k)}
        onChange={edit}
        onReset={(k) => resetKeys([k])}
        onCopied={setNote}
      />
    ));
  };

  const tabKeys = (FIELDS[tab] || []).map((f) => f.k);
  const anyChanged = tabKeys.some((k) => String(val(k) || '') !== String(gen[k] || ''));

  return (
    <div className="jtp">
      {(required.length > 0 || sugg.length > 0) && (
        <div className="jtp-fill" role="group" aria-label="Fill these first">
          <div className="jtp-fill-h">
            <b>Fill these first</b>
            <a className="btn btn-sm" href={`/requirements/${requirementId}?action=edit`} title="Open the job form to change any field">Edit the job</a>
          </div>
          <div className="small-muted">The posts keep <code>[ ]</code> where the job has nothing. Type here and the text updates. We never make up a salary, skill or benefit.</div>
          {sugg.length > 0 && (
            <div className="jtp-sugg">
              <div className="jtp-sugg-h">
                <span>The job description seems to say:</span>
                <button type="button" className="btn btn-sm" onClick={() => useGuesses(sugg)}>Fill from the job description</button>
              </div>
              <ul>
                {sugg.map((s) => (
                  <li key={s.key}>
                    <b>{s.label}:</b> {s.value} <span className="small-muted">(from &ldquo;{s.phrase}&rdquo;) {s.check}</span>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => useGuesses([s])}>Use this</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {required.length > 0 && (
            <div className="jtp-fill-grid">
              {required.map((m) => <FillItem key={m.key} m={m} value={ov[m.key] || ''} guessed={!!guess[m.key]} onChange={typed} />)}
            </div>
          )}
        </div>
      )}
      {optional.length > 0 && (
        <details className="jtp-opt" open>
          <summary>Also good to add ({optional.map((m) => m.label.toLowerCase()).join(', ')})</summary>
          <div className="jtp-fill-grid">{optional.map((m) => <FillItem key={m.key} m={m} value={ov[m.key] || ''} guessed={!!guess[m.key]} onChange={typed} />)}</div>
        </details>
      )}
      {typedAny && (
        <div className="jtp-row">
          {data.canFill && <button type="button" className="btn btn-sm" disabled={busy === 'fills'} onClick={saveFills}>{busy === 'fills' ? 'Saving…' : 'Save these into the job'}</button>}
          <span className="small-muted">{data.canFill ? 'Otherwise they are only used for these texts.' : 'These are only used for these texts (you cannot change the job itself).'}{Object.keys(guess).length ? ' Items marked "check this" came from the description.' : ''}</span>
        </div>
      )}

      {(data.notes || []).map((n, i) => <div key={i} className="jtp-note" role="status">{n}</div>)}

      {warnings.length > 0 && (
        <div className="jtp-warn" role="alert">
          <b>Please look at this</b>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}><b>{w.field}:</b> &ldquo;{w.phrase}&rdquo;. {w.why} <span>{w.suggest}</span> <span className="small-muted">{w.src ? 'Left out of the text TeamLink wrote.' : 'It is in your text. Change it before you post.'}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="jtp-who small-muted">
        Company shown on the posts: <b>{data.company.shown}</b>{data.company.hidesClient ? ' (the client name is never written)' : ''}.
      </div>

      <div className="jtp-tabs" role="tablist" aria-label="Which post">
        {showTabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`jtp-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {TAB_NAME[t]}
            {t === 'checklist' && fixCount > 0 && <span className="jtp-badge">{fixCount}</span>}
            {t !== 'checklist' && (FIELDS[t] || []).some((f) => String(val(f.k) || '') !== String(gen[f.k] || '')) && <span className="jtp-dot" title="Edited" />}
          </button>
        ))}
      </div>

      {ai && (
        <div className="jtp-ai" role="status">
          <b>{ai.label}</b>
          <div className="small-muted">Written by an AI from the same facts. Anything that is not in the job (a number, a tag, a line naming the client) was removed. Nothing is used until you press the button.</div>
          {ai.dropped && ai.dropped.length > 0 && (
            <details><summary>{ai.dropped.length} thing{ai.dropped.length === 1 ? '' : 's'} removed from the AI text</summary>
              <ul>{ai.dropped.map((d, i) => <li key={i}><b>{d.where}:</b> &ldquo;{d.line}&rdquo; — {d.why}</li>)}</ul></details>
          )}
          {ai.flagged && ai.flagged.map((f, i) => <div key={i} className="jtp-bad">{f}</div>)}
          <div><b>Check what changed</b> <span className="small-muted">({Object.keys(ai.diff || {}).length} text{Object.keys(ai.diff || {}).length === 1 ? '' : 's'} differ; green = added, red = removed)</span></div>
          {Object.keys(ai.diff || {}).length === 0 && <div className="small-muted">The AI changed nothing.</div>}
          {Object.keys(ai.diff || {}).map((k) => (
            <details key={k} open={k === (FIELDS[tab] || [{}])[0].k}>
              <summary>{KEY_LABEL[k] || k}</summary>
              <div className="jtp-diff">
                {ai.diff[k].map((l, i) => <div key={i} className={`jtp-d is-${l.op}`}>{l.op === 'add' ? '+ ' : l.op === 'del' ? '− ' : '  '}{l.text || ' '}</div>)}
              </div>
            </details>
          ))}
          <div className="jtp-row">
            {Object.keys(ai.diff || {}).length > 0 && <button type="button" className="btn btn-sm btn-primary" onClick={useAi}>Use the AI wording</button>}
            <button type="button" className="btn btn-sm" onClick={() => setAi(null)}>Keep my text</button>
          </div>
        </div>
      )}

      {renderTab()}

      {tab !== 'checklist' && (
        <div className="jtp-row">
          {dirtyKeys.length > 0 && data.canSave && (
            <button type="button" className="btn btn-primary" disabled={busy === 'texts'} onClick={saveEdits}>{busy === 'texts' ? 'Saving…' : 'Save my changes'}</button>
          )}
          {anyChanged && tabKeys.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => resetKeys(tabKeys)}>Reset {TAB_NAME[tab]} to generated</button>}
          {dirtyKeys.length > 0 && <span className="small-muted">{dirtyKeys.length} text{dirtyKeys.length === 1 ? '' : 's'} changed, not saved yet.</span>}
        </div>
      )}

      {data.ai && data.ai.available && !ai && (
        <div className="jtp-row">
          <button type="button" className="btn btn-sm" disabled={busy === 'ai'} onClick={polish}>{busy === 'ai' ? 'Writing…' : 'Polish with AI'}</button>
          <span className="small-muted">Optional. It only rewrites the wording from this job&rsquo;s facts, and you see what changed first.</span>
        </div>
      )}
      {data.ai && !data.ai.available && (
        <div className="small-muted">Polish with AI needs an AI key. An Admin can add it in <Link to="/admin/integrations">Administration → Integrations</Link>.</div>
      )}
      {note && <div className="jobops-ok" role="status">{typeof note === 'string' && !/^(Saved|Back to|The AI|Done)/.test(note) ? `Copied: ${note}.` : note}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

function FillItem({ m, value, guessed, onChange }) {
  const long = LONG.includes(m.key);
  return (
    <label className="jtp-fill-item">
      <span>{m.label}{m.optional ? '' : ' *'}{guessed && <em className="jtp-guess">check this</em>}</span>
      {long
        ? <textarea rows={m.key === 'responsibilities' ? 4 : 2} value={value} placeholder={m.hint} onChange={(e) => onChange(m.key, e.target.value)} />
        : <input type="text" value={value} placeholder={m.hint} onChange={(e) => onChange(m.key, e.target.value)} />}
    </label>
  );
}

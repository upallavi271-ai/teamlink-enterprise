import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import PostByHand from './PostByHand.jsx';
import './postingChoices.css';

// ---------------------------------------------------------------------------
// "POST THEM ONE BY ONE" — one screen that walks through every (job, board) pair
// that is waiting for a person to post it by hand (2026-10-10). For each pair:
//   [Copy job text]  [Open <board>]  link box  [I posted it]  [Skip for now]
// then the next one. Used from the Save & Post panel (one job, its waiting boards)
// and from the Jobs list (several jobs: "Waiting to be posted by hand").
// "I posted it" saves "Posted (by hand)" with who / when / link. TeamLink never
// signs in to a board and nothing is sent to it.
//   pairs: [{ requirementId, reqCode, title, client, board, boardName, waitedHours }]
// GET / POST /requirements/:id/posting-sites/:board/by-hand[/done]
// ---------------------------------------------------------------------------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(t);
    return ok;
  }
}

export default function PostWalkthrough({ pairs, onClose, onChanged }) {
  const [i, setI] = useState(0);
  const [h, setH] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState([]); // pair keys posted in this run
  const [skipped, setSkipped] = useState(0);
  const [fixing, setFixing] = useState(false); // the full helper, to fill [ ] gaps
  const cur = pairs[i] || null;
  const key = (p) => `${p.requirementId}|${p.board}`;

  useEffect(() => {
    if (!cur) return;
    setH(null); setUrl(''); setNote(''); setError('');
    api.get(`/requirements/${cur.requirementId}/posting-sites/${cur.board}/by-hand`)
      .then((r) => setH(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not prepare this requirement.'));
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doCopy() {
    if (!h) return;
    setNote((await copyText(h.text)) ? `Copied the ${cur.boardName} text. Paste it on ${cur.boardName}.` : 'Your browser did not allow copying. Open "Field by field" and copy by hand.');
  }
  async function posted() {
    setBusy(true); setError('');
    try {
      await api.post(`/requirements/${cur.requirementId}/posting-sites/${cur.board}/by-hand/done`, { url });
      setDone((d) => [...d, key(cur)]);
      if (onChanged) onChanged();
      setI((x) => x + 1);
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(false); }
  }
  const skip = () => { setSkipped((n) => n + 1); setI((x) => x + 1); };

  const total = pairs.length;
  const finished = i >= total;
  return (
    <Modal title="Post them one by one" size="wide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>{finished ? 'Close' : 'Stop for now'}</button>}>
      <div className="pw">
        <div className="small-muted">{finished ? 'All done.' : `${Math.min(i + 1, total)} of ${total}`}</div>
        <div className="pw-bar"><i style={{ width: `${Math.round((Math.min(i, total) / Math.max(total, 1)) * 100)}%` }} /></div>
        {finished && (
          <div className="pw-card">
            <div className="pw-title">{done.length ? `Well done. ${done.length} posted by hand.` : 'Nothing was posted this time.'}</div>
            {skipped > 0 && <div>{skipped} skipped. They stay on your list and we remind you again tomorrow.</div>}
          </div>
        )}
        {cur && (
          <div className="pw-card">
            <div className="pw-title">{cur.boardName}: {cur.title}</div>
            <div className="small-muted">{[cur.reqCode, cur.client].filter(Boolean).join(' · ')}{cur.waitedHours >= 1 ? ` · waiting ${cur.waitedHours} h` : ''}</div>
            {!h && <div className="small-muted">{error || 'Getting the text ready…'}</div>}
            {h && (
              <>
                {h.gaps && h.gaps.length > 0 && (
                  <div className="pbh-warn">
                    The text still has empty [ ] gaps for: {h.gaps.join(', ')}. Fill them in first, or fix them on {cur.boardName} while you paste.
                    <div className="pbh-row"><button type="button" className="btn btn-sm" onClick={() => setFixing(true)}>Fill the gaps</button></div>
                  </div>
                )}
                <textarea className="pw-text" readOnly value={h.text} aria-label={`The job text for ${cur.boardName}`} />
                <div className="pw-btns">
                  <button type="button" className="btn btn-primary" onClick={doCopy}>1. Copy job text</button>
                  <a className="btn" href={h.openUrl} target="_blank" rel="noreferrer">2. Open {cur.boardName} ↗</a>
                </div>
                <div className="field">
                  <label htmlFor="pw-url">3. Paste the link of the live requirement (optional), then press the button</label>
                  <input id="pw-url" type="url" inputMode="url" placeholder={`https://… (from ${cur.boardName})`} value={url} onChange={(e) => setUrl(e.target.value)} />
                </div>
                <div className="pw-btns">
                  <button type="button" className="btn btn-primary" disabled={busy || !h.live} onClick={posted}>{busy ? 'Saving…' : 'I posted it'}</button>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={skip}>Skip for now</button>
                </div>
                <div className="small-muted">Press &ldquo;I posted it&rdquo; only after you really posted it. It then reads &ldquo;Posted (by hand)&rdquo; with your name and the time.</div>
              </>
            )}
            {note && <div className="jobops-ok" role="status">{note}</div>}
            {error && h && <div className="error-text">{error}</div>}
          </div>
        )}
      </div>
      {fixing && cur && (
        <PostByHand
          requirementId={cur.requirementId}
          source={cur.board}
          name={cur.boardName}
          onClose={() => { setFixing(false); api.get(`/requirements/${cur.requirementId}/posting-sites/${cur.board}/by-hand`).then((r) => setH(r.data)).catch(() => {}); }}
          onChanged={() => { if (onChanged) onChanged(); }}
        />
      )}
    </Modal>
  );
}

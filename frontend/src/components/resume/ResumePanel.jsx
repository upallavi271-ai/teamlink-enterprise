// ---------------------------------------------------------------------------
// CANDIDATE 360 → RESUME TAB (resume_). Backend: routes/candidateResumes.js.
//
//   * Upload PDF / DOCX / DOC (drag-drop or click). Every upload is a NEW
//     original; earlier originals stay in the history, the newest is current.
//   * Details on top (parsed: skills, experience, education, location,
//     e-mail / phone), the resume below — a PDF in the browser's own viewer
//     (auth-protected blob URL), a Word file as its extracted text + download.
//   * Edit resume → structured sections → "Edited resume v1, v2 …", each with
//     a TeamLink-format PDF + DOCX (contact details removed).
//   * Side by side: Original (left) | Edited (right), each with a version
//     dropdown.
// Who may upload / edit is decided by the server (canUpload / canEdit); a
// login the API refuses (403) simply does not get this panel.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import './ResumePanel.css';

const SECTIONS = [
  ['headline', 'Headline (role · years)', 2, false],
  ['summary', 'Professional summary', 5, true],
  ['skills', 'Key skills (comma separated)', 4, false],
  ['education', 'Education', 4, false],
  ['experience', 'Work experience', 12, true],
  ['other', 'Additional information (free text)', 6, true],
];
const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const kb = (n) => (n ? `${Math.max(1, Math.round(n / 1024))} KB` : '');
const digits10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const nameWords = (v) => String(v || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);

// "Is this resume really this person's?" (user, 2026-10-03: a resume of
// someone else was uploaded and nothing said so). Phone or e-mail match = same
// person. Neither matches AND the name shares no word = probably the wrong file.
export function resumeOwnerCheck(parsed, person) {
  if (!parsed || !person) return { ok: true };
  const rPhones = (parsed.phones || []).map(digits10).filter((x) => x.length === 10);
  const rEmails = (parsed.emails || []).map((e) => String(e).toLowerCase().trim());
  const pPhone = digits10(person.phone);
  const pEmail = String(person.email || '').toLowerCase().trim();
  if ((pPhone && rPhones.includes(pPhone)) || (pEmail && rEmails.includes(pEmail))) return { ok: true };
  const rWords = nameWords(parsed.name);
  const pWords = nameWords(person.name);
  const shared = rWords.filter((w) => pWords.includes(w)).length;
  const nameShared = shared > 0 && shared >= Math.min(2, rWords.length, pWords.length);
  const resumeHasContact = rPhones.length > 0 || rEmails.length > 0;
  if (!resumeHasContact && (!rWords.length || nameShared)) return { ok: true };
  if (nameShared && !resumeHasContact) return { ok: true };
  if (nameShared) return { ok: true, soft: true };
  return { ok: false };
}

// An auth-protected file as a blob URL (the API needs the bearer token, so a
// plain <iframe src="/api/…"> would be refused).
function useBlobUrl(path) {
  const [state, setState] = useState({ url: null, error: '' });
  useEffect(() => {
    if (!path) { setState({ url: null, error: '' }); return undefined; }
    let url = null; let live = true;
    setState({ url: null, error: '' });
    api.get(path, { responseType: 'blob' })
      .then((res) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
        setState({ url, error: '' });
      })
      .catch(() => { if (live) setState({ url: null, error: 'Could not open the file. Please try again.' }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return state;
}

async function downloadFile(path, fileName) {
  const res = await api.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = fileName || 'resume';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function DocView({ candidateId, version, detail }) {
  const isPdf = version && version.hasPdf;
  const { url, error } = useBlobUrl(isPdf ? `/candidate-resumes/${candidateId}/file/${version.id}?format=pdf` : null);
  if (!version) return <div className="rsm-empty">No version selected.</div>;
  if (isPdf) {
    if (error) return <div className="rsm-empty">{error}</div>;
    if (!url) return <div className="rsm-empty">Loading the PDF…</div>;
    return <iframe title={version.label} src={url} />;
  }
  if (!detail) return <div className="rsm-empty">Loading…</div>;
  return (
    <pre className="rsm-text">
      {detail.text || 'No text could be extracted from this file — download it to read it.'}
    </pre>
  );
}

function Downloads({ candidateId, v, name, onError }) {
  if (!v) return null;
  const go = (format, ext) => downloadFile(
    `/candidate-resumes/${candidateId}/file/${v.id}?download=1${format ? `&format=${format}` : ''}`,
    v.kind === 'EDITED' ? `${name} - ${v.label}.${ext}` : v.fileName,
  ).catch(() => onError('Could not download. Please try again.'));
  if (v.kind === 'EDITED') {
    return (
      <>
        <button type="button" className="btn btn-sm" onClick={() => go('pdf', 'pdf')}>⬇ Download PDF</button>
        {v.hasDocx && <button type="button" className="btn btn-sm" onClick={() => go('docx', 'docx')}>⬇ Download Word</button>}
      </>
    );
  }
  return <button type="button" className="btn btn-sm" onClick={() => go('', '')}>⬇ Download</button>;
}

function Details({ v }) {
  const p = (v && v.parsed) || null;
  if (!v) return null;
  if (!p) return null;
  return (
    <div className="rsm-card">
      <div className="rsm-details">
        <div><div className="rsm-k">Total experience</div><div className="rsm-v">{p.totalExperienceYears != null ? `${p.totalExperienceYears} yrs` : '—'}{p.experienceSource === 'dates' && <span className="small-muted"> (from job dates)</span>}</div></div>
        <div><div className="rsm-k">Education</div><div className="rsm-v">{p.education && p.education.length ? p.education.join(', ') : '—'}</div></div>
        <div><div className="rsm-k">Current location</div><div className="rsm-v">{p.location || '—'}</div></div>
        <div><div className="rsm-k">E-mail / phone</div><div className="rsm-v">{[...(p.emails || []), ...(p.phones || [])].slice(0, 3).join(' · ') || '—'}</div></div>
        <div className="rsm-skills">
          <div className="rsm-k">{`Skills found in the resume (${(p.skills || []).length})`}</div>
          <div>{(p.skills || []).length ? p.skills.map((s) => <span key={s} className="skillpill match">{s}</span>) : <span className="small-muted">None recognised</span>}</div>
        </div>
      </div>
      {v.extractError && <div className="notice amber" style={{ margin: '10px 0 0' }}>{v.extractError}</div>}
      <div className="small-muted" style={{ marginTop: 8 }}>
        {`Read from ${v.label} by the ${v.parser === 'free+claude' ? 'free parser + Claude' : 'free parser'}. Used for the Resume % in every match.`}
      </div>
    </div>
  );
}

export default function ResumePanel({ candidateId, candidateName, candidatePhone, candidateEmail }) {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [mode, setMode] = useState('view'); // view | side | edit
  const [selId, setSelId] = useState('');
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [details, setDetails] = useState({}); // id -> version detail
  const [draft, setDraft] = useState(null);
  const [draftBase, setDraftBase] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [over, setOver] = useState(false);
  const [undoId, setUndoId] = useState(''); // the version just hidden (Undo)
  const fileRef = useRef(null);

  function load(selectId) {
    return api.get(`/candidate-resumes/${candidateId}`)
      .then((res) => {
        const d = res.data;
        setData(d);
        const firstOrig = d.originals[0]; const firstEdit = d.edited[0];
        setSelId((cur) => selectId || (cur && [...d.originals, ...d.edited].some((v) => v.id === cur) ? cur : (firstEdit || firstOrig || {}).id || ''));
        setLeftId((cur) => (cur && d.originals.some((v) => v.id === cur) ? cur : (firstOrig || {}).id || ''));
        setRightId((cur) => (selectId && d.edited.some((v) => v.id === selectId) ? selectId : (cur && d.edited.some((v) => v.id === cur) ? cur : (firstEdit || {}).id || '')));
      })
      .catch((err) => { if ([403, 404].includes(err.response?.status)) setHidden(true); else setError('Could not load the resumes. Please try again.'); });
  }
  useEffect(() => { setData(null); setHidden(false); setMode('view'); setDetails({}); setFlash(''); setError(''); setUndoId(''); load(); }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => (data ? [...data.edited, ...data.originals] : []), [data]);
  const byId = (id) => all.find((v) => v.id === id) || null;

  // Version text/sections, fetched when a version is shown.
  function ensureDetail(id) {
    if (!id || details[id]) return;
    api.get(`/candidate-resumes/${candidateId}/version/${id}`)
      .then((res) => setDetails((m) => ({ ...m, [id]: res.data })))
      .catch(() => setDetails((m) => ({ ...m, [id]: { text: '' } })));
  }
  useEffect(() => {
    if (mode === 'view') ensureDetail(selId);
    if (mode === 'side') { ensureDetail(leftId); ensureDetail(rightId); }
  }, [mode, selId, leftId, rightId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(file) {
    if (!file) return;
    setError(''); setFlash('');
    if (data && file.size > data.maxBytes) { setError(`That file is larger than ${Math.round(data.maxBytes / 1048576)} MB.`); return; }
    const fd = new FormData();
    fd.append('file', file);
    setBusy('upload');
    try {
      const res = await api.post(`/candidate-resumes/${candidateId}/upload`, fd);
      setUndoId('');
      // A wrong-person upload gets the red warning below instead of a green tick.
      if (res.data.ownerMismatch) setFlash('');
      else {
        setFlash(res.data.extractError
          ? `✓ Resume uploaded (${file.name}). We could not read its text: ${res.data.extractError}`
          : `✓ Resume uploaded and read (${file.name}).`);
      }
      await load(res.data.resume.id);
      setMode('view');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload. Please try again.');
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // "This is the wrong file — hide it": kept for the record, no longer current.
  async function hideVersion(v, hide) {
    if (!v) return;
    setError(''); setBusy(hide ? 'hide' : 'unhide');
    try {
      const res = await api.post(`/candidate-resumes/${candidateId}/${hide ? 'hide' : 'unhide'}/${v.id}`, { reason: 'Wrong file (another person\'s resume)' });
      setFlash(`✓ ${res.data.message}`);
      setUndoId(hide ? v.id : '');
      setDetails({});
      await load();
      setMode('view');
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(''); }
  }

  async function openEditor() {
    setError('');
    // Start from the newest edited version, else the current original.
    const base = (data.edited[0] || data.originals[0]);
    if (!base) return;
    setBusy('editor');
    try {
      const res = await api.get(`/candidate-resumes/${candidateId}/version/${base.id}`);
      setDraft({ ...(res.data.draftSections || {}) });
      setDraftBase(base.id);
      setMode('edit');
    } catch {
      setError('Could not open the resume to edit. Please try again.');
    } finally { setBusy(''); }
  }

  async function saveEdit() {
    setError(''); setBusy('save');
    try {
      const res = await api.post(`/candidate-resumes/${candidateId}/edit`, { sections: draft, baseResumeId: draftBase });
      setFlash(`${res.data.resume.label} saved — TeamLink-format PDF${res.data.resume.hasDocx ? ' and DOCX' : ''} generated (contact details removed).`);
      setDraft(null);
      await load(res.data.resume.id);
      setMode('side');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the edited resume. Please try again.');
    } finally { setBusy(''); }
  }

  if (hidden) return null;
  if (!data) return <div className="rsm"><div className="rsm-card small-muted">{error || 'Loading resumes…'}</div></div>;

  const sel = byId(selId);
  const left = byId(leftId);
  const right = byId(rightId);
  const name = candidateName || 'Candidate';
  const hasAny = all.length > 0;
  const current = data.originals[0] || null;
  // The server's check first (it also sees the profile's other phone); the
  // same rule in the browser as a fallback.
  const owner = (current && current.owner) || resumeOwnerCheck(current && current.parsed, { name: candidateName, phone: candidatePhone, email: candidateEmail });
  const says = (current && current.owner && current.owner.resumeSays) || (current && current.parsed ? {
    name: current.parsed.name, phone: (current.parsed.phones || [])[0], email: (current.parsed.emails || [])[0],
  } : {});
  const hiddenList = data.hiddenVersions || [];
  const undoV = undoId ? hiddenList.find((v) => v.id === undoId) : null;

  const versionSelect = (value, onChange, list) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((v) => <option key={v.id} value={v.id}>{`${v.label}${v === data.originals[0] || v === data.edited[0] ? ' (latest)' : ''} · ${when(v.createdAt)}`}</option>)}
    </select>
  );

  return (
    <div className="rsm">
      <div
        className={`rsm-card${over ? ' rsm-over' : ''}`}
        onDragOver={data.canUpload ? (e) => { e.preventDefault(); setOver(true); } : undefined}
        onDragLeave={data.canUpload ? () => setOver(false) : undefined}
        onDrop={data.canUpload ? (e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files && e.dataTransfer.files[0]); } : undefined}
      >
        <div className="rsm-head">
          <div className="rsm-title">
            <h3>Resume</h3>
            <div className="small-muted">
              {current
                ? `Uploaded ${when(current.createdAt)}${current.createdByName ? ` by ${current.createdByName}` : ''} · ${current.fileName || ''}`
                : 'No resume uploaded yet.'}
            </div>
          </div>
          <div className="rsm-actions">
            {data.canUpload && (
              <button type="button" className={`btn btn-sm${current ? '' : ' btn-primary'}`} disabled={busy === 'upload'} onClick={() => fileRef.current && fileRef.current.click()}>
                {busy === 'upload' ? 'Uploading…' : current ? '⬆ Upload a newer resume' : '⬆ Upload resume'}
              </button>
            )}
            {hasAny && data.canEdit && mode !== 'edit' && (
              <button type="button" className="btn btn-sm" disabled={busy === 'editor'} onClick={openEditor}>✎ Edit resume</button>
            )}
            {hasAny && data.edited.length > 0 && data.originals.length > 0 && mode !== 'side' && (
              <button type="button" className="btn btn-sm" onClick={() => setMode('side')}>⇆ Compare original and edited</button>
            )}
            {hasAny && mode !== 'view' && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setDraft(null); setMode('view'); }}>← Back to resume</button>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword" style={{ display: 'none' }} onChange={(e) => upload(e.target.files && e.target.files[0])} />
        </div>
        {data.canUpload && !current && (
          <div
            className={`rsm-drop${over ? ' over' : ''}`}
            style={{ marginTop: 10 }}
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current && fileRef.current.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' && fileRef.current) fileRef.current.click(); }}
          >
            {busy === 'upload' ? 'Uploading and reading the resume…' : (
              <>
                <b>Drop the resume file here, or click to choose</b>
                <br />
                {`PDF or Word, up to ${Math.round(data.maxBytes / 1048576)} MB.`}
              </>
            )}
          </div>
        )}
        {flash && (
          <div className="notice rsm-ok" style={{ margin: '10px 0 0' }}>
            <span className="rsm-grow">{flash}</span>
            {undoV && (
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => hideVersion(undoV, false)}>↶ Undo</button>
            )}
          </div>
        )}
        {error && <div className="notice red" style={{ margin: '10px 0 0' }}>{error}</div>}
        {current && !owner.ok && (
          <div className="notice red rsm-warn" role="alert">
            <b>⚠ This resume may belong to someone else.</b>
            <div className="rsm-who">
              <div><span className="rsm-k">The resume says</span>{[says.name, says.phone, says.email].filter(Boolean).join(' · ') || '—'}</div>
              <div><span className="rsm-k">This profile is</span>{[name, candidatePhone, candidateEmail].filter(Boolean).join(' · ')}</div>
            </div>
            <div>Check the file. If it is another person&apos;s resume, hide it and upload the right one.</div>
            {data.canUpload && (
              <div className="rsm-warn-actions">
                {data.canHide && (
                  <button type="button" className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => hideVersion(current, true)}>
                    {busy === 'hide' ? 'Hiding…' : 'This is the wrong file — hide it'}
                  </button>
                )}
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => fileRef.current && fileRef.current.click()}>⬆ Upload the right resume</button>
              </div>
            )}
          </div>
        )}
        {/* Both files, always in view (user, 2026-10-03): the original (never changed) and the latest edited one. */}
        {(current || data.edited[0]) && (
          <div className="rsm-files">
            {[current, data.edited[0]].filter(Boolean).map((v) => (
              <div key={v.id} className={`rsm-file-card${sel && sel.id === v.id && mode === 'view' ? ' on' : ''}`}>
                <div className="rsm-grow">
                  <b>{v.kind === 'EDITED' ? v.label : 'Original resume'}</b>
                  <div className="small-muted">
                    {v.kind === 'EDITED'
                      ? `TeamLink format · ${v.createdByName || '—'} · ${when(v.createdAt)} · clients see this one`
                      : `As uploaded, never changed · ${v.fileName || ''}`}
                  </div>
                </div>
                <div className="rsm-actions">
                  <button type="button" className="btn btn-sm" onClick={() => { setSelId(v.id); setMode('view'); }}>View</button>
                  <Downloads candidateId={candidateId} v={v} name={name} onError={setError} />
                </div>
              </div>
            ))}
            {!data.edited[0] && data.canEdit && current && <div className="small-muted rsm-files-note">No edited version yet. Use ✎ Edit resume to make the TeamLink-format copy for clients.</div>}
          </div>
        )}
      </div>

      {mode === 'view' && sel && <Details v={sel} />}

      {mode === 'view' && sel && (
        <div className="rsm-viewer">
          <div className="rsm-bar">
            {versionSelect(selId, setSelId, all)}
            {sel.kind === 'ORIGINAL' && <span className="small-muted rsm-file">{`${sel.fileName} · ${kb(sel.size)}`}</span>}
            <span className="rsm-spacer" style={{ flex: 1 }} />
            <Downloads candidateId={candidateId} v={sel} name={name} onError={setError} />
          </div>
          <DocView candidateId={candidateId} version={sel} detail={details[sel.id]} />
        </div>
      )}

      {mode === 'side' && (
        <div className="rsm-side">
          <div className="rsm-viewer">
            <div className="rsm-bar">
              <span className="rsm-tag">Original</span>
              {versionSelect(leftId, setLeftId, data.originals)}
              <span style={{ flex: 1 }} />
              <Downloads candidateId={candidateId} v={left} name={name} onError={setError} />
            </div>
            <DocView candidateId={candidateId} version={left} detail={details[leftId]} />
          </div>
          <div className="rsm-viewer">
            <div className="rsm-bar">
              <span className="rsm-tag">Edited</span>
              {versionSelect(rightId, setRightId, data.edited)}
              <span style={{ flex: 1 }} />
              <Downloads candidateId={candidateId} v={right} name={name} onError={setError} />
            </div>
            <DocView candidateId={candidateId} version={right} detail={details[rightId]} />
            {right && <div className="small-muted" style={{ padding: '6px 10px', background: '#fff' }}>{`${right.label} by ${right.createdByName || '—'} · ${when(right.createdAt)}. Clients see only the latest edited version, without phone / e-mail / address.`}</div>}
          </div>
        </div>
      )}

      {mode === 'edit' && draft && (
        <div className="rsm-card">
          <div className="rsm-head" style={{ marginBottom: 10 }}>
            <h3>{`Edit resume → Edited resume v${data.edited.length + 1}`}</h3>
            <span className="small-muted">{`Starting from ${(byId(draftBase) || {}).label || 'the current resume'}. The original file is never changed.`}</span>
          </div>
          <div className="rsm-editor">
            {SECTIONS.map(([key, label, rows, wide]) => (
              <label key={key} className={wide ? 'rsm-wide' : ''}>
                {label}
                <textarea rows={rows} value={draft[key] || ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="rsm-foot">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'save'} onClick={saveEdit}>{busy === 'save' ? 'Saving…' : `Save as Edited resume v${data.edited.length + 1}`}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setDraft(null); setMode('view'); }}>Cancel</button>
            <span className="small-muted">Phone numbers, e-mail addresses, street addresses and profile links are removed from the TeamLink-format PDF / DOCX automatically.</span>
          </div>
        </div>
      )}

      {all.length > 1 && (
        <div className="rsm-card">
          <div className="rsm-k" style={{ marginBottom: 6 }}>All versions</div>
          <div className="tbl-wrap">
            <table className="rsm-hist">
              <thead><tr><th>Version</th><th>File</th><th>By</th><th>When</th><th /></tr></thead>
              <tbody>
                {all.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((v) => (
                  <tr key={v.id}>
                    <td><span className={`status ${v.kind === 'EDITED' ? 'active' : 'new'}`}>{v.label}</span></td>
                    <td className="cell-muted">{v.kind === 'EDITED' ? `TeamLink format · PDF${v.hasDocx ? ' + DOCX' : ''}` : `${v.fileName} · ${kb(v.size)}`}</td>
                    <td className="cell-muted">{v.createdByName || '—'}</td>
                    <td className="cell-muted">{when(v.createdAt)}</td>
                    <td><button type="button" className="link-btn" onClick={() => { setSelId(v.id); setMode('view'); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hiddenList.length > 0 && (
        <div className="rsm-card rsm-hidden">
          <div className="rsm-k" style={{ marginBottom: 6 }}>{`Hidden files (${hiddenList.length}) — kept for the record, not used`}</div>
          {hiddenList.map((v) => (
            <div key={v.id} className="rsm-hrow">
              <span className="rsm-grow">
                <b>{v.fileName || v.label}</b>
                <span className="small-muted">{` · ${v.label} · hidden ${when(v.hiddenAt)}${v.hiddenByName ? ` by ${v.hiddenByName}` : ''}${v.hiddenReason ? ` · ${v.hiddenReason}` : ''}`}</span>
              </span>
              {data.canHide && (
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => hideVersion(v, false)}>Show again</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

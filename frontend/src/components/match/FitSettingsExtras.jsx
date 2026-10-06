// ---------------------------------------------------------------------------
// Company Setup → Fit settings, B8 additions (2026-10-05):
//   SemanticCard  "Match by meaning" — off by default; which engine runs on
//                 this server and for this login; the background index.
//   VersionsCard  every scoring version so far (v1 = before versioning).
// Backend: GET/PUT /api/candidate-resumes/fit-settings (semantic, versions,
// semanticInfo) and POST /api/candidate-resumes/semantic/build.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import './match.css';

const when = (d) => (d ? new Date(d).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');
export const ENGINE_WORD = { local: 'Built-in (offline)', ai: 'AI (Ollama)', off: 'Off' };

export function SemanticCard({
  data, form, setForm, edit, busy, onSave, onReload,
}) {
  const [msg, setMsg] = useState('');
  const info = data.semanticInfo || {};
  const sem = form.semantic || { on: false, weight: 5, engine: 'local' };
  const setSem = (patch) => setForm({ ...form, semantic: { ...sem, ...patch } });
  const idx = info.index || {};
  const saved = !!(data.semantic && data.semantic.on);
  async function rebuild() {
    setMsg('');
    try {
      const r = await api.post('/candidate-resumes/semantic/build');
      setMsg(r.data.message || 'Started.');
      setTimeout(onReload, 2500);
    } catch (e) { setMsg(e.response?.data?.error || 'Could not start. Please try again.'); }
  }
  return (
    <div className="card section b8-fs-section">
      <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>Match by meaning</h3>
      <div className="small-muted">
        Also counts skills written another way (ReactJS = React.js, accountant = accounts executive) and how close the
        profile is to the job in meaning. Off = every Fit % stays exactly as it is.
      </div>
      <div className="b8-fs-switch" role="group" aria-label="Match by meaning">
        <button type="button" className={!sem.on ? 'btn on' : 'btn'} disabled={!edit} aria-pressed={!sem.on} onClick={() => setSem({ on: false })}>Off</button>
        <button type="button" className={sem.on ? 'btn on' : 'btn'} disabled={!edit} aria-pressed={!!sem.on} onClick={() => setSem({ on: true })}>On</button>
      </div>
      {sem.on && (
        <>
          <label className="fit-row fit-min">
            <span className="fit-name"><b>How much it counts</b></span>
            <input type="number" min="0" max="30" disabled={!edit} value={sem.weight} onChange={(e) => setSem({ weight: e.target.value })} />
            <span className="fit-share small-muted">pts</span>
          </label>
          <div className="small-muted">Small on purpose: 5 points next to the 100 points above.</div>
          <div className="b8-fs-line"><b>Engine</b></div>
          <div className="b8-fs-switch" role="group" aria-label="Engine">
            <button type="button" className={sem.engine !== 'ai' ? 'btn on' : 'btn'} disabled={!edit} aria-pressed={sem.engine !== 'ai'} onClick={() => setSem({ engine: 'local' })}>Built-in (offline)</button>
            <button
              type="button"
              className={sem.engine === 'ai' ? 'btn on' : 'btn'}
              disabled={!edit || !info.youHaveAiAccess}
              aria-pressed={sem.engine === 'ai'}
              onClick={() => setSem({ engine: 'ai' })}
              title={info.youHaveAiAccess ? '' : 'Needs AI access for ATS data (Role Catalog)'}
            >
              AI (Ollama)
            </button>
          </div>
          <div className="small-muted">
            Built-in: nothing leaves this server. AI: profile text (never the name, phone or e-mail) goes to the Ollama
            server, and only for people whose role has AI access in Role Catalog.
          </div>
        </>
      )}
      {info.machine && (
        <div className="b8-fs-line">
          {'On this server: '}
          <span className={info.machine.aiReady ? 'b8-fs-ok' : 'b8-fs-wait'}>{info.machine.summary}</span>
        </div>
      )}
      {saved && (
        <div className="b8-fs-line">
          {`Running now for you: ${ENGINE_WORD[info.engineNow] || info.engineNow}. `}
          {info.why && <span className="small-muted">{info.why}</span>}
        </div>
      )}
      {saved && (
        <div className="b8-fs-line">
          {idx.state === 'running'
            ? `Getting ready… ${idx.done} of ${idx.total} people`
            : `Ready for ${idx.localIndexed || 0} people${idx.finishedAt ? ` (updated ${when(idx.finishedAt)})` : ''}.`}
          {idx.state === 'failed' && <span className="msp-err">{` Last update stopped: ${idx.error}`}</span>}
          {edit && <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} disabled={idx.state === 'running'} onClick={rebuild}>Update now</button>}
        </div>
      )}
      {msg && <div className="small-muted">{msg}</div>}
      {edit && (
        <div className="rsm-foot">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

const W_ORDER = ['mand', 'good', 'exp', 'relev', 'edu', 'loc', 'sal', 'notice', 'mode', 'emp', 'jp', 'avail'];
export function VersionsCard({ data }) {
  const list = [...(data.versions || [])].reverse();
  const short = (w) => W_ORDER.map((k) => `${(data.labels && data.labels[k]) || k} ${w[k]}`).join(' · ');
  return (
    <div className="card section b8-fs-section">
      <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>Scoring versions</h3>
      <div className="small-muted">Every saved Fit remembers the version (and the weights) it was worked out with.</div>
      <div className="tbl-wrap">
        <table className="b8-ver-table">
          <thead>
            <tr><th>Version</th><th>From</th><th className="b8-hide-sm">Weights</th><th>Match by meaning</th><th className="b8-hide-sm">Changed by</th></tr>
          </thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.version}>
                <td>
                  <b>{`v${v.version}`}</b>
                  {v.version === data.version ? ' (now)' : ''}
                </td>
                <td>{when(v.at)}</td>
                <td className="b8-hide-sm small-muted">{v.weights ? `${short(v.weights)} · Same specialisation +${v.specBonus}` : '—'}</td>
                <td>{v.semantic && v.semantic.on ? `On, ${v.semantic.weight} pts, ${ENGINE_WORD[v.semantic.engine] || v.semantic.engine}` : 'Off'}</td>
                <td className="b8-hide-sm">{v.byName || '—'}</td>
              </tr>
            ))}
            {!list.length && (
              <tr>
                <td>
                  <b>{data.versionLabel || 'v2'}</b>
                  {' (now)'}
                </td>
                <td>—</td>
                <td className="b8-hide-sm small-muted">The weights above</td>
                <td>{data.semantic && data.semantic.on ? 'On' : 'Off'}</td>
                <td className="b8-hide-sm">—</td>
              </tr>
            )}
            <tr>
              <td><b>v1</b></td>
              <td>Before versioning</td>
              <td className="b8-hide-sm small-muted">Fits saved before 6 Oct 2026</td>
              <td>Off</td>
              <td className="b8-hide-sm">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

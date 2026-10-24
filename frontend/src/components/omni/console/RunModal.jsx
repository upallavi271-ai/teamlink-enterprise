import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, Banner } from '../ui.jsx';
import { download, slug } from './consoleKit.js';

// the prototype's Send run window: progress bar, "n / total processed", the log (Contact, To, Message, Status), Stop, Download log.
// It follows ONE run on the server (outreach/consoleSend.js) by asking for it every second while it is active.
const PILL = { queued: ['queued', 'queued'], sending: ['sending', 'sending'], sent: ['sent', 'sent'], rehearsed: ['sent', 'rehearsed'], task: ['sent', 'call task'], failed: ['failed', 'failed'], skipped: ['cancelled', 'left out'], cancelled: ['cancelled', 'cancelled'] };
const ACTIVE = ['running', 'scheduled', 'waiting', 'stopping'];

export default function RunModal({ runId, onClose, go, toast }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const timer = useRef(null);
  const load = useCallback(async () => {
    try { const d = await omni.get(`/gs/console/runs/${runId}`); setData(d); setErr(''); return d; } catch (e) { setErr(errOf(e, 'This send could not be opened.')); return null; }
  }, [runId]);
  useEffect(() => {
    let on = true;
    const tick = async () => { const d = await load(); if (!on) return; if (!d || ACTIVE.includes(d.run.status)) timer.current = setTimeout(tick, 1000); };
    tick();
    return () => { on = false; clearTimeout(timer.current); };
  }, [load]);

  const run = data && data.run;
  const stop = async () => {
    try { await omni.post(`/gs/console/runs/${runId}/stop`, {}); toast('Stopping after the current message…'); load(); } catch (e) { toast(errOf(e, 'Could not stop it.')); }
  };
  const close = async () => { if (run && run.status === 'running') await stop(); onClose(); };
  const log = async () => {
    try { const b = await omni.blob(`/gs/console/runs/${runId}/log.csv`); download(b, `${slug(run.name)}-log.csv`); } catch (e) { toast(errOf(e, 'The log could not be downloaded.')); }
  };
  const items = (data && data.items) || [];
  const done = run ? run.sent + run.rehearsed + run.failed + run.skipped + run.cancelled : 0;
  const pct = run && run.total ? Math.round((done / run.total) * 100) : 0;
  const active = run && ACTIVE.includes(run.status);

  return (
    <div className="modal-bg show">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Send" style={{ width: 'min(880px,96vw)' }}>
        <div className="modal-head">
          <div>
            <b style={{ fontSize: 16 }}>{run ? `Sending ${run.channelWord} — ${run.name}` : 'Sending'}</b>
            {run && <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{run.total} recipient{run.total === 1 ? '' : 's'} from {run.sourceLabel}{run.skipped ? ` · ${run.skipped} left out` : ''}{run.templateLabel ? ` · ${run.templateLabel}` : ''}</p>}
          </div>
          <button type="button" className="close" onClick={close} aria-label={run && run.status === 'running' ? 'Stop and close' : 'Close'} title={run && run.status === 'running' ? 'Stop and close' : 'Close'}>&times;</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '66vh' }}>
          {err && <Banner tone="error">{err}</Banner>}
          {!data && !err && <div style={{ padding: 20, fontSize: 11, color: 'var(--muted)' }}>Opening…</div>}
          {run && (
            <>
              {run.rehearsal && <Banner tone="test"><b>Rehearsal.</b> Test mode is on, so nothing is sent to anybody. The rows are written down and counted as Test messages.</Banner>}
              {!run.rehearsal && <Banner tone="warn"><b>Real messages.</b> Test mode is off: these go to real people.</Banner>}
              {run.status === 'scheduled' && <Banner tone="info">Scheduled for {new Date(run.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST. It starts by itself.</Banner>}
              {run.status === 'waiting' && <Banner tone="warn">{run.note || 'Waiting.'}</Banner>}
              <div className="sr-progress"><div id="sendRunBar" style={{ width: `${pct}%` }} /></div>
              <div className="sr-stats">
                <span><b>{done}</b> / {run.total} processed</span>
                {run.sent > 0 && <span className="sr-ok">✓ {run.sent} sent</span>}
                {run.rehearsed > 0 && <span className="sr-ok">◌ {run.rehearsed} rehearsed (nothing sent)</span>}
                {run.failed > 0 && <span className="sr-bad">✕ {run.failed} failed</span>}
                {run.skipped > 0 && <span>{run.skipped} left out</span>}
                {run.cancelled > 0 && <span>{run.cancelled} stopped before sending</span>}
                <span>{run.statusWords}</span>
              </div>
              <div className="table-scroll sr-log">
                <table className="table">
                  <thead><tr><th>Contact</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
                  <tbody>
                    {items.map((r) => {
                      const [cls, word] = PILL[r.status] || ['queued', r.status];
                      return (
                        <tr key={r.id}>
                          <td style={{ overflowWrap: 'anywhere' }}>{r.name || '—'}</td>
                          <td className="sr-to">{r.to || '—'}</td>
                          <td className="sr-msg" title={r.message}>{r.message ? `${r.message.slice(0, 60)}${r.message.length > 60 ? '…' : ''}` : '—'}</td>
                          <td><span className={`sr-pill sr-${cls}`}>{word}</span>{r.error ? <small>{r.error}</small> : null}</td>
                        </tr>
                      );
                    })}
                    {!items.length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 22 }}>No rows.</td></tr>}
                  </tbody>
                </table>
              </div>
              {data.windowed && <p style={{ fontSize: 9, color: 'var(--muted)', margin: '8px 0 0' }}>A long list: only the rows around the progress are shown here. The full log is in the download.</p>}
              {data.masked && <p style={{ fontSize: 9, color: 'var(--muted)', margin: '6px 0 0' }}>Numbers and email addresses are hidden for your login.</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          {active && data && data.mayStop && <Btn onClick={stop}>{run.status === 'scheduled' ? 'Cancel this send' : 'Stop sending'}</Btn>}
          {run && !active && <Btn onClick={onClose}>Close</Btn>}
          {run && active && run.status !== 'running' && <Btn onClick={onClose}>Close</Btn>}
          {run && <Btn onClick={log}>⬇ Download log (CSV)</Btn>}
          {run && !active && <Btn primary onClick={() => { onClose(); go('campaigns'); }}>Open Campaigns</Btn>}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';

// WHICH LINE the call goes out on (founder 2026-11-16): API (calls & msgs), Dinstar (calls & msgs), SIP (call). The server lists the lines and says which are connected
// (GET /messaging/call-lines, utils/callLines.js). A line that is not connected is shown but cannot be picked, with the reason. A person's last choice is remembered on this
// computer (the bulk call queue reads the same one). `gw` keeps the shape the Call window already used: { configured, recording } for the line in use.
const KEY = 'tl_call_line';
const saved = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };

export function useCallLines() {
  const [data, setData] = useState(null);
  const [rec, setRec] = useState(false);
  const [pick, setPick] = useState(saved);
  useEffect(() => {
    api.get('/messaging/call-lines').then((r) => setData(r.data)).catch(() => setData(null));
    api.get('/messaging/channels').then((r) => setRec(!!(r.data.call && r.data.call.recording))).catch(() => setRec(false));
  }, []);
  const lines = data ? data.lines : [];
  const cur = lines.find((l) => l.id === pick && l.ready) || lines.find((l) => l.id === (data && data.default)) || lines[0] || null;
  const choose = (id) => { setPick(id); try { localStorage.setItem(KEY, id); } catch { /* the choice is kept for this visit only */ } };
  return { lines, cur, line: cur ? cur.id : '', choose, gw: data ? { configured: !!(cur && cur.ready), recording: !!(cur && cur.id === 'api' && rec) } : null };
}

export default function CallLinePicker({ CL }) {
  if (!CL || !CL.lines.length) return null;
  const { lines, cur } = CL;
  return (
    <div style={{ margin: '8px auto 2px', maxWidth: 360, textAlign: 'left' }}>
      <label htmlFor="call-line" className="small-muted" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>Call using</label>
      <select id="call-line" value={cur ? cur.id : ''} onChange={(e) => CL.choose(e.target.value)} style={{ width: '100%' }} aria-label="Which line to call on">
        {lines.map((l) => <option key={l.id} value={l.id} disabled={!l.ready}>{l.text}{l.ready ? '' : ' - not connected yet'}</option>)}
      </select>
      {cur && !cur.ready && <div className="small-muted" style={{ fontSize: 12, marginTop: 3 }}>{cur.reason}</div>}
    </div>
  );
}

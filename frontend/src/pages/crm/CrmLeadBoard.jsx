// CRM > LEADS, the board (founder 2026-11-06): one column per stage of CRM settings. Drag a lead to move it: Lost asks the reason; Won opens the lead so it can be made a deal.
import { useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, istToday, QuickLog } from './crmShared.jsx';

const short = (n) => { const v = Number(n) || 0; if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`; if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`; return v ? `₹${v.toLocaleString('en-IN')}` : '₹0'; };

// moving a lead, from the board or from the lead itself
export function useMoveLead(onMoved) {
  const { me, toast, openRecord } = useCrm();
  const [asking, setAsking] = useState(null);
  const [reason, setReason] = useState('');
  const [logging, setLogging] = useState(null); // a move was refused: nothing is logged on this lead yet - log it here, then the move is tried again
  async function move(lead, stage, lostReason) {
    if (stage === 'Lost' && !lostReason) { setAsking(lead); setReason(''); return; }
    try {
      const r = await api.post(`/crm/leads/${lead.id}/stage`, { stage, lostReason });
      toast(`Moved to ${stage}.`);
      onMoved(r.data.lead);
      if (r.data.needsDeal) { toast('Won! Press "Convert to deal" on the lead to make the deal.'); openRecord('lead', lead.id); }
    } catch (e) {
      if (e.response && e.response.data && e.response.data.needsLog) { setLogging({ lead, stage, lostReason }); return; }
      toast(errOf(e, 'The lead could not be moved.'));
    }
  }
  const dialog = (
    <>
      {asking && (
        <Modal title={`Why was "${asking.company}" lost?`} onClose={() => setAsking(null)} foot={<><button type="button" className="btn" onClick={() => setAsking(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!reason} onClick={() => { const l = asking; setAsking(null); move(l, 'Lost', reason); }}>Move to Lost</button></>}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {me.lists.lostReasons.map((r) => <button key={r} type="button" className={`btn btn-sm${reason === r ? ' btn-primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
          </div>
        </Modal>
      )}
      {logging && <QuickLog record={logging.lead} intro={`To move ${logging.lead.company} to ${logging.stage}, log what happened with them first. It moves as soon as you save.`} onClose={() => setLogging(null)} onLogged={() => { const l = logging; setLogging(null); move(l.lead, l.stage, l.lostReason); }} />}
    </>
  );
  return { move, dialog };
}

export default function CrmLeadBoard({ rows, onMoved }) {
  const { me, openRecord } = useCrm();
  const { move, dialog } = useMoveLead(onMoved);
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const [logging, setLogging] = useState(null); // 📞 Log on a card
  const today = istToday();
  return (
    <>
      {logging && <QuickLog record={logging} onClose={() => setLogging(null)} onLogged={() => { setLogging(null); onMoved(); }} />}
      <div className="crm-board">
        {me.lists.leadStages.map((s) => {
          const ls = rows.filter((l) => l.stage === s.name);
          return (
            <div
              key={s.name}
              className={`crm-col${over === s.name ? ' drop' : ''}`}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(s.name); } }}
              onDragLeave={() => setOver((o) => (o === s.name ? null : o))}
              onDrop={(e) => { e.preventDefault(); const l = rows.find((x) => x.id === dragId); setOver(null); setDragId(null); if (l && l.stage !== s.name) move(l, s.name); }}
            >
              <div className="crm-col-head" style={{ borderTop: `3px solid ${s.color}` }}><span>{s.name} · {ls.length}</span><span className="sum">{short(ls.reduce((a, l) => a + (Number(l.expectedValue) || 0), 0))}</span></div>
              {ls.map((l) => (
                <div
                  key={l.id}
                  className="crm-card"
                  draggable={me.canEdit && l.status !== 'Converted'}
                  onDragStart={(e) => { setDragId(l.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                  onClick={() => openRecord('lead', l.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') openRecord('lead', l.id); }}
                  role="button"
                  tabIndex={0}
                >
                  <b>{l.contactName && l.contactName !== l.company ? l.contactName : l.company}</b>
                  {l.contactName && l.contactName !== l.company && <div className="small-muted" style={{ fontSize: 12 }}>{l.company}</div>}
                  <div className="small-muted" style={{ fontSize: 12 }}>{[l.expectedValue ? short(l.expectedValue) : '', l.ownerName || 'No owner'].filter(Boolean).join(' · ')}</div>
                  {l.nextTaskDue && <div style={{ fontSize: 12, color: l.nextTaskDue < today ? 'var(--red)' : undefined }}>{`Next: ${l.nextTaskDue === today ? 'Today' : dateOf(l.nextTaskDue)}`}</div>}
                  {me.canEdit && l.status !== 'Converted' && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); setLogging(l); }} aria-label={`Log a call on ${l.company}`}>📞 Log</button>}
                </div>
              ))}
              {!ls.length && <div className="small-muted" style={{ fontSize: 11.5, padding: '4px 4px 10px' }}>No leads.</div>}
            </div>
          );
        })}
      </div>
      {dialog}
    </>
  );
}

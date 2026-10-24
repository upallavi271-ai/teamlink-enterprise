import { useEffect } from 'react';
import { Btn } from '../ui.jsx';

// ---------------------------------------------------------------------------
// The prototype's shared popup (#dashboardDetailModal, 560 px): "← Back to Overview", a bold title, a grey subtitle, a body and a foot.
// Used by the Dashboard (KPI card, channel health row, insight) and, exported, by the campaign page's "Responses" card (ResponsesDetail below).
//   rows: [{ label, value, pct }]  ->  "label | progress track | bold value"  (pct = the bar length, 0-100; leave it out for rows without a bar)
// ---------------------------------------------------------------------------
export function DetailRows({ rows, bars = true }) {
  return (rows || []).map((r) => (
    <div className="dd-row" key={r.label} style={bars ? undefined : { gridTemplateColumns: '1fr auto' }}>
      <span>{r.label}</span>
      {bars && <div className="dd-track"><span className="dd-fill" style={{ width: `${Math.max(0, Math.min(100, Number(r.pct) || 0))}%` }} /></div>}
      <b>{r.value}</b>
    </div>
  ));
}

export default function DetailModal({ title, subtitle, backLabel = '← Back to Overview', onClose, foot, children, width = 560 }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg show" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px,100%)` }}>
        <div className="modal-head">
          <div>
            {backLabel && <button type="button" className="dd-back" onClick={onClose}>{backLabel}</button>}
            <b>{title}</b>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '72vh', overflow: 'auto' }}>{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

// The campaign page's "Responses" popup (the prototype's openResponsesDetail), with REAL numbers from GET /api/outreach/gs/overview/responses?campaignId=
// data = that answer { campaign: { name }, total, sent, clicks, applied, rows }.  onInbox = go to the Inbox.  The prototype's split of replies into
// "Yes / follow-up / callback / opted out" is not shown: a reply cannot be classified without reading it, so only counted things are listed.
export function ResponsesDetail({ data, onClose, onInbox }) {
  return (
    <DetailModal title="Responses" subtitle={`${data.campaign ? data.campaign.name : 'Campaign'} · ${Number(data.total || 0).toLocaleString('en-IN')} total response${data.total === 1 ? '' : 's'}`} backLabel="← Back" onClose={onClose}
      foot={<><Btn onClick={onClose}>Close</Btn>{onInbox && <Btn primary onClick={onInbox}>View in Inbox</Btn>}</>}>
      <div style={{ textAlign: 'center', margin: '6px 0 14px' }}>
        <div style={{ fontSize: 34, fontWeight: 900, fontFamily: "'Space Grotesk',sans-serif" }}>{Number(data.total || 0).toLocaleString('en-IN')}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>wrote back, out of {Number(data.sent || 0).toLocaleString('en-IN')} messages really sent</div>
      </div>
      <DetailRows rows={(data.rows || []).map((r) => ({ label: r.label, value: Number(r.value || 0).toLocaleString('en-IN') }))} bars={false} />
    </DetailModal>
  );
}

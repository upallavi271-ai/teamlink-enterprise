// ---------------------------------------------------------------------------
// THE LIVE AGREEMENT BESIDE "ADD CLIENT" / "EDIT CLIENT" (2026-10-05). It only
// SHOWS what the server built (POST /clients/agreement-preview — the same code
// that saves the draft); nothing here writes agreement text. The values the
// form filled in are highlighted so the user sees them land in the document.
// Internal notes are never part of it.
// ---------------------------------------------------------------------------
import AgreementDocView from './AgreementDocView.jsx';

function Term({ k, v }) {
  return (
    <div className="acw-term">
      <div className="k">{k}</div>
      <div className={`v${v ? '' : ' blank'}`}>{v || 'Not set'}</div>
    </div>
  );
}
const day = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null);
const ddmmyyyy = (ymd) => { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

export default function AgreementLivePreview({ preview, state, className = '', title = 'Agreement preview', note = 'This is the draft we save when you press Save & create agreement.' }) {
  const t = preview?.keyTerms || {};
  const fixed = t.feeType && t.feeType !== 'PERCENT_CTC';
  const words = [
    t.clientName, t.address, t.feeText, ddmmyyyy(t.startDate),
    t.invoiceDays ? `after ${t.invoiceDays} days` : null,
    t.paymentDays != null ? `within ${t.paymentDays} days` : null,
    t.signatoryName, t.signatoryTitle,
  ].filter(Boolean);
  return (
    <aside className={`acw-preview ${className}`} aria-label="Agreement preview">
      <div className="acw-preview-head">
        <b>{title}</b>
        <span className="acw-status" role="status">
          {state === 'loading' ? 'Updating…' : state === 'error' ? 'Preview not available right now' : 'Fills in as you type'}
        </span>
      </div>
      <div className="acw-terms">
        <Term k="Client" v={t.clientName} />
        <Term k="Template" v={t.template} />
        <Term k="Fee" v={t.feeText ? (fixed ? t.feeText.replace(/ And .*$/, '') : `${t.feePercent}% of yearly CTC${t.gstApplicable === false ? '' : ` + GST ${t.gstPercent}%`}`) : null} />
        <Term k="Replacement guarantee" v={t.guaranteeDays != null ? (t.guaranteeDays === 0 ? 'No replacement' : `${t.guaranteeDays} days (${t.guaranteeWords})`) : null} />
        <Term k="Invoice" v={t.invoiceDays != null ? (t.invoiceDays === 0 ? 'On the joining day' : `${t.invoiceDays} days after joining`) : null} />
        <Term k="Payment" v={t.paymentDays != null ? `Within ${t.paymentDays} days of invoice` : null} />
        <Term k="Effective date" v={day(t.startDate)} />
        <Term k="Expiry date" v={t.endDate ? day(t.endDate) : 'Renews by itself'} />
        <Term k="Address" v={t.address} />
        <Term k="Signs for TeamLink" v={t.signatoryName ? `${t.signatoryName}${t.signatoryTitle ? `, ${t.signatoryTitle}` : ''}` : null} />
      </div>
      <div className="acw-doc" tabIndex={0}>
        {preview?.document ? <AgreementDocView text={preview.document} words={words} /> : 'Loading the agreement…'}
      </div>
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{note}</div>
    </aside>
  );
}

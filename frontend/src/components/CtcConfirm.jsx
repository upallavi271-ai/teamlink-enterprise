// ---------------------------------------------------------------------------
// CTC "is this right?" — the screen half of the server's CTC check
// (backend/src/utils/ctcCheck.js).
//
// The server refuses an impossible CTC in plain words (400), and for an odd one
// (below Rs 1 lakh or above Rs 1 crore a year) answers 409 with
// { needsConfirm: true, code: 'CTC_CONFIRM', error: <the sentence> }. The form
// then shows that sentence and ONE main button, "Yes, this is correct", which
// sends the same request again with confirmCtc: true. "No, change it" goes back
// to the number.
//
//   catch (err) { const ask = ctcAsk(err); if (ask) { setAsk(ask); return; } … }
//   {ask && <CtcAsk ask={ask} />}
//   footer when ask is set: <CtcAskButtons onYes={() => save(true)} onNo={() => setAsk(null)} busy={busy} />
// ---------------------------------------------------------------------------

// The 409 "please confirm" answer as { message, value }, or null for any other error.
export function ctcAsk(err) {
  const d = err && err.response && err.response.data;
  return d && d.needsConfirm && d.code === 'CTC_CONFIRM' ? { message: d.error, value: d.value } : null;
}

export function CtcAsk({ ask }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid #fdba74', background: '#fff7ed', color: '#7c2d12', fontSize: 14,
      }}
    >
      {ask.message}
    </div>
  );
}

export function CtcAskButtons({ onYes, onNo, busy = false }) {
  return (
    <>
      <button type="button" className="btn" disabled={busy} onClick={onNo}>No, change it</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onYes}>{busy ? 'Saving…' : 'Yes, this is correct'}</button>
    </>
  );
}

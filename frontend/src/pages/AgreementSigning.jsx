// ---------------------------------------------------------------------------
// THE CLIENT-FACING SIGNING PAGE, reached by the tokenised link TeamLink sends
// out over mail, WhatsApp or SMS. No TeamLink login: the signatory is a person
// at the client, not a user of this system.
//
// The flow, in the order the client actually does it:
//
//   1. READ        the agreement, with TeamLink's stamp and signature already
//                  on it — they are looking at a document that is half-executed
//   2. SEAL        upload their own stamp and signature, and name the signatory
//   3. DONE        choose how to verify: Aadhaar, or the alternative
//   4. VERIFY      enter the code sent to their mobile, and submit
//
// Each step only opens when the one before it is complete, because an
// agreement signed by somebody who never uploaded a signature is not signed by
// anybody. The server enforces the same order — this is the courteous version
// of the same rule, not the rule itself.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const STEPS = [
  ['read', 'Read the agreement'],
  ['seal', 'Add your stamp & signature'],
  ['verify', 'Verify and submit'],
];

export default function AgreementSigning() {
  const { token } = useParams();
  const [agreement, setAgreement] = useState(null);
  const [executed, setExecuted] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [step, setStep] = useState('read');

  // Step 2
  const [who, setWho] = useState({ signedBy: '', signedByTitle: '' });
  // Step 3/4
  const [method, setMethod] = useState('');
  const [aadhaar, setAadhaar] = useState('');
  const [mobile, setMobile] = useState('');
  const [sent, setSent] = useState(null);
  const [otp, setOtp] = useState('');

  const load = useCallback(() => {
    api.get(`/public/agreement/${token}`)
      .then((res) => setAgreement(res.data))
      .catch((err) => setError(err.response?.data?.error || 'This signing link is not valid'));
  }, [token]);
  useEffect(load, [load]);

  async function upload(kind, file) {
    if (!file) return;
    setBusy(kind); setError('');
    const body = new FormData();
    body.append('kind', kind);
    body.append('signedBy', who.signedBy);
    body.append('signedByTitle', who.signedByTitle);
    body.append('file', file);
    try {
      const res = await api.post(`/agreement/token/${token}/client-seal`, body);
      setExecuted(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'That image could not be uploaded.');
    } finally { setBusy(''); }
  }

  async function startVerify(e) {
    e.preventDefault();
    setBusy('start'); setError('');
    try {
      const res = await api.post(`/agreement/token/${token}/verify/start`, { method, aadhaar, mobile });
      setSent(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start the verification.');
    } finally { setBusy(''); }
  }

  async function confirmVerify(e) {
    e.preventDefault();
    setBusy('confirm'); setError('');
    try {
      const res = await api.post(`/agreement/token/${token}/verify/confirm`, { otp });
      setExecuted(res.data);
      setAgreement((a) => ({ ...a, status: 'SIGNED' }));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not verify that code.');
    } finally { setBusy(''); }
  }

  const sealed = !!(executed && executed.clientSide && executed.clientSide.sealedAt);
  const done = !!(executed && executed.verification);
  const signedAlready = agreement && agreement.status === 'SIGNED' && !done;

  return (
    <div className="careers-shell">
      <header className="careers-header">
        <div className="logo-lockup">
          <div className="mark">TL</div>
          <div>
            <div style={{ fontWeight: 600 }}>TeamLink Consultants</div>
            <div className="small-muted">Service agreement</div>
          </div>
        </div>
      </header>

      <main className="careers-content">
        {error && !agreement && <div className="error-text">{error}</div>}
        {!agreement && !error && <div className="small-muted">Loading…</div>}

        {agreement && (
          <>
            <h1>Recruitment / Staffing Services Agreement</h1>
            <p className="small-muted">
              {agreement.clientName}
              {agreement.agreementId ? ` · ${agreement.agreementId}` : ''}
            </p>

            {/* Where they are, so a four-step process does not feel like a form
                that keeps growing. */}
            {!done && !signedAlready && (
              <div className="tabs" style={{ marginBottom: 14 }}>
                {STEPS.map(([key, label], i) => (
                  <div
                    key={key}
                    className={`tab${step === key ? ' active' : ''}`}
                    onClick={() => setStep(key)}
                  >
                    {`${i + 1}. ${label}`}
                    {key === 'seal' && sealed && ' ✓'}
                  </div>
                ))}
              </div>
            )}

            {error && <div className="notice red">{error}</div>}

            {/* ---------------- DONE ---------------- */}
            {(done || signedAlready) && (
              <div className="card section">
                <h3>Signed</h3>
                <div className="small-muted">
                  {done ? (
                    <>
                      Verified by {executed.verifiedBy} on{' '}
                      {new Date(executed.verification.verifiedAt).toLocaleString()}
                      {executed.verification.aadhaarLast4
                        ? ` · Aadhaar ending ${executed.verification.aadhaarLast4}`
                        : ''}
                      {executed.verification.mobile ? ` · ${executed.verification.mobile}` : ''}.
                    </>
                  ) : (
                    <>
                      Signed by {agreement.signedBy}
                      {agreement.signedByTitle ? ` (${agreement.signedByTitle})` : ''}
                      {agreement.signedAt ? ` on ${new Date(agreement.signedAt).toLocaleString()}` : ''}.
                    </>
                  )}
                  <div style={{ marginTop: 6 }}>
                    A copy is now with your TeamLink account team — you can close this window.
                  </div>
                </div>
                {/* Said to the person signing, not hidden in a log. */}
                {done && executed.verification.note && (
                  <div className="notice amber" style={{ marginTop: 12 }}>
                    {executed.verification.note}
                  </div>
                )}
              </div>
            )}

            {/* ---------------- 1. READ ---------------- */}
            {!done && !signedAlready && step === 'read' && (
              <>
                <div className="card section">
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 460, overflowY: 'auto', margin: 0 }}>
                    {agreement.document}
                  </pre>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => setStep('seal')}>
                    I have read it — continue
                  </button>
                </div>
              </>
            )}

            {/* ---------------- 2. SEAL ---------------- */}
            {!done && !signedAlready && step === 'seal' && (
              <div className="card section">
                <h3>Your stamp and signature</h3>
                <p className="small-muted">
                  Upload a clear image of your company stamp and of the authorised signatory&apos;s signature.
                  PNG or JPG, up to 5 MB each.
                </p>

                <div className="grid-2">
                  <label className="field">
                    <span>Signatory name</span>
                    <input
                      value={who.signedBy}
                      onChange={(e) => setWho({ ...who, signedBy: e.target.value })}
                      placeholder="Full name"
                    />
                  </label>
                  <label className="field">
                    <span>Designation</span>
                    <input
                      value={who.signedByTitle}
                      onChange={(e) => setWho({ ...who, signedByTitle: e.target.value })}
                      placeholder="Director / Authorised Signatory"
                    />
                  </label>
                </div>

                <div className="grid-2">
                  <label className="field">
                    <span>Company stamp {executed?.clientSide?.hasStamp && '✓'}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      disabled={busy === 'client-stamp'}
                      onChange={(e) => upload('client-stamp', e.target.files[0])}
                    />
                  </label>
                  <label className="field">
                    <span>Signature {executed?.clientSide?.hasSignature && '✓'}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      disabled={busy === 'client-sign'}
                      onChange={(e) => upload('client-sign', e.target.files[0])}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <span className="small-muted">
                    {sealed ? 'Both uploaded.' : 'Both are needed before you can submit.'}
                  </span>
                  <button className="btn btn-primary" disabled={!sealed} onClick={() => setStep('verify')}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {/* ---------------- 3/4. VERIFY ---------------- */}
            {!done && !signedAlready && step === 'verify' && (
              <div className="card section">
                <h3>Verify and submit</h3>

                {!sent ? (
                  <form onSubmit={startVerify}>
                    <p className="small-muted">Choose how you would like to verify the signature.</p>

                    <label className="field" style={{ display: 'block', marginBottom: 10 }}>
                      <input
                        type="radio"
                        name="method"
                        checked={method === 'AADHAAR'}
                        onChange={() => setMethod('AADHAAR')}
                      />
                      <b style={{ marginLeft: 8 }}>Aadhaar verification</b>
                      <div className="small-muted" style={{ marginLeft: 26 }}>
                        Aadhaar number, eSign and a one-time code to your mobile.
                      </div>
                    </label>

                    {method === 'AADHAAR' && (
                      <>
                        <label className="field">
                          <span>Aadhaar number</span>
                          <input
                            inputMode="numeric"
                            maxLength={14}
                            value={aadhaar}
                            onChange={(e) => setAadhaar(e.target.value)}
                            placeholder="12 digits"
                          />
                        </label>
                        {/* Said before they type it, not after. */}
                        <div className="small-muted" style={{ marginTop: -6, marginBottom: 10 }}>
                          Your Aadhaar number is used only for this signature and is never stored — only
                          the last four digits are kept, on the signed record.
                        </div>
                      </>
                    )}

                    <label className="field" style={{ display: 'block', marginBottom: 10 }}>
                      <input
                        type="radio"
                        name="method"
                        checked={method === 'ALTERNATIVE'}
                        onChange={() => setMethod('ALTERNATIVE')}
                      />
                      <b style={{ marginLeft: 8 }}>Alternative verification</b>
                      <div className="small-muted" style={{ marginLeft: 26 }}>
                        A one-time code to the mobile number on your account.
                      </div>
                    </label>

                    <label className="field">
                      <span>Mobile number</span>
                      <input
                        inputMode="numeric"
                        maxLength={13}
                        value={mobile}
                        onChange={(e) => setMobile(e.target.value)}
                        placeholder="10 digits"
                      />
                    </label>

                    <button className="btn btn-primary" type="submit" disabled={!method || busy === 'start'}>
                      {busy === 'start' ? 'Sending…' : 'Send the code'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={confirmVerify}>
                    <p className="small-muted">
                      {`A ${sent.ttlMinutes}-minute code was sent to ${sent.mobile}.`}
                    </p>
                    {sent.note && <div className="notice amber">{sent.note}</div>}
                    <label className="field">
                      <span>Verification code</span>
                      <input
                        inputMode="numeric"
                        maxLength={6}
                        value={otp}
                        onChange={(e) => setOtp(e.target.value)}
                        placeholder="6 digits"
                      />
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary" type="submit" disabled={otp.length < 6 || busy === 'confirm'}>
                        {busy === 'confirm' ? 'Verifying…' : 'Submit and sign'}
                      </button>
                      <button className="btn" type="button" onClick={() => { setSent(null); setOtp(''); }}>
                        Start again
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

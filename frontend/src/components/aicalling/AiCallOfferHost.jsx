import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import AiCallDialog from './AiCallDialog.jsx';
import { OFFER_EVENT } from './aiCallingShared.js';

// Sits once in the app shell. When a recruiter moves a candidate to the shortlisted step, or an interview is booked or moved, the
// server writes an "offer" (only a question). This host notices the move, asks the server for the offer and shows it:
// "Tell them with the AI assistant?". Nothing is called unless the person then confirms in the call window.
//
// It watches the answers of the ordinary screens (no change to those screens): PATCH /applications/:id/stage and
// POST /ats/interviews/:id/(book|reschedule).
export default function AiCallOfferHost() {
  const [offer, setOffer] = useState(null);
  const [dialog, setDialog] = useState(false);
  const usable = useRef(null); // null = unknown, false = this login cannot use AI calling

  useEffect(() => {
    const id = api.interceptors.response.use((res) => {
      try {
        const m = (res.config.method || '').toLowerCase();
        const url = String(res.config.url || '');
        let appId = null;
        let mm = /\/applications\/([^/]+)\/stage$/.exec(url);
        if (m === 'patch' && mm) [, appId] = mm;
        mm = /\/ats\/interviews\/([^/]+)\/(book|reschedule)$/.exec(url);
        if (m === 'post' && mm) [, appId] = mm;
        if (appId) window.dispatchEvent(new CustomEvent(OFFER_EVENT, { detail: { applicationId: appId } }));
      } catch { /* never disturb the screen */ }
      return res;
    });
    return () => api.interceptors.response.eject(id);
  }, []);

  useEffect(() => {
    async function check(e) {
      const appId = e.detail && e.detail.applicationId;
      if (!appId || usable.current === false) return;
      try {
        const r = await api.get('/ai-calling/offers', { params: { applicationId: appId } });
        usable.current = true;
        const first = (r.data.rows || [])[0];
        if (first) { setOffer(first); setDialog(false); }
      } catch (err) {
        if (err && err.response && [401, 403].includes(err.response.status)) usable.current = false;
      }
    }
    window.addEventListener(OFFER_EVENT, check);
    return () => window.removeEventListener(OFFER_EVENT, check);
  }, []);

  if (!offer) return null;
  const close = () => { setOffer(null); setDialog(false); };
  if (dialog) return <AiCallDialog applicationIds={[offer.applicationId]} purpose={offer.purpose} offerId={offer.id} onClose={close} onDone={() => {}} />;
  return (
    <Modal
      title="Tell them with the AI assistant?"
      onClose={close}
      foot={(
        <>
          <button className="btn" onClick={() => { api.post(`/ai-calling/offers/${offer.id}/dismiss`).catch(() => {}); close(); }}>Not now</button>
          <button className="btn btn-primary" onClick={() => setDialog(true)}>Preview and call</button>
        </>
      )}
    >
      <p style={{ marginTop: 0 }}>
        <b>{offer.candidateName}</b>
        {offer.kind === 'shortlist'
          ? ` is now shortlisted for ${offer.jobTitle}. The AI assistant can phone them to tell them.`
          : ` has an interview for ${offer.jobTitle} that was just booked or changed. The AI assistant can phone them with the real date, time and place.`}
      </p>
      <div className="small-muted">You will see exactly what it will say first. Nothing is called unless you press the call button on the next screen.</div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// THE THANK-YOU SCREEN after the client has signed (user, 2026-10-10, note
// item 5). It is the ONLY thing a signed link shows: on the page the client
// lands on after "I agree & sign" and every time the signed link is opened
// again. The agreement text is never drawn here (and the server no longer
// sends it once the agreement is signed): the logo, a thank-you, what happens
// next, who to contact, the signed details and ONE button to download the PDF.
//
// The PDF comes from GET /api/agreement/token/:token/pdf — the link's own
// key, no login, only this agreement. If it is not ready yet the screen says
// "Preparing your PDF…" and tries again by itself.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { TeamLinkMark } from '../Logo.jsx';
import './agreements.css';
import './agreementBrand.css';
import './agreementThanks.css';

const RETRIES = 6;
const RETRY_MS = 3000;

function when(d) {
  return d ? `${new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST` : '—';
}

function Row({ k, v }) {
  return (
    <div className="agt-row">
      <dt>{k}</dt>
      <dd>{v || '—'}</dd>
    </div>
  );
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function AgreementThanks({ view, token }) {
  const [dl, setDl] = useState({ state: 'idle', text: '' });
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const active = view.status === 'ACTIVE';
  const who = view.signedBy || view.signature?.signedBy || '';
  const title = view.signedByTitle || view.signature?.signedByTitle || '';
  const first = who.trim().split(/\s+/)[0] || '';
  const c = view.contact || {};
  const pdfUrl = `/api/agreement/token/${token}/pdf`;
  const fileName = `${view.agreementId || 'agreement'}-signed.pdf`;

  async function download(copy, attempt = 0) {
    clearTimeout(timer.current);
    setDl({ state: attempt ? 'preparing' : 'busy', text: '' });
    try {
      const r = await api.get(`/agreement/token/${token}/pdf`, { responseType: 'blob', params: copy ? { copy } : undefined });
      saveBlob(r.data, copy === 'emudhra' ? `${view.agreementId || 'agreement'}-eMudhra-signed.pdf` : fileName);
      setDl({ state: 'done', text: 'Your PDF is downloading. Look in your Downloads folder.' });
    } catch (err) {
      const status = err.response?.status;
      if ((!status || status === 409 || status >= 500) && attempt < RETRIES) {
        setDl({ state: 'preparing', text: '' });
        timer.current = setTimeout(() => download(copy, attempt + 1), RETRY_MS);
        return;
      }
      setDl({
        state: 'error',
        text: status === 404 || status === 410
          ? 'This download link has ended. Please ask your TeamLink contact to send you a copy.'
          : 'We could not get your PDF just now. Please try again in a minute.',
      });
    }
  }
  const press = (copy) => (e) => { e.preventDefault(); download(copy); };
  const busy = dl.state === 'busy' || dl.state === 'preparing';

  return (
    <div className="careers-shell agt-shell">
      <main className="agr-sign agt-main">
        <div className="agt-logo"><TeamLinkMark width={230} /></div>

        <section className="agr-card agt-card" aria-labelledby="agt-h">
          <div className="agt-tick" aria-hidden="true">✓</div>
          <h1 id="agt-h">{first ? `Thank you, ${first}!` : 'Thank you!'}</h1>
          <p className="agt-lead">
            {`Your service agreement ${view.agreementId || ''} with TeamLink Consultants is signed.`.replace(/\s+/g, ' ')}
          </p>

          <p className="agt-dl-line">You can download your PDF here</p>
          <a className={`btn btn-primary agt-main-btn${busy ? ' is-busy' : ''}`} href={pdfUrl} onClick={press()} aria-disabled={busy}>
            {dl.state === 'busy' ? 'Please wait…' : (dl.state === 'preparing' ? 'Preparing your PDF…' : 'Download your agreement (PDF)')}
          </a>
          {dl.state === 'preparing' && <p className="small-muted agt-note" role="status">Your PDF is being made. This page tries again by itself, so you do not need to do anything.</p>}
          {dl.state === 'done' && <p className="agt-note agt-ok" role="status">{dl.text}</p>}
          {dl.state === 'error' && <p className="agt-note agt-bad" role="alert">{dl.text}</p>}
          {view.emudhra?.signed && (
            <p className="agt-note">
              <a href={`${pdfUrl}?copy=emudhra`} onClick={press('emudhra')}>Download the Aadhaar eSign (eMudhra) copy</a>
            </p>
          )}
        </section>

        <section className="agr-card agt-card agt-next" aria-labelledby="agt-next-h">
          <h2 id="agt-next-h">What happens next</h2>
          <ol className="agt-steps">
            <li className="done">You signed and stamped the agreement.</li>
            <li className={active ? 'done' : 'now'}>{active ? 'TeamLink has signed and stamped too.' : 'TeamLink adds its own signature and stamp. We have already been told.'}</li>
            <li className={active ? 'done' : ''}>{active ? 'Your agreement is Active. We can start sending you profiles.' : 'Your agreement becomes Active. You do not need to do anything.'}</li>
          </ol>
          <p className="agt-contact">
            {'Questions? Talk to '}
            <b>{c.name || 'your TeamLink contact'}</b>
            {c.phone ? <>{' on '}<a href={`tel:${String(c.phone).replace(/[^\d+]/g, '')}`}>{c.phone}</a></> : null}
            {c.email ? <>{c.phone ? ' or write to ' : ' at '}<a href={`mailto:${c.email}`}>{c.email}</a></> : null}
            .
          </p>
        </section>

        <section className="agr-card agt-card" aria-labelledby="agt-sum-h">
          <h2 id="agt-sum-h">Your signed details</h2>
          <dl className="agt-sum">
            <Row k="Agreement number" v={view.agreementId} />
            <Row k="Company" v={view.clientName} />
            <Row k="Signed on" v={when(view.signedAt)} />
            <Row k="Signed by" v={who ? `${who}${title ? `, ${title}` : ''}` : ''} />
            <Row k="Status" v={active ? 'Active' : 'Waiting for TeamLink to sign'} />
          </dl>
        </section>
      </main>
    </div>
  );
}

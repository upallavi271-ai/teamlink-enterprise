// ---------------------------------------------------------------------------
// THE TEAMLINK LOGO ON THE AGREEMENT (user, 2026-10-10, note item 5).
// The same artwork the app uses everywhere (assets/teamlink-full-logo.png via
// components/Logo.jsx, untouched), drawn
//   - in the page header of the signing screens        <AgreementHeader />
//   - at the top of the agreement text (screen + print) <DocLogoBar />
//   - small, with the page-footer note under the text   <PageFootNote />
// The PDF header uses the same file (backend utils/agreementPdf.js).
// ---------------------------------------------------------------------------
import { TeamLinkMark } from '../Logo.jsx';
import './agreementBrand.css';

// The band at the top of the public agreement pages: logo on a white plate
// (safe on the dark band and in dark mode) + what this page is.
export function AgreementHeader({ label = 'Service agreement' }) {
  return (
    <header className="agb-header agrs-noprint">
      <span className="agb-plate"><TeamLinkMark width={150} /></span>
      <span className="agb-label">{label}</span>
    </header>
  );
}

// Top of the agreement document: logo on the left, the agreement number on the
// right (like every PDF page header). Prints in black and white.
export function DocLogoBar({ agreementNo = '' }) {
  return (
    <div className="agb-docbar">
      <TeamLinkMark width={132} />
      {agreementNo ? <span className="agb-docno">{`Agreement No. ${agreementNo}`}</span> : null}
    </div>
  );
}

// What the bottom of every PDF page carries, shown once under the text so the
// screen and the PDF match: Page X of Y, TeamLink's and the client's stamp +
// initials. signNode / stampNode are the real images when they exist.
export function PageFootNote({ agreementNo = '', teamlink = null, signer = null }) {
  const box = (who, label) => (
    <div className="agb-foot-side">
      <span className="agb-foot-imgs">
        <span className="agb-foot-box">{who && who.stampNode ? who.stampNode : <i>Stamp</i>}</span>
        <span className="agb-foot-box agb-foot-wide">{who && who.signNode && !who.esign ? who.signNode : <i>Initial here</i>}</span>
      </span>
      <span className="agb-foot-cap">{label}</span>
    </div>
  );
  return (
    <div className="agb-foot" aria-label="What is printed at the bottom of every PDF page">
      {box(teamlink, 'Initialled by TeamLink')}
      <div className="agb-foot-mid">
        <b>{agreementNo ? `Agreement No. ${agreementNo} · Page X of Y` : 'Agreement No. · Page X of Y'}</b>
        <span>Every PDF page has this strip at the bottom, with the TeamLink logo and agreement number at the top.</span>
      </div>
      {box(signer, 'Initialled by Client')}
    </div>
  );
}

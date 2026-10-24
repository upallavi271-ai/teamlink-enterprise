// ---------------------------------------------------------------------------
// /agreements/:clientId — one agreement, for everyone allowed to see it: the
// client's own login, the client's BDE, Accounts, Manager, Admin and Super
// Admin. Admin / Super Admin also get countersign, dates and void (the server
// decides — see routes/agreementSeal.js). Everyone else gets a 403 message.
// ---------------------------------------------------------------------------
import { Link, useParams } from 'react-router-dom';
import AgreementPanel from '../components/agreements/AgreementPanel.jsx';
import SignedAgreementFiles, { ViewAgreementButton } from '../components/agreements/SignedAgreementFiles.jsx';

export default function AgreementView() {
  const { clientId } = useParams();
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service agreement</h1>
          <div className="page-sub">The agreement, both signatures, the OTP confirmation and the signed PDF</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ViewAgreementButton clientId={clientId} esign={false} />
          <Link className="btn btn-sm" to="/agreements" style={{ whiteSpace: 'nowrap' }}>← All agreements</Link>
        </div>
      </div>
      {/* Every signed agreement file kept on this client (PDF / picture); nothing is shown when there are none. */}
      <SignedAgreementFiles clientId={clientId} />
      <AgreementPanel clientId={clientId} showDocument />
    </div>
  );
}

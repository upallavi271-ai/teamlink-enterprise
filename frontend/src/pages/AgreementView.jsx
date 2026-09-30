// ---------------------------------------------------------------------------
// /agreements/:clientId — one agreement, for everyone allowed to see it: the
// client's own login, the client's BDE, Accounts, Manager, Admin and Super
// Admin. Admin / Super Admin also get countersign, dates and void (the server
// decides — see routes/agreementSeal.js). Everyone else gets a 403 message.
// ---------------------------------------------------------------------------
import { Link, useParams } from 'react-router-dom';
import AgreementPanel from '../components/agreements/AgreementPanel.jsx';

export default function AgreementView() {
  const { clientId } = useParams();
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service agreement</h1>
          <div className="page-sub">The agreement, both signatures, the OTP confirmation and the signed PDF</div>
        </div>
        <Link className="btn btn-sm" to="/agreements">← All agreements</Link>
      </div>
      <AgreementPanel clientId={clientId} showDocument />
    </div>
  );
}

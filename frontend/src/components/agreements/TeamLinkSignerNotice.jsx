// "TeamLink signer not set yet → Set it now" (2026-10-05). Shown to Super
// Admin / Admin on the client's Agreement card and in the agreement-link card
// while the TeamLink signer's name, signature or company stamp is missing in
// Agreement settings. Anyone else gets nothing (the server answers 403).
import { useEffect, useState } from 'react';
import api from '../../api';
import { AgreementSettingsButton } from './AgreementSettings.jsx';

export default function TeamLinkSignerNotice({ refreshKey }) {
  const [s, setS] = useState(null);
  useEffect(() => {
    api.get('/agreement/settings/teamlink-seal').then((r) => setS(r.data)).catch(() => setS(null));
  }, [refreshKey]);
  if (!s || s.ready) return null;
  const missing = [!s.signatoryName && 'name', !s.hasSign && 'signature', !s.hasStamp && 'company stamp'].filter(Boolean);
  return (
    <div className="agr-setnow" role="status">
      <span>{`TeamLink signer not set yet (${missing.join(', ')} missing).`}</span>
      <AgreementSettingsButton label="Set it now →" className="btn btn-sm" />
    </div>
  );
}

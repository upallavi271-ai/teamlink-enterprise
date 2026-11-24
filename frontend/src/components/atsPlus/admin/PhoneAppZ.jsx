import { useEffect, useState } from 'react';
import api from '../../../api';
import { Notice, Section, Table, useLoad, useAction, Field, row } from '../kit.jsx';

// ATS settings -> Organisation -> Phone app (15.13, ATS wave 2 Z). TeamLink installs from the browser today (Add to Home screen), with
// shortcuts to the ATS screens. A Google Play / App Store app needs the founder's developer accounts; the details typed here make the
// two files the stores check (/.well-known/assetlinks.json, /.well-known/apple-app-site-association). Backend: utils/atsPlus/mobileZ.js.
export default function PhoneAppZ() {
  const { data, err, reload } = useLoad('/ats-plus/mobilez');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ androidPackage: '', androidSha256: '', iosTeamId: '', iosBundleId: '' });
  useEffect(() => { if (data && data.saved) setF({ ...data.saved, androidSha256: (data.saved.androidSha256 || []).join('\n') }); }, [data]);
  return (
    <Section title="Phone app" note="Recruiters and interviewers install TeamLink from the browser on their phone (Chrome / Safari: Add to Home screen). The app's long-press shortcuts open the ATS screens directly. A Google Play or App Store listing needs the founder's developer accounts.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <>
        <div className="small-muted" data-testid="phone-app-status">Installable now: <b>{data.installable ? 'yes' : 'no'}</b> · ATS shortcuts: <b>{data.atsShortcuts}</b> · Google Play: <b>{data.android.ready ? 'details ready' : 'needs founder account'}</b> · App Store: <b>{data.ios.ready ? 'details ready' : 'needs founder account'}</b></div>
        <Table rows={data.shortcuts} rowKey={(r) => r.url} cols={[{ key: 'name', label: 'Shortcut' }, { key: 'url', label: 'Opens' }, { key: 'ats', label: 'ATS', render: (r) => (r.ats ? 'ATS' : '') }]} />
        {data.canEdit && (
          <div className="card" style={{ padding: 10, marginTop: 8 }}>
            <div className="grid-2">
              <Field label="Android package name" hint={data.android.needs}><input value={f.androidPackage} placeholder="in.teamlink.app" onChange={(e) => setF({ ...f, androidPackage: e.target.value })} /></Field>
              <Field label="Signing key SHA-256 fingerprint(s)" hint="Play Console > App integrity > App signing. One per line."><textarea rows={2} value={f.androidSha256} onChange={(e) => setF({ ...f, androidSha256: e.target.value })} /></Field>
              <Field label="Apple Team ID" hint={data.ios.needs}><input value={f.iosTeamId} onChange={(e) => setF({ ...f, iosTeamId: e.target.value })} /></Field>
              <Field label="iOS bundle ID"><input value={f.iosBundleId} placeholder="in.teamlink.app" onChange={(e) => setF({ ...f, iosBundleId: e.target.value })} /></Field>
            </div>
            <div style={row}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/mobilez', f), 'Saved.')}>Save</button>
              <a href={data.android.file} target="_blank" rel="noreferrer">assetlinks.json</a><a href={data.ios.file} target="_blank" rel="noreferrer">apple-app-site-association</a></div>
          </div>
        )}
      </>}
    </Section>
  );
}

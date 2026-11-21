import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import TabStrip from '../../components/ui/TabStrip.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> COMPANY SETUP -> ATS SETTINGS (market wave, founder 2026-11-21). The ATS settings that the market benchmark
// asked for, in five tabs (no sidebar item): Organisation, Forms & workflows, Offers & onboarding, Integrations, Privacy & security.
// Each panel reads /api/ats-plus/* (backend/src/utils/atsPlus/*); the server decides who may change what (Super Admin / Admin).
// ---------------------------------------------------------------------------
const P = {
  org: lazy(() => import('../../components/atsPlus/admin/OrgTab.jsx')),
  forms: lazy(() => import('../../components/atsPlus/admin/FormsTab.jsx')),
  onboarding: lazy(() => import('../../components/atsPlus/admin/OnboardingTab.jsx')),
  integrations: lazy(() => import('../../components/atsPlus/admin/IntegrationsTab.jsx')),
  privacy: lazy(() => import('../../components/atsPlus/admin/PrivacyTab.jsx')),
};
const TABS = [
  { key: 'org', label: 'Organisation', hint: 'Branches, seats and plan, currencies, languages' },
  { key: 'forms', label: 'Forms & workflows', hint: 'Extra fields and sections on the candidate, job and client forms; the steps each department must follow' },
  { key: 'onboarding', label: 'Offers & onboarding', hint: 'The offer clause library, joining checklists per client and job type, the pre-boarding portal' },
  { key: 'integrations', label: 'Integrations', hint: 'Open API keys, webhooks (Zapier / n8n), Slack / Teams, Google / Microsoft, single sign-on, verification and assessment vendors, job boards' },
  { key: 'privacy', label: 'Privacy & security', hint: 'DPDP notice, consent records, data requests, breaches, retention, Aadhaar / PAN, where data is stored, status and trust pages' },
];

export default function AtsPlusSettings() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'org';
  const Panel = P[tab];
  return (
    <div>
      <div className="page-head"><div><h1>ATS settings</h1><div className="page-sub">Organisation, forms, onboarding, integrations and privacy for the ATS</div></div></div>
      <TabStrip label="ATS settings" tabs={TABS} value={tab} onChange={(k) => setParams({ tab: k })} />
      <Suspense fallback={<div className="small-muted">Loading…</div>}><Panel /></Suspense>
    </div>
  );
}

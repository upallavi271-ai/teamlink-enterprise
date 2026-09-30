import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { LoadingState, ErrorState } from '@/components/feedback/states';
import { IntegrationsPage } from './IntegrationsPage';
import { SocialAccountsPanel } from './SocialAccountsPanel';
import { settingsService } from '@/services/settings/settings.service';
import { useCan } from '@/features/auth/useCan';
import { useOrgStore } from '@/stores/orgStore';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/components/toast/toastStore';

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];

export function SettingsPage() {
  const [sp, setSp] = useSearchParams();
  const TAB_KEYS = ['profile', 'workspace', 'integrations', 'social'];
  const initial = sp.get('tab');
  const [tab, setTabState] = useState(initial && TAB_KEYS.includes(initial) ? initial : 'profile');
  // Deep links like /app/settings?tab=integrations open the right tab (used by CRM → Google Sheets).
  const setTab = (k: string) => { setTabState(k); setSp(k === 'profile' ? {} : { tab: k }, { replace: true }); };
  return (
    <div>
      <PageHeader title="Settings" subtitle="Your profile, workspace and connected services" />
      <Tabs
        tabs={[{ key: 'profile', label: 'Profile' }, { key: 'workspace', label: 'Workspace' }, { key: 'integrations', label: 'Integrations' }, { key: 'social', label: 'Social Accounts' }]}
        active={tab}
        onChange={setTab}
      />
      <div className="pt-4">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'workspace' && <WorkspaceTab />}
        {tab === 'integrations' && <IntegrationsPage embedded />}
        {tab === 'social' && <SocialAccountsPanel />}
      </div>
    </div>
  );
}

function ProfileTab() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const permissions = useAuthStore((s) => s.permissions);
  const setSession = useAuthStore((s) => s.setSession);

  const [name, setName] = useState(user?.name ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwErr, setPwErr] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const saveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSavingProfile(true);
    settingsService.updateProfile({ name: name.trim() })
      .then((u) => {
        // `token` here is the value captured when this handler ran; if
        // updateProfile triggered a silent refresh, it is already stale. Read
        // the live one at write time so setSession cannot roll it back.
        const current = useAuthStore.getState().token ?? token;
        if (user && current) setSession({ user: { ...user, name: u.name }, token: current, permissions });
        toast.success('Profile updated');
      })
      .catch((err) => toast.error(err?.message ?? 'Update failed'))
      .finally(() => setSavingProfile(false));
  };

  const savePassword = (e: React.FormEvent) => {
    e.preventDefault();
    setPwErr('');
    if (pw.newPassword.length < 8) { setPwErr('New password must be at least 8 characters.'); return; }
    if (pw.newPassword !== pw.confirm) { setPwErr('New passwords do not match.'); return; }
    setSavingPw(true);
    settingsService.changePassword({ currentPassword: pw.currentPassword, newPassword: pw.newPassword })
      .then(() => { toast.success('Password changed'); setPw({ currentPassword: '', newPassword: '', confirm: '' }); })
      .catch((err) => toast.error(err?.message ?? 'Password change failed'))
      .finally(() => setSavingPw(false));
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">Your profile</h3>
        <form onSubmit={saveProfile} className="space-y-4">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email" hint="Contact an admin to change your sign-in email"><Input value={user?.email ?? ''} disabled /></Field>
          <Button size="sm" loading={savingProfile} onClick={saveProfile}>Save profile</Button>
        </form>
      </Card>

      <Card className="p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">Change password</h3>
        <form onSubmit={savePassword} className="space-y-4">
          <Field label="Current password"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))} /></Field>
          <Field label="New password"><Input type="password" value={pw.newPassword} invalid={!!pwErr} onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))} /></Field>
          <Field label="Confirm new password" error={pwErr}><Input type="password" value={pw.confirm} invalid={!!pwErr} onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} /></Field>
          <Button size="sm" variant="secondary" loading={savingPw} onClick={savePassword}>Update password</Button>
        </form>
      </Card>
    </div>
  );
}

function WorkspaceTab() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('workspace.manage');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['workspace-settings', orgId], queryFn: () => settingsService.getWorkspace(orgId), enabled: !!orgId,
  });

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) { setName(data.name); setTimezone(data.timezone ?? 'Asia/Kolkata'); } }, [data]);

  if (isLoading) return <Card><LoadingState /></Card>;
  if (isError) return <Card><ErrorState onRetry={() => refetch()} /></Card>;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    settingsService.updateWorkspace(orgId, { name: name.trim(), timezone })
      .then(() => toast.success('Workspace updated'))
      .catch((err) => toast.error(err?.message ?? 'Update failed'))
      .finally(() => setSaving(false));
  };

  return (
    <Card className="max-w-xl p-5">
      <h3 className="mb-1 text-sm font-semibold text-ink">Workspace</h3>
      {!canManage && <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">You need the workspace.manage permission to change these settings.</p>}
      <form onSubmit={save} className="space-y-4">
        <Field label="Workspace name"><Input value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Timezone">
          <Select value={timezone} disabled={!canManage} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </Select>
        </Field>
        {data?.currency && <Field label="Currency" hint="Set on the organization"><Input value={data.currency} disabled /></Field>}
        {canManage && <Button size="sm" loading={saving} onClick={save}>Save workspace</Button>}
      </form>
    </Card>
  );
}

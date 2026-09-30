import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/auth/auth.service';
import { useAuthStore } from '@/stores/authStore';
import { useOrgStore } from '@/stores/orgStore';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { toast } from '@/components/toast/toastStore';

export function LoginPage() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const setWorkspaces = useOrgStore((s) => s.setWorkspaces);
  const [email, setEmail] = useState('admin@greenstart.demo');
  const [password, setPassword] = useState('GreenStart!2026');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('Email is required.'); return; }
    setLoading(true);
    try {
      const { token, user } = await authService.login(email, password);
      setSession({ user, token, permissions: [] });
      // Token is now in the store; hydrate workspaces + active-workspace permissions.
      const ctx = await authService.me();
      setWorkspaces(ctx.workspaces);
      setPermissions(ctx.permissions);
      toast.success(`Welcome back, ${ctx.user.name}`);
      navigate('/app/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-7 shadow-card">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent font-display font-bold text-white">GS</div>
          <div><b className="block font-display text-ink">Green Start</b><span className="text-xs text-muted">Omnichannel marketing</span></div>
        </div>
        <h1 className="mb-1 font-display text-lg font-semibold text-ink">Sign in</h1>
        <p className="mb-5 text-sm text-muted">Use the demo credentials to explore the workspace.</p>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
          <Field label="Password" error={error}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          <Button type="submit" loading={loading} className="w-full">Sign in</Button>
        </form>
      </div>
    </div>
  );
}

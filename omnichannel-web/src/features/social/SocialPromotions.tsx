import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Megaphone, Rocket, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { socialPromotionsService } from '@/services/social/social-promotions.service';
import { socialAudiencesService } from '@/services/social/social-audiences.service';
import { socialPostsService } from '@/services/social/social-posts.service';
import { toast } from '@/components/toast/toastStore';
import type { SocialPromotion, SocialPromotionInput, SocialPromotionObjective, SocialBudgetType } from '@/types';

const OBJECTIVES: SocialPromotionObjective[] = ['awareness', 'traffic', 'engagement', 'leads', 'conversions'];
const money = (minor: number, ccy: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const statusTone = (s: string) => (s === 'active' ? 'green' : s === 'failed' ? 'red' : s === 'scheduled' ? 'blue' : 'neutral') as 'green' | 'red' | 'blue' | 'neutral';

export function SocialPromotions({ orgId }: { orgId: string }) {
  const lp = useListParams({ pageSize: 20 });
  const qc = useQueryClient();
  const canLaunch = useCan('integration.manage');
  const q = useQuery({ queryKey: ['social-promotions', orgId, lp.params], queryFn: () => socialPromotionsService.list(orgId, lp.params), enabled: !!orgId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['social-promotions', orgId] });
  const create = useMutation({ mutationFn: (i: SocialPromotionInput) => socialPromotionsService.create(orgId, i), onSuccess: invalidate });
  const update = useMutation({ mutationFn: (v: { id: string; input: Partial<SocialPromotionInput> }) => socialPromotionsService.update(orgId, v.id, v.input), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => socialPromotionsService.remove(orgId, id), onSuccess: invalidate });
  const launch = useMutation({ mutationFn: (id: string) => socialPromotionsService.launch(orgId, id) });

  const [editor, setEditor] = useState<{ p: SocialPromotion | null } | null>(null);
  const [toDelete, setToDelete] = useState<SocialPromotion | null>(null);
  const rows = q.data?.items ?? [];
  const adsConfigured = q.data?.adsConfigured ?? false;

  const doLaunch = (id: string) => launch.mutateAsync(id).then((r) => {
    if (r.launched) { toast.success('Promotion launched'); invalidate(); }
    else toast.info(r.message ?? 'Paid promotion is not configured yet.');
  }).catch((e) => toast.error(e?.message ?? 'Launch failed'));

  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-card border border-line bg-surface-2 p-3 text-xs text-muted">
        <Info size={15} className="mt-0.5 shrink-0 text-accent" />
        <span><b>Paid promotion</b> is separate from organic posting. A promotion pairs a post + audience + budget and would run through the ads API (Meta Marketing). {adsConfigured ? 'Ads are configured on this server.' : 'Ads are not configured — you can prepare promotions, but launching is disabled until a Meta ad account is set up. Nothing is ever launched or charged without a real ad account.'}</span>
      </div>
      <Card>
        <div className="flex items-center justify-between border-b border-line p-3">
          <span className="text-sm font-medium text-ink">Promotions</span>
          <Button size="sm" onClick={() => setEditor({ p: null })}><Plus size={15} /> New promotion</Button>
        </div>
        {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState onRetry={() => q.refetch()} />
          : rows.length === 0 ? <EmptyState title="No promotions yet" detail="Prepare a paid promotion for a post + audience."
              action={<Button size="sm" onClick={() => setEditor({ p: null })}><Plus size={15} /> New promotion</Button>} />
          : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Promotion</th><th className="px-4 py-3">Objective</th><th className="px-4 py-3">Budget</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th>
              </tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3 font-medium text-ink">{p.name}</td>
                    <td className="px-4 py-3"><Badge tone="blue">{p.objective}</Badge></td>
                    <td className="px-4 py-3 text-muted">{money(p.budgetMinor, p.currency)} / {p.budgetType}</td>
                    <td className="px-4 py-3"><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {canLaunch && ['draft', 'scheduled'].includes(p.status) && (
                          <Button variant="ghost" size="sm" aria-label="Launch" title="Launch (ads API)" loading={launch.isPending && launch.variables === p.id} onClick={() => doLaunch(p.id)}><Rocket size={15} /></Button>
                        )}
                        <Button variant="ghost" size="sm" aria-label="Edit" onClick={() => setEditor({ p })}><Pencil size={15} /></Button>
                        <Button variant="ghost" size="sm" aria-label="Delete" onClick={() => setToDelete(p)}><Trash2 size={15} /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editor && (
        <PromotionEditor orgId={orgId} promotion={editor.p} saving={create.isPending || update.isPending}
          onClose={() => setEditor(null)}
          onSave={(input) => {
            const pr = editor.p ? update.mutateAsync({ id: editor.p.id, input }) : create.mutateAsync(input);
            pr.then(() => { toast.success(editor.p ? 'Promotion updated' : 'Promotion created'); setEditor(null); })
              .catch((e) => toast.error(e?.message ?? 'Save failed'));
          }} />
      )}

      <ConfirmDialog open={!!toDelete} title="Delete promotion" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete "${toDelete?.name}"?`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id).then(() => { toast.success('Promotion deleted'); setToDelete(null); }).catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </div>
  );
}

function PromotionEditor({ orgId, promotion, saving, onClose, onSave }: {
  orgId: string; promotion: SocialPromotion | null; saving: boolean; onClose: () => void; onSave: (i: SocialPromotionInput) => void;
}) {
  const [name, setName] = useState(promotion?.name ?? '');
  const [postId, setPostId] = useState(promotion?.postId ?? '');
  const [audienceId, setAudienceId] = useState(promotion?.audienceId ?? '');
  const [objective, setObjective] = useState<SocialPromotionObjective>(promotion?.objective ?? 'traffic');
  const [budgetType, setBudgetType] = useState<SocialBudgetType>(promotion?.budgetType ?? 'daily');
  const [budgetMajor, setBudgetMajor] = useState(promotion ? String(Math.round(promotion.budgetMinor / 100)) : '');
  const [currency, setCurrency] = useState(promotion?.currency ?? 'INR');
  const [err, setErr] = useState('');

  const postsQ = useQuery({ queryKey: ['social-posts', orgId], queryFn: () => socialPostsService.list(orgId, { pageSize: 100 }), enabled: !!orgId });
  const audiencesQ = useQuery({ queryKey: ['social-audiences', orgId], queryFn: () => socialAudiencesService.list(orgId, { pageSize: 100 }), enabled: !!orgId });

  const submit = () => {
    if (!name.trim()) { setErr('Give the promotion a name.'); return; }
    setErr('');
    onSave({
      name: name.trim(), postId: postId || null, audienceId: audienceId || null,
      objective, budgetType, budgetMinor: Math.max(0, Math.round(Number(budgetMajor || '0') * 100)), currency: currency.toUpperCase(),
    });
  };

  return (
    <Modal open onClose={onClose} title={promotion ? `Edit: ${promotion.name}` : 'New paid promotion'} size="lg"
      footer={<><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button><Button size="sm" loading={saving} onClick={submit}>{promotion ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg bg-surface-2 p-2.5 text-xs text-muted">
          <Megaphone size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>This is a <b>paid</b> promotion. It prepares an ad from a post + audience + budget. It does not change or restrict the organic post, and nothing is launched or charged until a Meta ad account is connected.</span>
        </div>
        <Field label="Name" error={err}><Input value={name} invalid={!!err} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer — Hyderabad IT" /></Field>
        <Field label="Promote post" hint="optional"><Select value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">None</option>
          {(postsQ.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select></Field>
        <Field label="Audience"><Select value={audienceId} onChange={(e) => setAudienceId(e.target.value)}>
          <option value="">None</option>
          {(audiencesQ.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Objective"><Select value={objective} onChange={(e) => setObjective(e.target.value as SocialPromotionObjective)}>
            {OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select></Field>
          <Field label="Budget type"><Select value={budgetType} onChange={(e) => setBudgetType(e.target.value as SocialBudgetType)}>
            <option value="daily">Daily</option><option value="lifetime">Lifetime</option>
          </Select></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Budget amount"><Input value={budgetMajor} onChange={(e) => setBudgetMajor(e.target.value.replace(/[^\d.]/g, ''))} placeholder="5000" /></Field>
          <Field label="Currency"><Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} placeholder="INR" /></Field>
        </div>
      </div>
    </Modal>
  );
}

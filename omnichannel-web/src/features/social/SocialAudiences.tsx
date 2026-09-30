import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, MapPin, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { socialAudiencesService } from '@/services/social/social-audiences.service';
import { segmentsService } from '@/services/crm/segments.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import type { SocialAudience, SocialAudienceInput, SocialLocationType } from '@/types';

export const SECTORS = ['IT / Software', 'Healthcare', 'Education', 'Real Estate', 'Finance', 'Retail', 'Manufacturing', 'Startups', 'HR / Recruitment', 'Marketing'];
const LOCATION_TYPES: { value: SocialLocationType; label: string }[] = [
  { value: 'country', label: 'Country' }, { value: 'state', label: 'State' }, { value: 'city', label: 'City' },
  { value: 'postal', label: 'PIN / Postal code' }, { value: 'radius', label: 'Radius around a place' },
];
const GENDERS = ['all', 'male', 'female', 'other'];

export function SocialAudiences({ orgId }: { orgId: string }) {
  const lp = useListParams({ pageSize: 50 });
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['social-audiences', orgId, lp.params], queryFn: () => socialAudiencesService.list(orgId, lp.params), enabled: !!orgId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['social-audiences', orgId] });
  const create = useMutation({ mutationFn: (i: SocialAudienceInput) => socialAudiencesService.create(orgId, i), onSuccess: invalidate });
  const update = useMutation({ mutationFn: (v: { id: string; input: Partial<SocialAudienceInput> }) => socialAudiencesService.update(orgId, v.id, v.input), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => socialAudiencesService.remove(orgId, id), onSuccess: invalidate });

  const [editor, setEditor] = useState<{ a: SocialAudience | null } | null>(null);
  const [toDelete, setToDelete] = useState<SocialAudience | null>(null);
  const rows = q.data?.items ?? [];

  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-card border border-line bg-surface-2 p-3 text-xs text-muted">
        <Info size={15} className="mt-0.5 shrink-0 text-accent" />
        <span>Audiences describe <b>who you want to reach</b> — sector, location and interests. Organic posts can't be geo/sector-restricted by the platforms, so this is saved for <b>planning</b> and reused for a <b>paid promotion</b> later. It is never applied as a fake restriction on an organic post.</span>
      </div>
      <Card>
        <div className="flex items-center justify-between border-b border-line p-3">
          <span className="text-sm font-medium text-ink">Audiences</span>
          <Button size="sm" onClick={() => setEditor({ a: null })}><Plus size={15} /> New audience</Button>
        </div>
        {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState onRetry={() => q.refetch()} />
          : rows.length === 0 ? <EmptyState title="No audiences yet" detail="Create a reusable sector/location targeting profile."
              action={<Button size="sm" onClick={() => setEditor({ a: null })}><Plus size={15} /> New audience</Button>} />
          : (
          <div className="divide-y divide-line">
            {rows.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-3 p-4">
                <div>
                  <div className="font-medium text-ink">{a.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {a.sector && <Badge tone="blue">{a.sector}</Badge>}
                    {a.locationType && <Badge tone="neutral"><MapPin size={11} /> {locationSummary(a)}</Badge>}
                    {a.segmentName && <Badge tone="green">CRM: {a.segmentName}</Badge>}
                    {a.interests.slice(0, 4).map((i) => <Badge key={i} tone="neutral">{i}</Badge>)}
                    {a.interests.length > 4 && <Badge tone="neutral">+{a.interests.length - 4}</Badge>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" aria-label="Edit" onClick={() => setEditor({ a })}><Pencil size={15} /></Button>
                  <Button variant="ghost" size="sm" aria-label="Delete" onClick={() => setToDelete(a)}><Trash2 size={15} /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editor && (
        <AudienceEditor audience={editor.a} saving={create.isPending || update.isPending}
          onClose={() => setEditor(null)}
          onSave={(input) => {
            const p = editor.a ? update.mutateAsync({ id: editor.a.id, input }) : create.mutateAsync(input);
            p.then(() => { toast.success(editor.a ? 'Audience updated' : 'Audience created'); setEditor(null); })
              .catch((e) => toast.error(e?.message ?? 'Save failed'));
          }} />
      )}

      <ConfirmDialog open={!!toDelete} title="Delete audience" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete "${toDelete?.name}"? Posts using it will keep their content; the audience link is removed.`}
        onConfirm={() => toDelete && remove.mutateAsync(toDelete.id).then(() => { toast.success('Audience deleted'); setToDelete(null); }).catch((e) => toast.error(e?.message ?? 'Delete failed'))}
        onClose={() => setToDelete(null)} />
    </div>
  );
}

export function locationSummary(a: SocialAudience): string {
  if (a.locationType === 'radius') return `${a.radiusKm ?? '?'} km · ${a.centerLabel || a.city || 'location'}`;
  if (a.locationType === 'city') return a.city || 'city';
  if (a.locationType === 'state') return a.state || 'state';
  if (a.locationType === 'postal') return a.postalCode || 'PIN';
  if (a.locationType === 'country') return a.country || 'country';
  return '';
}

function AudienceEditor({ audience, saving, onClose, onSave }: {
  audience: SocialAudience | null; saving: boolean; onClose: () => void; onSave: (i: SocialAudienceInput) => void;
}) {
  const [name, setName] = useState(audience?.name ?? '');
  const [description, setDescription] = useState(audience?.description ?? '');
  const [sectorSel, setSectorSel] = useState(audience && audience.sector && !SECTORS.includes(audience.sector) ? '__custom' : audience?.sector ?? '');
  const [sectorCustom, setSectorCustom] = useState(audience && audience.sector && !SECTORS.includes(audience.sector) ? audience.sector : '');
  const [interestsText, setInterestsText] = useState((audience?.interests ?? []).join(', '));
  const [locationType, setLocationType] = useState<SocialLocationType | ''>(audience?.locationType ?? '');
  const [country, setCountry] = useState(audience?.country ?? '');
  const [state, setState] = useState(audience?.state ?? '');
  const [city, setCity] = useState(audience?.city ?? '');
  const [postalCode, setPostalCode] = useState(audience?.postalCode ?? '');
  const [radiusKm, setRadiusKm] = useState(audience?.radiusKm ? String(audience.radiusKm) : '');
  const [centerLabel, setCenterLabel] = useState(audience?.centerLabel ?? '');
  const [ageMin, setAgeMin] = useState(audience?.ageMin ? String(audience.ageMin) : '');
  const [ageMax, setAgeMax] = useState(audience?.ageMax ? String(audience.ageMax) : '');
  const [genders, setGenders] = useState<string[]>(audience?.genders ?? []);
  const [languagesText, setLanguagesText] = useState((audience?.languages ?? []).join(', '));
  const [segmentId, setSegmentId] = useState(audience?.segmentId ?? '');
  const [err, setErr] = useState('');

  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const segmentsQ = useQuery({ queryKey: ['segments', orgId], queryFn: () => segmentsService.list(orgId), enabled: !!orgId });

  const toggleGender = (g: string) => setGenders((s) => s.includes(g) ? s.filter((x) => x !== g) : [...s, g]);

  const submit = () => {
    if (!name.trim()) { setErr('Give the audience a name.'); return; }
    setErr('');
    const sector = sectorSel === '__custom' ? sectorCustom.trim() : sectorSel;
    const input: SocialAudienceInput = {
      name: name.trim(), description: description.trim() || null, sector: sector || null,
      interests: interestsText.split(',').map((s) => s.trim()).filter(Boolean),
      locationType: (locationType || null) as SocialLocationType | null,
      country: country.trim() || null, state: state.trim() || null, city: city.trim() || null, postalCode: postalCode.trim() || null,
      radiusKm: radiusKm ? Number(radiusKm) : null, centerLabel: centerLabel.trim() || null,
      ageMin: ageMin ? Number(ageMin) : null, ageMax: ageMax ? Number(ageMax) : null,
      genders, languages: languagesText.split(',').map((s) => s.trim()).filter(Boolean),
      segmentId: segmentId || null,
    };
    onSave(input);
  };

  return (
    <Modal open onClose={onClose} title={audience ? `Edit: ${audience.name}` : 'New audience'} size="lg"
      footer={<><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button><Button size="sm" loading={saving} onClick={submit}>{audience ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        <Field label="Audience name" error={err}><Input value={name} invalid={!!err} onChange={(e) => setName(e.target.value)} placeholder="Hyderabad IT Decision Makers" /></Field>
        <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who this audience is" /></Field>

        <Field label="Sector / Industry">
          <Select value={sectorSel} onChange={(e) => setSectorSel(e.target.value)}>
            <option value="">None</option>
            {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="__custom">Custom…</option>
          </Select>
          {sectorSel === '__custom' && <Input className="mt-2" value={sectorCustom} onChange={(e) => setSectorCustom(e.target.value)} placeholder="Enter a custom sector" />}
        </Field>

        <Field label="Interests" hint="comma separated"><Input value={interestsText} onChange={(e) => setInterestsText(e.target.value)} placeholder="Software, SaaS, Technology" /></Field>

        <div>
          <div className="mb-1.5 text-sm font-medium text-ink">Location</div>
          <Select value={locationType} onChange={(e) => setLocationType(e.target.value as SocialLocationType | '')}>
            <option value="">No location targeting</option>
            {LOCATION_TYPES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </Select>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(locationType === 'country' || locationType === 'state' || locationType === 'city' || locationType === 'postal' || locationType === 'radius') && (
              <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Country" />
            )}
            {(locationType === 'state' || locationType === 'city' || locationType === 'radius') && (
              <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="State" />
            )}
            {(locationType === 'city' || locationType === 'radius') && (
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
            )}
            {locationType === 'postal' && <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="PIN / Postal code" />}
            {locationType === 'radius' && <>
              <Input value={radiusKm} onChange={(e) => setRadiusKm(e.target.value.replace(/\D/g, ''))} placeholder="Radius (km)" />
              <Input value={centerLabel} onChange={(e) => setCenterLabel(e.target.value)} placeholder="Center place (e.g. Hyderabad, Telangana)" />
            </>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Age min"><Input value={ageMin} onChange={(e) => setAgeMin(e.target.value.replace(/\D/g, ''))} placeholder="25" /></Field>
          <Field label="Age max"><Input value={ageMax} onChange={(e) => setAgeMax(e.target.value.replace(/\D/g, ''))} placeholder="55" /></Field>
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium text-ink">Gender</div>
          <div className="flex flex-wrap gap-3">
            {GENDERS.map((g) => <label key={g} className="flex items-center gap-1.5 text-sm capitalize"><input type="checkbox" checked={genders.includes(g)} onChange={() => toggleGender(g)} /> {g}</label>)}
          </div>
        </div>
        <Field label="Languages" hint="comma separated"><Input value={languagesText} onChange={(e) => setLanguagesText(e.target.value)} placeholder="English, Telugu, Hindi" /></Field>

        <Field label="Linked CRM segment" hint="optional — reuses an existing Segment for customer-based targeting">
          <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
            <option value="">None</option>
            {(segmentsQ.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <p className="mt-1 text-xs text-muted">A Segment targets <b>your own CRM contacts</b> (usable in campaigns). Sector/location above describe an <b>external</b> platform audience for planning/paid promotion. They're complementary — not the same thing.</p>
        </Field>

        <p className="rounded-lg bg-surface-2 p-2.5 text-xs text-muted">These criteria are saved with the audience. For an <b>organic</b> post they're used only for planning; for a future <b>paid promotion</b> they'll be passed to the ads API. Green Start will never claim an organic post was geographically restricted.</p>
      </div>
    </Modal>
  );
}

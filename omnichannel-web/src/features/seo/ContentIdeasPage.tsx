import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Copy, Check, Trash2, Eye, FolderOpen, AlertTriangle, Info, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useCan } from '@/features/auth/useCan';
import { toast } from '@/components/toast/toastStore';
import { contentIdeasService } from '@/services/seo/contentIdeas.service';
import type { ContentDraft, ContentDraftRow, ContentTone, ContentType } from '@/services/seo/seo.types';
import { useOrgStore } from '@/stores/orgStore';

const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const TYPE_LABEL: Record<ContentType, string> = { blog: 'Blog article', landing: 'Landing page', social: 'Social post series' };
const lenTone = (n: number, lo: number, hi: number) => (n >= lo && n <= hi ? 'text-green' : 'text-orange');

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { toast.error('Could not copy'); }
  };
  return (
    <button type="button" onClick={copy} title={label} aria-label={label} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink">
      {done ? <Check size={14} className="text-green" /> : <Copy size={14} />}
    </button>
  );
}

function SendToLibraryModal({ draft, onClose, onSend, saving }: { draft: ContentDraft; onClose: () => void; onSend: (titleIndex: number, caption: string, linkUrl: string) => void; saving: boolean }) {
  const [titleIndex, setTitleIndex] = useState(0);
  const [caption, setCaption] = useState(draft.result.socialCaption);
  const [linkUrl, setLinkUrl] = useState('');
  return (
    <Modal open onClose={onClose} title="Save to Content Library" size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={() => onSend(titleIndex, caption.trim(), linkUrl.trim())}><FolderOpen size={14} /> Save as draft</Button>
      </>}>
      <div className="space-y-3">
        <Field label="Post name (pick a title)">
          <Select value={titleIndex} onChange={(e) => setTitleIndex(Number(e.target.value))}>
            {draft.result.titles.map((t, i) => <option key={i} value={i}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Caption" hint={`${caption.length} characters · hashtags added automatically: ${draft.result.hashtags.map((h) => `#${h}`).join(' ')}`}>
          <Textarea rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} />
        </Field>
        <Field label="Link (optional)"><Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://tmlink.in/blog/…" /></Field>
        <p className="flex items-start gap-1.5 text-xs text-muted"><Info size={13} className="mt-0.5 shrink-0" /> This creates a <b>draft</b> in Content Library. Nothing is published until you open it there, choose destinations and publish.</p>
      </div>
    </Modal>
  );
}

function IdeasView({ draft, canManage, onSend }: { draft: ContentDraft; canManage: boolean; onSend: () => void }) {
  const r = draft.result;
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <Card><CardBody className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="blue">{TYPE_LABEL[draft.contentType]}</Badge>
        <Badge tone="neutral">{draft.tone}</Badge>
        <span className="text-ink font-medium">{draft.topic}</span>
        {r.keywordsUsed.length > 0 && <span className="text-xs text-muted">· targeting {r.keywordsUsed.join(', ')}</span>}
        <span className="ml-auto text-xs text-muted">{draft.model} · {fmtDate(draft.createdAt)}</span>
        {draft.socialPostId
          ? <Button variant="secondary" size="sm" onClick={() => navigate('/app/content-library')}><ExternalLink size={14} /> In Content Library</Button>
          : <Button size="sm" disabled={!canManage} onClick={onSend}><FolderOpen size={14} /> Save to Content Library</Button>}
      </CardBody></Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><h3 className="text-sm font-semibold text-ink">Title options</h3><span className="text-xs text-muted">aim for 45–60 chars</span></CardHeader>
          <ul className="divide-y divide-line">
            {r.titles.map((t, i) => (
              <li key={i} className="flex items-start gap-2 px-5 py-2.5 text-sm">
                <span className="flex-1 text-ink">{t}</span>
                <span className={`shrink-0 text-xs ${lenTone(t.length, 45, 60)}`}>{t.length}</span>
                <CopyButton text={t} />
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader><h3 className="text-sm font-semibold text-ink">Meta descriptions</h3><span className="text-xs text-muted">aim for 120–155 chars</span></CardHeader>
          <ul className="divide-y divide-line">
            {r.metaDescriptions.map((t, i) => (
              <li key={i} className="flex items-start gap-2 px-5 py-2.5 text-sm">
                <span className="flex-1 text-ink">{t}</span>
                <span className={`shrink-0 text-xs ${lenTone(t.length, 120, 155)}`}>{t.length}</span>
                <CopyButton text={t} />
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader><h3 className="text-sm font-semibold text-ink">Outline</h3><CopyButton label="Copy outline" text={r.outline.map((o) => `## ${o.heading}\n${o.points.map((p) => `- ${p}`).join('\n')}`).join('\n\n')} /></CardHeader>
          <CardBody className="space-y-3">
            {r.outline.map((o, i) => (
              <div key={i}>
                <div className="text-sm font-medium text-ink">{i + 1}. {o.heading}</div>
                <ul className="mt-1 list-disc pl-6 text-sm text-muted">{o.points.map((p, j) => <li key={j}>{p}</li>)}</ul>
              </div>
            ))}
          </CardBody>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader><h3 className="text-sm font-semibold text-ink">FAQ</h3><CopyButton label="Copy FAQ" text={r.faq.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')} /></CardHeader>
            <CardBody className="space-y-3">
              {r.faq.map((f, i) => (
                <div key={i}><div className="text-sm font-medium text-ink">{f.question}</div><div className="text-sm text-muted">{f.answer}</div></div>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader><h3 className="text-sm font-semibold text-ink">Social caption</h3><CopyButton text={`${r.socialCaption}\n\n${r.hashtags.map((h) => `#${h}`).join(' ')}`} /></CardHeader>
            <CardBody>
              <p className="text-sm text-ink">{r.socialCaption}</p>
              <div className="mt-2 flex flex-wrap gap-1">{r.hashtags.map((h) => <Badge key={h} tone="green">#{h}</Badge>)}</div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function ContentIdeasPage() {
  const qc = useQueryClient();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canManage = useCan('content.manage');
  const [topic, setTopic] = useState('');
  const [keywords, setKeywords] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState<ContentTone>('professional');
  const [contentType, setContentType] = useState<ContentType>('blog');
  const [language, setLanguage] = useState('English');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ContentDraftRow | null>(null);
  const [page, setPage] = useState(1);

  const status = useQuery({ queryKey: ['seo-content', orgId, 'status'], queryFn: () => contentIdeasService.status(), enabled: !!orgId });
  const drafts = useQuery({ queryKey: ['seo-content', orgId, 'drafts', page], queryFn: () => contentIdeasService.list(page, 10), enabled: !!orgId });
  const selected = useQuery({ queryKey: ['seo-content', orgId, 'draft', selectedId], queryFn: () => contentIdeasService.get(selectedId as string), enabled: !!orgId && !!selectedId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['seo-content', orgId] });

  useEffect(() => { if (!selectedId && drafts.data?.items[0]) setSelectedId(drafts.data.items[0].id); }, [drafts.data, selectedId]);

  const generate = useMutation({
    mutationFn: () => contentIdeasService.generate({
      topic: topic.trim(), keywords: keywords.split(/,|\n/).map((k) => k.trim()).filter(Boolean).slice(0, 10),
      audience: audience.trim() || undefined, tone, contentType, language: language.trim() || 'English',
    }),
    onSuccess: (d) => { toast.success('Ideas ready'); qc.setQueryData(['seo-content', orgId, 'draft', d.id], d); setSelectedId(d.id); setPage(1); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Generation failed'),
  });
  const send = useMutation({
    mutationFn: (v: { titleIndex: number; caption: string; linkUrl: string }) => contentIdeasService.sendToLibrary(selectedId as string, { titleIndex: v.titleIndex, caption: v.caption || undefined, linkUrl: v.linkUrl || undefined }),
    onSuccess: (r) => { toast.success(`"${r.name}" saved to Content Library as a draft`); setSendOpen(false); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not save'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => contentIdeasService.remove(id),
    onSuccess: (_r, id) => { toast.success('Deleted'); setToDelete(null); if (selectedId === id) setSelectedId(null); invalidate(); },
    onError: (e: Error) => toast.error(e?.message ?? 'Delete failed'),
  });

  const configured = status.data?.configured;
  const rows = drafts.data?.items ?? [];
  const total = drafts.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 10));

  return (
    <div className="space-y-4">
      <PageHeader title="Content Ideas" subtitle="SEO titles, meta descriptions, outlines and a social caption for any topic"
        actions={<RefreshButton keys={['seo-content']} />} />

      {status.data && !configured && (
        <Card><CardBody className="space-y-2">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange" />
            <div><div className="font-medium text-ink">AI generation is not set up on this server yet</div>
              <div className="text-xs text-muted">Add <code>ANTHROPIC_API_KEY</code> (from console.anthropic.com) to the API <code>.env</code>, optionally <code>AI_MODEL</code>, then restart the API. The key stays on the server; every generation is recorded in the audit log.</div></div>
          </div>
        </CardBody></Card>
      )}

      <Card>
        <CardBody>
          <form onSubmit={(e) => { e.preventDefault(); if (topic.trim().length >= 3) generate.mutate(); }} className="grid gap-3 md:grid-cols-2">
            <Field label="Topic"><Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. How to choose a recruitment agency in Hyderabad" disabled={generate.isPending} /></Field>
            <Field label="Target keywords (comma-separated, optional)"><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="recruitment agency hyderabad, staffing company" disabled={generate.isPending} /></Field>
            <Field label="Audience (optional)"><Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="HR managers at mid-size companies" disabled={generate.isPending} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Content type">
                <Select value={contentType} onChange={(e) => setContentType(e.target.value as ContentType)} disabled={generate.isPending}>
                  <option value="blog">Blog article</option><option value="landing">Landing page</option><option value="social">Social posts</option>
                </Select>
              </Field>
              <Field label="Tone">
                <Select value={tone} onChange={(e) => setTone(e.target.value as ContentTone)} disabled={generate.isPending}>
                  <option value="professional">Professional</option><option value="friendly">Friendly</option><option value="persuasive">Persuasive</option><option value="informative">Informative</option>
                </Select>
              </Field>
              <Field label="Language"><Input value={language} onChange={(e) => setLanguage(e.target.value)} disabled={generate.isPending} /></Field>
            </div>
            <div className="md:col-span-2 flex items-center gap-3">
              <Button type="submit" loading={generate.isPending} disabled={!configured || !canManage || topic.trim().length < 3}><Sparkles size={15} /> Generate ideas</Button>
              <span className="text-xs text-muted">{configured ? `Uses ${status.data?.model}. Takes 10–30 seconds.` : 'Configure the AI key to enable.'}{!canManage && ' You need the “content.manage” permission.'}</span>
            </div>
          </form>
        </CardBody>
      </Card>

      {generate.isPending ? <Card><LoadingState label="Writing titles, descriptions, outline and FAQ…" /></Card>
        : selectedId && selected.isLoading ? <Card><LoadingState label="Loading…" /></Card>
        : selectedId && selected.isError ? <Card><ErrorState message="Could not load this draft." onRetry={() => selected.refetch()} /></Card>
        : selected.data ? <IdeasView draft={selected.data} canManage={canManage} onSend={() => setSendOpen(true)} />
        : null}

      <Card>
        <CardHeader><h3 className="text-sm font-semibold text-ink">Previous ideas</h3><span className="text-xs text-muted">Total {total}</span></CardHeader>
        {drafts.isLoading ? <LoadingState label="Loading…" />
          : drafts.isError ? <ErrorState message="Could not load previous ideas." onRetry={() => drafts.refetch()} />
          : rows.length === 0 ? <EmptyState title="Nothing generated yet" detail="Enter a topic above to get your first set of ideas." />
          : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="border-b border-line bg-surface-2/60 text-left text-xs font-semibold text-muted">
                  <th className="px-4 py-3">Topic</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Keywords</th><th className="px-4 py-3">Created</th><th className="px-4 py-3">Library</th><th className="px-4 py-3 text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={`border-b border-line last:border-0 hover:bg-surface-2/60 ${r.id === selectedId ? 'bg-accent-soft/40' : ''}`}>
                      <td className="max-w-md px-4 py-3"><button type="button" className="truncate text-left font-medium text-ink hover:underline" onClick={() => setSelectedId(r.id)}>{r.topic}</button></td>
                      <td className="px-4 py-3"><Badge tone="blue">{TYPE_LABEL[r.contentType]}</Badge></td>
                      <td className="max-w-xs truncate px-4 py-3 text-muted">{r.keywords.join(', ') || '—'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{fmtDate(r.createdAt)}</td>
                      <td className="px-4 py-3">{r.socialPostId ? <Badge tone="green">Draft saved</Badge> : <span className="text-muted">—</span>}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button type="button" onClick={() => setSelectedId(r.id)} title="View" aria-label="View" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"><Eye size={15} /></button>
                          {canManage && <button type="button" onClick={() => setToDelete(r)} title="Delete" aria-label="Delete" className="rounded-lg p-1.5 text-muted hover:bg-red/10 hover:text-red"><Trash2 size={15} /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-muted">
              <span>Page {page} of {pageCount}</span>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {sendOpen && selected.data && <SendToLibraryModal draft={selected.data} saving={send.isPending} onClose={() => setSendOpen(false)} onSend={(titleIndex, caption, linkUrl) => send.mutate({ titleIndex, caption, linkUrl })} />}
      <ConfirmDialog open={!!toDelete} title="Delete ideas" danger confirmLabel="Delete" loading={remove.isPending}
        message={`Delete the ideas for "${toDelete?.topic}"? A draft already saved to Content Library stays there.`} onConfirm={() => toDelete && remove.mutate(toDelete.id)} onClose={() => setToDelete(null)} />
    </div>
  );
}

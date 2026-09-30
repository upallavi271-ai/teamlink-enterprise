import type { Template, TemplateInput, TemplateStatus, ListParams, Paginated } from '@/types';
import type { TemplateMetaStatus, TemplateSubmitResult, TemplateSyncReport } from './templates.types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { WorkspaceScopedMock, genId, nowIso } from '../scopedMock';
import { seedTemplates } from '@/mocks/templates.mock';

const mock = new WorkspaceScopedMock<Template>('w2', seedTemplates, {
  searchFields: ['name', 'body', 'provider'],
  sortFields: ['name', 'updatedAt'],
  defaultSort: 'updatedAt',
  filter: (t, f) => (!f.channel || t.channel === f.channel) && (!f.status || t.status === f.status) && (!f.category || t.category === f.category),
});
const real = config.isRealApi('templates');

export const templatesService = {
  list(orgId: string, params: ListParams): Promise<Paginated<Template>> {
    return real ? apiRequest(`templates${toQuery(params)}`) : mock.list(orgId, params);
  },
  create(orgId: string, input: TemplateInput): Promise<Template> {
    const row: Template = { ...input, id: genId('tpl'), status: 'pending', variables: (input.body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length, updatedAt: nowIso() };
    return real ? apiRequest('templates', { method: 'POST', body: input }) : mock.create(orgId, row);
  },
  update(orgId: string, id: string, patch: Partial<TemplateInput>): Promise<Template> {
    return real ? apiRequest(`templates/${id}`, { method: 'PATCH', body: patch }) : mock.update(orgId, id, { ...patch, updatedAt: nowIso() });
  },
  /** Set the review status manually (server records it as a local decision). */
  setStatus(orgId: string, id: string, status: TemplateStatus, reason?: string): Promise<Template> {
    return real
      ? apiRequest(`templates/${id}/status`, { method: 'PATCH', body: { status, reason } })
      : mock.update(orgId, id, { status, updatedAt: nowIso() } as Partial<Template>);
  },
  remove(orgId: string, id: string): Promise<void> {
    return real ? apiRequest(`templates/${id}`, { method: 'DELETE' }) : mock.remove(orgId, id);
  },
  /**
   * Whether the stored WhatsApp token can ACTUALLY manage templates, according
   * to Meta's own token introspection — not the scope list Green Start recorded
   * when the connection was made.
   *
   * No mock branch with data: the entire answer is Meta introspecting a real
   * stored token, so there is nothing honest to simulate. Demo mode says so
   * rather than inventing a verdict about a connection that does not exist.
   */
  metaStatus(_orgId: string): Promise<TemplateMetaStatus> {
    if (!real) {
      return Promise.reject(new Error(
        'Checking the Meta connection requires the Green Start API. Set VITE_REAL_APIS to include “templates”.',
      ));
    }
    return apiRequest<TemplateMetaStatus>('templates/meta-status');
  },
  /**
   * Reconcile local WhatsApp templates against the WABA's real list.
   *
   * `dryRun: true` writes nothing and returns the same report shape, so the UI
   * can show the plan before anything is changed. The write run imports rows the
   * user does not have yet, so it is never the first call a person makes.
   *
   * No mock branch, for the same reason as `metaStatus`: the entire answer comes
   * from Meta reading a real WABA, and there is nothing honest to simulate.
   */
  syncFromMeta(_orgId: string, dryRun: boolean): Promise<TemplateSyncReport> {
    if (!real) {
      return Promise.reject(new Error(
        'Syncing templates from Meta requires the Green Start API. Set VITE_REAL_APIS to include “templates”.',
      ));
    }
    return apiRequest<TemplateSyncReport>('templates/sync', { method: 'POST', body: { dryRun } });
  },
  /**
   * Register a local template with Meta. The server runs the WhatsApp policy
   * check first and refuses anything Meta would reject — its explanation (in
   * `message`, and often in `details`) is the useful part of a failure and must
   * be shown to the user verbatim.
   */
  submitToMeta(_orgId: string, id: string): Promise<TemplateSubmitResult> {
    if (!real) {
      return Promise.reject(new Error(
        'Submitting a template to Meta requires the Green Start API. Set VITE_REAL_APIS to include “templates”.',
      ));
    }
    return apiRequest<TemplateSubmitResult>(`templates/${id}/submit`, { method: 'POST' });
  },
};

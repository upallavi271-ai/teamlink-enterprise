import type { ListParams, Paginated, WebForm, WebFormInput, WebFormSubmission } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { mockLatency } from '../mockDb';
import { seedForms, seedSubmissions } from '@/mocks/webforms.mock';

const real = config.isRealApi('web-forms');
const SEED_WS = 'w2';
const formsByWs = new Map<string, WebForm[]>();
const subsByWs = new Map<string, Record<string, WebFormSubmission[]>>();
function forms(orgId: string): WebForm[] {
  if (!formsByWs.has(orgId)) formsByWs.set(orgId, orgId === SEED_WS ? seedForms() : []);
  return formsByWs.get(orgId)!;
}
function subs(orgId: string): Record<string, WebFormSubmission[]> {
  if (!subsByWs.has(orgId)) subsByWs.set(orgId, orgId === SEED_WS ? seedSubmissions() : {});
  return subsByWs.get(orgId)!;
}
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'form';
const rnd = () => Math.random().toString(36).slice(2, 6);

export const webformsService = {
  async list(orgId: string, params: ListParams): Promise<Paginated<WebForm>> {
    if (real) return apiRequest(`web-forms${toQuery(params)}`);
    await mockLatency();
    let rows = [...forms(orgId)];
    const q = params.search?.trim().toLowerCase();
    if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q));
    if (params.filters?.status) rows = rows.filter((f) => f.status === params.filters!.status);
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  async get(orgId: string, id: string): Promise<WebForm> {
    if (real) return apiRequest(`web-forms/${id}`);
    await mockLatency(120);
    const f = forms(orgId).find((x) => x.id === id);
    if (!f) throw new Error('Form not found');
    return { ...f };
  },

  async create(orgId: string, input: WebFormInput): Promise<WebForm> {
    if (real) return apiRequest('web-forms', { method: 'POST', body: input });
    await mockLatency();
    const f: WebForm = {
      id: `wf_${Date.now()}`, name: input.name, description: input.description,
      fields: input.fields ?? [],
      customFieldIds: input.customFieldIds ?? [], permittedMemberIds: input.permittedMemberIds ?? [],
      isDefault: false, assignedMemberId: input.assignedMemberId ?? undefined,
      publicSlug: `${slug(input.name)}-${rnd()}`, status: 'active', submissionCount: 0,
      createdAt: new Date().toISOString(),
    };
    forms(orgId).unshift(f);
    subs(orgId)[f.id] = [];
    return { ...f };
  },

  async update(orgId: string, id: string, input: Partial<WebFormInput> & { status?: 'active' | 'disabled' }): Promise<WebForm> {
    if (real) return apiRequest(`web-forms/${id}`, { method: 'PATCH', body: input });
    await mockLatency();
    const f = forms(orgId).find((x) => x.id === id);
    if (!f) throw new Error('Form not found');
    if (input.name !== undefined) f.name = input.name;
    if (input.description !== undefined) f.description = input.description;
    if (input.fields !== undefined) f.fields = input.fields;
    if (input.customFieldIds !== undefined) f.customFieldIds = input.customFieldIds;
    if (input.permittedMemberIds !== undefined) f.permittedMemberIds = input.permittedMemberIds;
    if (input.status !== undefined) f.status = input.status;
    return { ...f };
  },

  async remove(orgId: string, id: string): Promise<void> {
    if (real) { await apiRequest(`web-forms/${id}`, { method: 'DELETE' }); return; }
    await mockLatency();
    formsByWs.set(orgId, forms(orgId).filter((f) => f.id !== id));
  },

  async submissions(orgId: string, id: string): Promise<WebFormSubmission[]> {
    if (real) {
      const p = await apiRequest<Paginated<WebFormSubmission>>(`web-forms/${id}/submissions?pageSize=200`);
      return p.items;
    }
    await mockLatency(150);
    return [...(subs(orgId)[id] ?? [])];
  },
};

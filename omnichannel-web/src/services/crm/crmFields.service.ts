import type { CustomField, CustomFieldInput, ListParams, Paginated } from '@/types';
import { config } from '../config';
import { apiRequest, toQuery } from '../apiClient';
import { WorkspaceScopedMock, genId, nowIso } from '../scopedMock';
import { seedFields } from '@/mocks/crm.mock';

const mock = new WorkspaceScopedMock<CustomField>('w2', seedFields, {
  searchFields: ['name', 'key'],
  sortFields: ['name', 'createdAt'],
  defaultSort: 'createdAt',
  filter: (f, ff) => !ff.type || f.type === ff.type,
});
const real = config.isRealApi('crm-fields');
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const crmFieldsService = {
  list(orgId: string, params: ListParams): Promise<Paginated<CustomField>> {
    return real ? apiRequest(`crm-fields${toQuery(params)}`) : mock.list(orgId, params);
  },
  create(orgId: string, input: CustomFieldInput): Promise<CustomField> {
    const body = { ...input, key: input.key || slug(input.name) };
    return real ? apiRequest('crm-fields', { method: 'POST', body })
      : mock.create(orgId, { ...body, id: genId('cf'), createdAt: nowIso() });
  },
  update(orgId: string, id: string, patch: Partial<CustomFieldInput>): Promise<CustomField> {
    return real ? apiRequest(`crm-fields/${id}`, { method: 'PATCH', body: patch }) : mock.update(orgId, id, patch);
  },
  remove(orgId: string, id: string): Promise<void> {
    return real ? apiRequest(`crm-fields/${id}`, { method: 'DELETE' }) : mock.remove(orgId, id);
  },
};

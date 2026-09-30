import type { WebForm, WebFormSubmission } from '@/types';

// Demo custom-field / member ids line up with crm.mock and team.mock so the
// pickers in the form editor resolve to real names in the mock workspace.
export const seedForms = (): WebForm[] => [
  {
    id: 'wf0', name: 'Default', description: 'Auto-generated default form for customer data.',
    isDefault: true,
    customFieldIds: ['cf1', 'cf2'], permittedMemberIds: [],
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
    ],
    publicSlug: 'default-9f2a', status: 'active', submissionCount: 0,
    createdAt: '2026-08-28T09:00:00.000Z',
  },
  {
    id: 'wf1', name: 'Contact Us', description: 'Homepage lead form',
    isDefault: false,
    customFieldIds: ['cf1'], permittedMemberIds: [],
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
      { key: 'phone', label: 'Phone', type: 'phone', required: false },
      { key: 'message', label: 'Message', type: 'textarea', required: false },
    ],
    publicSlug: 'contact-us-a1b2', status: 'active', submissionCount: 2,
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: 'wf2', name: 'Demo Request', description: 'Book a product demo',
    isDefault: false,
    customFieldIds: [], permittedMemberIds: [],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Work email', type: 'email', required: true },
      { key: 'company', label: 'Company', type: 'text', required: false },
    ],
    publicSlug: 'demo-request-c3d4', status: 'active', submissionCount: 0,
    createdAt: '2026-09-06T09:00:00.000Z',
  },
];

export const seedSubmissions = (): Record<string, WebFormSubmission[]> => ({
  wf1: [
    { id: 's1', data: { name: 'Anita Rao', email: 'anita@example.com', phone: '+919000000001', message: 'Interested in WhatsApp campaigns.' }, customerId: 'c1', createdAt: '2026-09-10T10:00:00.000Z' },
    { id: 's2', data: { name: 'Vikram Shah', email: 'vikram@example.com', message: 'Please call me.' }, customerId: 'c2', createdAt: '2026-09-11T12:30:00.000Z' },
  ],
  wf0: [],
  wf2: [],
});

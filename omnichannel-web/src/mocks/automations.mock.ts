import type { Automation, AutomationRun } from '@/types';

export const seedAutomations = (): Automation[] => [
  {
    id: 'au1',
    name: 'Tag & qualify web leads',
    description: 'When a web form is submitted, tag the contact and move them to Contacted.',
    trigger: 'form_submitted',
    logic: 'AND',
    conditions: [{ field: 'source', operator: 'equals', value: 'Web Form' }],
    actions: [{ type: 'add_tag', tag: 'Web Lead' }, { type: 'set_stage', stage: 'contacted' }],
    status: 'active',
    runCount: 42,
    matchCount: 38,
    lastRunAt: '2026-09-11T14:20:00.000Z',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-10T09:00:00.000Z',
  },
  {
    id: 'au2',
    name: 'Welcome new contacts',
    description: 'Tag every newly created contact so nothing slips through.',
    trigger: 'customer_created',
    logic: 'AND',
    conditions: [],
    actions: [{ type: 'add_tag', tag: 'New' }],
    status: 'active',
    runCount: 118,
    matchCount: 118,
    lastRunAt: '2026-09-11T16:05:00.000Z',
    createdAt: '2026-09-03T09:00:00.000Z',
    updatedAt: '2026-09-03T09:00:00.000Z',
  },
  {
    id: 'au3',
    name: 'Flag won deals',
    description: 'When a lead reaches the Won stage, tag them VIP.',
    trigger: 'stage_changed',
    logic: 'AND',
    conditions: [{ field: 'leadStage', operator: 'equals', value: 'won' }],
    actions: [{ type: 'add_tag', tag: 'VIP' }, { type: 'set_status', status: 'active' }],
    status: 'paused',
    runCount: 9,
    matchCount: 7,
    lastRunAt: '2026-09-09T11:00:00.000Z',
    createdAt: '2026-09-05T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
  },
];

export const seedRuns = (): Record<string, AutomationRun[]> => ({
  au1: [
    { id: 'r1', automationId: 'au1', trigger: 'form_submitted', status: 'success', entityType: 'customer', entityId: 'c1', actionsApplied: ['add_tag:Web Lead', 'set_stage:contacted'], createdAt: '2026-09-11T14:20:00.000Z' },
    { id: 'r2', automationId: 'au1', trigger: 'form_submitted', status: 'success', entityType: 'customer', entityId: 'c2', actionsApplied: ['add_tag:Web Lead', 'set_stage:contacted'], createdAt: '2026-09-11T12:31:00.000Z' },
    { id: 'r3', automationId: 'au1', trigger: 'form_submitted', status: 'skipped', entityType: 'customer', entityId: 'c7', actionsApplied: [], createdAt: '2026-09-10T18:02:00.000Z' },
  ],
  au2: [
    { id: 'r4', automationId: 'au2', trigger: 'customer_created', status: 'success', entityType: 'customer', entityId: 'c9', actionsApplied: ['add_tag:New'], createdAt: '2026-09-11T16:05:00.000Z' },
  ],
  au3: [
    { id: 'r5', automationId: 'au3', trigger: 'stage_changed', status: 'success', entityType: 'customer', entityId: 'c4', actionsApplied: ['add_tag:VIP', 'set_status:active'], createdAt: '2026-09-09T11:00:00.000Z' },
  ],
});

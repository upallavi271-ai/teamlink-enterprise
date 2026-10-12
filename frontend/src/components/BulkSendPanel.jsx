// BULK SEND — one message to many candidates, clients' contacts or employees.
// The screen now lives in components/messaging/SendMessage.jsx (SendManyDialog):
// ready-made wording from Message templates, a look at who gets it before
// anything goes, a confirm step, live progress. This file keeps the old import
// path working for the Candidates list.
export { SendManyDialog as default, BULK_LIMIT } from './messaging/SendMessage.jsx';

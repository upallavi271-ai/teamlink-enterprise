/**
 * Runtime config derived from Vite env. The mock<->real decision lives HERE,
 * never as an `if (mock)` branch inside a component or page.
 */
const truthy = (v: string | undefined) => v === 'true' || v === '1';

const realApis = (import.meta.env.VITE_REAL_APIS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  useMocks: import.meta.env.VITE_USE_MOCKS === undefined ? true : truthy(import.meta.env.VITE_USE_MOCKS),
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
  realApis,
  /** Is a given module wired to the real API? Global useMocks=false implies all real. */
  isRealApi(module: string): boolean {
    if (!this.useMocks) return true;
    return this.realApis.includes(module);
  },
  /** Real auth turns on as soon as any module talks to the real API. */
  get realAuth(): boolean {
    return !this.useMocks || this.realApis.length > 0;
  },
};

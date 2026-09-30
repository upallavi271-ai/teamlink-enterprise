/**
 * The ONLY HTTP boundary. Builds URLs, attaches auth + workspace headers,
 * unwraps the {success,data|error} envelope, and normalizes every failure
 * into a typed ApiError. UI and services never call fetch directly.
 */
import type { ApiResponse, ApiErrorCode, ListParams } from '@/types';
import { config } from './config';

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  details?: Array<{ field: string; message: string }>;
  constructor(code: ApiErrorCode, status: number, message: string, details?: ApiError['details']) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Validation failures put the per-field reasons in `details` and only
 * "Some fields were not accepted" in the message. Every caller toasts
 * `error.message`, so the reason never reached the screen and the user had no
 * way to know what to change. Keyed on the SHAPE of the details — the server's
 * validation pipe always sends {field, message} pairs — so errors that use
 * `details` differently (Meta template refusals send plain strings) are left
 * exactly as they were and are not shown twice.
 */
function withFieldReasons(message: string, details: unknown): string {
  if (!Array.isArray(details)) return message;
  const parts = details
    .filter((d): d is { field: string; message: string } =>
      !!d && typeof d === 'object'
      && typeof (d as { field?: unknown }).field === 'string'
      && typeof (d as { message?: unknown }).message === 'string')
    .slice(0, 3)
    .map((d) => (d.field && d.field !== '(body)' ? `${humanizeField(d.field)}: ${d.message}` : d.message));
  return parts.length ? `${message} — ${parts.join('; ')}` : message;
}

/** `assignedAgentId` → "assigned agent id"; `rows.0.phone` → "phone". */
function humanizeField(field: string): string {
  const last = field.split('.').pop() ?? field;
  return last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

type Providers = {
  getToken: () => string | null;
  getWorkspaceId: () => string | null;
  onUnauthorized: () => void;
  /** Called with a fresh access token after a successful silent refresh. */
  onTokenRefreshed?: (token: string) => void;
};
let providers: Providers = {
  getToken: () => null,
  getWorkspaceId: () => null,
  onUnauthorized: () => {},
};

/**
 * Silent refresh. The access token lives 15 minutes; the refresh token is an
 * httpOnly cookie the browser sends on its own. On the first 401 we ask the
 * server to rotate once and retry the original request — so a person is not
 * thrown to the sign-in page mid-task, and the token JavaScript can see stays
 * short-lived. One refresh at a time: concurrent 401s share the same promise.
 */
let refreshing: Promise<string | null> | null = null;
async function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${config.apiBaseUrl}/auth/refresh`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', cache: 'no-store', body: '{}',
        });
        if (!res.ok) return null;
        const payload = (await res.json()) as ApiResponse<{ accessToken: string }>;
        if (!payload.success) return null;
        providers.onTokenRefreshed?.(payload.data.accessToken);
        return payload.data.accessToken;
      } catch {
        return null;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}
export function configureApiClient(p: Providers) {
  providers = p;
}

export function toQuery(params: ListParams = {}): string {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.sort) q.set('sort', params.sort);
  if (params.dir) q.set('dir', params.dir);
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  for (const [k, v] of Object.entries(params.filters ?? {})) if (typeof v === 'string' && v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  // PUT is here for the handful of endpoints whose semantics are "replace the
  // whole set", not "merge these fields" — team/roles/:roleKey/policies is the
  // first. Sending that as PATCH would misdescribe it to the server.
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = providers.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const ws = providers.getWorkspaceId();
  if (ws) headers['X-Workspace-Id'] = ws;

  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}/${path.replace(/^\//, '')}`, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      // Never let the browser make a CONDITIONAL request. A 304 has no body, so
      // res.json() below would throw and we'd report a failure for a response
      // the server considered fine. These payloads are auth- and workspace-
      // scoped anyway, so HTTP caching buys nothing here.
      cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 0, 'Network error — could not reach the server.');
  }

  if (res.status === 401) {
    // Auth endpoints answer 401 for their own reasons (wrong password); only a
    // protected call with a token in hand is worth a refresh attempt.
    if (!retried && token && !path.startsWith('auth/')) {
      const fresh = await refreshAccessToken();
      if (fresh) return apiRequest<T>(path, opts, true);
    }
    providers.onUnauthorized();
    throw new ApiError('UNAUTHORIZED', 401, 'Your session has expired. Please sign in again.');
  }
  if (res.status === 304) {
    // Not an error — but there is no body to return, so the caller cannot be
    // served. Naming it precisely beats the old "Request failed (304)".
    throw new ApiError('INTERNAL_ERROR', 304, 'The server returned a cached-response marker with no data. Reload the page.');
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    if (!res.ok) throw new ApiError('INTERNAL_ERROR', res.status, `Request failed (${res.status}).`);
    throw new ApiError('INTERNAL_ERROR', res.status, 'Malformed server response.');
  }

  if (!payload.success) {
    throw new ApiError(payload.error.code, res.status, withFieldReasons(payload.error.message, payload.error.details), payload.error.details);
  }
  return payload.data;
}

/**
 * Multipart upload — same auth/workspace headers and envelope handling as
 * apiRequest, but sends FormData (the browser sets the multipart Content-Type
 * and boundary, so we must NOT set it ourselves).
 */
export async function apiUpload<T>(path: string, form: FormData, opts: { signal?: AbortSignal } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = providers.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const ws = providers.getWorkspaceId();
  if (ws) headers['X-Workspace-Id'] = ws;

  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}/${path.replace(/^\//, '')}`, {
      method: 'POST', headers, credentials: 'include', cache: 'no-store', body: form, signal: opts.signal,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 0, 'Network error — could not reach the server.');
  }
  if (res.status === 401) {
    if (!retried && token) {
      const fresh = await refreshAccessToken();
      if (fresh) return apiUpload<T>(path, form, opts, true);
    }
    providers.onUnauthorized();
    throw new ApiError('UNAUTHORIZED', 401, 'Your session has expired. Please sign in again.');
  }
  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('INTERNAL_ERROR', res.status, `Upload failed (${res.status}).`);
  }
  if (!payload.success) {
    throw new ApiError(payload.error.code, res.status, withFieldReasons(payload.error.message, payload.error.details), payload.error.details);
  }
  return payload.data;
}

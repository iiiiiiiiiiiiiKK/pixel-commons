/**
 * Tiny typed fetch wrapper.
 *
 * `__API_BASE__` is injected at build time:
 *  - empty string for the Cloudflare Worker build (same origin, /api/...)
 *  - the Worker URL for the static GitHub Pages build
 */

const API_BASE = typeof __API_BASE__ === 'string' ? __API_BASE__ : '';

export const apiBase = API_BASE;
export const isStaticBuild = API_BASE.length > 0;

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = 'http_error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      ...init,
      signal: init.signal ?? controller.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const payload = data as { message?: string; error?: string } | null;
      throw new ApiError(res.status, payload?.message ?? `Request failed (${res.status})`, payload?.error ?? 'http_error');
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'The server took too long to answer. Check your connection and retry.', 'timeout');
    }
    throw new ApiError(0, 'Network unreachable. Are you offline?', 'network');
  } finally {
    clearTimeout(timeout);
  }
}

export type SessionInfo = {
  handle: string;
  isAdmin: boolean;
  adminEnabled: boolean;
  cooldownMs: number;
  canvas: { width: number; height: number };
  recent: unknown[];
};

export const api = {
  session: () => request<SessionInfo>('/api/session'),
  history: (since = 0, limit = 60) =>
    request<{ history: Array<{ id: number; x: number; y: number; c: number; prev: number | null; at: number; by: string }>; lastId: number }>(
      `/api/history?since=${since}&limit=${limit}`,
    ),
  snapshots: () =>
    request<{ snapshots: Array<{ id: number; at: number; version: number; totalPixels: number }> }>('/api/snapshots'),
  adminLogin: (token: string) =>
    request<{ ok: boolean }>('/api/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  adminLogout: () => request<{ ok: boolean }>('/api/admin/logout', { method: 'POST', body: '{}' }),
  adminView: () =>
    request<{
      reports: Array<{ id: number; x: number; y: number; reason: string; note: string; at: number; status: string; by: string }>;
      audit: Array<{ id: number; action: string; detail: string; by: string; at: number }>;
      snapshots: Array<{ id: number; at: number; version: number; totalPixels: number }>;
      config: { width: number; height: number; totalPixels: number; onlineCount: number };
    }>('/api/admin/view'),
  adminAction: (body: Record<string, unknown>) =>
    request<{ ok: boolean; message: string }>('/api/admin/action', { method: 'POST', body: JSON.stringify(body) }),
};

/** Absolute URL for the PNG export, valid on both same-origin and static builds. */
export function exportPngUrl(scale = 4): string {
  return `${API_BASE}/api/export.png?scale=${scale}`;
}

export function snapshotPngUrl(id: number, scale = 2): string {
  return `${API_BASE}/api/snapshot.png?id=${id}&scale=${scale}`;
}

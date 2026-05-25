const BASE = '/api';

let on401: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { on401 = fn; }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    on401?.();
    return { ok: false, error: 'unauthorized' } as any;
  }
  return res.json();
}

export const api = {
  // Auth
  authStatus: () => request<any>('/auth/status'),
  login: (username: string, password: string) =>
    request<any>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<any>('/auth/logout', { method: 'POST' }),

  dashboard: () => request<any>('/dashboard'),
  // Services
  getServices: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/services${qs}`);
  },
  // Endpoints (活端点)
  getEndpoints: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/endpoints${qs}`);
  },
  getEndpointFacets: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/endpoints/facets${qs}`);
  },
  getFingerprintDaily: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/fingerprint-stats/daily${qs}`);
  },
  // Tasks
  getTasks: (scheduled?: boolean) => request<any>(`/tasks${scheduled ? '?scheduled=true' : ''}`),
  createTask: (data: any) => request<any>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: any) => request<any>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTask: (id: string) => request<any>(`/tasks/${id}`, { method: 'DELETE' }),
  runTask: (id: string) => request<any>(`/tasks/${id}/run`, { method: 'POST' }),
  // Findings
  getFindings: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/findings${qs}`);
  },
  getSecurityFindings: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams({ ...((params || {}) as any), kind: 'security' }).toString();
    return request<any>(`/findings?${q}`);
  },
  getActivityFindings: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams({ ...((params || {}) as any), kind: 'activity' }).toString();
    return request<any>(`/findings?${q}`);
  },
  updateFindingStatus: (id: string, status: string) =>
    request<any>(`/findings/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  getFindingStats: (kind: 'security' | 'activity' | 'all' = 'security') => request<any>(`/findings/stats?kind=${kind}`),
  getFindingsByInstance: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/findings/by-instance${qs}`);
  },
  getInstanceTrend: (key: string, days = 30) =>
    request<any>(`/findings/instance/${encodeURIComponent(key)}/trend?days=${days}`),
  takeRiskSnapshot: () => request<any>('/findings/snapshot', { method: 'POST' }),
  // Runs
  getRuns: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/runs${qs}`);
  },
  getRunReport: (id: string) => request<any>(`/runs/${id}/report`),
  getTaskRuns: (params?: Record<string, string | number>) => {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : '';
    return request<any>(`/runs/task-runs${qs}`);
  },
  getTaskRunReport: (id: string) => request<any>(`/runs/task-runs/${encodeURIComponent(id)}/report`),
  // Modules
  getModules: () => request<any>('/modules'),
  // WebPaths
  getWebPaths: (serviceId?: string) => request<any>(`/web-paths${serviceId ? `?serviceId=${serviceId}` : ''}`),
  getWebPathRules: () => request<any>('/web-path-rules'),
  createWebPathRule: (data: any) => request<any>('/web-path-rules', { method: 'POST', body: JSON.stringify(data) }),
  updateWebPathRule: (id: string, data: any) => request<any>(`/web-path-rules/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWebPathRule: (id: string) => request<any>(`/web-path-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reevaluateWebPathRules: () => request<any>('/web-path-rules/reevaluate', { method: 'POST' }),
  // PortLists
  getPortLists: () => request<any>('/port-lists'),
  createPortList: (data: any) => request<any>('/port-lists', { method: 'POST', body: JSON.stringify(data) }),
  updatePortList: (id: string, data: any) => request<any>(`/port-lists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePortList: (id: string) => request<any>(`/port-lists/${id}`, { method: 'DELETE' }),
  // AssetLists
  getAssetLists: () => request<any>('/asset-lists'),
  createAssetList: (data: any) => request<any>('/asset-lists', { method: 'POST', body: JSON.stringify(data) }),
  updateAssetList: (id: string, data: any) => request<any>(`/asset-lists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAssetList: (id: string) => request<any>(`/asset-lists/${id}`, { method: 'DELETE' }),
  exportAssetListUrl: (id: string, format: 'csv' | 'json' = 'csv') =>
    `/api/asset-lists/${encodeURIComponent(id)}/export?format=${format}`,
  // Sources
  getCloudquerySourceStatus: () => request<any>('/sources/cloudquery/status'),
  previewCloudquery: (strategy: string) =>
    request<any>('/sources/cloudquery/preview', { method: 'POST', body: JSON.stringify({ strategy }) }),
  syncCloudquery: (data: { strategy: string; name?: string; description?: string; replaceListId?: string; autoSync?: any }) =>
    request<any>('/sources/cloudquery/sync', { method: 'POST', body: JSON.stringify(data) }),
  syncCloudqueryBatch: (data: { strategies: string[]; prefix?: string; autoSync?: any }) =>
    request<any>('/sources/cloudquery/sync-batch', { method: 'POST', body: JSON.stringify(data) }),
};

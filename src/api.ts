export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown> | undefined;
  constructor(message: string, code = 'UNKNOWN', status = 500, details?: Record<string, unknown>) {
    super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { 'Accept': 'application/json', ...init.headers } });
  let result: { success?: boolean; data?: T; error?: { message?: string; code?: string; [key: string]: unknown } };
  try { result = await response.json(); } catch { throw new ApiError('暂时无法获取信息，请稍后重试。', 'INVALID_RESPONSE', response.status); }
  if (!response.ok || result.success === false) {
    const code = String(result.error?.code || response.status);
    const message = code === 'MISSING_API_KEY' || response.status === 503
      ? '商品信息暂时无法加载，请稍后重试。'
      : result.error?.message || '暂时无法获取信息，请稍后重试。';
    throw new ApiError(message, code, response.status, result.error);
  }
  if (result.data === undefined) throw new ApiError('暂时无法获取信息，请稍后重试。', 'INVALID_RESPONSE', response.status);
  return result.data;
}

export function apiGet<T>(path: string, params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return request<T>(`${path}${query.size ? `?${query.toString()}` : ''}`, init);
}
export function apiPost<T>(path: string, body: unknown, init: RequestInit = {}): Promise<T> {
  return request<T>(path, { ...init, method: 'POST', headers: { ...init.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function formatMoney(value: string | number, currency?: string | null) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '价格待确认';
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return amount.toFixed(2);
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, currencyDisplay: currency === 'USD' ? 'narrowSymbol' : 'symbol', maximumFractionDigits: 2 }).format(amount); }
  catch { return `${currency} ${amount.toFixed(2)}`; }
}

/**
 * 统一分页 / 排序 / 搜索工具
 *
 * 请求参数:
 *   ?page=1&pageSize=50          (默认 1/50, pageSize 上限 500)
 *   ?sort=field:asc|desc         (可选, 默认按插入顺序)
 *   ?q=keyword                   (关键字在调用方内已过滤, 这里不处理)
 *
 * 响应:
 *   { ok: true, data, total, page, pageSize, totalPages }
 */

export interface PageOptions {
  defaultSort?: string;  // e.g. 'lastSeenAt:desc'
  maxPageSize?: number;
}

export interface PageParams {
  page: number;
  pageSize: number;
  sortField?: string;
  sortDir: 'asc' | 'desc';
}

export function parsePageParams(query: any, opts: PageOptions = {}): PageParams {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const maxPS = opts.maxPageSize ?? 500;
  let pageSize = parseInt(query.pageSize, 10) || 50;
  pageSize = Math.min(Math.max(1, pageSize), maxPS);

  const sortRaw: string = (query.sort as string) || opts.defaultSort || '';
  let sortField: string | undefined;
  let sortDir: 'asc' | 'desc' = 'desc';
  if (sortRaw) {
    const [f, d] = sortRaw.split(':');
    sortField = f;
    sortDir = d === 'asc' ? 'asc' : 'desc';
  }
  return { page, pageSize, sortField, sortDir };
}

export function sortInPlace<T extends Record<string, any>>(arr: T[], field: string | undefined, dir: 'asc' | 'desc'): T[] {
  if (!field) return arr;
  const mul = dir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
  return arr;
}

export function paginate<T>(arr: T[], params: PageParams) {
  const total = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const page = Math.min(params.page, totalPages);
  const start = (page - 1) * params.pageSize;
  const data = arr.slice(start, start + params.pageSize);
  return {
    data,
    total,
    page,
    pageSize: params.pageSize,
    totalPages,
  };
}

const BEIJING_TIME_ZONE = 'Asia/Shanghai';

function formatDateTime(value?: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIME_ZONE,
    hour12: false,
    ...options,
  }).format(date).replace(/\//g, '-');
}

export function formatBeijingTime(value?: string | number | Date): string {
  return formatDateTime(value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBeijingDateTime(value?: string | number | Date): string {
  return formatDateTime(value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function beijingFileTimestamp(date = new Date()): string {
  return formatDateTime(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(/[\s:]/g, '-');
}

import React from 'react';

interface Props {
  page: number;
  pageSize: number;
  total: number;
  totalPages?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

export function Pagination({
  page, pageSize, total, totalPages,
  onPageChange, onPageSizeChange,
  pageSizeOptions = [20, 50, 100, 200],
}: Props) {
  const pages = totalPages ?? Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const goto = (p: number) => {
    const next = Math.max(1, Math.min(p, pages));
    if (next !== page) onPageChange(next);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      padding: '0.5rem 0', fontSize: '0.8rem', color: 'var(--text-dim)',
      flexWrap: 'wrap',
    }}>
      <span>
        {total === 0 ? '0 条' : `${start}-${end} / ${total}`}
      </span>
      <span style={{ flex: 1 }} />
      {onPageSizeChange && (
        <>
          <span>每页</span>
          <select value={pageSize} onChange={e => onPageSizeChange(+e.target.value)} style={{ width: '70px' }}>
            {pageSizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </>
      )}
      <button className="btn" disabled={page <= 1} onClick={() => goto(1)}>«</button>
      <button className="btn" disabled={page <= 1} onClick={() => goto(page - 1)}>‹</button>
      <span style={{ minWidth: '60px', textAlign: 'center' }}>{page} / {pages}</span>
      <button className="btn" disabled={page >= pages} onClick={() => goto(page + 1)}>›</button>
      <button className="btn" disabled={page >= pages} onClick={() => goto(pages)}>»</button>
    </div>
  );
}

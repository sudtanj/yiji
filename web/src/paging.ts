export const PAGE_SIZE = 500;

/** Half-open range [start, end) of rows to render for a scroll position, padded by `overscan` rows. */
export function visibleRange(scrollTop: number, height: number, rowH: number, overscan: number, total: number): [number, number] {
  const end = Math.min(total, Math.ceil((scrollTop + height) / rowH) + overscan);
  const start = Math.min(end, Math.max(0, Math.floor(scrollTop / rowH) - overscan));
  return [start, end];
}

/** `from` must already be quoted. */
export const pageSql = (from: string, offset: number, limit: number) =>
  `select * from ${from} limit ${limit} offset ${offset}`;

export const findPage = (collection: string, offset: number, limit: number) =>
  JSON.stringify({ find: collection, skip: offset, limit, batchSize: limit });

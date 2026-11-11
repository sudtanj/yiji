import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, findPage, pageSql, visibleRange } from './paging';

describe('visibleRange', () => {
  it('covers the viewport plus overscan at the top', () => {
    expect(visibleRange(0, 240, 24, 5, 1000)).toEqual([0, 15]);
  });
  it('starts overscan rows above the first visible row', () => {
    expect(visibleRange(2400, 240, 24, 5, 1000)).toEqual([95, 115]);
  });
  it('clamps to the row count', () => {
    expect(visibleRange(0, 240, 24, 5, 3)).toEqual([0, 3]);
    expect(visibleRange(24 * 98, 240, 24, 5, 100)).toEqual([93, 100]);
  });
  it('is empty without rows or past the end', () => {
    expect(visibleRange(0, 240, 24, 5, 0)).toEqual([0, 0]);
    expect(visibleRange(9999, 240, 24, 5, 10)).toEqual([10, 10]);
  });
  it('renders only overscan rows when the viewport has no height', () => {
    expect(visibleRange(0, 0, 24, 5, 1000)).toEqual([0, 5]);
    expect(visibleRange(480, 0, 24, 5, 1000)).toEqual([15, 25]);
  });
  it('keeps the last rows when scrolled to the very end', () => {
    // 100 rows * 24px = 2400px body, 240px viewport: max scrollTop is 2160.
    expect(visibleRange(2160, 240, 24, 5, 100)).toEqual([85, 100]);
  });
  it('includes partially visible rows for fractional scroll positions', () => {
    expect(visibleRange(35.5, 240, 24, 0, 1000)).toEqual([1, 12]);
    expect(visibleRange(23.9, 24, 24, 0, 1000)).toEqual([0, 2]);
  });
  it('clamps large overscan, and handles zero overscan and negative scroll', () => {
    expect(visibleRange(0, 240, 24, 1000, 50)).toEqual([0, 50]);
    expect(visibleRange(48, 240, 24, 0, 1000)).toEqual([2, 12]);
    expect(visibleRange(-50, 240, 24, 5, 1000)).toEqual([0, 13]);
  });
  it('keeps 0 <= start <= end <= total for any input', () => {
    for (const total of [0, 1, 7, 100])
      for (const top of [0, 1, 23.5, 500, 1e6])
        for (const h of [0, 100, 5000]) {
          const [a, b] = visibleRange(top, h, 24, 8, total);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(b);
          expect(b).toBeLessThanOrEqual(total);
        }
  });
});

describe('page builders', () => {
  it('builds limit/offset SQL', () => {
    expect(pageSql('"s"."t"', 500, 500)).toBe('select * from "s"."t" limit 500 offset 500');
  });
  it('passes a quoted identifier through untouched', () => {
    expect(pageSql('"we""ird"."a.b"', 0, 500)).toBe('select * from "we""ird"."a.b" limit 500 offset 0');
    expect(pageSql(`"it's"`, 0, 1)).toBe(`select * from "it's" limit 1 offset 0`);
  });
  it('uses plain integers for limit and offset', () => {
    expect(pageSql('"t"', 0, PAGE_SIZE)).toMatch(/ limit 500 offset 0$/);
    expect(pageSql('"t"', 1_000_000, 500)).toMatch(/ limit 500 offset 1000000$/);
  });
  it('keeps the page size at 500', () => {
    expect(PAGE_SIZE).toBe(500);
  });
  it('builds a find with skip and limit', () => {
    expect(JSON.parse(findPage('users', 1000, 500))).toEqual({ find: 'users', skip: 1000, limit: 500, batchSize: 500 });
  });
  it('escapes a collection name with quotes in the find JSON', () => {
    expect(JSON.parse(findPage('a"b.c', 0, 500))).toEqual({ find: 'a"b.c', skip: 0, limit: 500, batchSize: 500 });
  });
});

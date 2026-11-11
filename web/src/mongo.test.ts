import { describe, expect, it } from 'vitest';
import { replyToGrid } from './mongo';

describe('replyToGrid', () => {
  it('uses the union of top-level keys as columns and fills gaps with null', () => {
    const reply = JSON.stringify({
      cursor: { firstBatch: [{ _id: 1, name: 'a' }, { _id: 2, age: 30 }], id: 0 },
      ok: 1,
    });
    expect(replyToGrid(reply)).toEqual({
      columns: [{ name: '_id' }, { name: 'name' }, { name: 'age' }],
      rows: [
        [1, 'a', null],
        [2, null, 30],
      ],
    });
  });

  it('renders nested values as compact JSON and keeps null', () => {
    const reply = '{"cursor":{"firstBatch":[{"_id":{"$oid":"abc"},"tags":["x","y"],"addr":{"city":"Z"},"gone":null}]},"ok":1}';
    expect(replyToGrid(reply).rows).toEqual([['{"$oid":"abc"}', '["x","y"]', '{"city":"Z"}', null]]);
  });

  it('returns no rows for an empty batch', () => {
    expect(replyToGrid('{"cursor":{"firstBatch":[]},"ok":1}')).toEqual({ columns: [], rows: [] });
  });

  it('shows a reply without a cursor as one raw cell', () => {
    expect(replyToGrid('{"n":3,"ok":1}')).toEqual({ columns: [{ name: 'reply' }], rows: [['{"n":3,"ok":1}']] });
  });

  it('throws the server message when ok is 0', () => {
    expect(() => replyToGrid('{"ok":0,"errmsg":"unauthorized"}')).toThrow('unauthorized');
  });
});

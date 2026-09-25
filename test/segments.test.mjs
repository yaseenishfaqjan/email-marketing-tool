import './helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSegment, SegmentError } from '../src/segments/compile.mjs';

test('an empty segment means everybody, not nobody', () => {
  // An empty AND-chain compiling to a false-y expression would silently send a
  // campaign to zero people and look like a successful send.
  assert.deepEqual(compileSegment({ match: 'all', rules: [] }), { sql: 'true', params: [] });
  assert.deepEqual(compileSegment(undefined), { sql: 'true', params: [] });
});

test('values are bound, never interpolated', () => {
  const { sql, params } = compileSegment({
    rules: [{ field: 'email', op: 'contains', value: "'; drop table contacts; --" }],
  });
  assert.ok(!sql.includes('drop table'));
  assert.deepEqual(params, ["'; drop table contacts; --"]);
});

test('parameter numbering respects the offset the caller reserves', () => {
  const { sql, params } = compileSegment(
    { rules: [{ field: 'status', op: 'eq', value: 'subscribed' }] },
    3,
  );
  assert.match(sql, /\$3/);
  assert.equal(params.length, 1);
});

test('match: any produces OR, the default produces AND', () => {
  const rules = [
    { field: 'status', op: 'eq', value: 'subscribed' },
    { field: 'source', op: 'eq', value: 'form' },
  ];
  assert.match(compileSegment({ match: 'any', rules }).sql, / or /);
  assert.match(compileSegment({ match: 'all', rules }).sql, / and /);
});

test('unknown fields and operators are refused', () => {
  assert.throws(() => compileSegment({ rules: [{ field: 'password', op: 'eq', value: 'x' }] }), SegmentError);
  assert.throws(() => compileSegment({ rules: [{ field: 'email', op: 'regex', value: '.*' }] }), SegmentError);
  assert.throws(() => compileSegment({ rules: [{ field: 'created_at', op: 'contains', value: 'x' }] }), SegmentError);
});

test('an attribute key is a parameter, not part of the SQL', () => {
  const { sql, params } = compileSegment({
    rules: [{ field: "attrs.plan'); drop table contacts; --", op: 'eq', value: 'pro' }],
  });
  assert.ok(!sql.includes('drop table'));
  assert.equal(params[0], "plan'); drop table contacts; --");
});

test('tag rules become an EXISTS against contact_tags', () => {
  const { sql, params } = compileSegment({
    rules: [{ field: 'tag', op: 'has', value: '11111111-1111-1111-1111-111111111111' }],
  });
  assert.match(sql, /exists \(select 1 from contact_tags/);
  assert.equal(params[0], '11111111-1111-1111-1111-111111111111');
  assert.match(compileSegment({ rules: [{ field: 'tag', op: 'not_has', value: 'x' }] }).sql, /^\(not exists/);
});

test('within_days only accepts a whole number of days', () => {
  assert.doesNotThrow(() => compileSegment({ rules: [{ field: 'created_at', op: 'within_days', value: 30 }] }));
  assert.throws(() => compileSegment({ rules: [{ field: 'created_at', op: 'within_days', value: "30'; --" }] }), SegmentError);
});

test('a rule count that would blow up the query planner is refused', () => {
  const rules = Array.from({ length: 51 }, () => ({ field: 'status', op: 'eq', value: 'subscribed' }));
  assert.throws(() => compileSegment({ rules }), SegmentError);
});

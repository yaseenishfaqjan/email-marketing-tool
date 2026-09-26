/**
 * Compile a stored segment definition into SQL.
 *
 * A segment is a filter, not a list. Compiling it at send time is what makes
 * "everyone who signed up in the last 30 days" mean the right thing on the day
 * the campaign goes out rather than the day somebody saved it.
 *
 * Every field name and operator is checked against a whitelist and every value
 * is a bound parameter. Nothing from the definition is ever concatenated into
 * SQL — a segment is user input, and it arrives from an admin UI that one day
 * somebody will expose to a less trusted user.
 *
 * Definition shape:
 *   { "match": "all" | "any",
 *     "rules": [ { "field": "status", "op": "eq", "value": "subscribed" },
 *                { "field": "attrs.plan", "op": "eq", "value": "pro" },
 *                { "field": "tag", "op": "has", "value": "<tag uuid>" } ] }
 */

const COLUMNS = {
  email: 'c.email',
  first_name: 'c.first_name',
  last_name: 'c.last_name',
  status: 'c.status',
  source: 'c.source',
  created_at: 'c.created_at',
  consent_at: 'c.consent_at',
};

const TEXT_OPS = {
  eq: (col, p) => `${col} = ${p}`,
  neq: (col, p) => `${col} is distinct from ${p}`,
  contains: (col, p) => `${col} ilike '%' || ${p} || '%'`,
  starts_with: (col, p) => `${col} ilike ${p} || '%'`,
};

const DATE_OPS = {
  before: (col, p) => `${col} < ${p}`,
  after: (col, p) => `${col} > ${p}`,
  within_days: (col, p) => `${col} > now() - (${p} || ' days')::interval`,
};

const NULL_OPS = {
  exists: (col) => `${col} is not null`,
  not_exists: (col) => `${col} is null`,
};

const DATE_FIELDS = new Set(['created_at', 'consent_at']);

export class SegmentError extends Error {}

/**
 * @returns {{sql: string, params: any[]}} a boolean SQL expression over alias `c`
 */
export function compileSegment(definition, startIndex = 1) {
  const def = definition ?? {};
  const match = def.match === 'any' ? 'or' : 'and';
  const rules = Array.isArray(def.rules) ? def.rules : [];

  // No rules means the whole list. That is a real and common case ("send to
  // everyone"), so it must not be an error — but it must also not silently
  // become "nobody", which an empty AND-chain would.
  if (rules.length === 0) return { sql: 'true', params: [] };
  if (rules.length > 50) throw new SegmentError('A segment may not have more than 50 rules.');

  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${startIndex + params.length - 1}`;
  };

  const parts = rules.map((rule) => compileRule(rule, p));
  return { sql: `(${parts.join(` ${match} `)})`, params };
}

function compileRule(rule, p) {
  if (!rule || typeof rule !== 'object') throw new SegmentError('Each rule must be an object.');
  const { field, op, value } = rule;
  if (typeof field !== 'string' || typeof op !== 'string') {
    throw new SegmentError('Each rule needs a "field" and an "op".');
  }

  // "Has this person done X in their product?" -- the rule that makes
  // behavioural automations possible: trial started but feature never used,
  // checkout begun but nothing purchased.
  if (field === 'event') {
    if (typeof value !== 'string' || !value) throw new SegmentError('An event rule needs an event name.');
    let window = '';
    if (rule.within_days !== undefined) {
      const n = Number(rule.within_days);
      if (!Number.isInteger(n) || n < 0 || n > 36500) throw new SegmentError('within_days needs a whole number of days.');
      window = ` and e.at > now() - (${p(String(n))} || ' days')::interval`;
    }
    const exists = `exists (select 1 from events e where e.contact_id = c.id and e.name = ${p(value)}${window})`;
    if (op === 'has') return exists;
    if (op === 'not_has') return `not ${exists}`;
    throw new SegmentError(`Unknown event operator "${op}". Use has or not_has.`);
  }

  // Tags live in a join table; membership is an EXISTS, not a column compare.
  if (field === 'tag') {
    if (typeof value !== 'string') throw new SegmentError('A tag rule needs a tag id.');
    const exists = `exists (select 1 from contact_tags ct where ct.contact_id = c.id and ct.tag_id = ${p(value)}::uuid)`;
    if (op === 'has') return exists;
    if (op === 'not_has') return `not ${exists}`;
    throw new SegmentError(`Unknown tag operator "${op}". Use has or not_has.`);
  }

  // attrs.<key> — arbitrary per-brand data. The key is passed as a parameter
  // to the -> operator, so an attribute called "'; drop table" is just a key
  // that matches nothing.
  if (field.startsWith('attrs.')) {
    const key = field.slice(6);
    if (!key || key.length > 128) throw new SegmentError(`Invalid attribute "${field}".`);
    const col = `(c.attrs ->> ${p(key)})`;
    if (op in NULL_OPS) return NULL_OPS[op](col);
    if (op in TEXT_OPS) return TEXT_OPS[op](col, p(String(value ?? '')));
    throw new SegmentError(`Operator "${op}" cannot be used on an attribute.`);
  }

  const col = COLUMNS[field];
  if (!col) throw new SegmentError(`Unknown field "${field}".`);

  if (op in NULL_OPS) return NULL_OPS[op](col);

  if (DATE_FIELDS.has(field)) {
    if (!(op in DATE_OPS)) throw new SegmentError(`Operator "${op}" cannot be used on a date.`);
    if (op === 'within_days') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 36500) throw new SegmentError('within_days needs a whole number of days.');
      return DATE_OPS[op](col, p(String(n)));
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new SegmentError(`"${value}" is not a date.`);
    return DATE_OPS[op](col, p(d.toISOString()));
  }

  if (!(op in TEXT_OPS)) throw new SegmentError(`Unknown operator "${op}".`);
  return TEXT_OPS[op](col, p(String(value ?? '')));
}

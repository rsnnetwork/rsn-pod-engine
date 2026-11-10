// One member's row in the users table, for tests that run the real picture services against a database stand-in
// (30 Oct review, T3a). It understands the two shapes those services write:
//   UPDATE users SET col = $n, col = NULL, col = 'text', col = NOW() WHERE id = $1 [RETURNING col, ...]
//   SELECT col [AS name], ... FROM users WHERE id = $1
// so a test reads back exactly what was stored, whatever order the columns are written in. The patterns run over the
// SQL text only (never over a parameter, which can be a picture of megabytes).

export type Row = Record<string, unknown>;

const NOW = new Date('2026-11-01T10:00:00.000Z');

function valueOf(expr: string, params: unknown[]): unknown {
  const e = expr.trim();
  if (/^\$\d+$/.test(e)) return params[Number(e.slice(1)) - 1];
  if (/^NULL$/i.test(e)) return null;
  if (/^NOW\(\)$/i.test(e)) return NOW;
  if (/^'.*'$/.test(e)) return e.slice(1, -1);
  throw new Error(`fake-user-row: cannot read ${e}`);
}

const project = (row: Row, list: string) => {
  const out: Row = {};
  for (const item of list.split(',')) {
    const [col, alias] = item.trim().split(/\s+AS\s+/i);
    out[(alias ?? col).replace(/"/g, '')] = row[col] ?? null;
  }
  return out;
};

/**
 * A stand-in for `query` that holds one row. Returns null for SQL it does not know, so a test can answer that itself.
 * Like a real row, it is a member's unless the test says otherwise (users.account_kind defaults to 'member').
 */
export function fakeUserRow(initial: Row) {
  const row: Row = { account_kind: 'member', ...initial };
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const handle = (sql: string, params: unknown[] = []): { rows: Row[] } | null => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const update = /^UPDATE users SET (.+?) WHERE id = \$(\d+)(?: RETURNING (.+))?$/i.exec(s);
    if (update) {
      writes.push({ sql: s, params });
      if (params[Number(update[2]) - 1] !== row.id) return { rows: [] };
      for (const part of update[1].split(',')) {
        const at = part.indexOf('=');
        row[part.slice(0, at).trim()] = valueOf(part.slice(at + 1), params);
      }
      return { rows: [update[3] ? project(row, update[3]) : { id: row.id }] };
    }
    const select = /^SELECT (.+?) FROM users WHERE id = \$1$/i.exec(s);
    if (select) return { rows: params[0] === row.id ? [project(row, select[1])] : [] };
    return null;
  };
  return { row, writes, handle, NOW };
}

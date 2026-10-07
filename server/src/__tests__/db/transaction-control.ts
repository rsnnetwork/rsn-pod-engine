// What is not code: comments, string literals and dollar-quoted bodies. Matched in one
// pass, left to right, so a "--" inside a string or a quote inside a comment cannot
// confuse the next match.
const NOT_CODE = /--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'/g;

/**
 * The top-level statements in a migration that open or end a transaction: BEGIN,
 * START TRANSACTION, COMMIT, END (Postgres's other name for COMMIT), ROLLBACK and
 * ABORT (its other name for ROLLBACK), in any case, with or without the semicolon.
 * The runner (db/migrate.ts) already wraps each file in its own transaction, so a
 * file that does either commits or abandons it part way through.
 *
 * PL/pgSQL blocks have a BEGIN and END of their own, which are not transaction
 * control: they sit inside dollar quotes, which are blanked first, so a DO block or
 * a function body is left alone. An END that closes a CASE expression never starts a
 * statement, so it is too. It is a statement-start check and nothing more: a
 * ROLLBACK TO a savepoint is flagged as well (no migration here uses savepoints),
 * and a BEGIN ATOMIC function body, whose END would start a statement after its
 * inner semicolons, would be misread (none exists).
 */
export function transactionControl(migration: string): string[] {
  return migration
    .replace(NOT_CODE, ' ')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i.test(statement));
}

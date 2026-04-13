/**
 * sqlEscape — serialises a JS value to a SQL literal.
 *
 * Backslash handling differs by dialect:
 *   MySQL   — backslash is an escape character (NO_BACKSLASH_ESCAPES OFF by default),
 *             so a literal backslash must be written as \\ in the SQL string.
 *   SQLite  — backslash is NOT special in string literals; only '' escapes a single quote.
 *             Doubling backslashes here would corrupt the data when re-imported.
 *
 * @param {*}      value
 * @param {string} dialect  'sqlite' (default) | 'mysql'
 */
export function sqlEscape(value, dialect = "sqlite") {
  if (value === null || value === undefined) return "NULL";

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  // Buffer / BLOB → hex literal (portable across dialects)
  if (Buffer.isBuffer(value)) {
    return "X'" + value.toString("hex") + "'";
  }

  // Date → ISO-8601 string
  if (value instanceof Date) {
    const iso = value.toISOString().replace(/'/g, "''");
    return "'" + iso + "'";
  }

  const s = String(value);

  if (dialect === "mysql") {
    // MySQL interprets \\ as a single backslash inside string literals.
    // Escape backslashes first, then single quotes.
    return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  }

  // SQLite / standard SQL: backslash is a literal character — escape only ' by doubling.
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * quoteIdent — wraps an identifier in backticks.
 * Backticks are accepted by both MySQL and SQLite (SQLite also accepts " and []).
 */
export function quoteIdent(name, dialect = "sqlite") {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

/**
 * MySQL / MariaDB dialect
 * Transforms SQLite DDL into MySQL-compatible DDL.
 *
 * ── Type conversions ─────────────────────────────────────────────────────────
 *   UNSIGNED BIG INT      → BIGINT UNSIGNED
 *   DOUBLE PRECISION      → DOUBLE
 *   VARYING CHARACTER(n)  → VARCHAR(n)
 *   NATIVE CHARACTER(n)   → CHAR(n)
 *   CHARACTER(n)          → CHAR(n)       (not CHARACTER SET)
 *   NVARCHAR(n)           → VARCHAR(n)
 *   NCHAR(n)              → CHAR(n)
 *   INT2                  → SMALLINT
 *   INT8                  → BIGINT
 *   INTEGER               → INT
 *   NUMERIC               → DECIMAL
 *   BOOLEAN / BOOL        → TINYINT(1)
 *   AUTOINCREMENT         → AUTO_INCREMENT
 *   REAL                  → DOUBLE
 *   BLOB                  → LONGBLOB
 *   CLOB                  → LONGTEXT
 *   TEXT                  → LONGTEXT
 *
 * ── DDL cleanup ──────────────────────────────────────────────────────────────
 *   Double-quoted identifiers          → backtick-quoted
 *   ON CONFLICT clause                 → removed
 *   DEFERRABLE / INITIALLY clauses     → removed
 *   COLLATE NOCASE / RTRIM             → removed
 *   COLLATE BINARY                     → COLLATE utf8mb4_bin
 *   WITHOUT ROWID                      → removed
 *   STRICT modifier (SQLite 3.37+)     → removed
 *   Partial index WHERE clause         → removed
 *   DEFAULT (datetime('now'))          → DEFAULT CURRENT_TIMESTAMP
 *   DEFAULT (date('now'))              → DEFAULT CURRENT_DATE
 *   DEFAULT (time('now'))              → DEFAULT CURRENT_TIME
 *   DEFAULT (strftime/julianday/…)     → stripped (no MySQL equivalent)
 *   TEXT/BLOB DEFAULT literal/expr     → stripped (invalid in MySQL < 8.0.13)
 *   CREATE TABLE                       → ENGINE=InnoDB + utf8mb4 appended
 */

export function transformDDL(sql) {
  if (!sql) return sql;

  let out = sql.replace(/\r\n/g, "\n");

  // ── 1. Identifier quoting ─────────────────────────────────────────────────
  // "colName" → `colName`
  out = out.replace(/"([^"]+)"/g, "`$1`");

  // ── 2. Type conversions (multi-word before single-word) ───────────────────

  // Multi-word patterns must come before their sub-words are replaced
  out = out.replace(/\bUNSIGNED\s+BIG\s+INT\b/gi,      "BIGINT UNSIGNED");
  out = out.replace(/\bDOUBLE\s+PRECISION\b/gi,         "DOUBLE");
  out = out.replace(/\bVARYING\s+CHARACTER\b/gi,        "VARCHAR");
  out = out.replace(/\bNATIVE\s+CHARACTER\b/gi,         "CHAR");

  // CHARACTER(n) → CHAR(n)  —  but NOT "CHARACTER SET ..." (MySQL encoding directive)
  out = out.replace(/\bCHARACTER\b(?!\s+SET)/gi,        "CHAR");

  // N-prefixed aliases
  out = out.replace(/\bNVARCHAR\b/gi,  "VARCHAR");
  out = out.replace(/\bNCHAR\b/gi,     "CHAR");

  // Integer aliases (specific before generic)
  out = out.replace(/\bINT2\b/gi,    "SMALLINT");
  out = out.replace(/\bINT8\b/gi,    "BIGINT");
  out = out.replace(/\bINTEGER\b/gi, "INT");

  // Exact numeric
  out = out.replace(/\bNUMERIC\b/gi, "DECIMAL");

  // Boolean (before any INT replacement could interfere)
  out = out.replace(/\bBOOLEAN\b/gi, "TINYINT(1)");
  out = out.replace(/\bBOOL\b/gi,    "TINYINT(1)");

  // Keyword
  out = out.replace(/\bAUTOINCREMENT\b/gi, "AUTO_INCREMENT");

  // Float
  out = out.replace(/\bREAL\b/gi, "DOUBLE");

  // Binary
  out = out.replace(/\bBLOB\b/gi, "LONGBLOB");

  // Text
  // Note: \bTEXT\b has a word-boundary before T, so it does NOT match
  // TINYTEXT / MEDIUMTEXT (the T there is preceded by a word character).
  out = out.replace(/\bCLOB\b/gi, "LONGTEXT");
  out = out.replace(/\bTEXT\b/gi, "LONGTEXT");

  // ── 3. SQLite-specific DDL removal ───────────────────────────────────────

  // ON CONFLICT (column-level and table-level constraints)
  // e.g. "NOT NULL ON CONFLICT REPLACE",  "UNIQUE ON CONFLICT IGNORE"
  out = out.replace(
    /\bON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\b/gi,
    ""
  );

  // DEFERRABLE / INITIALLY (foreign key options, unsupported in MySQL)
  out = out.replace(/\b(?:NOT\s+)?DEFERRABLE\b/gi,             "");
  out = out.replace(/\bINITIALLY\s+(?:DEFERRED|IMMEDIATE)\b/gi, "");

  // COLLATE variants
  out = out.replace(/\bCOLLATE\s+NOCASE\b/gi,  "");           // no direct MySQL equivalent
  out = out.replace(/\bCOLLATE\s+RTRIM\b/gi,   "");           // no direct MySQL equivalent
  out = out.replace(/\bCOLLATE\s+BINARY\b/gi,  "COLLATE utf8mb4_bin");

  // ── 4. Partial index — strip WHERE clause ────────────────────────────────
  // MySQL does not support partial (filtered) indexes.
  // The index itself is kept; only the WHERE predicate is removed.
  if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(out)) {
    out = out.replace(/\s+WHERE\s+[\s\S]+$/i, "");
  }

  // ── 5. SQLite DEFAULT functions → MySQL equivalents ───────────────────────
  // Handles both forms: DEFAULT (datetime('now')) and DEFAULT datetime('now')
  // The inner regex `[^()]*(?:\([^()]*\)[^()]*)*` matches one level of nesting
  // so it covers strftime('%Y-%m-%d', 'now') and datetime('now', 'localtime').
  out = out.replace(
    /\bDEFAULT\s+\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi,
    (_match, inner) => {
      const t = inner.trim();
      if (/^datetime\s*\(/i.test(t))                        return "DEFAULT CURRENT_TIMESTAMP";
      if (/^date\s*\(/i.test(t))                            return "DEFAULT CURRENT_DATE";
      if (/^time\s*\(/i.test(t))                            return "DEFAULT CURRENT_TIME";
      if (/^(?:strftime|julianday|unixepoch)\s*\(/i.test(t)) return ""; // strip — no equivalent
      return _match; // literal in parens — keep as-is
    }
  );
  // Bare function calls (some SQLite versions omit the outer parens)
  out = out.replace(/\bDEFAULT\s+datetime\s*\([^)]*\)/gi,                      "DEFAULT CURRENT_TIMESTAMP");
  out = out.replace(/\bDEFAULT\s+date\s*\([^)]*\)/gi,                           "DEFAULT CURRENT_DATE");
  out = out.replace(/\bDEFAULT\s+time\s*\([^)]*\)/gi,                           "DEFAULT CURRENT_TIME");
  out = out.replace(/\bDEFAULT\s+(?:strftime|julianday|unixepoch)\s*\([^)]*\)/gi, "");

  // ── 6. TEXT/BLOB columns: strip non-NULL DEFAULT (invalid in MySQL < 8.0.13) ─
  // After type conversion, TEXT→LONGTEXT etc. Process line by line so we only
  // touch column definition lines that carry both a text/blob type and DEFAULT.
  if (/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE/i.test(out)) {
    const textBlobRe = /\b(?:(?:LONG|MEDIUM|TINY)?TEXT|(?:LONG|MEDIUM|TINY)?BLOB)\b/i;
    out = out.split("\n").map((line) => {
      if (!textBlobRe.test(line) || !/\bDEFAULT\b/i.test(line)) return line;
      if (/\bDEFAULT\s+NULL\b/i.test(line)) return line; // NULL is valid everywhere
      // Strip the DEFAULT clause (value may be: quoted string, (expr), or bare token).
      // Use [^\s,)]+ (not \S+) so the trailing comma/paren is NOT consumed.
      return line.replace(
        /\s+DEFAULT\s+(?:\((?:[^()]*(?:\([^()]*\)[^()]*)*)\)|'[^']*'|"[^"]*"|[^\s,)]+)/gi,
        ""
      );
    }).join("\n");
  }

  // ── 7. CREATE TABLE — remove table options + append ENGINE ───────────────
  if (/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE/i.test(out)) {
    // Remove STRICT modifier (SQLite 3.37+)
    out = out.replace(/\bSTRICT\b/gi, "");
    // Remove WITHOUT ROWID
    out = out.replace(/\bWITHOUT\s+ROWID\b/gi, "");
    // Clean up orphan commas before closing paren
    // e.g. "(col1 INT, col2 TEXT,)" → "(col1 INT, col2 TEXT)"
    out = out.replace(/,(\s*\))/g, "$1");

    out = out
      .trimEnd()
      .replace(
        /\)\s*$/,
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
      );
  }

  return out.trimEnd();
}

export function header() {
  return [
    "-- Dialect: MySQL / MariaDB",
    "-- Generated by sqlite-to-sql",
    "--",
    "-- NOTES:",
    "--   • VIEWs and TRIGGERs may need manual review (syntax differs from SQLite).",
    "--   • NOCASE/RTRIM collations stripped — add per-column collation if needed.",
    "--   • Filtered index predicates removed (not supported in MySQL < 8.0.13).",
    "--   • datetime('now') DEFAULT → CURRENT_TIMESTAMP; strftime/julianday stripped.",
    "--   • TEXT/BLOB DEFAULT (non-NULL) stripped — not valid in MySQL < 8.0.13.",
    "",
    "SET NAMES utf8mb4;",
    "SET FOREIGN_KEY_CHECKS = 0;",
  ].join("\n");
}

export function footer() {
  return "\nSET FOREIGN_KEY_CHECKS = 1;";
}

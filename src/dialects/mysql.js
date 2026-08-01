import { quoteIdent, sqlEscape } from "../escape.js";
import {
  getColumnMaxLength,
  getForeignKeys,
  getIndexes,
  getTableInfo,
  getTableSql,
} from "../schema.js";
import {
  extractCheckExpressions,
  extractGeneratedClause,
  parseCreateTable,
  translateMysqlExpression,
} from "../sqlite-parser.js";

/**
 * Build MySQL 8 compatible CREATE TABLE statements from SQLite PRAGMA metadata.
 * This avoids unsafe global replacements inside identifiers, CHECK values and
 * string literals.
 */
export function buildTableDDL(db, tableName, { inspectTextLengths = true } = {}) {
  const warnings = [];
  const tableSql = getTableSql(db, tableName);
  const parsed = parseCreateTable(tableSql);
  const columns = getTableInfo(db, tableName);
  const indexes = getIndexes(db, tableName);
  const foreignKeys = getForeignKeys(db, tableName);
  const knownNames = columns.map((c) => c.name);
  const indexedNames = new Set(
    indexes.flatMap((idx) => idx.columns.filter((c) => Number(c.cid) >= 0 && c.name).map((c) => c.name))
  );
  const pkColumns = columns.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
  const singlePk = pkColumns.length === 1 ? pkColumns[0].name : null;
  const hasAutoIncrement = /\bAUTOINCREMENT\b/i.test(tableSql);
  const definitions = [];

  for (const col of columns) {
    const raw = parsed.columns.get(col.name)?.raw ?? "";
    const shouldInspectLength = inspectTextLengths && (indexedNames.has(col.name) || col.dflt_value != null);
    const maxLength = shouldInspectLength
      ? safeMaxLength(db, tableName, col.name, warnings)
      : 0;
    const typeResult = mapSqliteType(col.type, {
      indexed: indexedNames.has(col.name),
      maxLength,
      defaultValue: col.dflt_value,
      tableName,
      columnName: col.name,
    });
    warnings.push(...typeResult.warnings);

    const parts = [quoteIdent(col.name, "mysql"), typeResult.type];
    const hidden = Number(col.hidden ?? 0);

    if (hidden > 0) {
      const generated = extractGeneratedClause(raw);
      if (!generated) {
        warnings.push(`Coluna gerada ${tableName}.${col.name} foi omitida: expressão não identificada.`);
        continue;
      }
      const expression = translateMysqlExpression(generated.expression, knownNames);
      parts.push(`GENERATED ALWAYS AS (${expression}) ${generated.storage}`);
      definitions.push("  " + parts.join(" "));
      continue;
    }

    const isSinglePk = singlePk === col.name;
    if (isSinglePk) parts.push("PRIMARY KEY");
    if (hasAutoIncrement && isSinglePk && hasIntegerAffinity(col.type)) parts.push("AUTO_INCREMENT");
    if (Number(col.notnull) === 1 && !isSinglePk) parts.push("NOT NULL");

    const defaultResult = translateDefault(col.dflt_value, typeResult.type);
    if (defaultResult.sql) parts.push(defaultResult.sql);
    if (defaultResult.warning) warnings.push(`${tableName}.${col.name}: ${defaultResult.warning}`);

    const collation = translateCollation(raw);
    if (collation) parts.push(collation);

    for (const check of extractCheckExpressions(raw)) {
      parts.push(`CHECK (${translateMysqlExpression(check, knownNames)})`);
    }

    definitions.push("  " + parts.join(" "));
  }

  if (pkColumns.length > 1) {
    definitions.push(`  PRIMARY KEY (${pkColumns.map((c) => quoteIdent(c.name, "mysql")).join(", ")})`);
  }

  // SQLite creates autoindexes for inline/table UNIQUE constraints. Rebuild them
  // as named UNIQUE KEY constraints, but never broaden partial uniqueness.
  let uniqueCounter = 0;
  const uniqueSignatures = new Set();
  const uniqueIndexes = indexes
    .filter((idx) => idx.unique && idx.origin !== "pk")
    .sort((a, b) => Number(a.name.startsWith("sqlite_autoindex_")) - Number(b.name.startsWith("sqlite_autoindex_")));
  for (const idx of uniqueIndexes) {
    if (idx.partial) {
      warnings.push(`Índice UNIQUE parcial ${idx.name} foi ignorado para não alterar a regra de unicidade.`);
      continue;
    }
    const cols = usableIndexColumns(idx, tableName, warnings);
    if (!cols) continue;
    const signature = cols.map((c) => `${String(c.name).toLowerCase()}:${Number(c.desc)}`).join("|");
    if (uniqueSignatures.has(signature)) continue;
    uniqueSignatures.add(signature);
    uniqueCounter++;
    const name = idx.name.startsWith("sqlite_autoindex_")
      ? safeObjectName(`uq_${tableName}_${uniqueCounter}`)
      : safeObjectName(idx.name);
    definitions.push(`  UNIQUE KEY ${quoteIdent(name, "mysql")} (${formatIndexColumns(cols)})`);
  }

  for (const fk of foreignKeys) {
    if (!fk.from.length || !fk.to.length || fk.from.some((v) => !v) || fk.to.some((v) => !v)) {
      warnings.push(`Chave estrangeira ${tableName}#${fk.id} foi ignorada por metadados incompletos.`);
      continue;
    }
    const name = safeObjectName(`fk_${tableName}_${fk.id}`);
    const from = fk.from.map((c) => quoteIdent(c, "mysql")).join(", ");
    const to = fk.to.map((c) => quoteIdent(c, "mysql")).join(", ");
    let clause = `  CONSTRAINT ${quoteIdent(name, "mysql")} FOREIGN KEY (${from}) REFERENCES ${quoteIdent(fk.table, "mysql")} (${to})`;
    clause += translateFkAction("ON DELETE", fk.onDelete, warnings, tableName, fk.id);
    clause += translateFkAction("ON UPDATE", fk.onUpdate, warnings, tableName, fk.id);
    definitions.push(clause);
  }

  for (const constraint of parsed.constraints) {
    if (!/^\s*(?:CONSTRAINT\s+[^\s]+\s+)?CHECK\b/i.test(constraint)) continue;
    const checks = extractCheckExpressions(constraint);
    for (const check of checks) {
      definitions.push(`  CHECK (${translateMysqlExpression(check, knownNames)})`);
    }
  }

  const ddl = [
    `CREATE TABLE ${quoteIdent(tableName, "mysql")} (`,
    definitions.join(",\n"),
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  ].join("\n");

  return { sql: ddl, warnings, indexes };
}

export function buildIndexDDLs(tableName, indexes) {
  const warnings = [];
  const statements = [];

  for (const idx of indexes) {
    // UNIQUE constraints are already emitted inside CREATE TABLE.
    if (idx.unique || idx.origin === "pk") continue;
    if (idx.partial) {
      warnings.push(`Índice parcial ${idx.name} foi ignorado; MySQL não suporta o predicado WHERE do SQLite.`);
      continue;
    }
    const cols = usableIndexColumns(idx, tableName, warnings);
    if (!cols) continue;
    const name = safeObjectName(idx.name);
    statements.push(
      `CREATE INDEX ${quoteIdent(name, "mysql")} ON ${quoteIdent(tableName, "mysql")} (${formatIndexColumns(cols)})`
    );
  }

  return { statements, warnings };
}

/**
 * Legacy compatibility helper. It is deliberately conservative now and should
 * only be used for non-table objects. Tables are rebuilt with buildTableDDL().
 */
export function transformDDL(sql) {
  if (!sql) return sql;
  return sql.trim().replace(/;\s*$/, "");
}

export function commentUnsupportedObject(obj) {
  const original = String(obj.sql ?? "").split(/\r?\n/).map((line) => `-- ${line}`).join("\n");
  return [
    `-- AVISO: ${obj.type.toUpperCase()} ${obj.name} não foi executado automaticamente.`,
    "-- Reveja e adapte a sintaxe para MySQL 8 antes de ativar:",
    original,
  ].join("\n");
}

export function header() {
  return [
    "-- Dialect: MySQL 8 / MariaDB",
    "-- Generated by sqlite-to-sql (safe schema mode)",
    "-- Tables are reconstructed from SQLite PRAGMA metadata.",
    "-- Unsupported/ambiguous objects are skipped with explicit warnings.",
    "",
    "SET NAMES utf8mb4;",
    "SET @OLD_SQL_MODE = @@SESSION.SQL_MODE;",
    "SET SESSION SQL_MODE = TRIM(BOTH ',' FROM REPLACE(CONCAT(@@SESSION.SQL_MODE, ',NO_AUTO_VALUE_ON_ZERO'), 'NO_BACKSLASH_ESCAPES', ''));",
    "SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;",
    "SET FOREIGN_KEY_CHECKS = 0;",
  ].join("\n");
}

export function footer() {
  return [
    "",
    "SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;",
    "SET SESSION SQL_MODE = @OLD_SQL_MODE;",
  ].join("\n");
}

function mapSqliteType(declaredType, context) {
  const warnings = [];
  const raw = String(declaredType ?? "").trim();
  const upper = raw.toUpperCase().replace(/\s+/g, " ");
  const params = /\(([^)]*)\)/.exec(upper)?.[1]?.trim();
  const suffix = params ? `(${params})` : "";

  if (!upper) {
    warnings.push(`${context.tableName}.${context.columnName}: tipo SQLite vazio convertido para LONGBLOB.`);
    return { type: "LONGBLOB", warnings };
  }
  if (/\bBOOL(?:EAN)?\b/.test(upper)) return { type: "TINYINT(1)", warnings };
  if (/UNSIGNED\s+BIG\s+INT/.test(upper)) return { type: "BIGINT UNSIGNED", warnings };
  if (/\bINT2\b|\bSMALLINT\b/.test(upper)) return { type: "SMALLINT", warnings };
  if (/\bINT8\b|\bBIGINT\b|\bINTEGER\b/.test(upper)) return { type: "BIGINT", warnings };
  if (/\bTINYINT\b/.test(upper)) return { type: "TINYINT", warnings };
  if (/\bMEDIUMINT\b/.test(upper)) return { type: "MEDIUMINT", warnings };
  if (/\bINT\b/.test(upper)) return { type: "INT", warnings };

  if (/DOUBLE\s+PRECISION|\bDOUBLE\b|\bREAL\b|\bFLOAT\b/.test(upper)) return { type: "DOUBLE", warnings };
  if (/\bNUMERIC\b|\bDECIMAL\b/.test(upper)) return { type: `DECIMAL${suffix}`, warnings };

  if (/\bNVARCHAR\b|VARYING\s+CHARACTER|\bVARCHAR\b/.test(upper)) return { type: `VARCHAR${suffix || "(255)"}`, warnings };
  if (/NATIVE\s+CHARACTER|\bNCHAR\b|\bCHARACTER\b|\bCHAR\b/.test(upper)) return { type: `CHAR${suffix || "(1)"}`, warnings };
  if (/\bTINYTEXT\b/.test(upper)) return { type: "TINYTEXT", warnings };
  if (/\bMEDIUMTEXT\b/.test(upper)) return { type: "MEDIUMTEXT", warnings };
  if (/\bLONGTEXT\b/.test(upper)) return { type: "LONGTEXT", warnings };
  if (/\bTEXT\b|\bCLOB\b/.test(upper)) {
    const defaultKind = classifyTextDefault(context.defaultValue);
    if (defaultKind === "datetime") return { type: "DATETIME", warnings };
    if (defaultKind === "date") return { type: "DATE", warnings };
    if (defaultKind === "time") return { type: "TIME", warnings };

    const observed = Math.max(0, Number(context.maxLength || 0));
    if (context.indexed) {
      const length = Math.min(Math.max(observed, 191), 768);
      warnings.push(`${context.tableName}.${context.columnName}: TEXT indexado convertido para VARCHAR(${length}); reveja o limite da coluna após a migração.`);
      if (observed > 768) {
        warnings.push(`${context.tableName}.${context.columnName}: existem valores com ${observed} caracteres; VARCHAR(768) não é suficiente para preservar todos os dados.`);
      }
      return { type: `VARCHAR(${length})`, warnings };
    }
    return { type: "LONGTEXT", warnings };
  }

  if (/\bTINYBLOB\b/.test(upper)) return { type: "TINYBLOB", warnings };
  if (/\bMEDIUMBLOB\b/.test(upper)) return { type: "MEDIUMBLOB", warnings };
  if (/\bLONGBLOB\b/.test(upper)) return { type: "LONGBLOB", warnings };
  if (/\bBLOB\b/.test(upper)) return { type: "LONGBLOB", warnings };

  if (/\bTIMESTAMP\b/.test(upper)) return { type: "TIMESTAMP", warnings };
  if (/\bDATETIME\b/.test(upper)) return { type: "DATETIME", warnings };
  if (/\bDATE\b/.test(upper)) return { type: "DATE", warnings };
  if (/\bTIME\b/.test(upper)) return { type: "TIME", warnings };
  if (/\bJSON\b/.test(upper)) return { type: "JSON", warnings };
  if (/\bUUID\b/.test(upper)) return { type: "CHAR(36)", warnings };

  // SQLite affinity fallback, conservative but importable in MySQL.
  if (upper.includes("INT")) return { type: "BIGINT", warnings };
  if (/(CHAR|CLOB|TEXT)/.test(upper)) return { type: context.indexed ? "VARCHAR(255)" : "LONGTEXT", warnings };
  if (upper.includes("BLOB")) return { type: "LONGBLOB", warnings };
  if (/(REAL|FLOA|DOUB)/.test(upper)) return { type: "DOUBLE", warnings };

  warnings.push(`${context.tableName}.${context.columnName}: tipo personalizado “${raw}” convertido para DECIMAL(65,30).`);
  return { type: "DECIMAL(65,30)", warnings };
}

function classifyTextDefault(value) {
  if (value === null || value === undefined) return "none";
  const normalized = unwrapOuterParens(String(value).trim());
  if (/^datetime\s*\(\s*['"]now['"](?:\s*,[^)]*)?\s*\)$/i.test(normalized) || /^CURRENT_TIMESTAMP$/i.test(normalized)) return "datetime";
  if (/^date\s*\(\s*['"]now['"](?:\s*,[^)]*)?\s*\)$/i.test(normalized) || /^CURRENT_DATE$/i.test(normalized)) return "date";
  if (/^time\s*\(\s*['"]now['"](?:\s*,[^)]*)?\s*\)$/i.test(normalized) || /^CURRENT_TIME$/i.test(normalized)) return "time";
  if (isQuoted(normalized)) return "literal";
  return "other";
}

function translateDefault(value, mysqlType) {
  if (value === null || value === undefined) return { sql: null, warning: null };
  const raw = String(value).trim();
  if (!raw) return { sql: null, warning: null };

  const unwrapped = unwrapOuterParens(raw);
  const normalized = unwrapped.trim();
  if (/^NULL$/i.test(normalized)) return { sql: "DEFAULT NULL", warning: null };
  if (/^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(normalized)) {
    return { sql: `DEFAULT ${normalized.toUpperCase()}`, warning: null };
  }
  if (/^datetime\s*\(\s*['"]now['"](?:\s*,[^)]*)?\s*\)$/i.test(normalized)) {
    return { sql: "DEFAULT CURRENT_TIMESTAMP", warning: null };
  }
  if (/^date\s*\(\s*['"]now['"](?:\s*,[^)]*)?\s*\)$/i.test(normalized)) {
    return { sql: "DEFAULT CURRENT_DATE", warning: null };
  }
  if (/^time\s*\(\s*['"]now['"](?:\s*,[^)]*)?\s*\)$/i.test(normalized)) {
    return { sql: "DEFAULT CURRENT_TIME", warning: null };
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return { sql: `DEFAULT ${normalized}`, warning: null };
  }
  if (/^(?:TRUE|FALSE)$/i.test(normalized)) {
    return { sql: `DEFAULT ${/^TRUE$/i.test(normalized) ? 1 : 0}`, warning: null };
  }
  if (isQuoted(normalized)) {
    const text = decodeSqliteQuoted(normalized);
    const literal = sqlEscape(text, "mysql");
    if (/TEXT|BLOB|JSON/i.test(mysqlType)) {
      return {
        sql: `DEFAULT (${literal})`,
        warning: "DEFAULT em TEXT/BLOB usa sintaxe do MySQL 8.0.13+; confirme a versão do servidor.",
      };
    }
    return { sql: `DEFAULT ${literal}`, warning: null };
  }

  return { sql: null, warning: `DEFAULT SQLite “${raw}” foi omitido por não existir conversão MySQL segura.` };
}

function translateCollation(rawColumn) {
  if (/\bCOLLATE\s+BINARY\b/i.test(rawColumn)) return "COLLATE utf8mb4_bin";
  if (/\bCOLLATE\s+(?:NOCASE|RTRIM)\b/i.test(rawColumn)) return "COLLATE utf8mb4_unicode_ci";
  return null;
}

function translateFkAction(prefix, action, warnings, tableName, id) {
  const normalized = String(action ?? "NO ACTION").toUpperCase();
  if (["NO ACTION", "RESTRICT", "CASCADE", "SET NULL"].includes(normalized)) {
    return normalized === "NO ACTION" ? "" : ` ${prefix} ${normalized}`;
  }
  if (normalized === "SET DEFAULT") {
    warnings.push(`FK ${tableName}#${id}: ${prefix} SET DEFAULT foi omitido; MySQL não suporta esta ação.`);
  }
  return "";
}

function usableIndexColumns(idx, tableName, warnings) {
  if (!idx.columns.length) {
    warnings.push(`Índice ${idx.name} em ${tableName} foi ignorado por não possuir colunas utilizáveis.`);
    return null;
  }
  if (idx.columns.some((c) => Number(c.cid) < 0 || !c.name)) {
    warnings.push(`Índice por expressão ${idx.name} em ${tableName} foi ignorado; requer adaptação manual.`);
    return null;
  }
  return idx.columns;
}

function formatIndexColumns(columns) {
  return columns.map((c) => `${quoteIdent(c.name, "mysql")}${Number(c.desc) === 1 ? " DESC" : ""}`).join(", ");
}

function safeMaxLength(db, tableName, columnName, warnings) {
  try {
    return getColumnMaxLength(db, tableName, columnName);
  } catch (error) {
    warnings.push(`${tableName}.${columnName}: não foi possível medir o tamanho máximo (${error.message}).`);
    return 0;
  }
}

function hasIntegerAffinity(type) {
  return /INT/i.test(String(type ?? ""));
}

function safeObjectName(name) {
  const clean = String(name).replace(/[^A-Za-z0-9_$]/g, "_");
  if (clean.length <= 64) return clean;
  const hash = simpleHash(clean);
  return clean.slice(0, 55) + "_" + hash;
}

function simpleHash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function unwrapOuterParens(value) {
  let out = value.trim();
  while (out.startsWith("(") && out.endsWith(")") && matchingOuterParens(out)) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function matchingOuterParens(value) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const next = value[i + 1];
    if (quote) {
      if (ch === quote) {
        if (next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0 && i !== value.length - 1) return false;
    }
  }
  return depth === 0;
}

function isQuoted(value) {
  return (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'));
}

function decodeSqliteQuoted(value) {
  const quote = value[0];
  return value.slice(1, -1).replace(new RegExp(escapeRegex(quote + quote), "g"), quote);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

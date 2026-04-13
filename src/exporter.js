import fs from "node:fs";
import Database from "better-sqlite3";
import { listTables, getSchemaObjects, getTableColumns } from "./schema.js";
import { sqlEscape, quoteIdent } from "./escape.js";
import * as sqliteDialect from "./dialects/sqlite.js";
import * as mysqlDialect from "./dialects/mysql.js";

/**
 * Exports a SQLite database to a .sql file.
 *
 * @param {object} opts
 * @param {string}   opts.inputPath       - Path to the .sqlite/.db file
 * @param {string}   opts.outputPath      - Path for the generated .sql file
 * @param {'sqlite'|'mysql'} opts.dialect - SQL dialect for DDL transformation
 * @param {number}   opts.batchSize       - Rows per INSERT statement (default 500)
 * @param {boolean}  opts.exportData      - Whether to include INSERT data
 * @param {boolean}  opts.exportIndexes   - Whether to include CREATE INDEX
 * @param {boolean}  opts.exportViews     - Whether to include CREATE VIEW
 * @param {boolean}  opts.exportTriggers  - Whether to include CREATE TRIGGER
 * @param {boolean}  opts.onlyTables      - Skip indexes/views/triggers
 * @param {string[]|null} opts.onlyTableNames - Restrict to these table names
 */
export function exportSqliteToSql({
  inputPath,
  outputPath,
  dialect = "sqlite",
  batchSize = 500,
  exportData = true,
  exportIndexes = true,
  exportViews = true,
  exportTriggers = true,
  onlyTables = false,
  onlyTableNames = null,
}) {
  const db = new Database(inputPath, { readonly: true });
  const fd = fs.openSync(outputPath, "w");

  const d = dialect === "mysql" ? mysqlDialect : sqliteDialect;

  const writeln = (s = "") => fs.writeSync(fd, s + "\n");

  try {
    // ── Header ──────────────────────────────────────────────────────────────
    const hdr = d.header();
    if (hdr) {
      writeln(hdr);
      writeln();
    }

    // ── DDL (schema objects) ─────────────────────────────────────────────────
    const objects = getSchemaObjects(db, {
      exportIndexes,
      exportViews,
      exportTriggers,
      onlyTables,
    });

    // Build lookup set for table filter
    const tableSet =
      Array.isArray(onlyTableNames) && onlyTableNames.length
        ? new Set(onlyTableNames)
        : null;

    for (const obj of objects) {
      // Skip tables not in the filter list
      if (obj.type === "table" && tableSet && !tableSet.has(obj.name)) {
        continue;
      }
      // Skip indexes/triggers that belong to filtered-out tables
      if (
        (obj.type === "index" || obj.type === "trigger") &&
        tableSet &&
        obj.tbl_name &&
        !tableSet.has(obj.tbl_name)
      ) {
        continue;
      }

      const ddl = d.transformDDL(obj.sql);
      writeln(ddl + ";");
      writeln();
    }

    // ── Data (INSERT batches) ─────────────────────────────────────────────────
    if (exportData) {
      const tables = listTables(db, onlyTableNames);

      for (const tableName of tables) {
        const columns = getTableColumns(db, tableName);
        if (columns.length === 0) continue;

        const quotedTable = quoteIdent(tableName, dialect);
        const quotedCols = columns
          .map((c) => quoteIdent(c, dialect))
          .join(", ");

        // Use backtick-escaped table name for the SELECT statement
        const safeTable = "`" + tableName.replace(/`/g, "``") + "`";
        const stmt = db.prepare(`SELECT * FROM ${safeTable}`);

        let batch = [];

        const flushBatch = () => {
          if (batch.length === 0) return;
          const values = batch
            .map(
              (row) =>
                "  (" + columns.map((c) => sqlEscape(row[c], dialect)).join(", ") + ")"
            )
            .join(",\n");
          writeln(`INSERT INTO ${quotedTable} (${quotedCols}) VALUES`);
          writeln(values + ";");
          writeln();
          batch = [];
        };

        for (const row of stmt.iterate()) {
          batch.push(row);
          if (batch.length >= batchSize) {
            flushBatch();
          }
        }
        flushBatch();
      }
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const ftr = d.footer();
    if (ftr) writeln(ftr);
  } finally {
    fs.closeSync(fd);
    db.close();
  }
}

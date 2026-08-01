import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { listTables, getSchemaObjects, getTableColumns } from "./schema.js";
import { sqlEscape, quoteIdent } from "./escape.js";
import * as sqliteDialect from "./dialects/sqlite.js";
import * as mysqlDialect from "./dialects/mysql.js";

/**
 * Export a SQLite database to SQL.
 * Returns a conversion report containing warnings and counters.
 */
export function exportSqliteToSql({
  inputPath,
  outputPath,
  dialect = "mysql",
  batchSize = 500,
  exportData = true,
  exportIndexes = true,
  exportViews = true,
  exportTriggers = true,
  onlyTables = false,
  onlyTableNames = null,
  inspectTextLengths = true,
}) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize inválido: ${batchSize}`);
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error("O ficheiro de saída não pode substituir a base SQLite de entrada.");
  }

  const db = new Database(inputPath, { readonly: true, fileMustExist: true });
  const fd = fs.openSync(outputPath, "w");
  const report = {
    inputPath,
    outputPath,
    dialect,
    tables: 0,
    rows: 0,
    indexes: 0,
    skippedObjects: 0,
    warnings: [],
  };
  const writeln = (s = "") => fs.writeSync(fd, String(s) + "\n");

  let completed = false;
  try {
    if (dialect === "mysql") {
      writeln(mysqlDialect.header());
      writeln();
      exportMysqlSchema({
        db,
        writeln,
        report,
        exportIndexes,
        exportViews,
        exportTriggers,
        onlyTables,
        onlyTableNames,
        inspectTextLengths,
      });
    } else {
      writeln(sqliteDialect.header());
      writeln();
      exportSqliteSchema({
        db,
        writeln,
        exportIndexes,
        exportViews,
        exportTriggers,
        onlyTables,
        onlyTableNames,
      });
    }

    if (exportData) {
      exportRows({ db, writeln, report, dialect, batchSize, onlyTableNames });
    }

    if (dialect === "mysql") {
      if (report.warnings.length) {
        writeln("-- ============================================================");
        writeln(`-- RELATÓRIO: ${report.warnings.length} aviso(s)`);
        for (const warning of report.warnings) writeln(`-- AVISO: ${singleLine(warning)}`);
        writeln("-- ============================================================");
        writeln();
      }
      writeln(mysqlDialect.footer());
    } else {
      const footer = sqliteDialect.footer();
      if (footer) writeln(footer);
    }
    completed = true;
  } finally {
    fs.closeSync(fd);
    db.close();
    if (!completed) {
      try { fs.unlinkSync(outputPath); } catch {}
    }
  }

  return report;
}

function exportMysqlSchema({
  db,
  writeln,
  report,
  exportIndexes,
  exportViews,
  exportTriggers,
  onlyTables,
  onlyTableNames,
  inspectTextLengths,
}) {
  const tableNames = listTables(db, onlyTableNames);
  const indexQueue = [];

  for (const tableName of tableNames) {
    const built = mysqlDialect.buildTableDDL(db, tableName, { inspectTextLengths });
    report.tables++;
    report.warnings.push(...built.warnings);
    writeln(built.sql + ";");
    writeln();
    indexQueue.push({ tableName, indexes: built.indexes });
  }

  if (!onlyTables && exportIndexes) {
    for (const item of indexQueue) {
      const built = mysqlDialect.buildIndexDDLs(item.tableName, item.indexes);
      report.warnings.push(...built.warnings);
      for (const statement of built.statements) {
        writeln(statement + ";");
        writeln();
        report.indexes++;
      }
    }
  }

  // Views and triggers are not copied as executable SQL in safe mode because a
  // syntactically valid SQLite object can silently change semantics in MySQL.
  if (!onlyTables && (exportViews || exportTriggers)) {
    const objects = getSchemaObjects(db, {
      exportIndexes: false,
      exportViews,
      exportTriggers,
      onlyTables: false,
    }).filter((obj) => obj.type === "view" || obj.type === "trigger");

    for (const obj of objects) {
      if (Array.isArray(onlyTableNames) && onlyTableNames.length && obj.tbl_name && !onlyTableNames.includes(obj.tbl_name)) {
        continue;
      }
      report.skippedObjects++;
      report.warnings.push(`${obj.type} ${obj.name} foi incluído apenas como comentário para revisão manual.`);
      writeln(mysqlDialect.commentUnsupportedObject(obj));
      writeln();
    }
  }
}

function exportSqliteSchema({
  db,
  writeln,
  exportIndexes,
  exportViews,
  exportTriggers,
  onlyTables,
  onlyTableNames,
}) {
  const tableSet = Array.isArray(onlyTableNames) && onlyTableNames.length ? new Set(onlyTableNames) : null;
  const objects = getSchemaObjects(db, { exportIndexes, exportViews, exportTriggers, onlyTables });

  for (const obj of objects) {
    if (obj.type === "table" && tableSet && !tableSet.has(obj.name)) continue;
    if ((obj.type === "index" || obj.type === "trigger") && tableSet && obj.tbl_name && !tableSet.has(obj.tbl_name)) continue;
    // Views cannot be reliably dependency-filtered from sqlite_master alone.
    if (obj.type === "view" && tableSet) continue;
    writeln(sqliteDialect.transformDDL(obj.sql) + ";");
    writeln();
  }
}

function exportRows({ db, writeln, report, dialect, batchSize, onlyTableNames }) {
  const tables = listTables(db, onlyTableNames);

  for (const tableName of tables) {
    const columns = getTableColumns(db, tableName);
    if (columns.length === 0) continue;

    const quotedTable = quoteIdent(tableName, dialect);
    const quotedCols = columns.map((c) => quoteIdent(c, dialect)).join(", ");
    const safeTable = quoteIdent(tableName, "sqlite");
    const stmt = db.prepare(`SELECT * FROM ${safeTable}`).safeIntegers(true);
    let batch = [];

    const flushBatch = () => {
      if (!batch.length) return;
      const values = batch.map((row) =>
        "  (" + columns.map((c) => sqlEscape(row[c], dialect)).join(", ") + ")"
      ).join(",\n");
      writeln(`INSERT INTO ${quotedTable} (${quotedCols}) VALUES`);
      writeln(values + ";");
      writeln();
      report.rows += batch.length;
      batch = [];
    };

    for (const row of stmt.iterate()) {
      batch.push(row);
      if (batch.length >= batchSize) flushBatch();
    }
    flushBatch();
  }
}

function singleLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

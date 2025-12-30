#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { exportSqliteToSql } from "../src/exporter.js";

function printHelp() {
  console.log(`
sqlite-to-sql - export SQLite .sqlite/.db to .sql

Usage:
  sqlite-to-sql -i <input.sqlite> -o <output.sql> [options]

Options:
  -i, --input <path>          Input SQLite file (.sqlite/.db) (required)
  -o, --output <path>         Output SQL file (.sql) (required)
  --dialect <sqlite|mysql>    SQL dialect for schema conversion (default: sqlite)
  --batch <n>                 Rows per INSERT batch (default: 500)

  --no-data                   Export schema only (no INSERTs)
  --only-tables               Export only tables (+ data if enabled); ignore indexes/views/triggers
  --no-indexes                Do not export indexes
  --no-views                  Do not export views
  --no-triggers               Do not export triggers

  --tables <t1,t2,...>        Export only these tables (comma-separated)

  -h, --help                  Show help

Examples:
  sqlite-to-sql -i ./base.sqlite -o ./base.sqlite.sql
  sqlite-to-sql -i ./base.sqlite -o ./base.mysql.sql --dialect mysql
  sqlite-to-sql -i ./base.sqlite -o ./base.mysql.sql --dialect mysql --batch 1000
  sqlite-to-sql -i ./base.sqlite -o ./out.sql --tables users,orders
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    dialect: "sqlite",
    batch: 500,
    data: true,
    onlyTables: false,
    indexes: true,
    views: true,
    triggers: true,
    tables: null,
  };

  const takeValue = (i) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("-"))
      throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];

    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }

    if (a === "-i" || a === "--input") {
      args.input = takeValue(i);
      i++;
      continue;
    }

    if (a === "-o" || a === "--output") {
      args.output = takeValue(i);
      i++;
      continue;
    }

    if (a === "--dialect") {
      args.dialect = takeValue(i);
      i++;
      continue;
    }

    if (a === "--batch") {
      args.batch = Number(takeValue(i));
      i++;
      continue;
    }

    if (a === "--no-data") {
      args.data = false;
      continue;
    }

    if (a === "--only-tables") {
      args.onlyTables = true;
      continue;
    }

    if (a === "--no-indexes") {
      args.indexes = false;
      continue;
    }

    if (a === "--no-views") {
      args.views = false;
      continue;
    }

    if (a === "--no-triggers") {
      args.triggers = false;
      continue;
    }

    if (a === "--tables") {
      const raw = takeValue(i);
      args.tables = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
      continue;
    }

    throw new Error(`Unknown argument: ${a}`);
  }

  return args;
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

(async function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.help) {
      printHelp();
      process.exit(0);
    }

    if (!args.input || !args.output) {
      printHelp();
      process.exit(1);
    }

    if (!fs.existsSync(args.input)) {
      throw new Error(`Input file not found: ${args.input}`);
    }

    if (!Number.isFinite(args.batch) || args.batch <= 0) {
      throw new Error(`Invalid --batch value: ${args.batch}`);
    }

    if (!["sqlite", "mysql"].includes(args.dialect)) {
      throw new Error(
        `Invalid --dialect: ${args.dialect}. Use sqlite or mysql.`
      );
    }

    ensureDirForFile(args.output);

    exportSqliteToSql({
      inputPath: args.input,
      outputPath: args.output,
      dialect: args.dialect,
      batchSize: args.batch,
      exportData: args.data,
      exportIndexes: args.onlyTables ? false : args.indexes,
      exportViews: args.onlyTables ? false : args.views,
      exportTriggers: args.onlyTables ? false : args.triggers,
      onlyTables: args.onlyTables,
      onlyTableNames: args.tables,
    });

    console.log(`Done. SQL written to: ${args.output}`);
  } catch (err) {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
  }
})();

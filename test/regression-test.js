#!/usr/bin/env node
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exportSqliteToSql } from "../src/exporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-to-mysql-v2-"));
const dbPath = path.join(temp, "dangerous.sqlite");
const outPath = path.join(temp, "dangerous.mysql.sql");
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else { console.error(`  ✗ ${message}`); failed++; }
}
function contains(text, value, message) { assert(text.includes(value), message); }
function notContains(text, value, message) { assert(!text.includes(value), message); }

try {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE "text" (
      "integer" INTEGER PRIMARY KEY,
      "real" TEXT,
      "strict" TEXT,
      kind TEXT CHECK(kind IN ('TEXT', 'REAL', 'BLOB'))
    );

    CREATE TABLE defaults (id INTEGER PRIMARY KEY, active BOOLEAN DEFAULT 1, note TEXT NOT NULL, score REAL DEFAULT 2.5);

    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX idx_active_email ON users(email) WHERE deleted_at IS NULL;

    CREATE TABLE "order" (
      "group" INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      description TEXT DEFAULT 'new'
    );
  `);
  db.prepare('INSERT INTO "text" ("integer", "real", "strict", kind) VALUES (?, ?, ?, ?)')
    .run(9007199254740993n, "TEXT", "STRICT", "REAL");
  db.prepare("INSERT INTO defaults VALUES (?, ?, ?, ?)").run(1, 1, "hello", 2.5);
  db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(1, "same@example.com", "2026-01-01");
  db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(2, "same@example.com", "2026-01-02");
  db.prepare('INSERT INTO "order" VALUES (?, ?, ?)').run(1, 1, "new");
  db.close();

  const report = exportSqliteToSql({ inputPath: dbPath, outputPath: outPath, dialect: "mysql" });
  const sql = fs.readFileSync(outPath, "utf8");

  console.log("\n--- Regression safety tests ---");
  contains(sql, "CREATE TABLE `text`", "reserved/type-like table name is preserved");
  contains(sql, "`integer` BIGINT PRIMARY KEY", "type-like column name is preserved");
  contains(sql, "`real` LONGTEXT", "real column name is not rewritten");
  contains(sql, "`strict` LONGTEXT", "strict column name is not removed");
  notContains(sql, "CREATE TABLE `LONGTEXT`", "table identifier is never converted as a type");
  contains(sql, "CHECK (`kind` IN ('TEXT', 'REAL', 'BLOB'))", "CHECK string values remain unchanged");
  contains(sql, "9007199254740993", "64-bit integer is exported without precision loss");
  notContains(sql, "9007199254740992", "rounded JavaScript integer is not emitted");
  contains(sql, "`active` TINYINT(1) DEFAULT 1", "one-line BOOLEAN default is preserved");
  contains(sql, "`score` DOUBLE DEFAULT 2.5", "one-line REAL default is preserved");
  contains(sql, "CREATE TABLE `order`", "MySQL reserved table name is quoted");
  contains(sql, "`group` BIGINT PRIMARY KEY", "MySQL reserved column name is quoted");
  contains(sql, "CONSTRAINT `fk_order_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)", "foreign key is reconstructed from PRAGMA");
  notContains(sql, "CREATE UNIQUE INDEX `idx_active_email`", "partial unique index is not broadened");
  assert(report.warnings.some((w) => w.includes("UNIQUE parcial idx_active_email")), "partial unique index produces a report warning");

  const automaticDir = path.join(temp, "automatic");
  fs.mkdirSync(automaticDir);
  const automaticDb = path.join(automaticDir, "copy.db");
  fs.copyFileSync(dbPath, automaticDb);
  const cli = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "sqlite-to-sql.js"), automaticDb], {
    encoding: "utf8",
  });
  assert(cli.status === 0, "automatic CLI conversion exits successfully");
  assert(fs.existsSync(path.join(automaticDir, "copy.mysql.sql")), "automatic CLI chooses the output filename");
  assert(fs.existsSync(path.join(automaticDir, "copy.mysql.sql.report.json")), "automatic CLI creates a JSON report");

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

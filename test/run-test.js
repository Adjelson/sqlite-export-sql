#!/usr/bin/env node
/**
 * Integration test for sqlite-to-sql.
 * Covers: basic types, all extended SQLite type aliases, DDL quirks,
 *         backslash escaping per dialect, generated columns, partial indexes,
 *         STRICT tables, and all filter flags.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportSqliteToSql } from "../src/exporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH    = path.join(__dirname, "_test.sqlite");
const OUT_SQLITE = path.join(__dirname, "_out.sqlite.sql");
const OUT_MYSQL  = path.join(__dirname, "_out.mysql.sql");

// ── Assertion helpers ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

const assertContains    = (text, sub, msg) => assert(text.includes(sub),  msg ?? `contains: ${sub}`);
const assertNotContains = (text, sub, msg) => assert(!text.includes(sub), msg ?? `does NOT contain: ${sub}`);

// ── Build test database ──────────────────────────────────────────────────────

function buildTestDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);

  db.exec(`
    -- ── Basic types + BLOB + CLOB + BOOLEAN ──────────────────────────────────
    CREATE TABLE users (
      id         INTEGER   PRIMARY KEY AUTOINCREMENT,
      name       TEXT      NOT NULL,
      email      TEXT      UNIQUE,
      age        INTEGER,
      score      REAL,
      active     BOOLEAN   DEFAULT 1,
      avatar     BLOB,
      bio        CLOB,
      created_at DATETIME  DEFAULT CURRENT_TIMESTAMP
    );

    -- ── FK references ─────────────────────────────────────────────────────────
    CREATE TABLE posts (
      id         INTEGER   PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER   NOT NULL REFERENCES users(id),
      title      TEXT      NOT NULL,
      body       TEXT,
      created_at DATETIME  DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Extended type aliases + DDL quirks ────────────────────────────────────
    --   Tests: VARCHAR, NVARCHAR, VARYING CHARACTER, NATIVE CHARACTER, CHARACTER,
    --          INT2, INT8, NUMERIC, DOUBLE PRECISION,
    --          COLLATE NOCASE, ON CONFLICT IGNORE
    CREATE TABLE products (
      id       INTEGER          PRIMARY KEY AUTOINCREMENT,
      sku      VARCHAR(50)      NOT NULL UNIQUE ON CONFLICT IGNORE,
      name     NVARCHAR(200)    NOT NULL COLLATE NOCASE,
      code     INT2             NOT NULL,
      ext_id   INT8,
      price    NUMERIC(10,2),
      weight   DOUBLE PRECISION,
      category VARYING CHARACTER(100),
      abbrev   NATIVE CHARACTER(5),
      fixed    CHARACTER(3),
      active   BOOLEAN          DEFAULT 1
    );

    -- ── Generated columns (STORED + VIRTUAL) ─────────────────────────────────
    CREATE TABLE inventory (
      id       INTEGER  PRIMARY KEY AUTOINCREMENT,
      qty      INTEGER  NOT NULL DEFAULT 0,
      price    REAL     NOT NULL DEFAULT 0,
      subtotal REAL     GENERATED ALWAYS AS (qty * price) STORED,
      label    TEXT     GENERATED ALWAYS AS ('item-' || id) VIRTUAL
    );

    -- ── STRICT modifier (SQLite 3.37+) ───────────────────────────────────────
    CREATE TABLE logs (
      id    INTEGER PRIMARY KEY,
      msg   TEXT    NOT NULL,
      level INTEGER DEFAULT 0
    ) STRICT;

    -- ── Indexes ───────────────────────────────────────────────────────────────
    CREATE UNIQUE INDEX idx_users_email     ON users(email);
    CREATE INDEX        idx_posts_user      ON posts(user_id);
    CREATE INDEX        idx_products_active ON products(sku) WHERE active = 1;

    -- ── View ──────────────────────────────────────────────────────────────────
    CREATE VIEW active_users AS
      SELECT id, name, email FROM users WHERE active = 1;

    -- ── Trigger ───────────────────────────────────────────────────────────────
    CREATE TRIGGER trg_update_user
      AFTER UPDATE ON users FOR EACH ROW
      BEGIN SELECT 1; END;
  `);

  // ── Seed data ───────────────────────────────────────────────────────────────

  const insUser = db.prepare(
    `INSERT INTO users (name, email, age, score, active, avatar, bio) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insUser.run("Alice",    "alice@example.com",  30, 9.5,  1, Buffer.from("imgdata"), "Alice's bio");
  insUser.run("Bob",      "bob@example.com",    25, 7.2,  1, null, null);
  insUser.run("Charlie",  null,                 35, null, 0, null, "Line1\nLine2");
  // Row with backslash — key test for dialect-specific escaping
  insUser.run("D'arte",   "darte@example.com",  28, 5.0,  1, null, "C:\\path\\file");

  const insPost = db.prepare(
    `INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)`
  );
  insPost.run(1, "Hello World",    "First post");
  insPost.run(1, "Second post",    "Post with 'single' quotes");
  insPost.run(2, "Bob's thoughts", null);

  const insProd = db.prepare(
    `INSERT INTO products (sku, name, code, ext_id, price, weight, category, abbrev, fixed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insProd.run("SKU001", "Widget",          1, 1000000000, "9.99",  0.5,  "Electronics", "ELEC", "EL");
  insProd.run("SKU002", "O'Brien Special", 2, null,       null,    null, null,           null,  null);

  const insInv = db.prepare(
    `INSERT INTO inventory (qty, price) VALUES (?, ?)`
  );
  insInv.run(10, 2.5);
  insInv.run(5,  4.0);

  const insLog = db.prepare(`INSERT INTO logs (msg, level) VALUES (?, ?)`);
  insLog.run("Application started", 0);
  insLog.run("Error occurred",      2);

  db.close();
  console.log(`[setup] Test DB created: ${DB_PATH}`);
}

// ── Run exports ──────────────────────────────────────────────────────────────

function runExports() {
  exportSqliteToSql({
    inputPath: DB_PATH, outputPath: OUT_SQLITE,
    dialect: "sqlite", batchSize: 500,
    exportData: true, exportIndexes: true, exportViews: true, exportTriggers: true,
    onlyTables: false, onlyTableNames: null,
  });

  exportSqliteToSql({
    inputPath: DB_PATH, outputPath: OUT_MYSQL,
    dialect: "mysql", batchSize: 2,   // small batch to test batching
    exportData: true, exportIndexes: true, exportViews: true, exportTriggers: true,
    onlyTables: false, onlyTableNames: null,
  });

  console.log(`[export] SQLite → ${OUT_SQLITE}`);
  console.log(`[export] MySQL  → ${OUT_MYSQL}`);
}

// ── Assertions ───────────────────────────────────────────────────────────────

function validateSqliteOutput(sql) {
  console.log("\n--- SQLite dialect ---");

  assert(sql.length > 0, "output is not empty");
  assertContains(sql, "CREATE TABLE",                    "has CREATE TABLE");
  assertContains(sql, "CREATE UNIQUE INDEX idx_users_email", "has unique index");
  assertContains(sql, "CREATE INDEX idx_posts_user",     "has regular index");
  assertContains(sql, "CREATE VIEW active_users",        "has view");
  assertContains(sql, "CREATE TRIGGER trg_update_user",  "has trigger");
  assertContains(sql, "INSERT INTO `users`",             "has INSERT for users");
  assertContains(sql, "INSERT INTO `posts`",             "has INSERT for posts");
  assertContains(sql, "INSERT INTO `products`",          "has INSERT for products");
  assertContains(sql, "INSERT INTO `logs`",              "has INSERT for logs");

  // Escaping
  assertContains(sql, "D''arte",           "single quote in name escaped (SQLite)");
  assertContains(sql, "'C:\\path\\file'",  "backslash NOT doubled in SQLite dialect");
  assertNotContains(sql, "'C:\\\\path\\\\file'", "no double-backslash in SQLite output");
  assertContains(sql, "X'",               "BLOB is hex-encoded");
  assertContains(sql, "NULL",             "NULL values present");

  // Dialect: no MySQL-specific additions
  assertNotContains(sql, "FOREIGN_KEY_CHECKS", "no MySQL header");
  assertNotContains(sql, "ENGINE=InnoDB",      "no ENGINE=InnoDB");

  // Generated columns: subtotal/label should NOT appear in INSERT
  assertNotContains(sql, "`subtotal`", "generated STORED column excluded from INSERT");
  assertNotContains(sql, "`label`",    "generated VIRTUAL column excluded from INSERT");
}

function validateMysqlOutput(sql) {
  console.log("\n--- MySQL dialect ---");

  assert(sql.length > 0, "output is not empty");
  assertContains(sql, "SET FOREIGN_KEY_CHECKS = 0;", "has FOREIGN_KEY_CHECKS=0");
  assertContains(sql, "SET FOREIGN_KEY_CHECKS = 1;", "has FOREIGN_KEY_CHECKS=1");
  assertContains(sql, "SET NAMES utf8mb4;",           "has SET NAMES utf8mb4");

  // ── Core type conversions ──
  assertContains(sql, "ENGINE=InnoDB",           "CREATE TABLE has ENGINE=InnoDB");
  assertContains(sql, "utf8mb4_unicode_ci",       "CREATE TABLE has utf8mb4 charset");
  assertContains(sql, "AUTO_INCREMENT",           "AUTOINCREMENT → AUTO_INCREMENT");
  assertNotContains(sql, "AUTOINCREMENT",         "no leftover AUTOINCREMENT");

  // TEXT / BLOB / REAL
  assertContains(sql, "LONGTEXT",                 "TEXT → LONGTEXT");
  assertContains(sql, "DOUBLE",                   "REAL → DOUBLE");
  assertContains(sql, "LONGBLOB",                 "BLOB → LONGBLOB");
  assertContains(sql, "TINYINT(1)",               "BOOLEAN → TINYINT(1)");
  assertNotContains(sql, " TEXT ",                "no bare TEXT column type");
  assertNotContains(sql, " REAL ",                "no bare REAL column type");
  assertNotContains(sql, " BLOB ",                "no bare BLOB column type");
  assertNotContains(sql, " BOOLEAN ",             "no bare BOOLEAN column type");

  // ── Extended type conversions ──
  assertContains(sql, "SMALLINT",                 "INT2 → SMALLINT");
  assertContains(sql, "BIGINT",                   "INT8 → BIGINT");
  assertContains(sql, "DECIMAL",                  "NUMERIC → DECIMAL");
  // DOUBLE PRECISION → DOUBLE (DOUBLE is already in the output; check no DOUBLE PRECISION remains)
  assertNotContains(sql, "DOUBLE PRECISION",      "no leftover DOUBLE PRECISION");
  // VARCHAR preserved (not converted to LONGTEXT)
  assertContains(sql, "VARCHAR(50)",              "VARCHAR(n) preserved");
  // NVARCHAR → VARCHAR
  assertContains(sql, "VARCHAR(200)",             "NVARCHAR → VARCHAR");
  assertNotContains(sql, "NVARCHAR",              "no leftover NVARCHAR");
  // VARYING CHARACTER → VARCHAR
  assertContains(sql, "VARCHAR(100)",             "VARYING CHARACTER → VARCHAR");
  // NATIVE CHARACTER → CHAR
  assertContains(sql, "CHAR(5)",                  "NATIVE CHARACTER → CHAR");
  // CHARACTER → CHAR
  assertContains(sql, "CHAR(3)",                  "CHARACTER → CHAR");
  assertNotContains(sql, "NCHAR",                 "no leftover NCHAR");

  // ── DDL cleanup ──
  assertNotContains(sql, "ON CONFLICT",           "ON CONFLICT removed");
  // COLLATE NOCASE removed from DDL lines (comments may mention it; ignore those)
  const ddlLines = sql.split("\n").filter((l) => !l.trimStart().startsWith("--"));
  assert(
    !ddlLines.some((l) => /COLLATE\s+NOCASE/i.test(l)),
    "COLLATE NOCASE removed from all DDL lines"
  );
  assertNotContains(sql, "STRICT",                "STRICT modifier removed");

  // Partial index: DDL present but WHERE clause removed from CREATE INDEX line
  const idxLine = sql.match(/^CREATE.*INDEX.*idx_products_active.*/m)?.[0] ?? "";
  assertContains(sql,     "idx_products_active",  "partial index DDL present");
  assert(!idxLine.includes("WHERE"),              "partial index WHERE clause removed from CREATE INDEX");

  // ── Data ──
  assertContains(sql, "INSERT INTO `users`",      "has INSERT for users");
  assertContains(sql, "INSERT INTO `products`",   "has INSERT for products");
  assertContains(sql, "INSERT INTO `logs`",       "has INSERT for logs");

  // Batching: batchSize=2, users has 4 rows → at least 2 INSERT blocks
  const insertUserCount = (sql.match(/^INSERT INTO `users`/gm) ?? []).length;
  assert(insertUserCount >= 2, `users split into ≥2 INSERT batches (got ${insertUserCount})`);

  // ── Escaping ──
  assertContains(sql, "D''arte",                  "single quote escaped in MySQL output");
  assertContains(sql, "'C:\\\\path\\\\file'",     "backslash doubled in MySQL dialect");
  assertNotContains(sql, "'C:\\path\\file'",      "no single-backslash in MySQL output (would corrupt data)");
  assertContains(sql, "X'",                       "BLOB hex-encoded");

  // Generated columns excluded from INSERT
  assertNotContains(sql, "`subtotal`",            "generated STORED col excluded from INSERT");
  assertNotContains(sql, "`label`",               "generated VIRTUAL col excluded from INSERT");
}

function validateFilteredExport() {
  console.log("\n--- --tables filter ---");
  const out = path.join(__dirname, "_out.filtered.sql");

  exportSqliteToSql({
    inputPath: DB_PATH, outputPath: out,
    dialect: "mysql", batchSize: 500,
    exportData: true, exportIndexes: true, exportViews: true, exportTriggers: true,
    onlyTables: false, onlyTableNames: ["users"],
  });

  const sql = fs.readFileSync(out, "utf8");
  assertContains(sql,    "`users`",             "filtered output has users");
  assertNotContains(sql, "`posts`",             "filtered output excludes posts table");
  assertContains(sql,    "INSERT INTO `users`", "filtered output has INSERT for users");
  assertNotContains(sql, "INSERT INTO `posts`", "filtered output excludes INSERT for posts");
  assertContains(sql,    "idx_users_email",     "users index included");
  assertNotContains(sql, "idx_posts_user",      "posts index excluded");

  fs.unlinkSync(out);
}

function validateNoDataExport() {
  console.log("\n--- --no-data ---");
  const out = path.join(__dirname, "_out.schema.sql");

  exportSqliteToSql({
    inputPath: DB_PATH, outputPath: out,
    dialect: "sqlite", batchSize: 500,
    exportData: false, exportIndexes: true, exportViews: true, exportTriggers: true,
    onlyTables: false, onlyTableNames: null,
  });

  const sql = fs.readFileSync(out, "utf8");
  assertContains(sql,    "CREATE TABLE",  "schema output has CREATE TABLE");
  assertNotContains(sql, "INSERT INTO",   "schema output has no INSERT");

  fs.unlinkSync(out);
}

function validateOnlyTablesFlag() {
  console.log("\n--- --only-tables ---");
  const out = path.join(__dirname, "_out.onlytables.sql");

  exportSqliteToSql({
    inputPath: DB_PATH, outputPath: out,
    dialect: "sqlite", batchSize: 500,
    exportData: true, exportIndexes: false, exportViews: false, exportTriggers: false,
    onlyTables: true, onlyTableNames: null,
  });

  const sql = fs.readFileSync(out, "utf8");
  assertContains(sql,    "CREATE TABLE",   "only-tables output has CREATE TABLE");
  assertNotContains(sql, "CREATE INDEX",   "only-tables output has no CREATE INDEX");
  assertNotContains(sql, "CREATE VIEW",    "only-tables output has no CREATE VIEW");
  assertNotContains(sql, "CREATE TRIGGER", "only-tables output has no CREATE TRIGGER");

  fs.unlinkSync(out);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function cleanup() {
  [DB_PATH, OUT_SQLITE, OUT_MYSQL].forEach((f) => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

try {
  buildTestDb();
  runExports();

  const sqliteSql = fs.readFileSync(OUT_SQLITE, "utf8");
  const mysqlSql  = fs.readFileSync(OUT_MYSQL,  "utf8");

  validateSqliteOutput(sqliteSql);
  validateMysqlOutput(mysqlSql);
  validateFilteredExport();
  validateNoDataExport();
  validateOnlyTablesFlag();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED.`);
    process.exit(1);
  } else {
    console.log("\nAll tests passed.");
  }
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
} finally {
  cleanup();
}

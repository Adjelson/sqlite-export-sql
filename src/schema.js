export function listTables(db, onlyTableNames = null) {
  const all = db
    .prepare(
      `
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `
    )
    .all()
    .map((r) => r.name);

  if (Array.isArray(onlyTableNames) && onlyTableNames.length) {
    const set = new Set(onlyTableNames);
    return all.filter((t) => set.has(t));
  }

  return all;
}

export function getSchemaObjects(
  db,
  { exportIndexes, exportViews, exportTriggers, onlyTables }
) {
  // exporta DDL na ordem: tables -> indexes -> views -> triggers
  // Nota: triggers/views podem depender de tables.
  const rows = db
    .prepare(
      `
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
  `
    )
    .all();

  const want = new Set(["table"]);
  if (!onlyTables && exportIndexes) want.add("index");
  if (!onlyTables && exportViews) want.add("view");
  if (!onlyTables && exportTriggers) want.add("trigger");

  const filtered = rows.filter((r) => want.has(r.type));

  const order = (t) => {
    switch (t) {
      case "table":
        return 1;
      case "index":
        return 2;
      case "view":
        return 3;
      case "trigger":
        return 4;
      default:
        return 9;
    }
  };

  filtered.sort((a, b) => {
    const oa = order(a.type);
    const ob = order(b.type);
    if (oa !== ob) return oa - ob;
    return String(a.name).localeCompare(String(b.name));
  });

  return filtered;
}

export function getTableColumns(db, tableName) {
  // PRAGMA table_info retorna: cid, name, type, notnull, dflt_value, pk
  const info = db
    .prepare(`PRAGMA table_info(${wrapSQLiteIdent(tableName)})`)
    .all();
  return info.map((c) => c.name);
}

// Para PRAGMA e SELECT no SQLite, manter identificadores seguros.
function wrapSQLiteIdent(name) {
  // SQLite aceita ``, " e []
  return "`" + String(name).replace(/`/g, "``") + "`";
}

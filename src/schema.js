export function listTables(db, onlyTableNames = null) {
  const all = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((r) => r.name);

  if (Array.isArray(onlyTableNames) && onlyTableNames.length) {
    const set = new Set(onlyTableNames);
    return all.filter((t) => set.has(t));
  }
  return all;
}

export function getSchemaObjects(db, { exportIndexes, exportViews, exportTriggers, onlyTables }) {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
  `).all();

  const want = new Set(["table"]);
  if (!onlyTables && exportIndexes) want.add("index");
  if (!onlyTables && exportViews) want.add("view");
  if (!onlyTables && exportTriggers) want.add("trigger");
  const order = { table: 1, index: 2, view: 3, trigger: 4 };
  return rows.filter((r) => want.has(r.type)).sort((a, b) =>
    (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.name).localeCompare(String(b.name))
  );
}

export function getTableColumns(db, tableName) {
  return getTableInfo(db, tableName).filter((c) => Number(c.hidden ?? 0) === 0).map((c) => c.name);
}

export function getTableInfo(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_xinfo(${wrapSQLiteIdent(tableName)})`).all();
  } catch {
    return db.prepare(`PRAGMA table_info(${wrapSQLiteIdent(tableName)})`).all().map((c) => ({ ...c, hidden: 0 }));
  }
}

export function getTableSql(db, tableName) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName)?.sql ?? "";
}

export function getForeignKeys(db, tableName) {
  const rows = db.prepare(`PRAGMA foreign_key_list(${wrapSQLiteIdent(tableName)})`).all();
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([id, items]) => ({
    id,
    table: items[0].table,
    from: items.sort((a, b) => Number(a.seq) - Number(b.seq)).map((r) => r.from),
    to: items.sort((a, b) => Number(a.seq) - Number(b.seq)).map((r) => r.to),
    onUpdate: items[0].on_update,
    onDelete: items[0].on_delete,
    match: items[0].match,
  }));
}

export function getIndexes(db, tableName) {
  const list = db.prepare(`PRAGMA index_list(${wrapSQLiteIdent(tableName)})`).all();
  return list.map((idx) => {
    const name = idx.name;
    const columns = db.prepare(`PRAGMA index_xinfo(${wrapSQLiteIdent(name)})`).all()
      .filter((c) => Number(c.key ?? 1) === 1)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno));
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql ?? null;
    return {
      name,
      unique: Number(idx.unique) === 1,
      origin: idx.origin,
      partial: Number(idx.partial) === 1,
      columns,
      sql,
    };
  });
}

export function getColumnMaxLength(db, tableName, columnName) {
  const table = wrapSQLiteIdent(tableName);
  const col = wrapSQLiteIdent(columnName);
  const row = db.prepare(`SELECT MAX(LENGTH(${col})) AS max_len FROM ${table}`).get();
  const value = row?.max_len;
  return value == null ? 0 : Number(value);
}

export function wrapSQLiteIdent(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

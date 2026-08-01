export function transformDDL(sql) {
  // Dialeto sqlite: não altera nada
  return sql;
}

export function header() {
  return [
    "-- Dialect: sqlite",
    "-- Notes: SQL is close to SQLite syntax. Importing into other DBs may require conversion.",
    "",
  ].join("\n");
}

export function footer() {
  return "";
}

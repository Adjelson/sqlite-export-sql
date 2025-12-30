export function sqlEscape(value) {
  if (value === null || value === undefined) return "NULL";

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  // Buffer (BLOB)
  if (Buffer.isBuffer(value)) {
    return "X'" + value.toString("hex") + "'";
  }

  // Date -> ISO string (seguro e portátil)
  if (value instanceof Date) {
    return "'" + value.toISOString().replace(/'/g, "''") + "'";
  }

  // string
  const s = String(value);
  // Escape de backslash e aspas simples (compatível com SQL padrão e MySQL)
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

export function quoteIdent(name, dialect = "sqlite") {
  // Para MySQL usamos ``, para sqlite podemos usar " ou `; aqui padronizamos em `
  const q = "`";
  return q + String(name).replace(/`/g, "``") + q;
}

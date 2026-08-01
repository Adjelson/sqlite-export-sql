/**
 * Small SQLite DDL parser helpers.
 * It intentionally parses only the outer CREATE TABLE structure; expressions
 * are preserved and translated conservatively instead of running global regexes.
 */

export function parseCreateTable(sql) {
  if (!sql) return { columns: new Map(), constraints: [], body: "" };
  const body = extractOuterParenthesized(sql);
  if (body == null) return { columns: new Map(), constraints: [], body: "" };

  const columns = new Map();
  const constraints = [];

  for (const part of splitTopLevel(body, ",")) {
    const segment = part.trim();
    if (!segment) continue;

    if (/^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|CHECK\b|FOREIGN\s+KEY\b)/i.test(segment)) {
      constraints.push(segment);
      continue;
    }

    const parsed = readIdentifier(segment);
    if (!parsed) {
      constraints.push(segment);
      continue;
    }
    columns.set(parsed.name, { raw: segment, rest: parsed.rest });
  }

  return { columns, constraints, body };
}

export function extractCheckExpressions(segment) {
  const result = [];
  let i = 0;
  while (i < segment.length) {
    const found = findKeywordOutsideQuotes(segment, "CHECK", i);
    if (found < 0) break;
    let p = found + 5;
    while (/\s/.test(segment[p] ?? "")) p++;
    if (segment[p] !== "(") {
      i = p;
      continue;
    }
    const end = findMatchingParen(segment, p);
    if (end < 0) break;
    result.push(segment.slice(p + 1, end).trim());
    i = end + 1;
  }
  return result;
}

export function extractGeneratedClause(segment) {
  const match = /\b(?:GENERATED\s+ALWAYS\s+)?AS\s*\(/i.exec(maskQuotedText(segment));
  if (!match) return null;
  const open = segment.indexOf("(", match.index);
  if (open < 0) return null;
  const close = findMatchingParen(segment, open);
  if (close < 0) return null;
  const tail = segment.slice(close + 1);
  const storage = /\bSTORED\b/i.test(tail) ? "STORED" : "VIRTUAL";
  return { expression: segment.slice(open + 1, close).trim(), storage };
}

export function translateMysqlExpression(expression, knownIdentifiers = []) {
  let out = replaceDoubleQuotedIdentifiers(expression);
  out = quoteKnownIdentifiers(out, knownIdentifiers);
  out = translateConcat(out, knownIdentifiers);
  return out.trim();
}

export function splitTopLevel(input, delimiter = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (quote) {
      if (quote === "[") {
        if (ch === "]") quote = null;
      } else if (ch === quote) {
        if (next === quote) {
          i++;
        } else {
          quote = null;
        }
      } else if (ch === "\\" && quote !== "`") {
        i++;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && input.startsWith(delimiter, i)) {
      parts.push(input.slice(start, i));
      i += delimiter.length - 1;
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function extractOuterParenthesized(sql) {
  let quote = null;
  let open = -1;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      if (quote === "[") {
        if (ch === "]") quote = null;
      } else if (ch === quote) {
        if (next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") quote = ch;
    else if (ch === "(") { open = i; break; }
  }
  if (open < 0) return null;
  const close = findMatchingParen(sql, open);
  return close < 0 ? null : sql.slice(open + 1, close);
}

export function findMatchingParen(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (quote === "[") {
        if (ch === "]") quote = null;
      } else if (ch === quote) {
        if (next === quote) i++;
        else quote = null;
      } else if (ch === "\\" && quote !== "`") {
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readIdentifier(segment) {
  const s = segment.trimStart();
  if (!s) return null;
  const first = s[0];
  if (first === '"' || first === "`" || first === "[") {
    const close = first === "[" ? "]" : first;
    let value = "";
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === close) {
        if (s[i + 1] === close && close !== "]") {
          value += close;
          i++;
          continue;
        }
        return { name: value, rest: s.slice(i + 1).trimStart() };
      }
      value += ch;
    }
    return null;
  }
  const m = /^([^\s(),]+)/.exec(s);
  if (!m) return null;
  return { name: m[1], rest: s.slice(m[0].length).trimStart() };
}

function findKeywordOutsideQuotes(text, keyword, from = 0) {
  const upper = text.toUpperCase();
  const target = keyword.toUpperCase();
  let quote = null;
  for (let i = from; i <= text.length - target.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (quote === "[") {
        if (ch === "]") quote = null;
      } else if (ch === quote) {
        if (next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      quote = ch;
      continue;
    }
    if (upper.startsWith(target, i)) {
      const before = upper[i - 1];
      const after = upper[i + target.length];
      if ((!before || !/[A-Z0-9_]/.test(before)) && (!after || !/[A-Z0-9_]/.test(after))) return i;
    }
  }
  return -1;
}

function replaceDoubleQuotedIdentifiers(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'" && text[i + 1] === "'") {
        out += text[++i];
      } else if (ch === "'") {
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      let value = "";
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          value += '"'; i += 2; continue;
        }
        if (text[i] === '"') { i++; break; }
        value += text[i++];
      }
      out += "`" + value.replace(/`/g, "``") + "`";
      continue;
    }
    if (ch === "[") {
      let value = "";
      i++;
      while (i < text.length && text[i] !== "]") value += text[i++];
      if (text[i] === "]") i++;
      out += "`" + value.replace(/`/g, "``") + "`";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function quoteKnownIdentifiers(text, knownIdentifiers) {
  const names = new Map(knownIdentifiers.map((n) => [String(n).toLowerCase(), String(n)]));
  if (!names.size) return text;
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (quote === "`") {
        if (ch === "`" && text[i + 1] === "`") out += text[++i];
        else if (ch === "`") quote = null;
      } else if (ch === "'") {
        if (ch === "'" && text[i + 1] === "'") out += text[++i];
        else if (ch === "'") quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === "`") {
      quote = ch; out += ch; i++; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const token = text.slice(i, j);
      const known = names.get(token.toLowerCase());
      out += known ? "`" + known.replace(/`/g, "``") + "`" : token;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function translateConcat(expression, knownIdentifiers) {
  const parts = splitTopLevel(expression, "||").map((p) => p.trim());
  if (parts.length <= 1) return expression;
  return `CONCAT(${parts.map((p) => translateMysqlExpression(p, knownIdentifiers)).join(", ")})`;
}

function maskQuotedText(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += " ";
      if (quote === "[") {
        if (ch === "]") quote = null;
      } else if (ch === quote) {
        if (next === quote) { out += " "; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      quote = ch; out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

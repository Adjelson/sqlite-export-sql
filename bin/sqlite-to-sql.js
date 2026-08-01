#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { exportSqliteToSql } from "../src/exporter.js";

const DB_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db"]);

function printHelp() {
  console.log(`
sqlite-to-sql - conversor automático SQLite → MySQL

Uso rápido:
  sqlite-to-sql <ficheiro.sqlite>
  sqlite-to-sql <pasta-com-bases> --recursive
  sqlite-to-sql -i <entrada> [-o <saida.sql|pasta>] [opções]

Comportamento automático:
  • MySQL é o dialeto padrão.
  • Se -o não for indicado, cria <nome>.mysql.sql junto da base.
  • Gera também <nome>.mysql.sql.report.json com avisos e contadores.
  • Uma pasta de entrada converte todos os .sqlite/.sqlite3/.db encontrados.

Opções:
  -i, --input <path>          Ficheiro ou pasta de entrada
  -o, --output <path>         Ficheiro .sql ou pasta de saída
  --dialect <mysql|sqlite>    Dialeto de saída (padrão: mysql)
  --batch <n>                 Linhas por INSERT (padrão: 500)
  --recursive                 Pesquisa bases em subpastas
  --no-report                 Não cria relatório JSON
  --strict-warnings           Termina com erro se houver avisos
  --no-text-scan              Não mede TEXT indexado para escolher VARCHAR seguro

  --no-data                   Exporta apenas o esquema
  --only-tables               Ignora índices, views e triggers
  --no-indexes                Não exporta índices
  --no-views                  Não inclui views para revisão
  --no-triggers               Não inclui triggers para revisão
  --tables <t1,t2,...>        Exporta apenas estas tabelas

  -h, --help                  Mostra esta ajuda

Exemplos:
  node ./bin/sqlite-to-sql.js ./clientes.sqlite
  node ./bin/sqlite-to-sql.js ./bases --recursive -o ./convertidas
  node ./bin/sqlite-to-sql.js -i ./base.db -o ./base.mysql.sql --batch 1000
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    dialect: "mysql",
    batch: 500,
    data: true,
    onlyTables: false,
    indexes: true,
    views: true,
    triggers: true,
    tables: null,
    recursive: false,
    report: true,
    strictWarnings: false,
    inspectTextLengths: true,
    help: false,
  };

  const takeValue = (i) => {
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) throw new Error(`Falta o valor de ${argv[i]}`);
    return value;
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { args.help = true; continue; }
    if (a === "-i" || a === "--input") { args.input = takeValue(i); i++; continue; }
    if (a === "-o" || a === "--output") { args.output = takeValue(i); i++; continue; }
    if (a === "--dialect") { args.dialect = takeValue(i).toLowerCase(); i++; continue; }
    if (a === "--batch") { args.batch = Number(takeValue(i)); i++; continue; }
    if (a === "--tables") {
      args.tables = takeValue(i).split(",").map((s) => s.trim()).filter(Boolean);
      i++;
      continue;
    }
    if (a === "--no-data") { args.data = false; continue; }
    if (a === "--only-tables") { args.onlyTables = true; continue; }
    if (a === "--no-indexes") { args.indexes = false; continue; }
    if (a === "--no-views") { args.views = false; continue; }
    if (a === "--no-triggers") { args.triggers = false; continue; }
    if (a === "--recursive") { args.recursive = true; continue; }
    if (a === "--no-report") { args.report = false; continue; }
    if (a === "--strict-warnings") { args.strictWarnings = true; continue; }
    if (a === "--no-text-scan") { args.inspectTextLengths = false; continue; }

    if (!a.startsWith("-") && !args.input) { args.input = a; continue; }
    throw new Error(`Argumento desconhecido: ${a}`);
  }
  return args;
}

function validateArgs(args) {
  if (!args.input) throw new Error("Indique um ficheiro ou pasta SQLite.");
  if (!fs.existsSync(args.input)) throw new Error(`Entrada não encontrada: ${args.input}`);
  if (!Number.isInteger(args.batch) || args.batch <= 0) throw new Error(`--batch inválido: ${args.batch}`);
  if (!["sqlite", "mysql"].includes(args.dialect)) throw new Error(`--dialect inválido: ${args.dialect}`);
}

function collectDatabases(inputPath, recursive) {
  const absolute = path.resolve(inputPath);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (!DB_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      throw new Error(`Extensão não suportada: ${path.extname(absolute) || "sem extensão"}`);
    }
    return [absolute];
  }
  if (!stat.isDirectory()) throw new Error("A entrada precisa ser um ficheiro ou pasta.");

  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) visit(full);
      else if (entry.isFile() && DB_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  visit(absolute);
  return files.sort();
}

function resolveOutput(inputFile, args, multiple) {
  const suffix = `.${args.dialect}.sql`;
  const base = path.basename(inputFile, path.extname(inputFile)) + suffix;
  if (!args.output) return path.join(path.dirname(inputFile), base);

  const out = path.resolve(args.output);
  if (multiple || fs.existsSync(out) && fs.statSync(out).isDirectory() || !path.extname(out)) {
    fs.mkdirSync(out, { recursive: true });
    return path.join(out, base);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return out;
}

function writeReport(report, outputPath) {
  const reportPath = outputPath + ".report.json";
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...report,
  }, null, 2) + "\n", "utf8");
  return reportPath;
}

function fmtNumber(value) {
  return new Intl.NumberFormat("pt-PT").format(value);
}

(async function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) { printHelp(); return; }
    validateArgs(args);

    const files = collectDatabases(args.input, args.recursive);
    if (!files.length) throw new Error("Nenhuma base .sqlite, .sqlite3 ou .db foi encontrada.");

    let totalWarnings = 0;
    let failed = 0;
    console.log(`A converter ${files.length} base(s) para ${args.dialect.toUpperCase()}...\n`);

    for (const inputPath of files) {
      const outputPath = resolveOutput(inputPath, args, files.length > 1);
      try {
        const report = exportSqliteToSql({
          inputPath,
          outputPath,
          dialect: args.dialect,
          batchSize: args.batch,
          exportData: args.data,
          exportIndexes: args.onlyTables ? false : args.indexes,
          exportViews: args.onlyTables ? false : args.views,
          exportTriggers: args.onlyTables ? false : args.triggers,
          onlyTables: args.onlyTables,
          onlyTableNames: args.tables,
          inspectTextLengths: args.inspectTextLengths,
        });
        const reportPath = args.report ? writeReport(report, outputPath) : null;
        totalWarnings += report.warnings.length;
        console.log(`✓ ${path.basename(inputPath)}`);
        console.log(`  SQL: ${outputPath}`);
        if (reportPath) console.log(`  Relatório: ${reportPath}`);
        console.log(`  ${fmtNumber(report.tables)} tabela(s), ${fmtNumber(report.rows)} linha(s), ${fmtNumber(report.warnings.length)} aviso(s)\n`);
      } catch (error) {
        failed++;
        try { fs.unlinkSync(outputPath); } catch {}
        try { fs.unlinkSync(outputPath + ".report.json"); } catch {}
        console.error(`✗ ${inputPath}: ${error.message}\n`);
      }
    }

    if (failed) process.exitCode = 1;
    if (args.strictWarnings && totalWarnings) process.exitCode = 2;
  } catch (error) {
    console.error(`Erro: ${error?.message || error}`);
    console.error("Use --help para ver os exemplos.");
    process.exitCode = 1;
  }
})();

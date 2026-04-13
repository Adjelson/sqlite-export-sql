# sqlite-to-sql

CLI em Node.js para converter bases de dados **SQLite** (`.sqlite`, `.db`) em ficheiros **`.sql`**, com suporte a dois dialetos:

- **SQLite** — dump fiel ao SQLite original
- **MySQL / MariaDB** — conversão completa de DDL + dados para importação directa

Inclui também uma **interface web PHP** para uso local via XAMPP.

---

## Funcionalidades

- Exporta schema (`CREATE TABLE`, `CREATE INDEX`, `CREATE VIEW`, `CREATE TRIGGER`)
- Exporta dados em `INSERT INTO ... VALUES (...)` por batches configuráveis
- Conversão DDL para MySQL:
  - Tipos: `TEXT→LONGTEXT`, `REAL→DOUBLE`, `BLOB→LONGBLOB`, `BOOLEAN→TINYINT(1)`, `NVARCHAR→VARCHAR`, `INT2→SMALLINT`, `INT8→BIGINT`, `NUMERIC→DECIMAL`, `DOUBLE PRECISION→DOUBLE`, etc.
  - Remove: `ON CONFLICT`, `DEFERRABLE`, `COLLATE NOCASE/RTRIM`, `STRICT`, `WITHOUT ROWID`
  - Remove cláusula `WHERE` de índices parciais (não suportada no MySQL < 8.0.13)
  - Adiciona `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  - Escaping correcto de `'` e `\` por dialeto
- Colunas geradas (`GENERATED ALWAYS AS`) excluídas automaticamente dos `INSERT`
- Processamento por stream — funciona com bases grandes sem estourar memória
- Filtro por tabelas via `--tables`

---

## Requisitos

- **Node.js** ≥ 18
- **PHP** ≥ 7.4 (apenas para a interface web)

---

## Instalação

```bash
git clone <repo-url>
cd sqlite-to-sql
npm install
```

Para usar globalmente:

```bash
npm install -g .
```

---

## Uso (CLI)

```bash
# Ajuda
node ./bin/sqlite-to-sql.js --help

# Dump SQLite
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.sqlite.sql

# Conversão para MySQL
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.mysql.sql --dialect mysql

# Só schema (sem dados)
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/schema.sql --no-data

# Filtrar tabelas específicas
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/partial.sql --tables users,orders

# Batch maior e sem triggers/views
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.mysql.sql \
  --dialect mysql --batch 1000 --no-views --no-triggers
```

---

## Opções

| Opção | Descrição | Padrão |
|---|---|---|
| `-i, --input` | Ficheiro `.sqlite`/`.db` de entrada | obrigatório |
| `-o, --output` | Ficheiro `.sql` de saída | obrigatório |
| `--dialect` | `sqlite` ou `mysql` | `sqlite` |
| `--batch` | Linhas por `INSERT` | `500` |
| `--no-data` | Exporta só schema | — |
| `--only-tables` | Exporta só tabelas (ignora índices/views/triggers) | — |
| `--no-indexes` | Omite `CREATE INDEX` | — |
| `--no-views` | Omite `CREATE VIEW` | — |
| `--no-triggers` | Omite `CREATE TRIGGER` | — |
| `--tables` | Lista de tabelas (vírgula) | todas |

---

## Interface Web (XAMPP)

Coloca a pasta do projecto em `htdocs/` e acede a:

```
http://localhost/sqlite-export-sql/
```

A interface permite carregar o ficheiro `.sqlite`, configurar todas as opções e fazer download do `.sql` gerado, sem instalar nada além do XAMPP e Node.js.

**Requisitos adicionais para a interface web:**
- `shell_exec` activo no `php.ini`
- `node` disponível no PATH do sistema
- `upload_max_filesize` e `post_max_size` ajustados conforme o tamanho das bases

---

## Importar no MySQL / MariaDB

```bash
# MySQL
mysql -u root -p nome_da_base < ./out/base.mysql.sql

# MariaDB
mariadb -u root -p nome_da_base < ./out/base.mysql.sql
```

O ficheiro gerado com `--dialect mysql` já inclui:
```sql
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
-- ... schema e dados ...
SET FOREIGN_KEY_CHECKS = 1;
```

---

## Estrutura do projecto

```
sqlite-to-sql/
├── bin/
│   └── sqlite-to-sql.js      # Entrada CLI (parse de args)
├── src/
│   ├── exporter.js           # Lógica principal de exportação
│   ├── schema.js             # Leitura de sqlite_master + PRAGMA
│   ├── escape.js             # Escaping SQL (dialect-aware)
│   └── dialects/
│       ├── mysql.js          # Conversões DDL para MySQL/MariaDB
│       └── sqlite.js         # Pass-through (sem conversão)
├── test/
│   └── run-test.js           # Suite de testes de integração (73 asserções)
├── index.php                 # Interface web (XAMPP)
├── package.json
├── .gitignore
└── README.md
```

---

## Testes

```bash
npm test
```

73 asserções cobrindo: tipos básicos e avançados, conversões DDL, escaping por dialeto, batching, filtros, colunas geradas, índices parciais, tabelas STRICT.

---

## Limitações conhecidas

- **VIEWs e TRIGGERs** — sintaxe difere entre SQLite e MySQL; pode ser necessário ajuste manual
- **Funções SQLite em DEFAULT** — `datetime('now')`, `strftime(...)` não são convertidas
- **Índices parciais** — o predicado `WHERE` é removido; o índice fica sem filtro
- **Tipos livres do SQLite** — tipos muito exóticos podem ficar como estão se não reconhecidos

---

## Licença

MIT — Adjelson Neves

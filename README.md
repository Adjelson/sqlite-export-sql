A seguir está um **README.md completo** para um projeto **Node.js (CLI)** que converte um ficheiro **`.sqlite`/`.db`** em **`.sql`**, com opção de dialeto **SQLite** (dump) ou **MySQL/MariaDB** (conversão básica). Pode copiar e colar diretamente como `README.md`.

````md
# sqlite-to-sql (Node.js CLI)

Ferramenta CLI em Node.js para converter uma base de dados **SQLite** (`.sqlite`, `.db`) em um ficheiro **`.sql`** (dump), com suporte a:
- **Dialeto SQLite** (exportação fiel ao SQLite)
- **Dialeto MySQL/MariaDB** (conversão básica de DDL + INSERTs)

> Objetivo: gerar um `.sql` portátil e fácil de importar em ambientes MySQL/MariaDB, preservando schema e dados.

---

## Funcionalidades

- Abre ficheiro `.sqlite`/`.db` local
- Exporta:
  - **Schema**: `CREATE TABLE`, `CREATE INDEX`, `CREATE VIEW`, `CREATE TRIGGER` (quando existirem)
  - **Dados**: `INSERT INTO ... VALUES (...)` por batches (configurável)
- Opções de dialeto:
  - `sqlite`: exporta DDL tal como está no SQLite
  - `mysql`: aplica conversões mínimas no DDL para compatibilidade com MySQL/MariaDB
- Escaping correto de:
  - strings com aspas
  - `NULL`
  - `BLOB` (hex `X'...'`)
- Processamento eficiente por **stream** (gera ficheiros grandes sem estourar memória)

---

## Requisitos

- Node.js 18+ (recomendado 20+)
- Windows / Linux / macOS

---

## Instalação

### 1) Clonar e instalar dependências
```bash
git clone <repo-url>
cd sqlite-to-sql
npm install
````

### 2) Executar localmente

```bash
node ./bin/sqlite-to-sql.js --help
```

---

## Uso (CLI)

### Exportar como SQL SQLite (dump)

```bash
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.sqlite.sql --dialect sqlite
```

### Exportar com dialeto MySQL/MariaDB

```bash
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.mysql.sql --dialect mysql
```

### Ajustar tamanho do batch (INSERTs)

```bash
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.mysql.sql --dialect mysql --batch 1000
```

### Ignorar views/triggers (opcional)

```bash
node ./bin/sqlite-to-sql.js -i ./data/base.sqlite -o ./out/base.mysql.sql --dialect mysql --no-views --no-triggers
```

---

## Parâmetros

| Opção           | Descrição                                                   | Padrão      |
| --------------- | ----------------------------------------------------------- | ----------- |
| `-i, --input`   | Caminho do ficheiro `.sqlite`/`.db`                         | obrigatório |
| `-o, --output`  | Caminho do ficheiro `.sql` gerado                           | obrigatório |
| `--dialect`     | `sqlite` ou `mysql`                                         | `sqlite`    |
| `--batch`       | Quantidade de linhas por `INSERT`                           | `500`       |
| `--no-data`     | Exporta apenas schema (sem INSERTs)                         | false       |
| `--only-tables` | Exporta apenas tabelas e dados (sem índices/views/triggers) | false       |
| `--no-indexes`  | Não exporta índices                                         | false       |
| `--no-views`    | Não exporta views                                           | false       |
| `--no-triggers` | Não exporta triggers                                        | false       |
| `--tables`      | Lista de tabelas (separadas por vírgula) para exportar      | todas       |

---

## Importação no MySQL/MariaDB

### MySQL

```bash
mysql -u root -p nome_da_base < ./out/base.mysql.sql
```

### MariaDB

```bash
mariadb -u root -p nome_da_base < ./out/base.mysql.sql
```

> Dica: se houver constraints complexas, pode ser útil inserir no topo do `.sql`:

```sql
SET FOREIGN_KEY_CHECKS=0;
```

e no fim:

```sql
SET FOREIGN_KEY_CHECKS=1;
```

---

## Limitações conhecidas (dialeto MySQL)

A conversão para MySQL/MariaDB é **compatibilidade básica**, focada em tabelas + dados.

Pode exigir ajuste manual em:

* `VIEW` e `TRIGGER` (sintaxe difere do SQLite)
* funções específicas do SQLite (`datetime('now')`, `strftime`, etc.)
* tipos muito livres do SQLite (MySQL é mais rígido)
* `WITHOUT ROWID` (não suportado no MySQL)

---

## Estrutura do projeto (sugerida)

```text
sqlite-to-sql/
├─ bin/
│  └─ sqlite-to-sql.js          # CLI (parse args, chama exporter)
├─ src/
│  ├─ exporter.js               # lógica principal de export
│  ├─ dialects/
│  │  ├─ mysql.js               # conversões DDL para MySQL/MariaDB
│  │  └─ sqlite.js              # pass-through (sem conversão)
│  ├─ escape.js                 # escaping e serialização SQL
│  └─ schema.js                 # leitura sqlite_master + PRAGMA table_info
├─ data/                        # exemplo (opcional)
├─ out/                         # output (gitignore)
├─ package.json
└─ README.md
```

---

## Roadmap (opcional)

* Conversão avançada de DDL para MySQL:

  * `AUTOINCREMENT`
  * `DEFAULT CURRENT_TIMESTAMP` e variações
  * normalização de `BOOLEAN`, `DATETIME`, `JSON`
* Export em modo:

  * `INSERT IGNORE`
  * `REPLACE INTO`
* Progresso / logging detalhado
* Testes automatizados (Vitest/Jest)
* Suporte a export seletivo por regex/namespace de tabelas

---

## Licença

MIT 

---

## Contribuição

PRs são bem-vindos:

1. Fork
2. Branch
3. Pull request com descrição clara e exemplos

---

## Autor

Nito ST


# SQLite → MySQL Converter 2.0

Conversor automático e conservador de bases **SQLite** (`.sqlite`, `.sqlite3`, `.db`) para scripts de importação **MySQL 8 / MariaDB**.

A versão 2.0 deixou de aplicar substituições globais no texto do `CREATE TABLE`. O esquema MySQL é reconstruído a partir dos metadados reais do SQLite (`PRAGMA`), evitando que nomes, valores de `CHECK` ou dados sejam confundidos com tipos SQL.

## Principais garantias

- Preserva nomes de tabelas e colunas como `text`, `integer`, `real`, `strict`, `order` e `group`.
- Preserva inteiros SQLite de 64 bits sem arredondamento do JavaScript.
- Reconstrói chaves primárias, chaves estrangeiras, índices e restrições `UNIQUE`.
- Mantém `DEFAULT` numéricos, booleanos, textos e datas quando existe equivalência segura.
- Preserva valores dentro de `CHECK`, sem transformar `'TEXT'` em `'LONGTEXT'`.
- Mantém colunas geradas no esquema e remove-as apenas dos `INSERT`.
- Ignora índices parciais com aviso, em vez de os transformar em índices globais com semântica diferente.
- Coloca views e triggers como comentários para revisão, em vez de gerar SQL potencialmente incorreto.
- Gera um relatório JSON automático com avisos e contadores.
- Processa os dados em lotes, sem carregar toda a base na memória.

## Requisitos

- Node.js 18 ou superior
- npm
- PHP 7.4 ou superior apenas para a interface web

## Instalação

```bash
npm install
```

> Não copie `node_modules` entre Windows, Linux e macOS. O `better-sqlite3` possui um módulo nativo e deve ser instalado no computador onde o conversor será executado.

## Conversão automática no Windows

A forma mais simples é arrastar uma base ou uma pasta para:

```text
CONVERTER_AUTOMATICO.bat
```

Também pode executar o ficheiro e escrever o caminho solicitado. Se as dependências ainda não existirem, o próprio script executa `npm install`.

A saída é criada ao lado da base:

```text
clientes.sqlite
clientes.mysql.sql
clientes.mysql.sql.report.json
```

## Conversão automática pelo terminal

Não é necessário indicar dialeto nem nome de saída:

```bash
node ./bin/sqlite-to-sql.js ./clientes.sqlite
```

Ou através do npm:

```bash
npm run convert -- ./clientes.sqlite
```

### Converter todas as bases de uma pasta

```bash
node ./bin/sqlite-to-sql.js ./bases --recursive
```

### Colocar os resultados noutra pasta

```bash
node ./bin/sqlite-to-sql.js ./bases --recursive -o ./convertidas
```

## Opções da CLI

| Opção | Descrição | Padrão |
|---|---|---|
| `-i, --input` | Ficheiro ou pasta SQLite | pode ser argumento posicional |
| `-o, --output` | Ficheiro `.sql` ou pasta de saída | junto da base |
| `--dialect` | `mysql` ou `sqlite` | `mysql` |
| `--batch` | Linhas por bloco de `INSERT` | `500` |
| `--recursive` | Pesquisa também em subpastas | desativado |
| `--no-report` | Não cria o relatório JSON | relatório ativo |
| `--strict-warnings` | Código de saída 2 quando houver avisos | desativado |
| `--no-text-scan` | Não mede textos indexados | medição ativa |
| `--no-data` | Exporta apenas o esquema | dados ativos |
| `--only-tables` | Ignora índices, views e triggers | desativado |
| `--no-indexes` | Não exporta índices | índices ativos |
| `--no-views` | Não inclui views para revisão | views ativas |
| `--no-triggers` | Não inclui triggers para revisão | triggers ativos |
| `--tables users,orders` | Exporta apenas tabelas específicas | todas |

## Exemplos

```bash
# Automático: SQLite → MySQL
node ./bin/sqlite-to-sql.js ./data/app.db

# Saída definida manualmente
node ./bin/sqlite-to-sql.js -i ./data/app.db -o ./out/app.sql

# Apenas estrutura
node ./bin/sqlite-to-sql.js ./data/app.db --no-data

# Apenas algumas tabelas
node ./bin/sqlite-to-sql.js ./data/app.db --tables users,departments

# Conversão em lote
node ./bin/sqlite-to-sql.js ./data --recursive -o ./out

# Falhar num pipeline quando existir algo para revisão
node ./bin/sqlite-to-sql.js ./data/app.db --strict-warnings
```

## Relatório automático

Cada conversão cria um ficheiro semelhante a:

```json
{
  "dialect": "mysql",
  "tables": 8,
  "rows": 1240,
  "indexes": 6,
  "skippedObjects": 2,
  "warnings": [
    "Índice UNIQUE parcial idx_email foi ignorado para não alterar a regra de unicidade.",
    "trigger update_user foi incluído apenas como comentário para revisão manual."
  ]
}
```

Os mesmos avisos aparecem no final do `.sql` como comentários.

## Interface desktop Electron

```bash
npm run electron
```

A interface usa MySQL como opção padrão, mostra o número de avisos e permite guardar o ficheiro convertido.

Para gerar aplicações desktop:

```bash
npm run electron:build
```

## Interface web PHP/XAMPP

1. Coloque o projeto dentro de `htdocs`.
2. Execute `npm install` na pasta do projeto.
3. Garanta que `node` está disponível no `PATH` do sistema.
4. Abra:

```text
http://localhost/sqlite-export-sql/
```

A interface web usa MySQL por padrão e inclui os avisos dentro do SQL gerado.

## Importação no MySQL

Crie primeiro uma base vazia:

```sql
CREATE DATABASE minha_base
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

Depois importe:

```bash
mysql -u root -p minha_base < clientes.mysql.sql
```

## Decisões de segurança

### Índices parciais

O SQLite suporta:

```sql
CREATE UNIQUE INDEX idx_email
ON users(email)
WHERE deleted_at IS NULL;
```

O MySQL não possui um equivalente direto. A versão anterior removia o `WHERE`, criando uma regra de unicidade global diferente. A versão 2.0 ignora o índice e emite um aviso.

### Views e triggers

A sintaxe e as funções disponíveis são diferentes. Para não produzir um ficheiro que falha durante a importação ou altera o comportamento da aplicação, o objeto original é incluído apenas como comentário.

### Tipos `INTEGER`

O `INTEGER` do SQLite pode armazenar 64 bits. Por isso, a conversão usa `BIGINT`, evitando perdas que ocorreriam com o `INT` de 32 bits do MySQL.

### Textos indexados

Colunas SQLite `TEXT` utilizadas em índices são convertidas automaticamente para `VARCHAR`, com base no tamanho observado, porque o MySQL não permite indexar `LONGTEXT` sem prefixo. Casos muito extensos geram aviso para revisão.

## Testes

```bash
npm test
```

A suite inclui:

- 81 testes funcionais do conversor;
- 18 testes de regressão e segurança;
- nomes iguais a tipos SQL;
- palavras reservadas do MySQL;
- inteiros maiores que `Number.MAX_SAFE_INTEGER`;
- `CHECK` com valores `TEXT`, `REAL` e `BLOB`;
- defaults escritos numa única linha;
- chaves estrangeiras;
- índices parciais;
- nome de saída e relatório automáticos.

## Estrutura

```text
sqlite-export-sql/
├── bin/
│   └── sqlite-to-sql.js
├── src/
│   ├── exporter.js
│   ├── schema.js
│   ├── sqlite-parser.js
│   ├── escape.js
│   └── dialects/
│       ├── mysql.js
│       └── sqlite.js
├── test/
│   ├── run-test.js
│   └── regression-test.js
├── electron/
├── renderer/
├── index.php
├── CONVERTER_AUTOMATICO.bat
├── converter-automatico.sh
├── package.json
└── README.md
```

## Limitações que ainda exigem revisão humana

- Views e triggers SQLite.
- Índices parciais ou índices baseados em expressões.
- Funções SQLite sem equivalente direto em `DEFAULT`, `CHECK` ou colunas geradas.
- Tipos personalizados muito específicos.
- Regras de collation personalizadas.

O conversor prefere **avisar e preservar os dados** a gerar automaticamente uma regra MySQL diferente da original.

## Licença

MIT — Adjelson Neves

# Relatório de validação — versão 2.0.0

Data: 24 de julho de 2026

## Resultado

- 81 testes funcionais aprovados.
- 18 testes de regressão e segurança aprovados.
- Total: **99 testes aprovados, 0 falhas**.

## Falhas críticas da versão anterior cobertas

- Preservação de tabelas e colunas chamadas `text`, `integer`, `real` e `strict`.
- Preservação de palavras reservadas MySQL como `order` e `group` através de quoting.
- Preservação exata do inteiro `9007199254740993`.
- Preservação dos valores `'TEXT'`, `'REAL'` e `'BLOB'` dentro de `CHECK`.
- Preservação de `DEFAULT 1` e `DEFAULT 2.5` em tabelas escritas numa única linha.
- Reconstrução de chaves estrangeiras através de `PRAGMA foreign_key_list`.
- Índices `UNIQUE ... WHERE` ignorados com aviso, sem ampliar a regra de unicidade.
- Criação automática do nome do SQL e do relatório JSON.
- Proteção contra a utilização do próprio ficheiro SQLite como saída.
- Remoção automática de saídas incompletas em caso de erro.

## Observação

Os testes validam a leitura da base SQLite, a estrutura do SQL gerado e os casos de regressão. Não havia um servidor MySQL/MariaDB disponível neste ambiente para executar uma importação real completa. Views, triggers, índices parciais e expressões SQLite sem equivalente direto continuam sinalizados para revisão humana.

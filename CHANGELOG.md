# Changelog

## 2.0.0

- Reconstrução segura do esquema MySQL através de `PRAGMA`.
- Preservação de identificadores que coincidem com tipos ou palavras reservadas.
- Preservação de inteiros SQLite de 64 bits através de `safeIntegers`.
- Conversão automática de chaves primárias e estrangeiras.
- Deduplicação de restrições `UNIQUE`.
- Índices parciais ignorados com aviso, sem mudança silenciosa de semântica.
- Defaults em definições de uma única linha preservados.
- Valores de `CHECK` protegidos contra substituições de tipo.
- Colunas geradas preservadas no DDL e removidas dos `INSERT`.
- Views e triggers incluídos como comentários para revisão.
- CLI com saída automática, conversão de pastas e relatório JSON.
- Scripts automáticos para Windows e sistemas Unix.
- Novos testes de regressão para os erros críticos da versão anterior.

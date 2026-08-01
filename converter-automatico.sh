#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ ! -d node_modules/better-sqlite3 ]; then
  npm install
fi

INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  printf "Caminho do ficheiro ou pasta SQLite: "
  read -r INPUT
fi

node ./bin/sqlite-to-sql.js "$INPUT" --recursive

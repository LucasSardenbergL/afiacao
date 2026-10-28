#!/usr/bin/env bash
# test-pg17.sh — roda os testes Go `TestPG17_*` do conector contra um PostgreSQL 17 DESCARTÁVEL.
#
# Por quê: o `Validate` lê o information_schema de verdade; o teste unitário só exercita a
# resolução pura (resolveMapping). Este script sobe um PG17 pelo harness do repo, exporta
# SAYERSYNC_PG17_URL e exige a marca POSITIVA de cada teste PG17 — teste pulado (sem a URL) é
# AUSÊNCIA de dado, nunca aprovação.
#
# Uso: bash connector/sayersync/test-pg17.sh
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$AQUI/../.." && pwd)"
# shellcheck disable=SC1091  # o helper é versionado em db/lib/ (mesmo idioma dos db/test-*.sh)
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major 17
PORT="${PGPORT_TEST:-$((5500 + RANDOM % 400))}"   # aleatória: várias sessões rodam provas em paralelo

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-sayersync.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
export LC_ALL=C LANG=C   # sem locale válido o postmaster aborta ("became multithreaded during startup")
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null || { echo "INFRA: pg_ctl não subiu (porta $PORT)"; tail -5 "$TMP/pg.log"; exit 1; }
echo "PG: $("$PGBIN/postgres" --version)"

export SAYERSYNC_PG17_URL="postgres://postgres@/postgres?host=$SOCK&port=$PORT&sslmode=disable"

# Os nomes exigidos são a lista de TODOS os TestPG17_* do pacote: um teste novo sem marca de PASS
# reprova aqui, em vez de passar calado.
ESPERADOS="$(grep -hoE '^func TestPG17_[A-Za-z0-9_]+' "$AQUI"/*_test.go | awk '{print $2}' | sort -u)"
[ -n "$ESPERADOS" ] || { echo "FALHA: nenhum TestPG17_* encontrado"; exit 1; }

set +e
(cd "$AQUI" && go test -run '^TestPG17_' -count=1 -v .) >"$TMP/go.out" 2>&1
rc=$?
set -e
cat "$TMP/go.out"
[ "$rc" -eq 0 ] || { echo "FALHA: go test exit=$rc"; exit 1; }

N=0
for t in $ESPERADOS; do
  N=$((N + 1))
  if ! grep -q -- "--- PASS: $t " "$TMP/go.out"; then
    echo "FALHA: sem a marca '--- PASS: $t' (pulado = ausência de dado)"
    exit 1
  fi
done
echo "PG17_OK $N teste(s): $(tr '\n' ' ' <<<"$ESPERADOS")"

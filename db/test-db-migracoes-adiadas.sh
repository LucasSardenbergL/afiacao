#!/usr/bin/env bash
# test-db-migracoes-adiadas.sh — prova a migration 20261126230001 num PG17 LOCAL descartável.
#
# Simula o DEFAULT ACL do schema public do Supabase (escrita para service_role em toda tabela nova,
# com BYPASSRLS) e exige: allowlist fecha a escrita de todo mundo fora claude_rw; claude_ro lê;
# anon/authenticated não leem; re-aplicar é idempotente. Falsificação com CONTROLE verde na mesma
# invocação: a cópia SEM o bloco de allowlist tem de abortar na postcondição A3.
# Uso: bash db/test-db-migracoes-adiadas.sh   (exit 0 = verde)
set -u
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
MIG="$RAIZ/supabase/migrations/20261126230001_db_migracoes_adiadas.sql"
PGBIN=${PGBIN:-$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || dirname "$(command -v initdb)")}
TMP=$(mktemp -d); PORTA=$((54000 + RANDOM % 1000))
trap '"$PGBIN/pg_ctl" -D "$TMP/d" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"' EXIT
"$PGBIN/initdb" -D "$TMP/d" -U postgres -A trust >/dev/null 2>&1 || { echo "MECANICA: initdb"; exit 6; }
"$PGBIN/pg_ctl" -D "$TMP/d" -o "-p $PORTA -k $TMP -c listen_addresses=''" -w start >/dev/null 2>&1 || { echo "MECANICA: start"; exit 6; }
q() { "$PGBIN/psql" -X -q -A -t -h "$TMP" -p "$PORTA" -U postgres -v ON_ERROR_STOP=1 "$@"; }
FALHAS=0
nok() { echo "FALHA $1"; FALHAS=$((FALHAS + 1)); }

base() {  # banco novo com os papéis e o default ACL do Supabase
  q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null
  q -d "$1" <<'SQL' >/dev/null
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude_ro') THEN CREATE ROLE claude_ro BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude_rw') THEN CREATE ROLE claude_rw; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, claude_ro, claude_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role, anon, authenticated;
SQL
}
aplica() { q -d "$1" -c 'BEGIN' -f "$2" -c 'COMMIT' 2>&1; }

# ── controle: a migration real aplica (2x) e a ACL fica na allowlist ─────────────────────────────
base t1
out=$(aplica t1 "$MIG") || nok "1º apply: $out"
out=$(aplica t1 "$MIG") || nok "2º apply (idempotência): $out"
[ "$(q -d t1 -c "select has_table_privilege('service_role','public.db_migracoes_adiadas','INSERT')")" = f ] || nok "service_role escreve"
[ "$(q -d t1 -c "select has_table_privilege('authenticated','public.db_migracoes_adiadas','SELECT')")" = f ] || nok "authenticated lê"
[ "$(q -d t1 -c "select has_table_privilege('claude_ro','public.db_migracoes_adiadas','SELECT')")" = t ] || nok "claude_ro não lê"
q -d t1 -c "SET ROLE claude_rw; INSERT INTO public.db_migracoes_adiadas (sha256, arquivo, motivo) VALUES (repeat('a',64), 'supabase/migrations/1_x.sql', 'fatia futura, sem front')" >/dev/null 2>&1 \
  || nok "claude_rw não insere"
q -d t1 -c "SET ROLE claude_rw; DELETE FROM public.db_migracoes_adiadas" >/dev/null 2>&1 && nok "claude_rw apagou (desfazer é revogada_em)"
q -d t1 -c "SET ROLE claude_rw; INSERT INTO public.db_migracoes_adiadas (sha256, arquivo, motivo) VALUES ('abc', 'x', 'curto')" >/dev/null 2>&1 \
  && nok "CHECK aceitou sha/arquivo/motivo inválidos"
[ "$FALHAS" = 0 ] && echo "ok   controle: apply 2x, allowlist, claude_rw insere, sem DELETE, CHECKs"

# ── falsificação: sem o bloco de allowlist, a postcondição A3 tem de abortar ────────────────────
# shellcheck disable=SC2016  # $allowlist$ é LITERAL do SQL
sed '/^DO \$allowlist\$/,/^\$allowlist\$;/d' "$MIG" > "$TMP/sab.sql"
if cmp -s "$MIG" "$TMP/sab.sql"; then nok "sabotagem não casou"
else
  base t2
  out=$(aplica t2 "$TMP/sab.sql"); rc=$?
  if [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'A3 FALHOU'; then echo "ok   falsificação: sem allowlist → A3 aborta"
  else nok "sabotada não abortou em A3 (rc=$rc): $(printf '%s' "$out" | head -c 300)"; fi
  [ "$(q -d t2 -c "select to_regclass('public.db_migracoes_adiadas') is null")" = t ] || nok "abortou mas deixou a tabela (transação?)"
fi

[ "$FALHAS" = 0 ] && { echo "TEST-DB-MIGRACOES-ADIADAS: OK"; exit 0; }
echo "TEST-DB-MIGRACOES-ADIADAS: $FALHAS falha(s)"; exit 1

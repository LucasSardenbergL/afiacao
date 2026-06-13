#!/usr/bin/env bash
# Onda1/Fase0 — valida a migração de idempotência de sales_orders num PG17 local.
# Prova: (a) as 3 colunas + os 3 índices; (b) UNIQUE(checkout_id,account) parcial bloqueia
# duplicata na MESMA conta, permite contas distintas, ignora checkout_id NULO; (c)
# UNIQUE(account,omie_pedido_id) parcial bloqueia dupla-vinculação. Base: verify-snapshot-replay.sh.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"; PORT=5434
DATA="$(mktemp -d /tmp/pgtest-fase0.XXXXXX)/data"; export LC_ALL=C LANG=C
SOCK="$(dirname "$DATA")"  # socket+log isolados por run → sem colisão de porta entre worktrees paralelas
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"; cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=" -l "$SOCK/pg-fase0.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres fase0_verify
P() { "$PGBIN/psql" -p "$PORT" -h "$SOCK" -U postgres -d fase0_verify "$@"; }
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" | grep -vE '^\\(un)?restrict ' > "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql"
echo "── asserts ──"
P -v ON_ERROR_STOP=1 -tA <<'SQL'
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders'
    AND column_name IN ('checkout_id','origem','atendimento_id'))=3, 'faltam colunas';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_checkout_account_uq')=1, 'falta uq checkout';
  -- UNIQUE(account, omie_pedido_id) é DELIBERADAMENTE ausente (incompatível com push+pull) → deve ser 0.
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_account_omiepedido_uq')=0, 'uq omie NAO deveria existir';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='idx_sales_orders_origem')=1, 'falta idx origem';
  RAISE NOTICE 'OK colunas+indices';
END $$;
SQL
P -v ON_ERROR_STOP=1 -tA <<'SQL'
SET session_replication_role = replica;  -- desliga FK/trigger p/ semear; unique segue enforçado
DO $$
DECLARE ck uuid := gen_random_uuid();
BEGIN
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben', ck);
  BEGIN
    INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben', ck);
    RAISE EXCEPTION 'FALHA: 2a (checkout,oben) deveria violar';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','colacor', ck);  -- conta diferente ok
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account) VALUES
    (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'rascunho','oben'),
    (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'rascunho','oben');  -- 2 com checkout nulo ok
  -- (account, omie_pedido_id) DUPLICADO deve ser PERMITIDO: o push (linha 'enviado') e o
  -- sync de entrada (linha 'faturado'/'importado') gravam o MESMO omie_pedido_id em linhas
  -- distintas por design → NÃO pode haver unique aqui (senão o sync de entrada quebra).
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, omie_pedido_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'enviado','oben', 999001);
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, omie_pedido_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'faturado','oben', 999001);  -- mesmo pedido, push+pull → OK
  ASSERT (SELECT count(*) FROM sales_orders WHERE account='oben' AND omie_pedido_id=999001)=2,
    'push+pull: 2 linhas com o mesmo (account, omie_pedido_id) devem coexistir';
  RAISE NOTICE 'OK semantica do uq checkout parcial + push+pull permitido';
END $$;
SQL
echo "FASE0 MIGRATION OK"

#!/usr/bin/env bash
# test-pedidos-vendedor.sh — prova PG17 da migration 20261121140000_pedidos_vendedor.sql
# ================================================================================================
# Meu dia do CEO: o placar lia sales_orders.vendedor_user_id pelo PostgREST e tomava 403 (coluna
# fechada para authenticated). A leitura passa a ser pela RPC pedidos_vendedor(uuid[]).
#
# Banco: stubs + schema-snapshot da prod + 20261113120000 (cria as colunas do vendedor) + a
# migration REAL (cópia — a sabotagem age na cópia).
#
#   MIG   a migration aplica com a POS verde; MIG2 re-aplicar é seguro (idempotente)
#   K1    a CAUSA do bug: authenticated NÃO lê vendedor_user_id direto (42501) — segue fechada
#   R1    master: lote com vendedor, sem vendedor e id inexistente → 2 linhas, vendedor certo
#   R2    employee passa · R3 service_role passa
#   G1    customer → 42501 PEDIDOS_VENDEDOR_ACESSO · G2 anon → 42501 (sem EXECUTE)
#   G3    authenticated sem uid → 42501 PEDIDOS_VENDEDOR_ACESSO
#   L1    lote vazio → 22023 PEDIDOS_VENDEDOR_LOTE · L2 lote de 1001 → 22023
#
# Uso:  bash db/test-pedidos-vendedor.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 bash db/test-pedidos-vendedor.sh   (2º locale)
#       bash db/test-pedidos-vendedor.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5811}"
SLUG="pedidos-vendedor"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261121140000_pedidos_vendedor.sql"
MIG_PRE="$REPO_ROOT/supabase/migrations/20261113120000_vendedor_pedido_omie.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=11

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS:VERDES-de-controle   (ID!MARCA = vermelho de execução com a marca)
  SABOTAGENS="sem_gate:G1,G3:R1,R2
              sem_employee:R2:R1,R3
              sem_lote:L1,L2:R1
              invoker:R1,R2:G1
              pos_grant_coluna:MIG!P4_FALHOU
              pos_anon:MIG!P2_FALHOU
              pos_invoker:MIG!P3_FALHOU"
  falhas=0
  echo "═══ CONTROLE (sem sabotagem) ═══"
  if ! PGPORT_TEST="$PORT" bash "$0" > "/tmp/falsif-${SLUG}-controle.log" 2>&1; then
    echo "❌ CONTROLE VERMELHO — sem linha de base, a falsificação não prova nada"; tail -20 "/tmp/falsif-${SLUG}-controle.log"; exit 1
  fi
  n=$(grep -c '  ✅ ' "/tmp/falsif-${SLUG}-controle.log" || true)
  [ "$n" = "$TOTAL_ESPERADO" ] || { echo "❌ CONTROLE rodou $n asserts, esperado $TOTAL_ESPERADO"; exit 1; }
  echo "  ✅ controle verde ($n asserts)"
  i=0
  for linha in $SABOTAGENS; do
    i=$((i+1))
    nome="${linha%%:*}"; resto="${linha#*:}"; reds="${resto%%:*}"
    case "$resto" in *:*) greens="${resto#*:}" ;; *) greens="" ;; esac
    log="/tmp/falsif-${SLUG}-${nome}.log"
    if SABOTAGEM="$nome" PGPORT_TEST="$((PORT+i))" bash "$0" > "$log" 2>&1; then
      echo "❌ $nome: harness VERDE com a sabotagem — assert sem dente"; falhas=$((falhas+1)); continue
    fi
    antes=$falhas
    for a in ${reds//,/ }; do
      case "$a" in
        *!*) id="${a%%!*}"; marca="${a#*!}"
             grep -q "^  ❌ $id .*ERROR:  $marca:" "$log" || { echo "❌ $nome: $id devia falhar com a marca $marca"; falhas=$((falhas+1)); } ;;
        *)   grep -q "^  ❌ $a " "$log" || { echo "❌ $nome: $a devia estar VERMELHO"; falhas=$((falhas+1)); } ;;
      esac
    done
    for a in ${greens//,/ }; do
      [ -n "$a" ] || continue
      grep -q "^  ✅ $a " "$log" || { echo "❌ $nome: $a (controle) devia seguir VERDE"; falhas=$((falhas+1)); }
    done
    [ "$falhas" = "$antes" ] || continue
    echo "  ✅ $nome → vermelho em [$reds]${greens:+, verde em [$greens]}"
  done
  [ "$falhas" = 0 ] || { echo "❌ FALSIFICAÇÃO FALHOU ($falhas)"; exit 1; }
  echo "✅ FALSIFICAÇÃO OK — todas as sabotagens ficaram vermelhas onde deviam"
  exit 0
fi

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/ (resolve o PGBIN no Mac e no CI)
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c TimeZone=UTC" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1 $2 (=$3)"; else bad "$1 $2 — esperado [$4], veio [$3]"; fi; }
# Erro esperado: casa a SQLSTATE e a MARCA (ASCII, caixa fixa) — "lançou algo" não conta.
erro() { # $1 id, $2 descrição, $3 sqlstate, $4 marca, $5 sql
  local out; out="$(P -tA -c "\\set VERBOSITY verbose" -c "$5" 2>&1 || true)"
  if printf '%s' "$out" | grep -q "ERROR:  $3:" && printf '%s' "$out" | grep -q "$4"; then
    ok "$1 $2 ($3 $4)"
  else
    bad "$1 $2 — esperado $3/$4, veio: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
DO $$ BEGIN CREATE ROLE claude_ro; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
# ACL de prod de sales_orders (20260709163500): SELECT/UPDATE por coluna, nunca table-level.
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE SELECT, UPDATE ON public.sales_orders FROM authenticated;
GRANT SELECT (id, customer_user_id, created_by, status, account, hash_payload, total, order_date_kpi, deleted_at) ON public.sales_orders TO authenticated;
GRANT UPDATE (status, notes) ON public.sales_orders TO authenticated;
SQL
P -q -f "$MIG_PRE" >/dev/null 2>"$TMPD/pre.err" || { echo "INFRA: 20261113120000 não aplicou"; tail -5 "$TMPD/pre.err"; exit 1; }
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"

MIG="$TMPD/mig.sql"
cp "$MIG_ORIG" "$MIG"
sabotar() { # $1 = expressão perl; exige que MUDE o arquivo (sabotagem que não casa = teatro)
  local antes depois
  antes="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  perl -0pi -e "$1" "$MIG"
  depois="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  [ "$antes" != "$depois" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
desliga_pos() { sabotar "s/RAISE EXCEPTION 'P(\\d)_FALHOU/RAISE NOTICE 'P\${1}_FALHOU/g"; }

case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate)         sabotar 's/  IF NOT \(coalesce\(auth\.role\(\)/  IF false AND NOT (coalesce(auth.role()/'; desliga_pos ;;
  sem_employee)     sabotar 's/\n\s+OR public\.has_role\(v_uid, .employee.::public\.app_role\)\)/)/'; desliga_pos ;;
  sem_lote)         sabotar 's/IF p_ids IS NULL OR cardinality/IF false AND p_ids IS NULL OR cardinality/'; desliga_pos ;;
  invoker)          sabotar 's/^SECURITY DEFINER$/SECURITY INVOKER/m'; desliga_pos ;;
  pos_grant_coluna) sabotar 's/^(GRANT EXECUTE ON FUNCTION public\.pedidos_vendedor.*)$/$1\nGRANT SELECT (vendedor_user_id) ON public.sales_orders TO authenticated;/m' ;;
  pos_anon)         sabotar 's/TO authenticated, service_role;/TO authenticated, service_role, anon;/' ;;
  pos_invoker)      sabotar 's/^SECURITY DEFINER$/SECURITY INVOKER/m' ;;
  *) echo "INFRA: sabotagem desconhecida '$SABOTAGEM'"; exit 2 ;;
esac

# ── MIG ────────────────────────────────────────────────────────────────────────────────────────
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG migration aplica (POS verde)"; else bad "MIG migration falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG2 re-aplicar é seguro"; else bad "MIG2 re-aplicar falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi

# ── semente ────────────────────────────────────────────────────────────────────────────────────
P -q <<'SQL' >/dev/null
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'),  -- vendedora
  ('00000000-0000-0000-0000-0000000000f1'),  -- master
  ('00000000-0000-0000-0000-0000000000e1'),  -- employee
  ('00000000-0000-0000-0000-0000000000c1');  -- cliente
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'master'), ('00000000-0000-0000-0000-0000000000e1', 'employee'),
  ('00000000-0000-0000-0000-0000000000c1', 'customer');
INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, total, status, account,
                                 order_date_kpi, vendedor_omie_codigo, vendedor_user_id, vendedor_lido_em)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 100, 100,
        'faturado', 'oben', date '2026-11-03', 842, '00000000-0000-0000-0000-0000000000a1', now()),
       ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 200, 200,
        'faturado', 'oben', date '2026-11-04', NULL, NULL, NULL);
SQL

LOTE="ARRAY['10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-0000000000ff']::uuid[]"
como() { Pq -c "SET ROLE authenticated; SET test.uid = '$1'; SET test.role = '${2:-authenticated}'; SELECT string_agg(id || '=' || coalesce(vendedor_user_id::text, '-'), ',' ORDER BY id) FROM public.pedidos_vendedor($LOTE)" 2>&1 | tail -1; }
ESPERADO="10000000-0000-0000-0000-000000000001=00000000-0000-0000-0000-0000000000a1,10000000-0000-0000-0000-000000000002=-"

erro K1 "authenticated não lê a coluna direto (a causa do 403)" 42501 "permission denied" "SET ROLE authenticated; SELECT vendedor_user_id FROM public.sales_orders"
eq R1 "master lê o vendedor do lote" "$(como 00000000-0000-0000-0000-0000000000f1)" "$ESPERADO"
eq R2 "employee lê o vendedor do lote" "$(como 00000000-0000-0000-0000-0000000000e1)" "$ESPERADO"
eq R3 "service_role lê o vendedor do lote" "$(Pq -c "SET ROLE service_role; SET test.role = 'service_role'; SELECT string_agg(id || '=' || coalesce(vendedor_user_id::text, '-'), ',' ORDER BY id) FROM public.pedidos_vendedor($LOTE)" 2>&1 | tail -1)" "$ESPERADO"
erro G1 "customer barrado" 42501 "PEDIDOS_VENDEDOR_ACESSO" "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000c1'; SELECT * FROM public.pedidos_vendedor($LOTE)"
erro G2 "anon sem EXECUTE" 42501 "permission denied" "SET ROLE anon; SELECT * FROM public.pedidos_vendedor($LOTE)"
erro G3 "authenticated sem uid barrado" 42501 "PEDIDOS_VENDEDOR_ACESSO" "SET ROLE authenticated; SELECT * FROM public.pedidos_vendedor($LOTE)"
erro L1 "lote vazio" 22023 "PEDIDOS_VENDEDOR_LOTE" "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000f1'; SELECT * FROM public.pedidos_vendedor(ARRAY[]::uuid[])"
erro L2 "lote de 1001" 22023 "PEDIDOS_VENDEDOR_LOTE" "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000f1'; SELECT * FROM public.pedidos_vendedor(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1001)))"

echo "═══ $PASS ✅ · $FAIL ❌ (esperado $TOTAL_ESPERADO ✅) ═══"
[ "$FAIL" = 0 ] && [ "$PASS" = "$TOTAL_ESPERADO" ] || exit 1
echo "PROVA_PEDIDOS_VENDEDOR_OK"

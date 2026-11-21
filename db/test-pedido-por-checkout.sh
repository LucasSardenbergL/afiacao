#!/usr/bin/env bash
# test-pedido-por-checkout.sh — prova PG17 da migration 20261121160000_pedido_por_checkout.sql
# ================================================================================================
# Checkout pelo app: ensureSalesOrderRow lia sales_orders.omie_response pelo PostgREST e tomava 403
# (coluna fechada para authenticated) — todo checkout falhava na 1ª chamada. A leitura passa a ser
# pela RPC pedido_por_checkout(uuid, text).
#
# Banco: stubs + schema-snapshot da prod + ACL de prod de sales_orders (medida via psql-ro em
# 2026-11-21) + a migration REAL (cópia — a sabotagem age na cópia).
#
#   MIG   a migration aplica com a POS verde; MIG2 re-aplicar é seguro (idempotente)
#   K1    a CAUSA do bug: o select do front (id, omie_pedido_id, omie_response) → 42501 para employee
#   K2    controle de K1: sem omie_response o mesmo employee lê a linha (só a coluna é fechada)
#   R1    employee, PV reconciliado → pv_reconciliado=t e pv_consulta = a consulta (não o resto)
#   R2    envio normal (sem `reconciled`) → f, consulta NULL · R3 rascunho (sem PID/resposta) → f
#   R4    `reconciled` = "true" (string) NÃO conta — o mesmo `=== true` do front
#   R5    par inexistente → 0 linhas · R6 outra account → 0 linhas
#   R7    master passa · R8 service_role passa
#   G1    customer → 42501 PEDIDO_POR_CHECKOUT_ACESSO · G2 anon → 42501 (sem EXECUTE)
#   G3    authenticated sem uid → 42501 PEDIDO_POR_CHECKOUT_ACESSO
#   A1    checkout_id NULL → 22023 PEDIDO_POR_CHECKOUT_ARGS · A2 account vazia → 22023
#
# Uso:  bash db/test-pedido-por-checkout.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 bash db/test-pedido-por-checkout.sh   (2º locale)
#       bash db/test-pedido-por-checkout.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5831}"
SLUG="pedido-por-checkout"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261121160000_pedido_por_checkout.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=17

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS:VERDES-de-controle   (ID!MARCA = vermelho de execução com a marca)
  SABOTAGENS="sem_gate:G1,G3:R1,R7
              sem_args:A1,A2:R1
              reconciled_frouxo:R4:R1,R2
              consulta_crua:R1:R2,R3
              sem_account:R6:R1
              invoker:R1,R7:K2
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
# ACL de prod de sales_orders (psql-ro 2026-11-21, has_column_privilege por coluna): SELECT/UPDATE
# por coluna, nunca table-level; omie_response FORA do SELECT.
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE SELECT, UPDATE ON public.sales_orders FROM authenticated;
GRANT SELECT (id, customer_user_id, created_by, items, subtotal, discount, total, status, notes, omie_pedido_id,
              omie_numero_pedido, created_at, updated_at, account, hash_payload, customer_address, customer_phone,
              ready_by_date, deleted_at, order_date_kpi, checkout_id, origem, atendimento_id, customer_document)
  ON public.sales_orders TO authenticated;
GRANT UPDATE (items, subtotal, total, status, notes, customer_address, customer_phone, ready_by_date, deleted_at,
              customer_document) ON public.sales_orders TO authenticated;
SQL
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
  sem_gate)          sabotar 's/  IF NOT \(coalesce\(auth\.role\(\)/  IF false AND NOT (coalesce(auth.role()/'; desliga_pos ;;
  sem_args)          sabotar "s/IF p_checkout_id IS NULL OR coalesce\\(btrim\\(p_account\\), ''\\) = '' THEN/IF false THEN/"; desliga_pos ;;
  reconciled_frouxo) sabotar "s/-> 'reconciled' = 'true'::jsonb/-> 'reconciled' IS NOT NULL/g"; desliga_pos ;;
  consulta_crua)     sabotar "s/THEN so\\.omie_response -> 'consulta' END/THEN so.omie_response END/"; desliga_pos ;;
  sem_account)       sabotar 's/\n\s+AND so\.account = p_account;/;/'; desliga_pos ;;
  invoker)           sabotar 's/^SECURITY DEFINER$/SECURITY INVOKER/m'; desliga_pos ;;
  pos_grant_coluna)  sabotar "s/^(GRANT EXECUTE ON FUNCTION public\\.pedido_por_checkout.*)\$/\$1\\nGRANT SELECT (omie_response) ON public.sales_orders TO authenticated;/m" ;;
  pos_anon)          sabotar 's/TO authenticated, service_role;/TO authenticated, service_role, anon;/' ;;
  pos_invoker)       sabotar 's/^SECURITY DEFINER$/SECURITY INVOKER/m' ;;
  *) echo "INFRA: sabotagem desconhecida '$SABOTAGEM'"; exit 2 ;;
esac

# ── MIG ────────────────────────────────────────────────────────────────────────────────────────
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG migration aplica (POS verde)"; else bad "MIG migration falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG2 re-aplicar é seguro"; else bad "MIG2 re-aplicar falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi

# ── semente ────────────────────────────────────────────────────────────────────────────────────
# ck…01 reconciliado (PV com 1 linha) · ck…02 envio normal · ck…03 rascunho · ck…04 "true" string
P -q <<'SQL' >/dev/null
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000f1'),  -- master
  ('00000000-0000-0000-0000-0000000000e1'),  -- employee
  ('00000000-0000-0000-0000-0000000000c1');  -- cliente
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'master'), ('00000000-0000-0000-0000-0000000000e1', 'employee'),
  ('00000000-0000-0000-0000-0000000000c1', 'customer');
INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, total, status, account, checkout_id,
                                 omie_pedido_id, omie_response)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', '[]', 1, 1, 'enviado', 'oben',
        'cc000000-0000-0000-0000-000000000001', 9001,
        '{"reconciled": true, "segredo": "x", "consulta": {"pedido_venda_produto": {"det": [{"produto": {"codigo_produto": 7, "quantidade": 3}}]}}}'),
       ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', '[]', 1, 1, 'enviado', 'oben',
        'cc000000-0000-0000-0000-000000000002', 9002, '{"codigo_pedido": 9002}'),
       ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', '[]', 1, 1, 'rascunho', 'oben',
        'cc000000-0000-0000-0000-000000000003', NULL, NULL),
       ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', '[]', 1, 1, 'enviado', 'oben',
        'cc000000-0000-0000-0000-000000000004', 9004, '{"reconciled": "true", "consulta": {"det": []}}');
SQL

EMP=00000000-0000-0000-0000-0000000000e1
# linha → "id|pid|reconciliado|consulta" (ou "0 linhas")
rpc() { # $1 uid ('' = sem uid), $2 role, $3 checkout, $4 account
  Pq -c "SET ROLE ${5:-authenticated}; SET test.uid = '$1'; SET test.role = '$2'; SELECT coalesce(string_agg(id || '|' || coalesce(omie_pedido_id::text, '-') || '|' || pv_reconciliado || '|' || coalesce(pv_consulta::text, '-'), ';'), '0 linhas') FROM public.pedido_por_checkout('$3', '$4')" 2>&1 | tail -1
}
CONSULTA='{"pedido_venda_produto": {"det": [{"produto": {"quantidade": 3, "codigo_produto": 7}}]}}'

erro K1 "o select do front pede omie_response → 42501 (a causa do 403)" 42501 "permission denied" "SET ROLE authenticated; SET test.uid = '$EMP'; SELECT id, omie_pedido_id, omie_response FROM public.sales_orders WHERE checkout_id = 'cc000000-0000-0000-0000-000000000001'"
eq K2 "sem omie_response o employee lê a linha" "$(Pq -c "SET ROLE authenticated; SET test.uid = '$EMP'; SELECT id || '|' || omie_pedido_id FROM public.sales_orders WHERE checkout_id = 'cc000000-0000-0000-0000-000000000001'" 2>&1 | tail -1)" "10000000-0000-0000-0000-000000000001|9001"
eq R1 "employee, PV reconciliado → só a consulta" "$(rpc $EMP authenticated cc000000-0000-0000-0000-000000000001 oben)" "10000000-0000-0000-0000-000000000001|9001|true|$CONSULTA"
eq R2 "envio normal → não reconciliado, consulta NULL" "$(rpc $EMP authenticated cc000000-0000-0000-0000-000000000002 oben)" "10000000-0000-0000-0000-000000000002|9002|false|-"
eq R3 "rascunho → sem PID, não reconciliado" "$(rpc $EMP authenticated cc000000-0000-0000-0000-000000000003 oben)" "10000000-0000-0000-0000-000000000003|-|false|-"
eq R4 "reconciled \"true\" (string) não conta" "$(rpc $EMP authenticated cc000000-0000-0000-0000-000000000004 oben)" "10000000-0000-0000-0000-000000000004|9004|false|-"
eq R5 "par inexistente → 0 linhas" "$(rpc $EMP authenticated cc000000-0000-0000-0000-0000000000ff oben)" "0 linhas"
eq R6 "outra account → 0 linhas" "$(rpc $EMP authenticated cc000000-0000-0000-0000-000000000001 colacor)" "0 linhas"
eq R7 "master passa" "$(rpc 00000000-0000-0000-0000-0000000000f1 authenticated cc000000-0000-0000-0000-000000000003 oben)" "10000000-0000-0000-0000-000000000003|-|false|-"
eq R8 "service_role passa" "$(rpc '' service_role cc000000-0000-0000-0000-000000000003 oben service_role)" "10000000-0000-0000-0000-000000000003|-|false|-"
erro G1 "customer barrado" 42501 "PEDIDO_POR_CHECKOUT_ACESSO" "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000c1'; SELECT * FROM public.pedido_por_checkout('cc000000-0000-0000-0000-000000000001', 'oben')"
erro G2 "anon sem EXECUTE" 42501 "permission denied" "SET ROLE anon; SELECT * FROM public.pedido_por_checkout('cc000000-0000-0000-0000-000000000001', 'oben')"
erro G3 "authenticated sem uid barrado" 42501 "PEDIDO_POR_CHECKOUT_ACESSO" "SET ROLE authenticated; SELECT * FROM public.pedido_por_checkout('cc000000-0000-0000-0000-000000000001', 'oben')"
erro A1 "checkout_id NULL" 22023 "PEDIDO_POR_CHECKOUT_ARGS" "SET ROLE authenticated; SET test.uid = '$EMP'; SELECT * FROM public.pedido_por_checkout(NULL, 'oben')"
erro A2 "account vazia" 22023 "PEDIDO_POR_CHECKOUT_ARGS" "SET ROLE authenticated; SET test.uid = '$EMP'; SELECT * FROM public.pedido_por_checkout('cc000000-0000-0000-0000-000000000001', '  ')"

echo "═══ $PASS ✅ · $FAIL ❌ (esperado $TOTAL_ESPERADO ✅) ═══"
[ "$FAIL" = 0 ] && [ "$PASS" = "$TOTAL_ESPERADO" ] || exit 1
echo "PROVA_PEDIDO_POR_CHECKOUT_OK"

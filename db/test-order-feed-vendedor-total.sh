#!/usr/bin/env bash
# test-order-feed-vendedor-total.sh — prova PG17 da migration 20261123120000_order_feed_vendedor_total.sql
# ================================================================================================
# /sales PR D: "Meus pedidos" (pedidos_ids_do_vendedor + order_feed_do_vendedor) e o valor do
# recorte (order_feed_total). A soma NÃO pode divergir dos filtros da listagem.
#
# Banco: stubs + schema-snapshot da prod + 20261113120000 (colunas do vendedor) + 20261102160821
# (corpo vivo da view) + a ACL de prod de sales_orders (SELECT por coluna, vendedor FORA) + a
# migration REAL (cópia — a sabotagem age na cópia). `total` perde o NOT NULL só aqui, para
# exercitar o "sem valor" (a view e a RPC não podem fabricar 0 quando um total faltar).
#
#   MIG   aplica com a PÓS verde · MIG2 re-aplicar é seguro
#   K1    authenticated segue SEM ler sales_orders.vendedor_user_id direto (fecho por coluna)
#   K2    staff lê order_feed normal (a view não passou a exigir a coluna fechada)
#   V1    master: "Meus" de V1 = só pedidos com vendedor_user_id = V1 (não created_by, não
#         excluído, não afiação) · V2 employee também lê
#   G1    customer → 42501 PEDIDOS_IDS_DO_VENDEDOR_ACESSO · G2 anon sem EXECUTE no total
#   G3    p_vendedor nulo → 22023 PEDIDOS_IDS_DO_VENDEDOR_PARAM (nulo nunca vira "todos")
#   N1    recorte vazio → 0 pedidos, soma NULL · N2 só sem-valor → soma NULL, sem_total 1
#   N3    mistura → soma dos conhecidos arredondada, sem_total 1
#   P1    período em São Paulo: inclui 00:00Z (data-pura Omie) e 03:00Z, exclui 02:59:59Z
#   R1    customer chamando o total vê só os próprios pedidos (SECURITY INVOKER: RLS vale)
#   PAR   paridade: em 384 recortes, a RPC = count/soma/sem-total das linhas que os filtros da
#         listagem (traduzidos operador a operador do PostgREST) devolvem
#
# Uso:  bash db/test-order-feed-vendedor-total.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 HARNESS_TZ=America/Sao_Paulo bash db/test-order-feed-vendedor-total.sh
#       bash db/test-order-feed-vendedor-total.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5831}"
SLUG="order-feed-vendedor-total"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
TZ_PG="${HARNESS_TZ:-UTC}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261123120000_order_feed_vendedor_total.sql"
MIG_VENDEDOR="$REPO_ROOT/supabase/migrations/20261113120000_vendedor_pedido_omie.sql"
MIG_VIEW="$REPO_ROOT/supabase/migrations/20261102160821_order_feed_sem_cte.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=15

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS:VERDES-de-controle   (ID!MARCA = vermelho de execução com a marca)
  SABOTAGENS="sem_gate:G1:V1,K2
              created_by:V1:K2,PAR
              sem_param:G3:V1
              busca_fora:PAR:N3,R1
              vend_sem_conta:PAR:N1
              periodo_sem_puros:P1,PAR:N3
              zero_fabricado:N1,N2:V1
              definer_total:R1:N3
              pos_anon:MIG!POS_FALHOU
              grant_coluna:MIG!POS_FALHOU,K1"
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
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c TimeZone=$TZ_PG" -l "$TMPD/pg.log" -w start >/dev/null
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
P -q -f "$MIG_VENDEDOR" >/dev/null 2>"$TMPD/pre.err" || { echo "INFRA: 20261113120000 não aplicou"; tail -5 "$TMPD/pre.err"; exit 1; }
# O snapshot traz um corpo de view anterior (md5 diferente); a PRE da 20261102160821 o recusaria,
# então ela sai da cópia — o que importa aqui é o corpo VIVO da prod, que é o desta migration.
perl -0pe 's/DO \$pre\$.*?\$pre\$;//s' "$MIG_VIEW" > "$TMPD/view.sql"
P -q -f "$TMPD/view.sql" >/dev/null 2>"$TMPD/view.err" || { echo "INFRA: 20261102160821 não aplicou"; tail -5 "$TMPD/view.err"; exit 1; }
# ACL de prod (psql-ro, 2026-11-23): sales_orders por COLUNA, vendedor_user_id fora; o resto table-level.
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE SELECT, UPDATE ON public.sales_orders FROM authenticated;
GRANT SELECT (id, customer_user_id, created_by, items, subtotal, total, status, omie_pedido_id, omie_numero_pedido,
              created_at, account, deleted_at) ON public.sales_orders TO authenticated;
GRANT SELECT ON public.orders, public.profiles, public.order_feed TO authenticated;
-- Só no harness: total ausente (a prod tem NOT NULL hoje; a tela não pode depender disso).
ALTER TABLE public.sales_orders ALTER COLUMN total DROP NOT NULL;
SQL
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL, TimeZone=$TZ_PG${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"

MIG="$TMPD/mig.sql"
cp "$MIG_ORIG" "$MIG"
sabotar() { # $1 = expressão perl; exige que MUDE o arquivo (sabotagem que não casa = teatro)
  local antes depois
  antes="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  perl -0pi -e "$1" "$MIG"
  depois="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  [ "$antes" != "$depois" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
# A PÓS mede ACL; nas sabotagens de comportamento ela fica de pé (nenhuma delas mexe em ACL).
case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate)          sabotar 's/  IF NOT \(coalesce\(auth\.role\(\)/  IF false AND NOT (coalesce(auth.role()/' ;;
  created_by)        sabotar 's/WHERE so\.vendedor_user_id = p_vendedor/WHERE COALESCE(so.vendedor_user_id, so.created_by) = p_vendedor/' ;;
  sem_param)         sabotar 's/IF p_vendedor IS NULL THEN\n    RAISE EXCEPTION .PEDIDOS_IDS_DO_VENDEDOR_PARAM/IF false THEN\n    RAISE EXCEPTION \x27PEDIDOS_IDS_DO_VENDEDOR_PARAM/' ;;
  busca_fora)        sabotar 's/\n        AND \(p_busca    IS NULL OR f\.busca ILIKE p_busca\);\n  ELSE/;\n  ELSE/' ;;
  vend_sem_conta)    sabotar 's/(FROM public\.order_feed_do_vendedor\(p_vendedor\) f\n      WHERE )\(p_account  IS NULL OR f\.account = p_account\)\n        AND /$1/' ;;
  periodo_sem_puros) sabotar 's/ OR f\.created_at = ANY \(COALESCE\(p_puros, .\{\}.::timestamptz\[\]\)\)//g' ;;
  zero_fabricado)    sabotar 's/round\(sum\(f\.total\), 2\)/round(COALESCE(sum(f.total), 0), 2)/g' ;;
  definer_total)     sabotar 's/(RETURNS TABLE \(pedidos bigint, soma numeric, sem_total bigint\)\nLANGUAGE plpgsql\nSTABLE\n)SECURITY INVOKER/${1}SECURITY DEFINER/' ;;
  pos_anon)          sabotar 's/(GRANT EXECUTE ON FUNCTION public\.order_feed_total\([^)]*\) TO authenticated, service_role);/$1, anon;/' ;;
  grant_coluna)      sabotar 's/^(GRANT EXECUTE ON FUNCTION public\.pedidos_ids_do_vendedor\(uuid\).*)$/$1\nGRANT SELECT (vendedor_user_id) ON public.sales_orders TO authenticated;/m' ;;
  *) echo "INFRA: sabotagem desconhecida '$SABOTAGEM'"; exit 2 ;;
esac

# ── MIG ──────────────────────────────────────────────────────────────────────────────────────────
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG migration aplica (POS verde)"; else bad "MIG migration falhou: $(printf '%s' "$out" | grep -m1 ERROR | sed 's/POS FALHOU/POS_FALHOU/')"; fi
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG2 re-aplicar é seguro"; else bad "MIG2 re-aplicar falhou: $(printf '%s' "$out" | grep -m1 ERROR | sed 's/POS FALHOU/POS_FALHOU/')"; fi

# ── seed ─────────────────────────────────────────────────────────────────────────────────────────
# M master · E employee · V1/V2 vendedores (employee) · C1/C2 clientes.
P -q <<'SQL' >/dev/null
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000f1'), ('00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2')
ON CONFLICT DO NOTHING;
DELETE FROM public.user_roles WHERE user_id::text LIKE '00000000-0000-0000-0000-0000000000%';
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'master'),   ('00000000-0000-0000-0000-0000000000e1', 'employee'),
  ('00000000-0000-0000-0000-0000000000a1', 'employee'), ('00000000-0000-0000-0000-0000000000a2', 'employee'),
  ('00000000-0000-0000-0000-0000000000c1', 'customer'), ('00000000-0000-0000-0000-0000000000c2', 'customer');
INSERT INTO public.profiles (id, user_id, name, document, is_approved) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1', 'ALICE LTDA',        '11.111.111/0001-11', true),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000c2', 'JOÃO &amp; FILHOS', '22.222.222/0001-22', true);
-- s1 V1 oben faturado, data-pura 00:00Z do dia 10 · s2 V1 colacor cancelado 02:59:59Z (véspera em SP)
-- s3 V2 oben faturado 03:00Z (meia-noite de SP) · s4 SEM vendedor, criado por V1 (wizard não lido)
-- s5 V1 EXCLUÍDO · s6 V1 oben rascunho SEM total · o1 afiação de C1 ao meio-dia UTC
INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, total, status, account, created_at,
                                 deleted_at, vendedor_user_id, vendedor_omie_codigo, vendedor_lido_em) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
   '[{"descricao":"Verniz PU","quantidade":2}]', 100.005, 100.005, 'faturado', 'oben', '2026-11-10 00:00:00+00',
   NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
   '[{"descricao":"Seladora","quantidade":1}]', 50, 50, 'cancelado', 'colacor', '2026-11-10 02:59:59+00',
   NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1',
   '[{"descricao":"Verniz Fosco","quantidade":3}]', 70, 70, 'faturado', 'oben', '2026-11-10 03:00:00+00',
   NULL, '00000000-0000-0000-0000-0000000000a2', 842, now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1',
   '[{"descricao":"Thinner","quantidade":1}]', 30, 30, 'enviado', 'colacor', '2026-11-11 15:00:00+00',
   NULL, NULL, NULL, NULL),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
   '[]', 999, 999, 'faturado', 'oben', '2026-11-11 10:00:00+00',
   now(), '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
   '[]', 0, NULL, 'rascunho', 'oben', '2026-11-12 09:00:00+00',
   NULL, '00000000-0000-0000-0000-0000000000a1', 841, now());
INSERT INTO public.orders (id, user_id, delivery_option, service_type, items, status, subtotal, total, created_at) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'retirada', 'afiacao',
   '[{"category":"Afiacao Serra","quantity":1}]', 'em_afiacao', 40, 40, '2026-11-10 12:00:00+00');
SQL

M=00000000-0000-0000-0000-0000000000f1
como() { # $1 uid, $2 sql → última linha
  Pq -c "SET ROLE authenticated; SET test.uid = '$1'; SET test.role = 'authenticated'; $2" 2>&1 | tail -1
}
V1=00000000-0000-0000-0000-0000000000a1
TOT="SELECT pedidos || '|' || coalesce(soma::text, '') || '|' || sem_total FROM public.order_feed_total"

erro K1 "authenticated não lê vendedor_user_id direto" 42501 "permission denied" "SET ROLE authenticated; SELECT vendedor_user_id FROM public.sales_orders"
eq K2 "staff lê order_feed (vivos + afiação)" "$(como $M "SELECT count(*) FROM public.order_feed")" "6"
IDS="SELECT string_agg(right(id::text, 2), ',' ORDER BY id) FROM public.order_feed_do_vendedor('$V1')"
eq V1 "master: Meus de V1 = só vendedor_user_id (sem s4/s5/afiação)" "$(como $M "$IDS")" "01,02,06"
eq V2 "employee lê os Meus de V1" "$(como 00000000-0000-0000-0000-0000000000e1 "$IDS")" "01,02,06"
erro G1 "customer barrado no vendedor" 42501 "PEDIDOS_IDS_DO_VENDEDOR_ACESSO" "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000c1'; SELECT * FROM public.order_feed_do_vendedor('$V1')"
erro G2 "anon sem EXECUTE no total" 42501 "permission denied" "SET ROLE anon; SELECT * FROM public.order_feed_total()"
erro G3 "p_vendedor nulo recusado" 22023 "PEDIDOS_IDS_DO_VENDEDOR_PARAM" "SET ROLE authenticated; SET test.uid = '$M'; SELECT * FROM public.order_feed_do_vendedor(NULL)"
eq N1 "recorte vazio: 0 pedidos, soma ausente" "$(como $M "$TOT(p_customer => gen_random_uuid())")" "0||0"
eq N2 "só sem valor: soma ausente" "$(como $M "$TOT(p_status => '{rascunho}', p_vendedor => '$V1')")" "1||1"
eq N3 "mistura: soma dos conhecidos (100,005+50 → 150,01) e 1 sem valor" \
  "$(como $M "$TOT(p_customer => '00000000-0000-0000-0000-0000000000c1', p_vendedor => '$V1')")" "3|150.01|1"
# Corte de "hoje" em São Paulo no dia 10: meia-noite local = 03:00Z; a data-pura 00:00Z entra.
eq P1 "período SP: 00:00Z e 03:00Z entram, 02:59:59Z não" \
  "$(como $M "$TOT(p_desde => '2026-11-10 03:00:00+00', p_puros => '{2026-11-10 00:00:00+00}')")" "5|240.01|1"
eq R1 "customer vê só os próprios (RLS da view)" \
  "$(como 00000000-0000-0000-0000-0000000000c1 "$TOT()")" "4|190.01|1"

# ── PAR: paridade soma × filtros da listagem ──────────────────────────────────────────────────────
# "Esperado" = as linhas que a listagem traz, com os filtros escritos como o PostgREST os traduz:
# .eq → =, .in → IN, .or(created_at.gte.X,created_at.eq.Y) → (>= X OR = Y), .ilike → ILIKE.
# A fonte com ?meus=1 é a MESMA função da listagem (V1 prova o conteúdo dela).
PAR="$(Pq -c "SET ROLE authenticated; SET test.uid = '$M'; SET test.role = 'authenticated';" -c "
DO \$par\$
DECLARE
  a text; s text[]; per int; c uuid; b text; v uuid; r record; e record;
  n int := 0; dif int := 0; cheios int := 0; primeiro text;
BEGIN
  FOREACH a IN ARRAY ARRAY[NULL, 'oben', 'colacor_sc'] LOOP
  FOR si IN 1..4 LOOP
    s := (ARRAY[NULL, '{faturado,entregue}', '{rascunho}', '{cancelado}']::text[])[si]::text[];
  FOR per IN 0..1 LOOP
  FOREACH c IN ARRAY ARRAY[NULL, '00000000-0000-0000-0000-0000000000c1']::uuid[] LOOP
  FOREACH b IN ARRAY ARRAY[NULL, '%alice%', '%joao & filhos%', '%verniz%'] LOOP
  FOREACH v IN ARRAY ARRAY[NULL, '$V1']::uuid[] LOOP
    n := n + 1;
    SELECT * INTO r FROM public.order_feed_total(a, s,
      CASE WHEN per = 1 THEN '2026-11-10 03:00:00+00'::timestamptz END,
      CASE WHEN per = 1 THEN '{2026-11-10 00:00:00+00}'::timestamptz[] END, c, b, v);
    SELECT count(*)::bigint AS pedidos, round(sum(l.total), 2) AS soma,
           count(*) FILTER (WHERE l.total IS NULL)::bigint AS sem_total INTO e
    FROM (SELECT * FROM public.order_feed WHERE v IS NULL
          UNION ALL SELECT * FROM public.order_feed_do_vendedor(v) WHERE v IS NOT NULL) l
    WHERE (a IS NULL OR l.account = a)
      AND (s IS NULL OR l.status IN (SELECT unnest(s)))
      AND (per = 0 OR (l.created_at >= '2026-11-10 03:00:00+00' OR l.created_at = '2026-11-10 00:00:00+00'))
      AND (c IS NULL OR l.customer_user_id = c)
      AND (b IS NULL OR l.busca ILIKE b);
    IF e.pedidos > 0 THEN cheios := cheios + 1; END IF;
    IF (r.pedidos, r.soma, r.sem_total) IS DISTINCT FROM (e.pedidos, e.soma, e.sem_total) THEN
      dif := dif + 1;
      primeiro := coalesce(primeiro, format('a=%s s=%s per=%s c=%s b=%s v=%s rpc=%s lista=%s', a, s, per, c, b, v, r, e));
    END IF;
  END LOOP; END LOOP; END LOOP; END LOOP; END LOOP; END LOOP;
  RAISE NOTICE 'PAR n=% dif=% cheios=% %', n, dif, cheios, coalesce(primeiro, '');
END
\$par\$;" 2>&1 | grep -o 'PAR n=.*' || true)"
case "$PAR" in
  "PAR n=384 dif=0 cheios="*)
    cheios="${PAR#*cheios=}"; cheios="${cheios%% *}"
    if [ "$cheios" -ge 40 ]; then ok "PAR 384 recortes, 0 divergências ($cheios não vazios)"; else bad "PAR poucos recortes com linha ($cheios) — paridade trivial"; fi ;;
  *) bad "PAR divergiu: ${PAR:-sem saída}" ;;
esac

echo "═══ $PASS ✅ · $FAIL ❌ (esperado $TOTAL_ESPERADO ✅) ═══"
[ "$FAIL" = 0 ] && [ "$PASS" = "$TOTAL_ESPERADO" ] || exit 1
echo "PROVA_ORDER_FEED_VENDEDOR_TOTAL_OK"

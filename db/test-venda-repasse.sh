#!/usr/bin/env bash
# test-venda-repasse.sh — prova PG17 da migration 20261020233000_venda_cliente_repasse.sql (Task 6)
# ================================================================================================
# Banco: stubs + schema-snapshot da prod + ACL de prod de get_defasagem_cliente + STUB da Task 2
# (private.venda_linhas_pedido copiada da prod em 2026-10-20 via pg_get_functiondef; venda_recompra
# com as colunas da prod) enquanto o PR #3248 não entra no snapshot. A migration aplicada é a REAL
# (cópia; a sabotagem age na cópia — supabase/migrations/ é DR e não se toca).
#
# Casos do plano (Task 6) + os exigidos pelo parecer Codex de desenho:
#   C1   paridade: get_defasagem_cliente devolve o MESMO JSON antes/depois da extração (sem cap e com
#        cap), num lote de itens que passa por TODOS os guards (reset entre itens incluído)
#   C2   candidatos: farmer, master sem cap (simulado), estratégico e anon → 42501
#   CAND candidatos do master: defasado com sugerido + valor anual; abaixo do piso só como SINAL
#   C6   Colacor, tinta, tinta NULL e dia sem preço apurado nunca aparecem em candidatos
#   C3   aprovar: alvo < último e alvo = último → 22023; SKU tinta NULL, empresa Colacor, sem último → 22023;
#        farmer → 42501
#   AP   aprovar pelo ALIAS grava o canônico; retry idêntico = mesmo id; tela velha → 40001; substituir
#   C4   leitura da farmer: conjunto EXATO das 6 chaves; valores; alias; outra farmer, cliente e grupo com
#        2 donos → 42501; estratégico (cap_carteira) lê
#   C5   vencido some; revogado some; revogar 2x é no-op; venda posterior que alcança o alvo some
#   ACL  tabela fechada a authenticated; RPCs fechadas a anon
#
# Uso:  bash db/test-venda-repasse.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 bash db/test-venda-repasse.sh …   (rode nos DOIS locales)
#       bash db/test-venda-repasse.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# O --falsificar roda PRIMEIRO o controle (sem sabotagem, exige verde e o total) e só então cada
# sabotagem, exigindo VERMELHO exatamente nos asserts listados e VERDE nos de controle.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5791}"
SLUG="venda-repasse"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="${MIG:-$REPO_ROOT/supabase/migrations/20261020233000_venda_cliente_repasse.sql}"
MIG_DESEMP="$REPO_ROOT/supabase/migrations/20261021021500_venda_repasse_base_desempenho.sql"
MIG_DEFASAGEM="$REPO_ROOT/supabase/migrations/20261014211500_defasagem_desconto_valor.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=54

# ── Falsificação ─────────────────────────────────────────────────────────────────────────────
# nome:vermelhos:verdes. As sabotagens de corpo não tocam o que a POS confere (ACL/RLS/md5 do cockpit),
# então a migration aplica e o dente provado é o do ASSERT. As "pos_" provam o dente da POS (MIG vermelho).
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="vaza_cmc:C4a,C4t:C4b,C4c
              vaza_c_now:C4a,C4t:C4b,C4c
              sem_recusa:C3a,C3b,W1:AP1,C3c
              tinta_null:C6,C3c:CAND1,C3a
              dono_uniao:C4e,C4h:C4a,C4d
              sem_revalidar:C5d,C5b:C5a,C4b
              sem_finito:CAND1,CAND2,C4b:C4a,C4t
              ressuscita:AP5,AP6:AP4b
              retry_subst:AP4b:AP2,AP4
              media_max:W2:W1
              alvo_texto:C4t:C4a
              paridade_markup:C1b:C1a,CAND1
              gate_candidatos:C2b:C2a,C2c
              pos_acl_anon:MIG!POS_ACL_ANON
              pos_rls:MIG!POS_RLS
              autojuncao:PERF:CAND1,C4b,PERFv
              pos_janela:MIG!POS_JANELA
              pre_config:MIG!PRE_CONFIG"
  falhas=0; sab_falhas=0
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
      echo "❌ $nome: harness VERDE com a sabotagem — assert sem dente"; falhas=$((falhas+1)); sab_falhas=$((sab_falhas+1)); continue
    fi
    antes=$falhas
    # conjunto EXATO: nenhum vermelho além dos anunciados (Codex código P2) …
    falhou="$(grep -oE '^  ❌ [A-Za-z0-9]+' "$log" | awk '{print $2}' | sort -u | paste -sd, - || true)"
    anunciado="$(printf '%s\n' "$reds" | tr ',' '\n' | sed 's/!.*//' | sort -u | paste -sd, -)"
    [ "$falhou" = "$anunciado" ] || { echo "❌ $nome: vermelhos [$falhou] ≠ anunciados [$anunciado]"; falhas=$((falhas+1)); }
    # … e o mutante que aplica a migration tem de rodar a suíte INTEIRA (não abortar no meio)
    case "$reds" in
      *MIG*) ;;
      *) n_exec=$(grep -cE '^  (✅|❌) ' "$log" || true)
         [ "$n_exec" = "$TOTAL_ESPERADO" ] || { echo "❌ $nome: executou $n_exec asserts, esperado $TOTAL_ESPERADO"; falhas=$((falhas+1)); } ;;
    esac
    for a in ${reds//,/ }; do
      case "$a" in
        *!*) id="${a%%!*}"; marca="${a#*!}"   # vermelho de EXECUÇÃO: o erro tem de trazer a marca
             grep -q "^  ❌ $id .*ERROR:  $marca:" "$log" || { echo "❌ $nome: $id devia falhar com a marca $marca"; falhas=$((falhas+1)); } ;;
        *)   grep -q "^  ❌ $a " "$log" || { echo "❌ $nome: $a devia estar VERMELHO"; falhas=$((falhas+1)); } ;;
      esac
    done
    for a in ${greens//,/ }; do
      [ -n "$a" ] || continue
      grep -q "^  ✅ $a " "$log" || { echo "❌ $nome: $a (controle) devia seguir VERDE"; falhas=$((falhas+1)); }
    done
    [ "$falhas" = "$antes" ] || { sab_falhas=$((sab_falhas+1)); continue; }
    echo "  ✅ $nome → vermelho em [$reds]${greens:+, verde em [$greens]}"
  done
  echo "SABOTAGENS: $((i - sab_falhas)) vermelhas / $sab_falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" = 0 ] || { echo "❌ FALSIFICAÇÃO FALHOU ($falhas)"; exit 1; }
  echo "✅ FALSIFICAÇÃO OK — todas as sabotagens ficaram vermelhas onde deviam"
  exit 0
fi

# ── arranque PG17 descartável ────────────────────────────────────────────────────────────────
# shellcheck disable=SC1091  # caminho dinâmico ($REPO_ROOT); o gate roda sem -x, como nas demais provas
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

# ZONA 1 — schema de prod: stubs + prelude + snapshot
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
# ACL de prod (psql-ro, 2026-10-20) — o snapshot vem sem privilégios
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE ALL ON FUNCTION public.get_defasagem_cliente(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_defasagem_cliente(jsonb,uuid) TO authenticated, service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
SQL
# o snapshot ainda pode trazer o predecessor do predecessor (a03eb600…): sobe a 20261014211500 primeiro
MD5_SNAP="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")"
if [ "$MD5_SNAP" = "a03eb600ef0d2a946e550aa55bba415e" ]; then
  P -q -f "$MIG_DEFASAGEM" >/dev/null 2>&1 || { echo "INFRA: 20261014211500 não aplicou"; exit 1; }
fi
# STUB da Task 2 (só se o snapshot ainda não a tiver): definição EXATA da prod (2026-10-20)
P -q <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS public.venda_recompra (
  comprador_id uuid NOT NULL, empresa text NOT NULL, omie_codigo_produto bigint NOT NULL, product_id uuid,
  n_pedidos integer, cadencia_dias numeric, qtd_sugerida numeric, ultima_compra date, ultimo_preco numeric,
  due_ratio numeric, atrasado boolean, valor_esperado numeric, data_referencia date, calculado_em timestamptz);
DO $stub$
BEGIN
  IF to_regprocedure('private.venda_linhas_pedido(date)') IS NULL THEN
    EXECUTE $def$
CREATE FUNCTION private.venda_linhas_pedido(p_ate date)
 RETURNS TABLE(comprador_id uuid, empresa text, omie_codigo_produto bigint, product_id uuid, quantidade numeric, preco_unit_liquido numeric, data_pedido date, sales_order_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.comprador_id, x.empresa, x.omie_codigo_produto, x.product_id,
         x.quantidade, x.preco_unit_liquido, x.data_pedido, x.sales_order_id
    FROM (
      SELECT COALESCE(a.canonical_user_id, so.customer_user_id) AS comprador_id,
             so.account AS empresa,
             oi.omie_codigo_produto,
             oi.product_id,
             oi.quantity AS quantidade,
             CASE WHEN oi.desconto_valor IS NULL OR oi.unit_price IS NULL THEN NULL
                  ELSE oi.unit_price - oi.desconto_valor / oi.quantity
             END AS preco_unit_liquido,
             COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido,
             so.id AS sales_order_id
        FROM public.order_items oi
        JOIN public.sales_orders so ON so.id = oi.sales_order_id
        LEFT JOIN public.customer_canonical_alias a
               ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
       WHERE so.deleted_at IS NULL
         AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
         AND so.customer_user_id IS NOT NULL
         AND so.account IN ('oben', 'colacor', 'colacor_sc')
         AND oi.omie_codigo_produto IS NOT NULL
         AND oi.quantity > 0
    ) x
   WHERE x.data_pedido < p_ate
$function$$def$;
    REVOKE ALL ON FUNCTION private.venda_linhas_pedido(date) FROM PUBLIC;
  END IF;
END $stub$;
REVOKE ALL ON TABLE public.venda_recompra FROM PUBLIC, anon, authenticated;
SQL
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"

MD5_PRE="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")"
eq H0 "predecessor = corpo medido na prod" "$MD5_PRE" "2ed6e15998b5c48e7b4de590e5dbbaf3"
ACL_ANTES="$(Pq -c "SELECT provolatile::text||'|'||prosecdef::text||'|'||coalesce(array_to_string(proconfig,','),'-')||'|'||coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(proacl) a),'NULL') FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")"

# ZONA 2 — semente (replica: sem gatilhos/FKs; a semente não é o objeto sob prova)
P -q <<'SQL' >/dev/null
ALTER TABLE public.sales_orders DISABLE TRIGGER ALL;
ALTER TABLE public.order_items  DISABLE TRIGGER ALL;
SET session_replication_role = replica;
CREATE FUNCTION pg_temp.compra(p_cli uuid, p_cod bigint, p_acc text, p_dia date, p_qty numeric, p_unit numeric, p_desc numeric)
RETURNS void LANGUAGE plpgsql AS $c$
DECLARE so uuid := gen_random_uuid(); n bigint;
BEGIN
  n := nextval('pg_temp.seq_ped');
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi,
                                   omie_pedido_id, omie_numero_pedido, total, discount)
    VALUES (so, p_cli, p_cli, p_acc, 'faturado', p_dia, n, n::text, 1000, 0);
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, desconto_valor)
    VALUES (so, p_cli, p_cod, p_qty, p_unit, 0, p_desc);
END $c$;
CREATE SEQUENCE pg_temp.seq_ped START 880000;
CREATE FUNCTION pg_temp.custo(p_cod bigint, p_acc text, p_dia_snap date, p_c_last numeric, p_c_now numeric, p_synced timestamptz)
RETURNS void LANGUAGE plpgsql AS $c$
BEGIN
  IF p_c_now IS NOT NULL THEN
    INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at) VALUES (p_cod, p_c_now, p_acc, p_synced);
  END IF;
  IF p_c_last IS NOT NULL THEN
    INSERT INTO public.cmc_snapshot (omie_codigo_produto, account, data_posicao, cmc, synced_at) VALUES (p_cod, p_acc, p_dia_snap, p_c_last, now());
  END IF;
END $c$;
DO $seed$
DECLARE
  hoje  date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  d30   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30;
  d90   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - 90;
  d600  date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - 600;
  cp    uuid := md5('vr:paridade')::uuid;
  can   uuid := md5('vr:canonico')::uuid;
  ali   uuid := md5('vr:alias')::uuid;
  can2  uuid := md5('vr:canonico2')::uuid;
  ali2  uuid := md5('vr:alias2')::uuid;
  staff uuid := md5('vr:staff')::uuid;
  mst   uuid := md5('vr:master')::uuid;
  far   uuid := md5('vr:farmer')::uuid;
  far2  uuid := md5('vr:farmer2')::uuid;
  est   uuid := md5('vr:estrategico')::uuid;
  r record;
BEGIN
  INSERT INTO public.user_roles (user_id, role) VALUES
    (staff,'employee'), (mst,'master'), (far,'employee'), (far2,'employee'), (est,'employee'), (can,'customer');
  INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (est, 'estrategico');
  INSERT INTO public.company_config (key, value) VALUES ('regua_preco_aliquota_venda_oben', '0.078');
  INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, status) VALUES
    (ali, can, 'active'), (ali2, can2, 'active');
  INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source, eligible) VALUES
    (can, far, 'omie', true),
    (can2, far, 'omie', true), (ali2, far2, 'omie', true);   -- grupo 2 com DOIS donos

  -- ── paridade (cliente cp, Oben): um SKU por guard ──
  -- cod, dia âncora, qty, unit, desconto, c_last (no dia), c_now, synced
  FOR r IN SELECT * FROM (VALUES
      (8002, d30, 10, 100, 5,    60, 80, now()),                       -- desconto_nao_provado
      (8003, d30, 10, 100, 0,    60, 80, now() - interval '72 hours'), -- sem_custo_atual_fresco
      (8004, d30, 10, 100, 0,  NULL, 80, now()),                       -- sem_custo_historico
      (8005, d30, 10,   0, 0,    60, 80, now()),                       -- sem_base (preço 0)
      (8006, d30, 10, 100, 0,    60, 80, now()),                       -- qty_divergente (carrinho 1000)
      (8007, d600,10, 100, 0,    60, 80, now()),                       -- ancora_antiga
      (8008, d30, 10, 100, 0,    50, 80, now()),                       -- quarentena_custo
      (8009, d30, 10,  50, 0,    60, 80, now()),                       -- prejuizo_ancora
      (8010, d30, 10, 100, 0,    60, 60, now()),                       -- custo_nao_subiu
      (8011, d30, 10, 100, 0,    60, 61, now()),                       -- alta_ruido
      (8012, d30, 10, 100, 0,    60, 80, now()),                       -- defasado (+ item sem preço)
      (8013, d30, 10, 100, 0,    60, 80, now()),                       -- preco_acompanhou (carrinho 133)
      (8014, d30, 10,  10, 0,     6, 6.3, now())                       -- gap_abaixo_do_piso (carrinho 10)
    ) AS x(cod, dia, qty, unit, dsc, c_last, c_now, synced)
  LOOP
    PERFORM pg_temp.compra(cp, r.cod, 'oben', r.dia, r.qty, r.unit, r.dsc);
    PERFORM pg_temp.compra(cp, r.cod, 'oben', r.dia - 60, 10, 90, 0);   -- compra anterior (não é âncora)
    PERFORM pg_temp.custo(r.cod, 'oben', r.dia, r.c_last, r.c_now, r.synced);
  END LOOP;

  -- ── repasse (comprador canônico can; parte das compras pelo alias) ──
  INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, is_tintometric) VALUES
    (7101,'7101','R1 lixa','oben',false), (7102,'7102','R2 base tinta','oben',true),
    (7103,'7103','R3 colacor','colacor',false), (7104,'7104','R4 abaixo piso','oben',false),
    (7105,'7105','R5 dia sem preço','oben',false), (7106,'7106','R6 tinta NULL','oben',NULL),
    (7107,'7107','R7 vencido','oben',false), (7108,'7108','R8 venda posterior','oben',false),
    (7110,'7110','R10 média ponderada','oben',false);
  FOR r IN SELECT * FROM (VALUES
      (7101, 'oben',    100, 0::numeric, 60, 80),
      (7102, 'oben',    100, 0,          60, 80),
      (7103, 'colacor', 100, 0,          60, 80),
      (7104, 'oben',     85, 0,          80, 80),
      (7105, 'oben',    100, NULL,       60, 80),
      (7106, 'oben',    100, 0,          60, 80),
      (7107, 'oben',    100, 0,          60, 80),
      (7108, 'oben',    100, 0,          60, 80)
    ) AS x(cod, acc, unit, dsc, c_last, c_now)
  LOOP
    PERFORM pg_temp.compra(can, r.cod, r.acc, d90, 10, 90, 0);
    PERFORM pg_temp.compra(ali, r.cod, r.acc, d30, 10, r.unit, r.dsc);       -- última compra: pelo ALIAS
    IF r.cod = 7105 THEN PERFORM pg_temp.compra(can, r.cod, r.acc, d30, 10, 100, 0); END IF;  -- mesmo dia, linha apurada
    PERFORM pg_temp.custo(r.cod, CASE WHEN r.acc = 'oben' THEN 'oben' ELSE 'colacor' END, d30, r.c_last, r.c_now, now());
    INSERT INTO public.venda_recompra (comprador_id, empresa, omie_codigo_produto, n_pedidos, cadencia_dias, qtd_sugerida,
                                       ultima_compra, ultimo_preco, data_referencia, calculado_em)
      VALUES (can, r.acc, r.cod, 2, 30, 10, d30, r.unit, hoje, now());
  END LOOP;
  -- R1: a conta 'oben' tem CMC Infinity sincronizado AGORA e a 'vendas' tem 80 de 1 h atrás → o lote usa 80
  UPDATE public.inventory_position SET cmc = 'Infinity' WHERE omie_codigo_produto = 7101 AND account = 'oben';
  INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at) VALUES (7101, 80, 'vendas', now() - interval '1 hour');
  -- R10: último dia com 1×(100 − 20 de desconto) + 9×120 → média ponderada do líquido = 116
  --      (MAX = 120 · média simples = 100 · cheio ponderado = 118)
  PERFORM pg_temp.compra(can, 7110, 'oben', d90, 10, 90, 0);
  PERFORM pg_temp.compra(ali, 7110, 'oben', d30, 1, 100, 20);
  PERFORM pg_temp.compra(can, 7110, 'oben', d30, 9, 120, 0);
  PERFORM pg_temp.custo(7110, 'oben', d30, 60, 80, now());
  -- grupo 2 (dois donos): uma compra só para existir base
  PERFORM pg_temp.compra(can2, 7101, 'oben', d30, 10, 100, 0);
END $seed$;
SET session_replication_role = origin;
ALTER TABLE public.sales_orders ENABLE TRIGGER ALL;
ALTER TABLE public.order_items  ENABLE TRIGGER ALL;
SQL

CP="$(Pq -c "SELECT md5('vr:paridade')::uuid")"
CAN="$(Pq -c "SELECT md5('vr:canonico')::uuid")";  ALI="$(Pq -c "SELECT md5('vr:alias')::uuid")"
CAN2="$(Pq -c "SELECT md5('vr:canonico2')::uuid")"; ALI2="$(Pq -c "SELECT md5('vr:alias2')::uuid")"
STAFF="$(Pq -c "SELECT md5('vr:staff')::uuid")";   MST="$(Pq -c "SELECT md5('vr:master')::uuid")"
FAR="$(Pq -c "SELECT md5('vr:farmer')::uuid")";    FAR2="$(Pq -c "SELECT md5('vr:farmer2')::uuid")"
EST="$(Pq -c "SELECT md5('vr:estrategico')::uuid")"
HOJE="(now() AT TIME ZONE 'America/Sao_Paulo')::date"

como() { # $1 = uid, $2 = SQL → saída (sem as linhas SET)
  Pq -c "SET test.uid='$1'; SET ROLE authenticated; $2" 2>&1 | grep -v '^SET$' || true
}
# negativo: captura SÓ a condição esperada (e a marca no SQLERRM); o resto re-lança
neg() { # $1 id, $2 descrição, $3 uid ('' = anon), $4 condição, $5 marca ('' = qualquer), $6 statement
  local papel="authenticated" out
  [ -n "$3" ] || papel="anon"
  # dentro de BEGIN … ROLLBACK: um negativo que PASSA indevidamente não deixa efeito para os asserts seguintes
  out="$(Pq -c "BEGIN; SET LOCAL test.uid='$3'; SET LOCAL ROLE $papel;
DO \$n\$ BEGIN
  $6;
  RAISE NOTICE 'NEG-PASSOU';
EXCEPTION WHEN $4 THEN RAISE NOTICE 'NEG-OK[%]', SQLERRM;
          WHEN OTHERS THEN RAISE;
END \$n\$;
ROLLBACK;" 2>&1 || true)"
  # here-string, não pipe: com pipefail, `printf | grep -q` reprova ao acaso (grep sai no 1º match → SIGPIPE 141)
  if grep -q "NEG-OK\[.*$5" <<< "$out"; then ok "$1 $2"
  else bad "$1 $2 — veio: $(printf '%s' "$out" | grep -E 'NEG-|ERROR' | head -1 | cut -c1-220)"; fi
}

# C1 (antes) — retrato do cockpit num lote que passa por todos os guards
ITENS='[{"empresa":"oben","codigo":8001,"preco":100},{"empresa":"oben","codigo":8002,"preco":100},
{"empresa":"oben","codigo":8003,"preco":100},{"empresa":"oben","codigo":8004,"preco":100},
{"empresa":"oben","codigo":8005,"preco":100},{"empresa":"oben","codigo":8006,"preco":100,"qty":1000},
{"empresa":"oben","codigo":8007,"preco":100},{"empresa":"oben","codigo":8008,"preco":100},
{"empresa":"oben","codigo":8009,"preco":100},{"empresa":"oben","codigo":8010,"preco":100},
{"empresa":"oben","codigo":8011,"preco":100},{"empresa":"oben","codigo":8012,"preco":100},
{"empresa":"oben","codigo":8013,"preco":133},{"empresa":"oben","codigo":8014,"preco":10},
{"empresa":"oben","codigo":8012},{"empresa":"colacor","codigo":8012,"preco":100},
{"empresa":"xyz","codigo":8012,"preco":100},{"empresa":"oben","codigo":8012,"preco":100,"qty":10}]'
retrato() { # $1 = uid → JSON do cockpit sem calculated_at (o único campo que depende do instante)
  como "$1" "SELECT md5(jsonb_agg(e - 'calculated_at' ORDER BY o)::text) FROM jsonb_array_elements(public.get_defasagem_cliente('$ITENS'::jsonb, '$CP'::uuid)) WITH ORDINALITY AS t(e, o)"
}
ANTES_STAFF="$(retrato "$STAFF")"; ANTES_MST="$(retrato "$MST")"
NSTAT="$(como "$MST" "SELECT count(DISTINCT e->>'motivo') FROM jsonb_array_elements(public.get_defasagem_cliente('$ITENS'::jsonb, '$CP'::uuid)) e")"
eq C0 "o lote de paridade passa por 14 motivos distintos" "$NSTAT" "14"

# ZONA 3 — a migration REAL (cópia, onde a sabotagem age)
# Duas migrations: a original (20261020233000) e a de desempenho (20261021021500), que redefine o helper do
# lote. A sabotagem age nas DUAS cópias (o helper existe nas duas); `sabotar_d` só na de desempenho.
MIGC="$TMPD/mig.sql"; MIGD="$TMPD/mig-desempenho.sql"
cp "$MIG_ORIG" "$MIGC"; cp "$MIG_DESEMP" "$MIGD"
md5de() { cat "$@" | { md5 -q 2>/dev/null || md5sum | cut -d' ' -f1; }; }
sabotar() { # $1 = sed; exige que o sed MUDE os arquivos (sabotagem que não casa = teatro)
  local antes; antes="$(md5de "$MIGC" "$MIGD")"
  sed -i.bak -E "$1" "$MIGC" "$MIGD"
  [ "$antes" != "$(md5de "$MIGC" "$MIGD")" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
sabotar_d() { # só na migration de desempenho
  local antes; antes="$(md5de "$MIGD")"
  sed -i.bak -E "$1" "$MIGD"
  [ "$antes" != "$(md5de "$MIGD")" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada (desempenho)"; exit 2; }
}
# sabotagem no CORPO do helper: a PRE/PÓS md5 da migration de desempenho viram NOTICE para o corpo chegar ao banco
desliga_md5_d() { sabotar_d "s/RAISE EXCEPTION 'P(RE|OS): /RAISE NOTICE 'P\1: /g"; }
case "${SABOTAGEM:-}" in
  "") ;;
  vaza_cmc)        sabotar "s/^( +)'valido_ate', +r\.valido_ate/\1'cmc', r.pct, 'valido_ate', r.valido_ate/" ;;
  vaza_c_now)      sabotar "s/^( +)'valido_ate', +r\.valido_ate/\1'c_now', r.pct, 'valido_ate', r.valido_ate/" ;;
  sem_recusa)      sabotar 's/^( +)IF p_preco_alvo <= v_ultimo THEN/\1IF false AND p_preco_alvo <= v_ultimo THEN/' ;;
  tinta_null)      sabotar 's/is_tintometric IS FALSE/is_tintometric IS NOT TRUE/g' ;;
  dono_uniao)      sabotar 's/AND NOT \(cardinality\(v_donos\) = 1 AND v_donos\[1\] = v_uid\)/AND NOT (v_uid = ANY (v_donos))/' ;;
  sem_revalidar)   sabotar 's/^( +)AND b\.ultimo_preco < ra\.preco_alvo$/\1AND true/' ;;
  paridade_markup) sabotar 's/^( +)markup_ant := \(p_p_last - p_c_last\) \/ p_c_last \* 100;/\1markup_ant := (p_p_last - p_c_last) \/ p_c_last * 101;/' ;;
  gate_candidatos) sabotar 's/^( +)OR NOT private\.cap_custo_ler\(v_uid\) THEN/\1THEN/' ;;
  sem_finito)      sabotar "s/AND private\.regua_num_finito\(ip\.cmc\) AND ip\.cmc > 0 /AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric /"; desliga_md5_d ;;
  ressuscita)      sabotar "s/^( +WHERE ra\.comprador_id = v_comprador AND ra\.empresa = 'oben' AND ra\.omie_codigo_produto = p_codigo)$/\1 AND ra.revogado_em IS NULL/" ;;
  retry_subst)     sabotar 's/AND v_atual\.substitui_id IS NOT DISTINCT FROM p_substitui THEN/AND p_substitui IS NULL THEN/' ;;
  media_max)       sabotar 's/^( +)sum\(l\.preco_unit_liquido \* l\.quantidade\) FILTER \(WHERE l\.preco_unit_liquido > 0\) AS soma,/\1max(l.preco_unit_liquido) * sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido > 0) AS soma,/'; desliga_md5_d ;;
  alvo_texto)      sabotar "s/^( +)'preco_alvo', +r\.preco_alvo,/\1'preco_alvo', r.preco_alvo::text,/" ;;
  pos_acl_anon)    sabotar '/^REVOKE ALL ON FUNCTION public\.venda_repasse_candidatos\(\) FROM PUBLIC, anon;/d' ;;
  pos_rls)         sabotar '/^ALTER TABLE public\.venda_repasse_aprovado ENABLE ROW LEVEL SECURITY;/d' ;;
  # o corpo NOVO não chega ao banco (fica o da autojunção): só o PERF pode ficar vermelho
  autojuncao)      sabotar_d 's/^CREATE OR REPLACE FUNCTION private\._venda_repasse_base\(p_comprador uuid\)$/CREATE OR REPLACE FUNCTION private._venda_repasse_base_sabotada(p_comprador uuid)/'
                   sabotar_d "s/RAISE EXCEPTION 'POS/RAISE NOTICE 'POS/g" ;;
  pre_config)      ;;   # age entre as duas migrations (abaixo)
  pos_janela)      sabotar_d 's/^CREATE OR REPLACE FUNCTION private\._venda_repasse_base\(p_comprador uuid\)$/CREATE OR REPLACE FUNCTION private._venda_repasse_base_sabotada(p_comprador uuid)/' ;;
  *) echo "INFRA: sabotagem desconhecida $SABOTAGEM"; exit 2 ;;
esac
# pre_config: deriva de search_path no helper ANTES da migration de desempenho — a PRE tem de recusar
DERIVA=":"; [ "${SABOTAGEM:-}" = "pre_config" ] && DERIVA="P -q -c 'ALTER FUNCTION private._venda_repasse_base(uuid) SET search_path = pg_catalog, public'"
if P -q -f "$MIGC" >"$TMPD/mig.out" 2>&1 && eval "$DERIVA" && P -q -f "$MIGD" >>"$TMPD/mig.out" 2>&1; then
  ok "MIG migrations aplicaram (repasse + desempenho; PRE+CREATE+POS)"
else
  bad "MIG migration não aplicou: $(grep -m1 -E 'ERROR' "$TMPD/mig.out" | cut -c1-200)"
  echo "RESULTADO: $PASS ok / $FAIL fail"; exit 1
fi
if P -q -f "$MIGC" >"$TMPD/mig2.out" 2>&1 && P -q -f "$MIGD" >>"$TMPD/mig2.out" 2>&1; then ok "MIG2 re-colar as migrations é seguro (PRE aceita este corpo)"
else bad "MIG2 re-colar falhou: $(grep -m1 ERROR "$TMPD/mig2.out" | cut -c1-200)"; fi
eq H1 "get_defasagem_cliente: volatilidade/secdef/search_path/ACL preservados" \
  "$(Pq -c "SELECT provolatile::text||'|'||prosecdef::text||'|'||coalesce(array_to_string(proconfig,','),'-')||'|'||coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(proacl) a),'NULL') FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")" \
  "$ACL_ANTES"

# C1 — paridade (depois)
eq C1a "cockpit SEM cap: JSON idêntico antes/depois" "$(retrato "$STAFF")" "$ANTES_STAFF"
eq C1b "cockpit COM cap: JSON idêntico antes/depois" "$(retrato "$MST")" "$ANTES_MST"

# C2 — gate de candidatos
neg C2a "candidatos como farmer → 42501" "$FAR" insufficient_privilege "requer master" "PERFORM public.venda_repasse_candidatos()"
C2B="$(Pq -c "BEGIN;
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT false';
SET LOCAL test.uid='$MST'; SET LOCAL ROLE authenticated;
DO \$g\$ BEGIN
  PERFORM public.venda_repasse_candidatos();
  RAISE NOTICE 'C2B-PASSOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'C2B-NEGADO-42501';
          WHEN OTHERS THEN RAISE;
END \$g\$;
ROLLBACK;" 2>&1 | grep -oE 'C2B-[A-Z0-9-]+' | head -1 || true)"
eq C2b "candidatos como master SEM cap (simulado) → 42501" "$C2B" "C2B-NEGADO-42501"
neg C2c "candidatos como estratégico (tem cap, não é master) → 42501" "$EST" insufficient_privilege "requer master" "PERFORM public.venda_repasse_candidatos()"
neg C2d "candidatos como anon → 42501 (sem EXECUTE)" "" insufficient_privilege "" "PERFORM public.venda_repasse_candidatos()"

# CAND / C6 — conteúdo dos candidatos (master)
cand() { # $1 = código, $2 = campo
  como "$MST" "SELECT coalesce(e->>'$2','(null)') FROM jsonb_array_elements(public.venda_repasse_candidatos()) e WHERE (e->>'omie_codigo_produto')::bigint = $1 AND (e->>'comprador_id')::uuid = '$CAN'"
}
eq CAND1 "R1 defasado: status, último, sugerido" "$(cand 7101 status_defasagem)|$(cand 7101 ultimo_preco)|$(cand 7101 preco_sugerido)" "defasado|100.0000|133.33"
eq CAND2 "R1 valor anual = qtd×365/cadência×(sugerido−último)" "$(cand 7101 valor_anual_recuperavel)" "4055.15"
eq CAND3 "R4 abaixo do piso: só o SINAL, sem sugerido" "$(cand 7104 abaixo_piso)|$(cand 7104 preco_sugerido)|$(cand 7104 valor_anual_recuperavel)" "true|(null)|(null)"
eq C6 "Colacor, tinta, tinta NULL e dia sem preço nunca são candidatos" \
  "$(como "$MST" "SELECT coalesce(string_agg(e->>'omie_codigo_produto', ',' ORDER BY e->>'omie_codigo_produto'), 'nenhum') FROM jsonb_array_elements(public.venda_repasse_candidatos()) e WHERE (e->>'omie_codigo_produto')::bigint IN (7102, 7103, 7105, 7106)")" \
  "nenhum"

# C3 — aprovação recusa
VAL="$HOJE + 30"
neg C3a "alvo abaixo do último → 22023" "$MST" invalid_parameter_value "REPASSE_ALVO_ABAIXO" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, 99.99, $VAL)"
neg C3b "alvo igual ao último → 22023" "$MST" invalid_parameter_value "REPASSE_ALVO_ABAIXO" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, 100.00, $VAL)"
neg C3c "SKU com tinta desconhecida (NULL) → 22023" "$MST" invalid_parameter_value "REPASSE_SKU" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7106, 130.00, $VAL)"
neg C3d "empresa Colacor → 22023" "$MST" invalid_parameter_value "REPASSE_EMPRESA" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'colacor', 7103, 130.00, $VAL)"
neg C3e "último dia sem preço apurado → 22023 (ausente ≠ zero)" "$MST" invalid_parameter_value "REPASSE_SEM_ULTIMO" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7105, 130.00, $VAL)"
neg C3f "farmer não aprova → 42501" "$FAR" insufficient_privilege "requer master" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, 130.00, $VAL)"
neg C3g "validade vencida → 22023" "$MST" invalid_parameter_value "REPASSE_VALIDADE" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, 130.00, $HOJE)"

# AP — aprovação, retry, conflito, substituição
ID1="$(como "$MST" "SELECT public.venda_aprovar_repasse('$ALI', 'oben', 7101, 125.00, $VAL)")"
eq AP1 "aprovar pelo ALIAS grava o comprador CANÔNICO" \
  "$(Pq -c "SELECT comprador_id||'|'||preco_alvo||'|'||(ultimo_preco_na_aprovacao = 100)::text FROM public.venda_repasse_aprovado WHERE id='$ID1'")" "$CAN|125.00|true"
eq AP2 "retry idêntico devolve o mesmo id" "$(como "$MST" "SELECT public.venda_aprovar_repasse('$CAN', 'oben', 7101, 125.00, $VAL)")" "$ID1"
neg AP3 "decisão de tela velha (sem p_substitui) → 40001" "$MST" serialization_failure "REPASSE_CONFLITO" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, 126.00, $VAL)"
ID2="$(como "$MST" "SELECT public.venda_aprovar_repasse('$CAN', 'oben', 7101, 126.00, $VAL, '$ID1')")"
eq AP4 "substituir com o id visto: 1 não-revogado, o anterior revogado" \
  "$(Pq -c "SELECT count(*) FILTER (WHERE revogado_em IS NULL)||'|'||bool_and(revogado_em IS NOT NULL) FILTER (WHERE id='$ID1')||'|'||(SELECT id FROM public.venda_repasse_aprovado WHERE revogado_em IS NULL AND omie_codigo_produto=7101 AND comprador_id='$CAN') FROM public.venda_repasse_aprovado WHERE omie_codigo_produto=7101")" \
  "1|true|$ID2"

eq AP4b "retry idêntico da SUBSTITUIÇÃO devolve o mesmo id novo" \
  "$(como "$MST" "SELECT public.venda_aprovar_repasse('$CAN', 'oben', 7101, 126.00, $VAL, '$ID1')")" "$ID2"
# média ponderada do líquido do último dia (116): 115 recusa, 117 aceita
neg W1 "R10: alvo 115 < média ponderada 116 → 22023" "$MST" invalid_parameter_value "REPASSE_ALVO_ABAIXO" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7110, 115.00, $VAL)"
ID10="$(como "$MST" "SELECT public.venda_aprovar_repasse('$CAN', 'oben', 7110, 117.00, $VAL)")"
eq W2 "R10: alvo 117 > 116 é aceito (último gravado = 116)" \
  "$(Pq -c "SELECT (ultimo_preco_na_aprovacao = 116)::text FROM public.venda_repasse_aprovado WHERE id = '${ID10:-00000000-0000-0000-0000-000000000000}'")" "true"
como "$MST" "SELECT public.venda_revogar_repasse('${ID10:-00000000-0000-0000-0000-000000000000}')" >/dev/null   # fora da leitura dos C4/C5
# parâmetros inválidos → 22023 com marca
neg N1 "aprovar com alvo NULL → 22023" "$MST" invalid_parameter_value "REPASSE_PARAM" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, NULL, $VAL)"
neg N2 "leitura com comprador NULL → 22023" "$FAR" invalid_parameter_value "REPASSE_PARAM" \
  "PERFORM public.venda_preco_alvo_comprador(NULL)"
neg N3 "revogar id inexistente → 22023" "$MST" invalid_parameter_value "REPASSE_INEXISTENTE" \
  "PERFORM public.venda_revogar_repasse(gen_random_uuid())"

# C4 — leitura da farmer
leitura() { # $1 uid, $2 comprador
  como "$1" "SELECT public.venda_preco_alvo_comprador('$2')"
}
eq C4a "farmer recebe SÓ as 6 chaves permitidas (conjunto exato, com linha)" \
  "$(como "$FAR" "SELECT count(DISTINCT e)||':'||string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(public.venda_preco_alvo_comprador('$CAN')) e, jsonb_object_keys(e) k")" \
  "1:empresa,faixa_margem,omie_codigo_produto,preco_alvo,ultimo_preco,valido_ate"
eq C4t "tipos das 6 chaves (número é número, não texto)" \
  "$(como "$FAR" "SELECT string_agg(k||':'||jsonb_typeof(e->k), ',' ORDER BY k) FROM jsonb_array_elements(public.venda_preco_alvo_comprador('$CAN')) e, jsonb_object_keys(e) k")" \
  "empresa:string,faixa_margem:string,omie_codigo_produto:number,preco_alvo:number,ultimo_preco:number,valido_ate:string"
eq C4b "valores: último, alvo, faixa (CMC 80 / alvo 126 = 36% → verde)" \
  "$(como "$FAR" "SELECT e->>'empresa'||'|'||(e->>'omie_codigo_produto')||'|'||(e->>'ultimo_preco')||'|'||(e->>'preco_alvo')||'|'||(e->>'faixa_margem') FROM jsonb_array_elements(public.venda_preco_alvo_comprador('$CAN')) e")" \
  "oben|7101|100.00|126.00|verde"
eq C4c "pedir pelo alias = pedir pelo canônico" "$(leitura "$FAR" "$ALI")" "$(leitura "$FAR" "$CAN")"
neg C4d "outra farmer (fora da carteira) → 42501" "$FAR2" insufficient_privilege "fora da sua carteira" \
  "PERFORM public.venda_preco_alvo_comprador('$CAN')"
neg C4e "grupo com DOIS donos nega até o dono do canônico → 42501" "$FAR" insufficient_privilege "fora da sua carteira" \
  "PERFORM public.venda_preco_alvo_comprador('$CAN2')"
neg C4h "dono só do ALIAS de um grupo com dois donos → 42501" "$FAR2" insufficient_privilege "fora da sua carteira" \
  "PERFORM public.venda_preco_alvo_comprador('$ALI2')"
neg C4f "o próprio cliente → 42501" "$CAN" insufficient_privilege "requer perfil staff" \
  "PERFORM public.venda_preco_alvo_comprador('$CAN')"
eq C4g "estratégico (cap_carteira) lê" "$(como "$EST" "SELECT jsonb_array_length(public.venda_preco_alvo_comprador('$CAN'))")" "1"

# C5 — vigência
Pq -c "INSERT INTO public.venda_repasse_aprovado (comprador_id, empresa, omie_codigo_produto, preco_alvo, ultimo_preco_na_aprovacao, valido_ate, aprovado_por)
       VALUES ('$CAN', 'oben', 7107, 120.00, 100, $HOJE - 1, '$MST')" >/dev/null
skus() { como "$FAR" "SELECT coalesce(string_agg(e->>'omie_codigo_produto', ',' ORDER BY e->>'omie_codigo_produto'), 'nenhum') FROM jsonb_array_elements(public.venda_preco_alvo_comprador('$CAN')) e"; }
eq C5a "repasse vencido (valido_ate < hoje SP) não aparece" "$(skus)" "7101"
ID8="$(como "$MST" "SELECT public.venda_aprovar_repasse('$CAN', 'oben', 7108, 110.00, $VAL)")"
eq C5c0 "R8 aprovado aparece antes da venda nova" "$(skus)" "7101,7108"
Pq -c "SET session_replication_role = replica;
       INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi, omie_pedido_id, omie_numero_pedido, total, discount)
         VALUES (md5('vr:r8-nova')::uuid, '$ALI', '$ALI', 'oben', 'faturado', $HOJE, 889999, '889999', 1000, 0);
       INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, desconto_valor)
         VALUES (md5('vr:r8-nova')::uuid, '$ALI', 7108, 10, 112, 0, 0);" >/dev/null
eq C5d "venda posterior que alcança o alvo tira o repasse da tela (registro fica)" \
  "$(skus)|$(Pq -c "SELECT count(*) FROM public.venda_repasse_aprovado WHERE id='$ID8' AND revogado_em IS NULL")" "7101|1"
como "$MST" "SELECT public.venda_revogar_repasse('$ID2')" >/dev/null
eq C5b "repasse revogado não aparece" "$(skus)" "nenhum"
REV1="$(Pq -c "SELECT revogado_em||'|'||revogado_por FROM public.venda_repasse_aprovado WHERE id='$ID2'")"
como "$MST" "SELECT public.venda_revogar_repasse('$ID2')" >/dev/null
eq C5e "revogar de novo é no-op (autor/data preservados)" \
  "$(Pq -c "SELECT revogado_em||'|'||revogado_por FROM public.venda_repasse_aprovado WHERE id='$ID2'")" "$REV1"
neg AP5 "repetir a CRIAÇÃO depois da revogação não ressuscita → 40001" "$MST" serialization_failure "REPASSE_CONFLITO" \
  "PERFORM public.venda_aprovar_repasse('$CAN', 'oben', 7101, 125.00, $VAL)"
eq AP6 "re-aprovar conscientemente (vendo a versão revogada) funciona" \
  "$(como "$MST" "SELECT public.venda_aprovar_repasse('$CAN', 'oben', 7101, 127.00, $VAL, '$ID2') IS NOT NULL")" "t"
neg C5f "farmer não revoga → 42501" "$FAR" insufficient_privilege "requer master" "PERFORM public.venda_revogar_repasse('$ID8')"

# ACL — tabela e RPCs pelo ACL efetivo
neg ACL1 "authenticated não lê a tabela direto" "$FAR" insufficient_privilege "" "PERFORM count(*) FROM public.venda_repasse_aprovado"
neg ACL2 "anon não executa a leitura de preço alvo" "" insufficient_privilege "" "PERFORM public.venda_preco_alvo_comprador('$CAN')"
eq ACL3 "helpers privados fechados a authenticated" \
  "$(Pq -c "SELECT bool_or(has_function_privilege('authenticated', f, 'EXECUTE'))::text FROM unnest(ARRAY['private._defasagem_item(boolean,boolean,date,numeric,numeric,numeric,numeric,timestamptz,numeric,numeric)','private._venda_repasse_base(uuid)','private._venda_repasse_sku_ok(bigint)']) f")" "false"

# PERF — volume de prod (72k linhas, 400 compradores × 20 SKUs × 9 pedidos) sob o statement_timeout da prod (8 s,
# authenticated/authenticator). Incidente 2026-10-21: o corpo com autojunção levou 29 s aqui e deu 500 na prod.
P -q <<'SQL' >/dev/null
SET session_replication_role = replica;
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, is_tintometric)
  SELECT 600000+s, (600000+s)::text, 'p'||s, 'oben', false FROM generate_series(1,400) s;
INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at)
  SELECT 600000+s, 80, 'oben', now() FROM generate_series(1,400) s;
INSERT INTO public.cmc_snapshot (omie_codigo_produto, account, data_posicao, cmc, synced_at)
  SELECT 600000+s, 'oben', (now() AT TIME ZONE 'America/Sao_Paulo')::date - d, 60, now()
    FROM generate_series(1,400) s, generate_series(1,400,3) d;
CREATE TEMP TABLE ped AS
  SELECT gen_random_uuid() AS id, md5('vol'||c)::uuid AS cli, 600000 + ((c*7 + j*13) % 400) + 1 AS cod,
         (now() AT TIME ZONE 'America/Sao_Paulo')::date - (k*30 + (c % 20)) AS dia
    FROM generate_series(1,400) c, generate_series(1,20) j, generate_series(1,9) k;
INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi, omie_pedido_id, omie_numero_pedido, total, discount)
  SELECT id, cli, cli, 'oben', 'faturado', dia, 9000000 + row_number() OVER (), 'x', 100, 0 FROM ped;
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, desconto_valor)
  SELECT id, cli, cod, 10, 100, 0, 0 FROM ped;
INSERT INTO public.venda_recompra (comprador_id, empresa, omie_codigo_produto, n_pedidos, cadencia_dias, qtd_sugerida, ultima_compra, ultimo_preco, data_referencia, calculado_em)
  SELECT DISTINCT ON (cli, cod) cli, 'oben', cod, 9, 30, 10, dia, 100, (now() AT TIME ZONE 'America/Sao_Paulo')::date, now() FROM ped LIMIT 1400;
SET session_replication_role = origin;
ANALYZE;
SQL
eq PERFv "volume semeado: linhas, pares comprador×SKU e dias por par" \
  "$(Pq -c "SELECT count(*)||'|'||count(DISTINCT (customer_user_id, omie_codigo_produto))||'|'||(SELECT min(n) FROM (SELECT count(DISTINCT so.order_date_kpi) n FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE oi.omie_codigo_produto > 600000 GROUP BY oi.customer_user_id, oi.omie_codigo_produto) x) FROM public.order_items WHERE omie_codigo_produto > 600000")" \
  "72000|8000|9"
PERF="$(Pq -c "SET test.uid='$MST'; SET ROLE authenticated; SET statement_timeout = '8s';" \
           -c "SELECT CASE WHEN jsonb_array_length(public.venda_repasse_candidatos()) >= 0 THEN 'PERF-OK' END" 2>&1 \
        | grep -oE 'PERF-OK|statement timeout' | head -1 || true)"
eq PERF "candidatos com volume de prod cabem no statement_timeout de 8 s da prod" "$PERF" "PERF-OK"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
[ "$PASS" = "$TOTAL_ESPERADO" ] || { echo "❌ rodou $PASS asserts, esperado $TOTAL_ESPERADO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "FIM-OK venda-repasse"

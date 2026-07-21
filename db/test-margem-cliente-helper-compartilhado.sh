#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 do helper compartilhado `private.margem_cliente_agregada()`       ║
# ║    bash db/test-margem-cliente-helper-compartilhado.sh > log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  Revisão adversária Codex (gpt-5.6-sol xhigh, 2026-07-21) derrubou a v1.      ║
# ║  Corrigido aqui:                                                              ║
# ║   · o ALTER DEFAULT PRIVILEGES era no schema `public` e a função nasce em     ║
# ║     `private` ⇒ anon/authenticated nunca recebiam os grants que a PROD tem,   ║
# ║     e L1/L2 ficavam VERDES mesmo sem os REVOKE por nome (falso-verde);        ║
# ║   · faltava o assert financeiro central: cliente MULTI-ITEM com custo         ║
# ║     conhecido + desconhecido e quantidade ≠ 1;                                ║
# ║   · faltava o contraexemplo do preço ausente fabricando margem 0.00;          ║
# ║   · nada checava prosecdef/proconfig — sabotar o SECURITY DEFINER passava;    ║
# ║   · "service_role executa" lia o ACL da função sem USAGE no schema;           ║
# ║   · só havia UM negativo de status; `status <> 'importado'` passaria.         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="margemhelper"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# ── espelhando a PROD (tipos, chaves e ACL reais, conferidos por psql-ro) ─────
P -q <<'SQL'
-- ⚠️ O schema `private` é criado ANTES da migration e recebe o default privilege AQUI.
-- Sem isto, anon/authenticated nasceriam sem o EXECUTE que a PROD concede por default, e os
-- asserts de REVOKE passariam pela razão errada — o falso-verde que o Codex xhigh pegou.
CREATE SCHEMA IF NOT EXISTS private;
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- USAGE em `private` para anon/authenticated ESPELHA A PROD, não é folga do harness:
-- medido 2026-07-21, `private.nspacl` = {…,authenticated=U/postgres,anon=U/postgres,…}.
-- Sem replicar, o assert de ACL mediria a ausência de USAGE em vez do REVOKE.
GRANT USAGE ON SCHEMA private TO authenticated, anon;

CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY,
  omie_codigo_produto bigint UNIQUE);
-- Espelha a PROD: `id` é a PK e `product_id` é UNIQUE em separado
-- (product_costs_pkey em id + product_costs_product_id_key em product_id).
CREATE TABLE public.product_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid UNIQUE,
  cost_final numeric,
  cost_price numeric);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  status text,
  deleted_at timestamptz);       -- 100% NULO na prod, mas a coluna EXISTE
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid,
  customer_user_id uuid,
  omie_codigo_produto bigint,
  product_id uuid,               -- NULO em 2,67% dos itens da prod — é o ponto do H1
  quantity numeric,
  unit_price numeric);
CREATE TABLE public.cliente_classificacao (
  user_id uuid PRIMARY KEY,
  excluir_da_carteira boolean);
SQL

# ── aplica as migrations REAIS, na ordem (não cópias) ────────────────────────
# A 2ª reconcilia o universo de status (allowlist → denylist) e faz
# get_customer_margin_summary virar projeção deste helper.
P -q -f "$REPO_ROOT/supabase/migrations/20260726150000_margem_cliente_helper_compartilhado.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726160000_margem_reconciliacao_universo_unico.sql"

# ── seed ─────────────────────────────────────────────────────────────────────
P -q <<'SQL'
INSERT INTO public.omie_products (id, omie_codigo_produto) VALUES
  ('dd000000-0000-0000-0000-000000000001', 1001),   -- custo 60
  ('dd000000-0000-0000-0000-000000000002', 1002),   -- SEM linha em product_costs
  ('dd000000-0000-0000-0000-000000000003', 1003),   -- custo 150
  ('dd000000-0000-0000-0000-000000000004', 1004),   -- cost_final = 0  → "não sei"
  ('dd000000-0000-0000-0000-000000000005', 1005),   -- cost_final NULL, cost_price 40
  ('dd000000-0000-0000-0000-000000000006', 1006),   -- custo 20
  ('dd000000-0000-0000-0000-000000000007', 1007),   -- cost_final = Infinity → "não sei"
  ('dd000000-0000-0000-0000-000000000008', 1008);   -- cost_final = NaN      → "não sei"

INSERT INTO public.product_costs (product_id, cost_final, cost_price) VALUES
  ('dd000000-0000-0000-0000-000000000001',        60, NULL),
  ('dd000000-0000-0000-0000-000000000003',       150, NULL),
  ('dd000000-0000-0000-0000-000000000004',         0, NULL),
  ('dd000000-0000-0000-0000-000000000005',      NULL,   40),
  ('dd000000-0000-0000-0000-000000000006',        20, NULL),
  ('dd000000-0000-0000-0000-000000000007', 'Infinity'::numeric, NULL),
  ('dd000000-0000-0000-0000-000000000008', 'NaN'::numeric,      NULL);

INSERT INTO public.sales_orders (id, status, deleted_at) VALUES
  ('50000000-0000-0000-0000-00000000000a', 'faturado',  NULL),
  ('50000000-0000-0000-0000-00000000000b', 'faturado',  NULL),
  ('50000000-0000-0000-0000-00000000000c', 'faturado',  NULL),
  ('50000000-0000-0000-0000-00000000000d', 'faturado',  NULL),
  ('50000000-0000-0000-0000-00000000000e', 'faturado',  NULL),
  ('50000000-0000-0000-0000-00000000000f', 'importado', NULL),   -- venda real: ENTRA na denylist
  ('50000000-0000-0000-0000-000000000015', 'separacao', NULL),   -- em trânsito: ENTRA
  ('50000000-0000-0000-0000-000000000017', 'enviado',   NULL),   -- em trânsito: ENTRA
  ('50000000-0000-0000-0000-000000000010', 'cancelado', NULL),   -- não é venda: SAI
  ('50000000-0000-0000-0000-000000000018', 'orcamento', NULL),   -- 2º negativo: SAI
  ('50000000-0000-0000-0000-000000000011', 'faturado',  NULL),
  ('50000000-0000-0000-0000-000000000012', 'faturado',  NULL),
  ('50000000-0000-0000-0000-000000000013', 'faturado',  NULL),
  ('50000000-0000-0000-0000-000000000014', 'faturado',  now());  -- soft-deleted

-- ⚠️ SÓ o item de A tem `product_id` NULO. Os outros vêm preenchidos DE PROPÓSITO: assim a
-- falsificação F1 (trocar o JOIN para product_id) fica vermelha em H1 e nos asserts que
-- REPETEM aquele mesmo valor, e não no harness inteiro — sabotagem que derruba tudo não prova
-- nada de específico.
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price) VALUES
  -- A: product_id NULO, código resolve p/ SKU COM custo → 40%. Classe dos 783 itens / R$ 247.482,10.
  ('50000000-0000-0000-0000-00000000000a','aa000000-0000-0000-0000-000000000001', 1001, NULL, 1, 100),
  -- B: só SKU sem linha de custo → NULL
  ('50000000-0000-0000-0000-00000000000b','bb000000-0000-0000-0000-000000000002', 1002, 'dd000000-0000-0000-0000-000000000002', 1, 100),
  -- C: custo 150 sobre receita 100 → margem NEGATIVA, preservada
  ('50000000-0000-0000-0000-00000000000c','cc000000-0000-0000-0000-000000000003', 1003, 'dd000000-0000-0000-0000-000000000003', 1, 100),
  -- D: cost_final = 0 → "não sei" → NULL
  ('50000000-0000-0000-0000-00000000000d','dd111111-0000-0000-0000-000000000004', 1004, 'dd000000-0000-0000-0000-000000000004', 1, 100),
  -- E: excluído da carteira → some
  ('50000000-0000-0000-0000-00000000000e','ee000000-0000-0000-0000-000000000005', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100),
  -- F: status 'importado' → ENTRA (venda real). Mesmo SKU/preço dos demais → margem 40%.
  ('50000000-0000-0000-0000-00000000000f','ff000000-0000-0000-0000-000000000006', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100),
  -- SEP/ENV: em trânsito, mas vendidos → ENTRAM
  ('50000000-0000-0000-0000-000000000015','5e000000-0000-0000-0000-000000000015', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100),
  ('50000000-0000-0000-0000-000000000017','6e000000-0000-0000-0000-000000000017', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100),
  -- F2: 'cancelado' → SAI. ORC: 'orcamento' → SAI (2º negativo: barra `status <> 'cancelado'`)
  ('50000000-0000-0000-0000-000000000010','f2000000-0000-0000-0000-000000000016', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100),
  ('50000000-0000-0000-0000-000000000018','7e000000-0000-0000-0000-000000000018', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100),
  -- I: fallback cost_price (cost_final NULL) → 60%
  ('50000000-0000-0000-0000-000000000011','1a000000-0000-0000-0000-000000000011', 1005, 'dd000000-0000-0000-0000-000000000005', 1, 100),
  -- SD: pedido soft-deleted → some
  ('50000000-0000-0000-0000-000000000014','5d000000-0000-0000-0000-000000000014', 1001, 'dd000000-0000-0000-0000-000000000001', 1, 100);

INSERT INTO public.cliente_classificacao (user_id, excluir_da_carteira) VALUES
  ('ee000000-0000-0000-0000-000000000005', true);

-- G: MULTI-ITEM com quantidade ≠ 1 e custo conhecido + desconhecido (o assert financeiro central).
--   (2×100, custo 60) → receita 200, custo 120
--   (3× 50, custo 20) → receita 150, custo  60
--   (1×999, SEM custo) → IGNORADO
--   receita 350, custo 180 → (350-180)/350 = 48,571… → 48.57
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price) VALUES
  ('50000000-0000-0000-0000-000000000012','9a000000-0000-0000-0000-000000000012', 1001, 'dd000000-0000-0000-0000-000000000001', 2, 100),
  ('50000000-0000-0000-0000-000000000012','9a000000-0000-0000-0000-000000000012', 1006, 'dd000000-0000-0000-0000-000000000006', 3,  50),
  ('50000000-0000-0000-0000-000000000012','9a000000-0000-0000-0000-000000000012', 1002, 'dd000000-0000-0000-0000-000000000002', 1, 999);

-- H: o CONTRAEXEMPLO do Codex — preço ausente com custo conhecido, misturado a um item válido.
--   Sem o guard: receita 100, custo 60+40=100 → margem 0.00 FABRICADA.
--   Com o guard: o item de preço NULO é ignorado → receita 100, custo 60 → 40.00.
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price) VALUES
  ('50000000-0000-0000-0000-000000000013','8a000000-0000-0000-0000-000000000013', 1001, 'dd000000-0000-0000-0000-000000000001', 1,  100),
  ('50000000-0000-0000-0000-000000000013','8a000000-0000-0000-0000-000000000013', 1005, 'dd000000-0000-0000-0000-000000000005', 1, NULL);
SQL

m() { Pq -c "SELECT COALESCE(margem_pct::text,'NULL') FROM private.margem_cliente_agregada() WHERE customer_user_id='$1';"; }

echo "-- H. o JOIN por omie_codigo_produto (o ponto do PR) --"
eq "H1 item com product_id NULO mas código com custo → margem REAL" \
   "$(m aa000000-0000-0000-0000-000000000001)" "40.00"

echo "-- I. ausente != zero, nas TRES pernas --"
eq "I1 SKU sem linha de custo → NULL, jamais 0"        "$(m bb000000-0000-0000-0000-000000000002)" "NULL"
eq "I2 cost_final = 0 é 'não sei', não custo zero"     "$(m dd111111-0000-0000-0000-000000000004)" "NULL"
eq "I3 fallback cost_price quando cost_final é NULL"   "$(m 1a000000-0000-0000-0000-000000000011)" "60.00"
eq "I4 itens_ignorados contabiliza o desconhecido" \
   "$(Pq -c "SELECT itens_ignorados FROM private.margem_cliente_agregada() WHERE customer_user_id='bb000000-0000-0000-0000-000000000002';")" "1"
# O contraexemplo do Codex: sem o guard de preço isto devolveria 0.00 (margem fabricada).
eq "I5 preço ausente NÃO fabrica margem 0 (item é ignorado)" \
   "$(m 8a000000-0000-0000-0000-000000000013)" "40.00"

echo "-- J. dado real preservado + agregação multi-item --"
eq "J1 margem NEGATIVA é dado real, não é zerada" "$(m cc000000-0000-0000-0000-000000000003)" "-50.00"
# O assert financeiro central: quantidade != 1, 2 SKUs com custo + 1 sem, tudo junto.
eq "J2 multi-item, qtd!=1, custo misto → margem correta" \
   "$(m 9a000000-0000-0000-0000-000000000012)" "48.57"
eq "J3 multi-item: contadores e somas batem" \
   "$(Pq -c "SELECT itens_computaveis||'|'||itens_ignorados||'|'||receita_computada||'|'||custo_computado
               FROM private.margem_cliente_agregada() WHERE customer_user_id='9a000000-0000-0000-0000-000000000012';")" \
   "2|1|350|180"

echo "-- K. universo (DENYLIST desde a reconciliação) --"
eq "K1 cliente excluído da carteira some" \
   "$(Pq -c "SELECT count(*) FROM private.margem_cliente_agregada() WHERE customer_user_id='ee000000-0000-0000-0000-000000000005';")" "0"
# ⚠️ INVERTIDO na reconciliação. A allowlist anterior (`IN ('confirmado','faturado','entregue')`)
# resolvia para SÓ `faturado` e descartava R$ 6.985.425,66 de vendas reais — 311 clientes (25,6%)
# perdiam a margem e caíam em `neutro`. `importado` É venda: entra.
eq "K2 status 'importado' ENTRA (é venda real, R\$ 2,75M)" \
   "$(m ff000000-0000-0000-0000-000000000006)" "40.00"
eq "K3 status 'separacao' ENTRA (em trânsito, mas vendido)" \
   "$(m 5e000000-0000-0000-0000-000000000015)" "40.00"
eq "K4 status 'enviado' ENTRA" \
   "$(m 6e000000-0000-0000-0000-000000000017)" "40.00"
eq "K5 status 'cancelado' SOME (a denylist barra)" \
   "$(Pq -c "SELECT count(*) FROM private.margem_cliente_agregada() WHERE customer_user_id='f2000000-0000-0000-0000-000000000016';")" "0"
eq "K6 status 'orcamento' SOME (2o negativo — barra 'status <> cancelado')" \
   "$(Pq -c "SELECT count(*) FROM private.margem_cliente_agregada() WHERE customer_user_id='7e000000-0000-0000-0000-000000000018';")" "0"
eq "K7 pedido soft-deleted some" \
   "$(Pq -c "SELECT count(*) FROM private.margem_cliente_agregada() WHERE customer_user_id='5d000000-0000-0000-0000-000000000014';")" "0"

echo "-- L. ACL (o helper não é alcançável do browser) --"
eq "L1 anon NAO executa"          "$(Pq -c "SELECT has_function_privilege('anon','private.margem_cliente_agregada()','EXECUTE');")"          "f"
eq "L2 authenticated NAO executa" "$(Pq -c "SELECT has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE');")" "f"
eq "L3 PUBLIC NAO executa"        "$(Pq -c "SELECT has_function_privilege('public','private.margem_cliente_agregada()','EXECUTE');")"        "f"
# `has_function_privilege` lê só o ACL da função. A chamada REAL sob SET ROLE é que prova que
# service_role alcança a função de fato (precisa de USAGE no schema também).
# `-q` é obrigatório: sem ele a tag "SET" do `SET ROLE` entra na saída capturada por `-tA`
# e o assert compara "SET\nt" com "t" (armadilha registrada em money-path.md).
eq "L4 service_role CHAMA de verdade (SET ROLE, não só ACL)" \
   "$(P -tA -q -c "SET ROLE service_role; SELECT count(*) > 0 FROM private.margem_cliente_agregada();")" "t"
eq "L5 vive em private, fora do schema exposto" \
   "$(Pq -c "SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='margem_cliente_agregada';")" "private"

echo "-- N. propriedades do objeto (sabotar isto passava antes) --"
eq "N1 é SECURITY DEFINER" \
   "$(Pq -c "SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='margem_cliente_agregada';")" "t"
eq "N2 search_path fixado (não herda o do caller)" \
   "$(Pq -c "SELECT array_to_string(proconfig,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='margem_cliente_agregada';")" \
   "search_path=pg_catalog, pg_temp"
eq "N3 é STABLE (não VOLATILE)" \
   "$(Pq -c "SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='margem_cliente_agregada';")" "s"

echo "-- O. idempotência --"
P -q -f "$REPO_ROOT/supabase/migrations/20260726150000_margem_cliente_helper_compartilhado.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726160000_margem_reconciliacao_universo_unico.sql"
eq "O1 re-aplicar não muda o resultado"                "$(m aa000000-0000-0000-0000-000000000001)" "40.00"
eq "O2 re-aplicar preserva o REVOKE de authenticated" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE');")" "f"
# ⚠️ Guarda contra o risco de ORDEM: re-colar SÓ a migration 150000 (a antiga) recria o helper com
# a ALLOWLIST e reverte o universo em silêncio — "a última a recriar vence" (database.md §2).
# Este assert exige que, após a sequência completa, o universo amplo tenha prevalecido.
eq "O3 após re-aplicar as duas EM ORDEM, o universo segue AMPLO" \
   "$(m ff000000-0000-0000-0000-000000000006)" "40.00"

echo "-- P. get_customer_margin_summary virou PROJEÇÃO do helper --"
# Os nomes de coluna são preservados (a edge calculate-scores depende deles), mas o número passa
# a vir do helper — mesma linha, mesmo valor, nos dois objetos.
eq "P1 a projeção devolve o MESMO valor que o helper" \
   "$(Pq -c "SELECT gross_margin_pct FROM public.get_customer_margin_summary() WHERE customer_user_id='aa000000-0000-0000-0000-000000000001';")" \
   "$(m aa000000-0000-0000-0000-000000000001)"
eq "P2 a projeção herda o universo amplo (importado entra)" \
   "$(Pq -c "SELECT gross_margin_pct FROM public.get_customer_margin_summary() WHERE customer_user_id='ff000000-0000-0000-0000-000000000006';")" "40.00"
eq "P3 a projeção herda o JOIN por código (product_id NULO resolve)" \
   "$(Pq -c "SELECT gross_margin_pct FROM public.get_customer_margin_summary() WHERE customer_user_id='aa000000-0000-0000-0000-000000000001';")" "40.00"
eq "P4 a projeção NÃO tem cálculo próprio (corpo só lê o helper)" \
   "$(Pq -c "SELECT pg_get_functiondef(p.oid) ~ 'margem_cliente_agregada' AND pg_get_functiondef(p.oid) !~ 'product_costs'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='get_customer_margin_summary';")" "t"
eq "P5 a projeção segue fechada a authenticated" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.get_customer_margin_summary()','EXECUTE');")" "f"

echo "========================================"
echo "  $PASS verde(s), $FAIL vermelho(s)"
[ "$FAIL" -eq 0 ] || exit 1
echo "  TODOS OS ASSERTS PASSARAM"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — preço ausente do Omie deixa de virar R$ 0,00 (a ORIGEM)              ║
# ║ Migration: supabase/migrations/20260905225613_preco_ausente_nao_e_zero.sql        ║
# ║ Rode: bash db/test-preco-ausente-nao-e-zero.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ║ (NÃO pipe pra tail — engole o exit≠0.)                                            ║
# ║                                                                                   ║
# ║ O harness roda em DOIS TEMPOS, de propósito:                                       ║
# ║   ANTES  — aplica só as migrations que HOJE estão em prod e prova que o bug é      ║
# ║            REAL (o item sem preço vira 0 e fabrica margem). Sem esta metade, a     ║
# ║            metade DEPOIS provaria uma correção sem provar que havia o que corrigir.║
# ║   DEPOIS — aplica a migration nova e prova a correção nos 4 objetos.               ║
# ║                                                                                   ║
# ║ ⚠️ Por que o harness irmão (test-margem-cliente-helper-compartilhado.sh) NÃO       ║
# ║ pegava isto: ele cria `order_items.unit_price` como `numeric` NULLABLE e prova o   ║
# ║ ramo `IS NOT NULL` inserindo NULL. Em prod a coluna é NOT NULL DEFAULT 0 — o ramo  ║
# ║ que ele prova é INALCANÇÁVEL lá, e o caminho que prod REALMENTE percorre (preço 0) ║
# ║ passava por `preco_unit >= 0` como COMPUTÁVEL. Verde no teste, morto na prod.      ║
# ║ Aqui a ZONA 1 replica o schema de prod (NOT NULL DEFAULT 0) e é a migration que o  ║
# ║ altera — que é a única forma de o teste falar do mesmo mundo que o founder aplica. ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5487}"
SLUG="preco-ausente-nao-e-zero"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
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
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FALHOU $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

c1="11111111-1111-1111-1111-111111111111"   # cliente do caso "preco ausente"
c2="22222222-2222-2222-2222-222222222222"   # cliente do caso "preco ZERO informado"
c3="33333333-3333-3333-3333-333333333333"   # cliente do caso "sem preco E sem custo"
sys="99999999-9999-9999-9999-999999999999"
p1="aaaaaaaa-0000-0000-0000-000000000001"   # SKU COM custo (60)
p2="aaaaaaaa-0000-0000-0000-000000000002"   # SKU SEM custo

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema FIEL A PROD (unit_price NOT NULL DEFAULT 0 — o ponto do teste)
# ══════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text);
CREATE TABLE public.product_costs (
  product_id uuid PRIMARY KEY, cost_final numeric, cost_price numeric);
CREATE TABLE public.cliente_classificacao (
  user_id uuid PRIMARY KEY, excluir_da_carteira boolean);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho', notes text,
  omie_pedido_id bigint, omie_numero_pedido text, origem text, checkout_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'oben', hash_payload text, deleted_at timestamptz,
  customer_address text, customer_phone text, order_date_kpi date);
-- ⚠️ NOT NULL DEFAULT 0 = o schema REAL de prod (medido psql-ro 2026-09-05). É esta linha
-- que torna o ramo `preco_unit IS NOT NULL` do helper de margem inalcançável.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric NOT NULL DEFAULT 0, discount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

-- Pré-requisitos de `melhoria_clientes_por_produto` (o ranking do bloco G da migration).
-- Stubs mínimos: o que se prova é a ORDENAÇÃO, não o gate de carteira — por isso os dois
-- predicados de visibilidade devolvem TRUE e saem do caminho.
ALTER TABLE public.omie_products ADD COLUMN descricao text;
ALTER TABLE public.omie_products ADD COLUMN codigo text;
ALTER TABLE public.omie_products ADD COLUMN ativo boolean DEFAULT true;
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text, razao_social text);
DO $e$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $e$;
CREATE FUNCTION public.has_role(p_uid uuid, p_role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT p_role = 'employee'::public.app_role $f$;
CREATE FUNCTION public.pode_ver_carteira_completa(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION public.carteira_visivel_para(p_cliente uuid, p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;

-- Pré-requisitos de `get_defasagem_cliente` (o ranking do bloco G). Igual acima: o que se
-- prova e a MEDIA PONDERADA, entao o gate de custo devolve TRUE e sai do caminho, e as duas
-- tabelas de custo ficam VAZIAS (c_now/c_last nulos nao impedem o p_last de ser calculado).
ALTER TABLE public.sales_orders ADD COLUMN omie_payload jsonb;
CREATE TABLE public.inventory_position (
  omie_codigo_produto bigint, account text, cmc numeric, synced_at timestamptz);
CREATE TABLE public.cmc_snapshot (
  omie_codigo_produto bigint, account text, cmc numeric, data_posicao date, synced_at timestamptz);
CREATE FUNCTION private.cap_custo_ler(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — o ESTADO DE HOJE EM PROD (migrations já aplicadas lá)
# ══════════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/supabase/migrations/20260617160000_criar_pedidos_com_itens.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726150000_margem_cliente_helper_compartilhado.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726160000_margem_reconciliacao_universo_unico.sql"
# A RPC de reconciliação entra porque a migration sob teste MEXE nela: tornar unit_price
# nullable sem consertar o diff INTRODUZ bug (NULL comparado como 0 ⇒ UPDATE não roda).
P -q -f "$REPO_ROOT/supabase/migrations/20260830123820_snapshot_atomico_universo_itens.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql"
echo "estado-de-hoje aplicado (5 migrations)"

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$c2'),('$c3'),('$sys') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES
  ('$p1', 1001, 'oben'), ('$p2', 1002, 'oben');
INSERT INTO public.product_costs(product_id, cost_final) VALUES ('$p1', 60);
SQL

# helper: margem do cliente pelo helper compartilhado
m() { Pq -c "SELECT COALESCE(margem_pct::text,'NULL') FROM private.margem_cliente_agregada() WHERE customer_user_id='$1';"; }

# ── ANTES: o bug é REAL? ─────────────────────────────────────────────────────────
echo "-- ANTES da migration: o bug existe? --"
# Pedido do c1: 1 item COM preço (100, custo 60) + 1 item SEM `unit_price` no payload.
P -q <<SQL
SELECT public.criar_pedidos_com_itens('[{"account":"oben","hash_payload":"omie_oben_1","customer_user_id":"$c1","created_by":"$sys","total":100,"status":"faturado","omie_pedido_id":1,"itens":[
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c1","quantity":1,"unit_price":100,"hash_payload":"i1"},
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c1","quantity":1,"hash_payload":"i2"}]}]'::jsonb);
SQL
ANTES_PRECO=$(Pq -c "SELECT unit_price::text FROM public.order_items WHERE hash_payload='i2';")
eq "Z1 (ANTES) item sem unit_price no payload vira 0 -- a fabricacao" "$ANTES_PRECO" "0"
# receita 100 (item bom) + 0 (item fabricado) = 100; custo 60 + 60 = 120 => -20.00
eq "Z2 (ANTES) o item fabricado ENTRA na margem e a puxa pra NEGATIVA" "$(m "$c1")" "-20.00"

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — aplica a MIGRATION SOB TESTE (Lei #1: a real, do repo)
# ══════════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260905225613_preco_ausente_nao_e_zero.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts DEPOIS
# ══════════════════════════════════════════════════════════════════════════════════
echo "-- A. a coluna passa a poder dizer 'nao sei' --"
eq "A1 unit_price virou nullable" \
   "$(Pq -c "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='unit_price';")" "YES"
eq "A2 unit_price perdeu o DEFAULT (senao INSERT que omite segue fabricando)" \
   "$(Pq -c "SELECT coalesce(column_default,'NENHUM') FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='unit_price';")" "NENHUM"
P -q <<SQL
INSERT INTO public.sales_orders(id, customer_user_id, created_by, status, account, hash_payload, total)
  VALUES ('50000000-0000-0000-0000-000000000009','$c1','$sys','faturado','oben','manual_9', 0);
INSERT INTO public.order_items(sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, hash_payload)
  VALUES ('50000000-0000-0000-0000-000000000009','$c1',1001,'$p1',1,'omitido');
SQL
eq "A3 INSERT que OMITE unit_price grava NULL, nao 0" \
   "$(Pq -c "SELECT coalesce(unit_price::text,'NULL') FROM public.order_items WHERE hash_payload='omitido';")" "NULL"

echo "-- B. a RPC de ingestao separa 'nao informou' de 'informou 0' --"
P -q <<SQL
SELECT public.criar_pedidos_com_itens('[{"account":"oben","hash_payload":"omie_oben_2","customer_user_id":"$c2","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":2,"itens":[
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c2","quantity":1,"hash_payload":"b_ausente"},
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c2","quantity":1,"unit_price":0,"hash_payload":"b_zero"},
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c2","quantity":1,"unit_price":-5,"hash_payload":"b_neg"},
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c2","quantity":1,"unit_price":"NaN","hash_payload":"b_nan"},
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c2","quantity":1,"unit_price":250,"hash_payload":"b_ok"}]}]'::jsonb);
SQL
q() { Pq -c "SELECT coalesce(unit_price::text,'NULL') FROM public.order_items WHERE hash_payload='$1';"; }
eq "B1 ausente  -> NULL ('nao sei')"                       "$(q b_ausente)" "NULL"
eq "B2 zero     -> 0 (o Omie DISSE zero; dado, nao ausencia)" "$(q b_zero)"  "0"
eq "B3 negativo -> NULL (lixo, nao dado)"                  "$(q b_neg)"     "NULL"
eq "B4 NaN      -> NULL (Postgres ordena NaN acima de Infinity)" "$(q b_nan)" "NULL"
eq "B5 preco bom preservado"                               "$(q b_ok)"      "250"

echo "-- C. a margem: 0 deixa de ser computavel --"
# c2 tem 5 itens, todos com custo 60. So `b_ok` (250) e computavel.
# receita 250, custo 60 => (250-60)/250 = 76.00
eq "C1 so o item com preco > 0 entra: margem NAO e fabricada" "$(m "$c2")" "76.00"
eq "C2 itens_computaveis = 1" \
   "$(Pq -c "SELECT itens_computaveis FROM private.margem_cliente_agregada() WHERE customer_user_id='$c2';")" "1"
eq "C3 itens_sem_preco = 4 (ausente, zero, negativo, NaN)" \
   "$(Pq -c "SELECT itens_sem_preco FROM private.margem_cliente_agregada() WHERE customer_user_id='$c2';")" "4"
eq "C4 itens_sem_custo = 0 (todos os SKUs tinham custo)" \
   "$(Pq -c "SELECT itens_sem_custo FROM private.margem_cliente_agregada() WHERE customer_user_id='$c2';")" "0"

echo "-- D. cobertura por MOTIVO, com a sobreposicao declarada --"
# c3: 1 item sem preco MAS com custo; 1 item com preco MAS sem custo; 1 item sem os DOIS.
P -q <<SQL
INSERT INTO public.sales_orders(id, customer_user_id, created_by, status, account, hash_payload, total)
  VALUES ('50000000-0000-0000-0000-000000000003','$c3','$sys','faturado','oben','manual_3', 0);
INSERT INTO public.order_items(sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price, hash_payload) VALUES
  ('50000000-0000-0000-0000-000000000003','$c3',1001,'$p1',1, NULL, 'd_sem_preco'),
  ('50000000-0000-0000-0000-000000000003','$c3',1002,'$p2',1, 10,   'd_sem_custo'),
  ('50000000-0000-0000-0000-000000000003','$c3',1002,'$p2',1, NULL, 'd_sem_ambos');
SQL
cob() { Pq -c "SELECT $1 FROM private.margem_cliente_agregada() WHERE customer_user_id='$c3';"; }
eq "D1 itens_ignorados = 3 (nenhum computavel)" "$(cob itens_ignorados)" "3"
eq "D2 itens_sem_preco = 2 (d_sem_preco + d_sem_ambos)" "$(cob itens_sem_preco)" "2"
eq "D3 itens_sem_custo = 2 (d_sem_custo + d_sem_ambos)" "$(cob itens_sem_custo)" "2"
# 2 + 2 = 4 > 3 ignorados: a SOBREPOSICAO e real e esta documentada no COMMENT.
eq "D4 sem_preco + sem_custo (4) EXCEDE ignorados (3) -- as classes se sobrepoem, nao particionam" \
   "$(cob 'itens_sem_preco + itens_sem_custo')" "4"
eq "D5 margem NULL: nenhum item computavel (nao 0)" "$(m "$c3")" "NULL"

echo "-- E. o wrapper publico projeta as duas contagens novas --"
eq "E1 get_customer_margin_summary devolve 8 colunas" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, unnest(p.proargmodes) m WHERE n.nspname='public' AND p.proname='get_customer_margin_summary' AND p.prokind='f' AND m='t';")" "8"
eq "E2 wrapper projeta itens_sem_preco do helper" \
   "$(Pq -c "SELECT itens_sem_preco FROM public.get_customer_margin_summary() WHERE customer_user_id='$c2';")" "4"
eq "E3 nome legado itens_sem_custo (col.2) segue trazendo IGNORADOS (compat da edge)" \
   "$(Pq -c "SELECT itens_sem_custo FROM public.get_customer_margin_summary() WHERE customer_user_id='$c3';")" "3"
eq "E4 nome honesto itens_sem_custo_conhecido traz o custo de verdade" \
   "$(Pq -c "SELECT itens_sem_custo_conhecido FROM public.get_customer_margin_summary() WHERE customer_user_id='$c3';")" "2"

echo "-- F. o ACL sobreviveu ao DROP+CREATE (o risco desta migration) --"
eq "F1 anon NAO executa o helper"            "$(Pq -c "SELECT has_function_privilege('anon','private.margem_cliente_agregada()','EXECUTE');")" "f"
eq "F2 authenticated NAO executa o helper"   "$(Pq -c "SELECT has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE');")" "f"
eq "F3 anon NAO executa o wrapper"           "$(Pq -c "SELECT has_function_privilege('anon','public.get_customer_margin_summary()','EXECUTE');")" "f"
eq "F4 authenticated NAO executa o wrapper"  "$(Pq -c "SELECT has_function_privilege('authenticated','public.get_customer_margin_summary()','EXECUTE');")" "f"
eq "F5 service_role EXECUTA (a edge calculate-scores depende)" "$(Pq -c "SELECT has_function_privilege('service_role','public.get_customer_margin_summary()','EXECUTE');")" "t"
eq "F6 SECURITY DEFINER preservado nas duas" \
   "$(Pq -c "SELECT bool_and(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='private' AND p.proname='margem_cliente_agregada') OR (n.nspname='public' AND p.proname='get_customer_margin_summary');")" "t"

# Negativo de VERDADE: authenticated tentando executar precisa dar 42501, nao "0 linhas".
echo "-- G. o REVOKE morde de verdade (SQLSTATE, nao contagem) --"
G=$(P -tA <<'SQL' 2>&1 || true
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM * FROM public.get_customer_margin_summary();
  RAISE EXCEPTION 'SEM-BARREIRA: authenticated executou a margem';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'BARRADO-COM-42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$G" in
  *BARRADO-COM-42501*) ok "G1 authenticated barrado com insufficient_privilege (42501)" ;;
  *) bad "G1 esperava 42501 -- veio: $(printf '%s' "$G" | head -c 200)" ;;
esac

echo "-- I. reconciliacao: o diff de preco ficou NULL-safe --"
# Com a coluna nullable, o `coalesce(a.unit_price,0)` antigo compararia um item SEM preco
# (NULL) como IGUAL a um desejado 0 e o UPDATE nao rodaria — o pedido ficaria eternamente
# dessincronizado do Omie sem ninguem ver. Os 3 casos abaixo cobrem a matriz NULL x numero.
GERIDO="ARRAY['importado','separacao','enviado','faturado','cancelado']"
P -q <<SQL
INSERT INTO public.sales_orders(id, customer_user_id, created_by, status, account, hash_payload, omie_pedido_id, total, subtotal, items)
  VALUES ('50000000-0000-0000-0000-000000000777','$c1','$sys','faturado','oben','omie_oben_777',777, 0, 0, '[]'::jsonb);
INSERT INTO public.order_items(sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price, discount, hash_payload)
  VALUES ('50000000-0000-0000-0000-000000000777','$c1',1001,'$p1',1, NULL, 0, 'omie_oben_777_1001');
SQL
# dollar-quoting SUBSTITUI as aspas simples (não convive com elas) — o payload tem aspas duplas.
rec() { Pq -c "SELECT (public.reconciliar_pedidos_omie(\$RECJSON\$$1\$RECJSON\$::jsonb, $GERIDO, clock_timestamp()))->>'corrections';"; }
PED_SEM='[{"account":"oben","hash_payload":"omie_oben_777","omie_pedido_id":777,"status_omie":"faturado","total":0,"items":[{"omie_codigo_produto":1001}],"itens":[{"omie_codigo_produto":1001,"quantity":1,"discount":0,"product_id":"'"$p1"'","hash_payload":"omie_oben_777_1001"}]}]'
PED_COM='[{"account":"oben","hash_payload":"omie_oben_777","omie_pedido_id":777,"status_omie":"faturado","total":7,"items":[{"omie_codigo_produto":1001}],"itens":[{"omie_codigo_produto":1001,"quantity":1,"unit_price":7,"discount":0,"product_id":"'"$p1"'","hash_payload":"omie_oben_777_1001"}]}]'
eq "I1 NULL vs NULL = IGUAL -> nao reescreve (0 correcoes de item)" "$(rec "$PED_SEM")" "0"
eq "I2 NULL vs 7 = DIFERENTE -> reescreve"                          "$(rec "$PED_COM")" "1"
eq "I3 o preco novo entrou mesmo"  "$(Pq -c "SELECT coalesce(unit_price::text,'NULL') FROM public.order_items WHERE hash_payload='omie_oben_777_1001';")" "7"
eq "I4 7 vs ausente = DIFERENTE -> volta a NULL (o Omie deixou de informar)" "$(rec "$PED_SEM")" "1"
eq "I5 e a coluna guardou NULL, nao 0"  "$(Pq -c "SELECT coalesce(unit_price::text,'NULL') FROM public.order_items WHERE hash_payload='omie_oben_777_1001';")" "NULL"
# I6 e o caso CANONICO do bug que o coalesce introduziria: banco NULL, Omie informa 0.
# `abs(coalesce(NULL,0) - 0) < 1e-6` da TRUE ⇒ "iguais" ⇒ o 0 informado nunca entraria.
PED_ZERO='[{"account":"oben","hash_payload":"omie_oben_777","omie_pedido_id":777,"status_omie":"faturado","total":0,"items":[{"omie_codigo_produto":1001}],"itens":[{"omie_codigo_produto":1001,"quantity":1,"unit_price":0,"discount":0,"product_id":"'"$p1"'","hash_payload":"omie_oben_777_1001"}]}]'
eq "I6 NULL vs 0 informado = DIFERENTE -> reescreve (o coalesce dizia 'iguais')" "$(rec "$PED_ZERO")" "1"
eq "I7 e a coluna guardou o 0 informado, distinto do NULL anterior" "$(Pq -c "SELECT coalesce(unit_price::text,'NULL') FROM public.order_items WHERE hash_payload='omie_oben_777_1001';")" "0"

echo "-- J. o ranking NAO fica de cabeca para baixo (o P1 que a nullable introduz) --"
# `sum(quantity * unit_price)` devolve NULL para o cliente sem NENHUM item precificado, e
# `ORDER BY … DESC` em Postgres e NULLS **FIRST** por padrao. Sem `NULLS LAST`, o cliente de
# quem NAO SE SABE a receita encabeca o top-50 de melhoria — "nao sei" apresentado como "o maior".
eq "J0 o default do Postgres em DESC e NULLS FIRST (o mecanismo do bug, medido)" \
   "$(Pq -c "SELECT string_agg(coalesce(v::text,'NULL'), ',' ORDER BY v DESC) FROM (VALUES (1),(NULL),(5)) t(v);")" \
   "NULL,5,1"
# Clientes NOVOS e exclusivos deste bloco: reusar c1/c2 (que ja tem itens dos testes acima)
# faria o ranking medir receita de outro caso — e, pior, deixaria o teste SEM nenhum cliente
# de soma NULL, que e exatamente o que ele existe para posicionar.
r1="e1000000-0000-0000-0000-0000000000a1"   # receita CONHECIDA (500)
r2="e2000000-0000-0000-0000-0000000000a2"   # receita CONHECIDA menor (250)
r3="e3000000-0000-0000-0000-0000000000a3"   # NENHUM item precificado -> sum() = NULL
P -q <<SQL
UPDATE public.omie_products SET descricao='TINTA ACRILICA PREMIUM', codigo='TAP-1', ativo=true WHERE id='$p1';
UPDATE public.omie_products SET descricao='TINTA ACRILICA COMUM',   codigo='TAC-2', ativo=true WHERE id='$p2';
INSERT INTO auth.users(id) VALUES ('$r1'),('$r2'),('$r3') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, name) VALUES
  ('$r1','Ranking COM receita alta'), ('$r2','Ranking COM receita baixa'), ('$r3','Ranking SEM preco');
INSERT INTO public.sales_orders(id, customer_user_id, created_by, status, account, hash_payload, total, order_date_kpi)
  VALUES ('50000000-0000-0000-0000-0000000000a1','$r1','$sys','faturado','oben','rank_a1', 500, current_date),
         ('50000000-0000-0000-0000-0000000000a2','$r2','$sys','faturado','oben','rank_a2', 250, current_date),
         ('50000000-0000-0000-0000-0000000000a3','$r3','$sys','faturado','oben','rank_a3',   0, current_date);
INSERT INTO public.order_items(sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price, hash_payload) VALUES
  ('50000000-0000-0000-0000-0000000000a1','$r1',1002,'$p2',1,  500, 'rank_i1'),
  ('50000000-0000-0000-0000-0000000000a2','$r2',1002,'$p2',1,  250, 'rank_i2'),
  ('50000000-0000-0000-0000-0000000000a3','$r3',1002,'$p2',9, NULL, 'rank_i3'),
  ('50000000-0000-0000-0000-0000000000a3','$r3',1002,'$p2',9, NULL, 'rank_i4');
SQL
# `| tail -1` porque o `SET` imprime a linha "SET" antes do resultado (idioma do template
# desta skill). Seguro aqui: captura um VALOR para o `eq` comparar, nao um exit code.
primeiro() { Pq -c "SET test.uid='$sys'; SELECT (public.melhoria_clientes_por_produto('TINTA')->'clientes'->0->>'cliente');" | tail -1; }
eq "J1 o topo do ranking e quem TEM receita conhecida, nao o NULL" "$(primeiro)" "Ranking COM receita alta"
# Busca pelo NOME, nao por posicao fixa: o indice do cliente muda junto com a ordenacao, e um
# assert por indice passaria a medir outra linha exatamente quando a ordem quebrasse.
valor_de() { Pq -c "SET test.uid='$sys'; SELECT coalesce((SELECT c->>'valor_12m' FROM jsonb_array_elements(public.melhoria_clientes_por_produto('TINTA')->'clientes') c WHERE c->>'cliente' = '$1'),'NULL');" | tail -1; }
eq "J2 o cliente sem preco aparece com valor_12m NULL (nao 0 fabricado)" "$(valor_de 'Ranking SEM preco')" "NULL"
eq "J3 e quem tem receita segue com o numero certo"  "$(valor_de 'Ranking COM receita alta')" "500.00"

echo "-- K. a media ponderada do ultimo preco nao e DILUIDA pela linha sem preco --"
# `sum(unit_price*quantity) / sum(quantity)`: o numerador ignora NULL (sum pula), mas o
# denominador CONSERVA a quantidade da linha sem preco. Duas linhas do mesmo SKU/dia, qtd 1
# cada, precos 100 e NULL, davam 100/2 = 50 — um preco que ninguem praticou, que segue para
# `p_req`, markup e a classificacao de defasagem que a tela mostra ao vendedor.
d1="d1000000-0000-0000-0000-0000000000d1"
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$d1') ON CONFLICT DO NOTHING;
INSERT INTO public.sales_orders(id, customer_user_id, created_by, status, account, hash_payload, omie_pedido_id, total, order_date_kpi)
  VALUES ('50000000-0000-0000-0000-0000000000d1','$d1','$sys','faturado','oben','defas_d1', 4242, 100, current_date - 30);
INSERT INTO public.order_items(sales_order_id, customer_user_id, omie_codigo_produto, product_id, quantity, unit_price, hash_payload) VALUES
  ('50000000-0000-0000-0000-0000000000d1','$d1',1001,'$p1',1,  100, 'defas_i1'),
  ('50000000-0000-0000-0000-0000000000d1','$d1',1001,'$p1',1, NULL, 'defas_i2');
SQL
plast() { Pq -c "SET test.uid='$sys'; SELECT coalesce((public.get_defasagem_cliente('[{\"empresa\":\"oben\",\"codigo\":1001,\"preco\":120}]'::jsonb,'$d1')->0->>'p_last'),'NULL');" | tail -1; }
eq "K1 p_last = 100 (o preco REAL), nao 50 (a media diluida pelo item sem preco)" "$(plast)" "100.0000000000000000"

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota, exige VERMELHO, restaura
# ══════════════════════════════════════════════════════════════════════════════════
echo "-- H. FALSIFICACAO: cada assert tem dente? --"
falso() { # $1 rotulo | $2 valor medido sob sabotagem | $3 valor que o assert VERDADEIRO exige
  if [ "$2" = "$3" ]; then bad "H:$1 SABOTADO e o assert seguiu VERDE -- o assert nao tem dente"
  else ok "H:$1 sabotado -> assert fica VERMELHO (veio [$2], o verdadeiro exige [$3])"; fi
}

# H1 — devolve `>= 0` ao helper: o preco 0 volta a ser computavel e C1 muda.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.margem_cliente_agregada()
 RETURNS TABLE(customer_user_id uuid, itens_computaveis bigint, itens_ignorados bigint,
               receita_computada numeric, custo_computado numeric, margem_pct numeric,
               itens_sem_preco bigint, itens_sem_custo bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','pg_temp'
AS $f$
  WITH custo AS (
    SELECT op.omie_codigo_produto AS cod,
           COALESCE(CASE WHEN pc.cost_final > 0 AND pc.cost_final < 'Infinity'::numeric THEN pc.cost_final END,
                    CASE WHEN pc.cost_price > 0 AND pc.cost_price < 'Infinity'::numeric THEN pc.cost_price END) AS custo_unit
      FROM public.omie_products op JOIN public.product_costs pc ON pc.product_id = op.id
     WHERE op.omie_codigo_produto IS NOT NULL),
  itens AS (
    SELECT oi.customer_user_id AS cid, oi.quantity::numeric AS qtd, oi.unit_price::numeric AS preco_unit, cu.custo_unit
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
      LEFT JOIN custo cu ON cu.cod = oi.omie_codigo_produto
     WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
       AND oi.customer_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = oi.customer_user_id AND cc.excluir_da_carteira IS TRUE)),
  norm AS (
    SELECT i.cid, i.qtd, i.preco_unit, i.custo_unit,
           (i.qtd IS NOT NULL AND i.qtd > 0 AND i.qtd < 'Infinity'::numeric) AS qtd_ok,
           -- SABOTAGEM: `>= 0` (a versao de hoje em prod)
           (i.preco_unit IS NOT NULL AND i.preco_unit >= 0 AND i.preco_unit < 'Infinity'::numeric) AS preco_ok,
           (i.custo_unit IS NOT NULL) AS custo_ok
      FROM itens i),
  flag AS (SELECT n.*, (n.qtd_ok AND n.preco_ok AND n.custo_ok) AS computavel FROM norm n)
  SELECT f.cid, count(*) FILTER (WHERE f.computavel), count(*) FILTER (WHERE NOT f.computavel),
         COALESCE(sum(f.preco_unit*f.qtd) FILTER (WHERE f.computavel),0),
         COALESCE(sum(f.custo_unit*f.qtd) FILTER (WHERE f.computavel),0),
         CASE WHEN COALESCE(sum(f.preco_unit*f.qtd) FILTER (WHERE f.computavel),0) > 0
              THEN round((sum(f.preco_unit*f.qtd) FILTER (WHERE f.computavel) - sum(f.custo_unit*f.qtd) FILTER (WHERE f.computavel))
                         / sum(f.preco_unit*f.qtd) FILTER (WHERE f.computavel) * 100, 2) ELSE NULL END,
         count(*) FILTER (WHERE NOT f.preco_ok), count(*) FILTER (WHERE NOT f.custo_ok)
    FROM flag f GROUP BY f.cid;
$f$;
SQL
falso "C1 (helper volta a >= 0)" "$(m "$c2")" "76.00"
falso "C3 (itens_sem_preco sob >= 0)" "$(Pq -c "SELECT itens_sem_preco FROM private.margem_cliente_agregada() WHERE customer_user_id='$c2';")" "4"

# H2 — sabota o ACL: GRANT ao authenticated. F2/F4 tem de virar 't'.
P -q -c "GRANT EXECUTE ON FUNCTION private.margem_cliente_agregada() TO authenticated;"
falso "F2 (ACL aberto ao authenticated)" "$(Pq -c "SELECT has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE');")" "f"

# restaura o mundo verdadeiro: re-aplica a migration REAL (idempotente)
P -q -f "$MIG"
eq "H0 restauracao: o mundo verdadeiro voltou (C1 de novo)" "$(m "$c2")" "76.00"
eq "H0b restauracao: ACL fechado de novo" "$(Pq -c "SELECT has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE');")" "f"

# H3 — sabota a RPC de ingestao: devolve o coalesce(...,0). B1 tem de virar 0.
P -q <<'SQL'
DO $sab$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='criar_pedidos_com_itens' AND p.prokind='f';
  v := replace(v,
    'CASE WHEN (it->>''unit_price'')::numeric >= 0',
    'CASE WHEN true OR (it->>''unit_price'')::numeric >= 0');
  v := replace(v, 'THEN (it->>''unit_price'')::numeric END,',
                  'THEN coalesce((it->>''unit_price'')::numeric, 0) END,');
  EXECUTE v;
END $sab$;
SQL
P -q <<SQL
SELECT public.criar_pedidos_com_itens('[{"account":"oben","hash_payload":"omie_oben_sab","customer_user_id":"$c1","created_by":"$sys","total":1,"status":"faturado","omie_pedido_id":77,"itens":[
  {"omie_codigo_produto":1001,"product_id":"$p1","customer_user_id":"$c1","quantity":1,"hash_payload":"sab_ausente"}]}]'::jsonb);
SQL
falso "B1 (RPC volta a fabricar 0)" "$(q sab_ausente)" "NULL"
P -q -f "$MIG"   # restaura

# H4 — devolve o diff NULL-blind à reconciliação. I6 (banco NULL, Omie manda 0) tem de
# parar de reescrever: é exatamente o item que ficaria eternamente dessincronizado.
P -q <<'SQL'
DO $sab$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconciliar_pedidos_omie' AND p.prokind='f';
  v := replace(v,
    '(    (a.unit_price IS NULL AND d.unit_price IS NULL)
                              OR (a.unit_price IS NOT NULL AND d.unit_price IS NOT NULL
                                  AND abs(a.unit_price - d.unit_price) < 1e-6) )',
    'abs(coalesce(a.unit_price, 0) - d.unit_price) < 1e-6');
  EXECUTE v;
END $sab$;
SQL
# volta o item para NULL, refaz o cenário do I6 e mede sob sabotagem
P -q -c "UPDATE public.order_items SET unit_price = NULL WHERE hash_payload='omie_oben_777_1001';"
falso "I6 (diff volta a NULL-blind)" "$(rec "$PED_ZERO")" "1"
P -q -f "$MIG"   # restaura
P -q -c "UPDATE public.order_items SET unit_price = NULL WHERE hash_payload='omie_oben_777_1001';"
eq "H0c restauracao: o diff NULL-safe voltou (I6 de novo)" "$(rec "$PED_ZERO")" "1"

# H5 — tira o NULLS LAST do ranking. J1 tem de inverter: o cliente SEM receita conhecida
# encabeça o top-50. É o P1 que esta migration introduziria se o bloco G não existisse.
P -q <<'SQL'
DO $sab$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='melhoria_clientes_por_produto' AND p.prokind='f';
  v := replace(v, 'order by valor_12m desc nulls last limit 50', 'order by valor_12m desc limit 50');
  v := replace(v, 'order by t.valor_12m desc nulls last)', 'order by t.valor_12m desc)');
  EXECUTE v;
END $sab$;
SQL
falso "J1 (ranking volta a NULLS FIRST)" "$(primeiro)" "Ranking COM receita alta"
P -q -f "$MIG"   # restaura
eq "H0d restauracao: o ranking voltou ao certo (J1 de novo)" "$(primeiro)" "Ranking COM receita alta"

# H6 — tira o FILTER do DENOMINADOR (só dele: é a metade que dilui). K1 tem de cair para 50,
# que é o preço fabricado — a média de 100 com uma linha cuja quantidade conta e cujo preço não.
P -q <<'SQL'
DO $sab$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_defasagem_cliente' AND p.prokind='f';
  v := replace(v,
    '/ sum(quantity) FILTER (WHERE unit_price > 0)',
    '/ sum(quantity)');
  v := replace(v,
    'CASE WHEN sum(quantity) FILTER (WHERE unit_price > 0) > 0',
    'CASE WHEN sum(quantity) > 0');
  EXECUTE v;
END $sab$;
SQL
falso "K1 (denominador volta a contar a linha sem preco)" "$(plast)" "100.0000000000000000"
P -q -f "$MIG"   # restaura
eq "H0e restauracao: a media voltou ao preco real (K1 de novo)" "$(plast)" "100.0000000000000000"

echo "════════════════════════════════════════"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "VERDE-REAL: migration prova os 4 objetos e a falsificacao confirmou o dente."

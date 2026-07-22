#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 de `public.get_carteira_margem_faixa()` (FU4-F fase 3)            ║
# ║    bash db/test-fu4f-fase3-carteira-margem-faixa.sh > log 2>&1; echo $?       ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                               ║
# ║  O que prova:                                                                 ║
# ║   · escopo espelha fcs_select_carteira (carteira própria; gestor vê tudo)      ║
# ║   · gate de PROJEÇÃO: margem_pct só sob cap_custo_ler; a FAIXA sempre sai      ║
# ║   · `g` usa a régua de percentis da POPULAÇÃO — mesmo valor para qualquer      ║
# ║     caller (o assert que sustenta a decisão de desenho de 2026-07-22)          ║
# ║   · `g` é NULL (não 0) quando a margem não é apurável — 0 é veredito           ║
# ║   · fail-closed sem auth.uid()                                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
# 5473: 5471 é do harness do #1495, 5472 do helper compartilhado.
PORT="${PGPORT_TEST:-5473}"
SLUG="fu4f3faixa"
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

# ── stubs espelhando a PROD ──────────────────────────────────────────────────
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;

CREATE SCHEMA IF NOT EXISTS private;
-- Default privilege do Supabase em AMBOS os schemas: sem isto o teste de ACL nasce fechado
-- por acidente e dá falso-verde.
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;

-- ⚠️ TABELAS ANTES DAS FUNÇÕES: `LANGUAGE sql` é validada no CREATE quando
-- `check_function_bodies=on` (o default) — referenciar tabela inexistente RECUSA o CREATE,
-- diferente de plpgsql, que aceita e só quebra ao executar. Criar `carteira_visivel_para` antes
-- de `carteira_teste` derruba o harness inteiro com "relation does not exist".
CREATE TABLE public.carteira_teste (cid uuid, dono uuid);
CREATE TABLE public.farmer_algorithm_config (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, omie_codigo_produto bigint UNIQUE);
CREATE TABLE public.product_costs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                   product_id uuid UNIQUE, cost_final numeric, cost_price numeric);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, status text, deleted_at timestamptz);
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                 sales_order_id uuid, customer_user_id uuid,
                                 omie_codigo_produto bigint, product_id uuid,
                                 quantity numeric, unit_price numeric);
CREATE TABLE public.cliente_classificacao (user_id uuid PRIMARY KEY, excluir_da_carteira boolean);

-- Capabilities controláveis por GUC (a prod resolve por has_role/carteira). Depois das tabelas.
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_custo',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_carteira',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM public.carteira_teste c
                                             WHERE c.cid=_customer_user_id AND c.dono=_uid) $f$;
SQL

# ── migrations REAIS, na ordem ───────────────────────────────────────────────
P -q -f "$REPO_ROOT/supabase/migrations/20260726150000_margem_cliente_helper_compartilhado.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726160000_margem_reconciliacao_universo_unico.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726170000_fu4f_fase3_carteira_margem_faixa.sql"

# ── seed: 5 clientes com margens espalhadas, em 2 carteiras ──────────────────
P -q <<'SQL'
INSERT INTO public.farmer_algorithm_config(key,value) VALUES
  ('margem_faixa_piso_pct','30'), ('margem_faixa_meta_pct','50')
ON CONFLICT (key) DO NOTHING;

-- SKUs: custo 90 / 70 / 50 / 10 / sem custo
INSERT INTO public.omie_products(id, omie_codigo_produto) VALUES
  ('d0000000-0000-0000-0000-000000000001', 2001),
  ('d0000000-0000-0000-0000-000000000002', 2002),
  ('d0000000-0000-0000-0000-000000000003', 2003),
  ('d0000000-0000-0000-0000-000000000004', 2004),
  ('d0000000-0000-0000-0000-000000000009', 2009);
INSERT INTO public.product_costs(product_id, cost_final) VALUES
  ('d0000000-0000-0000-0000-000000000001', 110),  -- preço 100 → -10%  (vermelho)
  ('d0000000-0000-0000-0000-000000000002',  80),  -- preço 100 →  20%  (amarelo)
  ('d0000000-0000-0000-0000-000000000003',  60),  -- preço 100 →  40%  (verde/abaixo_da_meta)
  ('d0000000-0000-0000-0000-000000000004',  10);  -- preço 100 →  90%  (verde/saudavel)
-- 2009 fica SEM linha de custo → cliente que só o compra é `neutro`

INSERT INTO public.sales_orders(id,status,deleted_at) VALUES
  ('50000000-0000-0000-0000-000000000001','faturado',NULL),
  ('50000000-0000-0000-0000-000000000002','faturado',NULL),
  ('50000000-0000-0000-0000-000000000003','faturado',NULL),
  ('50000000-0000-0000-0000-000000000004','faturado',NULL),
  ('50000000-0000-0000-0000-000000000005','faturado',NULL);

-- carteira do vendedor A: clientes 1 e 2 | vendedor B: clientes 3, 4 e 5
INSERT INTO public.carteira_teste(cid,dono) VALUES
  ('c1000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-00000000000a'),
  ('c2000000-0000-0000-0000-000000000002','aa000000-0000-0000-0000-00000000000a'),
  ('c3000000-0000-0000-0000-000000000003','bb000000-0000-0000-0000-00000000000b'),
  ('c4000000-0000-0000-0000-000000000004','bb000000-0000-0000-0000-00000000000b'),
  ('c5000000-0000-0000-0000-000000000005','bb000000-0000-0000-0000-00000000000b');

INSERT INTO public.order_items(sales_order_id,customer_user_id,omie_codigo_produto,quantity,unit_price) VALUES
  ('50000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',2001,1,100), -- -10%
  ('50000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000002',2002,1,100), --  20%
  ('50000000-0000-0000-0000-000000000003','c3000000-0000-0000-0000-000000000003',2003,1,100), --  40%
  ('50000000-0000-0000-0000-000000000004','c4000000-0000-0000-0000-000000000004',2004,1,100), --  90%
  ('50000000-0000-0000-0000-000000000005','c5000000-0000-0000-0000-000000000005',2009,1,100); -- sem custo
SQL

# helper: roda como um caller específico
como() { P -tA -q -c "SET test.uid='$1'; SET test.cap_custo='$2'; SET test.cap_carteira='$3'; $4"; }
A=aa000000-0000-0000-0000-00000000000a
B=bb000000-0000-0000-0000-00000000000b

echo "-- E. escopo (espelha fcs_select_carteira) --"
eq "E1 vendedor A vê só os 2 da carteira dele" \
   "$(como $A false false "SELECT count(*) FROM public.get_carteira_margem_faixa();")" "2"
eq "E2 vendedor B vê só os 3 dele" \
   "$(como $B false false "SELECT count(*) FROM public.get_carteira_margem_faixa();")" "3"
eq "E3 A NÃO alcança cliente de B" \
   "$(como $A false false "SELECT count(*) FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c3000000-0000-0000-0000-000000000003';")" "0"
eq "E4 gestor (cap_carteira_ler) vê os 5" \
   "$(como $A false true "SELECT count(*) FROM public.get_carteira_margem_faixa();")" "5"
eq "E5 fail-closed: sem auth.uid() → zero linhas" \
   "$(P -tA -q -c "SET test.uid=''; SELECT count(*) FROM public.get_carteira_margem_faixa();")" "0"

echo "-- F. gate de PROJEÇÃO do número --"
eq "F1 com cap_custo_ler, margem_pct é o valor EXATO" \
   "$(como $A true false "SELECT margem_pct FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" "20.00"
eq "F2 SEM cap_custo_ler, margem_pct é NULL" \
   "$(como $A false false "SELECT coalesce(margem_pct::text,'') FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" ""
eq "F3 a FAIXA sai mesmo sem cap_custo_ler (o sinal fica)" \
   "$(como $A false false "SELECT faixa FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" "amarelo"
eq "F4 o MOTIVO sai mesmo sem cap_custo_ler" \
   "$(como $A false false "SELECT motivo FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" "abaixo_do_piso"
eq "F5 o campo g sai mesmo sem cap_custo_ler (é ele que preserva o score)" \
   "$(como $A false false "SELECT (g IS NOT NULL)::text FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" "true"

echo "-- G. classificação --"
eq "G1 margem negativa → vermelho/abaixo_do_custo" \
   "$(como $A false false "SELECT faixa||'|'||motivo FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c1000000-0000-0000-0000-000000000001';")" "vermelho|abaixo_do_custo"
eq "G2 40% → verde/abaixo_da_meta" \
   "$(como $B false false "SELECT faixa||'|'||motivo FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c3000000-0000-0000-0000-000000000003';")" "verde|abaixo_da_meta"
eq "G3 90% → verde/saudavel" \
   "$(como $B false false "SELECT faixa||'|'||motivo FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c4000000-0000-0000-0000-000000000004';")" "verde|saudavel"
eq "G4 sem custo → neutro/sem_custo" \
   "$(como $B false false "SELECT faixa||'|'||motivo FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c5000000-0000-0000-0000-000000000005';")" "neutro|sem_custo"

echo "-- H. o campo g (a decisao de desenho de 2026-07-22) --"
# ⚠️ ASSERT DECISIVO: a régua é da POPULAÇÃO, não da carteira. O mesmo cliente tem de receber o
# MESMO `g` seja quem for que pergunta. Se a régua fosse calculada depois do filtro de escopo, o
# vendedor A (2 clientes) e o gestor (5 clientes) veriam percentis diferentes para o mesmo cliente
# — e o health score passaria a depender de QUEM calcula.
G_VENDEDOR="$(como $A false false "SELECT g FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")"
G_GESTOR="$(como $A false true  "SELECT g FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")"
eq "H1 o g e o MESMO para vendedor e gestor (régua populacional)" "$G_VENDEDOR" "$G_GESTOR"

# Régua sobre a população: margens -0,10 / 0,20 / 0,40 / 0,90 (o `neutro` não entra).
# p10 = -0,010 ; p90 = 0,750 ; range = 0,760.
#   cliente 2 (0,20): (0,20 - (-0,010)) / 0,760 = 0,2763…
eq "H2 o g bate a regua de percentis calculada à mão" \
   "$(como $A false false "SELECT round(g,4) FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" "0.2763"
eq "H3 o melhor da população satura em 1" \
   "$(como $B false false "SELECT round(g,2) FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c4000000-0000-0000-0000-000000000004';")" "1.00"
eq "H4 o pior satura em 0" \
   "$(como $A false false "SELECT round(g,2) FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c1000000-0000-0000-0000-000000000001';")" "0.00"
# ⚠️ 0 é VEREDITO ("pior margem da população"), NULL é "não sei". Confundi-los reintroduz a
# fabricação que o #1533 removeu — o calcularHealthScore renormaliza o peso quando g é NULL.
eq "H5 sem custo -> g e NULL, NÃO 0" \
   "$(como $B false false "SELECT coalesce(g::text,'NULO') FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c5000000-0000-0000-0000-000000000005';")" "NULO"

echo "-- I. ACL --"
eq "I1 anon NÃO executa" \
   "$(Pq -q -c "SELECT has_function_privilege('anon','public.get_carteira_margem_faixa()','EXECUTE');")" "f"
eq "I2 authenticated EXECUTA (é o vendedor; o gate está no corpo)" \
   "$(Pq -q -c "SELECT has_function_privilege('authenticated','public.get_carteira_margem_faixa()','EXECUTE');")" "t"
eq "I3 PUBLIC NÃO executa" \
   "$(Pq -q -c "SELECT has_function_privilege('public','public.get_carteira_margem_faixa()','EXECUTE');")" "f"
eq "I4 é SECURITY DEFINER" \
   "$(Pq -q -c "SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")" "t"

echo "-- J. idempotência --"
P -q -f "$REPO_ROOT/supabase/migrations/20260726170000_fu4f_fase3_carteira_margem_faixa.sql"
eq "J1 re-aplicar não muda a faixa" \
   "$(como $A false false "SELECT faixa FROM public.get_carteira_margem_faixa() WHERE customer_user_id='c2000000-0000-0000-0000-000000000002';")" "amarelo"
eq "J2 re-aplicar preserva o REVOKE de anon" \
   "$(Pq -q -c "SELECT has_function_privilege('anon','public.get_carteira_margem_faixa()','EXECUTE');")" "f"

echo "========================================"
echo "  $PASS verde(s), $FAIL vermelho(s)"
[ "$FAIL" -eq 0 ] || exit 1
echo "  TODOS OS ASSERTS PASSARAM"

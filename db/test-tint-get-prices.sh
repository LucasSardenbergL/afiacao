#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — get_tint_prices (BATCH) — money-path com FALSIFICAÇÃO          ║
# ║  Espelha db/test-tint-get-price.sh (single); prova a versão que calcula N      ║
# ║  fórmulas de uma vez (mapa { formula_id: breakdown }) p/ alternativas/global.  ║
# ║      bash db/test-tint-get-prices.sh > /tmp/t.log 2>&1; echo "exit=$?"         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5456}"     # 5456 p/ não colidir com o harness single (5455)
SLUG="tint-get-prices"
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
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — tabelas que a RPC lê (só colunas usadas; a batch NÃO tem gate de staff) ──
P -q <<'SQL'
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, valor_unitario numeric, ativo boolean DEFAULT true);
CREATE TABLE public.tint_skus (id uuid PRIMARY KEY, omie_product_id uuid);
CREATE TABLE public.tint_corantes (id uuid PRIMARY KEY, descricao text, volume_total_ml numeric, omie_product_id uuid);
CREATE TABLE public.tint_formulas (id uuid PRIMARY KEY, sku_id uuid);
CREATE TABLE public.tint_formula_itens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formula_id uuid, corante_id uuid, qtd_ml numeric, ordem int);
SQL

# A migration de gate recria as DUAS RPCs: get_tint_prices (testada aqui) E get_tint_price
# (single, plpgsql, referencia app_role/has_role/auth.uid no corpo). Stub mínimo p/ o arquivo
# aplicar limpo — a single não é exercida neste harness, mas o CREATE dela vem junto.
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_uid AND role=_role) $f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260616120000_tint_price_gate_ativo.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seeds (iguais ao harness single, sem user_roles) ──
P -q <<'SQL'
INSERT INTO public.omie_products(id, valor_unitario) VALUES
  ('b0000000-0000-0000-0000-000000000001', 449.9),  -- base ok
  ('b0000000-0000-0000-0000-000000000002', 0),       -- base zerada (PRD03657)
  ('b0000000-0000-0000-0000-000000000003', 100),     -- corante (100/1000ml = 0,10/ml)
  ('b0000000-0000-0000-0000-000000000004', 0);       -- corante preço ZERO (dado inválido)

INSERT INTO public.tint_skus(id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002');

INSERT INTO public.tint_corantes(id, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','Corante OK', 1000, 'b0000000-0000-0000-0000-000000000003'),
  ('c0000000-0000-0000-0000-000000000002','Corante sem Omie', 1000, NULL),
  ('c0000000-0000-0000-0000-000000000003','Corante preço 0', 1000, 'b0000000-0000-0000-0000-000000000004');

INSERT INTO public.tint_formulas(id, sku_id) VALUES
  ('f0000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001'),  -- f_ok
  ('f0000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002'),  -- f_zero
  ('f0000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000001'),  -- f_pura (sem itens)
  ('f0000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000001'),  -- f_inc (corante misto)
  ('f0000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000001');   -- f_cor_zero

INSERT INTO public.tint_formula_itens(formula_id, corante_id, qtd_ml, ordem) VALUES
  ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001', 1135.4, 1),  -- f_ok: 113,54 → 563,44
  ('f0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000001', 10, 1),       -- f_zero
  ('f0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000001', 10, 1),       -- f_inc: corante OK (1,00)
  ('f0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000002', 20, 2),       -- f_inc: + corante sem custo (MISTURA → testa bool_and/NULL)
  ('f0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000003', 10, 1);       -- f_cor_zero: corante preço 0

GRANT EXECUTE ON FUNCTION public.get_tint_prices(uuid[]) TO authenticated, anon;
SQL

# Seed do GATE DE ativo (achado Codex 16/06): base/corante INATIVOS no Omie, valor congelado > 0.
P -q <<'SQL'
INSERT INTO public.omie_products(id, valor_unitario, ativo) VALUES
  ('b0000000-0000-0000-0000-000000000005', 500, false),  -- base INATIVA (valor > 0)
  ('b0000000-0000-0000-0000-000000000006', 100, false);   -- corante c/ produto Omie INATIVO (valor > 0)
INSERT INTO public.tint_skus(id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000005');
INSERT INTO public.tint_corantes(id, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000004','Corante c/ produto inativo', 1000, 'b0000000-0000-0000-0000-000000000006');
INSERT INTO public.tint_formulas(id, sku_id) VALUES
  ('f0000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000003'),  -- f_base_inat: base inativa + corante OK
  ('f0000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000001');   -- f_cor_inat: base ativa + corante inativo
INSERT INTO public.tint_formula_itens(formula_id, corante_id, qtd_ml, ordem) VALUES
  ('f0000000-0000-0000-0000-000000000006','c0000000-0000-0000-0000-000000000001', 10, 1),  -- corante OK (isola: NULL vem da base)
  ('f0000000-0000-0000-0000-000000000007','c0000000-0000-0000-0000-000000000004', 10, 1);   -- corante inativo (isola: base ativa)
SQL

# ── ZONA 4 — asserts ──
echo "── asserts ──"
F_OK="f0000000-0000-0000-0000-000000000001"
F_ZERO="f0000000-0000-0000-0000-000000000002"
F_PURA="f0000000-0000-0000-0000-000000000003"
F_INC="f0000000-0000-0000-0000-000000000004"
F_COR_ZERO="f0000000-0000-0000-0000-000000000005"
F_BASE_INAT="f0000000-0000-0000-0000-000000000006"
F_COR_INAT="f0000000-0000-0000-0000-000000000007"
GHOST="99999999-9999-9999-9999-999999999999"

# P1 — single id no batch → precoFinal = base + corantes
V=$(Pq -c "SELECT ((public.get_tint_prices(ARRAY['$F_OK']::uuid[]) -> '$F_OK' ->> 'precoFinal')::numeric = 563.44);")
eq "P1 precoFinal = base+corantes (563,44)" "$V" "t"
V=$(Pq -c "SELECT ((public.get_tint_prices(ARRAY['$F_OK']::uuid[]) -> '$F_OK' ->> 'custoBase')::numeric = 449.9);")
eq "P1b custoBase = preço da base" "$V" "t"

# PB — BATCH de verdade: vários ids de uma vez, cada um correto (o diferencial da função)
M="public.get_tint_prices(ARRAY['$F_OK','$F_ZERO','$F_PURA','$F_INC','$F_COR_ZERO']::uuid[])"
V=$(Pq -c "SELECT (SELECT count(*) FROM jsonb_object_keys($M)) = 5;")
eq "PB batch retorna 5 entradas (1 por fórmula)" "$V" "t"
V=$(Pq -c "SELECT (($M -> '$F_OK' ->> 'precoFinal')::numeric = 563.44);")
eq "PB[F_OK] precoFinal 563,44" "$V" "t"
V=$(Pq -c "SELECT ($M -> '$F_ZERO' ->> 'precoFinal') IS NULL;")
eq "PB[F_ZERO] precoFinal NULL (base zerada)" "$V" "t"
V=$(Pq -c "SELECT ($M -> '$F_PURA' ->> 'precoFinal') IS NULL;")
eq "PB[F_PURA] precoFinal NULL (receita faltando, fail closed)" "$V" "t"
V=$(Pq -c "SELECT ($M -> '$F_INC' ->> 'precoFinal') IS NULL;")
eq "PB[F_INC] precoFinal NULL (corante misto sem custo)" "$V" "t"
V=$(Pq -c "SELECT ($M -> '$F_COR_ZERO' ->> 'precoFinal') IS NULL;")
eq "PB[F_COR_ZERO] precoFinal NULL (corante preço 0)" "$V" "t"

# N — flags coerentes
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_ZERO']::uuid[]) -> '$F_ZERO' ->> 'baseDisponivel');")
eq "N1 base zerada → baseDisponivel false" "$V" "false"
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_PURA']::uuid[]) -> '$F_PURA' ->> 'corantesCompletos');")
eq "N3 receita vazia → corantesCompletos false" "$V" "false"
V=$(Pq -c "SELECT ((public.get_tint_prices(ARRAY['$F_INC']::uuid[]) -> '$F_INC' ->> 'custoCorantes')::numeric = 1.0);")
eq "N2c corante incompleto → custoCorantes parcial (1,00)" "$V" "t"

# N5 — base INATIVA no Omie (valor>0) → baseDisponivel false, custoBase/precoFinal NULL (não vende descontinuado)
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_BASE_INAT']::uuid[]) -> '$F_BASE_INAT' ->> 'baseDisponivel');")
eq "N5 base inativa → baseDisponivel false" "$V" "false"
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_BASE_INAT']::uuid[]) -> '$F_BASE_INAT' ->> 'custoBase') IS NULL;")
eq "N5b base inativa → custoBase NULL" "$V" "t"
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_BASE_INAT']::uuid[]) -> '$F_BASE_INAT' ->> 'precoFinal') IS NULL;")
eq "N5c base inativa → precoFinal NULL (não vende base desativada no Omie)" "$V" "t"

# N6 — corante c/ produto Omie INATIVO → corantesCompletos false, precoFinal NULL (base é ativa → isola)
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_COR_INAT']::uuid[]) -> '$F_COR_INAT' ->> 'baseDisponivel');")
eq "N6 corante inativo → baseDisponivel true (base ativa)" "$V" "true"
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_COR_INAT']::uuid[]) -> '$F_COR_INAT' ->> 'corantesCompletos');")
eq "N6b corante inativo → corantesCompletos false" "$V" "false"
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_COR_INAT']::uuid[]) -> '$F_COR_INAT' ->> 'precoFinal') IS NULL;")
eq "N6c corante inativo → precoFinal NULL" "$V" "t"

# Bordas do batch
V=$(Pq -c "SELECT public.get_tint_prices(ARRAY[]::uuid[]) = '{}'::jsonb;")
eq "B1 array vazio → {} (não quebra)" "$V" "t"
V=$(Pq -c "SELECT public.get_tint_prices(ARRAY['$GHOST']::uuid[]) = '{}'::jsonb;")
eq "B2 id inexistente → {} (não inventa entrada)" "$V" "t"
# não vaza a receita (itensCorantes) — operador ? checa se a chave existe
V=$(Pq -c "SELECT public.get_tint_prices(ARRAY['$F_OK']::uuid[]) -> '$F_OK' ? 'itensCorantes';")
eq "B3 batch NÃO expõe itensCorantes (receita/IP)" "$V" "f"

# ── ZONA 5 — falsificação ──
echo "── falsificação ──"

apply_real() { P -q -f "$MIG"; }

# F1 — SABOTA a base: precoFinal vira só corantes (ignora a base)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH corantes AS (
    SELECT fi.formula_id,
           COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) AS cc
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id
    WHERE fi.formula_id = ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(formula_id, jsonb_build_object('precoFinal', cc)), '{}'::jsonb) FROM corantes;
$fn$;
SQL
V=$(Pq -c "SELECT ((public.get_tint_prices(ARRAY['$F_OK']::uuid[]) -> '$F_OK' ->> 'precoFinal')::numeric = 563.44);")
if [ "$V" = "f" ]; then ok "F1 base sabotada → P1 vermelho"; else bad "F1 sabotei a base e P1 seguiu verde → fraco"; fi
apply_real

# F2 — SABOTA a blindagem: soma mesmo com corante incompleto (ignora corantes_completos)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id, COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object('precoFinal', CASE WHEN b.bd THEN b.bp+COALESCE(co.cc,0) ELSE NULL END)),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_INC']::uuid[]) -> '$F_INC' ->> 'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F2 blindagem sabotada → N2/PB[F_INC] vermelho"; else bad "F2 sabotei a blindagem e seguiu verde → fraco"; fi
apply_real

# F3 — SABOTA a lógica de 3 valores: COALESCE(valor,0)>0 vira valor>0 (NULL ignorado pelo bool_and)
#      F_INC mistura corante COM custo + corante sem omie (NULL): bool_and(true, NULL)=true → completo errado.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id,
            COALESCE(SUM(CASE WHEN op.valor_unitario>0 AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,
            COALESCE(bool_and(op.valor_unitario>0 AND c.volume_total_ml>0), false) comp   -- SABOTADO: sem COALESCE(...,0), NULL escapa
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object('precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,false) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END)),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_INC']::uuid[]) -> '$F_INC' ->> 'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F3 lógica-3-valores sabotada → N2 vermelho (bool_and ignorou o NULL)"; else bad "F3 sabotei o COALESCE e seguiu verde → fraco (three-valued não pego)"; fi
apply_real

# F4 — SABOTA o corante preço-0: volta pra IS NOT NULL (aceita preço 0 como custo)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id,
            COALESCE(SUM(CASE WHEN op.valor_unitario IS NOT NULL AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,
            COALESCE(bool_and(op.valor_unitario IS NOT NULL AND c.volume_total_ml>0), false) comp   -- SABOTADO: aceita preço 0
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object('precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,false) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END)),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_COR_ZERO']::uuid[]) -> '$F_COR_ZERO' ->> 'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F4 corante-0 sabotado → N4 vermelho (aceitou preço 0)"; else bad "F4 sabotei o >0 e N4 seguiu verde → fraco"; fi
apply_real

# F5 — SABOTA o fail-closed da fórmula SEM itens: o COALESCE da SAÍDA vira ,true.
#      F_PURA não tem itens → LEFT JOIN ausente (co.comp NULL); a versão real faz COALESCE(NULL,false)=false
#      (não cobra só a base). Sabotando p/ COALESCE(NULL,true), a receita vazia vira "completa" e cobra a base.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id,
            COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,
            COALESCE(bool_and(COALESCE(op.valor_unitario,0)>0 AND c.volume_total_ml>0), false) comp
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object(
    -- SABOTADO: COALESCE(co.comp, TRUE) → fórmula sem itens (co ausente) vira "completa" e cobra a base.
    'precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,true) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END
  )),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_PURA']::uuid[]) -> '$F_PURA' ->> 'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F5 fail-closed sabotado → PB[F_PURA] vermelho (receita vazia deixou de ser NULL)"; else bad "F5 sabotei o fail-closed e seguiu verde → fraco"; fi
apply_real

# F6 — SABOTA o gate da BASE: tira o "AND COALESCE(op.ativo,false)" da base → base inativa precifica.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0) bd  -- SABOTADO: sem ativo
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id, COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,
            COALESCE(bool_and(COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0), false) comp
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object('precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,false) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END)),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_BASE_INAT']::uuid[]) -> '$F_BASE_INAT' ->> 'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F6 gate-base sabotado → N5 vermelho (base inativa voltou a precificar)"; else bad "F6 sabotei o gate da base e N5 seguiu verde → fraco"; fi
apply_real

# F7 — SABOTA o gate do CORANTE: tira o "AND COALESCE(op.ativo,false)" do corante → corante inativo conta.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0 AND COALESCE(op.ativo,false)) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id, COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,  -- SABOTADO: sem ativo
            COALESCE(bool_and(COALESCE(op.valor_unitario,0)>0 AND c.volume_total_ml>0), false) comp
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object('precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,false) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END)),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_prices(ARRAY['$F_COR_INAT']::uuid[]) -> '$F_COR_INAT' ->> 'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F7 gate-corante sabotado → N6 vermelho (corante inativo voltou a contar)"; else bad "F7 sabotei o gate do corante e N6 seguiu verde → fraco"; fi
apply_real

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

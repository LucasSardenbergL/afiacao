#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — GATE DE CUSTO POR STAFF (P1) — get_tint_price + get_tint_prices ║
# ║  Prova o gate de PROJEÇÃO da migration 20260708234100: custoBase/custoCorantes  ║
# ║  só p/ staff (employee/master); customer/anon veem NULL MAS mantêm precoFinal.  ║
# ║  Cobre AS DUAS funções (singular plpgsql + batch sql) + FALSIFICAÇÃO cruzada.   ║
# ║      bash db/test-tint-gate-custo-staff.sh > /tmp/t.log 2>&1; echo "exit=$?"    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5458}"     # 5458 p/ não colidir com single(5455)/batch(5456)
SLUG="tint-gate-custo-staff"
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

# ── ZONA 1 — tabelas + gate de staff (app_role/user_roles/has_role/auth.uid) ──
P -q <<'SQL'
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, valor_unitario numeric, ativo boolean DEFAULT true);
CREATE TABLE public.tint_skus (id uuid PRIMARY KEY, omie_product_id uuid);
CREATE TABLE public.tint_corantes (id uuid PRIMARY KEY, descricao text, volume_total_ml numeric, omie_product_id uuid);
CREATE TABLE public.tint_formulas (id uuid PRIMARY KEY, sku_id uuid);
CREATE TABLE public.tint_formula_itens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formula_id uuid, corante_id uuid, qtd_ml numeric, ordem int);

CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_uid AND role=_role) $f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
SQL

# ── ZONA 2 — aplicar a migration REAL (o gate que estamos provando) ──
MIG="$REPO_ROOT/supabase/migrations/20260708234100_tint_gate_custo_staff.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed: 1 fórmula COMPLETA (custoBase=200, custoCorantes=5, precoFinal=205) ──
# + 3 identidades: staff(employee), master, customer(sem role staff).
P -q <<'SQL'
INSERT INTO public.omie_products(id, valor_unitario, ativo) VALUES
  ('a0000000-0000-0000-0000-000000000001', 200, true),   -- base ativa
  ('a0000000-0000-0000-0000-000000000002', 100, true);    -- corante (100/1000ml = 0,10/ml)
INSERT INTO public.tint_skus(id, omie_product_id) VALUES
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001');
INSERT INTO public.tint_corantes(id, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','Corante OK', 1000, 'a0000000-0000-0000-0000-000000000002');
INSERT INTO public.tint_formulas(id, sku_id) VALUES
  ('f0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001');
INSERT INTO public.tint_formula_itens(formula_id, corante_id, qtd_ml, ordem) VALUES
  ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001', 50, 1);  -- 50 * 0,10 = 5,00

INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),  -- staff
  ('22222222-2222-2222-2222-222222222222','master'),    -- master (também staff)
  ('33333333-3333-3333-3333-333333333333','customer');   -- customer (NÃO staff)

GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

UID_STAFF="11111111-1111-1111-1111-111111111111"
UID_MASTER="22222222-2222-2222-2222-222222222222"
UID_CLI="33333333-3333-3333-3333-333333333333"
F_OK="f0000000-0000-0000-0000-000000000001"
SBATCH="public.get_tint_prices(ARRAY['$F_OK']::uuid[]) -> '$F_OK'"
SSING="public.get_tint_price('$F_OK'::uuid)"

# helper: roda como authenticated impersonando um uid (o cenário real do PostgREST)
gate()  { Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT $2;" | tail -1; }
# helper: sem uid (auth.uid() NULL) — anon-like, rodando como postgres com GUC vazio
nouid() { Pq -c "SET test.uid=''; SELECT $1;" | tail -1; }

# ── ZONA 4 — asserts ──
echo "── STAFF (employee) vê o custo ──"
eq "S1 staff singular custoBase=200"     "$(gate "$UID_STAFF" "($SSING ->> 'custoBase')::numeric = 200")"    "t"
eq "S2 staff singular custoCorantes=5"   "$(gate "$UID_STAFF" "($SSING ->> 'custoCorantes')::numeric = 5")"  "t"
eq "S3 staff singular precoFinal=205"    "$(gate "$UID_STAFF" "($SSING ->> 'precoFinal')::numeric = 205")"   "t"
eq "S4 staff batch custoBase=200"        "$(gate "$UID_STAFF" "($SBATCH ->> 'custoBase')::numeric = 200")"   "t"
eq "S5 staff batch custoCorantes=5"      "$(gate "$UID_STAFF" "($SBATCH ->> 'custoCorantes')::numeric = 5")" "t"
eq "S6 staff batch precoFinal=205"       "$(gate "$UID_STAFF" "($SBATCH ->> 'precoFinal')::numeric = 205")"  "t"

echo "── MASTER também é staff ──"
eq "S7 master singular custoBase=200"    "$(gate "$UID_MASTER" "($SSING ->> 'custoBase')::numeric = 200")"   "t"
eq "S8 master batch custoBase=200"       "$(gate "$UID_MASTER" "($SBATCH ->> 'custoBase')::numeric = 200")"  "t"

echo "── CUSTOMER: custo ESCONDIDO, preço PRESERVADO (o coração do fix) ──"
eq "C1 customer singular custoBase NULL"       "$(gate "$UID_CLI" "($SSING ->> 'custoBase') IS NULL")"           "t"
eq "C2 customer singular custoCorantes NULL"   "$(gate "$UID_CLI" "($SSING ->> 'custoCorantes') IS NULL")"       "t"
eq "C3 customer singular precoFinal=205 (mantido)" "$(gate "$UID_CLI" "($SSING ->> 'precoFinal')::numeric = 205")" "t"
eq "C4 customer singular baseDisponivel=true"  "$(gate "$UID_CLI" "($SSING ->> 'baseDisponivel')")"              "true"
eq "C5 customer singular corantesCompletos=true" "$(gate "$UID_CLI" "($SSING ->> 'corantesCompletos')")"         "true"
eq "C6 customer batch custoBase NULL"          "$(gate "$UID_CLI" "($SBATCH ->> 'custoBase') IS NULL")"          "t"
eq "C7 customer batch custoCorantes NULL"      "$(gate "$UID_CLI" "($SBATCH ->> 'custoCorantes') IS NULL")"      "t"
eq "C8 customer batch precoFinal=205 (mantido)" "$(gate "$UID_CLI" "($SBATCH ->> 'precoFinal')::numeric = 205")" "t"
eq "C9 customer batch baseDisponivel=true"     "$(gate "$UID_CLI" "($SBATCH ->> 'baseDisponivel')")"             "true"
eq "C10 customer batch corantesCompletos=true" "$(gate "$UID_CLI" "($SBATCH ->> 'corantesCompletos')")"          "true"

echo "── SEM uid (auth.uid() NULL) também esconde (fail-closed) ──"
eq "A1 no-uid singular custoBase NULL"   "$(nouid "($SSING ->> 'custoBase') IS NULL")"                "t"
eq "A2 no-uid batch custoBase NULL"      "$(nouid "($SBATCH ->> 'custoBase') IS NULL")"               "t"
eq "A3 no-uid singular precoFinal=205 (preço não depende de staff)" "$(nouid "($SSING ->> 'precoFinal')::numeric = 205")" "t"

# a chave existe (é null JSON), não some — contrato estável p/ o front
eq "A4 custoBase é chave PRESENTE (valor null), não ausente" "$(gate "$UID_CLI" "$SSING ? 'custoBase'")" "t"

# ── ZONA 5 — falsificação (sabota o gate → o custo VAZA p/ customer → dente do assert) ──
echo "── falsificação ──"
apply_real() { P -q -f "$MIG"; }

# FG1 — SABOTA o gate do BATCH (custoBase sem s.is_staff) → customer volta a ver custoBase.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0 AND COALESCE(op.ativo,false)) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id, COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,
            COALESCE(bool_and(COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0), false) comp
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object(
    'custoBase', CASE WHEN b.bd THEN b.bp ELSE NULL END,  -- SABOTADO: sem gate de staff
    'custoCorantes', CASE WHEN b.bd THEN COALESCE(co.cc,0) ELSE NULL END,
    'precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,false) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END
  )),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(gate "$UID_CLI" "($SBATCH ->> 'custoBase') IS NULL")
if [ "$V" = "f" ]; then ok "FG1 gate-batch sabotado → custoBase VAZOU p/ customer (C6 morderia)"; else bad "FG1 sabotei o gate do batch e custoBase seguiu NULL → C6 fraco"; fi
apply_real

# FG2 — SABOTA o gate do SINGULAR (custoCorantes sem v_is_staff) → customer volta a ver custoCorantes.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_is_staff boolean; v_bp numeric; v_ba boolean; v_bd boolean; v_cb numeric; v_cc numeric; v_comp boolean; v_pf numeric;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
  SELECT op.valor_unitario, op.ativo INTO v_bp, v_ba FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=p_formula_id;
  v_bd := v_bp IS NOT NULL AND v_bp>0 AND COALESCE(v_ba,false);
  v_cb := CASE WHEN v_bd THEN v_bp ELSE NULL END;
  SELECT COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0),
         COALESCE(bool_and(COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0), false)
    INTO v_cc, v_comp
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=p_formula_id;
  v_pf := CASE WHEN v_bd AND v_comp THEN v_cb+v_cc ELSE NULL END;
  RETURN jsonb_build_object(
    'custoBase', CASE WHEN v_is_staff THEN v_cb ELSE NULL END,
    'baseDisponivel', v_bd,
    'custoCorantes', v_cc,   -- SABOTADO: sem gate de staff
    'corantesCompletos', v_comp,
    'precoFinal', v_pf,
    'itensCorantes', '[]'::jsonb
  );
END; $fn$;
SQL
V=$(gate "$UID_CLI" "($SSING ->> 'custoCorantes') IS NULL")
if [ "$V" = "f" ]; then ok "FG2 gate-singular sabotado → custoCorantes VAZOU p/ customer (C2 morderia)"; else bad "FG2 sabotei o gate do singular e custoCorantes seguiu NULL → C2 fraco"; fi
apply_real

# FG3 — SABOTA p/ esconder de TODOS (gate=false no batch) → STAFF perde custoBase (o assert S4 tem dente).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH bases AS (SELECT f.id fid, op.valor_unitario bp, (op.valor_unitario IS NOT NULL AND op.valor_unitario>0 AND COALESCE(op.ativo,false)) bd
    FROM tint_formulas f LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=ANY(p_formula_ids)),
  cor AS (SELECT fi.formula_id, COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0 THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) cc,
            COALESCE(bool_and(COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml>0), false) comp
    FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=ANY(p_formula_ids) GROUP BY fi.formula_id)
  SELECT COALESCE(jsonb_object_agg(b.fid, jsonb_build_object(
    'custoBase', CASE WHEN false AND b.bd THEN b.bp ELSE NULL END,  -- SABOTADO: esconde de TODOS (inclusive staff)
    'precoFinal', CASE WHEN b.bd AND COALESCE(co.comp,false) THEN b.bp+COALESCE(co.cc,0) ELSE NULL END
  )),'{}'::jsonb)
  FROM bases b LEFT JOIN cor co ON co.formula_id=b.fid;
$fn$;
SQL
V=$(gate "$UID_STAFF" "($SBATCH ->> 'custoBase') IS NOT NULL")
if [ "$V" = "f" ]; then ok "FG3 gate=false sabotado → STAFF perdeu custoBase (S4 morderia)"; else bad "FG3 escondi de todos e staff seguiu vendo → S4 fraco"; fi
apply_real

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

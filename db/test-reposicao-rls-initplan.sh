#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA: migration 20260627170000_reposicao_rls_initplan.sql                    ║
# ║  Fix de RLS has_role por-linha → InitPlan em 36 policies de 15 tabelas base    ║
# ║  da reposição. Prova: (A1) autorização IDÊNTICA old↔new (matriz 15×6 callers), ║
# ║  (A2) catálogo de policy preservado (cmd/roles/permissive/clauses — anti-drift ║
# ║  do ALTER POLICY), (A3) wrap aplicado nas 36, (A4) autz absoluta, (A5) WITH    ║
# ║  CHECK (incl. classe master-only), (A6) has_role O(1) InitPlan. Falsifica:     ║
# ║  F1 alarga role→catálogo morde; F2 USING(true)→customer vaza; F3 USING(false)  ║
# ║  →master bloqueia; F4 sem-wrap→contador explode.                               ║
# ║  Rodar:  bash db/test-reposicao-rls-initplan.sh > /tmp/t.log 2>&1; echo $?     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="repo-rls"
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
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'
EMP='22222222-2222-2222-2222-222222222222'
CUST='33333333-3333-3333-3333-333333333333'
NOROLE='44444444-4444-4444-4444-444444444444'

TABS="categoria_aumento_familia_mapeamento empresa_configuracao_custos fornecedor_aumento_anunciado fornecedor_aumento_item fornecedor_cadeia_logistica fornecedor_grupo_producao fornecedor_habilitado_reposicao inventory_position omie_products promocao_campanha promocao_item sku_grupo_producao sku_leadtime_history sku_parametros venda_items_history"
TABS_CSV="$(echo "$TABS" | tr ' ' ',')"

echo "═══ setup (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (estado de PROD): enum, user_roles, has_role VERBATIM,
#          15 tabelas mínimas (nenhuma policy referencia coluna), seed, fixture raw
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);

-- has_role VERBATIM de prod (STABLE SECURITY DEFINER) — Lei #1: a dependência é a real
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),('44444444-4444-4444-4444-444444444444')
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','customer');
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
SQL

# 15 tabelas mínimas (id uuid) + RLS + grants + seed 50 linhas cada
for t in $TABS; do
  P -q -c "CREATE TABLE public.$t (id uuid primary key default gen_random_uuid());
           ALTER TABLE public.$t ENABLE ROW LEVEL SECURITY;
           GRANT SELECT,INSERT,UPDATE,DELETE ON public.$t TO authenticated, anon;
           INSERT INTO public.$t SELECT gen_random_uuid() FROM generate_series(1,50);"
done

# Fixture: os 36 CREATE POLICY RAW = estado de PROD hoje (gerado read-only de prod)
P -q <<'SQL'
CREATE POLICY "Admin/manager editam categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento AS PERMISSIVE FOR ALL TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY "Staff lê categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_empresa_configuracao_custos_delete ON public.empresa_configuracao_custos AS PERMISSIVE FOR DELETE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_empresa_configuracao_custos_insert ON public.empresa_configuracao_custos AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_empresa_configuracao_custos_select ON public.empresa_configuracao_custos AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_empresa_configuracao_custos_update ON public.empresa_configuracao_custos AS PERMISSIVE FOR UPDATE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY "Admin/manager editam fornecedor_aumento_anunciado" ON public.fornecedor_aumento_anunciado AS PERMISSIVE FOR ALL TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY "Staff lê fornecedor_aumento_anunciado" ON public.fornecedor_aumento_anunciado AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY "Admin/manager editam fornecedor_aumento_item" ON public.fornecedor_aumento_item AS PERMISSIVE FOR ALL TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY "Staff lê fornecedor_aumento_item" ON public.fornecedor_aumento_item AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_cadeia_logistica_delete ON public.fornecedor_cadeia_logistica AS PERMISSIVE FOR DELETE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_cadeia_logistica_insert ON public.fornecedor_cadeia_logistica AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_cadeia_logistica_select ON public.fornecedor_cadeia_logistica AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_cadeia_logistica_update ON public.fornecedor_cadeia_logistica AS PERMISSIVE FOR UPDATE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_grupo_producao_delete ON public.fornecedor_grupo_producao AS PERMISSIVE FOR DELETE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_grupo_producao_insert ON public.fornecedor_grupo_producao AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_grupo_producao_select ON public.fornecedor_grupo_producao AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_grupo_producao_update ON public.fornecedor_grupo_producao AS PERMISSIVE FOR UPDATE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_habilitado_reposicao_delete ON public.fornecedor_habilitado_reposicao AS PERMISSIVE FOR DELETE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_habilitado_reposicao_insert ON public.fornecedor_habilitado_reposicao AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_habilitado_reposicao_select ON public.fornecedor_habilitado_reposicao AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_fornecedor_habilitado_reposicao_update ON public.fornecedor_habilitado_reposicao AS PERMISSIVE FOR UPDATE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY "Staff can manage inventory" ON public.inventory_position AS PERMISSIVE FOR ALL TO public USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_inventory_position_select ON public.inventory_position AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY "Staff can manage products" ON public.omie_products AS PERMISSIVE FOR ALL TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY "Admin/manager/master editam campanhas" ON public.promocao_campanha AS PERMISSIVE FOR ALL TO public USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY "Staff vê campanhas" ON public.promocao_campanha AS PERMISSIVE FOR SELECT TO public USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY "Admin/manager/master editam itens" ON public.promocao_item AS PERMISSIVE FOR ALL TO public USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY "Staff vê itens" ON public.promocao_item AS PERMISSIVE FOR SELECT TO public USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_sku_grupo_producao_delete ON public.sku_grupo_producao AS PERMISSIVE FOR DELETE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_sku_grupo_producao_insert ON public.sku_grupo_producao AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_sku_grupo_producao_select ON public.sku_grupo_producao AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_sku_grupo_producao_update ON public.sku_grupo_producao AS PERMISSIVE FOR UPDATE TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_sku_leadtime_history_all ON public.sku_leadtime_history AS PERMISSIVE FOR ALL TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role))) WITH CHECK ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY staff_sku_parametros_select ON public.sku_parametros AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY staff_venda_items_history_select ON public.venda_items_history AS PERMISSIVE FOR SELECT TO authenticated USING ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
SQL

echo "fixture raw instalado: $(Pq -c "select count(*) from pg_policies where schemaname='public' and tablename = any(string_to_array('$TABS_CSV',','));") policies"

# ── helpers de medição ──
cnt()      { Pq -c "SET test.uid='$2'; SET ROLE authenticated; SELECT count(*) FROM public.$1;" | tail -1; }
cnt_anon() { Pq -c "SET test.uid=''; SET ROLE anon; SELECT count(*) FROM public.$1;" | tail -1; }
# probe de INSERT (WITH CHECK) — BEGIN/ROLLBACK p/ NÃO sujar os dados; retorna INS_OK|INS_DENY
ins_probe()      { P -tA 2>&1 -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL test.uid='$2'; DO \$\$ BEGIN INSERT INTO public.$1 DEFAULT VALUES; RAISE NOTICE 'INS_OK'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'INS_DENY'; WHEN OTHERS THEN RAISE; END \$\$; ROLLBACK;" | grep -oE 'INS_OK|INS_DENY' | tail -1; }
ins_probe_anon() { P -tA 2>&1 -c "BEGIN; SET LOCAL ROLE anon; DO \$\$ BEGIN INSERT INTO public.$1 DEFAULT VALUES; RAISE NOTICE 'INS_OK'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'INS_DENY'; WHEN OTHERS THEN RAISE; END \$\$; ROLLBACK;" | grep -oE 'INS_OK|INS_DENY' | tail -1; }
# matriz de visibilidade (USING/leitura): tabela|caller|count
snapshot_matrix()  { for t in $TABS; do for c in "$MASTER" "$EMP" "$CUST" "$NOROLE" ""; do echo "$t|$c|$(cnt "$t" "$c")"; done; echo "$t|anon|$(cnt_anon "$t")"; done; }
# matriz de escrita (WITH CHECK/INSERT): tabela|caller|INS_OK|INS_DENY — pega drift de role no WITH CHECK
snapshot_inserts() { for t in $TABS; do for c in "$MASTER" "$EMP" "$CUST"; do echo "$t|$c|$(ins_probe "$t" "$c")"; done; echo "$t|anon|$(ins_probe_anon "$t")"; done; }
# catálogo (anti-drift): tabela|policy|cmd|permissive|tem_using|tem_check|roles — SEM o texto (que muda pelo wrap)
snapshot_catalog() { Pq -c "select tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||(qual is not null)||'|'||(with_check is not null)||'|'||array_to_string(roles,',') from pg_policies where schemaname='public' and tablename = any(string_to_array('$TABS_CSV',',')) order by 1;"; }

MATRIX_OLD=$(mktemp); MATRIX_NEW=$(mktemp); INS_OLD=$(mktemp); INS_NEW=$(mktemp); CAT_OLD=$(mktemp); CAT_NEW=$(mktemp); CAT_SAB=$(mktemp)
snapshot_matrix > "$MATRIX_OLD"; snapshot_inserts > "$INS_OLD"; snapshot_catalog > "$CAT_OLD"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260627170000_reposicao_rls_initplan.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"
snapshot_matrix > "$MATRIX_NEW"; snapshot_inserts > "$INS_NEW"; snapshot_catalog > "$CAT_NEW"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── A1 EQUIVALÊNCIA de LEITURA (USING): a RLS mostra os MESMOS callers old↔new ──"
if diff -q "$MATRIX_OLD" "$MATRIX_NEW" >/dev/null; then ok "A1 matriz de visibilidade idêntica old↔new (15 tabelas × 6 callers)"; else bad "A1 matriz DIVERGIU:"; diff "$MATRIX_OLD" "$MATRIX_NEW" | head; fi

echo "── A1b EQUIVALÊNCIA de ESCRITA (WITH CHECK): INSERT admite os MESMOS callers old↔new ──"
if diff -q "$INS_OLD" "$INS_NEW" >/dev/null; then ok "A1b matriz de INSERT idêntica old↔new (15 tabelas × 4 callers — pega drift de role no WITH CHECK)"; else bad "A1b matriz de INSERT DIVERGIU:"; diff "$INS_OLD" "$INS_NEW" | head; fi

echo "── A2 CATÁLOGO preservado (cmd/roles/permissive/clauses — anti-drift do ALTER) ──"
if diff -q "$CAT_OLD" "$CAT_NEW" >/dev/null; then ok "A2 catálogo de policy preservado (36 policies)"; else bad "A2 catálogo DRIFTOU:"; diff "$CAT_OLD" "$CAT_NEW" | head; fi

echo "── A3 WRAP aplicado (InitPlan) nas 36 ──"
W=$(Pq -c "select count(*) from pg_policies where schemaname='public' and tablename = any(string_to_array('$TABS_CSV',',')) and (qual ilike '%select%' or with_check ilike '%select%');")
eq "A3 36 policies wrapped" "$W" "36"

echo "── A4 AUTZ ABSOLUTA: master vê 50, não-staff vê 0 (toda tabela) ──"
for t in $TABS; do
  eq "A4 $t master=50"   "$(cnt "$t" "$MASTER")" "50"
  eq "A4 $t customer=0"  "$(cnt "$t" "$CUST")"   "0"
  eq "A4 $t anon=0"      "$(cnt_anon "$t")"      "0"
done

echo "── A5 WITH CHECK: master insere; customer barra; classe master-only barra employee ──"
eq "A5a master INSERT inventory_position" "$(ins_probe inventory_position "$MASTER")" "INS_OK"
eq "A5b customer INSERT inventory_position barrado" "$(ins_probe inventory_position "$CUST")" "INS_DENY"
eq "A5c employee INSERT omie_products (staff-completo)" "$(ins_probe omie_products "$EMP")" "INS_OK"
eq "A5d employee INSERT promocao_item barrado (master-only WITH CHECK)" "$(ins_probe promocao_item "$EMP")" "INS_DENY"
eq "A5e master INSERT promocao_item" "$(ins_probe promocao_item "$MASTER")" "INS_OK"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (cada sabotagem exige VERMELHO; restaura depois)
# Restore CIRÚRGICO: re-aplicar $MIG inteiro bateria no guard (que aborta com
# has_role count ≠ 36 enquanto uma policy está sabotada com true/false) → restaura
# só a policy-alvo na sua forma wrapped.
# ══════════════════════════════════════════════════════════════════════════════
restore_venda() { P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));"; }
echo "── F1: alargar role (authenticated→public) → A2 (catálogo) tem de morder ──"
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history TO public;"
snapshot_catalog > "$CAT_SAB"
if ! diff -q "$CAT_OLD" "$CAT_SAB" >/dev/null; then ok "F1 A2 tem dente (pegou authenticated→public)"; else bad "F1 catálogo NÃO pegou o alargamento de role"; fi
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history TO authenticated;"

echo "── F2: USING(true) → customer passa a ver tudo → A4 tem de morder ──"
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history USING (true);"
SAB=$(cnt venda_items_history "$CUST")
if [ "${SAB:-0}" != "0" ]; then ok "F2 A4 tem dente (USING(true) vazou ${SAB} p/ customer)"; else bad "F2 customer ainda vê 0 com USING(true)"; fi
restore_venda

echo "── F3: USING(false) → nem o master vê → A4 tem de morder ──"
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history USING (false);"
SAB=$(cnt venda_items_history "$MASTER")
if [ "$SAB" = "0" ]; then ok "F3 A4 tem dente (USING(false) bloqueou até o master)"; else bad "F3 master AINDA vê $SAB com USING(false)"; fi
restore_venda

# ── A6 + F4: InitPlan via contador (instrumenta has_role; mantém STABLE SECURITY DEFINER) ──
echo "── A6 InitPlan: has_role O(1) por statement (TODAS as 15 tabelas; master short-circuita) ──"
P -q <<'SQL'
CREATE SEQUENCE IF NOT EXISTS public._hr_calls;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT nextval('public._hr_calls') IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
SQL
for t in $TABS; do
  Pq -c "SELECT setval('public._hr_calls',1,false);" >/dev/null
  Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.$t;" >/dev/null
  K=$(Pq -c "SELECT last_value FROM public._hr_calls;")
  if [ "${K:-99}" -le 6 ]; then ok "A6 $t InitPlan (${K}× p/ 50 linhas)"; else bad "A6 $t por-linha (${K}×)"; fi
done

echo "── F4: omitir o wrap (has_role direto) → contador explode → A6 tem de morder ──"
P -q -c "ALTER POLICY staff_venda_items_history_select ON public.venda_items_history USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));"
Pq -c "SELECT setval('public._hr_calls',1,false);" >/dev/null
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.venda_items_history;" >/dev/null
K_OLD=$(Pq -c "SELECT last_value FROM public._hr_calls;")
if [ "${K_OLD:-0}" -ge 50 ]; then ok "F4 A6 tem dente (sem wrap: ${K_OLD}× p/ 50 linhas)"; else bad "F4 sabotei o wrap e só rodou ${K_OLD}×"; fi
restore_venda

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F fase 1 — prova PG17 da migração de custo employee → cap_custo_ler      ║
# ║      bash db/test-authz-custo-fu4f-fase1.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  Invariante money-path central (A5): trocar o gate de custo do tintométrico   ║
# ║  NÃO pode mexer no preço de balcão. precoFinal sai FORA do gate em prod —     ║
# ║  este harness prova que continua saindo depois da troca.                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="fu4f1"
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
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
ne()  { if [ "$2" != "$3" ]; then ok "$1 (=$2, != $3)"; else bad "$1 — NÃO devia ser [$3], veio [$2]"; fi; }

M='11111111-1111-1111-1111-111111111111'   # master
F='22222222-2222-2222-2222-222222222222'   # farmer   (employee + commercial_role=farmer)
E='33333333-3333-3333-3333-333333333333'   # estrategico (employee + commercial_role=estrategico)
O='44444444-4444-4444-4444-444444444444'   # outro farmer (para provar o own-scope do log)

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# Stubs espelham a PROD (money-path.md: "espelhe a PROD, não o design"). O predicado de staff
# do tintométrico é copiado VERBATIM de pg_get_functiondef em prod (2026-07-20) — se ele
# divergir, o regexp da migration não casa e ela ABORTA, que é o comportamento desejado.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TYPE public.commercial_role AS ENUM ('gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid PRIMARY KEY, commercial_role public.commercial_role NOT NULL);

CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_uid AND ur.role=_role);
$f$;

-- espelha o #1434 (aplicado em prod pelo dono antes desta migration)
CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT COALESCE(
    _uid IS NOT NULL AND (
      public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role)
          AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                       WHERE cr.user_id=_uid AND cr.commercial_role IN ('estrategico','super_admin')))
    ), false);
$f$;

-- ── tabelas-alvo, com as policies COMO ESTÃO EM PROD (a migration é quem as troca) ──
CREATE TABLE public.cmc_snapshot (id bigserial PRIMARY KEY, omie_codigo_produto text, cmc numeric);
ALTER TABLE public.cmc_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

CREATE TABLE public.regua_preco_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id uuid, product_id text, piso_mc numeric, cmc_usado numeric,
  preco_final numeric, aplicou boolean DEFAULT false, outcome_status text DEFAULT 'pendente');
ALTER TABLE public.regua_preco_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY regua_preco_log_staff_all ON public.regua_preco_log FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

CREATE TABLE public.inventory_position (omie_codigo_produto text, account text, cmc numeric, synced_at timestamptz);
SQL

# get_tint_price / get_tint_prices — predicado de staff VERBATIM de prod.
# Corpo simplificado (não é o motor real de tinta), mas a ESTRUTURA que importa é fiel:
# precoFinal calculado ANTES e emitido FORA do gate; custoBase/custoCorantes DENTRO do gate.
P -q <<'SQL'
CREATE FUNCTION public.get_tint_price(p_formula uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE
  v_is_staff boolean;
  v_custo_base numeric := 40.00;
  v_custo_corantes numeric := 8.50;
  v_preco_final numeric;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));

  v_preco_final := round((v_custo_base + v_custo_corantes) * 1.8, 2);

  RETURN jsonb_build_object(
    'custoBase', CASE WHEN v_is_staff THEN v_custo_base ELSE NULL END,
    'custoCorantes', CASE WHEN v_is_staff THEN v_custo_corantes ELSE NULL END,
    'precoFinal', v_preco_final,
    'itensCorantes', CASE WHEN v_is_staff THEN '[{"c":1}]'::jsonb ELSE '[]'::jsonb END);
END $f$;

CREATE FUNCTION public.get_tint_prices(p_formulas uuid[]) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  WITH staff AS MATERIALIZED (
    SELECT (auth.uid() IS NOT NULL
      AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))) AS is_staff
  )
  SELECT jsonb_build_object(
    'custoBase', CASE WHEN s.is_staff THEN 40.00 ELSE NULL END,
    'custoCorantes', CASE WHEN s.is_staff THEN 8.50 ELSE NULL END,
    'precoFinal', round((40.00 + 8.50) * 1.8, 2))
  FROM staff s;
$f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260723120000_authz_custo_fu4f_fase1.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$M'),('$F'),('$E'),('$O') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$M','master'),('$F','employee'),('$E','employee'),('$O','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$F','farmer'),('$E','estrategico'),('$O','farmer');

INSERT INTO public.cmc_snapshot(omie_codigo_produto,cmc) VALUES ('SKU-1', 12.40);
INSERT INTO public.regua_preco_log(salesperson_id,product_id,piso_mc,cmc_usado)
  VALUES ('$O','SKU-9', 33.00, 20.00);   -- linha de OUTRO vendedor (prova o own-scope)

GRANT SELECT ON public.cmc_snapshot TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.regua_preco_log TO authenticated;
GRANT SELECT ON public.user_roles, public.commercial_roles TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid), public.get_tint_prices(uuid[]) TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

as_user() { Pq -c "SET test.uid='$1'; SET ROLE authenticated; $2" | tail -1; }

# ─── cmc_snapshot ───
eq "A1 master LÊ cmc_snapshot"        "$(as_user "$M" 'SELECT count(*) FROM public.cmc_snapshot;')" "1"
eq "A2 estrategico LÊ cmc_snapshot"   "$(as_user "$E" 'SELECT count(*) FROM public.cmc_snapshot;')" "1"
eq "A3 farmer NÃO lê cmc_snapshot"    "$(as_user "$F" 'SELECT count(*) FROM public.cmc_snapshot;')" "0"
eq "A4 anon NÃO lê cmc_snapshot"      "$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.cmc_snapshot;" | tail -1)" "0"

# ─── tintométrico: o INVARIANTE MONEY-PATH ───
PF_F=$(as_user "$F" "SELECT (public.get_tint_price('$M'::uuid))->>'precoFinal';")
PF_M=$(as_user "$M" "SELECT (public.get_tint_price('$M'::uuid))->>'precoFinal';")
ne "A5 farmer AINDA recebe precoFinal (balcão vivo)" "$PF_F" ""
eq "A6 precoFinal IDÊNTICO farmer×master (gate não move preço)" "$PF_F" "$PF_M"

CB_F=$(as_user "$F" "SELECT coalesce((public.get_tint_price('$M'::uuid))->>'custoBase','NULL');")
CB_M=$(as_user "$M" "SELECT coalesce((public.get_tint_price('$M'::uuid))->>'custoBase','NULL');")
eq "A7 farmer NÃO vê custoBase"       "$CB_F" "NULL"
ne "A8 master AINDA vê custoBase"     "$CB_M" "NULL"

CB_P=$(as_user "$F" "SELECT coalesce((public.get_tint_prices(ARRAY['$M'::uuid]))->>'custoBase','NULL');")
PF_P=$(as_user "$F" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'precoFinal';")
eq "A9 farmer NÃO vê custoBase (batch)"  "$CB_P" "NULL"
ne "A10 farmer AINDA recebe precoFinal (batch)" "$PF_P" ""

# ─── regua_preco_log: writer sobrevive, leitura alheia fecha ───
# ⚠️ RETURNING via `psql -tA | tail -1` devolve o STATUS do comando ("INSERT 0 1"), não o valor —
# um assert "não-vazio" passaria por motivo errado. Envolver em CTE força uma linha de RESULTADO.
# (Mordido ao escrever este harness: o A11 ficou verde lendo "INSERT 0 1".)
INS=$(as_user "$F" "WITH ins AS (INSERT INTO public.regua_preco_log(salesperson_id,product_id,piso_mc,cmc_usado) VALUES ('$F','SKU-1',30.0,18.0) RETURNING id) SELECT id::text FROM ins;")
case "$INS" in
  [0-9a-f]*-*-*-*-*) ok "A11 farmer INSERE e RECEBE O ID (writer vivo — .select('id') funciona)" ;;
  *) bad "A11 insert não devolveu uuid — veio [$INS]" ;;
esac
eq "A12 farmer lê SÓ a própria linha"  "$(as_user "$F" 'SELECT count(*) FROM public.regua_preco_log;')" "1"
eq "A13 master lê TODAS"               "$(as_user "$M" 'SELECT count(*) FROM public.regua_preco_log;')" "2"
eq "A14 farmer atualiza a própria (outcome vivo)" \
   "$(as_user "$F" "WITH upd AS (UPDATE public.regua_preco_log SET aplicou=true WHERE salesperson_id='$F' RETURNING id) SELECT count(*)::text FROM upd;")" "1"

# A15 NEGATIVO com SQLSTATE — DELETE deve ser barrado. Sentinela NÃO contém texto que o PG emite.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$F'; SET ROLE authenticated;
DO \$\$
BEGIN
  DELETE FROM public.regua_preco_log WHERE salesperson_id='$F';
  IF NOT FOUND THEN RAISE NOTICE 'SENTINELA_BARRADO_POR_RLS'; ELSE RAISE NOTICE 'SENTINELA_PASSOU_INDEVIDO'; END IF;
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_BARRADO_POR_RLS';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
if echo "$R" | grep -q 'SENTINELA_BARRADO_POR_RLS'; then ok "A15 farmer NÃO deleta log (evidência preservada)"; else bad "A15 DELETE do farmer passou — $R"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem TEM de derrubar o seu assert) ──"
FALS_OK=0; FALS_BAD=0
fals() { if [ "$2" != "$3" ]; then FALS_OK=$((FALS_OK+1)); echo "  🔴 $1 — derrubou como esperado"; else FALS_BAD=$((FALS_BAD+1)); echo "  ⚠️  $1 — SEGUIU VERDE: assert sem dente!"; fi; }

# F1 — devolve o gate de cmc_snapshot para `employee`: A3 tem de deixar de valer.
P -q <<'SQL'
DROP POLICY cmc_snapshot_select_staff ON public.cmc_snapshot;
CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));
SQL
fals "F1 gate de cmc_snapshot de volta a employee (vs A3)" "$(as_user "$F" 'SELECT count(*) FROM public.cmc_snapshot;')" "0"
P -q -c "DROP POLICY cmc_snapshot_select_staff ON public.cmc_snapshot;
         CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot FOR SELECT TO authenticated
           USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));"

# F2 — abre o gate de custo do tint: A7 tem de deixar de valer.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_is_staff boolean; v_custo_base numeric := 40.00; v_preco_final numeric;
BEGIN
  v_is_staff := true;   -- SABOTAGEM
  v_preco_final := round(v_custo_base * 1.8, 2);
  RETURN jsonb_build_object('custoBase', CASE WHEN v_is_staff THEN v_custo_base ELSE NULL END,
                            'precoFinal', v_preco_final);
END $f$;
SQL
fals "F2 gate do tint aberto (vs A7)" \
     "$(as_user "$F" "SELECT coalesce((public.get_tint_price('$M'::uuid))->>'custoBase','NULL');")" "NULL"

# F3 — tira o own-scope do SELECT do log: A11 (insert().select('id')) tem de quebrar.
#      É a regressão que motivou o own-scope — o writer devolveria null EM SILÊNCIO.
P -q <<'SQL'
DROP POLICY regua_preco_log_select ON public.regua_preco_log;
CREATE POLICY regua_preco_log_select ON public.regua_preco_log FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));
SQL
INS_F3=$(as_user "$F" "WITH ins AS (INSERT INTO public.regua_preco_log(salesperson_id,product_id) VALUES ('$F','SKU-2') RETURNING id) SELECT id::text FROM ins;" 2>/dev/null || echo "")
case "$INS_F3" in
  [0-9a-f]*-*-*-*-*) FALS_BAD=$((FALS_BAD+1)); echo "  ⚠️  F3 own-scope removido do log (vs A11) — SEGUIU VERDE: assert sem dente!" ;;
  *) FALS_OK=$((FALS_OK+1)); echo "  🔴 F3 own-scope removido do log (vs A11 — writer cego) — derrubou como esperado" ;;
esac

echo "  falsificação: $FALS_OK derrubaram / $FALS_BAD sem dente"
[ "$FALS_BAD" = "0" ] || FAIL=$((FAIL+1))

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

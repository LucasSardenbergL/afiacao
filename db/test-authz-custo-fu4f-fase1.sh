#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F fase 1 — prova PG17 da migração de custo employee → cap_custo_ler      ║
# ║      bash db/test-authz-custo-fu4f-fase1.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  Revisão adversária Codex (gpt-5.6-sol xhigh, 2026-07-20) derrubou a versão   ║
# ║  anterior deste harness. Corrigido aqui:                                      ║
# ║   · BASELINE pré-migration do preço — antes eu só comparava farmer×master     ║
# ║     DEPOIS, e ficaria verde se o preço mudasse igualmente para os dois.       ║
# ║   · falsificação exige VALOR EXATO, não "diferente do baseline" — antes um    ║
# ║     erro de SQL contava como "assert com dente".                              ║
# ║   · idempotência TESTADA (2 aplicações), não afirmada no comentário.          ║
# ║   · custoCorantes/itensCorantes cobertos (antes só custoBase).                ║
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
F='22222222-2222-2222-2222-222222222222'   # farmer      (employee + commercial_role=farmer)
E='33333333-3333-3333-3333-333333333333'   # estrategico (employee + commercial_role=estrategico)

as_user() { Pq -c "SET test.uid='$1'; SET ROLE authenticated; $2" | tail -1; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# Stubs espelham a PROD (money-path.md: "espelhe a PROD, não o design"). O predicado de staff
# do tintométrico é copiado VERBATIM de pg_get_functiondef em prod (2026-07-20) — se divergir,
# o regexp ancorado da migration não casa e ela ABORTA, que é o comportamento desejado.
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

-- espelha o #1434, já aplicado em prod (confirmado via psql-ro: contrato v2 ativo)
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

CREATE TABLE public.cmc_snapshot (id bigserial PRIMARY KEY, omie_codigo_produto text, cmc numeric);
ALTER TABLE public.cmc_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));
SQL

# get_tint_price / get_tint_prices — predicado de staff VERBATIM de prod. Corpo simplificado (não é
# o motor real de tinta), mas a ESTRUTURA que importa é fiel: precoFinal calculado ANTES e emitido
# FORA do gate; custoBase/custoCorantes/itensCorantes DENTRO do gate.
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
    'precoFinal', round((40.00 + 8.50) * 1.8, 2),
    'itensCorantes', CASE WHEN s.is_staff THEN '[{"c":1}]'::jsonb ELSE '[]'::jsonb END)
  FROM staff s;
$f$;
SQL

# ── seeds ANTES da migration: o baseline precisa de usuários reais para chamar as funções ──
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$M'),('$F'),('$E') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES ('$M','master'),('$F','employee'),('$E','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES ('$F','farmer'),('$E','estrategico');
INSERT INTO public.cmc_snapshot(omie_codigo_produto,cmc) VALUES ('SKU-1', 12.40);
GRANT SELECT ON public.cmc_snapshot TO authenticated, anon;
GRANT SELECT ON public.user_roles, public.commercial_roles TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid), public.get_tint_prices(uuid[]) TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1.5 — BASELINE PRÉ-MIGRATION  (correção P1 do Codex)
# Sem isto, A5/A6 provariam apenas "farmer e master veem o mesmo" — e ficariam VERDES se a
# migration mudasse o preço IGUALMENTE para os dois. O money-path exige o "antes".
# ══════════════════════════════════════════════════════════════════════════════
BASE_PF_SINGULAR=$(as_user "$M" "SELECT (public.get_tint_price('$M'::uuid))->>'precoFinal';")
BASE_PF_BATCH=$(as_user "$M" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'precoFinal';")
echo "baseline pré-migration: precoFinal singular=$BASE_PF_SINGULAR batch=$BASE_PF_BATCH"
[ -n "$BASE_PF_SINGULAR" ] && [ -n "$BASE_PF_BATCH" ] || { echo "❌ baseline vazio — harness inválido"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) + PROVAR IDEMPOTÊNCIA
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260723140000_authz_custo_fu4f_fase1.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# A versão anterior AFIRMAVA idempotência no cabeçalho e falhava na 2ª aplicação (linha 103).
# O dono cola à mão: reaplicar após erro de rede é o caso de uso REAL, não hipótese.
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A0 idempotente — 2ª aplicação passa"; else bad "A0 2ª aplicação FALHOU (não é idempotente)"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# ─── cmc_snapshot ───
eq "A1 master LÊ cmc_snapshot"      "$(as_user "$M" 'SELECT count(*) FROM public.cmc_snapshot;')" "1"
eq "A2 estrategico LÊ cmc_snapshot" "$(as_user "$E" 'SELECT count(*) FROM public.cmc_snapshot;')" "1"
eq "A3 farmer NÃO lê cmc_snapshot"  "$(as_user "$F" 'SELECT count(*) FROM public.cmc_snapshot;')" "0"
eq "A4 anon NÃO lê cmc_snapshot"    "$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.cmc_snapshot;" | tail -1)" "0"

# ─── INVARIANTE MONEY-PATH: o preço não se move (comparado ao BASELINE, não entre papéis) ───
eq "A5 precoFinal singular == baseline pré-migration" \
   "$(as_user "$F" "SELECT (public.get_tint_price('$M'::uuid))->>'precoFinal';")" "$BASE_PF_SINGULAR"
eq "A6 precoFinal batch == baseline pré-migration" \
   "$(as_user "$F" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'precoFinal';")" "$BASE_PF_BATCH"
eq "A7 master também mantém precoFinal" \
   "$(as_user "$M" "SELECT (public.get_tint_price('$M'::uuid))->>'precoFinal';")" "$BASE_PF_SINGULAR"

# ─── mascaramento: TODOS os 3 campos de custo, não só custoBase (gap apontado pelo Codex) ───
eq "A8  farmer NÃO vê custoBase"      "$(as_user "$F" "SELECT coalesce((public.get_tint_price('$M'::uuid))->>'custoBase','NULL');")"     "NULL"
eq "A9  farmer NÃO vê custoCorantes"  "$(as_user "$F" "SELECT coalesce((public.get_tint_price('$M'::uuid))->>'custoCorantes','NULL');")" "NULL"
eq "A10 farmer NÃO vê itensCorantes"  "$(as_user "$F" "SELECT (public.get_tint_price('$M'::uuid))->>'itensCorantes';")"                  "[]"
eq "A11 master AINDA vê custoBase"    "$(as_user "$M" "SELECT (public.get_tint_price('$M'::uuid))->>'custoBase';")"                      "40.00"
eq "A12 master AINDA vê custoCorantes" "$(as_user "$M" "SELECT (public.get_tint_price('$M'::uuid))->>'custoCorantes';")"                 "8.50"
eq "A13 estrategico vê custoBase (a capability concede)" \
   "$(as_user "$E" "SELECT (public.get_tint_price('$M'::uuid))->>'custoBase';")" "40.00"
eq "A14 farmer NÃO vê custoBase (batch)" \
   "$(as_user "$F" "SELECT coalesce((public.get_tint_prices(ARRAY['$M'::uuid]))->>'custoBase','NULL');")" "NULL"
# ⚠️ A15-A18: o batch antes só era testado em custoBase — uma sabotagem que vazasse custoCorantes
# ou itensCorantes SÓ no batch passava o harness inteiro verde (achado P1 da rodada 2 do Codex).
eq "A15 farmer NÃO vê custoCorantes (batch)" \
   "$(as_user "$F" "SELECT coalesce((public.get_tint_prices(ARRAY['$M'::uuid]))->>'custoCorantes','NULL');")" "NULL"
eq "A16 farmer NÃO vê itensCorantes (batch)" \
   "$(as_user "$F" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'itensCorantes';")" "[]"
eq "A17 master AINDA vê custoCorantes (batch — allow-side)" \
   "$(as_user "$M" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'custoCorantes';")" "8.50"
eq "A18 estrategico vê custoBase (batch — a capability concede)" \
   "$(as_user "$E" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'custoBase';")" "40.00"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (Lei #3)
# Cada sabotagem exige o VALOR EXATO que ela produziria. A versão anterior aceitava "diferente
# do baseline" — e um erro de SQL também é diferente, então a falsificação podia ficar vermelha
# pelo motivo errado (achado do Codex).
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem exige o valor EXATO que produziria) ──"
FALS_OK=0; FALS_BAD=0
fals() { # $1 nome · $2 valor obtido · $3 valor EXATO que a sabotagem deve produzir
  if [ "$2" = "$3" ]; then FALS_OK=$((FALS_OK+1)); echo "  🔴 $1 — derrubou com o valor exato [$3]";
  else FALS_BAD=$((FALS_BAD+1)); echo "  ⚠️  $1 — esperava [$3], veio [$2]: sabotagem não reproduziu o furo"; fi; }

# F1 — devolve o gate de cmc_snapshot para `employee`: o farmer volta a ler EXATAMENTE 1 linha.
P -q <<'SQL'
DROP POLICY cmc_snapshot_select_staff ON public.cmc_snapshot;
CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));
SQL
fals "F1 gate de cmc_snapshot de volta a employee (vs A3)" \
     "$(as_user "$F" 'SELECT count(*) FROM public.cmc_snapshot;')" "1"
P -q -c "DROP POLICY cmc_snapshot_select_staff ON public.cmc_snapshot;
         CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot FOR SELECT TO authenticated
           USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));"

# F2 — abre o gate de custo do tint: o farmer volta a ver EXATAMENTE 40.00 (não "algo != NULL").
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_is_staff boolean; v_custo_base numeric := 40.00; v_preco_final numeric;
BEGIN
  v_is_staff := true;   -- SABOTAGEM
  v_preco_final := round((40.00 + 8.50) * 1.8, 2);
  RETURN jsonb_build_object('custoBase', CASE WHEN v_is_staff THEN v_custo_base ELSE NULL END,
                            'precoFinal', v_preco_final);
END $f$;
SQL
fals "F2 gate do tint aberto (vs A8)" \
     "$(as_user "$F" "SELECT coalesce((public.get_tint_price('$M'::uuid))->>'custoBase','NULL');")" "40.00"

# F3 — sabota o PREÇO (não o gate): prova que A5 pega deriva de valor, que era o furo da versão
#      anterior (lá, mudar o preço para TODOS mantinha o assert verde por falta de baseline).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN
  RETURN jsonb_build_object('custoBase', NULL, 'precoFinal', 72.00);  -- SABOTAGEM: preço derivou
END $f$;
SQL
# guarda anti-colisão: se o baseline do stub virar 72.00, F3 diria "derrubou" com A5 verde
[ "$BASE_PF_SINGULAR" != "72.00" ] || { echo "❌ F3 invalida: baseline colidiu com o valor sabotado"; exit 1; }
fals "F3 precoFinal derivou p/ TODOS (vs A5 — o furo da versão sem baseline)" \
     "$(as_user "$F" "SELECT (public.get_tint_price('$M'::uuid))->>'precoFinal';")" "72.00"

# F4 — vaza custoCorantes SÓ no batch (o furo que A14 sozinho não pegava).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formulas uuid[]) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  WITH staff AS MATERIALIZED (SELECT (SELECT private.cap_custo_ler(auth.uid())) AS is_staff)
  SELECT jsonb_build_object(
    'custoBase', CASE WHEN s.is_staff THEN 40.00 ELSE NULL END,
    'custoCorantes', 8.50,                       -- SABOTAGEM: fora do gate
    'itensCorantes', '[{"c":1}]'::jsonb,         -- SABOTAGEM: fora do gate
    'precoFinal', round((40.00 + 8.50) * 1.8, 2))
  FROM staff s;
$f$;
SQL
fals "F4 batch vaza custoCorantes fora do gate (vs A15)" \
     "$(as_user "$F" "SELECT (public.get_tint_prices(ARRAY['$M'::uuid]))->>'custoCorantes';")" "8.50"

echo "  falsificação: $FALS_OK derrubaram / $FALS_BAD não reproduziram"
[ "$FALS_BAD" = "0" ] || FAIL=$((FAIL+1))

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

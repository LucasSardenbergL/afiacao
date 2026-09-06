#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — CAPTURA DO GATE DE CUSTO (private.cap_custo_ler)                 ║
# ║  Prova a migration 20260830204209: get_tint_price / get_tint_prices /            ║
# ║  get_preco_cockpit projetam custo APENAS para master ou employee com             ║
# ║  commercial_role IN ('estrategico','super_admin').                               ║
# ║                                                                                  ║
# ║  ⚠️ Este harness existe porque db/test-tint-gate-custo-staff.sh prova o          ║
# ║  CONTRÁRIO — lá o employee comum VÊ custoBase=200 — e continua correto, porque    ║
# ║  aplica a migration de 2026-07-08 e descreve o que AQUELA fez. O gate de HOJE     ║
# ║  (vivo em prod desde o FU4F) é este. Os dois são verdes ao mesmo tempo sobre      ║
# ║  arquivos diferentes; é isto que a captura vem registrar.                         ║
# ║                                                                                  ║
# ║  A FALSIFICAÇÃO aqui é literal: sabotar = reescrever o gate na versão do REPO.    ║
# ║  Se os asserts seguissem verdes com o predicado antigo, a migration não estaria    ║
# ║  capturando hardening nenhum — e é exatamente a regressão que ela previne.        ║
# ║      bash db/test-captura-authz-gate-custo.sh > /tmp/t.log 2>&1; echo "exit=$?"   ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="captura-authz-gate-custo"
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

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — o que a migration LÊ mas não cria. Inclui private.cap_custo_ler VERBATIM
# da prod (é a dep central do gate) e pode_ver_carteira_completa, que só a
# FALSIFICAÇÃO usa (é o predicado que o repo tinha no cockpit).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);

CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_uid AND role=_role) $f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;

-- VERBATIM da prod (pg_get_functiondef, 2026-08-30). É o gate que a migration captura;
-- reescrevê-lo aqui "mais simples" faria o teste provar outra coisa que não roda.
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('estrategico','super_admin')
        )
      )
    ), false);
$function$;

-- O predicado ANTIGO do cockpit (o do repo). Só a falsificação o chama. Espelha o que
-- 20260704120000_preco_por_tier usava: inclui 'gerencial' — é a folga que a captura fecha.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
      public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role) AND EXISTS (
            SELECT 1 FROM public.commercial_roles cr
             WHERE cr.user_id=_uid AND cr.commercial_role IN ('estrategico','super_admin','gerencial')))
  ), false) $f$;

-- tint
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, valor_unitario numeric, ativo boolean DEFAULT true,
                                   omie_codigo_produto bigint, account text, familia text);
CREATE TABLE public.tint_skus (id uuid PRIMARY KEY, omie_product_id uuid);
CREATE TABLE public.tint_corantes (id uuid PRIMARY KEY, descricao text, volume_total_ml numeric, omie_product_id uuid);
CREATE TABLE public.tint_formulas (id uuid PRIMARY KEY, sku_id uuid, account text, produto_id uuid, base_id uuid, embalagem_id uuid);
CREATE TABLE public.tint_formula_itens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formula_id uuid, corante_id uuid, qtd_ml numeric, ordem int);

-- cockpit
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, cmc numeric, account text, synced_at timestamptz);
CREATE TABLE public.cliente_tier_preco (company text, customer_user_id uuid, tier text);
CREATE FUNCTION public.resolve_markup_policy(p_empresa text, p_codigo bigint, p_familia text, p_tier text)
  RETURNS TABLE(piso_markup numeric, meta_markup numeric) LANGUAGE sql STABLE
  AS $f$ SELECT 20::numeric, 50::numeric $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migration REAL (Lei #1): o mesmo arquivo que o founder cola no SQL Editor.
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260830204209_captura_authz_gate_custo_rpcs_preco.sql"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
P -q -f "$MIG"
echo "═══ migration aplicada: $(basename "$MIG") ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seed. Fórmula completa: custoBase=200, custoCorantes=5, precoFinal=205.
# Cockpit: cmc=100, preco=180 ⇒ markup=80%, folga=80, faixa=verde.
# 5 identidades, escolhidas pelo que SEPARAM:
#   MASTER            — passa nos dois predicados (controle positivo)
#   ESTRATEGICO       — passa em cap_custo_ler                (o hardening deixa entrar)
#   EMPLOYEE comum    — passa no predicado do REPO, NÃO no vivo   ← O EIXO de tint
#   GERENCIAL         — passa em pode_ver_carteira_completa, NÃO em cap_custo_ler ← eixo cockpit
#   CUSTOMER          — não passa em nada
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO public.omie_products(id, valor_unitario, ativo, omie_codigo_produto, account, familia) VALUES
  ('a0000000-0000-0000-0000-000000000001', 200, true, 9001, 'colacor', 'TINTAS'),
  ('a0000000-0000-0000-0000-000000000002', 100, true, 9002, 'colacor', 'CORANTES');
INSERT INTO public.tint_skus(id, omie_product_id) VALUES
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001');
INSERT INTO public.tint_corantes(id, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','Corante OK', 1000, 'a0000000-0000-0000-0000-000000000002');
INSERT INTO public.tint_formulas(id, sku_id) VALUES
  ('f0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001');
INSERT INTO public.tint_formula_itens(formula_id, corante_id, qtd_ml, ordem) VALUES
  ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001', 50, 1);

INSERT INTO public.inventory_position(omie_codigo_produto, cmc, account, synced_at)
VALUES (9001, 100, 'colacor', now());

INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),   -- estratégico
  ('33333333-3333-3333-3333-333333333333','employee'),   -- comum (SEM commercial_role)
  ('44444444-4444-4444-4444-444444444444','employee'),   -- gerencial
  ('55555555-5555-5555-5555-555555555555','customer');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('22222222-2222-2222-2222-222222222222','estrategico'),
  ('44444444-4444-4444-4444-444444444444','gerencial');

GRANT SELECT ON public.user_roles, public.commercial_roles TO authenticated, anon;
SQL

U_MASTER="11111111-1111-1111-1111-111111111111"
U_ESTRAT="22222222-2222-2222-2222-222222222222"
U_EMPCOM="33333333-3333-3333-3333-333333333333"
U_GEREN="44444444-4444-4444-4444-444444444444"
U_CLI="55555555-5555-5555-5555-555555555555"
F_OK="f0000000-0000-0000-0000-000000000001"
SSING="public.get_tint_price('$F_OK'::uuid)"
SBATCH="public.get_tint_prices(ARRAY['$F_OK']::uuid[]) -> '$F_OK'"
ITENS='[{"empresa":"colacor","codigo":9001,"preco":180}]'

# roda como authenticated impersonando um uid — o cenário real do PostgREST
gate() { Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT $2;" | tail -1; }
# cockpit: ecoa o valor textual de uma chave do 1º item ('NULO' quando o gate zerou o número)
cock() { # $1=uid $2=chave
  Pq -c "SET test.uid='$1'; SET ROLE authenticated;
  SELECT COALESCE((public.get_preco_cockpit('$ITENS'::jsonb) -> 0 ->> '$2'), 'NULO');" | tail -1
}
# variante NUMÉRICA: numeric compara VALOR, não representação — '80.0000000000000000' e
# '80.00000000000000000000' são o mesmo número e casar string aqui seria fragilidade do teste.
cockn() { # $1=uid $2=chave $3=valor esperado
  Pq -c "SET test.uid='$1'; SET ROLE authenticated;
  SELECT (public.get_preco_cockpit('$ITENS'::jsonb) -> 0 ->> '$2')::numeric = $3;" | tail -1
}
# Lei #2: captura a SQLSTATE ESPERADA e RE-LANÇA o resto. Raspar o texto do erro não serve —
# o psql imprime CONTEXT depois de ERROR e o `tail -1` pegaria a linha errada, pintando de
# 'não barrou' um caso que barrou. A sentinela é a SQLSTATE, não prosa.
cock_sqlstate() { # $1=uid
  Pq -c "SET test.uid='$1'; SET ROLE authenticated;
  DO \$t\$ BEGIN
    PERFORM public.get_preco_cockpit('$ITENS'::jsonb);
    RAISE NOTICE 'SEM_ERRO';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN RAISE NOTICE '42501';
    WHEN OTHERS THEN RAISE;
  END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  \(.*\)$/\1/p' | tail -1 || true
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════
echo "─── tint: quem PODE ver custo ───"
eq "T1 master singular custoBase=200"       "$(gate "$U_MASTER" "($SSING ->> 'custoBase')::numeric = 200")"   "t"
eq "T2 estrategico singular custoBase=200"  "$(gate "$U_ESTRAT" "($SSING ->> 'custoBase')::numeric = 200")"   "t"
eq "T3 master batch custoBase=200"          "$(gate "$U_MASTER" "($SBATCH ->> 'custoBase')::numeric = 200")"  "t"
eq "T4 estrategico batch custoBase=200"     "$(gate "$U_ESTRAT" "($SBATCH ->> 'custoBase')::numeric = 200")"  "t"

echo "─── tint: O EIXO — employee COMUM não vê custo (o repo deixava ver) ───"
eq "T5 employee comum singular custoBase NULL"    "$(gate "$U_EMPCOM" "($SSING ->> 'custoBase') IS NULL")"      "t"
eq "T6 employee comum singular custoCorantes NULL" "$(gate "$U_EMPCOM" "($SSING ->> 'custoCorantes') IS NULL")" "t"
eq "T7 employee comum batch custoBase NULL"        "$(gate "$U_EMPCOM" "($SBATCH ->> 'custoBase') IS NULL")"    "t"
eq "T8 employee comum singular itensCorantes vazio" "$(gate "$U_EMPCOM" "($SSING -> 'itensCorantes') = '[]'::jsonb")" "t"
eq "T9 gerencial singular custoBase NULL"          "$(gate "$U_GEREN"  "($SSING ->> 'custoBase') IS NULL")"     "t"
eq "T10 customer singular custoBase NULL"          "$(gate "$U_CLI"    "($SSING ->> 'custoBase') IS NULL")"     "t"

echo "─── tint: o BALCÃO não pode quebrar (precoFinal é preço de VENDA, não custo) ───"
eq "T11 employee comum ainda vê precoFinal=205" "$(gate "$U_EMPCOM" "($SSING ->> 'precoFinal')::numeric = 205")" "t"
eq "T12 customer ainda vê precoFinal=205"       "$(gate "$U_CLI"    "($SSING ->> 'precoFinal')::numeric = 205")" "t"
eq "T13 customer batch precoFinal=205"          "$(gate "$U_CLI"    "($SBATCH ->> 'precoFinal')::numeric = 205")" "t"
eq "T14 custoBase é chave PRESENTE com valor null, não ausente" "$(gate "$U_CLI" "$SSING ? 'custoBase'")" "t"

echo "─── cockpit: os DOIS gates são independentes ───"
eq "C1 estrategico vê cmc=100"                 "$(cock "$U_ESTRAT" cmc)"        "100"
eq "C2 estrategico vê markup_perc=80"          "$(cockn "$U_ESTRAT" markup_perc 80)" "t"
eq "C3 employee comum ENTRA (gate de execução inalterado)" "$(cock "$U_EMPCOM" faixa)" "verde"
eq "C4 employee comum NÃO vê cmc"              "$(cock "$U_EMPCOM" cmc)"        "NULO"
eq "C5 employee comum NÃO vê markup_perc"      "$(cock "$U_EMPCOM" markup_perc)" "NULO"
eq "C6 GERENCIAL entra mas NÃO vê cmc (o repo deixava)" "$(cock "$U_GEREN" cmc)" "NULO"
eq "C7 gerencial ainda vê a faixa (decisão sem o número)" "$(cock "$U_GEREN" faixa)" "verde"
eq "C8 customer é BARRADO na execução do cockpit (42501)" "$(cock_sqlstate "$U_CLI")" "42501"
eq "C9 estrategico NÃO é barrado (o gate de execução deixa staff entrar)" "$(cock_sqlstate "$U_ESTRAT")" "SEM_ERRO"

echo "─── sensor de apply: COMMENT carimba sem tocar o corpo ───"
# A migration usa COMMENT ON FUNCTION como ÚNICO efeito observável (ela recria o corpo que já
# roda, então nada mais distingue "aplicada" de "não colada"). Isso só vale se o COMMENT de fato
# NÃO entrar no pg_get_functiondef — senão o md5 mudaria e a validação de fidelidade acusaria
# falso positivo. Provado aqui, não assumido.
MD5_ANTES="$(Pq -c "SELECT md5(pg_get_functiondef('public.get_tint_price(uuid)'::regprocedure));")"
P -q <<'SQL'
COMMENT ON FUNCTION public.get_tint_price(uuid) IS 'texto qualquer só para mexer no comentário';
SQL
MD5_DEPOIS="$(Pq -c "SELECT md5(pg_get_functiondef('public.get_tint_price(uuid)'::regprocedure));")"
eq "S1 COMMENT não altera o md5 do functiondef (o sensor não polui a prova de fidelidade)" "$MD5_ANTES" "$MD5_DEPOIS"
eq "S2 o COMMENT trocado é de fato observável (o sensor sensoria)" \
   "$(Pq -c "SELECT obj_description('public.get_tint_price(uuid)'::regprocedure) = 'texto qualquer só para mexer no comentário';")" "t"
# restaura o carimbo da migration e confirma que ele voltou
P -q -f "$MIG"
eq "S3 reaplicar a migration recarimba as 3 funções" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('get_tint_price','get_tint_prices','get_preco_cockpit')
               AND obj_description(p.oid) LIKE '%captura-deriva-authz 2026-08-30%';")" "3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3). Sabotar aqui = restaurar o predicado do REPO. Se os
# asserts do eixo seguissem verdes, a migration não capturaria hardening nenhum.
# A sentinela é o VALOR 200/100 (dado do seed), não texto que o código emita.
# ══════════════════════════════════════════════════════════════════════════════
echo "─── falsificação: reescrever o gate na versão do REPO ───"
SAB="$(mktemp /tmp/sabota-gate-custo.XXXXXX)"
sed -e "s/private\.cap_custo_ler(auth\.uid())/(auth.uid() IS NOT NULL AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)))/g" "$MIG" > "$SAB"
N_SAB=$(command grep -c "has_role(auth.uid(),'employee'::app_role) OR" "$SAB" || true)
if [ "$N_SAB" -lt 3 ]; then
  bad "falsificação NÃO aplicou a sabotagem nas 3 funções (casou $N_SAB) — os asserts abaixo seriam teatro"
else
  P -q -f "$SAB"
  V_TINT="$(gate "$U_EMPCOM" "($SSING ->> 'custoBase')::numeric = 200")"
  V_COCK="$(cock "$U_EMPCOM" cmc)"
  if [ "$V_TINT" = "t" ] && [ "$V_COCK" = "100" ]; then
    ok "falsificação: com o predicado do REPO o employee comum VOLTA a ver custo (tint=200 · cmc=$V_COCK) — os asserts têm dente"
  else
    bad "FALSIFICAÇÃO SEM DENTE: o predicado do repo devia reabrir o custo, mas veio tint=[$V_TINT] cmc=[$V_COCK]"
  fi
  # sabotagem 2: o predicado do cockpit que INCLUI gerencial
  SAB2="$(mktemp /tmp/sabota-cockpit.XXXXXX)"
  sed -e "s/v_pode_num := private\.cap_custo_ler(auth\.uid());/v_pode_num := public.pode_ver_carteira_completa(auth.uid());/" "$MIG" > "$SAB2"
  if ! command grep -q "v_pode_num := public.pode_ver_carteira_completa" "$SAB2"; then
    bad "falsificação 2 não casou o predicado do cockpit"
  else
    P -q -f "$SAB2"
    V_GER="$(cock "$U_GEREN" cmc)"
    if [ "$V_GER" = "100" ]; then
      ok "falsificação 2: com pode_ver_carteira_completa o GERENCIAL volta a ver cmc (=$V_GER) — C6 tem dente"
    else
      bad "FALSIFICAÇÃO 2 SEM DENTE: gerencial devia voltar a ver cmc, veio [$V_GER]"
    fi
  fi
  rm -f "$SAB2"
  # restaura a versão verdadeira e reconfirma (o harness não pode terminar com o corpo furado)
  P -q -f "$MIG"
  eq "restaurado: employee comum volta a NÃO ver custo" "$(gate "$U_EMPCOM" "($SSING ->> 'custoBase') IS NULL")" "t"
  eq "restaurado: gerencial volta a NÃO ver cmc"        "$(cock "$U_GEREN" cmc)" "NULO"
fi
rm -f "$SAB"

echo
echo "═══ $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1

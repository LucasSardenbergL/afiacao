#!/usr/bin/env bash
# shellcheck disable=SC2016  # os comandos passados a `falsifica` sao strings avaliadas DEPOIS da
#                              sabotagem: a expansao TEM de ser adiada, entao aspas simples e o
#                              desenho, nao um descuido.
# shellcheck disable=SC2329  # `cleanup` e invocada indiretamente, pelo `trap` (o shellcheck nao ve).
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F fase 3 (PR-B) — prova PG17 de get_skus_margem_positiva + fecha product_costs ║
# ║   bash db/test-authz-custo-fu4f-fase3-ranking.sh > log 2>&1; echo "exit=$?"           ║
# ║  (NAO pipe pra tail — engole o exit != 0.)                                            ║
# ║                                                                                       ║
# ║  DISCIPLINA APLICADA (licoes caras do repo):                                          ║
# ║   · BASELINE PRE-MIGRATION: provo que o farmer LE product_costs ANTES. Sem isso,       ║
# ║     "le 0 depois" e indistinguivel de "a query quebrou" (#1488).                       ║
# ║   · CONTROLE POSITIVO em todo assert de negacao: se ninguem le nada, "negado" passaria ║
# ║     como sucesso. Por isso o master TEM de continuar lendo N.                          ║
# ║   · A FEATURE TEM DE SOBREVIVER: A22 prova que o farmer ainda recebe os SKUs vendaveis ║
# ║     fechamento. Fechar custo apagando cross-sell nao e sucesso, e regressao.           ║
# ║   · SET ROLE (nao SET LOCAL — em autocommit vira WARNING e roda como superuser, que    ║
# ║     BYPASSA RLS e deixa a zona inteira falso-verde), + guard de current_user.          ║
# ║   · existencia por to_regprocedure, nunca comparando identity_args com string literal. ║
# ║   · migration aplicada com -f, NUNCA -c com heredoc (o psql descarta o stdin em        ║
# ║     silencio e a falsificacao passa a medir o objeto original).                        ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5464}"
SLUG="fu4f3rank"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG_RPC="$REPO_ROOT/supabase/migrations/20260725120000_authz_custo_fu4f_fase3_ranking_rpc.sql"
MIG_FECHA="$REPO_ROOT/supabase/migrations/20260725130000_authz_custo_fu4f_fase3_fecha_product_costs.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG_RPC" ]   || { echo "migration ausente: $MIG_RPC"; exit 1; }
[ -f "$MIG_FECHA" ] || { echo "migration ausente: $MIG_FECHA"; exit 1; }

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
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

M='11111111-1111-1111-1111-111111111111'   # master
F='22222222-2222-2222-2222-222222222222'   # farmer      (employee + commercial_role=farmer)
E='33333333-3333-3333-3333-333333333333'   # estrategico (employee + commercial_role=estrategico)
CU='66666666-6666-6666-6666-666666666666'  # customer (nao-staff): prova o gate de identidade

# guard: se o SET ROLE nao pegar, TODA a zona de RLS roda como superuser (bypassa) e fica
# falso-verde. Aborta em vez de "passar".
as_user() {
  local got
  got="$(Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT current_user;" | tail -1)"
  [ "$got" = "authenticated" ] || { echo "ABORT: SET ROLE nao pegou (current_user=$got)"; exit 9; }
  Pq -c "SET test.uid='$1'; SET ROLE authenticated; $2" | tail -1
}

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — STUBS ESPELHANDO A PROD (money-path.md: "espelhe a PROD, nao o design")
# cap_custo_ler e as 2 policies de product_costs sao VERBATIM de pg_get_functiondef /
# pg_policies em prod (psql-ro, 2026-07-21). Os GRANTs reproduzem o relacl real
# (authenticated=arwdDxtm E anon=arwdDxtm) — stub menos permissivo que a prod inventa
# seguranca que nao existe.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TYPE public.commercial_role AS ENUM ('gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid PRIMARY KEY, commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.carteira_assignments (farmer_id uuid NOT NULL, customer_user_id uuid NOT NULL, eligible boolean NOT NULL DEFAULT true);

CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_uid AND ur.role=_role);
$f$;

-- VERBATIM de prod (2026-07-21)
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

CREATE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT COALESCE(
    _uid IS NOT NULL AND (
      public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role)
          AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                       WHERE cr.user_id=_uid AND cr.commercial_role IN ('gerencial','estrategico','super_admin')))
    ), false);
$f$;

CREATE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.carteira_assignments ca
                  WHERE ca.customer_user_id=_customer_user_id AND ca.farmer_id=_uid);
$f$;

-- VERBATIM de prod (#1488)
CREATE FUNCTION private.regua_num_finito(v numeric) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT v IS NOT NULL AND v <> 'NaN'::numeric AND v > '-Infinity'::numeric AND v < 'Infinity'::numeric;
$f$;

CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY, codigo text, descricao text,
  valor_unitario numeric, ativo boolean DEFAULT true, estoque numeric
);
CREATE TABLE public.product_costs (
  product_id uuid PRIMARY KEY,
  cost_price numeric, cmc numeric, cost_final numeric, custo_producao numeric,
  cost_source text, cost_confidence numeric, family_category text
);
ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;

-- relacl REAL da prod: arwdDxtm p/ anon E authenticated (o D e TRUNCATE, que ignora RLS)
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.product_costs TO anon, authenticated, service_role;
GRANT SELECT ON public.omie_products TO anon, authenticated, service_role;

-- as DUAS policies permissivas, verbatim de pg_policies (2026-07-21)
CREATE POLICY "Staff can manage product costs" ON public.product_costs
  FOR ALL USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
CREATE POLICY "Staff can view product costs" ON public.product_costs
  FOR SELECT USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));

INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','employee'),
  ('66666666-6666-6666-6666-666666666666','customer');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('22222222-2222-2222-2222-222222222222','farmer'),
  ('33333333-3333-3333-3333-333333333333','estrategico');

-- C1 pertence a carteira do farmer F; C2 NAO (prova o gate de carteira)
INSERT INTO public.carteira_assignments(farmer_id, customer_user_id) VALUES
  ('22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444');

-- catalogo: 4 SKUs cobrindo os casos de custo
--   P1 margem +80  (preco 100, custo 20)
--   P2 margem +30  (preco  50, custo 20)
--   P3 margem -10  (preco  40, custo 50)  -> margem NEGATIVA
--   P4 SEM custo canonico                 -> ausente != zero
--   P5 cost_final = NaN                   -> tem de cair no fallback e depois em NULL
INSERT INTO public.omie_products(id, codigo, descricao, valor_unitario) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','P1','Produto 1',100),
  ('aaaaaaaa-0000-0000-0000-000000000002','P2','Produto 2', 50),
  ('aaaaaaaa-0000-0000-0000-000000000003','P3','Produto 3', 40),
  ('aaaaaaaa-0000-0000-0000-000000000004','P4','Produto 4', 90),
  ('aaaaaaaa-0000-0000-0000-000000000005','P5','Produto 5', 70),
  ('aaaaaaaa-0000-0000-0000-000000000006','P6','Produto 6 INATIVO', 90);
UPDATE public.omie_products SET ativo=false WHERE id='aaaaaaaa-0000-0000-0000-000000000006';
INSERT INTO public.product_costs(product_id, cost_final, cost_price) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 20,   25),
  ('aaaaaaaa-0000-0000-0000-000000000002', 20,   NULL),
  ('aaaaaaaa-0000-0000-0000-000000000003', 50,   NULL),
  ('aaaaaaaa-0000-0000-0000-000000000004', NULL, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'NaN'::numeric, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000006', 10, NULL);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — BASELINE PRE-MIGRATION
# Prova que o DETECTOR enxerga o mundo VIVO. Sem isto, "farmer le 0" depois seria
# indistinguivel de "a query esta quebrada" (licao #1488).
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 2: baseline PRE-migration (o detector ve o mundo vivo?) ==="
eq "B1 farmer LE product_costs hoje (policy antiga)"  "$(as_user "$F" "SELECT count(*) FROM public.product_costs;")" "6"
eq "B2 master LE product_costs hoje"                  "$(as_user "$M" "SELECT count(*) FROM public.product_costs;")" "6"
eq "B3 get_skus_margem_positiva NAO existe antes"     "$(Pq -c "SELECT CASE WHEN to_regprocedure('public.get_skus_margem_positiva()') IS NULL THEN 'AUSENTE' ELSE 'EXISTE' END;")" "AUSENTE"
eq "B4 as 2 policies antigas existem"                 "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='product_costs';")" "2"
eq "B5 authenticated TEM TRUNCATE antes (o D do arwdDxtm)" "$(Pq -c "SELECT has_table_privilege('authenticated','public.product_costs','TRUNCATE');")" "t"
eq "B6 anon TEM SELECT antes"                         "$(Pq -c "SELECT has_table_privilege('anon','public.product_costs','SELECT');")" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — APLICA A MIGRATION REAL DA RPC (-f, nunca -c)
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 3: aplica 20260725120000 (RPC) ==="
P -q -f "$MIG_RPC" >/dev/null
echo "  aplicada"
P -q -f "$MIG_RPC" >/dev/null   # idempotencia: 2a aplicacao nao pode abortar
echo "  reaplicada (idempotente)"

echo "=== ZONA 4: a RPC (sem parametro — a superficie de ataque e o conjunto vazio) ==="
eq "A1 get_skus_margem_positiva existe" \
   "$(Pq -c "SELECT CASE WHEN to_regprocedure('public.get_skus_margem_positiva()') IS NULL THEN 'AUSENTE' ELSE 'EXISTE' END;")" \
   "EXISTE"

# P1 (100/20) e P2 (50/20) tem margem > 0. P3 (40/50) e negativa. P4 sem custo. P5 cost_final=NaN.
# Espera-se EXATAMENTE {P1,P2}: negativa fora, sem-custo fora, NaN fora (ausente != zero).
Q_SKUS="SELECT string_agg(right(product_id::text,1), ',' ORDER BY product_id::text) FROM public.get_skus_margem_positiva();"
eq "A2 farmer recebe os SKUs vendaveis"      "$(as_user "$F" "$Q_SKUS")" "1,2"
eq "A3 master recebe o MESMO conjunto"       "$(as_user "$M" "$Q_SKUS")" "1,2"
eq "A4 estrategico recebe o MESMO conjunto"  "$(as_user "$E" "$Q_SKUS")" "1,2"

# INVARIANTE: o conjunto NAO depende da capability. Se dependesse, a vendedora teria uma lista
# pior que a do master e fechar custo teria custado qualidade de recomendacao.
A5_F="$(as_user "$F" "$Q_SKUS")"; A5_M="$(as_user "$M" "$Q_SKUS")"
if [ "$A5_F" = "$A5_M" ] && [ "$A5_F" = "1,2" ]; then
  ok "A5 conjunto IDENTICO p/ farmer e master (=$A5_F)"
else
  bad "A5 farmer[$A5_F] x master[$A5_M] -- ambos tem de ser '1,2' (vazio dos dois lados nao e sucesso)"
fi

eq "A6 margem NEGATIVA fica de fora (P3)" \
   "$(as_user "$F" "SELECT count(*) FROM public.get_skus_margem_positiva() WHERE product_id='aaaaaaaa-0000-0000-0000-000000000003';")" "0"
eq "A7 SKU sem custo fica de fora (P4, ausente != zero)" \
   "$(as_user "$F" "SELECT count(*) FROM public.get_skus_margem_positiva() WHERE product_id='aaaaaaaa-0000-0000-0000-000000000004';")" "0"
eq "A8 cost_final=NaN fica de fora (P5)" \
   "$(as_user "$F" "SELECT count(*) FROM public.get_skus_margem_positiva() WHERE product_id='aaaaaaaa-0000-0000-0000-000000000005';")" "0"
eq "A9 SKU inativo fica de fora" \
   "$(as_user "$F" "SELECT count(*) FROM public.get_skus_margem_positiva() WHERE product_id='aaaaaaaa-0000-0000-0000-000000000006';")" "0"

# FAIL-CLOSED e gate de identidade
eq "A10 sem auth.uid(): zero linhas (fail-closed)" \
   "$(Pq -c "SET test.uid=''; SET ROLE authenticated; SELECT count(*) FROM public.get_skus_margem_positiva();" | tail -1)" "0"
eq "A11 customer (nao-staff): zero linhas" \
   "$(as_user "$CU" "SELECT count(*) FROM public.get_skus_margem_positiva();")" "0"
eq "A12 anon NAO executa a RPC" \
   "$(Pq -c "SELECT has_function_privilege('anon', to_regprocedure('public.get_skus_margem_positiva()'), 'EXECUTE');")" "f"
eq "A12b authenticated EXECUTA (controle positivo do REVOKE)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', to_regprocedure('public.get_skus_margem_positiva()'), 'EXECUTE');")" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — APLICA O FECHAMENTO e prova que a FEATURE SOBREVIVE
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 5: aplica 20260725130000 (fecha product_costs) ==="
# a precondicao exige a RPC da frente irma; no harness ela nao existe, entao crio o stub
# minimo aqui — e a AUSENCIA dela e falsificada em S6.
P -q -c "CREATE FUNCTION public.get_carteira_margem_faixa() RETURNS TABLE(customer_user_id uuid, faixa text) LANGUAGE sql STABLE AS \$f\$ SELECT NULL::uuid, NULL::text WHERE false \$f\$;" >/dev/null
P -q -f "$MIG_FECHA" >/dev/null
echo "  aplicada"
P -q -f "$MIG_FECHA" >/dev/null   # idempotencia
echo "  reaplicada (idempotente)"

eq "A17 farmer NAO le mais product_costs"        "$(as_user "$F" "SELECT count(*) FROM public.product_costs;")" "0"
eq "A18 master AINDA le product_costs (controle positivo)" "$(as_user "$M" "SELECT count(*) FROM public.product_costs;")" "6"
eq "A18b estrategico AINDA le"                   "$(as_user "$E" "SELECT count(*) FROM public.product_costs;")" "6"
eq "A19 authenticated perdeu TRUNCATE"           "$(Pq -c "SELECT has_table_privilege('authenticated','public.product_costs','TRUNCATE');")" "f"
eq "A19b authenticated perdeu INSERT/UPDATE/DELETE" \
   "$(Pq -c "SELECT (has_table_privilege('authenticated','public.product_costs','INSERT') OR has_table_privilege('authenticated','public.product_costs','UPDATE') OR has_table_privilege('authenticated','public.product_costs','DELETE'));")" "f"
eq "A19c authenticated MANTEM SELECT (senao a policy vira tautologia)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.product_costs','SELECT');")" "t"
eq "A20 anon perdeu tudo"                        "$(Pq -c "SELECT (has_table_privilege('anon','public.product_costs','SELECT') OR has_table_privilege('anon','public.product_costs','TRUNCATE'));")" "f"
eq "A20b service_role MANTEM INSERT (o sync de custo nao pode quebrar)" \
   "$(Pq -c "SELECT has_table_privilege('service_role','public.product_costs','INSERT');")" "t"
eq "A21 sobrou exatamente 1 policy"              "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='product_costs';")" "1"

# ─── O ASSERT QUE JUSTIFICA A ENTREGA ───────────────────────────────────────────
# Fechar custo apagando a feature nao e sucesso, e regressao. A22 prova que o farmer, que agora
# le ZERO linhas de product_costs, continua recebendo o ranking COMPLETO e na MESMA ordem.
eq "A22 a FEATURE SOBREVIVE: farmer ainda recebe os SKUs vendaveis apos o fechamento" \
   "$(as_user "$F" "$Q_SKUS")" "1,2"
eq "A22b e o master tambem (nada quebrou p/ quem tem a capability)" \
   "$(as_user "$M" "$Q_SKUS")" "1,2"

echo
echo "=== BASELINE: ${PASS} OK / ${FAIL} FAIL ==="
[ "$FAIL" -eq 0 ] || { echo "BASELINE VERMELHO -- nao faz sentido falsificar"; exit 1; }
BASE_PASS=$PASS

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — FALSIFICACAO
# Cada sabotagem exige o vermelho DO ASSERT QUE ELA MIRA, com o valor conferido.
# "exit != 0" nao distingue "pegou o bug" de "o comando quebrou" -- por isso comparo valores.
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 6: falsificacao ==="
FALS=0
falsifica() { # $1=nome  $2=sql da sabotagem  $3=assert  $4=esperado_sabotado
  local got
  P -q -c "$2" >/dev/null 2>&1 || { echo "  FAIL [$1] a sabotagem nem aplicou"; FAIL=$((FAIL+1)); return; }
  got="$(eval "$3")"
  if [ "$got" = "$4" ]; then echo "  OK   [$1] o assert FICOU VERMELHO (veio [$got])"; FALS=$((FALS+1))
  else echo "  FAIL [$1] o assert NAO reagiu -- veio [$got], esperava a sabotagem produzir [$4]"; FAIL=$((FAIL+1)); fi
}

# S1: capability sempre verdadeira -> A17 (farmer nao le product_costs) tem de cair.
#     Note que a capability NAO entra mais na RPC (todo staff recebe o mesmo conjunto, de
#     proposito: o conjunto vendavel nao e segredo de custo). Ela governa a POLICY da tabela,
#     e e la que a sabotagem tem de doer.
falsifica "S1 cap_custo_ler := true" \
  "CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT true \$f\$;" \
  'as_user "$F" "SELECT count(*) FROM public.product_costs;"' "6"
P -q -c "CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT COALESCE(_uid IS NOT NULL AND (public.has_role(_uid,'master'::public.app_role) OR (public.has_role(_uid,'employee'::public.app_role) AND EXISTS (SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid AND cr.commercial_role IN ('estrategico','super_admin')))), false) \$f\$;" >/dev/null

# S2: policy antiga de volta -> A17 (farmer le 0) tem de cair
falsifica "S2 policy antiga (master OR employee) de volta" \
  "CREATE POLICY \"Staff can view product costs\" ON public.product_costs FOR SELECT USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));" \
  'as_user "$F" "SELECT count(*) FROM public.product_costs;"' "6"
P -q -c "DROP POLICY \"Staff can view product costs\" ON public.product_costs;" >/dev/null

# S3: CONTROLE POSITIVO. Sem policy nenhuma TODOS leem 0 -- A17 continuaria verde por acidente.
#     Quem tem de gritar e A18 (master le 6). Sem esta falsificacao, "ninguem le nada" passaria
#     como sucesso e a tabela poderia estar simplesmente quebrada.
falsifica "S3 sem policy: A18 (master le 6) tem de cair" \
  "DROP POLICY product_costs_select_custo ON public.product_costs;" \
  'as_user "$M" "SELECT count(*) FROM public.product_costs;"' "0"
P -q -f "$MIG_FECHA" >/dev/null

# S4: o REVOKE desfeito -> A19 (sem TRUNCATE) tem de cair. Prova que o assert mede GRANT,
#     nao policy: trocar policy nunca revogaria TRUNCATE, que ignora RLS.
falsifica "S4 GRANT de volta: A19 (sem TRUNCATE) tem de cair" \
  "GRANT TRUNCATE ON public.product_costs TO authenticated;" \
  'Pq -c "SELECT has_table_privilege('"'"'authenticated'"'"','"'"'public.product_costs'"'"','"'"'TRUNCATE'"'"');"' "t"
P -q -c "REVOKE TRUNCATE ON public.product_costs FROM authenticated;" >/dev/null

# S5: custo ausente fabricando 0 -> A7 (P4 fora da lista) tem de cair. E o bug do #1466
#     rearmado: com custo 0 o SKU sem custo vira margem CHEIA e entra como o mais vendavel.
falsifica "S5 custo ausente vira 0: A7 (P4 fora) tem de cair" \
  "CREATE OR REPLACE FUNCTION private.custo_canonico(p_cost_final numeric, p_cost_price numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS \$f\$ SELECT COALESCE(p_cost_final, p_cost_price, 0) \$f\$;" \
  'as_user "$F" "SELECT count(*) FROM public.get_skus_margem_positiva() WHERE product_id='"'"'aaaaaaaa-0000-0000-0000-000000000004'"'"';"' "1"
P -q -f "$MIG_RPC" >/dev/null

# S6: falsifica A PRECONDICAO do fechamento -- o mecanismo que torna a ordem de aplicacao
#     manual segura. Sem a RPC dos engines, ela TEM de abortar.
echo "  --- S6: sem get_skus_margem_positiva, o fechamento tem de ABORTAR ---"
P -q -c "DROP FUNCTION public.get_skus_margem_positiva();" >/dev/null
if P -q -f "$MIG_FECHA" >/dev/null 2>&1; then
  echo "  FAIL [S6] o fechamento APLICOU sem a RPC dos engines -- a precondicao nao dispara"
  FAIL=$((FAIL+1))
else
  echo "  OK   [S6] o fechamento ABORTOU (a precondicao tem dente)"
  FALS=$((FALS+1))
fi
P -q -f "$MIG_RPC" >/dev/null

# S7: idem para a RPC da frente irma (farmer-scoring). Sem ela, fechar zera o health score.
echo "  --- S7: sem get_carteira_margem_faixa, o fechamento tem de ABORTAR ---"
P -q -c "DROP FUNCTION public.get_carteira_margem_faixa();" >/dev/null
if P -q -f "$MIG_FECHA" >/dev/null 2>&1; then
  echo "  FAIL [S7] o fechamento APLICOU sem a RPC do farmer-scoring -- a precondicao nao dispara"
  FAIL=$((FAIL+1))
else
  echo "  OK   [S7] o fechamento ABORTOU (a precondicao tem dente)"
  FALS=$((FALS+1))
fi
P -q -c "CREATE FUNCTION public.get_carteira_margem_faixa() RETURNS TABLE(customer_user_id uuid, faixa text) LANGUAGE sql STABLE AS \$f\$ SELECT NULL::uuid, NULL::text WHERE false \$f\$;" >/dev/null
P -q -f "$MIG_FECHA" >/dev/null

# S8: o gate de IDENTIDADE removido -> A11 (customer le 0) tem de cair.
falsifica "S8 gate de identidade removido: A11 tem de cair" \
  "CREATE OR REPLACE FUNCTION public.get_skus_margem_positiva() RETURNS TABLE(product_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', pg_temp AS \$f\$ BEGIN RETURN QUERY SELECT p.id FROM public.omie_products p JOIN public.product_costs pc ON pc.product_id=p.id WHERE p.ativo IS TRUE AND private.custo_canonico(pc.cost_final,pc.cost_price) IS NOT NULL AND p.valor_unitario > private.custo_canonico(pc.cost_final,pc.cost_price); END \$f\$;" \
  'as_user "$CU" "SELECT count(*) FROM public.get_skus_margem_positiva();"' "2"
P -q -f "$MIG_RPC" >/dev/null

# S9: margem NEGATIVA passando a entrar na lista -> A6 tem de cair. Sabota o predicado que
#     separa vendavel de prejuizo (troca > por >=... nao: por <>, que aceita negativa).
falsifica "S9 filtro de margem positiva afrouxado: A6 tem de cair" \
  "CREATE OR REPLACE FUNCTION public.get_skus_margem_positiva() RETURNS TABLE(product_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', pg_temp AS \$f\$ DECLARE v_uid uuid := (SELECT auth.uid()); BEGIN IF v_uid IS NULL THEN RETURN; END IF; RETURN QUERY SELECT p.id FROM public.omie_products p JOIN public.product_costs pc ON pc.product_id=p.id WHERE p.ativo IS TRUE AND private.custo_canonico(pc.cost_final,pc.cost_price) IS NOT NULL; END \$f\$;" \
  'as_user "$F" "SELECT count(*) FROM public.get_skus_margem_positiva() WHERE product_id='"'"'aaaaaaaa-0000-0000-0000-000000000003'"'"';"' "1"
P -q -f "$MIG_RPC" >/dev/null

echo
echo "=== TOTAL: ${PASS} asserts de baseline, ${FALS} falsificacoes, ${FAIL} falhas ==="
# fail-closed na COBERTURA (licao P3 do #1488): mudar o numero de asserts ou de falsificacoes
# obriga a atualizar estes literais conscientemente, senao remover um assert passa despercebido.
ESPERADO_PASS=30
ESPERADO_FALS=9
if [ "$PASS" -ne "$ESPERADO_PASS" ]; then
  echo "COBERTURA MUDOU: esperava $ESPERADO_PASS asserts, contei $PASS -- atualize o literal conscientemente"
  FAIL=$((FAIL+1))
fi
if [ "$FALS" -ne "$ESPERADO_FALS" ]; then
  echo "COBERTURA MUDOU: esperava $ESPERADO_FALS falsificacoes com dente, contei $FALS"
  FAIL=$((FAIL+1))
fi
if [ "$FAIL" -eq 0 ]; then
  echo "VERDE (${BASE_PASS} asserts + ${FALS} falsificacoes com dente)"
else
  echo "VERMELHO"
fi
exit "$FAIL"

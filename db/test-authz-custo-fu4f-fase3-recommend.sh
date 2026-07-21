#!/usr/bin/env bash
# shellcheck disable=SC2016  # os comandos passados a `falsifica` sao strings avaliadas DEPOIS da
#                              sabotagem: a expansao TEM de ser adiada, entao aspas simples e o
#                              desenho, nao um descuido.
# shellcheck disable=SC2329  # `cleanup` e invocada indiretamente, pelo `trap` (o shellcheck nao ve).
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F fase 3 (PR-A) — prova PG17 de public.pode_ler_custo() + recommendation_log ║
# ║   bash db/test-authz-custo-fu4f-fase3-recommend.sh > log 2>&1; echo "exit=$?"  ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  DISCIPLINA APLICADA (lições caras do repo):                                  ║
# ║   · BASELINE PRÉ-MIGRATION do detector: provo que o farmer LÊ o log ANTES.    ║
# ║     Sem isso, "lê 0 linhas" depois é indistinguível de "a query quebrou".     ║
# ║   · CONTROLE POSITIVO em todo assert de negação: se ninguém lê nada, "negado" ║
# ║     passaria como sucesso. Por isso o master TEM de ler N.                    ║
# ║   · SET ROLE (não SET LOCAL — em autocommit vira WARNING e roda como superuser,║
# ║     que BYPASSA RLS e deixa a zona inteira falso-verde), + guard de current_user.║
# ║   · assert de existência por to_regprocedure, nunca comparando identity_args   ║
# ║     com string literal (#1488: o detector que nunca dispara).                  ║
# ║   · migration aplicada com -f, NUNCA -c com heredoc (o psql descarta o stdin   ║
# ║     em silêncio e a falsificação passa a medir o objeto original).             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="fu4f3rec"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260724130000_authz_custo_fu4f_fase3_recommend.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

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
# cap_custo_ler copiada VERBATIM de pg_get_functiondef em prod (2026-07-20).
# recommendation_log com a policy ANTIGA (cmd=ALL, master OR employee), tambem verbatim.
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

-- colunas espelhando a prod (a tabela guarda a superficie de inversao INTEIRA:
-- unit_cost, margin, eip, score_*, weights)
CREATE TABLE public.recommendation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  product_id uuid,
  recommendation_type text NOT NULL,
  score_final numeric, score_assoc numeric, score_eip numeric, score_sim numeric, score_ctx numeric,
  explanation_text text, explanation_key text,
  unit_cost numeric, cost_source text, margin numeric, probability numeric, eip numeric,
  event_type text, weights jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.recommendation_log ENABLE ROW LEVEL SECURITY;
-- GRANTs espelhando a PROD, medidos com has_table_privilege (2026-07-20): anon, authenticated E
-- service_role tem SELECT/INSERT. Stub menos permissivo que a prod inventa seguranca que nao existe
-- (money-path.md) -- foi exatamente o que derrubou A14 na 1a rodada deste harness.
--
-- ⚠️ E os GRANTs FICAM como estao de proposito. Revogar INSERT de `authenticated` faria A13 passar
-- por falta de PRIVILEGIO em vez de falta de POLICY -- e ele seguiria verde mesmo se uma policy
-- permissiva de INSERT reaparecesse. Endurecer o gate transformaria o fiscal em tautologia (#1488).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recommendation_log TO anon, authenticated, service_role;

-- policy ANTIGA, verbatim da prod
CREATE POLICY "Staff can manage recommendation log" ON public.recommendation_log
  FOR ALL USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','employee');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('22222222-2222-2222-2222-222222222222','farmer'),
  ('33333333-3333-3333-3333-333333333333','estrategico');

-- 3 linhas com custo, como o que a edge grava
INSERT INTO public.recommendation_log(farmer_id, customer_user_id, product_id, recommendation_type, unit_cost, margin, eip, event_type)
SELECT '22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444',
       gen_random_uuid(),'cross_sell', 7.77, 92.23, 46.115, 'impression'
FROM generate_series(1,3);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — BASELINE PRE-MIGRATION
# Prova que o DETECTOR enxerga o mundo VIVO. Sem isto, "farmer le 0" depois seria
# indistinguivel de "a query esta quebrada" (licao #1488).
# ══════════════════════════════════════════════════════════════════════════════
echo "=== ZONA 2: baseline PRE-migration ==="
eq "B1 farmer LE o log hoje (o vazamento existe)"        "$(as_user "$F" "SELECT count(*) FROM public.recommendation_log;")" "3"
eq "B2 master LE o log hoje"                             "$(as_user "$M" "SELECT count(*) FROM public.recommendation_log;")" "3"
eq "B3 pode_ler_custo() ainda NAO existe"                "$(Pq -c "SELECT to_regprocedure('public.pode_ler_custo()') IS NULL;")" "t"
eq "B4 farmer ESCREVE no log hoje (a policy ALL concedia)" \
   "$(as_user "$F" "INSERT INTO public.recommendation_log(farmer_id,customer_user_id,recommendation_type) VALUES ('$F','$F','x') RETURNING 1;")" "1"
Pq -c "DELETE FROM public.recommendation_log WHERE recommendation_type='x';" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — APLICA A MIGRATION REAL (-f, nunca -c)
# ══════════════════════════════════════════════════════════════════════════════
echo "=== ZONA 3: aplicando a migration real ==="
P -q -f "$MIG" >/dev/null
echo "  migration aplicada"

# idempotencia: reaplicar tem de ser no-op, nao erro.
# if-then-else e nao `A && B || C`: naquele padrao o C roda tambem quando B falha (SC2015).
if P -q -f "$MIG" >/dev/null 2>&1; then
  ok "A0 migration e IDEMPOTENTE (2a aplicacao passa)"
else
  bad "A0 2a aplicacao falhou"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — public.pode_ler_custo()
# ══════════════════════════════════════════════════════════════════════════════
echo "=== ZONA 4: pode_ler_custo() ==="
eq "A1 existe com assinatura EXATA (0 args, via to_regprocedure)" \
   "$(Pq -c "SELECT to_regprocedure('public.pode_ler_custo()') IS NOT NULL;")" "t"
eq "A2 sem parametro (o desenho anti-oraculo depende disso)" \
   "$(Pq -c "SELECT pg_get_function_identity_arguments(to_regprocedure('public.pode_ler_custo()'));")" ""
eq "A3 master TEM a capability"                "$(as_user "$M" "SELECT public.pode_ler_custo();")" "t"
eq "A4 farmer NAO tem (o vazamento fecha aqui)" "$(as_user "$F" "SELECT public.pode_ler_custo();")" "f"
eq "A5 estrategico TEM (controle positivo: nao e 'negado para todos')" \
   "$(as_user "$E" "SELECT public.pode_ler_custo();")" "t"
# fail-closed com auth.uid() NULL. ⚠️ ROTULO CORRIGIDO (achado do Codex): isto testa `authenticated`
# com uid nulo, NAO literalmente o service_role. Prova a PROPRIEDADE de que a funcao depende
# (uid ausente => false), que e a mesma que protege a chamada por service_role -- mas o rotulo
# anterior ("e o que acontece com service_role") era mais forte que a evidencia.
eq "A6 uid NULO -> false (fail-closed; mesma propriedade que cobre o service_role)" \
   "$(Pq -c "SET test.uid=''; SET ROLE authenticated; SELECT public.pode_ler_custo();" | tail -1)" "f"

# privilegio: anon NAO executa; authenticated executa (controle positivo)
eq "A7 anon NAO executa"          "$(Pq -c "SELECT has_function_privilege('anon', to_regprocedure('public.pode_ler_custo()'), 'EXECUTE');")" "f"
eq "A8 authenticated EXECUTA (sem isso a edge quebra com o assert verde)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', to_regprocedure('public.pode_ler_custo()'), 'EXECUTE');")" "t"
# comportamental, nao so catalogo: anon chamando levanta 42501
eq "A9 anon chamando levanta 42501" \
   "$(Pq -c "SET ROLE anon; DO \$\$ BEGIN PERFORM public.pode_ler_custo(); RAISE EXCEPTION 'NAO_BARROU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok'; END \$\$; SELECT '42501';" 2>/dev/null | tail -1)" "42501"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — recommendation_log
# ══════════════════════════════════════════════════════════════════════════════
echo "=== ZONA 5: recommendation_log ==="
eq "A10 farmer le 0 linhas (era 3 no baseline B1)" "$(as_user "$F" "SELECT count(*) FROM public.recommendation_log;")" "0"
eq "A11 master SEGUE lendo 3 (controle positivo: nao quebrei a tabela)" \
   "$(as_user "$M" "SELECT count(*) FROM public.recommendation_log;")" "3"
eq "A12 estrategico le 3"                          "$(as_user "$E" "SELECT count(*) FROM public.recommendation_log;")" "3"
# escrita por authenticated sumiu (a policy ALL antiga concedia -- B4 provou)
eq "A13 farmer NAO escreve mais (42501)" \
   "$(as_user "$F" "DO \$\$ BEGIN INSERT INTO public.recommendation_log(farmer_id,customer_user_id,recommendation_type) VALUES ('$F','$F','x'); RAISE EXCEPTION 'NAO_BARROU'; EXCEPTION WHEN insufficient_privilege THEN NULL; END \$\$; SELECT '42501';")" "42501"
eq "A14 service_role SEGUE gravando (e o writer real da edge)" \
   "$(Pq -c "SET ROLE service_role; INSERT INTO public.recommendation_log(farmer_id,customer_user_id,recommendation_type) VALUES ('$F','$F','svc') RETURNING 1;" | tail -1)" "1"
Pq -c "SET ROLE service_role; DELETE FROM public.recommendation_log WHERE recommendation_type='svc';" >/dev/null
# anon TEM grant de tabela na prod (medido) e mesmo assim le 0: quem barra e a RLS, porque nenhuma
# policy alcanca o role. Assert com SIGNIFICADO justamente por o grant continuar presente.
eq "A15 anon le 0 (com GRANT presente -- quem nega e a RLS, nao o privilegio)" \
   "$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.recommendation_log;" | tail -1)" "0"

echo
echo "=== BASELINE: ${PASS} OK / ${FAIL} FAIL ==="
[ "$FAIL" -eq 0 ] || { echo "BASELINE VERMELHO -- nao faz sentido falsificar"; exit 1; }
BASE_PASS=$PASS

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — FALSIFICACAO
# Cada sabotagem exige o vermelho DO ASSERT QUE ELA MIRA, com contagem conferida.
# "exit != 0" nao distingue "pegou o bug" de "o comando quebrou" -- por isso conto.
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 6: falsificacao ==="
falsifica() { # $1=nome  $2=sql da sabotagem  $3=assert  $4=esperado_sabotado
  local got
  P -q -c "$2" >/dev/null 2>&1 || { echo "  FAIL [$1] a sabotagem nem aplicou"; FAIL=$((FAIL+1)); return; }
  got="$(eval "$3")"
  if [ "$got" = "$4" ]; then echo "  OK   [$1] o assert FICOU VERMELHO (veio [$got], o correto seria diferente)"
  else echo "  FAIL [$1] o assert NAO reagiu -- veio [$got], esperava a sabotagem produzir [$4]"; FAIL=$((FAIL+1)); fi
}

# S1: pode_ler_custo() sempre true -> A4 (farmer nao tem) deveria virar 't'
falsifica "S1 pode_ler_custo := true" \
  "CREATE OR REPLACE FUNCTION public.pode_ler_custo() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', pg_temp AS \$f\$ SELECT true \$f\$;" \
  'as_user "$F" "SELECT public.pode_ler_custo();"' "t"
P -q -f "$MIG" >/dev/null   # restaura

# S2: GRANT a anon -> A7 deveria virar 't'
falsifica "S2 GRANT EXECUTE TO anon" \
  "GRANT EXECUTE ON FUNCTION public.pode_ler_custo() TO anon;" \
  'Pq -c "SELECT has_function_privilege('"'"'anon'"'"', to_regprocedure('"'"'public.pode_ler_custo()'"'"'), '"'"'EXECUTE'"'"');"' "t"
P -q -c "REVOKE ALL ON FUNCTION public.pode_ler_custo() FROM anon;" >/dev/null

# S3: policy antiga de volta -> A10 (farmer le 0) deveria virar 3
falsifica "S3 policy antiga (master OR employee) de volta" \
  "DROP POLICY recommendation_log_select_custo ON public.recommendation_log; CREATE POLICY recommendation_log_select_custo ON public.recommendation_log FOR SELECT TO authenticated USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));" \
  'as_user "$F" "SELECT count(*) FROM public.recommendation_log;"' "3"
P -q -f "$MIG" >/dev/null

# S4: CONTROLE POSITIVO do assert de negacao -- sem policy nenhuma, TODOS leem 0.
#     A10 continuaria verde por acidente; quem tem de gritar e A11 (master le 3).
#     Sem esta falsificacao, "negado para todos" passaria como sucesso.
falsifica "S4 sem policy: A11 (master le 3) tem de cair" \
  "DROP POLICY recommendation_log_select_custo ON public.recommendation_log;" \
  'as_user "$M" "SELECT count(*) FROM public.recommendation_log;"' "0"
P -q -f "$MIG" >/dev/null

# S5: quem falsifica A13 (escrita). Achado do Codex: S4 cobre o falso-verde da LEITURA, mas nenhuma
#     sabotagem exercia o assert de ESCRITA -- ele podia estar passando por motivo errado sem aviso.
#     Com uma policy permissiva de INSERT o farmer volta a inserir (=1), provando que A13 mede
#     POLICY e nao PRIVILEGIO (o grant de INSERT continua presente, ver ZONA 1).
falsifica "S5 policy permissiva de INSERT: A13 (farmer nao escreve) tem de cair" \
  "CREATE POLICY tmp_insert_livre ON public.recommendation_log FOR INSERT TO authenticated WITH CHECK (true);" \
  'as_user "$F" "INSERT INTO public.recommendation_log(farmer_id,customer_user_id,recommendation_type) VALUES ('"'"'$F'"'"','"'"'$F'"'"','"'"'s5'"'"') RETURNING 1;"' "1"
P -q -c "DROP POLICY IF EXISTS tmp_insert_livre ON public.recommendation_log; DELETE FROM public.recommendation_log WHERE recommendation_type='s5';" >/dev/null

# S6: falsifica os asserts DENTRO da migration (A2b/A2c). Eles rodam no apply e passaram -- mas
#     "passou" e "dispara quando deve" sao crencas diferentes (licao #1488: o detector que nunca
#     dispara). Aqui a sabotagem cria a precondicao do ataque de owner e exige que a migration ABORTE.
FALS=5
echo "  --- S6: A2c (CREATE em public) tem de ABORTAR a migration ---"
P -q -c "GRANT CREATE ON SCHEMA public TO anon;" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then
  echo "  FAIL [S6] a migration APLICOU com anon tendo CREATE em public — A2c nao dispara"
  FAIL=$((FAIL+1))
else
  echo "  OK   [S6] a migration ABORTOU (A2c tem dente)"
  FALS=$((FALS+1))
fi
P -q -c "REVOKE CREATE ON SCHEMA public FROM anon;" >/dev/null
P -q -f "$MIG" >/dev/null   # restaura estado bom

# S7: falsifica o A2b, que S6 NAO cobre. Achado MEU, ao reler a licao do #1488 contra o meu proprio
#     assert: no harness `pode_ler_custo` e `cap_custo_ler` sao criadas pelo MESMO papel, entao os
#     owners sao iguais POR CONSTRUCAO e o A2b nunca e visto disparando -- tautologico, exatamente o
#     detector-que-nunca-dispara que o #1488 custou caro. Aqui monto o ATAQUE de fato: um papel
#     hostil pre-cria a assinatura, `CREATE OR REPLACE` PRESERVA o owner dele, e a migration tem de
#     recusar. E a unica prova de que o achado #3 do Codex esta realmente fechado.
echo "  --- S7: A2b (owner hostil pre-criado) tem de ABORTAR a migration ---"
P -q -c "DROP FUNCTION IF EXISTS public.pode_ler_custo();
         DROP ROLE IF EXISTS atacante; CREATE ROLE atacante;
         GRANT CREATE ON SCHEMA public TO atacante;
         SET ROLE atacante;
         CREATE FUNCTION public.pode_ler_custo() RETURNS boolean LANGUAGE sql AS \$\$ SELECT true \$\$;
         RESET ROLE;
         REVOKE CREATE ON SCHEMA public FROM atacante;" >/dev/null 2>&1
OWNER_HOSTIL=$(P -q -tA -c "SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('public.pode_ler_custo()');" | tail -1)
if [ "$OWNER_HOSTIL" != "atacante" ]; then
  echo "  FAIL [S7] a montagem falhou: owner e '$OWNER_HOSTIL', esperava 'atacante' — sabotagem nao rodou"
  FAIL=$((FAIL+1))
elif P -q -f "$MIG" >/dev/null 2>&1; then
  echo "  FAIL [S7] a migration APLICOU sobre funcao de owner hostil — A2b nao dispara"
  FAIL=$((FAIL+1))
else
  echo "  OK   [S7] a migration ABORTOU (A2b tem dente; CREATE OR REPLACE preservou o owner 'atacante')"
  FALS=$((FALS+1))
fi
P -q -c "DROP FUNCTION IF EXISTS public.pode_ler_custo(); DROP ROLE IF EXISTS atacante;" >/dev/null 2>&1
P -q -f "$MIG" >/dev/null   # restaura estado bom

echo
echo "=== TOTAL: ${PASS} asserts de baseline, ${FAIL} falhas ==="
if [ "$FAIL" -eq 0 ]; then
  echo "VERDE (baseline ${BASE_PASS} asserts + ${FALS} falsificacoes com dente)"
else
  echo "VERMELHO"
fi
exit "$FAIL"

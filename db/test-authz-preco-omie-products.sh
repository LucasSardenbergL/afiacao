#!/usr/bin/env bash
# shellcheck disable=SC2016  # os comandos passados a `falsifica` sao strings avaliadas DEPOIS da
#                              sabotagem: a expansao TEM de ser adiada, entao aspas simples e o
#                              desenho, nao um descuido.
# shellcheck disable=SC2329  # `cleanup` e invocada indiretamente, pelo `trap` (o shellcheck nao ve).
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  Fecha a ESCRITA em omie_products — prova PG17 de 20260727120000                      ║
# ║   bash db/test-authz-preco-omie-products.sh > log 2>&1; echo "exit=$?"                ║
# ║  (NAO pipe pra tail — engole o exit != 0.)                                             ║
# ║                                                                                        ║
# ║  DISCIPLINA APLICADA (licoes caras do repo):                                           ║
# ║   · BASELINE PRE-MIGRATION: provo que o farmer ESCREVE em valor_unitario ANTES. Sem    ║
# ║     isso, "nao escreve depois" e indistinguivel de "o UPDATE esta quebrado" (#1488).   ║
# ║   · CONTROLE POSITIVO: service_role executa o MESMO UPDATE na MESMA linha, com exito,  ║
# ║     na mesma rodada. Sem ele, "ninguem escreve nada" passaria como sucesso.            ║
# ║   · A LEITURA TEM DE SOBREVIVER: fechar escrita apagando o catalogo do staff seria     ║
# ║     regressao, nao sucesso.                                                            ║
# ║   · SET ROLE (nao SET LOCAL — em autocommit vira WARNING e roda como superuser, que    ║
# ║     BYPASSA RLS e deixa a zona inteira falso-verde), + guard de current_user.          ║
# ║   · Estados de escrita MUTUAMENTE DISTINGUIVEIS (OK/RLS0/DENIED), nunca string vazia   ║
# ║     (#1380: assert que compara com "" passa ate sem gate nenhum).                      ║
# ║   · migration aplicada com -f, NUNCA -c com heredoc (o psql descarta o stdin em        ║
# ║     silencio e a falsificacao passa a medir o objeto original).                        ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="precoomie"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260727140000_authz_preco_fecha_omie_products.sql"
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
F='22222222-2222-2222-2222-222222222222'   # farmer   (employee + commercial_role=farmer) = Regina/Tatyana
CU='66666666-6666-6666-6666-666666666666'  # customer (nao-staff)

# guard: se o SET ROLE nao pegar, TODA a zona de RLS roda como superuser (bypassa) e fica
# falso-verde. Aborta em vez de "passar". Chamado por `le` e `escreve` antes de cada medicao.
guard_role() { # $1=uid
  local got
  got="$(Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT current_user;" | tail -1)"
  [ "$got" = "authenticated" ] || { echo "ABORT: SET ROLE nao pegou (current_user=$got)"; exit 9; }
}

# Tenta escrever valor_unitario do SKU P1 como <uid>. Devolve TRES estados mutuamente
# distinguiveis — nunca string vazia (#1380):
#   OK     = escreveu (grant presente E policy permitiu)
#   RLS0   = grant presente, mas a RLS barrou (0 linhas)
#   DENIED = o PRIVILEGIO negou (42501) — o REVOKE mordeu
# O CTE forca linha de resultado mesmo quando o UPDATE afeta 0 (senao viria vazio).
escreve() { # $1=uid  $2=valor
  local out
  guard_role "$1"
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q -tA \
        -c "SET test.uid='$1'; SET ROLE authenticated;
            WITH u AS (UPDATE public.omie_products SET valor_unitario=$2 WHERE codigo='P1' RETURNING 1)
            SELECT count(*)::text FROM u;" 2>&1)" || true
  case "$out" in
    *"permission denied"*) echo "DENIED" ;;
    *1)                    echo "OK" ;;
    *0)                    echo "RLS0" ;;
    *)                     echo "INESPERADO:$out" ;;
  esac
}

# Le o catalogo como <uid>. Mesma disciplina de `escreve`: estados distinguiveis, nunca vazio.
#   <n>    = leu n linhas (grant presente E policy permitiu)
#   DENIED = o PRIVILEGIO negou (42501) — util na S3, onde o REVOKE de SELECT e a sabotagem
le() { # $1=uid
  local out
  guard_role "$1"
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q -tA \
        -c "SET test.uid='$1'; SET ROLE authenticated;
            SELECT count(*)::text FROM public.omie_products;" 2>&1)" || true
  case "$out" in
    *"permission denied"*) echo "DENIED" ;;
    ''|*[!0-9]*)           echo "INESPERADO:$out" ;;
    *)                     echo "$out" ;;
  esac
}

# CONTROLE POSITIVO: o MESMO UPDATE, na MESMA linha, como service_role. Tem de dar OK sempre —
# se der outra coisa, a negacao do farmer nao prova gate, prova ambiente quebrado.
escreve_service() { # $1=valor
  local out
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q -tA \
        -c "SET ROLE service_role;
            WITH u AS (UPDATE public.omie_products SET valor_unitario=$1 WHERE codigo='P1' RETURNING 1)
            SELECT count(*)::text FROM u;" 2>&1)" || true
  case "$out" in
    *"permission denied"*) echo "DENIED" ;;
    *1)                    echo "OK" ;;
    *0)                    echo "RLS0" ;;
    *)                     echo "INESPERADO:$out" ;;
  esac
}

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — STUBS ESPELHANDO A PROD (money-path.md: "espelhe a PROD, nao o design")
# A policy e os GRANTs sao VERBATIM de pg_policies / relacl em prod (psql-ro, 2026-07-21).
# Stub menos permissivo que a prod inventa seguranca que nao existe.
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

-- VERBATIM de prod (2026-07-21) — master-only. Nao e usada por esta migration (opcao (i) do
-- spec §3.2), mas fica no stub porque o Codex vai perguntar por ela e porque a falsificacao S5
-- prova que ela NAO foi acidentalmente ligada ao caminho de escrita.
CREATE FUNCTION private.cap_preco_escrever(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$f$;

-- Colunas relevantes de prod (20 no total; aqui as que o gate e os asserts tocam)
CREATE TABLE public.omie_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL,
  descricao      text NOT NULL,
  valor_unitario numeric NOT NULL DEFAULT 0,
  estoque        numeric DEFAULT 0,
  ativo          boolean NOT NULL DEFAULT true,
  account        text NOT NULL DEFAULT 'oben',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;

-- relacl REAL da prod: arwdDxtm p/ anon E authenticated (o D e TRUNCATE, que ignora RLS)
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON public.omie_products TO anon, authenticated, service_role;

-- a policy VERBATIM de pg_policies (2026-07-21): FOR ALL, {authenticated}, com wrap de InitPlan
CREATE POLICY "Staff can manage products" ON public.omie_products
  FOR ALL TO authenticated
  USING      ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))));

INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('66666666-6666-6666-6666-666666666666','customer');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('22222222-2222-2222-2222-222222222222','farmer');

INSERT INTO public.omie_products(codigo, descricao, valor_unitario) VALUES
  ('P1','Produto 1 — o alvo dos UPDATEs', 100),
  ('P2','Produto 2',  50),
  ('P3','Produto 3',  40);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — BASELINE PRE-MIGRATION
# Prova que o DETECTOR enxerga o mundo VIVO. Sem isto, "farmer nao escreve" depois seria
# indistinguivel de "o UPDATE esta quebrado" (licao #1488).
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 2: baseline PRE-migration (o buraco existe mesmo?) ==="
eq "B1 farmer ESCREVE valor_unitario hoje (O BURACO)"  "$(escreve "$F" 999)"  "OK"
eq "B2 master escreve hoje"                            "$(escreve "$M" 998)"  "OK"
eq "B3 customer NAO escreve (gate de identidade ja ok)" "$(escreve "$CU" 997)" "RLS0"
eq "B4 farmer LE o catalogo hoje"                      "$(le "$F")" "3"
eq "B5 master LE o catalogo hoje"                      "$(le "$M")" "3"
eq "B6 authenticated TEM TRUNCATE antes (o D do arwdDxtm)" "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','TRUNCATE');")" "t"
eq "B7 anon TEM SELECT antes"                          "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','SELECT');")" "t"
eq "B8 anon TEM UPDATE antes"                          "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','UPDATE');")" "t"
eq "B9 existe 1 policy (a FOR ALL)"                    "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';")" "1"
eq "B10 CONTROLE POSITIVO: service_role escreve"       "$(escreve_service 100)" "OK"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — APLICA A MIGRATION REAL (-f, nunca -c com heredoc)
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 3: aplica 20260727120000 ==="
P -q -f "$MIG" >/dev/null
echo "  aplicada"
P -q -f "$MIG" >/dev/null   # idempotencia: a 2a aplicacao nao pode abortar
echo "  reaplicada (idempotente)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — O FECHAMENTO
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 4: pos-migration ==="
# — catalogo —
eq "A1 policy antiga morreu"        "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_products' AND policyname='Staff can manage products';")" "0"
eq "A2 exatamente 1 policy"         "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';")" "1"
eq "A2b e ela e FOR SELECT"         "$(Pq -c "SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';")" "SELECT"
eq "A3 authenticated SEM TRUNCATE"  "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','TRUNCATE');")" "f"
eq "A4a authenticated SEM UPDATE"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','UPDATE');")" "f"
eq "A4b authenticated SEM INSERT"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','INSERT');")" "f"
eq "A4c authenticated SEM DELETE"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','DELETE');")" "f"
# REVOKE ALL tira 8 privilegios; A3/A4a-c so cobriam 4. O stub da ZONA 1 concede os 8
# (GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN — arwdDxtm real de
# prod), entao aqui da pra provar que o REVOKE ALL tirou TODOS, nao so os 4 mais obvios.
eq "A4d authenticated SEM REFERENCES" "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','REFERENCES');")" "f"
eq "A4e authenticated SEM TRIGGER"    "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','TRIGGER');")" "f"
eq "A4f authenticated SEM MAINTAIN"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','MAINTAIN');")" "f"
eq "A5a anon SEM SELECT"            "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','SELECT');")" "f"
eq "A5b anon SEM TRUNCATE"          "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','TRUNCATE');")" "f"
eq "A5c anon SEM INSERT"            "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','INSERT');")" "f"
eq "A5d anon SEM UPDATE"            "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','UPDATE');")" "f"
eq "A5e anon SEM DELETE"            "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','DELETE');")" "f"
eq "A6 authenticated MANTEM SELECT (anti-tautologia)" "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','SELECT');")" "t"
eq "A7a service_role MANTEM UPDATE" "$(Pq -c "SELECT has_table_privilege('service_role','public.omie_products','UPDATE');")" "t"
eq "A7b service_role MANTEM INSERT" "$(Pq -c "SELECT has_table_privilege('service_role','public.omie_products','INSERT');")" "t"
eq "A8 RLS habilitada"              "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.omie_products'::regclass;")" "t"

# — comportamento: e aqui que o fechamento se prova, nao no catalogo —
echo "  --- comportamento ---"
eq "A9 farmer NAO escreve mais (O FECHO)"  "$(escreve "$F" 111)"  "DENIED"
eq "A10 master TAMBEM nao escreve (opcao (i) do spec, distingue da (ii))" "$(escreve "$M" 222)" "DENIED"
eq "A11 farmer AINDA LE (leitura preservada)" "$(le "$F")"  "3"
eq "A12 master AINDA LE"                      "$(le "$M")"  "3"
eq "A13 customer segue sem ler"               "$(le "$CU")" "0"

# — CONTROLE POSITIVO: sem isto, A9/A10 passariam num mundo onde NADA funciona —
eq "A14 CONTROLE POSITIVO: service_role escreve a MESMA linha" "$(escreve_service 333)" "OK"
eq "A14b e o valor mudou de verdade"  "$(Pq -c "SELECT valor_unitario::int FROM public.omie_products WHERE codigo='P1';")" "333"

echo
echo "=== BASELINE: ${PASS} OK / ${FAIL} FAIL ==="
[ "$FAIL" -eq 0 ] || { echo "BASELINE VERMELHO -- nao faz sentido falsificar"; exit 1; }
BASE_PASS=$PASS

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 5: falsificacao ==="
FALS=0
falsifica() { # $1=nome  $2=sql da sabotagem  $3=assert  $4=esperado_sabotado
  local got
  P -q -c "$2" >/dev/null 2>&1 || { echo "  FAIL [$1] a sabotagem nem aplicou"; FAIL=$((FAIL+1)); return; }
  got="$(eval "$3")"
  if [ "$got" = "$4" ]; then echo "  OK   [$1] o assert FICOU VERMELHO (veio [$got])"; FALS=$((FALS+1))
  else echo "  FAIL [$1] o assert NAO reagiu -- veio [$got], esperava a sabotagem produzir [$4]"; FAIL=$((FAIL+1)); fi
}

# S1: o REVOKE de TRUNCATE desfeito -> A3 tem de cair. Prova que o assert mede GRANT, nao
#     policy: trocar policy NUNCA revogaria TRUNCATE, que ignora RLS.
falsifica "S1 GRANT TRUNCATE de volta: A3 tem de cair" \
  "GRANT TRUNCATE ON public.omie_products TO authenticated;" \
  'Pq -c "SELECT has_table_privilege('"'"'authenticated'"'"','"'"'public.omie_products'"'"','"'"'TRUNCATE'"'"');"' "t"
P -q -c "REVOKE TRUNCATE ON public.omie_products FROM authenticated;" >/dev/null

# S2: A MAIS IMPORTANTE. A policy antiga de volta + o grant de UPDATE de volta -> A9 (farmer
#     nao escreve) tem de cair. Permissivas combinam com OR: se o DROP falhasse, o gate NAO
#     fecharia. Esta e a unica sabotagem que prova que o fecho e COMPORTAMENTAL, nao cosmetico
#     no pg_policies.
falsifica "S2 policy antiga + grant de volta: A9 tem de cair" \
  "GRANT UPDATE ON public.omie_products TO authenticated;
   CREATE POLICY \"Staff can manage products\" ON public.omie_products FOR ALL TO authenticated
     USING ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))))
     WITH CHECK ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))));" \
  'escreve "$F" 444' "OK"
P -q -c "DROP POLICY \"Staff can manage products\" ON public.omie_products; REVOKE UPDATE ON public.omie_products FROM authenticated;" >/dev/null

# S3: o GRANT SELECT de volta OMITIDO -> A11 (farmer ainda le) tem de cair.
#     Sem o grant, a negacao viria do privilegio e a policy nunca seria exercida.
falsifica "S3 sem GRANT SELECT: A11 (farmer le) tem de cair" \
  "REVOKE SELECT ON public.omie_products FROM authenticated;" \
  'le "$F"' "DENIED"
P -q -c "GRANT SELECT ON public.omie_products TO authenticated;" >/dev/null
eq "S3b leitura restaurada apos a sabotagem" "$(le "$F")" "3"

# S4: CONTROLE POSITIVO sabotado. Se service_role perder o grant, A14 tem de gritar -- senao
#     "ninguem escreve nada" passaria como sucesso e o harness estaria medindo ambiente morto.
falsifica "S4 service_role sem UPDATE: A14 tem de cair" \
  "REVOKE UPDATE ON public.omie_products FROM service_role;" \
  'escreve_service 555' "DENIED"
P -q -c "GRANT UPDATE ON public.omie_products TO service_role;" >/dev/null

# S5: a PRECONDICAO. Uma policy desconhecida (simulando sessao paralela) tem de ABORTAR a
#     migration -- senao o DROP+CREATE a deixaria viva e o gate nao fecharia.
echo "  --- S5: policy inesperada tem de ABORTAR a migration ---"
P -q -c "CREATE POLICY \"policy de outra sessao\" ON public.omie_products FOR ALL TO authenticated USING (true);" >/dev/null
S5_OUT="$(P -q -f "$MIG" 2>&1)" && S5_RC=0 || S5_RC=$?
if [ "$S5_RC" -eq 0 ]; then
  echo "  FAIL [S5] a migration APLICOU com policy desconhecida presente -- a precondicao nao dispara"
  FAIL=$((FAIL+1))
elif printf '%s' "$S5_OUT" | command grep -q 'precondicao FALHOU'; then
  echo "  OK   [S5] a migration ABORTOU PELA PRECONDICAO (tem dente)"
  FALS=$((FALS+1))
else
  echo "  FAIL [S5] a migration abortou, mas NAO pela precondicao -- saida: $S5_OUT"
  FAIL=$((FAIL+1))
fi
P -q -c "DROP POLICY \"policy de outra sessao\" ON public.omie_products;" >/dev/null
P -q -f "$MIG" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — O VALIDADOR (db/valida-authz-preco-omie-products.sql) TAMBEM E PROVADO
# Doutrina do #1490/#1501 (docs/agent/money-path.md): "o harness EXECUTA o validador contra
# banco bom (100% verde) e sabotado (tem de reprovar) — sem essa zona ele e carimbo." Ate
# aqui o harness so provava a MIGRATION; o validador (o script que roda pos-apply, so LE
# catalogo, e o founder cola no SQL Editor) nao tinha prova nenhuma de que morde.
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 6: o validador (db/valida-authz-preco-omie-products.sql) ==="
VALIDA="$REPO_ROOT/db/valida-authz-preco-omie-products.sql"
[ -f "$VALIDA" ] || { echo "validador ausente: $VALIDA"; exit 1; }

valida_linha() { Pq -f "$VALIDA"; }                  # a UNICA linha de resultados, campos com |
campo() { valida_linha | cut -d'|' -f"$1"; }         # $1 = indice 1-based (c1=1, c2=2, ...)

# quantos checks o arquivo declara AGORA (cada um termina em "AS cNN_...") — deriva em vez de
# hardcodar, pra nao descolar se algum dia mudar a contagem.
N_CHECKS="$(command grep -c -E 'AS c[0-9]+_' "$VALIDA")"
[ "$N_CHECKS" -gt 0 ] || { echo "N_CHECKS=0 -- grep nao achou check nenhum em $VALIDA"; exit 1; }
ESPERADO_BOM=""
for ((_i = 0; _i < N_CHECKS; _i++)); do ESPERADO_BOM="${ESPERADO_BOM}t|"; done
ESPERADO_BOM="${ESPERADO_BOM%|}"
echo "  ($N_CHECKS checks declarados no validador)"

eq "Z1 validador contra banco BOM: todos os $N_CHECKS em t" "$(valida_linha)" "$ESPERADO_BOM"

# restaura a policy CANONICA por DDL direto (nao reaplicando a migration) — necessario pra
# V2/V3: a sabotagem usa NOME diferente, e a PRECONDICAO da migration so tolera 'Staff can
# manage products' e 'omie_products_select_staff' — reaplicar com um nome desconhecido
# presente TEM de abortar (comportamento certo, provado na S5); nao pode ser o caminho de
# restauracao aqui.
restaura_policy_canonica() {
  P -q -c "
    DROP POLICY IF EXISTS omie_products_select_staff   ON public.omie_products;
    DROP POLICY IF EXISTS omie_products_select_staff_x ON public.omie_products;
    CREATE POLICY omie_products_select_staff ON public.omie_products
      FOR SELECT TO authenticated
      USING ((SELECT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
                   OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role))));
  " >/dev/null
}

# V2/V3: nao ha UM campo especifico pra apontar (a sabotagem pode derrubar mais de um) -- a
# exigencia e "pelo menos 1 campo veio f". Se NENHUM vier, e FURO REAL do validador: conta
# como FAIL (nunca como falsificacao bem-sucedida) e imprime a linha inteira pra nao esconder.
falsifica_algum() { # $1=nome  $2=sql da sabotagem
  local linha
  P -q -c "$2" >/dev/null 2>&1 || { echo "  FAIL [$1] a sabotagem nem aplicou"; FAIL=$((FAIL+1)); return; }
  linha="$(valida_linha)"
  case "$linha" in
    *f*) echo "  OK   [$1] pelo menos 1 check reprovou (linha: $linha)"; FALS=$((FALS+1)) ;;
    *)   echo "  FAIL [$1] FURO REAL: nenhum check reprovou -- o validador NAO detecta este mundo falso-verde (linha: $linha)"; FAIL=$((FAIL+1)) ;;
  esac
}

echo "  --- V1: qual adulterado (OR true na policy) -- c4 tem de cair ---"
falsifica "V1 qual adulterado (OR true): c4 tem de cair" \
  "DROP POLICY omie_products_select_staff ON public.omie_products;
   CREATE POLICY omie_products_select_staff ON public.omie_products
     FOR SELECT TO authenticated
     USING ((SELECT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
                  OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role))) OR true);" \
  'campo 4' "f"
P -q -f "$MIG" >/dev/null
eq "V1b validador volta a 100% (reaplicando a migration real)" "$(valida_linha)" "$ESPERADO_BOM"

echo "  --- V2: policy correta, NOME diferente (omie_products_select_staff_x) ---"
falsifica_algum "V2 nome diferente" \
  "DROP POLICY omie_products_select_staff ON public.omie_products;
   CREATE POLICY omie_products_select_staff_x ON public.omie_products
     FOR SELECT TO authenticated
     USING ((SELECT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
                  OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role))));"
restaura_policy_canonica
eq "V2b validador volta a 100% (policy canonica recriada)" "$(valida_linha)" "$ESPERADO_BOM"

echo "  --- V3: policy correta, TO service_role em vez de TO authenticated ---"
falsifica_algum "V3 TO service_role" \
  "DROP POLICY omie_products_select_staff ON public.omie_products;
   CREATE POLICY omie_products_select_staff ON public.omie_products
     FOR SELECT TO service_role
     USING ((SELECT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
                  OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role))));"
restaura_policy_canonica
eq "V3b validador volta a 100% (policy canonica recriada)" "$(valida_linha)" "$ESPERADO_BOM"

# fecha a zona no estado que a migration REAL produz (nao o recriado a mao) -- simetrico ao
# fechamento da zona 5.
P -q -f "$MIG" >/dev/null
eq "V-fim validador 100% com o estado pos-migration real" "$(valida_linha)" "$ESPERADO_BOM"

echo
echo "════════════════════════════════════════════════════════════"
echo "  asserts verdes : ${BASE_PASS}"
echo "  falsificacoes  : ${FALS}/8  (zona 5: S1-S5 / zona 6 validador: V1-V3)"
echo "  FAIL           : ${FAIL}"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && [ "$FALS" -eq 8 ] || exit 1
echo "TUDO VERDE"

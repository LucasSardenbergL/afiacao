#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU7: hardening repo-wide de SECURITY DEFINER                  ║
# ║      bash db/test-secdef-searchpath-oraculo.sh > /tmp/t.log 2>&1; echo $?      ║
# ║                                                                                ║
# ║  ⚠️ NATUREZA: este harness prova MECANISMO do Postgres, não uma migration.     ║
# ║  Ele existe pra DECIDIR a arquitetura do FU7 antes de escrever DDL:            ║
# ║    A) uma policy RLS que chama has_role() sobrevive ao REVOKE EXECUTE do       ║
# ║       caller? (decide se dá pra fechar o oráculo sem mover de schema)          ║
# ║    B) o shadow via pg_temp atinge o quê — relação? função? tipo? (dimensiona   ║
# ║       o "search_path=public é inseguro" pro AMBIENTE REAL, não pra doc)        ║
# ║  A topologia replica a de PROD (medida por psql-ro 2026-07-18): has_role       ║
# ║  SECDEF search_path=public + policy que a chama SEM qualificar.                ║
# ║                                                                                ║
# ║  Lei de Ferro: (2) negativo captura SQLSTATE e re-lança; (3) falsificação.     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="secdef-sp"
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — TOPOLOGIA FIEL À PROD
#   ⚠️ O default privilege do Supabase é OBRIGATÓRIO aqui: sem ele a função nasce
#   SEM execute p/ authenticated e o assert de REVOKE dá FALSO-VERDE (lição
#   database.md §5 — mordeu na Onda 5).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);

-- has_role: cópia FIEL do corpo de prod (SECDEF, search_path=public, ref NÃO qualificada)
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- tabela protegida por policy que chama has_role SEM qualificar (como as 389 de prod)
CREATE TABLE public.dado_sensivel (id int primary key, segredo text);
ALTER TABLE public.dado_sensivel ENABLE ROW LEVEL SECURITY;
CREATE POLICY "master le tudo" ON public.dado_sensivel FOR SELECT
  USING (has_role(auth.uid(), 'master'::public.app_role));

-- callers que chamam has_role SEM qualificar (as 28 de prod). Criados AGORA, com has_role
-- ainda em public — é assim que existem em prod. LANGUAGE sql é early-bound (valida no
-- CREATE); plpgsql é late-bound (só falha ao EXECUTAR) — medimos os dois.
CREATE FUNCTION public.caller_sql() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT has_role('11111111-1111-1111-1111-111111111111'::uuid, 'master'::public.app_role) $f$;

CREATE FUNCTION public.caller_plpgsql() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ BEGIN RETURN has_role('11111111-1111-1111-1111-111111111111'::uuid, 'master'::public.app_role); END $f$;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','customer');
INSERT INTO public.dado_sensivel VALUES (1,'confidencial');
GRANT SELECT ON public.dado_sensivel, public.user_roles TO authenticated, anon;
SQL
echo "topologia fiel aplicada (has_role SECDEF + policy nao-qualificada)"

MASTER="11111111-1111-1111-1111-111111111111"
CUSTOMER="22222222-2222-2222-2222-222222222222"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4A — O MECANISMO QUE DECIDE: policy RLS x REVOKE EXECUTE
# ══════════════════════════════════════════════════════════════════════════════
echo "── BLOCO A: policy RLS chama has_role — o caller precisa de EXECUTE? ──"

A1=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.dado_sensivel;" | tail -1)
eq "A1 baseline: master le via policy (COM execute)" "$A1" "1"

A2=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT count(*) FROM public.dado_sensivel;" | tail -1)
eq "A2 baseline: customer NAO le (policy nega)" "$A2" "0"

A3=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT public.has_role('$MASTER','master'::public.app_role);" | tail -1)
eq "A3 ORACULO ABERTO: customer pergunta 'X e master?' e recebe" "$A3" "t"

# ── o experimento decisivo: REVOKE mata o oráculo, mas mata a policy junto? ──
P -q -c "REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM authenticated, anon, PUBLIC;"
echo "  [REVOKE EXECUTE aplicado]"

# Lei #2: captura a SQLSTATE esperada e re-lança o resto.
A4=$(P -tA 2>&1 <<SQL
SET test.uid='$MASTER';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM count(*) FROM public.dado_sensivel;
  RAISE NOTICE 'SENTINELA_POLICY_SOBREVIVE';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_POLICY_MORREU_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$A4" in
  *SENTINELA_POLICY_MORREU_42501*) ok "A4 DECISIVO: policy EXIGE execute do caller — REVOKE a QUEBRA (opcao A morta)" ;;
  *SENTINELA_POLICY_SOBREVIVE*)    bad "A4 policy sobreviveu — reavaliar: opcao A seria viavel" ;;
  *)                               bad "A4 resultado inesperado: $A4" ;;
esac

A5=$(P -tA 2>&1 <<SQL
SET test.uid='$CUSTOMER';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM public.has_role('$MASTER','master'::public.app_role);
  RAISE NOTICE 'SENTINELA_ORACULO_SEGUE_ABERTO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$A5" in
  *SENTINELA_42501*)                ok "A5 o REVOKE de fato fecha o oraculo (so que ao custo do A4)" ;;
  *SENTINELA_ORACULO_SEGUE_ABERTO*) bad "A5 oraculo SEGUE ABERTO apos REVOKE" ;;
  *)                                bad "A5 resultado inesperado: $A5" ;;
esac

A6=$(Pq -c "SET ROLE service_role; SELECT public.has_role('$MASTER','master'::public.app_role);" | tail -1)
eq "A6 service_role INTACTO (o REVOKE nao atinge as 5 edges)" "$A6" "t"

P -q -c "GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;"
A7=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.dado_sensivel;" | tail -1)
eq "A7 re-GRANT restaura a policy (o dano do REVOKE e reversivel)" "$A7" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4C — A HIPÓTESE QUE SOBRA: mover p/ schema não exposto ao PostgREST.
#   Pergunta: as 389 policies referenciam por OID (sobrevivem) ou por nome (quebram)?
# ══════════════════════════════════════════════════════════════════════════════
echo "── BLOCO C: mover has_role p/ schema 'private' (nao exposto ao PostgREST) ──"

P -q <<'SQL'
CREATE SCHEMA private;
ALTER FUNCTION public.has_role(uuid, public.app_role) SET SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
SQL
echo "  [ALTER FUNCTION ... SET SCHEMA private aplicado]"

C1=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.dado_sensivel;" | tail -1)
eq "C1 DECISIVO: as policies SOBREVIVEM ao move (referencia por OID)" "$C1" "1"

C2=$(Pq -c "SELECT qual FROM pg_policies WHERE tablename='dado_sensivel';" | tail -1)
case "$C2" in
  *private.has_role*) ok "C2 pg_policies re-renderiza qualificado: $C2" ;;
  *)                  bad "C2 esperava 'private.has_role' no qual, veio: $C2" ;;
esac

C3=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT count(*) FROM public.dado_sensivel;" | tail -1)
eq "C3 policy segue NEGANDO customer apos o move" "$C3" "0"

# o ganho: a funcao sai do schema exposto → PostgREST nao a publica como RPC.
C4=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='has_role';" | tail -1)
eq "C4 has_role NAO esta mais em public (fora do PostgREST = oraculo fechado)" "$C4" "0"

# o CUSTO: os callers pré-existentes que chamam sem qualificar. Os 2 dialetos.
for LANG in sql plpgsql; do
  R=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  PERFORM public.caller_${LANG}();
  RAISE NOTICE 'SENTINELA_CALLER_OK';
EXCEPTION
  WHEN undefined_function THEN RAISE NOTICE 'SENTINELA_CALLER_QUEBROU_42883';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in
    *SENTINELA_CALLER_QUEBROU_42883*) ok "C5-${LANG} CUSTO medido: caller nao-qualificado QUEBRA (42883) — as 28 de prod" ;;
    *SENTINELA_CALLER_OK*)            bad "C5-${LANG} caller sobreviveu ao move — reavaliar o custo" ;;
    *)                                bad "C5-${LANG} resultado inesperado: $R" ;;
  esac
done

# e a mitigação do custo: basta o search_path incluir 'private' (sem reescrever corpo)
P -q -c "ALTER FUNCTION public.caller_sql() SET search_path TO 'public', 'private';"
C6=$(Pq -c "SELECT public.caller_sql();" | tail -1)
eq "C6 mitigacao: search_path com 'private' religa o caller sem tocar no corpo" "$C6" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4B — SHADOW VIA pg_temp: atinge o quê?
#   ⚠️ pg_temp é POR-SESSÃO → cada cenário roda num UNICO bloco psql
#   (lição money-path.md: em blocos separados o cenário nao enxerga a temp).
# ══════════════════════════════════════════════════════════════════════════════
echo "── BLOCO B: shadow via pg_temp — relação? função? ──"

P -q <<'SQL'
CREATE TABLE public.tabela_alvo (valor text);
INSERT INTO public.tabela_alvo VALUES ('REAL');

-- (i) ref NÃO qualificada + search_path=public  → o padrão das 148 de prod
CREATE FUNCTION public.le_naoqualificada() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT valor FROM tabela_alvo LIMIT 1 $f$;

-- (ii) ref NÃO qualificada + pg_temp POR ÚLTIMO → a mitigação proposta pelo Codex
CREATE FUNCTION public.le_pgtemp_last() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $f$ SELECT valor FROM tabela_alvo LIMIT 1 $f$;

-- (iii) ref QUALIFICADA + search_path=public → a mitigação usada no #1398
CREATE FUNCTION public.le_qualificada() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT valor FROM public.tabela_alvo LIMIT 1 $f$;

-- (iv) chama FUNÇÃO não qualificada → pg_temp é pesquisado p/ FUNÇÃO?
CREATE FUNCTION public.checa_permissao() RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT 'REAL' $f$;
CREATE FUNCTION public.usa_funcao_naoqualificada() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT checa_permissao() $f$;

GRANT EXECUTE ON FUNCTION public.le_naoqualificada(), public.le_pgtemp_last(),
  public.le_qualificada(), public.usa_funcao_naoqualificada() TO authenticated;
SQL

# B1/B2/B3/B4 — TUDO num bloco psql só (pg_temp é por-sessão)
BOUT=$(P -tA <<'SQL'
SET ROLE authenticated;
CREATE TEMP TABLE tabela_alvo (valor text);
INSERT INTO pg_temp.tabela_alvo VALUES ('SHADOW');
CREATE FUNCTION pg_temp.checa_permissao() RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT 'SHADOW' $f$;
SELECT 'B1='||public.le_naoqualificada();
SELECT 'B2='||public.le_pgtemp_last();
SELECT 'B3='||public.le_qualificada();
SELECT 'B4='||public.usa_funcao_naoqualificada();
SQL
)
echo "${BOUT//$'\n'/$'\n'     }" | sed '1s/^/     /'

b() { echo "$BOUT" | grep -o "^$1=.*" | cut -d= -f2; }
case "$(b B1)" in
  SHADOW) ok "B1 shadow de RELAÇÃO FUNCIONA com search_path=public (vetor REAL)" ;;
  REAL)   bad "B1 shadow de relação NAO funcionou — revisar premissa do FU7" ;;
  *)      bad "B1 inesperado: $(b B1)" ;;
esac
eq "B2 pg_temp POR ULTIMO imuniza"        "$(b B2)" "REAL"
eq "B3 ref QUALIFICADA imuniza"           "$(b B3)" "REAL"
eq "B4 pg_temp NAO faz shadow de FUNCAO"  "$(b B4)" "REAL"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: se o REVOKE fosse só FROM PUBLIC (o erro clássico do Supabase — database.md §5),
#     o authenticated AINDA executaria. Prova que o assert A5 tem dente.
P -q -c "REVOKE EXECUTE ON FUNCTION private.has_role(uuid, public.app_role) FROM PUBLIC;"
F1=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT private.has_role('$MASTER','master'::public.app_role);" 2>&1 | tail -1)
if [ "$F1" = "t" ]; then ok "F1 sabotagem detectada: REVOKE so-FROM-PUBLIC deixa o oraculo ABERTO (A5 seria vermelho)"
else bad "F1 falsificacao SEM DENTE: esperava oraculo aberto, veio [$F1]"; fi

# F2: sabota a mitigação do B2 (tira o pg_temp-last) → o shadow tem de voltar.
#     Prova que B2 mede a mitigação, e não um efeito colateral do harness.
P -q -c "ALTER FUNCTION public.le_pgtemp_last() SET search_path TO 'public';"
F2=$(P -tA <<'SQL' | tail -1
SET ROLE authenticated;
CREATE TEMP TABLE tabela_alvo (valor text);
INSERT INTO pg_temp.tabela_alvo VALUES ('SHADOW');
SELECT public.le_pgtemp_last();
SQL
)
if [ "$F2" = "SHADOW" ]; then ok "F2 sabotagem detectada: sem pg_temp-last o shadow VOLTA (B2 tem dente)"
else bad "F2 falsificacao SEM DENTE: esperava SHADOW, veio [$F2]"; fi
P -q -c "ALTER FUNCTION public.le_pgtemp_last() SET search_path TO 'public', 'pg_temp';"

# F3: sabota a policy p/ USING(true) → A5 (customer negado) tem de virar vermelho.
P -q -c "DROP POLICY \"master le tudo\" ON public.dado_sensivel; CREATE POLICY \"master le tudo\" ON public.dado_sensivel FOR SELECT USING (true);"
F3=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT count(*) FROM public.dado_sensivel;" | tail -1)
if [ "$F3" = "1" ]; then ok "F3 sabotagem detectada: USING(true) deixa customer ler (A2/C3 seriam vermelhos)"
else bad "F3 falsificacao SEM DENTE: esperava 1, veio [$F3]"; fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

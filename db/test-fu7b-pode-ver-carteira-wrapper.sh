#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU7-b: pode_ver_carteira_completa → private + wrapper public  ║
# ║      bash db/test-fu7b-pode-ver-carteira-wrapper.sh > /tmp/t.log 2>&1; echo $?║
# ║                                                                                ║
# ║  Aplica a migration REAL 20260718170000_fu7b_*.sql sobre a topologia de prod:  ║
# ║    · 64 policies (representadas) + 1 view security_invoker                     ║
# ║    · 3 funções SECDEF que a chamam SEM qualificar                             ║
# ║    · 4 call-sites de edge via service_role → exigem o wrapper                  ║
# ║                                                                                ║
# ║  Prova o que o #1421 não cobriu: o WRAPPER de mesmo nome (sombreia a private   ║
# ║  p/ callers não-qualificados) e a cadeia SECDEF→SECDEF preservando auth.uid(). ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="fu7b"
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

GESTOR="11111111-1111-1111-1111-111111111111"
VENDEDOR="33333333-3333-3333-3333-333333333333"
CUSTOMER="22222222-2222-2222-2222-222222222222"

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — TOPOLOGIA FIEL À PROD (default privilege do Supabase é obrigatório)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TYPE public.commercial_role AS ENUM ('vendedor','gerencial','estrategico','super_admin');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id=_user_id AND role=_role) $f$;

-- get_commercial_role já veio do #1421 sem EXECUTE p/ authenticated
CREATE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT commercial_role FROM public.commercial_roles WHERE user_id=_user_id LIMIT 1 $f$;
REVOKE EXECUTE ON FUNCTION public.get_commercial_role(uuid) FROM authenticated, anon, PUBLIC;

-- o ALVO, com o corpo EXATO de prod (refs não qualificadas)
CREATE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT has_role(_uid,'master'::public.app_role)
     OR (has_role(_uid,'employee'::public.app_role)
         AND get_commercial_role(_uid) IN ('gerencial'::public.commercial_role,
             'estrategico'::public.commercial_role,'super_admin'::public.commercial_role));
$f$;

-- tabela gateada por policy que a chama SEM qualificar (as 64 de prod)
CREATE TABLE public.radar_empresas (id int, empresa text);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_select ON public.radar_empresas FOR SELECT
  USING (pode_ver_carteira_completa(auth.uid()));

-- VIEW security_invoker (roda como o CALLER → precisa de EXECUTE + USAGE no schema)
CREATE TABLE public.farmer_calls (customer_user_id uuid, nota text);
ALTER TABLE public.farmer_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY fc_all ON public.farmer_calls FOR SELECT USING (true);
CREATE VIEW public.v_cliente_interacoes WITH (security_invoker=true) AS
  SELECT fc.customer_user_id, fc.nota FROM public.farmer_calls fc
  WHERE pode_ver_carteira_completa(auth.uid());

-- ⚠️ OS 17 CALLERS QUE QUALIFICAM `public.` — a classe que o #1421 QUEBROU EM PROD.
-- Mover a função sem deixar nada ocupando `public.<nome>` faz cada um destes falhar com 42883
-- ao EXECUTAR (late-bound: o ALTER não valida o corpo de quem referencia). Aqui é o wrapper que
-- os mantém vivos — e o assert A13/falsificação F6 provam que é ELE, não sorte.
CREATE FUNCTION public.criar_plano_tatico_stub(_customer uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ BEGIN RETURN public.pode_ver_carteira_completa(auth.uid()); END $f$;

-- as 3 funções internas SECDEF que a chamam SEM qualificar
CREATE FUNCTION public.get_preco_cockpit(p_itens jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT pode_ver_carteira_completa(auth.uid()) $f$;
CREATE FUNCTION public.medir_abaixo_piso_tier(p_dias integer)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ BEGIN RETURN pode_ver_carteira_completa(auth.uid()); END $f$;
CREATE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT pode_ver_carteira_completa(auth.uid()) $f$;

-- ⚠️ ESPELHAR O ACL DE PROD: função nova nasce com proacl=NULL ⇒ PUBLIC tem EXECUTE IMPLÍCITO.
-- Em prod essas funções NÃO têm grant a PUBLIC (medido: proacl sem `=X`). Sem este REVOKE o
-- harness diverge da prod e a falsificação F2 NÃO MORDE — revogar de `authenticated` vira no-op
-- enquanto o privilégio chega por PUBLIC. É a lição "espelhe a PROD, não o design", aplicada a ACL.
REVOKE EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid), public.has_role(uuid, public.app_role),
  public.get_preco_cockpit(jsonb), public.medir_abaixo_piso_tier(integer),
  public.get_defasagem_cliente(jsonb, uuid) FROM PUBLIC;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('22222222-2222-2222-2222-222222222222','customer'),
  ('33333333-3333-3333-3333-333333333333','employee');
INSERT INTO public.commercial_roles VALUES
  ('11111111-1111-1111-1111-111111111111','gerencial'),
  ('33333333-3333-3333-3333-333333333333','vendedor');
INSERT INTO public.radar_empresas VALUES (1,'ACME');
INSERT INTO public.farmer_calls VALUES ('22222222-2222-2222-2222-222222222222','ligacao');
GRANT SELECT ON public.radar_empresas, public.farmer_calls, public.v_cliente_interacoes,
  public.user_roles TO authenticated, anon;
SQL
echo "topologia fiel aplicada"

echo "── baseline pré-migration (o furo existe) ──"
B1=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT public.pode_ver_carteira_completa('$GESTOR');" | tail -1)
eq "P1 ORACULO ABERTO: customer descobre que o uid X e gestor" "$B1" "t"
B2=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas;" | tail -1)
eq "P2 baseline autz: gestor le a tabela gateada" "$B2" "1"
B3=$(Pq -c "SET test.uid='$VENDEDOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas;" | tail -1)
eq "P3 baseline autz: vendedor comum NAO le" "$B3" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718180000_fu7b_pode_ver_carteira_completa_privado.sql"
# Estado REAL de prod pós-#1421: o schema private existe e `authenticated`/`anon` TÊM USAGE nele.
# ⚠️ Espelhar isso importa: sem o GRANT, o harness fica ACIDENTALMENTE mais seguro que a prod e a
# falsificação F1b (reabertura do wrapper) não morde — o INVOKER barraria por falta de USAGE, não
# pela ACL. Mesmo erro de "stub espelha a PROD, não o design" que já mordeu no ACL de PUBLIC.
P -q -c "CREATE SCHEMA IF NOT EXISTS private;
         GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── o oráculo HTTP fecha, a autorização sobrevive ──"

neg() { # $1=rótulo $2=uid $3=expr → exige 42501
  local R
  R=$(P -tA 2>&1 <<SQL
SET test.uid='$2';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM $3;
  RAISE NOTICE 'SENTINELA_SEGUE_ABERTO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_NEGADO_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in
    *SENTINELA_NEGADO_42501*) ok "$1" ;;
    *SENTINELA_SEGUE_ABERTO*) bad "$1 — SEGUE ABERTO" ;;
    *)                        bad "$1 — inesperado: $R" ;;
  esac
}

neg "A1 wrapper em public FECHADO p/ authenticated (oraculo HTTP morto)" "$CUSTOMER" "public.pode_ver_carteira_completa('$GESTOR')"

A2=$(Pq -c "SET ROLE service_role; SELECT public.pode_ver_carteira_completa('$GESTOR');" | tail -1)
eq "A2 service_role EXECUTA o wrapper (as 4 edges nao quebram)" "$A2" "t"

A3=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas;" | tail -1)
eq "A3 DECISIVO: a policy SOBREVIVE (gestor ainda le)" "$A3" "1"

A4=$(Pq -c "SET test.uid='$VENDEDOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas;" | tail -1)
eq "A4 policy segue NEGANDO vendedor comum (nao virou fail-open)" "$A4" "0"

A5=$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename='radar_empresas' AND qual ~ 'private\.pode_ver_carteira_completa';" | tail -1)
eq "A5 a policy religou por OID p/ private" "$A5" "1"

echo "── a view security_invoker (roda como o CALLER) ──"
A6=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.v_cliente_interacoes;" | tail -1)
eq "A6 view security_invoker funciona p/ gestor (EXECUTE+USAGE em private)" "$A6" "1"
A7=$(Pq -c "SET test.uid='$VENDEDOR'; SET ROLE authenticated; SELECT count(*) FROM public.v_cliente_interacoes;" | tail -1)
eq "A7 view segue negando vendedor comum" "$A7" "0"

echo "── os 3 callers internos (resolvem p/ o WRAPPER; são SECDEF owned por postgres) ──"
A8=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT public.get_preco_cockpit('{}'::jsonb);" | tail -1)
eq "A8 caller SQL atravessa o wrapper e ACERTA o gate" "$A8" "t"
A9=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT public.medir_abaixo_piso_tier(7);" | tail -1)
eq "A9 caller plpgsql idem" "$A9" "t"
A10=$(Pq -c "SET test.uid='$VENDEDOR'; SET ROLE authenticated; SELECT public.get_preco_cockpit('{}'::jsonb);" | tail -1)
eq "A10 e NEGA vendedor comum (auth.uid() sobreviveu a 2 SECDEF)" "$A10" "f"

# A11 — auth.uid() sobrevive à cadeia wrapper→private?
# ⚠️ A 1ª versão deste assert lia o GUC FORA da cadeia e por isso provava MENOS do que o rótulo
# dizia (achado do Codex). Agora o valor é lido DENTRO da função mais interna e devolvido de volta.
# Replica a topologia REAL: caller SECDEF (como os 3 de prod) → wrapper INVOKER → impl SECDEF.
P -q <<'SQL'
CREATE FUNCTION private.echo_uid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
AS $f$ SELECT auth.uid() $f$;
CREATE FUNCTION public.echo_uid_wrapper() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'private' AS $f$ SELECT private.echo_uid() $f$;
CREATE FUNCTION public.echo_uid_caller() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $f$ SELECT echo_uid_wrapper() $f$;
REVOKE EXECUTE ON FUNCTION private.echo_uid(), public.echo_uid_wrapper(), public.echo_uid_caller() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.echo_uid_caller() TO authenticated;
SQL
A11=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT public.echo_uid_caller();" | tail -1)
eq "A11 auth.uid() lido NO FUNDO da cadeia devolve o JWT do caller (troca-se role, nao GUC)" "$A11" "$GESTOR"

# A12 — a propriedade do wrapper INVOKER (confirmada na prática ao escrever este harness):
# como ele NÃO eleva, o caller precisa de USAGE+EXECUTE internos. Um caller `authenticated`
# chamando o wrapper direto bate em "permission denied for schema private" — que é justamente
# a barreira desejada. É o contraste com o desenho SECDEF, que dispensaria isso.
A12=$(P -tA 2>&1 <<SQL
SET test.uid='$GESTOR';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM public.echo_uid_wrapper();
  RAISE NOTICE 'SENTINELA_INVOKER_ELEVOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_INVOKER_NAO_ELEVA';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$A12" in
  *SENTINELA_INVOKER_NAO_ELEVA*) ok "A12 wrapper INVOKER nao eleva: caller sem privilegio interno e barrado" ;;
  *SENTINELA_INVOKER_ELEVOU*)    bad "A12 o wrapper elevou — deveria ser INVOKER" ;;
  *)                             bad "A12 inesperado: $A12" ;;
esac

echo "── os 17 callers que QUALIFICAM public. (a classe que o #1421 quebrou em prod) ──"
A13=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT public.criar_plano_tatico_stub('$CUSTOMER');" | tail -1)
eq "A13 caller com ref QUALIFICADA 'public.' sobrevive (o wrapper ocupa a assinatura)" "$A13" "t"
A14=$(Pq -c "SET test.uid='$VENDEDOR'; SET ROLE authenticated; SELECT public.criar_plano_tatico_stub('$CUSTOMER');" | tail -1)
eq "A14 ...e ainda ACERTA o gate (nega vendedor comum)" "$A14" "f"

echo "── o detector de reabertura (bloco 4 da migration) ──"
D1=$(Pq -c "SELECT has_function_privilege('authenticated','public.pode_ver_carteira_completa(uuid)','EXECUTE');" | tail -1)
eq "D1 authenticated SEM execute no wrapper" "$D1" "f"
D2=$(Pq -c "SELECT has_function_privilege('authenticated','private.pode_ver_carteira_completa(uuid)','EXECUTE');" | tail -1)
eq "D2 authenticated COM execute na implementacao (as policies precisam)" "$D2" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: simula a REABERTURA (alguém re-aplica a migration antiga por cima do wrapper).
#     O detector do bloco 4 tem de RECUSAR — provando que ele não é decorativo.
P -q -c "GRANT EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) TO authenticated;"
F1=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  IF has_function_privilege('authenticated','public.pode_ver_carteira_completa(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FU7-b: wrapper em public EXECUTAVEL por authenticated — oraculo reaberto';
  END IF;
  RAISE NOTICE 'SENTINELA_DETECTOR_CEGO';
EXCEPTION
  WHEN raise_exception THEN RAISE NOTICE 'SENTINELA_DETECTOR_MORDEU';
END \$\$;
SQL
)
case "$F1" in
  *SENTINELA_DETECTOR_MORDEU*) ok "F1 sabotagem detectada: o detector RECUSA a reabertura do oraculo" ;;
  *SENTINELA_DETECTOR_CEGO*)   bad "F1 detector CEGO — nao viu o wrapper reaberto" ;;
  *)                           bad "F1 inesperado: $F1" ;;
esac
# e, reaberto, o oráculo de fato volta a responder (prova que A1 tem dente)
F1b=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT public.pode_ver_carteira_completa('$GESTOR');" | tail -1)
eq "F1b com o wrapper reaberto o oraculo RESPONDE (A1 tem dente)" "$F1b" "t"
P -q -c "REVOKE EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) FROM authenticated;"

# F2: sem o GRANT em private, as 64 policies morrem com 42501 (prova que o GRANT do bloco 1
#     não é supérfluo — é o que separa "oráculo fechado" de "autorização quebrada").
#     ⚠️ Revogar de `authenticated` E de PUBLIC: com proacl=NULL o privilégio chega por PUBLIC e
#     o revoke-por-nome é NO-OP (foi o que fez esta falsificação nascer sem dente).
P -q -c "REVOKE EXECUTE ON FUNCTION private.pode_ver_carteira_completa(uuid) FROM authenticated, PUBLIC;"
F2=$(P -tA 2>&1 <<SQL
SET test.uid='$GESTOR';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM count(*) FROM public.radar_empresas;
  RAISE NOTICE 'SENTINELA_POLICY_VIVA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_POLICY_MORREU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$F2" in
  *SENTINELA_POLICY_MORREU*) ok "F2 sabotagem detectada: sem GRANT em private as policies dao 42501 (A3 tem dente)" ;;
  *)                         bad "F2 falsificacao SEM DENTE: $F2" ;;
esac
P -q -c "GRANT EXECUTE ON FUNCTION private.pode_ver_carteira_completa(uuid) TO authenticated;"

# F3: re-run da migration inteira é no-op (o founder re-cola no SQL Editor)
P -q -f "$MIG"
F3=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas;" | tail -1)
eq "F3 re-run e no-op (autz intacta, sem duplicar funcao)" "$F3" "1"
F3b=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='pode_ver_carteira_completa';" | tail -1)
eq "F3b exatamente 2 funcoes (wrapper public + impl private), nao 3" "$F3b" "2"

# F4 (Codex §4): policy e view NÃO precisam de USAGE no schema private — guardam a expressão já
# resolvida por OID, sem lookup de nome em runtime. Revogar USAGE de authenticated e exigir VERDE
# prova que o GRANT amplo do bloco 1 seria supérfluo (por isso a migration não o amplia).
P -q -c "REVOKE USAGE ON SCHEMA private FROM authenticated;"
F4a=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas;" | tail -1)
eq "F4a policy funciona SEM usage no schema private (resolve por OID)" "$F4a" "1"
F4b=$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.v_cliente_interacoes;" | tail -1)
eq "F4b view security_invoker idem" "$F4b" "1"
# e o contraste: uma chamada ESCRITA pelo caller exige USAGE (aí sim o nome é resolvido em runtime)
F4c=$(P -tA 2>&1 <<SQL
SET test.uid='$GESTOR';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM private.pode_ver_carteira_completa('$GESTOR');
  RAISE NOTICE 'SENTINELA_CHAMADA_DIRETA_OK';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_PRECISA_USAGE';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$F4c" in
  *SENTINELA_PRECISA_USAGE*) ok "F4c contraste: chamada DIRETA escrita pelo caller exige USAGE (nome resolvido em runtime)" ;;
  *)                         bad "F4c esperava 42501 por falta de USAGE: $F4c" ;;
esac
P -q -c "GRANT USAGE ON SCHEMA private TO authenticated;"

# F5 (Codex §3): o WRAPPER é um TOMBSTONE. Re-aplicar a migration LEGADA por cima restaura o CORPO
# mas NÃO reabre o EXECUTE — `CREATE OR REPLACE FUNCTION` preserva owner e ACL. É o que derruba a
# premissa da 1ª versão desta migration ("re-aplicar reabriria o oráculo silenciosamente").
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT has_role(_uid,'master'::public.app_role) $f$;
SQL
F5a=$(Pq -c "SELECT has_function_privilege('authenticated','public.pode_ver_carteira_completa(uuid)','EXECUTE');" | tail -1)
eq "F5a TOMBSTONE: CREATE OR REPLACE legado NAO reabre o execute (ACL preservada)" "$F5a" "f"
F5b=$(Pq -c "SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='pode_ver_carteira_completa';" | tail -1)
eq "F5b ...mas o CORPO foi substituido (drift real: voltou a SECDEF) — so um hash pega isso" "$F5b" "t"

# F6: A FALSIFICAÇÃO MAIS IMPORTANTE — reproduz o bug do #1421.
# Dropar o wrapper deixa `public.pode_ver_carteira_completa` inexistente. Os 17 callers que
# qualificam `public.` passam a falhar com 42883 ao EXECUTAR (late-bound: o DROP não valida
# o corpo de quem referencia). É EXATAMENTE o que quebrou 4 RPCs em produção no #1421 — lá
# não havia wrapper ocupando a assinatura. Prova que A13 tem dente e que o wrapper é a defesa.
P -q -c "DROP FUNCTION public.pode_ver_carteira_completa(uuid);"
F6=$(P -tA 2>&1 <<SQL
SET test.uid='$GESTOR';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM public.criar_plano_tatico_stub('$CUSTOMER');
  RAISE NOTICE 'SENTINELA_CALLER_SOBREVIVEU_SEM_WRAPPER';
EXCEPTION
  WHEN undefined_function THEN RAISE NOTICE 'SENTINELA_CALLER_QUEBROU_42883';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$F6" in
  *SENTINELA_CALLER_QUEBROU_42883*)        ok "F6 sabotagem detectada: SEM o wrapper o caller qualificado QUEBRA (42883) — reproduz o #1421" ;;
  *SENTINELA_CALLER_SOBREVIVEU_SEM_WRAPPER*) bad "F6 falsificacao SEM DENTE: caller sobreviveu sem o wrapper" ;;
  *)                                       bad "F6 inesperado: $F6" ;;
esac

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

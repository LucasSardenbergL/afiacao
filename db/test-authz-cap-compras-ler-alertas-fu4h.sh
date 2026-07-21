#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU4-H: as 2 tabelas de compras fora da matriz                     ║
# ║   bash db/test-authz-cap-compras-ler-alertas-fu4h.sh > "$S/t.log" 2>&1; echo $?   ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20260720160000 e prova que a policy de SELECT de          ║
# ║  `reposicao_alerta_pedido_minimo` e `reposicao_auto_aprovacao_log` saiu de         ║
# ║  "staff (employee OR master)" e entrou em `private.cap_compras_ler` (master-only)  ║
# ║  SEM quebrar a escrita (SECDEF service-role-only) e SEM tirar o master.            ║
# ║                                                                                    ║
# ║  ⚠️ É prova de RLS: TODO assert de leitura roda sob `SET ROLE authenticated`.      ║
# ║  O psql conecta como superuser, que BYPASSA RLS — asserts rodados como postgres    ║
# ║  pintariam tudo de verde provando nada. O guard aborta se o SET ROLE não pegar.    ║
# ║                                                                                    ║
# ║  Lei #1: a migration REAL é aplicada (não um stub da lógica).                      ║
# ║  Lei #2: negativo por CONTAGEM sob a role certa + anon por SQLSTATE.               ║
# ║  Lei #3: ZONA 5 sabota e EXIGE vermelho.                                          ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5494}"
SLUG="fu4halertas"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260720160000_authz_cap_compras_ler_alertas_auto_aprovacao_fu4h.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

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

MASTER="10000000-0000-0000-0000-000000000001"
FARMER="40000000-0000-0000-0000-000000000004"
EMPL_SEM_CR="50000000-0000-0000-0000-000000000005"
CUSTOMER="60000000-0000-0000-0000-000000000006"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (stubs espelhando PROD, medido 2026-07-20)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 1: pré-requisitos ──"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth    TO authenticated, anon, service_role;

CREATE TYPE public.app_role        AS ENUM ('customer','employee','master','admin');
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- ⚠️ `user_roles` PRECISA do GRANT + RLS + policies de prod (medido 2026-07-20).
-- A policy ANTIGA ("staff") lê `public.user_roles` DIRETO — sem isto, ela falha com
-- `permission denied for table user_roles` e a falsificação F1 não consegue reabrir a leitura,
-- fazendo o assert negativo passar por acidente. (Já mordeu: 1ª execução deste harness.)
-- A policy NOVA não depende disto — `cap_compras_ler` chama `has_role`, que é SECDEF e bypassa
-- a RLS de user_roles. Por isso só a falsificação quebrava, e os asserts positivos não.
GRANT SELECT ON public.user_roles TO authenticated, service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins and employees can view all roles" ON public.user_roles
  FOR SELECT USING (public.has_role(auth.uid(),'master'::public.app_role)
                 OR public.has_role(auth.uid(),'employee'::public.app_role));
CREATE POLICY "Users can view their own roles" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);

-- a capability do #1434 (dependência REAL desta migration — a §0 aborta sem ela)
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) $f$;
REVOKE ALL ON FUNCTION private.cap_compras_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated, service_role;

-- ── as 2 tabelas alvo: colunas VERBATIM de prod (psql-ro 2026-07-20) ──
CREATE TABLE public.reposicao_alerta_pedido_minimo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL, fornecedor_nome text, grupo_codigo text, pedido_id bigint,
  valor_alertado numeric, valor_ultimo numeric,
  alertado_em timestamptz NOT NULL DEFAULT now(), resolvido_em timestamptz);
CREATE TABLE public.reposicao_auto_aprovacao_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id bigint, empresa text NOT NULL, fornecedor_nome text, grupo_codigo text,
  valor_total numeric, valor_anterior numeric, delta_pct numeric, regua text,
  criado_em timestamptz NOT NULL DEFAULT now());

-- RLS + a policy "staff" VERBATIM de prod: é o que a migration vai substituir.
-- Nome com espaço e acento de propósito — é o nome real, e a migration tem de lidar com ele
-- (%I no format). Um stub com nome "limpo" provaria um mundo que não existe.
ALTER TABLE public.reposicao_alerta_pedido_minimo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_auto_aprovacao_log   ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff lê alertas de pedido mínimo" ON public.reposicao_alerta_pedido_minimo
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = ANY (ARRAY['employee'::public.app_role,'master'::public.app_role])));
CREATE POLICY "Staff lê log de auto-aprovação" ON public.reposicao_auto_aprovacao_log
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = ANY (ARRAY['employee'::public.app_role,'master'::public.app_role])));

-- GRANTs como em prod (o default privilege do Supabase concede a anon também; RLS é quem nega)
GRANT SELECT, INSERT ON public.reposicao_alerta_pedido_minimo TO authenticated, anon, service_role;
GRANT SELECT, INSERT ON public.reposicao_auto_aprovacao_log   TO authenticated, anon, service_role;

-- ── uma tabela VIZINHA com policy 'Staff lê …', sem relação com esta migration ──
-- Prod tem ~20 delas (des_*, fornecedor_*, gmail_webhook_log, objects…). O harness precisa de
-- pelo menos UMA, senão um assert de escopo largo (`WHERE polname LIKE 'Staff lê%'` sobre o
-- catálogo inteiro) passa aqui e falha em produção — foi exatamente o que aconteceu com o
-- validador pós-apply na aplicação real (2026-07-20). Banco de teste mais LIMPO que produção
-- não é neutro: ele esconde a classe de bug que depende de vizinhança.
CREATE TABLE public.vizinha_irrelevante (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, x text);
ALTER TABLE public.vizinha_irrelevante ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff lê vizinha_irrelevante" ON public.vizinha_irrelevante
  FOR SELECT TO authenticated USING (true);

-- o WRITER real: SECDEF, service-role-only (authenticated NÃO executa). Bypassa RLS.
CREATE OR REPLACE FUNCTION public.reposicao_alerta_pedido_minimo_tick()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$
DECLARE v int;
BEGIN
  INSERT INTO public.reposicao_alerta_pedido_minimo(empresa, fornecedor_nome, pedido_id, valor_alertado, valor_ultimo)
    VALUES ('OBEN','Sayerlack', 4242, 2800.00, 3100.00);
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $f$;
REVOKE ALL ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() TO service_role;
SQL
echo "  pré-requisitos criados"

# guard do stub: sem a policy STAFF viva, a migration não teria o que trocar e a prova seria vacuosa.
eq "S1 stub nasce com a policy STAFF nas 2 tabelas" \
   "$(Pq -c "SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
               AND p.polcmd='r' AND pg_get_expr(p.polqual,p.polrelid) ~ 'user_roles';")" "2"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS (antes da migration: a precondição de papel gerencial olha isto)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 3: seeds ──"
P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'), ('$FARMER','employee'), ('$EMPL_SEM_CR','employee'), ('$CUSTOMER','customer');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES ('$FARMER','farmer');
-- linhas com o dado que a matriz protege: valor de compra + fornecedor
INSERT INTO public.reposicao_alerta_pedido_minimo(empresa, fornecedor_nome, pedido_id, valor_alertado, valor_ultimo)
  VALUES ('OBEN','Sayerlack', 101, 1500.00, 1800.00);
INSERT INTO public.reposicao_auto_aprovacao_log(empresa, fornecedor_nome, pedido_id, valor_total, valor_anterior, delta_pct, regua)
  VALUES ('OBEN','Sayerlack', 101, 9900.00, 9000.00, 10.0, 'r1');
SQL
echo "  seeds inseridos"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 2: aplicar migration real ──"
P -q -f "$MIG"
echo "  migration aplicada: $(basename "$MIG")"

if P -q -f "$MIG" >/dev/null 2>&1; then
  ok "P0a migration é IDEMPOTENTE (2ª aplicação passa)"
else
  bad "P0a re-aplicar a migration falhou — não é idempotente"
fi

# ── o guard de RLS: sem isto TODO assert de leitura seria teatro (superuser bypassa RLS) ──
as_user() { P -tA -q <<SQL
SET test.uid = '$1';
SET ROLE authenticated;
$2
SQL
}
GUARD=$(as_user "$MASTER" "SELECT current_user;")
[ "$GUARD" = "authenticated" ] || { echo "❌ HARNESS INVÁLIDO: SET ROLE não pegou (current_user=$GUARD)"; exit 1; }
echo "  guard: asserts rodam como '$GUARD' (não superuser) ✅"

le_alertas()  { as_user "$1" "SELECT count(*) FROM public.reposicao_alerta_pedido_minimo;"; }
le_aprov()    { as_user "$1" "SELECT count(*) FROM public.reposicao_auto_aprovacao_log;"; }

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 4a: o furo que o FU4-H fecha (farmer perde o valor de compra) ──"
# RLS não levanta exceção: ela FILTRA. O negativo aqui é contagem 0 sob a role certa.
eq "N1 farmer NÃO lê alertas de pedido mínimo"      "$(le_alertas "$FARMER")"      "0"
eq "N2 farmer NÃO lê log de auto-aprovação"         "$(le_aprov   "$FARMER")"      "0"
eq "N3 employee sem commercial_role NÃO lê alertas" "$(le_alertas "$EMPL_SEM_CR")" "0"
eq "N4 employee sem commercial_role NÃO lê aprovações" "$(le_aprov "$EMPL_SEM_CR")" "0"
eq "N5 customer NÃO lê alertas"                     "$(le_alertas "$CUSTOMER")"    "0"
eq "N6 uid NULO (sem JWT) NÃO lê alertas — fail-closed" \
   "$(P -tA -q -c "SET ROLE authenticated;" -c "SELECT count(*) FROM public.reposicao_alerta_pedido_minimo;")" "0"

echo "── ZONA 4b: anon negado ──"
eq "N7 anon NÃO lê alertas" \
   "$(P -tA -q -c "SET ROLE anon;" -c "SELECT count(*) FROM public.reposicao_alerta_pedido_minimo;")" "0"

echo "── ZONA 4c: master preserva TUDO (ninguém que devia ler perdeu) ──"
eq "M1 master LÊ os alertas"          "$(le_alertas "$MASTER")" "1"
eq "M2 master LÊ o log de aprovação"  "$(le_aprov   "$MASTER")" "1"
eq "M3 e o conteúdo sensível chega íntegro (valor+fornecedor)" \
   "$(as_user "$MASTER" "SELECT valor_alertado::int||'|'||fornecedor_nome FROM public.reposicao_alerta_pedido_minimo;")" \
   "1500|Sayerlack"
eq "M4 idem no log de aprovação (valor_total+delta)" \
   "$(as_user "$MASTER" "SELECT valor_total::int||'|'||delta_pct::int FROM public.reposicao_auto_aprovacao_log;")" "9900|10"

echo "── ZONA 4d: a ESCRITA não foi tocada (o writer é SECDEF service-role-only) ──"
# É o risco real de fechar uma policy: matar o alimentador em silêncio. O tick roda como
# service_role e bypassa RLS — a troca da policy de SELECT não pode afetá-lo.
eq "W1 o tick (SECDEF, service_role) ESCREVE normalmente após a troca" \
   "$(P -tA -q -c "SET ROLE service_role;" -c "SELECT public.reposicao_alerta_pedido_minimo_tick();")" "1"
eq "W1e ...e a linha nova existe de fato (2 agora)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_alerta_pedido_minimo;")" "2"
eq "W2 authenticated segue SEM EXECUTE no tick (fronteira de GRANT preservada)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.reposicao_alerta_pedido_minimo_tick()','EXECUTE');")" "f"

echo "── ZONA 4e: catálogo ──"
eq "K1 as 2 policies de SELECT estão no gate NOVO" \
   "$(Pq -c "SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
               AND p.polcmd='r' AND pg_get_expr(p.polqual,p.polrelid) ~ 'cap_compras_ler';")" "2"
eq "K2 NENHUMA sobrou no gate staff (user_roles)" \
   "$(Pq -c "SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
               AND p.polcmd='r' AND pg_get_expr(p.polqual,p.polrelid) ~ 'user_roles';")" "0"
# ⚠️ ESCOPADO ÀS 2 TABELAS — e o seed da ZONA 1 cria de propósito uma policy 'Staff lê …' numa
# tabela VIZINHA, sem relação com a migration. A 1ª versão deste assert (e do validador
# pós-apply) varria `pg_policy` inteiro e passava aqui SÓ porque o PG17 descartável é mais limpo
# que prod: no banco real há ~20 policies com esse prefixo, e o validador deu FALSO NEGATIVO na
# aplicação real. O stub mínimo escondeu o bug por ser mais limpo que produção — por isso a
# vizinha agora existe no harness: sem ela, o filtro largo volta a passar despercebido.
eq "K3 o nome MENTIROSO ('Staff lê...') sumiu DAS 2 TABELAS" \
   "$(Pq -c "SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
               AND p.polname LIKE 'Staff lê%';")" "0"
eq "K3b ...e a policy 'Staff lê' da tabela VIZINHA continua intacta (o assert não é largo demais)" \
   "$(Pq -c "SELECT count(*) FROM pg_policy WHERE polname LIKE 'Staff lê%';")" "1"
eq "K4 RLS segue LIGADA nas 2 (policy sem RLS seria decorativa)" \
   "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
               AND c.relrowsecurity;")" "2"
eq "K5 nenhuma policy de ESCRITA foi criada (a migration não inventa contrato)" \
   "$(Pq -c "SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
               AND p.polcmd <> 'r';")" "0"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota e EXIGE vermelho
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 5: falsificação (sabotar → exigir vermelho) ──"

# F1 — devolve a policy STAFF. O farmer TEM de voltar a ler; se não voltar, N1 é cego
# (ex.: a tabela estaria vazia, ou o SET ROLE não estaria pegando).
P -q <<'SQL'
DROP POLICY reposicao_alerta_pedido_minimo_sel ON public.reposicao_alerta_pedido_minimo;
CREATE POLICY "Staff lê alertas de pedido mínimo" ON public.reposicao_alerta_pedido_minimo
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = ANY (ARRAY['employee'::public.app_role,'master'::public.app_role])));
SQL
# ⚠️ IGUALDADE EXATA, não `!= "0"`. A 1ª versão deste assert usava `if [ ... != "0" ]` e passou
# com a query FALHANDO: `permission denied for table user_roles` devolve string VAZIA, e ""!="0"
# é verdadeiro ⇒ o assert declarava "o farmer voltou a ler" quando ninguém tinha lido nada.
# Um negativo formulado como "diferente do valor ruim" aceita todo resultado anômalo, inclusive
# erro; o positivo por igualdade só aceita o número que o cenário produz. São 2 linhas aqui:
# a do seed (pedido 101) + a que o tick inseriu na W1 (pedido 4242).
eq "F1 policy staff restaurada → farmer VOLTA a ler as 2 linhas → N1 tem dente" \
   "$(le_alertas "$FARMER")" "2"
eq "F1e ...e o vazamento entrega o valor de compra (efeito, não só contagem)" \
   "$(as_user "$FARMER" "SELECT valor_alertado::int FROM public.reposicao_alerta_pedido_minimo WHERE pedido_id=101;")" "1500"

# restaura o gate novo re-aplicando a migration REAL (é idempotente e reconhece a policy staff)
P -q -f "$MIG"
eq "F1r restaurado: farmer volta a NÃO ler" "$(le_alertas "$FARMER")" "0"

# F2 — a precondição de dependência tem dente? Sem cap_compras_ler, DEVE abortar.
P -q -c "DROP POLICY reposicao_alerta_pedido_minimo_sel ON public.reposicao_alerta_pedido_minimo;"
P -q -c "CREATE POLICY \"Staff lê alertas de pedido mínimo\" ON public.reposicao_alerta_pedido_minimo FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=(SELECT auth.uid()) AND ur.role=ANY(ARRAY['employee'::public.app_role,'master'::public.app_role])));"
P -q -c "DROP FUNCTION private.cap_compras_ler(uuid) CASCADE;" >/dev/null 2>&1 || true
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F2 precondição: migration aplicou SEM private.cap_compras_ler (deveria abortar)"
else
  ok "F2 precondição aborta sem cap_compras_ler → sem policy órfã"
fi

# recria a capability e as policies para as falsificações seguintes
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) $f$;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated, service_role;
SQL
P -q -c "DROP POLICY IF EXISTS reposicao_auto_aprovacao_log_sel ON public.reposicao_auto_aprovacao_log;" >/dev/null 2>&1 || true
P -q -c "CREATE POLICY \"Staff lê log de auto-aprovação\" ON public.reposicao_auto_aprovacao_log FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=(SELECT auth.uid()) AND ur.role=ANY(ARRAY['employee'::public.app_role,'master'::public.app_role])));" >/dev/null 2>&1 || true

# F3 — o guard de "policy divergente" tem dente? Troca o USING por algo que a migration NÃO
# reconhece e exige aborto (em vez de dropar uma regra que ela não sabe o que é).
P -q -c "DROP POLICY \"Staff lê alertas de pedido mínimo\" ON public.reposicao_alerta_pedido_minimo;"
P -q -c "CREATE POLICY politica_estranha ON public.reposicao_alerta_pedido_minimo FOR SELECT TO authenticated USING (true);"
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F3 guard: migration dropou uma policy de SELECT que NÃO era a staff medida"
else
  ok "F3 guard aborta com policy de SELECT divergente → não destrói regra desconhecida"
fi
eq "F3e ...e a policy estranha continua intacta (a migration não a tocou)" \
   "$(Pq -c "SELECT count(*) FROM pg_policy WHERE polname='politica_estranha';")" "1"

# F4 — a precondição de "papel gerencial vivo" tem dente?
P -q -c "DROP POLICY politica_estranha ON public.reposicao_alerta_pedido_minimo;"
P -q -c "CREATE POLICY \"Staff lê alertas de pedido mínimo\" ON public.reposicao_alerta_pedido_minimo FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=(SELECT auth.uid()) AND ur.role=ANY(ARRAY['employee'::public.app_role,'master'::public.app_role])));"
P -q -c "INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES ('20000000-0000-0000-0000-000000000002','gerencial');"
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F4 precondição: migration aplicou COM papel gerencial vivo (deveria abortar)"
else
  ok "F4 precondição aborta com papel gerencial vivo → o guard tem dente"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1

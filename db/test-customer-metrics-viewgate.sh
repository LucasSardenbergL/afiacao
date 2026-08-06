#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — view-gate de public.customer_metrics_mv                         ║
# ║  Migration sob teste: 20260717120000_seg_customer_metrics_gate_staff.sql      ║
# ║                                                                                ║
# ║  ACHADO: a view em `public` é security_invoker=off (lê a MV em `private` como  ║
# ║  OWNER, contornando a ausência de grant) + GRANT SELECT TO authenticated, SEM  ║
# ║  gate no WHERE. Como customer e staff compartilham o role `authenticated`,     ║
# ║  qualquer JWT de customer lê razão social/documento/faturamento de TODOS.      ║
# ║                                                                                ║
# ║  TOPOLOGIA REAL (Lei #1 — nada de stub da lógica): monta a MV em `public`      ║
# ║  (estado de 20260305000443), aplica a migration REAL 20260629120000 (que move  ║
# ║  p/ `private` e cria a view SEM gate = a prod de hoje), PROVA O VAZAMENTO,     ║
# ║  então aplica a migration REAL do fix e prova que fechou.                      ║
# ║                                                                                ║
# ║      bash db/test-customer-metrics-viewgate.sh > /tmp/t.log 2>&1; echo $?      ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="cmetrics-gate"
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

-- FIDELIDADE À PROD: `authenticated`/`anon` TÊM usage em `auth` e execute em
-- auth.uid()/auth.role() na produção — medido no psql-ro 2026-07-17:
--   has_schema_privilege('authenticated','auth','USAGE')      = t
--   has_function_privilege('authenticated','auth.uid()','EXECUTE') = t
-- O db/stubs-supabase.sql compartilhado NÃO concede isso, então uma query do
-- CALLER que chame auth.uid() dá 42501 no harness e funciona na prod — um
-- falso-DENIED que mascararia o resultado do teste (mordeu na 2ª rodada deste
-- harness). Concedido aqui, local, p/ não mexer no stub que 40 worktrees usam.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

-- FIDELIDADE À PROD (2): o DEFAULT PRIVILEGE do Supabase no schema `public`.
-- Medido em pg_default_acl 2026-07-17 — o concedente `postgres` tem, p/ o tipo
-- `r` (relações): anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm;
-- e p/ o tipo `f` (funções): anon=X, authenticated=X, service_role=X.
-- ⇒ TODA relação nova em `public` nasce com TODOS os privilégios p/ anon E
-- authenticated, e toda função nova nasce EXECUTÁVEL por eles. Ninguém precisa
-- conceder nada — é o objeto que nasce aberto. É a causa-raiz do
-- `authenticated=arwdDxtm` da view (a migration 20260305000443 só dá SELECT) e
-- a razão de o repo estar cheio de `REVOKE ... FROM anon`.
-- Sem isto o harness nasce FECHADO por acidente e não reproduz a dívida de ACL
-- que a 20260717130000 existe p/ pagar (o assert "authenticated tem INSERT"
-- falhava — era o harness otimista, não a prod).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL     ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
ne()  { if [ "$2" != "$3" ]; then ok "$1 (=$2, ≠$3)"; else bad "$1 — NÃO devia ser [$3], veio [$2]"; fi; }

# ── contagem sob identidade (BEGIN/COMMIT: `SET LOCAL ROLE` fora de transação é
#    só WARNING e mediria o SUPERUSER — o assert mentiria verde). Distingue
#    0-linhas (gate filtrou) de DENIED (42501, sem grant): resultados DIFERENTES.
_conta() {  # $1 = SQL de identidade, $2 = relação
  local out
  out="$(P -tAq <<SQL 2>&1 || true
BEGIN;
$1
SELECT count(*) FROM $2;
COMMIT;
SQL
)"
  if echo "$out" | grep -qi 'permission denied'; then echo "DENIED"; return; fi
  echo "$out" | grep -E '^[0-9]+$' | tail -1
}
CUST_UID='11111111-1111-1111-1111-111111111111'
EMPL_UID='22222222-2222-2222-2222-222222222222'
MAST_UID='33333333-3333-3333-3333-333333333333'
como_customer()     { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';" "$1"; }
como_employee()     { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$EMPL_UID';" "$1"; }
como_master()       { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$MAST_UID';" "$1"; }
como_anon()         { _conta "SET LOCAL ROLE anon; SET LOCAL test.role='anon';" "$1"; }
como_service_role() { _conta "SET LOCAL ROLE service_role; SET LOCAL test.role='service_role';" "$1"; }
# JWT `authenticated` SEM uid (sessão expirada/malformada) — o null-hardening do gate.
como_sem_uid()      { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated';" "$1"; }

# Lê o `document` (CNPJ) de OUTRO cliente (customer_user_id <> auth.uid()) sob a
# identidade dada. Contar linhas não prova vazamento de CONTEÚDO — isto prova.
#
# 3 estados MUTUAMENTE distinguíveis, nenhum deles "vazio":
#   <14 dígitos> = leu o CNPJ alheio (vazou) · <sem-linha> = gate filtrou · DENIED = 42501
# O COALESCE garante que SEMPRE volte 1 linha, e o grep final só aceita um dos 3
# formatos. Assim um helper quebrado devolve "" → nenhum assert casa → VERMELHO.
# (1ª versão deste helper tinha um grep inválido que devolvia "" sempre e pintava
#  2 asserts de verde por acidente — o anti-teatro da Lei #3 vale pro próprio teste.)
_le_documento() {  # $1 = SQL de identidade
  local out
  out="$(P -tAq <<SQL 2>&1 || true
BEGIN;
$1
SELECT COALESCE((SELECT document FROM public.customer_metrics_mv
                  WHERE customer_user_id IS DISTINCT FROM auth.uid()
                  ORDER BY document LIMIT 1), '<sem-linha>');
COMMIT;
SQL
)"
  if echo "$out" | grep -qi 'permission denied'; then echo "DENIED"; return; fi
  echo "$out" | grep -E '^([0-9]{14}|<sem-linha>)$' | tail -1
}

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos: a topologia REAL da prod (fatos vindos do psql-ro,
#          não do schema-snapshot, que pode estar stale)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
CREATE SCHEMA IF NOT EXISTS private;

-- enum real da prod: master, employee, customer
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');

-- user_roles REAL: RLS ativo + policies verbatim da prod
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- has_role REAL: SECURITY DEFINER + STABLE (bypassa a RLS de user_roles de propósito)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$function\$;

CREATE POLICY "Admins and employees can view all roles" ON public.user_roles FOR SELECT TO public
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Users can view their own roles" ON public.user_roles FOR SELECT TO public
  USING (auth.uid() = user_id);
GRANT SELECT ON public.user_roles TO anon, authenticated, service_role;

-- fonte da MV (irrelevante p/ o gate; só p/ a MV ter corpo fiel de 13 colunas)
CREATE TABLE public._metrics_src (
  customer_user_id uuid PRIMARY KEY, razao_social text, document text,
  ultima_compra_data timestamptz, dias_desde_ultima_compra int, pedidos_90d bigint,
  faturamento_90d numeric, ticket_medio_90d numeric, faturamento_prev_90d numeric,
  intervalo_medio_dias numeric, atraso_relativo numeric, is_cold_start boolean,
  calculated_at timestamptz
);

-- Identidades: 1 customer (sem role de staff), 1 employee, 1 master.
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$CUST_UID', 'customer'),
  ('$EMPL_UID', 'employee'),
  ('$MAST_UID', 'master');

-- 3 clientes com dado sensível FICTÍCIO (repo público: nada de CNPJ/nome real).
INSERT INTO public._metrics_src VALUES
  ('$CUST_UID','ACME MARCENARIA LTDA','11111111000191', now()-interval '10 day', 10, 4, 40000, 10000, 30000, 25, 0.4, false, now()),
  ('aaaaaaaa-0000-0000-0000-000000000001','BETA MOVEIS LTDA','22222222000172', now()-interval '5 day', 5, 9, 90000, 10000, 70000, 12, 0.4, false, now()),
  ('aaaaaaaa-0000-0000-0000-000000000002','GAMA DESIGN LTDA','33333333000153', now()-interval '2 day', 2, 2, 15000,  7500, 12000, 30, 0.1, true,  now());

-- Estado de 20260305000443: a MV nascia no schema public (MV NUNCA teve RLS).
-- (sem crase: este heredoc é NÃO-quotado p/ interpolar os UUIDs, e a crase viraria
--  command substitution do bash — corromperia o SQL silenciosamente.)
CREATE MATERIALIZED VIEW public.customer_metrics_mv AS
  SELECT customer_user_id, razao_social, document, ultima_compra_data,
         dias_desde_ultima_compra, pedidos_90d, faturamento_90d, ticket_medio_90d,
         faturamento_prev_90d, intervalo_medio_dias, atraso_relativo, is_cold_start,
         calculated_at
    FROM public._metrics_src;
CREATE UNIQUE INDEX customer_metrics_mv_pk ON public.customer_metrics_mv(customer_user_id);
GRANT SELECT ON public.customer_metrics_mv TO authenticated, service_role;  -- os grants de 20260305000443
-- (redundantes na prática: o default privilege acima já deu arwdDxtm — que é
--  exatamente a dívida de ACL que a 20260717130000 paga.)

-- RPC real da prod, criada AQUI (não na seção de teste) p/ que o assert do ACL
-- real signifique algo: SECDEF, corpo \`SELECT * FROM public.customer_metrics_mv\`
-- (late-bound — hoje aponta pra MV, depois da 20260629120000 aponta pra view).
CREATE OR REPLACE FUNCTION public.get_customer_metrics()
  RETURNS TABLE(customer_user_id uuid, razao_social text, document text, ultima_compra_data timestamptz,
                dias_desde_ultima_compra int, pedidos_90d bigint, faturamento_90d numeric,
                ticket_medio_90d numeric, faturamento_prev_90d numeric, intervalo_medio_dias numeric,
                atraso_relativo numeric, is_cold_start boolean, calculated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$ SELECT * FROM public.customer_metrics_mv; \$function\$;
-- ACL REAL medido na prod: proacl = postgres/service_role/sandbox_exec — SEM
-- authenticated. Como o default privilege acima concede EXECUTE a todos, alguém
-- revogou explicitamente em algum momento; reproduzimos esse estado.
REVOKE ALL ON FUNCTION public.get_customer_metrics() FROM PUBLIC, anon, authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2a — a migration REAL que criou o estado de HOJE (move p/ private + view sem gate)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/supabase/migrations/20260629120000_seg_customer_metrics_viewgate.sql"

echo ""
echo '═══ 1. O BUG REPRODUZ? (se não reproduzir, todo o resto é teatro) ═══'
eq "topologia fiel: a MV foi movida p/ o schema private" \
   "$(Pq -c "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='customer_metrics_mv' AND c.relkind='m';")" "private"
eq "topologia fiel: public.customer_metrics_mv é VIEW com security_invoker=off" \
   "$(Pq -c "SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name='security_invoker'),'<ausente>') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='customer_metrics_mv' AND c.relkind='v';")" "off"
eq "topologia fiel: authenticated TEM SELECT na view public" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.customer_metrics_mv','SELECT')::text;")" "true"
eq "topologia fiel: authenticated NÃO tem SELECT na MV crua em private" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','private.customer_metrics_mv','SELECT')::text;")" "false"

# O CORAÇÃO: sem gate, o customer lê as 3 linhas — inclusive as que não são dele.
eq "🔓 VAZAMENTO: customer lê TODAS as 3 linhas da view (o bug existe)" \
   "$(como_customer public.customer_metrics_mv)" "3"
# Ancorado no CNPJ EXATO do cliente BETA (≠ do customer logado): prova vazamento
# CROSS-CUSTOMER de conteúdo. "≠DENIED" não serviria — passaria com o helper quebrado.
eq "🔓 VAZAMENTO: customer lê o document (CNPJ) de OUTRO cliente" \
   "$(_le_documento "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';")" "22222222000172"
eq "   ↳ e o invoker=off é o que permite (a MV crua nega o mesmo customer)" \
   "$(como_customer private.customer_metrics_mv)" "DENIED"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2b — a migration REAL sob teste (o fix): view-gate no WHERE
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/supabase/migrations/20260717120000_seg_customer_metrics_gate_staff.sql"

echo ""
echo '═══ 2. O GATE FECHA o customer e PRESERVA quem lê de verdade ═══'
eq "🔒 customer → 0 linhas (filtrado pelo gate, NÃO 42501)" \
   "$(como_customer public.customer_metrics_mv)" "0"
eq "🔒 customer não lê mais o document de NINGUÉM (nem o próprio)" \
   "$(_le_documento "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';")" "<sem-linha>"
eq "🔒 authenticated SEM uid (sessão expirada) → 0 (null-hardened, não vaza)" \
   "$(como_sem_uid public.customer_metrics_mv)" "0"
eq "✅ employee → segue lendo as 3 (Customer360/MeuDia/Rota não quebram)" \
   "$(como_employee public.customer_metrics_mv)" "3"
eq "✅ master → segue lendo as 3" \
   "$(como_master public.customer_metrics_mv)" "3"
eq "✅ service_role → segue lendo as 3 (edge ai-ops-agent não quebra)" \
   "$(como_service_role public.customer_metrics_mv)" "3"
eq "✅ anon → segue DENIED (não tem grant; o gate não afrouxa nada)" \
   "$(como_anon public.customer_metrics_mv)" "DENIED"
eq "✅ a MV crua em private segue negada ao customer" \
   "$(como_customer private.customer_metrics_mv)" "DENIED"

echo ""
echo '═══ 3. O replace é SEGURO (contrato do PostgREST + regra #1375/#1377) ═══'
eq "as opções foram REPETIDAS no replace: security_invoker segue off" \
   "$(Pq -c "SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name='security_invoker'),'<RESETOU!>') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='customer_metrics_mv';")" "off"
eq "security_barrier segue true" \
   "$(Pq -c "SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name='security_barrier'),'<RESETOU!>') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='customer_metrics_mv';")" "true"
eq "lista/ordem das 13 colunas intacta (só acrescentou WHERE)" \
   "$(Pq -c "SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid='public.customer_metrics_mv'::regclass AND a.attnum>0 AND NOT a.attisdropped;")" \
   "customer_user_id,razao_social,document,ultima_compra_data,dias_desde_ultima_compra,pedidos_90d,faturamento_90d,ticket_medio_90d,faturamento_prev_90d,intervalo_medio_dias,atraso_relativo,is_cold_start,calculated_at"
eq "grants preservados: authenticated mantém SELECT (o gate filtra, não o grant)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.customer_metrics_mv','SELECT')::text;")" "true"
eq "grants preservados: service_role mantém SELECT (o disjunct é inútil sem o grant)" \
   "$(Pq -c "SELECT has_table_privilege('service_role','public.customer_metrics_mv','SELECT')::text;")" "true"
eq "a migration é idempotente (2º apply não quebra nem afrouxa)" \
   "$(P -q -f "$REPO_ROOT/supabase/migrations/20260717120000_seg_customer_metrics_gate_staff.sql" >/dev/null 2>&1 && como_customer public.customer_metrics_mv)" "0"

echo ""
echo '═══ 4. ACL least-privilege (migration 20260717130000 — Codex ponto 2) ═══'
# O relacl da prod é `authenticated=arwdDxtm/postgres`: SELECT + INSERT/UPDATE/
# DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, herdados de quando era MV em
# `public`. GRANT SELECT não remove privilégio antigo — só REVOKE remove.
eq "antes do REVOKE: authenticated carrega INSERT herdado (a dívida existe)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.customer_metrics_mv','INSERT')::text;")" "true"
P -q -f "$REPO_ROOT/supabase/migrations/20260717130000_seg_customer_metrics_acl_least_privilege.sql"
for PRIV in INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
  eq "🔒 authenticated NÃO tem $PRIV na view (least privilege)" \
     "$(Pq -c "SELECT has_table_privilege('authenticated','public.customer_metrics_mv','$PRIV')::text;")" "false"
done
eq "✅ authenticated mantém SELECT (o gate filtra, não o grant)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.customer_metrics_mv','SELECT')::text;")" "true"
eq "✅ service_role mantém SELECT (edge ai-ops-agent)" \
   "$(Pq -c "SELECT has_table_privilege('service_role','public.customer_metrics_mv','SELECT')::text;")" "true"
eq "🔒 anon segue sem SELECT" \
   "$(Pq -c "SELECT has_table_privilege('anon','public.customer_metrics_mv','SELECT')::text;")" "false"
eq "✅ o REVOKE/GRANT não afrouxou o gate: customer segue em 0" \
   "$(como_customer public.customer_metrics_mv)" "0"
eq "✅ ...e o staff segue lendo" "$(como_employee public.customer_metrics_mv)" "3"

echo ""
echo '═══ 5. get_customer_metrics (SECDEF, SELECT * da view) ═══'
# A RPC foi criada na ZONA 1 com o ACL REAL da prod — não aqui. Criá-la já com um
# grant artificial (como a 1ª versão fazia) provaria só o cenário artificial.
# (a) O ACL REAL: authenticated não executa. Este é o assert que importa —
#     o Codex apontou que só testar com um GRANT artificial demonstra defesa em
#     profundidade mas NÃO prova que o ACL real permaneceu fechado.
eq "🔒 ACL real: authenticated NÃO tem EXECUTE na RPC (é o que fecha hoje)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.get_customer_metrics()','EXECUTE')::text;")" "false"
eq "🔒 ACL real: anon NÃO tem EXECUTE na RPC" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.get_customer_metrics()','EXECUTE')::text;")" "false"
# (b) Defesa em profundidade, HIPOTÉTICA e rotulada como tal: SE um grant futuro
#     reativar a RPC, o gate ainda vale — o SECDEF troca o ROLE, não o JWT
#     (auth.uid() lê request.jwt.claim.sub, GUC do caller). Cenário artificial.
P -q -c "GRANT EXECUTE ON FUNCTION public.get_customer_metrics() TO authenticated;"
eq "🔒 [hipotético: COM grant] customer via RPC SECDEF → 0 (SECDEF troca role, não JWT)" \
   "$(_conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';" "public.get_customer_metrics()")" "0"
eq "✅ [hipotético: COM grant] employee via RPC SECDEF → 3" \
   "$(_conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$EMPL_UID';" "public.get_customer_metrics()")" "3"
P -q -c "REVOKE ALL ON FUNCTION public.get_customer_metrics() FROM authenticated;"

echo ""
echo '═══ 6. O gate não é vazado por ordem de avaliação (barrier + never executed) ═══'
# Codex ponto 4: com barrier=true + gate constante por statement, a varredura da
# MV nem chega a executar para o customer. Prova que não há leak por predicado
# aplicado antes do filtro.
PLANO="$(P -tAq <<SQL 2>&1 || true
BEGIN;
SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT * FROM public.customer_metrics_mv;
COMMIT;
SQL
)"
if echo "$PLANO" | grep -qi 'never executed'; then
  ok "customer: a varredura da MV aparece como 'never executed' (gate curto-circuita)"
else
  bad "customer: esperava 'never executed' no plano — veio: $(echo "$PLANO" | tr '\n' ' ' | cut -c1-120)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — FALSIFICAÇÃO (Lei #3): sabota → EXIGE vermelho → restaura.
#   Sentinela anti-teatro: a decisão é o COUNT (3 = vazou), nunca um ILIKE em
#   texto que o próprio código emite.
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo '═══ 7. FALSIFICAÇÃO — os asserts têm dente? ═══'

# (a) Sabotagem 1: remover o gate (a view volta ao estado de hoje).
P -q <<'SQL'
CREATE OR REPLACE VIEW public.customer_metrics_mv
  WITH (security_invoker = off, security_barrier = true) AS
  SELECT customer_user_id, razao_social, document, ultima_compra_data,
         dias_desde_ultima_compra, pedidos_90d, faturamento_90d, ticket_medio_90d,
         faturamento_prev_90d, intervalo_medio_dias, atraso_relativo, is_cold_start,
         calculated_at
    FROM private.customer_metrics_mv;
SQL
SABOTADO="$(como_customer public.customer_metrics_mv)"
if [ "$SABOTADO" = "3" ]; then
  ok "sem o gate o vazamento VOLTA (=3) ⇒ o assert do customer tem dente"
else
  bad "sabotagem não reabriu o vazamento (veio [$SABOTADO], esperado 3) ⇒ o assert do customer é FRACO — não é o gate que fecha"
fi
# idem p/ o assert de CONTEÚDO: sem o gate o CNPJ alheio reaparece. Se este ficasse
# verde sob sabotagem, o _le_documento estaria quebrado (foi o que aconteceu na 1ª
# rodada) e o "customer não lê mais o document" seria teatro.
SAB_DOC="$(_le_documento "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';")"
if [ "$SAB_DOC" = "22222222000172" ]; then
  ok "sem o gate o CNPJ alheio REAPARECE ⇒ o assert do document tem dente"
else
  bad "sabotagem não reabriu o CNPJ (veio [$SAB_DOC], esperado 22222222000172) ⇒ o assert do document é FRACO/quebrado"
fi

# (b) Sabotagem 2: a regra #1375/#1377 — replace SEM o WITH reseta a opção.
#     Prova que repetir o WITH na migration não é decoração.
P -q <<'SQL'
CREATE OR REPLACE VIEW public.customer_metrics_mv AS
  SELECT customer_user_id, razao_social, document, ultima_compra_data,
         dias_desde_ultima_compra, pedidos_90d, faturamento_90d, ticket_medio_90d,
         faturamento_prev_90d, intervalo_medio_dias, atraso_relativo, is_cold_start,
         calculated_at
    FROM private.customer_metrics_mv
   WHERE (SELECT auth.role()) = 'service_role'
      OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::app_role)), false)
      OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::app_role)), false);
SQL
RESETOU="$(Pq -c "SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name='security_barrier'),'<ausente>') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='customer_metrics_mv';")"
eq "replace SEM o WITH RESETA security_barrier (por isso a migration o repete)" "$RESETOU" "<ausente>"

# (c) Restaura a versão VERDADEIRA (cirúrgico: só re-aplica a migration sob teste)
P -q -f "$REPO_ROOT/supabase/migrations/20260717120000_seg_customer_metrics_gate_staff.sql"
eq "restaurado: customer volta a 0" "$(como_customer public.customer_metrics_mv)" "0"
eq "restaurado: customer volta a não ler o CNPJ" \
   "$(_le_documento "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$CUST_UID';")" "<sem-linha>"
eq "restaurado: employee volta a 3" "$(como_employee public.customer_metrics_mv)" "3"
eq "restaurado: employee volta a enxergar o CNPJ (o gate não quebra o staff)" \
   "$(_le_documento "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid='$EMPL_UID';")" "11111111000191"

echo ""
echo "═══════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1

#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F fase 2 — prova PG17: inventory_position fecha em cap_custo_ler,         ║
# ║  a view operacional serve saldo sem custo. Com falsificação.                   ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE ESTE HARNESS PROVA (e por que cada assert existe):
#
#   O achado que fez a migration existir: inventory_position tem DUAS policies permissivas, e
#   permissivas combinam com **OR**. `Staff can manage inventory` é FOR ALL (cobre SELECT). Fechar
#   apenas a policy _select deixaria o vendedor lendo custo pela outra — um fechamento FANTASMA que
#   passa em qualquer teste que só exercite a policy trocada. A falsificação F1 é o assert que pega
#   exatamente isso: recria a OUTRA policy na versão furada e exige que N1 fique VERMELHO.
#
#   O 2º achado: a view é `security_invoker=off` (lê a base como owner, de propósito — a base agora
#   exige cap_custo_ler que o separador não tem). Num `off` NÃO há RLS por baixo para salvar: o
#   WHERE e o ACL são a autorização inteira. Por isso o harness REPLICA o default privilege do
#   Supabase (ZONA 1) — sem ele a view nasceria fechada por acidente e o REVOKE "provaria" uma
#   segurança que a produção não teria (database.md §4, as 3 armadilhas de harness).
#
# Pré-requisitos: brew install postgresql@17 pgvector
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="fu4f-fase2"
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
# ZONA 1 — PRÉ-REQUISITOS (o estado de prod ANTES desta migration)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.commercial_role_t AS ENUM ('gestor','vendedor','farmer','estrategico','super_admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE IF NOT EXISTS public.commercial_roles (user_id uuid, commercial_role public.commercial_role_t);

-- has_role REAL (fail-closed: uid NULL ⇒ EXISTS false)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- private.cap_custo_ler REAL (verbatim do #1434 / 20260718190000)
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
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
$f$;
-- ACL espelhando a prod (medido 2026-07-20): authenticated TEM execute; anon NÃO.
REVOKE ALL     ON FUNCTION private.cap_custo_ler(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION private.cap_custo_ler(uuid) TO authenticated, service_role;
GRANT  USAGE   ON SCHEMA private TO authenticated, anon, service_role;

CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint,
  product_id uuid,
  saldo numeric,
  cmc numeric,
  preco_medio numeric,
  account text,
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.inventory_position ENABLE ROW LEVEL SECURITY;

-- O ESPELHO DE CUSTO, reproduzido fielmente (achado do Codex xhigh, confirmado em prod).
-- product_costs.cmc é escrita pela edge omie-analytics-sync como cópia de inventory_position.cmc.
-- Suas 2 policies são `master OR employee` — sem cap_custo_ler. Está aqui para o assert L1 medir
-- o limite REAL desta fase em vez de o harness fingir que a porta não existe.
CREATE TABLE IF NOT EXISTS public.product_costs (
  product_id uuid,
  cmc numeric,
  cost_price numeric
);
ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can manage product costs" ON public.product_costs;
CREATE POLICY "Staff can manage product costs" ON public.product_costs FOR ALL TO public
  USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
DROP POLICY IF EXISTS "Staff can view product costs" ON public.product_costs;
CREATE POLICY "Staff can view product costs" ON public.product_costs FOR SELECT TO public
  USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
GRANT ALL ON public.product_costs TO anon, authenticated, service_role;

-- ACL da TABELA espelhando prod (medido 2026-07-20 via psql-ro: anon=arwdDxtm, authenticated=arwdDxtm).
-- É o default privilege do Supabase já materializado na tabela — a RLS filtra POR CIMA do grant.
-- Sem isto o assert de RLS morre com 42501 antes de a policy sequer ser avaliada, e o harness
-- "provaria" negação que na verdade é falta de privilégio (causa oposta em natureza).
GRANT ALL ON public.inventory_position TO anon, authenticated, service_role;

-- As DUAS policies no estado PRÉ-migration (staff amplo, já wrapped em InitPlan como em prod)
DROP POLICY IF EXISTS "Staff can manage inventory" ON public.inventory_position;
CREATE POLICY "Staff can manage inventory" ON public.inventory_position FOR ALL TO public
  USING      ((SELECT (public.has_role((SELECT auth.uid()),'master'::public.app_role) OR public.has_role((SELECT auth.uid()),'employee'::public.app_role))))
  WITH CHECK ((SELECT (public.has_role((SELECT auth.uid()),'master'::public.app_role) OR public.has_role((SELECT auth.uid()),'employee'::public.app_role))));

DROP POLICY IF EXISTS staff_inventory_position_select ON public.inventory_position;
CREATE POLICY staff_inventory_position_select ON public.inventory_position FOR SELECT TO authenticated
  USING ((SELECT (public.has_role((SELECT auth.uid()),'master'::public.app_role) OR public.has_role((SELECT auth.uid()),'employee'::public.app_role))));
SQL

# ⚠️ DEFAULT PRIVILEGE DO SUPABASE — sem isto o harness MENTE.
# Em prod, pg_default_acl concede arwdDxtm a anon/authenticated/service_role em TODA relação nova do
# schema public: a VIEW da migration NASCE ABERTA, inclusive para `anon`. Se o harness não replicar,
# a view nasce fechada por acidente (só o owner) e o assert N4 ("anon não lê") passaria mesmo que a
# migration ESQUECESSE o REVOKE — provando uma segurança que a produção não teria.
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
SQL

# GUARD ANTI-FALSO-VERDE: o psql conecta como `postgres` (SUPERUSER), que BYPASSA RLS. Se o SET ROLE
# não pegar, TODO assert de RLS abaixo lê como superuser e fica verde por acidente — o harness
# inteiro viraria teatro. Aborta antes de gastar um assert.
GUARD=$(Pq -c "SET ROLE authenticated; SELECT current_user;" | tail -1)
[ "$GUARD" = "authenticated" ] || { echo "❌ ABORT: SET ROLE não pegou (current_user=$GUARD) — asserts de RLS seriam falso-verdes"; exit 1; }
echo "  🔒 guard SET ROLE ok (current_user=$GUARD sob SET ROLE)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260723130000_authz_custo_fu4f_fase2_inventory.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs
# ══════════════════════════════════════════════════════════════════════════════
M_UID='11111111-1111-1111-1111-111111111111'   # master        → cap_custo_ler = TRUE
F_UID='22222222-2222-2222-2222-222222222222'   # employee+farmer → cap_custo_ler = FALSE (o caso real)
C_UID='33333333-3333-3333-3333-333333333333'   # customer      → nada

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$M_UID'),('$F_UID'),('$C_UID') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$M_UID','master'::public.app_role),
  ('$F_UID','employee'::public.app_role),
  ('$C_UID','customer'::public.app_role);
-- Espelha prod: os 2 employees são farmer (nenhum é estrategico/super_admin ⇒ 0 passam no cap)
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES ('$F_UID','farmer');

INSERT INTO public.inventory_position(omie_codigo_produto, saldo, cmc, preco_medio, account) VALUES
  (1001, 50, 12.40, 13.10, 'oben'),
  (1002,  0, 99.90, 101.5, 'oben');

GRANT SELECT ON public.user_roles, public.commercial_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# ── M1: ESTRUTURAL — as DUAS policies migraram. É o assert que pega o fechamento fantasma.
POL_CAP=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='inventory_position' AND qual ILIKE '%cap_custo_ler%';")
eq "M1a as DUAS policies exigem cap_custo_ler" "$POL_CAP" "2"
POL_OLD=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='inventory_position' AND qual ILIKE '%has_role%';")
eq "M1b nenhuma policy antiga (has_role) sobrou" "$POL_OLD" "0"

# ── M2: o wrap InitPlan sobreviveu (perder o wrap = regressão de performance invisível ao autz)
POL_WRAP=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='inventory_position' AND qual ILIKE '%( select%';")
eq "M2 wrap InitPlan preservado nas 2" "$POL_WRAP" "2"

# ── P1: master LÊ custo pela tabela (cap_custo_ler = true)
MST=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT count(*) FROM public.inventory_position;" | tail -1)
eq "P1 master lê a tabela de custo" "$MST" "2"
MST_CMC=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT cmc FROM public.inventory_position WHERE omie_codigo_produto=1001;" | tail -1)
eq "P1b master vê o VALOR do cmc" "$MST_CMC" "12.40"

# ── N1: employee-farmer NÃO lê a tabela. O assert central: hoje ela lê 2 linhas.
FRM=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT count(*) FROM public.inventory_position;" | tail -1)
eq "N1 employee-farmer NÃO lê a tabela de custo" "$FRM" "0"

# ── P2: …mas LÊ saldo pela view operacional (o separador continua trabalhando)
FRM_V=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT count(*) FROM public.inventory_position_operacional;" | tail -1)
eq "P2 employee-farmer LÊ saldo pela view" "$FRM_V" "2"
FRM_SALDO=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT saldo FROM public.inventory_position_operacional WHERE omie_codigo_produto=1001;" | tail -1)
eq "P2b o saldo é o valor REAL (não mascarado)" "$FRM_SALDO" "50"

# ── P3: service_role (sync) segue lendo a tabela — BYPASSRLS
SVC=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.inventory_position;" | tail -1)
eq "P3 service_role (sync) preservado" "$SVC" "2"

# ── N2/N3: a view NÃO TEM as colunas de custo. Não é "escondido": não existe.
# EXECUTE dinâmico ⇒ o erro vira runtime e o EXCEPTION pega (query estática falharia no PARSE).
# Sentinela anti-teatro: string que o código NUNCA emite.
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  EXECUTE 'SELECT cmc FROM public.inventory_position_operacional LIMIT 1';
  RAISE NOTICE 'ZZ_FALHOU_VIEW_AINDA_TEM_CMC';
EXCEPTION
  WHEN undefined_column THEN RAISE NOTICE 'ZZ_SENTINELA_N2_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *ZZ_SENTINELA_N2_OK*) ok "N2 view não expõe cmc (42703 undefined_column)";; *) bad "N2 view AINDA expõe cmc — [$R]";; esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  EXECUTE 'SELECT preco_medio FROM public.inventory_position_operacional LIMIT 1';
  RAISE NOTICE 'ZZ_FALHOU_VIEW_AINDA_TEM_PM';
EXCEPTION
  WHEN undefined_column THEN RAISE NOTICE 'ZZ_SENTINELA_N3_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *ZZ_SENTINELA_N3_OK*) ok "N3 view não expõe preco_medio (42703)";; *) bad "N3 view AINDA expõe preco_medio — [$R]";; esac

# ── N4: anon NÃO lê a view (o REVOKE tem de morder — a view é invoker=off, não há RLS por baixo)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  EXECUTE 'SET LOCAL ROLE anon';
  EXECUTE 'SELECT count(*) FROM public.inventory_position_operacional';
  RAISE NOTICE 'ZZ_FALHOU_ANON_LEU_A_VIEW';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ZZ_SENTINELA_N4_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *ZZ_SENTINELA_N4_OK*) ok "N4 anon barrado na view (42501 — REVOKE mordeu)";; *) bad "N4 anon LEU a view — [$R]";; esac

# ── N5: customer autenticado (compartilha o role `authenticated` com staff) não passa no WHERE
CUS=$(Pq -c "SET test.uid='$C_UID'; SET ROLE authenticated; SELECT count(*) FROM public.inventory_position_operacional;" | tail -1)
eq "N5 customer não lê a view (gate do WHERE)" "$CUS" "0"

# ── N6: uid nulo (JWT sem sub) não passa — fail-closed
NUL=$(Pq -c "SET ROLE authenticated; SELECT count(*) FROM public.inventory_position_operacional;" | tail -1)
eq "N6 uid nulo não lê a view (fail-closed)" "$NUL" "0"

# ── Lacunas apontadas pelo Codex (rodada xhigh) — todas baratas e todas reais:

# M3: o WITH CHECK do FOR ALL também fechou. Inspecionar só `qual` deixaria a ESCRITA aberta.
POL_WC=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='inventory_position' AND with_check ILIKE '%cap_custo_ler%';")
eq "M3 WITH CHECK do FOR ALL fechado" "$POL_WC" "1"

# M4: NENHUMA policy a mais. Contar só as que têm cap_custo_ler não detecta uma 3ª `USING (true)`
# convivendo — permissivas somam por OR, então o total importa tanto quanto o conteúdo.
POL_TOT=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='inventory_position';")
eq "M4 exatamente 2 policies (nenhuma 3ª permissiva)" "$POL_TOT" "2"

# M5: allowlist EXATA de colunas da view. Testar só a ausência de cmc/preco_medio não pega uma
# coluna de custo futura com outro nome (custo_medio, valor_unitario…).
COLS=$(Pq -c "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_position_operacional';")
eq "M5 allowlist exata de colunas" "$COLS" "id,omie_codigo_produto,product_id,saldo,account,synced_at"

# M6: a view é simples ⇒ AUTOMATICAMENTE ATUALIZÁVEL. Se `authenticated` guardasse DML, a escrita
# passaria pelo owner e bypassaria a RLS da base — o REVOKE ALL tem de cobrir mais que o SELECT.
for PRIV in INSERT UPDATE DELETE; do
  D=$(Pq -c "SELECT has_table_privilege('authenticated','public.inventory_position_operacional','$PRIV');" | tail -1)
  eq "M6 authenticated SEM $PRIV na view" "$D" "f"
done

# N7: DML direto na tabela negado ao farmer (o FOR ALL fecha escrita, não só leitura)
# ⚠️ `FOUND` NÃO serve aqui: o `PERFORM set_config` acima dele já seta FOUND=true, e um EXECUTE
# dinâmico não o redefine de forma confiável — a 1ª versão deste assert acusou "farmer ESCREVEU"
# lendo o FOUND do PERFORM, não o do UPDATE. ROW_COUNT mede o que realmente aconteceu.
R=$(P -tA 2>&1 <<SQL
DO \$\$
DECLARE v_rows integer;
BEGIN
  PERFORM set_config('test.uid','$F_UID',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE 'UPDATE public.inventory_position SET cmc = 1 WHERE omie_codigo_produto = 1001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE NOTICE 'ZZ_SENTINELA_N7_OK';
  ELSE RAISE NOTICE 'ZZ_FALHOU_FARMER_ESCREVEU_% _LINHAS', v_rows; END IF;
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ZZ_SENTINELA_N7_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *ZZ_SENTINELA_N7_OK*) ok "N7 farmer não ESCREVE na tabela (FOR ALL fecha DML)";; *) bad "N7 farmer ESCREVEU — [$R]";; esac

# ── ⚠️ LIMITE HONESTO DA FASE, TRAVADO EM TESTE (achado do Codex, confirmado em prod 2026-07-20)
# product_costs.cmc é uma CÓPIA de inventory_position.cmc (escrita pela edge omie-analytics-sync:1227;
# 2.987 linhas casam em prod) e suas 2 policies são `master OR employee` — o farmer LÊ. Como a view
# operacional projeta product_id, o contorno é um JOIN de uma linha.
# ⇒ Esta fase NÃO fecha o custo: reduz superfície. O assert abaixo FALHA DE PROPÓSITO quando a
# fase 3 fechar product_costs — é o lembrete executável de que a porta segue aberta até lá.
ESPELHO=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='product_costs' AND qual ILIKE '%has_role%';")
if [ "$ESPELHO" != "0" ]; then
  ok "L1 LIMITE CONHECIDO: product_costs ainda abre custo ao employee ($ESPELHO policies has_role) — fase 3"
else
  bad "L1 product_costs mudou — REESCREVA este assert e a seção 'limite honesto' do PR (a fase 3 chegou?)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (sabota → exige VERMELHO → restaura) ──"

# F1 — A DECISIVA. Recria SÓ a outra policy (`Staff can manage inventory`) na versão furada, como
# se a migration tivesse fechado apenas a _select. Se N1 seguir verde, o assert não tem dente e o
# fechamento fantasma passaria despercebido.
P -q <<'SQL'
DROP POLICY IF EXISTS "Staff can manage inventory" ON public.inventory_position;
CREATE POLICY "Staff can manage inventory" ON public.inventory_position FOR ALL TO public
  USING ((SELECT (public.has_role((SELECT auth.uid()),'master'::public.app_role) OR public.has_role((SELECT auth.uid()),'employee'::public.app_role))));
SQL
F1=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT count(*) FROM public.inventory_position;" | tail -1)
if [ "$F1" != "0" ]; then ok "F1 sabotagem detectada: fechar 1 das 2 policies NÃO fecha (farmer voltou a ler $F1 linhas)"
else bad "F1 SEM DENTE: sabotei a outra policy e N1 seguiu 0 — o assert não prova o OR das permissivas"; fi
# restaura
P -q <<'SQL'
DROP POLICY IF EXISTS "Staff can manage inventory" ON public.inventory_position;
CREATE POLICY "Staff can manage inventory" ON public.inventory_position FOR ALL TO public
  USING      ((SELECT private.cap_custo_ler((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_custo_ler((SELECT auth.uid()))));
SQL
F1R=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT count(*) FROM public.inventory_position;" | tail -1)
eq "F1r restaurado (farmer volta a 0)" "$F1R" "0"

# F2 — a view com a coluna de custo: o assert N2 tem de virar vermelho.
P -q <<'SQL'
DROP VIEW IF EXISTS public.inventory_position_operacional;
CREATE VIEW public.inventory_position_operacional WITH (security_invoker = off, security_barrier = true) AS
SELECT ip.id, ip.omie_codigo_produto, ip.product_id, ip.saldo, ip.cmc, ip.account, ip.synced_at
FROM public.inventory_position ip
WHERE COALESCE((SELECT public.has_role((SELECT auth.uid()),'employee'::public.app_role)), false)
   OR COALESCE((SELECT public.has_role((SELECT auth.uid()),'master'::public.app_role)), false);
GRANT SELECT ON public.inventory_position_operacional TO authenticated;
SQL
F2=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT cmc FROM public.inventory_position_operacional WHERE omie_codigo_produto=1001;" 2>/dev/null | tail -1)
if [ "$F2" = "12.40" ]; then ok "F2 sabotagem detectada: view com cmc VAZA o custo ao farmer (=$F2)"
else bad "F2 SEM DENTE: recriei a view COM cmc e o farmer não leu o valor — [$F2]"; fi

# F3 — a view sem o REVOKE de anon: N4 tem de virar vermelho.
# (a view sabotada de F2 já foi criada sem REVOKE; o default privilege da ZONA 1 a deixou aberta)
# ⚠️ A 1ª versão deste assert tinha `ok` nos DOIS ramos do if — nunca podia falhar (achado do Codex,
# rodada xhigh). Erro/timeout/resposta inesperada pintavam verde. Agora ancora no CATÁLOGO
# (has_table_privilege), que é booleano e não confunde "negado" com "deu ruim".
F3=$(Pq -c "SELECT has_table_privilege('anon','public.inventory_position_operacional','SELECT');" | tail -1)
eq "F3 sabotagem detectada: sem REVOKE o anon TEM privilégio de SELECT" "$F3" "t"

# restaura a view verdadeira reaplicando a migration (idempotente — prova a idempotência de brinde)
P -q -f "$MIG"
F2R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  EXECUTE 'SELECT cmc FROM public.inventory_position_operacional LIMIT 1';
  RAISE NOTICE 'ZZ_FALHOU_RESTAURO';
EXCEPTION
  WHEN undefined_column THEN RAISE NOTICE 'ZZ_SENTINELA_RESTAURO_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$F2R" in *ZZ_SENTINELA_RESTAURO_OK*) ok "F2r view restaurada sem cmc (migration idempotente)";; *) bad "F2r restauro falhou — [$F2R]";; esac

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

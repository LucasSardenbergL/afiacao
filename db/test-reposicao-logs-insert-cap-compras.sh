#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — M-09: INSERT dos logs do motor de reposição exige cap de escrita  ║
# ║   bash db/test-reposicao-logs-insert-cap-compras.sh > "$SCRATCH/t.log" 2>&1; echo $? ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20261011120100 sobre as policies de PROD (medidas via     ║
# ║  psql-ro 2026-10-11: INSERT TO authenticated WITH CHECK (true)) e prova, sob       ║
# ║  SET ROLE authenticated + GUC, que customer/employee levam 42501 e master/         ║
# ║  service_role continuam inserindo.                                                 ║
# ║                                                                                    ║
# ║  CONTROLE: antes da migration o MESMO insert de customer PASSA (o furo existe no   ║
# ║  banco de teste — sem isso o 42501 pós-migration poderia vir de grant/stub).       ║
# ║  FALSIFICAÇÃO: (F1) policy reaberta → customer passa; (F2) migration sabotada num  ║
# ║  espelho em tmpdir (WITH CHECK (true)) → a pós-condição aborta com M09_POS_FALHOU. ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5531}"
SLUG="reposicao-logs-insert"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261011120100_reposicao_logs_insert_cap_compras.sql"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

MASTER="10000000-0000-0000-0000-000000000001"
EMPLOYEE="20000000-0000-0000-0000-000000000002"
CUSTOMER="30000000-0000-0000-0000-000000000003"

# ═══ ZONA 1 — pré-requisitos espelhando PROD (psql-ro 2026-10-11) ═══
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth    TO authenticated, anon, service_role;
CREATE TYPE public.app_role AS ENUM ('customer','employee','master','admin');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
-- verbatim de prod (pg_get_functiondef)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$f$;
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$f$;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('10000000-0000-0000-0000-000000000001','master'),
  ('20000000-0000-0000-0000-000000000002','employee'),
  ('30000000-0000-0000-0000-000000000003','customer');

CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, empresa text NOT NULL,
  data_ciclo date NOT NULL, pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now(), capados_n integer NOT NULL DEFAULT 0);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL, sku_codigo_omie text NOT NULL, sku_descricao text, grupo_codigo text, motivo text NOT NULL,
  estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
ALTER TABLE public.reposicao_motor_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_estoque_nao_confirmado_log ENABLE ROW LEVEL SECURITY;
-- ACL de prod: anon/authenticated/service_role = arwdDxtm
GRANT ALL ON public.reposicao_motor_run, public.reposicao_estoque_nao_confirmado_log TO anon, authenticated, service_role;
-- policies de PROD (o estado que a migration corrige)
CREATE POLICY reposicao_motor_run_sel ON public.reposicao_motor_run FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
CREATE POLICY reposicao_motor_run_ins ON public.reposicao_motor_run FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY estoque_nao_confirmado_log_sel ON public.reposicao_estoque_nao_confirmado_log FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
CREATE POLICY estoque_nao_confirmado_log_ins ON public.reposicao_estoque_nao_confirmado_log FOR INSERT TO authenticated WITH CHECK (true);
SQL
echo "═══ setup pronto (PG17 :$PORT) ═══"

# tenta(role, uid, tabela) → imprime INSERIU | BARRADO_42501 | o erro cru
tenta() {
  local role="$1" uid="$2" tab="$3" ins
  if [ "$tab" = "run" ]; then
    ins="INSERT INTO public.reposicao_motor_run(run_id, empresa, data_ciclo) VALUES (gen_random_uuid(), 'OBEN', current_date)"
  else
    ins="INSERT INTO public.reposicao_estoque_nao_confirmado_log(empresa, sku_codigo_omie, motivo) VALUES ('OBEN', '123', 'forjado')"
  fi
  P -tA 2>&1 <<SQL || true
BEGIN;
SET LOCAL ROLE $role;
SELECT set_config('test.uid', '$uid', true) \\g /dev/null
DO \$\$ BEGIN
  $ins;
  RAISE NOTICE 'INSERIU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BARRADO_42501';
END \$\$;
ROLLBACK;
SQL
}
espera() { # rotulo, saida, marcador
  case "$2" in *"$3"*) ok "$1 → $3" ;; *) bad "$1 — esperado $3, veio: $(echo "$2" | tr '\n' ' ' | cut -c1-200)" ;; esac
}

# ═══ ZONA 2 — CONTROLE: o furo existe antes da migration ═══
echo "── controle (antes da migration) ──"
espera "C1 customer insere em motor_run (furo de prod reproduzido)" "$(tenta authenticated "$CUSTOMER" run)" INSERIU
espera "C2 customer insere em estoque_nao_confirmado_log"          "$(tenta authenticated "$CUSTOMER" log)" INSERIU

# ═══ ZONA 3 — migration REAL (2x: idempotência) ═══
P -q -f "$MIG" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A0 migration re-aplicada sem erro (idempotente, pós-condição verde 2x)"; else bad "A0 2ª aplicação falhou"; fi

echo "── asserts ──"
espera "A1 customer → motor_run"  "$(tenta authenticated "$CUSTOMER" run)" BARRADO_42501
espera "A2 customer → log"        "$(tenta authenticated "$CUSTOMER" log)" BARRADO_42501
espera "A3 employee → motor_run"  "$(tenta authenticated "$EMPLOYEE" run)" BARRADO_42501
espera "A4 employee → log"        "$(tenta authenticated "$EMPLOYEE" log)" BARRADO_42501
espera "A5 authenticated sem uid → motor_run" "$(tenta authenticated "" run)" BARRADO_42501
espera "A6 anon → log"            "$(tenta anon "" log)" BARRADO_42501
espera "A7 master → motor_run (recálculo pelo app segue)" "$(tenta authenticated "$MASTER" run)" INSERIU
espera "A8 master → log"          "$(tenta authenticated "$MASTER" log)" INSERIU
espera "A9 service_role → motor_run (edge gerar-pedidos-diario)" "$(tenta service_role "" run)" INSERIU
espera "A10 service_role → log"   "$(tenta service_role "" log)" INSERIU

# ═══ ZONA 4 — FALSIFICAÇÃO ═══
echo "── falsificação ──"
# F1: reabre a policy → o MESMO assert A1 tem de virar INSERIU
P -q -c "DROP POLICY reposicao_motor_run_ins ON public.reposicao_motor_run; CREATE POLICY reposicao_motor_run_ins ON public.reposicao_motor_run FOR INSERT TO authenticated WITH CHECK (true);"
espera "F1 policy reaberta → customer volta a inserir (A1 tinha dente)" "$(tenta authenticated "$CUSTOMER" run)" INSERIU
# F2: migration sabotada num ESPELHO (nunca em supabase/migrations/) → pós-condição tem de abortar
sed 's/WITH CHECK ((SELECT private.cap_compras_escrever((SELECT auth.uid()))));/WITH CHECK (true);/' "$MIG" > "$TMPD/sabotada.sql"
if cmp -s "$MIG" "$TMPD/sabotada.sql"; then
  bad "F2 sed não sabotou nada (padrão não casou) — falsificação não rodou"
else
  R=$(P -q -f "$TMPD/sabotada.sql" 2>&1 || true)
  espera "F2 migration sabotada aborta na pós-condição" "$R" M09_POS_FALHOU
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

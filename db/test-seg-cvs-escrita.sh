#!/usr/bin/env bash
# Teste PG17 da migration 20261113214823_seg_cvs_fecha_escrita_cliente.sql.
# Auto-contido: stubs auth.uid()/private.cap_* por GUC, customer_visit_scores com as policies e
# GRANTs ABERTOS de prod. CONTROLE: antes da migration o customer INSERE (o buraco existe neste
# harness); depois, INSERT/UPDATE/DELETE como authenticated/anon dão 42501 e a leitura segue.
# Aplica a migration 2× (idempotência).
# Falsificação: MIGRATION=<cópia sabotada> bash db/test-seg-cvs-escrita.sh → tem de dar vermelho.
# Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="${MIGRATION:-$REPO_ROOT/supabase/migrations/20261113214823_seg_cvs_fecha_escrita_cliente.sql}"
export PGVER=17
PORT="${PGPORT_TEST:-${PORT:-5448}}"
DATA="$(mktemp -d /tmp/pgtest-segcvs.XXXXXX)/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres segcvs
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d segcvs -v ON_ERROR_STOP=1 "$@"; }

echo "→ fundação (stubs + tabela com policies e GRANTs abertos de prod)…"
P -q <<'SQL'
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE FUNCTION private.cap_carteira_escrever(_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $f$ SELECT current_setting('test.role', true) = 'master' $f$;
CREATE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $f$ SELECT current_setting('test.role', true) IN ('master','employee') $f$;
CREATE FUNCTION private.carteira_ve_tudo() RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE FUNCTION private.carteira_clientes_visiveis() RETURNS SETOF uuid LANGUAGE sql STABLE AS
  $f$ SELECT NULL::uuid WHERE false $f$;
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth, private, public TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, private TO authenticated, anon, service_role;

CREATE TABLE public.customer_visit_scores (
  customer_user_id uuid PRIMARY KEY, farmer_id uuid, visit_score numeric);
ALTER TABLE public.customer_visit_scores ENABLE ROW LEVEL SECURITY;
INSERT INTO public.customer_visit_scores VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 10);
GRANT ALL ON public.customer_visit_scores TO anon, authenticated, service_role;
CREATE POLICY cvs_select_carteira ON public.customer_visit_scores FOR SELECT
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR (SELECT private.carteira_ve_tudo())
         OR customer_user_id IN (SELECT private.carteira_clientes_visiveis()));
CREATE POLICY cvs_insert_own_or_gestor ON public.customer_visit_scores FOR INSERT
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));
CREATE POLICY cvs_update_own_or_gestor ON public.customer_visit_scores FOR UPDATE
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));
CREATE POLICY cvs_delete_own_or_gestor ON public.customer_visit_scores FOR DELETE
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));
SQL

U_CUST=00000000-0000-0000-0000-0000000000a1   # customer não aprovado
U_EMP=00000000-0000-0000-0000-0000000000e1    # employee dono da linha c1
FALHAS=0
PASSOU=0
espera() {  # espera <descricao> <esperado> <obtido>
  if [ "$2" = "$3" ]; then echo "  OK  $1 = $3"; PASSOU=$((PASSOU+1)); else echo "  FALHOU $1: esperado $2, obtido $3"; FALHAS=$((FALHAS+1)); fi
}
# tenta(role, test.role, uid, sql) → "ok" | SQLSTATE do erro (só 42501 é a recusa esperada)
tenta() {
  P -tA -q <<SQL | tail -1
SET ROLE $1;
SELECT set_config('test.role','$2',false), set_config('test.uid','$3',false);
DO \$t\$ BEGIN
  $4;
  PERFORM set_config('test.res','ok',false);
EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('test.res','42501',false);
END \$t\$;
SELECT current_setting('test.res');
SQL
}
INS_C="INSERT INTO public.customer_visit_scores VALUES ('00000000-0000-0000-0000-0000000000c2', '$U_CUST', 999)"

echo "→ CONTROLE (antes da migration o buraco existe)…"
espera "customer não aprovado INSERE score forjado (antes)" ok "$(tenta authenticated customer "$U_CUST" "$INS_C")"
P -q -c "DELETE FROM public.customer_visit_scores WHERE customer_user_id = '00000000-0000-0000-0000-0000000000c2'"

echo "→ aplica a migration (1ª vez)…"
P -q -f "$MIGRATION" | grep -q 'OK seg_cvs_fecha_escrita_cliente' \
  || { echo "FALHOU: 1º apply sem o marcador de fim"; exit 1; }
echo "→ aplica a migration (2ª vez — idempotência)…"
P -q -f "$MIGRATION" | grep -q 'OK seg_cvs_fecha_escrita_cliente' \
  || { echo "FALHOU: 2º apply sem o marcador de fim"; exit 1; }

echo "→ escrita fechada…"
espera "customer NÃO insere"          42501 "$(tenta authenticated customer "$U_CUST" "$INS_C")"
espera "employee dono NÃO atualiza"   42501 "$(tenta authenticated employee "$U_EMP" "UPDATE public.customer_visit_scores SET visit_score = 0")"
espera "employee dono NÃO apaga"      42501 "$(tenta authenticated employee "$U_EMP" "DELETE FROM public.customer_visit_scores")"
espera "master NÃO insere pelo client" 42501 "$(tenta authenticated master "$U_EMP" "$INS_C")"
espera "anon NÃO insere"              42501 "$(tenta anon '' '' "$INS_C")"
echo "→ leitura e escritor legítimo…"
espera "employee segue LENDO o score" 1 "$(P -tA -q -c "SET ROLE authenticated; SELECT set_config('test.role','employee',false), set_config('test.uid','$U_EMP',false);" -c "SET ROLE authenticated; SELECT count(*) FROM public.customer_visit_scores" | tail -1)"
espera "service_role segue gravando"  ok "$(tenta service_role '' '' "INSERT INTO public.customer_visit_scores VALUES ('00000000-0000-0000-0000-0000000000c3', '$U_EMP', 5) ON CONFLICT (customer_user_id) DO UPDATE SET visit_score = excluded.visit_score")"

echo "RESULTADO: $PASSOU ok / $FALHAS fail"
if [ "$FALHAS" -ne 0 ]; then echo "✗ db/test-seg-cvs-escrita.sh — $FALHAS falha(s)"; exit 1; fi
echo "✓ db/test-seg-cvs-escrita.sh — PASSOU"

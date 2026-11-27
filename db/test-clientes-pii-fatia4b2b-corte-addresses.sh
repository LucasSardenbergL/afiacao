#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════════
# ║  Prova PG17 da onda D / fatia 4b-2b — corte de `addresses` por coluna
# ║    bash db/test-clientes-pii-fatia4b2b-corte-addresses.sh > log 2>&1; echo $?
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-pii-fatia4b2b-corte-addresses.sh
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Base: stubs do Supabase + `addresses` com as colunas e as 5 policies de PROD (psql-ro, 2026-11-27),
# ║  partindo do PIOR caso de grants (o default Supabase: tudo para anon/authenticated/service_role).
# ║  `v_endereco_contato` (invoker=off, barrier) e uma view invoker=on com as colunas que v_caca_* usam.
# ║  As escritas seguem a forma do PostgREST com return=minimal (json_populate_recordset + RETURNING 1).
# ║  Negativos casam a SQLSTATE pelo NOME e re-lançam o resto. FALSIFICAÇÃO na MESMA invocação: suíte
# ║  verde antes, uma sabotagem POR CAMADA com o seu vermelho EXATO, suíte verde de novo depois.
# ╚══════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5497}"
SLUG="piifatia4b2b"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261127010000_clientes_pii_fatia4b2b_corte_addresses.sql"

DONO=00000000-0000-0000-0000-0000000000c1
OUTRO=00000000-0000-0000-0000-0000000000c2
STAFF=00000000-0000-0000-0000-0000000000a1
A1=10000000-0000-0000-0000-000000000001; A2=10000000-0000-0000-0000-000000000002
B1=20000000-0000-0000-0000-000000000001

# ── ZONA 1: o que o corte toca, espelhando a PROD ──
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE TABLE public.addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, label text NOT NULL DEFAULT 'Principal',
  street text NOT NULL, number text NOT NULL, complement text, neighborhood text NOT NULL, city text NOT NULL,
  state text NOT NULL, zip_code text NOT NULL, is_default boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), is_from_omie boolean DEFAULT false);
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Employees can view all addresses" ON public.addresses FOR SELECT
  USING (( SELECT public.has_role(auth.uid(), 'master'::public.app_role)) OR ( SELECT public.has_role(auth.uid(), 'employee'::public.app_role)));
CREATE POLICY "Users can create their own addresses" ON public.addresses FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own addresses" ON public.addresses FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Users can update their own addresses" ON public.addresses FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own addresses" ON public.addresses FOR SELECT USING (auth.uid() = user_id);
-- O gate de leitura da rua: invoker=off (lê como dona); o dono vê tudo, os outros veem a rua mascarada.
-- (A regra de carteira em si foi provada na 4b-1; aqui só importa que a view atravessa o corte.)
CREATE VIEW public.v_endereco_contato WITH (security_invoker = off, security_barrier = true) AS
  SELECT a.id, a.user_id,
         CASE WHEN a.user_id = auth.uid() THEN a.street END AS street,
         CASE WHEN a.user_id = auth.uid() THEN a.zip_code END AS zip_code,
         a.city, a.state, a.is_default
    FROM public.addresses a;
GRANT SELECT ON public.v_endereco_contato TO authenticated;
-- Espelho das colunas de addresses que v_caca_candidatos/v_caca_compradores (invoker=on) usam em prod.
CREATE VIEW public.v_caca_espelho WITH (security_invoker = on) AS
  SELECT a.user_id, a.city, a.state, a.is_default, a.created_at FROM public.addresses a;
GRANT SELECT ON public.v_caca_espelho TO authenticated;
SQL

grants_base() { # o PIOR caso: o default Supabase antes de qualquer corte
  P -q -c "REVOKE ALL ON public.addresses FROM anon, authenticated, service_role, PUBLIC;
           GRANT ALL ON public.addresses TO anon, authenticated, service_role;
           GRANT SELECT ON public.addresses TO PUBLIC;"
}
semear() {
  P -q -c "DELETE FROM public.addresses; DELETE FROM public.user_roles;
           INSERT INTO public.user_roles (user_id, role) VALUES ('$STAFF', 'employee');
           INSERT INTO public.addresses (id, user_id, street, number, neighborhood, city, state, zip_code, is_default)
           VALUES ('$A1', '$DONO', 'Rua A', '10', 'Centro', 'JOINVILLE', 'SC', '89200000', true),
                  ('$A2', '$DONO', 'Rua B', '20', 'Centro', 'JOINVILLE', 'SC', '89200001', false),
                  ('$B1', '$OUTRO', 'Rua Z', '99', 'Bairro', 'BLUMENAU', 'SC', '89000000', true);"
}

# como <role> <uid|""> <sql> — devolve a saída (erro vira texto)
como() {
  local claims=''
  [ -n "$2" ] && claims="{\"sub\":\"$2\",\"role\":\"$1\"}"
  P -tA -q -c "SELECT pg_catalog.set_config('request.jwt.claims', '$claims', false); SET ROLE $1; $3" 2>&1 | tail -n +2 || true
}
# nega <role> <uid|""> <sqlstate-nome> <sql> — MARCA_BARRADO só na condição esperada; outro erro
# RE-LANÇADO (vira "outro"); sucesso = MARCA_VAZOU.
nega() {
  local claims=''
  [ -n "$2" ] && claims="{\"sub\":\"$2\",\"role\":\"$1\"}"
  P -tA -q 2>&1 <<SQL || true
SELECT pg_catalog.set_config('request.jwt.claims', '$claims', false);
SET ROLE $1;
DO \$neg\$
BEGIN
  BEGIN
    EXECUTE \$q\$ $4 \$q\$;
    RAISE NOTICE 'MARCA_VAZOU_7Q';
  EXCEPTION
    WHEN $3 THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
    WHEN OTHERS THEN RAISE;
  END;
END
\$neg\$;
SQL
}
veredito() { case "$1" in *MARCA_BARRADO_7Q*) echo barrado ;; *MARCA_VAZOU_7Q*) echo vazou ;; *) echo "outro" ;; esac; }
# classe <saída> — erro de privilégio em addresses vira "negado-coluna" (ASCII, caixa fixa); o resto passa cru.
classe() { case "$1" in *"permission denied for table addresses"*) echo negado-coluna ;; *) echo "$1" ;; esac; }

# Formas do PostgREST (return=minimal) para os escritores do front (Addresses.tsx, Auth.tsx).
INS="WITH pgrst_source AS (INSERT INTO public.addresses (user_id, label, street, number, complement, neighborhood, city, state, zip_code, is_default, is_from_omie) SELECT pgrst_body.user_id, pgrst_body.label, pgrst_body.street, pgrst_body.number, pgrst_body.complement, pgrst_body.neighborhood, pgrst_body.city, pgrst_body.state, pgrst_body.zip_code, pgrst_body.is_default, pgrst_body.is_from_omie FROM json_populate_recordset(null::public.addresses, '[{\"user_id\":\"$DONO\",\"label\":\"Obra\",\"street\":\"Rua N\",\"number\":\"1\",\"neighborhood\":\"X\",\"city\":\"JOINVILLE\",\"state\":\"SC\",\"zip_code\":\"89200002\",\"is_default\":false,\"is_from_omie\":false}]'::json) pgrst_body RETURNING 1) SELECT count(*) FROM pgrst_source"
UPD_DONO="WITH pgrst_source AS (UPDATE public.addresses SET is_default = false WHERE public.addresses.user_id = '$DONO' RETURNING 1) SELECT count(*) FROM pgrst_source"
UPD_ID="WITH pgrst_source AS (UPDATE public.addresses SET is_default = true WHERE public.addresses.id = '$A2' RETURNING 1) SELECT count(*) FROM pgrst_source"
DEL_ID="WITH pgrst_source AS (DELETE FROM public.addresses WHERE public.addresses.id = '$A2' RETURNING 1) SELECT count(*) FROM pgrst_source"

rodar() {
  semear
  R_rua_crua="$(veredito "$(nega authenticated "$STAFF" insufficient_privilege "SELECT street FROM public.addresses")")"
  R_cep_cru="$(veredito "$(nega authenticated "$DONO" insufficient_privilege "SELECT zip_code FROM public.addresses")")"
  R_estrela="$(veredito "$(nega authenticated "$DONO" insufficient_privilege "SELECT * FROM public.addresses")")"
  R_identidade="$(como authenticated "$STAFF" "SELECT count(*) FROM (SELECT id, user_id, city, state, is_default, is_from_omie, created_at FROM public.addresses) s;" | tr -d '\n')"
  R_head_count="$(como authenticated "$DONO" "SELECT count(id) FROM public.addresses WHERE user_id = '$DONO';" | tr -d '\n')"
  R_view_dono="$(como authenticated "$DONO" "SELECT string_agg(street, ',' ORDER BY street) FROM public.v_endereco_contato WHERE user_id = '$DONO';" | tr -d '\n')"
  R_view_outro="$(como authenticated "$STAFF" "SELECT coalesce(street, '(mascarado)') FROM public.v_endereco_contato WHERE id = '$B1';" | tr -d '\n')"
  R_invoker="$(como authenticated "$STAFF" "SELECT count(*) FROM public.v_caca_espelho;" | tr -d '\n')"
  R_ins="$(como authenticated "$DONO" "$INS" | tr -d '\n')"
  R_upd_dono="$(como authenticated "$DONO" "$UPD_DONO" | tr -d '\n')"
  R_upd_id="$(como authenticated "$DONO" "$UPD_ID" | tr -d '\n')"
  R_del_id="$(como authenticated "$DONO" "$DEL_ID" | tr -d '\n')"
  R_anon="$(veredito "$(nega anon "" insufficient_privilege "SELECT id FROM public.addresses")")"
  R_service="$(como service_role "" "SELECT count(street) FROM public.addresses;" | tr -d '\n')"
}
suite() {
  rodar
  eq "staff não lê a rua crua → 42501" "${R_rua_crua}" "barrado"
  eq "nem o dono lê o CEP cru (vai pela view) → 42501" "${R_cep_cru}" "barrado"
  eq "select('*') cru → 42501 (o front antigo quebraria: por isso só depois do Publish)" "${R_estrela}" "barrado"
  eq "as 7 colunas de identidade/território seguem legíveis" "${R_identidade}" "3"
  eq "head count por id do useProfile/useCustomerDashboard" "${R_head_count}" "2"
  eq "v_endereco_contato atravessa o corte: o dono vê a rua" "${R_view_dono}" "Rua A,Rua B"
  eq "v_endereco_contato fora do dono: rua mascarada" "${R_view_outro}" "(mascarado)"
  eq "view invoker=on com as colunas de v_caca_* segue lendo" "${R_invoker}" "3"
  eq "INSERT do front (return=minimal) segue" "${R_ins}" "1"
  eq "UPDATE is_default por user_id segue" "${R_upd_dono}" "3"
  eq "UPDATE is_default por id segue" "${R_upd_id}" "1"
  eq "DELETE por id segue" "${R_del_id}" "1"
  eq "anon não lê nada → 42501" "${R_anon}" "barrado"
  eq "service_role (edges) lê a rua" "${R_service}" "3"
}

aplicar() { grants_base; P -q -f "$1" 2>&1; }

echo "-- aplica a migration (com a postcondição) --"
if aplicar "$MIG" | grep -c "fatia 4b-2b ok" | grep -qx 1; then ok "postcondição da migration passou"; else bad "postcondição não passou"; fi
if aplicar "$MIG" | grep -c "fatia 4b-2b ok" | grep -qx 1; then ok "reaplicar é idempotente"; else bad "reaplicar falhou"; fi

echo "-- SUÍTE (verde) --"
suite

echo "-- a postcondição C6 recusa uma view invoker=on que leia a rua --"
P -q -c "CREATE VIEW public.v_lê_rua WITH (security_invoker = on) AS SELECT a.street FROM public.addresses a;"
R_c6="$(aplicar "$MIG" | grep -o 'C6 FALHOU' | head -1 || true)"
eq "C6 pega view invoker=on lendo coluna cortada" "${R_c6}" "C6 FALHOU"
P -q -c "DROP VIEW public.v_lê_rua;"

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; a suíte verde acima já rodou) ═════════
echo "-- FALSIFICAÇÃO: uma sabotagem por camada, cada uma com o SEU vermelho --"
exige_vermelho() { # <rótulo> <obtido> <correto> <vermelho-esperado>
  if [ "$2" = "$3" ]; then bad "$1 — sabotado ficou VERDE (assert não pega a camada) [$2]"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — vermelho ALHEIO ao mutante: esperado [$4], veio [$2]"; fi
}
# sabota <perl expr> — aplica a migration sabotada sem a postcondição, a partir dos grants-base
sabota() {
  perl -0pe "$1" "$MIG" > "$RODADA/sabotada.sql"
  if cmp -s "$MIG" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a migration ($1)"; fi
  perl -0pi -e 's/DO \$post\$.*?\$post\$;//s' "$RODADA/sabotada.sql"
  aplicar "$RODADA/sabotada.sql" >/dev/null
  rodar
}

sabota 's/REVOKE SELECT ON public\.addresses FROM authenticated;\n//'
exige_vermelho "S1 sem revogar o SELECT de tabela" "${R_rua_crua}" "barrado" "vazou"

sabota 's/GRANT SELECT \(id, user_id, /GRANT SELECT (id, /'
exige_vermelho "S2 sem user_id no GRANT (UPDATE por dono)" "$(classe "${R_upd_dono}")" "3" "negado-coluna"

sabota 's/REVOKE SELECT ON public\.addresses FROM PUBLIC, anon;\n//'
exige_vermelho "S3 sem revogar PUBLIC/anon" "${R_anon}" "barrado" "vazou"

sabota 's/GRANT SELECT \(id, user_id, city, state, /GRANT SELECT (id, user_id, /'
exige_vermelho "S4 sem city/state (view invoker=on de v_caca_*)" "$(classe "${R_invoker}")" "3" "negado-coluna"

# S5: a postcondição sem o C6 não pega a view invoker=on lendo a rua
perl -0pe 's/  IF v_ruim IS NOT NULL THEN\n.*?END IF;\n//s' "$MIG" > "$RODADA/sem-c6.sql"
if cmp -s "$MIG" "$RODADA/sem-c6.sql"; then bad "sabotagem S5 não alterou a migration"; fi
P -q -c "CREATE VIEW public.v_lê_rua WITH (security_invoker = on) AS SELECT a.street FROM public.addresses a;"
R_c6s="$(aplicar "$RODADA/sem-c6.sql" | grep -o 'C6 FALHOU' | head -1 || true)"
exige_vermelho "S5 postcondição sem C6" "${R_c6s:-(passou calada)}" "C6 FALHOU" "(passou calada)"
P -q -c "DROP VIEW public.v_lê_rua;"

echo "-- CONTROLE: a migration real de novo, suíte verde --"
aplicar "$MIG" >/dev/null
suite

echo "== $PASS OK · $FAIL XX (locale $LOCALE_TESTE) =="
[ "$FAIL" -eq 0 ] && echo "PROVA-4B2B-VERDE"

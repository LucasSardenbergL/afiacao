#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Trava de crédito: piso (vencido > 60 d) sobre o GRUPO inteiro    ║
# ║  Migration: 20261121120000_trava_credito_piso_grupo.sql                        ║
# ║  Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9.3             ║
# ║  Rode: bash db/test-trava-credito-piso-grupo.sh > /tmp/t.log 2>&1; echo $?     ║
# ║  Locale: LC_ALL_TESTE=pt_BR.UTF-8 bash db/test-trava-credito-piso-grupo.sh     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="trava-credito-grupo"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"

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
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
-- Supabase real: authenticated/anon têm USAGE no schema auth (toda policy/trigger chama auth.uid())
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração lê/referencia mas não cria)
# Helpers de role: definições REAIS de prod (pg_get_functiondef via psql-ro, 2026-07-02).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='commercial_role') THEN
    CREATE TYPE public.commercial_role AS ENUM
      ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE IF NOT EXISTS public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);

-- fiel a prod (verbatim)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1 $function$;

CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR (
      has_role(_uid, 'employee'::app_role)
      AND get_commercial_role(_uid) IN (
        'gerencial'::commercial_role,
        'estrategico'::commercial_role,
        'super_admin'::commercial_role
      )
    );
$function$;

-- tabelas que a migration referencia (stub das colunas usadas)
CREATE TABLE IF NOT EXISTS public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE IF NOT EXISTS public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_codigo_cliente bigint,
  saldo numeric,
  status_titulo text,
  data_vencimento date
);

CREATE TABLE IF NOT EXISTS public.customer_canonical_alias (
  alias_user_id uuid PRIMARY KEY,
  canonical_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','conflict'))
);
CREATE TABLE IF NOT EXISTS public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account text NOT NULL,
  omie_codigo_cliente bigint
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (a v1 do gate cria venda_excecao_credito; a nova é a sob prova)
# ══════════════════════════════════════════════════════════════════════════════
MIG1="$REPO_ROOT/supabase/migrations/20260702233000_trava_credito_fase2.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260703140000_trava_credito_gate_excecao_por_par.sql"
MIG="$REPO_ROOT/supabase/migrations/20261121120000_trava_credito_piso_grupo.sql"
P -q -f "$MIG1"
P -q -f "$MIG2"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG1") + $(basename "$MIG2") + $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# canônico C (c…01) → oben 101 · alias A1 (a1…) ACTIVE → colacor_sc 202
# alias A2 (a2…) CONFLICT → colacor 303 · alias A3 (a3…) INACTIVE → colacor 404
# cliente X (99…) sem vínculo → oben 999 (vencido: não pode vazar para o grupo)
# gestor 1111 (employee+gerencial) para inserir exceção sob RLS
# ══════════════════════════════════════════════════════════════════════════════
C=c0000000-0000-0000-0000-000000000001
A1=a1000000-0000-0000-0000-000000000001
A2=a2000000-0000-0000-0000-000000000001
A3=a3000000-0000-0000-0000-000000000001
X=99000000-0000-0000-0000-000000000001
S1=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
S2=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES ('11111111-1111-1111-1111-111111111111','gerencial');
INSERT INTO public.sales_orders(id) VALUES ('$S1'), ('$S2');
INSERT INTO public.customer_canonical_alias(alias_user_id, canonical_user_id, status) VALUES
  ('$A1', '$C', 'active'), ('$A2', '$C', 'conflict'), ('$A3', '$C', 'inactive');
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES
  ('$C', 'oben', 101), ('$A1', 'colacor_sc', 202), ('$A2', 'colacor', 303),
  ('$A3', 'colacor', 404), ('$X', 'oben', 999), ('$C', 'colacor', NULL);
GRANT SELECT, INSERT ON public.venda_excecao_credito TO authenticated;
GRANT SELECT ON public.user_roles, public.commercial_roles TO authenticated, anon;
SQL

# títulos: reseta e semeia "company:codigo:dias_vencido:saldo" ...
titulos() {
  local sql="DELETE FROM public.fin_contas_receber;"
  for t in "$@"; do
    IFS=: read -r co cod dias saldo <<<"$t"
    sql+="INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente, saldo, status_titulo, data_vencimento) VALUES ('$co', $cod, $saldo, 'ATRASADO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - $dias));"
  done
  P -q -c "$sql"
}
excecao_s1_oben() { # gestor aprova exceção do pedido S1 para o par (oben, 101), sob RLS
  P -q <<SQL
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
INSERT INTO public.venda_excecao_credito (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
VALUES ('$S1', 'oben', 101, 'cliente quita sexta', now() + interval '3 days', '11111111-1111-1111-1111-111111111111');
RESET ROLE;
SQL
}
gate() { Pq -c "SELECT public.venda_gate_credito_grupo('$1', $2, $3, $4);"; }
J() { python3 -c "import sys,json; d=json.load(sys.stdin); v=d$1; print(v)"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (função: a falsificação re-roda o MESMO conjunto)
# ══════════════════════════════════════════════════════════════════════════════
asserts() {
  P -q -c "DELETE FROM public.venda_excecao_credito;"
  titulos
  eq "A1 sem vencido em nenhum par → passa" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['motivo']")" "sem_vencido_60d"

  titulos "oben:101:75:300"
  local g; g=$(gate "$S1" "'oben'" 101 "'$C'")
  eq "A2 vencido no par do pedido → bloqueia" "$(echo "$g" | J "['bloqueado']")" "True"
  eq "A2b pares lista 1 empresa" "$(echo "$g" | J "['pares'].__len__()")" "1"

  titulos "colacor_sc:202:75:500"
  g=$(gate "$S1" "'oben'" 101 "'$C'")
  eq "A3 vencido SÓ na colacor_sc (alias active), pedido na oben → bloqueia [o furo]" "$(echo "$g" | J "['bloqueado']")" "True"
  eq "A3b par culpado = colacor_sc" "$(echo "$g" | J "['pares'][0]['company']")" "colacor_sc"
  eq "A3c vencido somado = 500" "$(echo "$g" | J "['vencido']")" "500"
  eq "A3d grupo_resolvido" "$(echo "$g" | J "['grupo_resolvido']")" "True"

  eq "A4 chamado pelo ALIAS resolve o canônico → bloqueia" "$(gate "$S1" "'colacor_sc'" 202 "'$A1'" | J "['bloqueado']")" "True"
  titulos "oben:101:75:120"
  eq "A4b alias enxerga a dívida do canônico" "$(gate "$S1" "'colacor_sc'" 202 "'$A1'" | J "['vencido']")" "120"

  titulos "oben:101:59:300"
  eq "A5 vencido 59 d não bloqueia (corte SP)" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['bloqueado']")" "False"
  titulos "oben:101:61:300"
  eq "A5b vencido 61 d bloqueia" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['bloqueado']")" "True"

  titulos "colacor:303:75:700" "colacor:404:75:800"
  eq "A6 alias CONFLICT/INACTIVE não expandem → passa" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['bloqueado']")" "False"
  eq "A6b mas o par do próprio pedido (colacor 303) é avaliado" "$(gate "$S1" "'colacor'" 303 "'$A2'" | J "['vencido']")" "700"

  titulos "oben:999:75:900"
  eq "A6c dívida de cliente sem vínculo não vaza para o grupo" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['bloqueado']")" "False"

  titulos "oben:101:75:100" "colacor_sc:202:80:50"
  eq "A6d dívida de 2 empresas soma (150)" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['vencido']")" "150"
  eq "A6e título contado 1 vez quando par do pedido ∈ grupo" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['titulos']")" "2"

  titulos "colacor_sc:202:75:500"
  P -q -c "DELETE FROM public.venda_excecao_credito;"
  excecao_s1_oben
  eq "A7 exceção do (pedido, par) libera mesmo com dívida no grupo" "$(gate "$S1" "'oben'" 101 "'$C'" | J "['motivo']")" "excecao_valida"
  eq "A7b exceção NÃO vaza para outro pedido" "$(gate "$S2" "'oben'" 101 "'$C'" | J "['bloqueado']")" "True"
  eq "A7c exceção NÃO vaza para outro par no mesmo pedido" "$(gate "$S1" "'colacor_sc'" 202 "'$C'" | J "['bloqueado']")" "True"

  local f
  for f in "credito_grupo_pares(uuid)" "venda_gate_credito_grupo(uuid,text,bigint,uuid)"; do
    eq "A8 anon NÃO executa $f" "$(Pq -c "SELECT has_function_privilege('anon','public.$f','EXECUTE');")" "f"
    eq "A8 authenticated NÃO executa $f" "$(Pq -c "SELECT has_function_privilege('authenticated','public.$f','EXECUTE');")" "f"
    eq "A8 service_role executa $f" "$(Pq -c "SELECT has_function_privilege('service_role','public.$f','EXECUTE');")" "t"
  done

  titulos
  eq "A9 sem código, user com par mas sem título → passa" "$(gate "$S1" "'oben'" NULL "'$X'::uuid" | J "['motivo']")" "sem_vencido_60d"
  eq "A9b sem código e user nulo → sem_codigo" "$(gate "$S1" "'oben'" NULL "NULL::uuid" | J "['motivo']")" "sem_codigo"
  titulos "colacor_sc:202:75:500"
  eq "A9c sem código MAS grupo vencido → bloqueia" "$(gate "$S1" "'oben'" NULL "'$C'" | J "['bloqueado']")" "True"
}

echo "── asserts (controle) ──"
asserts
if [ "$FAIL" != "0" ]; then
  echo "RESULTADO: $PASS ok / $FAIL fail"; echo "❌ HARNESS VERMELHO (controle) — falsificação não roda"; exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (uma camada por vez; controle verde acima na MESMA invocação)
# Cada sabotagem aplica uma cópia adulterada da migration, exige o assert-alvo
# VERMELHO, e re-aplica a migration real.
# ══════════════════════════════════════════════════════════════════════════════
SAB="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
sabota() { # $1 rótulo · $2 python que transforma o texto · $3 comando do assert-alvo · $4 valor que o assert SÃO exige
  python3 - "$MIG" "$SAB/m.sql" "$2" <<'PY'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read(); n = eval(expr)
assert n != t, "sabotagem não alterou o texto"
open(dst, "w").write(n)
PY
  P -q -f "$SAB/m.sql"
  local v; v=$(eval "$3")
  if [ "$v" != "$4" ]; then ok "$1 → assert-alvo ficou vermelho (veio $v)"; else bad "$1 → sabotei e o assert continuou verde ($v): sem dente"; fi
  P -q -f "$MIG"
}

echo "── falsificação ──"
P -q -c "DELETE FROM public.venda_excecao_credito;"
titulos "colacor_sc:202:75:500"
sabota "F1 sem expansão de alias" \
  "t.replace(\"WHERE a.status = 'active'\n  )\n  SELECT\", \"WHERE false\n  )\n  SELECT\")" \
  "gate '$S1' \"'oben'\" 101 \"'$C'\" | J \"['bloqueado']\"" "True"

titulos "colacor:303:75:700"
sabota "F2 expande também CONFLICT" \
  "t.replace(\"JOIN canon c ON a.canonical_user_id = c.cid\n     WHERE a.status = 'active'\", \"JOIN canon c ON a.canonical_user_id = c.cid\n     WHERE a.status IN ('active','conflict')\")" \
  "gate '$S1' \"'oben'\" 101 \"'$C'\" | J \"['bloqueado']\"" "False"

titulos "oben:101:59:300"
sabota "F3 corte 58 d (off-by-one)" \
  "t.replace(\"::date - 60)\", \"::date - 58)\")" \
  "gate '$S1' \"'oben'\" 101 \"'$C'\" | J \"['bloqueado']\"" "False"

titulos "colacor_sc:202:75:500"
excecao_s1_oben
sabota "F4 exceção sem filtro de par" \
  "t.replace(\"AND x.company = p_company\n       AND x.omie_codigo_cliente = p_codigo\n\", \"\")" \
  "gate '$S1' \"'colacor_sc'\" 202 \"'$C'\" | J \"['bloqueado']\"" "True"
P -q -c "DELETE FROM public.venda_excecao_credito;"

titulos "oben:101:75:100" "colacor_sc:202:80:50"
sabota "F5 UNION ALL (título contado 2x)" \
  "t.replace(\"WHERE p_company IS NOT NULL AND p_codigo IS NOT NULL AND p_codigo > 0\n    UNION\n\", \"WHERE p_company IS NOT NULL AND p_codigo IS NOT NULL AND p_codigo > 0\n    UNION ALL\n\")" \
  "gate '$S1' \"'oben'\" 101 \"'$C'\" | J \"['titulos']\"" "2"

sabota "F6 REVOKE esquecido (authenticated executa)" \
  "t.replace(\"REVOKE EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid, text, bigint, uuid) FROM anon, authenticated, PUBLIC;\", \"GRANT EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid, text, bigint, uuid) TO authenticated;\")" \
  "Pq -c \"SELECT has_function_privilege('authenticated','public.venda_gate_credito_grupo(uuid,text,bigint,uuid)','EXECUTE');\"" "f"
# F6 deixou o GRANT a authenticated colado (CREATE OR REPLACE preserva ACL) → limpa explicitamente
P -q -c "REVOKE EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid,text,bigint,uuid) FROM authenticated;"
rm -rf "$SAB"

echo "── re-prova pós-restauração ──"
asserts

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
echo "FIM-OK"

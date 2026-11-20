#!/usr/bin/env bash
# PROVA PG17 — combinado_dia / combinado_registrar (migrations 20261120200000 + 20261120210000 'esfriando'): gate master, validação dos itens,
# upsert por (dia, vendedora) com n_copias, ACL fechada ao JWT. EXECUTA a RPC (PL/pgSQL é late-bound).
# bash db/test-combinado-dia.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="combinado-dia"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
MIG="${MIG_COMBINADO:-$REPO_ROOT/supabase/migrations/20261120200000_combinado_dia.sql}"
MIG2="${MIG_ESFRIANDO:-$REPO_ROOT/supabase/migrations/20261120210000_combinado_aceita_esfriando.sql}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER=00000000-0000-0000-0000-00000000000a
REGINA=00000000-0000-0000-0000-00000000000b
CLIENTE=00000000-0000-0000-0000-00000000000c

# ── pré-req: app_role, user_roles e has_role como na PROD + default privilege do Supabase ──
P -q <<SQL
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
INSERT INTO public.user_roles VALUES ('$MASTER', 'master'), ('$REGINA', 'employee'), ('$CLIENTE', 'customer');
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
SQL

P -q -f "$MIG"
P -q -f "$MIG"   # idempotente: re-colar não pode quebrar
ok "migration aplica 2x sem erro"
# 20261120210000: a PRE aceita o predecessor (recém-aplicado) e o próprio corpo (re-aplicar).
P -q -f "$MIG2"
P -q -f "$MIG2"
ok "migration esfriando aplica 2x sem erro (PRE aceita predecessor e a si mesma)"

# Chama a RPC como o usuário $1; imprime o SQLSTATE do erro, ou OK.
chamar() {
  Pq -c "DO \$\$ BEGIN
    PERFORM set_config('request.jwt.claim.sub', '$1', true);
    PERFORM public.combinado_registrar($2, \$j\$$3\$j\$::jsonb);
    RAISE NOTICE 'OK';
  EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '22023' THEN
    RAISE EXCEPTION 'ESTADO=%', SQLSTATE;
  END \$\$;" 2>&1 | grep -oE 'ESTADO=[0-9A-Z]+|NOTICE:  OK' | head -1
}
ITEM1='[{"tipo":"cobranca","empresa":"oben","cliente_ref":"123","nome":"ACME","valor":1500}]'
ITEM2='[{"tipo":"recompra","empresa":"colacor","cliente_ref":"abc","nome":"Beta","valor":null},{"tipo":"cobranca","cliente_ref":"9"}]'

echo "── gate ──"
eq "G1 não-master barrado (42501)"     "$(chamar "$REGINA" "'$MASTER'" "$ITEM1")" "ESTADO=42501"
eq "G2 sem sessão barrado (42501)"     "$(chamar "" "'$REGINA'" "$ITEM1")" "ESTADO=42501"
eq "G3 vendedora que é cliente (22023)" "$(chamar "$MASTER" "'$CLIENTE'" "$ITEM1")" "ESTADO=22023"

echo "── validação dos itens ──"
eq "V1 lista vazia (22023)"            "$(chamar "$MASTER" "'$REGINA'" '[]')" "ESTADO=22023"
eq "V2 4 itens (22023)"                "$(chamar "$MASTER" "'$REGINA'" '[{"tipo":"cobranca","cliente_ref":"1"},{"tipo":"cobranca","cliente_ref":"2"},{"tipo":"cobranca","cliente_ref":"3"},{"tipo":"cobranca","cliente_ref":"4"}]')" "ESTADO=22023"
eq "V3 tipo desconhecido (22023)"      "$(chamar "$MASTER" "'$REGINA'" '[{"tipo":"brinde","cliente_ref":"1"}]')" "ESTADO=22023"
eq "V4 sem cliente_ref (22023)"        "$(chamar "$MASTER" "'$REGINA'" '[{"tipo":"cobranca"}]')" "ESTADO=22023"
eq "V3b tipo esfriando aceito"         "$(chamar "$MASTER" "'$REGINA'" '[{"tipo":"esfriando","empresa":"oben","cliente_ref":"e1","nome":"Gama","valor":null}]')" "NOTICE:  OK"
P -q -c "DELETE FROM public.combinado_dia"
eq "V5 nenhuma linha gravada até aqui" "$(Pq -c 'SELECT count(*) FROM public.combinado_dia')" "0"

echo "── upsert por (dia, vendedora) ──"
eq "U1 master grava"                   "$(chamar "$MASTER" "'$REGINA'" "$ITEM1")" "NOTICE:  OK"
eq "U2 1 linha, n_copias=1"            "$(Pq -c 'SELECT count(*)||'"'"'/'"'"'||max(n_copias) FROM public.combinado_dia')" "1/1"
eq "U3 re-copiar no dia"               "$(chamar "$MASTER" "'$REGINA'" "$ITEM2")" "NOTICE:  OK"
eq "U4 segue 1 linha, n_copias=2"      "$(Pq -c 'SELECT count(*)||'"'"'/'"'"'||max(n_copias) FROM public.combinado_dia')" "1/2"
eq "U5 itens = os da última cópia"     "$(Pq -c 'SELECT jsonb_array_length(itens) FROM public.combinado_dia')" "2"
eq "U6 dia = hoje em SP"               "$(Pq -c "SELECT dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date FROM public.combinado_dia")" "t"

echo "── ACL ──"
F='public.combinado_registrar(uuid,jsonb)'
eq "A1 anon sem EXECUTE"               "$(Pq -c "SELECT has_function_privilege('anon', '$F', 'EXECUTE')")" "f"
eq "A2 authenticated com EXECUTE"      "$(Pq -c "SELECT has_function_privilege('authenticated', '$F', 'EXECUTE')")" "t"
eq "A3 authenticated não lê a tabela"  "$(Pq -c "SELECT has_table_privilege('authenticated', 'public.combinado_dia', 'SELECT')")" "f"

echo "── PRE anti-deriva ──"
# Corpo vivo que não é nem o predecessor nem este: a migration tem de ABORTAR na PRE (P0001), sem recriar.
P -q -c "CREATE OR REPLACE FUNCTION public.combinado_registrar(p_vendedora uuid, p_itens jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS \$\$ BEGIN RETURN '{}'::jsonb; END \$\$;"
DERIVA="$(P -q -f "$MIG2" 2>&1 || true)"
case "$DERIVA" in *"PRE FALHOU"*) ok "D1 corpo derivado aborta na PRE" ;; *) bad "D1 corpo derivado NÃO abortou: [$DERIVA]" ;; esac
eq "D2 corpo derivado ficou intocado" "$(Pq -c "SELECT prosrc LIKE '%RETURN ''{}''::jsonb%' FROM pg_proc WHERE oid = 'public.combinado_registrar(uuid,jsonb)'::regprocedure")" "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

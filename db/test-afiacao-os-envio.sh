#!/usr/bin/env bash
# Teste PG17 da reserva idempotente da OS de Afiação (migration 20261121120002).
# Sem snapshot: stubs mínimos (roles, app_role, user_roles) + a migration aplicada DUAS vezes
# (idempotência), e os asserts da semântica que a edge omie-sync v1.15 usa:
#   A1 re-aplicar não quebra · A2 PK barra a 2ª reserva (ON CONFLICT DO NOTHING mantém a 1ª
#   assinatura) · A3 vínculo da OS só UMA vez (UPDATE … WHERE omie_codigo_os IS NULL) · A4 CHECK
#   de coerência barra OS sem desfecho · A5 chave_integracao UNIQUE · A6 authenticated não escreve,
#   anon não lê · A7 staff lê, customer não (RLS).
# Pré-req: brew install postgresql@17. Saída positiva: a última linha é "TESTE_OK".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447
DATA="$(mktemp -d /tmp/pgtest-osenvio.XXXXXX)/data"
MIG="$REPO_ROOT/supabase/migrations/20261121120002_afiacao_os_envio_reserva.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P() { "$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

P <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.omie_ordens_servico (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, omie_codigo_os bigint);
GRANT ALL ON public.omie_ordens_servico TO service_role;
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'employee'),
                                     ('00000000-0000-0000-0000-00000000000c', 'customer');
SQL

P -f "$MIG" >/dev/null
P -f "$MIG" >/dev/null && echo "A1 ok: migration re-aplicada sem erro"

P <<'SQL'
SET ROLE service_role;
INSERT INTO public.afiacao_os_envio (order_id, chave_integracao, assinatura, omie_codigo_cliente)
VALUES ('11111111-1111-4111-8111-111111111111', 'OS_1111111111114111811111', 'A', 300)
ON CONFLICT (order_id) DO NOTHING;
INSERT INTO public.afiacao_os_envio (order_id, chave_integracao, assinatura, omie_codigo_cliente)
VALUES ('11111111-1111-4111-8111-111111111111', 'OS_1111111111114111811111', 'B', 300)
ON CONFLICT (order_id) DO NOTHING;
DO $$ BEGIN
  IF (SELECT assinatura FROM public.afiacao_os_envio) <> 'A' OR (SELECT count(*) FROM public.afiacao_os_envio) <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: 2a reserva sobrescreveu a assinatura da 1a';
  END IF;
END $$;
SQL
echo "A2 ok: 2a reserva do mesmo pedido mantem a assinatura da 1a"

N1=$(P -c "SET ROLE service_role; WITH u AS (UPDATE public.afiacao_os_envio SET omie_codigo_os=111, omie_numero_os='624', desfecho='incluida', confirmado_em=now() WHERE order_id='11111111-1111-4111-8111-111111111111' AND omie_codigo_os IS NULL RETURNING 1) SELECT count(*) FROM u;")
N2=$(P -c "SET ROLE service_role; WITH u AS (UPDATE public.afiacao_os_envio SET omie_codigo_os=222, omie_numero_os='999', desfecho='reconciliada', confirmado_em=now() WHERE order_id='11111111-1111-4111-8111-111111111111' AND omie_codigo_os IS NULL RETURNING 1) SELECT count(*) FROM u;")
OS=$(P -c "SELECT omie_codigo_os FROM public.afiacao_os_envio;")
[ "$N1" = "1" ] && [ "$N2" = "0" ] && [ "$OS" = "111" ] || { echo "A3 FALHOU: vinculo N1=$N1 N2=$N2 OS=$OS"; exit 1; }
echo "A3 ok: vinculo da OS gravado uma vez so"

# SQLSTATE esperada capturada; qualquer outra coisa re-lança.
esperar_sqlstate() { # rotulo sqlstate sql
  local out
  out=$(P -c "DO \$\$ BEGIN $3; RAISE EXCEPTION 'NAO_FALHOU'; EXCEPTION WHEN SQLSTATE '$2' THEN RAISE NOTICE 'ESPERADO'; END \$\$;" 2>&1) || { echo "$1 FALHOU: $out"; exit 1; }
  echo "$1 ok: SQLSTATE $2"
}
esperar_sqlstate "A4b (confirmada com codigo NULL)" 23514 "SET LOCAL ROLE service_role; INSERT INTO public.afiacao_os_envio (order_id, chave_integracao, omie_codigo_cliente, desfecho, confirmado_em) VALUES ('55555555-5555-4555-8555-555555555555','OS_5555',300,'incluida',now())"
esperar_sqlstate "A4 (OS sem desfecho)" 23514 "SET LOCAL ROLE service_role; INSERT INTO public.afiacao_os_envio (order_id, chave_integracao, omie_codigo_cliente, omie_codigo_os) VALUES ('22222222-2222-4222-8222-222222222222','OS_2222',300,5)"
esperar_sqlstate "A5 (chave duplicada)" 23505 "SET LOCAL ROLE service_role; INSERT INTO public.afiacao_os_envio (order_id, chave_integracao, omie_codigo_cliente) VALUES ('33333333-3333-4333-8333-333333333333','OS_1111111111114111811111',300)"
esperar_sqlstate "A6 (authenticated insere)" 42501 "SET LOCAL ROLE authenticated; INSERT INTO public.afiacao_os_envio (order_id, chave_integracao, omie_codigo_cliente) VALUES ('44444444-4444-4444-8444-444444444444','OS_4444',300)"
esperar_sqlstate "A6 (anon le)" 42501 "SET LOCAL ROLE anon; PERFORM 1 FROM public.afiacao_os_envio"

esperar_sqlstate "A8 (espelho duplicado)" 23505 "SET LOCAL ROLE service_role; INSERT INTO public.omie_ordens_servico (order_id) VALUES ('66666666-6666-4666-8666-666666666666'), ('66666666-6666-4666-8666-666666666666')"
UP=$(P -c "SET ROLE service_role; INSERT INTO public.omie_ordens_servico (order_id, omie_codigo_os) VALUES ('77777777-7777-4777-8777-777777777777', 1) ON CONFLICT (order_id) DO NOTHING; INSERT INTO public.omie_ordens_servico (order_id, omie_codigo_os) VALUES ('77777777-7777-4777-8777-777777777777', 2) ON CONFLICT (order_id) DO NOTHING; SELECT count(*)||':'||min(omie_codigo_os) FROM public.omie_ordens_servico WHERE order_id='77777777-7777-4777-8777-777777777777';")
[ "$UP" = "1:1" ] || { echo "A9 FALHOU: upsert do espelho $UP"; exit 1; }
echo "A9 ok: upsert do espelho mantem 1 linha (a 1a)"

STAFF=$(P -c "SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000000a'; SET ROLE authenticated; SELECT count(*) FROM public.afiacao_os_envio;")
CUST=$(P -c "SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000000c'; SET ROLE authenticated; SELECT count(*) FROM public.afiacao_os_envio;")
[ "$STAFF" = "1" ] && [ "$CUST" = "0" ] || { echo "A7 FALHOU: staff=$STAFF customer=$CUST"; exit 1; }
echo "A7 ok: staff le (1), customer nao (0)"

echo "TESTE_OK"

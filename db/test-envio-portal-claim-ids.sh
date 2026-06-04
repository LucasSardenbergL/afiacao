#!/usr/bin/env bash
# Testa a RPC public.envio_portal_claim_ids (migration 20260604150000) num Postgres 17 local
# descartável. Ela substitui o claim atômico .update().or().select() da edge
# enviar-pedido-portal-sayerlack, que o PostgREST quebrava com 42703 "column
# pedido_compra_sugerido.status_envio_portal does not exist" (travando TODO disparo ao portal).
#
# Schema MÍNIMO (não o snapshot inteiro): só o que a RPC toca — public.pedido_compra_sugerido
# (id/status_envio_portal/portal_erro), public.app_role, public.has_role, public.user_roles,
# auth.uid() lendo GUC de sessão (impersonação de teste). Prova a LÓGICA do claim: trava só os
# não-em-voo, idempotência, zera portal_erro, ids vazio, e o gate staff/service_role.
#
# Pré-requisitos: brew install postgresql@17   (mesmo boilerplate de db/verify-snapshot-replay.sh)
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5434
DATA="$(mktemp -d /tmp/pgtest-claim.XXXXXX)/data"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-claim.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres claim_test
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d claim_test "$@"; }

# 1) Schema mínimo que a RPC referencia
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS
  $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role) $f$;
CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  status_envio_portal text,
  portal_erro text
);
-- service_role precisa existir p/ o GRANT da migration
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')
  THEN CREATE ROLE service_role; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
  THEN CREATE ROLE authenticated; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
  THEN CREATE ROLE anon; END IF; END $$;
-- seed: 1 master, 1 vendedor não-staff (customer)
INSERT INTO public.user_roles VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','customer');
SQL

# 2) Aplica a migration da RPC (verbatim do repo)
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604150000_envio_portal_claim_ids.sql"

# 3) Seed de pedidos em todos os estados relevantes + asserts
echo "ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.pedido_compra_sugerido (id, status_envio_portal, portal_erro) VALUES
  (901, 'pendente_envio_portal', 'erro antigo a ser limpo'),
  (902, 'erro_retentavel',       NULL),
  (903, NULL,                     NULL),               -- fresco
  (904, 'enviando_portal',        NULL),               -- já em voo
  (905, 'pendente_envio_portal',  NULL);               -- p/ idempotência

DO $$
DECLARE n int; st text; err text;
BEGIN
  -- contexto = service_role (auth.uid() NULL): gate passa
  PERFORM set_config('test.uid', '', false);

  -- A1: claim de pendente + erro_retentavel + NULL → trava os 3, retorna os 3
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[901,902,903]::bigint[]);
  ASSERT n = 3, format('A1 esperava 3 reivindicados, veio %s', n);
  SELECT count(*) INTO n FROM public.pedido_compra_sugerido
    WHERE id IN (901,902,903) AND status_envio_portal = 'enviando_portal';
  ASSERT n = 3, format('A1 esperava 3 em enviando_portal, veio %s', n);

  -- A2: portal_erro foi ZERADO ao reivindicar (901 tinha "erro antigo")
  SELECT portal_erro INTO err FROM public.pedido_compra_sugerido WHERE id = 901;
  ASSERT err IS NULL, format('A2 esperava portal_erro NULL, veio %L', err);

  -- A3: claim de 904 (já em voo) → 0 reivindicados, status inalterado (anti-duplo-envio)
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[904]::bigint[]);
  ASSERT n = 0, format('A3 esperava 0 (já em voo), veio %s', n);
  SELECT status_envio_portal INTO st FROM public.pedido_compra_sugerido WHERE id = 904;
  ASSERT st = 'enviando_portal', format('A3 status do 904 mudou p/ %L', st);

  -- A4: idempotência — reivindicar 905 duas vezes; 2ª vez retorna 0 (já travado pela 1ª)
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[905]::bigint[]);
  ASSERT n = 1, format('A4 1ª chamada esperava 1, veio %s', n);
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[905]::bigint[]);
  ASSERT n = 0, format('A4 2ª chamada (idempotente) esperava 0, veio %s', n);

  -- A5: ids vazio → 0, sem erro
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[]::bigint[]);
  ASSERT n = 0, format('A5 ids vazio esperava 0, veio %s', n);

  RAISE NOTICE 'A1..A5 OK (service_role): claim, zera erro, anti-duplo-envio, idempotência, vazio';
END $$;

-- A6: gate — usuário NÃO-staff levanta exceção; master passa
DO $$
DECLARE ok boolean;
BEGIN
  PERFORM set_config('test.uid', '44444444-4444-4444-4444-444444444444', false); -- customer
  BEGIN
    PERFORM * FROM public.envio_portal_claim_ids(ARRAY[902]::bigint[]);
    ASSERT false, 'A6 esperava exceção p/ não-staff, não levantou';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'A6 OK: não-staff barrado (42501)';
  END;

  PERFORM set_config('test.uid', '33333333-3333-3333-3333-333333333333', false); -- master
  SELECT count(*) >= 0 INTO ok FROM public.envio_portal_claim_ids(ARRAY[902]::bigint[]);
  ASSERT ok, 'A6 master deveria passar o gate';
  RAISE NOTICE 'A6 OK: master passa o gate';
END $$;
SQL

echo ""
echo "TODOS OS ASSERTS PASSARAM ✅"

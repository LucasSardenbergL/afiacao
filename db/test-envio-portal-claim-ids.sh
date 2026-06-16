#!/usr/bin/env bash
# Testa a RPC public.envio_portal_claim_ids num Postgres 17 local descartável.
# Ela faz o claim atômico do envio ao portal Sayerlack (transição p/ enviando_portal,
# anti-duplo-envio) — substitui o .update().or().select() que o PostgREST quebrava.
#
# Aplica as DUAS migrations em sequência (replay realista):
#   20260604150000 — #592: move o claim p/ a RPC (predicado largo: IS NULL OR <> enviando_portal)
#   20260604180000 — aperta p/ LISTA POSITIVA (só pendente_envio_portal/erro_retentavel) + guard
#                    empresa/fornecedor → anti-PO-duplicado (não reivindica estados terminais).
#
# Schema MÍNIMO (não o snapshot inteiro): só o que a RPC toca. Prova a LÓGICA final:
# claim, zera portal_erro, anti-duplo-envio, idempotência, ids vazio, gate, e — o P1 do
# 20260604180000 — NÃO reivindicar terminais/NULL/fora-de-escopo.
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
  empresa text,
  fornecedor_nome text,
  status_envio_portal text,
  portal_erro text
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')
  THEN CREATE ROLE service_role; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
  THEN CREATE ROLE authenticated; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
  THEN CREATE ROLE anon; END IF; END $$;
INSERT INTO public.user_roles VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','customer');
SQL

# 2) Aplica as 2 migrations EM SEQUÊNCIA (a 180000 faz CREATE OR REPLACE da 150000)
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604150000_envio_portal_claim_ids.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604180000_envio_portal_claim_ids_lista_positiva.sql"

# 3) Seed + asserts
echo "ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status_envio_portal, portal_erro) VALUES
  -- reivindicáveis (Sayerlack/OBEN, estado de fila)
  (901, 'OBEN', 'RENNER SAYERLACK S/A', 'pendente_envio_portal', 'erro antigo a ser limpo'),
  (902, 'OBEN', 'RENNER SAYERLACK S/A', 'erro_retentavel',       NULL),
  (905, 'OBEN', 'RENNER SAYERLACK S/A', 'pendente_envio_portal', NULL),   -- idempotência
  -- NÃO reivindicáveis
  (903, 'OBEN', 'RENNER SAYERLACK S/A', NULL,                    NULL),   -- NULL (nova semântica)
  (904, 'OBEN', 'RENNER SAYERLACK S/A', 'enviando_portal',       NULL),   -- já em voo
  -- TERMINAIS/ambíguos (P1 — JAMAIS reivindicar: re-envio = PO duplicado)
  (910, 'OBEN', 'RENNER SAYERLACK S/A', 'sucesso_portal',                NULL),
  (911, 'OBEN', 'RENNER SAYERLACK S/A', 'indeterminado_requer_conciliacao', NULL),
  (912, 'OBEN', 'RENNER SAYERLACK S/A', 'aceito_portal_sem_protocolo',   NULL),
  (913, 'OBEN', 'RENNER SAYERLACK S/A', 'erro_nao_retentavel',           NULL),
  -- fora de escopo (guard empresa/fornecedor)
  (930, 'COLACOR', 'RENNER SAYERLACK S/A', 'pendente_envio_portal', NULL),  -- empresa != OBEN
  (931, 'OBEN',    'OUTRO FORNECEDOR LTDA','pendente_envio_portal', NULL);  -- fornecedor != Sayerlack

DO $$
DECLARE n int; st text; err text;
BEGIN
  PERFORM set_config('test.uid', '', false);  -- service_role: gate passa

  -- A1: reivindica pendente + erro_retentavel
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[901,902]::bigint[]);
  ASSERT n = 2, format('A1 esperava 2 reivindicados, veio %s', n);
  SELECT count(*) INTO n FROM public.pedido_compra_sugerido
    WHERE id IN (901,902) AND status_envio_portal = 'enviando_portal';
  ASSERT n = 2, format('A1 esperava 2 em enviando_portal, veio %s', n);

  -- A2: portal_erro zerado ao reivindicar
  SELECT portal_erro INTO err FROM public.pedido_compra_sugerido WHERE id = 901;
  ASSERT err IS NULL, format('A2 esperava portal_erro NULL, veio %L', err);

  -- A3: já em voo (enviando_portal) → 0, status inalterado
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[904]::bigint[]);
  ASSERT n = 0, format('A3 esperava 0 (já em voo), veio %s', n);

  -- A4: idempotência
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[905]::bigint[]);
  ASSERT n = 1, format('A4 1ª esperava 1, veio %s', n);
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[905]::bigint[]);
  ASSERT n = 0, format('A4 2ª (idempotente) esperava 0, veio %s', n);

  -- A5: ids vazio
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[]::bigint[]);
  ASSERT n = 0, format('A5 vazio esperava 0, veio %s', n);

  RAISE NOTICE 'A1..A5 OK: claim, zera erro, anti-duplo-envio, idempotência, vazio';

  -- A7 (P1): TERMINAIS/ambíguos JAMAIS reivindicados (anti-PO-duplicado)
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[910,911,912,913]::bigint[]);
  ASSERT n = 0, format('A7 esperava 0 (terminais protegidos), veio %s — RISCO DE PO DUPLICADO', n);
  SELECT count(*) INTO n FROM public.pedido_compra_sugerido
    WHERE id IN (910,911,912,913) AND status_envio_portal = 'enviando_portal';
  ASSERT n = 0, format('A7 terminais NÃO podem virar enviando_portal, %s viraram', n);

  -- A8: NULL não reivindicado (nova semântica, sem OR IS NULL)
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[903]::bigint[]);
  ASSERT n = 0, format('A8 NULL esperava 0, veio %s', n);

  -- A9: guard empresa/fornecedor
  SELECT count(*) INTO n FROM public.envio_portal_claim_ids(ARRAY[930,931]::bigint[]);
  ASSERT n = 0, format('A9 fora-de-escopo esperava 0, veio %s', n);

  RAISE NOTICE 'A7..A9 OK: terminais/NULL/fora-de-escopo NÃO reivindicados (P1 anti-PO-duplicado)';
END $$;

-- A6: gate — não-staff levanta exceção; master passa
DO $$
DECLARE ok boolean;
BEGIN
  PERFORM set_config('test.uid', '44444444-4444-4444-4444-444444444444', false); -- customer
  BEGIN
    PERFORM * FROM public.envio_portal_claim_ids(ARRAY[902]::bigint[]);
    ASSERT false, 'A6 esperava exceção p/ não-staff';
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

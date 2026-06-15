#!/usr/bin/env bash
# Teste PG17 do claim ATÔMICO do full sync (P1-A): claim_estoque_full_sync.
#   D1  marcador ausente → 1º claim = true (cria 'syncing')
#   D2  claim enquanto 'syncing' RECENTE (<15min) → false (negado; serializa cron×manual)
#   D2b claim enquanto 'syncing' de 6min (dentro do TTL 15min) → ainda false
#   D3  claim enquanto 'syncing' STALE (>15min, sync morreu) → true (auto-libera/re-claim)
#   D4  claim enquanto 'complete' → true (reivindica, sobrescreve p/ 'syncing')
#   D6  finalize com run_id DONO → true + status='complete'
#   D7  finalize com run_id ALHEIO (claim roubado (TTL 15min)) → false + status fica 'syncing' (ownership)
#   D7b finalize sobre status != 'syncing' → false
#   D5  REVOKE: anon NÃO pode executar; service_role pode (claim + finalize)
# Base: db/test-data-health-estoque-marcador.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5444
DATA="$(mktemp -d /tmp/pgtest-claim.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-claim.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres claim_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d claim_verify "$@"; }

RR="$(mktemp /tmp/snap-claim.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ roles stub (service_role/anon) + claim migration…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
SQL
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611220000_reposicao_claim_full_sync.sql" >/dev/null

echo "ASSERTS:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE v_ok boolean; v_status text; v_can boolean;
BEGIN
  DELETE FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';

  -- D1: marcador ausente → 1º claim = true, cria 'syncing'
  v_ok := public.claim_estoque_full_sync('oben', 1000, now());
  ASSERT v_ok = true, format('D1 esperava true, veio %s', v_ok);
  SELECT status INTO v_status FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';
  ASSERT v_status = 'syncing', format('D1 status esperava syncing, veio %s', v_status);

  -- D2: claim enquanto 'syncing' RECENTE (<15min) → false (negado)
  v_ok := public.claim_estoque_full_sync('oben', 1001, now());
  ASSERT v_ok = false, format('D2 (syncing recente) esperava false, veio %s', v_ok);

  -- D2b: 'syncing' de 6min (DENTRO do TTL 15min agora) → ainda NEGA (antes do round4 isso liberava)
  UPDATE public.sync_state SET last_sync_at = now() - interval '6 minutes'
    WHERE entity_type='reposicao_estoque_full' AND account='oben';
  v_ok := public.claim_estoque_full_sync('oben', 1001, now());
  ASSERT v_ok = false, format('D2b (syncing 6min < TTL 15min) esperava false, veio %s', v_ok);

  -- D3: 'syncing' STALE (>15min, sync morreu) → true (auto-libera)
  UPDATE public.sync_state SET last_sync_at = now() - interval '16 minutes'
    WHERE entity_type='reposicao_estoque_full' AND account='oben';
  v_ok := public.claim_estoque_full_sync('oben', 1002, now());
  ASSERT v_ok = true, format('D3 (syncing stale >15min) esperava true, veio %s', v_ok);

  -- D4: 'complete' → true (reivindica)
  UPDATE public.sync_state SET status='complete', last_sync_at = now()
    WHERE entity_type='reposicao_estoque_full' AND account='oben';
  v_ok := public.claim_estoque_full_sync('oben', 1003, now());
  ASSERT v_ok = true, format('D4 (complete) esperava true, veio %s', v_ok);
  SELECT status INTO v_status FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';
  ASSERT v_status = 'syncing', format('D4 após claim status esperava syncing, veio %s', v_status);

  RAISE NOTICE 'D1..D4 OK: claim atômico (cria/nega-recente/auto-libera-stale/reivindica-complete)';

  -- D6 [ownership]: claim (run 2000) → finalize com run_id CORRETO → true + status='complete'
  DELETE FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';
  PERFORM public.claim_estoque_full_sync('oben', 2000, now());
  v_ok := public.finalizar_estoque_full_sync('oben', 2000, 'complete', now(), 100, NULL, '{"paginas":7}'::jsonb);
  ASSERT v_ok = true, format('D6 finalize com run_id dono esperava true, veio %s', v_ok);
  SELECT status INTO v_status FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';
  ASSERT v_status = 'complete', format('D6 status após finalize esperava complete, veio %s', v_status);

  -- D7 [ownership]: claim (run 2001) → finalize com run_id ERRADO (claim roubado) → false + status fica 'syncing'
  DELETE FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';
  PERFORM public.claim_estoque_full_sync('oben', 2001, now());
  v_ok := public.finalizar_estoque_full_sync('oben', 9999, 'complete', now(), 100, NULL, '{}'::jsonb);
  ASSERT v_ok = false, format('D7 finalize com run_id ALHEIO esperava false (perdeu o claim), veio %s', v_ok);
  SELECT status INTO v_status FROM public.sync_state WHERE entity_type='reposicao_estoque_full' AND account='oben';
  ASSERT v_status = 'syncing', format('D7 status NÃO podia virar complete (ownership), veio %s', v_status);

  -- D7b: finalize quando o status NÃO é 'syncing' (já complete) → false (não re-finaliza)
  UPDATE public.sync_state SET status='complete' WHERE entity_type='reposicao_estoque_full' AND account='oben';
  v_ok := public.finalizar_estoque_full_sync('oben', 2001, 'complete', now(), 100, NULL, '{}'::jsonb);
  ASSERT v_ok = false, format('D7b finalize sobre não-syncing esperava false, veio %s', v_ok);

  RAISE NOTICE 'D6..D7b OK: finalize valida OWNERSHIP (run_id) e exige status=syncing';

  -- D5: REVOKE — anon NÃO pode; service_role pode (claim E finalize)
  SELECT has_function_privilege('anon','public.claim_estoque_full_sync(text, bigint, timestamptz)','EXECUTE') INTO v_can;
  ASSERT v_can = false, 'D5 claim: anon NÃO deveria poder executar (REVOKE)';
  SELECT has_function_privilege('service_role','public.claim_estoque_full_sync(text, bigint, timestamptz)','EXECUTE') INTO v_can;
  ASSERT v_can = true, 'D5 claim: service_role deveria poder executar (GRANT)';
  SELECT has_function_privilege('anon','public.finalizar_estoque_full_sync(text, bigint, text, timestamptz, int, text, jsonb)','EXECUTE') INTO v_can;
  ASSERT v_can = false, 'D5 finalize: anon NÃO deveria poder executar (REVOKE)';
  SELECT has_function_privilege('service_role','public.finalizar_estoque_full_sync(text, bigint, text, timestamptz, int, text, jsonb)','EXECUTE') INTO v_can;
  ASSERT v_can = true, 'D5 finalize: service_role deveria poder executar (GRANT)';

  RAISE NOTICE 'D5 OK: REVOKE anon/authenticated, GRANT service_role (claim + finalize)';
END $$;

SELECT '✅ TODOS OS ASSERTS (D1..D7b) PASSARAM' AS resultado;
SQL

echo "✅ test-claim-full-sync: OK"

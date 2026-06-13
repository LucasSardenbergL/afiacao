#!/usr/bin/env bash
# Teste PG17 do PASSO 5 — check estoque_reposicao via MARCADOR (worst-of físico + a-caminho).
# Aplica schema-snapshot + a base (20260611140000, via ultima_sincronizacao) + a nova (20260611210000,
# via markers sync_state) e valida o check `estoque_reposicao` do _data_health_compute():
#   C1  ambos markers (full+pendente) complete e frescos → 'ok'
#   C2  marker pendente AUSENTE → 'broken' (faltando>0) — pega o sync parcial
#   C3  marker pendente status='running' (não-complete) → 'broken'
#   C4  ambos complete, mas a-caminho velho (20h) → 'stale' (worst-of pega o mais velho)
#   C5  RPC-falha: full fresco + pendente 31h → 'broken' (o que o max(ultima_sincronizacao) deixava verde)
#   C7  [P1-A] full 'syncing' <30min → 'ok' (sync em andamento, motor já bloqueado)
#   C8  [P1-A] full 'syncing' >30min → 'broken' (sync travou no meio)
#   C6  total de checks = 18 (o conjunto NÃO mudou)
# Base: db/test-rpc-intraday.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443
DATA="$(mktemp -d /tmp/pgtest-dhmark.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-dhmark.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres dhmark_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d dhmark_verify "$@"; }

RR="$(mktemp /tmp/snap-dhmark.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (colunas stale) + stub cron.schedule…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;
ALTER TABLE public.sku_parametros ADD COLUMN IF NOT EXISTS minimo_forcado_manual numeric;
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "→ base 140000 (#752 estoque-frescor) + 180000 (família-lista-email: cria o helper que o watchdog do 210000 chama) + 210000 (markers)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611140000_data_health_check_estoque_frescor.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611180000_familia_ausente_lista_email.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611210000_data_health_estoque_via_marcador.sql" >/dev/null

echo "ASSERTS:"
P -v ON_ERROR_STOP=1 <<'SQL'
-- helper: seta os markers (reseta os 2 e insere conforme o caso)
CREATE OR REPLACE FUNCTION _set_markers(p_full_age interval, p_full_status text, p_pend_age interval, p_pend_status text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.sync_state WHERE entity_type IN ('reposicao_estoque_full','reposicao_pendente_po') AND account='oben';
  IF p_full_status IS NOT NULL THEN
    INSERT INTO public.sync_state (entity_type, account, status, last_sync_at) VALUES ('reposicao_estoque_full','oben',p_full_status, now()-p_full_age);
  END IF;
  IF p_pend_status IS NOT NULL THEN
    INSERT INTO public.sync_state (entity_type, account, status, last_sync_at) VALUES ('reposicao_pendente_po','oben',p_pend_status, now()-p_pend_age);
  END IF;
END $$;

DO $$
DECLARE v_status text; v_n int;
BEGIN
  -- C1: ambos complete + frescos → ok
  PERFORM _set_markers(interval '10 minutes','complete', interval '10 minutes','complete');
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'ok', format('C1 esperava ok, veio %s', v_status);

  -- C2: pendente AUSENTE → broken (faltando>0)
  PERFORM _set_markers(interval '10 minutes','complete', NULL, NULL);
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'broken', format('C2 (pendente ausente) esperava broken, veio %s', v_status);

  -- C3: pendente status='running' (não-complete, não-syncing) → broken (não saudável → faltando=1)
  PERFORM _set_markers(interval '10 minutes','complete', interval '10 minutes','running');
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'broken', format('C3 (pendente running) esperava broken, veio %s', v_status);

  -- C4: ambos complete, a-caminho 20h → stale (worst-of, 16h<20h<30h)
  PERFORM _set_markers(interval '10 minutes','complete', interval '20 hours','complete');
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'stale', format('C4 (a-caminho 20h) esperava stale, veio %s', v_status);

  -- C5: RPC-falha — full fresco + pendente 31h → broken (o que o max(ultima_sincronizacao) deixava verde)
  PERFORM _set_markers(interval '10 minutes','complete', interval '31 hours','complete');
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'broken', format('C5 (RPC-falha, pendente 31h) esperava broken, veio %s', v_status);

  -- C7 [P1-A]: full 'syncing' RECENTE (<30min) + pendente complete fresco → ok (tolera sync em andamento)
  PERFORM _set_markers(interval '10 minutes','syncing', interval '10 minutes','complete');
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'ok', format('C7 (full syncing <30min) esperava ok, veio %s', v_status);

  -- C8 [P1-A]: full 'syncing' STALE (>30min) → broken (sync travou/falhou no meio)
  PERFORM _set_markers(interval '45 minutes','syncing', interval '10 minutes','complete');
  SELECT status INTO v_status FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_status = 'broken', format('C8 (full syncing >30min stale) esperava broken, veio %s', v_status);

  RAISE NOTICE 'C1..C8 OK: worst-of dos 2 markers; pega parcial/RPC-falha; tolera syncing<30min, alerta syncing stale';

  -- C6: total de checks = 18 (conjunto inalterado) + estoque_reposicao presente
  PERFORM _set_markers(interval '10 minutes','complete', interval '10 minutes','complete');
  SELECT count(*) INTO v_n FROM public._data_health_compute();
  ASSERT v_n = 18, format('C6 esperava 18 checks, veio %s', v_n);
  SELECT count(*) INTO v_n FROM public._data_health_compute() WHERE source='estoque_reposicao';
  ASSERT v_n = 1, format('C6 estoque_reposicao deveria existir 1×, veio %s', v_n);
  -- e o source ainda está nos IN-lists do watchdog (push) — sanity: a função existe e referencia o source
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname='data_health_watchdog'
    AND pg_get_functiondef(oid) LIKE '%estoque_reposicao%';
  ASSERT v_n = 1, 'C6 watchdog deveria referenciar estoque_reposicao (push intacto)';

  RAISE NOTICE 'C6 OK: 18 checks, conjunto inalterado, watchdog ainda referencia estoque_reposicao';
END $$;

SELECT '✅ TODOS OS ASSERTS (C1..C8) PASSARAM' AS resultado;
SQL

echo "✅ test-data-health-estoque-marcador: OK"

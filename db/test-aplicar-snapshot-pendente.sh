#!/usr/bin/env bash
# Teste PG17 da RPC aplicar_snapshot_pendente (passo 1 — FONTE ÚNICA do "a caminho", money-path OBEN).
# Aplica schema-snapshot + a migration nova, semeia sku_estoque_atual/sync_state, e valida:
#   A1  aplica e SETA os do payload (FUNDO PU = 3)
#   A2  substituição ABSOLUTA: zera SKU com pendente fora do payload (nunca +=)
#   A3  preserva estoque_fisico E ultima_sincronizacao da linha existente (só toca o pendente)
#   A4  marcador 'complete' com run_id + observed_at + codints_aprovados + account='oben'
#   A5  run velho → SKIP (estoque e marcador inalterados)
#   A6  idempotência: re-aplicar o MESMO run = mesmo estado
#   A7  UPSERT cria linha só-pendente (fisico=0, ultima_sincronizacao=NULL, fonte_sync='snapshot_pendente_sem_fisico')
#   A8  GUARD empty_page_reached ausente → RAISE, NÃO zera (backstop anti-payload-vazio-acidental)
#   A9  GUARD saldo inválido (<=0 / não-numérico) → RAISE
#   A10 payload vazio + empty_page_reached=true → zera TUDO (0 POs legítimo)
#   A11 gate: customer (não-staff) → 42501; master → passa; service_role (uid NULL) → passa
#   A12 só toca a empresa do payload (COLACOR intacto)
#   A13 codints_aprovados normalizados (distintos, sem vazio/NULL)
# Base: db/test-rpc-intraday.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5439
DATA="$(mktemp -d /tmp/pgtest-snappend.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-snappend.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres snappend_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d snappend_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-snappend.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ auth.uid() controlável + roles + seed de user_roles…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; END $$;
-- fixture: dispensa a integridade referencial de auth.users (teste isola só a RPC).
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_fkey;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','customer')
ON CONFLICT DO NOTHING;
SQL

echo "→ aplica a migration da RPC…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611195000_reposicao_aplicar_snapshot_pendente.sql" >/dev/null

echo "ASSERTS:"
P -v ON_ERROR_STOP=1 <<'SQL'
-- Seed: estado ANTES do snapshot.
--   8689734299 (FUNDO PU): já tem física, pendente velho (será setado p/ 3 pelo payload)
--   1001: tem física + pendente velho, NÃO está no payload → deve ZERAR (substituição absoluta)
--   1002: tem física, pendente NULL, está no payload → setado
--   COLACOR/9001: outra empresa → intocada
TRUNCATE public.sku_estoque_atual;
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_disponivel, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync) VALUES
  ('OBEN','8689734299', 10, 10, 99, '2026-06-11 09:00:00+00', 'ListarPosEstoque'),
  ('OBEN','1001',       50, 50, 25, '2026-06-11 09:00:00+00', 'ListarPosEstoque'),
  ('OBEN','1002',        5,  5, NULL,'2026-06-11 09:00:00+00', 'ListarPosEstoque'),
  ('COLACOR','9001',     7,  7, 13, '2026-06-11 09:00:00+00', 'ListarSaldoPendente');

DO $$
DECLARE r jsonb; v numeric; f numeric; ts timestamptz; fonte text; st text; n int; meta jsonb; err_state text;
BEGIN
  PERFORM set_config('test.uid', '', false);  -- service_role

  -- A1+A2+A3: aplica run 1000 com FUNDO PU=3, 1002=8 (1001 fora → zera)
  r := public.aplicar_snapshot_pendente(
        'OBEN',
        '{"8689734299": 3, "1002": 8}'::jsonb,
        ARRAY['AFI-abc','AFI-def','AFI-abc',' ']::text[],   -- aprovados: com duplicata + vazio (testa normalização)
        ARRAY['AFI-emaprov','AFI-emaprov']::text[],         -- em aprovação (P1.2): testa normalização + gravação
        1000::bigint, '2026-06-11 12:00:00+00'::timestamptz,
        '{"empty_page_reached":"true","paginas":4,"modo":"full"}'::jsonb);
  ASSERT (r->>'applied')::boolean, format('A1 esperava applied=true, veio %s', r);

  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='8689734299';
  ASSERT v = 3, format('A1 FUNDO PU pendente esperava 3, veio %s', v);

  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='1002';
  ASSERT v = 8, format('A1 1002 pendente esperava 8, veio %s', v);

  -- A2: 1001 fora do payload → zerado (não +=, não preservado)
  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='1001';
  ASSERT v = 0, format('A2 1001 esperava 0 (substituição absoluta), veio %s', v);

  -- A3: físico e ultima_sincronizacao preservados (FUNDO PU)
  SELECT estoque_fisico, ultima_sincronizacao, fonte_sync INTO f, ts, fonte
    FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='8689734299';
  ASSERT f = 10, format('A3 físico esperava 10 (preservado), veio %s', f);
  ASSERT ts = '2026-06-11 09:00:00+00'::timestamptz, format('A3 ultima_sincronizacao deveria ser preservada, veio %s', ts);
  ASSERT fonte = 'ListarPosEstoque', format('A3 fonte_sync deveria ser preservada, veio %s', fonte);

  -- A4: marcador complete + metadata
  SELECT status, metadata INTO st, meta FROM public.sync_state WHERE entity_type='reposicao_pendente_po' AND account='oben';
  ASSERT st = 'complete', format('A4 status esperava complete, veio %s', st);
  ASSERT (meta->>'run_id')::bigint = 1000, format('A4 run_id esperava 1000, veio %s', meta->>'run_id');
  ASSERT (meta->>'observed_at')::timestamptz = '2026-06-11 12:00:00+00'::timestamptz, 'A4 observed_at errado';
  ASSERT (meta->'codints_aprovados') ? 'AFI-abc', 'A4 marcador deveria conter AFI-abc';
  ASSERT (meta->'codints_aprovados') ? 'AFI-def', 'A4 marcador deveria conter AFI-def';
  -- [P1.2] codints_em_aprovacao gravado e normalizado (distinto)
  ASSERT (meta->'codints_em_aprovacao') ? 'AFI-emaprov', 'A4 marcador deveria conter codints_em_aprovacao';
  ASSERT jsonb_array_length(meta->'codints_em_aprovacao') = 1, 'A4 codints_em_aprovacao deveria ser distinto (1)';
  ASSERT NOT ((meta->'codints_aprovados') ? 'AFI-emaprov'), 'A4 em_aprovacao NÃO pode estar em codints_aprovados';

  -- A13: codints normalizados (distintos, sem vazio) → 2
  SELECT jsonb_array_length(meta->'codints_aprovados') INTO n;
  ASSERT n = 2, format('A13 codints distintos esperava 2 (sem dup/vazio), veio %s', n);
  ASSERT (r->>'codints_aprovados')::int = 2, format('A13 retorno codints esperava 2, veio %s', r->>'codints_aprovados');

  RAISE NOTICE 'A1..A4,A13 OK: aplica/seta, zera fora do payload, preserva físico, marcador+codints normalizados';

  -- A5: run VELHO (999 < 1000) → SKIP, nada muda
  r := public.aplicar_snapshot_pendente(
        'OBEN', '{"8689734299": 777}'::jsonb, ARRAY['AFI-x']::text[],
        ARRAY[]::text[], 999::bigint, '2026-06-11 13:00:00+00'::timestamptz, '{"empty_page_reached":"true"}'::jsonb);
  ASSERT (r->>'applied')::boolean = false AND r->>'skipped_reason' = 'stale_run', format('A5 esperava skip stale_run, veio %s', r);
  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='8689734299';
  ASSERT v = 3, format('A5 run velho NÃO podia alterar (esperava 3), veio %s', v);
  SELECT (metadata->>'run_id')::bigint INTO n FROM public.sync_state WHERE entity_type='reposicao_pendente_po' AND account='oben';
  ASSERT n = 1000, format('A5 marcador NÃO podia regredir (esperava run 1000), veio %s', n);

  -- A6: idempotência — re-aplica run 1000 idêntico
  r := public.aplicar_snapshot_pendente(
        'OBEN', '{"8689734299": 3, "1002": 8}'::jsonb, ARRAY['AFI-abc','AFI-def']::text[],
        ARRAY[]::text[], 1000::bigint, '2026-06-11 12:00:00+00'::timestamptz, '{"empty_page_reached":"true"}'::jsonb);
  ASSERT (r->>'applied')::boolean, 'A6 re-aplicar mesmo run deveria aplicar (>=)';
  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='8689734299';
  ASSERT v = 3, format('A6 idempotente esperava 3, veio %s', v);

  RAISE NOTICE 'A5..A6 OK: run velho skip + idempotência';

  -- A7: UPSERT cria linha só-pendente p/ SKU sem física (2002), run 1001
  r := public.aplicar_snapshot_pendente(
        'OBEN', '{"8689734299": 3, "1002": 8, "2002": 5}'::jsonb, ARRAY[]::text[],
        ARRAY[]::text[], 1001::bigint, '2026-06-11 12:05:00+00'::timestamptz, '{"empty_page_reached":"true"}'::jsonb);
  SELECT estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync INTO f, v, ts, fonte
    FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='2002';
  ASSERT f = 0, format('A7 linha nova físico esperava 0, veio %s', f);
  ASSERT v = 5, format('A7 linha nova pendente esperava 5, veio %s', v);
  ASSERT ts IS NULL, format('A7 linha nova ultima_sincronizacao esperava NULL, veio %s', ts);
  ASSERT fonte = 'snapshot_pendente_sem_fisico', format('A7 fonte_sync esperava snapshot_pendente_sem_fisico, veio %s', fonte);
  ASSERT (r->>'skus_sem_linha_criados')::int = 1, format('A7 skus_sem_linha_criados esperava 1, veio %s', r->>'skus_sem_linha_criados');

  RAISE NOTICE 'A7 OK: UPSERT cria linha só-pendente honesta (fisico=0, ts=NULL, fonte marcada)';

  -- A8: GUARD empty_page_reached ausente → RAISE, NÃO altera (1002 continua 8)
  BEGIN
    PERFORM public.aplicar_snapshot_pendente('OBEN', '{}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 1002::bigint,
              '2026-06-11 12:10:00+00'::timestamptz, '{"paginas":1}'::jsonb);
    ASSERT false, 'A8 deveria ter dado RAISE (empty_page_reached ausente)';
  EXCEPTION WHEN data_exception THEN NULL;  -- 22023 = invalid_parameter_value (classe 22)
  END;
  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='OBEN' AND sku_codigo_omie='1002';
  ASSERT v = 8, format('A8 guard recusou mas alterou estoque (esperava 8), veio %s', v);

  -- A9: GUARD saldo inválido (<=0)
  BEGIN
    PERFORM public.aplicar_snapshot_pendente('OBEN', '{"8689734299": 0}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 1003::bigint,
              '2026-06-11 12:11:00+00'::timestamptz, '{"empty_page_reached":"true"}'::jsonb);
    ASSERT false, 'A9 deveria ter dado RAISE (saldo <= 0)';
  EXCEPTION WHEN data_exception THEN NULL;
  END;
  -- saldo não-numérico
  BEGIN
    PERFORM public.aplicar_snapshot_pendente('OBEN', '{"8689734299": "x"}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 1003::bigint,
              '2026-06-11 12:11:00+00'::timestamptz, '{"empty_page_reached":"true"}'::jsonb);
    ASSERT false, 'A9 deveria ter dado RAISE (saldo não-numérico)';
  EXCEPTION WHEN data_exception THEN NULL;
  END;

  RAISE NOTICE 'A8..A9 OK: guards de completude e de saldo (fail-closed)';

  -- A10: payload vazio LEGÍTIMO (empty_page_reached=true) → zera TUDO OBEN, run 1004
  r := public.aplicar_snapshot_pendente('OBEN', '{}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 1004::bigint,
            '2026-06-11 12:20:00+00'::timestamptz, '{"empty_page_reached":"true"}'::jsonb);
  ASSERT (r->>'applied')::boolean, 'A10 payload vazio legítimo deveria aplicar';
  SELECT count(*) INTO n FROM public.sku_estoque_atual WHERE empresa='OBEN' AND COALESCE(estoque_pendente_entrada,0) <> 0;
  ASSERT n = 0, format('A10 payload vazio legítimo deveria zerar todo OBEN, ainda há %s com pendente', n);

  RAISE NOTICE 'A10 OK: 0 POs aprovadas legítimo → zera todo o a-caminho';

  -- A12: COLACOR intocada por todo o teste
  SELECT estoque_pendente_entrada INTO v FROM public.sku_estoque_atual WHERE empresa='COLACOR' AND sku_codigo_omie='9001';
  ASSERT v = 13, format('A12 COLACOR não podia ser tocada (esperava 13), veio %s', v);

  RAISE NOTICE 'A12 OK: só a empresa do payload é tocada';
END $$;

-- A11: gate (fora do bloco, p/ trocar test.uid e isolar exceções de role)
DO $$
DECLARE ok boolean; err_state text;
BEGIN
  -- master → passa
  PERFORM set_config('test.uid', '33333333-3333-3333-3333-333333333333', false);
  PERFORM public.aplicar_snapshot_pendente('OBEN', '{"8689734299": 3}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 2000::bigint,
            now(), '{"empty_page_reached":"true"}'::jsonb);
  RAISE NOTICE 'A11 master OK (passa)';

  -- customer → 42501
  PERFORM set_config('test.uid', '44444444-4444-4444-4444-444444444444', false);
  BEGIN
    PERFORM public.aplicar_snapshot_pendente('OBEN', '{"8689734299": 3}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 2001::bigint,
              now(), '{"empty_page_reached":"true"}'::jsonb);
    ASSERT false, 'A11 customer deveria ter sido barrado (42501)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'A11 customer barrado OK (42501)';
  END;

  -- service_role (uid NULL) → passa
  PERFORM set_config('test.uid', '', false);
  PERFORM public.aplicar_snapshot_pendente('OBEN', '{"8689734299": 3}'::jsonb, ARRAY[]::text[], ARRAY[]::text[], 2002::bigint,
            now(), '{"empty_page_reached":"true"}'::jsonb);
  RAISE NOTICE 'A11 service_role OK (passa)';
END $$;

SELECT '✅ TODOS OS ASSERTS (A1..A13) PASSARAM' AS resultado;
SQL

echo "✅ test-aplicar-snapshot-pendente: OK"

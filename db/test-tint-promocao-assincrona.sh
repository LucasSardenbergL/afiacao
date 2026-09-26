#!/usr/bin/env bash
# PROVA — 20260925210000_tint_promocao_assincrona.sql (promoção do tint-sync-agent sai do HTTP).
#
# Aplica a migration REAL num PG17 descartável sobre o snapshot de schema (+ a 5b#1, que é o corpo
# de prod do promote) e prova, EXECUTANDO:
#   X1  — premissa: SET statement_timeout na DEFINIÇÃO da função NÃO limita o statement corrente
#         (é por isso que o timeout vai no COMANDO do cron, e que o '300s' do promote é inerte).
#   T1  — fila FIFO: promove o mais antigo primeiro, 1 por tick; lote de 20 pares promove fora do
#         HTTP; status (ingestão) intacto; fila vazia devolve 'fila_vazia'.
#   T2  — falha: tentativa conta, backoff 1→2 min com clock_timestamp, cabeça em backoff SEGURA o
#         grupo (FIFO estrito), 3 falhas → 'erro' sem mexer em status; depois a fila anda.
#   T3  — statement_timeout (57014) é CAPTURADO no tick: parcial desfeito, tentativa conta, rc 0.
#   T4  — nunca 2 promoções simultâneas: tick concorrente PULA (try-lock); o lento termina.
#   T5  — snapshot na MESMA fila, em ordem de chegada; aplica em todas as linhas-chunk; ok:false
#         do RPC (blast radius) vira 'erro' DIRETO (sem retry). Fixa também o efeito herdado do
#         latest-staging: run anterior na fila já promove chave de run posterior; o snapshot no
#         meio a desativa por um instante; o run posterior a reativa — o estado final CONVERGE.
#   T6  — run pendente que não está 'complete' não é promovido (erro explícito).
#   T7  — cap de 50 limpezas/24h conta pela PROMOÇÃO (promovido_em), não pela ingestão.
#   T8  — purge de tint_keys_snapshots >30d poupa snapshot PENDENTE.
#   T9  — watchdog: alerta de erro e de atraso (fin_alertas + e-mail), dispensa ao resolver, e
#         erro VELHO (>7d) continua alertando (sem janela).
#   T10 — ACL: authenticated não executa tick/watchdog (42501).
#   T11 — re-apply idempotente (corpos idênticos, 1 job por nome).
#   T12 — sem a 5b#1 a migration ABORTA inteira (nada fica meio-aplicado).
# Falsificações (F*) na MESMA invocação do controle verde: cada sabotagem exige o CONJUNTO EXATO
# de asserts vermelhos. Controle não-verde aborta antes da 1ª sabotagem.
#
# Uso: db/test-tint-promocao-assincrona.sh   (PGBIN=<dir>; HARNESS_LOCALE=C|pt_BR.UTF-8)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-5448}"
LOC="${HARNESS_LOCALE:-C}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-promoasync.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
MIG5B="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "PG ausente em $PGBIN (defina PGBIN)"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
[ -f "$MIG5B" ] || { echo "migration 5b#1 ausente: $MIG5B"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -p "$PORT" -h "$SOCK" -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
echo "PG: $("$PGBIN/postgres" --version) · locale=$LOC"

# ── X1: premissa (ANTES de tudo) ─────────────────────────────────────────────────────────────
X1="$(PA -d postgres -tA 2>&1 <<'SQL'
CREATE FUNCTION _x1_lenta() RETURNS text LANGUAGE plpgsql SET statement_timeout = '1s'
AS $$ BEGIN PERFORM pg_sleep(2); RETURN 'X1_TERMINOU'; END $$;
SELECT _x1_lenta();
SQL
)" || true
case "$X1" in
  *X1_TERMINOU*) echo "  ✓ X1 premissa: SET statement_timeout na definição da função NÃO corta o statement corrente" ;;
  *) echo "  ✗ X1 premissa FALSA — o desenho (timeout no comando do cron) precisa ser revisto: [$X1]"; exit 1 ;;
esac

# ── template base: stubs + prelude + snapshot + cron stub + 5b#1 + seed ─────────────────────────
PA -q -d postgres -c "CREATE DATABASE tpl0" >/dev/null
T0() { PA -d tpl0 "$@"; }
T0 -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T0 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T0 -q --single-transaction -f "$TMP/snap.sql" >/dev/null
T0 -q <<'SQL' >/dev/null
-- pg_cron não roda no PG local: stubs com a mesma assinatura, gravando em cron.job.
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid), 0) + 1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command, active = true WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  RETURN FOUND;
END $$;

-- ── instrumentação do harness ──
CREATE TABLE _t_res (ord serial, nome text NOT NULL, ok boolean NOT NULL, detalhe text);
CREATE FUNCTION _t_assert(p_nome text, p_ok boolean, p_detalhe text DEFAULT '')
RETURNS void LANGUAGE sql AS $$ INSERT INTO _t_res (nome, ok, detalhe) VALUES (p_nome, COALESCE(p_ok, false), p_detalhe) $$;
CREATE TABLE _t_ticks (n serial, r jsonb);
-- Injeção de falha por run: 'erro' (RAISE) ou 'lento' (sleep 3s só no INSERT) no registro de
-- importação que o promote grava logo no início (AFTER → a linha existe e precisa ser DESFEITA).
CREATE TABLE _t_veneno (run_id uuid PRIMARY KEY, modo text NOT NULL);
CREATE FUNCTION _t_veneno_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_modo text;
BEGIN
  SELECT modo INTO v_modo FROM _t_veneno WHERE run_id::text = NEW.arquivo_hash;
  IF v_modo = 'erro' THEN RAISE EXCEPTION 'VENENO_TESTE run %', NEW.arquivo_hash; END IF;
  IF v_modo = 'lento' AND TG_OP = 'INSERT' THEN PERFORM pg_sleep(3); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER _t_veneno AFTER INSERT OR UPDATE ON tint_importacoes
  FOR EACH ROW EXECUTE FUNCTION _t_veneno_trg();

-- Run de fórmulas pendente na fila (plpgsql é late-bound: as colunas novas só existem pós-migration).
-- p_specs: 'COR|COD_PRODUTO|ID_BASE|QTD'.
CREATE FUNCTION _t_run(p_run uuid, p_min_atras numeric, p_specs text[],
                       p_status text DEFAULT 'complete', p_pendente boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text; a text[]; v_fid uuid;
BEGIN
  INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status,
                              started_at, completed_at, promocao_status)
  VALUES (p_run, 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', 'formulas', p_status,
          clock_timestamp() - make_interval(secs => p_min_atras * 60 + 5),
          CASE WHEN p_status = 'complete' THEN clock_timestamp() - make_interval(secs => p_min_atras * 60) END,
          CASE WHEN p_pendente THEN 'pendente' END);
  FOREACH s IN ARRAY p_specs LOOP
    a := string_to_array(s, '|');
    v_fid := gen_random_uuid();
    INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto,
                                       id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
    VALUES (v_fid, p_run, 'oben', 'L1', a[1], 'Cor ' || a[1], a[2], a[3], 'E900', 'SL', 900, false, 1);
    INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
    VALUES (p_run, v_fid, 'AX', 1, a[4]::numeric);
  END LOOP;
END $$;

-- ── seed: catálogo + 22 fórmulas oficiais (baseline promovido pelo caminho antigo) ──
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', 'automatic_primary', 'tok_test', true);

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at)
VALUES ('c0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1',
        'catalogs', 'complete', now() - interval '3 days', now() - interval '3 days');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
SELECT 'c0000000-0000-0000-0000-000000000001', 'oben', 'L1', p, 'Produto ' || p
  FROM (SELECT unnest(ARRAY['P1', 'P2']) AS p
        UNION ALL SELECT 'PX' || lpad(g::text, 2, '0') FROM generate_series(1, 20) g) x;
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
SELECT 'c0000000-0000-0000-0000-000000000001', 'oben', 'L1', b, 'Base ' || b FROM unnest(ARRAY['B1', 'B2', 'BX']) b;
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('c0000000-0000-0000-0000-000000000001', 'oben', 'L1', 'E900', 'Galão 900', 900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
SELECT 'c0000000-0000-0000-0000-000000000001'::uuid, 'oben', 'L1', p, b, 'E900'
  FROM (VALUES ('P1', 'B1'), ('P2', 'B2')) v(p, b)
UNION ALL
SELECT 'c0000000-0000-0000-0000-000000000001'::uuid, 'oben', 'L1', 'PX' || lpad(g::text, 2, '0'), 'BX', 'E900'
  FROM generate_series(1, 20) g;
SELECT tint_promote_sync_run('c0000000-0000-0000-0000-000000000001');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at)
VALUES ('f0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1',
        'formulas', 'complete', now() - interval '3 days', now() - interval '3 days');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
                                   id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'oben', 'L1', 'COR1', 'Azul',
        'P1', 'B1', 'E900', 'SL', 900, false, 1),
       ('ff000000-0000-0000-0000-000000000009', 'f0000000-0000-0000-0000-000000000001', 'oben', 'L1', 'COR9', 'Cinza',
        'P2', 'B2', 'E900', 'SL', 900, false, 2);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('f0000000-0000-0000-0000-000000000001', 'ff000000-0000-0000-0000-000000000001', 'AX', 1, 10),
       ('f0000000-0000-0000-0000-000000000001', 'ff000000-0000-0000-0000-000000000009', 'AX', 1, 7),
       ('f0000000-0000-0000-0000-000000000001', 'ff000000-0000-0000-0000-000000000009', 'VM', 2, 7);
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
                                   id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
SELECT ('ff100000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid, 'f0000000-0000-0000-0000-000000000001',
       'oben', 'L1', 'CX' || lpad(g::text, 2, '0'), 'Cor X' || g, 'PX' || lpad(g::text, 2, '0'), 'BX', 'E900',
       'SL', 900, false, 1
  FROM generate_series(1, 20) g;
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT 'f0000000-0000-0000-0000-000000000001', ('ff100000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'AX', 1, 5
  FROM generate_series(1, 20) g;
SELECT tint_promote_sync_run('f0000000-0000-0000-0000-000000000001');
SQL

SEED="$(T0 -tA -c "SELECT count(*) FILTER (WHERE desativada_em IS NULL) || '/' ||
  (SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id = fi.formula_id WHERE f.cor_id = 'COR9')
  FROM tint_formulas WHERE account = 'oben'")"
[ "$SEED" = "22/2" ] || { echo "✗ seed: esperado 22 fórmulas ativas e COR9 com 2 itens, veio $SEED"; exit 1; }

# tpl = tpl0 + 5b#1 (o corpo de prod do promote hoje)
PA -q -d postgres -c "CREATE DATABASE tpl TEMPLATE tpl0" >/dev/null
PA -q -d tpl -f "$MIG5B" >/dev/null
[ "$(PA -d tpl -tA -c "SELECT position('v_tombstones_fase5' in pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure)) > 0")" = "t" ] \
  || { echo "✗ tpl: 5b#1 não aplicou"; exit 1; }

# ═════════════════════════════ CENÁRIOS ═════════════════════════════
# Cada um roda num DB NOVO clonado do template migrado (isolamento total entre cenários).
TICK="INSERT INTO _t_ticks (r) SELECT public.tint_promocao_tick();"

cen_T1() { local db=$1; PA -d "$db" -q <<SQL
SELECT _t_run('a1000000-0000-0000-0000-00000000000a', 3, ARRAY['COR2|P1|B1|3']);
SELECT _t_run('a1000000-0000-0000-0000-00000000000b', 2, ARRAY['COR3|P2|B2|4']);
SELECT _t_run('a1000000-0000-0000-0000-00000000000c', 1,
  ARRAY(SELECT 'CX' || lpad(g::text, 2, '0') || '|PX' || lpad(g::text, 2, '0') || '|BX|6' FROM generate_series(1, 20) g));
$TICK
SELECT _t_assert('T1.ordem',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-00000000000a') = 'promovido'
  AND (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-00000000000b') = 'pendente'
  AND (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-00000000000c') = 'pendente',
  (SELECT string_agg(promocao_status, ',' ORDER BY id) FROM tint_sync_runs WHERE id::text LIKE 'a1%'));
SELECT _t_assert('T1.efeito',
  (SELECT count(*) FROM tint_formulas f JOIN tint_formula_itens fi ON fi.formula_id = f.id
    WHERE f.cor_id = 'COR2' AND f.desativada_em IS NULL AND fi.qtd_ml = 3) = 1
  AND (SELECT promovido_em IS NOT NULL AND promocao_tentativas = 1 FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-00000000000a'));
$TICK
$TICK
SELECT _t_assert('T1.lote20',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-00000000000c') = 'promovido'
  AND (SELECT count(DISTINCT f.cor_id) FROM tint_formulas f JOIN tint_formula_itens fi ON fi.formula_id = f.id
        WHERE f.cor_id LIKE 'CX%' AND f.desativada_em IS NULL AND fi.qtd_ml = 6) = 20,
  (SELECT count(DISTINCT (cod_produto, id_base))::text || ' pares' FROM tint_staging_formulas WHERE sync_run_id = 'a1000000-0000-0000-0000-00000000000c'));
$TICK
SELECT _t_assert('T1.vazia', (SELECT r->>'acao' FROM _t_ticks ORDER BY n DESC LIMIT 1) = 'fila_vazia',
  (SELECT r::text FROM _t_ticks ORDER BY n DESC LIMIT 1));
SELECT _t_assert('T1.status_intacto',
  (SELECT bool_and(status = 'complete') FROM tint_sync_runs WHERE id::text LIKE 'a1%'));
SQL
}

cen_T2() { local db=$1; PA -d "$db" -q <<SQL
INSERT INTO _t_veneno VALUES ('a2000000-0000-0000-0000-00000000000a', 'erro');
SELECT _t_run('a2000000-0000-0000-0000-00000000000a', 3, ARRAY['COR2|P1|B1|3']);
SELECT _t_run('a2000000-0000-0000-0000-00000000000b', 2, ARRAY['COR3|P2|B2|4']);
$TICK
SELECT _t_assert('T2.retry1',
  (SELECT promocao_status = 'pendente' AND promocao_tentativas = 1 AND promocao_erro LIKE 'P0001: VENENO_TESTE%'
     FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a'),
  (SELECT promocao_status || '/' || promocao_tentativas || '/' || COALESCE(promocao_erro, 'NULL') FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a'));
SELECT _t_assert('T2.backoff_1min',
  (SELECT promocao_proxima_em BETWEEN clock_timestamp() + interval '50 seconds' AND clock_timestamp() + interval '61 seconds'
     FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a'));
SELECT _t_assert('T2.log',
  (SELECT count(*) FROM tint_sync_errors WHERE sync_run_id = 'a2000000-0000-0000-0000-00000000000a'
      AND entity_type = 'promotion' AND error_details->>'origem' = 'tint_promocao_tick'
      AND error_details->>'sqlstate' = 'P0001' AND (error_details->>'tentativa')::int = 1) = 1);
SELECT _t_assert('T2.parcial_desfeito',
  NOT EXISTS (SELECT 1 FROM tint_importacoes WHERE arquivo_hash = 'a2000000-0000-0000-0000-00000000000a'));
-- cabeça em backoff: o 2º item NÃO pode furar a fila
$TICK
SELECT _t_assert('T2.backoff_respeitado',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000b') = 'pendente'
  AND (SELECT promocao_tentativas FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a') = 1,
  (SELECT r::text FROM _t_ticks ORDER BY n DESC LIMIT 1));
UPDATE tint_sync_runs SET promocao_proxima_em = clock_timestamp() - interval '1 second' WHERE id = 'a2000000-0000-0000-0000-00000000000a';
$TICK
SELECT _t_assert('T2.backoff_2min',
  (SELECT promocao_tentativas = 2 AND promocao_status = 'pendente'
          AND promocao_proxima_em BETWEEN clock_timestamp() + interval '110 seconds' AND clock_timestamp() + interval '121 seconds'
     FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a'));
UPDATE tint_sync_runs SET promocao_proxima_em = clock_timestamp() - interval '1 second' WHERE id = 'a2000000-0000-0000-0000-00000000000a';
$TICK
SELECT _t_assert('T2.esgota',
  (SELECT promocao_tentativas = 3 AND promocao_status = 'erro' AND promocao_proxima_em IS NULL
     FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a'),
  (SELECT promocao_status || '/' || promocao_tentativas FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a'));
SELECT _t_assert('T2.status_intacto',
  (SELECT status FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000a') = 'complete');
$TICK
SELECT _t_assert('T2.fila_segue',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a2000000-0000-0000-0000-00000000000b') = 'promovido');
SQL
}

cen_T3() { local db=$1 rc=0 out
PA -d "$db" -q <<'SQL'
INSERT INTO _t_veneno VALUES ('a3000000-0000-0000-0000-00000000000a', 'lento');
SELECT _t_run('a3000000-0000-0000-0000-00000000000a', 1, ARRAY['COR2|P1|B1|3']);
SQL
# EXATAMENTE o comando do cron (SET + SELECT no mesmo envio), com teto de 1s contra um promote de 3s.
out="$(PA -d "$db" -tA -c "SET statement_timeout = '1s'; SELECT public.tint_promocao_tick();" 2>&1)" || rc=$?
PA -d "$db" -q <<SQL
SELECT _t_assert('T3.cron_rc0', $rc = 0, \$d\$$(printf '%s' "$out" | tr -d '$' | head -c 300)\$d\$);
SELECT _t_assert('T3.timeout_capturado',
  (SELECT promocao_status = 'pendente' AND promocao_tentativas = 1 AND promocao_erro LIKE '57014: %'
     FROM tint_sync_runs WHERE id = 'a3000000-0000-0000-0000-00000000000a'),
  (SELECT promocao_status || '/' || promocao_tentativas || '/' || COALESCE(promocao_erro, 'NULL') FROM tint_sync_runs WHERE id = 'a3000000-0000-0000-0000-00000000000a'));
SELECT _t_assert('T3.parcial_desfeito',
  NOT EXISTS (SELECT 1 FROM tint_importacoes WHERE arquivo_hash = 'a3000000-0000-0000-0000-00000000000a'));
SELECT _t_assert('T3.log',
  (SELECT count(*) FROM tint_sync_errors WHERE sync_run_id = 'a3000000-0000-0000-0000-00000000000a'
      AND error_details->>'sqlstate' = '57014') = 1);
SQL
}

cen_T4() { local db=$1 i n=0 bgrc visto=0
PA -d "$db" -q <<'SQL'
INSERT INTO _t_veneno VALUES ('a4000000-0000-0000-0000-00000000000a', 'lento');
SELECT _t_run('a4000000-0000-0000-0000-00000000000a', 1, ARRAY['COR2|P1|B1|3']);
SQL
( PA -d "$db" -q -c "$TICK" >"$TMP/$db.bg" 2>&1; echo $? >"$TMP/$db.bgrc" ) &
local bg=$!
# espera COM TETO (5s) e ramo que diz "não consegui": o tick lento tem de estar segurando o lock.
for i in $(seq 1 50); do
  n="$(PA -d "$db" -tA -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")"
  if [ "$n" -gt 0 ]; then visto=1; break; fi
  sleep 0.1
done
if [ "$visto" = 1 ]; then PA -d "$db" -q -c "$TICK"; fi
wait "$bg" || true
bgrc="$(cat "$TMP/$db.bgrc" 2>/dev/null || echo ausente)"
PA -d "$db" -q <<SQL
SELECT _t_assert('T4.lock_observado', $visto = 1, 'sem lock advisory visível em 5s — cenário não exercitado');
SELECT _t_assert('T4.pula',
  (SELECT count(*) FROM _t_ticks WHERE r->>'acao' = 'pulado_tick_concorrente') = 1,
  (SELECT string_agg(r->>'acao', ',' ORDER BY n) FROM _t_ticks));
SELECT _t_assert('T4.lento_termina', '$bgrc' = '0'
  AND (SELECT promocao_status = 'promovido' AND promocao_tentativas = 1 FROM tint_sync_runs WHERE id = 'a4000000-0000-0000-0000-00000000000a'),
  'bg rc=$bgrc');
SQL
}

cen_T5() { local db=$1; PA -d "$db" -q <<SQL
SELECT _t_run('a5000000-0000-0000-0000-00000000000d', 3, ARRAY['COR9|P2|B2|8']);
-- snapshot SN (2 chunks) chega DEPOIS de RD e ANTES de RE: as 22 chaves ativas menos a COR1
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks,
                                 chunk_index, keys, created_at, aplicacao_status)
SELECT 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', '55000000-0000-0000-0000-000000000001', 'formulas',
       clock_timestamp() - interval '2 minutes 30 seconds', 2, c.idx, c.ks, clock_timestamp() - interval '2 minutes', 'pendente'
  FROM (SELECT 0 AS idx, to_jsonb(ARRAY['COR9|P2|B2|false']) AS ks
        UNION ALL
        SELECT 1, (SELECT jsonb_agg('CX' || lpad(g::text, 2, '0') || '|PX' || lpad(g::text, 2, '0') || '|BX|false')
                     FROM generate_series(1, 20) g)) c;
SELECT _t_run('a5000000-0000-0000-0000-00000000000e', 1, ARRAY['COR6|P2|B2|2']);
$TICK
SELECT _t_assert('T5.ordem1',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a5000000-0000-0000-0000-00000000000d') = 'promovido'
  AND (SELECT bool_and(aplicacao_status = 'pendente') FROM tint_keys_snapshots WHERE snapshot_id = '55000000-0000-0000-0000-000000000001')
  AND (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a5000000-0000-0000-0000-00000000000e') = 'pendente');
-- ⚠️ Efeito REAL da fila (herdado do latest-staging-por-chave, que não filtra por run): o promote
-- do RD re-expande o par P2/B2 e JÁ promove a COR6 do RE (ingerida depois, ainda na fila).
SELECT _t_assert('T5.latest_adianta',
  (SELECT desativada_em IS NULL FROM tint_formulas WHERE cor_id = 'COR6'));
$TICK
-- O SN (gerado ANTES da COR6 existir) desativa COR1 E a COR6 adiantada: janela transitória.
SELECT _t_assert('T5.aplica',
  (SELECT desativada_em IS NOT NULL FROM tint_formulas WHERE cor_id = 'COR1')
  AND (SELECT desativada_em IS NOT NULL FROM tint_formulas WHERE cor_id = 'COR6')
  AND (SELECT (r->'resultado'->>'desativadas')::int FROM _t_ticks ORDER BY n DESC LIMIT 1) = 2
  AND (SELECT count(*) FROM tint_formulas WHERE desativada_em IS NULL) = 21
  AND (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a5000000-0000-0000-0000-00000000000e') = 'pendente',
  (SELECT r::text FROM _t_ticks ORDER BY n DESC LIMIT 1));
SELECT _t_assert('T5.chunks_juntos',
  (SELECT count(*) FILTER (WHERE aplicacao_status = 'aplicado' AND aplicado_em IS NOT NULL AND aplicacao_tentativas = 1)
     FROM tint_keys_snapshots WHERE snapshot_id = '55000000-0000-0000-0000-000000000001') = 2);
$TICK
SELECT _t_assert('T5.ordem3',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a5000000-0000-0000-0000-00000000000e') = 'promovido');
-- ...e CONVERGE: o RE (depois do SN na fila) reativa a COR6; a COR1 (fora da fonte) segue inativa.
SELECT _t_assert('T5.converge',
  (SELECT desativada_em IS NULL FROM tint_formulas WHERE cor_id = 'COR6')
  AND (SELECT desativada_em IS NOT NULL FROM tint_formulas WHERE cor_id = 'COR1'));
-- SB: snapshot com 1 chave de 22 → blast radius → ok:false → erro DIRETO, sem retry
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks,
                                 chunk_index, keys, aplicacao_status)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', '55000000-0000-0000-0000-00000000000b', 'formulas',
        clock_timestamp(), 1, 0, '["COR9|P2|B2|false"]'::jsonb, 'pendente');
$TICK
SELECT _t_assert('T5.blast_erro_direto',
  (SELECT aplicacao_status = 'erro' AND aplicacao_tentativas = 1 AND aplicacao_proxima_em IS NULL
          AND aplicacao_erro LIKE 'RPC tint_apply_keys_snapshot ok=false:%blast radius%'
     FROM tint_keys_snapshots WHERE snapshot_id = '55000000-0000-0000-0000-00000000000b'),
  (SELECT aplicacao_status || '/' || aplicacao_tentativas || '/' || COALESCE(aplicacao_erro, 'NULL') FROM tint_keys_snapshots WHERE snapshot_id = '55000000-0000-0000-0000-00000000000b'));
SELECT _t_assert('T5.blast_nao_desativou',
  (SELECT count(*) FROM tint_formulas WHERE desativada_em IS NULL) = 22);
SQL
}

cen_T6() { local db=$1; PA -d "$db" -q <<SQL
SELECT _t_run('a6000000-0000-0000-0000-00000000000a', 1, ARRAY['COR2|P1|B1|3'], 'running', true);
$TICK
SELECT _t_assert('T6.nao_complete',
  (SELECT promocao_status = 'erro' AND promocao_erro LIKE 'run com status running%' AND promovido_em IS NULL
     FROM tint_sync_runs WHERE id = 'a6000000-0000-0000-0000-00000000000a')
  AND NOT EXISTS (SELECT 1 FROM tint_formulas WHERE cor_id = 'COR2'),
  (SELECT r::text FROM _t_ticks ORDER BY n DESC LIMIT 1));
SQL
}

cen_T7() { local db=$1; PA -d "$db" -q <<SQL
-- RANT: limpou 50 receitas, INGERIDO há 2 dias, PROMOVIDO há 1 hora (fila atrasada).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at,
                            promocao_status, promovido_em, metadata)
VALUES ('a7000000-0000-0000-0000-0000000000a0', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', 'formulas',
        'complete', now() - interval '2 days', now() - interval '2 days', 'promovido', now() - interval '1 hour',
        '{"receitas_limpas": 50}'::jsonb);
-- RLIMP: tríade declarada (base pura) na COR9 → 1 limpeza candidata; 50 + 1 > cap 50 → barra.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at, promocao_status)
VALUES ('a7000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', 'formulas',
        'complete', clock_timestamp(), clock_timestamp(), 'pendente');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
                                   id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, is_base_pura)
VALUES ('f7000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-0000000000a1', 'oben', 'L1', 'COR9', 'Cinza',
        'P2', 'B2', 'E900', 'SL', 900, false, 0, true);
$TICK
SELECT _t_assert('T7.promoveu', (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a7000000-0000-0000-0000-0000000000a1') = 'promovido',
  (SELECT r::text FROM _t_ticks ORDER BY n DESC LIMIT 1));
SELECT _t_assert('T7.cap_conta_promocao',
  (SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id = fi.formula_id WHERE f.cor_id = 'COR9') = 2
  AND (SELECT count(*) FROM tint_sync_errors WHERE sync_run_id = 'a7000000-0000-0000-0000-0000000000a1'
        AND entity_type = 'formula_promote' AND error_message LIKE 'limpeza em massa suspeita%') = 1,
  (SELECT count(*)::text || ' itens COR9' FROM tint_formula_itens fi JOIN tint_formulas f ON f.id = fi.formula_id WHERE f.cor_id = 'COR9'));
SQL
}

cen_T8() { local db=$1; PA -d "$db" -q <<SQL
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks,
                                 chunk_index, keys, created_at, aplicacao_status)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', '58000000-0000-0000-0000-00000000000a', 'formulas',
        now() - interval '40 days', 1, 0, '[]'::jsonb, now() - interval '40 days', 'pendente'),
       ('aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'L1', '58000000-0000-0000-0000-00000000000b', 'formulas',
        now() - interval '40 days', 1, 0, '[]'::jsonb, now() - interval '40 days', 'aplicado');
SELECT tint_promote_sync_run('f0000000-0000-0000-0000-000000000001');
SELECT _t_assert('T8.purge_poupa_pendente',
  EXISTS (SELECT 1 FROM tint_keys_snapshots WHERE snapshot_id = '58000000-0000-0000-0000-00000000000a'));
SELECT _t_assert('T8.purge_segue',
  NOT EXISTS (SELECT 1 FROM tint_keys_snapshots WHERE snapshot_id = '58000000-0000-0000-0000-00000000000b'));
SQL
}

cen_T9() { local db=$1; PA -d "$db" -q <<SQL
SELECT _t_run('a9000000-0000-0000-0000-00000000000a', 10, ARRAY['COR2|P1|B1|3'], 'complete', false);
UPDATE tint_sync_runs SET promocao_status = 'erro', promocao_tentativas = 3, promocao_erro = 'x' WHERE id = 'a9000000-0000-0000-0000-00000000000a';
SELECT _t_run('a9000000-0000-0000-0000-00000000000b', 60, ARRAY['COR3|P2|B2|4']);
SELECT tint_promocao_watchdog();
SELECT _t_assert('T9.alerta_erro',
  (SELECT (contexto->>'_n')::int = 1 AND severidade = 'aviso' FROM fin_alertas
    WHERE company = 'oben' AND tipo = 'tint_promocao_erro' AND dismissed_at IS NULL));
SELECT _t_assert('T9.alerta_atraso',
  (SELECT (contexto->>'_n')::int = 1 FROM fin_alertas
    WHERE company = 'oben' AND tipo = 'tint_promocao_atrasada' AND dismissed_at IS NULL));
SELECT _t_assert('T9.email',
  (SELECT count(*) FROM fornecedor_alerta WHERE titulo LIKE '[Tintometrico] %promocao%' AND status = 'pendente_notificacao') = 2);
UPDATE tint_sync_runs SET promocao_status = 'descartado' WHERE id = 'a9000000-0000-0000-0000-00000000000a';
UPDATE tint_sync_runs SET promocao_status = 'promovido' WHERE id = 'a9000000-0000-0000-0000-00000000000b';
SELECT tint_promocao_watchdog();
SELECT _t_assert('T9.dispensa',
  NOT EXISTS (SELECT 1 FROM fin_alertas WHERE tipo IN ('tint_promocao_erro', 'tint_promocao_atrasada') AND dismissed_at IS NULL)
  AND (SELECT count(*) FROM fin_alertas WHERE tipo IN ('tint_promocao_erro', 'tint_promocao_atrasada') AND dismissed_at IS NOT NULL) = 2);
-- erro VELHO (10 dias) não resolvido continua alertando
SELECT _t_run('a9000000-0000-0000-0000-00000000000c', 14400, ARRAY['COR4|P1|B1|3'], 'complete', false);
UPDATE tint_sync_runs SET promocao_status = 'erro', promocao_tentativas = 3, promocao_erro = 'x' WHERE id = 'a9000000-0000-0000-0000-00000000000c';
SELECT tint_promocao_watchdog();
SELECT _t_assert('T9.sem_janela',
  EXISTS (SELECT 1 FROM fin_alertas WHERE company = 'oben' AND tipo = 'tint_promocao_erro' AND dismissed_at IS NULL));
SQL
}

cen_T10() { local db=$1 o1 o2 a1=false a2=false
o1="$(PA -d "$db" -tA -c "\\set VERBOSITY verbose" -c "SET ROLE authenticated" -c "SELECT public.tint_promocao_tick()" 2>&1 || true)"
o2="$(PA -d "$db" -tA -c "\\set VERBOSITY verbose" -c "SET ROLE authenticated" -c "SELECT public.tint_promocao_watchdog()" 2>&1 || true)"
# 42501 SOZINHO casaria "permission denied for schema" (falso verde): exige o nome da função junto.
case "$o1" in *42501*tint_promocao_tick*) a1=true ;; esac
case "$o2" in *42501*tint_promocao_watchdog*) a2=true ;; esac
PA -d "$db" -q <<SQL
SELECT _t_assert('T10.acl_tick', $a1, \$d\$$(printf '%s' "$o1" | tr -d '$' | head -c 200)\$d\$);
SELECT _t_assert('T10.acl_watchdog', $a2, \$d\$$(printf '%s' "$o2" | tr -d '$' | head -c 200)\$d\$);
SQL
}

cen_T11() { local db=$1 antes depois rc=0 mig=$2
antes="$(PA -d "$db" -tA -c "SELECT md5(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure))
  || md5(pg_get_functiondef('public.tint_promocao_tick()'::regprocedure))
  || md5(pg_get_functiondef('public.tint_promocao_watchdog()'::regprocedure))")"
PA -d "$db" -q -f "$mig" >/dev/null 2>"$TMP/$db.reapply" || rc=$?
depois="$(PA -d "$db" -tA -c "SELECT md5(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure))
  || md5(pg_get_functiondef('public.tint_promocao_tick()'::regprocedure))
  || md5(pg_get_functiondef('public.tint_promocao_watchdog()'::regprocedure))")"
PA -d "$db" -q <<SQL
SELECT _t_assert('T11.idempotente', $rc = 0 AND '$antes' = '$depois'
  AND (SELECT count(*) FROM cron.job WHERE jobname IN ('tint-promocao-tick', 'tint-promocao-watchdog')) = 2,
  'rc=$rc');
SQL
}

# T12 roda FORA da suíte (DB sem a 5b#1): a migration tem de abortar INTEIRA.
cen_T12() { local mig=$1 rc=0 out
PA -q -d postgres -c "DROP DATABASE IF EXISTS t12" -c "CREATE DATABASE t12 TEMPLATE tpl0" >/dev/null
out="$(PA -d t12 -q -f "$mig" 2>&1)" || rc=$?
PA -d t12 -q <<SQL
SELECT _t_assert('T12.aborta_sem_5b1',
  $rc <> 0 AND position('promocao-assincrona ABORTADA' in \$o\$$(printf '%s' "$out" | tr -d '$' | head -c 400)\$o\$) > 0
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tint_sync_runs' AND column_name = 'promocao_status')
  AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname LIKE 'tint-promocao%'), 'rc=$rc');
SQL
PA -d t12 -tA -c "SELECT 'RES|' || nome || '|' || CASE WHEN ok THEN 't' ELSE 'f' END || '|' || COALESCE(detalhe, '') FROM _t_res ORDER BY ord"
}

CENARIOS="T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 T11"

# suite <migration> <sabotagem-sql-ou-vazio> → imprime RES|nome|ok|detalhe de todos os asserts
suite() {
  local mig=$1 sab=$2 c db
  PA -q -d postgres -c "DROP DATABASE IF EXISTS tplm" -c "CREATE DATABASE tplm TEMPLATE tpl" >/dev/null
  if ! PA -d tplm -q -f "$mig" >/dev/null 2>"$TMP/apply.err"; then
    echo "RES|APPLY|f|$(head -c 300 "$TMP/apply.err" | tr '\n' ' ')"
    return 0
  fi
  if [ -n "$sab" ]; then
    if ! PA -d tplm -q -f "$sab" >/dev/null 2>"$TMP/sab.err"; then
      echo "RES|SABOTAGEM|f|$(head -c 300 "$TMP/sab.err" | tr '\n' ' ')"
      return 0
    fi
  fi
  for c in $CENARIOS; do
    db="$(echo "s_$c" | tr 'A-Z' 'a-z')"
    PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE tplm" >/dev/null
    if [ "$c" = T11 ]; then
      cen_T11 "$db" "$mig" >/dev/null 2>"$TMP/$db.err" || echo "RES|$c.EXEC|f|$(head -c 300 "$TMP/$db.err" | tr '\n' ' ')"
    else
      "cen_$c" "$db" >/dev/null 2>"$TMP/$db.err" || echo "RES|$c.EXEC|f|$(head -c 300 "$TMP/$db.err" | tr '\n' ' ')"
    fi
    PA -d "$db" -tA -c "SELECT 'RES|' || nome || '|' || CASE WHEN ok THEN 't' ELSE 'f' END || '|' || COALESCE(detalhe, '') FROM _t_res ORDER BY ord" 2>/dev/null || true
  done
  cen_T12 "$mig"
}

falhas_de() { grep '^RES|' | awk -F'|' '$3 != "t" {print $2}' | sort | tr '\n' ' ' | sed 's/ $//'; }

# ═════════════════════════════ CONTROLE (migration real) ═════════════════════════════
echo "════ CONTROLE — migration real ════"
CTRL="$(suite "$MIG" "")"
printf '%s\n' "$CTRL" | grep '^RES|' | awk -F'|' '{ printf "  %s %s%s\n", ($3=="t"?"✓":"✗"), $2, ($3=="t"?"":"  ["$4"]") }'
NTOT="$(printf '%s\n' "$CTRL" | grep -c '^RES|')"
FCTRL="$(printf '%s\n' "$CTRL" | falhas_de)"
NESP=43   # nº EXATO de asserts: assert que some (cenário que parou no meio) é falha, não verde
if [ -n "$FCTRL" ] || [ "$NTOT" -ne "$NESP" ]; then
  echo "✗ CONTROLE NÃO-VERDE (falhas: [${FCTRL}] · asserts: $NTOT de $NESP) — abortando ANTES das falsificações"
  exit 1
fi
echo "  → controle verde: $NTOT asserts"

# ═════════════════════════════ FALSIFICAÇÕES ═════════════════════════════
FALSOS=0
# fals <nome> <esperado (nomes ordenados, espaço)> <migration> <sabotagem-sql>
fals() {
  local nome=$1 esperado=$2 mig=$3 sab=$4 got
  got="$(suite "$mig" "$sab" | falhas_de)"
  if [ "$got" = "$esperado" ]; then
    echo "  ✓ $nome: vermelho EXATO [$got]"
  else
    echo "  ✗ $nome: esperado [$esperado], veio [$got]"
    FALSOS=$((FALSOS + 1))
  fi
}
sabmig() {  # sabmig <arquivo-saida> <sed-expr> — falha se o sed não mudou nada
  sed "$2" "$MIG" > "$1"
  if cmp -s "$MIG" "$1"; then echo "✗ sabotagem no-op ($2) — âncora sumiu da migration"; exit 1; fi
}
# sabpromote <arquivo> <de> <para> — reverte um ajuste NO CORPO do promote, depois da migration.
sabpromote() {
  cat > "$1" <<SQL
DO \$s\$
DECLARE v text := pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure);
BEGIN
  IF position(\$a\$$2\$a\$ in v) = 0 THEN RAISE EXCEPTION 'sabotagem no-op: âncora ausente'; END IF;
  EXECUTE replace(v, \$a\$$2\$a\$, \$b\$$3\$b\$);
END \$s\$;
SQL
}

echo "════ FALSIFICAÇÕES ════"
sabmig "$TMP/f1.sql" 's/    FROM cabeca c$/    FROM fila c/'
fals "F1 sem FIFO estrito (qualquer item elegível fura a cabeça em backoff)" "T2.backoff_respeitado" "$TMP/f1.sql" ""

sabmig "$TMP/f2.sql" 's/EXCEPTION WHEN query_canceled OR others THEN/EXCEPTION WHEN others THEN/'
fals "F2 só OTHERS (timeout não capturado)" "T3.cron_rc0 T3.log T3.timeout_capturado" "$TMP/f2.sql" ""

sabmig "$TMP/f3.sql" "s/IF NOT pg_try_advisory_xact_lock(hashtext('tint_promocao_tick')) THEN/IF false THEN/"
fals "F3 sem try-lock do tick" "T4.pula" "$TMP/f3.sql" ""

sabpromote "$TMP/f4.sql" "AND COALESCE(tr.promovido_em, tr.started_at) > now()" "AND tr.started_at > now()"
# F4/F5 derrubam TAMBÉM o T11: re-aplicar a migration sobre um promote que PERDEU o ajuste faz a
# postcondição P4 abortar (detecta o drift) — é desenho, não efeito colateral.
fals "F4 cap de limpezas pela INGESTÃO (bypass com fila)" "T11.idempotente T7.cap_conta_promocao" "$MIG" "$TMP/f4.sql"

sabpromote "$TMP/f5.sql" "
    AND aplicacao_status IS DISTINCT FROM 'pendente';" ";"
fals "F5 purge apaga snapshot pendente" "T11.idempotente T8.purge_poupa_pendente" "$MIG" "$TMP/f5.sql"

sabmig "$TMP/f6.sql" "s/FROM tint_sync_runs WHERE promocao_status = 'erro';/FROM tint_sync_runs WHERE promocao_status = 'erro' AND completed_at > now() - interval '7 days';/"
fals "F6 watchdog com janela de 7 dias" "T9.sem_janela" "$TMP/f6.sql" ""

sabmig "$TMP/f7.sql" 's/v_max_tentativas constant int := 3;/v_max_tentativas constant int := 99;/'
fals "F7 sem teto de tentativas" "T2.esgota T2.fila_segue" "$TMP/f7.sql" ""

sabmig "$TMP/f8.sql" "s/IF v_status_run IS DISTINCT FROM 'complete' THEN/IF false THEN/"
fals "F8 promove run sem ingestão confirmada" "T6.nao_complete" "$TMP/f8.sql" ""

sabmig "$TMP/f9.sql" 's/ELSIF v_ok IS FALSE THEN/ELSIF false THEN/'
fals "F9 ok:false do RPC vira retry" "T5.blast_erro_direto" "$TMP/f9.sql" ""

sabmig "$TMP/f10.sql" 's/REVOKE EXECUTE ON FUNCTION public.tint_promocao_tick() FROM PUBLIC, anon, authenticated;/GRANT EXECUTE ON FUNCTION public.tint_promocao_tick() TO authenticated;/'
fals "F10 tick aberto a authenticated (a postcondição P6 aborta o apply)" "APPLY" "$TMP/f10.sql" ""

printf '%s\n' "GRANT EXECUTE ON FUNCTION public.tint_promocao_tick() TO authenticated;" > "$TMP/f11.sql"
fals "F11 tick aberto a authenticated DEPOIS da migration" "T10.acl_tick" "$MIG" "$TMP/f11.sql"

echo ""
if [ "$FALSOS" -ne 0 ]; then
  echo "✗ $FALSOS falsificação(ões) NÃO produziram o vermelho exato — algum assert não tem dente (ou morde demais)"
  exit 1
fi
echo "✅ PROVA OK — controle verde ($NTOT asserts) + 11 falsificações com vermelho exato · locale=$LOC"

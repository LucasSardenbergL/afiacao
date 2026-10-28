#!/usr/bin/env bash
# test-tint-consumo-corante.sh — prova PG17 da migration 20261028100000_tint_consumo_corante.sql
# (giro de corante, Fase 1: tabelas do consumo, staging saneado, promoção de preparações, cobertura
# derivada, plano de extração e a raia do tick).
#
# Plano: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md (Tasks 1 e 2).
# Spec:  docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md.
#
# O SNAPSHOT É O VIVO (supabase/schema-snapshot.sql): ele já traz o tick, o staging de preparações e
# o promote de catálogos, que esta migration estende. Os GRANTs do Supabase (o dump não os traz) são
# espelhados no template — sem eles, "customer lê 0 linhas" passaria por permission denied, não por
# RLS, e a prova de ACL não teria dente.
#
# Falsificações (F*) na MESMA invocação do controle verde: cada sabotagem exige o CONJUNTO EXATO de
# asserts vermelhos. Controle não-verde aborta antes da 1ª sabotagem.
#
#   db/test-tint-consumo-corante.sh               → controle; imprime `PASS=<n>  FAIL=<m>`
#   db/test-tint-consumo-corante.sh --falsificar  → controle + sabotagens NA MESMA invocação
#   HARNESS_LOCALE=pt_BR.UTF-8 db/test-tint-consumo-corante.sh   → o mesmo no outro locale
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5467}}"
MODO=normal
case "${1:-}" in
  --falsificar) MODO=falsificar ;;
  "") ;;
  *) echo "uso: $0 [--falsificar]"; exit 2 ;;
esac
LOC="${HARNESS_LOCALE:-C}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-consumo.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
MIG="$REPO_ROOT/supabase/migrations/20261028100000_tint_consumo_corante.sql"
export LC_ALL=C LANG=C

[ -f "$SNAP" ] || { echo "INFRA: snapshot ausente: $SNAP"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
# PG DESCARTÁVEL: durabilidade desligada e clone de template por FILE_COPY (ver test-tint-promocao-assincrona.sh).
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
PA() { PGOPTIONS="-c client_min_messages=warning" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -v ON_ERROR_STOP=1 "$@"; }
echo "PG: $("$PGBIN/postgres" --version) · locale=$LOC"

# ── template base: stubs + prelude + snapshot vivo + grants do Supabase + instrumentação + seed ─────
PA -q -d postgres -c "CREATE DATABASE tpl0" >/dev/null
T0() { PA -d tpl0 "$@"; }
T0 -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T0 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T0 -q --single-transaction -f "$TMP/snap.sql" >/dev/null
T0 -q <<'SQL' >/dev/null
-- Supabase: as roles da API têm ALL nas tabelas de public (default privileges) e o service_role
-- fura RLS. O dump não carrega isso; sem o espelho, a prova de ACL/RLS não morderia.
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- ── instrumentação do harness ──
CREATE TABLE _t_res (ord serial, nome text NOT NULL, ok boolean NOT NULL, detalhe text);
GRANT ALL ON _t_res TO PUBLIC;
GRANT ALL ON SEQUENCE _t_res_ord_seq TO PUBLIC;
CREATE FUNCTION _t_assert(p_nome text, p_ok boolean, p_detalhe text DEFAULT '')
RETURNS void LANGUAGE sql AS $$ INSERT INTO _t_res (nome, ok, detalhe) VALUES (p_nome, COALESCE(p_ok, false), p_detalhe) $$;
-- Executa e devolve 'OK' ou a SQLSTATE ESPERÁVEL; qualquer outra exceção SOBE (cenário vira EXEC vermelho).
CREATE FUNCTION _t_sqlstate(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION
  WHEN check_violation        THEN RETURN '23514';
  WHEN insufficient_privilege THEN RETURN '42501';
  WHEN not_null_violation     THEN RETURN '23502';
END $$;

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
-- Supabase: funções novas de public nascem executáveis pelas roles da API (o REVOKE é que fecha).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ── helpers das provas da Task 2 (plpgsql é late-bound: as tabelas só existem pós-migration) ──
CREATE TABLE _t_ticks (n serial, r jsonb);
-- Drena o consumidor de preparações até a fila esvaziar (ou o lock estar com outra sessão).
CREATE FUNCTION _t_drenar() RETURNS int LANGUAGE plpgsql AS $$
DECLARE v jsonb; i int := 0;
BEGIN
  LOOP
    v := public.tint_preparacoes_tick();
    INSERT INTO _t_ticks (r) VALUES (v);
    i := i + 1;
    EXIT WHEN v ->> 'acao' IN ('fila_vazia', 'pulado_tick_concorrente') OR i >= 3000;
  END LOOP;
  RETURN i;
END $$;
-- Plano semeado direto (os testes de promoção não dependem do algoritmo do plano).
CREATE FUNCTION _t_plano(p_ext uuid, p_modo text, p_desde timestamptz, p_ate timestamptz, p_store text DEFAULT 'M01')
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tint_consumo_planos (extracao_id, account, store_code, modo, janela_desde, janela_ate, criado_em, expira_em)
  VALUES (p_ext, 'oben', p_store, p_modo, p_desde, p_ate, p_desde, p_desde + interval '30 minutes');
  RETURN p_ext;
END $$;
-- Extração completa semeada direto (provas de cobertura e de plano).
CREATE FUNCTION _t_ext(p_store text, p_desde timestamptz, p_ate timestamptz, p_cons timestamptz,
                       p_completa boolean DEFAULT true, p_modo text DEFAULT 'incremental')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO tint_consumo_planos (extracao_id, account, store_code, modo, janela_desde, janela_ate, criado_em, expira_em)
  VALUES (v, 'oben', p_store, p_modo, p_desde, p_ate, p_cons, p_cons + interval '30 minutes');
  INSERT INTO tint_consumo_extracoes (extracao_id, account, store_code, modo, janela_desde, janela_ate, consultado_em,
                                      total_lotes, criada_em, completa_em)
  VALUES (v, 'oben', p_store, p_modo, p_desde, p_ate, p_cons, 1, p_cons, CASE WHEN p_completa THEN p_cons END);
  RETURN v;
END $$;
-- Um lote como a edge o monta: run preparations complete+pendente, staging e manifesto.
-- p_specs: 'ID|data_dosagem|corante:qtd,corante:qtd' (válida) ou 'ID|data_dosagem|!motivo' (rejeitada).
CREATE FUNCTION _t_lote(p_run uuid, p_ext uuid, p_lote int, p_total int, p_started timestamptz, p_specs text[],
                        p_over jsonb DEFAULT '{}'::jsonb, p_store text DEFAULT 'M01')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  pl record; s text; a text[]; it text; b text[]; v_pid uuid; v_ord int;
  v_ate timestamptz; v_cons timestamptz; v_np int := 0; v_nr int := 0; v_ni int := 0; v_min text; v_max text;
BEGIN
  SELECT * INTO pl FROM tint_consumo_planos WHERE extracao_id = p_ext;
  v_ate := COALESCE((p_over ->> 'janela_ate')::timestamptz, pl.janela_ate);
  v_cons := COALESCE((p_over ->> 'consultado_em')::timestamptz, v_ate);
  INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at,
                              promocao_status)
  VALUES (p_run, 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', p_store, 'preparations', 'complete',
          p_started, p_started + interval '1 second', 'pendente');
  FOREACH s IN ARRAY p_specs LOOP
    a := string_to_array(s, '|');
    v_pid := gen_random_uuid();
    IF left(a[3], 1) = '!' THEN
      INSERT INTO tint_staging_preparacoes (id, sync_run_id, account, store_code, preparacao_id, data_preparacao,
                                            rejeicao_motivo)
      VALUES (v_pid, p_run, 'oben', p_store, a[1], a[2]::timestamptz, substr(a[3], 2));
      v_nr := v_nr + 1;
    ELSE
      INSERT INTO tint_staging_preparacoes (id, sync_run_id, account, store_code, preparacao_id, data_preparacao)
      VALUES (v_pid, p_run, 'oben', p_store, a[1], a[2]::timestamptz);
      v_np := v_np + 1;
      v_ord := 0;
      FOREACH it IN ARRAY string_to_array(a[3], ',') LOOP
        b := string_to_array(it, ':');
        v_ord := v_ord + 1;
        INSERT INTO tint_staging_preparacao_itens (sync_run_id, staging_preparacao_id, id_corante, ordem, qtd_ml)
        VALUES (p_run, v_pid, b[1], v_ord, b[2]::numeric);
        v_ni := v_ni + 1;
      END LOOP;
    END IF;
  END LOOP;
  SELECT min(sp.preparacao_id COLLATE "C"), max(sp.preparacao_id COLLATE "C") INTO v_min, v_max
    FROM tint_staging_preparacoes sp WHERE sp.sync_run_id = p_run;
  IF NOT COALESCE((p_over ->> 'sem_manifesto')::boolean, false) THEN
    INSERT INTO tint_staging_preparacao_manifestos (sync_run_id, account, store_code, extracao_id, lote, total_lotes,
      modo, janela_desde, janela_ate, consultado_em, n_preparacoes, n_rejeitadas, n_itens,
      primeira_preparacao_id, ultima_preparacao_id)
    VALUES (p_run, 'oben', p_store, p_ext, p_lote, COALESCE((p_over ->> 'total_lotes')::int, p_total),
            COALESCE(p_over ->> 'modo', pl.modo), COALESCE((p_over ->> 'janela_desde')::timestamptz, pl.janela_desde),
            v_ate, v_cons, v_np, v_nr, COALESCE((p_over ->> 'n_itens')::int, v_ni),
            COALESCE(p_over ->> 'primeira', v_min), COALESCE(p_over ->> 'ultima', v_max));
  END IF;
END $$;
-- Estado do fato de uma loja, sem a loja (para comparar lojas e antes/depois).
CREATE FUNCTION _t_estado(p_store text DEFAULT 'M01') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN md5(COALESCE((SELECT string_agg(p.preparacao_id || '/' || p.situacao || '/' || extract(epoch FROM p.data_dosagem)::text,
                                         ';' ORDER BY p.preparacao_id COLLATE "C")
                         FROM tint_consumo_preparacao p WHERE p.store_code = p_store), '') || '#' ||
             COALESCE((SELECT string_agg(c.preparacao_id || '/' || c.ordem || '/' || c.id_corante_origem || '/' || c.qtd_ml::text,
                                         ';' ORDER BY c.preparacao_id COLLATE "C", c.ordem)
                         FROM tint_consumo_corante c WHERE c.store_code = p_store), ''));
END $$;
-- Erro do run contém o motivo e nomeia o RPC (P12).
CREATE FUNCTION _t_recusou(p_run uuid, p_motivo text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  RETURN (SELECT sr.promocao_status = 'erro' AND position('tint_promote_preparacoes' in sr.promocao_erro) > 0
                 AND position(p_motivo in sr.promocao_erro) > 0
            FROM tint_sync_runs sr WHERE sr.id = p_run);
END $$;

-- ── seed: 14 WP (QT no Omie) + 1 PU sem produto; staff e customer ──
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, unidade, account)
SELECT ('00000000-0000-0000-0000-0000000001' || lpad(n::text, 2, '0'))::uuid, 9000 + n,
       'PRD' || lpad(n::text, 5, '0'), format('WP%s.3900QT CORANTE %s', lpad(n::text, 2, '0'), n), 'L', 'oben'
  FROM generate_series(1, 14) n;
INSERT INTO tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml, omie_product_id)
SELECT ('00000000-0000-0000-0000-0000000002' || lpad(n::text, 2, '0'))::uuid, 'oben', n::text,
       format('WP%s', lpad(n::text, 2, '0')), 2300,
       ('00000000-0000-0000-0000-0000000001' || lpad(n::text, 2, '0'))::uuid
  FROM generate_series(1, 14) n;
INSERT INTO tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml)
VALUES ('00000000-0000-0000-0000-000000000215', 'oben', '15', 'WFO.6506 PU', 1000);

INSERT INTO auth.users (id, email) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'staff@teste'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'cliente@teste');
INSERT INTO user_roles (user_id, role) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'employee'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'customer');

INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01', 'automatic_primary', 'tok_test', true);
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at)
VALUES ('c0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01',
        'preparations', 'running', now(), NULL);
SQL
PA -q -d postgres -c "CREATE DATABASE tpl TEMPLATE tpl0 STRATEGY FILE_COPY" >/dev/null

# ═════════════════════════════ CENÁRIOS ═════════════════════════════

# C1 — CHECK de qtd_ml no fato (faixa física 0 < q <= 18000, finita).
cen_C1() { PA -d "$1" -q <<'SQL'
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao,
                                     versao_fonte_em, run_criado_em, sync_run_id)
SELECT 'oben', 'M01', 'P' || n, '2026-10-01 10:00-03'::timestamptz, 'valida', now(), now(),
       'c0000000-0000-0000-0000-000000000001'::uuid FROM generate_series(1, 7) n;
-- Uma preparação por valor: um valor aceito por engano não colide com o seguinte (a sabotagem
-- fica vermelha SÓ no assert dela, não no cenário inteiro).
CREATE TEMP TABLE _c1 (n int, q text, esperado text);
INSERT INTO _c1 VALUES (1, '0', '23514'), (2, '-1', '23514'), (3, '''NaN''', '23514'), (4, '''Infinity''', '23514'),
                       (5, '18000.001', '23514'), (6, '18000', 'OK'), (7, '0.01', 'OK');
SELECT _t_assert('C1.qtd_' || replace(replace(q, '''', ''), '.', '_'),
                 _t_sqlstate(format($f$INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem,
                   id_corante_origem, qtd_ml, data_dosagem, sync_run_id, run_criado_em)
                   VALUES ('oben','M01','P%s',1,'1',%s,'2026-10-01 10:00-03','c0000000-0000-0000-0000-000000000001',now())$f$,
                   n, q)) = esperado, q)
  FROM _c1 ORDER BY n;
SQL
}

# C2 — staging de preparações não aceita cliente, nem como coluna, nem dentro do raw_data.
cen_C2() { PA -d "$1" -q <<'SQL'
SELECT _t_assert('C2.cliente_coluna', _t_sqlstate($s$INSERT INTO tint_staging_preparacoes
  (sync_run_id, account, store_code, preparacao_id, cliente)
  VALUES ('c0000000-0000-0000-0000-000000000001','oben','M01','X','Fulano')$s$) = '23514');
SELECT _t_assert('C2.cliente_raw', _t_sqlstate($s$INSERT INTO tint_staging_preparacoes
  (sync_run_id, account, store_code, preparacao_id, raw_data)
  VALUES ('c0000000-0000-0000-0000-000000000001','oben','M01','X','{"cliente":"Fulano"}')$s$) = '23514');
SELECT _t_assert('C2.sem_cliente_aceito', _t_sqlstate($s$INSERT INTO tint_staging_preparacoes
  (sync_run_id, account, store_code, preparacao_id, raw_data, data_preparacao)
  VALUES ('c0000000-0000-0000-0000-000000000001','oben','M01','X','{"preparacao_id":"X"}', now())$s$) = 'OK');
SQL
}

# C3 — manifesto: coerência local por CHECK.
cen_C3() { PA -d "$1" -q <<'SQL'
CREATE TEMP TABLE _c3 (nome text, lote text, total text, desde text, ate text, cons text, n_itens text, modo text,
                       esperado text, ini text DEFAULT NULL, fim text DEFAULT NULL);
INSERT INTO _c3 (nome, lote, total, desde, ate, cons, n_itens, modo, esperado, ini, fim) VALUES
  ('faixa_ok',      '1', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', 'OK', 'A1', 'a0'),
  ('faixa_invertida','1','1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', '23514', 'a0', 'A1'),
  ('faixa_meia',    '1', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', '23514', 'A1', NULL);
INSERT INTO _c3 (nome, lote, total, desde, ate, cons, n_itens, modo, esperado) VALUES
  ('base',          '1', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', 'OK'),
  ('lote_zero',     '0', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', '23514'),
  ('lote_maior',    '3', '2', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', '23514'),
  ('janela_vazia',  '1', '1', '2026-10-01 00:00-03', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '0',  'incremental', '23514'),
  ('consulta_cedo', '1', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-01 23:59-03', '0',  'incremental', '23514'),
  ('itens_neg',     '1', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '-1', 'incremental', '23514'),
  ('modo_x',        '1', '1', '2026-10-01 00:00-03', '2026-10-02 00:00-03', '2026-10-02 00:00-03', '0',  'x',           '23514');
SELECT _t_assert('C3.' || nome, _t_sqlstate(format($f$
  DELETE FROM tint_staging_preparacao_manifestos;
  INSERT INTO tint_staging_preparacao_manifestos (sync_run_id, account, store_code, extracao_id, lote, total_lotes,
    modo, janela_desde, janela_ate, consultado_em, n_preparacoes, n_rejeitadas, n_itens,
    primeira_preparacao_id, ultima_preparacao_id)
  VALUES ('c0000000-0000-0000-0000-000000000001','oben','M01',gen_random_uuid(),%s,%s,%L,%L,%L,%L,0,0,%s,%L,%L)$f$,
  lote, total, modo, desde, ate, cons, n_itens, ini, fim)) = esperado, nome)
  FROM _c3 ORDER BY nome;
SQL
}

# C4 — seed da capacidade: os 14 WP com 2300 não confirmada; o PU (sem produto Omie) fica NULL.
cen_C4() { PA -d "$1" -q <<'SQL'
SELECT _t_assert('C4.seed_14',
  (SELECT count(*) FROM tint_corantes WHERE account = 'oben' AND capacidade_canister_ml = 2300
                                        AND capacidade_confirmada IS FALSE) = 14);
SELECT _t_assert('C4.pu_null',
  (SELECT capacidade_canister_ml IS NULL AND capacidade_confirmada IS FALSE
     FROM tint_corantes WHERE id_corante_sayersystem = '15'));
SELECT _t_assert('C4.constantes',
  (SELECT validade_dias = 365 AND lata_ml = 810 AND lata_l = 0.81 AND horizonte_dias = 180 AND frescor_dias = 4
      AND cobertura_min_dias = 60 AND cobertura_plena_dias = 180 AND limite_ausencia = 0.01
      AND regime_janela_dias = 60 AND regime_fator = 2 AND piso_dias = 400 AND janela_max_dias = 35
      AND janela_inicial_dias = 7 AND lotes_alvo = 10 AND max_lotes_extracao = 20
      AND revisita_recente_janela_dias = 35 AND revisita_recente_dias = 7 AND revisita_antiga_dias = 30
      AND fila_max_pendentes = 6 AND plano_validade = interval '30 minutes'
      AND compactacao_idade = interval '2 days' AND relogio_tolerancia = interval '10 minutes'
     FROM tint_corante_constantes()));
SQL
}

# C5 — ACL e RLS: só a promoção (SECDEF) escreve o fato; customer não lê; staff lê.
cen_C5() { PA -d "$1" -q <<'SQL'
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao,
                                     versao_fonte_em, run_criado_em, sync_run_id)
VALUES ('oben', 'M01', 'P1', '2026-10-01 10:00-03', 'valida', now(), now(), 'c0000000-0000-0000-0000-000000000001');
INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem, id_corante_origem, qtd_ml,
                                  data_dosagem, sync_run_id, run_criado_em)
VALUES ('oben', 'M01', 'P1', 1, '1', 10, '2026-10-01 10:00-03', 'c0000000-0000-0000-0000-000000000001', now());
INSERT INTO tint_consumo_planos (extracao_id, account, store_code, modo, janela_desde, janela_ate, criado_em, expira_em)
VALUES ('e0000000-0000-0000-0000-000000000001', 'oben', 'M01', 'incremental', '2026-10-01 00:00-03',
        '2026-10-02 00:00-03', now(), now() + interval '30 minutes');
INSERT INTO tint_consumo_extracoes (extracao_id, account, store_code, modo, janela_desde, janela_ate, consultado_em,
                                    total_lotes, criada_em, completa_em)
VALUES ('e0000000-0000-0000-0000-000000000001', 'oben', 'M01', 'incremental', '2026-10-01 00:00-03',
        '2026-10-02 00:00-03', '2026-10-02 00:00-03', 1, now(), now());
INSERT INTO tint_consumo_extracao_lotes (extracao_id, lote, sync_run_id, n_preparacoes, n_rejeitadas, n_itens, promovido_em)
VALUES ('e0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 1, 0, 1, now());

SELECT _t_assert('C5.sem_escrita_' || r || '_' || t || '_' || p, NOT has_table_privilege(r, 'public.' || t, p), r)
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
       unnest(ARRAY['tint_consumo_preparacao', 'tint_consumo_corante', 'tint_consumo_planos', 'tint_consumo_extracoes',
                    'tint_consumo_extracao_lotes']) t,
       unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p
 ORDER BY r, t, p;
SELECT _t_assert('C5.manifesto_service_insert', has_table_privilege('service_role', 'public.tint_staging_preparacao_manifestos', 'INSERT'));
SELECT _t_assert('C5.manifesto_anon_nada', NOT has_table_privilege('anon', 'public.tint_staging_preparacao_manifestos', 'SELECT'));

SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
SET ROLE authenticated;
CREATE TEMP TABLE _c5_cli AS
SELECT (SELECT count(*) FROM tint_consumo_preparacao) + (SELECT count(*) FROM tint_consumo_corante)
     + (SELECT count(*) FROM tint_consumo_extracoes) + (SELECT count(*) FROM tint_consumo_extracao_lotes)
     + (SELECT count(*) FROM tint_consumo_planos) + (SELECT count(*) FROM tint_staging_preparacao_manifestos) AS n;
RESET ROLE;
SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
SET ROLE authenticated;
CREATE TEMP TABLE _c5_staff AS
SELECT (SELECT count(*) FROM tint_consumo_preparacao) AS p, (SELECT count(*) FROM tint_consumo_corante) AS c,
       (SELECT count(*) FROM tint_consumo_extracoes) AS e, (SELECT count(*) FROM tint_consumo_extracao_lotes) AS l,
       (SELECT count(*) FROM tint_consumo_planos) AS pl;
CREATE TEMP TABLE _c5_ins AS
SELECT _t_sqlstate($s$INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem, id_corante_origem,
  qtd_ml, data_dosagem, sync_run_id, run_criado_em) VALUES ('oben','M01','P1',2,'1',5,now(),
  'c0000000-0000-0000-0000-000000000001',now())$s$) AS st;
RESET ROLE;
RESET request.jwt.claim.sub;
SELECT _t_assert('C5.customer_le_zero', (SELECT n FROM _c5_cli) = 0, (SELECT n FROM _c5_cli)::text);
SELECT _t_assert('C5.staff_le', (SELECT p = 1 AND c = 1 AND e = 1 AND l = 1 AND pl = 1 FROM _c5_staff));
SELECT _t_assert('C5.staff_insert_negado', (SELECT st FROM _c5_ins) = '42501', (SELECT st FROM _c5_ins));
SQL
}

# ════════════════════ Task 2 — promoção, cobertura, plano, consumidor ════════════════════
# Datas em 2027 (futuro): a compactação do consumidor usa o relógio REAL e não pode morder a simulação.
# Promoção sempre pelo consumidor (`_t_drenar` → tint_preparacoes_tick), nunca direta.

# P1 — o mesmo conteúdo em duas extrações converge para o mesmo estado.
cen_P1() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e1000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_plano('e1000000-0000-0000-0000-000000000002', 'rescan', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('11000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:10,2:20', 'B|2027-06-10 11:00-03|3:5']);
SELECT _t_drenar();
CREATE TEMP TABLE _p1 AS SELECT _t_estado() AS e;
SELECT _t_lote('11000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000002', 1, 1,
  '2027-06-11 01:00-03', ARRAY['A|2027-06-10 10:00-03|1:10,2:20', 'B|2027-06-10 11:00-03|3:5']);
SELECT _t_drenar();
SELECT _t_assert('P1.mesmo_estado', (SELECT e FROM _p1) = _t_estado());
SELECT _t_assert('P1.contagem', (SELECT count(*) FROM tint_consumo_preparacao) = 2
  AND (SELECT count(*) FROM tint_consumo_corante) = 3 AND (SELECT sum(qtd_ml) FROM tint_consumo_corante) = 35);
SQL
}

# P2 — edição na origem: slots trocados e um a menos → itens EXATAMENTE os da versão nova.
cen_P2() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e2000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_plano('e2000000-0000-0000-0000-000000000002', 'rescan', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('21000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['X|2027-06-10 10:00-03|1:10,2:20,3:30']);
SELECT _t_lote('21000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 1, 1,
  '2027-06-11 01:00-03', ARRAY['X|2027-06-10 10:00-03|3:30,1:10']);
SELECT _t_drenar();
SELECT _t_assert('P2.itens_exatos', (SELECT string_agg(ordem || '=' || id_corante_origem || ':' || qtd_ml::text, ','
  ORDER BY ordem) FROM tint_consumo_corante WHERE preparacao_id = 'X') = '1=3:30,2=1:10');
SELECT _t_assert('P2.soma', (SELECT sum(qtd_ml) FROM tint_consumo_corante WHERE preparacao_id = 'X') = 40);
SQL
}

# P3 — versão = CHEGADA: relógio da origem que regride não faz a leitura nova perder; a cura de janela
# antiga promovida depois do rescan vence. P3b — replay depois da poda é reconhecido e não muda nada.
cen_P3() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e3000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_plano('e3000000-0000-0000-0000-000000000002', 'rescan', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('31000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 02:00-03', ARRAY['X|2027-06-10 10:00-03|1:10'], '{"consultado_em": "2027-06-11 02:00-03"}');
SELECT _t_lote('31000000-0000-0000-0000-000000000002', 'e3000000-0000-0000-0000-000000000002', 1, 1,
  '2027-06-11 03:00-03', ARRAY['X|2027-06-10 10:00-03|1:99'], '{"consultado_em": "2027-06-11 01:00-03"}');
SELECT _t_plano('e3000000-0000-0000-0000-000000000003', 'rescan', '2027-06-12 00:00-03', '2027-06-14 00:00-03');
SELECT _t_plano('e3000000-0000-0000-0000-000000000004', 'cura', '2027-06-12 00:00-03', '2027-06-13 00:00-03');
SELECT _t_lote('31000000-0000-0000-0000-000000000003', 'e3000000-0000-0000-0000-000000000003', 1, 1,
  '2027-06-14 05:00-03', ARRAY['Y|2027-06-12 10:00-03|1:55'], '{"consultado_em": "2027-06-14 05:00-03"}');
SELECT _t_lote('31000000-0000-0000-0000-000000000004', 'e3000000-0000-0000-0000-000000000004', 1, 1,
  '2027-06-14 06:00-03', ARRAY['Y|2027-06-12 10:00-03|1:77'], '{"consultado_em": "2027-06-13 00:00-03"}');
SELECT _t_drenar();
SELECT _t_assert('P3.regressao_relogio', (SELECT qtd_ml FROM tint_consumo_corante WHERE preparacao_id = 'X') = 99);
SELECT _t_assert('P3.cura_vence', (SELECT qtd_ml FROM tint_consumo_corante WHERE preparacao_id = 'Y') = 77);
CREATE TEMP TABLE _p3b AS SELECT _t_estado() AS e;
UPDATE tint_sync_runs SET promocao_status = 'pendente', promocao_tentativas = 0
 WHERE id = '31000000-0000-0000-0000-000000000002';
TRUNCATE _t_ticks;
SELECT _t_drenar();
SELECT _t_assert('P3b.ja_aplicado', EXISTS (SELECT 1 FROM _t_ticks WHERE r ->> 'acao' = 'promovido'
  AND r -> 'resultado' ->> 'acao' = 'ja_aplicado'));
SELECT _t_assert('P3b.estado_igual', (SELECT e FROM _p3b) = _t_estado());
SQL
}

# P4 — a ordem de PROMOÇÃO não importa: a chegada (started_at) fixa a versão.
cen_P4() { PA -d "$1" -q <<'SQL'
DO $$
DECLARE lj text; n int; perm int[]; i int;
BEGIN
  FOR i IN 1 .. 3 LOOP
    lj := 'M0' || i;
    perm := (ARRAY[ARRAY[1, 2, 3], ARRAY[3, 2, 1], ARRAY[2, 3, 1]])[i:i];
    FOR n IN 1 .. 3 LOOP
      PERFORM _t_plano(('e4000000-0000-0000-0000-0000000000' || i || n)::uuid, 'rescan',
                       '2027-06-10 00:00-03', '2027-06-11 00:00-03', lj);
      PERFORM _t_lote(('41000000-0000-0000-0000-0000000000' || i || n)::uuid,
                      ('e4000000-0000-0000-0000-0000000000' || i || n)::uuid, 1, 1,
                      '2027-06-11 01:00-03'::timestamptz + make_interval(mins => n),
                      ARRAY['X|2027-06-10 10:00-03|1:' || n, 'Q' || n || '|2027-06-10 11:00-03|2:1'],
                      '{"consultado_em": "2027-06-11 00:00-03"}', lj);
    END LOOP;
    -- a fila (FIFO por completed_at) promove na permutação pedida, independente da chegada
    FOR n IN 1 .. 3 LOOP
      UPDATE tint_sync_runs SET completed_at = '2027-06-11 02:00-03'::timestamptz + make_interval(mins => n)
       WHERE id = ('41000000-0000-0000-0000-0000000000' || i || perm[1][n])::uuid;
    END LOOP;
  END LOOP;
END $$;
SELECT _t_drenar();
SELECT _t_assert('P4.permutacoes_iguais', _t_estado('M01') = _t_estado('M02') AND _t_estado('M02') = _t_estado('M03'));
SELECT _t_assert('P4.vence_a_ultima_chegada', (SELECT qtd_ml FROM tint_consumo_corante
  WHERE store_code = 'M02' AND preparacao_id = 'X') = 3);
SQL
}

# P5 — corante sem ponte: mantido com tint_corante_id NULL e contado.
cen_P5() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e5000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('51000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['Z|2027-06-10 10:00-03|99:7,1:3']);
SELECT _t_drenar();
SELECT _t_assert('P5.sem_ponte_null', (SELECT tint_corante_id IS NULL FROM tint_consumo_corante
  WHERE preparacao_id = 'Z' AND ordem = 1));
SELECT _t_assert('P5.com_ponte', (SELECT tint_corante_id = '00000000-0000-0000-0000-000000000201'
  FROM tint_consumo_corante WHERE preparacao_id = 'Z' AND ordem = 2));
SELECT _t_assert('P5.contado', EXISTS (SELECT 1 FROM _t_ticks WHERE r -> 'resultado' ->> 'itens_sem_ponte' = '1'));
SQL
}

# P6 — extração de 2 lotes só certifica cobertura com os DOIS promovidos.
cen_P6() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e6000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('61000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000001', 1, 2,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:1']);
SELECT _t_drenar();
SELECT _t_assert('P6.incompleta', (SELECT completa_em IS NULL FROM tint_consumo_extracoes
  WHERE extracao_id = 'e6000000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM tint_consumo_cobertura_em('2027-06-20 15:00-03') WHERE store_code = 'M01'));
SELECT _t_lote('61000000-0000-0000-0000-000000000002', 'e6000000-0000-0000-0000-000000000001', 2, 2,
  '2027-06-11 00:06-03', ARRAY['B|2027-06-10 11:00-03|1:1']);
SELECT _t_drenar();
SELECT _t_assert('P6.completa_ilha', (SELECT ilha_desde = '2027-06-10 00:00-03' AND ilha_ate = '2027-06-11 00:00-03'
  FROM tint_consumo_cobertura_em('2027-06-20 15:00-03') WHERE store_code = 'M01'));
SQL
}

# P7 — janela sem dosagem: 1 lote vazio completa a extração.
cen_P7() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e7000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('71000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY[]::text[]);
SELECT _t_drenar();
SELECT _t_assert('P7.vazia_completa', (SELECT completa_em IS NOT NULL FROM tint_consumo_extracoes
  WHERE extracao_id = 'e7000000-0000-0000-0000-000000000001')
  AND (SELECT ilha_ate = '2027-06-11 00:00-03' FROM tint_consumo_cobertura_em('2027-06-20 15:00-03')
        WHERE store_code = 'M01'));
SQL
}

# P8 — rejeitada na origem (sem itens), depois válida numa chegada posterior.
cen_P8() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e8000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_plano('e8000000-0000-0000-0000-000000000002', 'rescan', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('81000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['X|2027-06-10 10:00-03|!slot_parcial']);
SELECT _t_drenar();
SELECT _t_assert('P8.rejeitada_sem_itens', (SELECT situacao = 'rejeitada' AND motivo_rejeicao = 'slot_parcial'
  FROM tint_consumo_preparacao WHERE preparacao_id = 'X')
  AND NOT EXISTS (SELECT 1 FROM tint_consumo_corante WHERE preparacao_id = 'X'));
SELECT _t_lote('81000000-0000-0000-0000-000000000002', 'e8000000-0000-0000-0000-000000000002', 1, 1,
  '2027-06-11 01:00-03', ARRAY['X|2027-06-10 10:00-03|1:5']);
SELECT _t_drenar();
SELECT _t_assert('P8.valida_depois', (SELECT situacao = 'valida' FROM tint_consumo_preparacao WHERE preparacao_id = 'X')
  AND (SELECT count(*) FROM tint_consumo_corante WHERE preparacao_id = 'X') = 1);
SQL
}

# P9 — retenção por estado: o staging do run promovido some; o do run em erro fica.
cen_P9() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('e9000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_plano('e9000000-0000-0000-0000-000000000002', 'rescan', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('91000000-0000-0000-0000-000000000001', 'e9000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:1']);
SELECT _t_lote('91000000-0000-0000-0000-000000000002', 'e9000000-0000-0000-0000-000000000002', 1, 1,
  '2027-06-11 01:00-03', ARRAY['A|2027-06-10 10:00-03|1:1'], '{"n_itens": 9}');
SELECT _t_drenar();
SELECT _t_assert('P9.purgado',
  NOT EXISTS (SELECT 1 FROM tint_staging_preparacoes WHERE sync_run_id = '91000000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM tint_staging_preparacao_itens WHERE sync_run_id = '91000000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM tint_staging_preparacao_manifestos WHERE sync_run_id = '91000000-0000-0000-0000-000000000001'));
SELECT _t_assert('P9.erro_mantem',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = '91000000-0000-0000-0000-000000000002') = 'erro'
  AND EXISTS (SELECT 1 FROM tint_staging_preparacoes WHERE sync_run_id = '91000000-0000-0000-0000-000000000002')
  AND EXISTS (SELECT 1 FROM tint_staging_preparacao_manifestos WHERE sync_run_id = '91000000-0000-0000-0000-000000000002'));
SQL
}

# P10 — consumidores separados: o tick atual não toca preparações, o novo não toca catálogo; o patch do
# tick muda SÓ o predicado (desfazer a troca devolve o md5 do predecessor).
cen_P10() { PA -d "$1" -q <<'SQL'
CREATE TABLE _t_cont (run_id uuid);
DROP FUNCTION public.tint_promote_sync_run(uuid);
CREATE FUNCTION public.tint_promote_sync_run(p_sync_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
AS $$ BEGIN INSERT INTO _t_cont VALUES (p_sync_run_id); RETURN '{"ok": true}'::jsonb; END $$;
SELECT _t_plano('ea000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('a1000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:1']);
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at, promocao_status)
VALUES ('c1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01', 'catalogs',
        'complete', '2027-06-11 00:06-03', '2027-06-11 00:06:01-03', 'pendente');
DO $$ DECLARE v jsonb; i int := 0;
BEGIN LOOP v := public.tint_promocao_tick(); i := i + 1; EXIT WHEN v ->> 'acao' = 'fila_vazia' OR i > 20; END LOOP; END $$;
SELECT _t_assert('P10.tick_ignora_prep',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-000000000001') = 'pendente'
  AND (SELECT promocao_status FROM tint_sync_runs WHERE id = 'c1000000-0000-0000-0000-000000000001') = 'promovido'
  AND (SELECT count(*) FROM _t_cont) = 1);
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at, promocao_status)
VALUES ('c1000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01', 'catalogs',
        'complete', '2027-06-11 00:07-03', '2027-06-11 00:07:01-03', 'pendente');
SELECT _t_drenar();
SELECT _t_assert('P10.prep_promovido',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'a1000000-0000-0000-0000-000000000001') = 'promovido');
SELECT _t_assert('P10.prep_ignora_catalogo',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'c1000000-0000-0000-0000-000000000002') = 'pendente');
SELECT _t_assert('P10.patch_so_predicado', (SELECT md5(replace(p.prosrc,
    E'     WHERE sr.promocao_status = \'pendente\'\n       AND sr.sync_type IS DISTINCT FROM \'preparations\'\n    UNION ALL',
    E'     WHERE sr.promocao_status = \'pendente\'\n    UNION ALL')) = 'd0e3beb394c932ad1979da5efc910943'
    AND md5(p.prosrc) = 'e5f375b0bff05600fe66f3f6d79d513c'
  FROM pg_proc p WHERE p.oid = 'public.tint_promocao_tick()'::regprocedure));
SQL
}

# P11 — ACL das funções SECURITY DEFINER.
cen_P11() { PA -d "$1" -q <<'SQL'
SELECT _t_assert('P11.' || split_part(f, '(', 1) || '_' || r, NOT has_function_privilege(r, 'public.' || f, 'EXECUTE'), f)
  FROM unnest(ARRAY['tint_promote_preparacoes(uuid)', 'tint_consumo_plano_extracao(text,text,timestamptz)',
                    'tint_preparacoes_tick()', 'tint_promocao_tick()', 'tint_consumo_compactar(timestamptz)']) f,
       unnest(ARRAY['anon', 'authenticated', 'public']) r
 ORDER BY f, r;
SELECT _t_assert('P11.service_role_plano',
  has_function_privilege('service_role', 'public.tint_consumo_plano_extracao(text,text,timestamptz)', 'EXECUTE'));
SET ROLE authenticated;
CREATE TEMP TABLE _p11 AS SELECT _t_sqlstate('SELECT public.tint_preparacoes_tick()') AS st;
RESET ROLE;
SELECT _t_assert('P11.authenticated_42501', (SELECT st FROM _p11) = '42501', (SELECT st FROM _p11));
SQL
}

# P12 — recusas determinísticas: erro sem retry, nada gravado, a mensagem nomeia o RPC e o motivo.
cen_P12() { PA -d "$1" -q <<'SQL'
DO $$ DECLARE i int;
BEGIN
  FOR i IN 1 .. 8 LOOP
    PERFORM _t_plano(('ec000000-0000-0000-0000-00000000000' || i)::uuid, 'incremental',
                     '2027-06-10 00:00-03', '2027-06-11 00:00-03');
  END LOOP;
END $$;
SELECT _t_lote('c2000000-0000-0000-0000-000000000001', 'ec000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:1'], '{"sem_manifesto": true}');
SELECT _t_lote('c2000000-0000-0000-0000-000000000002', 'ecffffff-0000-0000-0000-000000000002', 1, 1,
  '2027-06-11 00:06-03', ARRAY['A|2027-06-10 10:00-03|1:1'],
  '{"modo": "incremental", "janela_desde": "2027-06-10 00:00-03", "janela_ate": "2027-06-11 00:00-03"}');
SELECT _t_lote('c2000000-0000-0000-0000-000000000003', 'ec000000-0000-0000-0000-000000000003', 1, 1,
  '2027-06-11 00:07-03', ARRAY['A|2027-06-10 10:00-03|1:1'], '{"n_itens": 5}');
SELECT _t_lote('c2000000-0000-0000-0000-000000000004', 'ec000000-0000-0000-0000-000000000004', 1, 1,
  '2027-06-11 00:08-03', ARRAY['A|2027-06-10 10:00-03|1:1', 'A|2027-06-10 11:00-03|1:2']);
SELECT _t_lote('c2000000-0000-0000-0000-000000000005', 'ec000000-0000-0000-0000-000000000005', 1, 1,
  '2027-06-11 00:09-03', ARRAY['A|2027-06-10 10:00-03|1:1'], '{"primeira": "0", "ultima": "0"}');
SELECT _t_lote('c2000000-0000-0000-0000-000000000006', 'ec000000-0000-0000-0000-000000000006', 1, 1,
  '2027-06-11 00:10-03', ARRAY['A|2027-06-11 00:00-03|1:1']);
SELECT _t_lote('c2000000-0000-0000-0000-000000000007', 'ec000000-0000-0000-0000-000000000007', 1, 1,
  '2027-06-11 00:00-03', ARRAY['A|2027-06-10 10:00-03|1:1'], '{"consultado_em": "2027-06-11 00:11-03"}');
SELECT _t_lote('c2000000-0000-0000-0000-000000000008', 'ec000000-0000-0000-0000-000000000008', 1, 1,
  '2027-06-11 00:12-03', ARRAY['A|2027-06-10 10:00-03|1:1'], '{"total_lotes": 21}');
SELECT _t_drenar();
SELECT _t_assert('P12.' || m, _t_recusou(('c2000000-0000-0000-0000-00000000000' || i)::uuid, m), m)
  FROM unnest(ARRAY['sem_manifesto', 'extracao_nao_planejada', 'contagem_divergente', 'preparacao_duplicada',
                    'preparacao_fora_da_faixa_do_lote', 'dosagem_fora_da_janela', 'relogio_origem_adiantado',
                    'extracao_grande']) WITH ORDINALITY AS u(m, i)
 ORDER BY i;
SELECT _t_assert('P12.nada_gravado', (SELECT count(*) FROM tint_consumo_preparacao) = 0
  AND (SELECT count(*) FROM tint_consumo_extracoes) = 0
  AND (SELECT count(*) FROM tint_sync_runs WHERE sync_type = 'preparations' AND promocao_tentativas <> 1) = 0);
SQL
}

# P13 — extração incoerente nunca completa: metadados divergentes e lotes sobrepostos.
cen_P13() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('ed000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('d1000000-0000-0000-0000-000000000001', 'ed000000-0000-0000-0000-000000000001', 1, 2,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:1', 'M|2027-06-10 11:00-03|1:1']);
SELECT _t_drenar();
SELECT _t_lote('d1000000-0000-0000-0000-000000000002', 'ed000000-0000-0000-0000-000000000001', 2, 2,
  '2027-06-11 00:06-03', ARRAY['N|2027-06-10 12:00-03|1:1'], '{"consultado_em": "2027-06-11 00:01-03"}');
SELECT _t_lote('d1000000-0000-0000-0000-000000000003', 'ed000000-0000-0000-0000-000000000001', 2, 3,
  '2027-06-11 00:07-03', ARRAY['N|2027-06-10 12:00-03|1:1']);
SELECT _t_lote('d1000000-0000-0000-0000-000000000004', 'ed000000-0000-0000-0000-000000000001', 2, 2,
  '2027-06-11 00:08-03', ARRAY['K|2027-06-10 12:00-03|1:1', 'Z|2027-06-10 13:00-03|1:1']);
SELECT _t_drenar();
SELECT _t_assert('P13.consulta_divergente', _t_recusou('d1000000-0000-0000-0000-000000000002', 'extracao_divergente'));
SELECT _t_assert('P13.total_divergente', _t_recusou('d1000000-0000-0000-0000-000000000003', 'extracao_divergente'));
SELECT _t_assert('P13.sobrepostos', _t_recusou('d1000000-0000-0000-0000-000000000004', 'lotes_sobrepostos'));
SELECT _t_assert('P13.nunca_completa', (SELECT completa_em IS NULL FROM tint_consumo_extracoes
  WHERE extracao_id = 'ed000000-0000-0000-0000-000000000001'));
SQL
}

# P14 — o mesmo (extração, lote) por outro run é recusado; o original segue.
cen_P14() { PA -d "$1" -q <<'SQL'
SELECT _t_plano('ee000000-0000-0000-0000-000000000001', 'incremental', '2027-06-10 00:00-03', '2027-06-11 00:00-03');
SELECT _t_lote('e1100000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:05-03', ARRAY['A|2027-06-10 10:00-03|1:1']);
SELECT _t_drenar();
SELECT _t_lote('e1100000-0000-0000-0000-000000000002', 'ee000000-0000-0000-0000-000000000001', 1, 1,
  '2027-06-11 00:06-03', ARRAY['B|2027-06-10 10:00-03|1:1']);
SELECT _t_drenar();
SELECT _t_assert('P14.duplicado', _t_recusou('e1100000-0000-0000-0000-000000000002', 'lote_duplicado'));
SELECT _t_assert('P14.original_segue', (SELECT sync_run_id FROM tint_consumo_extracao_lotes
  WHERE extracao_id = 'ee000000-0000-0000-0000-000000000001' AND lote = 1) = 'e1100000-0000-0000-0000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM tint_consumo_preparacao WHERE preparacao_id = 'B'));
SQL
}

# P15 — álgebra das ilhas: buraco não é atravessado e se cura; aninhados fundem; piso móvel não abre lacuna.
cen_P15() { PA -d "$1" -q <<'SQL'
CREATE TEMP TABLE _k AS
SELECT '2027-06-20 15:00-03'::timestamptz AS agora,
       ((date '2027-06-20' - 400)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS piso,
       (date '2027-06-20' - 400) AS piso_dia;
CREATE FUNCTION pg_temp.dia(p int) RETURNS timestamptz LANGUAGE sql AS
  $$ SELECT ((date '2027-06-20' - 400 + p)::timestamp AT TIME ZONE 'America/Sao_Paulo') $$;
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                     run_criado_em, sync_run_id)
SELECT 'oben', s, 'PX', pg_temp.dia(1) + interval '10 hours', 'valida', now(), now(), gen_random_uuid()
  FROM unnest(ARRAY['M01', 'M02', 'M03', 'M04', 'M05']) s;
SELECT _t_ext('M01', pg_temp.dia(0), pg_temp.dia(135), pg_temp.dia(135));
SELECT _t_ext('M01', pg_temp.dia(135), pg_temp.dia(170), pg_temp.dia(170), false);
SELECT _t_ext('M01', pg_temp.dia(170), pg_temp.dia(205), pg_temp.dia(205));
SELECT _t_assert('P15.ilha_recente', (SELECT ilha_desde = pg_temp.dia(170) AND ilha_ate = pg_temp.dia(205)
  FROM tint_consumo_cobertura_em((SELECT agora FROM _k)) WHERE store_code = 'M01'));
SELECT _t_assert('P15.lacuna', (SELECT lacuna_desde = pg_temp.dia(135)
  FROM tint_consumo_cobertura_em((SELECT agora FROM _k)) WHERE store_code = 'M01'));
SELECT _t_ext('M01', pg_temp.dia(135), pg_temp.dia(170), pg_temp.dia(290), true, 'cura');
SELECT _t_assert('P15.curado', (SELECT ilha_desde = pg_temp.dia(0) AND ilha_ate = pg_temp.dia(205)
  AND lacuna_desde IS NULL FROM tint_consumo_cobertura_em((SELECT agora FROM _k)) WHERE store_code = 'M01'));
-- aninhados, inseridos em 3 ordens: [0,35) [5,10) [30,60) → UMA ilha [0,60)
SELECT _t_ext('M02', pg_temp.dia(0), pg_temp.dia(35), pg_temp.dia(35));
SELECT _t_ext('M02', pg_temp.dia(5), pg_temp.dia(10), pg_temp.dia(10));
SELECT _t_ext('M02', pg_temp.dia(30), pg_temp.dia(60), pg_temp.dia(60));
SELECT _t_ext('M03', pg_temp.dia(30), pg_temp.dia(60), pg_temp.dia(60));
SELECT _t_ext('M03', pg_temp.dia(0), pg_temp.dia(35), pg_temp.dia(35));
SELECT _t_ext('M03', pg_temp.dia(5), pg_temp.dia(10), pg_temp.dia(10));
SELECT _t_ext('M04', pg_temp.dia(5), pg_temp.dia(10), pg_temp.dia(10));
SELECT _t_ext('M04', pg_temp.dia(30), pg_temp.dia(60), pg_temp.dia(60));
SELECT _t_ext('M04', pg_temp.dia(0), pg_temp.dia(35), pg_temp.dia(35));
SELECT _t_assert('P15.aninhados', (SELECT count(*) FILTER (WHERE ilha_desde = pg_temp.dia(0) AND ilha_ate = pg_temp.dia(60)
  AND lacuna_desde IS NULL) = 3 FROM tint_consumo_cobertura_em((SELECT agora FROM _k))
  WHERE store_code IN ('M02', 'M03', 'M04')));
-- piso móvel: a ilha começou no piso de ONTEM e ainda contém o de hoje
SELECT _t_ext('M05', pg_temp.dia(-1), (SELECT agora FROM _k) - interval '1 day', (SELECT agora FROM _k) - interval '1 day');
SELECT _t_assert('P15.piso_movel', (SELECT lacuna_desde IS NULL AND ilha_desde = pg_temp.dia(-1)
  AND primeiro_dia_coberto = (SELECT piso_dia FROM _k) + 1
  FROM tint_consumo_cobertura_em((SELECT agora FROM _k)) WHERE store_code = 'M05'));
SQL
}

# P16 — só dias SP inteiros e a partir da 1ª dosagem; o fuso da sessão não muda nada.
cen_P16() { PA -d "$1" -q <<'SQL'
SELECT _t_ext('M01', '2027-05-01 16:55-03', '2027-05-11 00:00-03', '2027-05-11 00:00-03');
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                     run_criado_em, sync_run_id)
VALUES ('oben', 'M01', 'PX', '2027-05-01 17:00-03', 'valida', now(), now(), gen_random_uuid()),
       ('oben', 'M02', 'PY', (((date '2027-06-20' - 400 + 40)::timestamp) AT TIME ZONE 'America/Sao_Paulo') + interval '10 hours',
        'valida', now(), now(), gen_random_uuid());
SELECT _t_ext('M02', ((date '2027-06-20' - 400)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
              ((date '2027-06-20' - 400 + 60)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
              ((date '2027-06-20' - 400 + 60)::timestamp AT TIME ZONE 'America/Sao_Paulo'));
SELECT _t_assert('P16.meio_dia', (SELECT primeiro_dia_coberto = date '2027-05-02' AND ultimo_dia_coberto = date '2027-05-10'
  FROM tint_consumo_cobertura_em('2027-06-20 15:00-03') WHERE store_code = 'M01'));
SELECT _t_assert('P16.primeira_dosagem', (SELECT primeiro_dia_coberto = date '2027-06-20' - 400 + 40
  FROM tint_consumo_cobertura_em('2027-06-20 15:00-03') WHERE store_code = 'M02'));
SET TIME ZONE 'UTC';
CREATE TEMP TABLE _p16 AS SELECT md5(string_agg(store_code || primeiro_dia_coberto || ultimo_dia_coberto
  || extract(epoch FROM ilha_ate), ';' ORDER BY store_code)) AS u FROM tint_consumo_cobertura_em('2027-06-20 15:00-03');
SET TIME ZONE 'America/Sao_Paulo';
SELECT _t_assert('P16.tz_igual', (SELECT u FROM _p16) = (SELECT md5(string_agg(store_code || primeiro_dia_coberto
  || ultimo_dia_coberto || extract(epoch FROM ilha_ate), ';' ORDER BY store_code))
  FROM tint_consumo_cobertura_em('2027-06-20 15:00-03')));
SQL
}

# P17 — o plano (às 15h SP, nunca à meia-noite): admissão, frente, cura, revisita, tamanho da janela.
cen_P17() { PA -d "$1" -q <<'SQL'
CREATE TEMP TABLE _k AS SELECT '2027-06-20 15:00-03'::timestamptz AS agora;
CREATE FUNCTION pg_temp.dia(p int) RETURNS timestamptz LANGUAGE sql AS
  $$ SELECT ((date '2027-06-20' - 400 + p)::timestamp AT TIME ZONE 'America/Sao_Paulo') $$;
CREATE FUNCTION pg_temp.hoje(p int) RETURNS timestamptz LANGUAGE sql AS
  $$ SELECT ((date '2027-06-20' + p)::timestamp AT TIME ZONE 'America/Sao_Paulo') $$;
CREATE TEMP TABLE _jan (caso text, modo text, desde timestamptz, ate timestamptz);
CREATE FUNCTION pg_temp.plano(p_caso text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.tint_consumo_plano_extracao('oben', 'M01', '2027-06-20 15:00-03');
  INSERT INTO _jan SELECT p_caso, j ->> 'modo', (j ->> 'desde')::timestamptz, (j ->> 'ate')::timestamptz
    FROM jsonb_array_elements(v -> 'janelas') j;
  RETURN v;
END $$;
CREATE FUNCTION pg_temp.limpa() RETURNS void LANGUAGE sql AS
  $$ DELETE FROM tint_consumo_planos; DELETE FROM tint_consumo_preparacao; $$;
-- a) sem ilha → backfill no piso, janela inicial de 7 dias
SELECT pg_temp.plano('a');
SELECT _t_assert('P17.backfill', (SELECT count(*) = 1 AND bool_and(modo = 'backfill' AND desde = pg_temp.dia(0)
  AND ate = pg_temp.dia(7)) FROM _jan WHERE caso = 'a'));
-- b) plano em voo → em_andamento
SELECT _t_assert('P17.em_andamento', (SELECT r ->> 'motivo' = 'em_andamento' AND jsonb_array_length(r -> 'janelas') = 0
  FROM (SELECT pg_temp.plano('b') AS r) s));
-- c) 6 runs pendentes → fila_cheia
UPDATE tint_consumo_planos SET expira_em = '2027-06-20 14:59-03';
INSERT INTO tint_sync_runs (setting_id, account, store_code, sync_type, status, started_at, completed_at, promocao_status)
SELECT 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01', 'preparations', 'complete', now(), now(), 'pendente'
  FROM generate_series(1, 6);
SELECT _t_assert('P17.fila_cheia', (SELECT pg_temp.plano('c') ->> 'motivo') = 'fila_cheia');
DELETE FROM tint_sync_runs WHERE sync_type = 'preparations';
-- d) buraco → frente + cura
SELECT pg_temp.limpa();
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                     run_criado_em, sync_run_id)
VALUES ('oben', 'M01', 'PX', pg_temp.dia(1) + interval '10 hours', 'valida', now(), now(), gen_random_uuid());
SELECT _t_ext('M01', pg_temp.dia(0), pg_temp.dia(35), pg_temp.dia(35));
SELECT _t_ext('M01', pg_temp.dia(70), pg_temp.hoje(0), pg_temp.hoje(0) + interval '1 hour');
SELECT pg_temp.plano('d');
SELECT _t_assert('P17.frente_e_cura', (SELECT count(*) = 2
  AND bool_or(modo = 'incremental' AND desde = pg_temp.hoje(0) AND ate = '2027-06-20 15:00-03')
  AND bool_or(modo = 'cura' AND desde = pg_temp.dia(35) AND ate = pg_temp.dia(70)) FROM _jan WHERE caso = 'd'));
-- e) sem buraco; a última semana lida há 8 dias → rescan de 35 d que termina na meia-noite de hoje
SELECT pg_temp.limpa();
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                     run_criado_em, sync_run_id)
VALUES ('oben', 'M01', 'PX', pg_temp.dia(1) + interval '10 hours', 'valida', now(), now(), gen_random_uuid());
SELECT _t_ext('M01', pg_temp.dia(0), pg_temp.hoje(-8), pg_temp.hoje(-8));
SELECT _t_ext('M01', pg_temp.hoje(-8), pg_temp.hoje(0), pg_temp.hoje(0) + interval '1 hour');
SELECT pg_temp.plano('e');
SELECT _t_assert('P17.rescan_meia_noite', (SELECT bool_or(modo = 'rescan' AND desde = pg_temp.hoje(-35)
  AND ate = pg_temp.hoje(0)) AND bool_or(modo = 'incremental') FROM _jan WHERE caso = 'e'));
-- f) densidade de 2.000 preparações/dia → w = 5
SELECT pg_temp.limpa();
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                     run_criado_em, sync_run_id)
SELECT 'oben', 'M01', 'D' || n, pg_temp.hoje(-3) + interval '10 hours', 'valida', now(), now(), gen_random_uuid()
  FROM generate_series(1, 2000) n;
SELECT pg_temp.plano('f');
SELECT _t_assert('P17.w_densidade', (SELECT count(*) = 1 AND bool_and(modo = 'backfill' AND desde = pg_temp.dia(0)
  AND ate = pg_temp.dia(5)) FROM _jan WHERE caso = 'f'));
-- g) invariantes de toda janela emitida
SELECT _t_assert('P17.meia_noite', (SELECT bool_and((desde AT TIME ZONE 'America/Sao_Paulo')::time = time '00:00') FROM _jan));
SELECT _t_assert('P17.teto', (SELECT bool_and(ate - desde <= interval '35 days' AND desde < ate) FROM _jan));
SQL
}

# P18 — isolamento de EXECUÇÃO: outra sessão segura o lock do consumidor de preparações e uma linha do
# fato; o tick atual promove o catálogo sem esperar, e o consumidor pula (try-lock).
cen_P18() { local db=$1 bg
PA -d "$db" -q <<'SQL'
CREATE TABLE _t_cont (run_id uuid);
DROP FUNCTION public.tint_promote_sync_run(uuid);
CREATE FUNCTION public.tint_promote_sync_run(p_sync_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
AS $$ BEGIN INSERT INTO _t_cont VALUES (p_sync_run_id); RETURN '{"ok": true}'::jsonb; END $$;
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at, completed_at, promocao_status)
VALUES ('c1800000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01', 'catalogs',
        'complete', '2027-06-11 00:06-03', '2027-06-11 00:06:01-03', 'pendente');
INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                     run_criado_em, sync_run_id)
VALUES ('oben', 'M01', 'L1', '2027-06-10 10:00-03', 'valida', now(), now(), gen_random_uuid());
SQL
PA -d "$db" -q -c "BEGIN" -c "SELECT pg_advisory_lock(hashtext('tint_preparacoes_tick'))" \
   -c "SELECT 1 FROM tint_consumo_preparacao FOR UPDATE" -c "SELECT pg_sleep(6)" -c "COMMIT" >/dev/null 2>&1 &
bg=$!
sleep 1
PA -d "$db" -q <<'SQL'
CREATE TEMP TABLE _p18 AS SELECT clock_timestamp() AS t0;
DO $$ DECLARE v jsonb; i int := 0;
BEGIN LOOP v := public.tint_promocao_tick(); i := i + 1; EXIT WHEN v ->> 'acao' = 'fila_vazia' OR i > 20; END LOOP; END $$;
SELECT _t_assert('P18.catalogo_nao_espera',
  (SELECT promocao_status FROM tint_sync_runs WHERE id = 'c1800000-0000-0000-0000-000000000001') = 'promovido'
  AND clock_timestamp() - (SELECT t0 FROM _p18) < interval '4 seconds');
SELECT _t_assert('P18.prep_pula', public.tint_preparacoes_tick() ->> 'acao' = 'pulado_tick_concorrente');
SQL
wait "$bg" || true
}

# P19 — convergência ponta a ponta (simulação no PG, relógio por parâmetro): 59 dias de ciclos de 6 h,
# promoção atrasada 1 ciclo, lotes de 40, edição de uma dosagem de D−100 no dia 20.
# P20 — compactação no fim: menos extrações, mesma cobertura e mesma revisita.
cen_P19() { PA -d "$1" -q <<'SQL'
CREATE TABLE _t_fonte (preparacao_id text PRIMARY KEY, data_dosagem timestamptz NOT NULL, itens text NOT NULL);
INSERT INTO _t_fonte
SELECT 'P' || to_char(d, 'YYYYMMDD') || '-' || h,
       (d + make_interval(hours => h)) AT TIME ZONE 'America/Sao_Paulo',
       ((extract(doy FROM d)::int + h) % 14 + 1) || ':' || (5 + (extract(doy FROM d)::int * h) % 20)
       || CASE WHEN h = 13 THEN ',' || (extract(doy FROM d)::int % 14 + 1) || ':3' ELSE '' END
  FROM generate_series(timestamp '2027-06-01' - interval '401 days', timestamp '2027-06-01' + interval '60 days',
                       interval '1 day') d,
       unnest(ARRAY[10, 13, 16]) h;
CREATE FUNCTION pg_temp.simular(p_inicio timestamptz, p_ciclos int, p_passo interval, p_lote int,
                                p_edit_ciclo int, p_edit_id text, p_compacta_cada int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t timestamptz; c int; pl jsonb; j jsonb; v_ate timestamptz; v_n int; v_tot int; v_l int;
        v_specs text[]; v_k int;
BEGIN
  FOR c IN 0 .. p_ciclos - 1 LOOP
    t := p_inicio + p_passo * c;
    v_k := 0;
    IF c = p_edit_ciclo THEN
      UPDATE _t_fonte SET itens = '1:100' WHERE preparacao_id = p_edit_id;
    END IF;
    pl := public.tint_consumo_plano_extracao('oben', 'M01', t);
    FOR j IN SELECT * FROM jsonb_array_elements(pl -> 'janelas') LOOP
      v_ate := least((j ->> 'ate')::timestamptz, t);
      SELECT count(*) INTO v_n FROM _t_fonte f
       WHERE f.data_dosagem >= (j ->> 'desde')::timestamptz AND f.data_dosagem < v_ate;
      v_tot := greatest(1, ceil(v_n::numeric / p_lote)::int);
      FOR v_l IN 1 .. v_tot LOOP
        SELECT COALESCE(array_agg(x.spec ORDER BY x.id COLLATE "C"), '{}') INTO v_specs
          FROM (SELECT f.preparacao_id AS id, f.preparacao_id || '|' || f.data_dosagem::text || '|' || f.itens AS spec
                  FROM _t_fonte f
                 WHERE f.data_dosagem >= (j ->> 'desde')::timestamptz AND f.data_dosagem < v_ate
                 ORDER BY f.preparacao_id COLLATE "C" OFFSET (v_l - 1) * p_lote LIMIT p_lote) x;
        v_k := v_k + 1;
        PERFORM _t_lote(gen_random_uuid(), (j ->> 'extracao_id')::uuid, v_l, v_tot,
                        t + make_interval(secs => v_k), v_specs,
                        jsonb_build_object('janela_ate', v_ate, 'consultado_em', t));
      END LOOP;
    END LOOP;
    IF c % 2 = 1 THEN PERFORM _t_drenar(); END IF;
    IF p_compacta_cada > 0 AND c > 0 AND c % p_compacta_cada = 0 THEN PERFORM public.tint_consumo_compactar(t); END IF;
  END LOOP;
  PERFORM _t_drenar();
END $$;
SELECT pg_temp.simular('2027-06-01 15:00-03', 236, interval '6 hours', 40, 80, 'P20270313-10', 40);
CREATE TEMP TABLE _k AS SELECT '2027-06-01 15:00-03'::timestamptz + interval '6 hours' * 235 AS fim;
CREATE TEMP TABLE _cob AS SELECT * FROM tint_consumo_cobertura_em((SELECT fim FROM _k)) WHERE store_code = 'M01';
SELECT _t_assert('P19.sem_lacuna', (SELECT lacuna_desde IS NULL FROM _cob));
SELECT _t_assert('P19.fresco', (SELECT ilha_ate >= (SELECT fim FROM _k) - interval '12 hours' FROM _cob));
CREATE TEMP TABLE _src AS
SELECT f.preparacao_id, o.ord::int AS ordem, split_part(o.it, ':', 1) AS corante, split_part(o.it, ':', 2)::numeric AS qtd
  FROM _t_fonte f, unnest(string_to_array(f.itens, ',')) WITH ORDINALITY o(it, ord)
 WHERE f.data_dosagem >= (SELECT primeiro_dia_coberto::timestamp AT TIME ZONE 'America/Sao_Paulo' FROM _cob)
   AND f.data_dosagem < (SELECT ilha_ate FROM _cob);
CREATE TEMP TABLE _fat AS
SELECT c.preparacao_id, c.ordem, c.id_corante_origem AS corante, c.qtd_ml AS qtd
  FROM tint_consumo_corante c
 WHERE c.data_dosagem >= (SELECT primeiro_dia_coberto::timestamp AT TIME ZONE 'America/Sao_Paulo' FROM _cob)
   AND c.data_dosagem < (SELECT ilha_ate FROM _cob);
SELECT _t_assert('P19.fato_igual_fonte', NOT EXISTS (SELECT * FROM _src EXCEPT SELECT * FROM _fat)
  AND NOT EXISTS (SELECT * FROM _fat EXCEPT SELECT * FROM _src) AND (SELECT count(*) FROM _src) > 1000,
  (SELECT count(*) FROM _src)::text || ' x ' || (SELECT count(*) FROM _fat)::text);
SELECT _t_assert('P19.edicao_convergiu', (SELECT string_agg(ordem || '=' || id_corante_origem || ':' || qtd_ml::text, ',')
  FROM tint_consumo_corante WHERE preparacao_id = 'P20270313-10') = '1=1:100');
SELECT _t_assert('P19.lotes_multiplos', EXISTS (SELECT 1 FROM tint_consumo_extracoes WHERE total_lotes > 1
  AND completa_em IS NOT NULL));
-- P20 — compactação
CREATE FUNCTION pg_temp.revisita() RETURNS text LANGUAGE sql AS $$
  SELECT md5(string_agg(g::date::text || '=' || COALESCE(extract(epoch FROM (
           SELECT max(e.consultado_em) FROM tint_consumo_extracoes e
            WHERE e.store_code = 'M01' AND e.completa_em IS NOT NULL
              AND e.janela_desde <= (g::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
              AND e.janela_ate >= ((g::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')))::text, '-'), ';'
         ORDER BY g))
    FROM _cob, generate_series(_cob.primeiro_dia_coberto::timestamp, _cob.ultimo_dia_coberto::timestamp,
                               interval '1 day') g $$;
CREATE TEMP TABLE _p20 AS SELECT (SELECT count(*) FROM tint_consumo_extracoes) AS n, pg_temp.revisita() AS rev;
SELECT public.tint_consumo_compactar((SELECT fim FROM _k));
SELECT _t_assert('P20.compactou', (SELECT count(*) FROM tint_consumo_extracoes) < (SELECT n FROM _p20),
  (SELECT n FROM _p20)::text || ' -> ' || (SELECT count(*) FROM tint_consumo_extracoes)::text);
SELECT _t_assert('P20.cobertura_igual', (SELECT row(c.*)::text FROM tint_consumo_cobertura_em((SELECT fim FROM _k)) c
  WHERE store_code = 'M01') = (SELECT row(c.*)::text FROM _cob c));
SELECT _t_assert('P20.revisita_igual', pg_temp.revisita() = (SELECT rev FROM _p20));
SELECT _t_assert('P20.fixpoint', NOT EXISTS (SELECT 1 FROM tint_consumo_extracoes e
  WHERE e.completa_em IS NOT NULL AND e.consultado_em < (SELECT fim FROM _k) - interval '2 days'
    AND EXISTS (SELECT 1 FROM tint_consumo_extracoes o WHERE o.store_code = e.store_code AND o.completa_em IS NOT NULL
                  AND o.extracao_id <> e.extracao_id AND o.janela_desde <= e.janela_desde AND o.janela_ate >= e.janela_ate
                  AND (o.consultado_em, o.janela_ate - o.janela_desde, o.extracao_id)
                      > (e.consultado_em, e.janela_ate - e.janela_desde, e.extracao_id))));
SQL
}

# Impressão digital do que a migration cria (para o re-apply).
FP_SQL="SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT c.relname || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) AS x
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
     AND (c.relname LIKE 'tint_consumo%' OR c.relname LIKE 'tint_staging_prep%' OR c.relname = 'tint_corantes')
  UNION ALL SELECT conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace
     AND (conrelid::regclass::text LIKE 'tint_consumo%' OR conrelid::regclass::text LIKE 'tint_staging_prep%'
          OR conrelid::regclass::text = 'tint_corantes')
  UNION ALL SELECT tablename || ':' || policyname || ':' || qual FROM pg_policies WHERE tablename LIKE 'tint_consumo%'
  UNION ALL SELECT p.proname || ':' || md5(p.prosrc) || ':' || COALESCE(array_to_string(p.proacl, ','), '')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('tint_corante_constantes', 'tint_promote_preparacoes', 'tint_consumo_cobertura_em',
                       'tint_consumo_plano_extracao', 'tint_promocao_tick', 'tint_consumo_compactar',
                       'tint_preparacoes_tick')
  UNION ALL SELECT c.relname || ':acl:' || COALESCE(array_to_string(c.relacl, ','), '') FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'tint_consumo%' AND c.relkind = 'r'
  UNION ALL SELECT 'cap:' || id_corante_sayersystem || ':' || COALESCE(capacidade_canister_ml::text, '-') || ':'
                   || capacidade_confirmada FROM tint_corantes
) s"

# C6 — re-apply: a migration inteira de novo é no-op, e não pisa numa capacidade já confirmada.
cen_C6() { local db=$1 mig=$2 fp1 fp2 rc=0
PA -d "$db" -q -c "UPDATE tint_corantes SET capacidade_canister_ml = 400, capacidade_confirmada = true WHERE id_corante_sayersystem = '3'"
fp1="$(PA -d "$db" -tA -c "$FP_SQL")"
PA -d "$db" -q --single-transaction -f "$mig" >/dev/null 2>"$TMP/$db.reapply.err" || rc=$?
fp2="$(PA -d "$db" -tA -c "$FP_SQL")"
PA -d "$db" -q <<SQL
SELECT _t_assert('C6.reapply_ok', $rc = 0, \$e\$$(head -c 300 "$TMP/$db.reapply.err" | tr -d '$')\$e\$);
SELECT _t_assert('C6.reapply_mesmo_estado', '$fp1' = '$fp2' AND '$fp1' <> '');
SELECT _t_assert('C6.capacidade_confirmada_preservada',
  (SELECT capacidade_canister_ml = 400 AND capacidade_confirmada FROM tint_corantes WHERE id_corante_sayersystem = '3'));
SQL
}

CENARIOS="C1 C2 C3 C4 C5 C6 P1 P2 P3 P4 P5 P6 P7 P8 P9 P10 P11 P12 P13 P14 P15 P16 P17 P18 P19"
NESP=159   # nº EXATO de asserts: assert que some (cenário que parou no meio) é falha, não verde

# suite <migration> <sabotagem-sql-ou-vazio> → imprime RES|nome|ok|detalhe de todos os asserts
suite() {
  local mig=$1 sab=$2 c db
  PA -q -d postgres -c "DROP DATABASE IF EXISTS tplm" -c "CREATE DATABASE tplm TEMPLATE tpl STRATEGY FILE_COPY" >/dev/null
  if ! PA -d tplm -q --single-transaction -f "$mig" >/dev/null 2>"$TMP/apply.err"; then
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
    # shellcheck disable=SC2018,SC2019  # nome de cenário é ASCII fixo — sem acento a preservar
    db="$(echo "s_$c" | tr 'A-Z' 'a-z')"
    PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE tplm STRATEGY FILE_COPY" >/dev/null
    if [ "$c" = C6 ]; then
      cen_C6 "$db" "$mig" >/dev/null 2>"$TMP/$db.err" || echo "RES|$c.EXEC|f|$(head -c 300 "$TMP/$db.err" | tr '\n' ' ')"
    else
      "cen_$c" "$db" >/dev/null 2>"$TMP/$db.err" || echo "RES|$c.EXEC|f|$(head -c 300 "$TMP/$db.err" | tr '\n' ' ')"
    fi
    PA -d "$db" -tA -c "SELECT 'RES|' || nome || '|' || CASE WHEN ok THEN 't' ELSE 'f' END || '|' || COALESCE(detalhe, '') FROM _t_res ORDER BY ord" 2>/dev/null || true
  done
}

falhas_de() { grep '^RES|' | awk -F'|' '$3 != "t" {print $2}' | sort | tr '\n' ' ' | sed 's/ $//'; }

# ═════════════════════════════ CONTROLE (migration real) ═════════════════════════════
echo "════ CONTROLE — migration real ════"
CTRL="$(suite "$MIG" "")"
printf '%s\n' "$CTRL" | grep '^RES|' | awk -F'|' '{ printf "  %s %s%s\n", ($3=="t"?"✓":"✗"), $2, ($3=="t"?"":"  ["$4"]") }'
NTOT="$(printf '%s\n' "$CTRL" | grep -c '^RES|' || true)"
FCTRL="$(printf '%s\n' "$CTRL" | falhas_de)"
NFCTRL="$(printf '%s\n' "$CTRL" | grep '^RES|' | awk -F'|' '$3 != "t"' | wc -l | tr -d ' ')"
echo "PASS=$((NTOT - NFCTRL))  FAIL=$NFCTRL"   # recibo lido pelo db/roda-nucleo-ci.sh
if [ -n "$FCTRL" ] || [ "$NTOT" -ne "$NESP" ]; then
  echo "✗ CONTROLE NÃO-VERDE (falhas: [${FCTRL}] · asserts: $NTOT de $NESP) — abortando ANTES das falsificações"
  exit 1
fi
echo "  → controle verde: $NTOT asserts"
if [ "$MODO" = normal ]; then
  echo "✅ CONTROLE OK — $NTOT asserts · locale=$LOC (falsificação: --falsificar)"
  exit 0
fi

# ═════════════════════════════ FALSIFICAÇÕES ═════════════════════════════
FALSOS=0
VERM=0
# fals <nome> <esperado (nomes ordenados, espaço)> <migration> <sabotagem-sql>
fals() {
  local nome=$1 esperado=$2 mig=$3 sab=$4 got
  got="$(suite "$mig" "$sab" | falhas_de)"
  if [ "$got" = "$esperado" ]; then
    echo "  ✓ $nome: vermelho EXATO [$got]"
    VERM=$((VERM + 1))
  else
    echo "  ✗ $nome: esperado [$esperado], veio [$got]"
    FALSOS=$((FALSOS + 1))
  fi
}
sabmig() {  # sabmig <arquivo-saida> <sed-expr> — falha se o sed não mudou nada
  sed "$2" "$MIG" > "$1"
  if cmp -s "$MIG" "$1"; then echo "✗ sabotagem no-op ($2) — âncora sumiu da migration"; exit 1; fi
}

echo "════ FALSIFICAÇÕES ════"
sabmig "$TMP/f1.sql" 's/qtd_ml > 0 AND qtd_ml <= 18000/qtd_ml >= 0 AND qtd_ml <= 18000/'
fals "F1 qtd_ml aceita zero" "C1.qtd_0" "$TMP/f1.sql" ""

printf '%s\n' "GRANT INSERT ON public.tint_consumo_corante TO authenticated;" > "$TMP/f2.sql"
# F2/F3 derrubam TAMBÉM o C6.reapply_mesmo_estado: re-aplicar a migration sobre o drift o DESFAZ
# (o REVOKE e a policy voltam) — é desenho, não efeito colateral.
fals "F2 fato gravável por authenticated" "C5.sem_escrita_authenticated_tint_consumo_corante_INSERT C6.reapply_mesmo_estado" "$MIG" "$TMP/f2.sql"

printf '%s\n' "DROP POLICY IF EXISTS tint_consumo_preparacao_staff_le ON public.tint_consumo_preparacao;
CREATE POLICY tint_consumo_preparacao_todos_leem ON public.tint_consumo_preparacao FOR SELECT TO authenticated USING (true);" > "$TMP/f3.sql"
fals "F3 RLS aberta a qualquer autenticado" "C5.customer_le_zero C6.reapply_mesmo_estado" "$MIG" "$TMP/f3.sql"

sabmig "$TMP/f4.sql" 's/   AND capacidade_canister_ml IS NULL;  -- seed não pisa em capacidade já gravada/;/'
fals "F4 seed pisa na capacidade confirmada" "C6.capacidade_confirmada_preservada C6.reapply_mesmo_estado" "$TMP/f4.sql" ""

# ── Task 2 ──
sabmig "$TMP/fa.sql" 's/(h.run_criado_em, h.sync_run_id) < (r.started_at, r.id)/h.versao_fonte_em < m.consultado_em/'
fals "Fa versão pelo relógio da origem" "FA_ESPERADO" "$TMP/fa.sql" ""

sabmig "$TMP/fb.sql" 's/AND cc.preparacao_id = ANY (v_ids);/AND cc.preparacao_id = ANY (v_ids) AND EXISTS (SELECT 1 FROM public.tint_staging_preparacao_itens i2 JOIN public.tint_staging_preparacoes s2 ON s2.id = i2.staging_preparacao_id WHERE s2.sync_run_id = p_run_id AND s2.preparacao_id = cc.preparacao_id AND i2.ordem = cc.ordem);/'
fals "Fb upsert de itens (slot que sumiu fica)" "FB_ESPERADO" "$TMP/fb.sql" ""

sabmig "$TMP/fc.sql" 's/  IF v_lotes = m.total_lotes THEN/  IF true THEN/'
fals "Fc completa sem conferir total_lotes" "FC_ESPERADO" "$TMP/fc.sql" ""

sabmig "$TMP/fd.sql" "s/        THEN 'lotes_sobrepostos'/        AND false THEN 'lotes_sobrepostos'/"
fals "Fd sem o teste de sobreposição" "FD_ESPERADO" "$TMP/fd.sql" ""

sabmig "$TMP/fe.sql" 's/ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING/'
fals "Fe união por LAG(ate)" "FE_ESPERADO" "$TMP/fe.sql" ""

sabmig "$TMP/ff.sql" "s/                         ELSE (r.d AT TIME ZONE 'America\/Sao_Paulo')::date + 1 END,/                         ELSE (r.d AT TIME ZONE 'America\/Sao_Paulo')::date END,/"
fals "Ff dia parcial contado como coberto" "FF_ESPERADO" "$TMP/ff.sql" ""

sabmig "$TMP/fg.sql" 's/WHERE pl.account = p_account AND pl.store_code = p_store_code AND pl.expira_em > p_agora/WHERE false/'
fals "Fg plano sem a admissão em_andamento" "FG_ESPERADO" "$TMP/fg.sql" ""

cat > "$TMP/fh.sql" <<'SQL'
DO $s$
DECLARE v text := pg_get_functiondef('public.tint_promocao_tick()'::regprocedure);
        a text := E'     WHERE sr.promocao_status = \'pendente\'\n       AND sr.sync_type IS DISTINCT FROM \'preparations\'\n    UNION ALL';
BEGIN
  IF position(a in v) = 0 THEN RAISE EXCEPTION 'sabotagem no-op: âncora ausente'; END IF;
  EXECUTE replace(v, a, E'     WHERE sr.promocao_status = \'pendente\'\n    UNION ALL');
END $s$;
SQL
fals "Fh tick atual sem o filtro de preparações" "FH_ESPERADO" "$MIG" "$TMP/fh.sql"

sabmig "$TMP/fi.sql" 's/  ELSIF c.primeiro_dia_coberto IS NOT NULL THEN/  ELSIF false THEN/'
fals "Fi revisita desligada" "FI_ESPERADO" "$TMP/fi.sql" ""

sabmig "$TMP/fj.sql" 's/                    AND o.janela_desde <= e.janela_desde AND o.janela_ate >= e.janela_ate$/                    AND true/'
fals "Fj compactação sem exigir contida" "FJ_ESPERADO" "$TMP/fj.sql" ""

echo ""
echo "SABOTAGENS: $VERM vermelhas / $FALSOS falhas"   # recibo ÚNICO lido pelo db/roda-nucleo-ci.sh
if [ "$FALSOS" -ne 0 ]; then
  echo "✗ $FALSOS falsificação(ões) NÃO produziram o vermelho exato — algum assert não tem dente (ou morde demais)"
  exit 1
fi
echo "✅ PROVA OK — controle verde ($NTOT asserts) + $VERM falsificações com vermelho exato · locale=$LOC"

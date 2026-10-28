#!/usr/bin/env bash
# test-tint-corante-giro.sh — prova PG17 da migration 20261028100100_tint_corante_giro.sql (giro de corante,
# Fase 1, Task 3: faixa, regra, teto, excesso e capital por WP; advisory).
#
# Plano: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md (Task 3).
# Spec:  docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md §5.
#
# Snapshot VIVO + a migration-base 20261028100000 (Tasks 1–2) no template; a cobertura das provas passa
# pelo mesmo caminho da produção (extrações completas → tint_consumo_cobertura_em). Relógio fixo:
# 2027-06-20 15:00 SP. Bordas das faixas com valores EXATOS (a aritmética está no comentário de cada G).
#
#   db/test-tint-corante-giro.sh               → controle; imprime `PASS=<n>  FAIL=<m>`
#   db/test-tint-corante-giro.sh --falsificar  → controle + sabotagens NA MESMA invocação
#   HARNESS_LOCALE=pt_BR.UTF-8 db/test-tint-corante-giro.sh   → o mesmo no outro locale
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5469}}"
MODO=normal
case "${1:-}" in
  --falsificar) MODO=falsificar ;;
  "") ;;
  *) echo "uso: $0 [--falsificar]"; exit 2 ;;
esac
LOC="${HARNESS_LOCALE:-C}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-giro.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
BASE="$REPO_ROOT/supabase/migrations/20261028100000_tint_consumo_corante.sql"
MIG="$REPO_ROOT/supabase/migrations/20261028100100_tint_corante_giro.sql"
export LC_ALL=C LANG=C

[ -f "$SNAP" ] || { echo "INFRA: snapshot ausente: $SNAP"; exit 1; }
[ -f "$BASE" ] || { echo "migration-base ausente: $BASE"; exit 1; }
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
-- auth.uid() num corpo de função é resolvido na EXECUÇÃO (a policy já vem resolvida): o Supabase dá USAGE em auth.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
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
# A migration-base (Task 1+2) entra no TEMPLATE; a sob prova (Task 3) entra na suíte.
T0 -q --single-transaction -f "$BASE" >/dev/null
T0 -q <<'SQL' >/dev/null
-- Seed do giro (relógio fixo das provas: 2027-06-20 15:00 SP). Cobertura: 1 extração completa do piso até
-- a meia-noite de hoje → 180 dias cobertos na janela [2026-12-22, 2027-06-19].
UPDATE tint_corantes SET capacidade_canister_ml = 2300, capacidade_confirmada = true WHERE omie_product_id IS NOT NULL;
-- GL só do WP01 (o resto não tem GL no Omie)
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, unidade, account)
VALUES ('00000000-0000-0000-0000-000000000301', 9101, 'PRD09101', 'WP01.3900GL CORANTE 1 GL', 'L', 'oben');
-- LT dos QT: médio 7, p95 5 → n = 7 → LTc = 11; demanda 0,05 L/dia
INSERT INTO sku_parametros (empresa, sku_codigo_omie, lt_medio_dias_uteis, lt_p95_dias, demanda_media_diaria)
SELECT 'OBEN', 9000 + n, 7, 5, 0.05 FROM generate_series(1, 14) n;
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico)
SELECT 'OBEN', (9000 + n)::text, 0 FROM generate_series(1, 14) n;
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico) VALUES ('OBEN', '9101', 3.6);
INSERT INTO inventory_position (omie_codigo_produto, saldo, cmc, account)
SELECT 9000 + n, 0, 100, 'oben' FROM generate_series(1, 14) n;
-- cobertura e 1ª dosagem (fora da janela)
CREATE FUNCTION _g_dia(p int) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS
  $$ SELECT ((date '2027-06-20' + p)::timestamp AT TIME ZONE 'America/Sao_Paulo') $$;
CREATE FUNCTION _g_cobre(p_store text, p_desde timestamptz, p_ate timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO tint_consumo_planos (extracao_id, account, store_code, modo, janela_desde, janela_ate, criado_em, expira_em)
  VALUES (v, 'oben', p_store, 'incremental', p_desde, p_ate, p_ate, p_ate + interval '30 minutes');
  INSERT INTO tint_consumo_extracoes (extracao_id, account, store_code, modo, janela_desde, janela_ate, consultado_em,
                                      total_lotes, criada_em, completa_em)
  VALUES (v, 'oben', p_store, 'incremental', p_desde, p_ate, p_ate + interval '1 hour', 1, p_ate, p_ate);
END $$;
-- Uma preparação válida com um item; p_corante = id_corante_sayersystem ('1'..'14'; '99' = sem ponte).
CREATE FUNCTION _g_dose(p_corante text, p_quando timestamptz, p_qtd numeric, p_store text DEFAULT 'M01')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text := gen_random_uuid()::text;
BEGIN
  INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                       run_criado_em, sync_run_id)
  VALUES ('oben', p_store, v, p_quando, 'valida', p_quando, p_quando, gen_random_uuid());
  INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem, id_corante_origem, tint_corante_id,
                                    qtd_ml, data_dosagem, sync_run_id, run_criado_em)
  VALUES ('oben', p_store, v, 1, p_corante,
          (SELECT id FROM tint_corantes WHERE account = 'oben' AND id_corante_sayersystem = p_corante),
          p_qtd, p_quando, gen_random_uuid(), p_quando);
END $$;
CREATE FUNCTION _g_rejeitada(p_quando timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, motivo_rejeicao,
                                       versao_fonte_em, run_criado_em, sync_run_id)
  VALUES ('oben', 'M01', gen_random_uuid()::text, p_quando, 'rejeitada', 'slot_parcial', p_quando, p_quando,
          gen_random_uuid());
END $$;
-- Distribui p_total ml em p_n dosagens iguais, uma por dia, a partir do 1º dia da janela.
CREATE FUNCTION _g_espalha(p_corante text, p_total numeric, p_n int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  FOR i IN 0 .. p_n - 1 LOOP
    PERFORM _g_dose(p_corante, _g_dia(-180 + i) + interval '10 hours', p_total / p_n);
  END LOOP;
END $$;
-- O giro de um WP, como staff (gate da função), no relógio fixo.
SELECT _g_cobre('M01', ((date '2027-06-20' - 400)::timestamp AT TIME ZONE 'America/Sao_Paulo'), _g_dia(0));
SELECT _g_dose('14', ((date '2027-06-20' - 399)::timestamp AT TIME ZONE 'America/Sao_Paulo') + interval '10 hours', 1);
SQL
PA -q -d postgres -c "CREATE DATABASE tpl TEMPLATE tpl0 STRATEGY FILE_COPY" >/dev/null

# Toda leitura do giro nas provas é como STAFF (o gate da função exige has_role); o postgres fura o RLS.
STAFF="SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';"
G() { PA -d "$1" -q -c "$STAFF" -f -; }

# ═════════════════════════════ CENÁRIOS ═════════════════════════════

# G1 — borda s = u (devagar) e +0,001 ml/dia (rápido, k = 1). LT n = 8 → LTc = 12; 12150 ml em 180 dias.
cen_G1() { G "$1" <<'SQL'
UPDATE sku_parametros SET lt_medio_dias_uteis = 8 WHERE sku_codigo_omie IN (9002, 9003);
SELECT _g_espalha('2', 12150, 180);
SELECT _g_espalha('3', 12150, 180);
SELECT _g_dose('3', _g_dia(-100) + interval '11 hours', 0.18);
SELECT _t_assert('G1.s_igual_u_devagar', (SELECT faixa = 'devagar' AND ponto_pedido_ml = 810 AND lt_dias_corridos = 12
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP02'));
SELECT _t_assert('G1.acima_rapido_k1', (SELECT faixa = 'rapido' AND k_latas = 1 AND teto_l = 1.62
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP03'));
SQL
}

# G2 — borda 2u/d − LTc = 365 (não é muito_pouco); 1 ml a menos no período → muito_pouco. n = 6 → LTc = 10.
cen_G2() { G "$1" <<'SQL'
UPDATE sku_parametros SET lt_medio_dias_uteis = 6 WHERE sku_codigo_omie IN (9004, 9005);
SELECT _g_espalha('4', 777.6, 12);
SELECT _g_espalha('5', 776.6, 12);
SELECT _t_assert('G2.borda_nao_muito_pouco', (SELECT faixa = 'devagar'
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP04'));
SELECT _t_assert('G2.abaixo_muito_pouco', (SELECT faixa = 'muito_pouco' AND teto_l = 0
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP05'));
SQL
}

# G3 — borda u/d = 365 (u = 730 pela capacidade): não é parado; um pouco abaixo de d → parado.
cen_G3() { G "$1" <<'SQL'
UPDATE tint_corantes SET capacidade_canister_ml = 730 WHERE id_corante_sayersystem IN ('6', '7');
SELECT _g_espalha('6', 360, 12);
SELECT _g_espalha('7', 359, 12);
SELECT _t_assert('G3.borda_nao_parado', (SELECT faixa <> 'parado' AND recarga_ml = 730
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP06'));
SELECT _t_assert('G3.abaixo_parado', (SELECT faixa = 'parado'
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP07'));
SQL
}

# G4 — d = 0: 180 dias → parado; 120 → faixa 1 sem_consumo_cobertura_parcial; 59 → cobertura_insuficiente.
cen_G4() { G "$1" <<'SQL'
SELECT _t_assert('G4.zero_180_parado', (SELECT faixa = 'parado' AND consumo_ml_dia = 0 AND dias_cobertos = 180
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP08'));
DELETE FROM tint_consumo_planos;
SELECT _g_cobre('M01', _g_dia(-120), _g_dia(0));
SELECT _t_assert('G4.zero_120_parcial', (SELECT faixa = 'sem_recomendacao' AND motivo = 'sem_consumo_cobertura_parcial'
  AND dias_cobertos = 120 AND confianca = 'baixa'
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP08'));
DELETE FROM tint_consumo_planos;
SELECT _g_cobre('M01', _g_dia(-59), _g_dia(0));
SELECT _t_assert('G4.59_insuficiente', (SELECT motivo = 'cobertura_insuficiente'
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP08'));
SQL
}

# G5 — consumo esparso: P90 = 0, d·LTc ≈ 2,33; o piso da maior dosagem decide (s = 30). n = 5 → LTc = 7.
cen_G5() { G "$1" <<'SQL'
UPDATE sku_parametros SET lt_medio_dias_uteis = 5, lt_p95_dias = 0 WHERE sku_codigo_omie = 9009;
SELECT _g_dose('9', _g_dia(-150) + interval '10 hours', 30);
SELECT _g_dose('9', _g_dia(-60) + interval '10 hours', 30);
SELECT _t_assert('G5.piso_maior_dosagem', (SELECT ponto_pedido_ml = 30 AND maior_dosagem_ml = 30 AND lt_dias_corridos = 7
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP09'));
SQL
}

# G6 — capacidade não confirmada → faixa 1; confirmada → faixa calculada.
cen_G6() { G "$1" <<'SQL'
UPDATE tint_corantes SET capacidade_confirmada = false WHERE id_corante_sayersystem = '10';
SELECT _t_assert('G6.nao_confirmada', (SELECT faixa = 'sem_recomendacao' AND motivo = 'capacidade_nao_confirmada'
  AND faixa_ultimo_calculo = 'sem_recomendacao'
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP10'));
SELECT _t_assert('G6.confirmada', (SELECT faixa = 'parado' AND motivo IS NULL
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP11'));
SQL
}

# G7 — duas lojas com cobertura → as 14 linhas mais_de_uma_loja.
cen_G7() { G "$1" <<'SQL'
SELECT _g_cobre('M02', _g_dia(-200), _g_dia(0));
SELECT _t_assert('G7.duas_lojas', (SELECT count(*) = 14 AND bool_and(motivo = 'mais_de_uma_loja')
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
SQL
}

# G8 — frescor: até 4 dias − 1 s fresco; 4 dias exatos → desatualizado, com o último cálculo; fuso não muda nada.
cen_G8() { G "$1" <<'SQL'
UPDATE sku_parametros SET lt_medio_dias_uteis = 8 WHERE sku_codigo_omie = 9002;
SELECT _g_espalha('2', 12150, 180);
SELECT _t_assert('G8.fresco', (SELECT fresco AND faixa = 'devagar'
  FROM tint_corante_giro_em(_g_dia(0) + interval '4 days' - interval '1 second') WHERE wp_codigo = 'WP02'));
SELECT _t_assert('G8.desatualizado', (SELECT NOT fresco AND faixa = 'sem_recomendacao' AND motivo = 'dado_desatualizado'
  AND faixa_ultimo_calculo = 'devagar' AND excesso_l IS NULL
  FROM tint_corante_giro_em(_g_dia(0) + interval '4 days') WHERE wp_codigo = 'WP02'));
SET TIME ZONE 'UTC';
CREATE TEMP TABLE _g8 AS SELECT md5(string_agg(wp_codigo || faixa || COALESCE(motivo, '-') || consumo_ml_dia::text
  || dias_cobertos || extract(epoch FROM coberto_ate), ';' ORDER BY wp_codigo)) AS u
  FROM tint_corante_giro_em('2027-06-20 15:00-03');
SET TIME ZONE 'America/Sao_Paulo';
SELECT _t_assert('G8.tz_igual', (SELECT u FROM _g8) = (SELECT md5(string_agg(wp_codigo || faixa || COALESCE(motivo, '-')
  || consumo_ml_dia::text || dias_cobertos || extract(epoch FROM coberto_ate), ';' ORDER BY wp_codigo))
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
SQL
}

# G9 — dia fora da cobertura não vira zero: 10 dias de dosagem, cobertura só nos 5 últimos → d sobre 5 dias.
cen_G9() { G "$1" <<'SQL'
DELETE FROM tint_consumo_planos;
SELECT _g_cobre('M01', _g_dia(-5), _g_dia(0));
DO $$ BEGIN FOR i IN 1 .. 10 LOOP PERFORM _g_dose('11', _g_dia(-i) + interval '10 hours', 10); END LOOP; END $$;
SELECT _t_assert('G9.fora_nao_zero', (SELECT dias_cobertos = 5 AND consumo_ml_dia = 10
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP11'));
DELETE FROM tint_consumo_planos;
SELECT _g_cobre('M01', _g_dia(-6) + interval '16 hours 55 minutes', _g_dia(0));
SELECT _t_assert('G9.meio_dia_fora', (SELECT dias_cobertos = 5 AND consumo_ml_dia = 10
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP11'));
SQL
}

# G10 — LT: QT sem LT e GL com médio 7 → GL (LTc 11); sem os dois → mediana dos WP; nenhum → lt_sem_fonte.
cen_G10() { G "$1" <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, unidade, account)
VALUES ('00000000-0000-0000-0000-000000000312', 9112, 'PRD09112', 'WP12.3900GL CORANTE 12 GL', 'L', 'oben');
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico) VALUES ('OBEN', '9112', 0);
DELETE FROM sku_parametros WHERE sku_codigo_omie IN (9012, 9013);
INSERT INTO sku_parametros (empresa, sku_codigo_omie, lt_medio_dias_uteis, lt_p95_dias) VALUES ('OBEN', 9112, 7, 2);
SELECT _t_assert('G10.gl', (SELECT lt_fonte = 'GL' AND lt_dias_corridos = 11
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP12'));
SELECT _t_assert('G10.mediana', (SELECT lt_fonte = 'mediana_wp' AND lt_dias_corridos = 11 AND motivo IS NULL
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP13'));
DELETE FROM sku_parametros;
SELECT _t_assert('G10.sem_fonte', (SELECT count(*) = 14 AND bool_and(motivo = 'lt_sem_fonte' AND lt_fonte IS NULL)
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
SQL
}

# G11 — estoque: GL existe sem linha de estoque → estoque, excesso e capital NULL (nunca 0); GL inexistente → só o
# QT; GL existe sem sku_parametros → demanda do motor NULL.
cen_G11() { G "$1" <<'SQL'
UPDATE sku_estoque_atual SET estoque_fisico = 2 WHERE sku_codigo_omie IN ('9001', '9002');
INSERT INTO sku_parametros (empresa, sku_codigo_omie, lt_medio_dias_uteis, lt_p95_dias) VALUES ('OBEN', 9101, 7, 5);
SELECT _t_assert('G11.com_gl_soma', (SELECT estoque_fechado_l = 5.6 AND excesso_l = 5.6 AND demanda_motor_l_dia IS NULL
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP01'));
DELETE FROM sku_estoque_atual WHERE sku_codigo_omie = '9101';
SELECT _t_assert('G11.gl_sem_estoque_null', (SELECT estoque_fechado_l IS NULL AND excesso_l IS NULL
  AND capital_parado IS NULL AND faixa = 'parado'
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP01'));
SELECT _t_assert('G11.sem_gl_so_qt', (SELECT estoque_fechado_l = 2 AND excesso_l = 2 AND demanda_motor_l_dia = 0.05
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP02'));
SQL
}

# G12 — capital = excesso (L) × cmc (R$/L), sem ÷ 0,81.
cen_G12() { G "$1" <<'SQL'
UPDATE sku_estoque_atual SET estoque_fisico = 1.62 WHERE sku_codigo_omie = '9014';
UPDATE inventory_position SET cmc = 101.076754 WHERE omie_codigo_produto = 9014;
SELECT _t_assert('G12.capital', (SELECT faixa = 'parado' AND excesso_l = 1.62 AND capital_parado = 1.62 * 101.076754
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP14'),
  (SELECT capital_parado::text FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP14'));
SQL
}

# G13 — sem-ponte e rejeitadas acima de 1% → faixa 1 em TODOS; abaixo → faixa calculada.
cen_G13() { G "$1" <<'SQL'
SELECT _g_espalha('11', 10000, 100);
SELECT _g_dose('99', _g_dia(-50) + interval '10 hours', 100);
SELECT _t_assert('G13.sem_ponte_abaixo', (SELECT bool_and(motivo IS DISTINCT FROM 'dosagens_sem_ponte')
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
SELECT _g_dose('99', _g_dia(-49) + interval '10 hours', 2);
SELECT _t_assert('G13.sem_ponte_acima', (SELECT count(*) = 14 AND bool_and(motivo = 'dosagens_sem_ponte')
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
DELETE FROM tint_consumo_corante WHERE id_corante_origem = '99';
DELETE FROM tint_consumo_preparacao p WHERE NOT EXISTS (SELECT 1 FROM tint_consumo_corante c
  WHERE c.preparacao_id = p.preparacao_id) AND p.situacao = 'valida';
SELECT _g_rejeitada(_g_dia(-40) + interval '10 hours');
SELECT _t_assert('G13.rejeitadas_abaixo', (SELECT bool_and(motivo IS DISTINCT FROM 'preparacoes_rejeitadas')
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
SELECT _g_rejeitada(_g_dia(-39) + interval '10 hours');
SELECT _t_assert('G13.rejeitadas_acima', (SELECT count(*) = 14 AND bool_and(motivo = 'preparacoes_rejeitadas')
  FROM tint_corante_giro_em('2027-06-20 15:00-03')));
SQL
}

# G16 — o P90 decide quando o consumo se concentra: 50 ml/dia só nos últimos 60 dias da janela.
# d = 3000/180 ≈ 16,67 → d·LTc(11) ≈ 183,3; maior dosagem 50; janelas de 11 dias inteiras no bloco = 550, e os
# 10% maiores das 170 janelas são todas 550 → P90 = 550 > os dois pisos → s = 550.
cen_G16() { G "$1" <<'SQL'
DO $$ BEGIN FOR i IN 1 .. 60 LOOP PERFORM _g_dose('13', _g_dia(-i) + interval '10 hours', 50); END LOOP; END $$;
SELECT _t_assert('G16.p90_decide', (SELECT ponto_pedido_ml = 550 AND maior_dosagem_ml = 50
  FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP13'),
  (SELECT ponto_pedido_ml::text FROM tint_corante_giro_em('2027-06-20 15:00-03') WHERE wp_codigo = 'WP13'));
SQL
}

# G14 — RLS pela view (security_invoker): customer 0 linhas; staff as 14.
cen_G14() { PA -d "$1" -q <<'SQL'
SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
SET ROLE authenticated;
CREATE TEMP TABLE _g14c AS SELECT count(*) AS n FROM v_corante_giro;
RESET ROLE;
SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
SET ROLE authenticated;
CREATE TEMP TABLE _g14s AS SELECT count(*) AS n FROM v_corante_giro;
RESET ROLE;
SELECT _t_assert('G14.customer_zero', (SELECT n FROM _g14c) = 0, (SELECT n FROM _g14c)::text);
SELECT _t_assert('G14.staff_14', (SELECT n FROM _g14s) = 14, (SELECT n FROM _g14s)::text);
SQL
}

# G15 — as duas views com security_invoker=on.
cen_G15() { PA -d "$1" -q <<'SQL'
SELECT _t_assert('G15.' || v, (SELECT reloptions @> ARRAY['security_invoker=on'] FROM pg_class
  WHERE oid = to_regclass('public.' || v))) FROM unnest(ARRAY['v_corante_consumo_diario', 'v_corante_giro']) v ORDER BY v;
SQL
}

CENARIOS="G1 G2 G3 G4 G5 G6 G7 G8 G9 G10 G11 G12 G13 G14 G15 G16"
NESP=34   # nº EXATO de asserts: assert que some (cenário que parou no meio) é falha, não verde

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
    "cen_$c" "$db" >/dev/null 2>"$TMP/$db.err" || echo "RES|$c.EXEC|f|$(head -c 300 "$TMP/$db.err" | tr '\n' ' ')"
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
sabmig "$TMP/g1.sql" 's/WHEN b.d > 0 AND 2 \* b.u \/ b.d - b.ltc > b.validade_dias/WHEN b.d > 0 AND 2 * b.u \/ b.d - b.ltc >= b.validade_dias/'
fals "Fg1 muito_pouco com >= na borda" "G2.borda_nao_muito_pouco" "$TMP/g1.sql" ""

sabmig "$TMP/g2.sql" 's/              ELSE greatest(0, f.fechado_l - t.teto) \* f.cmc END,/              ELSE greatest(0, f.fechado_l - t.teto) * f.cmc \/ 0.81 END,/'
fals "Fg2 capital com ÷ 0,81 de volta" "G12.capital" "$TMP/g2.sql" ""

sabmig "$TMP/g3.sql" '/WHEN eg.estoque_fisico IS NULL THEN NULL /d; s/ELSE eq.estoque_fisico + eg.estoque_fisico END AS fechado_l/ELSE eq.estoque_fisico + COALESCE(eg.estoque_fisico, 0) END AS fechado_l/'
fals "Fg3 GL sem estoque somado como 0" "G11.gl_sem_estoque_null" "$TMP/g3.sql" ""

sabmig "$TMP/g4.sql" 's/         CASE WHEN f.fechado_l IS NULL OR t.teto IS NULL THEN NULL ELSE greatest(0, f.fechado_l - t.teto) END,/         greatest(0, f.fechado_l - t.teto),/'
fals "Fg4 excesso sem o CASE (greatest(0, NULL) = 0)" "G11.gl_sem_estoque_null G8.desatualizado" "$TMP/g4.sql" ""

sabmig "$TMP/g5.sql" 's/(cob.ilha_ate > p_agora - make_interval(days => k.frescor_dias))/(cob.ilha_ate >= p_agora - make_interval(days => k.frescor_dias))/'
fals "Fg5 frescor com >= (4 dias exatos ainda fresco)" "G8.desatualizado" "$TMP/g5.sql" ""

sabmig "$TMP/g6.sql" 's/           sum(d.qtd_ml) \/ NULLIF(count(d.dia), 0) AS d,/           sum(d.qtd_ml) \/ 180.0 AS d,/'
fals "Fg6 denominador fixo de 180 dias" "G9.fora_nao_zero G9.meio_dia_fora" "$TMP/g6.sql" ""

sabmig "$TMP/g7.sql" 's/greatest(c.d \* lt.ltc, p90.v, m.m) AS s/greatest(c.d * lt.ltc, p90.v) AS s/'
fals "Fg7 sem o piso da maior dosagem" "G5.piso_maior_dosagem" "$TMP/g7.sql" ""

sabmig "$TMP/g8.sql" 's/greatest(c.d \* lt.ltc, p90.v, m.m) AS s/greatest(c.d * lt.ltc, m.m) AS s/'
fals "Fg8 sem o P90 das janelas" "G16.p90_decide" "$TMP/g8.sql" ""

echo ""
echo "SABOTAGENS: $VERM vermelhas / $FALSOS falhas"   # recibo ÚNICO lido pelo db/roda-nucleo-ci.sh
if [ "$FALSOS" -ne 0 ]; then
  echo "✗ $FALSOS falsificação(ões) NÃO produziram o vermelho exato — algum assert não tem dente (ou morde demais)"
  exit 1
fi
echo "✅ PROVA OK — controle verde ($NTOT asserts) + $VERM falsificações com vermelho exato · locale=$LOC"

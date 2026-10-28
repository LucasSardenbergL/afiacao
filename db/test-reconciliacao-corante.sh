#!/usr/bin/env bash
# test-reconciliacao-corante.sh — prova PG17 da Task 4 do giro de corante (Fase 1):
#   · a consulta db/consultas/reconciliacao-corante-fase2.sql (critério 2 de entrada da Fase 2, spec §11.2),
#     com as falsificações OBRIGATÓRIAS da spec como cenários (feed zerado e unidade × 1,95 reprovam);
#   · a migration 20261028100200_analytics_ledger_corantes.sql (o sensor `reposicao.corantes_aberta`).
# Plano: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md (Task 4).
#
#   db/test-reconciliacao-corante.sh               → controle; imprime `PASS=<n>  FAIL=<m>`
#   db/test-reconciliacao-corante.sh --falsificar  → controle + sabotagens NA MESMA invocação
#   HARNESS_LOCALE=pt_BR.UTF-8 db/test-reconciliacao-corante.sh   → o mesmo no outro locale
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5470}}"
MODO=normal
case "${1:-}" in
  --falsificar) MODO=falsificar ;;
  "") ;;
  *) echo "uso: $0 [--falsificar]"; exit 2 ;;
esac
LOC="${HARNESS_LOCALE:-C}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-recon.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
BASE="$REPO_ROOT/supabase/migrations/20261028100000_tint_consumo_corante.sql"
MIG="$REPO_ROOT/supabase/migrations/20261028100200_analytics_ledger_corantes.sql"
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
  WHEN invalid_parameter_value THEN RETURN '22023';
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
# A migration-base (Tasks 1–2: o fato de consumo) entra no TEMPLATE; a do ledger entra na suíte.
T0 -q --single-transaction -f "$BASE" >/dev/null
# O snapshot vivo traz o ledger de ANTES da 20261020 (md5 9772…); a PROD está nela (6eaf…, psql-ro
# 2026-10-28). Aplicá-la aqui põe o template no estado da prod antes da migration sob prova.
T0 -q -f "$REPO_ROOT/supabase/migrations/20261020202720_analytics_ledger_venda_cliente.sql" >/dev/null
T0 -q <<'SQL' >/dev/null
-- Os 14 WP da linha de base (§3 da spec), pelos códigos reais.
UPDATE omie_products op SET descricao = c.wp || '.3900QT CORANTE'
  FROM (SELECT n, (ARRAY['WP01','WP02','WP03','WP04','WP42','WP06','WP07','WP08','WP12','WP53','WP69','WP71',
                         'WP87','WP88'])[n] AS wp FROM generate_series(1, 14) n) c
 WHERE op.omie_codigo_produto = 9000 + c.n;
UPDATE tint_corantes SET capacidade_canister_ml = 2300, capacidade_confirmada = true WHERE omie_product_id IS NOT NULL;
-- Físico inicial = a linha de base: sem movimento, retirado = 0 (o WP não é elegível por acaso).
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico)
SELECT 'OBEN', (9000 + n)::text,
       (ARRAY[7.11, 2.43, 3.67, 3.24, 1.62, 2.43, 0.81, 5.48, 7.91, 1.43, 3.05, 0.00, 8.34, 0.00])[n]
  FROM generate_series(1, 14) n;
INSERT INTO warehouses (id, code, name) VALUES ('99999999-0000-0000-0000-000000000001', 'OBN', 'Oben');
CREATE FUNCTION _r_cod(p_wp text) RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT omie_codigo_produto FROM omie_products WHERE descricao = p_wp || '.3900QT CORANTE' $$;
-- Estado de um WP: linha de base implícita (§3) → recebe p_rec L → físico atual p_fis L → dosa p_dos L.
CREATE FUNCTION _r_wp(p_wp text, p_rec numeric, p_fis numeric, p_dos_l numeric, p_unid text DEFAULT 'L')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_nf uuid := gen_random_uuid(); v_prep text := gen_random_uuid()::text;
BEGIN
  IF p_rec > 0 THEN
    INSERT INTO nfe_recebimentos (id, warehouse_id, numero_nfe, chave_acesso, cnpj_emitente, status, efetivado_at)
    VALUES (v_nf, '99999999-0000-0000-0000-000000000001', left(v_prep, 20), lpad(left(replace(v_prep, '-', ''), 30), 44, '0'),
            '00000000000191', 'efetivado', '2026-11-15 10:00-03');
    INSERT INTO nfe_recebimento_itens (nfe_recebimento_id, sequencia, descricao, codigo_produto, unidade_nfe,
                                       quantidade_nfe, quantidade_esperada, produto_omie_id)
    VALUES (v_nf, 1, p_wp || ' QT', 'PRD', p_unid, p_rec, 1, _r_cod(p_wp));
  END IF;
  UPDATE sku_estoque_atual SET estoque_fisico = p_fis WHERE sku_codigo_omie = _r_cod(p_wp)::text;
  -- dosado em preparações de até 1 L (o teto físico de 18 L por preparação vale também na fixture)
  FOR i IN 1 .. ceil(p_dos_l)::int LOOP
    v_prep := gen_random_uuid()::text;
    INSERT INTO tint_consumo_preparacao (account, store_code, preparacao_id, data_dosagem, situacao, versao_fonte_em,
                                         run_criado_em, sync_run_id)
    VALUES ('oben', 'M01', v_prep, '2026-12-01 10:00-03', 'valida', now(), now(), gen_random_uuid());
    INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem, id_corante_origem, tint_corante_id,
                                      qtd_ml, data_dosagem, sync_run_id, run_criado_em)
    SELECT 'oben', 'M01', v_prep, 1, tc.id_corante_sayersystem, tc.id, p_dos_l * 1000 / ceil(p_dos_l),
           '2026-12-01 10:00-03', gen_random_uuid(), now()
      FROM tint_corantes tc JOIN omie_products op ON op.id = tc.omie_product_id
     WHERE op.omie_codigo_produto = _r_cod(p_wp);
  END LOOP;
END $$;
CREATE TABLE _r_out (linha text);
SQL
PA -q -d postgres -c "CREATE DATABASE tpl TEMPLATE tpl0 STRATEGY FILE_COPY" >/dev/null

QRY="$REPO_ROOT/db/consultas/reconciliacao-corante-fase2.sql"
[ -f "$QRY" ] || { echo "consulta ausente: $QRY"; exit 1; }
# veredito <db> → a linha VEREDITO da consulta (relógio fixo depois de toda a fixture)
veredito() { PA -d "$1" -tA -v agora="'2027-02-01 12:00-03'" -f "$QRY" | grep '^VEREDITO|' | awk -F'|' '{print $NF}'; }

# ═════════════════════════════ CENÁRIOS ═════════════════════════════

# R1 — consistente: 6 WP elegíveis, dosado = retirado (± dentro da tolerância) → passou.
# retirado = base + recebido − físico; ex. WP01: 7,11 + 10 − 4,11 = 13.
cen_R1() { local db=$1 v
PA -d "$db" -q <<'SQL' || return 1
SELECT _r_wp('WP01', 10, 4.11, 13.2);
SELECT _r_wp('WP02', 5, 1.43, 6);
SELECT _r_wp('WP03', 4, 2.67, 5);
SELECT _r_wp('WP08', 2, 3.48, 3.9);
SELECT _r_wp('WP12', 3, 6.91, 4);
SELECT _r_wp('WP87', 0, 5.34, 3.1);
SQL
v="$(veredito "$db")" || return 1
PA -d "$db" -q -c "SELECT _t_assert('R1.consistente_passou', '$v' = 'passou', '$v')"
}

# R2 — feed zerado (dosado = 0): falsificação obrigatória da spec → reprovou.
cen_R2() { local db=$1 v
PA -d "$db" -q <<'SQL' || return 1
SELECT _r_wp('WP01', 10, 4.11, 0);
SELECT _r_wp('WP02', 5, 1.43, 0);
SELECT _r_wp('WP03', 4, 2.67, 0);
SELECT _r_wp('WP08', 2, 3.48, 0);
SELECT _r_wp('WP12', 3, 6.91, 0);
SELECT _r_wp('WP87', 0, 5.34, 0);
SQL
v="$(veredito "$db")" || return 1
PA -d "$db" -q -c "SELECT _t_assert('R2.feed_zerado_reprovou', '$v' = 'reprovou', '$v')"
}

# R3 — unidade errada (dosado × 1,95, o peso do WP07): falsificação obrigatória → reprovou.
cen_R3() { local db=$1 v
PA -d "$db" -q <<'SQL' || return 1
SELECT _r_wp('WP01', 10, 4.11, 13 * 1.95);
SELECT _r_wp('WP02', 5, 1.43, 6 * 1.95);
SELECT _r_wp('WP03', 4, 2.67, 5 * 1.95);
SELECT _r_wp('WP08', 2, 3.48, 4 * 1.95);
SELECT _r_wp('WP12', 3, 6.91, 4 * 1.95);
SELECT _r_wp('WP87', 0, 5.34, 3 * 1.95);
SQL
v="$(veredito "$db")" || return 1
PA -d "$db" -q -c "SELECT _t_assert('R3.unidade_errada_reprovou', '$v' = 'reprovou', '$v')"
}

# R4 — só 4 WP elegíveis (retirado >= 2 L): o critério NÃO foi medido (não "passou").
cen_R4() { local db=$1 v
PA -d "$db" -q <<'SQL' || return 1
SELECT _r_wp('WP01', 10, 4.11, 13);
SELECT _r_wp('WP02', 5, 1.43, 6);
SELECT _r_wp('WP03', 4, 2.67, 5);
SELECT _r_wp('WP08', 2, 3.48, 4);
SQL
v="$(veredito "$db")" || return 1
PA -d "$db" -q -c "SELECT _t_assert('R4.quatro_elegiveis_nao_medido', '$v' = 'nao_medido', '$v')"
}

# R5 — elegível sem medida (capacidade do canister desconhecida) → nao_medido, nunca "passou" (ausente ≠ zero).
cen_R5() { local db=$1 v
PA -d "$db" -q <<'SQL' || return 1
SELECT _r_wp('WP01', 10, 4.11, 13);
SELECT _r_wp('WP02', 5, 1.43, 6);
SELECT _r_wp('WP03', 4, 2.67, 5);
SELECT _r_wp('WP08', 2, 3.48, 4);
SELECT _r_wp('WP12', 3, 6.91, 4);
SELECT _r_wp('WP87', 0, 5.34, 3);
UPDATE tint_corantes SET capacidade_canister_ml = NULL
 WHERE omie_product_id = (SELECT id FROM omie_products WHERE descricao = 'WP87.3900QT CORANTE');
SQL
v="$(veredito "$db")" || return 1
PA -d "$db" -q -c "SELECT _t_assert('R5.capacidade_desconhecida_nao_medido', '$v' = 'nao_medido', '$v')"
}

# L — o sensor da aba no ledger: o corpo vivo do snapshot é o predecessor; o evento novo é aceito; o
# desconhecido volta 22023.
cen_L() { PA -d "$1" -q <<'SQL'
SELECT _t_assert('L.corpo_novo', (SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.analytics_ledger_registrar(text,text,jsonb)'::regprocedure) = 'ca71354bee7c0fe4252ddb5368ef98de');
SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
SET ROLE authenticated;
CREATE TEMP TABLE _l AS
SELECT _t_sqlstate($s$SELECT public.analytics_ledger_registrar('reposicao.corantes_aberta', 'OBEN', '{}')$s$) AS novo,
       _t_sqlstate($s$SELECT public.analytics_ledger_registrar('reposicao.evento_inexistente', 'OBEN', '{}')$s$) AS fora;
RESET ROLE;
SELECT _t_assert('L.evento_aceito', (SELECT novo FROM _l) = 'OK'
  AND EXISTS (SELECT 1 FROM analytics_outbox WHERE evento = 'reposicao.corantes_aberta'), (SELECT novo FROM _l));
SELECT _t_assert('L.fora_da_allowlist_22023', (SELECT fora FROM _l) = '22023', (SELECT fora FROM _l));
SQL
}

CENARIOS="R1 R2 R3 R4 R5 L"
NESP=8   # nº EXATO de asserts: assert que some (cenário que parou no meio) é falha, não verde

# PRE do ledger: o snapshot vivo traz o predecessor revisado (asserção, não suposição).
PRED="$(PA -d tpl -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.analytics_ledger_registrar(text,text,jsonb)'::regprocedure")"
[ "$PRED" = "6eaf1d41626ece3a6fe6b51617788f21" ] || { echo "INFRA: ledger do snapshot não é o predecessor revisado ($PRED)"; exit 1; }

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

echo "════ CONTROLE — migration e consulta reais ════"
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
# falsq <nome> <esperado> <sed-expr> — sabota a CONSULTA (não a migration), falha se o sed não mudou nada
falsq() {
  local orig=$QRY
  sed "$3" "$orig" > "$TMP/q.sql"
  if cmp -s "$orig" "$TMP/q.sql"; then echo "✗ sabotagem no-op ($3) — âncora sumiu da consulta"; exit 1; fi
  QRY="$TMP/q.sql"
  fals "$1" "$2" "$MIG" ""
  QRY=$orig
}

echo "════ FALSIFICAÇÕES ════"
falsq "Fr1 sem o piso de elegibilidade (2 L)" "R4.quatro_elegiveis_nao_medido" 's/(p.retirado_l >= 2) AS elegivel/(p.retirado_l IS NOT NULL) AS elegivel/'
falsq "Fr2 dosado em ml (sem ÷ 1000)" "R1.consistente_passou" 's/COALESCE(sum(c.qtd_ml), 0) \/ 1000 AS dosado_l/COALESCE(sum(c.qtd_ml), 0) AS dosado_l/'
falsq "Fr3 elegível sem medida não derruba o veredito" "R5.capacidade_desconhecida_nao_medido" 's/WHEN a.n_elegiveis < 5 OR a.algum_sem_medida THEN/WHEN a.n_elegiveis < 5 THEN/'
perl -0pe "s/'venda.painel_aberto',\n\s+'reposicao.corantes_aberta'\) THEN/'venda.painel_aberto') THEN/" "$MIG" > "$TMP/fl.sql"
if cmp -s "$MIG" "$TMP/fl.sql"; then echo "✗ sabotagem no-op (allowlist)"; exit 1; fi
fals "Fl ledger sem o evento novo (a PÓS do md5 aborta o apply)" "APPLY" "$TMP/fl.sql" ""

echo ""
echo "SABOTAGENS: $VERM vermelhas / $FALSOS falhas"   # recibo ÚNICO lido pelo db/roda-nucleo-ci.sh
if [ "$FALSOS" -ne 0 ]; then
  echo "✗ $FALSOS falsificação(ões) NÃO produziram o vermelho exato — algum assert não tem dente (ou morde demais)"
  exit 1
fi
echo "✅ PROVA OK — controle verde ($NTOT asserts) + $VERM falsificações com vermelho exato · locale=$LOC"

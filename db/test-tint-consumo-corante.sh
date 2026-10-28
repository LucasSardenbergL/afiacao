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
VALUES ('oben', 'M01', 'P1', '2026-10-01 10:00-03', 'valida', now(), now(), 'c0000000-0000-0000-0000-000000000001');
CREATE TEMP TABLE _c1 (ordem int, q text, esperado text);
INSERT INTO _c1 VALUES (1, '0', '23514'), (2, '-1', '23514'), (3, '''NaN''', '23514'), (4, '''Infinity''', '23514'),
                       (5, '18000.001', '23514'), (6, '18000', 'OK'), (1, '0.01', 'OK');
SELECT _t_assert('C1.qtd_' || replace(replace(q, '''', ''), '.', '_'),
                 _t_sqlstate(format($f$INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem,
                   id_corante_origem, qtd_ml, data_dosagem, sync_run_id, run_criado_em)
                   VALUES ('oben','M01','P1',%s,'1',%s,'2026-10-01 10:00-03','c0000000-0000-0000-0000-000000000001',now())$f$,
                   ordem, q)) = esperado, q)
  FROM _c1 ORDER BY ordem, q;
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
CREATE TEMP TABLE _c3 (nome text, lote text, total text, desde text, ate text, cons text, n_itens text, modo text, esperado text);
INSERT INTO _c3 VALUES
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
    modo, janela_desde, janela_ate, consultado_em, n_preparacoes, n_rejeitadas, n_itens)
  VALUES ('c0000000-0000-0000-0000-000000000001','oben','M01',gen_random_uuid(),%s,%s,%L,%L,%L,%L,0,0,%s)$f$,
  lote, total, modo, desde, ate, cons, n_itens)) = esperado, nome)
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
      AND rescan_janela_dias = 35 AND rescan_intervalo_dias = 7 AND fila_max_pendentes = 6
      AND relogio_tolerancia = interval '10 minutes'
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
INSERT INTO tint_consumo_extracoes (extracao_id, account, store_code, modo, janela_desde, janela_ate, consultado_em,
                                    total_lotes, criada_em, completa_em)
VALUES ('e0000000-0000-0000-0000-000000000001', 'oben', 'M01', 'incremental', '2026-10-01 00:00-03',
        '2026-10-02 00:00-03', '2026-10-02 00:00-03', 1, now(), now());
INSERT INTO tint_consumo_extracao_lotes (extracao_id, lote, sync_run_id, n_preparacoes, n_rejeitadas, n_itens, promovido_em)
VALUES ('e0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 1, 0, 1, now());

SELECT _t_assert('C5.sem_escrita_' || r || '_' || t || '_' || p, NOT has_table_privilege(r, 'public.' || t, p), r)
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
       unnest(ARRAY['tint_consumo_preparacao', 'tint_consumo_corante', 'tint_consumo_extracoes',
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
     + (SELECT count(*) FROM tint_staging_preparacao_manifestos) AS n;
RESET ROLE;
SET request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
SET ROLE authenticated;
CREATE TEMP TABLE _c5_staff AS
SELECT (SELECT count(*) FROM tint_consumo_preparacao) AS p, (SELECT count(*) FROM tint_consumo_corante) AS c,
       (SELECT count(*) FROM tint_consumo_extracoes) AS e, (SELECT count(*) FROM tint_consumo_extracao_lotes) AS l;
CREATE TEMP TABLE _c5_ins AS
SELECT _t_sqlstate($s$INSERT INTO tint_consumo_corante (account, store_code, preparacao_id, ordem, id_corante_origem,
  qtd_ml, data_dosagem, sync_run_id, run_criado_em) VALUES ('oben','M01','P1',2,'1',5,now(),
  'c0000000-0000-0000-0000-000000000001',now())$s$) AS st;
RESET ROLE;
RESET request.jwt.claim.sub;
SELECT _t_assert('C5.customer_le_zero', (SELECT n FROM _c5_cli) = 0, (SELECT n FROM _c5_cli)::text);
SELECT _t_assert('C5.staff_le', (SELECT p = 1 AND c = 1 AND e = 1 AND l = 1 FROM _c5_staff));
SELECT _t_assert('C5.staff_insert_negado', (SELECT st FROM _c5_ins) = '42501', (SELECT st FROM _c5_ins));
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
                       'tint_consumo_plano_extracao', 'tint_promocao_tick')
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

CENARIOS="C1 C2 C3 C4 C5 C6"
NESP=64   # nº EXATO de asserts: assert que some (cenário que parou no meio) é falha, não verde

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
fals "F2 fato gravável por authenticated" "C5.sem_escrita_authenticated_tint_consumo_corante_INSERT" "$MIG" "$TMP/f2.sql"

printf '%s\n' "DROP POLICY IF EXISTS tint_consumo_preparacao_staff_le ON public.tint_consumo_preparacao;
CREATE POLICY tint_consumo_preparacao_todos_leem ON public.tint_consumo_preparacao FOR SELECT TO authenticated USING (true);" > "$TMP/f3.sql"
fals "F3 RLS aberta a qualquer autenticado" "C5.customer_le_zero" "$MIG" "$TMP/f3.sql"

sabmig "$TMP/f4.sql" 's/   AND capacidade_canister_ml IS NULL;  -- seed não pisa em capacidade já gravada/;/'
fals "F4 seed pisa na capacidade confirmada" "C6.capacidade_confirmada_preservada C6.reapply_mesmo_estado" "$TMP/f4.sql" ""

echo ""
echo "SABOTAGENS: $VERM vermelhas / $FALSOS falhas"   # recibo ÚNICO lido pelo db/roda-nucleo-ci.sh
if [ "$FALSOS" -ne 0 ]; then
  echo "✗ $FALSOS falsificação(ões) NÃO produziram o vermelho exato — algum assert não tem dente (ou morde demais)"
  exit 1
fi
echo "✅ PROVA OK — controle verde ($NTOT asserts) + $VERM falsificações com vermelho exato · locale=$LOC"

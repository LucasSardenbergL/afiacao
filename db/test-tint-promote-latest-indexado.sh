#!/usr/bin/env bash
# PROVA — 20261030071806_tint_promote_latest_por_chave_indexado.sql
#
# Custo medido em 2026-10-30 (psql-ro, EXPLAIN BUFFERS na prod): os blocos _tp_* de
# tint_promote_sync_run pegavam o latest por chave com DISTINCT ON sobre TODAS as ~2.190 versões
# retidas (30.400 buffers no run de corantes; seq scan de 90 MB + spill no de skus). A migration troca
# o DISTINCT ON por LATERAL ... LIMIT 1 (EXISTS no skus) sobre índices novos. Esta prova sobe o corpo
# VIVO do promote (md5 conferido contra prod) e assevera:
#
#   MD5           o promote trocado tem o md5 que a migration declara
#   EQUIV         o catálogo promovido (produtos, bases, embalagens, corantes, skus, fórmulas com preço
#                 e receita) é IDÊNTICO ao do promote ANTIGO, cada um a partir do MESMO estado inicial
#                 (empate de created_at por id, linhas mais novas de outra store/account, chave do run
#                 com account divergente, latest sem custo caindo no latest COM custo do cor_latest)
#   LEITURA       a promoção de um catálogo com 1.500 versões por chave toca poucas páginas de staging
#                 (plano custom E genérico)
#   LEITURA_PRECO a promoção de fórmula (cor_latest executa) não lê as versões de corante sem custo
#   ACL           anon/authenticated não executam o promote
#   IDEMP         re-aplicar é no-op (md5 igual)
#   GUARDA        re-aplicar sobre um promote de OUTRO corpo (versão posterior) ABORTA em vez de revertê-lo
# Fora da suíte (só controle): DERIVA — corpo vivo diferente do revisado ABORTA e não deixa índice.
# Controles de não-vacuidade: a referência (promote antigo) tem de exibir cada caso de borda, e o
# promote ANTIGO tem de estourar os tetos de LEITURA/LEITURA_PRECO que o novo cumpre.
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), cada uma com o conjunto EXATO
# de asserts que TEM de cair, depois do controle verde NA MESMA invocação.
#
# Uso: db/test-tint-promote-latest-indexado.sh  (PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5454}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-latest.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261030071806_tint_promote_latest_por_chave_indexado.sql"
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
MIG_5B1="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
MIG_ASYNC="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
MIG_FANT="$REPO_ROOT/supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql"
MIG_REF="$REPO_ROOT/supabase/migrations/20261013220000_tint_promote_snapshot_ref_por_generated_at.sql"
MIG_PURGE="$REPO_ROOT/supabase/migrations/20261021203000_tint_purge_staging_fora_do_promote.sql"
MD5_PROD='0e2a4169469eacb43e60eea224baad22'   # md5(prosrc) do promote em prod, 2026-10-30 (psql-ro)
export LC_ALL=C LANG=C

for f in "$MIG" "$MIG_V6" "$MIG_5B1" "$MIG_ASYNC" "$MIG_FANT" "$MIG_REF" "$MIG_PURGE"; do
  [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }
done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
# autovacuum desligado: os contadores de pg_statio são a medida do LEITURA — nada além da promoção toca o staging.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── template = o corpo vivo do promote (cadeia da prova do purge + o próprio purge) ─────────────────
PA -q -d postgres -c "CREATE DATABASE tpl_latest" >/dev/null
T() { PA -d tpl_latest "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null

# v6 ancorada num artefato imutável (o snapshot de schema é re-dump da prod e muda de baixo da prova).
python3 - "$MIG_V6" "$TMP/v6.sql" <<'PY0'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
t = open(src).read()
ms = list(re.finditer(r'CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.tint_promote_sync_run\s*\(', t))
assert len(ms) == 1, f"esperava 1 definicao da funcao na migration da v6, achei {len(ms)}"
tag = re.compile(r'\$[A-Za-z_]*\$').search(t, ms[0].end())
fim_corpo = t.find(tag.group(0), tag.end())
fim = t.find(';', fim_corpo + len(tag.group(0)))
assert fim_corpo > 0 and fim > 0, "bloco da v6 sem fechamento"
open(dst, 'w').write(t[ms[0].start():fim + 1] + '\n')
PY0
T -q -f "$TMP/v6.sql" >/dev/null
T -q -f "$MIG_5B1" >/dev/null
python3 - "$MIG_ASYNC" "$TMP/async_s3.sql" <<'PY1'
import sys
t = open(sys.argv[1]).read()
ini = t.index('-- ── 3. tint_promote_sync_run')
fim = t.index('-- ── 4. O consumidor da fila')
assert t.count('-- ── 3. tint_promote_sync_run') == 1 and t.count('-- ── 4. O consumidor da fila') == 1
open(sys.argv[2], 'w').write(t[ini:fim])
PY1
T -q -f "$TMP/async_s3.sql" >/dev/null
T -q -f "$MIG_FANT" >/dev/null
T -q -f "$MIG_REF" >/dev/null
# pg_cron não existe no PG17 da prova: as tabelas vêm do stub; as duas funções que o purge chama, aqui.
T -q <<'SQL' >/dev/null
CREATE SEQUENCE IF NOT EXISTS cron.jobid_seq;
CREATE OR REPLACE FUNCTION cron.schedule(p_nome text, p_agenda text, p_cmd text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_nome;
  INSERT INTO cron.job (jobid, schedule, command, active, jobname)
  VALUES (nextval('cron.jobid_seq'), p_agenda, p_cmd, true, p_nome) RETURNING jobid INTO v;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_nome text) RETURNS boolean
LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobname = p_nome; RETURN FOUND; END $$;
SQL
T -q --single-transaction -f "$MIG_PURGE" >/dev/null

VIVO="$(T -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
[ "$VIVO" = "$MD5_PROD" ] || { echo "✗ pré-condição: o template não é o corpo de PROD (md5 $VIVO, prod $MD5_PROD)"; exit 1; }
echo "  · template = corpo de prod (md5 $VIVO)"

# Histórico grande (loja BIG, chaves K*): 1.500 versões por chave (3.000 em skus), como os ~2.190 runs
# retidos na prod.
# Fica no TEMPLATE para a referência antiga e cada suíte partirem do mesmo estado.
T -q <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_l1', true),
       ('aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','automatic_primary','tok_big', true);
-- 1 run por versão (como a prod: ~2.190 runs distintos) — com um run só, o plano genérico do
-- 'chaves' (sync_run_id = $1) estimaria a tabela inteira e a medida viraria artefato da massa.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, started_at)
SELECT ('5' || lpad(g::text, 31, '0'))::uuid, 'aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','catalogs','complete',
       now() - interval '20 days' + g * interval '1 minute'
  FROM generate_series(1, 3000) g;
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao, created_at)
SELECT ('5' || lpad(g::text, 31, '0'))::uuid,'oben','BIG','KP' || k, 'KP' || k || ' v' || g, now() - interval '20 days' + g * interval '1 minute'
  FROM generate_series(0, 9) k, generate_series(1, 1500) g;
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao, created_at)
SELECT ('5' || lpad(g::text, 31, '0'))::uuid,'oben','BIG','KB' || k, 'KB' || k || ' v' || g, now() - interval '20 days' + g * interval '1 minute'
  FROM generate_series(0, 19) k, generate_series(1, 1500) g;
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml, created_at)
SELECT ('5' || lpad(g::text, 31, '0'))::uuid,'oben','BIG','KE' || k, 'KE' || k, 900, now() - interval '20 days' + g * interval '1 minute'
  FROM generate_series(0, 3) k, generate_series(1, 1500) g;
-- corantes: custo NULL em todas as versões menos UMA antiga por corante (como a prod: 0 com custo).
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, custo, volume_ml, created_at)
SELECT ('5' || lpad(g::text, 31, '0'))::uuid,'oben','BIG','KC' || k, 'KC' || k || ' v' || g, 50,
       CASE WHEN g = 1 THEN 40 END, 1000, now() - interval '20 days' + g * interval '1 minute'
  FROM generate_series(0, 25) k, generate_series(1, 1500) g;
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, created_at)
SELECT ('5' || lpad(g::text, 31, '0'))::uuid,'oben','BIG','KP' || (k % 10), 'KB' || (k / 10), 'KE0', now() - interval '20 days' + g * interval '1 minute'
  FROM generate_series(0, 59) k, generate_series(1, 3000) g;
ANALYZE;
SQL
echo "  · histórico BIG: 1.500/3.000 versões por chave (skus $(T -tA -c "SELECT count(*) FROM tint_staging_skus"))"

# ── cenário de equivalência (loja L1) — cada caso de borda com um controle na referência ───────────
seed() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
-- R1 (3 dias): catálogo inicial.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao, created_at) VALUES
 ('22222222-0000-0000-0000-000000000001','oben','L1','P1','P1 v1', now() - interval '3 days'),
 ('22222222-0000-0000-0000-000000000001','oben','L1','P2','P2 v1', now() - interval '3 days');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao, created_at) VALUES
 ('22222222-0000-0000-0000-000000000001','oben','L1','B1','B1 v1', now() - interval '3 days');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml, created_at) VALUES
 ('22222222-0000-0000-0000-000000000001','oben','L1','E900','E900 v1', 900, now() - interval '3 days'),
 ('22222222-0000-0000-0000-000000000001','oben','L1','E3600','E3600 v1', 3600, now() - interval '3 days');
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, custo, volume_ml, created_at) VALUES
 ('22222222-0000-0000-0000-000000000001','oben','L1','AX','AX v1', 11, 10, 1000, now() - interval '3 days'),
 ('22222222-0000-0000-0000-000000000001','oben','L1','AY','AY v1', 22, NULL, 1000, now() - interval '3 days');
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, created_at) VALUES
 ('22222222-0000-0000-0000-000000000001','oben','L1','P1','B1','E900', now() - interval '3 days'),
 ('22222222-0000-0000-0000-000000000001','oben','L1','P2','B1','E3600', now() - interval '3 days');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000001');

-- Ruído MAIS NOVO de outra store e de outra account (nunca pode vencer o latest de oben/L1).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','oben','L2','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao, created_at) VALUES
 ('22222222-0000-0000-0000-000000000009','oben','L2','P1','P1 OUTRA STORE', now()),
 ('22222222-0000-0000-0000-000000000009','colacor','L1','P1','P1 OUTRA ACCOUNT', now());
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao, created_at) VALUES
 ('22222222-0000-0000-0000-000000000009','oben','L2','B1','B1 OUTRA STORE', now());
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml, created_at) VALUES
 ('22222222-0000-0000-0000-000000000009','oben','L2','E900','E900 OUTRA STORE', 1, now());
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, custo, volume_ml, created_at) VALUES
 ('22222222-0000-0000-0000-000000000009','oben','L2','AX','AX OUTRA STORE', 99, 99, 1, now()),
 ('22222222-0000-0000-0000-000000000009','colacor','L1','AY','AY OUTRA ACCOUNT', 99, 99, 1, now());

-- R2 (2 dias): reenvio. B1 com EMPATE de created_at (id maior vence); AX perde o custo (o cor_latest
-- cai no de R1); AY ganha custo; E900 muda o volume; P2 e o sku P2/B1/E3600 chegam com account
-- DIVERGENTE (valem pelo latest de oben/L1); P9 e o sku P8 só existem na account divergente (somem).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao, created_at) VALUES
 ('22222222-0000-0000-0000-000000000002','oben','L1','P1','P1 v2', now() - interval '2 days'),
 ('22222222-0000-0000-0000-000000000002','colacor','L1','P2','P2 DIVERGENTE', now() - interval '2 days'),
 ('22222222-0000-0000-0000-000000000002','colacor','L1','P9','P9 DIVERGENTE', now() - interval '2 days');
INSERT INTO tint_staging_bases (id, sync_run_id, account, store_code, id_base_sayersystem, descricao, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000b1','22222222-0000-0000-0000-000000000002','oben','L1','B1','B1 empate perde', date_trunc('day', now()) - interval '2 days'),
 ('ffffffff-0000-0000-0000-0000000000b1','22222222-0000-0000-0000-000000000002','oben','L1','B1','B1 empate vence', date_trunc('day', now()) - interval '2 days');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml, created_at) VALUES
 ('22222222-0000-0000-0000-000000000002','oben','L1','E900','E900 v2', 950, now() - interval '2 days');
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, custo, volume_ml, created_at) VALUES
 ('22222222-0000-0000-0000-000000000002','oben','L1','AX','AX v2', 12, NULL, 1000, now() - interval '2 days'),
 ('22222222-0000-0000-0000-000000000002','oben','L1','AY','AY v2', 23, 5, 500, now() - interval '2 days');
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, created_at) VALUES
 ('22222222-0000-0000-0000-000000000002','oben','L1','P1','B1','E900', now() - interval '2 days'),
 ('22222222-0000-0000-0000-000000000002','colacor','L1','P2','B1','E3600', now() - interval '2 days'),
 ('22222222-0000-0000-0000-000000000002','colacor','L1','P8','B1','E900', now() - interval '2 days');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000002');

-- R3 (agora): fórmula X em P1/B1/E900 com AX+AY e preço de base → _expand cheio, cor_latest executa.
-- E uma 2ª X em P2/B1/E3600 (outro preço, outras qtds): só o PRODUTO distingue as duas — a impressão
-- tem de enxergar uma permuta de preço/receita entre elas (parecer Codex P3).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('22222222-0000-0000-0000-000000000003','oben','L1','P1','B1','E900', 100, 10, 20),
       ('22222222-0000-0000-0000-000000000003','oben','L1','P1','B1','E3600', 300, 10, 20),
       ('22222222-0000-0000-0000-000000000003','oben','L1','P2','B1','E3600', 200, 10, 20);
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('22222222-0000-0000-0000-000000000003','oben','L1','X','Cor X','P1','B1','E900','SL',900,false,2),
       ('22222222-0000-0000-0000-000000000003','oben','L1','X','Cor X','P2','B1','E3600','SL',3600,false,2);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, c, o, CASE WHEN cod_produto = 'P1' THEN q ELSE q * 3 END
  FROM tint_staging_formulas, (VALUES ('AX', 1, 10), ('AY', 2, 4)) v(c, o, q)
 WHERE sync_run_id = '22222222-0000-0000-0000-000000000003';
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000003');

-- R4: sku NOVO P1/B1/E3600 → reexpande X para a embalagem nova (preço com o cor_latest de novo).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem) VALUES
 ('22222222-0000-0000-0000-000000000004','oben','L1','P1','B1','E3600');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000004');
SQL
}

# Impressão digital do catálogo PROMOVIDO por chave natural, sem id/timestamps.
impressao() {
  PA -d "$1" -tA -c "SELECT md5(string_agg(x, E'\n' ORDER BY x)) || ' ' || count(*) FROM (
    SELECT 'P|' || cod_produto || '|' || descricao AS x FROM tint_produtos
    UNION ALL SELECT 'B|' || id_base_sayersystem || '|' || descricao FROM tint_bases
    UNION ALL SELECT 'E|' || id_embalagem_sayersystem || '|' || descricao || '|' || volume_ml FROM tint_embalagens
    UNION ALL SELECT 'C|' || id_corante_sayersystem || '|' || descricao || '|' || volume_total_ml || '|' || COALESCE(preco_litro::text, '-') FROM tint_corantes
    UNION ALL SELECT 'S|' || p.cod_produto || '|' || b.id_base_sayersystem || '|' || e.id_embalagem_sayersystem
      FROM tint_skus s JOIN tint_produtos p ON p.id = s.produto_id JOIN tint_bases b ON b.id = s.base_id
      JOIN tint_embalagens e ON e.id = s.embalagem_id
    UNION ALL SELECT 'F|' || format('%L|%L|%L|%L|%L|%L|%L|%L|%L|%L|%L', f.account, f.cor_id, f.nome_cor,
           p.cod_produto, b.id_base_sayersystem, e.id_embalagem_sayersystem, sc.id_subcolecao_sayersystem,
           f.volume_final_ml, f.preco_final_sayersystem, f.desativada_em IS NULL,
           (SELECT string_agg(format('%L=%L', co.id_corante_sayersystem, trim_scale(i.qtd_ml)), ',' ORDER BY i.ordem)
              FROM tint_formula_itens i JOIN tint_corantes co ON co.id = i.corante_id
             WHERE i.formula_id = f.id))
      FROM tint_formulas f JOIN tint_embalagens e ON e.id = f.embalagem_id
      JOIN tint_produtos p ON p.id = f.produto_id JOIN tint_bases b ON b.id = f.base_id
      LEFT JOIN tint_subcolecoes sc ON sc.id = f.subcolecao_id) s"
}
q() { PA -d "$1" -tA -c "$2"; }

# Páginas de staging tocadas por UMA promoção: delta de pg_statio (heap+índice) das 5 tabelas de catálogo.
# A promoção roda numa sessão própria: o backend descarrega as estatísticas ao sair.
# Fail-closed: promoção que não devolve ok=true, ou que não deixou o efeito esperado ($5, SQL que tem de
# dar 't'), imprime FALHOU em vez de um delta — uma promoção abortada cedo leria ~0 e passaria no teto.
blocos() {   # $1 = banco, $2 = run, $3 = plan_cache_mode, $4 = tabelas (regex), $5 = efeito esperado
  local antes depois r
  local sql="SELECT COALESCE(sum(heap_blks_hit + heap_blks_read + COALESCE(idx_blks_hit, 0) + COALESCE(idx_blks_read, 0)), 0)
               FROM pg_statio_user_tables WHERE relname ~ '$4'"
  antes="$(q "$1" "$sql")" || { echo FALHOU; return; }
  r="$(PA -q -tA -d "$1" -c "SET plan_cache_mode = $3" -c "SELECT tint_promote_sync_run('$2')->>'ok'" 2>&1)" \
    || { echo "    (promoção $2 em $1 falhou: $r)" >&2; echo FALHOU; return; }
  [ "$r" = "true" ] || { echo "    (promoção $2 em $1: ok=[$r])" >&2; echo FALHOU; return; }
  r="$(q "$1" "$5")" || { echo FALHOU; return; }
  [ "$r" = "t" ] || { echo "    (promoção $2 em $1 sem o efeito esperado)" >&2; echo FALHOU; return; }
  sleep 1
  depois="$(q "$1" "$sql")" || { echo FALHOU; return; }
  echo $((depois - antes))
}
cabe() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -le "$2" ]; }   # delta numérico E dentro do teto
# O efeito de cada run medido: o catálogo BIG com a descrição DESTE run, a fórmula KX deste run promovida.
promoveu_cat() { echo "SELECT (SELECT count(*) FROM tint_produtos WHERE descricao LIKE '% novo$1') = 10
                          AND (SELECT count(*) FROM tint_bases WHERE descricao LIKE '% novo$1') = 20
                          AND (SELECT count(*) FROM tint_corantes WHERE descricao LIKE '% novo$1') = 26"; }
promoveu_formula() { echo "SELECT count(*) = 1 FROM tint_formulas WHERE cor_id = 'KX$1' AND desativada_em IS NULL"; }
CATALOGO='^tint_staging_(produtos|bases|embalagens|corantes|skus)$'

# Run de catálogo BIG com 1 linha por chave (o reenvio do ciclo) e run de fórmula que expande em BIG.
seed_big() {   # $1 = banco, $2 = sufixo do run (dígito)
  PA -q -d "$1" <<SQL >/dev/null
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('33333333-0000-0000-0000-00000000000$2','aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
SELECT '33333333-0000-0000-0000-00000000000$2','oben','BIG','KP' || k, 'KP' || k || ' novo$2' FROM generate_series(0, 9) k;
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
SELECT '33333333-0000-0000-0000-00000000000$2','oben','BIG','KB' || k, 'KB' || k || ' novo$2' FROM generate_series(0, 19) k;
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
SELECT '33333333-0000-0000-0000-00000000000$2','oben','BIG','KE' || k, 'KE' || k, 900 FROM generate_series(0, 3) k;
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, volume_ml)
SELECT '33333333-0000-0000-0000-00000000000$2','oben','BIG','KC' || k, 'KC' || k || ' novo$2', 50, 1000 FROM generate_series(0, 25) k;
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
SELECT '33333333-0000-0000-0000-00000000000$2','oben','BIG','KP' || (k % 10), 'KB' || (k / 10), 'KE0' FROM generate_series(0, 59) k;
SQL
}
seed_big_formula() {   # $1 = banco, $2 = sufixo do run (dígito)
  PA -q -d "$1" <<SQL >/dev/null
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('44444444-0000-0000-0000-00000000000$2','aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('44444444-0000-0000-0000-00000000000$2','oben','BIG','KX$2','Cor KX','KP0','KB0','KE0','SL',900,false,3);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'KC' || o, o, 5 FROM tint_staging_formulas, generate_series(0, 2) o
 WHERE sync_run_id = '44444444-0000-0000-0000-00000000000$2';
SQL
}

# Tetos: catálogo — controle 511–531, F7 (sem idx_tsc_latest) 1.134, antigo 6.722; preço — controle 42, antigo 3.610.
TETO_CATALOGO=800
TETO_PRECO=50

# ── referência: o promote ANTIGO, do MESMO template ──────────────────────────────────────────────────
PA -q -d postgres -c "CREATE DATABASE ref TEMPLATE tpl_latest" >/dev/null
seed ref
IMP_REF="$(impressao ref)"
v="$(q ref "SELECT string_agg(x, ';' ORDER BY x) FROM (
  SELECT 'B1=' || descricao x FROM tint_bases WHERE id_base_sayersystem = 'B1'
  UNION ALL SELECT 'P1=' || descricao FROM tint_produtos WHERE cod_produto = 'P1'
  UNION ALL SELECT 'P2=' || descricao FROM tint_produtos WHERE cod_produto = 'P2'
  UNION ALL SELECT 'P8P9=' || count(*) FROM tint_produtos WHERE cod_produto IN ('P8', 'P9')
  UNION ALL SELECT 'E900=' || volume_ml FROM tint_embalagens WHERE id_embalagem_sayersystem = 'E900'
  UNION ALL SELECT 'AX=' || descricao || '/' || preco_litro FROM tint_corantes WHERE id_corante_sayersystem = 'AX'
  UNION ALL SELECT 'X=' || count(*) || '/' || count(preco_final_sayersystem) FROM tint_formulas WHERE cor_id = 'X') s")"
ESPERADO_REF='AX=AX v2/12;B1=B1 empate vence;E900=950;P1=P1 v2;P2=P2 v1;P8P9=0;X=3/3'
[ "$v" = "$ESPERADO_REF" ] || { echo "✗ cenário: a referência não exibe os casos de borda: [$v] ≠ [$ESPERADO_REF]"; exit 1; }
echo "  · referência (promote antigo): $IMP_REF — $v"

seed_big ref 1
REF_CAT="$(blocos ref 33333333-0000-0000-0000-000000000001 auto "$CATALOGO" "$(promoveu_cat 1)")"
seed_big_formula ref 1
REF_PRECO="$(blocos ref 44444444-0000-0000-0000-000000000001 auto '^tint_staging_corantes$' "$(promoveu_formula 1)")"
[[ "$REF_CAT" =~ ^[0-9]+$ ]] && [[ "$REF_PRECO" =~ ^[0-9]+$ ]] \
  && [ "$REF_CAT" -gt $((TETO_CATALOGO * 3)) ] && [ "$REF_PRECO" -gt $((TETO_PRECO * 3)) ] \
  || { echo "✗ controle: o promote ANTIGO devia estourar os tetos (catálogo $REF_CAT vs $TETO_CATALOGO, preço $REF_PRECO vs $TETO_PRECO)"; exit 1; }
echo "  · promote antigo: catálogo BIG = $REF_CAT blocos de staging, fórmula BIG = $REF_PRECO blocos de corantes"

TODOS="MD5 EQUIV LEITURA LEITURA_PRECO ACL IDEMP GUARDA"

# ── a suíte: $1 = arquivo da migration (real ou sabotada), $2 = banco; imprime os asserts que CAÍRAM ──
suite() {
  local mig="$1" db="$2" caidos="" v
  cai() { caidos="$caidos $1"; }
  PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE tpl_latest" >/dev/null
  if ! PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.apply.log" 2>&1; then
    echo "$TODOS"; return
  fi

  v="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  [ "$v" = "$(sed -nE "s/.*c_este constant text := '([0-9a-f]{32})'.*/\1/p" "$MIG")" ] || cai MD5

  if seed "$db" 2>"$TMP/$db.seed.log" && [ "$(impressao "$db")" = "$IMP_REF" ]; then :; else cai EQUIV; fi

  local c1 c2 p1
  seed_big "$db" 1; c1="$(blocos "$db" 33333333-0000-0000-0000-000000000001 force_custom_plan "$CATALOGO" "$(promoveu_cat 1)")"
  seed_big "$db" 2; c2="$(blocos "$db" 33333333-0000-0000-0000-000000000002 force_generic_plan "$CATALOGO" "$(promoveu_cat 2)")"
  cabe "$c1" "$TETO_CATALOGO" && cabe "$c2" "$TETO_CATALOGO" \
    || { cai LEITURA; echo "    (LEITURA: custom $c1, genérico $c2, teto $TETO_CATALOGO)" >&2; }
  seed_big_formula "$db" 1; p1="$(blocos "$db" 44444444-0000-0000-0000-000000000001 auto '^tint_staging_corantes$' "$(promoveu_formula 1)")"
  cabe "$p1" "$TETO_PRECO" || { cai LEITURA_PRECO; echo "    (LEITURA_PRECO: $p1, teto $TETO_PRECO)" >&2; }
  echo "    · $db: catálogo BIG custom=$c1 genérico=$c2 · fórmula BIG=$p1" >&2

  v="$(q "$db" "SELECT has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')::text
                    || has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')::text")"
  [ "$v" = "falsefalse" ] || cai ACL

  local md5_antes
  md5_antes="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  if PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.reapply.log" 2>&1; then
    [ "$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")" = "$md5_antes" ] || cai IDEMP
  else
    cai IDEMP
  fi
  # GUARDA: uma versão posterior do promote (corpo diferente) — re-aplicar este arquivo tem de ABORTAR.
  q "$db" "DO \$g\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure),
           'runs órfãos >30min → error.', 'runs órfãos >30min → error. (v posterior)'); END \$g\$" >/dev/null
  if PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.guarda.log" 2>&1 \
     || ! grep -qF "nem este (" "$TMP/$db.guarda.log"; then
    cai GUARDA
  fi
  echo "${caidos# }"
}

PASSOU=0; FALHAS=0
echo "════ CONTROLE — migration real ════"
CAIDOS="$(suite "$MIG" ctl)"
for a in $TODOS; do
  case " $CAIDOS " in *" $a "*) echo "  ✗ $a"; FALHAS=$((FALHAS + 1));; *) echo "  ✓ $a"; PASSOU=$((PASSOU + 1));; esac
done

# DERIVA: corpo vivo ≠ revisado (outra sessão recriou o promote) → ABORTA, e a transação não deixa nada.
PA -q -d postgres -c "CREATE DATABASE deriva TEMPLATE tpl_latest" >/dev/null
q deriva "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure),
          'runs órfãos >30min → error.', 'runs órfãos >30min → error. (deriva)'); END \$d\$" >/dev/null
if PA -q -d deriva --single-transaction -f "$MIG" >"$TMP/deriva.log" 2>&1; then
  echo "  ✗ DERIVA: a migration aplicou sobre um corpo vivo que não é o revisado"; FALHAS=$((FALHAS + 1))
elif grep -q "corpo vivo do promote" "$TMP/deriva.log" \
     && [ "$(q deriva "SELECT count(*) FROM pg_class WHERE relname = 'idx_tss_chave'")" = "0" ]; then
  echo "  ✓ DERIVA: abortou pelo md5 e não deixou índice"; PASSOU=$((PASSOU + 1))
else
  echo "  ✗ DERIVA: abortou pelo motivo errado ou deixou resto: $(head -c 300 "$TMP/deriva.log")"; FALHAS=$((FALHAS + 1))
fi

if [ "$FALHAS" -ne 0 ]; then
  echo "PASS=$PASSOU  FAIL=$FALHAS"; echo "RESULTADO: VERMELHO (controle) — falsificações não rodam sem controle verde"; exit 1
fi

# ── falsificações: sabota UMA camada por vez numa cópia; exige o conjunto EXATO de asserts vermelhos ──
# As trocas chegam pelo stdin como LISTA PYTHON de pares (busca, troca); cada busca tem de casar
# exatamente 1 vez, senão a sabotagem é inválida. A cópia é CONSISTENTE: o c_este dela é o md5 que o
# próprio banco calcula para o corpo sabotado (lido da PÓS de um ensaio com c_este sentinela).
cat > "$TMP/troca.py" <<'PYTROCA'
import sys, ast, re
src, dst = sys.argv[1], sys.argv[2]
trocas = ast.literal_eval(sys.stdin.read())
t = open(src).read()
for busca, troca in trocas:
    if t.count(busca) != 1:
        sys.exit("ancora casou %dx: %r" % (t.count(busca), busca[:80]))
    t = t.replace(busca, troca)
t = re.sub(r"c_este constant text := '[0-9a-f]{32}'", "c_este constant text := 'SENTINELA'", t, count=1)
open(dst, "w").write(t)
PYTROCA
consistente() {   # $1 = cópia com c_este SENTINELA → reescreve com o md5 calculado pelo banco
  local md5
  PA -q -d postgres -c "DROP DATABASE IF EXISTS ensaio" -c "CREATE DATABASE ensaio TEMPLATE tpl_latest" >/dev/null
  PA -q -d ensaio --single-transaction -f "$1" >"$TMP/ensaio.log" 2>&1 || true
  md5="$(sed -nE 's/.*pós-troca o md5 do promote é ([0-9a-f]{32}) \(esperado SENTINELA\).*/\1/p' "$TMP/ensaio.log" | head -1)"
  if [ -n "$md5" ]; then sed -i.bak "s/c_este constant text := 'SENTINELA'/c_este constant text := '$md5'/" "$1"; fi
}
FALSIF_ERR=0; FALSIF_OK=0
falsifica() {   # $1=rótulo $2..=asserts que TÊM de cair; stdin = trocas
  local rot="$1"; shift
  local esp="$*" copia caidos
  copia="$TMP/f_$rot.sql"
  if ! python3 "$TMP/troca.py" "$MIG" "$copia"
  then echo "  ✗ $rot: sabotagem NÃO aplicou (âncora) — inválida"; FALSIF_ERR=$((FALSIF_ERR + 1)); return; fi
  consistente "$copia"
  local db; db="db_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  caidos="$(suite "$copia" "$db")"
  # aborto só conta pelo motivo CERTO (MOTIVO=<texto do RAISE>): sem isso, um erro de sintaxe na cópia
  # sabotada derrubaria todos os asserts e passaria por "a camada pegou".
  if [ -n "${MOTIVO:-}" ] && ! grep -qF "$MOTIVO" "$TMP/$db.apply.log"; then
    echo "  ✗ $rot: abortou sem o motivo [$MOTIVO]: $(head -c 300 "$TMP/$db.apply.log")"; FALSIF_ERR=$((FALSIF_ERR + 1)); return
  fi
  if [ "$caidos" = "$esp" ]; then echo "  ✓ $rot: caíram exatamente [$esp]"; FALSIF_OK=$((FALSIF_OK + 1))
  else echo "  ✗ $rot: esperado [$esp], veio [$caidos]"; FALSIF_ERR=$((FALSIF_ERR + 1)); fi
}

echo "════ FALSIFICAÇÕES ════"
# F1 — desempate invertido em bases (empate de created_at passa a ser resolvido pelo MENOR id).
falsifica F1 MD5 EQUIV <<'TROCAS'
[("AND s.id_base_sayersystem = c.id_base_sayersystem\n      ORDER BY s.created_at DESC, s.id DESC", "AND s.id_base_sayersystem = c.id_base_sayersystem\n      ORDER BY s.created_at DESC, s.id ASC")]
TROCAS
# F2 — o LATERAL de produtos esquece a store: a linha mais nova de OUTRA store vence (e o índice perde o prefixo: a leitura também denuncia).
falsifica F2 MD5 EQUIV LEITURA <<'TROCAS'
[("WHERE s.account = v_account AND s.store_code = v_store AND s.cod_produto = c.cod_produto", "WHERE s.account = v_account AND s.cod_produto = c.cod_produto")]
TROCAS
# F3 — corantes pegam a versão MAIS VELHA (ASC, ASC: o índice ainda serve, lido de trás para frente).
falsifica F3 MD5 EQUIV <<'TROCAS'
[("AND s.id_corante_sayersystem = c.id_corante_sayersystem\n      ORDER BY s.created_at DESC, s.id DESC", "AND s.id_corante_sayersystem = c.id_corante_sayersystem\n      ORDER BY s.created_at ASC, s.id ASC")]
TROCAS
# F4 — o EXISTS de skus esquece a account: a chave que só existe na account divergente (P8) entra (e o índice perde o prefixo: a leitura também denuncia).
falsifica F4 MD5 EQUIV LEITURA <<'TROCAS'
[("      WHERE s.account = v_account AND s.store_code = v_store\n        AND s.cod_produto = c.cod_produto", "      WHERE s.store_code = v_store\n        AND s.cod_produto = c.cod_produto")]
TROCAS
# F5 — embalagens pegam a versão MAIS VELHA (volume 900 em vez de 950).
falsifica F5 MD5 EQUIV <<'TROCAS'
[("AND s.id_embalagem_sayersystem = c.id_embalagem_sayersystem\n      ORDER BY s.created_at DESC, s.id DESC", "AND s.id_embalagem_sayersystem = c.id_embalagem_sayersystem\n      ORDER BY s.created_at ASC, s.id ASC")]
TROCAS
# F6 — sem o índice de skus E sem a linha dele na postcondição: só a medida de leitura denuncia.
falsifica F6 LEITURA <<'TROCAS'
[("CREATE INDEX IF NOT EXISTS idx_tss_chave\n  ON public.tint_staging_skus (account, store_code, cod_produto, id_base, id_embalagem);", ""),
 (",\n    ARRAY['idx_tss_chave',       'tint_staging_skus',       '(account, store_code, cod_produto, id_base, id_embalagem)']", "")]
TROCAS
# F6b — sem o índice de skus, postcondição intacta: a migration ABORTA (camada A1).
MOTIVO="A1 FALHOU: idx_tss_chave" falsifica F6b "$TODOS" <<'TROCAS'
[("CREATE INDEX IF NOT EXISTS idx_tss_chave\n  ON public.tint_staging_skus (account, store_code, cod_produto, id_base, id_embalagem);", "")]
TROCAS
# F7 — sem o índice latest de corantes (+ postcondição): cai no (account, id_corante) e lê as 1.500 versões.
falsifica F7 LEITURA <<'TROCAS'
[("CREATE INDEX IF NOT EXISTS idx_tsc_latest\n  ON public.tint_staging_corantes (account, store_code, id_corante_sayersystem, created_at DESC, id DESC);\n", ""),
 ("    ARRAY['idx_tsc_latest',      'tint_staging_corantes',   '(account, store_code, id_corante_sayersystem, created_at DESC, id DESC)'],\n", "")]
TROCAS
# F8 — sem o índice de run de corantes (+ postcondição): toda promoção volta a varrer corantes — a de fórmula também (LEITURA_PRECO).
falsifica F8 LEITURA LEITURA_PRECO <<'TROCAS'
[("CREATE INDEX IF NOT EXISTS idx_tsc_run\n  ON public.tint_staging_corantes (sync_run_id);\n", ""),
 ("    ARRAY['idx_tsc_run',         'tint_staging_corantes',   '(sync_run_id)'],\n", "")]
TROCAS
# F9 — sem o parcial do cor_latest (+ postcondição): a promoção de fórmula lê as versões sem custo.
falsifica F9 LEITURA_PRECO <<'TROCAS'
[("CREATE INDEX IF NOT EXISTS idx_tsc_latest_custo\n  ON public.tint_staging_corantes (account, store_code, id_corante_sayersystem, created_at DESC, id DESC)\n  WHERE custo IS NOT NULL AND volume_ml IS NOT NULL;\n", ""),
 ("    ARRAY['idx_tsc_latest_custo','tint_staging_corantes',   '(account, store_code, id_corante_sayersystem, created_at DESC, id DESC) WHERE ((custo IS NOT NULL) AND (volume_ml IS NOT NULL))'],\n", "")]
TROCAS
# F10 — a troca de skus vira no-op (o texto novo é o DISTINCT ON antigo) e a A2 de skus neutralizada: o
# _tp_sku volta a ler todas as versões. Só a leitura (e o md5 do corpo) denuncia.
falsifica F10 MD5 LEITURA <<'TROCAS'
[("'  latest AS (   -- só a chave é projetada: o latest é a própria chave, se ela existe em account/store\n    SELECT c.cod_produto, c.id_base, c.id_embalagem\n    FROM chaves c\n    WHERE EXISTS (\n      SELECT 1 FROM tint_staging_skus s\n      WHERE s.account = v_account AND s.store_code = v_store\n        AND s.cod_produto = c.cod_produto AND s.id_base = c.id_base AND s.id_embalagem = c.id_embalagem\n    )\n  )']",
  "'  latest AS (\n    SELECT DISTINCT ON (s.cod_produto, s.id_base, s.id_embalagem)\n           s.cod_produto, s.id_base, s.id_embalagem\n    FROM tint_staging_skus s\n    JOIN chaves c ON c.cod_produto = s.cod_produto AND c.id_base = s.id_base AND c.id_embalagem = s.id_embalagem\n    WHERE s.account = v_account AND s.store_code = v_store\n    ORDER BY s.cod_produto, s.id_base, s.id_embalagem, s.created_at DESC, s.id DESC\n  )']"),
 ("     OR position('SELECT DISTINCT ON (s.cod_produto, s.id_base, s.id_embalagem)' in v_src) > 0\n", "")]
TROCAS
# F11 — a guarda do PRE neutralizada: re-aplicar sobre a versão posterior não aborta pela guarda.
falsifica F11 GUARDA <<'TROCAS'
[("  IF v_md5 <> c_pred THEN", "  IF false THEN")]
TROCAS

echo "─── controle $PASSOU ok | falsificações certas: $FALSIF_OK | inválidas/erradas: $FALSIF_ERR ───"
echo "PASS=$PASSOU  FAIL=$FALSIF_ERR"
if [ "$FALSIF_ERR" -ne 0 ]; then echo "RESULTADO: VERMELHO"; exit 1; fi
echo "RESULTADO: VERDE — $PASSOU asserts + $FALSIF_OK falsificações com conjunto exato"

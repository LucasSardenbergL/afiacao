#!/usr/bin/env bash
# PROVA — 20261104110000_tint_promote_snap_fonte_so_com_expansao.sql
#
# Programa Mini, temp crônico: o filtro de fantasmas da fonte (20261013150000) materializava o snapshot
# de chaves (`SELECT DISTINCT chave … jsonb_array_elements_text(keys)`, ~123 mil chaves em prod) em TODA
# promoção — e 685 de 688 promoções/dia são `catalogs` com o _expand_uniq VAZIO, onde o DELETE que o
# consome não apaga nada. Medido em prod: ~9,5 MB de temp por promoção (HashAggregate Batches 5 +
# tuplestore). A migration só materializa com `EXISTS (SELECT 1 FROM _expand_uniq)`.
#
# Sobe o corpo VIVO do promote (md5 conferido contra prod) e, com work_mem mínimo + log_temp_files=0,
# assevera contra o promote ANTIGO (o mesmo template, sem a migration) como referência:
#
#   APLICA     a migration aplica (numa transação, como o db:aplicar)
#   MD5        o promote trocado tem o md5 que a migration declara
#   PAR_CAT    run catalogs sem sku novo: estado + retorno IDÊNTICOS ao antigo
#   PAR_SKU    run catalogs com sku NOVO (reexpande o par, o filtro age): idênticos ao antigo
#   PAR_FORM   run de fórmulas (reexpande o par, o filtro age): idênticos ao antigo
#   MARCA_CAT  no run catalogs sem expansão o _snap_fonte NÃO nasce
#   TEMP_CAT   no run catalogs sem expansão a promoção escreve ZERO arquivos temporários
#   FILTRO     com expansão o filtro segue barrando a fantasma (A inativa, nem nasce na embalagem nova;
#              contador > 0 nos dois runs) — paridade sozinha passaria se antigo e novo errassem juntos
#   IDEMP      re-aplicar é no-op (md5 igual)
#   GUARDA     aplicar sobre um promote de OUTRO corpo ABORTA (PRE ou PÓS-md5) e o corpo fica intacto
#   ACL        anon/authenticated não executam o promote
# Controle de não-vacuidade (no promote ANTIGO): o run catalogs sem expansão CRIA o _snap_fonte e
# DERRAMA temp — sem isso MARCA_CAT/TEMP_CAT seriam vácuos.
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), cada uma com o conjunto EXATO de
# asserts que TEM de cair, depois do controle verde NA MESMA invocação.
#
# Uso: db/test-tint-promote-snap-fonte.sh   (PGPORT_TEST=<porta>; LOCALE_TESTE=pt_BR.UTF-8 no 2º idioma)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5459}}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-snapfonte.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261104110000_tint_promote_snap_fonte_so_com_expansao.sql"
MIG_DIFF="$REPO_ROOT/supabase/migrations/20261103093424_tint_promote_escreve_so_o_que_mudou.sql"
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
MIG_5B1="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
MIG_ASYNC="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
MIG_FANT="$REPO_ROOT/supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql"
MIG_REF="$REPO_ROOT/supabase/migrations/20261013220000_tint_promote_snapshot_ref_por_generated_at.sql"
MIG_PURGE="$REPO_ROOT/supabase/migrations/20261021203000_tint_purge_staging_fora_do_promote.sql"
MIG_LATEST="$REPO_ROOT/supabase/migrations/20261030071806_tint_promote_latest_por_chave_indexado.sql"
MD5_PROD='2c6f461f9c9d4f8c54ea817e25f88f61'   # md5(prosrc) do promote em prod, 2026-11-04 (psql-ro)

for f in "$MIG" "$MIG_DIFF" "$MIG_V6" "$MIG_5B1" "$MIG_ASYNC" "$MIG_FANT" "$MIG_REF" "$MIG_PURGE" "$MIG_LATEST"; do
  [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }
done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
# log_temp_files=0: todo arquivo temporário vira uma linha no log, com o application_name na frente —
# é a medida de TEMP_CAT (a mesma grandeza de pg_stat_database.temp_bytes, sem a latência das stats).
# lc_messages=C: a linha casa em ASCII nos dois locales.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off -c log_temp_files=0 -c lc_messages=C -c log_line_prefix='%a|'" \
  -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }
q() { PA -d "$1" -tA -c "$2"; }
echo "  · locale do cluster: $(q postgres "SELECT datcollate FROM pg_database WHERE datname = 'postgres'")"

# ── template = o corpo vivo do promote (a cadeia da prova do diff + o próprio diff) ──────────────────
PA -q -d postgres -c "CREATE DATABASE tpl_snap" >/dev/null
T() { PA -d tpl_snap "$@"; }
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
T -q --single-transaction -f "$MIG_LATEST" >/dev/null 2>&1
T -q --single-transaction -f "$MIG_DIFF" >/dev/null 2>&1

VIVO="$(T -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
[ "$VIVO" = "$MD5_PROD" ] || { echo "✗ pré-condição: o template não é o corpo de PROD (md5 $VIVO, prod $MD5_PROD)"; exit 1; }
echo "  · template = corpo de prod (md5 $VIVO)"
# o ACL de prod (medido): só postgres/service_role/sandbox executam. O snapshot pode trazer grants a mais.
T -q -c "REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated" >/dev/null

# ── seed (promovido pelo promote ANTIGO, no template: referência e suítes partem do mesmo oficial) ──
# Par P1/B1/E900, cores B1..B8 + A. O snapshot da fonte (aplicado pelo apply REAL) tem B1..B8 e 20 mil
# chaves de enchimento (o DISTINCT delas não cabe em 64 kB, como as 123 mil não cabem em 3,5 MB em prod):
# A vira fantasma — staging antigo, ausente da fonte, desativada pelo apply.
T -q <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_l1', true);

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','Produto 1');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','B1','Base 1');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','E900','Galão 900',900),
       ('11111111-0000-0000-0000-000000000001','oben','L1','E3600','Balde 3600',3600);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','AX','Corante AX',1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','B1','E900');
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000001');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, created_at)
SELECT '11111111-0000-0000-0000-000000000002','oben','L1', c, 'Cor ' || c, 'P1','B1','E900','SL',900,false,1, now() - interval '2 days'
  FROM unnest(ARRAY['B1','B2','B3','B4','B5','B6','B7','B8','A']) c;
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 10 FROM tint_staging_formulas WHERE sync_run_id = '11111111-0000-0000-0000-000000000002';
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000002');

INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks, chunk_index, keys, created_at, aplicacao_status)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','5a000000-0000-0000-0000-000000000001','formulas',
        now() - interval '1 day', 1, 0,
        (SELECT jsonb_agg(k) FROM (
           SELECT c || '|P1|B1|false' AS k FROM unnest(ARRAY['B1','B2','B3','B4','B5','B6','B7','B8']) c
           UNION ALL
           SELECT 'ENCH' || g || '|P9|B9|false' FROM generate_series(1, 20000) g) x),
        now() - interval '1 day', 'pendente');

-- Estado canônico por chave NATURAL (os uuids de linhas novas diferem entre bancos) — o que a paridade
-- compara. É uma PROJEÇÃO, não a relação inteira: sem timestamps (now() difere) e sem ids; as FKs entram
-- pela chave natural do alvo (sku → produto/base/embalagem, importação → arquivo_hash).
CREATE FUNCTION _estado(p_run uuid) RETURNS text LANGUAGE sql AS $$
  SELECT md5(concat_ws(E'\n',
    (SELECT string_agg(concat_ws('|', f.cor_id, p.cod_produto, b.id_base_sayersystem, e.id_embalagem_sayersystem,
              s.id_subcolecao_sayersystem, f.nome_cor, f.volume_final_ml::text, f.preco_final_sayersystem::text,
              f.personalizada::text, (f.desativada_em IS NULL)::text, f.desativada_motivo,
              (SELECT sp.cod_produto || '/' || sb.id_base_sayersystem || '/' || se.id_embalagem_sayersystem
                 FROM tint_skus sk JOIN tint_produtos sp ON sp.id = sk.produto_id JOIN tint_bases sb ON sb.id = sk.base_id
                 JOIN tint_embalagens se ON se.id = sk.embalagem_id WHERE sk.id = f.sku_id),
              (SELECT i.arquivo_hash FROM tint_importacoes i WHERE i.id = f.importacao_id),
              (SELECT string_agg(co.id_corante_sayersystem || ':' || fi.ordem::text || ':' || fi.qtd_ml::text, ',' ORDER BY co.id_corante_sayersystem)
                 FROM tint_formula_itens fi JOIN tint_corantes co ON co.id = fi.corante_id WHERE fi.formula_id = f.id)),
            E'\n' ORDER BY f.cor_id, e.id_embalagem_sayersystem)
       FROM tint_formulas f JOIN tint_produtos p ON p.id = f.produto_id JOIN tint_bases b ON b.id = f.base_id
       JOIN tint_embalagens e ON e.id = f.embalagem_id LEFT JOIN tint_subcolecoes s ON s.id = f.subcolecao_id),
    (SELECT string_agg(cod_produto || '=' || descricao, ',' ORDER BY cod_produto) FROM tint_produtos),
    (SELECT string_agg(id_base_sayersystem || '=' || descricao, ',' ORDER BY id_base_sayersystem) FROM tint_bases),
    (SELECT string_agg(concat_ws('=', id_embalagem_sayersystem, descricao, volume_ml::text), ',' ORDER BY id_embalagem_sayersystem) FROM tint_embalagens),
    (SELECT string_agg(concat_ws('=', id_corante_sayersystem, descricao, volume_total_ml::text, preco_litro::text), ',' ORDER BY id_corante_sayersystem) FROM tint_corantes),
    (SELECT string_agg(k, ',' ORDER BY k) FROM (
       SELECT p.cod_produto || '/' || b.id_base_sayersystem || '/' || e.id_embalagem_sayersystem AS k
         FROM tint_skus sk JOIN tint_produtos p ON p.id = sk.produto_id JOIN tint_bases b ON b.id = sk.base_id
         JOIN tint_embalagens e ON e.id = sk.embalagem_id) x),
    (SELECT string_agg(k, E'\n' ORDER BY k) FROM (
       SELECT concat_ws('|', sync_run_id::text, entity_type, entity_id, error_message) AS k FROM tint_sync_errors) x),
    (SELECT string_agg(concat_ws('|', status, registros_importados::text, registros_erro::text), ',' ORDER BY arquivo_hash) FROM tint_importacoes),
    (SELECT concat_ws('|', status, inserts::text, errors::text, metadata::text) FROM tint_sync_runs WHERE id = p_run)))
$$;
SQL
APPLY="$(T -tA -c "SELECT (tint_apply_keys_snapshot('5a000000-0000-0000-0000-000000000001')->>'desativadas')")"
[ "$APPLY" = "1" ] || { echo "✗ seed: o apply real tinha de desativar exatamente A (1), veio [$APPLY]"; exit 1; }
T -q -c "UPDATE tint_keys_snapshots SET aplicacao_status='aplicado', aplicado_em = now() - interval '1 day' WHERE snapshot_id='5a000000-0000-0000-0000-000000000001'" >/dev/null

# Os 3 runs dos cenários (staging AGORA, depois do snapshot), já no template — promovidos em cada banco.
#   CAT  catalogs como os de prod: descrição nova de produto/base/corante e o sku JÁ existente → nada expande
#   SKU  catalogs com sku NOVO (E3600) → reexpande o par: o staging antigo de A entra e o filtro o barra
#   FORM fórmulas: B1 reenviada com dose nova → reexpande o par: idem
T -q <<'SQL' >/dev/null
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete'),
       ('22222222-0000-0000-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete'),
       ('22222222-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('22222222-0000-0000-0000-00000000000c','oben','L1','P1','Produto 1 rev');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('22222222-0000-0000-0000-00000000000c','oben','L1','B1','Base 1 rev');
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, volume_ml)
VALUES ('22222222-0000-0000-0000-00000000000c','oben','L1','AX','Corante AX rev',1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('22222222-0000-0000-0000-00000000000c','oben','L1','P1','B1','E900'),
       ('22222222-0000-0000-0000-00000000000d','oben','L1','P1','B1','E3600');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('22222222-0000-0000-0000-00000000000f','oben','L1','B1','Cor B1','P1','B1','E900','SL',900,false,1);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 12 FROM tint_staging_formulas WHERE sync_run_id = '22222222-0000-0000-0000-00000000000f';
SQL
SEED="$(q tpl_snap "SELECT count(*) FILTER (WHERE desativada_em IS NULL) || '/' || count(*) FROM tint_formulas")"
[ "$SEED" = "8/9" ] || { echo "✗ seed: esperado 8 ativas de 9 antes dos cenários, veio $SEED"; exit 1; }

RUN_CAT='22222222-0000-0000-0000-00000000000c'
RUN_SKU='22222222-0000-0000-0000-00000000000d'
RUN_FORM='22222222-0000-0000-0000-00000000000f'

# Promove $2 em $1 com work_mem mínimo, numa transação, e lê ANTES do commit se o _snap_fonte nasceu
# (ON COMMIT DROP). Imprime: <retorno sem importacao_id>|<snap_fonte nasceu>|<nº de arquivos temp>.
promove() {
  local db="$1" run="$2" tag; tag="t$(uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]')"
  local out
  out="$(PGAPPNAME="$tag" PA -q -d "$db" -tA -c "SET work_mem = '64kB'" -c "BEGIN" \
          -c "SELECT (tint_promote_sync_run('$run') - 'importacao_id')::text" \
          -c "SELECT (to_regclass('pg_temp._snap_fonte') IS NOT NULL)::text" -c "COMMIT" | paste -sd'|' -)"
  local n; n="$(grep -c "^$tag|.*temporary file" "$TMP/pg.log" || true)"
  echo "$out|$n"
}
ret_de()   { printf '%s' "$1" | cut -d'|' -f1; }
marca_de() { printf '%s' "$1" | cut -d'|' -f2; }
temp_de()  { printf '%s' "$1" | cut -d'|' -f3; }

# ── referência: o promote ANTIGO, um banco por cenário ───────────────────────────────────────────────
for c in CAT SKU FORM; do
  PA -q -d postgres -c "CREATE DATABASE ref_$(echo $c | tr '[:upper:]' '[:lower:]') TEMPLATE tpl_snap" >/dev/null
done
REF_CAT="$(promove ref_cat "$RUN_CAT")";   EST_CAT="$(q ref_cat "SELECT _estado('$RUN_CAT')")"
REF_SKU="$(promove ref_sku "$RUN_SKU")";   EST_SKU="$(q ref_sku "SELECT _estado('$RUN_SKU')")"
REF_FORM="$(promove ref_form "$RUN_FORM")"; EST_FORM="$(q ref_form "SELECT _estado('$RUN_FORM')")"

# controle de não-vacuidade: o ANTIGO cria o _snap_fonte e derrama temp no catalogs sem expansão
[ "$(marca_de "$REF_CAT")" = "true" ] || { echo "✗ controle: o promote antigo não criou o _snap_fonte no catalogs [$REF_CAT] — MARCA_CAT seria vácuo"; exit 1; }
[ "$(temp_de "$REF_CAT")" -gt 0 ] || { echo "✗ controle: o promote antigo não derramou temp no catalogs [$REF_CAT] — TEMP_CAT seria vácuo"; exit 1; }
# …e com expansão o filtro age (o cenário exercita o caminho que a migration preserva)
for r in "$REF_SKU" "$REF_FORM"; do
  n="$(ret_de "$r" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("fantasmas_fonte_barradas"))')"
  [ "$n" -gt 0 ] 2>/dev/null || { echo "✗ controle: com expansão o filtro antigo não barrou fantasma [$r]"; exit 1; }
done
echo "  · controle (promote antigo): catalogs sem expansão cria o _snap_fonte e escreve $(temp_de "$REF_CAT") arquivo(s) temp; SKU/FORM barram fantasma"

TODOS="APLICA MD5 PAR_CAT PAR_SKU PAR_FORM MARCA_CAT TEMP_CAT FILTRO IDEMP GUARDA ACL"
c_este_de() { sed -nE "s/^  c_este constant text := '([^']*)';/\1/p" "$1"; }
estado_cor() {  # ATIVA | INATIVA | AUSENTE (count(*) primeiro: bool_or de zero linhas é NULL)
  q "$1" "SELECT CASE WHEN count(*) = 0 THEN 'AUSENTE' WHEN bool_or(desativada_em IS NULL) THEN 'ATIVA' ELSE 'INATIVA' END
            FROM tint_formulas f JOIN tint_embalagens e ON e.id = f.embalagem_id
           WHERE f.cor_id = '$2' AND e.id_embalagem_sayersystem = '$3'"
}

# ── a suíte: $1 = arquivo da migration (real ou sabotada), $2 = prefixo dos bancos; imprime os que CAÍRAM ──
suite() {
  local mig="$1" db="$2" caidos="" r
  cai() { caidos="$caidos $1"; }
  local c
  for c in cat sku form; do
    PA -q -d postgres -c "CREATE DATABASE ${db}_$c TEMPLATE tpl_snap" >/dev/null
    if ! PA -q -d "${db}_$c" --single-transaction -f "$mig" >"$TMP/${db}_$c.apl" 2>&1; then
      echo "$TODOS"; return
    fi
  done
  [ "$(q "${db}_cat" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")" \
    = "$(c_este_de "$mig")" ] || cai MD5

  local rc rs rf
  rc="$(promove "${db}_cat" "$RUN_CAT")"; rs="$(promove "${db}_sku" "$RUN_SKU")"; rf="$(promove "${db}_form" "$RUN_FORM")"
  [ "$(ret_de "$rc")" = "$(ret_de "$REF_CAT")" ] && [ "$(q "${db}_cat" "SELECT _estado('$RUN_CAT')")" = "$EST_CAT" ] || cai PAR_CAT
  [ "$(ret_de "$rs")" = "$(ret_de "$REF_SKU")" ] && [ "$(q "${db}_sku" "SELECT _estado('$RUN_SKU')")" = "$EST_SKU" ] || cai PAR_SKU
  [ "$(ret_de "$rf")" = "$(ret_de "$REF_FORM")" ] && [ "$(q "${db}_form" "SELECT _estado('$RUN_FORM')")" = "$EST_FORM" ] || cai PAR_FORM
  [ "$(marca_de "$rc")" = "false" ] || cai MARCA_CAT
  [ "$(temp_de "$rc")" = "0" ] || { cai TEMP_CAT; echo "    (TEMP_CAT: $(temp_de "$rc") arquivo(s))" >&2; }
  local ns nf
  ns="$(ret_de "$rs" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("fantasmas_fonte_barradas"))' 2>/dev/null || echo erro)"
  nf="$(ret_de "$rf" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("fantasmas_fonte_barradas"))' 2>/dev/null || echo erro)"
  if [ "$(estado_cor "${db}_sku" A E900)" != "INATIVA" ] || [ "$(estado_cor "${db}_sku" A E3600)" != "AUSENTE" ] \
     || [ "$(estado_cor "${db}_form" A E900)" != "INATIVA" ] || [ "$(estado_cor "${db}_sku" B1 E3600)" != "ATIVA" ] \
     || ! [ "$ns" -gt 0 ] 2>/dev/null || ! [ "$nf" -gt 0 ] 2>/dev/null; then
    cai FILTRO
  fi

  local antes depois
  antes="$(q "${db}_cat" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  if PA -q -d "${db}_cat" --single-transaction -f "$mig" >/dev/null 2>&1; then
    depois="$(q "${db}_cat" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
    [ "$antes" = "$depois" ] || cai IDEMP
  else
    cai IDEMP
  fi

  # GUARDA: um promote de OUTRO corpo (versão posterior hipotética) — a migration aborta e não o troca
  PA -q -d postgres -c "CREATE DATABASE ${db}_guarda TEMPLATE tpl_snap" >/dev/null
  PA -q -d "${db}_guarda" -c "DO \$g\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure), 'v_snap_id uuid;', 'v_snap_id uuid;  -- outro corpo'); END \$g\$" >/dev/null
  antes="$(q "${db}_guarda" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  if PA -q -d "${db}_guarda" --single-transaction -f "$mig" >"$TMP/${db}_guarda.apl" 2>&1; then
    cai GUARDA
  else
    depois="$(q "${db}_guarda" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
    # qualquer camada da própria migration (PRE ou PÓS-md5) — F4 desliga a PRE e exige que a PÓS segure
    grep -q 'promote-snap-fonte ABORTADA' "$TMP/${db}_guarda.apl" && [ "$antes" = "$depois" ] || cai GUARDA
  fi

  [ "$(q "${db}_cat" "SELECT has_function_privilege('anon','public.tint_promote_sync_run(uuid)','EXECUTE')
                    OR has_function_privilege('authenticated','public.tint_promote_sync_run(uuid)','EXECUTE')")" = "f" ] || cai ACL
  echo "${caidos# }"
}

# ── a migration real ─────────────────────────────────────────────────────────────────────────────────
FALHAS=0
caidos="$(suite "$MIG" real)"
if [ -n "$caidos" ]; then
  echo "✗ migration real: caíram [$caidos]"; sed -n 1,20p "$TMP/real_cat.apl"; FALHAS=1
else
  echo "  ✓ migration real: $TODOS"
fi
# Falsificar sem o controle verde é teatro: uma suíte que reprova tudo aprovaria qualquer sabotagem.
[ "$FALHAS" -eq 0 ] || { echo "VERMELHO (migration real) — falsificações não rodadas"; exit 1; }

# ── falsificações: sabota UMA camada por vez numa cópia; exige o conjunto EXATO de asserts vermelhos ──
# A cópia é CONSISTENTE: o c_este dela é o md5 que o próprio banco calcula para o corpo sabotado (lido
# do erro de um ensaio com c_este sentinela), senão MD5 cairia em toda falsificação e mascararia a camada.
FALSIF_ERR=0
cat >"$TMP/sabota.py" <<'PY'
import sys
src, trocas, dst = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read()
for par in open(trocas).read().rstrip('\n').split('\n=====\n'):
    a, b = par.split('\n-----\n')
    if t.count(a) != 1:
        print('ANCORA'); sys.exit(0)
    t = t.replace(a, b)
open(dst, 'w').write(t)
print('OK')
PY
NF=0
falsifica() {
  local rot="$1"; shift
  local esperado="$*" copia="$TMP/$rot.sql" python_out
  NF=$((NF + 1))
  python_out="$(python3 "$TMP/sabota.py" "$MIG" "$TMP/trocas_$rot" "$copia")"
  if [ "$python_out" != "OK" ]; then echo "  ✗ $rot: sabotagem NÃO aplicou (âncora) — inválida"; FALSIF_ERR=$((FALSIF_ERR + 1)); return; fi
  local ens md5s
  ens="ens_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  sed -i.bak -E "s/^  c_este constant text := '[^']*';/  c_este constant text := 'SENTINELA';/" "$copia"
  PA -q -d postgres -c "CREATE DATABASE $ens TEMPLATE tpl_snap" >/dev/null
  md5s="$(PA -q -d "$ens" --single-transaction -f "$copia" 2>&1 | grep -oE 'md5 do promote e [0-9a-f]{32}' | grep -oE '[0-9a-f]{32}' || true)"
  if [ -n "$md5s" ]; then
    sed -i.bak -E "s/^  c_este constant text := 'SENTINELA';/  c_este constant text := '$md5s';/" "$copia"
  fi
  local db got; db="f_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  got="$(suite "$copia" "$db" 2>/dev/null)"
  if [ "$got" = "$esperado" ]; then echo "  ✓ $rot: caíram exatamente [$got]"
  else echo "  ✗ $rot: esperava [$esperado], caíram [$got]"; FALSIF_ERR=$((FALSIF_ERR + 1)); fi
}

# F1: sem o guard — o snapshot volta a nascer em TODA promoção (num ramo em minúsculas que a PÓS, que
#     casa por texto exato, não enxerga; o ramo guardado fica para a expansão). Estado idêntico: só a
#     MARCA e o TEMP caem — é a camada que a migration acrescenta, e a paridade não a vê.
cat >"$TMP/trocas_F1" <<'EOF'
  IF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
-----
  IF v_snap_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _expand_uniq) THEN
    create temp table _snap_fonte on commit drop as
    SELECT DISTINCT chave FROM tint_keys_snapshots, jsonb_array_elements_text(keys) AS chave
     WHERE snapshot_id = v_snap_id AND entity = 'formulas';
  ELSIF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
EOF
falsifica F1 MARCA_CAT TEMP_CAT

# F2: guard que NUNCA deixa o filtro agir (o 1º ramo captura todo snapshot aplicado) — o defeito
#     simétrico: sem temp, mas a fantasma ressuscita onde há expansão. Caem a paridade dos 2 cenários
#     com expansão e o FILTRO absoluto.
cat >"$TMP/trocas_F2" <<'EOF'
  IF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
-----
  IF v_snap_id IS DISTINCT FROM NULL THEN
    NULL;
  ELSIF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
EOF
falsifica F2 PAR_SKU PAR_FORM FILTRO

# F3: sem o no-op por md5 → re-aplicar bate na PRE (o vivo já não é o predecessor) e aborta → IDEMP cai
cat >"$TMP/trocas_F3" <<'EOF'
  IF v_md5 = c_este THEN
-----
  IF false THEN
EOF
falsifica F3 IDEMP

# F4: PRE desligada (aceita qualquer corpo vivo) → no "outro corpo" a âncora ainda casa e o EXECUTE
#     troca; o PÓS-md5 aborta e a transação desfaz. GUARDA continua verde = a PÓS-md5 é a 2ª camada
#     (redundância registrada, não defeito): conjunto esperado VAZIO.
cat >"$TMP/trocas_F4" <<'EOF'
  IF v_md5 <> c_pred THEN
-----
  IF false THEN
EOF
falsifica F4

# F5: REVOKE trocado por GRANT a authenticated e a PÓS de ACL desligada → só ACL cai
cat >"$TMP/trocas_F5" <<'EOF'
REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated;
-----
GRANT EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) TO authenticated;
=====
  IF has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE') THEN
-----
  IF false THEN
EOF
falsifica F5 ACL

# F6: sem a TROCA — a migration reemite o corpo VIVO (EXECUTE v_def) e as duas PÓS que a pegariam (md5 e
#     textual) saem junto: o EXECUTE sabotado RODA (sem PÓS-md5 o ensaio não devolve md5 e o c_este fica
#     SENTINELA). Só o comportamento denuncia: MD5, MARCA_CAT e TEMP_CAT caem; IDEMP segue (reemitir é no-op).
cat >"$TMP/trocas_F6" <<'EOF'
  EXECUTE replace(v_def, c_busca, c_troca);
-----
  EXECUTE v_def;
=====
  IF v_md5 <> c_este THEN
-----
  IF false THEN
=====
     OR position('IF v_snap_id IS NOT NULL THEN' in v_src) > 0 THEN
-----
     OR position('IF v_snap_id IS NOT NULL THEN' in v_src) > 0) THEN
=====
  IF v_expand = 0 OR v_guard = 0 OR v_snap = 0 OR v_delete = 0
-----
  IF false AND (v_expand = 0 OR v_guard = 0 OR v_snap = 0 OR v_delete = 0
EOF
falsifica F6 MD5 MARCA_CAT TEMP_CAT

# F7: a camada TEXTUAL da PÓS sozinha — a troca reinsere o IF SEM o guard (md5 consistente pelo ensaio,
#     então a PÓS-md5 passa): a postcondição P1 aborta a migration → APLICA cai e, com ele, tudo.
cat >"$TMP/trocas_F7" <<'EOF'
  IF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
-----
  IF v_snap_id IS NOT NULL THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
EOF
# shellcheck disable=SC2086  # TODOS é a lista de asserts, um por palavra
falsifica F7 $TODOS

echo
if [ "$FALHAS" -ne 0 ] || [ "$FALSIF_ERR" -ne 0 ]; then
  echo "VERMELHO (falhas=$FALHAS, falsificações erradas=$FALSIF_ERR)"; exit 1
fi
echo "VERDE: $TODOS + $NF falsificações (locale $LOC)"

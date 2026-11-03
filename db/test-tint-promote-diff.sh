#!/usr/bin/env bash
# PROVA — 20261103093424_tint_promote_escreve_so_o_que_mudou.sql
#
# A promoção de fórmulas reexpande o PAR (cod_produto, id_base) inteiro e reescrevia toda chave do par:
# 606 stagings (599 idênticas) → 408.470 fórmulas + ~1,5 M itens reescritos (02/11, Mini, 15 min). A
# migration tira de _expand_uniq a chave cujo oficial já é o que seria gravado E é mais novo que a staging
# vencedora. Esta prova sobe o corpo VIVO do promote (md5 conferido contra prod) e assevera:
#
#   MD5     o promote trocado tem o md5 que a migration declara
#   EQUIV   a partir do MESMO estado, a sequência de 11 runs dá o MESMO resultado com o promote ANTIGO e o
#           novo: fórmulas (header, preço, volume, ativa/motivo, sku), receita (corante, ORDEM, qtd pelo
#           TEXTO), catálogo, erros por run, importações, retorno e metadata de cada run (sem
#           importacao_id/formulas_identicas_puladas) e o FRESCOR por fórmula (updated_at e created_at de
#           todo item > staging mais nova da chave — a prova que o formula-identica.ts da edge usa)
#   PULA    o novo pula de fato: no reenvio idêntico de 1 cor (R3), todas as chaves do par menos as dela
#   VOLUME  reenvio de 2 cores num par de 4.000 fórmulas/12.000 itens: o novo escreve ≤ 100 tuplas nas duas
#           tabelas oficiais; o antigo (controle) ≥ 20.000
#   ACL     anon/authenticated não executam o promote
#   IDEMP   re-aplicar é no-op (md5 igual)
#   GUARDA  re-aplicar sobre um promote de OUTRO corpo (versão posterior) ABORTA em vez de revertê-lo
# Fora da suíte (só controle): DERIVA — corpo vivo diferente do revisado ABORTA e não troca nada.
# Controles de não-vacuidade: a referência (promote antigo) tem de exibir cada caso de borda.
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), cada uma com o conjunto EXATO de
# asserts que TEM de cair, depois do controle verde NA MESMA invocação.
#
# Uso: db/test-tint-promote-diff.sh   (PGPORT_TEST=<porta>; LOCALE_TESTE=pt_BR.UTF-8 roda no 2º idioma)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5457}}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-diff.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261103093424_tint_promote_escreve_so_o_que_mudou.sql"
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
MIG_5B1="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
MIG_ASYNC="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
MIG_FANT="$REPO_ROOT/supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql"
MIG_REF="$REPO_ROOT/supabase/migrations/20261013220000_tint_promote_snapshot_ref_por_generated_at.sql"
MIG_PURGE="$REPO_ROOT/supabase/migrations/20261021203000_tint_purge_staging_fora_do_promote.sql"
MIG_LATEST="$REPO_ROOT/supabase/migrations/20261030071806_tint_promote_latest_por_chave_indexado.sql"
MD5_PROD='954a96411be99c18ab4bff40df14e620'   # md5(prosrc) do promote em prod, 2026-11-03 (psql-ro)

for f in "$MIG" "$MIG_V6" "$MIG_5B1" "$MIG_ASYNC" "$MIG_FANT" "$MIG_REF" "$MIG_PURGE" "$MIG_LATEST"; do
  [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }
done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
# autovacuum desligado: os contadores de pg_stat são a medida do VOLUME — nada além da promoção escreve.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }
q() { PA -d "$1" -tA -c "$2"; }
echo "  · locale do cluster: $(q postgres "SELECT datcollate FROM pg_database WHERE datname = 'postgres'")"

# ── template = o corpo vivo do promote (cadeia da prova do latest-indexado + o próprio latest) ──────
PA -q -d postgres -c "CREATE DATABASE tpl_diff" >/dev/null
T() { PA -d tpl_diff "$@"; }
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

VIVO="$(T -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
[ "$VIVO" = "$MD5_PROD" ] || { echo "✗ pré-condição: o template não é o corpo de PROD (md5 $VIVO, prod $MD5_PROD)"; exit 1; }
echo "  · template = corpo de prod (md5 $VIVO)"

# Helpers SÓ de teste (idênticos na referência e em cada suíte): run, fórmula de staging com itens.
T -q <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_l1', true),
       ('aaaaaaaa-0000-0000-0000-000000000002','oben','BIG','automatic_primary','tok_big', true);
CREATE TABLE _res (rot text PRIMARY KEY, run uuid, r jsonb, estado text);
CREATE FUNCTION _run(p_id uuid, p_tipo text, p_store text DEFAULT 'L1') RETURNS void LANGUAGE sql AS $$
  INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
  VALUES (p_id, CASE p_store WHEN 'L1' THEN 'aaaaaaaa-0000-0000-0000-000000000001'::uuid
                             ELSE 'aaaaaaaa-0000-0000-0000-000000000002'::uuid END,
          'oben', p_store, p_tipo, 'complete') $$;
-- itens = [[corante, ordem, qtd], ...] (qtd como texto: '0' e 'NaN' são legítimos no staging);
-- expected = nº de linhas; pura = tríade da Fase 1d (expected 0, sem linha).
CREATE FUNCTION _sf(p_run uuid, p_cor text, p_nome text, p_prod text, p_base text, p_sub text, p_pers boolean,
                    p_itens jsonb, p_pura boolean DEFAULT NULL, p_store text DEFAULT 'L1')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v uuid; e jsonb;
BEGIN
  INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
         id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, is_base_pura)
  VALUES (p_run, 'oben', p_store, p_cor, p_nome, p_prod, p_base, 'X', p_sub, 900, p_pers,
          jsonb_array_length(p_itens), p_pura)
  RETURNING id INTO v;
  FOR e IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
    VALUES (p_run, v, e->>0, (e->>1)::int, (e->>2)::numeric);
  END LOOP;
END $$;
-- Promoção que pode esperar um lock: devolve o desfecho em ASCII (o texto do erro é traduzido no pt_BR).
CREATE FUNCTION _tenta(p_run uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.tint_promote_sync_run(p_run);
  RETURN 'PASSOU';
EXCEPTION WHEN lock_not_available THEN
  RETURN 'BLOQUEADO';
END $$;
-- Estado do par P1 (L1) por chave natural, sem id/importacao_id/timestamps — o frescor entra como
-- BOOLEANO relativo à staging mais nova da cor no par (a prova do formula-identica.ts da edge).
CREATE FUNCTION _estado() RETURNS text LANGUAGE sql AS $$
  SELECT md5(string_agg(x, E'\n' ORDER BY x)) || ' ' || count(*) FROM (
    SELECT format('%L|%L|%L|%L|%L|%L|%L|%L|%L|%L|%L|%L|%L', f.cor_id, f.nome_cor,
           p.cod_produto, b.id_base_sayersystem, e.id_embalagem_sayersystem, sc.id_subcolecao_sayersystem,
           f.volume_final_ml::text, f.preco_final_sayersystem::text, f.personalizada, f.desativada_em IS NULL,
           f.desativada_motivo, (sk.id IS NOT NULL AND sk.embalagem_id = f.embalagem_id),
           (SELECT string_agg(format('%s:%s:%s', co.id_corante_sayersystem, i.ordem, i.qtd_ml::text), ','
                              ORDER BY co.id_corante_sayersystem)
              FROM tint_formula_itens i JOIN tint_corantes co ON co.id = i.corante_id
             WHERE i.formula_id = f.id))
           || '|fresca=' || COALESCE((
             SELECT (f.updated_at > m.ult)
                    AND NOT EXISTS (SELECT 1 FROM tint_formula_itens i
                                     WHERE i.formula_id = f.id AND NOT (i.created_at > m.ult))
               FROM (SELECT max(s.created_at) AS ult FROM tint_staging_formulas s
                      WHERE s.store_code = 'L1' AND s.cor_id = f.cor_id
                        AND s.cod_produto = p.cod_produto AND s.id_base = b.id_base_sayersystem) m)::text, '-') AS x
      FROM tint_formulas f JOIN tint_embalagens e ON e.id = f.embalagem_id
      JOIN tint_produtos p ON p.id = f.produto_id JOIN tint_bases b ON b.id = f.base_id
      LEFT JOIN tint_subcolecoes sc ON sc.id = f.subcolecao_id
      LEFT JOIN tint_skus sk ON sk.id = f.sku_id
     WHERE p.cod_produto = 'P1') s $$;
-- Promove e FOTOGRAFA o estado logo depois: a equivalência vale a cada run, não só no fim (um run
-- posterior pode "curar" uma divergência intermediária — F7/F8 ficavam verdes comparando só o final).
CREATE FUNCTION _promove(p_rot text, p_run uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.tint_promote_sync_run(p_run);
  INSERT INTO _res VALUES (p_rot, p_run, v, _estado());
  RETURN v;
END $$;
SQL

# ── massa BIG (loja BIG, produtos KP0..KP4 × base KB0 × 4 embalagens × 1.000 cores) ──────────────────
# Fica no TEMPLATE (promovida pelo promote ANTIGO): referência e cada suíte partem do mesmo oficial.
T -q <<'SQL' >/dev/null
SELECT _run('b0000000-0000-0000-0000-000000000001', 'catalogs', 'BIG');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
SELECT 'b0000000-0000-0000-0000-000000000001','oben','BIG','KP' || k, 'KP' || k FROM generate_series(0, 4) k;
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','BIG','KB0','KB0');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
SELECT 'b0000000-0000-0000-0000-000000000001','oben','BIG','KE' || k, 'KE' || k, (ARRAY[900, 3600, 18000, 450])[k + 1]
  FROM generate_series(0, 3) k;
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, volume_ml)
SELECT 'b0000000-0000-0000-0000-000000000001','oben','BIG','KC' || k, 'KC' || k, 50, 1000 FROM generate_series(0, 2) k;
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
SELECT 'b0000000-0000-0000-0000-000000000001','oben','BIG','KP' || p, 'KB0', 'KE' || e
  FROM generate_series(0, 4) p, generate_series(0, 3) e;
SELECT tint_promote_sync_run('b0000000-0000-0000-0000-000000000001');
-- 5.000 fórmulas de staging, 4 linhas cada (KC0 em 2 etapas: ordem 1 e 4 — a maior ordem vence).
SELECT _run('b0000000-0000-0000-0000-000000000002', 'formulas', 'BIG');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
       id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
SELECT 'b0000000-0000-0000-0000-000000000002','oben','BIG','K' || lpad(c::text, 4, '0'), 'Cor ' || c,
       'KP' || p, 'KB0', 'KE0', NULL, 900, false, 4
  FROM generate_series(1, 1000) c, generate_series(0, 4) p;
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sf.sync_run_id, sf.id, v.c, v.o, v.q + (substr(sf.cor_id, 2)::int % 7)
  FROM tint_staging_formulas sf,
       (VALUES ('KC0', 1, 0.5), ('KC0', 4, 2.25), ('KC1', 2, 1.125), ('KC2', 3, 3.0)) v(c, o, q)
 WHERE sf.sync_run_id = 'b0000000-0000-0000-0000-000000000002';
SELECT tint_promote_sync_run('b0000000-0000-0000-0000-000000000002');
ANALYZE;
SQL
echo "  · massa BIG: $(T -tA -c "SELECT count(*) || ' fórmulas, ' || (SELECT count(*) FROM tint_formula_itens) || ' itens' FROM tint_formulas")"

# ── cenário de equivalência (loja L1, par P1/B1 com E900 e E3600) ────────────────────────────────────
seed() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
-- R1: catálogo. Corantes sem custo (como a prod).
SELECT _run('11111111-0000-0000-0000-000000000001', 'catalogs');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','P1');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','B1','B1');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','E900','E900', 900),
       ('11111111-0000-0000-0000-000000000001','oben','L1','E3600','E3600', 3600);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','AX','AX', 11, 1000),
       ('11111111-0000-0000-0000-000000000001','oben','L1','AY','AY', 22, 1000),
       ('11111111-0000-0000-0000-000000000001','oben','L1','AZ','AZ', 33, 1000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','B1','E900'),
       ('11111111-0000-0000-0000-000000000001','oben','L1','P1','B1','E3600');
SELECT _promove('R1', '11111111-0000-0000-0000-000000000001');

-- R2: o par nasce. C1 com subcoleção SL; C3 em 2 etapas; C4 base pura; C7 personalizada; C9 pigmentada.
SELECT _run('11111111-0000-0000-0000-000000000002', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000002','C1','Cor 1','P1','B1','SL',false,'[["AX",1,"10"],["AY",2,"4"]]');
SELECT _sf('11111111-0000-0000-0000-000000000002','C2','Cor 2','P1','B1',NULL,false,'[["AX",1,"5"]]');
SELECT _sf('11111111-0000-0000-0000-000000000002','C3','Cor 3','P1','B1',NULL,false,'[["AY",1,"2"],["AY",2,"3"]]');
SELECT _sf('11111111-0000-0000-0000-000000000002','C4','Cor 4','P1','B1',NULL,false,'[]',true);
SELECT _sf('11111111-0000-0000-0000-000000000002','C5','Cor 5','P1','B1',NULL,false,'[["AX",1,"7"],["AZ",2,"1"]]');
SELECT _sf('11111111-0000-0000-0000-000000000002','C6','Cor 6','P1','B1',NULL,false,'[["AX",1,"1"],["AY",2,"1"]]');
SELECT _sf('11111111-0000-0000-0000-000000000002','C7','Cor 7','P1','B1',NULL,true,'[["AX",1,"2"]]');
SELECT _sf('11111111-0000-0000-0000-000000000002','C9','Cor 9','P1','B1',NULL,false,'[["AZ",1,"8"]]');
SELECT _promove('R2', '11111111-0000-0000-0000-000000000002');

-- R3: reenvio IDÊNTICO de C1 (staging mais nova que o oficial) → reexpande o par inteiro.
SELECT _run('11111111-0000-0000-0000-000000000003', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000003','C1','Cor 1','P1','B1','SL',false,'[["AX",1,"10"],["AY",2,"4"]]');
SELECT _promove('R3', '11111111-0000-0000-0000-000000000003');

-- R4: mudanças. C1 só o nome; C2 qtd; C3 só a ORDEM vencedora; C5 perde AZ; C6 corrompida (barrada,
-- oficial preservado); C8 chave nova; C9 vira base pura declarada (limpa a receita).
SELECT _run('11111111-0000-0000-0000-000000000004', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000004','C1','Cor 1 nova','P1','B1','SL',false,'[["AX",1,"10"],["AY",2,"4"]]');
SELECT _sf('11111111-0000-0000-0000-000000000004','C2','Cor 2','P1','B1',NULL,false,'[["AX",1,"6"]]');
SELECT _sf('11111111-0000-0000-0000-000000000004','C3','Cor 3','P1','B1',NULL,false,'[["AY",1,"2"],["AY",3,"3"]]');
SELECT _sf('11111111-0000-0000-0000-000000000004','C5','Cor 5','P1','B1',NULL,false,'[["AX",1,"7"]]');
SELECT _sf('11111111-0000-0000-0000-000000000004','C6','Cor 6','P1','B1',NULL,false,'[["AX",1,"1"],["AY",2,"0"]]');
SELECT _sf('11111111-0000-0000-0000-000000000004','C8','Cor 8','P1','B1',NULL,false,'[["AX",1,"3"],["AZ",2,"0.5"]]');
SELECT _sf('11111111-0000-0000-0000-000000000004','C9','Cor 9','P1','B1',NULL,false,'[]',true);
SELECT _promove('R4', '11111111-0000-0000-0000-000000000004');

-- R5: catálogo muda o volume da E900 (não reexpande: sku já existe).
SELECT _run('11111111-0000-0000-0000-000000000005', 'catalogs');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000005','oben','L1','E900','E900', 950);
SELECT _promove('R5', '11111111-0000-0000-0000-000000000005');

-- R6: reenvio de C7 → reexpande: toda E900 muda volume (e dose); E3600 idêntica; C4 pura só no volume.
SELECT _run('11111111-0000-0000-0000-000000000006', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000006','C7','Cor 7','P1','B1',NULL,true,'[["AX",1,"2"]]');
SELECT _promove('R6', '11111111-0000-0000-0000-000000000006');

-- R7: C2 desativada como o keys-snapshot faz (desativada_em + updated_at = now()); reenvio de C4 a reativa.
UPDATE tint_formulas SET desativada_em = now(), updated_at = now() WHERE cor_id = 'C2';
SELECT _run('11111111-0000-0000-0000-000000000007', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000007','C4','Cor 4','P1','B1',NULL,false,'[]',true);
SELECT _promove('R7', '11111111-0000-0000-0000-000000000007');

-- R8: preço de base da E3600 + custo do AX no mesmo run, reenvio de C5 → preço muda (E2) e o E4 roda.
SELECT _run('11111111-0000-0000-0000-000000000008', 'formulas');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('11111111-0000-0000-0000-000000000008','oben','L1','P1','B1','E3600', 300, 10, 20);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, custo, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000008','oben','L1','AX','AX', 11, 10, 1000);
SELECT _sf('11111111-0000-0000-0000-000000000008','C5','Cor 5','P1','B1',NULL,false,'[["AX",1,"7"]]');
SELECT _promove('R8', '11111111-0000-0000-0000-000000000008');

-- R9: o MESMO preço e custo de novo + reenvio de C5 → as E3600 só-AX ficam idênticas (puladas) e o E4
-- (as duas pontas) tem de excluí-las como antes excluía pelo importacao_id.
SELECT _run('11111111-0000-0000-0000-000000000009', 'formulas');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('11111111-0000-0000-0000-000000000009','oben','L1','P1','B1','E3600', 300, 10, 20);
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, preco_litro, custo, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000009','oben','L1','AX','AX', 11, 10, 1000);
SELECT _sf('11111111-0000-0000-0000-000000000009','C5','Cor 5','P1','B1',NULL,false,'[["AX",1,"7"]]');
SELECT _promove('R9', '11111111-0000-0000-0000-000000000009');

-- R10: receita de C1 com a mesma QUANTIDADE e outra ESCALA (10 vs 10.000000, como um import legado);
-- reenvio de C2 → o antigo reescreve; o novo tem de ver a diferença de texto e reescrever também.
UPDATE tint_formula_itens SET qtd_ml = trim_scale(qtd_ml)
 WHERE formula_id IN (SELECT id FROM tint_formulas WHERE cor_id = 'C1');
-- ... e edições no OFICIAL sem staging nova (staff/legado: a promoção sempre as sobrescreveu): o nome de
-- C7 e a ordem de C3. Sem staging nova da chave, só a comparação as enxerga (o frescor não).
UPDATE tint_formulas SET nome_cor = 'Cor 7 editada' WHERE cor_id = 'C7';
UPDATE tint_formula_itens SET ordem = ordem + 10
 WHERE formula_id IN (SELECT id FROM tint_formulas WHERE cor_id = 'C3');
SELECT _run('11111111-0000-0000-0000-000000000010', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000010','C2','Cor 2','P1','B1',NULL,false,'[["AX",1,"6"]]');
SELECT _promove('R10', '11111111-0000-0000-0000-000000000010');

-- R11: reenvio idêntico de C3 (o mais comum na prod): tudo igual, só C3 reescreve.
SELECT _run('11111111-0000-0000-0000-000000000011', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000011','C3','Cor 3','P1','B1',NULL,false,'[["AY",1,"2"],["AY",3,"3"]]');
SELECT _promove('R11', '11111111-0000-0000-0000-000000000011');

-- R12/R13: a staging de C5 chega (R12) e, ANTES de promovê-la, um run de preço (R13) avança o updated_at
-- das E3600 pelo E4 sem tocar a receita. Na promoção do R12 o header de C5/E3600 é mais novo que a
-- staging, os itens não: tem de reescrever (é o caso do Codex P1 no formula-identica.ts).
SELECT _run('11111111-0000-0000-0000-000000000012', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000012','C5','Cor 5','P1','B1',NULL,false,'[["AX",1,"7"]]');
SELECT _run('11111111-0000-0000-0000-000000000013', 'catalogs');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('11111111-0000-0000-0000-000000000013','oben','L1','P1','B1','E3600', 300, 10, 20);
SELECT _promove('R13', '11111111-0000-0000-0000-000000000013');
SELECT _promove('R12', '11111111-0000-0000-0000-000000000012');

-- R14..R14b (Codex P1): o catálogo R14 cria a E1800 (sku NOVO → reexpande o par) com preço de base 400;
-- o reenvio de C9 (R15) reaceita as chaves E1800 idênticas (o antigo grava importacao_id=R15, o novo as
-- pula e elas guardam R14); chega um preço 500 que ninguém promove (R16); RE-PROMOVE-se o R14. O E4 do
-- R14 tem de recalcular as E1800 pelo preço 500 — o antigo recalcula porque o importacao_id é R15.
SELECT _run('11111111-0000-0000-0000-000000000014', 'catalogs');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000014','oben','L1','E1800','E1800', 1800);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('11111111-0000-0000-0000-000000000014','oben','L1','P1','B1','E1800');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('11111111-0000-0000-0000-000000000014','oben','L1','P1','B1','E1800', 400, 10, 20);
SELECT _promove('R14', '11111111-0000-0000-0000-000000000014');
SELECT _run('11111111-0000-0000-0000-000000000015', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000015','C9','Cor 9','P1','B1',NULL,false,'[]',true);
SELECT _promove('R15', '11111111-0000-0000-0000-000000000015');
SELECT _run('11111111-0000-0000-0000-000000000016', 'catalogs');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('11111111-0000-0000-0000-000000000016','oben','L1','P1','B1','E1800', 500, 10, 20);
SELECT _promove('R14b', '11111111-0000-0000-0000-000000000014');
SQL
}

# Impressão digital do resultado (L1): o estado do par depois de CADA run e no fim, catálogo, retorno e
# metadata de cada run (sem importacao_id/formulas_identicas_puladas), erros e importações.
impressao() {
  PA -d "$1" -tA -c "SELECT md5(string_agg(x, E'\n' ORDER BY x)) || ' ' || count(*) FROM (
    SELECT 'F|final|' || _estado() AS x
    UNION ALL SELECT 'S|' || rot || '|' || estado FROM _res
    UNION ALL SELECT 'C|' || id_corante_sayersystem || '|' || descricao || '|' || volume_total_ml || '|' || COALESCE(preco_litro::text, '-')
      FROM tint_corantes WHERE id_corante_sayersystem IN ('AX', 'AY', 'AZ')
    UNION ALL SELECT 'E|' || id_embalagem_sayersystem || '|' || volume_ml FROM tint_embalagens WHERE id_embalagem_sayersystem LIKE 'E%'
    UNION ALL SELECT 'R|' || rot || '|' || (r - 'importacao_id' - 'formulas_identicas_puladas')::text FROM _res
    UNION ALL SELECT 'M|' || rs.rot || '|' || (tr.metadata - 'formulas_identicas_puladas')::text || '|' || tr.inserts || '|' || tr.errors
      FROM _res rs JOIN tint_sync_runs tr ON tr.id = rs.run
    UNION ALL SELECT 'X|' || rs.rot || '|' || e.entity_id || '|' || e.error_message
      FROM _res rs JOIN tint_sync_errors e ON e.sync_run_id = rs.run
    UNION ALL SELECT 'I|' || rs.rot || '|' || i.status || '|' || i.registros_importados || '|' || i.registros_erro
      FROM _res rs JOIN tint_importacoes i ON i.id = (rs.r->>'importacao_id')::uuid) s"
}

# Tuplas escritas nas duas tabelas oficiais por UMA promoção (sessão própria: o backend descarrega as
# estatísticas ao sair). Fail-closed: promoção que não devolve ok=true ou não deixa o efeito esperado
# imprime FALHOU em vez de um número — uma promoção abortada cedo escreveria ~0 e passaria no teto.
escritas() {   # $1 = banco, $2 = run
  local antes depois r
  local sql="SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) FROM pg_stat_user_tables
               WHERE relname IN ('tint_formulas', 'tint_formula_itens')"
  antes="$(q "$1" "$sql")" || { echo FALHOU; return; }
  r="$(PA -q -tA -d "$1" -c "SELECT tint_promote_sync_run('$2')->>'ok'" 2>&1)" \
    || { echo "    (promoção $2 em $1 falhou: $r)" >&2; echo FALHOU; return; }
  [ "$r" = "true" ] || { echo "    (promoção $2 em $1: ok=[$r])" >&2; echo FALHOU; return; }
  # efeito: K0002 com a dose nova (KC1 = 1.125 + 2 + 1 = 4.125, ×1 na KE0) e K0001 fresca.
  r="$(q "$1" "SELECT count(*) FILTER (WHERE f.cor_id = 'K0002' AND i.qtd_ml::text = '4.125000') = 1
                  AND bool_and(i.created_at > (SELECT max(created_at) FROM tint_staging_formulas WHERE cor_id = 'K0001'))
                      FILTER (WHERE f.cor_id = 'K0001')
                 FROM tint_formulas f JOIN tint_formula_itens i ON i.formula_id = f.id
                 JOIN tint_produtos p ON p.id = f.produto_id JOIN tint_embalagens e ON e.id = f.embalagem_id
                 JOIN tint_corantes co ON co.id = i.corante_id
                WHERE p.cod_produto = 'KP0' AND e.id_embalagem_sayersystem = 'KE0' AND co.id_corante_sayersystem = 'KC1'
                  AND f.cor_id IN ('K0001', 'K0002')")" || { echo FALHOU; return; }
  [ "$r" = "t" ] || { echo "    (promoção $2 em $1 sem o efeito esperado: [$r])" >&2; echo FALHOU; return; }
  sleep 1
  depois="$(q "$1" "$sql")" || { echo FALHOU; return; }
  echo $((depois - antes))
}
cabe() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -le "$2" ]; }
# Run BIG medido: reenvio IDÊNTICO de K0001 e K0002 com KC1 mudado, ambos só em KP0 (par de 4.000 fórmulas).
seed_big_run() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
SELECT _run('b0000000-0000-0000-0000-000000000003', 'formulas', 'BIG');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
       id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('b0000000-0000-0000-0000-000000000003','oben','BIG','K0001','Cor 1','KP0','KB0','KE0',NULL,900,false,4),
       ('b0000000-0000-0000-0000-000000000003','oben','BIG','K0002','Cor 2','KP0','KB0','KE0',NULL,900,false,4);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sf.sync_run_id, sf.id, v.c, v.o, v.q + (substr(sf.cor_id, 2)::int % 7) + CASE WHEN sf.cor_id = 'K0002' AND v.c = 'KC1' THEN 1 ELSE 0 END
  FROM tint_staging_formulas sf,
       (VALUES ('KC0', 1, 0.5), ('KC0', 4, 2.25), ('KC1', 2, 1.125), ('KC2', 3, 3.0)) v(c, o, q)
 WHERE sf.sync_run_id = 'b0000000-0000-0000-0000-000000000003';
SQL
}
TETO_VOLUME=100
PISO_ANTIGO=20000

# ── referência: o promote ANTIGO, do MESMO template ──────────────────────────────────────────────────
PA -q -d postgres -c "CREATE DATABASE ref TEMPLATE tpl_diff" >/dev/null
seed ref
IMP_REF="$(impressao ref)"
# A referência tem de EXIBIR cada caso de borda — senão a equivalência é vacuamente verde.
v="$(q ref "SELECT string_agg(x, ';' ORDER BY x COLLATE \"C\") FROM (
  SELECT 'C1nome=' || min(nome_cor) x FROM tint_formulas WHERE cor_id = 'C1'
  UNION ALL SELECT 'C1escala=' || string_agg(DISTINCT i.qtd_ml::text, ',') FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id
     JOIN tint_embalagens e ON e.id = f.embalagem_id WHERE f.cor_id = 'C1' AND e.id_embalagem_sayersystem = 'E3600'
  UNION ALL SELECT 'C2ativa=' || bool_and(desativada_em IS NULL) FROM tint_formulas WHERE cor_id = 'C2'
  UNION ALL SELECT 'C3ordem=' || string_agg(DISTINCT i.ordem::text, ',') FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id WHERE f.cor_id = 'C3'
  UNION ALL SELECT 'C4vol=' || string_agg(volume_final_ml::text, ',' ORDER BY volume_final_ml) FROM tint_formulas WHERE cor_id = 'C4'
  UNION ALL SELECT 'C5itens=' || count(*) FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id WHERE f.cor_id = 'C5'
  UNION ALL SELECT 'C6preservada=' || count(*) FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id WHERE f.cor_id = 'C6'
  UNION ALL SELECT 'C9itens=' || count(*) FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id WHERE f.cor_id = 'C9'
  UNION ALL SELECT 'precoE3600=' || count(preco_final_sayersystem) FROM tint_formulas f JOIN tint_embalagens e ON e.id = f.embalagem_id
     WHERE e.id_embalagem_sayersystem = 'E3600'
  UNION ALL SELECT 'R9recalc=' || (r->>'recalculadas') FROM _res WHERE rot = 'R9'
  UNION ALL SELECT 'R14b=' || (r->>'recalculadas') || '/' || (SELECT count(*) FROM tint_formulas f JOIN tint_embalagens e ON e.id = f.embalagem_id
     WHERE e.id_embalagem_sayersystem = 'E1800' AND f.preco_final_sayersystem > 660) FROM _res WHERE rot = 'R14b'
  UNION ALL SELECT 'R10C1=' || count(*) FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id
     WHERE f.cor_id = 'C1' AND i.qtd_ml::text NOT LIKE '%.%') s")"
ESPERADO_REF='C1escala=16.000000,40.000000;C1nome=Cor 1 nova;C2ativa=true;C3ordem=3;C4vol=950,1800,3600;C5itens=3;C6preservada=4;C9itens=0;R10C1=0;R14b=8/3;R9recalc=3;precoE3600=5'
[ "$v" = "$ESPERADO_REF" ] || { echo "✗ cenário: a referência não exibe os casos de borda: [$v] ≠ [$ESPERADO_REF]"; exit 1; }
echo "  · referência (promote antigo): $IMP_REF — $v"

seed_big_run ref
REF_VOL="$(escritas ref b0000000-0000-0000-0000-000000000003)"
[[ "$REF_VOL" =~ ^[0-9]+$ ]] && [ "$REF_VOL" -ge "$PISO_ANTIGO" ] \
  || { echo "✗ controle: o promote ANTIGO devia escrever ≥ $PISO_ANTIGO tuplas no run BIG (veio $REF_VOL)"; exit 1; }
echo "  · promote antigo: run BIG (2 cores reenviadas) = $REF_VOL tuplas escritas"

TODOS="MD5 EQUIV PULA VOLUME LOCK ACL IDEMP GUARDA"

# ── a suíte: $1 = arquivo da migration (real ou sabotada), $2 = banco; imprime os asserts que CAÍRAM ──
suite() {
  local mig="$1" db="$2" caidos="" v
  cai() { caidos="$caidos $1"; }
  PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE tpl_diff" >/dev/null
  if ! PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.apply.log" 2>&1; then
    echo "    ($db: a migration abortou: $(grep -m1 -E 'ERRO|ERROR' "$TMP/$db.apply.log" | head -c 300))" >&2
    echo "$TODOS"; return
  fi

  v="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  [ "$v" = "$(sed -nE "s/.*c_este constant text := '([0-9a-f]{32})'.*/\1/p" "$MIG")" ] || cai MD5

  if seed "$db" 2>"$TMP/$db.seed.log" && [ "$(impressao "$db")" = "$IMP_REF" ]; then :; else cai EQUIV; fi

  # R3 reenviou só C1: das 2×8 chaves do par (C6 inclusa; nenhuma barrada ainda) pulam todas menos as 2 de C1.
  v="$(q "$db" "SELECT r->>'formulas_identicas_puladas' FROM _res WHERE rot = 'R3'")"
  [ "$v" = "14" ] || { cai PULA; echo "    (PULA: R3 pulou [$v], esperado 14)" >&2; }

  local w
  seed_big_run "$db"; w="$(escritas "$db" b0000000-0000-0000-0000-000000000003)"
  cabe "$w" "$TETO_VOLUME" || { cai VOLUME; echo "    (VOLUME: $w tuplas, teto $TETO_VOLUME)" >&2; }
  echo "    · $db: run BIG = $w tuplas escritas (antigo $REF_VOL)" >&2

  # LOCK (Codex P2): duas lojas da MESMA account não promovem em paralelo. A sessão 1 segura uma promoção
  # de L1 aberta; a da loja BIG tem de esperar (lock_timeout 1 s → BLOQUEADO) e, solta, tem de PASSAR
  # (controle: o run em si promove — o que barrou foi o lock).
  q "$db" "SELECT _run('cccccccc-0000-0000-0000-000000000001', 'catalogs', 'L1'), _run('cccccccc-0000-0000-0000-000000000002', 'catalogs', 'BIG')" >/dev/null
  PA -q -d "$db" -c "BEGIN" -c "SELECT tint_promote_sync_run('cccccccc-0000-0000-0000-000000000001')" \
     -c "SELECT pg_sleep(4)" -c "COMMIT" >"$TMP/$db.lock1.log" 2>&1 &
  local pid_lock=$! v1 v2
  sleep 1.5
  v1="$(PA -tA -d "$db" -c "SET lock_timeout = '1s'" -c "SELECT _tenta('cccccccc-0000-0000-0000-000000000002')" 2>&1 | tail -n 1)"
  wait "$pid_lock" || true
  v2="$(q "$db" "SELECT _tenta('cccccccc-0000-0000-0000-000000000002')" 2>&1)"
  [ "$v1" = "BLOQUEADO" ] && [ "$v2" = "PASSOU" ] || { cai LOCK; echo "    (LOCK: com a outra loja aberta [$v1], depois [$v2])" >&2; }

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

# DERIVA: corpo vivo ≠ revisado (outra sessão recriou o promote) → ABORTA, e a transação não troca nada.
PA -q -d postgres -c "CREATE DATABASE deriva TEMPLATE tpl_diff" >/dev/null
q deriva "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure),
          'runs órfãos >30min → error.', 'runs órfãos >30min → error. (deriva)'); END \$d\$" >/dev/null
DERIVA_MD5="$(q deriva "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
if PA -q -d deriva --single-transaction -f "$MIG" >"$TMP/deriva.log" 2>&1; then
  echo "  ✗ DERIVA: a migration aplicou sobre um corpo vivo que não é o revisado"; FALHAS=$((FALHAS + 1))
elif grep -qF "corpo vivo do promote" "$TMP/deriva.log" \
     && [ "$(q deriva "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")" = "$DERIVA_MD5" ]; then
  echo "  ✓ DERIVA: abortou pelo md5 e não trocou o corpo"; PASSOU=$((PASSOU + 1))
else
  echo "  ✗ DERIVA: abortou pelo motivo errado ou trocou o corpo: $(head -c 300 "$TMP/deriva.log")"; FALHAS=$((FALHAS + 1))
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
t = re.sub(r"c_este constant text := '[0-9a-zA-Z]+'", "c_este constant text := 'SENTINELA'", t, count=1)
open(dst, "w").write(t)
PYTROCA
consistente() {   # $1 = cópia com c_este SENTINELA → reescreve com o md5 calculado pelo banco
  local md5
  PA -q -d postgres -c "DROP DATABASE IF EXISTS ensaio" -c "CREATE DATABASE ensaio TEMPLATE tpl_diff" >/dev/null
  PA -q -d ensaio --single-transaction -f "$1" >"$TMP/ensaio.log" 2>&1 || true
  md5="$(sed -nE 's/.*pos-troca o md5 do promote e ([0-9a-f]{32}) \(esperado SENTINELA\).*/\1/p' "$TMP/ensaio.log" | head -1)"
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
# F1 — sem o FRESCOR do header: o reenvio idêntico da base pura C4 (R7, sem item: o frescor dos itens é
#      vácuo) é pulado e o oficial fica mais velho que a staging. (Com receita, o dos itens já pega o R3.)
falsifica F1 MD5 EQUIV <<'TROCAS'
[("  WHERE f.desativada_em IS NULL\n    AND f.updated_at > sf.created_at\n", "  WHERE f.desativada_em IS NULL\n")]
TROCAS
# F2 — sem o FRESCOR dos itens: no R12 o header de C5/E3600 está fresco (o E4 do R13 o avançou) e a
#      receita é velha — a chave é pulada e a prova da edge (itens mais novos que a staging) se perde.
falsifica F2 MD5 EQUIV <<'TROCAS'
[("    AND COALESCE(atual.fresca, true);", "    AND true;")]
TROCAS
# F3 — quantidade comparada pelo VALOR (trim_scale): a escala legada '10' de C1 (R10) não é reescrita.
falsifica F3 MD5 EQUIV <<'TROCAS'
[("fi.ordem::text || '|' || fi.qtd_ml::text, ','", "fi.ordem::text || '|' || trim_scale(fi.qtd_ml)::text, ','"),
 ("COALESCE(d.ordem::text, 'null') || '|' || d.qtd_ml::text, ','", "COALESCE(d.ordem::text, 'null') || '|' || trim_scale(d.qtd_ml)::text, ','")]
TROCAS
# F4 — a ORDEM fora da assinatura da receita: a ordem editada de C3 (antes do R10) não é desfeita.
falsifica F4 MD5 EQUIV <<'TROCAS'
[("fi.corante_id::text || '|' || fi.ordem::text || '|'", "fi.corante_id::text || '|'"),
 ("d.corante_id::text || '|' || COALESCE(d.ordem::text, 'null') || '|'", "d.corante_id::text || '|'")]
TROCAS
# F5 — nome_cor fora da comparação do header: o nome editado de C7 (antes do R10) não é desfeito.
falsifica F5 MD5 EQUIV <<'TROCAS'
[("    AND f.nome_cor IS NOT DISTINCT FROM eu.nome_cor\n", "")]
TROCAS
# F6 — volume fora da comparação: a base pura C4 (sem item, só o volume da E900 muda no R6) fica velha.
falsifica F6 MD5 EQUIV <<'TROCAS'
[("    AND f.volume_final_ml::text IS NOT DISTINCT FROM eu.vol_destino::text\n", "")]
TROCAS
# F7 — preço fora da comparação: o preço que a E3600 ganha no R8 não é gravado nas chaves puladas
#      (o E4 do R13 o 'cura' depois — por isso o estado é fotografado a cada run).
falsifica F7 MD5 EQUIV <<'TROCAS'
[("    AND f.preco_final_sayersystem::text\n        IS NOT DISTINCT FROM COALESCE(eu.preco, f.preco_final_sayersystem)::text\n", "")]
TROCAS
# F8 — desativada não conta: C2 desativada (R7) é pulada em vez de reativada (o reenvio de C2 no R10
#      a reativaria — o estado por run pega no R7).
falsifica F8 MD5 EQUIV <<'TROCAS'
[("  WHERE f.desativada_em IS NULL\n    AND f.updated_at", "  WHERE true\n    AND f.updated_at")]
TROCAS
# F9 — o E4 de precos_base sem a exclusão das puladas (postcondição ajustada): recalcula a mais no R9.
falsifica F9 MD5 EQUIV <<'TROCAS'
[("      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t3$", "      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n$t3$"),
 ("        / length('NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)') <> 2", "        / length('NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)') <> 1")]
TROCAS
# F10 — o E4 de custo de corante sem a exclusão das puladas (postcondição ajustada): idem, pela outra ponta.
falsifica F10 MD5 EQUIV <<'TROCAS'
[("      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t4$", "      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n$t4$"),
 ("        / length('NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)') <> 2", "        / length('NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)') <> 1")]
TROCAS
# F11 — desempate da receita desejada invertido (MENOR ordem): a 2 etapas nunca casa → reescreve tudo.
#       Direção segura (só custa I/O): EQUIV verde, só o VOLUME e o PULA denunciam.
falsifica F11 MD5 PULA VOLUME <<'TROCAS'
[("      ORDER BY co.id, si.ordem DESC, si.qtd_ml DESC, si.id DESC\n    ) d", "      ORDER BY co.id, si.ordem ASC, si.qtd_ml DESC, si.id DESC\n    ) d")]
TROCAS
# F12 — o diff é calculado mas nunca aplicado (sem o DELETE de _expand_uniq): só o VOLUME denuncia.
falsifica F12 MD5 VOLUME <<'TROCAS'
[("  DELETE FROM _expand_uniq eu\n  USING _pulados pu\n  WHERE pu.staging_formula_id = eu.staging_formula_id AND pu.emb_id = eu.emb_id;\n  GET DIAGNOSTICS v_puladas = ROW_COUNT;\n", "  SELECT count(*) INTO v_puladas FROM _pulados;\n")]
TROCAS
# F13 — a guarda do PRE neutralizada: re-aplicar sobre a versão posterior não aborta pela guarda.
falsifica F13 GUARDA <<'TROCAS'
[("  IF v_md5 <> c_pred THEN", "  IF false THEN")]
TROCAS
# F14 — a postcondição pega o corpo sem a exclusão do E4 (troca removida, contagem 2 intacta): ABORTA.
MOTIVO="P1 FALHOU" falsifica F14 "$TODOS" <<'TROCAS'
[("      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t4$", "      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n$t4$")]
TROCAS
# F15 — o E4 volta a excluir pelo importacao_id do run nas duas pontas (a 1ª versão, Codex P1; postcondição
#       ajustada): na re-promoção do R14 as E1800 puladas pelo R15 guardam importacao_id=R14 e não recalculam.
falsifica F15 MD5 EQUIV <<'TROCAS'
[("      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t3$", "      AND (f.importacao_id IS DISTINCT FROM v_importacao_id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t3$"),
 ("      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t4$", "      AND (f.importacao_id IS DISTINCT FROM v_importacao_id)\n      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)\n$t4$"),
 ("     OR (length(v_src) - length(replace(v_src, 'NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)', '')))\n        / length('NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)') <> 2\n     OR position('f.importacao_id IS DISTINCT FROM v_importacao_id' in v_src) > 0\n", "")]
TROCAS
# F16 — sem o lock por account (postcondição ajustada): a loja BIG promove com a L1 aberta.
falsifica F16 MD5 LOCK <<'TROCAS'
[("  PERFORM pg_advisory_xact_lock(hashtext('tint_formulas_account:' || v_account));\n$t7$", "$t7$"),
 ("     OR position('pg_advisory_xact_lock(hashtext(''tint_formulas_account:'' || v_account))' in v_src) = 0\n", "")]
TROCAS

echo "─── controle $PASSOU ok | falsificações certas: $FALSIF_OK | inválidas/erradas: $FALSIF_ERR ───"
echo "PASS=$PASSOU  FAIL=$FALSIF_ERR"
if [ "$FALSIF_ERR" -ne 0 ]; then echo "RESULTADO: VERMELHO"; exit 1; fi
echo "RESULTADO: VERDE ($LOC) — $PASSOU asserts + $FALSIF_OK falsificações com conjunto exato"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — histórico de receitas do tintométrico + arquivo das 14 cores-fantasma        ║
# ║    20261026214720_tint_receita_versoes.sql      (tabela append-only + captura + cron)      ║
# ║    20261026214721_tint_arquivar_staging_fantasma.sql (lote 1: 7 linhas de staging)         ║
# ║    20261029095257_tint_arquivar_staging_fantasma_lote2.sql (lote 2: fecha a classe)        ║
# ║  bash db/test-tint-receita-versoes.sh > log 2>&1; echo "exit=$?"                           ║
# ║  bash db/test-tint-receita-versoes.sh --falsificar > log 2>&1; echo "exit=$?"              ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                                    ║
# ║                                                                                            ║
# ║  Esquema REAL (schema-snapshot.sql de prod) + grant default do Supabase ligado (senão o    ║
# ║  REVOKE não teria o que provar). Snapshot de chaves no formato do conector                 ║
# ║  (cor|cod_produto|id_base|personalizada), em 2 chunks.                                     ║
# ║                                                                                            ║
# ║  --falsificar: roda PRIMEIRO a suíte contra as migrations reais e exige 0 vermelhos (o     ║
# ║  CONTROLE, na mesma invocação); depois cada sabotagem aplica UMA troca textual numa CÓPIA  ║
# ║  em tmpdir (tem de casar exatamente 1 vez) e exige o CONJUNTO EXATO de asserts vermelhos — ║
# ║  ou, nas de pós-condição, que o apply ABORTE com a marca exata.                            ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5461}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-receita.XXXXXX")"
DATA="$TMP/data"
MIG_H1="$REPO_ROOT/supabase/migrations/20261026214720_tint_receita_versoes.sql"
MIG_A="$REPO_ROOT/supabase/migrations/20261026214721_tint_arquivar_staging_fantasma.sql"
MIG_A2="$REPO_ROOT/supabase/migrations/20261029095257_tint_arquivar_staging_fantasma_lote2.sql"
FALSIFICAR=0; [ "${1:-}" = "--falsificar" ] && FALSIFICAR=1
# Sem locale válido o postmaster do macOS aborta ("became multithreaded"). C por padrão; quem chama
# pode passar LC_ALL=pt_BR.UTF-8 — as marcas casadas abaixo são ASCII e vêm do RAISE, não do psql.
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

for f in "$MIG_H1" "$MIG_A" "$MIG_A2"; do
  [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }
done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }
q()  { PA -qtA -d "$1" -c "$2"; }

# ── template: stubs + esquema de prod + cron stub + grant default do Supabase ──
PA -q -d postgres -c "CREATE DATABASE tpl" >/dev/null
T() { PA -d tpl "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null
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
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

-- helper de fixture (schema próprio, fora do public): uma linha de staging + itens 'cor:dose:slot'
CREATE SCHEMA teste;
CREATE FUNCTION teste.stg(p_cor text, p_idade interval, p_itens text[], p_esperado int DEFAULT NULL,
                          p_pers boolean DEFAULT false, p_prod text DEFAULT 'P1', p_base text DEFAULT 'B1',
                          p_id uuid DEFAULT gen_random_uuid())
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE it text;
BEGIN
  INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
                                     id_embalagem, subcolecao, volume_final_ml, preco_final, personalizada,
                                     raw_data, expected_item_count, created_at)
  VALUES (p_id, '22222222-0000-0000-0000-000000000001', 'oben', 'L1', p_cor, 'Cor ' || p_cor, p_prod, p_base,
          '1', NULL, 900, 99.9, p_pers, jsonb_build_object('fonte', p_cor), p_esperado, now() - p_idade);
  FOREACH it IN ARRAY p_itens LOOP
    INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml, created_at)
    VALUES ('22222222-0000-0000-0000-000000000001', p_id, split_part(it, ':', 1),
            split_part(it, ':', 3)::int, split_part(it, ':', 2)::numeric, now() - p_idade);
  END LOOP;
  RETURN p_id;
END $$;
SQL

# ── fixture: cada chave existe para UM assert ──
fixture() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_test', true);
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, metadata)
VALUES ('22222222-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete',
        '{"agent_version":"0.2.0"}');
-- MUDANCA: C1 muda uma vez (10d → igual 5d → muda 3d)
SELECT teste.stg('C1', '10 days', ARRAY['AX:10:1']);
SELECT teste.stg('C1', '5 days',  ARRAY['AX:10:1']);
SELECT teste.stg('C1', '3 days',  ARRAY['AX:12:1']);
-- ORDEM: C5 troca só o slot
SELECT teste.stg('C5', '6 days', ARRAY['AX:10:1','BY:5:2']);
SELECT teste.stg('C5', '2 days', ARRAY['BY:5:1','AX:10:2']);
-- ESCALA: C2 mesma dose com escala diferente
SELECT teste.stg('C2', '4 days', ARRAY['AX:2.4645:1']);
SELECT teste.stg('C2', '1 day',  ARRAY['AX:2.46450:1']);
-- INCOMPLETA: C3 declara 2 itens, chegou 1
SELECT teste.stg('C3', '4 days', ARRAY['AX:1:1'], 2);
-- RECENTE: C4 chegou há 1 min (itens podem estar em trânsito)
SELECT teste.stg('C4', '1 minute', ARRAY['AX:1:1']);
-- SAIDA/VOLTOU: F1 fora de todo snapshot
SELECT teste.stg('F1', '20 days', ARRAY['AX:3:1']);
-- COR_NOVA: C6 chegou DEPOIS do snapshot e não está nele
SELECT teste.stg('C6', '1 hour', ARRAY['AX:1:1']);
-- as 7 da migration A (ids de prod), personalizadas, fora da fonte
SELECT teste.stg(c, '30 days', ARRAY['0:0:5','AX:1:1'], 2, true, 'FO10.6554', '14', id::uuid)
  FROM (VALUES ('66cbebc0-2c21-481c-a420-eee00aa1c71c','4602081'),('1f2ed55f-4bf7-44a1-b354-d6f139870ad9','4602092'),
               ('c7e4fa46-5b9c-4715-9801-f06dc0294e46','4602093'),('8292ba62-aa72-4586-9faa-4bdf7db1fccf','4602100'),
               ('2ef39afc-3ce4-477d-8bcd-35878c603541','CAFELATTE ARAUCO ZAMBALD'),
               ('d9237a8e-53ad-431e-8093-419300d0a894','CHOCOLATE AMARGO '),
               ('d720a669-f558-4b37-a04a-95bafda747b8','Y149 VERDE')) v(id, c);
-- as 7 do lote 2 (ids, cores, produto e base de prod; 6 itens com os slots livres como '0'/0)
SELECT teste.stg(c, '60 days', ARRAY['1:12.322:1','12:1.925:2','13:17.713:3','16:1.463:4','0:0:5','0:0:6'], 6,
                 true, prod, base, id::uuid)
  FROM (VALUES ('71770a2f-7e45-406a-a329-b39080f41402','4602104','JO05.7796','90'),
               ('77439be5-8fec-40b9-81c9-a411bfbe64dc','885J COLA','JO20.7666','49'),
               ('00f2bf42-fb87-410d-a3ef-a44830206056','CINZA LENADRO MICRO METALIZADA','JO05.7796','91'),
               ('31eeb240-cfd2-4b2d-9300-72bc374fa3ab','KL ','FO20.6501','19'),
               ('4eacc77b-33d4-449d-845d-06a6e085c24d','KL PALHA','FO20.6501','19'),
               ('bdf481d6-7d5b-4627-a076-b99c477b7c82','MARILIES PALHA','FO20.6501','19'),
               ('79cce452-75f1-4382-97bb-a4dffd973256','OVELHA MATHEUS','FB.6045','1')) v(id, c, prod, base);
-- S1: completo e aplicado (o de verdade) — 1 dia atrás, 2 chunks
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks,
                                 chunk_index, keys, created_at, aplicacao_status, aplicado_em)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','55555555-0000-0000-0000-000000000001','formulas',
        now()-interval '1 day', 2, 0, '["C1|P1|B1|false","C5|P1|B1|false"]', now()-interval '1 day', 'aplicado', now()-interval '1 day'),
       ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','55555555-0000-0000-0000-000000000001','formulas',
        now()-interval '1 day', 2, 1, '["C2|P1|B1|false","C3|P1|B1|false","C4|P1|B1|false"]', now()-interval '1 day', 'aplicado', now()-interval '1 day'),
-- S0: mais novo, chunks todos, mas um PENDENTE — e sem C1/C5
       ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','55555555-0000-0000-0000-000000000002','formulas',
        now()-interval '12 hours', 2, 0, '["C2|P1|B1|false"]', now()-interval '12 hours', 'aplicado', now()-interval '12 hours'),
       ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','55555555-0000-0000-0000-000000000002','formulas',
        now()-interval '12 hours', 2, 1, '[]', now()-interval '12 hours', 'pendente', NULL),
-- S0b: ainda mais novo, aplicado, mas só 1 de 2 chunks — e sem C1/C5
       ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','55555555-0000-0000-0000-000000000003','formulas',
        now()-interval '6 hours', 2, 0, '["C2|P1|B1|false"]', now()-interval '6 hours', 'aplicado', now()-interval '6 hours');
SQL
}

nrec() { q "$1" "SELECT count(*) FROM tint_receita_versoes WHERE cor_id = '$2' AND evento = '$3'"; }
IDS_A="ARRAY['66cbebc0-2c21-481c-a420-eee00aa1c71c','1f2ed55f-4bf7-44a1-b354-d6f139870ad9','c7e4fa46-5b9c-4715-9801-f06dc0294e46',
'8292ba62-aa72-4586-9faa-4bdf7db1fccf','2ef39afc-3ce4-477d-8bcd-35878c603541','d9237a8e-53ad-431e-8093-419300d0a894',
'd720a669-f558-4b37-a04a-95bafda747b8']::uuid[]"
IDS_A2="ARRAY['71770a2f-7e45-406a-a329-b39080f41402','77439be5-8fec-40b9-81c9-a411bfbe64dc','00f2bf42-fb87-410d-a3ef-a44830206056',
'31eeb240-cfd2-4b2d-9300-72bc374fa3ab','4eacc77b-33d4-449d-845d-06a6e085c24d','bdf481d6-7d5b-4627-a076-b99c477b7c82',
'79cce452-75f1-4382-97bb-a4dffd973256']::uuid[]"
narq() { q "$1" "SELECT count(*) FROM tint_receita_versoes WHERE evento = 'staging_arquivado' AND staging_formula_id = ANY ($2)"; }
# a CLASSE (a mesma medida da prod): chaves cuja latest de staging tem item de corante '0' com dose 0
classe() {
  q "$1" "SELECT count(*) FROM (SELECT DISTINCT ON (account, store_code, cor_id, cod_produto, id_base, COALESCE(subcolecao, ''), personalizada) id
                                 FROM tint_staging_formulas
                                ORDER BY account, store_code, cor_id, cod_produto, id_base, COALESCE(subcolecao, ''), personalizada,
                                         created_at DESC, id DESC) l
           WHERE EXISTS (SELECT 1 FROM tint_staging_formula_itens i
                          WHERE i.staging_formula_id = l.id AND i.id_corante = '0' AND COALESCE(i.qtd_ml, 0) = 0)"
}
fixture_db() {   # $1 = banco novo com fixture
  PA -q -d postgres -c "CREATE DATABASE $1 TEMPLATE tpl" >/dev/null
  fixture "$1"
}
aplica() { PA -q -d "$1" --single-transaction -f "$2" >"$TMP/$1.$3.log" 2>&1; }

# suite DIR TAG → imprime os asserts VERMELHOS (vazio = tudo verde)
suite() {
  local dir="$1" db="s_$2" caidos=""
  cai() { caidos="$caidos $1"; }
  fixture_db "$db"
  if ! aplica "$db" "$dir/h1.sql" h1; then echo "FIM:APPLY_H1"; return; fi

  [ "$(nrec "$db" C1 receita)" = "2" ] || cai MUDANCA
  [ "$(nrec "$db" C5 receita)" = "1" ] || cai ORDEM
  [ "$(nrec "$db" C2 receita)" = "1" ] || cai ESCALA
  [ "$(nrec "$db" C3 receita)" = "0" ] || cai INCOMPLETA
  [ "$(nrec "$db" C4 receita)" = "0" ] || cai RECENTE
  [ "$(nrec "$db" F1 saiu_da_fonte)" = "1" ] || cai SAIDA
  [ "$(q "$db" "SELECT count(*) FROM tint_receita_versoes WHERE cor_id IN ('C1','C5','C2') AND evento = 'saiu_da_fonte'")" = "0" ] || cai SNAP_PARCIAL
  [ "$(nrec "$db" C6 saiu_da_fonte):$(nrec "$db" C6 receita)" = "0:1" ] || cai COR_NOVA
  [ "$(q "$db" "SELECT (r->>'receitas') || ':' || (r->>'saidas') FROM (SELECT tint_receita_versoes_capturar() r) x")" = "0:0" ] || cai IDEMP

  q "$db" "SELECT teste.stg('F1', '20 minutes', ARRAY['AX:3:1'])" >/dev/null
  q "$db" "SELECT tint_receita_versoes_capturar()" >/dev/null
  [ "$(nrec "$db" F1 receita):$(q "$db" "SELECT evento FROM tint_receita_versoes WHERE cor_id = 'F1' ORDER BY recebido_em DESC LIMIT 1")" = "2:receita" ] || cai VOLTOU

  local ao=0
  for cmd in "UPDATE tint_receita_versoes SET motivo = 'x'" "DELETE FROM tint_receita_versoes" "TRUNCATE tint_receita_versoes"; do
    if q "$db" "BEGIN; $cmd; ROLLBACK;" >"$TMP/$db.ao.log" 2>&1 || ! grep -qF "APPEND-ONLY" "$TMP/$db.ao.log"; then ao=1; fi
  done
  [ "$ao" = "0" ] || cai APPEND_ONLY

  [ "$(q "$db" "SELECT has_table_privilege('authenticated','public.tint_receita_versoes','INSERT')::text
                   || has_table_privilege('authenticated','public.tint_receita_versoes','TRUNCATE')::text
                   || has_table_privilege('anon','public.tint_receita_versoes','SELECT')::text
                   || has_function_privilege('authenticated','public.tint_receita_versoes_capturar()','EXECUTE')::text
                   || has_table_privilege('authenticated','public.tint_receita_versoes','SELECT')::text")" \
    = "falsefalsefalsefalsetrue" ] || cai GRANTS
  [ "$(q "$db" "SELECT count(*) FROM cron.job WHERE jobname = 'tint-receita-versoes-diario' AND schedule = '3 5 * * *' AND active")" = "1" ] || cai CRON

  local antes; antes="$(q "$db" "SELECT count(*) FROM tint_receita_versoes")"
  if ! aplica "$db" "$dir/h1.sql" h1b || [ "$(q "$db" "SELECT count(*) FROM tint_receita_versoes")" != "$antes" ]; then cai REAPLICA; fi

  # ── migration A (lote 1) — e não toca as linhas do lote 2 ──
  local classe_ini; classe_ini="$(classe "$db")"
  if aplica "$db" "$dir/a.sql" a \
     && [ "$(q "$db" "SELECT count(*) FROM tint_receita_versoes WHERE evento = 'staging_arquivado'
                       AND staging_linha->'raw_data' ? 'fonte' AND jsonb_array_length(itens) = 2")" = "7" ] \
     && [ "$(q "$db" "SELECT count(*) FROM tint_staging_formulas WHERE id = ANY ($IDS_A)")" = "0" ] \
     && [ "$(q "$db" "SELECT count(*) FROM tint_staging_formula_itens WHERE staging_formula_id = ANY ($IDS_A)")" = "0" ] \
     && [ "$(q "$db" "SELECT count(*) FROM tint_staging_formulas WHERE id = ANY ($IDS_A2)")" = "7" ]; then :; else cai ARQ; fi
  if ! aplica "$db" "$dir/a.sql" a_bis || [ "$(q "$db" "SELECT count(*) FROM tint_receita_versoes WHERE evento = 'staging_arquivado'")" != "7" ]; then
    cai ARQ_REAPLICA
  fi
  local classe_a1; classe_a1="$(classe "$db")"

  # ── migration A2 (lote 2) ──
  if aplica "$db" "$dir/a2.sql" a2 \
     && [ "$(q "$db" "SELECT count(*) FROM tint_receita_versoes WHERE evento = 'staging_arquivado' AND staging_formula_id = ANY ($IDS_A2)
                       AND (staging_linha->>'id')::uuid = staging_formula_id AND staging_linha->'raw_data' ? 'fonte'
                       AND jsonb_array_length(itens) = 6 AND itens @> '[{\"id_corante\":\"0\"}]'")" = "7" ] \
     && [ "$(q "$db" "SELECT count(*) FROM tint_staging_formulas WHERE id = ANY ($IDS_A2)")" = "0" ] \
     && [ "$(q "$db" "SELECT count(*) FROM tint_staging_formula_itens WHERE staging_formula_id = ANY ($IDS_A2)")" = "0" ]; then :; else cai ARQ2; fi
  if ! aplica "$db" "$dir/a2.sql" a2_bis || [ "$(narq "$db" "$IDS_A2")" != "7" ]; then
    cai ARQ2_REAPLICA
  fi
  # a classe sai de 14 → 7 (lote 1) → 0 (lote 2): a medida não é vazia e cada lote tira só os seus
  [ "$classe_ini:$classe_a1:$(classe "$db")" = "14:7:0" ] || cai CLASSE_ZERADA

  # GUARDA_MD5: corpo vivo diferente → re-aplicar H1 ABORTA
  q "$db" "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_receita_versoes_capturar()'::regprocedure),
           'Uma captura por vez', 'Uma captura por vez (deriva)'); END \$d\$" >/dev/null
  if aplica "$db" "$dir/h1.sql" h1c || ! grep -qF "com outro corpo" "$TMP/$db.h1c.log"; then cai GUARDA_MD5; fi

  # ── guardas da A, num banco à parte (cada aborto deixa o banco intacto) ──
  local g="g_$2"
  fixture_db "$g"
  aplica "$g" "$dir/h1.sql" h1 || cai APPLY_H1_G
  # VOLTOU (banco próprio: sem esta guarda a A aplica de verdade e contaminaria as outras)
  local v="v_$2"
  fixture_db "$v"
  aplica "$v" "$dir/h1.sql" h1 || cai APPLY_H1_G
  q "$v" "UPDATE tint_keys_snapshots SET keys = keys || '[\"4602081|FO10.6554|14|true\"]'::jsonb
           WHERE snapshot_id = '55555555-0000-0000-0000-000000000001' AND chunk_index = 0" >/dev/null
  if aplica "$v" "$dir/a.sql" voltou || ! grep -qF "VOLTOU para a fonte" "$TMP/$v.voltou.log"; then cai ARQ_GUARDA_VOLTOU; fi
  # lote 2: a chave que volta é a de cor com espaço no fim (a chave do conector não apara a cor)
  q "$v" "UPDATE tint_keys_snapshots SET keys = keys || '[\"KL |FO20.6501|19|true\"]'::jsonb
           WHERE snapshot_id = '55555555-0000-0000-0000-000000000001' AND chunk_index = 1" >/dev/null
  if aplica "$v" "$dir/a2.sql" voltou2 || ! grep -qF "VOLTOU para a fonte" "$TMP/$v.voltou2.log"; then cai ARQ2_GUARDA_VOLTOU; fi
  # LATEST: chega linha mais nova da chave do 4602092
  q "$g" "SELECT teste.stg('4602092', '2 days', ARRAY['AX:1:1'], 1, true, 'FO10.6554', '14', 'eeeeeeee-0000-0000-0000-000000000001')" >/dev/null
  if aplica "$g" "$dir/a.sql" latest || ! grep -qF "latest da chave" "$TMP/$g.latest.log"; then cai ARQ_GUARDA_LATEST; fi
  q "$g" "DELETE FROM tint_staging_formulas WHERE id = 'eeeeeeee-0000-0000-0000-000000000001'" >/dev/null
  q "$g" "SELECT teste.stg('MARILIES PALHA', '2 days', ARRAY['AX:1:1'], 1, true, 'FO20.6501', '19', 'eeeeeeee-0000-0000-0000-000000000002')" >/dev/null
  if aplica "$g" "$dir/a2.sql" latest2 || ! grep -qF "latest da chave" "$TMP/$g.latest2.log"; then cai ARQ2_GUARDA_LATEST; fi
  q "$g" "DELETE FROM tint_staging_formulas WHERE id = 'eeeeeeee-0000-0000-0000-000000000002'" >/dev/null
  # TRAVA: uma promoção segura a trava do tick
  PA -q -d "$g" -c "SELECT pg_advisory_lock(hashtext('tint_promocao_tick')); SELECT pg_sleep(6)" >/dev/null 2>&1 &
  local pid=$! i=0
  until [ "$(q "$g" "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")" != "0" ] || [ $i -ge 50 ]; do
    sleep 0.1; i=$((i + 1))
  done
  if aplica "$g" "$dir/a.sql" trava || ! grep -qF "trava do tick ocupada" "$TMP/$g.trava.log"; then cai ARQ_TRAVA; fi
  if aplica "$g" "$dir/a2.sql" trava2 || ! grep -qF "trava do tick ocupada" "$TMP/$g.trava2.log"; then cai ARQ2_TRAVA; fi
  wait "$pid" || true
  # e, sem nenhum dos três, a A e a A2 passam nesse mesmo banco (as guardas abortaram LIMPO)
  if ! aplica "$g" "$dir/a.sql" final || [ "$(narq "$g" "$IDS_A")" != "7" ]; then
    cai ARQ_GUARDAS_LIMPAS
  fi
  if ! aplica "$g" "$dir/a2.sql" final2 || [ "$(narq "$g" "$IDS_A2")" != "7" ]; then
    cai ARQ2_GUARDAS_LIMPAS
  fi

  echo "FIM:${caidos# }"
}

TODOS="MUDANCA ORDEM ESCALA INCOMPLETA RECENTE SAIDA SNAP_PARCIAL COR_NOVA IDEMP VOLTOU APPEND_ONLY GRANTS CRON REAPLICA ARQ ARQ_REAPLICA ARQ2 ARQ2_REAPLICA CLASSE_ZERADA GUARDA_MD5 ARQ_GUARDA_VOLTOU ARQ2_GUARDA_VOLTOU ARQ_GUARDA_LATEST ARQ2_GUARDA_LATEST ARQ_TRAVA ARQ2_TRAVA ARQ_GUARDAS_LIMPAS ARQ2_GUARDAS_LIMPAS"

mkdir -p "$TMP/real"; cp "$MIG_H1" "$TMP/real/h1.sql"; cp "$MIG_A" "$TMP/real/a.sql"; cp "$MIG_A2" "$TMP/real/a2.sql"
PASSOU=0; FALHAS=0
echo "════ CONTROLE — migrations reais ════"
CAIDOS="$(suite "$TMP/real" ctl)" || true
case "$CAIDOS" in FIM:*) CAIDOS="${CAIDOS#FIM:}";; *) echo "  ✗ a suíte do controle morreu sem o marcador FIM: [$CAIDOS]"; exit 1;; esac
case " $CAIDOS " in *" APPLY_H1 "*) echo "  ✗ APPLY_H1: $(head -c 600 "$TMP/s_ctl.h1.log")"; exit 1;; esac
for a in $TODOS; do
  case " $CAIDOS " in *" $a "*) echo "  ✗ $a"; FALHAS=$((FALHAS + 1));; *) echo "  ✓ $a"; PASSOU=$((PASSOU + 1));; esac
done
case " $CAIDOS " in *" APPLY_H1_G "*) echo "  ✗ APPLY_H1_G"; FALHAS=$((FALHAS + 1));; esac

if [ "$FALHAS" -ne 0 ]; then
  echo "PASS=$PASSOU  FAIL=$FALHAS"; echo "RESULTADO: VERMELHO (controle)"; exit 1
fi
if [ "$FALSIFICAR" = "0" ]; then
  echo "PASS=$PASSOU  FAIL=0"; echo "RESULTADO: VERDE"; exit 0
fi

# ── falsificações: UMA camada por vez numa cópia; exige o conjunto EXATO de asserts vermelhos ──
cat > "$TMP/troca.py" <<'PYTROCA'
import sys
src, dst, busca, troca = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
t = open(src).read()
n = t.count(busca)
if n != 1:
    sys.exit(f"busca casou {n} vezes (esperado 1): {busca[:80]!r}")
t = t.replace(busca, troca)
# A cópia sabotada é um arquivo COERENTE: se a troca mexeu no corpo da captura, o md5 da guarda
# anti-reversão acompanha (como faria quem editasse a migration) — senão a REAPLICA cairia por
# artefato da sabotagem, não pela camada sabotada.
import hashlib, re
m = re.search(r"c_captura constant text := '([0-9a-f]{32})'", t)
if m:
    i = t.index('CREATE OR REPLACE FUNCTION public.tint_receita_versoes_capturar()')
    a = t.index('$function$', i) + len('$function$'); b = t.index('$function$', a)
    t = t.replace(m.group(0), m.group(0).replace(m.group(1), hashlib.md5(t[a:b].encode()).hexdigest()))
open(dst, 'w').write(t)
PYTROCA

N=0; SAB_FALHAS=0
sabota() {   # nome  arquivo(h1|a|a2)  busca  troca  esperado
  local nome="$1" alvo="$2" d="$TMP/sab_$1"
  N=$((N + 1)); mkdir -p "$d"; cp "$TMP/real/h1.sql" "$TMP/real/a.sql" "$TMP/real/a2.sql" "$d/"
  if ! python3 "$TMP/troca.py" "$TMP/real/$alvo.sql" "$d/$alvo.sql" "$3" "$4"; then
    echo "  ✗ $nome: sabotagem inválida"; SAB_FALHAS=$((SAB_FALHAS + 1)); return
  fi
  local got; got="$(suite "$d" "f$N")" || true
  case "$got" in FIM:*) got="${got#FIM:}";; *) echo "  ✗ $nome: a suíte morreu sem o marcador FIM"; SAB_FALHAS=$((SAB_FALHAS + 1)); return;; esac
  if [ "$got" = "$5" ]; then echo "  ✓ $nome → vermelho exato: $got"
  else echo "  ✗ $nome → esperado [$5], veio [$got]"; SAB_FALHAS=$((SAB_FALHAS + 1)); fi
}
sabota_post() {   # nome  busca  troca  marca — o apply da H1 tem de ABORTAR com a marca
  local nome="$1" d="$TMP/sab_$1"
  N=$((N + 1)); mkdir -p "$d"
  if ! python3 "$TMP/troca.py" "$TMP/real/h1.sql" "$d/h1.sql" "$2" "$3"; then
    echo "  ✗ $nome: sabotagem inválida"; SAB_FALHAS=$((SAB_FALHAS + 1)); return
  fi
  fixture_db "p$N"
  if aplica "p$N" "$d/h1.sql" h1; then echo "  ✗ $nome: a H1 aplicou"; SAB_FALHAS=$((SAB_FALHAS + 1))
  elif grep -qF "$4" "$TMP/p$N.h1.log" && [ -z "$(q "p$N" "SELECT to_regclass('public.tint_receita_versoes')")" ]; then
    echo "  ✓ $nome → abortou com '$4' e não deixou a tabela"
  else echo "  ✗ $nome: abortou pelo motivo errado: $(head -c 300 "$TMP/p$N.h1.log")"; SAB_FALHAS=$((SAB_FALHAS + 1)); fi
}
sabota_post_a2() {   # nome  busca  troca  marca — a A2 tem de ABORTAR com a marca e não tirar nada do staging
  local nome="$1" d="$TMP/sab_$1"
  N=$((N + 1)); mkdir -p "$d"
  if ! python3 "$TMP/troca.py" "$TMP/real/a2.sql" "$d/a2.sql" "$2" "$3"; then
    echo "  ✗ $nome: sabotagem inválida"; SAB_FALHAS=$((SAB_FALHAS + 1)); return
  fi
  fixture_db "p$N"
  aplica "p$N" "$TMP/real/h1.sql" h1 || { echo "  ✗ $nome: a H1 não aplicou"; SAB_FALHAS=$((SAB_FALHAS + 1)); return; }
  if aplica "p$N" "$d/a2.sql" a2; then echo "  ✗ $nome: a A2 aplicou"; SAB_FALHAS=$((SAB_FALHAS + 1))
  elif grep -qF "$4" "$TMP/p$N.a2.log" && [ "$(q "p$N" "SELECT count(*) FROM tint_staging_formulas WHERE id = ANY ($IDS_A2)")" = "7" ]; then
    echo "  ✓ $nome → abortou com '$4' e o staging ficou intacto"
  else echo "  ✗ $nome: abortou pelo motivo errado: $(head -c 300 "$TMP/p$N.a2.log")"; SAB_FALHAS=$((SAB_FALHAS + 1)); fi
}

echo "════ FALSIFICAÇÕES ════"
sabota HASH_POR_SLOT h1 "ORDER BY i.id_corante, i.qtd_ml), '') AS assinatura" "ORDER BY i.ordem, i.id_corante), '') AS assinatura" "ORDEM"
sabota DOSE_SEM_TRIM h1 "COALESCE(trim_scale(i.qtd_ml)::text, '∅'), ','" "COALESCE(i.qtd_ml::text, '∅'), ','" "ESCALA"
sabota SEM_ITENS_COMPLETOS h1 "     AND (s.expected_item_count IS NULL OR s.expected_item_count = it.n)
     AND NOT EXISTS" "     AND NOT EXISTS" "INCOMPLETA"
sabota SEM_MARGEM h1 "v_ate      timestamptz := now() - interval '15 minutes';" "v_ate      timestamptz := now();" "RECENTE"
sabota SNAP_SEM_CHUNKS h1 "       AND count(DISTINCT k.chunk_index) = max(k.total_chunks)
     ORDER BY k.account" "     ORDER BY k.account" "SNAP_PARCIAL"
sabota SNAP_SEM_STATUS h1 "    HAVING bool_and(k.aplicacao_status = 'aplicado')
       AND count(DISTINCT k.chunk_index) = max(k.total_chunks)
     ORDER BY k.account" "    HAVING count(DISTINCT k.chunk_index) = max(k.total_chunks)
     ORDER BY k.account" "SNAP_PARCIAL"
sabota VOLTA_POR_DIFERENTE h1 "x.hash_ant IS DISTINCT FROM x.receita_hash" "x.hash_ant <> x.receita_hash" "VOLTOU"
sabota HASH_SEM_ITENS h1 "             || '|' || it.assinatura) AS receita_hash" "             ) AS receita_hash" "MUDANCA"
sabota SAIDA_SEM_RELOGIO h1 "       AND u.recebido_em < snap.recebido
" "" "COR_NOVA"
sabota TRIGGER_QUE_DEIXA h1 "  RAISE EXCEPTION 'tint_receita_versoes e APPEND-ONLY: % recusado (historico nao se reescreve)', TG_OP
    USING ERRCODE = 'P0001';" "  RETURN OLD;" "APPEND_ONLY"
sabota GUARDA_MD5_DESLIGADA h1 "IF v_md5 IS NOT NULL AND v_md5 <> c_captura THEN" "IF false THEN" "GUARDA_MD5"
sabota A_SEM_GUARDA_VOLTOU a "THEN 'a chave VOLTOU para a fonte'" "AND false THEN 'a chave VOLTOU para a fonte'" "ARQ_GUARDA_VOLTOU"
sabota A_SEM_GUARDA_LATEST a "THEN 'não é mais a latest da chave'" "AND false THEN 'não é mais a latest da chave'" "ARQ_GUARDA_LATEST"
sabota A_SEM_TRAVA a "IF NOT pg_try_advisory_xact_lock(hashtext('tint_promocao_tick')) THEN" "IF false THEN" "ARQ_TRAVA"
sabota A_SEM_ARQUIVO a "     WHERE s.id = ANY (c_ids)
    ON CONFLICT DO NOTHING;" "     WHERE s.id = ANY (c_ids) AND false
    ON CONFLICT DO NOTHING;" "ARQ ARQ_REAPLICA CLASSE_ZERADA ARQ_GUARDAS_LIMPAS"
sabota A2_SEM_GUARDA_VOLTOU a2 "THEN 'a chave VOLTOU para a fonte'" "AND false THEN 'a chave VOLTOU para a fonte'" "ARQ2_GUARDA_VOLTOU"
sabota A2_SEM_GUARDA_LATEST a2 "THEN 'não é mais a latest da chave'" "AND false THEN 'não é mais a latest da chave'" "ARQ2_GUARDA_LATEST"
sabota A2_SEM_TRAVA a2 "IF NOT pg_try_advisory_xact_lock(hashtext('tint_promocao_tick')) THEN" "IF false THEN" "ARQ2_TRAVA"
sabota A2_SEM_ARQUIVO a2 "     WHERE s.id = ANY (c_ids)
    ON CONFLICT DO NOTHING;" "     WHERE s.id = ANY (c_ids) AND false
    ON CONFLICT DO NOTHING;" "ARQ2 ARQ2_REAPLICA CLASSE_ZERADA ARQ2_GUARDAS_LIMPAS"
sabota A2_COR_SEM_ESPACO a2 "'KL '," "'KL'," "ARQ2 ARQ2_REAPLICA CLASSE_ZERADA ARQ2_GUARDA_VOLTOU ARQ2_GUARDAS_LIMPAS"
sabota_post_a2 A2_POST_P1 "     WHERE s.id = ANY (c_ids)
    ON CONFLICT DO NOTHING;" "     WHERE s.id = ANY (c_ids) AND false
    ON CONFLICT DO NOTHING;" "P1 FALHOU"
sabota_post_a2 A2_POST_P2 "    DELETE FROM tint_staging_formulas s
     WHERE s.id = ANY (c_ids)" "    DELETE FROM tint_staging_formulas s
     WHERE s.id = ANY (c_ids) AND false" "P2 FALHOU"
sabota_post SEM_REVOKE "REVOKE ALL ON public.tint_receita_versoes FROM PUBLIC, anon, authenticated;" "" "P3 FALHOU"
sabota_post SEM_SEMENTE "SELECT public.tint_receita_versoes_capturar();
" "" "P5 FALHOU"
sabota_post SEM_TRIGGER "CREATE TRIGGER trg_tint_receita_versoes_append_only
" "CREATE TRIGGER trg_tint_receita_versoes_append_only_x
" "P2 FALHOU"
sabota_post CRON_ERRADO "  '3 5 * * *',
  \$cron\$" "  '3 6 * * *',
  \$cron\$" "P4 FALHOU"

echo "SABOTAGENS: $N rodadas, $SAB_FALHAS falha(s)"
if [ "$SAB_FALHAS" -ne 0 ]; then echo "RESULTADO: VERMELHO (falsificação)"; exit 1; fi
echo "PASS=$PASSOU  FAIL=0"; echo "RESULTADO: VERDE (controle + $N sabotagens)"

#!/usr/bin/env bash
# PROVA — 20261021203000_tint_purge_staging_fora_do_promote.sql
#
# Custo medido em 2026-10-21 (psql-ro): o bloco PURGE no fim de tint_promote_sync_run varria
# tint_staging_formulas inteira a cada promoção (~1.300/dia) = 98% da leitura de disco do banco.
# A migration move os MESMOS 9 DELETEs para public.tint_staging_purge() (cron diário) e recorta o
# bloco do promote. Esta prova sobe o corpo VIVO do promote (md5 conferido contra prod) e assevera:
#
#   MD5         o promote recortado tem o md5 que a migration declara (= o calculado sobre prod)
#   NAO_PURGA   depois da migration, promover NÃO apaga staging superseded (o custo saiu dali)
#   EQUIV       o catálogo promovido (fórmulas + receitas) é IDÊNTICO ao do promote ANTIGO, que
#               purgava a cada run — a frequência do purge não muda resultado
#   LATEST      a receita promovida é a do staging MAIS RECENTE (o superseded ainda vivo não vence)
#   PURGE_CONTA tint_staging_purge() apaga exatamente o superseded (contagem por tabela)
#   PURGE_PRESERVA o latest-por-chave sobrevive, inclusive com >30d
#   SNAP_POUPA  snapshot de chaves pendente/erro sobrevive; aplicado e status NULL >30d somem
#   ACL         anon/authenticated não executam o purge nem o promote
#   CRON        tint-staging-purge-diario agendado, ativo, chamando o purge
#   TRAVA       o purge espera a advisory lock do tick (não corre junto de uma promoção)
#   IDEMP       re-aplicar é no-op (md5 igual, 1 cron só)
#   GUARDA      re-aplicar sobre um purge de OUTRO corpo (versão posterior) ABORTA em vez de revertê-lo
# Fora da suíte (só controle): DERIVA — corpo vivo diferente do revisado ABORTA e não deixa nada.
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), cada uma com o conjunto EXATO
# de asserts que TEM de cair, depois do controle verde NA MESMA invocação.
#
# Uso: db/test-tint-purge-staging-diario.sh  (PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5453}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-purge.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261021203000_tint_purge_staging_fora_do_promote.sql"
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
MIG_5B1="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
MIG_ASYNC="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
MIG_FANT="$REPO_ROOT/supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql"
MIG_REF="$REPO_ROOT/supabase/migrations/20261013220000_tint_promote_snapshot_ref_por_generated_at.sql"
MD5_PROD='42d09d510b02afdd4167e34ff04b2ce4'   # md5(prosrc) do promote em prod, 2026-10-21 (psql-ro)
export LC_ALL=C LANG=C

for f in "$MIG" "$MIG_V6" "$MIG_5B1" "$MIG_ASYNC" "$MIG_FANT" "$MIG_REF"; do
  [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }
done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── template = o corpo vivo do promote (mesma cadeia da prova do #3051, + o próprio #3051 e ajuste) ──
PA -q -d postgres -c "CREATE DATABASE tpl_purge" >/dev/null
T() { PA -d tpl_purge "$@"; }
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

# pg_cron não existe no PG17 da prova: as tabelas vêm do stub; as duas funções que a migration chama, aqui.
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

VIVO="$(T -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
[ "$VIVO" = "$MD5_PROD" ] || { echo "✗ pré-condição: o template não é o corpo de PROD (md5 $VIVO, prod $MD5_PROD)"; exit 1; }
echo "  · template = corpo de prod (md5 $VIVO)"

# ── cenário: catálogo + 3 runs de fórmula; X é re-enviada (R3 supera R2), Y é latest com >30d ─────
# Linha do tempo: R1 catálogo e R2 fórmulas há 40d; P1 re-enviado e R3 (X nova receita) há 35d; R4 (Z)
# agora — toca o par P1/B1 e reexpande o latest de TODAS as cores. O promote ANTIGO purga R2-X no
# promote do R3/R4; o NOVO não purga — e o catálogo promovido tem de sair igual.
seed() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_test', true);

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao, created_at)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P1','Produto 1', now() - interval '40 days');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao, created_at)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','B1','Base 1', now() - interval '40 days');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml, created_at)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','E900','Galão 900',900, now() - interval '40 days');
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, created_at)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P1','B1','E900', now() - interval '40 days');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000001');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, created_at)
SELECT '22222222-0000-0000-0000-000000000002','oben','L1', c, 'Cor ' || c, 'P1','B1','E900','SL',900,false,1, now() - interval '40 days'
  FROM unnest(ARRAY['X','Y']) c;
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 10 FROM tint_staging_formulas WHERE sync_run_id = '22222222-0000-0000-0000-000000000002';
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000002');

-- P1 re-enviado num catálogo (supera o de R1) e X com receita NOVA (supera a de R2) — ambos há 35d.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao, created_at)
VALUES ('22222222-0000-0000-0000-000000000003','oben','L1','P1','Produto 1', now() - interval '35 days');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, created_at)
VALUES ('22222222-0000-0000-0000-000000000003','oben','L1','X','Cor X','P1','B1','E900','SL',900,false,1, now() - interval '35 days');
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 20 FROM tint_staging_formulas WHERE sync_run_id = '22222222-0000-0000-0000-000000000003';
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000003');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('22222222-0000-0000-0000-000000000004','oben','L1','Z','Cor Z','P1','B1','E900','SL',900,false,1);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 30 FROM tint_staging_formulas WHERE sync_run_id = '22222222-0000-0000-0000-000000000004';
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000004');
SQL
}

# Impressão digital do catálogo PROMOVIDO: fórmula + estado + receita, sem id/timestamps.
impressao() {
  PA -d "$1" -tA -c "SELECT count(*) || '/' || md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) FROM (
    SELECT f.cor_id || ':' || f.nome_cor || ':' || COALESCE(f.volume_final_ml::text, '-') || ':' ||
           COALESCE(f.preco_final_sayersystem::text, '-') || ':' || (f.desativada_em IS NULL)::text || ':' ||
           COALESCE(f.desativada_motivo, '-') || ':' || COALESCE(f.personalizada::text, '-') || ':' ||
           (f.sku_id IS NOT NULL)::text || ':' ||
           COALESCE((SELECT string_agg(i.ordem || '=' || i.qtd_ml, ',' ORDER BY i.ordem)
                       FROM tint_formula_itens i WHERE i.formula_id = f.id), '') AS x
      FROM tint_formulas f) s"
}
q() { PA -d "$1" -tA -c "$2"; }

# ── referência: o promote ANTIGO (sem a migration), que purgava a cada run ─────────────────────────
PA -q -d postgres -c "CREATE DATABASE ref TEMPLATE tpl_purge" >/dev/null
seed ref
IMP_REF="$(impressao ref)"
X_REF="$(q ref "SELECT count(*) FROM tint_staging_formulas WHERE cor_id = 'X'")"
# controle de NÃO-vacuidade: o cenário só prova algo se o promote antigo de fato purgou R2-X.
[ "$X_REF" = "1" ] || { echo "✗ cenário: o promote ANTIGO devia ter purgado o X de R2 (staging X=1), veio $X_REF"; exit 1; }
case "$IMP_REF" in 3/*) ;; *) echo "✗ cenário: esperava 3 fórmulas promovidas na referência, veio $IMP_REF"; exit 1;; esac
echo "  · referência (promote antigo): $IMP_REF, staging X=$X_REF"

TODOS="MD5 NAO_PURGA EQUIV LATEST PURGE_CONTA PURGE_PRESERVA SNAP_POUPA ACL CRON TRAVA IDEMP GUARDA"

# ── a suíte: $1 = arquivo da migration (real ou sabotada), $2 = banco; imprime os asserts que CAÍRAM ──
suite() {
  local mig="$1" db="$2" caidos="" v
  cai() { caidos="$caidos $1"; }
  PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE tpl_purge" >/dev/null
  if ! PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.apply.log" 2>&1; then
    echo "$TODOS"; return
  fi

  v="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  [ "$v" = "$(sed -nE "s/.*c_este constant text := '([0-9a-f]{32})'.*/\1/p" "$MIG")" ] || cai MD5

  seed "$db"
  v="$(q "$db" "SELECT (SELECT count(*) FROM tint_staging_formulas WHERE cor_id = 'X') || '/' ||
                       (SELECT count(*) FROM tint_staging_produtos WHERE cod_produto = 'P1')")"
  [ "$v" = "2/2" ] || cai NAO_PURGA

  [ "$(impressao "$db")" = "$IMP_REF" ] || cai EQUIV
  v="$(q "$db" "SELECT string_agg(trim_scale(i.qtd_ml)::text, ',') FROM tint_formulas f JOIN tint_formula_itens i ON i.formula_id = f.id WHERE f.cor_id = 'X'")"
  [ "$v" = "20" ] || { cai LATEST; echo "    (LATEST: receita de X = [$v])" >&2; }

  # snapshots >30d: pendente, erro e aplicado — inseridos DEPOIS dos promotes (um 'aplicado' antes viraria
  # referência do filtro do #3051 e barraria as cores, que não é o que esta prova mede).
  q "$db" "INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks, chunk_index, keys, created_at, aplicacao_status)
           SELECT 'aaaaaaaa-0000-0000-0000-000000000001','oben','L1', gen_random_uuid(), 'formulas',
                  now() - interval '40 days', 1, 0, '[]'::jsonb, now() - interval '40 days', s
             FROM unnest(ARRAY['pendente','erro','aplicado',NULL]) s" >/dev/null

  v="$(q "$db" "SELECT (r->'apagadas')::text FROM (SELECT public.tint_staging_purge() r) x")"
  [ "$v" = '{"tint_staging_skus": 0, "tint_staging_bases": 0, "tint_keys_snapshots": 2, "tint_staging_corantes": 0, "tint_staging_formulas": 1, "tint_staging_produtos": 1, "tint_staging_embalagens": 0, "tint_staging_precos_base": 0, "tint_staging_formula_itens": 1}' ] \
    || { cai PURGE_CONTA; echo "    (purge devolveu: $v)" >&2; }

  v="$(q "$db" "SELECT (SELECT count(*) FROM tint_staging_formulas WHERE cor_id = 'X') || '|' || (SELECT string_agg(sf.sync_run_id::text || ':' || i.qtd_ml, ',') FROM tint_staging_formulas sf JOIN tint_staging_formula_itens i ON i.staging_formula_id = sf.id WHERE sf.cor_id = 'X')
                || '|' || (SELECT count(*) FROM tint_staging_formulas WHERE cor_id = 'Y')
                || '|' || (SELECT string_agg(sync_run_id::text, ',') FROM tint_staging_produtos WHERE cod_produto = 'P1')")"
  [ "$v" = "1|22222222-0000-0000-0000-000000000003:20|1|22222222-0000-0000-0000-000000000003" ] || cai PURGE_PRESERVA
  v="$(q "$db" "SELECT string_agg(COALESCE(aplicacao_status, 'NULO'), ',' ORDER BY COALESCE(aplicacao_status, 'NULO')) FROM tint_keys_snapshots  -- COALESCE: string_agg PULA NULL (a F6 pegou)")"
  [ "$v" = "erro,pendente" ] || cai SNAP_POUPA

  v="$(q "$db" "SELECT has_function_privilege('anon', 'public.tint_staging_purge()', 'EXECUTE')::text
                    || has_function_privilege('authenticated', 'public.tint_staging_purge()', 'EXECUTE')::text
                    || has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')::text
                    || has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')::text")"
  [ "$v" = "falsefalsefalsefalse" ] || cai ACL

  v="$(q "$db" "SELECT count(*) FROM cron.job WHERE jobname = 'tint-staging-purge-diario' AND active
                  AND schedule = '23 5 * * *' AND command LIKE '%SELECT public.tint_staging_purge();%'")"
  [ "$v" = "1" ] || cai CRON

  # TRAVA: outra sessão segura a lock do tick por 3s; o purge tem de esperar por ela.
  PA -q -d "$db" -c "SELECT pg_advisory_lock(hashtext('tint_promocao_tick')); SELECT pg_sleep(3); SELECT pg_advisory_unlock(hashtext('tint_promocao_tick'));" >/dev/null &
  local seg=$!
  local espera=0
  while [ "$(q "$db" "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")" = "0" ]; do
    espera=$((espera + 1)); [ "$espera" -lt 50 ] || break
    "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -d "$db" -tA -c "SELECT pg_sleep(0.1)" >/dev/null
  done
  # CTE MATERIALIZED: o purge executa ANTES do clock_timestamp(); now() = início do statement.
  v="$(q "$db" "WITH p AS MATERIALIZED (SELECT public.tint_staging_purge() r) SELECT extract(epoch FROM clock_timestamp() - now()) >= 1.5 FROM p")"
  wait "$seg"
  [ "$v" = "t" ] || { cai TRAVA; echo "    (TRAVA: esperou >=1.5s = [$v], laço de espera da lock = $espera)" >&2; }

  local md5_antes cron_antes
  md5_antes="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  if PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.reapply.log" 2>&1; then
    cron_antes="$(q "$db" "SELECT count(*) FROM cron.job WHERE jobname = 'tint-staging-purge-diario'")"
    if [ "$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")" != "$md5_antes" ] \
       || [ "$cron_antes" != "1" ]; then cai IDEMP; fi
  else
    cai IDEMP
  fi
  # GUARDA: uma versão posterior do purge (corpo diferente) — re-aplicar este arquivo tem de ABORTAR.
  q "$db" "DO \$g\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_staging_purge()'::regprocedure),
           'RETURN jsonb_build_object(''ok'', true', 'RETURN jsonb_build_object(''v'', 2, ''ok'', true'); END \$g\$" >/dev/null
  if PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.guarda.log" 2>&1 \
     || ! grep -qF "com outro corpo" "$TMP/$db.guarda.log"; then
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
PA -q -d postgres -c "CREATE DATABASE deriva TEMPLATE tpl_purge" >/dev/null
q deriva "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure),
          'runs órfãos >30min → error.', 'runs órfãos >30min → error. (deriva)'); END \$d\$" >/dev/null
if PA -q -d deriva --single-transaction -f "$MIG" >"$TMP/deriva.log" 2>&1; then
  echo "  ✗ DERIVA: a migration aplicou sobre um corpo vivo que não é o revisado"; FALHAS=$((FALHAS + 1))
elif grep -q "corpo vivo do promote" "$TMP/deriva.log" \
     && [ "$(q deriva "SELECT count(*) FROM pg_proc WHERE proname = 'tint_staging_purge'")" = "0" ]; then
  echo "  ✓ DERIVA: abortou pelo md5 e não deixou o purge criado"; PASSOU=$((PASSOU + 1))
else
  echo "  ✗ DERIVA: abortou pelo motivo errado ou deixou resto: $(head -c 300 "$TMP/deriva.log")"; FALHAS=$((FALHAS + 1))
fi

if [ "$FALHAS" -ne 0 ]; then
  echo "PASS=$PASSOU  FAIL=$FALHAS"; echo "RESULTADO: VERMELHO (controle) — falsificações não rodam sem controle verde"; exit 1
fi

# ── falsificações: sabota UMA camada por vez numa cópia; exige o conjunto EXATO de asserts vermelhos ──
# As trocas chegam pelo stdin como LISTA PYTHON de pares (busca, troca) — sem escape de shell; cada
# busca tem de casar exatamente 1 vez, senão a sabotagem é inválida (não conta como vermelho).
cat > "$TMP/troca.py" <<'PYTROCA'
import sys, ast
src, dst = sys.argv[1], sys.argv[2]
trocas = ast.literal_eval(sys.stdin.read())
t = open(src).read()
for busca, troca in trocas:
    if t.count(busca) != 1:
        sys.exit("ancora casou %dx: %r" % (t.count(busca), busca[:80]))
    t = t.replace(busca, troca)
# a sabotagem é uma migration CONSISTENTE: a guarda declara o md5 do purge que a própria cópia cria
import hashlib, re
ini = t.index("CREATE OR REPLACE FUNCTION public.tint_staging_purge()")
a = t.index("AS $function$", ini) + len("AS $function$"); b = t.index("$function$;", a)
t = re.sub(r"c_purge constant text := '[0-9a-f]{32}'", "c_purge constant text := '%s'" % hashlib.md5(t[a:b].encode()).hexdigest(), t, count=1)
open(dst, "w").write(t)
PYTROCA
FALSIF_ERR=0; FALSIF_OK=0
falsifica() {   # $1=rótulo $2..=asserts que TÊM de cair; stdin = trocas
  local rot="$1"; shift
  local esp="$*" copia caidos
  copia="$TMP/f_$rot.sql"
  if ! python3 "$TMP/troca.py" "$MIG" "$copia"
  then echo "  ✗ $rot: sabotagem NÃO aplicou (âncora) — inválida"; FALSIF_ERR=$((FALSIF_ERR + 1)); return; fi
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
# F1 — o purge esquece as fórmulas (o DELETE vira no-op; os itens ainda saem → cabeçalho órfão).
falsifica F1 PURGE_CONTA PURGE_PRESERVA <<'TROCAS'
[("  DELETE FROM tint_staging_formulas s\n  WHERE s.created_at", "  DELETE FROM tint_staging_formulas s\n  WHERE false AND s.created_at")]
TROCAS
# F2 — o purge apaga também o LATEST (o EXISTS vira verdade incondicional).
falsifica F2 PURGE_CONTA PURGE_PRESERVA <<'TROCAS'
[("        AND (n.created_at, n.id) > (s.created_at, s.id));\n  GET DIAGNOSTICS v_n = ROW_COUNT;\n  v_res := v_res || jsonb_build_object('tint_staging_formulas'",
  "        AND (n.created_at, n.id) > (s.created_at, s.id) OR true);\n  GET DIAGNOSTICS v_n = ROW_COUNT;\n  v_res := v_res || jsonb_build_object('tint_staging_formulas'")]
TROCAS
# F3 — sem a trava do tick E sem a pós-condição que a exige: só a medição de espera denuncia.
falsifica F3 TRAVA <<'TROCAS'
[("  PERFORM pg_advisory_xact_lock(hashtext('tint_promocao_tick'));", "  PERFORM 1;"),
 ("     OR position('pg_advisory_xact_lock(hashtext(''tint_promocao_tick''))' in v_src) = 0 THEN", "     THEN")]
TROCAS
# F3b — sem a trava, pós-condição intacta: a migration ABORTA (camada P2).
MOTIVO="P2 FALHOU" falsifica F3b "$TODOS" <<'TROCAS'
[("  PERFORM pg_advisory_xact_lock(hashtext('tint_promocao_tick'));", "  PERFORM 1;")]
TROCAS
# F4 — o recorte não acontece (EXECUTE pulado) e as checagens PÓS-md5/P1 neutralizadas: o promote segue
# purgando — e aí o purge diário não acha nada para apagar.
falsifica F4 MD5 NAO_PURGA PURGE_CONTA <<'TROCAS'
[("  EXECUTE v_def;", "  NULL;"),
 ("  IF v_md5 <> c_este THEN\n    RAISE EXCEPTION 'purge-diario ABORTADA: pós-recorte", "  IF false THEN\n    RAISE EXCEPTION 'purge-diario ABORTADA: pós-recorte"),
 ("  IF v_src IS NULL OR position('DELETE FROM tint_staging_formulas s' in v_src) > 0", "  IF false AND (v_src IS NULL OR position('DELETE FROM tint_staging_formulas s' in v_src) > 0"),
 ("COALESCE(completed_at, now())' in v_src) = 0 THEN", "COALESCE(completed_at, now())' in v_src) = 0) THEN")]
TROCAS
# F4b — o recorte não acontece, checagens intactas: ABORTA (camada PÓS md5).
MOTIVO="(esperado " falsifica F4b "$TODOS" <<'TROCAS'
[("  EXECUTE v_def;", "  NULL;")]
TROCAS
# F5 — sem o REVOKE do purge: anon/authenticated herdam EXECUTE de PUBLIC → a pós-condição P3 aborta.
MOTIVO="P3 FALHOU" falsifica F5 "$TODOS" <<'TROCAS'
[("REVOKE EXECUTE ON FUNCTION public.tint_staging_purge() FROM PUBLIC, anon, authenticated;", "")]
TROCAS

# F6 — o purge esquece snapshot com status NULL (vira eterno).
falsifica F6 PURGE_CONTA SNAP_POUPA <<'TROCAS'
[("    AND (aplicacao_status IS NULL OR aplicacao_status NOT IN ('pendente', 'erro'));", "    AND (aplicacao_status NOT IN ('pendente', 'erro'));")]
TROCAS
# F7 — a guarda do purge neutralizada: re-aplicar reverte a versão posterior calado.
falsifica F7 GUARDA <<'TROCAS'
[("  IF v_md5 IS NOT NULL AND v_md5 <> c_purge THEN", "  IF false THEN")]
TROCAS

echo "─── controle $PASSOU ok | falsificações certas: $FALSIF_OK | inválidas/erradas: $FALSIF_ERR ───"
echo "PASS=$PASSOU  FAIL=$FALSIF_ERR"
if [ "$FALSIF_ERR" -ne 0 ]; then echo "RESULTADO: VERMELHO"; exit 1; fi
echo "RESULTADO: VERDE — $PASSOU asserts + $FALSIF_OK falsificações com conjunto exato"

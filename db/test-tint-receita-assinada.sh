#!/usr/bin/env bash
# PROVA — 20261104061910_tint_receita_assinada_no_cabecalho.sql
#
# O _pulados do promote passa a comparar a receita pela ASSINATURA do cabeçalho (sha256 da mesma string
# que ele montava dos itens) e só lê tint_formula_itens quando ela é NULL. Esta prova sobe o corpo VIVO
# do promote (cenário da db/test-tint-promote-diff.sh, lido do arquivo dela, + a 20261103093424; md5
# conferido contra prod) e assevera:
#
#   MD5     o promote trocado tem o md5 que a migration declara
#   EQUIV   do MESMO estado, os runs do cenário + o RH dão o MESMO resultado com o promote de hoje e o
#           novo — inclusive QUAIS chaves são puladas em cada run (lidas do _pulados) — e a re-promoção
#           sem run intermediário dá o mesmo preço. O RH isola o hash: a receita da staging de C8 muda no
#           lugar (cabeçalho igual, itens frescos) e só a comparação da receita a separa
#   ASSINA  o promote assina (≥ 10 fórmulas do par P1 depois do cenário) e, depois de todos os runs
#           (cenário, desvio, BIG), nenhuma assinatura não-nula difere da recalculada dos itens (sha256 e
#           receita_desde); os ataques seguintes julgam cada um as suas fórmulas
#   LEITURA par de 4.000 fórmulas: o 1º run assina as 4.000 (8 reescritas + 3.992 puladas); no reenvio
#           idêntico seguinte o promote faz ≤ 100 varreduras em tint_formula_itens (o de hoje: ≥ 3.000)
#   CONC_A  item escrito ANTES (transação aberta) e assinador depois: o assinador ESPERA e assina a
#           receita nova
#   CONC_B  assinador ANTES (transação aberta) e DELETE de item depois: a invalidação ESPERA e zera
#   RR      assinador em REPEATABLE READ com snapshot anterior a um item commitado: não assina velho
#   FORJA   valor do chamador nunca vale: hash forjado (postgres e service_role), receita_desde
#           isolada, INSERT com assinatura (→ NULL) e upsert com id proposto ≠ alvo
#   ITEM    created_at NULL num item invalida (reassinada: receita_desde -infinity); item movido entre
#           duas fórmulas assinadas invalida as duas
#   TEMP    pg_temp.tint_formula_itens / pg_temp.tint_formulas na sessão não desviam assinar/invalidar
#   TOMB    tombstone da Fase 5: carimbar zera, pedir assinatura não erra nem assina, item não erra
#   PRIV    service_role sem TRIGGER (CREATE TRIGGER negado) e a escrita de item dele ainda invalida
#   BULK    TRUNCATE dos itens zera tudo; COPY de item zera a fórmula
#   ACL     anon/authenticated não executam o promote nem as funções da assinatura
#   IDEMP   re-aplicar é no-op (md5 igual)
#   GUARDA  re-aplicar sobre um promote de OUTRO corpo (versão posterior) ABORTA
# Fora da suíte (controles): DERIVA — corpo vivo diferente do revisado ABORTA e não troca nada;
# TETO — com o teto 6 e 8 reescritas, as reescritas levam só a metade (3), as puladas as outras 3, e o
# run seguinte avança.
# Controles de não-vacuidade: o promote de hoje exibe os casos de borda (cenário), lê ≥ 3.000 vezes os
# itens no reenvio do par BIG e service_role TEM o privilégio TRIGGER antes da migration.
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), cada uma com o conjunto EXATO de
# asserts que TEM de cair, depois do controle verde NA MESMA invocação.
#
# Uso: db/test-tint-receita-assinada.sh   (PGPORT_TEST=<porta>; LOCALE_TESTE=pt_BR.UTF-8 roda no 2º idioma)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5458}}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-assin.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261104061910_tint_receita_assinada_no_cabecalho.sql"
MIG_DIFF="$REPO_ROOT/supabase/migrations/20261103093424_tint_promote_escreve_so_o_que_mudou.sql"
CENARIO="$REPO_ROOT/db/test-tint-promote-diff.sh"
# a cadeia que o cenário aplica (variáveis que ele lê)
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
MIG_5B1="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
MIG_ASYNC="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
MIG_FANT="$REPO_ROOT/supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql"
MIG_REF="$REPO_ROOT/supabase/migrations/20261013220000_tint_promote_snapshot_ref_por_generated_at.sql"
MIG_PURGE="$REPO_ROOT/supabase/migrations/20261021203000_tint_purge_staging_fora_do_promote.sql"
MIG_LATEST="$REPO_ROOT/supabase/migrations/20261030071806_tint_promote_latest_por_chave_indexado.sql"
# shellcheck disable=SC2034  # lido pelo cenário carregado com `.` abaixo
MD5_PROD='954a96411be99c18ab4bff40df14e620'   # o que a cadeia do cenário reproduz (predecessor do diff)
MD5_VIVO='2c6f461f9c9d4f8c54ea817e25f88f61'   # md5(prosrc) do promote em prod, 2026-11-04 (psql-ro)

for f in "$MIG" "$MIG_DIFF" "$CENARIO" "$MIG_V6" "$MIG_5B1" "$MIG_ASYNC" "$MIG_FANT" "$MIG_REF" "$MIG_PURGE" "$MIG_LATEST"; do
  [ -f "$f" ] || { echo "arquivo ausente: $f"; exit 1; }
done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
# autovacuum desligado: os contadores de pg_stat são a medida da LEITURA — nada além da promoção lê.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }
q() { PA -d "$1" -tA -c "$2"; }
echo "  · locale do cluster: $(q postgres "SELECT datcollate FROM pg_database WHERE datname = 'postgres'")"

# ── cenário: template, helpers, massa BIG, seed/desvio/run BIG — o MESMO da prova do diff, lido do
#    arquivo dela (um só cenário para as duas provas; marcadores conferidos, fail-closed). ─────────────
INI='# ── template = o corpo vivo do promote'
FIM='# ── referência: o promote ANTIGO, do MESMO template'
[ "$(grep -c "^$INI" "$CENARIO")" = 1 ] && [ "$(grep -c "^$FIM" "$CENARIO")" = 1 ] \
  || { echo "✗ pré-condição: os marcadores do cenário sumiram de $CENARIO"; exit 1; }
sed -n "/^$INI/,/^$FIM/p" "$CENARIO" > "$TMP/cenario.sh"
# shellcheck source=/dev/null
. "$TMP/cenario.sh"
for fn in T seed seed_desvio seed_big_run escritas; do
  [ "$(type -t "$fn")" = "function" ] || { echo "✗ pré-condição: o cenário não definiu $fn"; exit 1; }
done

# o corpo de PROD hoje = a cadeia + o diff
T -q --single-transaction -f "$MIG_DIFF" >/dev/null 2>&1
VIVO="$(T -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
[ "$VIVO" = "$MD5_VIVO" ] || { echo "✗ pré-condição: o template não é o corpo de PROD (md5 $VIVO, prod $MD5_VIVO)"; exit 1; }
echo "  · template = corpo de prod (md5 $VIVO)"

# ACL de prod nas 2 tabelas (o dump sai sem privilégios): service_role com tudo (inclusive TRIGGER) e
# BYPASSRLS, sandbox_exec só INSERT+SELECT, authenticated só SELECT.
T -q <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE sandbox_exec; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO service_role, sandbox_exec, authenticated;
GRANT ALL ON public.tint_formulas, public.tint_formula_itens TO service_role;
GRANT SELECT, INSERT ON public.tint_formulas, public.tint_formula_itens TO sandbox_exec;
GRANT SELECT ON public.tint_formulas, public.tint_formula_itens TO authenticated;
GRANT SELECT ON public.tint_produtos, public.tint_embalagens TO service_role;
-- id de fórmula por chave natural (massa BIG)
CREATE FUNCTION _fid(p_cor text, p_prod text, p_emb text) RETURNS uuid LANGUAGE sql AS $$
  SELECT f.id FROM tint_formulas f JOIN tint_produtos p ON p.id = f.produto_id
    JOIN tint_embalagens e ON e.id = f.embalagem_id
   WHERE f.cor_id = p_cor AND p.cod_produto = p_prod AND e.id_embalagem_sayersystem = p_emb $$;
CREATE FUNCTION _neutro() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
-- (Codex P2-2) a foto de cada run leva QUAIS chaves foram puladas (o _pulados do promote ainda existe
-- na transação do _promove), não só quantas.
CREATE OR REPLACE FUNCTION _promove(p_rot text, p_run uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb; k text := '-';
BEGIN
  v := public.tint_promote_sync_run(p_run);
  IF to_regclass('pg_temp._pulados') IS NOT NULL THEN
    EXECUTE $q$SELECT COALESCE(string_agg(f.cor_id || '/' || e.id_embalagem_sayersystem, ','
                                          ORDER BY f.cor_id || '/' || e.id_embalagem_sayersystem COLLATE "C"), '')
                 FROM pg_temp._pulados pu JOIN tint_formulas f ON f.id = pu.formula_id
                 JOIN tint_embalagens e ON e.id = f.embalagem_id$q$ INTO k;
  END IF;
  INSERT INTO _res VALUES (p_rot, p_run, v, _estado() || ' pul=' || k);
  RETURN v;
END $$;
SQL

# Reenvio IDÊNTICO de K0003 em KP0 (o par de 4.000 fórmulas): a staging nova reescreve só K0003.
seed_big_run2() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
SELECT _run('b0000000-0000-0000-0000-000000000004', 'formulas', 'BIG');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base,
       id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('b0000000-0000-0000-0000-000000000004','oben','BIG','K0003','Cor 3','KP0','KB0','KE0',NULL,900,false,4);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sf.sync_run_id, sf.id, v.c, v.o, v.q + (substr(sf.cor_id, 2)::int % 7)
  FROM tint_staging_formulas sf,
       (VALUES ('KC0', 1, 0.5), ('KC0', 4, 2.25), ('KC1', 2, 1.125), ('KC2', 3, 3.0)) v(c, o, q)
 WHERE sf.sync_run_id = 'b0000000-0000-0000-0000-000000000004';
SQL
}

# RH (Codex P2-2): a receita da staging VENCEDORA de C8 muda no lugar (a staging continua mais velha que
# o oficial: cabeçalho igual, itens frescos) e um reenvio de C3 reexpande o par. Só a comparação da
# receita separa C8 — pelos itens no promote de hoje, pelo hash da assinatura no novo.
seed_hash() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
UPDATE tint_staging_formula_itens si SET qtd_ml = si.qtd_ml + 1
  FROM tint_staging_formulas sf
 WHERE si.staging_formula_id = sf.id AND sf.cor_id = 'C8' AND si.id_corante = 'AX'
   AND sf.sync_run_id = '11111111-0000-0000-0000-000000000004';
SELECT _run('11111111-0000-0000-0000-000000000017', 'formulas');
SELECT _sf('11111111-0000-0000-0000-000000000017','C3','Cor 3','P1','B1',NULL,false,'[["AY",1,"2"],["AY",3,"3"]]');
SELECT _promove('RH', '11111111-0000-0000-0000-000000000017');
SQL
}

# Impressão do resultado (L1): a da prova do diff, agora COM formulas_identicas_puladas (a decisão de
# pular é o que a assinatura muda) e sem o receitas_assinadas (o promote de hoje não tem).
impressao() {
  PA -d "$1" -tA -c "SELECT md5(string_agg(x, E'\n' ORDER BY x)) || ' ' || count(*) FROM (
    SELECT 'F|final|' || _estado() AS x
    UNION ALL SELECT 'S|' || rot || '|' || estado FROM _res
    UNION ALL SELECT 'C|' || id_corante_sayersystem || '|' || descricao || '|' || volume_total_ml || '|' || COALESCE(preco_litro::text, '-')
      FROM tint_corantes WHERE id_corante_sayersystem IN ('AX', 'AY', 'AZ')
    UNION ALL SELECT 'E|' || id_embalagem_sayersystem || '|' || volume_ml FROM tint_embalagens WHERE id_embalagem_sayersystem LIKE 'E%'
    UNION ALL SELECT 'R|' || rot || '|' || (r - 'importacao_id' - 'receitas_assinadas')::text FROM _res
    UNION ALL SELECT 'M|' || rs.rot || '|' || (tr.metadata - 'receitas_assinadas')::text || '|' || tr.inserts || '|' || tr.errors
      FROM _res rs JOIN tint_sync_runs tr ON tr.id = rs.run
    UNION ALL SELECT 'X|' || rs.rot || '|' || e.entity_id || '|' || e.error_message
      FROM _res rs JOIN tint_sync_errors e ON e.sync_run_id = rs.run
    UNION ALL SELECT 'I|' || rs.rot || '|' || i.status || '|' || i.registros_importados || '|' || i.registros_erro
      FROM _res rs JOIN tint_importacoes i ON i.id = (rs.r->>'importacao_id')::uuid) s"
}

# Varreduras de tint_formula_itens (idx + seq) por UMA promoção, em sessão própria (o backend descarrega
# as estatísticas ao sair). Imprime "<varreduras> <ok> <assinadas> <puladas>" ou FALHOU.
leituras() {   # $1 = banco, $2 = run
  local antes depois r
  local sql="SELECT COALESCE(idx_scan, 0) + seq_scan FROM pg_stat_user_tables WHERE relname = 'tint_formula_itens'"
  antes="$(q "$1" "$sql")" || { echo FALHOU; return; }
  r="$(PA -q -tA -d "$1" -c "SELECT (x->>'ok') || ' ' || COALESCE(x->>'receitas_assinadas', '-') || ' ' || (x->>'formulas_identicas_puladas')
                                 FROM (SELECT tint_promote_sync_run('$2') AS x) s" 2>&1)" \
    || { echo "    (promoção $2 em $1 falhou: $r)" >&2; echo FALHOU; return; }
  sleep 1
  depois="$(q "$1" "$sql")" || { echo FALHOU; return; }
  echo "$((depois - antes)) $r"
}

# Espera uma sessão chegar no pg_sleep marcado (prova POSITIVA de que ela está com a transação aberta).
espera_sleep() {   # $1 = banco, $2 = duração marcadora (ex. 3.01)
  local _
  for _ in $(seq 1 100); do
    [ "$(q "$1" "SELECT count(*) FROM pg_stat_activity
                  WHERE wait_event = 'PgSleep' AND query LIKE '%pg_sleep($2)%' AND pid <> pg_backend_pid()")" -ge 1 ] && return 0
    sleep 0.1
  done
  return 1
}
# Duas sessões: a 1ª abre transação, roda $2 e dorme 3 s; a 2ª roda $3 enquanto isso. Imprime "esperou"
# se a 2ª ficou presa num lock (prova de que a ordem foi a pretendida), senão o que deu errado.
duas_sessoes() {   # $1 = banco, $2 = SQL da 1ª, $3 = SQL da 2ª
  local p1 p2 res=nao_esperou _
  PA -q -d "$1" -c "BEGIN" -c "$2" -c "SELECT pg_sleep(3.01)" -c "COMMIT" >"$TMP/$1.s1.log" 2>&1 &
  p1=$!
  if ! espera_sleep "$1" 3.01; then wait "$p1" || true; echo "sem_sleep"; return; fi
  PA -q -d "$1" -c "$3" >"$TMP/$1.s2.log" 2>&1 &
  p2=$!
  for _ in $(seq 1 25); do
    if [ "$(q "$1" "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()")" -ge 1 ]; then
      res=esperou; break
    fi
    sleep 0.1
  done
  wait "$p1" || res="falhou_1a"
  wait "$p2" || res="falhou_2a"
  echo "$res"
}

# ── referência: o promote de HOJE, do MESMO template ─────────────────────────────────────────────────
PA -q -d postgres -c "CREATE DATABASE ref TEMPLATE tpl_diff" >/dev/null
seed ref
seed_hash ref
IMP_REF="$(impressao ref)"
v="$(q ref "SELECT string_agg(x, ';' ORDER BY x COLLATE \"C\") FROM (
  SELECT 'C1nome=' || min(nome_cor) x FROM tint_formulas WHERE cor_id = 'C1'
  UNION ALL SELECT 'C3ordem=' || string_agg(DISTINCT i.ordem::text, ',') FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id WHERE f.cor_id = 'C3'
  UNION ALL SELECT 'R10C1=' || count(*) FROM tint_formula_itens i JOIN tint_formulas f ON f.id = i.formula_id
     WHERE f.cor_id = 'C1' AND i.qtd_ml::text NOT LIKE '%.%'
  UNION ALL SELECT 'R3pul=' || (r->>'formulas_identicas_puladas') FROM _res WHERE rot = 'R3'
  UNION ALL SELECT 'R11pul=' || (r->>'formulas_identicas_puladas') FROM _res WHERE rot = 'R11'
  UNION ALL SELECT 'R3chaves=' || (length(split_part(estado, ' pul=', 2)) - length(replace(split_part(estado, ' pul=', 2), ',', '')) + 1)
              FROM _res WHERE rot = 'R3'
  UNION ALL SELECT 'RHpulaC8=' || (position('C8/' in split_part(estado, ' pul=', 2)) > 0)
                   || '/C3=' || (position('C3/' in split_part(estado, ' pul=', 2)) > 0)
                   || '/outras=' || (split_part(estado, ' pul=', 2) <> '')
              FROM _res WHERE rot = 'RH') s")"
ESPERADO_REF='C1nome=Cor 1 nova;C3ordem=3;R10C1=0;R11pul=14;R3chaves=14;R3pul=14;RHpulaC8=false/C3=false/outras=true'
[ "$v" = "$ESPERADO_REF" ] || { echo "✗ cenário: a referência não exibe os casos de borda: [$v] ≠ [$ESPERADO_REF]"; exit 1; }
REF_DESVIO="$(seed_desvio ref)"
echo "  · referência (promote de hoje): $IMP_REF — $v — desvio $REF_DESVIO"

seed_big_run ref
r="$(leituras ref b0000000-0000-0000-0000-000000000003)"
seed_big_run2 ref
REF_LEIT="$(leituras ref b0000000-0000-0000-0000-000000000004)"
[[ "$REF_LEIT" =~ ^([0-9]+)\ true\ -\ 3996$ ]] && [ "${BASH_REMATCH[1]}" -ge 3000 ] \
  || { echo "✗ controle: o promote de HOJE devia varrer os itens ≥ 3.000 vezes no reenvio (veio [$REF_LEIT], 1º run [$r])"; exit 1; }
echo "  · promote de hoje: reenvio idêntico no par BIG = ${REF_LEIT%% *} varreduras de tint_formula_itens"
[ "$(q ref "SELECT has_table_privilege('service_role', 'public.tint_formulas', 'TRIGGER')
            AND has_table_privilege('service_role', 'public.tint_formula_itens', 'TRIGGER')")" = "t" ] \
  || { echo "✗ controle: service_role devia ter TRIGGER antes da migration (como em prod)"; exit 1; }

TODOS="MD5 EQUIV ASSINA LEITURA CONC_A CONC_B RR FORJA ITEM TEMP TOMB PRIV BULK ACL IDEMP GUARDA"
C_ESTE_REAL="$(sed -nE "s/.*c_este constant text := '([0-9a-f]{32})'.*/\1/p" "$MIG")"

# Helpers que leem as colunas novas (só existem depois da migration).
helpers_suite() {   # $1 = banco
  PA -q -d "$1" <<'SQL' >/dev/null
-- Oráculo: a assinatura recalculada dos itens, pela string do _pulados de hoje.
CREATE FUNCTION _inconsistentes(p_ids uuid[] DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM tint_formulas f
   CROSS JOIN LATERAL (
     SELECT sha256(convert_to(COALESCE(string_agg(fi.corante_id::text || '|' || fi.ordem::text || '|' || fi.qtd_ml::text, ','
                                                  ORDER BY fi.corante_id), ''), 'UTF8')) AS s,
            CASE WHEN count(*) = 0 THEN NULL
                 WHEN bool_or(fi.created_at IS NULL) THEN '-infinity'::timestamptz
                 ELSE min(fi.created_at) END AS d
       FROM tint_formula_itens fi WHERE fi.formula_id = f.id) x
   WHERE f.receita_assinatura IS NOT NULL
     AND (p_ids IS NULL OR f.id = ANY (p_ids))
     AND (f.receita_assinatura <> x.s OR f.receita_desde IS DISTINCT FROM x.d) $$;
CREATE FUNCTION _assinada(p_id uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT receita_assinatura IS NOT NULL FROM tint_formulas WHERE id = p_id $$;
CREATE FUNCTION _tenta_trigger() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  CREATE TRIGGER zz_forja BEFORE UPDATE ON public.tint_formulas FOR EACH ROW EXECUTE FUNCTION public._neutro();
  RETURN 'CRIOU';
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 'NEGADO';
END $$;
SQL
}

# ── a suíte: $1 = arquivo da migration (real ou sabotada), $2 = banco; imprime os asserts que CAÍRAM ──
suite() {
  local mig="$1" db="$2" caidos="" v w X Y Z
  cai() { caidos="$caidos $1"; }
  PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE tpl_diff" >/dev/null
  if ! PA -q -d "$db" --single-transaction -f "$mig" >"$TMP/$db.apply.log" 2>&1; then
    echo "    ($db: a migration abortou: $(grep -m1 -E 'ERRO|ERROR' "$TMP/$db.apply.log" | head -c 300))" >&2
    echo "$TODOS"; return
  fi
  helpers_suite "$db"

  v="$(q "$db" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")"
  [ "$v" = "$C_ESTE_REAL" ] || cai MD5

  # EQUIV: o cenário inteiro (estado por run, retorno, metadata, puladas) + a re-promoção sem intermediário.
  # (o RH só isola o hash se C8 chega a ele ASSINADA — senão compara pelos itens, como o de hoje)
  local c8
  if seed "$db" 2>"$TMP/$db.seed.log" \
     && c8="$(q "$db" "SELECT bool_and(receita_assinatura IS NOT NULL) FROM tint_formulas WHERE cor_id = 'C8'")" \
     && [ "$c8" = "t" ] && seed_hash "$db" && [ "$(impressao "$db")" = "$IMP_REF" ] \
     && [ "$(seed_desvio "$db")" = "$REF_DESVIO" ]; then :; else cai EQUIV; echo "    (EQUIV: C8 assinada antes do RH [${c8:-?}])" >&2; fi

  # ASSINA (1/2): o promote assinou o par P1 e tudo o que assinou bate com os itens.
  v="$(q "$db" "SELECT count(*) FILTER (WHERE f.receita_assinatura IS NOT NULL) || '/' || _inconsistentes()
                  FROM tint_formulas f JOIN tint_produtos p ON p.id = f.produto_id WHERE p.cod_produto = 'P1'")"
  local assina_ok=1
  [[ "$v" =~ ^([0-9]+)/0$ ]] && [ "${BASH_REMATCH[1]}" -ge 10 ] || { assina_ok=0; echo "    (ASSINA: P1 assinadas/inconsistentes = [$v])" >&2; }

  # LEITURA: o 1º run do par BIG assina as 4.000; o reenvio seguinte quase não varre itens.
  seed_big_run "$db"
  v="$(leituras "$db" b0000000-0000-0000-0000-000000000003)"
  seed_big_run2 "$db"
  w="$(leituras "$db" b0000000-0000-0000-0000-000000000004)"
  local fresca
  fresca="$(q "$db" "SELECT bool_and(i.created_at > (SELECT max(created_at) FROM tint_staging_formulas WHERE cor_id = 'K0003'))
                       FROM tint_formula_itens i WHERE i.formula_id = _fid('K0003', 'KP0', 'KE0')")"
  if [[ "$v" =~ \ true\ 4000\ 3992$ ]] && [[ "$w" =~ ^([0-9]+)\ true\ 4\ 3996$ ]] && [ "${BASH_REMATCH[1]}" -le 100 ] \
     && [ "$fresca" = "t" ]; then :; else
    cai LEITURA; echo "    (LEITURA: 1º run [$v], reenvio [$w], K0003 fresca [$fresca])" >&2
  fi
  echo "    · $db: reenvio no par BIG = ${w%% *} varreduras de itens (hoje ${REF_LEIT%% *})" >&2

  # ASSINA (2/2): depois de todos os runs (cenário, desvio, BIG), nenhuma assinatura difere dos itens.
  # Antes dos ataques abaixo: cada um julga as suas fórmulas.
  v="$(q "$db" "SELECT _inconsistentes() || '/' || count(*) FILTER (WHERE receita_assinatura IS NOT NULL) FROM tint_formulas")"
  [ "$assina_ok" = 1 ] && [[ "$v" =~ ^0/[0-9]+$ ]] || { cai ASSINA; echo "    (ASSINA: inconsistentes/assinadas depois dos runs [$v])" >&2; }

  # CONC_A: item escrito antes, transação aberta; o pedido de assinatura (NULL inicial) espera e assina o novo.
  X="$(q "$db" "SELECT _fid('K0101', 'KP1', 'KE0')")"
  v="$(duas_sessoes "$db" "UPDATE tint_formula_itens SET qtd_ml = qtd_ml + 1 WHERE formula_id = '$X' AND ordem = 3" \
                          "UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$X'")"
  w="$(q "$db" "SELECT _assinada('$X') || '/' || _inconsistentes(ARRAY['$X'::uuid])")"
  [ "$v" = "esperou" ] && [ "$w" = "true/0" ] || { cai CONC_A; echo "    (CONC_A: [$v], assinada/inconsistente [$w])" >&2; }

  # CONC_B: assinador antes, transação aberta; o DELETE de item espera e zera.
  Y="$(q "$db" "SELECT _fid('K0102', 'KP1', 'KE0')")"
  v="$(duas_sessoes "$db" "UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$Y'" \
                          "DELETE FROM tint_formula_itens WHERE formula_id = '$Y' AND ordem = 3")"
  w="$(q "$db" "SELECT _assinada('$Y') || '/' || _inconsistentes(ARRAY['$Y'::uuid])")"
  [ "$v" = "esperou" ] && [ "$w" = "false/0" ] || { cai CONC_B; echo "    (CONC_B: [$v], assinada/inconsistente [$w])" >&2; }

  # RR: snapshot tirado ANTES de um item commitado; o pedido de assinatura depois não pode assinar o velho.
  Z="$(q "$db" "SELECT _fid('K0103', 'KP1', 'KE0')")"
  PA -q -d "$db" -c "BEGIN ISOLATION LEVEL REPEATABLE READ" \
     -c "SELECT count(*) FROM tint_formula_itens WHERE formula_id = '$Z'" -c "SELECT pg_sleep(2.02)" \
     -c "UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$Z'" -c "COMMIT" >"$TMP/$db.rr.log" 2>&1 &
  local prr=$! rr_ok=1
  espera_sleep "$db" 2.02 || rr_ok=0
  q "$db" "UPDATE tint_formula_itens SET qtd_ml = qtd_ml + 1 WHERE formula_id = '$Z' AND ordem = 3" >/dev/null || rr_ok=0
  wait "$prr" || rr_ok=0
  w="$(q "$db" "SELECT _inconsistentes(ARRAY['$Z'::uuid])")"
  [ "$rr_ok" = 1 ] && [ "$w" = "0" ] || { cai RR; echo "    (RR: sessão ok=$rr_ok, inconsistente [$w]: $(head -c 200 "$TMP/$db.rr.log"))" >&2; }

  # FORJA: o valor do chamador nunca vale.
  v="$(PA -q -tA -d "$db" 2>&1 <<SQL
\set ON_ERROR_STOP 1
UPDATE tint_formulas SET receita_assinatura = sha256('forjada'::bytea), receita_desde = 'infinity'
 WHERE id = _fid('K0201', 'KP2', 'KE0');
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = _fid('K0202', 'KP2', 'KE0');
UPDATE tint_formulas SET receita_desde = 'infinity' WHERE id = _fid('K0202', 'KP2', 'KE0');
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = _fid('K0203', 'KP2', 'KE0');
UPDATE tint_formulas SET receita_assinatura = sha256('outra'::bytea) WHERE id = _fid('K0203', 'KP2', 'KE0');
INSERT INTO tint_formulas (account, cor_id, nome_cor, produto_id, base_id, embalagem_id, volume_final_ml,
                           personalizada, receita_assinatura, receita_desde)
SELECT account, 'KFORJA', nome_cor, produto_id, base_id, embalagem_id, volume_final_ml, personalizada,
       sha256('x'::bytea), now()
  FROM tint_formulas WHERE id = _fid('K0204', 'KP2', 'KE0');
INSERT INTO tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id,
                           volume_final_ml, personalizada, receita_assinatura)
SELECT gen_random_uuid(), account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id,
       volume_final_ml, personalizada, sha256('u'::bytea)
  FROM tint_formulas WHERE id = _fid('K0205', 'KP2', 'KE0')
ON CONFLICT (account, cor_id, produto_id, base_id, COALESCE(subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid), embalagem_id)
DO UPDATE SET receita_assinatura = sha256('u2'::bytea);
SET ROLE service_role;
UPDATE public.tint_formulas SET receita_assinatura = sha256('sr'::bytea) WHERE id = _fid('K0206', 'KP2', 'KE0');
RESET ROLE;
SELECT _assinada(_fid('K0201', 'KP2', 'KE0')) AND _assinada(_fid('K0202', 'KP2', 'KE0'))
   AND _assinada(_fid('K0203', 'KP2', 'KE0')) AND _assinada(_fid('K0205', 'KP2', 'KE0'))
   AND _assinada(_fid('K0206', 'KP2', 'KE0'))
   AND (SELECT receita_assinatura IS NULL AND receita_desde IS NULL FROM tint_formulas WHERE cor_id = 'KFORJA')
   AND _inconsistentes(ARRAY[_fid('K0201', 'KP2', 'KE0'), _fid('K0202', 'KP2', 'KE0'), _fid('K0203', 'KP2', 'KE0'),
                             _fid('K0205', 'KP2', 'KE0'), _fid('K0206', 'KP2', 'KE0')]) = 0;
SQL
)" || true
  [ "$v" = "t" ] || { cai FORJA; echo "    (FORJA: [$(echo "$v" | head -c 300)])" >&2; }

  # ITEM (Codex P2-2): created_at NULL num item de fórmula assinada invalida, e a reassinatura dá
  # receita_desde -infinity (nunca fresca); item MOVIDO entre duas fórmulas assinadas invalida as duas.
  X="$(q "$db" "SELECT _fid('K0401', 'KP4', 'KE0')")"
  Y="$(q "$db" "SELECT _fid('K0402', 'KP4', 'KE0')")"
  v="$(PA -q -tA -d "$db" 2>&1 <<SQL
\set ON_ERROR_STOP 1
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id IN ('$X', '$Y');
UPDATE tint_formula_itens SET created_at = NULL WHERE formula_id = '$X' AND ordem = 3;
SELECT 'nulo=' || _assinada('$X');
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$X';
SELECT 'desde=' || receita_desde || '/' || _inconsistentes(ARRAY['$X'::uuid]) FROM tint_formulas WHERE id = '$X';
DELETE FROM tint_formula_itens WHERE formula_id = '$Y' AND ordem = 3;
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$Y';
SELECT 'antes=' || _assinada('$X') || '/' || _assinada('$Y');
UPDATE tint_formula_itens SET formula_id = '$Y' WHERE formula_id = '$X' AND ordem = 3;
SELECT 'movido=' || _assinada('$X') || '/' || _assinada('$Y');
SQL
)" || true
  [ "$(echo "$v" | tr '\n' ' ')" = "nulo=false desde=-infinity/0 antes=true/true movido=false/false " ] \
    || { cai ITEM; echo "    (ITEM: [$(echo "$v" | tr '\n' ' ' | head -c 300)])" >&2; }

  # TEMP: tabelas homônimas em pg_temp na sessão não desviam o assinador nem a invalidação.
  # (ids resolvidos ANTES, noutra sessão: na sessão sombreada até o helper _fid leria a tabela temporária)
  X="$(q "$db" "SELECT _fid('K0301', 'KP3', 'KE0')")"
  Y="$(q "$db" "SELECT _fid('K0302', 'KP3', 'KE0')")"
  q "$db" "UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$Y'" >/dev/null
  v="$(PA -q -tA -d "$db" 2>&1 <<SQL
\set ON_ERROR_STOP 1
CREATE TEMP TABLE tint_formula_itens (LIKE public.tint_formula_itens);
CREATE TEMP TABLE tint_formulas (LIKE public.tint_formulas);
INSERT INTO tint_formulas SELECT * FROM public.tint_formulas WHERE id = '$Y';
UPDATE public.tint_formulas SET receita_assinatura = ''::bytea WHERE id = '$X';
UPDATE public.tint_formula_itens SET qtd_ml = qtd_ml + 1 WHERE formula_id = '$Y' AND ordem = 3;
SELECT 'sombra=' || count(*) FROM tint_formulas WHERE receita_assinatura IS NOT NULL;
SQL
)" || true
  w="$(q "$db" "SELECT _assinada('$X') || '/' || _inconsistentes(ARRAY['$X'::uuid]) || '/' || _assinada('$Y')")"
  [ "$v" = "sombra=1" ] || w="$w (sessão sombreada: $v)"
  [ "$w" = "true/0/false" ] || { cai TEMP; echo "    (TEMP: assinada/inconsistente/invalidada [$w] $(echo "$v" | head -c 200))" >&2; }

  # TOMB: carimbar o tombstone zera; pedir assinatura nele não erra nem assina; escrever item dele não erra.
  v="$(PA -q -tA -d "$db" 2>&1 <<'SQL'
\set ON_ERROR_STOP 1
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = _fid('K0303', 'KP3', 'KE0');
SELECT 'antes=' || _assinada(_fid('K0303', 'KP3', 'KE0'));
BEGIN;
SET LOCAL afiacao.tint_tombstone_manutencao = 'on';
UPDATE tint_formulas SET desativada_motivo = 'fase5_geracao_legada', desativada_em = now()
 WHERE id = _fid('K0303', 'KP3', 'KE0');
COMMIT;
SELECT 'carimbado=' || _assinada(_fid('K0303', 'KP3', 'KE0'));
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = _fid('K0303', 'KP3', 'KE0');
UPDATE tint_formula_itens SET qtd_ml = qtd_ml + 1 WHERE formula_id = _fid('K0303', 'KP3', 'KE0') AND ordem = 3;
SELECT 'pedido=' || _assinada(_fid('K0303', 'KP3', 'KE0'));
SQL
)" || true
  [ "$(echo "$v" | tr '\n' ' ')" = "antes=true carimbado=false pedido=false " ] \
    || { cai TOMB; echo "    (TOMB: [$(echo "$v" | tr '\n' ' ' | head -c 300)])" >&2; }

  # PRIV: service_role não cria gatilho; a escrita de item dele ainda invalida (o gatilho dispara para ele).
  q "$db" "UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = _fid('K0304', 'KP3', 'KE0')" >/dev/null
  v="$(PA -q -tA -d "$db" 2>&1 <<'SQL'
\set ON_ERROR_STOP 1
SET client_min_messages = warning;
SELECT has_table_privilege('service_role', 'public.tint_formulas', 'TRIGGER')
    OR has_table_privilege('service_role', 'public.tint_formula_itens', 'TRIGGER');
SET ROLE service_role;
SELECT public._tenta_trigger();
WITH u AS (UPDATE public.tint_formula_itens SET qtd_ml = qtd_ml + 1
            WHERE formula_id = public._fid('K0304', 'KP3', 'KE0') AND ordem = 3 RETURNING 1)
SELECT count(*) FROM u;
RESET ROLE;
DROP TRIGGER IF EXISTS zz_forja ON public.tint_formulas;
SELECT _assinada(_fid('K0304', 'KP3', 'KE0'));
SQL
)" || true
  [ "$(echo "$v" | tr '\n' ' ')" = "f NEGADO 1 f " ] \
    || { cai PRIV; echo "    (PRIV: [$(echo "$v" | tr '\n' ' ' | head -c 300)])" >&2; }

  # BULK: TRUNCATE dos itens zera tudo (na transação); COPY de item zera a fórmula.
  v="$(PA -q -tA -d "$db" 2>&1 <<'SQL'
\set ON_ERROR_STOP 1
UPDATE tint_formulas SET receita_assinatura = ''::bytea WHERE id = _fid('K0305', 'KP3', 'KE0');
SELECT 'antes=' || (count(*) > 0) FROM tint_formulas WHERE receita_assinatura IS NOT NULL;
BEGIN;
TRUNCATE public.tint_formula_itens;
SELECT 'trunc=' || count(*) FROM tint_formulas WHERE receita_assinatura IS NOT NULL;
ROLLBACK;
SQL
)" || true
  # COPY: a linha de dados leva o id da fórmula (assinada acima), resolvido antes
  local b1
  b1="$(q "$db" "SELECT _fid('K0305', 'KP3', 'KE0')")"
  w="$(printf '%s\n' '\set ON_ERROR_STOP 1' 'BEGIN;' \
        "INSERT INTO tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml) VALUES ('c0000000-0000-0000-0000-000000000009', 'oben', 'KC9', 'KC9', 1000);" \
        'COPY public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) FROM stdin;' \
        "$b1	c0000000-0000-0000-0000-000000000009	9	1.5" '\.' \
        "SELECT 'copy=' || _assinada('$b1');" 'ROLLBACK;' | PA -q -tA -d "$db" 2>&1)" || true
  [ "$(echo "$v" | head -2 | tr '\n' ' ')" = "antes=true trunc=0 " ] && [ "$w" = "copy=false" ] \
    || { cai BULK; echo "    (BULK: [$(echo "$v" | head -2 | tr '\n' ' ')] [$(echo "$w" | head -c 200)])" >&2; }

  v="$(q "$db" "SELECT bool_or(has_function_privilege(r, f, 'EXECUTE'))
                  FROM unnest(ARRAY['anon', 'authenticated']) r,
                       unnest(ARRAY['public.tint_promote_sync_run(uuid)', 'public.tint_formulas_assina_receita()',
                                    'public.tint_formula_itens_invalida_assinatura()']) f")"
  [ "$v" = "f" ] || cai ACL

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
  PA -q -d postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null
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
     && [ "$(q deriva "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure")" = "$DERIVA_MD5" ] \
     && [ "$(q deriva "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.tint_formulas'::regclass AND attname = 'receita_assinatura'")" = "0" ]; then
  echo "  ✓ DERIVA: abortou pelo md5 e não trocou nada (nem as colunas)"; PASSOU=$((PASSOU + 1))
else
  echo "  ✗ DERIVA: abortou pelo motivo errado ou deixou rastro: $(head -c 300 "$TMP/deriva.log")"; FALHAS=$((FALHAS + 1))
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

# TETO (controle fora da suíte), com o teto 6 e a RESERVA saturada (Codex P2-2): o 1º run do par BIG tem
# 8 reescritas, que só levam a metade (3); as puladas levam as outras 3. O seguinte assina mais 6 — o
# resto fica NULL e é comparado pelos itens, com o mesmo resultado.
python3 "$TMP/troca.py" "$MIG" "$TMP/teto.sql" <<'TROCAS'
[("  c_teto_assinar   constant int := 20000;", "  c_teto_assinar   constant int := 6;")]
TROCAS
consistente "$TMP/teto.sql"
PA -q -d postgres -c "CREATE DATABASE teto TEMPLATE tpl_diff" >/dev/null
if PA -q -d teto --single-transaction -f "$TMP/teto.sql" >"$TMP/teto.apply.log" 2>&1; then
  helpers_suite teto
  seed_big_run teto; v="$(leituras teto b0000000-0000-0000-0000-000000000003)"
  s="$(q teto "SELECT count(*) FILTER (WHERE f.receita_assinatura IS NOT NULL AND f.cor_id IN ('K0001', 'K0002')) || '+'
                      || count(*) FILTER (WHERE f.receita_assinatura IS NOT NULL AND f.cor_id NOT IN ('K0001', 'K0002'))
                 FROM tint_formulas f JOIN tint_produtos p ON p.id = f.produto_id WHERE p.cod_produto = 'KP0'")"
  seed_big_run2 teto; w="$(leituras teto b0000000-0000-0000-0000-000000000004)"
  t="$(q teto "SELECT count(*) FILTER (WHERE f.receita_assinatura IS NOT NULL) || '/' || _inconsistentes()
                 FROM tint_formulas f JOIN tint_produtos p ON p.id = f.produto_id WHERE p.cod_produto = 'KP0'")"
  if [[ "$v" =~ \ true\ 6\ 3992$ ]] && [ "$s" = "3+3" ] && [[ "$w" =~ \ true\ 6\ 3996$ ]] && [[ "$t" =~ ^(9|1[0-2])/0$ ]]; then
    echo "  ✓ TETO: 6 por run, reescritas na metade ($s no 1º; $t assinadas/inconsistentes no par)"; PASSOU=$((PASSOU + 1))
  else
    echo "  ✗ TETO: 1º [$v] reescritas+puladas [$s], 2º [$w], par [$t]"; FALHAS=$((FALHAS + 1))
  fi
else
  echo "  ✗ TETO: a cópia com teto 40 não aplicou: $(grep -m1 -E 'ERRO|ERROR' "$TMP/teto.apply.log" | head -c 300)"; FALHAS=$((FALHAS + 1))
fi

if [ "$FALHAS" -ne 0 ]; then
  echo "PASS=$PASSOU  FAIL=$FALHAS"; echo "RESULTADO: VERMELHO (controle) — falsificações não rodam sem controle verde"; exit 1
fi

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
# F1 — o assinador aceita o hash do chamador (só calcula quando pedem com ''): forja vale.
falsifica F1 FORJA <<'TROCAS'
[("  -- Fora de READ COMMITTED o snapshot", "  IF NEW.receita_assinatura <> ''::bytea THEN\n    RETURN NEW;\n  END IF;\n  -- Fora de READ COMMITTED o snapshot")]
TROCAS
# F2 — a invalidação do UPDATE de item sem a trava antes do filtro (postcondição ajustada): o assinador
#      não espera o item em voo e assina a receita velha.
falsifica F2 CONC_A <<'TROCAS'
[("    PERFORM 1 FROM public.tint_formulas f\n     WHERE f.id IN (SELECT o.formula_id FROM antigos o UNION SELECT n.formula_id FROM novos n)\n       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada'\n     ORDER BY f.id\n     FOR NO KEY UPDATE OF f;\n", ""),
 ("               / length('FOR NO KEY UPDATE OF f') = 3));", "               / length('FOR NO KEY UPDATE OF f') = 2));")]
TROCAS
# F3 — idem no DELETE de item: a invalidação não espera o assinador em voo e a assinatura velha fica.
falsifica F3 CONC_B <<'TROCAS'
[("    PERFORM 1 FROM public.tint_formulas f\n     WHERE f.id IN (SELECT o.formula_id FROM antigos o)\n       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada'\n     ORDER BY f.id\n     FOR NO KEY UPDATE OF f;\n", ""),
 ("               / length('FOR NO KEY UPDATE OF f') = 3));", "               / length('FOR NO KEY UPDATE OF f') = 2));")]
TROCAS
# F4 — o assinador aceita REPEATABLE READ: assina pelo snapshot velho.
falsifica F4 RR <<'TROCAS'
[("NOT IN ('read committed', 'read uncommitted')", "NOT IN ('read committed', 'read uncommitted', 'repeatable read')")]
TROCAS
# F5 — o assinador não reconhece o tombstone: carimbar mantém a assinatura — e a invalidação (que pula
#      tombstone de propósito: o guard dele barra UPDATE) não a zera nem no TRUNCATE.
falsifica F5 TOMB BULK <<'TROCAS'
[("     OR NEW.desativada_motivo IS NOT DISTINCT FROM 'fase5_geracao_legada'\n", "     OR (false AND NEW.desativada_motivo IS NOT DISTINCT FROM 'fase5_geracao_legada')\n")]
TROCAS
# F6 — o _pulados lê os itens mesmo assinado (sem o filtro de uma vez; postcondição ajustada): o
#      resultado é o mesmo, só a LEITURA denuncia.
falsifica F6 MD5 LEITURA <<'TROCAS'
[("    WHERE fi.formula_id = f.id\n      AND f.receita_assinatura IS NULL\n  ) atual", "    WHERE fi.formula_id = f.id\n  ) atual"),
 ("  IF position('AND f.receita_assinatura IS NULL' in v_src) = 0\n", "  IF false\n")]
TROCAS
# F7 — a assinatura sem o FRESCOR: o reenvio idêntico de C1 (R3) é pulado com o oficial mais velho
#      que a staging.
falsifica F7 MD5 EQUIV <<'TROCAS'
[("                  AND (f.receita_desde IS NULL OR f.receita_desde > sf.created_at)\n", "")]
TROCAS
# F8 — o upsert não zera a assinatura: REDUNDANTE (a invalidação do DELETE/INSERT de itens zera) —
#      só o MD5 cai.
falsifica F8 MD5 <<'TROCAS'
[("      desativada_em           = NULL,\n      receita_assinatura      = NULL,\n      receita_desde           = NULL\n    RETURNING$s7$", "      desativada_em           = NULL\n    RETURNING$s7$")]
TROCAS
# F9 — o promote não assina nada: tudo continua pelos itens.
falsifica F9 MD5 LEITURA ASSINA <<'TROCAS'
[("  IF current_setting('transaction_isolation') = 'read committed' THEN\n    CREATE TEMP TABLE _assinar", "  IF false THEN\n    CREATE TEMP TABLE _assinar")]
TROCAS
# F10 — TRIGGER não revogado (postcondição ajustada): service_role cria gatilho.
falsifica F10 PRIV <<'TROCAS'
[("    EXECUTE format('REVOKE TRIGGER ON %s FROM %s', r.tab, r.quem);", "    NULL;"),
 ("  IF v_n <> 0 THEN\n    RAISE EXCEPTION 'P5 FALHOU", "  IF false THEN\n    RAISE EXCEPTION 'P5 FALHOU")]
TROCAS
# F11 — o assinador com pg_temp à frente E relação sem schema (as duas camadas; postcondição ajustada):
#       a tabela homônima da sessão vira a receita.
falsifica F11 TEMP <<'TROCAS'
[("SET search_path = pg_catalog, public, pg_temp\nAS $fn$\nDECLARE", "SET search_path = pg_temp, pg_catalog, public\nAS $fn$\nDECLARE"),
 ("    FROM public.tint_formula_itens fi\n   WHERE fi.formula_id = NEW.id;", "    FROM tint_formula_itens fi\n   WHERE fi.formula_id = NEW.id;"),
 ("           AND position('FROM public.tint_formula_itens fi' in p.prosrc) > 0\n", ""),
 ("  IF v_n <> 2 THEN\n    RAISE EXCEPTION 'P3 FALHOU", "  IF v_n < 1 THEN\n    RAISE EXCEPTION 'P3 FALHOU")]
TROCAS
# F12 — o INSERT de item não invalida: o COPY deixa a assinatura velha.
falsifica F12 BULK <<'TROCAS'
[("     WHERE f.id IN (SELECT n.formula_id FROM novos n)\n       AND f.receita_assinatura IS NOT NULL\n", "     WHERE f.id IN (SELECT n.formula_id FROM novos n)\n       AND f.receita_assinatura IS NOT NULL AND false\n")]
TROCAS
# F13 — o TRUNCATE não invalida.
falsifica F13 BULK <<'TROCAS'
[("     WHERE f.receita_assinatura IS NOT NULL\n       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';\n  ELSIF TG_OP = 'INSERT'", "     WHERE f.receita_assinatura IS NOT NULL AND false\n       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';\n  ELSIF TG_OP = 'INSERT'")]
TROCAS
# F14 — a guarda do PRE neutralizada: re-aplicar sobre a versão posterior não aborta pela guarda.
falsifica F14 GUARDA <<'TROCAS'
[("  IF v_md5 <> c_pred THEN", "  IF false THEN")]
TROCAS
# F15 — a postcondição pega um gatilho de invalidação desabilitado: a migration ABORTA.
MOTIVO="P2 FALHOU" falsifica F15 "$TODOS" <<'TROCAS'
[("-- ── PÓS-CONDIÇÃO (relida do catálogo)", "ALTER TABLE public.tint_formula_itens DISABLE TRIGGER trg_tint_formula_itens_invalida_del;\n-- ── PÓS-CONDIÇÃO (relida do catálogo)")]
TROCAS

# F16 (Codex P2-2) — a assinatura vale sem comparar o hash (postcondição ajustada): no RH, a C8 assinada
#       cuja receita mudou sem staging nova (cabeçalho igual, itens frescos) é pulada.
falsifica F16 MD5 EQUIV <<'TROCAS'
[("             THEN f.receita_assinatura = sha256(convert_to(COALESCE(novo.receita, ''), 'UTF8'))\n", "             THEN true\n"),
 ("     OR position('THEN f.receita_assinatura = sha256(convert_to(COALESCE(novo.receita, ''''), ''UTF8''))' in v_src) = 0\n", "")]
TROCAS
# F17 (Codex P2-2) — o UPDATE de item invalida só a fórmula de DESTINO: o item movido deixa a de origem
#       assinada com a receita que não tem mais.
falsifica F17 ITEM <<'TROCAS'
[("     WHERE f.id IN (SELECT o.formula_id FROM antigos o UNION SELECT n.formula_id FROM novos n)\n       AND f.receita_assinatura IS NOT NULL\n", "     WHERE f.id IN (SELECT n.formula_id FROM novos n)\n       AND f.receita_assinatura IS NOT NULL\n")]
TROCAS

echo "─── controle $PASSOU ok | falsificações certas: $FALSIF_OK | inválidas/erradas: $FALSIF_ERR ───"
echo "PASS=$PASSOU  FAIL=$FALSIF_ERR"
if [ "$FALSIF_ERR" -ne 0 ]; then echo "RESULTADO: VERMELHO"; exit 1; fi
echo "RESULTADO: VERDE ($LOC) — $PASSOU asserts + $FALSIF_OK falsificações com conjunto exato"

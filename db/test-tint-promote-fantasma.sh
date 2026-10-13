#!/usr/bin/env bash
# PROVA — 20261013150000_tint_promote_nao_ressuscita_fantasma.sql
#
# Incidente 2026-10-13: 26.180 fórmulas ATIVAS de 6.545 cores que a fonte NÃO tem (ausentes do
# snapshot de chaves aplicado), todas canônicas e com receita válida, 9.164 com preço final no
# balcão. Ciclo diário: o apply do snapshot desativa; o promote reexpande o staging LATEST do par
# (across TODOS os runs) e REATIVA; o apply seguinte desativa de novo.
#
# Parte do snapshot de schema com a v6 ANCORADA na 20260726120000 + a 5b#1 (20260924120000) por
# cima = o corpo vivo em prod (marcas v_tombstones_fase5 + _fl_culpa). O snapshot da fonte é
# aplicado pelo tint_apply_keys_snapshot REAL — é o que prova que a chave de 4 partes montada pelo
# filtro é a MESMA do apply (se divergissem, uma cor presente pareceria ausente).
#
# Cenário (um par P1/B1/E900, 10 cores ativas):
#   B1..B8  presentes na fonte o tempo todo
#   A       a fonte RETIROU (staging antigo; ausente do snapshot)          → fantasma
#   C       retirada e RE-ADICIONADA depois do snapshot (staging NOVO)     → tem de voltar
#   D       cor NOVA da fonte, chega depois do snapshot (staging NOVO)     → tem de nascer
#   E       staging ANTIGO nunca promovido, ausente do snapshot            → não pode nascer
# Linha do tempo (relógio do servidor): staging R2/E há 2 dias → snapshot recebido há 1 dia →
# apply → staging R3 (C, D) agora → promote do R3, que reexpande o par inteiro.
#
#   T0 — REPRODUÇÃO sem a migration: A reativa e E nasce (o defeito de prod).
#   T1 — com a migration: A segue desativada; E não nasce; C reativa; D nasce; B intactas;
#        metadata do run e retorno do RPC contam 2 fantasmas.
#   T2 — sem snapshot APLICADO (só recebido): o filtro não age — comportamento anterior.
#   T3 — re-apply idempotente (no-op, corpo inalterado).
#   F1 — filtro neutralizado (`AND false`)           → T1 TEM de cair (fantasmas voltam).
#   F2 — sem o critério TEMPORAL (`AND true`)       → C e D barradas (o falso positivo do desenho).
#   F3 — chave em formato errado (sem personalizada) → todas viram "ausentes"; a contagem denuncia.
#
# Uso: db/test-tint-promote-fantasma.sh  (PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5447}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-fantasma.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql"
MIG_5B1="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
export LC_ALL=C LANG=C

for f in "$MIG" "$MIG_5B1" "$MIG_V6"; do [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }; done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── template: stubs + prelude + snapshot de schema + v6 ancorada + 5b#1 = corpo vivo ───────────
PA -q -d postgres -c "CREATE DATABASE tpl_fantasma" >/dev/null
T() { PA -d tpl_fantasma "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null

# A v6 ancorada num artefato IMUTÁVEL (mesma razão da prova da 5b#1: o snapshot de schema é
# re-dump da prod e muda de baixo da prova). Depois a 5b#1 por cima — o corpo vivo em 2026-10-13.
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
# + a seção 3 da promoção assíncrona (20260925210000), que ancora 2 ajustes no promote (janela do cap
# de limpezas e cláusula do purge). Só a seção 3: o resto (colunas, consumidor, crons) já está no
# snapshot de schema, e os crons exigiriam o pg_cron. Com ela, o corpo testado é BYTE-IDÊNTICO ao de
# prod em 2026-10-13 (conferido por diff contra pg_get_functiondef via psql-ro) — sem ela, a prova
# testaria uma função que prod não tem.
MIG_ASYNC="$REPO_ROOT/supabase/migrations/20260925210000_tint_promocao_assincrona.sql"
[ -f "$MIG_ASYNC" ] || { echo "migration ausente: $MIG_ASYNC"; exit 1; }
python3 - "$MIG_ASYNC" "$TMP/async_s3.sql" <<'PY1'
import sys
t = open(sys.argv[1]).read()
ini = t.index('-- ── 3. tint_promote_sync_run')
fim = t.index('-- ── 4. O consumidor da fila')
assert t.count('-- ── 3. tint_promote_sync_run') == 1 and t.count('-- ── 4. O consumidor da fila') == 1
open(sys.argv[2], 'w').write(t[ini:fim])
PY1
T -q -f "$TMP/async_s3.sql" >/dev/null

PRE="$(T -tA -c "SELECT (position('v_tombstones_fase5' in d) > 0)::text || '/' || (position('v_fantasmas_fonte' in d) > 0)::text
                   FROM (SELECT pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure) d) x")"
[ "$PRE" = "true/false" ] || { echo "✗ pré-condição: o template não é a v6+5b#1 sem a correção ($PRE)"; exit 1; }

# ── seed ───────────────────────────────────────────────────────────────────────────────────────
T -q <<'SQL' >/dev/null
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_test', true);

-- R1 catálogo: P1/B1/E900.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','Produto 1');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','B1','Base 1');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','E900','Galão 900',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','B1','E900');
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000001');

-- R2 fórmulas (há 2 dias): B1..B8, A e C — as 10 que a fonte tinha.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, created_at)
SELECT '11111111-0000-0000-0000-000000000002','oben','L1', c, 'Cor ' || c, 'P1','B1','E900','SL',900,false,1, now() - interval '2 days'
  FROM unnest(ARRAY['B1','B2','B3','B4','B5','B6','B7','B8','A','C']) c;
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 10 FROM tint_staging_formulas WHERE sync_run_id = '11111111-0000-0000-0000-000000000002';
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000002');

-- E: staging ANTIGO de um run cujo promote nunca rodou (ausente da fonte) — o caminho de INSERT.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-00000000002e','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count, created_at)
VALUES ('11111111-0000-0000-0000-00000000002e','oben','L1','E','Cor E','P1','B1','E900','SL',900,false,1, now() - interval '2 days');
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 10 FROM tint_staging_formulas WHERE sync_run_id = '11111111-0000-0000-0000-00000000002e';

-- Snapshot da FONTE recebido há 1 dia: só B1..B8 (A e C retiradas). Chave de 4 partes.
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks, chunk_index, keys, created_at, aplicacao_status)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','5a000000-0000-0000-0000-000000000001','formulas',
        now() - interval '1 day', 1, 0,
        (SELECT jsonb_agg(c || '|P1|B1|false') FROM unnest(ARRAY['B1','B2','B3','B4','B5','B6','B7','B8']) c),
        now() - interval '1 day', 'pendente');
SQL

# o APPLY REAL (desativa A e C; 2 de 10 = no limite de 20% do blast radius) e marca como aplicado,
# como o tick assíncrono faz.
APPLY="$(T -tA -c "SELECT (tint_apply_keys_snapshot('5a000000-0000-0000-0000-000000000001')->>'desativadas')")"
[ "$APPLY" = "2" ] || { echo "✗ seed: o apply real tinha de desativar exatamente A e C (2), veio [$APPLY]"; exit 1; }
T -q -c "UPDATE tint_keys_snapshots SET aplicacao_status='aplicado', aplicado_em = now() - interval '1 day' WHERE snapshot_id='5a000000-0000-0000-0000-000000000001'" >/dev/null

T -q <<'SQL' >/dev/null
-- R3 fórmulas (AGORA): C volta à fonte e D é cor nova — o run toca o par P1/B1 e reexpande o latest
-- de TODAS as cores do par, inclusive o staging antigo de A e de E.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('11111111-0000-0000-0000-000000000003','oben','L1','C','Cor C','P1','B1','E900','SL',900,false,1),
       ('11111111-0000-0000-0000-000000000003','oben','L1','D','Cor D','P1','B1','E900','SL',900,false,1);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sync_run_id, id, 'AX', 1, 10 FROM tint_staging_formulas WHERE sync_run_id = '11111111-0000-0000-0000-000000000003';
SQL

SEED="$(T -tA -c "SELECT count(*) FILTER (WHERE desativada_em IS NULL) || '/' || count(*) FROM tint_formulas")"
[ "$SEED" = "8/10" ] || { echo "✗ seed: esperado 8 ativas de 10 antes do R3, veio $SEED"; exit 1; }

FALHAS=0; PASSOU=0
ok()  { echo "  ✓ $*"; PASSOU=$((PASSOU + 1)); }
bad() { echo "  ✗ $*"; FALHAS=$((FALHAS + 1)); }
# if/else explicito (e nao `A && ok || bad`): o shellcheck do CI reprova o SC2015, e o padrao so
# funciona enquanto ok() nunca falhar — uma garantia que nenhum gate vigia.
afirma() { local m_ok="$1" m_bad="$2"; shift 2; if "$@"; then ok "$m_ok"; else bad "$m_bad"; fi; }
novo_db() { PA -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE tpl_fantasma" >/dev/null 2>&1; }
# estado de uma cor: ATIVA | INATIVA | AUSENTE
# count(*) PRIMEIRO: agregado sobre zero linhas ainda devolve UMA linha, e bool_or(vazio) = NULL cai no
# ELSE do CASE — sem o count, cor inexistente era lida como 'INATIVA' (medido: o A2 mentiu assim).
estado() { PA -d "$1" -tA -c "SELECT CASE WHEN count(*) = 0 THEN 'AUSENTE' WHEN bool_or(desativada_em IS NULL) THEN 'ATIVA' ELSE 'INATIVA' END FROM tint_formulas WHERE cor_id = '$2'"; }
promove_r3() { PA -d "$1" -tA -c "SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000003')::text"; }

# ── T0: reprodução (sem a migration) ───────────────────────────────────────────────────────────
echo "════ T0 — reprodução (sem a migration) ════"
novo_db t0
promove_r3 t0 >/dev/null
afirma "T0 sem a correção, A (retirada da fonte) RESSUSCITA" "T0 A não ressuscitou: $(estado t0 A) — o cenário não reproduz o incidente" [ "$(estado t0 A)" = "ATIVA" ]
afirma "T0 sem a correção, E (staging antigo, ausente da fonte) NASCE" "T0 E não nasceu: $(estado t0 E)" [ "$(estado t0 E)" = "ATIVA" ]
# ── suíte da correção (reusada pelas falsificações) ────────────────────────────────────────────
suite() {   # $1 = banco já com a migration (real ou sabotada) aplicada
  local db="$1" ret
  ret="$(promove_r3 "$db")"
  afirma "A1 A (retirada da fonte) NÃO ressuscita" "A1 A: $(estado "$db" A)" [ "$(estado "$db" A)" = "INATIVA" ]
  afirma "A2 E (staging antigo, ausente) NÃO nasce" "A2 E: $(estado "$db" E)" [ "$(estado "$db" E)" = "AUSENTE" ]
  afirma "A3 C (re-adicionada após o snapshot) VOLTA" "A3 C: $(estado "$db" C)" [ "$(estado "$db" C)" = "ATIVA" ]
  afirma "A4 D (cor nova após o snapshot) NASCE" "A4 D: $(estado "$db" D)" [ "$(estado "$db" D)" = "ATIVA" ]
  local b; b="$(PA -d "$db" -tA -c "SELECT count(*) FROM tint_formulas WHERE cor_id LIKE 'B_' AND desativada_em IS NULL")"
  afirma "A5 B1..B8 (presentes) seguem ativas" "A5 B ativas: $b" [ "$b" = "8" ]
  local meta; meta="$(PA -d "$db" -tA -c "SELECT metadata->>'fantasmas_fonte_barradas' FROM tint_sync_runs WHERE id='11111111-0000-0000-0000-000000000003'")"
  afirma "A6 metadata do run conta 2 fantasmas barradas (A e E)" "A6 metadata: [$meta]" [ "$meta" = "2" ]
  local r; r="$(printf '%s' "$ret" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("fantasmas_fonte_barradas"))')"
  afirma "A7 retorno do RPC conta 2" "A7 retorno: [$r]" [ "$r" = "2" ]
}

echo "════ T1 — com a migration ════"
novo_db t1
PA -d t1 -q -f "$MIG" >/dev/null
suite t1

# ── T2: sem snapshot APLICADO, o filtro não age ────────────────────────────────────────────────
echo "════ T2 — snapshot só recebido (não aplicado) ════"
novo_db t2
PA -d t2 -q -c "UPDATE tint_keys_snapshots SET aplicacao_status='pendente', aplicado_em=NULL" >/dev/null
PA -d t2 -q -f "$MIG" >/dev/null
promove_r3 t2 >/dev/null
afirma "T2 sem referência aplicada, comportamento anterior (A reativa)" "T2 A: $(estado t2 A)" [ "$(estado t2 A)" = "ATIVA" ]
# ── T3: re-apply idempotente ───────────────────────────────────────────────────────────────────
echo "════ T3 — re-apply ════"
H1="$(PA -d t1 -tA -c "SELECT md5(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure))")"
PA -d t1 -q -f "$MIG" >/dev/null 2>&1
H2="$(PA -d t1 -tA -c "SELECT md5(pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure))")"
afirma "T3 re-apply é no-op (corpo inalterado)" "T3 re-apply mudou o corpo" [ "$H1" = "$H2" ]
echo "─── controle: $PASSOU ok / $FALHAS falhas ───"
[ "$FALHAS" -eq 0 ] || { echo "RESULTADO: VERMELHO no controle"; echo "PASS=$PASSOU  FAIL=$FALHAS"; exit 1; }
CONTROLE_OK=$PASSOU

# ── falsificações: cada uma exige o conjunto EXATO de asserts vermelhos ────────────────────────
FALSIF_ERR=0
falsifica() {   # $1=rotulo $2=busca $3=troca $4..=asserts que TÊM de cair
  local rot="$1" busca="$2" troca="$3"; shift 3
  local esp; esp="$(printf '%s\n' "$@" | sort | tr '\n' ' ' | sed 's/ $//')"
  if ! python3 - "$MIG" "$TMP/sab_$rot.sql" "$busca" "$troca" <<'PY'
import sys
src, dst, busca, troca = sys.argv[1:5]
s = open(src).read()
n = s.count(busca)
if n != 1:
    sys.stderr.write("ancora casou %d vezes\n" % n); sys.exit(3)
open(dst, 'w').write(s.replace(busca, troca))
PY
  then echo "  ✗ $rot: sabotagem NÃO aplicou (âncora) — inválida"; FALSIF_ERR=$((FALSIF_ERR + 1)); return; fi
  local db; db="f_$(printf %s "$rot" | tr "[:upper:]" "[:lower:]")"   # identificador sem aspas vira minusculas no PG
  novo_db "$db"
  if ! PA -d "$db" -q -f "$TMP/sab_$rot.sql" >"$TMP/sab_$rot.log" 2>&1; then
    echo "  ✗ $rot: a migration sabotada não aplicou — $(tail -c 300 "$TMP/sab_$rot.log" | tr '\n' ' ')"
    FALSIF_ERR=$((FALSIF_ERR + 1)); return
  fi
  local saida caidos
  saida="$(FALHAS=0; PASSOU=0; suite "$db" 2>&1)"
  caidos="$(printf '%s\n' "$saida" | sed -n 's/^  ✗ \([A-Z][0-9]*\) .*/\1/p' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$caidos" = "$esp" ]; then echo "  ✓ $rot derrubou EXATAMENTE [$caidos]"
  else echo "  ✗ $rot: esperado [$esp], veio [$caidos]"; FALSIF_ERR=$((FALSIF_ERR + 1)); fi
}

echo "════ FALSIFICAÇÕES ════"
# ⚠️ F1/F2 PRESERVAM o literal `AND sf.created_at < v_snap_recebido`: a pós-condição da migration o
#    exige por TEXTO e aborta o apply sem ele (medido 2026-10-13: a 1ª versão destas sabotagens, que
#    trocava a linha inteira, morria ali). Esse é o dente da camada textual; estas medem o COMPORTAMENTO.
# F1: o filtro não barra nada — as fantasmas voltam (o estado de prod em 13/10).
falsifica F1 "      AND sf.created_at < v_snap_recebido' || E'\\n' ||" "      AND sf.created_at < v_snap_recebido AND false' || E'\\n' ||" A1 A2 A6 A7
# F2: sem o critério TEMPORAL — todo staging parece anterior ao snapshot, o filtro barra por presença
#     pura, e a cor re-adicionada (C) e a cor nova (D) somem: o falso positivo que o desenho evita.
falsifica F2 "      AND sf.created_at < v_snap_recebido' || E'\\n' ||" "      AND sf.created_at < v_snap_recebido + interval ''100 years''' || E'\\n' ||" A3 A4 A6 A7
# F3: chave sem o 4º termo — nenhuma bate com o snapshot; tudo "ausente". Só a contagem denuncia
#     (as presentes já estavam ativas e seguem; o dano seria barrar a reativação legítima delas).
falsifica F3 "                             || (CASE WHEN eu.personalizada THEN ''true'' ELSE ''false'' END));' || E'\\n' ||" "                             );' || E'\\n' ||" A6 A7

echo "─── controle $CONTROLE_OK ok | falsificações inválidas/erradas: $FALSIF_ERR ───"
echo "PASS=$CONTROLE_OK  FAIL=$FALSIF_ERR"
if [ "$FALSIF_ERR" -ne 0 ]; then echo "RESULTADO: VERMELHO"; exit 1; fi
echo "RESULTADO: VERDE — $CONTROLE_OK asserts + 3 falsificações com conjunto exato"

#!/usr/bin/env bash
# PROVA — 20260924120000_tint_promote_tombstone_fase5.sql (Fase 5b#1).
#
# Incidente 2026-09-24: tint-sync-agent /catalogs e /formulas → 500 em pares, ciclo após ciclo.
# Causa: o upsert do tint_promote_sync_run (v6) faz `desativada_em = NULL` numa linha carimbada
# pela Fase 5 (desativada_motivo NOT NULL) → viola tint_formulas_motivo_exige_desativacao (23514)
# → o promote INTEIRO aborta.
#
# Parte do snapshot de schema (a CHECK da Fase 5 e a base) com a v6 ANCORADA na 20260726120000 — o
# corpo que a prod tinha no incidente, imune ao re-dump do DR (que já traz a 5b#1). Casos:
#   T0 — REPRODUÇÃO: sem a migration, o promote de um run que toca o par da chave carimbada
#        morre com SQLSTATE 23514 (exatamente esta, não "qualquer erro").
#   T1 — com a migration: o mesmo run promove; tombstone intocado (inativo, carimbado, preço e
#        itens iguais); cor nova promovida; linha desativada pelo SNAPSHOT (motivo NULL) continua
#        REATIVANDO (não-regressão); metadata e retorno contam 1 tombstone.
#   T2 — re-apply idempotente (no-op).
#   F1 — FALSIFICAÇÃO: migration espelhada com o filtro neutralizado (em tmp, nunca no repo) →
#        a suíte TEM de reprovar. Roda na MESMA invocação que o controle verde (T1).
#
# Uso: db/test-tint-promote-tombstone-fase5.sh   (PGBIN_OVERRIDE=<dir> para outro PG — a major 17 é
#      conferida; PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5446}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-tombstone5.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20260924120000_tint_promote_tombstone_fase5.sql"
export LC_ALL=C LANG=C

[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── template: stubs + prelude + snapshot + seed (a Fase 5 já carimbou a '1') ─────────────────
PA -q -d postgres -c "CREATE DATABASE tpl_tombstone" >/dev/null
T() { PA -d tpl_tombstone "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
# transaction_timeout é PG17+: filtrado para o snapshot carregar também em PG16 (só um SET de sessão).
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null

# A v6 (o estado do incidente) ancorada num artefato IMUTAVEL, nao no snapshot. O schema-snapshot.sql
# e o dump de DR, re-gerado da PROD a cada 1-3 semanas — e a PROD ja roda a 5b#1 (o patch desta
# migration). Lida do snapshot, a v6 sumiria no proximo re-dump: a pre-condicao/T0 ficariam vermelhas
# sem defeito nenhum, e F1/F2 cairiam no guard "ja aplicada" da migration. O bloco da funcao na
# 20260726120000 e a v6 (byte-identico ao snapshot de 2026-09-05, sha256 3eeb6cd760); extraido do
# arquivo e aplicado por cima do snapshot. Hoje nao muda nada; depois do re-dump, e ele que segura.
MIG_V6="$REPO_ROOT/supabase/migrations/20260726120000_tint_promote_error_details_completo.sql"
[ -f "$MIG_V6" ] || { echo "migration da v6 ausente: $MIG_V6"; exit 1; }
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

# Pré-condições do cenário (a base + a v6 ancorada TÊM de ser o estado que dispara o incidente).
PRE="$(T -tA -c "SELECT (position('CREATE TEMP TABLE _fl_culpa' in pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure)) > 0)::text
                 || '/' || EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tint_formulas_motivo_exige_desativacao')::text")"
[ "$PRE" = "true/true" ] || { echo "✗ pré-condição: snapshot sem v6 e/ou sem a CHECK da Fase 5 ($PRE)"; exit 1; }

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

-- R2 fórmulas: COR1 nas gerações 'SL' e '1' (a legada que a Fase 5 aposenta) + COR3 (só SL).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff000000-0000-0000-0000-00000000000a','11111111-0000-0000-0000-000000000002','oben','L1','COR1','Azul','P1','B1','E900','SL',900,false,1),
       ('ff000000-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000002','oben','L1','COR1','Azul','P1','B1','E900','1', 900,false,1),
       ('ff000000-0000-0000-0000-00000000000c','11111111-0000-0000-0000-000000000002','oben','L1','COR3','Verde','P1','B1','E900','SL',900,false,1);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('11111111-0000-0000-0000-000000000002','ff000000-0000-0000-0000-00000000000a','AX',1,10),
       ('11111111-0000-0000-0000-000000000002','ff000000-0000-0000-0000-00000000000b','AX',1,7),
       ('11111111-0000-0000-0000-000000000002','ff000000-0000-0000-0000-00000000000c','VM',1,5);
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000002');

-- Fase 5: carimba a COR1 geração '1'. Snapshot: desativa a COR3 SEM motivo (a fonte a retirou).
UPDATE tint_formulas f SET desativada_em = now() - interval '1 day', desativada_motivo = 'fase5_geracao_legada',
       preco_final_sayersystem = 123.45
  FROM tint_subcolecoes s
 WHERE s.id = f.subcolecao_id AND s.id_subcolecao_sayersystem = '1' AND f.cor_id = 'COR1';
UPDATE tint_formulas SET desativada_em = now() - interval '1 day' WHERE cor_id = 'COR3';

-- R3 fórmulas (o ciclo do incidente): cor NOVA COR2 no MESMO par → re-expande o latest do par,
-- inclusive o staging antigo da '1' e da COR3.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff000000-0000-0000-0000-00000000000d','11111111-0000-0000-0000-000000000003','oben','L1','COR2','Rosa','P1','B1','E900','SL',900,false,1);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('11111111-0000-0000-0000-000000000003','ff000000-0000-0000-0000-00000000000d','AX',1,3);
SQL

SEED_OK="$(T -tA -c "SELECT count(*) FILTER (WHERE desativada_motivo = 'fase5_geracao_legada')::text || '/' || count(*)::text FROM tint_formulas")"
[ "$SEED_OK" = "1/3" ] || { echo "✗ seed: esperado 1 carimbada de 3 fórmulas, veio $SEED_OK"; exit 1; }

FALHAS=0; PASSOU=0
ok()  { echo "  ✓ $*"; PASSOU=$((PASSOU + 1)); }
bad() { echo "  ✗ $*"; FALHAS=$((FALHAS + 1)); }
novo_db() { PA -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE tpl_tombstone" >/dev/null 2>&1; }

# ── T0: reprodução do incidente (sem a migration) ───────────────────────────────────────────
echo "════ T0 — reprodução (sem a migration) ════"
novo_db t0
R0="$(PA -d t0 -tA 2>&1 <<'SQL'
DO $$
BEGIN
  PERFORM tint_promote_sync_run('11111111-0000-0000-0000-000000000003');
  RAISE NOTICE 'T0=PROMOVEU';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'T0=23514 %', SQLERRM;
END $$;
SQL
)" || true
case "$R0" in
  *"T0=23514"*tint_formulas_motivo_exige_desativacao*) ok "sem a migration o promote morre com 23514 na CHECK da Fase 5 (= o 500 da edge)" ;;
  *) bad "T0 não reproduziu o incidente: [$R0]" ;;
esac

# ── suíte T1: aplica <migration> num DB novo e assere; imprime FALHAS=<n> ───────────────────
suite() {  # $1 = arquivo da migration, $2 = nome do db
  local mig="$1" db="$2" out
  novo_db "$db"
  if ! PA -d "$db" -q -f "$mig" >/dev/null 2>"$TMP/$db.err"; then
    echo "APPLY_FALHOU $(tr '\n' ' ' < "$TMP/$db.err")"; return 0
  fi
  out="$(PA -d "$db" -tA <<'SQL' 2>&1
DO $$
DECLARE v jsonb; n int := 0; r record; msg text := '';
BEGIN
  v := tint_promote_sync_run('11111111-0000-0000-0000-000000000003');

  -- tombstone intocado
  SELECT f.desativada_em IS NOT NULL AS inativa, f.desativada_motivo, f.preco_final_sayersystem,
         (SELECT string_agg(c.id_corante_sayersystem || '=' || trim_scale(fi.qtd_ml), ',') FROM tint_formula_itens fi
            JOIN tint_corantes c ON c.id = fi.corante_id WHERE fi.formula_id = f.id) AS itens
    INTO r
    FROM tint_formulas f JOIN tint_subcolecoes s ON s.id = f.subcolecao_id
   WHERE f.cor_id = 'COR1' AND s.id_subcolecao_sayersystem = '1';
  IF r.inativa IS NOT TRUE                           THEN n := n+1; msg := msg || ' [A1 tombstone reativado]'; END IF;
  IF r.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada' THEN n := n+1; msg := msg || ' [A2 carimbo perdido]'; END IF;
  IF r.preco_final_sayersystem IS DISTINCT FROM 123.45 THEN n := n+1; msg := msg || ' [A3 preço do tombstone mudou]'; END IF;
  IF r.itens IS DISTINCT FROM 'AX=7'                 THEN n := n+1; msg := msg || ' [A4 itens do tombstone: ' || COALESCE(r.itens,'∅') || ']'; END IF;

  -- cor nova promovida; SL ativa
  IF NOT EXISTS (SELECT 1 FROM tint_formulas WHERE cor_id = 'COR2' AND desativada_em IS NULL)
                                                     THEN n := n+1; msg := msg || ' [A5 COR2 não promovida]'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tint_formulas f JOIN tint_subcolecoes s ON s.id = f.subcolecao_id
                  WHERE f.cor_id = 'COR1' AND s.id_subcolecao_sayersystem = 'SL' AND f.desativada_em IS NULL)
                                                     THEN n := n+1; msg := msg || ' [A6 COR1/SL inativa]'; END IF;
  -- não-regressão: desativada pelo snapshot (motivo NULL) reativa como antes
  IF NOT EXISTS (SELECT 1 FROM tint_formulas WHERE cor_id = 'COR3' AND desativada_em IS NULL)
                                                     THEN n := n+1; msg := msg || ' [A7 COR3 (motivo NULL) não reativou]'; END IF;

  -- contagem visível
  IF (v->>'tombstones_fase5_preservados') IS DISTINCT FROM '1'
                                                     THEN n := n+1; msg := msg || ' [A8 retorno: ' || COALESCE(v->>'tombstones_fase5_preservados','∅') || ']'; END IF;
  IF (SELECT metadata->>'tombstones_fase5_preservados' FROM tint_sync_runs WHERE id = '11111111-0000-0000-0000-000000000003') IS DISTINCT FROM '1'
                                                     THEN n := n+1; msg := msg || ' [A9 metadata sem contador=1]'; END IF;
  -- promovidas conta só o gravado (COR1/SL, COR2, COR3 = 3; o tombstone NÃO)
  IF (v->>'promovidas') IS DISTINCT FROM '3'         THEN n := n+1; msg := msg || ' [A10 promovidas=' || COALESCE(v->>'promovidas','∅') || ']'; END IF;

  RAISE NOTICE 'FALHAS=% %', n, msg;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FALHAS=ERRO % %', SQLSTATE, SQLERRM;
END $$;
SQL
)" || true
  echo "$out"
}

echo "════ T1 — controle VERDE (migration real) ════"
S1="$(suite "$MIG" t1)"
case "$S1" in
  *"FALHAS=0 "*|*"FALHAS=0") ok "migration real: todos os asserts A1-A10 passam" ;;
  *) bad "migration real reprovou: [$S1]" ;;
esac

echo "════ T2 — re-apply idempotente ════"
if R2="$(PA -d t1 -f "$MIG" 2>&1)"; then
  case "$R2" in
    *"já aplicada"*"5b#1 OK"*) ok "re-apply = NOTICE no-op + marcador de fim" ;;
    *) bad "re-apply sem o no-op esperado: [$R2]" ;;
  esac
else
  bad "re-apply falhou: [$R2]"
fi

echo "════ F1 — FALSIFICAÇÃO (filtro neutralizado num espelho em tmp) ════"
sed "s/'    AND tf.embalagem_id = eu.emb_id'/'    AND tf.embalagem_id IS NULL'/" "$MIG" > "$TMP/sab.sql"
if cmp -s "$MIG" "$TMP/sab.sql"; then
  bad "F1: o sed não casou o alvo (a migration mudou?) — sabotagem não aplicada"
else
  SF="$(suite "$TMP/sab.sql" f1)"
  case "$SF" in
    *"FALHAS=ERRO 23514"*) ok "sabotada volta a morrer com 23514 — o filtro é o que segura" ;;
    *) bad "F1: sabotagem NÃO derrubou a suíte: [$SF]" ;;
  esac
fi

echo "════ F2 — FALSIFICAÇÃO (filtro LARGO: qualquer desativada, não só a carimbada) ════"
sed "s/tf.desativada_motivo IS NOT NULL;/tf.desativada_em IS NOT NULL;/g" "$MIG" > "$TMP/sab2.sql"
if cmp -s "$MIG" "$TMP/sab2.sql"; then
  bad "F2: o sed não casou o alvo (a migration mudou?) — sabotagem não aplicada"
else
  SF2="$(suite "$TMP/sab2.sql" f2)"
  case "$SF2" in
    *"FALHAS=4 "*"[A7 "*"[A8 "*"[A9 "*"[A10 "*) ok "filtro largo derruba A7 (COR3 não reativa), A8+A9 (contam 2) e A10 (promovidas 2) — a não-regressão tem dente" ;;
    *) bad "F2: sabotagem não derrubou EXATAMENTE A7+A8+A9+A10: [$SF2]" ;;
  esac
fi

echo ""
echo "PASS=$PASSOU  FAIL=$FALHAS"   # recibo lido pelo db/roda-nucleo-ci.sh
if [ "$FALHAS" -eq 0 ]; then
  echo "TOMBSTONE_FASE5_PROVA_OK"
else
  echo "TOMBSTONE_FASE5_PROVA_FALHOU ($FALHAS)"; exit 1
fi

#!/usr/bin/env bash
# PROVA — 20261010120000_tint_formulas_tombstone_fase5_imutavel.sql [money-path]
#
# Resíduo (psql-ro, 2026-10-10): o preco_final_sayersystem das 463.995 linhas carimbadas
# 'fase5_geracao_legada' é o piso do tint_gate_revalida e o rótulo do balcão (via
# v_tint_formula_canonica), e qualquer staff o alterava direto pela API (authenticated=arwdDxtm +
# policy "Staff can manage" cmd '*'), sem trigger nem rastro.
#
# Sondas (cada uma numa transação própria com ROLLBACK, como staff autenticado via GUC de JWT):
#   P1 UPDATE do preço do tombstone          P2 reativar o tombstone (desativada_em/motivo NULL)
#   P3 INSERT de outra linha carimbada com o mesmo sku+cor e preço maior (move o max() da view)
#   P4 DELETE do tombstone                    P5 carimbar uma linha ATIVA
#   P6 UPDATE no-op do tombstone (tem de PASSAR)
#   P7 postgres SEM o GUC tenta mudar o preço (tem de ser barrado)
#   P8 postgres COM SET LOCAL do GUC: a reversão documentada da Fase 5 (tem de PASSAR)
#   P9 authenticated COM o GUC (tem de ser barrado: o escape exige role fora da API)
#   P10 renomear a subcoleção '1' (tira TODOS os tombstones do max() da view de uma vez)
#   P11 renomear OUTRA subcoleção (tem de PASSAR: o guard é só da '1')
#   V  efeito no dinheiro: preco_csv_legado/preco_piso_legado da COR1 depois de P1 e de P3
#   N  não-regressão: o promote de um run que toca a chave carimbada segue promovendo
# B0 = BASELINE sem a migration: P1-P5 PASSAM e V muda (o resíduo reproduzido). T1 = migration real.
# F1-F4 = falsificações num espelho em tmp (nunca no repo), na MESMA invocação do controle T1.
#
# Uso: db/test-tint-tombstone-fase5-imutavel.sh   (PGBIN_OVERRIDE=<dir>; PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5447}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-tomb5imut.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261010120000_tint_formulas_tombstone_fase5_imutavel.sql"
export LC_ALL=C LANG=C

[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── template: stubs + prelude + snapshot (prod: promote já com a 5b#1) + seed ─────────────────
PA -q -d postgres -c "CREATE DATABASE tpl_tomb" >/dev/null
T() { PA -d tpl_tomb "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null

PRE="$(T -tA -c "SELECT (position('tombstones_fase5_preservados' in pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure)) > 0)::text
                 || '/' || EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.tint_formulas'::regclass AND polname='Staff can manage tint_formulas' AND polcmd='*')::text
                 || '/' || (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tint_formulas'::regclass AND NOT tgisinternal)::text")"
[ "$PRE" = "true/true/0" ] || { echo "✗ pré-condição: snapshot sem promote 5b#1 / sem a policy cmd '*' / com trigger em tint_formulas ($PRE)"; exit 1; }

T -q <<'SQL' >/dev/null
-- O relacl de PROD (medido 2026-10-10): authenticated=arwdDxtm. O snapshot não carrega os GRANTs.
GRANT ALL ON public.tint_formulas, public.tint_formula_itens TO anon, authenticated;
GRANT SELECT ON public.user_roles, public.tint_embalagens TO authenticated;
GRANT ALL ON public.tint_subcolecoes TO authenticated;   -- prod: arwdDxtm + policy Staff can manage cmd '*'

-- Staff (employee) que faz o PATCH.
INSERT INTO auth.users (id) VALUES ('5aff0000-0000-0000-0000-000000000001');
INSERT INTO public.user_roles (user_id, role) VALUES ('5aff0000-0000-0000-0000-000000000001', 'employee');

INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_test', true);

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

-- Fase 5: carimba a COR1 geração '1' com o preço CSV. Snapshot desativa a COR3 sem motivo.
UPDATE tint_formulas f SET desativada_em = now() - interval '1 day', desativada_motivo = 'fase5_geracao_legada',
       preco_final_sayersystem = 123.45
  FROM tint_subcolecoes s
 WHERE s.id = f.subcolecao_id AND s.id_subcolecao_sayersystem = '1' AND f.cor_id = 'COR1';
UPDATE tint_formulas SET desativada_em = now() - interval '1 day' WHERE cor_id = 'COR3';

-- 2ª embalagem para o INSERT do P3 (chave única nova, mesmo sku+cor que a view agrega).
INSERT INTO tint_embalagens (account, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('oben','E3600','Galão 3600',3600);

-- R3 (ciclo seguinte): cor nova COR2 no mesmo par → re-expande o latest, inclusive a '1' carimbada.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, subcolecao, volume_final_ml, personalizada, expected_item_count)
VALUES ('ff000000-0000-0000-0000-00000000000d','11111111-0000-0000-0000-000000000003','oben','L1','COR2','Rosa','P1','B1','E900','SL',900,false,1);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('11111111-0000-0000-0000-000000000003','ff000000-0000-0000-0000-00000000000d','AX',1,3);
SQL

SEED_OK="$(T -tA -c "SELECT count(*) FILTER (WHERE desativada_motivo = 'fase5_geracao_legada')::text || '/' || count(*)::text
                     || '/' || COALESCE((SELECT preco_csv_legado::text FROM v_tint_formula_canonica WHERE cor_id='COR1'), '∅')
                     FROM tint_formulas")"
[ "$SEED_OK" = "1/3/123.45" ] || { echo "✗ seed: esperado 1 carimbada de 3 e csv_legado(COR1)=123.45, veio $SEED_OK"; exit 1; }

FALHAS=0; PASSOU=0
ok()  { echo "  ✓ $*"; PASSOU=$((PASSOU + 1)); }
bad() { echo "  ✗ $*"; FALHAS=$((FALHAS + 1)); }
novo_db() { PA -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE tpl_tomb" >/dev/null 2>&1; }

# Uma sonda: $1 = db, $2 = rótulo, $3 = role (staff|postgres), $4 = 'guc' liga o escape, $5 = SQL
# (um único comando DML). Imprime <rótulo>=PASSOU (≥1 linha afetada) | BLOQ (o 42501 do guard) |
# ZERO (0 linhas — RLS ou WHERE vazio, NUNCA conta como passou) | ERRO:<sqlstate>. Sempre ROLLBACK.
sonda() {
  local db="$1" rot="$2" quem="$3" guc="$4" dml="$5" pre=""
  [ "$guc" = "guc" ] && pre="SET LOCAL afiacao.tint_tombstone_manutencao = 'on';"
  [ "$quem" = "staff" ] && pre="$pre SET LOCAL request.jwt.claim.sub = '5aff0000-0000-0000-0000-000000000001'; SET LOCAL ROLE authenticated;"
  PA -d "$db" -tA 2>&1 <<SQL | grep -E "^(NOTICE:  )?$rot=" | sed 's/^NOTICE:  //' || echo "$rot=SEM_SAIDA"
BEGIN;
$pre
DO \$s\$
DECLARE n int;
BEGIN
  $dml;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '$rot=%', CASE WHEN n > 0 THEN 'PASSOU' ELSE 'ZERO' END;
EXCEPTION
  WHEN insufficient_privilege THEN
    IF SQLERRM LIKE 'tint_tombstone_fase5_imutavel:%' THEN RAISE NOTICE '$rot=BLOQ';
    ELSE RAISE NOTICE '$rot=ERRO:42501:%', SQLERRM; END IF;
  WHEN OTHERS THEN RAISE NOTICE '$rot=ERRO:%:%', SQLSTATE, SQLERRM;
END \$s\$;
ROLLBACK;
SQL
}

TOMB="(SELECT f.id FROM tint_formulas f WHERE f.desativada_motivo = 'fase5_geracao_legada' AND f.cor_id = 'COR1')"
ATIVA="(SELECT f.id FROM tint_formulas f JOIN tint_subcolecoes s ON s.id = f.subcolecao_id WHERE f.cor_id = 'COR1' AND s.id_subcolecao_sayersystem = 'SL')"
INS_CARIMBADA="INSERT INTO tint_formulas (account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id,
                 volume_final_ml, preco_final_sayersystem, personalizada, desativada_em, desativada_motivo)
               SELECT f.account, f.cor_id, f.nome_cor, f.produto_id, f.base_id,
                      (SELECT id FROM tint_embalagens WHERE id_embalagem_sayersystem = 'E3600'),
                      f.subcolecao_id, f.sku_id, 3600, 999, f.personalizada, now(), 'fase5_geracao_legada'
                 FROM tint_formulas f WHERE f.id = $TOMB"

REN_SUB1="UPDATE tint_subcolecoes SET id_subcolecao_sayersystem = '1-legado' WHERE id_subcolecao_sayersystem = '1'"

# Vetor de sondas (P1..P11) num db já preparado.
vetor() {
  local db="$1"
  {
    sonda "$db" P1 staff    -   "UPDATE tint_formulas SET preco_final_sayersystem = 999 WHERE id = $TOMB"
    sonda "$db" P2 staff    -   "UPDATE tint_formulas SET desativada_em = NULL, desativada_motivo = NULL WHERE id = $TOMB"
    sonda "$db" P3 staff    -   "$INS_CARIMBADA"
    sonda "$db" P4 staff    -   "DELETE FROM tint_formulas WHERE id = $TOMB"
    sonda "$db" P5 staff    -   "UPDATE tint_formulas SET desativada_em = now(), desativada_motivo = 'fase5_geracao_legada' WHERE id = $ATIVA"
    sonda "$db" P6 staff    -   "UPDATE tint_formulas SET preco_final_sayersystem = preco_final_sayersystem WHERE id = $TOMB"
    sonda "$db" P7 postgres -   "UPDATE tint_formulas SET preco_final_sayersystem = 999 WHERE id = $TOMB"
    sonda "$db" P8 postgres guc "UPDATE tint_formulas SET desativada_em = NULL, desativada_motivo = NULL WHERE desativada_motivo = 'fase5_geracao_legada'"
    sonda "$db" P9 staff    guc "UPDATE tint_formulas SET preco_final_sayersystem = 999 WHERE id = $TOMB"
    sonda "$db" P10 staff   -   "$REN_SUB1"
    sonda "$db" P11 staff   -   "UPDATE tint_subcolecoes SET descricao = 'x', id_subcolecao_sayersystem = 'SL2' WHERE id_subcolecao_sayersystem = 'SL'"
  } | tr '\n' ' ' | sed 's/ $//'
}

# Efeito no dinheiro: depois de um DML como staff (COMMIT, num db descartável), o csv/piso da COR1.
dinheiro() {  # $1 = db, $2 = DML
  PA -d "$1" -q -c "BEGIN; SET LOCAL request.jwt.claim.sub = '5aff0000-0000-0000-0000-000000000001'; SET LOCAL ROLE authenticated; $2; COMMIT;" >/dev/null 2>&1 || true
  PA -d "$1" -tA -c "SELECT COALESCE(preco_csv_legado::text,'∅') || '/' || COALESCE(preco_piso_legado::text,'∅') FROM v_tint_formula_canonica WHERE cor_id = 'COR1'"
}

# ── B0: BASELINE sem a migration — o resíduo reproduzido ─────────────────────────────────────
echo "════ B0 — baseline SEM a migration (o PATCH direto do staff passa) ════"
novo_db b0
V0="$(vetor b0)"
B0_ESPERADO="P1=PASSOU P2=PASSOU P3=PASSOU P4=PASSOU P5=PASSOU P6=PASSOU P7=PASSOU P8=PASSOU P9=PASSOU P10=PASSOU P11=PASSOU"
if [ "$V0" = "$B0_ESPERADO" ]; then ok "sem a migration o staff muda preço, reativa, insere carimbada, apaga e carimba: [$V0]"; else bad "baseline não reproduziu o resíduo: [$V0]"; fi
novo_db b0p1; M1="$(dinheiro b0p1 "UPDATE tint_formulas SET preco_final_sayersystem = 999 WHERE id = $TOMB")"
novo_db b0p3; M3="$(dinheiro b0p3 "$INS_CARIMBADA")"
novo_db b0p10; M10="$(dinheiro b0p10 "$REN_SUB1")"
if [ "$M1" = "999/999" ] && [ "$M3" = "999/999" ] && [ "$M10" = "∅/∅" ]; then ok "sem a migration o csv_legado/piso da COR1 vai de 123.45 a 999 (UPDATE: $M1 · INSERT: $M3) e some com o rename da subcoleção (P10: $M10)"; else bad "baseline: efeito no dinheiro inesperado (UPDATE: $M1 · INSERT: $M3 · P10: $M10)"; fi

# ── suíte: aplica <migration> num db novo; imprime o vetor + dinheiro + não-regressão ────────
suite() {  # $1 = migration, $2 = prefixo do db
  local mig="$1" db="$2" v m1 m3 m10 n
  novo_db "$db"
  if ! PA -d "$db" -q -tA -f "$mig" >"$TMP/$db.out" 2>"$TMP/$db.err"; then
    echo "APPLY_FALHOU $(tr '\n' ' ' < "$TMP/$db.err")"; return 0
  fi
  v="$(vetor "$db")"
  novo_db "${db}m1"; PA -d "${db}m1" -q -f "$mig" >/dev/null 2>&1
  m1="$(dinheiro "${db}m1" "UPDATE tint_formulas SET preco_final_sayersystem = 999 WHERE id = $TOMB")"
  novo_db "${db}m3"; PA -d "${db}m3" -q -f "$mig" >/dev/null 2>&1
  m3="$(dinheiro "${db}m3" "$INS_CARIMBADA")"
  novo_db "${db}m10"; PA -d "${db}m10" -q -f "$mig" >/dev/null 2>&1
  m10="$(dinheiro "${db}m10" "$REN_SUB1")"
  n="$(PA -d "$db" -tA 2>&1 <<'SQL'
DO $$
DECLARE v jsonb; r record;
BEGIN
  v := tint_promote_sync_run('11111111-0000-0000-0000-000000000003');
  SELECT f.desativada_em IS NOT NULL AS inativa, f.desativada_motivo, f.preco_final_sayersystem INTO r
    FROM tint_formulas f WHERE f.desativada_motivo IS NOT NULL AND f.cor_id = 'COR1';
  RAISE NOTICE 'N=%/%/%/%/%/%', r.inativa, r.preco_final_sayersystem,
    EXISTS (SELECT 1 FROM tint_formulas WHERE cor_id = 'COR2' AND desativada_em IS NULL),
    EXISTS (SELECT 1 FROM tint_formulas WHERE cor_id = 'COR3' AND desativada_em IS NULL),
    v->>'tombstones_fase5_preservados', v->>'promovidas';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'N=ERRO:%:%', SQLSTATE, SQLERRM;
END $$;
SQL
)"
  n="$(printf '%s\n' "$n" | grep -E '^(NOTICE:  )?N=' | sed 's/^NOTICE:  //')"
  echo "$v | DIN=$m1,$m3,$m10 | $n"
}

T1_ESPERADO="P1=BLOQ P2=BLOQ P3=BLOQ P4=BLOQ P5=BLOQ P6=PASSOU P7=BLOQ P8=PASSOU P9=BLOQ P10=BLOQ P11=PASSOU | DIN=123.45/123.45,123.45/123.45,123.45/123.45 | N=t/123.45/t/t/1/3"

echo "════ T1 — controle VERDE (migration real) ════"
S1="$(suite "$MIG" t1)"
if [ "$S1" = "$T1_ESPERADO" ]; then ok "migration real: P1-P5,P7,P9 barrados; no-op e reversão com GUC passam; piso intacto; promote segue: [$S1]"; else bad "migration real reprovou: [$S1] (esperado [$T1_ESPERADO])"; fi
if grep -qx 'TINT_TOMBSTONE_FASE5_IMUTAVEL_OK' "$TMP/t1.out"; then
  ok "apply imprime o marcador de fim (a pós-condição executou o UPDATE e viu o 42501)"
else
  bad "marcador de fim ausente: [$(tr '\n' ' ' < "$TMP/t1.out")]"
fi

echo "════ T2 — re-apply idempotente ════"
if R2="$(PA -d t1 -tA -f "$MIG" 2>&1)"; then
  case "$R2" in
    *TINT_TOMBSTONE_FASE5_IMUTAVEL_OK*)
      NT="$(PA -d t1 -tA -c "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tint_formulas'::regclass AND NOT tgisinternal")"
      if [ "$NT" = "3" ]; then ok "re-apply ok e continua com exatamente 3 triggers"; else bad "re-apply deixou $NT triggers"; fi ;;
    *) bad "re-apply sem marcador: [$R2]" ;;
  esac
else
  bad "re-apply falhou: [$R2]"
fi

echo "════ T3 — pós-condição morde (trigger desabilitado ANTES do re-apply ⇒ o apply tem de abortar) ════"
novo_db t3
# Espelho que desabilita 1 trigger antes da pós-condição: a checagem de catálogo tem de reprovar.
python3 - "$MIG" "$TMP/t3.sql" <<'PY'
import sys
t = open(sys.argv[1]).read()
alvo = "-- Pós-condição: catálogo + EXECUÇÃO"
assert t.count(alvo) == 1, "âncora da pós-condição não encontrada"
open(sys.argv[2], "w").write(t.replace(alvo, "ALTER TABLE public.tint_formulas DISABLE TRIGGER trg_tint_formulas_tombstone_fase5_upd;\n" + alvo))
PY
if R3="$(PA -d t3 -tA -f "$TMP/t3.sql" 2>&1)"; then
  bad "T3: apply com trigger desabilitado PASSOU: [$R3]"
else
  case "$R3" in
    *"esperava 3 triggers do tombstone habilitados, achei 2"*) ok "pós-condição aborta o apply quando um trigger não está habilitado" ;;
    *) bad "T3: abortou por outro motivo: [$R3]" ;;
  esac
fi

# ── falsificações: espelhos sabotados em tmp, cada uma tem de derrubar EXATAMENTE as suas sondas ──
falsifica() {  # $1 = rótulo, $2 = python que transforma o texto t, $3 = vetor esperado (sabotado)
  local rot="$1" py="$2" esperado="$3" sab="$TMP/$1.sql" sf
  python3 - "$MIG" "$sab" "$py" <<'PY'
import sys
src, dst, code = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(src).read(); antes = t
exec(code)
assert t != antes, "sabotagem não casou o alvo"
open(dst, "w").write(t)
PY
  sf="$(suite "$sab" "$(echo "$rot" | tr "[:upper:]" "[:lower:]")")"
  if [ "$sf" = "$esperado" ]; then ok "$rot: sabotagem derruba o esperado: [$sf]"; else bad "$rot: [$sf] (esperado [$esperado])"; fi
}

# A pós-condição executa um UPDATE no tombstone: nos espelhos que sabotam o UPDATE ela abortaria o
# apply antes das sondas. Nesses, a sabotagem também remove o bloco da execução (fica só o catálogo).
SEM_EXEC='t = t.replace("    UPDATE public.tint_formulas\n       SET preco_final_sayersystem = preco_final_sayersystem + 1\n     WHERE id = v_id;\n    RAISE EXCEPTION", "    PERFORM 1;\n    IF false THEN RAISE EXCEPTION")
t = t.replace("o trigger não morde'"'"', v_id;", "o trigger não morde'"'"', v_id; END IF;")'

echo "════ F1 — WHEN do UPDATE neutralizado (o trigger de UPDATE nunca dispara) ════"
falsifica F1 "t = t.replace(\"WHEN (OLD.desativada_motivo = 'fase5_geracao_legada' OR NEW.desativada_motivo = 'fase5_geracao_legada')\", 'WHEN (false)')
$SEM_EXEC" \
  "P1=PASSOU P2=PASSOU P3=BLOQ P4=BLOQ P5=PASSOU P6=PASSOU P7=PASSOU P8=PASSOU P9=PASSOU P10=BLOQ P11=PASSOU | DIN=999/999,123.45/123.45,123.45/123.45 | N=t/123.45/t/t/1/3"

echo "════ F2 — trigger de INSERT removido ════"
falsifica F2 "t = t.replace(\"WHEN (NEW.desativada_motivo = 'fase5_geracao_legada')\n\", 'WHEN (false)\n', 1)" \
  "P1=BLOQ P2=BLOQ P3=PASSOU P4=BLOQ P5=BLOQ P6=PASSOU P7=BLOQ P8=PASSOU P9=BLOQ P10=BLOQ P11=PASSOU | DIN=123.45/123.45,999/999,123.45/123.45 | N=t/123.45/t/t/1/3"

echo "════ F3 — trigger de DELETE removido ════"
falsifica F3 "t = t.replace(\"BEFORE DELETE ON public.tint_formulas\n  FOR EACH ROW\n  WHEN (OLD.desativada_motivo = 'fase5_geracao_legada')\", 'BEFORE DELETE ON public.tint_formulas\n  FOR EACH ROW\n  WHEN (false)')" \
  "P1=BLOQ P2=BLOQ P3=BLOQ P4=PASSOU P5=BLOQ P6=PASSOU P7=BLOQ P8=PASSOU P9=BLOQ P10=BLOQ P11=PASSOU | DIN=123.45/123.45,123.45/123.45,123.45/123.45 | N=t/123.45/t/t/1/3"

echo "════ F4 — escape SEM a checagem de role (authenticated com o GUC passaria) ════"
falsifica F4 "t = t.replace(\"     AND current_user NOT IN ('anon', 'authenticated') THEN\", '     THEN')" \
  "P1=BLOQ P2=BLOQ P3=BLOQ P4=BLOQ P5=BLOQ P6=PASSOU P7=BLOQ P8=PASSOU P9=PASSOU P10=BLOQ P11=PASSOU | DIN=123.45/123.45,123.45/123.45,123.45/123.45 | N=t/123.45/t/t/1/3"

echo "════ F5 — WHEN do trigger da subcoleção '1' neutralizado ════"
falsifica F5 "t = t.replace(\"  WHEN (OLD.id_subcolecao_sayersystem = '1'\n\", '  WHEN (false AND OLD.id_subcolecao_sayersystem = \\'1\\'\n')" \
  "P1=BLOQ P2=BLOQ P3=BLOQ P4=BLOQ P5=BLOQ P6=PASSOU P7=BLOQ P8=PASSOU P9=BLOQ P10=PASSOU P11=PASSOU | DIN=123.45/123.45,123.45/123.45,∅/∅ | N=t/123.45/t/t/1/3"

echo ""
echo "PASS=$PASSOU  FAIL=$FALHAS"   # recibo lido pelo db/roda-nucleo-ci.sh
if [ "$FALHAS" -eq 0 ]; then
  echo "TOMBSTONE_FASE5_IMUTAVEL_PROVA_OK"
else
  echo "TOMBSTONE_FASE5_IMUTAVEL_PROVA_FALHOU ($FALHAS)"; exit 1
fi

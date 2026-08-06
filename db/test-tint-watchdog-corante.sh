#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — tint_watchdog_corante_check() (Fase 5b#2, PR 1)                  ║
# ║  bash db/test-tint-watchdog-corante.sh > /tmp/t.log 2>&1; echo "exit=$?"       ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  O QUE PROVA (a migration 20260727150000):                                     ║
# ║   A1 corante impagável EM USO  -> alerta criado (fin_alertas + e-mail)         ║
# ║   A2 corante impagável FORA de uso -> NÃO alerta      (precisão > recall)      ║
# ║   A3 impagável só em fórmula DESATIVADA -> NÃO alerta (precisão > recall)      ║
# ║   A4 marcador sync_state avança em sucesso COMPLETO   (Codex: "verde por       ║
# ║      construção" — sem last_success_at, ausência de alerta não é saúde)        ║
# ║   A5 volta a zero -> dismiss                                                   ║
# ║   A6 AGRAVAMENTO: 2o corante cai com alerta aberto -> atualiza + re-emite      ║
# ║      (Codex [P1]: ON CONFLICT DO NOTHING deixaria o 2o MUDO)                   ║
# ║   A7 severidade escala com o nº de fórmulas atingidas (Codex [P2])             ║
# ║   A8 dead-man cruzado NÃO alarma quando a Camada B ainda não existe            ║
# ║   A9 marcador da Camada B stale (>13h) -> alerta watchdog parado               ║
# ║  FALSIFICAÇÕES (cada uma declara o CONJUNTO EXATO que derruba):                ║
# ║   F1 remove o filtro de USO            -> {A2,A3}                              ║
# ║   F2 remove `ativo` do predicado       -> {A1}                                 ║
# ║   F3 remove o bloco de agravamento     -> {A6}                                 ║
# ║   F4 remove o marcador de sucesso      -> {A4}                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="tintwd"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0; FALHAS=()
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); FALHAS+=("$1"); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ══ ZONA 1 — pré-requisitos (o que a migration LÊ mas não cria) ══
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS cron;
-- a migration chama cron.schedule; no PG17 local não há pg_cron. Stub que REGISTRA
-- a chamada, para o assert provar que o cron foi armado com o schedule certo.
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint; BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd) RETURNING jobid INTO v;
  RETURN v;
END $f$;

CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  valor_unitario numeric, ativo boolean, descricao text, codigo text);
CREATE TABLE public.tint_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_product_id uuid, volume_total_ml numeric, ativo boolean DEFAULT true);
CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben', sku_id uuid, cor_id uuid,
  desativada_em timestamptz, desativada_motivo text);
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid, corante_id uuid, qtd_ml numeric);
CREATE TABLE public.fin_alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, tipo text NOT NULL, severidade text NOT NULL, mensagem text NOT NULL,
  contexto jsonb, criado_em timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz, email_enfileirado_em timestamptz);
-- o UNIQUE PARCIAL real de prod: é ele que faz o ON CONFLICT DO NOTHING ser anti-spam
CREATE UNIQUE INDEX fin_alertas_unique_ativo ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE TABLE public.fornecedor_alerta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text, tipo text, severidade text, titulo text, mensagem text, status text,
  criado_em timestamptz DEFAULT now());
CREATE TABLE public.sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas',
  last_sync_at timestamptz, status text DEFAULT 'idle', error_message text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX sync_state_entity_account_uq ON public.sync_state (entity_type, account);
SQL

# ══ ZONA 2 — a migration REAL (Lei #1: nunca um stub da lógica) ══
MIG="$REPO_ROOT/supabase/migrations/20260727150000_tint_watchdog_corante_impagavel.sql"
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }
P -q -f "$MIG"
echo "=== migration aplicada ==="

# guarda o corpo verdadeiro, para restaurar depois de cada sabotagem
P -q -c "CREATE TABLE _bkp AS SELECT pg_get_functiondef('public.tint_watchdog_corante_check()'::regprocedure) AS def;"
restaura() { Pq -c "SELECT def FROM _bkp;" > /tmp/_wd_real.sql; P -q -f /tmp/_wd_real.sql; }

# ══ ZONA 3 — seeds ══
# C_OK: corante saudável (nunca deve alarmar).  C_INAT: omie INATIVO (impagável).
# C_SEMCUSTO: valor_unitario 0.  C_ORFAO: impagável mas FORA de uso.
# C_MORTA: impagável, usado só por fórmula DESATIVADA.
P -q <<'SQL'
INSERT INTO public.omie_products (id, valor_unitario, ativo, descricao) VALUES
 ('a0000000-0000-0000-0000-000000000001', 600, true,  'CONCENTRADO OK'),
 ('a0000000-0000-0000-0000-000000000002', 600, false, 'CONCENTRADO INATIVO'),
 ('a0000000-0000-0000-0000-000000000003', 0,    true, 'CONCENTRADO SEM CUSTO'),
 ('a0000000-0000-0000-0000-000000000004', 0,    true, 'CONCENTRADO ORFAO'),
 ('a0000000-0000-0000-0000-000000000005', 0,    true, 'CONCENTRADO SO EM MORTA');
INSERT INTO public.tint_corantes (id, omie_product_id, volume_total_ml) VALUES
 ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001', 810),
 ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002', 810),
 ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000003', 810),
 ('c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000004', 810),
 ('c0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000005', 810);
-- F_ATIVA usa C_OK e C_INAT; F_MORTA (desativada) usa C_MORTA; C_ORFAO não é usado por ninguém.
INSERT INTO public.tint_formulas (id, account, sku_id, cor_id, desativada_em, desativada_motivo) VALUES
 ('f0000000-0000-0000-0000-000000000001','oben','5c000000-0000-0000-0000-000000000001'::uuid,'c0100000-0000-0000-0000-000000000001'::uuid, NULL, NULL),
 ('f0000000-0000-0000-0000-000000000002','oben','5c000000-0000-0000-0000-000000000001'::uuid,'c0100000-0000-0000-0000-000000000002'::uuid, now(), 'fase5_geracao_legada');
INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml) VALUES
 ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001', 10),
 ('f0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000005', 10);
SQL

reset_estado() {
  P -q -c "DELETE FROM public.fin_alertas; DELETE FROM public.fornecedor_alerta; DELETE FROM public.sync_state;"
}
# liga/desliga um corante impagável DENTRO de uma fórmula ATIVA
usa_na_ativa() { P -q -c "INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml) VALUES ('f0000000-0000-0000-0000-000000000001','$1', 5);"; }
tira_da_ativa() { P -q -c "DELETE FROM public.tint_formula_itens WHERE formula_id='f0000000-0000-0000-0000-000000000001' AND corante_id='$1';"; }

alertas_ativos() { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
emails()         { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%$1%';"; }

# ══ ZONA 4 — a suíte (roda inteira; usada também sob sabotagem) ══
roda_suite() {
  PASS=0; FAIL=0; FALHAS=()

  # A2/A3 primeiro: estado SAUDÁVEL (só C_OK em uso). C_ORFAO e C_MORTA são impagáveis
  # mas não estão em fórmula ativa -> o watchdog tem de ficar MUDO.
  reset_estado
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A2 impagavel FORA de uso nao alarma" "$(alertas_ativos tint_corante_impagavel)" "0"
  eq "A3 impagavel so em formula DESATIVADA nao alarma" "$(emails 'corante sem custo')" "0"
  eq "A4 marcador avanca em sucesso" "$(Pq -c "SELECT COALESCE(status,'AUSENTE') FROM public.sync_state WHERE entity_type='tint_watchdog_corante';")" "complete"
  eq "A8 dead-man nao alarma sem a Camada B" "$(alertas_ativos tint_watchdog_fase5_parado)" "0"

  # A1: o corante INATIVO entra numa fórmula ativa -> tem de alarmar
  usa_na_ativa 'c0000000-0000-0000-0000-000000000002'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A1 impagavel EM USO alarma" "$(alertas_ativos tint_corante_impagavel)" "1"
  eq "A1b e-mail enfileirado" "$(emails 'corante sem custo')" "1"
  eq "A7 severidade aviso com poucas formulas" "$(Pq -c "SELECT severidade FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "aviso"

  # A6: um SEGUNDO corante cai com o alerta ABERTO -> tem de atualizar e re-emitir
  usa_na_ativa 'c0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A6 agravamento atualiza o contexto" "$(Pq -c "SELECT contexto->>'corantes' FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "2"
  eq "A6b agravamento re-emite e-mail" "$(emails 'AGRAVOU')" "1"

  # A5: tudo volta ao normal -> dismiss
  tira_da_ativa 'c0000000-0000-0000-0000-000000000002'
  tira_da_ativa 'c0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A5 dismiss quando volta a zero" "$(alertas_ativos tint_corante_impagavel)" "0"

  # A9: marcador da Camada B velho -> dead-man cruzado dispara
  P -q -c "INSERT INTO public.sync_state (entity_type, account, last_sync_at, status) VALUES ('tint_watchdog_fase5','oben', now() - interval '20 hours','complete');"
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A9 dead-man cruzado dispara com B parada" "$(alertas_ativos tint_watchdog_fase5_parado)" "1"
}

echo "=== BASELINE (migration real) ==="
roda_suite
BASE_PASS=$PASS; BASE_FAIL=$FAIL
echo "--- baseline: $BASE_PASS ok / $BASE_FAIL falhas ---"
if [ "$BASE_FAIL" -ne 0 ]; then
  echo "BASELINE VERMELHO — a migration real nao passa. Falhas: ${FALHAS[*]}"
  exit 1
fi
echo "TOTAL_ASSERTS=$BASE_PASS"

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO (Lei #3) — sabota a migration em UM ponto e exige o conjunto
# EXATO de asserts vermelhos. "Falsificação prova que o assert tem dente; só
# instrumentar o RESULTADO prova que ele é ESPECÍFICO" (lição #1505).
# Cada sabotagem nasce por substituição sobre a migration REAL (diferença de
# exatamente 1 ponto), e PROVA QUE APLICOU antes de medir — senão "não casou
# nada" se leria como "o assert não tem dente".
# ══════════════════════════════════════════════════════════════════════════════
FALSIF_ERR=0

sabota_e_mede() {   # $1=rotulo  $2=busca  $3=troca  $4..=asserts esperados
  local rot="$1" busca="$2" troca="$3"; shift 3
  local esperado="$*"
  local sab="/tmp/_wd_sab_${rot}.sql"

  python3 - "$MIG" "$sab" "$busca" "$troca" <<'PY'
import sys
src, dst, busca, troca = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src).read()
n = s.count(busca)
if n != 1:
    sys.stderr.write("ANCORA NAO UNICA (%d ocorrencias)\n" % n); sys.exit(3)
open(dst, "w").write(s.replace(busca, troca))
PY
  if [ $? -ne 0 ]; then
    echo "  FALSIF XX  $rot: a sabotagem NAO aplicou (ancora nao casou) — INVALIDA, nao leia como 'sem dente'"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi
  # prova que aplicou de fato
  if ! command grep -q -- "$troca" "$sab"; then
    echo "  FALSIF XX  $rot: texto sabotado ausente no arquivo — INVALIDA"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi

  P -q -f "$sab" >/dev/null 2>&1
  roda_suite > /tmp/_wd_suite.log 2>&1

  local caidos=""
  if [ "${#FALHAS[@]}" -gt 0 ]; then
    for f in "${FALHAS[@]}"; do caidos="$caidos $(printf '%s' "$f" | awk '{print $1}')"; done
  fi
  caidos="$(printf '%s' "$caidos" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  local esp="$(printf '%s' "$esperado" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

  if [ "$caidos" = "$esp" ]; then
    echo "  FALSIF OK  $rot derrubou EXATAMENTE [$caidos]"
  else
    echo "  FALSIF XX  $rot: esperado [$esp], veio [$caidos]"
    FALSIF_ERR=$((FALSIF_ERR+1))
  fi
  restaura   # volta a versão verdadeira antes da próxima
}

echo "=== FALSIFICACOES ==="

# F1 — remove o filtro de USO: corante impagável que ninguém dosa passaria a alarmar.
#      Prova que A2/A3 (precisão > recall) têm dente.
#      ⚠️ O conjunto é MAIOR que {A2,A3}, e isso é CASCATA LÓGICA de uma sabotagem
#      só — não de duas. Sem o filtro, os impagáveis órfãos (C_ORFAO/C_MORTA)
#      contam SEMPRE: a chave nunca volta a zero (derruba o dismiss A5) e a
#      contagem nunca sobe de 1->2 (derruba o agravamento A6/A6b). Declarado como
#      medido: prever {A2,A3} e "consertar" o harness para casar seria repintar
#      de verde uma sabotagem que de fato morde mais fundo.
sabota_e_mede "F1" \
  "AND EXISTS (SELECT 1 FROM tint_formula_itens fi
                     JOIN tint_formulas f ON f.id = fi.formula_id
                    WHERE fi.corante_id = c.id
                      AND f.desativada_em IS NULL AND f.sku_id IS NOT NULL)" \
  "AND true" \
  A2 A3 A5 A6 A6b

# F2 — remove o 'ativo' do predicado: o corante INATIVO deixa de ser impagável.
#      Prova que a detecção cobre inatividade no Omie, não só custo zero.
sabota_e_mede "F2" \
  "AND COALESCE(op.ativo, false)" \
  "AND true" \
  A1 A1b A7 A6 A6b

# F3 — mata o ramo de agravamento: o 2o corante caindo com alerta aberto fica MUDO.
#      Prova que o fix do achado [P1] do Codex tem dente.
sabota_e_mede "F3" \
  "IF v_ruins > COALESCE(v_ant_n, 0) THEN" \
  "IF false THEN" \
  A6 A6b

# F4 — grava o marcador sob outro nome: o dead-man perde o last_success_at.
#      Prova que A4 mede mesmo o avanço do marcador.
sabota_e_mede "F4" \
  "'tint_watchdog_corante', v_conta" \
  "'tint_watchdog_NOME_ERRADO', v_conta" \
  A4

# ══ fecho: re-roda a suíte na versão REAL e exige verde ══
echo "=== VERIFICACAO FINAL (migration real restaurada) ==="
roda_suite
echo "--- final: $PASS ok / $FAIL falhas | falsificacoes invalidas/erradas: $FALSIF_ERR ---"
if [ "$FAIL" -ne 0 ] || [ "$FALSIF_ERR" -ne 0 ]; then
  echo "RESULTADO: VERMELHO"
  exit 1
fi
echo "RESULTADO: VERDE — $PASS asserts + 4 falsificacoes com conjunto exato"

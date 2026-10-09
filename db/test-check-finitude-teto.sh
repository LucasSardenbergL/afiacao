#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — TETO DE FAIXA nos CHECKs de finitude                            ║
# ║  migration: supabase/migrations/20261009120000_check_finitude_teto_faixa.sql   ║
# ║  Parte do estado REAL de prod em 2026-10-09: as constraints do #1691 aplicadas.║
# ║                                                                                ║
# ║  Corrige os 3 defeitos de harness apontados pelo challenge Codex no #1691:     ║
# ║   1. total esperado FIXO (o denominador é o tell de "não rodou nada");         ║
# ║   2. sonda TRIESTADO: aceitou / rejeitou_23514 / erro_inesperado (= FAIL);     ║
# ║   3. aborto ancorado em 23514 + estado residual afirmado explicitamente.       ║
# ║  rodar: bash db/test-check-finitude-teto.sh > /tmp/t.log 2>&1; echo $?         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PORT="${PGPORT_TEST:-5473}"
DATA="$(mktemp -d "/tmp/pgtest-teto.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
MIG="$REPO_ROOT/supabase/migrations/20261009120000_check_finitude_teto_faixa.sql"
TOTAL_ESPERADO=33

[ -x "$PGBIN/initdb" ] || { echo "postgresql@17 ausente"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
LC_ALL=C "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
LC_ALL=C "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-teto.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tAq "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# sonda TRIESTADO: imprime ACEITOU | REJEITOU_23514 | INESPERADO_<sqlstate>
sonda() {
  local out
  out=$(P -tA 2>&1 <<SQL || true
DO \$do\$
BEGIN
  $1
  RAISE NOTICE 'SONDA_ACEITOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '23514' THEN RAISE NOTICE 'SONDA_REJEITOU_23514';
  ELSE RAISE NOTICE 'SONDA_INESPERADO_%', SQLSTATE; END IF;
END \$do\$;
SQL
)
  case "$out" in
    *SONDA_REJEITOU_23514*) echo REJEITOU_23514 ;;
    *SONDA_ACEITOU*)        echo ACEITOU ;;
    *SONDA_INESPERADO_*)    echo "INESPERADO_$(printf '%s' "$out" | sed -n 's/.*SONDA_INESPERADO_\([0-9A-Z]*\).*/\1/p' | head -1)" ;;
    *)                      echo "INESPERADO_SEMSAIDA" ;;
  esac
}
deve() { local v; v=$(sonda "$3"); eq "$1" "$v" "$2"; }   # deve <desc> <ACEITOU|REJEITOU_23514> <sql>

T_INS() { echo "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),1,$1);"; }
C_INS() { echo "INSERT INTO public.cmc_snapshot (cmc) VALUES ($1);"; }
temcon() { Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='$1';"; }
valida() { Pq -c "SELECT coalesce((SELECT convalidated::text FROM pg_constraint WHERE conname='$1'),'ausente');"; }

# ── ESTADO DE PROD HOJE: tabelas + as constraints do #1691, verbatim do pg_get_constraintdef ──
estado_prod() {
P -q <<'SQL'
DROP TABLE IF EXISTS public.tint_formula_itens, public.cmc_snapshot;
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formula_id uuid NOT NULL, corante_id uuid NOT NULL,
  ordem integer NOT NULL, qtd_ml numeric NOT NULL, created_at timestamptz DEFAULT now(),
  CONSTRAINT tint_formula_itens_qtd_ml_finita
    CHECK (((qtd_ml > (0)::numeric) AND (qtd_ml <> 'NaN'::numeric) AND (qtd_ml < 'Infinity'::numeric))));
CREATE TABLE public.cmc_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cmc numeric NOT NULL,
  CONSTRAINT cmc_snapshot_cmc_check
    CHECK (((cmc > (0)::numeric) AND (cmc <> 'NaN'::numeric) AND (cmc < 'Infinity'::numeric))));
-- dado real: inclui o MÁXIMO medido em prod (171143.111111 / 218715.88), que TEM de passar no teto
INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml)
  SELECT gen_random_uuid(), gen_random_uuid(), g, (g*1.5)::numeric FROM generate_series(1,300) g;
INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml)
  VALUES (gen_random_uuid(),gen_random_uuid(),1,171143.111111),(gen_random_uuid(),gen_random_uuid(),1,0.000050);
INSERT INTO public.cmc_snapshot (cmc) SELECT (g*0.75)::numeric FROM generate_series(1,200) g;
INSERT INTO public.cmc_snapshot (cmc) VALUES (218715.88),(0.01);
SQL
}

echo "=== PG17 :$PORT (LC_ALL=$LC_ALL) ==="
estado_prod

# C0 — CARACTERIZAÇÃO do defeito no estado de prod (premissa da migration; se virar, ela perde o motivo)
echo "-- caracterizacao (estado de prod, ANTES da migration) --"
deve "C1 [defeito] CHECK do #1691 ACEITA 1e100000 em qtd_ml" ACEITOU "$(T_INS "'1e100000'::numeric")"
deve "C2 [defeito] CHECK do #1691 ACEITA 1e100000 em cmc"    ACEITOU "$(C_INS "'1e100000'::numeric")"
P -q -c "DELETE FROM public.tint_formula_itens WHERE qtd_ml > 1000000; DELETE FROM public.cmc_snapshot WHERE cmc > 10000000;"

# ── aplica a migration REAL ──
P -q -f "$MIG" >/dev/null 2>&1
echo "-- asserts (pos-migration) --"
eq "A1 tint: constraint nova existe"            "$(temcon tint_formula_itens_qtd_ml_faixa)" 1
eq "A2 tint: constraint nova VALIDADA"          "$(valida tint_formula_itens_qtd_ml_faixa)" true
eq "A3 tint: constraint antiga (sem teto) saiu" "$(temcon tint_formula_itens_qtd_ml_finita)" 0
eq "A4 cmc: constraint nova existe e validada"  "$(valida cmc_snapshot_cmc_faixa)" true
eq "A5 cmc: constraint antiga saiu"             "$(temcon cmc_snapshot_cmc_check)" 0
deve "A6 tint aceita dose normal"               ACEITOU        "$(T_INS 12.5)"
deve "A7 tint aceita o MAXIMO real de prod"     ACEITOU        "$(T_INS 171143.111111)"
deve "A8 tint aceita exatamente o teto"         ACEITOU        "$(T_INS 1000000)"
deve "A9 tint rejeita 1e100000 [o achado]"      REJEITOU_23514 "$(T_INS "'1e100000'::numeric")"
deve "A10 tint rejeita teto+0.000001"           REJEITOU_23514 "$(T_INS 1000000.000001)"
deve "A11 tint rejeita NaN"                     REJEITOU_23514 "$(T_INS "'NaN'::numeric")"
deve "A12 tint rejeita Infinity"                REJEITOU_23514 "$(T_INS "'Infinity'::numeric")"
deve "A13 tint rejeita zero"                    REJEITOU_23514 "$(T_INS 0)"
deve "A14 cmc aceita o MAXIMO real de prod"     ACEITOU        "$(C_INS 218715.88)"
deve "A15 cmc rejeita 1e100000 [o achado]"      REJEITOU_23514 "$(C_INS "'1e100000'::numeric")"
deve "A16 cmc rejeita NaN"                      REJEITOU_23514 "$(C_INS "'NaN'::numeric")"
deve "A17 cmc rejeita Infinity"                 REJEITOU_23514 "$(C_INS "'Infinity'::numeric")"

# idempotência: re-aplicar não falha nem duplica
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A18 re-aplicar a migration passa"; else bad "A18 re-aplicar FALHOU"; fi
eq "A19 re-aplicar nao duplica"                 "$(temcon tint_formula_itens_qtd_ml_faixa)" 1
eq "A20 re-aplicar mantem validada"             "$(valida tint_formula_itens_qtd_ml_faixa)" true

# A21 — P1 do Codex: o arquivo INTEIRO colado como UMA mensagem (como um SQL Editor faz) também aplica.
# Os BEGIN/COMMIT explícitos fecham a transação do ADD antes do VALIDATE.
estado_prod
if P -q -c "$(cat "$MIG")" >/dev/null 2>&1; then ok "A21 arquivo inteiro numa mensagem unica aplica"; else bad "A21 mensagem unica FALHOU"; fi
eq "A22 mensagem unica: tint validada"          "$(valida tint_formula_itens_qtd_ml_faixa)" true

# A23-25 — dado sujo preexistente: o VALIDATE aborta com 23514, o residual é CONHECIDO e AINDA GUARDA
estado_prod
P -q -c "ALTER TABLE public.tint_formula_itens DROP CONSTRAINT tint_formula_itens_qtd_ml_finita;
         INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),1,'1e100000'::numeric);"
SAIDA=$(P -q -f "$MIG" 2>&1 || true)
case "$SAIDA" in *"is violated by some row"*) ok "A23 dado sujo: VALIDATE aborta por violacao (23514)";; *) bad "A23 aborto nao foi por violacao: $(printf '%s' "$SAIDA" | tr '\n' ' ' | cut -c1-140)";; esac
eq "A24 residual: constraint nova existe NOT VALID" "$(valida tint_formula_itens_qtd_ml_faixa)" false
deve "A25 residual NOT VALID ainda barra escrita nova" REJEITOU_23514 "$(T_INS "'1e100000'::numeric")"

# ── FALSIFICAÇÃO — baseline com TOTAL FIXO antes de sabotar ──
echo "-- falsificacao --"
if [ "$FAIL" != 0 ] || [ "$PASS" != 27 ]; then echo "  ABORTA: baseline invalido ($PASS ok / $FAIL fail; esperado 27/0)"; exit 1; fi
echo "  baseline VERDE: 27/27"
MIG_ORIG="$MIG"
SAB="$(mktemp /tmp/mig-sabotada.XXXXXX.sql)"
sabota() {  # $1 = sed que remove UM predicado; tem de provar que aplicou
  sed "$1" "$MIG_ORIG" > "$SAB"
  if cmp -s "$MIG_ORIG" "$SAB"; then bad "F-sabotagem nao aplicou ($1)"; return 1; fi
  estado_prod; P -q -f "$SAB" >/dev/null 2>&1
}
# F1 — remove o teto do tint: 1e100000 tem de ENTRAR (A9 tem dente)
sabota 's/ AND qtd_ml <= 1000000//' && { v=$(sonda "$(T_INS "'1e100000'::numeric")"); eq "F1 sem teto no tint, 1e100000 ENTRA" "$v" ACEITOU; }
# F2 — remove o teto do cmc: A15 tem dente
sabota 's/ AND cmc <= 10000000//'   && { v=$(sonda "$(C_INS "'1e100000'::numeric")"); eq "F2 sem teto no cmc, 1e100000 ENTRA" "$v" ACEITOU; }
# F3 — a sonda distingue erro INESPERADO de rejeição (o defeito do probe_rej antigo)
estado_prod; P -q -f "$MIG" >/dev/null 2>&1
v=$(sonda "INSERT INTO public.tabela_que_nao_existe VALUES (1);"); eq "F3 sonda triestado marca erro inesperado" "$v" INESPERADO_42P01
# F4 — controle: a migration real, depois das sabotagens, volta a barrar
v=$(sonda "$(T_INS "'1e100000'::numeric")"); eq "F4 controle: migration real barra de novo" "$v" REJEITOU_23514
# F6 — a POSTCONDIÇÃO tem dente: rodada sobre o estado de prod SEM teto, tem de abortar
estado_prod
POST="$(sed -n '/^DO \$post\$/,$p' "$MIG")"
SAIDA=$(P -q -c "$POST" 2>&1 || true)
case "$SAIDA" in *POSTCONDICAO_FALHOU*) ok "F6 postcondicao aborta no estado sem teto";; *) bad "F6 postcondicao NAO abortou: $(printf '%s' "$SAIDA" | tr '\n' ' ' | cut -c1-120)";; esac
# F5 — o total fixo tem dente: um assert a menos seria detectado
eq "F5 contagem fixa: total final confere" "$((PASS + FAIL + 1))" "$TOTAL_ESPERADO"
rm -f "$SAB"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail (esperado $TOTAL_ESPERADO)"
[ "$FAIL" = 0 ] && [ "$PASS" = "$TOTAL_ESPERADO" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

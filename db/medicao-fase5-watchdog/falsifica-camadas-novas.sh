#!/usr/bin/env bash
# TEMPORÁRIO — sai do branch antes do PR. Falsificação das camadas NOVAS da test-tint-fase5-watchdog.sh.
# Controle verde na MESMA invocação; aborta antes da 1ª sabotagem se ele não for verde.
set -uo pipefail
WT="$1"; OUT="$2"; mkdir -p "$OUT"
PROVA="$WT/db/test-tint-fase5-watchdog.sh"
COPIA="$WT/db/_sab-f5wd.sh"
trap 'rm -f "$COPIA"' EXIT

roda() {  # roda <rotulo> <arquivo> -> rc no stdout, log em $OUT/<rotulo>.log
  local rot="$1" arq="$2"
  PGPORT_TEST="${PORTA_BASE:-5489}" bash "$arq" > "$OUT/$rot.log" 2>&1 && echo 0 || echo $?
}
sabota() {  # sabota <busca> <troca> — na CÓPIA; exige âncora única e a troca presente
  python3 - "$PROVA" "$COPIA" "$1" "$2" <<'PY'
import sys
src, dst, b, t = sys.argv[1:5]
s = open(src).read()
n = s.count(b)
if n != 1: sys.exit("ANCORA com %d ocorrencias: %r" % (n, b[:70]))
open(dst, "w").write(s.replace(b, t))
PY
}
veredito() { printf '%-28s %s\n' "$1" "$2"; }

# ── CONTROLE ──
rc="$(roda controle "$PROVA")"
if [ "$rc" != 0 ] || ! grep -qx 'PASS=31  FAIL=0' "$OUT/controle.log"; then
  veredito "CONTROLE" "NAO VERDE (rc=$rc) — aborto sem sabotar"; exit 3
fi
veredito "CONTROLE" "verde (rc=0, PASS=31 FAIL=0)"

# ── S1: a sessão do lock pega OUTRA chave -> a pré-condição tem de reprovar ──
sabota "SELECT pg_advisory_xact_lock(hashtext('tint_watchdog_fase5')); SELECT pg_sleep(60);" \
       "SELECT pg_advisory_xact_lock(hashtext('outra_chave')); SELECT pg_sleep(60);" || { veredito S1 "INVALIDA"; exit 4; }
rc="$(roda s1 "$COPIA")"
n_xx="$(grep -c '^  XX  ' "$OUT/s1.log" || true)"
if [ "$rc" != 0 ] && [ "$n_xx" = 1 ] && grep -q 'BASELINE VERMELHO.*B14 pre-condicao' "$OUT/s1.log"; then
  veredito "S1 pre-condicao" "VERMELHA pelo motivo certo (rc=$rc, 1 assert vermelho: a pre-condicao)"
else veredito "S1 pre-condicao" "ERRADA (rc=$rc, XX=$n_xx)"; fi

# ── S2: o encerramento não acha a sessão -> a pós-condição tem de reprovar ──
sabota "WHERE application_name = 'f5wd_lock';" "WHERE application_name = 'ninguem';" || { veredito S2 "INVALIDA"; exit 4; }
rc="$(roda s2 "$COPIA")"
if [ "$rc" != 0 ] && grep -q 'BASELINE VERMELHO.*B14 pos-condicao' "$OUT/s2.log"; then
  veredito "S2 pos-condicao" "VERMELHA pelo motivo certo (rc=$rc)"
else veredito "S2 pos-condicao" "ERRADA (rc=$rc)"; fi

# ── S3: uma sabotagem com âncora que não casa -> FALSIF inválida entra no FAIL do recibo ──
sabota '  "v_conta, '"'"'tint_fase5_fonte_retirada'"'"', v_s2," \' \
       '  "v_conta, '"'"'NAO_CASA_NADA'"'"', v_s2," \' || { veredito S3 "INVALIDA"; exit 4; }
rc="$(roda s3 "$COPIA")"
if [ "$rc" != 0 ] && grep -q 'FALSIF XX  F2: a sabotagem NAO aplicou' "$OUT/s3.log" \
   && grep -qx 'PASS=31  FAIL=1' "$OUT/s3.log"; then
  veredito "S3 recibo+FALSIF_ERR" "VERMELHA pelo motivo certo (rc=$rc, PASS=31 FAIL=1)"
else veredito "S3 recibo+FALSIF_ERR" "ERRADA (rc=$rc)"; fi

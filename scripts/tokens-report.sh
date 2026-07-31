#!/usr/bin/env bash
# tokens-report.sh — painel de consumo de tokens do Claude Code (READ-ONLY).
#
# POR QUÊ: 82% do custo de token é ENTRADA de contexto (cache_read 52% +
# cache_write 29%), não geração (18%). Otimizar "resposta curta" mexe em 18%;
# medir e cortar contexto mexe em 82%. Este script é a régua — sem baseline
# não há como provar que uma otimização funcionou (regra da EVIDÊNCIA POSITIVA).
#
# Fonte: ~/.claude/projects/**/*.jsonl (campo message.usage de cada request).
# Nada sai da máquina; nenhum arquivo do projeto é alterado.
#
# Uso:
#   scripts/tokens-report.sh                 # últimos 30 dias
#   scripts/tokens-report.sh --dias 7        # janela menor (mais rápido)
#   scripts/tokens-report.sh --dias 0        # todo o histórico (lento)
#   scripts/tokens-report.sh --tsv X --pular-coleta   # reusa coleta anterior
#
# Preços = tabela pública da API (US$/MTok de input); output 5x, cache_write
# 1.25x (TTL 5min), cache_read 0.1x. O total é CUSTO-EQUIVALENTE de API — em
# plano de assinatura não é desembolso, serve para priorizar desperdício.
set -euo pipefail

DIAS=30
TSV=""
PULAR_COLETA=0
RAIZ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dias)         DIAS="${2:?--dias exige um número}"; shift 2 ;;
    --tsv)          TSV="${2:?--tsv exige um caminho}"; shift 2 ;;
    --pular-coleta) PULAR_COLETA=1; shift ;;
    -h|--help)      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opção desconhecida: $1 (use --help)" >&2; exit 2 ;;
  esac
done

[ -d "$RAIZ" ] || { echo "não encontrei $RAIZ" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq é necessário (brew install jq)" >&2; exit 1; }
[ -n "$TSV" ] || TSV="${TMPDIR:-/tmp}/tokens-report-$$.tsv"

# ---------------------------------------------------------------- coleta ----
if [ "$PULAR_COLETA" -eq 0 ]; then
  echo "coletando de $RAIZ (janela: ${DIAS} dias; 0 = tudo)..." >&2
  : > "$TSV"
  for dir in "$RAIZ"/*/; do
    [ -d "$dir" ] || continue
    # PULA SYMLINK. Existe um `projects -> ~/.claude/projects` (symlink para o
    # próprio pai): o glob `*/` o expande e o `find` com barra final RESOLVE o
    # link, varrendo todo o histórico de novo sob outro nome. Sem este guard o
    # relatório conta cada request DUAS VEZES (razão medida: exatamente 2.0000).
    [ -L "${dir%/}" ] && continue
    proj=$(basename "$dir")
    if [ "$DIAS" -gt 0 ]; then
      find "$dir" -name '*.jsonl' -type f -mtime "-${DIAS}" -print0 2>/dev/null
    else
      find "$dir" -name '*.jsonl' -type f -print0 2>/dev/null
    fi | while IFS= read -r -d '' f; do
      # 1 linha por request: projeto, dia, modelo, input, output, cache_w, cache_r, sessão
      jq -rc --arg p "$proj" '
        select(.message.usage != null)
        | [ $p,
            (.timestamp // "?")[0:10],
            (.message.model // "?"),
            (.message.usage.input_tokens // 0),
            (.message.usage.output_tokens // 0),
            (.message.usage.cache_creation_input_tokens // 0),
            (.message.usage.cache_read_input_tokens // 0),
            (.sessionId // "?")
          ] | @tsv' "$f" 2>/dev/null
    done
  done >> "$TSV"
fi

[ -s "$TSV" ] || { echo "nenhum request na janela de ${DIAS} dias." >&2; exit 0; }
echo "linhas coletadas: $(wc -l < "$TSV" | tr -d ' ')" >&2
echo >&2

# BSD awk (macOS) não tem asorti nem array multidimensional: o que precisa de
# ordem sai prefixado e é ordenado por `sort`. Locais = parâmetros extras.
PRECOS='
function pin(m,   _) {
  if (m ~ /fable|mythos/) return 10
  if (m ~ /opus/)         return 5
  if (m ~ /sonnet/)       return 3
  if (m ~ /haiku/)        return 1
  return 0
}
function custo(m, i, o, cw, cr,   q) {
  q = pin(m); return (i*q + o*q*5 + cw*q*1.25 + cr*q*0.1) / 1000000
}
'

# ------------------------------------------- 1. totais e decomposição -------
awk -F'\t' "$PRECOS"'
$3 == "<synthetic>" || $3 == "?" { next }
{
  c = custo($3,$4,$5,$6,$7); q = pin($3)
  T += c; R++; TK += $4 + $5 + $6 + $7
  CR += $7*q*0.1/1e6; CW += $6*q*1.25/1e6; OU += $5*q*5/1e6; IN += $4*q/1e6
}
END {
  if (R == 0) { print "  (sem requests faturáveis na janela)"; exit }
  printf "===== TOTAL (custo-equivalente de API) =====\n"
  printf "  requests      : %12d\n", R
  printf "  tokens        : %12.0f   (%.1f bilhões)\n", TK, TK/1e9
  printf "  US$           : %12.0f\n\n", T
  printf "  ONDE O TOKEN VAI\n"
  printf "    cache_read  : %9.0f  (%4.1f%%)  <- RELER contexto\n", CR, 100*CR/T
  printf "    cache_write : %9.0f  (%4.1f%%)\n", CW, 100*CW/T
  printf "    output      : %9.0f  (%4.1f%%)  <- gerar\n", OU, 100*OU/T
  printf "    input cru   : %9.0f  (%4.1f%%)\n", IN, 100*IN/T
  printf "    ENTRADA     : %9.0f  (%4.1f%%)\n", CR+CW+IN, 100*(CR+CW+IN)/T
}' "$TSV"

# ------------------------------------------------------- 2. por modelo ------
echo
echo "===== POR MODELO ====="
printf "  %-30s %8s %10s %8s\n" modelo reqs "US\$" "%"
awk -F'\t' "$PRECOS"'
$3 == "<synthetic>" || $3 == "?" { next }
{ c = custo($3,$4,$5,$6,$7); C[$3] += c; N[$3]++; T += c }
END { for (m in C) printf "%.4f\t%s\t%d\t%.1f\n", C[m], m, N[m], 100*C[m]/T }' "$TSV" \
  | sort -rn | awk -F'\t' '{printf "  %-30s %8s %10.0f %7.1f%%\n", $2, $3, $1, $4}'

# ------------------------------- 3. piso de contexto e concentração ---------
echo
awk -F'\t' "$PRECOS"'
$3 == "<synthetic>" || $3 == "?" { next }
{
  c = custo($3,$4,$5,$6,$7); ctx = $4 + $6 + $7
  SC[$8] += c; SR[$8]++; T += c
  # piso só de sessões principais: subagentes Haiku têm preâmbulo próprio,
  # bem menor, e diluiriam a média do que a sessão de verdade paga.
  if ($3 !~ /haiku/ && (!($8 in SM) || ctx < SM[$8])) SM[$8] = ctx
}
END {
  if (T == 0) exit
  print  "===== PISO DE CONTEXTO POR SESSÃO ====="
  print  "  (menor contexto visto na sessão = system prompt + tools + CLAUDE.md +"
  print  "   lista de skills; é relido em TODO request — cortá-lo rende em 100% deles)"
  for (s in SM) { n++; soma += SM[s] }
  if (n > 0) printf "  sessões principais: %d    piso médio: %.0f tokens\n", n, soma/n
  print  ""
  print  "===== CONCENTRAÇÃO POR TAMANHO DE SESSÃO ====="
  print  "  (custo cresce ~quadraticamente: o request N relê o que os N-1 acumularam)"
  for (s in SC) {
    if      (SR[s] >= 2000) f = "5. >=2000 req"
    else if (SR[s] >= 1000) f = "4. 1000-1999 "
    else if (SR[s] >=  300) f = "3. 300-999   "
    else if (SR[s] >=   50) f = "2. 50-299    "
    else                    f = "1. <50       "
    FC[f] += SC[s]; FN[f]++; FR[f] += SR[s]
  }
  printf "  %-14s %8s %10s %11s %8s\n", "faixa", "sessões", "requests", "US$", "%custo"
  split("1. <50       |2. 50-299    |3. 300-999   |4. 1000-1999 |5. >=2000 req", o, "|")
  for (k = 1; k <= 5; k++) {
    f = o[k]
    if (FN[f] > 0) printf "  %-14s %8d %10d %11.0f %7.1f%%\n", f, FN[f], FR[f], FC[f], 100*FC[f]/T
  }
}' "$TSV"

# ---------------------------------------------------------- 4. por dia ------
echo
echo "===== POR DIA (últimos 30) ====="
printf "  %-12s %8s %12s %10s\n" dia reqs ctx_médio "US\$"
awk -F'\t' "$PRECOS"'
$3 == "<synthetic>" || $3 == "?" { next }
{ C[$2] += custo($3,$4,$5,$6,$7); N[$2]++; X[$2] += $4 + $6 + $7 }
END { for (d in C) printf "%s\t%d\t%.0f\t%.0f\n", d, N[d], X[d]/N[d], C[d] }' "$TSV" \
  | sort | tail -30 | awk -F'\t' '{printf "  %-12s %8s %12s %10s\n", $1, $2, $3, $4}'

# ------------------------------------------- 5. distribuição do contexto ----
echo
echo "===== TAMANHO DE CONTEXTO POR REQUEST ====="
CTX="${TSV}.ctx"
awk -F'\t' '$3 != "<synthetic>" && $3 != "?" { print $4 + $6 + $7 }' "$TSV" | sort -n > "$CTX"
N=$(wc -l < "$CTX" | tr -d ' ')
if [ "$N" -gt 0 ]; then
  for p in 50 75 90 99; do
    L=$(( N * p / 100 )); [ "$L" -lt 1 ] && L=1
    printf "  p%-3s : %10s tokens\n" "$p" "$(sed -n "${L}p" "$CTX")"
  done
  printf "  máx  : %10s tokens\n" "$(tail -1 "$CTX")"
fi
rm -f "$CTX"

echo
echo "TSV bruto: $TSV" >&2

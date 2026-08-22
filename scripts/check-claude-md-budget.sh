#!/usr/bin/env bash
# check-claude-md-budget.sh — orçamento APERTADO do CLAUDE.md: do arquivo INTEIRO e POR SEÇÃO.
#
# O CLAUDE.md é carregado em TODA sessão + subagente. Inchado, ele empurra os subagentes
# pra perto do limite de contexto → thrashing de auto-compact (registrado em #819) e
# encarece toda sessão. A frente 1 o enxugou de ~68 KB → ~13 KB, movendo o detalhe pra
# docs/agent/* (lição operacional) e docs/historico/* (diário de PR). Este gate impede o re-inchaço.
#
# Estourou? NÃO adicione linha aqui — mova a lição pro docs/agent/<dominio>.md, o
# histórico pro docs/historico/, e deixe no CLAUDE.md só a REGRA + o ponteiro pro doc.
#
# Bytes/palavras são a métrica dura (estável); a estimativa de tokens é informativa.
# Linha gigante = sinal de que entrou um bullet de diário que devia ir pra docs/historico/.
#
# ── Por que também POR SEÇÃO (2026-08-22) ───────────────────────────────────────────────
# Teto só do arquivo INTEIRO deixa uma seção crescer sendo PAGA pelo encolhimento de outra —
# **encolher a parte segura para financiar a arriscada**, invisível ao gate. E a que mais cresce
# é "⚠️ Armadilhas recorrentes" (46% do arquivo), justamente a que falha ABERTO: regra de estilo
# que não carrega custa inconsistência, mas a regra do `WITH (security_invoker=on)` que não
# carrega custa RLS BYPASSADA EM PRODUÇÃO. Compactar melhora o NÍVEL; só teto por seção muda a
# INCLINAÇÃO — Armadilhas cresce a cada lição aprendida. Análise: docs/historico/split-claude-md-sensor.md
#
# Ratchet (mesmo idioma do fronteiras/manifesto.gate): o teto de cada seção é o valor MEDIDO no
# dia em que a baseline foi gerada — nº inventado nenhum. Baseline: scripts/claude-md-secoes-baseline.txt
#   - seção CRESCEU → compacte a PRÓPRIA seção ou mova a lição pra docs/agent/; se o teto novo for
#     mesmo deliberado, rode `--gerar-baseline` e ele aparece no diff do PR (é o que se revisa).
#   - seção ENCOLHEU mais que a folga → rode `--gerar-baseline` pra a catraca CLICAR. Sem isso a
#     compactação de hoje vira crédito SILENCIOSO de recrescimento amanhã (o nível melhora, a
#     inclinação não), que é exatamente o furo que este gate existe pra fechar.
#   - seção NOVA sem entrada, ou entrada da baseline SEM seção (renome/split!) → VERMELHO. Pular
#     seção desconhecida seria a saída de emergência que esvazia o gate: bastaria renomear o
#     título — ou mover o bullet pra uma seção nova — pra nunca mais ser cobrado.
#
# Palavra é contada por `awk NF`, NUNCA por `wc -w`: medido em 2026-08-22, o `⚠️` do título de
# Armadilhas faz `wc -w` devolver 2338 em pt_BR.UTF-8 e 2337 em LC_ALL=C. Teto apertado + métrica
# locale-dependente = vermelho falso em UM dos ambientes (a armadilha do #1483). `awk NF` deu o
# mesmo número nos dois. A suíte hermética (scripts/test-claude-md-budget.sh, no `test:hooks`)
# roda os casos nos DOIS locales por isso.
#
# Uso:
#   bash scripts/check-claude-md-budget.sh [arquivo] [baseline]   # verifica (é o que o CI roda)
#   bash scripts/check-claude-md-budget.sh --gerar-baseline       # re-fixa os tetos no valor de hoje
#
# Exit: 0 = dentro do orçamento · 1 = estourou (arquivo ou seção) · 2 = entrada inválida
#       (arquivo/baseline ausente ou vazio, seção duplicada, soma≠total) · 64 = uso errado.
set -euo pipefail

MAX_BYTES=20480 # 20 KB (~5,5k tokens). Pós-refactor ~13 KB — folga p/ regra nova, barra o diário.
MAX_WORDS=2600
MAX_LINE=2000    # chars por linha — linha maior = bullet de diário (mover pra docs/historico/)
FOLGA_SECAO=20   # palavras que uma seção pode ficar ABAIXO do teto antes de exigir re-baseline

gerar=0
f=""
baseline=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gerar-baseline) gerar=1 ;;
    -h | --help)
      echo "uso: $0 [arquivo] [baseline] | $0 --gerar-baseline [arquivo] [baseline]"
      exit 0
      ;;
    -*)
      echo "❌ flag desconhecida: $1 (só existe --gerar-baseline)" >&2
      exit 64
      ;;
    *)
      if [ -z "$f" ]; then f="$1"; else baseline="$1"; fi
      ;;
  esac
  shift
done
f="${f:-CLAUDE.md}"
baseline="${baseline:-scripts/claude-md-secoes-baseline.txt}"

[ -f "$f" ] || {
  echo "❌ não achei $f (rode da raiz do repo)" >&2
  exit 2
}

# Emite "<palavras>\t<título>" por seção, na ordem do arquivo. Cerca de código NÃO abre seção
# (um `## algo` dentro de ```bash é comentário de shell, não título) — mas as palavras de dentro
# dela contam igual: elas ocupam contexto do mesmo jeito. "(preâmbulo)" = tudo antes do 1º `## `.
medir() {
  awk '
    BEGIN { pre = "(preâmbulo)"; sec = pre; n = 1; ordem[1] = pre; w[pre] = 0 }
    /^[ \t]*(```|~~~)/ { cerca = !cerca }
    !cerca && /^## / {
      if ($0 in w) { dup = $0 } else { ordem[++n] = $0; w[$0] = 0 }
      sec = $0
    }
    { w[sec] += NF }
    END {
      if (dup != "") {
        printf "❌ título de seção DUPLICADO (o teto de um esconderia o outro): %s\n", dup > "/dev/stderr"
        exit 3
      }
      for (i = 1; i <= n; i++) printf "%d\t%s\n", w[ordem[i]], ordem[i]
    }
  ' "$1"
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! medir "$f" > "$tmp"; then
  echo "❌ $f: não deu pra medir as seções (ver acima)" >&2
  exit 2
fi

# Invariante anti-cegueira: a soma das seções TEM de bater com o total do arquivo, contado por um
# caminho independente. Divergiu = o divisor de seções largou linha pelo caminho ⇒ o teto de alguma
# seção estaria medindo menos do que existe, e o verde seria por cegueira (docs/historico/gates-textuais-cegos.md).
words=$(awk '{ t += NF } END { print t + 0 }' "$f")
soma=$(awk -F'\t' '{ s += $1 } END { print s + 0 }' "$tmp")
if [ "$soma" != "$words" ]; then
  echo "❌ $f: soma das seções ($soma) ≠ total do arquivo ($words) — divisor de seções perdeu linha" >&2
  exit 2
fi

if [ "$gerar" -eq 1 ]; then
  {
    echo "# GERADO por \`bash scripts/check-claude-md-budget.sh --gerar-baseline\` — NÃO editar à mão."
    echo "# Ratchet de PALAVRAS por seção do CLAUDE.md (heading \`## \`; \"(preâmbulo)\" = tudo antes do 1º)."
    echo "# Cada teto é o valor MEDIDO no dia da geração — crescer acima dele = CI vermelho."
    echo "# Subir um teto é ato DELIBERADO e aparece neste diff, que é onde se revisa."
    echo "# Por que teto por seção (e não só do arquivo inteiro): topo de scripts/check-claude-md-budget.sh."
    cat "$tmp"
  } > "$baseline"
  echo "✅ baseline re-gerada: $(awk 'END { print NR }' "$tmp") seção(ões) em $baseline"
  exit 0
fi

[ -s "$baseline" ] || {
  echo "❌ baseline de seções ausente ou VAZIA: $baseline" >&2
  echo "   → rode \`bash $0 --gerar-baseline\` e COMMITE o arquivo (sem ela o teto por seção não existe)" >&2
  exit 2
}

bytes=$(wc -c < "$f" | tr -d " ") # BSD wc alinha com espaços; `set -o pipefail` mantém o erro visível
maxline=$(awk '{ if (length > m) { m = length; ln = NR } } END { print m"@"ln }' "$f")
maxlen="${maxline%@*}"
maxln="${maxline#*@}"
est_tokens=$((bytes * 10 / 35))

fail=0
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  echo "❌ $f: $bytes bytes > teto $MAX_BYTES — mova lição pra docs/agent/ e histórico pra docs/historico/ (ver topo do CLAUDE.md)"
  fail=1
fi
if [ "$words" -gt "$MAX_WORDS" ]; then
  echo "❌ $f: $words palavras > teto $MAX_WORDS"
  fail=1
fi
if [ "$maxlen" -gt "$MAX_LINE" ]; then
  echo "❌ $f: linha $maxln tem $maxlen chars > teto $MAX_LINE — provável bullet de diário (mova pra docs/historico/)"
  fail=1
fi

# Ratchet por seção. Primeiro arquivo = baseline, segundo = o medido (NR==FNR separa as fases;
# baseline vazia cairia nessa armadilha, por isso o `-s` acima já barrou — e o `nb==0`/`ns==0`
# no END é a segunda tranca: nenhuma das duas pode terminar em silêncio verde).
if ! awk -v folga="$FOLGA_SECAO" -v arq="$f" -v base="$baseline" -v prog="$0" '
  NR == FNR {
    if ($0 ~ /^[ \t]*(#|$)/) next
    i = index($0, "\t")
    if (i == 0) { printf "❌ %s:%d sem TAB — baseline corrompida: %s\n", base, FNR, $0; erro = 1; next }
    t = substr($0, i + 1)
    if (t in teto) { printf "❌ %s: título repetido na baseline: %s\n", base, t; erro = 1 }
    teto[t] = substr($0, 1, i - 1) + 0
    nb++
    next
  }
  {
    i = index($0, "\t")
    t = substr($0, i + 1)
    p = substr($0, 1, i - 1) + 0
    ns++
    visto[t] = 1
    if (!(t in teto)) {
      printf "❌ seção SEM teto na baseline (%d palavras): %s\n", p, t
      printf "   → seção nova (ou título editado) não passa em silêncio: um bullet mudado de seção\n"
      printf "     escaparia do teto da seção de origem. Rode `bash %s --gerar-baseline` se for deliberado.\n", prog
      erro = 1
      next
    }
    if (p > teto[t]) {
      printf "❌ seção estourou o teto: %s\n", t
      printf "   %d palavras > teto %d (+%d). Compacte a PRÓPRIA seção ou mova a lição pra docs/agent/ —\n", p, teto[t], p - teto[t]
      printf "   encolher OUTRA seção pra pagar esta é exatamente o que este teto existe pra impedir.\n"
      printf "   Se o teto novo for deliberado: `bash %s --gerar-baseline` (aparece no diff do PR).\n", prog
      erro = 1
    } else if (teto[t] - p > folga) {
      printf "❌ seção encolheu %d palavras abaixo do teto (folga tolerada: %d): %s\n", teto[t] - p, folga, t
      printf "   %d palavras, teto %d. A catraca precisa CLICAR: rode `bash %s --gerar-baseline`.\n", p, teto[t], prog
      printf "   Sem isso a compactação de hoje vira crédito silencioso de recrescimento amanhã.\n"
      erro = 1
    }
  }
  END {
    if (nb == 0) { printf "❌ %s: nenhuma entrada de teto lida — baseline vazia/só comentário\n", base; erro = 1 }
    if (ns == 0) { printf "❌ %s: nenhuma seção medida — o gate não olhou nada\n", arq; erro = 1 }
    for (t in teto) {
      if (!(t in visto)) {
        printf "❌ teto ÓRFÃO: a baseline cobra %s, que não existe mais em %s\n", t, arq
        printf "   → seção renomeada/removida deixa o teto medindo NADA (verde por cegueira). Rode\n"
        printf "     `bash %s --gerar-baseline` depois de conferir que o conteúdo não migrou pra fugir do teto.\n", prog
        erro = 1
      }
    }
    exit erro ? 1 : 0
  }
' "$baseline" "$tmp"; then
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✅ $f: $bytes bytes / $words palavras / ≈${est_tokens} tokens / maior linha $maxlen chars — dentro do orçamento (teto ${MAX_BYTES}B / ${MAX_WORDS}w / linha ${MAX_LINE}c)"
  # palavras/teto e a FATIA de cada seção — é aqui que "Armadilhas = 46% do arquivo" fica visível
  # sem ninguém precisar medir de novo (era o número que só existia no docs/historico/).
  awk -F'\t' -v tot="$words" '
    NR == FNR { if ($0 !~ /^[ \t]*(#|$)/) { i = index($0, "\t"); teto[substr($0, i + 1)] = substr($0, 1, i - 1) + 0 } ; next }
    { printf "   %4d/%-4d %3d%%  %s\n", $1, teto[$2], ($1 * 100 + tot / 2) / tot, $2 }
  ' "$baseline" "$tmp"
fi
exit "$fail"

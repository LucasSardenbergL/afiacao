#!/usr/bin/env bash
# test-claude-md-budget.sh — suíte HERMÉTICA do scripts/check-claude-md-budget.sh (sem rede, sem git).
#
# O caso que dá nome a tudo é o `furo original`: uma seção CRESCE e outra ENCOLHE o mesmo tanto, o
# arquivo fica com o MESMO total de palavras — e o gate antigo (teto só do arquivo inteiro) passava.
# Se esse caso ficar verde, o teto por seção não existe de fato. Os demais fecham as saídas de
# emergência que esvaziariam o gate em silêncio (seção nova, renome, baseline vazia/só-comentário).
#
# Tudo roda nos DOIS locales: o `⚠️` do título de Armadilhas faz `wc -w` divergir entre pt_BR.UTF-8
# e LC_ALL=C (medido 2026-08-22), e falsificar em UM ambiente não prova a asserção (#1483). Sem um
# locale UTF-8 disponível a suíte FALHA — rodar C duas vezes seria metade da cobertura fingindo ser
# inteira (ausência de dado ≠ aprovação).
#
# Uso: bash scripts/test-claude-md-budget.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
raiz="$(cd "$here/.." && pwd)"
GATE="$here/check-claude-md-budget.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
arq="$tmp/FAKE.md"
base="$tmp/baseline.txt"

ok=0
ruim=0
LOC=""

# ── locale UTF-8: exigir resposta POSITIVA, nunca degradar em silêncio ────────────────────────
# `locale -a` casaria "C.utf8" x "C.UTF-8" por acidente de grafia; aqui a sonda é POSITIVA —
# só vale o locale que RESPONDE UTF-8 quando aplicado (presente-porém-quebrado esvaziaria o guard).
utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then
    utf8="$cand"
    break
  fi
done
if [ -z "$utf8" ]; then
  echo "❌ nenhum locale UTF-8 (pt_BR/en_US/C) neste ambiente — a metade UTF-8 da suíte não rodaria."
  echo "   Rodar só LC_ALL=C e chamar de verde é a falsificação em UM ambiente do #1483."
  exit 1
fi

# ── helpers ──────────────────────────────────────────────────────────────────────────────────
palavras() { awk -v n="$1" 'BEGIN { for (i = 1; i <= n; i++) printf "p%d%s", i, (i < n ? " " : "\n") }'; }

# monta <n_palavras_alfa> <n_palavras_beta> — Beta tem `⚠️` e travessão no título de propósito.
monta() {
  {
    echo "preambulo do arquivo de teste"
    echo
    echo "## Alfa"
    palavras "$1"
    echo
    echo "## ⚠️ Beta — seção com acento"
    palavras "$2"
  } > "$arq"
}

total_palavras() { awk '{ t += NF } END { print t + 0 }' "$1"; }

# esperar <rc> <trecho-ou-vazio> <descrição> [args do gate...]
esperar() {
  local rc_esp="$1" trecho="$2" desc="$3"
  shift 3
  local saida rc
  saida="$(LC_ALL="$LOC" bash "$GATE" "$@" 2>&1)"
  rc=$? # medido COLADO na substituição — qualquer comando no meio sobrescreveria o $?
  if [ "$rc" -ne "$rc_esp" ]; then
    echo "❌ [$LOC] $desc — esperava exit $rc_esp, veio $rc"
    printf '%s\n' "$saida" | sed 's/^/     | /'
    ruim=$((ruim + 1))
    return
  fi
  if [ -n "$trecho" ] && ! printf '%s\n' "$saida" | grep -qF "$trecho"; then
    echo "❌ [$LOC] $desc — exit $rc certo, mas a saída não diz \"$trecho\" (mensagem muda ⇒ gate mudou de motivo)"
    printf '%s\n' "$saida" | sed 's/^/     | /'
    ruim=$((ruim + 1))
    return
  fi
  ok=$((ok + 1))
}

# ── os casos, rodados uma vez por locale ─────────────────────────────────────────────────────
for LOC in C "$utf8"; do
  echo "── locale: $LOC ──"

  # 1. verde: baseline recém-gerada bate com o arquivo que a gerou
  monta 60 40
  LC_ALL="$LOC" bash "$GATE" --gerar-baseline "$arq" "$base" > /dev/null || {
    echo "❌ [$LOC] --gerar-baseline falhou"
    ruim=$((ruim + 1))
  }
  esperar 0 "dentro do orçamento" "verde: arquivo == baseline" "$arq" "$base"

  # 2. O FURO ORIGINAL: Beta +5 pago por Alfa -5 ⇒ total do arquivo IDÊNTICO.
  #    O gate antigo (só arquivo inteiro) passava; este tem de reprovar nomeando Beta.
  antes="$(total_palavras "$arq")"
  monta 55 45
  depois="$(total_palavras "$arq")"
  if [ "$antes" != "$depois" ]; then
    echo "❌ [$LOC] fixture ruim: o furo exige total IGUAL ($antes vs $depois) — o caso não provaria nada"
    ruim=$((ruim + 1))
  else
    ok=$((ok + 1))
  fi
  esperar 1 "seção estourou o teto" "furo original: cresce uma, encolhe outra, total igual" "$arq" "$base"
  esperar 1 "Beta" "furo original: a mensagem nomeia a seção que cresceu" "$arq" "$base"

  # 3. crescimento puro
  monta 60 46
  esperar 1 "seção estourou o teto" "seção cresceu sozinha" "$arq" "$base"

  # 4. encolhimento dentro da folga (20) segue verde — edição normal não vira churn
  monta 45 40
  esperar 0 "dentro do orçamento" "encolheu 15 (< folga 20): verde" "$arq" "$base"

  # 5. encolhimento além da folga: a catraca precisa CLICAR
  monta 30 40
  esperar 1 "catraca precisa CLICAR" "encolheu 30 (> folga 20): exige --gerar-baseline" "$arq" "$base"

  # 6. seção NOVA sem teto: mover bullet pra seção nova não pode escapar
  monta 60 40
  printf '\n## Gama\n%s\n' "$(palavras 30)" >> "$arq"
  esperar 1 "SEM teto na baseline" "seção nova sem entrada na baseline" "$arq" "$base"

  # 7. RENOME: o teto órfão não pode ficar medindo nada em silêncio
  monta 60 40
  sed 's/^## Alfa$/## Alfa renomeada/' "$arq" > "$arq.tmp" && mv "$arq.tmp" "$arq"
  esperar 1 "teto ÓRFÃO" "seção renomeada deixa teto órfão" "$arq" "$base"

  # 8. `## ` dentro de cerca de código NÃO abre seção (senão viraria "seção sem teto")
  monta 60 40
  {
    echo
    echo '```bash'
    echo "## isto e comentario de shell, nao titulo"
    echo "bun run algo"
    echo '```'
  } >> "$arq"
  esperar 1 "seção estourou o teto" "cerca: linhas contam palavras (Beta cresce), mas não viram seção" "$arq" "$base"
  saida_cerca="$(LC_ALL="$LOC" bash "$GATE" "$arq" "$base" 2>&1)"
  if printf '%s\n' "$saida_cerca" | grep -qF "SEM teto na baseline"; then
    echo "❌ [$LOC] cerca de código virou seção — o divisor não entende \`\`\`"
    ruim=$((ruim + 1))
  else
    ok=$((ok + 1))
  fi

  # 9. título DUPLICADO: dois iguais fariam um teto esconder o outro
  monta 60 40
  printf '\n## Alfa\n%s\n' "$(palavras 10)" >> "$arq"
  esperar 2 "DUPLICADO" "título de seção duplicado" "$arq" "$base"

  # 10. baseline VAZIA e baseline SÓ COMENTÁRIO: nenhuma das duas pode terminar verde
  monta 60 40
  : > "$tmp/vazia.txt"
  esperar 2 "VAZIA" "baseline vazia" "$arq" "$tmp/vazia.txt"
  printf '# só comentário\n#\n' > "$tmp/comentario.txt"
  esperar 1 "nenhuma entrada de teto" "baseline só com comentário" "$arq" "$tmp/comentario.txt"

  # 11. entradas ausentes/ inválidas
  esperar 2 "ausente ou VAZIA" "baseline inexistente" "$arq" "$tmp/nao-existe.txt"
  esperar 2 "não achei" "arquivo inexistente" "$tmp/nao-existe.md" "$base"
  esperar 64 "flag desconhecida" "flag inventada não é ignorada" --turbo "$arq" "$base"

  # 12. round-trip: re-gerar a baseline sobre o arquivo mutado devolve o verde
  monta 60 40
  printf '\n## Gama\n%s\n' "$(palavras 30)" >> "$arq"
  LC_ALL="$LOC" bash "$GATE" --gerar-baseline "$arq" "$base" > /dev/null
  esperar 0 "dentro do orçamento" "round-trip: --gerar-baseline devolve o verde" "$arq" "$base"

  # 13. o par COMMITADO (CLAUDE.md + baseline) tem de estar verde — é o que o CI roda
  esperar 0 "dentro do orçamento" "CLAUDE.md real x baseline commitada" "$raiz/CLAUDE.md" "$raiz/scripts/claude-md-secoes-baseline.txt"
done

echo
if [ "$ruim" -eq 0 ]; then
  echo "✅ test-claude-md-budget: $ok asserções verdes (2 locales: C e $utf8)"
  exit 0
fi
echo "❌ test-claude-md-budget: $ruim falha(s) em $((ok + ruim)) asserções"
exit 1

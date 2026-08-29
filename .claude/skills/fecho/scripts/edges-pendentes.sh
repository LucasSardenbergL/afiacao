#!/usr/bin/env bash
# edges-pendentes.sh — Passo 3 do /fecho: das edges que mergearam na janela, quais AINDA
# precisam de chip?
#
# O QUE ELE RESOLVE. O gatilho do Passo 3 era `git log ... -- supabase/functions/` puro: commit na
# janela ⇒ chip. Num repo com dezenas de worktrees e ~4–11 merges de edge por dia, esse gatilho é
# quase sempre verdadeiro, e a MESMA edge vira chip em toda sessão que fecha na mesma janela. Chip
# redundante não é grátis: o founder é quem clica, e uma fila de chips iguais some com o chip que
# importava. Este script troca "commit no git" por "o que está NO AR", usando a única evidência
# que já existe de graça: o campo `fonte` que `criarRespostaSonda` serve (SHA-256 do fecho
# transitivo dos imports locais) comparado com `_shared/sonda-fingerprints.ts` da main.
#
# 🔴 A DIREÇÃO É UMA SÓ: presença PROVA, ausência NÃO reprova (a lição do #2086/#2095). Este
# script só sabe SUPRIMIR chip com evidência POSITIVA — `fonte` servido == `fonte` da main. Tudo
# o mais (sem linha na janela, edge fora do mapa, `nao-mapeada`, banco mudo) sai como pendência.
# Ele é o lado que APAGA a pendência, então é fail-CLOSED por desenho: na dúvida, chip.
#
# Por que a comparação é imune ao guard temporal do #2079: o `fonte` é função do CONTEÚDO, não do
# relógio. Uma resposta gravada ANTES do merge carrega o fingerprint do bundle velho e não casa com
# a main. Não há "tick pré-merge lido como prova" aqui — o que o `versao` não veria (mesma string
# nas duas pontas), o `fonte` vê (foi assim que o `omie-vendas-sync` foi pego com bundle velho).
#
# COBERTURA, dita em voz alta: o mapa cobre ~40 das ~95 edges. As outras ~55 saem SEM_PROVA e
# viram chip como hoje — o gate não regride nada, só corta o redundante onde há prova.
#
# Uso:
#   edges-pendentes.sh <slug> [<slug> ...]      # classifica os slugs dados
#   edges-pendentes.sh --desde "<git-since>"    # deriva os slugs da janela (UNIÃO de 2 fontes)
#
# `--desde` enumera pela UNIÃO, porque cada fonte sozinha tem furo (mesmo princípio do Passo 4 da
# lovable-deploy-verify): (a) o DIFF do mapa de fingerprints entre o início da janela e a main —
# única via que enxerga mudança em `_shared/`, que muda o bundle de N edges sem tocar na pasta de
# nenhuma; (b) o `git log --name-only` das pastas — única via que enxerga edge FORA do mapa.
#
# Exit: 0 = nada pendente (todas provadas no ar) · 1 = há pendência → abra chip para a lista
#       2 = a MECÂNICA não é confiável (sem banco, mapa ilegível, janela inválida) → trate TUDO
#           como pendente; o script já imprime todos os alvos como SEM_PROVA
#       3 = uso inválido
#
# Env: AFIACAO_PSQL (default ~/.config/afiacao/psql-ro) · FECHO_JANELA_TTL (default '6 hours',
#      = pg_net.ttl) · FECHO_MAPA_FONTE (arquivo de mapa alternativo; default = o da origin/main).
# Testes: scripts/test-fecho-edges-pendentes.sh (com --falsificar).
set -uo pipefail

JANELA="${FECHO_JANELA_TTL:-6 hours}"
PSQL="${AFIACAO_PSQL:-$HOME/.config/afiacao/psql-ro}"
MAPA_REL="supabase/functions/_shared/sonda-fingerprints.ts"
RAIZ="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../../../.." 2>/dev/null && pwd)}"

tmp="$(mktemp -d)" || { echo "edges-pendentes: mktemp falhou"; exit 2; }
trap 'rm -rf "$tmp"' EXIT

# --------------------------------------------------------------------- uso ---
[ "$#" -ge 1 ] || {
  echo "uso: edges-pendentes.sh <slug> [slug...]   |   edges-pendentes.sh --desde \"<git-since>\""
  exit 3
}

# ------------------------------------------------------- alvos (quem medir) ---
# Modo --desde: a UNIÃO das duas fontes. Sem ela o gate herda o furo da fonte escolhida.
if [ "$1" = "--desde" ]; then
  desde="${2:-}"
  [ -n "$desde" ] || { echo "uso: edges-pendentes.sh --desde \"<git-since>\""; exit 3; }

  base="$(git -C "$RAIZ" rev-list -1 --before="$desde" origin/main 2>/dev/null)"
  if [ -z "$base" ]; then
    echo "⚠️ edges-pendentes: não achei o commit-base de origin/main antes de \"$desde\""
    echo "   (git fetch feito? a data é parseável pelo git?) — MECÂNICA NÃO CONFIÁVEL, exit 2"
    exit 2
  fi

  # (a) diff do mapa de fingerprints: pega mudança vinda de _shared/, cega para edge fora do mapa
  git -C "$RAIZ" show "$base:$MAPA_REL" 2>/dev/null \
    | sed -nE 's/.*"([a-z0-9_-]+)": *"([0-9a-f]{64})".*/\1 \2/p' > "$tmp/mapa_base" || true
  git -C "$RAIZ" show "origin/main:$MAPA_REL" 2>/dev/null \
    | sed -nE 's/.*"([a-z0-9_-]+)": *"([0-9a-f]{64})".*/\1 \2/p' > "$tmp/mapa_agora" || true
  # slug cujo par (slug sha) existe no mapa de agora e NÃO existe igual no mapa base ⇒ fonte mudou
  # (inclui edge NOVA, que não tem linha no base).
  if [ -s "$tmp/mapa_agora" ]; then
    while read -r slug sha; do
      command grep -Fxq -- "$slug $sha" "$tmp/mapa_base" 2>/dev/null || printf '%s\n' "$slug"
    done < "$tmp/mapa_agora" >> "$tmp/alvos"
  fi

  # (b) pastas tocadas no git log: pega edge FORA do mapa, cega para _shared/
  git -C "$RAIZ" log "$base..origin/main" --name-only --format="" -- supabase/functions/ 2>/dev/null \
    | sed -n 's#^supabase/functions/\([a-z0-9][a-z0-9_-]*\)/.*#\1#p' >> "$tmp/alvos"
  # o `[a-z0-9]` inicial exclui `_shared/` de propósito: não é edge, não se deploya sozinha,
  # e o efeito dela nas edges que a importam já entra pela via (a), o diff dos fingerprints.

  sort -u -o "$tmp/alvos" "$tmp/alvos" 2>/dev/null || true
else
  printf '%s\n' "$@" | sort -u > "$tmp/alvos"
fi

if [ ! -s "$tmp/alvos" ]; then
  echo "✅ nenhuma edge na janela — nada a deployar, nenhum chip."
  exit 0
fi

# --------------------------------------------------- mapa de fingerprints ---
# Da origin/main de propósito: a pergunta é "o ar bate com o que ESTÁ MERGEADO?", não com o
# worktree local (que pode ter fatia ainda não mergeada, e aí o "desatualizada" seria mentira).
if [ -n "${FECHO_MAPA_FONTE:-}" ]; then
  cat "$FECHO_MAPA_FONTE" 2>/dev/null > "$tmp/mapa_bruto"
else
  git -C "$RAIZ" show "origin/main:$MAPA_REL" 2>/dev/null > "$tmp/mapa_bruto"
fi
sed -nE 's/.*"([a-z0-9_-]+)": *"([0-9a-f]{64})".*/\1 \2/p' "$tmp/mapa_bruto" \
  2>/dev/null > "$tmp/mapa" || true

mecanica_ok=1
motivo=""
if [ ! -s "$tmp/mapa" ]; then
  mecanica_ok=0
  motivo="mapa de fingerprints ilegível ou vazio ($MAPA_REL na origin/main)"
fi

# ------------------------------------------------------- sonda do BANCO ---
# `command -v` NÃO basta: wrapper presente-porém-quebrado esvaziaria o gate igual, e este é o
# script que APAGA pendência. Exige-se RESPOSTA POSITIVA ('1') antes de confiar em qualquer
# ausência lida do banco.
# shellcheck disable=SC2016  # aspas simples sao TEXTO aqui; a string externa e dupla
case "$JANELA" in
  [0-9]*' hours' | [0-9]*' hour' | [0-9]*' minutes' | [0-9]*' days') ;;
  *) mecanica_ok=0; motivo="${motivo:-janela inválida: '$JANELA' (use '6 hours')}" ;;
esac

if [ "$mecanica_ok" = 1 ]; then
  if [ ! -x "$PSQL" ]; then
    mecanica_ok=0; motivo="psql-ro ausente ou sem permissão de execução ($PSQL)"
  elif ! "$PSQL" -Atc 'SELECT 1' 2>/dev/null | command grep -Fxq -- '1'; then
    # LINHA exatamente "1", não a saída inteira: o wrapper emite os `SET` da sessão read-only
    # antes do resultado (`docs/historico/evidencia-positiva-shell.md` §11 — o PREÂMBULO do wrapper
    # vira "dado"). Exigir a FORMA, não a presença: vazio, só `SET`, ou erro não passam daqui.
    mecanica_ok=0; motivo="psql-ro não respondeu 1 ao SELECT 1 (presente porém mudo/quebrado)"
  fi
fi

if [ "$mecanica_ok" = 1 ]; then
  # DISTINCT ON pega a resposta MAIS RECENTE por edge: dentro da janela cabe o deploy no meio dela
  # (bundle velho às 21:48, novo às 22:04) e "alguma resposta bateu" leria o velho como prova.
  # O `OFFSET 0` é barreira de otimização: sem ela o planner pode empurrar o `content::jsonb` para
  # antes do filtro de forma e estourar em linha que não é JSON.
  sql="WITH bruto AS (
         SELECT created, content FROM net._http_response
         WHERE status_code = 200 AND content IS NOT NULL
           AND left(ltrim(content), 1) = '{'
           AND created > now() - interval '$JANELA'
         OFFSET 0
       ), sondas AS (
         SELECT created,
                (content::jsonb) ->> 'edge'  AS edge,
                (content::jsonb) ->> 'fonte' AS fonte
         FROM bruto WHERE (content::jsonb) ? 'fonte'
       )
       SELECT DISTINCT ON (edge) edge || ' ' || fonte
       FROM sondas WHERE edge IS NOT NULL AND fonte IS NOT NULL
       ORDER BY edge, created DESC;"
  if ! "$PSQL" -Atc "$sql" > "$tmp/ar" 2>"$tmp/erro"; then
    mecanica_ok=0
    motivo="a consulta a net._http_response falhou: $(head -c 160 "$tmp/erro" | tr '\n' ' ')"
  fi
fi

# ------------------------------------------------------------ veredito ---
: > "$tmp/chips"
echo "== edges da janela: precisa de chip? =="
if [ "$mecanica_ok" = 0 ]; then
  echo "⚠️ MECÂNICA NÃO CONFIÁVEL — $motivo"
  echo "   Fail-closed: sem evidência POSITIVA, toda edge da janela segue pendente."
fi

while read -r slug; do
  [ -n "$slug" ] || continue
  esperado=""; servido=""
  if [ "$mecanica_ok" = 1 ]; then
    esperado="$(command grep -m1 -- "^$slug " "$tmp/mapa"  2>/dev/null | cut -d' ' -f2)"
    servido="$( command grep -m1 -- "^$slug " "$tmp/ar"    2>/dev/null | cut -d' ' -f2)"
  fi

  if [ "$mecanica_ok" = 1 ] && [ -n "$esperado" ] && [ "$servido" = "$esperado" ]; then
    printf '  NO_AR          %-34s fonte %s… bate com a main\n' "$slug" "${servido:0:8}"
    continue
  fi

  printf '%s\n' "$slug" >> "$tmp/chips"
  if [ "$mecanica_ok" = 0 ]; then
    printf '  SEM_PROVA      %-34s mecânica não confiável (ver acima)\n' "$slug"
  elif [ -z "$esperado" ]; then
    printf '  SEM_PROVA      %-34s fora do mapa de sondas — não há prova passiva possível\n' "$slug"
  elif [ -z "$servido" ]; then
    printf '  SEM_PROVA      %-34s nenhuma sonda em %s (ausência ≠ pendência: INDETERMINADO)\n' "$slug" "$JANELA"
  elif [ "$servido" = "nao-mapeada" ]; then
    # shellcheck disable=SC2016  # as crases sao TEXTO: `nao-mapeada` e o valor servido
    printf '  SEM_PROVA      %-34s a sonda respondeu `nao-mapeada` — a prova nasceu cega\n' "$slug"
  else
    printf '  DESATUALIZADA  %-34s no ar %s… ≠ main %s… — BUNDLE VELHO SERVINDO\n' \
      "$slug" "${servido:0:8}" "${esperado:0:8}"
  fi
done < "$tmp/alvos"

n_chips="$(wc -l < "$tmp/chips" | tr -d "[:space:]")"
echo
if [ "$n_chips" -eq 0 ]; then
  echo "✅ todas provadas no ar pelo \`fonte\` — nenhum chip de deploy por estas edges."
  exit 0
fi
echo "🎫 abra chip para: $(tr '\n' ' ' < "$tmp/chips")"
echo "   (DESATUALIZADA = deploy pendente PROVADO · SEM_PROVA = indeterminado, chip por fail-closed)"
[ "$mecanica_ok" = 1 ] && exit 1
exit 2

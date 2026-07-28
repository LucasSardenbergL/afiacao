#!/usr/bin/env bash
# lovable-revert-scan.sh — acusa REVERSÃO do sync do Lovable com prova, não só "tocou path".
#
# O bot (gpt-engineer-app[bot]) commita direto na main ("Changes"/"Deployed...") e às vezes
# empurra o workspace VELHO por cima de arquivo recém-mergeado, desfazendo o PR (#1445→#1478:
# wiring de edge apagado 4h após o merge; 3 deploys "verbatim da main" deployaram a main JÁ
# revertida). O lovable-watch.yml sinaliza o toque genérico; ESTE scan responde a pergunta cara:
# o commit direto REMOVEU linha que um merge de PR RECENTE tinha ADICIONADO no mesmo arquivo?
#
# Uso: lovable-revert-scan.sh [<sha>]   (default HEAD; roda no cwd do repo)
# Env: LRS_WINDOW   janela de merges "recentes" (default "48 hours ago")
#      LRS_PATTERNS regex ERE dos paths sensíveis (default = o do lovable-watch.yml)
#      LRS_MIN_LEN  comprimento mínimo p/ linha contar como substantiva (default 12)
#
# Saída: mudo + exit 0 quando nada; blocos "REVERSAO arquivo=... pr=#N merge=... linhas=K" com
# amostra das linhas quando há hit (exit 0 também — quem decide é quem lê o stdout; erro de git
# → exit != 0 e o step do CI fica vermelho, visível). Filtra linha trivial (curta/só pontuação)
# e COMENTÁRIO puro — o bot apaga comentário-aviso legitimamente sem reverter o gate (deploy.md).
# Falso-negativo aceito: reversão só-de-comentário/1-linha-curta escapa daqui, mas continua
# coberta pela Issue genérica de path sensível. Testes: scripts/test-lovable-revert-scan.sh.
set -u

sha="${1:-HEAD}"
window="${LRS_WINDOW:-48 hours ago}"
patterns="${LRS_PATTERNS:-^supabase/functions/|^src/integrations/supabase/types\.ts$|^src/lib/reposicao/|^src/lib/custo/}"
minlen="${LRS_MIN_LEN:-12}"

# Merge de PR no alvo (subject termina "(#N)") não é commit direto — defesa em profundidade,
# o workflow já filtra antes de chamar.
subj="$(git log -1 --pretty=%s "$sha")" || exit 1
printf '%s' "$subj" | grep -qE '\(#[0-9]+\)[[:space:]]*$' && exit 0

changed="$(git diff --name-only "$sha^" "$sha" | grep -E "$patterns" || true)"
[ -n "$changed" ] || exit 0

substantiva() {
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -vE '^(//|#|--|/\*|\*)' \
    | grep -vE '^[][(){};,]*$' \
    | awk -v m="$minlen" 'length($0) >= m'
}

while IFS= read -r f; do
  [ -n "$f" ] || continue
  removed="$(git diff "$sha^" "$sha" -- "$f" | grep '^-' | grep -v '^---' | cut -c2- | substantiva | sort -u)"
  [ -n "$removed" ] || continue
  merges="$(git log --since="$window" --first-parent -E --grep='\(#[0-9]+\)[[:space:]]*$' --pretty='%H' "$sha^" -- "$f" || true)"
  [ -n "$merges" ] || continue
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    added="$(git show "$m" -- "$f" | grep '^+' | grep -v '^+++' | cut -c2- | substantiva | sort -u)"
    [ -n "$added" ] || continue
    hits="$(comm -12 <(printf '%s\n' "$removed") <(printf '%s\n' "$added"))"
    [ -n "$hits" ] || continue
    n="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
    pr="$(git log -1 --pretty=%s "$m" | sed -E 's/.*\(#([0-9]+)\)[[:space:]]*$/\1/')"
    msha="$(git rev-parse --short=8 "$m")"
    printf 'REVERSAO arquivo=%s pr=#%s merge=%s linhas=%s\n' "$f" "$pr" "$msha" "$n"
    printf '%s\n' "$hits" | head -6 | sed 's/^/  - /'
    if [ "$n" -gt 6 ] 2>/dev/null; then printf '  ... (+%s linhas)\n' "$((n - 6))"; fi
  done <<EOF
$merges
EOF
done <<EOF2
$changed
EOF2

exit 0

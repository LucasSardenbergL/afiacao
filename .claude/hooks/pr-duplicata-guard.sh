#!/usr/bin/env bash
# pr-duplicata-guard.sh — PreToolUse(Bash): AVISA (não nega) na hora do `gh pr create` quando o
# ARTEFATO que este PR introduz JÁ EXISTE na origin/main — i.e. a tarefa já foi ENTREGUE por outra
# sessão. Eixo OBJETIVO; o irmão pr-collision-guard.sh cobre o eixo ARQUIVO (conflito de merge).
#
# Por que um hook e não (mais) uma frase: em 2026-08-15 uma única sessão produziu 3 duplicatas no
# mesmo dia, com a regra do eixo OBJETIVO já escrita desde 2026-07-23 (worktrees.md, "achado
# COMPARTILHADO colide por DESENHO"). O detector que ela prescreve — varrer TÍTULO de PR — dá 0 hits
# nas 3, por duas causas independentes: o entregador já MERGEOU (`gh pr list` lista aberto por
# padrão) e o PR entrega sob o tema DELE (o c542210c registrou `reposicao_pos_marcador` no manifesto
# sob "o eixo do gate passa a ver COMPRAS"). Contramedida textual reincide; gate estrutural para.
#
# O TESTE (por (arquivo, símbolo), três vias — esta é a parte falsificada):
#   1. ausente do ARQUIVO na merge-base   (não existia quando eu comecei)
#   2. presente no ARQUIVO no meu HEAD    (fui EU que introduzi)
#   3. presente no ARQUIVO na origin/main (alguém JÁ entregou enquanto eu trabalhava)
# As três juntas são a assinatura da duplicata. Se a main não andou naquele arquivo, (1) e (3) se
# contradizem e o hook cala sozinho — o silêncio é estrutural, não sorte.
#
# ⚠️ O escopo é POR ARQUIVO, não repo-wide, e isso foi MEDIDO, não escolhido: `reposicao_pos_marcador`
# já existia em 10 arquivos (migrations) na merge-base, então um teste repo-wide de "símbolo novo" o
# excluiria como "não é novo" → falso negativo em 1 das 3 ocorrências. O que era novo era o símbolo
# NAQUELE arquivo (o registro no scripts/authz-manifest.ts). Precisão vem do par, não do símbolo.
#
# Candidato = identificador de ≥12 chars contendo `_` ou corcova camelCase. O filtro de forma existe
# para que prosa portuguesa em .md ("imediatamente", "implementacao") não vire candidato — só
# identificador tem underscore ou corcova. Ambos os símbolos reais passam (reposicao_pos_marcador,
# DENO_NO_PACKAGE_JSON).
#
# Fail-open TOTAL: sem jq/git → exit 0; fetch falha → segue com refs locais; sem merge-base → exit 0;
# arquivo ausente da main → pula (nada a duplicar ali). AVISA via additionalContext com
# permissionDecision=allow — NUNCA bloqueia (PR legítimo que ESTENDE trabalho recém-mergeado existe).
# Testes: scripts/test-pr-duplicata-guard.sh.
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# É um `gh pr create`? Sanitiza aspas/heredoc antes (menção "gh pr create" ≠ execução) — mesma
# detecção do pr-collision-guard.sh, deliberadamente idêntica para os dois guards concordarem.
# shellcheck disable=SC2016  # \x27/\x22 são literais do regex do perl, não expansão de shell
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
[ -n "$scan" ] || scan="$cmd"
printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])gh([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+pr[[:space:]]+create([[:space:]]|$)' || exit 0

if command -v timeout >/dev/null 2>&1; then
  timeout 8 git fetch origin main --quiet >/dev/null 2>&1 || true
else
  git fetch origin main --quiet >/dev/null 2>&1 || true
fi

mb="$(git merge-base HEAD origin/main 2>/dev/null)" || exit 0
[ -n "$mb" ] || exit 0

mine="$(git diff --name-only "$mb" HEAD 2>/dev/null)" || exit 0
[ -n "$mine" ] || exit 0

# Identificador significativo: ≥12 chars, com underscore OU corcova camelCase.
IDRE='[A-Za-z_][A-Za-z0-9_]{11,}'
_ids() { grep -oE "$IDRE" 2>/dev/null | grep -E '_|[a-z][A-Z]' 2>/dev/null | sort -u; }

achados=""
n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  n=$((n + 1))
  [ "$n" -le 25 ] || break
  case "$f" in
    *.lock | *.lockb | *lock.json | *.png | *.jpg | *.svg | *.ico | *.woff*) continue ;;
  esac

  # Sem o arquivo na main não há entrega alheia ali. (Erro de `git show` cai no mesmo ramo.)
  main_c="$(git show "origin/main:$f" 2>/dev/null)" || continue
  [ -n "$main_c" ] || continue
  base_c="$(git show "$mb:$f" 2>/dev/null)" || base_c=""

  add_ids="$(git diff "$mb" HEAD -- "$f" 2>/dev/null | grep '^+' | grep -v '^+++' | _ids)"
  [ -n "$add_ids" ] || continue

  novos="$(comm -23 <(printf '%s\n' "$add_ids") <(printf '%s\n' "$base_c" | _ids) 2>/dev/null)"
  [ -n "$novos" ] || continue
  dup="$(comm -12 <(printf '%s\n' "$novos") <(printf '%s\n' "$main_c" | _ids) 2>/dev/null | head -4)"
  [ -n "$dup" ] || continue

  achados="$achados  $f → $(printf '%s' "$dup" | tr '\n' ' ')
"
done <<EOF
$mine
EOF

[ -n "$achados" ] || exit 0

msg="⚠️ Possível DUPLICATA por OBJETIVO na hora do gh pr create (eixo OBJETIVO — worktrees.md; caso: docs/historico/duplicata-por-objetivo.md).

Estes símbolos NÃO existiam no arquivo quando você começou, você os introduz — e eles JÁ ESTÃO no mesmo arquivo na origin/main:
$achados
Ou seja: outra sessão pode ter entregue esta tarefa enquanto você trabalhava (padrão #1744/#1763 — 3 duplicatas em 2026-08-15). Confira ANTES de criar:
  git log -S '<símbolo>' origin/main --oneline -- <arquivo>
Se o núcleo já mergeou: fechar > reconciliar — salve só o SEU diferencial sobre o vencedor (o desenho alheio já foi melhor 2×: #1560 e a891ba9c). Se este PR ESTENDE de propósito o que já entrou, ignore este aviso."
jq -n --arg m "$msg" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
exit 0

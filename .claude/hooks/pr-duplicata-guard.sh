#!/usr/bin/env bash
# pr-duplicata-guard.sh — PreToolUse(Bash): AVISA (não nega) quando o ARTEFATO que este trabalho
# introduz JÁ EXISTE na origin/main — i.e. a tarefa já foi ENTREGUE por outra sessão. Eixo
# OBJETIVO; o irmão pr-collision-guard.sh cobre o eixo ARQUIVO (conflito de merge).
# DOIS gatilhos: `git commit` e `gh pr create`.
#
# Por que um hook e não (mais) uma frase: em 2026-08-15 uma única sessão produziu 3 duplicatas no
# mesmo dia, com a regra do eixo OBJETIVO já escrita desde 2026-07-23 (worktrees.md, "achado
# COMPARTILHADO colide por DESENHO"). O detector que ela prescreve — varrer TÍTULO de PR — dá 0 hits
# nas 3, por duas causas independentes: o entregador já MERGEOU (`gh pr list` lista aberto por
# padrão) e o PR entrega sob o tema DELE (o c542210c registrou `reposicao_pos_marcador` no manifesto
# sob "o eixo do gate passa a ver COMPRAS"). Contramedida textual reincide; gate estrutural para.
#
# O TESTE (por (arquivo, símbolo), três vias — esta é a parte falsificada):
#   1. ausente do ARQUIVO na merge-base    (não existia quando eu comecei)
#   2. presente no ARQUIVO no meu trabalho (fui EU que introduzi)
#   3. presente no ARQUIVO na origin/main  (alguém JÁ entregou enquanto eu trabalhava)
# As três juntas são a assinatura da duplicata. Se a main não andou naquele arquivo, (1) e (3) se
# contradizem e o hook cala sozinho — o silêncio é estrutural, não sorte.
#
# GATILHO 2 — `git commit` (2026-08-18): o create é tarde, pelo mesmo motivo que fez o guard irmão
# descer no #1770 (eixo TEMPO). No create o trabalho JÁ está pronto: a rede evita o merge duplicado,
# não o DESPERDÍCIO (#1757 6 arq/+270; #1764 1 arq/+29, morto 36s depois de criado).
#   - a fonte do "meu trabalho" muda por modo: no commit o ALVO do diff é o ÍNDICE
#     (`mb..index` = STAGED ∪ commits da branch numa expressão só) e a ÁRVORE em `git commit -a`.
#     Olhar só o `mb..HEAD` seria TEATRO: no PRIMEIRO commit ele é VAZIO e o #1764 tinha 1 commit.
#   - anti-alarm-fatigue: avisa 1x por (branch, conjunto de achados); achado NOVO fura o silêncio e
#     o `gh pr create` NUNCA é silenciado (último portão).
#   - SEM cache de rede: o `git fetch` é a única rede aqui e o resultado dele não é cacheado, de
#     propósito — cache de estado volátil num guard é falso-negativo silencioso (versão com TTL de
#     2min foi escrita e DESCARTADA no #1770 por mascarar colisão verdadeira nos próprios testes).
#     Quem corta ruído é o dedupe do AVISO (por conteúdo), não cache da RESPOSTA (por tempo).
#
# ⚠️ Descer o gatilho NÃO cria ocasião de alarme nova, e isso é ESTRUTURAL: disparar exige o símbolo
# ausente em `mb:$f` e presente em `origin/main:$f` ⇒ a main mexeu em `$f` desde a merge-base ⇒ `$f`
# já está no conjunto (a) do pr-collision-guard, que avisa no commit desde o #1770. Este guard só
# acrescenta PRECISÃO (nomeia o símbolo) dentro de um aviso que já sairia de qualquer forma.
#
# ⚠️ O escopo é POR ARQUIVO, não repo-wide, e isso foi MEDIDO, não escolhido: `reposicao_pos_marcador`
# já existia em 10 arquivos (migrations) na merge-base, então um teste repo-wide de "símbolo novo" o
# excluiria como "não é novo" → falso negativo em 1 das 3 ocorrências. O que era novo era o símbolo
# NAQUELE arquivo (o registro no scripts/authz-manifest.ts). Precisão vem do par, não do símbolo.
#
# ⚠️ Precisão MEDIDA (2026-08-18; 60 PRs mergeados, 797 pares concorrentes numa janela de 8h): num
# teto PESSIMISTA o par (arquivo,símbolo) dispara em 51 de 134 pares que compartilham arquivo. O
# "símbolo" inclui nome REFERENCIADO, não só criado, e o ruído concentra em arquivo append-only
# compartilhado (docs/historico/*.md, scripts/audit-custom-migrations.sql). Por isso a mensagem diz
# "possível" e manda CONFERIR — nunca "você duplicou". Filtrar `docs/` daria falso negativo: a
# ocorrência 2 das 3 reais era exatamente um follow-up de doc.
#
# Candidato = identificador de ≥12 chars contendo `_` ou corcova camelCase. O filtro de forma existe
# para que prosa portuguesa em .md ("imediatamente", "implementacao") não vire candidato — só
# identificador tem underscore ou corcova. Ambos os símbolos reais passam (reposicao_pos_marcador,
# DENO_NO_PACKAGE_JSON).
#
# Fail-open TOTAL: sem jq/git → exit 0; fetch falha → segue com refs locais; sem merge-base → exit 0;
# arquivo ausente da main → pula (nada a duplicar ali). AVISA via additionalContext com
# permissionDecision=allow — NUNCA bloqueia (PR legítimo que ESTENDE trabalho recém-mergeado existe).
# Testes: scripts/test-pr-duplicata-guard.sh (roda no CI via `bun run test:hooks`).
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# É um `gh pr create` ou um `git commit`? Sanitiza aspas/heredoc antes (menção ≠ execução) — mesma
# detecção do pr-collision-guard.sh, deliberadamente idêntica para os dois guards concordarem.
# shellcheck disable=SC2016  # \x27/\x22 são literais do regex do perl, não expansão de shell
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
[ -n "$scan" ] || scan="$cmd"
modo=""
if printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])gh([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  modo="create"
elif printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])git([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)'; then
  modo="commit"
fi
[ -n "$modo" ] || exit 0

if command -v timeout >/dev/null 2>&1; then
  timeout 8 git fetch origin main --quiet >/dev/null 2>&1 || true
else
  git fetch origin main --quiet >/dev/null 2>&1 || true
fi

mb="$(git merge-base HEAD origin/main 2>/dev/null)" || exit 0
[ -n "$mb" ] || exit 0

# ALVO do diff — é o que distingue os dois gatilhos. No create, os commits da branch (mb..HEAD).
# No commit o trabalho ainda NÃO está commitado: comparar com o ÍNDICE dá STAGED ∪ commits da
# branch de uma vez; com `-a` o alvo é a ÁRVORE, que ainda soma o não-staged. Sem `-a` a árvore
# fica de fora de propósito — aquele arquivo nem entraria no commit (achado do Codex, #1770).
alvo=HEAD
if [ "$modo" = commit ]; then
  alvo=--cached
  printf '%s' "$scan" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*a[a-zA-Z]*|--all)([[:space:]]|$)' && alvo=""
fi

# shellcheck disable=SC2086  # $alvo é UMA palavra (HEAD/--cached) ou vazio de propósito (árvore)
mine="$(git diff --name-only "$mb" $alvo 2>/dev/null)" || exit 0
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

  # shellcheck disable=SC2086  # idem: $alvo é palavra única ou vazio intencional
  add_ids="$(git diff "$mb" $alvo -- "$f" 2>/dev/null | grep '^+' | grep -v '^+++' | _ids)"
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

# Anti-alarm-fatigue (só no commit): avisa 1x por (branch, conjunto de achados). Commit é
# frequente — repetir o MESMO aviso cega o leitor. Achado novo = assinatura nova = avisa.
# O `gh pr create` é o último portão e NUNCA é silenciado por este cache.
if [ "$modo" = commit ]; then
  cache_dir="${PRDG_CACHE_DIR:-${TMPDIR:-/tmp}/prdg-$(id -u 2>/dev/null || echo 0)}"
  mkdir -p "$cache_dir" 2>/dev/null || true
  assin="$(printf '%s\n%s' "$(git branch --show-current 2>/dev/null)" "$achados" \
    | cksum 2>/dev/null | tr -cd '0-9')"
  if [ -n "$assin" ]; then
    marca="$cache_dir/visto-$assin"
    if [ -f "$marca" ] && [ -z "$(find "$marca" -mmin +"${PRDG_VISTO_TTL_MIN:-360}" 2>/dev/null)" ]; then
      exit 0   # já avisei este MESMO achado nesta branch — não repito
    fi
    : > "$marca" 2>/dev/null || true
  fi
fi

if [ "$modo" = commit ]; then
  quando="ANTES de commitar"
  acao="Decida AGORA, antes de escrever mais: se o núcleo já mergeou, o barato é reduzir já ao seu
DIFERENCIAL (ou abortar). Descobrir isso com o PR pronto custou 2 PRs em 2026-08-15 (#1757/#1764)."
else
  quando="na hora do gh pr create"
  acao="Se o núcleo já mergeou: fechar > reconciliar — salve só o SEU diferencial sobre o vencedor
(o desenho alheio já foi melhor 2x: #1560 e a891ba9c). Se este PR ESTENDE de propósito o que já
entrou, ignore este aviso."
fi

msg="⚠️ Possível DUPLICATA por OBJETIVO $quando (eixo OBJETIVO — worktrees.md; caso: docs/historico/duplicata-por-objetivo.md).

Estes símbolos NÃO existiam no arquivo quando você começou, você os introduz — e eles JÁ ESTÃO no mesmo arquivo na origin/main:
$achados
Ou seja: outra sessão pode ter entregue esta tarefa enquanto você trabalhava (padrão #1744/#1763 — 3 duplicatas em 2026-08-15). Confira antes de seguir:
  git log -S '<símbolo>' origin/main --oneline -- <arquivo>
$acao"
jq -n --arg m "$msg" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
exit 0

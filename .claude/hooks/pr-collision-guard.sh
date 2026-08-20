#!/usr/bin/env bash
# pr-collision-guard.sh — PreToolUse(Bash): AVISA (não nega) se há colisão de arquivos com a
# origin/main FRESCA ou com PR ABERTO de outra branch. DOIS gatilhos: `git commit` e `gh pr create`.
#
# Automatiza o ritual manual do worktrees.md §"Colisão de CÓDIGO multi-sessão": a checagem de
# `gh pr list` feita no minuto 0 de uma sessão longa é foto velha — o #1526 abriu no minuto em
# que o #1525 mergeou e jogou 26 arquivos fora. A janela de colisão é o tempo da sessão LONGA;
# este hook re-executa a conferência nos instantes que importam.
#
# GATILHO 2 — `git commit` (2026-08-15): o create é tarde. Detectar ali evita o merge duplicado,
# não o DESPERDÍCIO: #1757 e #1764 morreram no mesmo dia com o trabalho já pronto (o #1764 em 36s).
# O commit é o chokepoint anterior e cadenciado pelo TRABALHO (não pelo relógio — as janelas
# medidas foram de 24min e 9min, que um "re-cheque a cada 30min" erra por sorte).
#   - conjunto de arquivos = STAGED ∪ commits da branch (∪ working-tree só em `-a`). Só o 3 pontos
#     seria TEATRO: no PRIMEIRO commit ele é VAZIO, e o #1764 tinha 1 commit só.
#   - anti-alarm-fatigue: avisa 1x por (branch, conjunto colidente) — commit é frequente e aviso
#     repetido cega. Colisão NOVA fura o silêncio; o `gh pr create` NUNCA é silenciado (último portão).
#   - o `gh pr list` NÃO é cacheado (ver comentário no corpo): cache de resposta mascara
#     colisão real — falso-negativo num guard custa mais que 1s por commit.
#
# Interseções por diff de TRÊS pontos (ancora na merge-base — o de dois pontos acusa os próprios
# commits como colisão, falso positivo do #1551):
#   meus arquivos  = git diff --name-only origin/main...HEAD
#   main ganhou    = git diff --name-only HEAD...origin/main
#   colisão (a)    = interseção dos dois;  colisão (b) = meus × files de PRs abertos (gh).
#
# Fail-open TOTAL e GRANULAR: sem jq/git → exit 0; fetch falha → segue com refs locais (stale é
# melhor que nada); gh falha → checa só a main. AVISA via additionalContext com
# permissionDecision=allow — NUNCA bloqueia (re-create legítimo sobre domínio quente existe;
# zero-FP bloqueante é o padrão dos guards deste repo). Testes: scripts/test-pr-collision-guard.sh.
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# É um `gh pr create` ou um `git commit`? Sanitiza aspas/heredoc antes (menção ≠ execução).
# shellcheck disable=SC2016  # \x27/\x22 são literais do regex do perl, não expansão de shell
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
[ -n "$scan" ] || scan="$cmd"
modo=""
# Encadeado (`git commit -am x && gh pr create ...`) casava como `create` pela ORDEM do if/elif —
# mas quem EXECUTA primeiro é o commit, e ali o `mb..HEAD` ainda está vazio (o #1764 tinha 1
# commit só) ⇒ o guard calava justamente no cenário que o gatilho 2 existe para cobrir. O alvo do
# commit é SUPERCONJUNTO do alvo do create, então o commit vence quando os dois aparecem.
# (achado da 2ª opinião adversária — Codex, 2026-08-19)
tem_create=""; tem_commit=""
printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])gh([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+pr[[:space:]]+create([[:space:]]|$)' && tem_create=1
printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])git([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' && tem_commit=1
if [ -n "$tem_commit" ]; then
  modo="commit"
elif [ -n "$tem_create" ]; then
  modo="create"
fi
[ -n "$modo" ] || exit 0

# Refs frescas — rede pode falhar/pendurar → timeout curto e segue com o que há localmente.
if command -v timeout >/dev/null 2>&1; then
  timeout 8 git fetch origin main --quiet >/dev/null 2>&1 || true
else
  git fetch origin main --quiet >/dev/null 2>&1 || true
fi

# Meus arquivos desde a merge-base (3 pontos, HEAD por último). Sem diff próprio → nada a colidir.
mine="$(git diff --name-only origin/main...HEAD 2>/dev/null)" || exit 0
# No commit o trabalho ainda NÃO está commitado: o 3-pontos é vazio no primeiro commit (#1764
# tinha 1 commit só) — some o que está STAGED e o que está modificado na árvore.
if [ "$modo" = "commit" ]; then
  # working-tree só entra quando o commit é `-a`/`--all` (senão o arquivo nem vai no commit —
  # incluí-lo sempre só acrescenta ruído; achado da 2ª opinião do Codex, 2026-08-18).
  wt=""
  printf '%s' "$scan" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*a[a-zA-Z]*|--all)([[:space:]]|$)' \
    && wt="$(git diff --name-only 2>/dev/null)"
  mine="$(printf '%s\n%s\n%s\n' \
    "$mine" \
    "$(git diff --name-only --cached 2>/dev/null)" \
    "$wt" | grep -v '^$')"
fi
[ -n "$mine" ] || exit 0
mine_sorted="$(printf '%s\n' "$mine" | sort -u)"

avisos=""

# (a) A main ganhou arquivo que EU também toco?
ganhou="$(git diff --name-only HEAD...origin/main 2>/dev/null)" || ganhou=""
if [ -n "$ganhou" ]; then
  col_main="$(comm -12 <(printf '%s\n' "$mine_sorted") <(printf '%s\n' "$ganhou" | sort -u) 2>/dev/null | head -12)"
  if [ -n "$col_main" ]; then
    avisos="A origin/main GANHOU commits nesses arquivos que você também toca (desde a merge-base):
$col_main
Confira se o seu diff ainda vale antes de criar o PR — pode já ter sido feito/suplantado (padrão #1525/#1526)."
  fi
fi

# (b) PR ABERTO de OUTRA branch tocando arquivo meu? (gh é rede → fail-open granular: pula se falhar)
if command -v gh >/dev/null 2>&1; then
  branch="$(git branch --show-current 2>/dev/null)" || branch=""
  # SEM cache de rede aqui — de propósito. Uma versão com cache (TTL 2min) foi escrita e
  # DESCARTADA: ela mascarou colisão verdadeira nos testes (o resultado velho sobrepôs o novo),
  # que é falso-negativo silencioso num guard — pior que 1s de latência por commit. Quem cega o
  # ruído é o dedupe do AVISO lá embaixo (por conteúdo), não um cache da RESPOSTA (por tempo).
  prs="$(gh pr list --state open --json number,title,headRefName,files --limit 30 2>/dev/null)" || prs=""
  if [ -n "$prs" ]; then
    col_prs="$(printf '%s' "$prs" | jq -r --arg mine "$mine_sorted" --arg me "$branch" '
      ($mine | split("\n") | map(select(length > 0))) as $m
      | .[]
      | select(.headRefName != $me)
      | [.files[].path] as $paths
      | ($paths - ($paths - $m)) as $hit
      | select(($hit | length) > 0)
      | "  PR #\(.number) (\(.title)) ja toca: \($hit | join(", "))"' 2>/dev/null | head -8)"
    if [ -n "$col_prs" ]; then
      avisos="$avisos${avisos:+

}PR(s) ABERTO(s) de outra sessao tocando arquivo(s) que este PR tambem toca:
$col_prs"
    fi
  fi
fi

[ -n "$avisos" ] || exit 0

# Anti-alarm-fatigue (só no commit): avisa 1x por (branch, conjunto colidente). Commit é
# frequente — repetir o MESMO aviso cega o leitor. Colisão nova = assinatura nova = avisa.
# O `gh pr create` é o último portão e NUNCA é silenciado por este cache — inclusive
# quando vem ENCADEADO com o commit (`$tem_create`), caso em que o modo é `commit`.
if [ "$modo" = "commit" ] && [ -z "$tem_create" ]; then
  cache_dir="${PRCG_CACHE_DIR:-${TMPDIR:-/tmp}/prcg-$(id -u 2>/dev/null || echo 0)}"
  mkdir -p "$cache_dir" 2>/dev/null || true
  assin="$(printf '%s\n%s' "$(git branch --show-current 2>/dev/null)" "$avisos" \
    | cksum 2>/dev/null | tr -cd '0-9')"
  if [ -n "$assin" ]; then
    marca="$cache_dir/visto-$assin"
    if [ -f "$marca" ] && [ -z "$(find "$marca" -mmin +"${PRCG_VISTO_TTL_MIN:-360}" 2>/dev/null)" ]; then
      exit 0   # já avisei esta MESMA colisão nesta branch — não repito
    fi
    : > "$marca" 2>/dev/null || true
  fi
fi

if [ "$modo" = "commit" ]; then
  quando="ANTES de commitar"
  acao="Decida AGORA, antes de escrever mais: se o núcleo já mergeou ou está em voo, o barato é reduzir
já ao seu DIFERENCIAL (ou abortar). Descobrir isso com o PR pronto custou 2 PRs em 2026-08-15 (#1757/#1764)."
else
  quando="na hora do gh pr create"
  acao="Antes de criar: se o núcleo já mergeou/está em voo, fechar > reconciliar — salve só o SEU diferencial num PR enxuto sobre o vencedor."
fi

msg="⚠️ Colisão multi-sessão detectada $quando (re-conferência automática — worktrees.md §Colisão de CÓDIGO).
$avisos

$acao Para inspecionar: gh pr list --search \"<domínio>\" e git log origin/main -- <arquivo>."
jq -n --arg m "$msg" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
exit 0

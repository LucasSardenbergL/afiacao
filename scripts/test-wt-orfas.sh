#!/usr/bin/env bash
# test-wt-orfas.sh — TDD da MEDIÇÃO do scripts/wt-orfas.sh.
#
# O que se prova aqui não é formatação: é que o teste usado pelo script mede a
# coisa certa. Três medidas ingênuas inflaram a apuração de 2026-08-06 (66 falsos
# pendentes, 9 falsos "PR aberto", 18 commits fantasma numa branch de 1) e cada
# uma tem caso abaixo — com um squash-merge DE VERDADE num repo git descartável,
# porque a armadilha só aparece depois do squash realmente feito.
#
# Vereditos em ASCII de caixa fixa de propósito: casar string acentuada com -i
# muda de resultado entre LC_ALL=C e pt_BR.UTF-8 e a asserção passa por acidente
# de ambiente (#1483).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$here/wt-orfas.sh" # expõe as funções puras sem rodar main

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

ok() { echo "  ok    $1"; }
ruim() {
  echo "  FALHA $1"
  fail=1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else ruim "$1 (esperado '$3', veio '$2')"; fi; }
verdade() { if "${@:2}"; then ok "$1"; else ruim "$1 (esperava verdadeiro)"; fi; }
mentira() { if "${@:2}"; then ruim "$1 (esperava falso)"; else ok "$1"; fi; }

T() { printf '%s%s%s%s%s%s%s\n' "$1" "$SEP" "$2" "$SEP" "$3" "$SEP" "$4"; }

echo "── nome da pasta de transcript ──"
eq "prefixo do projeto" "$(prefixo_projeto /Users/x/Projetos/afiacao)" "-Users-x-Projetos-afiacao"
eq "nome do worktree" \
  "$(nome_worktree "/p/-Users-x-afiacao--claude-worktrees-foo-123" "-Users-x-afiacao")" "foo-123"
eq "pasta de outro projeto" \
  "$(nome_worktree "/p/-Users-x-OUTRO--claude-worktrees-foo" "-Users-x-afiacao")" ""
eq "pasta sem sufixo de worktree" \
  "$(nome_worktree "/p/-Users-x-afiacao" "-Users-x-afiacao")" ""

echo
echo "── ARMADILHA 2: pr-link grava PR CITADO, nao so o produzido ──"
PRS="$tmp/prs"
{
  T 100 MERGED claude/alfa aaa111
  T 101 OPEN claude/beta bbb222
  T 102 CLOSED claude/alfa ccc333
  T 103 MERGED outra/coisa ddd444
} >"$PRS"

eq "so os PRs da branch entram" \
  "$(prs_da_branch claude/alfa <"$PRS" | cut -d"$SEP" -f1 | tr '\n' ' ')" "100 102 "
eq "PR de outra branch fica de fora" \
  "$(prs_da_branch claude/alfa <"$PRS" | command grep -c 103 || true)" "0"
eq "sessao que rodou na main nao e dona de PR" \
  "$(prs_da_branch main <"$PRS" | wc -l | tr -d ' ')" "0"
eq "branch vazia nao casa nada" \
  "$(prs_da_branch '' <"$PRS" | wc -l | tr -d ' ')" "0"

echo
echo "── campo VAZIO no meio nao pode deslocar os seguintes ──"
# O bug que isto pega: com IFS=<TAB>, `read` COLAPSA tabs consecutivos (tab e
# IFS-whitespace), o campo vazio some e cada campo seguinte anda uma casa. So
# quebra na linha que TEM campo vazio — aqui, sessao que nao citou PR nenhum —
# entao 117 das 449 linhas sairam com a branch trocada pelo numero do peso e
# classificadas como SEM RASTRO. Silencioso: o relatorio inteiro parecia plausivel.
fake="$tmp/fake"
mkdir -p "$fake"
{
  echo '{"type":"custom-title","customTitle":"Sessao sem PR nenhum"}'
  echo '{"cwd":"/x","gitBranch":"claude/sem-pr","type":"user"}'
  echo '{"cwd":"/x","gitBranch":"claude/sem-pr","type":"assistant"}'
} >"$fake/sem-pr.jsonl"
{
  echo '{"type":"custom-title","customTitle":"Sessao com PR"}'
  echo '{"cwd":"/x","gitBranch":"claude/com-pr","type":"user"}'
  echo '{"type":"pr-link","prNumber":1234,"prUrl":"x"}'
} >"$fake/com-pr.jsonl"

le() { # roda o consumidor REAL sobre a saida do meta e devolve "branch|peso"
  meta_transcript "$1" "$tmp" |
    while IFS="$SEP" read -r _t _p b w; do printf '%s|%s\n' "$b" "$w"; done
}
eq "sem PR citado: branch e peso intactos" "$(le "$fake/sem-pr.jsonl")" "claude/sem-pr|2"
eq "com PR citado: idem" "$(le "$fake/com-pr.jsonl")" "claude/com-pr|1"
eq "titulo vazio tambem nao desloca" \
  "$(printf '%s%s%s%s%s%s%s\n' '' "$SEP" '' "$SEP" 'claude/x' "$SEP" '9' |
    while IFS="$SEP" read -r _t _p b w; do printf '%s|%s' "$b" "$w"; done)" "claude/x|9"

echo
echo "── classificacao (contadores entram por parametro, nada vaza da iteracao anterior) ──"
#          ref_existe n_pend n_merged n_open n_closed
eq "PR aberto vence tudo" "$(classificar 1 0 1 1 0)" "pr-aberto"
eq "tudo na main" "$(classificar 1 0 1 0 0)" "entregue"
eq "commits sem PR nenhum" "$(classificar 1 3 0 0 0)" "commits-soltos"
eq "commits com PR fechado sem merge" "$(classificar 1 3 0 0 1)" "pr-fechado"
eq "sem ref, mas com merge = provado" "$(classificar 0 0 1 0 0)" "entregue"
eq "sem ref e sem merge = ausencia de dado" "$(classificar 0 0 0 0 0)" "branch-sumiu"
mentira "HEAD nao e branch de trabalho" branch_util HEAD
mentira "nome vazio nao e branch" branch_util ''
verdade "branch normal passa" branch_util claude/alfa
verdade "commits-soltos e pendencia" eh_pendente commits-soltos
verdade "pr-aberto e pendencia" eh_pendente pr-aberto
mentira "entregue nao e pendencia" eh_pendente entregue
mentira "sem rastro nao conta como pendencia" eh_pendente branch-sumiu

echo
echo "── squash-merge DE VERDADE (armadilhas 1 e 3) ──"
repo="$tmp/repo"
git init -q -b main "$repo" 2>/dev/null || {
  echo "  SKIP  git init falhou"
  exit "$fail"
}
(
  cd "$repo" || exit 1
  git config user.email t@t.t
  git config user.name t
  git commit -q --allow-empty -m base
  git checkout -q -b claude/feature
  for i in 1 2 3; do
    echo "$i" >"f$i.txt"
    git add "f$i.txt"
    git commit -q -m "commit $i"
  done
) || {
  echo "  FALHA nao montei o repo"
  exit 1
}

tip="$(git -C "$repo" rev-parse claude/feature)"
(
  cd "$repo" || exit 1
  git checkout -q main
  git merge -q --squash claude/feature
  git commit -q -m "feat: tudo de uma vez (#123)"
) || {
  echo "  FALHA nao consegui fazer o squash"
  exit 1
}

# o que o GitHub gravaria no PR merged desta branch
BPRS="$tmp/bprs"
T 123 MERGED claude/feature "$tip" >"$BPRS"

# --- a medida ERRADA (documentada aqui pra nao voltar) ---
if git -C "$repo" merge-base --is-ancestor claude/feature main 2>/dev/null; then
  ruim "premissa: --is-ancestor deveria dar FALSO apos squash (o teste ingenuo)"
else
  ok "confirmado: --is-ancestor diz 'nao entregue' apos squash — por isso nao e o teste"
fi
eq "confirmado: git cherry acusa os 3 commits ja entregues" \
  "$(git -C "$repo" cherry main claude/feature | command grep -c '^+' || true)" "3"

# --- a medida CERTA ---
verdade "headRefOid == tip prova a entrega" tip_entregue_por_merge "$tip" <"$BPRS"
eq "oid do merge vira piso do rev-list" "$(oids_merged <"$BPRS")" "$tip"
eq "rev-list nao acusa nada pendente" \
  "$(git -C "$repo" rev-list --count claude/feature --not main "$tip")" "0"

# --- e nao pode perder o que veio DEPOIS do merge ---
(
  cd "$repo" || exit 1
  git checkout -q claude/feature
  echo depois >f4.txt
  git add f4.txt
  git commit -q -m "commit 4 (pos-merge)"
) || {
  echo "  FALHA nao consegui commitar pos-merge"
  exit 1
}
mentira "tip mudou: o merge antigo nao cobre mais" tip_entregue_por_merge \
  "$(git -C "$repo" rev-parse claude/feature)" <"$BPRS"
eq "rev-list acha exatamente o commit novo" \
  "$(git -C "$repo" rev-list --count claude/feature --not main "$tip")" "1"
eq "confirmado: git cherry inflaria para 4" \
  "$(git -C "$repo" cherry main claude/feature | command grep -c '^+' || true)" "4"

echo
if [ "$fail" -eq 0 ]; then echo "PASS medicao correta"; else echo "FALHOU"; fi
exit "$fail"

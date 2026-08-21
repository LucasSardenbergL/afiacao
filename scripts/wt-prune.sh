#!/usr/bin/env bash
# wt-prune.sh — remove a worktree cuja CONVERSA foi EXCLUÍDA do histórico do app
#               (e cujo trabalho está 100% salvo). É o "excluir a worktree junto
#               com a conversa" — de forma diferida e segura.
#
# Excluir a conversa nos "três pontos" do app NÃO dispara hook nenhum (a ação é
# muda — só some o .jsonl de ~/.claude/projects). Então, em vez de reagir ao
# evento, este comando RECONCILIA: a worktree cuja conversa sumiu vira candidata.
# A worktree de uma conversa que AINDA existe no histórico é preservada (você
# pode voltar nela). O wt:clean só apaga node_modules; este remove a worktree.
#
# SÓ remove uma worktree quando TODAS estas condições valem (desenho com o codex):
#   - não é a atual, não tem sessão/processo VIVO (lsof), não está `locked`;
#   - a CONVERSA foi EXCLUÍDA do histórico (não há mais .jsonl da worktree em
#     ~/.claude/projects) — conversa ainda viva no histórico = PRESERVA;
#   - working tree limpo: `git status --porcelain --untracked-files=all` vazio;
#   - arquivos IGNORADOS só na allowlist de descartáveis (node_modules, dist, …);
#     um .env só passa se for byte-idêntico ao da worktree atual (senão pode ter
#     segredo único) — qualquer ignored fora disso BLOQUEIA a remoção;
#   - trabalho 100% salvo, por UM de:
#       (A) HEAD é ancestral de origin/main  → já está na main; ou
#       (B) a branch tem PR MERGEADO cujo headRefOid == HEAD → squash-merge, sem
#           commits locais posteriores ao merge (PR mergeado sozinho NÃO basta:
#           a branch pode ter avançado depois do merge).
#   - revalida tudo imediatamente antes do `git worktree remove` (sem --force);
#   - NUNCA apaga a branch (cleanup de branch é outra operação) — todo commit
#     fica recuperável com `git worktree add <path> <branch>`.
#
# `git fetch origin --prune` é OBRIGATÓRIO no início; se falhar, não remove nada.
#
# ⚠️ Este script REMOVE worktrees. Quatro regras vieram do #1838 e da varredura
# dos irmãos — todas travadas por `scripts/test-wt-prune.sh`:
#
#   0. `mktemp` puro, NUNCA `mktemp -t <prefixo>`: o BSD trata o argumento como
#      PREFIXO e funciona; o GNU o trata como TEMPLATE e EXIGE `XXXXXX`, saindo
#      1 com "too few X's". Sob `set -e` isso mata o script na primeira linha —
#      ou seja, este script nunca rodou em Linux, e só se soube quando a suíte
#      nova o EXECUTOU no CI Ubuntu (20 de 25 asserções vermelhas). É o mesmo
#      eco que o #1838 levou do `vm_stat`, e a irmã da flag homônima BSD/GNU já
#      registrada no CLAUDE.md — só que esta FALHA em vez de fazer outra coisa.
#
#   1. Sonda de segurança AUSENTE é fail-CLOSED, não "sem medida". Medidos DOIS
#      casos, os dois virando remoção indevida em silêncio: (a) `lsof` devolvendo
#      127 esvazia o `active_file`, `is_active` responde "não" para todo mundo e
#      a worktree de sessão VIVA passa de "skip (sessão/processo ativo)" para
#      "would … -250 MB"; (b) `md5` ausente faz os dois lados da comparação
#      virarem string vazia, `[ "" = "" ]` dá VERDADEIRO e o `.env` com segredo
#      único — o exato caso que a allowlist existe para bloquear — é classificado
#      como descartável. Guard que emudece não protege nada.
#   2. `sz="$(du -sm "$wt" | cut -f1)"` sob `set -e`+`pipefail`, em `handle()`
#      (chamada SOLTA, `set -e` ativo), MATA o script quando o `du` falha —
#      medido: EXIT=1 com a varredura parando na 1ª worktree, e no `--yes` isso
#      acontece DEPOIS de já ter removido, sem imprimir o resumo do que fez. O
#      `${sz:-0}` da linha seguinte nunca chegava a rodar. Sem teto, ainda: aqui
#      o `du` é da worktree INTEIRA (node_modules incluso).
#   3. Nenhum leitor que fecha o pipe cedo (`| head`): use `awk 'NR<=N'`, que lê
#      até o EOF. Hoje o `| head -3` do `ignored_blockers` sobrevive por ACIDENTE
#      — `classify` só é chamada dentro de `if !`, e isso suspende o `set -e`
#      (medido: o mesmo pipeline solto sai 141 e mata). Depender de contexto de
#      chamada para não morrer é armadilha para o próximo refactor. Esta troca é
#      PREVENTIVA e não tem teste que a distinga: devolver o `| head -3` numa
#      cópia deixa o `test-wt-prune.sh` VERDE (medido na falsificação), porque
#      enquanto a chamada estiver dentro do `if !` a diferença é inobservável.
#
# Uso:
#   bun run wt:prune          # DRY-RUN: classifica e mostra o que faria
#   bun run wt:prune --yes    # executa de verdade
set -euo pipefail

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) YES=1 ;;
    -h | --help)
      sed -n '2,53p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/wt-medida.sh disable=SC1091
. "$here/lib/wt-medida.sh"

rp() { realpath "$1" 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
self="$(rp "$PWD")"
ref_env_dir="$self" # referência p/ comparar .env (todas as worktrees têm cópia idêntica)

# --- fetch obrigatório ------------------------------------------------------
echo "Atualizando refs do origin (obrigatório p/ avaliar 'mergeada')…"
if ! git fetch origin --prune --quiet 2>/dev/null; then
  echo "❌ git fetch origin falhou — não removo nada às cegas. Cheque a rede e tente de novo." >&2
  exit 1
fi
if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  echo "❌ origin/main não existe após o fetch — abortando." >&2
  exit 1
fi

# --- mapa branch->headRefOid de PRs mergeados (best-effort) ------------------
prmap="$(mktemp)"
trap 'rm -f "$prmap" "$active_file" 2>/dev/null || true' EXIT
if ! { command -v gh >/dev/null 2>&1 \
  && gh pr list --state merged --limit 2000 --json headRefName,headRefOid \
       --jq '.[] | "\(.headRefOid)\t\(.headRefName)"' >"$prmap" 2>/dev/null; }; then
  : >"$prmap"
  echo "⚠️  gh indisponível — só o caminho (A) 'ancestral de origin/main' será usado." >&2
fi

# --- diretórios com processo vivo (cwd dentro) ------------------------------
# Sem `lsof` não há como saber quem está trabalhando, e o efeito colateral de
# errar aqui é remover a worktree de uma sessão viva.
if ! sonda_lsof_ok; then
  if [ "$YES" -eq 1 ]; then
    echo "❌ lsof não respondeu (ausente ou quebrado) — sem ele não sei quais worktrees têm" >&2
    echo "   sessão viva, e remover às cegas pode derrubar a worktree de quem está trabalhando. Abortando." >&2
    exit 1
  fi
  SONDA_ATIVIDADE=0
else
  SONDA_ATIVIDADE=1
fi

active_file="$(mktemp)"
{
  for proc in claude bun node vite tsx vitest esbuild npm; do
    lsof -nP -a -c "$proc" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  done
} | while IFS= read -r d; do [ -n "$d" ] && rp "$d"; done | sort -u >"$active_file" 2>/dev/null || true

is_active() {
  local wt="$1" d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ "$d" = "$wt" ] && return 0
    case "$d/" in "$wt"/*) return 0 ;; esac
  done <"$active_file"
  return 1
}

# arquivos ignorados que NÃO são descartáveis (vazio = pode remover) ----------
ignored_blockers() {
  local wt="$1" p base h1 h2
  git -C "$wt" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p' | while IFS= read -r p; do
    [ -n "$p" ] || continue
    base="$(basename "${p%/}")"
    case "$base" in
      node_modules | dist | build | .vite | .turbo | coverage | .DS_Store | *.log | *.tsbuildinfo) ;;
      .env | .env.*)
        # Fail-closed: sem sonda de hash não dá para afirmar "idêntico ao de
        # referência", e o custo de errar é perder um .env com segredo único.
        # Comparar dois `md5` ausentes dava `[ "" = "" ]` → verdadeiro → descarte.
        if [ -f "$ref_env_dir/$base" ] \
          && h1="$(hash_arquivo "$wt/${p%/}")" \
          && h2="$(hash_arquivo "$ref_env_dir/$base")" \
          && [ -n "$h1" ] && [ "$h1" = "$h2" ]; then
          : # idêntico ao de referência → descartável
        else
          echo "$p"
        fi
        ;;
      *) echo "$p" ;;
    esac
  done
}

# path da worktree -> diretório de transcript do Claude Code -----------------
enc() { printf '%s' "$1" | sed 's#[/.]#-#g'; }
has_transcript() {
  # conversa "ainda no histórico" = há ≥1 .jsonl no dir de transcript da worktree.
  # excluir a conversa nos 3-pontos remove o .jsonl → este teste passa a falhar.
  local wt="$1" dir
  dir="$HOME/.claude/projects/$(enc "$wt")"
  ls "$dir"/*.jsonl >/dev/null 2>&1
}

# elegível? define REASON. retorna 0 se pode remover -------------------------
classify() {
  local wt="$1" branch head dirty blk
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)" || { REASON="git ilegível"; return 1; }
  head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || { REASON="git ilegível"; return 1; }

  dirty="$(git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' ')"
  [ "$dirty" != "0" ] && { REASON="trabalho não-commitado ($dirty)"; return 1; }

  blk="$(ignored_blockers "$wt" | awk 'NR<=3' | tr '\n' ' ')"
  [ -n "$blk" ] && { REASON="ignored não-descartável: $blk"; return 1; }

  if has_transcript "$wt"; then REASON="conversa ainda no histórico [$branch]"; return 1; fi

  if git -C "$wt" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    REASON="na main [$branch]"; return 0
  fi
  if awk -v b="$branch" -v h="$head" -F'\t' '$1==h && $2==b{f=1} END{exit !f}' "$prmap"; then
    REASON="PR mergeado, HEAD==oid [$branch]"; return 0
  fi
  REASON="trabalho não salvo na main [$branch]"; return 1
}

# --- varre os worktrees -----------------------------------------------------
removed=0; freed=0; kept=0; sem_medida=0
# ausente ≠ zero: o não-medido conta na COBERTURA, nunca no total de MB.
soma_medida() {
  if [ "$2" -eq 0 ]; then freed=$((freed + $1)); else sem_medida=$((sem_medida + 1)); fi
}
cur_wt=""; cur_locked=0

handle() {
  [ -n "$cur_wt" ] || return 0
  local wt sz rc; wt="$(rp "$cur_wt")"
  local short="${wt/#$HOME/~}"

  if [ "$wt" = "$self" ]; then printf '  skip    %-50s (atual)\n' "$short"; kept=$((kept+1)); return 0; fi
  if [ "$cur_locked" -eq 1 ]; then printf '  skip    %-50s (locked)\n' "$short"; kept=$((kept+1)); return 0; fi
  if is_active "$wt"; then printf '  skip    %-50s (sessão/processo ativo)\n' "$short"; kept=$((kept+1)); return 0; fi

  if ! classify "$wt"; then
    printf '  KEEP    %-50s (%s)\n' "$short" "$REASON"; kept=$((kept+1)); return 0
  fi

  sz="$(du_mb "$wt")" && rc=0 || rc=$?
  if [ "$YES" -eq 1 ]; then
    # revalidação final (fecha corrida com sessão que reabriu / arquivo que mudou)
    if is_active "$wt" || ! classify "$wt"; then
      printf '  skip    %-50s (mudou na revalidação)\n' "$short"; kept=$((kept+1)); return 0
    fi
    if git worktree remove "$wt" 2>/tmp/wt-prune-err; then
      printf '  PRUNE   %-50s %s (%s)\n' "$short" "$(medida_humana "$sz" "$rc")" "$REASON"
      removed=$((removed+1)); soma_medida "$sz" "$rc"
    else
      printf '  FALHOU  %-50s (%s)\n' "$short" "$(tr -d '\n' </tmp/wt-prune-err)"; kept=$((kept+1))
    fi
  else
    printf '  would   %-50s %s (%s)\n' "$short" "$(medida_humana "$sz" "$rc")" "$REASON"
    removed=$((removed+1)); soma_medida "$sz" "$rc"
  fi
}

echo "Varrendo worktrees…"
while IFS= read -r line; do
  case "$line" in
    "worktree "*) handle; cur_wt="${line#worktree }"; cur_locked=0 ;;
    locked*) cur_locked=1 ;;
    "") handle; cur_wt=""; cur_locked=0 ;;
  esac
done < <(git worktree list --porcelain)
handle

[ "$YES" -eq 1 ] && git worktree prune 2>/dev/null || true

echo
piso=""
[ "$sem_medida" -gt 0 ] && piso=" (piso — medidos: $((removed - sem_medida)) de ${removed})"
if [ "$YES" -eq 1 ]; then
  echo "✅ removidas ${removed} worktree(s) de conversa excluída, ~${freed} MB liberados${piso}. ${kept} preservada(s)."
  echo "   Branches NÃO foram apagadas — recupere qualquer uma com: git worktree add <path> <branch>"
else
  echo "DRY-RUN: removeria ${removed} worktree(s) de conversa EXCLUÍDA (~${freed} MB${piso}); preservaria ${kept}."
  echo "         Rode 'bun run wt:prune --yes' pra executar."
fi
if [ "$sem_medida" -gt 0 ]; then
  echo "         sem medida: ${sem_medida} — não é 0 MB, é dado que falta (o total acima é PISO)."
fi
if [ "$SONDA_ATIVIDADE" -eq 0 ]; then
  echo "⚠️  lsof não respondeu: NÃO sei quais worktrees têm sessão viva, então este dry-run" >&2
  echo "   não é confiável — qualquer 'would' pode ser de uma sessão em uso. O --yes aborta." >&2
fi

#!/usr/bin/env bash
# wt-orfas.sh — sessões Claude cujo worktree SUMIU: o que ficou pra trás.
#
# Irmão do wt-status/wt-clean/wt-reap/wt-prune. Enquanto eles cuidam de RAM e
# disco das worktrees VIVAS, este olha as MORTAS: a pasta de transcript em
# ~/.claude/projects sobrevive ao `git worktree remove`, e com ela o rastro de
# trabalho que talvez nunca tenha chegado na main. Em 2026-08-06 eram 104
# sessões nesse estado — 15 com commit fora da main, incluindo money-path.
#
# Não muda nada — só lê, cruza com o GitHub e reporta.
#
# AS TRÊS ARMADILHAS DE MEDIÇÃO (cada uma inflou o resultado na apuração):
#   1. SQUASH-MERGE: `git merge-base --is-ancestor <branch> origin/main` NUNCA é
#      verdade numa branch squash-mergeada — o squash reescreve o commit. Acusava
#      66 falsos pendentes. Aqui o teste é a identidade que o GitHub registrou:
#      headRefOid do PR MERGED == tip da branch.
#   2. PR CITADO ≠ PR PRODUZIDO: a linha `pr-link` do transcript grava todo PR
#      mencionado na conversa (uma sessão listava 17 que não produziu) — 9 falsos
#      "PR aberto". Aqui quem classifica é headRefName == branch da sessão; os
#      citados entram só como informação.
#   3. `git cherry` NÃO SOBREVIVE A SQUASH de N commits: o patch combinado não
#      bate com os individuais — acusou 18 commits perdidos numa branch de 1.
#      Aqui: git rev-list --count <headRefOid>..<branch> --not origin/main
#
# ⚠️ É um filtro de TRIAGEM, não veredito: mede COMMIT fora da main, que não é o
#    mesmo que TRABALHO fora da main — num repo que faz squash, o conteúdo pode ter
#    chegado por outro PR sem o commit virar ancestral. Confirme cada candidata com
#    o diff ancorado no merge-base antes de agir:
#      mb=$(git merge-base origin/main <branch>) && git diff "$mb" <branch>
#    Medido: das 40 candidatas de 2026-08-07, as 2 money-path estavam ENTREGUES.
#    Detalhe em docs/historico/medicao-trabalho-nao-entregue.md (§ o limite que fica).
#
# Uso:
#   bun run wt:orfas              # candidatas: commit fora da main (≠ trabalho)
#   bun run wt:orfas --todas      # inclui as sessões já entregues
#   bun run wt:orfas --sem-fetch  # pula o `git fetch` (mais rápido, menos fresco)
#   bun run wt:orfas --sem-cache  # ignora o cache de metadados do transcript
set -u

PROJETOS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
# O `v2` é a versão do FORMATO gravado, não do script: a chave do cache é
# arquivo+mtime+tamanho, e transcript de sessão morta nunca muda — então mudar o
# layout de `meta_transcript` sem subir isto serviria dado velho para sempre.
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/afiacao/wt-orfas/v2"

# Separador de campo interno: US (0x1f), NÃO tabulação. `IFS=$'\t' read` COLAPSA
# tabs consecutivos — tab é IFS-*whitespace* — então um campo vazio no meio
# desaparece e desloca todos os seguintes. Silencioso por construção: só erra na
# linha que TEM campo vazio (aqui, sessão sem PR citado), e o campo seguinte
# ocupa o lugar do que sumiu — a branch virava o número do peso.
SEP=$'\037'

# ─────────────────────────── decisões PURAS (testáveis sem git/gh) ────────────

# prefixo com que o Claude Code nomeia a pasta do projeto: troca '/' e '.' por '-'
#   /Users/x/afiacao  →  -Users-x-afiacao
prefixo_projeto() { printf '%s' "$1" | tr '/.' '--'; }

# nome do worktree a partir da pasta de transcript; vazio se não é deste projeto.
#   -Users-x-afiacao--claude-worktrees-foo-123  →  foo-123
nome_worktree() {
  local base="${1##*/}" prefixo="$2" marca
  marca="$prefixo--claude-worktrees-"
  case "$base" in
    "$marca"?*) printf '%s' "${base#"$marca"}" ;;
    *) : ;;
  esac
}

# ARMADILHA 2 — os PRs que são DESTA branch. stdin: `num·state·head·oid` (· = SEP)
# de TODOS os PRs do repo. Filtra por headRefName: PR só citado na conversa (de
# outra branch) não entra. `main` não tem dono — sessão que rodou nela não é dona
# de PR nenhum.
prs_da_branch() {
  local branch="$1" num st head oid
  case "$branch" in '' | main | master) return 0 ;; esac
  while IFS="$SEP" read -r num st head oid; do
    [ "${head:-}" = "$branch" ] &&
      printf '%s%s%s%s%s%s%s\n' "$num" "$SEP" "$st" "$SEP" "$head" "$SEP" "$oid"
  done
  return 0
}

# ARMADILHA 1 — o tip da branch já foi entregue por um merge? stdin: TSV dos PRs
# da branch. `--is-ancestor` responde NÃO para toda branch squash-mergeada; o que
# prova é o oid que o GitHub gravou como cabeça no momento do merge.
tip_entregue_por_merge() {
  local tip="$1" num st head oid
  [ -n "$tip" ] || return 1
  while IFS="$SEP" read -r num st head oid; do
    [ "${st:-}" = "MERGED" ] || continue
    [ "${oid:-}" = "$tip" ] && return 0
  done
  return 1
}

# ARMADILHA 3 — os oids que servem de PISO pra contar o que sobrou. Cada merge
# entregue vira um `--not <oid>` no rev-list: o que restar é commit feito DEPOIS
# do merge e que nunca chegou na main. (`git cherry` compara PATCH e erra aqui.)
oids_merged() {
  local num st head oid
  while IFS="$SEP" read -r num st head oid; do
    [ "${st:-}" = "MERGED" ] && [ -n "${oid:-}" ] && printf '%s\n' "$oid"
  done
  return 0
}

# estado final de uma branch órfã. Tudo entra por parâmetro de propósito: contador
# que não zera entre iterações contamina a linha seguinte do relatório.
#   classificar <ref_existe> <n_pend> <n_merged> <n_open> <n_closed>
classificar() {
  local ref_existe="$1" n_pend="$2" n_merged="$3" n_open="$4" n_closed="$5"
  if [ "$n_open" -gt 0 ]; then printf 'pr-aberto'; return 0; fi
  if [ "$ref_existe" -eq 0 ]; then
    # sem ref local nem remota: só um merge PROVA entrega. Sem ele é ausência de
    # dado, não aprovação — vai pra indeterminado, não pra "entregue".
    if [ "$n_merged" -gt 0 ]; then printf 'entregue'; else printf 'branch-sumiu'; fi
    return 0
  fi
  if [ "$n_pend" -gt 0 ]; then
    if [ "$n_closed" -gt 0 ]; then printf 'pr-fechado'; else printf 'commits-soltos'; fi
    return 0
  fi
  printf 'entregue'
}

# nome que não representa trabalho de uma sessão. `HEAD` é o sentinela que o
# transcript grava em detached HEAD — e ele resolve por `refs/remotes/origin/HEAD`
# (→ origin/main), então passaria como "entregue" por acidente, não por medida.
branch_util() {
  case "${1:-}" in '' | HEAD) return 1 ;; *) return 0 ;; esac
}

# pendência = precisa de ação humana. `branch-sumiu` é ausência de dado e sai
# separado: não é prova de entrega nem de perda.
eh_pendente() {
  case "$1" in pr-aberto | pr-fechado | commits-soltos) return 0 ;; *) return 1 ;; esac
}

# ─────────────────────────── coleta ───────────────────────────────────────────

# GNU primeiro e validando NUMERO, nao confiando no `||`: no Linux `stat -f %m` NAO falha do jeito
# que o idioma supoe (-f la e --file-system e nao consome formato) — sai !=0 mas ANTES ja despejou no
# stdout o bloco multi-linha do filesystem, e o `a || b` concatena os dois. Mordido 2× em hooks
# (branch-pos-squash-guard, read-contexto-nudge). Ver docs/agent/worktrees.md.
mtime_de() {
  local v
  v="$(stat -c %Y "$1" 2>/dev/null)"
  case "$v" in '' | *[!0-9]*) v="$(stat -f %m "$1" 2>/dev/null)" ;; esac
  case "$v" in '' | *[!0-9]*) v=0 ;; esac
  printf '%s' "$v"
}

# metadados de UM transcript, numa passada só de grep (os .jsonl têm MBs; jq
# direto neles é lento demais). Emite (· = SEP):
#   titulo·prs_citados·branch·peso   (uma linha por branch da sessão)
# `command grep` de propósito: o `grep` deste ambiente é shim do ugrep.
meta_transcript() {
  local f="$1" tmp="$2" bruto="$2/bruto" titulo prs
  command grep -h -o -E \
    '"customTitle":"([^"\\]|\\.)*"|"gitBranch":"[^"]*"|"prNumber":[0-9]+' \
    -- "$f" 2>/dev/null >"$bruto" || true
  [ -s "$bruto" ] || return 0

  titulo="$(command grep -F '"customTitle":' -- "$bruto" | tail -1 |
    sed 's/^"customTitle":"//; s/"$//')"
  prs="$(command grep -F '"prNumber":' -- "$bruto" | sed 's/^.*://' |
    sort -un | tr '\n' ' ' | sed 's/ $//')"

  # uma sessão toca N branches (entra e sai de worktree, troca de checkout): 144
  # dos 326 transcritos têm mais de uma. Emite TODAS com o peso — descartar as
  # secundárias esconderia trabalho.
  command grep -F '"gitBranch":' -- "$bruto" | sort | uniq -c |
    sed 's/^ *//; s/^\([0-9]*\) "gitBranch":"\(.*\)"$/\1 \2/' |
    while read -r peso branch; do
      [ -n "${branch:-}" ] || continue
      printf '%s%s%s%s%s%s%s\n' "$titulo" "$SEP" "$prs" "$SEP" "$branch" "$SEP" "$peso"
    done
  return 0
}

# mesma coisa, com cache: transcript de sessão morta nunca mais muda, então a
# chave (mtime+tamanho) invalida sozinha se mudar.
meta_transcript_cache() {
  local f="$1" tmp="$2" usar_cache="$3" chave alvo tam
  if [ "$usar_cache" -eq 0 ]; then
    meta_transcript "$f" "$tmp"
    return 0
  fi
  tam="$(wc -c <"$f" 2>/dev/null | tr -d ' ')"
  chave="$(printf '%s|%s|%s' "$f" "$(mtime_de "$f")" "${tam:-0}" | cksum | tr -d ' ')"
  alvo="$CACHE_DIR/$chave"
  if [ -f "$alvo" ]; then cat -- "$alvo"; return 0; fi
  mkdir -p "$CACHE_DIR" 2>/dev/null || true
  meta_transcript "$f" "$tmp" >"$alvo.tmp" 2>/dev/null || true
  mv -f -- "$alvo.tmp" "$alvo" 2>/dev/null || true
  cat -- "$alvo" 2>/dev/null || true
  return 0
}

# ─────────────────────────── relatório ────────────────────────────────────────

rotulo() {
  case "$1" in
    pr-aberto) printf 'PR ABERTO     ' ;;
    pr-fechado) printf 'PR SEM MERGE  ' ;;
    commits-soltos) printf 'COMMITS SOLTOS' ;;
    branch-sumiu) printf 'SEM RASTRO    ' ;;
    *) printf 'entregue      ' ;;
  esac
}

main() {
  set -uo pipefail
  local TODAS=0 FETCH=1 CACHE=1 arg
  for arg in "$@"; do
    case "$arg" in
      --todas | -a) TODAS=1 ;;
      --sem-fetch) FETCH=0 ;;
      --sem-cache) CACHE=0 ;;
      -h | --help)
        sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *)
        echo "argumento desconhecido: $arg" >&2
        exit 2
        ;;
    esac
  done

  command -v gh >/dev/null 2>&1 || {
    echo "erro: preciso do 'gh' pra saber o estado dos PRs." >&2
    exit 1
  }

  # tmp global de propósito: o trap EXIT precisa vê-lo depois que main retorna
  tmp="$(mktemp -d)"
  trap '[ -n "${tmp:-}" ] && rm -rf "$tmp"' EXIT

  local raiz prefixo
  raiz="$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
  [ -n "$raiz" ] || {
    echo "erro: rode de dentro do repo (não achei o worktree principal)." >&2
    exit 1
  }
  prefixo="$(prefixo_projeto "$raiz")"

  local base_ref='origin/main'
  if [ "$FETCH" -eq 1 ]; then
    echo "· atualizando origin…" >&2
    git fetch --quiet origin 2>/dev/null || echo "  (fetch falhou — seguindo com o que tem)" >&2
  fi
  git rev-parse --verify --quiet "$base_ref" >/dev/null 2>&1 || base_ref='main'

  # UMA chamada ao GitHub. `gh pr view` por PR seriam 1600+ chamadas.
  local prs_f="$tmp/prs"
  echo "· lendo PRs do GitHub (uma chamada)…" >&2
  if ! gh pr list --state all --limit 3000 \
    --json number,state,mergedAt,headRefName,headRefOid \
    --jq '.[] | [.number, .state, .headRefName, .headRefOid] | map(tostring) | join("\u001f")' \
    >"$prs_f" 2>"$tmp/gh.err"; then
    echo "erro: 'gh pr list' falhou:" >&2
    sed 's/^/  /' "$tmp/gh.err" >&2
    exit 1
  fi

  # branches que ainda estão checadas em worktree VIVA: o trabalho delas não é
  # órfão, mesmo que apareçam no transcript de uma sessão morta.
  local vivas_f="$tmp/vivas"
  git worktree list --porcelain 2>/dev/null |
    sed -n 's|^branch refs/heads/||p' | sort -u >"$vivas_f"

  # ── fase 1: varrer as pastas órfãs → uma linha por (sessão, branch)
  local pares_f="$tmp/pares" n_pastas=0 n_orfas=0 n_sessoes=0
  : >"$pares_f"
  local d nome f mt titulo prs branch peso
  for d in "$PROJETOS_DIR"/*--claude-worktrees-*; do
    [ -d "$d" ] || continue
    nome="$(nome_worktree "$d" "$prefixo")"
    [ -n "$nome" ] || continue
    n_pastas=$((n_pastas + 1))
    [ -d "$raiz/.claude/worktrees/$nome" ] && continue # worktree viva
    n_orfas=$((n_orfas + 1))
    for f in "$d"/*.jsonl; do
      [ -f "$f" ] || continue
      n_sessoes=$((n_sessoes + 1))
      mt="$(mtime_de "$f")"
      while IFS="$SEP" read -r titulo prs branch peso; do
        branch_util "${branch:-}" || continue
        command grep -qxF -- "$branch" "$vivas_f" && continue
        printf '%s%s%s%s%s%s%s%s%s%s%s\n' \
          "$mt" "$SEP" "$nome" "$SEP" "$branch" "$SEP" "${peso:-0}" "$SEP" \
          "${titulo:-(sem título)}" "$SEP" "${prs:-}"
      done < <(meta_transcript_cache "$f" "$tmp" "$CACHE") >>"$pares_f"
    done
  done

  if [ ! -s "$pares_f" ]; then
    echo "✅ nenhuma sessão órfã com branch identificável (${n_pastas} pasta(s) do projeto)."
    return 0
  fi

  # ── fase 2: classificar cada branch UMA vez (a mesma branch aparece em várias
  #    sessões quando o worktree foi reusado)
  local estados_f="$tmp/estados" branch_prs="$tmp/bprs"
  local branches_f="$tmp/branches" prs_rel="$tmp/prs_rel"
  cut -d"$SEP" -f3 "$pares_f" | sort -u >"$branches_f"
  # Pré-filtra os PRs às branches que interessam. Sem isto, `prs_da_branch` varre
  # os 1.664 PRs do repo uma vez POR branch (~830 mil voltas de loop shell, e de
  # novo no relatório) — o `gh` leva 10s e o pós-processamento levava minutos.
  # Não afeta a decisão: quem filtra por headRefName continua sendo a função pura.
  awk -F"$SEP" 'NR==FNR { quer[$0] = 1; next } quer[$3]' "$branches_f" "$prs_f" >"$prs_rel"
  : >"$estados_f"
  local ref tip n_pend n_merged n_open n_closed estado st oid num pr_txt
  while IFS= read -r branch; do
    [ -n "$branch" ] || continue
    # reset explícito a cada volta: contador vazado da iteração anterior
    # contamina a branch seguinte
    ref=''
    tip=''
    n_pend=0
    n_merged=0
    n_open=0
    n_closed=0
    pr_txt=''

    prs_da_branch "$branch" <"$prs_rel" >"$branch_prs"
    while IFS="$SEP" read -r num st _ oid; do
      case "$st" in
        MERGED) n_merged=$((n_merged + 1)) ;;
        OPEN) n_open=$((n_open + 1)) ;;
        CLOSED) n_closed=$((n_closed + 1)) ;;
      esac
      pr_txt="$pr_txt #$num($st)"
    done <"$branch_prs"

    for ref in "refs/heads/$branch" "refs/remotes/origin/$branch"; do
      tip="$(git rev-parse --verify --quiet "$ref" 2>/dev/null)" && [ -n "$tip" ] && break
      tip=''
    done

    if [ -n "$tip" ]; then
      if tip_entregue_por_merge "$tip" <"$branch_prs"; then
        n_pend=0 # ARMADILHA 1: squash entregou; não conte nada
      else
        # ARMADILHA 3: o piso é cada oid de merge, não o patch dos commits
        local -a nots=("$base_ref")
        while IFS= read -r oid; do
          [ -n "$oid" ] || continue
          git cat-file -e "$oid^{commit}" 2>/dev/null && nots+=("$oid")
        done < <(oids_merged <"$branch_prs")
        n_pend="$(git rev-list --count "$tip" --not "${nots[@]}" 2>/dev/null || echo 0)"
      fi
      estado="$(classificar 1 "$n_pend" "$n_merged" "$n_open" "$n_closed")"
    else
      estado="$(classificar 0 0 "$n_merged" "$n_open" "$n_closed")"
    fi
    printf '%s%s%s%s%s%s%s\n' \
      "$branch" "$SEP" "$estado" "$SEP" "$n_pend" "$SEP" "${pr_txt:- —}" >>"$estados_f"
  done <"$branches_f"

  # ── fase 3: juntar. A branch pendente é reportada na sessão mais RECENTE que a
  #    tocou (é onde o founder vai procurar o contexto).
  local linhas_f="$tmp/linhas"
  sort -t"$SEP" -k3,3 -k1,1nr "$pares_f" |
    awk -F"$SEP" '!vista[$3]++' |
    sort -t"$SEP" -k1,1nr >"$linhas_f"

  local n_pend_total=0 n_ok=0 n_indef=0 saida_f="$tmp/saida"
  : >"$saida_f"
  local pr_txt data_txt achado
  while IFS="$SEP" read -r mt nome branch peso titulo prs; do
    [ -n "${branch:-}" ] || continue
    # igualdade exata de campo, não `grep -F` de prefixo: a branch `foo` casaria
    # o começo de `foobar` e herdaria o estado dela
    achado="$(awk -F"$SEP" -v b="$branch" '$1 == b { print $2 FS $3 FS $4; exit }' "$estados_f")"
    IFS="$SEP" read -r estado n_pend pr_txt <<<"$achado"
    estado="${estado:-entregue}"
    case "$estado" in
      entregue) n_ok=$((n_ok + 1)) ;;
      branch-sumiu) n_indef=$((n_indef + 1)) ;;
      *) n_pend_total=$((n_pend_total + 1)) ;;
    esac
    if [ "$TODAS" -eq 0 ] && [ "$estado" = 'entregue' ]; then continue; fi

    [ "${n_pend:-0}" -gt 0 ] 2>/dev/null && pr_txt="$pr_txt  [${n_pend} commit(s) fora da main]"
    data_txt="$(date -r "$mt" '+%Y-%m-%d' 2>/dev/null || echo '????-??-??')"
    {
      printf '  %s  %s  %s\n' "$(rotulo "$estado")" "$data_txt" "$titulo"
      printf '                  wt:%s  branch:%s\n' "$nome" "$branch"
      printf '                  PRs:%s\n' "$pr_txt"
    } >>"$saida_f"
  done <"$linhas_f"

  echo
  echo "═══ sessões Claude órfãs (worktree já removido) ═══"
  echo "  pastas do projeto: ${n_pastas} · órfãs: ${n_orfas} · transcritos: ${n_sessoes}"
  echo "  branches: ${n_pend_total} CANDIDATA(s) · ${n_indef} sem rastro · ${n_ok} entregue(s)"
  echo
  if [ -s "$saida_f" ]; then
    cat "$saida_f"
  else
    echo "  ✅ nada pendente — todo trabalho das sessões órfãs chegou na main."
  fi
  if [ -s "$saida_f" ]; then
    echo
    echo "  ⚠️  CANDIDATAS, não veredito: isto mede COMMIT fora da main. O conteúdo pode"
    echo "     ter chegado por outro PR (squash reescreve). Confirme antes de agir:"
    echo "       mb=\$(git merge-base origin/main <branch>) && git diff \"\$mb\" <branch>"
  fi
  if [ "$TODAS" -eq 0 ] && [ "$n_ok" -gt 0 ]; then
    echo
    echo "  (${n_ok} entregue(s) ocultas — 'bun run wt:orfas --todas' pra ver)"
  fi
  return 0
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi

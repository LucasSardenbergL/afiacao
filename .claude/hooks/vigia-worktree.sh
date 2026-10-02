#!/usr/bin/env bash
# vigia-worktree.sh — SessionStart(startup): worktree pronto-pra-uso + sinais de RAM.
#
# 1) deps SEM resposta positiva (node_modules AUSENTE, VAZIO ou PARCIAL) → delega
#    `bun install` ao BACKGROUND — que não dispara se já houver outro EM VOO nesta
#    worktree — e avisa a sessão nomeando o estado (senão o 1º typecheck dá
#    "Cannot find module" — FALSO vermelho —, ou pior: teste VERDE com as deps do
#    checkout principal; o CI real se confere com `gh pr checks`). Já custou 3×
#    bun install manual + falso alarme de CI (diagnóstico 2026-07) e, com o
#    `node_modules` VAZIO que o teste antigo de existência não via, 5 h de
#    baseline medindo outro ambiente (2026-09-25).
# 2) swap alto / muitas sessões Claude vivas → aviso de higiene (a alavanca real
#    de RAM na M2 8GB é FECHAR sessões — wt:status mostra as ociosas).
# 4) semáforo `heavy` divergente do repo → aviso (nunca instala sozinho).
# 5) processo ÓRFÃO (PPID=1) QUEIMANDO CPU → o ponto cego de 2026-08-23, que
#    custou 17h de máquina inutilizável: 1)-4) mediam só o que o founder já vê
#    na tela (deps, swap, sessões, heavy) e ninguém olhava ppid/pcpu.
# 6) claude-mem que não GRAVA (contador de falhas de hook ou observações paradas)
#    → a falha que o plugin ≥ 13.24.18 passou a engolir em silêncio.
#
# Melhor-esforço: nunca bloqueia; qualquer falha interna vira silêncio ('{}').
set -u

avisos=""

# --- 1) deps da worktree ------------------------------------------------------
# A pergunta é "as deps RESPONDEM?", não "o diretório existe?". Em 2026-09-25 a
# worktree tinha o `node_modules` EXISTENTE e VAZIO: o teste antigo (`! -d`)
# calou — nenhum install, nenhum aviso —, a resolução de módulos SUBIU ao
# checkout principal (`yaml` de afiacao/node_modules, `tsc` 5.8.3: teste verde
# com as deps de OUTRA árvore) e o `exclusividade:medir` gastou 5 h de baseline
# medindo outro ambiente (docs/historico/exclusividade-media-outra-coisa.md).
# Presente-porém-vazio esvazia o guard igual à ausência
# (docs/historico/sonda-ausente-em-script-que-apaga.md).
#
# Sinal positivo POR CONTEÚDO, sem rodar binário: para cada um dos 4 binários de
# BINARIOS_DAS_DEPS (scripts/lib/exclusividade.ts — os do `Unlisted binaries` do
# incidente), `.bin/<b>` tem de RESOLVER num executável (link pendurado falha) e
# o manifesto do pacote dono tem de DECLARAR versão semver (vazio ou truncado
# falha). Pelo CAMINHO LOCAL, nunca pelo nome: pelo nome a resolução sobe a
# árvore e responde pelo checkout principal. Custo medido: ~20 ms os 4. O
# `--version` (a sonda do motor, que tem teto de 60 s) custou 150-800 ms quente
# para 1 e 4 binários, e mais sob swap: seria o 1º subprocess BLOQUEANTE deste
# hook, e um teto curto que o mata vira "sem dado" — que não decide se dispara
# install. Limite: não prova que o binário RODA nem que bate com o lockfile; o
# critério é o do `bun install` para "instalado", o mesmo que o remédio conserta.
DEPS_SONDA="eslint:eslint tsc:typescript vite:vite vitest:vitest"

# ecoa OK | AUSENTE | VAZIO | PARCIAL <binários sem resposta>
estado_deps() {
  local par b p faltas=""
  [ -d node_modules ] || { echo AUSENTE; return; }
  # VAZIO = nenhum PACOTE: entrada oculta (.bin, .vite, .cache) não conta — o vite
  # cria `node_modules/.vite` mesmo resolvendo as deps do checkout de cima.
  set -- node_modules/*
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo VAZIO; return; fi
  for par in $DEPS_SONDA; do
    b="${par%%:*}"; p="${par#*:}"
    [ -x "node_modules/.bin/$b" ] \
      && grep -Eq '"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+' "node_modules/$p/package.json" 2>/dev/null \
      && continue
    faltas="$faltas $b"
  done
  if [ -n "$faltas" ]; then echo "PARCIAL$faltas"; else echo OK; fi
}

# Há `bun install` EM VOO nesta worktree? Pergunta à TABELA DE PROCESSOS, não a um
# arquivo de trava — a trava apodrece quando o install morre, e só veria os
# installs deste hook: processo `bun install|i|add` cuja cwd é ESTA worktree.
# Cobre o install de outra sessão (o do hook dela ou à mão) e o do founder no
# terminal. Ecoa o pid e sai 0 se há; sai 1 se não há; 2 se NÃO CONSEGUI CONFERIR.
# Limite: dois hooks no MESMO instante, antes de qualquer um ter o bun de pé, não
# se veem (janela de dezenas de ms entre a sonda e o exec).
install_em_voo() {
  local aqui pids rc linha pid="" respondeu=0
  aqui="$(pwd -P)"   # físico: é o caminho que o lsof devolve
  # Casa o PROCESSO do bun (`bun install`, `/caminho/bun i ...`) — não o texto de
  # um wrapper `zsh -c "... bun install"` nem `bun run` (medido no macOS). O
  # padrão identifica um COMANDO, e a tabela é da MÁQUINA: quem diz que é ESTA
  # worktree é a cwd (docs/historico/evidencia-positiva-shell.md §13).
  pids="$(pgrep -f '(^|/)bun (install|i|add)( |$)' 2>/dev/null)"; rc=$?
  case "$rc" in
    0) ;;
    1) return 1 ;;   # o pgrep respondeu: nenhum install na máquina
    *) return 2 ;;   # pgrep ausente ou quebrado
  esac
  # Lista vazia NUNCA chega ao lsof: `lsof -p ""` ignora o filtro e devolve a cwd
  # de TODOS os processos — inclusive os desta sessão, que moram nesta worktree
  # (medido): seria "em voo" sempre.
  [ -n "$pids" ] || return 2
  while IFS= read -r linha; do
    case "$linha" in
      p*) pid="${linha#p}" ;;
      n*) respondeu=1
          if [ "${linha#n}" = "$aqui" ]; then echo "$pid"; return 0; fi ;;
    esac
  done <<EOF
$(lsof -nP -a -p "$(printf '%s' "$pids" | tr '\n' ',')" -d cwd -Fpn 2>/dev/null)
EOF
  # lsof que não devolveu cwd nenhuma (ausente, quebrado, ou os pids sumiram no
  # meio) não prova "ninguém aqui": é falta de dado.
  [ "$respondeu" -eq 1 ] && return 1
  return 2
}

# Roda em BACKGROUND, com a saída no log: o bloco 1 só LÊ arquivos — a sonda de
# voo (pgrep+lsof: 25-470 ms medidos, mais sob swap) e o install nunca entram no
# timeout:10 do SessionStart. O log FECHA com uma marca ASCII de caixa fixa.
disparar_install() {
  local pid rc
  pid="$(install_em_voo)"; rc=$?
  case "$rc" in
    0) echo "VIGIA-EM-VOO: ja ha 'bun install' nesta worktree (pid $pid) -- NAO disparei outro. Espere esse pid sair; se as deps ainda faltarem, rode 'bun install'."
       return ;;
    1) ;;
    *) echo "VIGIA-NAO-CONFERI: nao consegui conferir se ha 'bun install' em voo nesta worktree (pgrep/lsof sem resposta) -- NAO disparei, para nao correr 2 installs na mesma arvore. Confira e rode 'bun install'."
       return ;;
  esac
  bun install; rc=$?
  echo "VIGIA-FIM: bun install saiu rc=$rc"
}

# Marcas do aviso em ASCII de caixa fixa (casáveis sem -i, em qualquer locale):
# AUSENTE / VAZIO / PARCIAL nomeiam o estado; VAZIO é o formato do incidente.
if [ -f package.json ]; then
  estado="$(estado_deps)"
  if [ "$estado" != OK ]; then
    case "$estado" in
      AUSENTE) desc="node_modules AUSENTE" ;;
      VAZIO)   desc="node_modules VAZIO (o diretorio existe sem NENHUM pacote -- o formato do incidente de 2026-09-25: a resolucao SOBE ao checkout principal e o teste pode ficar VERDE com as deps de OUTRA arvore)" ;;
      *)       desc="node_modules PARCIAL (sem resposta pelo caminho local:${estado#PARCIAL})" ;;
    esac
    log="${TMPDIR:-/tmp}/bun-install-wt-$$.log"
    if ! command -v bun >/dev/null 2>&1; then
      avisos="${avisos}${desc} -> bun FORA DO PATH deste hook: NAO disparei install. Rode 'bun install' antes de test/typecheck. "
    elif ! printf 'vigia-worktree: %s em %s -- conferindo install EM VOO antes de disparar\n' "$estado" "$(pwd -P)" 2>/dev/null >"$log"; then
      # "delegado" só com o log aberto: é ele que fecha com a marca do desfecho.
      avisos="${avisos}${desc} -> NAO ABRI O LOG em $log: NAO disparei install. Rode 'bun install' antes de test/typecheck. "
    else
      (disparar_install >>"$log" 2>&1 </dev/null &)
      avisos="${avisos}${desc} -> 'bun install' delegado ao background (log: $log), que NAO dispara se ja houver outro EM VOO nesta worktree; o log fecha com VIGIA-FIM, VIGIA-EM-VOO ou VIGIA-NAO-CONFERI. NAO rode outro 'bun install' em paralelo (dois na mesma arvore a deixam PARCIAL) e espere o log fechar antes de test/typecheck. Com a arvore parcial o falso vermelho tem DOIS sintomas: 'Cannot find module' (obvio) e erro de RUNTIME do React -- tipicamente 'Cannot read properties of null (reading ...)' de dentro de um componente, que parece bug do SEU codigo. Discriminador, DEPOIS do log fechar: 'bun install --frozen-lockfile' verde em segundos com o lockfile intacto = era a arvore. (CI real: gh pr checks). "
    fi
  fi
fi

# --- 2) swap (macOS: "total = 10240.00M  used = 9100.00M  ...") ---------------
swap_used_mb="$(sysctl -n vm.swapusage 2>/dev/null | sed -E 's/.*used = ([0-9]+)[.,].*/\1/')"
case "$swap_used_mb" in
  ''|*[!0-9]*) swap_used_mb=0 ;;
esac
if [ "$swap_used_mb" -gt 6144 ]; then
  avisos="${avisos}Swap em ${swap_used_mb}MB (M2 8GB sufocando) → sugira ao founder 'bun run wt:status' + fechar sessões ociosas / wt:clean / wt:reap. "
fi

# --- 3) sessões Claude vivas --------------------------------------------------
n_sessoes="$(pgrep -f 'claude.app/Contents/MacOS/claude' 2>/dev/null | wc -l | tr -d ' ')"
case "$n_sessoes" in
  ''|*[!0-9]*) n_sessoes=0 ;;
esac
if [ "$n_sessoes" -gt 6 ]; then
  avisos="${avisos}${n_sessoes} sessões Claude vivas → a alavanca real de RAM é FECHAR sessões (wt:status lista as ociosas). "
fi

# --- 4) semáforo `heavy` desatualizado ou ausente -----------------------------
# ~/.local/bin/heavy é CÓPIA de scripts/heavy.sh: mergear na main NÃO atualiza o
# semáforo em uso (#1459 ficou inerte). Só AVISA — não instala: o CI é ubuntu e
# nunca prova o heavy (test-heavy.sh é macOS-only), então auto-instalar propagaria
# para todas as sessões um script não validado, sem ninguém no circuito.
# A comparação NÃO é reimplementada aqui: quem define os estados é o
# heavy-install.sh --status, num lugar só (contrato de 4 estados no header dele).
# Script ausente (worktree antiga) → silêncio.
#
# Teto de 3s no --status: este é o PRIMEIRO subprocess BLOQUEANTE deste hook —
# os blocos 1)/2)/3) acima nunca bloqueiam (o bloco 1 só LÊ arquivos — a sonda
# de install em voo e o `bun install` vão juntos ao background;
# `sysctl`/`pgrep` sempre retornam na hora). Este
# bloqueia em I/O DE DISCO (git show), justo sob a pressão de swap que o bloco 2
# existe para reportar — isto NÃO é "o mesmo risco de sempre", é risco NOVO.
# Sem teto, um `git show` lento pode consumir o timeout:10 do SessionStart
# (settings.json) inteiro; como a saída só é emitida no fim do script, o hook
# inteiro morre e NENHUM aviso sai, nem os de 2)/3) já prontos antes deste bloco
# (medido: >12s nesse ramo, o que já estoura o timeout:10 sozinho).
#
# `timeout(1)` não é nativo do macOS (só via Homebrew, /opt/homebrew/bin) — e o
# PATH deste hook é HERDADO DO PROCESSO DO APP, não do perfil de shell: mesmo
# com o Homebrew instalado, `command -v timeout` pode não achar porque
# /opt/homebrew/bin nunca entrou no PATH deste processo. Fallback de caminho
# absoluto cobre esse caso comum; sem nenhum dos dois, roda sem teto (nunca
# pula nem quebra por causa disso).
TO=""
if command -v timeout >/dev/null 2>&1; then
  TO="timeout"
elif [ -x /opt/homebrew/bin/timeout ]; then
  TO="/opt/homebrew/bin/timeout"
fi

if [ -x scripts/heavy-install.sh ]; then
  # shellcheck disable=SC2086  # ${TO:+$TO 3} split de propósito: 0 ou 2 palavras
  st="$(${TO:+$TO 3} bash scripts/heavy-install.sh --status 2>&1)"
  rc=$?
  case "$rc" in
    0) : ;; # sincronizado OU em voo (--daqui proposital nesta worktree) — silêncio nos dois
    1)
      avisos="${avisos}${st:-heavy divergente ou ausente} → rode 'bun run heavy:install' (o heavy em uso é CÓPIA de scripts/heavy.sh; merge na main não atualiza o semáforo). Se outra worktree instalou com --daqui de propósito, ignore. "
      ;;
    *)
      # rc=3 (heavy-install.sh) OU rc=124 (o `timeout` matou por estourar os 3s)
      # OU qualquer outro código inesperado: NÃO é "divergente" — é falta de
      # dado. $st carrega o remédio real (ex.: "'git fetch origin' resolve"),
      # por isso 2>&1 acima em vez de descartar o stderr.
      avisos="${avisos}não consegui verificar o heavy (${st:-sem detalhe; pode ter sido o teto de 3s}) — isto é FALTA DE DADO, a comparação nem rodou; rode 'bash scripts/heavy-install.sh --status' manualmente pra ver a causa. "
      ;;
  esac
fi

# --- 5) processos ÓRFÃOS custosos ---------------------------------------------
# O ponto cego que custou 17 horas. Em 2026-08-23 esta máquina ficou com load
# 83,92 e 83MB livres por 16h55min por causa de 8 `zsh` ÓRFÃOS (PPID=1) em ~5,5
# dos 8 cores — restos de um `eval` de carga sintética cuja sessão Claude morreu
# sem matá-los. Os blocos 1-4 acima mediam node_modules, swap, SESSÕES e o heavy:
# tudo que o founder JÁ VÊ. Nenhum media ppid/pcpu. Descoberto por acidente.
#
# O critério (dois eixos) e o porquê de TIME sozinho ser o eixo errado vivem em
# scripts/orfaos-custosos.sh — num lugar só, como o bloco 4 faz com o
# heavy-install.sh --status. Reimplementar aqui é como os dois vigias divergem.
#
# Mesmo teto de 3s do bloco 4 e pelo mesmo motivo: este hook morre inteiro se
# estourar o timeout:10 do SessionStart, levando junto os avisos já prontos.
# Sonda ausente (worktree anterior a ela) → silêncio: é SENSOR, não script que
# apaga — degradar é o certo aqui.
if [ -f scripts/orfaos-custosos.sh ]; then
  # shellcheck disable=SC2086  # ${TO:+$TO 3} split de propósito: 0 ou 2 palavras
  orf="$(${TO:+$TO 3} bash scripts/orfaos-custosos.sh --resumo 2>/dev/null)"
  rc=$?
  if [ -n "$orf" ]; then
    # rc=3 já vem com o próprio SEM-MEDIDA no texto; rc=0 com texto é achado.
    avisos="${avisos}${orf} "
  elif [ "$rc" -ne 0 ]; then
    # Vazio COM rc≠0 é a varredura que nem rodou (teto de 3s, tipicamente).
    # Silenciar aqui seria ausência de dado virando "está limpo" — o mesmo erro
    # que deixou os 8 órfãos vivos por 17h.
    avisos="${avisos}Não consegui varrer processos órfãos (a sonda saiu ${rc}; provável teto de 3s) — isto é FALTA DE DADO, não 'está limpo': rode 'bash scripts/orfaos-custosos.sh'. "
  fi
fi

# --- 6) o claude-mem está GRAVANDO? --------------------------------------------
# O bloco 5 só vê o worker do claude-mem quando ele QUEIMA CPU. Em 2026-09-24 ele
# travou de novo, e a partir da 13.24.18 o plugin bloqueia 1 prompt e depois falha
# em SILÊNCIO; e em 2026-09-25 o banco mostrou a memória sem gravar observação desde
# 27/07 — 60 dias, com o worker "saudável" e o contador de falhas em 0. Os dois eixos
# (contador de falhas de hook e prompts gravados sem observação) e seus limiares
# vivem em scripts/claude-mem-saude.sh, num lugar só, como os blocos 4 e 5 — e a
# guarda do plugin DESLIGADO de propósito (enabledPlugins false: sai 0 e mudo).
#
# Teto de 2s, não 3: são três blocos com teto no mesmo timeout:10 do SessionStart
# (3+3+2 = 8s no pior caso). A sonda mede 0,06s no banco real (sqlite3 -readonly
# com .timeout 1000). Sonda que saiu ≠0 SEM texto é a medição que nem rodou → avisa
# FALTA DE DADO; a própria sonda já escreve "NAO MEDI" quando falta sqlite3/banco/
# contador. Script ausente (worktree anterior a ele) → silêncio, como no bloco 5.
if [ -f scripts/claude-mem-saude.sh ]; then
  # shellcheck disable=SC2086  # ${TO:+$TO 2} split de propósito: 0 ou 2 palavras
  mem="$(${TO:+$TO 2} bash scripts/claude-mem-saude.sh --resumo 2>/dev/null)"
  rc=$?
  if [ -n "$mem" ]; then
    avisos="${avisos}${mem} "
  elif [ "$rc" -ne 0 ]; then
    avisos="${avisos}Não consegui medir o claude-mem (a sonda saiu ${rc}; provável teto de 2s) — isto é FALTA DE DADO, não 'está gravando': rode 'bash scripts/claude-mem-saude.sh'. "
  fi
fi

# --- saída --------------------------------------------------------------------
if [ -n "$avisos" ] && command -v jq >/dev/null 2>&1; then
  jq -n --arg c "Vigia do worktree: $avisos" \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
else
  echo '{}'
fi

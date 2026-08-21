#!/usr/bin/env bash
# wt-medida.sh — sondas com TETO e degradação honesta, para os scripts wt-*.
#
# Existe por causa do #1838 (`wt:status` morria de SIGPIPE/`du` lento justo com a
# máquina cheia). A varredura dos irmãos achou a mesma classe no `wt:clean` e no
# `wt:prune` — com um agravante: esses dois APAGAM. Duas regras, medidas:
#
#   1. Medida que pode não terminar tem TETO e reporta COBERTURA. Worktree não
#      medida entra como "sem medida", NUNCA como 0 MB (money-path §2: ausente ≠
#      zero) e NUNCA como silêncio (§13: sensor que não mede não é sensor).
#      Sob `set -e`+`pipefail`, `sz="$(du -sm x | cut -f1)"` num contexto que não
#      é de teste MATA o script inteiro — o `${sz:-0}` da linha seguinte, que
#      declarava a intenção de degradar, nunca chega a rodar. Medido: EXIT=1 com
#      a varredura parando na 1ª worktree.
#
#   2. Sonda de SEGURANÇA que falta é FAIL-CLOSED aqui, não "sem medida". No
#      `wt:status` uma leitura ausente degrada a seção e a vida segue: ele só lê.
#      No `wt:clean`/`wt:prune` a mesma ausência vira REMOÇÃO INDEVIDA — medido:
#      com `lsof` devolvendo 127, a worktree de sessão VIVA passa de
#      "skip (sessão/processo ativo)" para "would … -250 MB", sem uma palavra
#      sobre a sonda ter faltado. Guard que emudece não protege nada.
#
# Uso: . "$(dirname "$0")/lib/wt-medida.sh"

# Teto por ITEM, em segundos. O `du` aqui é ORNAMENTAL (só informa quantos MB
# sairiam); a decisão de apagar não depende dele, então o teto é curto de
# propósito — é melhor dizer "sem medida" do que pendurar a varredura.
# Calibragem herdada do #1838 (M2 8GB em swap): um `du -sm` de node_modules
# custa 6-8s e NÃO barateia repetido (a pressão de memória despeja o cache do FS).
WT_CAP_ITEM="${WT_CAP_ITEM:-10}"

if [ -n "${WT_SEM_TIMEOUT:-}" ]; then
  WT_TIMEOUT_BIN=""
else
  WT_TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
fi

# du_mb <dir> [teto_s] — ecoa os MB e sai 0 se MEDIU.
# Não mediu ⇒ nada no stdout e o MOTIVO no exit code: 124 = teto estourado,
# 1 = o `du` falhou de verdade. Os dois são "não medido" (≠ zero), mas o relato
# muda — creditar o relógio como "erro do du" é a mesma desonestidade que estas
# funções existem para não cometer.
du_mb() {
  local alvo="$1" teto="${2:-$WT_CAP_ITEM}" saida rc tmp pid guard t0
  if [ -n "$WT_TIMEOUT_BIN" ]; then
    # A saída vai para ARQUIVO, não para `$(...)`. O `timeout` mata o `du`, mas
    # não o neto que ele tenha gerado — e um neto vivo segura o pipe da
    # substituição de comando, fazendo o teto valer nada na prática (medido: o
    # caso "du lento" custava quase o mesmo COM e SEM teto sob carga, o que
    # deixaria o teste flaky no CI). Com arquivo não há pipe a segurar.
    tmp="$(mktemp)"
    if "$WT_TIMEOUT_BIN" "$teto" du -sm "$alvo" >"$tmp" 2>/dev/null; then rc=0; else rc=$?; fi
    saida="$(cat "$tmp" 2>/dev/null)"
    rm -f "$tmp"
    [ "$rc" -eq 0 ] || return "$rc"
  else
    t0="$SECONDS"
    # Sem coreutils: cão-de-guarda em background. O `sleep` órfão que sobrar
    # morre sozinho — o que importa é o guard não matar ninguém depois que o
    # `du` terminou.
    tmp="$(mktemp)"
    du -sm "$alvo" >"$tmp" 2>/dev/null &
    pid=$!
    (
      sleep "$teto"
      kill -9 "$pid" 2>/dev/null
    ) >/dev/null 2>&1 &
    guard=$!
    if wait "$pid" 2>/dev/null; then saida="$(cat "$tmp")"; else saida=""; fi
    kill "$guard" 2>/dev/null || true
    rm -f "$tmp"
    if [ -z "$saida" ]; then
      [ "$((SECONDS - t0))" -lt "$teto" ] || return 124
      return 1
    fi
  fi
  saida="${saida%%$'\t'*}"
  case "$saida" in
    '' | *[!0-9]*) return 1 ;; # o `du` respondeu lixo → não medido, não zero
  esac
  printf '%s' "$saida"
}

# medida_humana <mb> <rc> — como a linha do relatório mostra o que não foi medido.
# NUNCA "0 MB": quem não foi medido aparece com o motivo, para o leitor não somar
# um zero fabricado ao total.
medida_humana() {
  local mb="$1" rc="$2"
  case "$rc" in
    0) printf -- '-%s MB' "$mb" ;;
    124) printf 'sem medida (teto de %ss)' "$WT_CAP_ITEM" ;;
    *) printf 'sem medida (erro do du)' ;;
  esac
}

# hash_arquivo <path> — ecoa um digest, ou sai 1 se NÃO HÁ sonda de hash.
# `md5 -q` é macOS; o CI é Ubuntu. Sem os três, sair 1 é o que permite ao
# chamador ser fail-closed em vez de comparar duas strings vazias e concluir
# "idêntico" — que foi o defeito medido no `wt:prune` (`.env` com segredo único
# passando como descartável).
hash_arquivo() {
  local p="$1" h=""
  if command -v md5 >/dev/null 2>&1; then
    h="$(md5 -q "$p" 2>/dev/null)"
  elif command -v md5sum >/dev/null 2>&1; then
    h="$(md5sum "$p" 2>/dev/null)"
    h="${h%% *}"
  elif command -v shasum >/dev/null 2>&1; then
    h="$(shasum "$p" 2>/dev/null)"
    h="${h%% *}"
  else
    return 1 # sem sonda nenhuma → o chamador tem de tratar como "não sei"
  fi
  [ -n "$h" ] || return 1
  printf '%s' "$h"
}

# sonda_lsof_ok — evidência POSITIVA de que o `lsof` responde: pergunta a ele o
# cwd do PRÓPRIO processo, que existe por construção. Resposta vazia = sonda
# inútil, e o chamador é fail-closed.
#
# Checar só `command -v lsof` NÃO basta e isso foi medido: um `lsof` presente
# porém quebrado (PATH capado, shim que sai !=0, permissão) esvazia o
# `active_file` exatamente como a ausência, e a worktree de sessão viva volta a
# ser candidata a remoção. Ausência de resposta não é "nenhum processo ativo" —
# é ausência de dado.
#
# O `awk NR<=1` no lugar de `head -1` é a regra 1 do #1838: leitor que fecha o
# pipe cedo vira SIGPIPE no produtor, e sob `set -e`+`pipefail` isso mata o
# script. O `awk` lê até o EOF.
sonda_lsof_ok() {
  command -v lsof >/dev/null 2>&1 || return 1
  local r
  r="$(lsof -nP -a -p "$$" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | awk 'NR<=1')"
  [ -n "$r" ]
}

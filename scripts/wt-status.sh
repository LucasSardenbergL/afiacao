#!/usr/bin/env bash
# wt-status.sh — raio-X rápido de RAM / disco / worktrees. Rode quando o Mac
# ficar lento pra ver o que está pesando e se vale um `bun run wt:clean`.
#
# Não muda nada — só lê e reporta.
#
# ⚠️ Este script é um SENSOR de saturação: ele é lido JUSTO quando a máquina
# está sufocando. Duas regras, medidas na marra em 2026-08-20 (M2 8GB em swap,
# 66 worktrees) e travadas por `scripts/test-wt-status.sh`:
#
#   1. Nenhum leitor que fecha o pipe cedo (`| head`) depois de um `sort`: o
#      sort só emite depois de ler TUDO, então ainda está escrevendo quando o
#      head sai ⇒ SIGPIPE(141), que o `pipefail` promove a status do pipeline e
#      o `set -e` transforma em morte do script. Use `awk 'NR<=N'`, que lê até
#      o EOF. (Limiar medido do buffer de pipe do macOS: 0/5 em 62 KB, 2/5 em
#      126 KB, 5/5 em 318 KB — por isso o bug só aparecia com a máquina cheia.)
#   2. Medida que pode não terminar tem TETO e reporta COBERTURA. Worktree não
#      medida entra como "sem medida", NUNCA como 0 MB e NUNCA como silêncio
#      (money-path §2 "ausente ≠ zero" e §13 "sensor que não mede quando
#      importa deixa de ser sensor").
set -euo pipefail

rp() { realpath "$1" 2>/dev/null || echo "$1"; }
human_gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1073741824 }'; }
curto() { printf '%s' "${1/#$HOME/~}"; }

# Teto TOTAL da varredura de node_modules, em segundos. Suba pra medir tudo
# numa máquina saturada: WT_STATUS_TETO_S=300 bun run wt:status
#
# Calibragem MEDIDA (2026-08-20, M2 8GB em swap): um `du -sm` de node_modules
# custa 6-8s e NÃO fica mais barato repetido (a pressão de memória despeja o
# cache do FS). 30 worktrees ⇒ ~3,5 min de varredura completa.
teto_s="${WT_STATUS_TETO_S:-60}"
# Teto por ITEM (≤ teto_s). Existe pra uma worktree patológica não comer o
# orçamento inteiro — e é o que faz "estourou o teto do item" e "acabou o
# orçamento" serem eventos DISTINTOS, cada um com seu motivo no relato.
cap_item="${WT_STATUS_CAP_ITEM:-20}"
if [ -n "${WT_STATUS_SEM_TIMEOUT:-}" ]; then
  TIMEOUT_BIN=""
else
  TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
fi

# Mede um diretório em MB com teto de tempo. Ecoa os MB e sai 0 se MEDIU.
# Não mediu ⇒ nada no stdout e o MOTIVO no exit code: 124 = teto estourado,
# 1 = o du falhou de verdade. Os dois são "não medido" (≠ zero), mas o relato
# ao founder muda — dizer "erro do du" quando foi o relógio é a mesma
# desonestidade que este script existe pra não cometer.
du_mb() {
  local alvo="$1" teto="$2" saida rc tmp pid guard t0
  if [ -n "$TIMEOUT_BIN" ]; then
    saida="$("$TIMEOUT_BIN" "$teto" du -sm "$alvo" 2>/dev/null)" && rc=0 || rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
  else
    t0="$SECONDS"
    # Sem coreutils: cão-de-guarda em background. O `sleep` órfão que sobrar
    # morre sozinho — o que importa é que o guard não chegue a matar ninguém
    # depois que o du terminou.
    tmp="$(mktemp)"
    du -sm "$alvo" > "$tmp" 2>/dev/null &
    pid=$!
    ( sleep "$teto"; kill -9 "$pid" 2>/dev/null ) > /dev/null 2>&1 &
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
  case "$saida" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' "$saida"
}

echo "═══ RAM (total 8 GB nesta máquina) ═══"
# `sysctl hw.memsize` e `vm_stat` são do macOS. Ausentes (ou falhando), o
# `pipefail` devolvia 127 e o `set -e` matava o script INTEIRO na primeira
# seção — a mesma classe de defeito que este arquivo existe pra não repetir:
# sonda que falta derruba o sensor todo. Agora a seção degrada e as outras
# seguem. Pego pelo CI Ubuntu do #1838, que é o 1º ambiente não-macOS a
# EXECUTAR este script.
ram_ok=1
mem_total="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
pgsize="$(vm_stat 2>/dev/null | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')" || ram_ok=0
pgsize="${pgsize:-16384}"
# "disponível" ≈ páginas livres + inativas (o macOS recicla as inativas)
avail_pages="$(vm_stat 2>/dev/null | awk '
  /Pages free/         { gsub(/[.]/,"",$3); f=$3 }
  /Pages inactive/     { gsub(/[.]/,"",$3); i=$3 }
  /File-backed pages/  { gsub(/[.]/,"",$3); fb=$3 }
  END { print f + i + fb }')" || ram_ok=0
case "$mem_total" in '' | *[!0-9]*) mem_total=0 ;; esac
case "$avail_pages" in '' | *[!0-9]*) ram_ok=0 ;; esac
if [ "$ram_ok" -eq 1 ] && [ "$mem_total" -gt 0 ]; then
  avail_bytes=$((avail_pages * pgsize))
  echo "  total:      $(human_gb "$mem_total") GB"
  echo "  disponível: $(human_gb "$avail_bytes") GB"
else
  echo "  ⚠️  sem medida: sysctl/vm_stat não responderam (raio-X de RAM é de macOS)."
  echo "      Não é 0 GB — é dado que falta."
fi
swap="$(sysctl -n vm.swapusage 2>/dev/null || true)"
[ -n "$swap" ] && echo "  swap:       $swap"
case "$swap" in
  *used\ =\ 0.00M*) : ;;
  *used*) echo "  ⚠️  swap em uso = RAM saturada. Feche apps/sessões ou rode wt:clean." ;;
esac

echo
# Órfãos custosos vêm LOGO DEPOIS da RAM, e antes de disco/worktrees, porque é a
# ordem em que a pergunta "por que o Mac está lento?" se responde: em 2026-08-23
# a resposta não estava em node_modules nem em sessões — eram 8 zsh órfãos em
# ~5,5 dos 8 cores havia 16h55min, e este relatório inteiro era cego a eles.
#
# `|| true` no ponto de CHAMADA: a sonda sai 3 quando não consegue varrer (e ela
# mesma imprime SEM-MEDIDA). Sob o `set -e` deste script, esse 3 mataria o
# wt-status inteiro — a sonda nova derrubando o sensor velho, que é o #1838 de
# novo. Sonda ausente (worktree antiga) declara a ausência em vez de silenciar.
sonda_orfaos="$(dirname "$0")/orfaos-custosos.sh"
if [ -f "$sonda_orfaos" ]; then
  bash "$sonda_orfaos" || true
else
  echo "═══ processos órfãos custosos (PPID=1 queimando CPU) ═══"
  echo "  SEM-MEDIDA: sonda ausente ($sonda_orfaos) — worktree anterior a ela?"
fi

echo
echo "═══ disco (/) ═══"
df -h / 2>/dev/null | awk 'NR==1 || NR==2 { printf "  %s\n", $0 }'

echo
echo "═══ node_modules por worktree ═══"
if ! wts="$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')"; then
  wts=""
  echo "  ⚠️  não consegui listar as worktrees (git falhou) — sem medida, não zero."
fi

# 1ª passada (barata): quem TEM node_modules. Saber o denominador antes de
# medir é o que permite dizer "medi X de Y" em vez de só somar o que deu.
candidatos=""
n_cand=0
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  nm="$(rp "$wt")/node_modules"
  if [ -e "$nm" ] && [ ! -L "$nm" ]; then
    candidatos="${candidatos}${wt}"$'\n'
    n_cand=$((n_cand + 1))
  fi
done <<EOF
$wts
EOF

# 2ª passada (cara): o du, com teto. GULOSO de propósito — cada du recebe todo
# o resto do orçamento (com um cap por item), em vez de uma fatia igual.
# Repartir igual foi tentado e MEDIDO: com 30 candidatos em 30s cada um ganhava
# 2s, e como um du custa 6-8s aqui, NENHUM terminava — "medidos: 0 de 30" em
# toda execução, que é o §13 do money-path na veia (sensor que degrada sempre
# não é sensor). Medir 8 de verdade e declarar os outros 22 vale mais do que
# não medir nada com uma repartição elegante.
inicio="$SECONDS"
total=0
medidos=0
linhas=""
sem_teto=0
sem_erro=0
nomes_sem=""
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  sobra=$((teto_s - (SECONDS - inicio)))
  if [ "$sobra" -le 0 ]; then
    sem_teto=$((sem_teto + 1))
    nomes_sem="${nomes_sem}$(curto "$wt")"$'\n'
    continue
  fi
  # cap por item: uma worktree patológica não leva o orçamento inteiro
  teto_item=$sobra
  if [ "$teto_item" -gt "$cap_item" ]; then teto_item="$cap_item"; fi
  sz="$(du_mb "$(rp "$wt")/node_modules" "$teto_item")" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    total=$((total + sz))
    medidos=$((medidos + 1))
    linhas="${linhas}$(printf '%8d MB  %s' "$sz" "$(curto "$wt")")"$'\n'
  else
    nomes_sem="${nomes_sem}$(curto "$wt")"$'\n'
    if [ "$rc" -eq 124 ]; then
      sem_teto=$((sem_teto + 1))
    else
      sem_erro=$((sem_erro + 1))
    fi
  fi
done <<EOF
$candidatos
EOF

if [ -n "$linhas" ]; then
  # `awk NR<=10` e não `| head -10`: o head fecharia o pipe do sort → SIGPIPE.
  printf '%s' "$linhas" | sort -rn | awk 'NR<=10 { print "  " $0 }'
  if [ "$medidos" -gt 10 ]; then
    echo "        … e mais $((medidos - 10)) worktree(s) medida(s)"
  fi
fi

sem_medida=$((sem_teto + sem_erro))
if [ "$medidos" -gt 0 ]; then
  piso=""
  if [ "$sem_medida" -gt 0 ]; then piso=" (piso — só o que foi medido)"; fi
  echo "  medidos: ${medidos} de ${n_cand} worktree(s) com node_modules — ~${total} MB${piso}"
else
  echo "  medidos: 0 de ${n_cand} worktree(s) com node_modules — nenhuma medida (ausente ≠ zero)"
fi

# Mediana DO QUE FOI MEDIDO — fato sobre a amostra, não estimativa do resto.
# Serve pra você mesmo fazer a conta das que faltaram, sem o script fabricar
# um total que não mediu (§2). Só sai com amostra ≥3, abaixo disso é ruído.
if [ "$medidos" -ge 3 ]; then
  mediana="$(printf '%s' "$linhas" | awk '{ print $1 }' | sort -n |
    awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : int((v[NR / 2] + v[NR / 2 + 1]) / 2) }')"
  echo "  mediana das medidas: ${mediana} MB por worktree"
fi

if [ "$sem_medida" -gt 0 ]; then
  motivo=""
  if [ "$sem_teto" -gt 0 ]; then motivo="${sem_teto} pelo teto de ${teto_s}s"; fi
  if [ "$sem_erro" -gt 0 ]; then
    if [ -n "$motivo" ]; then motivo="${motivo}, "; fi
    motivo="${motivo}${sem_erro} por erro do du"
  fi
  echo "  ⚠️  sem medida: ${sem_medida} — ${motivo}. Não é 0 MB: é dado que falta."
  printf '%s' "$nomes_sem" | awk 'NR<=5 { print "        " $0 }'
  if [ "$sem_medida" -gt 5 ]; then
    echo "        … e mais $((sem_medida - 5))"
  fi
  if [ "$sem_teto" -gt 0 ]; then
    echo "      Pra medir tudo: WT_STATUS_TETO_S=300 bun run wt:status"
  fi
fi

echo
echo "═══ sessões Claude vivas (cwd → worktree) ═══"
if ! sessions="$(lsof -nP -a -c claude -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u)"; then
  sessions=""
  echo "  ⚠️  o lsof falhou — não consegui consultar (≠ 'nenhuma sessão')."
elif [ -n "$sessions" ]; then
  while IFS= read -r s; do
    [ -n "$s" ] && echo "  $(curto "$s")"
  done <<EOF
$sessions
EOF
else
  echo "  (nenhuma)"
fi

echo
echo "═══ top consumidores de memória (RSS) ═══"
ps -axo rss,comm 2>/dev/null | sort -rn |
  awk 'NR<=10 { printf "  %6.0f MB  %s\n", $1 / 1024, $2 }'

echo
if [ "$total" -gt 2000 ]; then
  aprox="~"
  if [ "$sem_medida" -gt 0 ]; then aprox="≥"; fi
  echo "💡 ${aprox}${total} MB presos em node_modules de worktrees parados."
  echo "   Rode 'bun run wt:clean' (dry-run) pra ver quanto dá pra liberar agora."
fi

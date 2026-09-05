#!/usr/bin/env bash
# orfaos-custosos.sh — processos ÓRFÃOS (PPID=1) que estão QUEIMANDO CPU.
#
# Por que existe: em 2026-08-23 esta M2 8GB passou 16h55min com load 83,92 e
# 83MB livres por causa de 8 `zsh` órfãos consumindo ~5,5 dos 8 cores — restos
# de um `eval` de carga sintética cuja sessão Claude morreu sem matá-los. Os
# vigias da casa (`.claude/hooks/vigia-worktree.sh`, `scripts/wt-status.sh`)
# contavam SESSÕES e worktrees — o que o founder já vê na tela — e eram cegos a
# ppid/pcpu. Levou 17 horas pra alguém notar, e só por acidente.
#
# Só LÊ e reporta. NUNCA mata ninguém: quem decide matar processo é o founder.
#
# ── O critério são DOIS eixos, ambos obrigatórios ────────────────────────────
# Medido nesta máquina em 2026-08-23 (335 processos com PPID=1 — órfão sozinho
# não é anomalia, é rotina):
#
#   TIME acumulado sozinho é o EIXO ERRADO (mesma classe do
#   docs/historico/roteirizador-corte-cidades.md — "o teto é o EIXO, não o
#   tamanho"). O worker do plugin claude-mem é PPID=1, tem 9:32 de CPU e mora em
#   /Users/... : passaria por "TIME>5min fora de /System//usr/*//Applications/"
#   e viraria falso positivo. `/bin/zsh -c source .../shell-snapshots/...` com
#   PPID=1 também é rotina (0,6%, 14s).
#
#   Então exige-se pcpu ≥ teto (queima AGORA — no macOS o %CPU do ps é média
#   decaída de ~1min) E cputime ≥ teto (queima SUSTENTADA, não spike). Medido:
#   maior órfão não-sistema = 3,5%; os 8 zsh do incidente = ~68% cada. Uma ordem
#   de grandeza de folga.
#
#   Precisão > recall de propósito: sensor que grita a cada boot o founder
#   aprende a ignorar, e aí deixa de existir — que é como se perdem 17h de novo.
#
#   `/usr/local/bin/warsaw/core` (módulo de segurança bancária, órfão legítimo)
#   NÃO está na lista de prefixos: ele cai pelo eixo pcpu (0,0%). Allowlist por
#   nome de processo é dívida de manutenção; o eixo certo já o exclui.
#
# ── Limitação conhecida: o pcpu OSCILA ───────────────────────────────────────
# Medido em 2026-08-23: o mesmo pid 1541 leu 1,1% e, segundos depois, 2,9% — o
# %CPU do ps é média decaída, não instantâneo. Um processo que orbite o teto
# pode escapar de UMA execução. Isso é aceito de propósito: (a) a folga real é
# de uma ordem de grandeza (órfãos legítimos 0-4% · o incidente ~68%), e (b) o
# hook roda a cada SessionStart, com dezenas de sessões por dia — 17 horas de
# queima dão dezenas de chances. Baixar o teto pra fechar essa fresta traria de
# volta o claude-mem como falso positivo, que é o que mata o sensor.
#
# Por isso o controle positivo se faz sobre um SNAPSHOT CONGELADO, nunca contra
# o `ps` ao vivo (que muda entre as duas leituras e fabrica um "não achou"):
#   ps -axo pid=,ppid=,time=,pcpu=,command= > /tmp/ps.txt
#   d=$(mktemp -d); printf '#!/bin/sh\ncat /tmp/ps.txt\n' > "$d/ps"; chmod +x "$d/ps"
#   PATH="$d:$PATH" ORFAOS_PCPU_MIN=1 ORFAOS_CPUTIME_MIN_S=60 bash scripts/orfaos-custosos.sh
#
# Uso:
#   bash scripts/orfaos-custosos.sh            # relatório (wt-status)
#   bash scripts/orfaos-custosos.sh --resumo   # 1 linha p/ hook, ou NADA
#
# Env: ORFAOS_PCPU_MIN (50) · ORFAOS_CPUTIME_MIN_S (300)
#      CLAUDE_MEM_DATA_DIR (~/.claude-mem — o MESMO nome que o plugin honra)
#
# ── Discriminador do claude-mem: VIVO ≠ SÃO ──────────────────────────────────
# Em 2026-09-05 o daemon do plugin (`worker-service.cjs --daemon`, PPID=1) foi
# acusado CORRETAMENTE pelos dois eixos — 95% de CPU por 2h — e a linha dizia só
# "pid X queimando CPU". Faltava o discriminador: o worker estava VIVO-MAS-SURDO
# (porta em LISTEN, `/api/health` sem resposta) e o hook do plugin bloqueava TODO
# prompt de TODA sessão com exit 2 após 3 falhas consecutivas (contador global em
# ~/.claude-mem/state/hook-failures.json); o plugin NÃO se recupera sozinho. A
# receita verificada vive em docs/historico/claude-mem-worker-vivo-mas-surdo.md.
#
# O critério dos dois eixos NÃO muda e NÃO há allowlist por nome (allowlist é
# dívida; o eixo certo já exclui o worker SÃO, que fica em 0-4%). O discriminador
# só ANOTA o órfão já acusado: (a) o contador — arquivo AUSENTE é "sem contador",
# nunca 0 (ausente ≠ zero, docs/agent/money-path.md); (b) o `/api/health` na porta
# lida de `worker.pid`, com `curl -m 2`, que só roda quando HÁ órfão do claude-mem
# e UMA vez só (a porta é uma) — o vigia impõe teto de 3s ao script inteiro;
# (c) surdo E contador ≥ 3 → aponta a receita. Sonda ausente ou quebrada (curl,
# arquivo, porta) degrada para "nao sondei" — nunca para "health ok", e nunca
# para SURDO, que também é afirmação (docs/historico/sonda-ausente-em-script-
# que-apaga.md). O casamento com `worker-service.cjs` é feito no awk ANTES do
# corte de 110 chars: a linha real tem 146 e o nome do script fica depois do corte.
#
# Exit: 0 = varreu (achando ou não) · 3 = NÃO consegui varrer (ausente ≠ zero)
set -u

pcpu_min="${ORFAOS_PCPU_MIN:-50}"
cputime_min="${ORFAOS_CPUTIME_MIN_S:-300}"
resumo=0
[ "${1:-}" = "--resumo" ] && resumo=1

# LC_ALL=C na chamada do ps: medido nesta máquina, sob pt_BR.UTF-8 o ps emite
# "68,4" (vírgula decimal) e sob C "68.4". Sem fixar, o mesmo processo geraria
# relatos diferentes pro founder e pro CI, e a asserção que casa o número
# falsificaria por acidente de ambiente (#1483).
if ! bruto="$(LC_ALL=C ps -axo pid=,ppid=,time=,pcpu=,command= 2>/dev/null)"; then
  bruto=""
  if [ "$resumo" -eq 1 ]; then
    echo "SEM-MEDIDA: nao consegui varrer processos orfaos (o ps falhou) — isto e FALTA DE DADO, nao 'esta tudo limpo'; rode 'ps -axo pid,ppid,time,pcpu,command' na mao."
  else
    echo "  SEM-MEDIDA: o ps falhou — nao consegui varrer. Nao e 'esta limpo': e dado que falta."
  fi
  exit 3
fi

# Uma linha por culpado: "<pid>\t<pcpu>\t<segundos>\t<etiqueta>\t<comando truncado>"
# etiqueta: "claude-mem" (worker-service.cjs no comando COMPLETO) ou "-".
achados="$(printf '%s\n' "$bruto" | awk \
  -v pcpu_min="$pcpu_min" -v t_min="$cputime_min" '
  # [DD-]HH:MM:SS[.ff] e MM:SS[.ff] — o macOS usa MM:SS (e passa de 59: "1015:22"),
  # o Linux/CI usa HH:MM:SS e DD-HH:MM:SS. Os dois rodam este script.
  function segs(t,   d, i, n, a, s) {
    d = 0
    if (t ~ /-/) { i = index(t, "-"); d = substr(t, 1, i - 1) + 0; t = substr(t, i + 1) }
    n = split(t, a, ":")
    s = 0
    for (i = 1; i <= n; i++) s = s * 60 + (a[i] + 0)
    return d * 86400 + s
  }
  $2 == 1 {
    cmd = $0
    sub(/^[ \t]*[^ \t]+[ \t]+[^ \t]+[ \t]+[^ \t]+[ \t]+[^ \t]+[ \t]+/, "", cmd)
    # Prefixos do SO/apps: o founder já vê apps na tela, e daemon do sistema com
    # pico de CPU não é dele pra matar. Sem isso o WindowServer (medido: 90%
    # durante compilação) viraria alarme a cada boot.
    if (cmd ~ /^\/(System|usr\/libexec|usr\/sbin|usr\/bin|sbin|Library\/Apple|Applications)\//) next
    if (($4 + 0) < (pcpu_min + 0)) next
    s = segs($3)
    if (s < (t_min + 0)) next
    tag = (cmd ~ /worker-service\.cjs/) ? "claude-mem" : "-"
    if (length(cmd) > 110) cmd = substr(cmd, 1, 107) "..."
    printf "%s\t%s\t%d\t%s\t%s\n", $1, $4, s, tag, cmd
  }')"

humano() {  # segundos → "16h55m" / "7m03s"
  awk -v s="$1" 'BEGIN {
    h = int(s / 3600); m = int((s % 3600) / 60)
    if (h > 0) printf "%dh%02dm", h, m; else printf "%dm%02ds", m, int(s % 60)
  }'
}

n="$(printf '%s' "$achados" | grep -c . || true)"

# ── discriminador do claude-mem (ver cabeçalho) ──────────────────────────────
mem_dir="${CLAUDE_MEM_DATA_DIR:-${HOME:-}/.claude-mem}"

json_num() {  # json_num <arquivo> <chave> → o inteiro da chave, ou VAZIO (ausente / não-inteiro)
  # sed, não jq/python3: o PATH do hook é herdado do app (vigia-worktree.sh explica)
  # e /opt/homebrew/bin pode não estar nele — jq viraria "nao li" justo no
  # SessionStart. Os dois arquivos são JSON raso escrito pelo plugin. Valor entre
  # aspas ou chave ausente NÃO casa → vazio, e vazio é FALTA DE DADO, não 0.
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | awk 'NR == 1'
}

mem_disc=""
if printf '%s\n' "$achados" | grep -q $'\tclaude-mem\t'; then
  # (a) contador de falhas consecutivas de hook — AUSENTE ≠ 0
  contador=""
  f="$mem_dir/state/hook-failures.json"
  if [ ! -f "$f" ]; then
    contador_txt="sem contador (hook-failures.json ausente em $mem_dir/state)"
  else
    contador="$(json_num "$f" consecutiveFailures)"
    if [ -n "$contador" ]; then contador_txt="contador=$contador falha(s) consecutiva(s) de hook"
    else contador_txt="contador ilegivel (hook-failures.json sem consecutiveFailures inteiro)"; fi
  fi

  # (b) /api/health na porta do worker.pid — resposta POSITIVA é HTTP 200
  health=""
  pidf="$mem_dir/worker.pid"
  porta=""
  [ ! -f "$pidf" ] || porta="$(json_num "$pidf" port)"
  if [ ! -f "$pidf" ]; then
    health_txt="nao sondei health (worker.pid ausente em $mem_dir)"
  elif [ -z "$porta" ]; then
    health_txt="nao sondei health (worker.pid sem porta inteira)"
  elif ! command -v curl >/dev/null 2>&1; then
    health_txt="nao sondei health (curl ausente no PATH)"
  else
    # -m 2 = teto TOTAL (conexão inclusa): é o que mantém o script sob os 3s do
    # vigia com um worker surdo. --noproxy: sonda local nunca passa por proxy.
    code="$(curl -s -m 2 --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:${porta}/api/health" 2>/dev/null)"
    rc=$?
    if [ "$rc" -eq 0 ] && [ "$code" = "200" ]; then
      health="ok"; health_txt="health ok (porta $porta respondeu 200)"
    elif [ "$rc" -eq 0 ]; then
      health_txt="health respondeu HTTP ${code:-?} na porta $porta (nao e 200)"
    else
      case "$rc" in
        # 7 recusada · 28 timeout dos 2s · 52 resposta vazia · 55/56 send/recv
        # falhou (ECONNRESET — o que o incidente de 05/09 deu): o curl FUNCIONOU
        # e o worker NÃO respondeu. Qualquer outro código é o curl que não sondou.
        7|28|52|55|56) health="SURDO"; health_txt="health SURDO (porta $porta sem resposta em 2s, curl $rc)" ;;
        *) health_txt="nao sondei health (curl saiu $rc)" ;;
      esac
    fi
  fi

  mem_disc="claude-mem: ${health_txt}; ${contador_txt}"
  # (c) a receita só quando as DUAS condições dela valem — surdo E contador >= 3
  if [ "$health" = "SURDO" ] && [ -n "$contador" ] && [ "$contador" -ge 3 ]; then
    mem_disc="${mem_disc} -> VIVO-MAS-SURDO: o plugin NAO se recupera sozinho e bloqueia todo prompt de toda sessao; receita em docs/historico/claude-mem-worker-vivo-mas-surdo.md"
  fi
fi

if [ "$resumo" -eq 1 ]; then
  [ "$n" -gt 0 ] || exit 0   # silêncio: hook que fala à toa vira ruído e some
  linha="${n} processo(s) ORFAO(s) (PPID=1, nenhuma sessao e dona) queimando CPU:"
  i=0
  while IFS=$'\t' read -r pid pcpu segs tag cmd; do
    [ -n "${pid:-}" ] || continue
    i=$((i + 1))
    [ "$i" -le 3 ] || continue
    entrada="pid ${pid} (${pcpu}%, $(humano "$segs") de CPU) ${cmd:0:60}"
    [ "$tag" != "claude-mem" ] || entrada="${entrada} [${mem_disc}]"
    linha="${linha} ${entrada};"
  done <<EOF
$achados
EOF
  [ "$n" -le 3 ] && linha="${linha%;}" || linha="${linha} e mais $((n - 3))."
  echo "$linha Confirme com 'ps -p <pid> -o ppid,time,pcpu,command' ANTES de 'kill <pid>' — e nunca mate sem olhar."
  exit 0
fi

echo "═══ processos órfãos custosos (PPID=1 queimando CPU) ═══"
if [ "$n" -eq 0 ]; then
  varridos="$(printf '%s\n' "$bruto" | awk '$2 == 1' | grep -c . || true)"
  echo "  (nenhum orfao caro entre ${varridos} orfao(s) varrido(s) — teto: ${pcpu_min}% de CPU E ${cputime_min}s acumulados)"
else
  while IFS=$'\t' read -r pid pcpu segs tag cmd; do
    [ -n "${pid:-}" ] || continue
    printf '  ⚠️  pid %-7s %5s%%  %-8s de CPU  %s\n' "$pid" "$pcpu" "$(humano "$segs")" "$cmd"
    [ "$tag" != "claude-mem" ] || printf '      ↳ %s\n' "$mem_disc"
  done <<EOF
$achados
EOF
  echo "      Órfão = a sessão que o criou morreu sem matá-lo; ninguém mais vai."
  echo "      Confirme com 'ps -p <pid> -o ppid,time,pcpu,command' e então 'kill <pid>'."
fi
exit 0

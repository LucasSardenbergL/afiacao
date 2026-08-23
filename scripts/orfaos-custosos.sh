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

# Uma linha por culpado: "<pid>\t<pcpu>\t<segundos>\t<comando truncado>"
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
    if (length(cmd) > 110) cmd = substr(cmd, 1, 107) "..."
    printf "%s\t%s\t%d\t%s\n", $1, $4, s, cmd
  }')"

humano() {  # segundos → "16h55m" / "7m03s"
  awk -v s="$1" 'BEGIN {
    h = int(s / 3600); m = int((s % 3600) / 60)
    if (h > 0) printf "%dh%02dm", h, m; else printf "%dm%02ds", m, int(s % 60)
  }'
}

n="$(printf '%s' "$achados" | grep -c . || true)"

if [ "$resumo" -eq 1 ]; then
  [ "$n" -gt 0 ] || exit 0   # silêncio: hook que fala à toa vira ruído e some
  linha="${n} processo(s) ORFAO(s) (PPID=1, nenhuma sessao e dona) queimando CPU:"
  i=0
  while IFS=$'\t' read -r pid pcpu segs cmd; do
    [ -n "${pid:-}" ] || continue
    i=$((i + 1))
    [ "$i" -le 3 ] || continue
    linha="${linha} pid ${pid} (${pcpu}%, $(humano "$segs") de CPU) ${cmd:0:60};"
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
  while IFS=$'\t' read -r pid pcpu segs cmd; do
    [ -n "${pid:-}" ] || continue
    printf '  ⚠️  pid %-7s %5s%%  %-8s de CPU  %s\n' "$pid" "$pcpu" "$(humano "$segs")" "$cmd"
  done <<EOF
$achados
EOF
  echo "      Órfão = a sessão que o criou morreu sem matá-lo; ninguém mais vai."
  echo "      Confirme com 'ps -p <pid> -o ppid,time,pcpu,command' e então 'kill <pid>'."
fi
exit 0

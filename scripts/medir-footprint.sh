#!/usr/bin/env bash
# medir-footprint.sh — mede o PICO de memória física da ÁRVORE de um comando, em macOS.
#
# Uso:  bash scripts/medir-footprint.sh <comando...>
#       bun run medir:footprint -- <comando...>
#
# Saída em stdout — EXATAMENTE estas 7 linhas, nesta ordem (contrato lido pelas
# tarefas 7-11 do plano `2026-09-07-vitest-workers-e-ambiente`):
#
#   pico_mb=<inteiro>          MiB, arredondado
#   amostras=<inteiro>         quantas amostras entraram no pico
#   intervalo_ms=<inteiro>     intervalo REAL entre amostras (ver §Intervalo)
#   duracao_s=<decimal 1 casa> parede, do lançamento ao fim do comando
#   swapouts_delta=<inteiro>   vm_stat Swapouts fim menos início; -1 = NÃO MEDIDO
#   erros_leitura=<inteiro>    processos da árvore que não deram para ler
#   exit_comando=<inteiro>     exit code DO COMANDO MEDIDO, não deste script
#
# `exit_comando` existe para quem chama distinguir "o comando falhou" de "a
# medição falhou". O EXIT DESTE SCRIPT fala só da medição: 0 = medi; 2 = via não
# observável (sem python3, amostrador não subiu, comando ausente). O comando
# medido tem seu stdout e stderr REDIRECIONADOS PARA O STDERR daqui, para que o
# stdout carregue só o contrato acima.
#
# ── §Métrica: por que phys_footprint e não RSS ────────────────────────────────
# Medido nesta máquina em 2026-09-07: 16 sessões de um agente somavam 1.713 MB de
# RSS e 4.662 MB de `phys_footprint` — o compressor de memória do macOS segurava
# 3.303 MB que o RSS não conta. RSS SUBESTIMA em ~2,7x aqui. `phys_footprint` já
# contabiliza a memória comprimida: não se soma o compressor de novo, e NUNCA se
# multiplica RSS por um fator para "corrigir". Ver a §Instrumento de
# docs/historico/vitest-1-arquivo-7-forks.md.
#
# `P_pico` é o MÁXIMO AO LONGO DO TEMPO DA SOMA dos processos vivos da árvore —
# não a soma dos máximos individuais de cada processo (essa soma seria um pico
# que nunca existiu simultaneamente). A diferença NÃO é acadêmica: numa suíte com
# forks escalonados — o caso típico das Tasks 7-11 — os picos individuais caem em
# instantes diferentes e a fórmula errada INFLA o número em quase 2x. É a PROVA 4
# de scripts/test-medir-footprint.sh, e ela precisa de fixture própria: com UM só
# processo alocador as duas fórmulas dão o mesmo número.
#
# ── §Mecanismo (escolhido POR MEDIÇÃO em 2026-09-07, custo de UMA amostra) ─────
#   footprint(1) -p <pid> ...... 28 ms POR PID (×N da árvore); `footprint -a`
#                                (todos de uma vez) exige root: "Must run as root".
#   top -l 1 -stats pid,mem .... 594 ms — 6x acima do intervalo alvo.
#   ps -Ao pid,rss ............. 24 ms — piso de custo; NÃO é fonte de footprint.
#   libproc via python3 (spawn)  53 ms — dominado pela subida do interpretador.
#   libproc num amostrador VIVO   2,0 ms  ← escolhido
# `proc_pid_rusage()` devolve `ri_phys_footprint` (o mesmo número do Activity
# Monitor) e não pede sudo para processos do próprio usuário. Um único python3
# amostrador percorre a árvore com `proc_listchildpids()`, então as chamadas
# ficam dentro de um processo só: 2 ms por amostra, sem fork por amostra.
#
# ── §Intervalo ────────────────────────────────────────────────────────────────
# Padrão 100 ms. `intervalo_ms` na saída é o intervalo REAL — quem lê um
# `pico_mb` não pode supor a que taxa ele foi amostrado: intervalo maior
# SUBESTIMA o pico, e subestimar o pico enviesa a favor de aprovar. Override por
# `MEDIR_INTERVALO_MS`.
#
# ── §Ausente != zero ──────────────────────────────────────────────────────────
# Processo da árvore que não dá para ler (morto, zumbi, sem permissão) entra em
# `erros_leitura` e é EXCLUÍDO da amostra — nunca vira 0 MB. Isso não é teórico:
# um ZUMBI (morto e não reapeado) continua na lista de filhos e o
# `proc_pid_rusage` dele responde SUCESSO com footprint 0. Quem confiasse só no
# código de retorno registraria "0 MB" para um processo que não pôde ser lido.
# O amostrador exige um sinal POSITIVO de vida (PROC_PIDTBSDINFO legível e
# status != SZOMB) antes de acreditar no número.
set -u

if [ "$#" -eq 0 ]; then
  printf 'uso: bash scripts/medir-footprint.sh <comando...>\n' >&2
  exit 2
fi

INTERVALO_MS="${MEDIR_INTERVALO_MS:-100}"
case "$INTERVALO_MS" in
  ''|*[!0-9]*) printf 'medir-footprint: MEDIR_INTERVALO_MS invalido: %s\n' "$INTERVALO_MS" >&2; exit 2 ;;
esac
[ "$INTERVALO_MS" -ge 1 ] || { printf 'medir-footprint: MEDIR_INTERVALO_MS < 1\n' >&2; exit 2; }

command -v python3 >/dev/null 2>&1 || {
  printf 'medir-footprint: VIA_NAO_OBSERVAVEL — python3 ausente; sem amostrador nao ha medicao.\n' >&2
  exit 2
}

TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMP"' EXIT
ARQ_PID="$TMP/pid"; ARQ_PARAR="$TMP/parar"; ARQ_RES="$TMP/res"; AMOSTRADOR="$TMP/amostrador.py"

# `date +%s%N` funciona no macOS 26+, mas o BSD date antigo devolve o literal N.
# Ausência de nanossegundos degrada para segundos — nunca para lixo aritmético.
agora_ns() {
  local t
  t="$(date +%s%N 2>/dev/null)"
  case "$t" in
    ''|*[!0-9]*) printf '%s000000000\n' "$(date +%s)" ;;
    *) printf '%s\n' "$t" ;;
  esac
}

# Contador MONOTÔNICO de páginas paginadas para o swap desde o boot. Se o vm_stat
# não responder um número, o delta é -1 (NÃO MEDIDO) — nunca 0, que se leria como
# "não houve swap".
ler_swapouts() {
  local linha n
  linha="$(vm_stat 2>/dev/null | grep -i '^Swapouts:')" || { printf '\n'; return 0; }
  n="$(printf '%s' "$linha" | tr -cd '0-9')"
  case "$n" in
    ''|*[!0-9]*) printf '\n' ;;
    *) printf '%s\n' "$n" ;;
  esac
}

cat > "$AMOSTRADOR" <<'PY'
"""Amostrador: soma o phys_footprint da árvore viva do PID raiz, a cada intervalo.

Argumentos: <arq_pid> <arq_parar> <intervalo_ms> <arq_resultado>
Escreve em <arq_resultado>: pico_bytes=, amostras=, erros=
"""
import ctypes
import os
import struct
import sys
import time

# ── as quatro chaves do instrumento; cada uma é alvo de uma sabotagem do
#    scripts/test-medir-footprint.sh. NÃO renomeie sem ajustar aquele teste.
CAMPO_LIDO = "phys_footprint"   # RSS subestima ~2,7x nesta máquina (§Métrica)
ANDAR_ARVORE = True             # False = só a raiz; perderia todo fork do vitest
GATE_VIVO = True                # False = acredita no rusage de um zumbi (0 MB)
PICO_DA_SOMA = True             # False = soma dos maximos por pid; infla ~2x (§Métrica)

# rusage_info_v0: uuid[16] + 10 uint64. resident_size é o 7º, phys_footprint o 8º.
_DESLOC = {"resident_size": 16 + 6 * 8, "phys_footprint": 16 + 7 * 8}
_PROC_PIDTBSDINFO = 3
_SZOMB = 5

libc = ctypes.CDLL(None, use_errno=True)
_buf_rusage = ctypes.create_string_buffer(512)
_buf_bsd = ctypes.create_string_buffer(1024)
_off = _DESLOC[CAMPO_LIDO]


def _responde_vivo(pid):
    """Sinal POSITIVO de vida: PROC_PIDTBSDINFO legível e status != SZOMB."""
    r = libc.proc_pidinfo(ctypes.c_int(pid), ctypes.c_int(_PROC_PIDTBSDINFO),
                          ctypes.c_ulonglong(0), ctypes.byref(_buf_bsd),
                          ctypes.c_int(ctypes.sizeof(_buf_bsd)))
    if r <= 0:
        return False
    return struct.unpack_from('<I', _buf_bsd.raw, 4)[0] != _SZOMB


def esta_vivo(pid):
    """Posso ACREDITAR no número deste processo?

    O rusage de um zumbi devolve SUCESSO com footprint 0 — sem este gate, um
    processo ilegível viraria "0 MB" em silêncio (ausente != zero).
    """
    if not GATE_VIVO:
        return True
    return _responde_vivo(pid)


def raiz_sumiu(pid):
    """O comando acabou? Pergunta SEPARADA da de cima, de propósito: a condição
    de parada do laço não pode depender do gate que a sabotagem da PROVA 3
    desliga, senão a sabotagem mexeria em duas coisas e o vermelho ficaria
    ambíguo."""
    return not _responde_vivo(pid)


def bytes_de(pid):
    """Bytes do campo lido, ou None se o kernel não respondeu."""
    if libc.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(0),
                            ctypes.byref(_buf_rusage)) != 0:
        return None
    return struct.unpack_from('<Q', _buf_rusage.raw, _off)[0]


def filhos(pid):
    n = libc.proc_listchildpids(ctypes.c_int(pid), None, ctypes.c_int(0))
    if n <= 0:
        return []
    arr = (ctypes.c_int * (n + 64))()
    r = libc.proc_listchildpids(ctypes.c_int(pid), arr, ctypes.sizeof(arr))
    if r <= 0:
        return []
    return [p for p in arr[:r] if p > 0]


def amostra(raiz, maximos):
    """(soma_bytes, erros) da árvore num instante. Nascidos depois entram na próxima."""
    soma = 0
    erros = 0
    vistos = set()
    pilha = [raiz]
    while pilha:
        pid = pilha.pop()
        if pid in vistos:
            continue
        vistos.add(pid)
        if ANDAR_ARVORE:
            # filhos ANTES do gate de vida: um nó morto não pode esconder a subárvore viva
            for c in filhos(pid):
                if c not in vistos:
                    pilha.append(c)
        if not esta_vivo(pid):
            erros += 1
            continue
        v = bytes_de(pid)
        if v is None:
            erros += 1
            continue
        soma += v
        # `maximos` só é alimentado quando a chave da fórmula está desligada — na
        # medição de verdade este dicionário fica vazio e não custa nada.
        if not PICO_DA_SOMA and v > maximos.get(pid, 0):
            maximos[pid] = v
    return soma, erros


def acumula_pico(pico, soma, maximos):
    """A FÓRMULA do pico: máximo ao longo do tempo da SOMA da árvore viva.

    A alternativa — somar o máximo individual de cada pid — devolve um pico que
    nunca existiu simultaneamente, e infla quase 2x quando os processos picam em
    instantes diferentes (forks escalonados de uma suíte). A PROVA 4 do
    scripts/test-medir-footprint.sh desliga a chave acima e exige vermelho.
    """
    if PICO_DA_SOMA:
        return soma if soma > pico else pico
    return sum(maximos.values())


def espera_raiz(arq_pid):
    limite = time.monotonic() + 10.0
    while time.monotonic() < limite:
        try:
            with open(arq_pid) as fh:
                txt = fh.read().strip()
        except IOError:
            txt = ''
        if txt:
            return int(txt)
        time.sleep(0.002)
    return None


def main():
    arq_pid, arq_parar, intervalo_ms, arq_res = sys.argv[1:5]
    intervalo = int(intervalo_ms) / 1000.0
    raiz = espera_raiz(arq_pid)
    if raiz is None:
        sys.stderr.write('medir-footprint: o pid do comando nunca apareceu\n')
        return 2

    pico = 0
    n = 0
    erros = 0
    maximos = {}
    while True:
        t0 = time.monotonic()
        if raiz_sumiu(raiz):
            break            # comando acabou: para de amostrar e reporta o que tem
        soma, e = amostra(raiz, maximos)
        pico = acumula_pico(pico, soma, maximos)
        n += 1
        erros += e
        if os.path.exists(arq_parar):
            break
        # Dorme o resto do intervalo EM FATIAS: um `sleep(intervalo)` inteiro só notaria o fim do
        # comando ao acordar, e o coletor ficaria de pé até 1 intervalo depois dele. Isso não é
        # custo de amostragem — é latência de desligamento, e ela contaminava a `duracao_s`
        # (medida com MEDIR_INTERVALO_MS=1000: +506 ms de puro pós-morte).
        while True:
            resto = intervalo - (time.monotonic() - t0)
            if resto <= 0 or os.path.exists(arq_parar):
                break
            time.sleep(resto if resto < 0.02 else 0.02)

    with open(arq_res, 'w') as fh:
        fh.write('pico_bytes=%d\namostras=%d\nerros=%d\n' % (pico, n, erros))
    return 0


sys.exit(main())
PY

SWAP_INI="$(ler_swapouts)"
INI_NS="$(agora_ns)"

python3 "$AMOSTRADOR" "$ARQ_PID" "$ARQ_PARAR" "$INTERVALO_MS" "$ARQ_RES" &
PID_AMOSTRADOR=$!

# O comando medido fala pelo STDERR daqui: o stdout carrega só o contrato.
"$@" >&2 &
PID_CMD=$!

# escrita atômica: o amostrador nunca lê um pid pela metade
printf '%s\n' "$PID_CMD" > "$ARQ_PID.parcial" && mv "$ARQ_PID.parcial" "$ARQ_PID"

wait "$PID_CMD"; EXIT_COMANDO=$?
# `duracao_s` é do COMANDO: o relógio para aqui, antes de esperar o amostrador. Contar o
# desligamento do instrumento como duração do comando seria o instrumento medindo a si mesmo.
FIM_NS="$(agora_ns)"
: > "$ARQ_PARAR"
wait "$PID_AMOSTRADOR" || true

SWAP_FIM="$(ler_swapouts)"

if [ ! -s "$ARQ_RES" ]; then
  printf 'medir-footprint: VIA_NAO_OBSERVAVEL — o amostrador nao produziu resultado.\n' >&2
  exit 2
fi
# Vazio ANTES do source: se o arquivo vier truncado, o campo faltante fica vazio e
# a validação abaixo derruba a medição — em vez de o `set -u` estourar ou, pior,
# um default 0 virar veredito.
pico_bytes=''; amostras=''; erros=''
# shellcheck disable=SC1090  # arquivo gerado por nós logo acima, 3 atribuições de inteiro
. "$ARQ_RES"
for campo in "$pico_bytes" "$amostras" "$erros"; do
  case "$campo" in
    ''|*[!0-9]*)
      printf 'medir-footprint: VIA_NAO_OBSERVAVEL — resultado do amostrador incompleto.\n' >&2
      exit 2 ;;
  esac
done

DUR_MS=$(( (FIM_NS - INI_NS) / 1000000 ))
[ "$DUR_MS" -ge 0 ] || DUR_MS=0

if [ -n "$SWAP_INI" ] && [ -n "$SWAP_FIM" ]; then
  SWAPOUTS_DELTA=$(( SWAP_FIM - SWAP_INI ))
else
  SWAPOUTS_DELTA=-1   # NÃO MEDIDO — ausência de dado, não "não houve swap"
fi

if [ "$amostras" -eq 0 ]; then
  printf 'medir-footprint: 0 amostras — o comando terminou antes da 1a leitura; pico_mb=0 e AUSENCIA DE DADO.\n' >&2
fi

printf 'pico_mb=%d\n'         "$(( (pico_bytes + 524288) / 1048576 ))"
printf 'amostras=%d\n'        "$amostras"
printf 'intervalo_ms=%d\n'    "$INTERVALO_MS"
printf 'duracao_s=%d.%d\n'    "$(( DUR_MS / 1000 ))" "$(( (DUR_MS % 1000) / 100 ))"
printf 'swapouts_delta=%d\n'  "$SWAPOUTS_DELTA"
printf 'erros_leitura=%d\n'   "$erros"
printf 'exit_comando=%d\n'    "$EXIT_COMANDO"

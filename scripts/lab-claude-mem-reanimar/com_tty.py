"""com_tty.py — roda um comando dentro de um TTY de verdade e devolve o exit dele.

O claude-mem-reanimar.sh pede confirmacao lendo /dev/tty (de proposito: nunca decide matar
lendo stdin de pipe). O laboratorio responde por ele dando ao script um TTY: o stdin daqui vai
para o TTY, a saida do TTY vem para o stdout daqui.

Por que nao `script(1)`: o do util-linux (`script -qec`) nao existe no macOS, e o do macOS manda o
EOF da entrada ANTES da resposta (medido: o `read` do script lia vazio). Por que nao
`pty.spawn`: o python3 do macOS e o 3.9 da Command Line Tools, cujo `pty.spawn` fica preso num
`select` vazio quando o filho sai depois do EOF da entrada (medido: travou ate ser morto a mao).

Teto: um cenario que pendura nao pode pendurar a suite (espera sem teto e fail-OPEN). Estourou ->
mata o grupo do filho, diz isso e sai 124.

Uso: python3 com_tty.py <teto_s> <comando> [args...]
"""
import os
import pty
import select
import signal
import sys
import time


def main():
    teto = float(sys.argv[1])
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[2], sys.argv[2:])
    fim = time.monotonic() + teto
    entrada = sys.stdin.fileno()
    ler_entrada = True
    while True:
        resta = fim - time.monotonic()
        if resta <= 0:
            os.killpg(pid, signal.SIGKILL)  # o filho do pty.fork lidera sessao e grupo
            os.waitpid(pid, 0)
            os.write(1, f"\nCOM_TTY: TETO de {teto:g}s estourado — o comando NAO terminou; matei o grupo {pid}\n".encode())
            sys.exit(124)
        fds = [fd] + ([entrada] if ler_entrada else [])
        prontos, _, _ = select.select(fds, [], [], resta)
        if fd in prontos:
            try:
                dados = os.read(fd, 65536)
            except OSError:  # Linux: EIO quando o ultimo fd do lado escravo fecha
                dados = b""
            if not dados:
                break
            os.write(1, dados)
        if ler_entrada and entrada in prontos:
            dados = os.read(entrada, 65536)
            if dados:
                os.write(fd, dados)
            else:
                ler_entrada = False  # EOF da entrada: para de ler, SEM mandar ^D ao TTY
    _, st = os.waitpid(pid, 0)
    rc = os.waitstatus_to_exitcode(st)
    sys.exit(rc if rc >= 0 else 128 - rc)  # morto por sinal N -> 128+N, como o shell


main()

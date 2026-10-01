"""entrada_tardia.py — roda o com_tty.py com o escalonamento de uma maquina sufocada, sem sorte.

O flake de 2026-09-26 (M2 em swap, carga 51 em 8 nucleos): o caso REANIMAR_TESTE_SONDA_S=0 do
c_tempo_invalido disse o PAREI certo e voltou rc=1 em vez de 2. O 1 era do com_tty.py, nao do
script: sob carga, o helper so repassou a resposta ao TTY depois que o comando ja tinha saido, e o
macOS devolve EIO a essa escrita. Medido no macOS: o filho (lider de sessao) so termina de sair
quando o pai DRENA a saida dele; o read do pai o libera, e o write logo depois perde a corrida em
26 de 30 vezes (30 de 30 com 0,3 s de folga). Solto, o pipeline do lab nao reproduziu em 450.

Aqui a ordem vira regra:
  1. o 1o select do com_tty.py so roda depois que o comando escreveu tudo (o marcador que ELE cria)
     — o pai sem CPU durante a vida inteira do filho;
  2. a escrita da resposta no TTY so roda depois que o filho terminou de SAIR (estado Z no ps).
A escrita e a de VERDADE: quem decide e o kernel, e eu DIGO o que ele fez. Onde o kernel ACEITA a
escrita tardia (o Linux, pela leitura do pty.c — a 1a rodada no CI mede), o EIO do macOS e EMULADO,
e isso sai escrito — para a guarda do helper ter dente tambem no CI.

Uso: python3 entrada_tardia.py <com_tty.py> <marcador> <teto_s> <comando> [args...]
     (stdin = a resposta, como no roda() do lab.sh; o comando tem de criar <marcador> ao terminar
      de escrever, e nao pode ler o TTY)
"""
import errno
import os
import pty
import runpy
import select
import subprocess
import sys
import time

ALVO, MARCADOR = sys.argv[1], sys.argv[2]
_fork, _select, _write = pty.fork, select.select, os.write
filho = {}


def diz(msg):
    _write(2, f"ENTRADA-TARDIA: {msg}\n".encode())


def espera(oque, pronto, teto=20.0):  # polling com teto que DIZ — nunca segue como se tivesse dado
    fim = time.monotonic() + teto
    while not pronto():
        if time.monotonic() > fim:
            diz(f"{oque} nao aconteceu em {teto:g}s — o cenario NAO rodou")
            os._exit(3)
        time.sleep(0.02)


def saiu(pid):  # Z = terminou de sair (e o TTY dele fechou); ainda nao recolhido: o helper recolhe
    r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return r.stdout.strip()[:1] == "Z"


def fork():
    pid, fd = _fork()
    if pid:
        filho.update(pid=pid, fd=fd)
    return pid, fd


def select_(*args):
    if not filho.get("escreveu"):
        espera("o comando escrever tudo (marcador)", lambda: os.path.exists(MARCADOR))
        filho["escreveu"] = True
    return _select(*args)


def write(fd, dados):
    if fd != filho.get("fd"):
        return _write(fd, dados)
    espera("o comando terminar de sair (estado Z)", lambda: saiu(filho["pid"]))
    try:
        _write(fd, dados)
    except OSError as e:
        diz(f"o kernel RECUSOU a entrada tardia (errno {e.errno}) — EIO real")
        raise
    diz("o kernel ACEITOU a entrada tardia — EIO EMULADO (o do macOS)")
    raise OSError(errno.EIO, os.strerror(errno.EIO))


pty.fork, select.select, os.write = fork, select_, write
sys.argv = [ALVO] + sys.argv[3:]
runpy.run_path(ALVO, run_name="__main__")

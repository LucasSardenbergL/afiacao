"""desanexa.py — setsid(1) portatil: roda o comando numa SESSAO nova (grupo proprio, sem TTY).

O laboratorio sobe o worker falso como o plugin sobe o real: desanexado de quem o criou. E isso
que da ao worker um grupo proprio, e o `arvore()` do claude-mem-reanimar.sh casa os filhos pelo
pgid. O `setsid` do util-linux nao existe no macOS.

Uso: python3 desanexa.py <comando> [args...]
"""
import os
import sys

if os.getpgrp() == os.getpid():  # ja lidera um grupo: setsid() daria EPERM — forka antes, como o setsid(1)
    if os.fork() > 0:
        os._exit(0)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])

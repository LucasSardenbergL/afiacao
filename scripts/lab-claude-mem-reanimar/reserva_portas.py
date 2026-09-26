"""reserva_portas.py — reserva um BLOCO de portas para UMA execucao do lab, e o segura ate morrer.

Por que existe (#2564): as portas eram fixas (37780+k; a falsificacao, 38000+100*job+k). Duas
coisas as tomavam:
  - outro lab ao mesmo tempo (test:hooks de duas worktrees, a falsificacao rodada a mao) — mesma
    base, mesma porta;
  - o connect() de QUALQUER cliente no Linux: a faixa efemera la e 32768-60999, e a 37780-39918
    esta dentro dela. No CI (run 36206481333) a falsificacao rodou SOZINHA e a porta 39118, que so
    uma sabotagem usava, estava tomada — so pode ter sido uma porta efemera de cliente.
Por isso a faixa fica ABAIXO da efemera (confere a do sistema e recusa se colidir) e a posse do
bloco e do KERNEL: um sentinela ESCUTA na porta 0 do bloco (nenhum cenario a usa); o bind de
quem vier depois falha e ele tenta o proximo bloco. Sem arquivo de trava — nada fica velho: o
processo morreu, o bloco esta livre. O bloco so e aceito se as portas dos cenarios (1..BLOCO-1)
estao livres AGORA; ocupada por outro programa = pula o bloco (e diz quantos pulou).

Uso: python3 reserva_portas.py <arquivo-de-resposta> <inicio> <fim> <tamanho-do-bloco> <semente> [marca]
  Escreve no arquivo UMA linha e fica vivo segurando o bloco (quem mata e o limpa() do lab):
    BASE <porta> PULADOS <n>        reservou
    EFEMERA <ini> <fim>             a faixa efemera do sistema cobre a do lab (sai 3)
    NENHUM <n>                      todos os blocos ocupados (sai 1)
  A marca so existe para o pkill do lab achar este processo.
"""
import os
import signal
import socket
import subprocess
import sys

resp, ini, fim, bloco, semente = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])


def responde(linha):
    tmp = resp + ".tmp"
    with open(tmp, "w") as f:
        f.write(linha + "\n")
    os.rename(tmp, resp)  # atomico: o lab nunca le a linha pela metade


def faixa_efemera():
    try:
        with open("/proc/sys/net/ipv4/ip_local_port_range") as f:
            a, b = f.read().split()
            return int(a), int(b)
    except (OSError, ValueError):
        pass
    try:
        out = subprocess.run(["sysctl", "-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[0]), int(out[1])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


ef = faixa_efemera()
if ef is not None and ef[0] <= fim and ini <= ef[1]:
    responde("EFEMERA %d %d" % ef)
    sys.exit(3)


def livre(porta):  # o mesmo teste do porta_livre() do lab
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", porta))
        return True
    except OSError:
        return False
    finally:
        s.close()


n = (fim - ini + 1) // bloco
pulados = 0
for k in range(n):
    base = ini + ((semente + k) % n) * bloco
    sentinela = socket.socket()  # SEM SO_REUSEADDR: dois sentinelas nunca dividem a porta
    try:
        sentinela.bind(("127.0.0.1", base))
        sentinela.listen(1)
    except OSError:
        sentinela.close()
        continue  # outro lab ja e dono deste bloco: nao conta como "pulado por ocupacao"
    if all(livre(base + d) for d in range(1, bloco)):
        responde("BASE %d PULADOS %d" % (base, pulados))
        while True:  # segura o sentinela ate o limpa() do lab matar este processo
            signal.pause()
    sentinela.close()
    pulados += 1
responde("NENHUM %d" % n)
sys.exit(1)

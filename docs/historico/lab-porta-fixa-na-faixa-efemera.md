# A porta fixa que morava na faixa efêmera (2026-09-25, #2564)

O CI da main reprovou com a sabotagem `tempo-invalido-vira-fail-open` vermelha pelo MOTIVO
ERRADO: `porta 39118 OCUPADA por outro processo — cenario NAO rodou (outro lab ao mesmo tempo?)`
([run 36206481333](https://github.com/LucasSardenbergL/afiacao/actions/runs/36206481333), 1ª
tentativa). O laboratório do `claude-mem-reanimar.sh` (#2548) usava portas fixas: `37780+k` no
lab, `38000+100·job+k` na falsificação.

## O diagnóstico da issue estava errado — e o conserto sugerido pioraria

A issue supôs que "dois cenários disputaram a mesma porta". O log diz que não: o step de
falsificação roda **sozinho** (steps do job são sequenciais), no runner só existe o locale C, e
`39118 = 38000 + 11·100 + 18` é a porta do job 11 no deslocamento 18 — **nenhum outro cenário
daquela execução a usa**. O controle usa 37781–37798, e as outras sabotagens usam outras centenas.

Quem tomou a porta foi um **`connect()` qualquer**: no Linux a faixa efêmera é **32768–60999**, e
37780–39918 está inteira dentro dela. Cada curl de sonda, cada hook falso, qualquer cliente do
runner recebe uma porta local sorteada nessa faixa — um dia caiu na 39118. No macOS a faixa
efêmera começa em 49152, e é por isso que **nunca reproduziu local**. Há um segundo motivo: o BSD deixa
um `bind` com `SO_REUSEADDR` passar por cima de socket cliente conectado. O Linux não deixa.

O conserto sugerido — "bind em `:0` e ler a porta atribuída" — sorteia **da mesma faixa
efêmera**: trocaria uma colisão rara por uma janela de corrida em TODO cenário, entre soltar a
porta sondada e o worker falso subir nela.

## O conserto

`reserva_portas.py`: cada execução do lab reserva um **bloco de 20 portas em 20000–32759**, abaixo
da faixa efêmera do Linux e do macOS. O helper lê a faixa do sistema
(`/proc/sys/net/ipv4/ip_local_port_range` / `sysctl net.inet.ip.portrange.*`) e o lab **reprova**
se ela cobrir a dele. A posse é do **kernel**: um sentinela escuta na porta 0 do bloco (nenhum
cenário a usa), e o `bind` de outra execução falha e passa para o próximo bloco. Não há arquivo
de trava, então nada fica velho, e o bloco só é aceito com as 19 portas dos cenários livres.

Isso também fecha o eixo que a issue imaginou e que é real no dia a dia: dois `test:hooks` de
worktrees diferentes, ou a falsificação rodada à mão, usavam a MESMA base e se atropelavam.

## A prova

Script no scratchpad da sessão (`PROVA-VERDE`, exit 0): controle e sabotagem na **mesma invocação**. O controle (HEAD)
roda primeiro e aborta se vier vermelho. A sabotagem são o `lab.sh` e o `falsifica.sh` da
`origin/main`, ou seja, o conserto revertido.

| Eixo | Sabotado (porta fixa) | Controle (bloco reservado) |
| --- | --- | --- |
| 4 labs simultâneos (mesma semente) | 1 "porta OCUPADA", 0/4 verdes | 0 OCUPADA, 4/4 verdes, 4 blocos distintos — ×3 rodadas |
| serviço alheio escutando na porta do cenário | OCUPADA, vermelho | pulou o bloco ("pulei 1"), verde — ×3 |
| 2 falsificações inteiras em paralelo | **9** OCUPADA, 0/2 verdes | 0 OCUPADA, 2/2 `FALSIFICACAO-VERDE` |
| `test-claude-mem-reanimar.sh` (concorrência) | rc=1 (1/2 verde, sem linha `portas:`) | rc=0, `CONCORRENCIA-VERDE` |

O próprio controle pegou um erro da prova antes de qualquer sabotagem: a 1ª versão copiava o lab
sem o `claude-mem-reanimar.sh` (rc 127), e o controle saiu vermelho com `ocupada=0`. Ele abortou,
e com isso não saiu um "vermelho por colisão" que seria mentira.

O eixo efêmero do Linux não roda no mac. A garantia dele é estrutural (a faixa do lab fica
fora da efêmera, conferido em tempo de execução), e a evidência do defeito é o log do CI acima.

## Lição

**Porta fixa em teste precisa ficar FORA da faixa efêmera do SO mais restritivo** (Linux:
32768+). Qualquer número "alto e redondo" entre 32768 e 60999 é roleta no CI. E antes de aceitar o
diagnóstico de uma issue de flake, refaça a conta da porta **com o log**: "outro lab ao mesmo
tempo" era a mensagem do guard, não a causa.

# Prova do Radar: soltar a transação ao OBSERVAR o bloqueio, em vez de segurar 2 s (2026-11-06, plano v7 — E17)

**Substrato:** `db/test-radar-cadastro-conflitos.sh` (núcleo, `falsificar=15`) · **Sem banco de prod, sem Publish.**
Experimento rodado **depois** do E14 medido ([ci-e14-escopo-main-docs.md](ci-e14-escopo-main-docs.md)), para não
misturar os ganhos.

## Problema

As 7 provas concorrentes (B9a–B9f e B10c) abriam a sessão A numa transação e a seguravam com `pg_sleep(2)` fixo,
enquanto o controle em bash procurava a sessão B em espera de `Lock`. Os 2 s eram pagos inteiros mesmo com o
bloqueio já visto em milissegundos, e por passagem da suíte: no `--falsificar` são 16 passagens (controle + 15
sabotagens). Pior: numa sabotagem em que B **não** bloqueia, o `espera_estado` do controle ainda esperava os 10 s
do seu laço antes de dizer `nao`. A tabela do LPT tinha 360 s para esta prova (`db/nucleo-ci-custo.txt`).

## O desenho

**Não** só encurtar o sleep, que trocaria o custo por flakiness. A própria sessão A solta quando vê:

- **`segura_ate_ver_bloqueio`**: no lugar do `pg_sleep(2)`, A roda um laço PL/pgSQL de 10 ms sobre
  `pg_stat_activity` e sai com `sim` ao ver `conf_<B>` com `wait_event_type = 'Lock'`. Sai com `nao` se B sumir
  depois de vista (terminou sem esperar) e com `timeout` aos 10 s, que é a falha. `pg_stat_clear_snapshot()` a
  cada volta: sem ele, `pg_stat_activity` devolve a mesma foto a transação inteira.
- **Quem afirma "B esperou" é A**, que viu B parada atrás dela, com o mesmo predicado de antes
  (`wait_event_type = 'Lock'`). O veredito sai na 2ª linha da saída de A e entra no `eq` como antes. O controle em
  bash só confere que A chegou ao laço (`EM_SLEEP`, inalterado).
- **Janela de 50 ms de B antes da chamada** (`SELECT 1 FROM pg_sleep(0.05) WHERE random() < 0`, zero linhas): uma B
  que não bloqueia (sabotagem) pode nascer e morrer entre duas voltas de A. Sem a janela, A só sairia no timeout.
  **Tropeço da entrega:** a 1ª versão usava `WHERE false`, que o planner dobra, e o `pg_sleep` nem executava. O
  `trava_sem_lock` ficou vermelho do mesmo jeito, mas por `timeout` e não por `nao`. Foi o veredito do mutante
  que acusou o defeito; com o filtro volátil ele sai `nao`.

## Medição local (M2, `heavy`, sem fila; 3 rodadas alternadas antes/depois)

| | antes (`pg_sleep(2)`) | depois (observar o bloqueio) |
|---|---|---|
| prova normal | 17,28 · 16,85 · 16,89 s | **4,20 · 4,26 · 4,29 s** (−75%) |
| `--falsificar` (controle + 15) | 391,6 s | **79,0 s** (−80%) |
| asserts | 56/56 | 56/56 |
| sabotagens vermelhas | 15/15 | 15/15 (`trava_sem_lock` → B10c `nao`) |

O ganho do `--falsificar` (−313 s) passa dos 16 × ~16 s de retenção porque as sabotagens em que B não bloqueia
deixaram de pagar os 10 s do `espera_estado` (agora A vê B sumir e sai `nao`). A 1ª medição do "antes" deu 33 s
na normal, com cache frio; a série alternada é a que vale.

## No runner do CI

RUNNER

## Veredito

VEREDITO

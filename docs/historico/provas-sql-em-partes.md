# O `provas-sql` em partes paralelas (2026-10-01)

> Regra viva em `docs/agent/database.md` §2b (bullet do gate). Código: `db/roda-nucleo-ci.sh` (bloco
> "1b. A PARTE"), matriz do job `provas-sql` em `.github/workflows/ci.yml`. Dente: `db/falsifica-nucleo-ci.sh`
> (seção "AS PARTES"; piso de 45 casos, `HARNESS_OK_MINIMO`).

## O incidente

O núcleo de provas SQL rodava **serial**, num job com teto de 20 min.

- Em 2026-10-01 o #2685 pôs no núcleo `db/test-hoje-sp-views-defaults.sh`. O `--falsificar` dela, com 33 sabotagens, custava 301 s no runner.
- Dali em diante as runs da `main` foram **CANCELADAS no teto** (36799444473: 20m16s; 36802018807: 20m10s). Como o `validate` só fica verde com o `provas-sql` verde, **nenhum PR mergeava**.
- A última run verde antes disso levou 14m46s no job (818 s somando as provas). Uma sessão anotou mediana de 17,9 min em 8 runs, com 3 PRs entre 19,6 e 19,9 min.
- Para caber, **três falsificações saíram do CI** como exceção `fora-do-ci`:
  - `db/test-hoje-sp-views-defaults.sh`, em `b3268a80b`;
  - `db/test-hoje-sp-data-ciclo.sh`;
  - `db/test-pre-anti-deriva-concorrencia.sh`, do #2702.

O próprio `ci.yml` já tinha decidido o que fazer quando isso acontecesse (2026-09-29): "a mediana medida é o sinal de quando a próxima prova pedir **paralelizar o runner em vez de subir o teto de novo**".

Em paralelo, o #2712 (decisão do founder, com todo PR bloqueado) subiu o teto para **30 min** como *stopgap declarado*: o comentário dele no `ci.yml` aponta a paralelização como o próximo passo, e este PR é esse passo. No merge, o teto de 30 e o comentário do #2712 ficaram como estavam, e a matriz entrou depois deles.

## O desenho

- **Matriz no job:** `strategy.matrix.parte: [1, 2, 3]`, com `fail-fast: false`, para que uma parte vermelha não esconda as outras. Cada parte roda num runner próprio, então as portas TCP dos clusters não colidem.
- **Partição round-robin** sobre a ordem do manifesto: a prova de posição k vai para a parte k mod N. Ela não precisa de tabela de durações (que apodreceria) e é determinística para cada versão do manifesto.
  - Simulação com as durações medidas: 327 / 309 / 364 s, contra 1.000 s em série.
  - O balanceamento guloso daria 334 / 333 / 333 s; não compensa manter dados de duração por 30 s.
- **Quem diz `i` e `N` é o GitHub:** `NUCLEO_PARTE: ${{ strategy.job-index }}/${{ strategy.job-total }}`. Com um número escrito à mão, acrescentar uma parte à lista e esquecer o total deixaria provas fora de todas as partes, com tudo verde. Contando pela matriz real, não há buraco possível.
- **Toda parte valida o manifesto INTEIRO** antes de cortar a sua fatia: linha podre reprova as N partes.
- **Recusas fail-closed:**
  - `NUCLEO_PARTE` malformada ou fora da faixa aborta. Rodar tudo estouraria o teto em silêncio; rodar nada seria o verde vazio.
  - Parte sem nenhuma prova, quando N é maior que o manifesto, também aborta.
- **O `validate` não mudou:** ele lê `needs.provas-sql.result`, que a matriz agrega (success só se TODAS as partes passarem). A proteção da `main` exige só o check `validate`, então os nomes novos `provas-sql (1)`, `(2)` e `(3)` não travam nada.
- **A autofalsificação do runner roda só na 1ª parte** (`if: strategy.job-index == 0`). Ela exercita o RUNNER, que é o mesmo nas N partes.

## Complemento — o recibo de cada parte e a UNIÃO a cada run (01/10)

A partição estava provada no harness, mas a EXECUÇÃO de cada run não estava: a matriz agrega `success` também quando o step do núcleo de uma parte é PULADO (um `if:` novo, uma condição que muda de tipo) — a parte some e as outras saem verdes.

- **Recibo:** com `NUCLEO_RECIBO`, cada parte grava — só depois do próprio conjunto conferido — o sha256 do manifesto, `parte i/N` e cada unidade (arquivo, modo) concluída. Sobe como artefato (`upload-artifact@v7`, `if-no-files-found: error`).
- **União:** o job `provas-sql-uniao` (no `needs` do `validate`, que passou a esperar 6 jobs e guarda o nome dele como já guardava o `provas-sql`) não sobe banco: baixa os recibos e roda `db/roda-nucleo-ci.sh --uniao`, que refaz a partição k mod N sobre o manifesto INTEIRO e exige N recibos, as partes 0..N-1 uma vez cada, o mesmo manifesto, cada unidade uma vez e na sua parte; nada fora do formato é ignorado. Exige também o recibo do harness da 1ª parte. Roda com `!cancelled()`, para dizer QUAL parte falhou em vez de virar um `skipped` mudo.
- **Argumentos estritos:** o runner só lia o 1º argumento e ignorava os outros; com o `--uniao` no mundo, erro de digitação rodaria o núcleo inteiro no job sem banco.
- **Harness:** +20 casos (piso 45 → 65) — controle positivo (2 partes e a união verdes), um vermelho por regra da união, os argumentos, e a ponta a ponta: a seleção sabotada PERDE uma prova, as duas partes saem verdes e só a união pega.
- **As 2 falsificações voltam:** `hoje-sp-views-defaults` (`falsificar=33`) e `hoje-sp-data-ciclo` (`falsificar=17`; local: `SABOTAGENS: 17 vermelhas / 0 falhas`, exit 0) — 50 sabotagens de volta ao caminho obrigatório. Simulado com os tempos da run verde `36815770229`, a parte mais pesada vai a ~636 s com N=3: as duas são vizinhas no manifesto e caem sempre em partes diferentes, mas o rodízio por prova não equilibra por duração. Fica abaixo do teto do job e fora do caminho crítico (o `gates-e-falsificacao`); se encostar no teto, vale a regra de "O que fica para depois": mais uma parte.

## O dente

`db/falsifica-nucleo-ci.sh` ganhou 6 casos (piso 39 → 45). Rodada local: `FALSIFICACAO: OK=45 XX=0`, em 49 s.

- **3 recusas, cada uma pela marca certa:** parte malformada, parte fora da faixa e parte vazia.
- **Cobertura:** a UNIÃO das 3 listas é o manifesto, sem repetição. O risco novo é de partição, e o juiz da cobertura tem a própria falsificação: um runner sabotado que entrega sempre a fatia 0 é PEGO como `REPETE`/`BURACO`.
- **Controle positivo:** a parte 1 de 3 EXECUTA só as 2 provas dela e fecha o recibo da parte (`SQL_PROOF_OK provas=2/2 … parte=0/3`). Sem esse controle, um runner que recusasse toda `NUCLEO_PARTE` passaria nas recusas.

No manifesto da `main` de 2026-10-01 (57 provas, já com o #2712), as 3 partes ficaram com 19, 19 e 19 provas; a união é o manifesto inteiro, sem repetição.

## O que fica para depois

- **As três falsificações `fora-do-ci` podem voltar ao CI:** a simulação dá ~6 min por parte, contra o teto de 30. Fica para PRs próprios, um por dono, para cada volta ser medida.
- **O teto de 30 do stopgap pode voltar a 20** quando a duração das partes for MEDIDA em runs reais. A decisão é do founder.
- **Folga acabando de novo:** acrescente uma parte à matriz. Não suba o teto e não tire falsificação do CI.
- **Custo:** mais minutos de runner (setup do PGDG e sonda ×3, ~1 min cada) em troca de wall-clock. O caminho crítico do `validate` volta a ser o `gates-e-falsificacao` (~21–22 min), não o `provas-sql`.

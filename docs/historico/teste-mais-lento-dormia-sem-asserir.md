# O arquivo de teste mais lento da suíte dormia 11s que nenhum cenário asseria

**Data:** 2026-09-26 · **PRs:** #2546, #2550 · **Alvo:** `scripts/exclusividade-medir.test.ts` · **Substrato:** job `testes` do CI

## Como o alvo foi achado — no log do CI, não na máquina local

O vitest imprime no log do job `testes` uma linha por arquivo com a duração da fase de testes
(` ✓ |node| <arquivo> (N tests) Xms`) e uma linha própria para cada teste acima de 300ms. Parseadas em
três execuções, elas apontaram o mesmo alvo:

| | main `1460ea5` | PR #2543 | PR #2544 |
|---|---|---|---|
| `scripts/exclusividade-medir.test.ts` | 27.354ms (28 testes) | 36.103ms (32) | 37.002ms (32) |
| 2º arquivo (`erro-colapsado-em-vazio-gate.test.ts`) | 8.595ms | 9.485ms | 8.513ms |

No #2544 o alvo era 4,3× o segundo arquivo e ~20% da fase de testes dos 843 arquivos somados. O #2543
(o bloco da guarda 12) o levou de 28 para 32 testes, e de 27,4s para 36,1s — em máquinas diferentes, então
a diferença é indicativa, não medida. O `it` isolado mais lento é outro — o da
auto-ocultação no `erro-colapsado-em-vazio-gate.test.ts`, 4,6–5,6s —, e tem conserto próprio (fim do doc).

## Por que era lento

O arquivo testa o motor do `exclusividade:medir` montando repositórios-fixture e rodando o motor de
verdade. Por rodada do arquivo: 29 execuções do motor, 27 do gate real, 385 processos `bun` e 1.466 `git`
(contados por um shim que registra cada spawn). Quase tudo isso é inerente — o write-guard fotografa a
árvore com 3 `git` antes e depois de cada gate.

O que NÃO era inerente: o gate de fixture `g:lento` é um `Atomics.wait` de **900ms**. Ele existe por um
motivo só: ser o suspeito CARO que a ordem por custo põe atrás dos gates de bytes, para a poda parar antes
dele e o teste "o suspeito podado RODA fora da poda" ter o que provar. Só a rodada limpa assere isso. Mas os
blocos da guarda 12 e do write-guard montavam o fixture com o mesmo conjunto `PADRAO` e pagavam 1–2 sonos
por teste sem asserir nada sobre ordem: **12 execuções × 900ms = 10,8s** — 40% do arquivo na medição
local, o equivalente a ~30% dos 37s do CI.

| bloco (mini-runner local, cronometrando cada `beforeAll`/`it`) | antes | depois | `g:lento` antes |
|---|---|---|---|
| rodada limpa | 5,3s | 5,5s | 4 — é o que ela prova |
| guarda 12 | 7,2s | 1,6s | 5 |
| write-guard | 4,7s | 1,5s | 3 |
| fora-da-rodada | 8,8s | 8,7s | 0 — roda o gate `exclusividade` real; o custo é o assunto |
| demais | 0,8s | 0,8s | 0 |

## O conserto

Os cenários cujo assunto não é a poda passam a usar o conjunto ENXUTO: `g:barato` + `g:pega`. O `g:pega`
é o `g:lento` sem o sono — reprova no mesmo `SABOTADO` —, então assume o `@suspeito`. As duas receitas do
write-guard mantêm o `sonda:fingerprint`: é o gate que prescreve o `regenerar-fingerprints`. O motor não
exige isso, mas um dever de casa sem o gate que o prescreve seria um fixture sem par no repo. O `PADRAO`
ficou restrito, e comentado, à rodada limpa e ao bloco que aborta antes do baseline, onde a lista não
custa nada.

De carona: o `contador()` da guarda 12 criava um `excl-rpc-*` no tmp que nenhum `afterAll` apagava — um
diretório órfão por rodada do arquivo. Agora entra no mesmo registro (`raizes`) que os fixtures.

## A medição local — vitest real, A/B intercalado, mesma máquina

| lado | n | fase de testes do arquivo (s) | média |
|---|---|---|---|
| antes (`HEAD~1`) | 3 | 26,92 · 26,59 · 26,58 | 26,70 |
| depois | 3 | 17,87 · 17,82 · 17,49 | 17,73 |

**−33,6%**, com os intervalos sem sobreposição e 32/32 testes nas seis rodadas. O vazamento teve controle
na mesma invocação: depois do laço sobraram exatamente **3** `excl-rpc-*` — um por rodada do arquivo
original — e zero das rodadas novas.

## A validação no CI — n≥3, relógio da mesma natureza, denominador conferido

Vale a regra de [medir-ganho-de-ci-sob-ruido.md](medir-ganho-de-ci-sob-ruido.md): o runner varia até 45%,
então uma amostra não prova nada, e o ganho se lê contra um relógio de referência do MESMO job, inerte à
mudança. O denominador é conferido em dois níveis: `Test Files 843 passed (843)` e `(32 tests)` na linha do
alvo — com o blob do arquivo (`429ef2f`) conferido em cada head medido.

**O relógio óbvio — o resto da suíte — é o errado para este alvo.** Nas seis amostras "antes", a razão
alvo ÷ resto variou ±8,9%, MAIS que o valor absoluto do alvo (±8,1%): a suíte é CPU (transform, collect,
render) e o alvo é spawn e sono — os 10,8s de `Atomics.wait` não aceleram em máquina rápida. O relógio da
mesma natureza são os outros arquivos de `scripts/`, onde está quase todo teste que sobe processo (11 dos
53, contra 1 dos 467 `.ts` de `src/`): ±6,4%.

| execução | head | alvo (ms) | resto da suíte (ms) | outros `scripts/` (ms) | alvo ÷ `scripts/` |
|---|---|---|---|---|---|
| PR #2543 | `52bd2b8` | 36.103 | 146.432 | 35.730 | 1,010 |
| PR #2544 | `6661a8f` | 37.002 | 149.664 | 38.767 | 0,954 |
| PR #2540 | `7eb830c` | 31.274 | 110.314 | 29.455 | 1,062 |
| main (manual) | `149bfec` | 36.963 | 141.241 | 37.232 | 0,993 |
| main (manual) | `149bfec` | 36.596 | 141.770 | 37.724 | 0,970 |
| main (manual) | `149bfec` | 33.005 | 112.357 | 30.457 | 1,084 |

**Critério pré-registrado** — fixado com os dados "antes" e ANTES de existir amostra "depois": n≥3
execuções do job `testes` que contenham esta mudança (`(32 tests)`, `Test Files N passed (N)`), e o
ganho está provado se TODAS ficarem abaixo da faixa "antes" nos DOIS eixos — absoluto < 31.274ms e
alvo ÷ `scripts/` < 0,954. Os dois eixos juntos porque cada um tem o seu viés: o absoluto herda a
máquina sorteada, e a razão herda qualquer arquivo novo em `scripts/`. Esperado, pela medição local:
~22–25s (estimativa).

**Depois — o critério fechou em n=8, todas dentro nos dois eixos.** A inclusão de cada amostra está
provada no próprio log, não pelo horário: a base do merge no checkout (run de PR) ou o head (run da main)
tem o squash do #2546 como ancestral.

| execução | alvo (ms) | alvo ÷ `scripts/` |
|---|---|---|
| PR #2546 | 25.559 | 0,685 |
| PR #2549 | 28.008 | 0,701 |
| PR #2550 | 26.595 | 0,641 |
| PR #2553 | 27.526 | 0,692 |
| PR #2554 ¹ | 24.545 | 0,779 |
| main `56c5284` (manual) | 21.277 | 0,834 |
| main `56c5284` (manual) | 25.820 | 0,649 |
| main `7f2232e` (manual) | 28.362 | 0,705 |

¹ Roda também a mudança do próprio #2554 no MESMO arquivo (`maintenance.auto=false` no `commitar` do
fixture, que tira a manutenção destacada do git após cada commit) — não mede só este conserto. Sem ela, 7/7
e as médias abaixo não mudam no arredondamento.

O "depois" mais lento (28.362ms) fica abaixo do "antes" mais rápido (31.274ms), e a razão (0,641–0,834)
não encosta na faixa "antes" (0,954–1,084). Pelas médias, ~−26% no absoluto e ~−30% na razão — menos que
os −34% locais, e longe do ruído. O arquivo segue o mais lento da suíte: o que sobra é a rodada limpa e o
fora-da-rodada, custo que é o assunto.

## O impacto honesto

O `testes` não é o caminho crítico do `validate`: roda em ~4–5 min, em paralelo com o
`gates-e-falsificacao`, que leva ~12–13 min por causa do step de Falsificação. **O tempo até o merge não
muda.** O ganho está em três lugares:

1. no laço local de quem mexe no motor — este é o teste dele: 27s → 18s por rodada;
2. em cada rodada do `exclusividade:medir`, cujo gate `test` roda a suíte inteira no baseline e em cada
   linha que chega a ele (quanto disso chega ao relógio depende do paralelismo — não medido);
3. em frear o crescimento: cenário novo com o `PADRAO` custava ~1,8s; com o ENXUTO, ~0,4s (local).

## O que foi descartado, e por quê

- **Baixar o sono de 900ms:** a margem é o que mantém a ordem por custo determinística com a M2
  saturada — o teste que prova a poda passaria a depender de ruído de milissegundo.
- **Colapsar o snapshot do write-guard de 3 `git` para 1:** mexeria no write-guard de produção para ganhar
  só no teste.
- **`describe.concurrent` com spawn assíncrono:** contenção de CPU no worker — o mesmo cenário que produz o
  timeout de RPC do vitest que a guarda 12 existe para classificar.
- **O bloco fora-da-rodada** (8,7s): roda o gate real contra fixtures; o custo é o assunto do teste.

## Na sequência: o `it` mais lento dividia o trabalho com o 2º (parse único, #2550)

Os dois `it` de varredura do `erro-colapsado-em-vazio-gate.test.ts` — auto-ocultação e `return`
afirmativo, o 1º e o 2º `it` mais lentos da suíte — faziam o parse TypeScript das mesmas 1.489 fontes,
cada um do zero, para contar formas diferentes sobre o MESMO `acharColapsos`. Nas 8 execuções do CI
medidas acima: 3.332–5.567ms e 2.541–4.111ms.

O conserto: `contarAutoOcultacaoEm`/`contarRetornoAfirmativoEm` contam sobre sítios já achados (as
funções antigas delegam a eles, então a regra de contagem continua num lugar só), e o teste guarda um memo
preguiçoso por fonte: quem roda primeiro paga o parse, o outro lê o memo. O orçamento do #2311 fica nos
dois, porque qualquer um pode ser o primeiro (sob `-t` ou reordenação). O diagnóstico passa a dividir o
tempo pelas fontes parseadas NAQUELE `it` — senão o `it` servido pelo memo imprimiria "0,02 ms/fonte" e
leria como carga o que não mediu nada.

Local, vitest real, A/B intercalado — o "antes" é o teste original contra o módulo novo, para isolar o memo:

| lado | arquivo (ms) | `it` auto-ocultação (ms) | `it` afirmativo (ms) |
|---|---|---|---|
| antes | 4.642 · 4.530 · 4.303 | 2.602 · 2.386 · 2.347 | 2.015 · 2.117 · 1.935 |
| depois | 2.503 · 2.408 · 2.345 | 2.477 · 2.382 · 2.319 | < 300 (memo) |

**−46%**, 19/19 nas seis rodadas. A equivalência sai da própria asserção: os dois `it` exigem que cada
arquivo bata EXATAMENTE com a baseline — nem sítio a mais, nem a menos —, então o memo contar diferente
seria vermelho. Falsificado com controle verde na mesma invocação: numa cópia, `PrimePlanosTab.tsx` 1→0 na
`BASELINE` e `ToolHistory.tsx` 1→0 na `BASELINE_AFIRMATIVO` deram `Tests 2 failed | 36 passed (38)` —
exatamente os dois `it` de varredura, cada um nomeando o seu `(0→1)`, com o arquivo real verde —, e o
diagnóstico saiu nos dois ramos ("1489 de 1489 fontes parseadas neste `it`" / "as 1489 fontes vieram do
memo").

O `it` de auto-ocultação continua o mais lento da suíte: o custo dele é o parse em si, e só um detector mais
rápido o reduz. O que saiu foi a segunda vez.

**No CI, o relógio é outro.** Este alvo é CPU (parse), da natureza da suíte — mas o "resto" passou a
carregar o ganho do Fix A (−11s num arquivo de `scripts/`), o que enviesaria a razão. A referência é a
soma dos outros arquivos de `src/`: nas 8 execuções "antes" (o teste e o módulo sem commit desde
`1460ea5`), razão 78,7–96,8‰ (±10,5%), contra ±22% do absoluto. **Critério pré-registrado:** n≥3
execuções com a mudança, todas com alvo ÷ outros `src/` < 78,7‰, e — sinal binário, imune à máquina — o
`it` afirmativo fora da lista de testes > 300ms, onde ele aparece nas 8 "antes". O absoluto fica como
informação: o piso "antes" (5.902ms, numa máquina rápida) encosta no teto "depois" esperado numa lenta.

**Resultado — fechou em n=6, todas dentro do critério** (inclusão provada no log, como acima, contra o
squash `56c5284`):

| execução | arquivo (ms) | alvo ÷ outros `src/` | `it` > 300ms |
|---|---|---|---|
| PR #2550 | 5.627 | 53,5‰ | só o de auto-ocultação |
| PR #2553 | 6.511 | 61,9‰ | idem |
| PR #2554 | 3.206 | 42,1‰ | idem |
| main `56c5284` (manual) | 2.979 | 44,2‰ | idem |
| main `56c5284` (manual) | 4.838 | 50,5‰ | idem |
| main `7f2232e` (manual) | 6.348 | 59,4‰ | idem |

A razão (42,1–61,9‰) fica longe da faixa "antes" — que uma 9ª amostra, o CI do #2549 ainda sem o
#2550, alargou para CIMA (113,1‰) sem baixar o piso. Pelas médias, ~−40% na razão e ~−39% no absoluto,
contra −46% local. E o absoluto sozinho, como o critério previa, não separaria: o "depois" mais lento
(6.511ms) passa do "antes" mais rápido (5.902ms). Aqui foi a normalização que tornou a leitura possível.

## Depois: ~42% do `it` não era o parse (2026-09-26)

A frase acima — "só um detector mais rápido o reduz" — estava incompleta. Medido por camada, o vitest
custava ~1,8× o Node puro no mesmo trabalho, e a diferença era o Proxy de interop do vite-node em volta do
CJS do `typescript`: um trap por chamada de `ts.*`, por nó da AST. Com o Proxy fora do laço e um atalho
por condição necessária, o `it` caiu de ~3,0s para ~1,1s no vitest isolado, com os mesmos sítios:
[proxy-de-interop-no-laco-quente.md](proxy-de-interop-no-laco-quente.md).

## Regra

**Custo que um fixture paga para UM cenário não vira o padrão dos outros.** O conjunto caro (sono
sintético, gate real) fica restrito — e comentado — a quem ASSERE o que ele produz; cenário novo parte do
conjunto mínimo que o seu assunto exige. Custo sem asserção é, no eixo do tempo, o mesmo defeito do teste
que não prova nada: paga-se sem receber. E em teste, **todo** `mkdtemp` entra no mesmo registro que o
`afterAll` apaga — diretório criado fora dele vaza uma vez por rodada.

**Ao medir o ganho de UM arquivo, o relógio tem a natureza do alvo.** Normalizar um arquivo de spawn e
sono pelo resto CPU-bound da suíte deu ruído MAIOR que o valor absoluto; a referência que cancela a
máquina é a que ela afeta do mesmo jeito que o alvo.

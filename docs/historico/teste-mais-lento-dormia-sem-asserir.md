# O arquivo de teste mais lento da suíte dormia 11s que nenhum cenário asseria

**Data:** 2026-09-26 · **Alvo:** `scripts/exclusividade-medir.test.ts` · **Substrato:** job `testes` do CI

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

Depois: a registrar com as execuções deste PR e as seguintes na main.

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

## Próximo: o `it` mais lento

Os dois `it` de varredura AST do `erro-colapsado-em-vazio-gate.test.ts` (4,6–5,6s e 3,8–3,9s no CI)
fazem o parse TypeScript das mesmas ~1.489 fontes, cada um do zero. Um parse único compartilhado rendeu,
em bancada, 3,1s → 1,2s com contagens idênticas. Vai em PR separado.

## Regra

**Custo que um fixture paga para UM cenário não vira o padrão dos outros.** O conjunto caro (sono
sintético, gate real) fica restrito — e comentado — a quem ASSERE o que ele produz; cenário novo parte do
conjunto mínimo que o seu assunto exige. Custo sem asserção é, no eixo do tempo, o mesmo defeito do teste
que não prova nada: paga-se sem receber. E em teste, **todo** `mkdtemp` entra no mesmo registro que o
`afterAll` apaga — diretório criado fora dele vaza uma vez por rodada.

**Ao medir o ganho de UM arquivo, o relógio tem a natureza do alvo.** Normalizar um arquivo de spawn e
sono pelo resto CPU-bound da suíte deu ruído MAIOR que o valor absoluto; a referência que cancela a
máquina é a que ela afeta do mesmo jeito que o alvo.

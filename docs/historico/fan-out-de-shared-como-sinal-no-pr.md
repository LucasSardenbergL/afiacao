# Fan-out de `_shared/` como SINAL no PR — o autor decidia P1/P2 sem enxergar (2026-09-05)

## 1. A classe: consequência CORRETA, invisível para quem a causa

O `fonte` servido pela sonda é o hash do fecho transitivo dos imports da edge, `_shared/` incluso.
Mudar `_shared/x.ts` muda o `fonte` de toda edge que o empacota — e isso está certo: os bundles
mudaram mesmo. O problema não é a mecânica; é que **ninguém a vê no momento em que ela acontece**:

| mecanismo | por que é deliberado | o que esconde |
|---|---|---|
| `sonda:bump` exclui `_shared/` | medido: cobri-lo daria ~12 bumps à mão por PR (cabeçalho do gate); precisão > recall | o autor vê o gate VERDE e conclui "nenhuma edge mudou" |
| `sonda:fingerprint --write` regenera o mapa | o fan-out "é de graça porque o CI regenera" (cabeçalho do gerador) | regenera em SILÊNCIO: 18 hashes mudam e o autor não sabe quais |

Medido em 11 dias (2026-09-05): 24 PRs tocaram edges, 42 bumps legítimos de `versao.ts`, **66**
mudanças de `fonte` → **22 pedidos de deploy só por fan-out, sem a edge mudar, 18 de um único PR
(#2132)**. De graça para o CI; para o founder, cada `fonte` que muda é um prompt no Lovable, um
crédito e uma sonda.

A decisão que faltava tem nome na matriz de [`scripts/lib/pendencias-deploy.ts`](../../scripts/lib/pendencias-deploy.ts):
`fonte` diferente com `VERSAO` igual = **DIVERGE_P2** (pendente NÃO declarado, leva agrupada);
com `VERSAO` diferente = **DIVERGE_P1** (comportamento declarado, deploy no PR). Quem muda
`_shared/` querendo mudar o comportamento da edge X bumpa a X — vira P1. Só que essa decisão era
tomada DEPOIS, por outra sessão, lendo o ledger. O autor — o único que sabe se a mudança era de
comportamento — nunca foi consultado, porque nunca viu a lista. A pendência estava nomeada no §5 de
[deploy-redundante-ledger-e-cron-de-sonda.md](deploy-redundante-ledger-e-cron-de-sonda.md), o doc do ledger (#2199).

## 2. O que entrou

- **[`scripts/sonda-fan-out.ts`](../../scripts/sonda-fan-out.ts)** (`bun run sonda:fanout`): para a
  fatia base..HEAD imprime (1) quais arquivos de `_shared/` mudaram, (2) para cada um, quais edges
  instrumentadas tiveram o `fonte` alterado por ele, (3) qual delas bumpou o `VERSAO` nesta fatia.
  **Uma linha por edge, ASCII, rótulos em caixa fixa** (`BUMP` · `SEM_BUMP` · `NOVA` · `ILEGIVEL`).
- **Passo no CI** (`validate`, `pull_request`-only, `continue-on-error: true`), logo após o
  `sonda:fingerprint`. Exit 0 com ou sem achados; exit 2 só por mecânica (base que não resolve, git
  que falha) — e mesmo esse não reprova o PR.
- **Dica no `sonda:fingerprint`:** a mensagem de falha ("fonte mudou e o mapa não") agora aponta
  para o `sonda:fanout` — é o momento em que o autor está olhando.
- Contrato de mutação `scripts/mutcheck.d/sonda-fan-out.mut` (roda no job `mutation-check`).

O bloco, no #2132 (`bun scripts/sonda-fan-out.ts --base 5362ec761^ --head 5362ec761`, recortado):

```
sonda-fan-out: fatia 1508228bb..5362ec761: 3 arquivo(s) de _shared/ mudaram, 20 edge(s) instrumentada(s) com fonte alterado por _shared/
  _shared/itens-com-pedido.ts  consumidoras=2: fin-valor-cockpit,omie-analytics-sync
  _shared/leitura-critica.ts   consumidoras=20: ai-ops-agent,algorithm-a-audit,calculate-scores,...
  _shared/universo-pedidos.ts  consumidoras=7: carteira-positivacao-snapshot,fin-valor-cockpit,...
  SEM_BUMP  ai-ops-agent        v1.0-sensor-inicial (mesmo da base)   por _shared/leitura-critica.ts
  ...
  BUMP      fin-valor-cockpit   v1.1-... -> v1.2-...                  por _shared/itens-com-pedido.ts,...
  resumo: BUMP=2 (P1: comportamento declarado, deploy no PR) SEM_BUMP=18 (P2: fonte muda sem VERSAO, vira DIVERGE_P2 no pendencias:deploy, leva agrupada) NOVA=0 ILEGIVEL=0
  decida agora: SEM_BUMP cujo comportamento muda com esta fatia merece bump do VERSAO (vira P1). Informativo: este passo nunca reprova.
```

## 3. Decisões — e o porquê de cada uma

1. **Informação, não gate.** A mesma medição que tirou `_shared/` do `sonda:bump` vale aqui: aviso
   que grita 12× por PR treina a ignorar. O bloco não reprova nunca; ele entrega a lista para quem
   tem o dado que falta (o autor) no único momento em que ele está olhando (o PR).
2. **Módulo próprio, não um bloco dentro do `sonda-fingerprint.ts`.** O fingerprint é gate de
   ESTADO (roda em push do Lovable e no cron da main, sem base). Este precisa do DIFF — é da família
   do `sonda:bump` (`pull_request`-only, base = merge-base, a MESMA `resolverBase`). E o fingerprint
   é a fonte da `fecharGrafo` que este consome: importar de volta seria ciclo.
3. **A régua reusa as duas réguas existentes em vez de criar uma terceira:** o fecho é a
   `fecharGrafo` que produz o `fonte`; o marcador é lido com a `extrairVersao` do `sonda:bump`.
   Duas noções de "o que entra no bundle" divergem em silêncio (a razão de `parsearMapa` viver no
   fingerprint). Testes e mapa gerado ficam fora porque nunca entram em fecho — o mapa é a SAÍDA e
   mudaria em toda fatia.
4. **Com `--head <rev>` o HEAD é MATERIALIZADO** (`git archive`, como o `edges:afetadas`), nunca a
   árvore de trabalho; sem `--head`, a árvore (a régua do `sonda:bump`). O teste sabota a árvore
   DEPOIS do commit em três eixos — diff, `VERSAO`, fecho — um por leitura que o coletor faz, e o
   `.mut` tem uma mutação por eixo. Um só eixo deixaria a outra leitura vazar em silêncio.
5. **Universo = edges instrumentadas.** `fonte` só existe para elas. Edge FORA do mapa que importa
   `_shared/` é a classe cega do `edges:afetadas` (via c) — outra pergunta, outro script.
6. **`ILEGIVEL` vence `NOVA`.** Nascer sem `export const VERSAO` legível não é nascer instrumentada:
   sem marcador legível a sonda não prova bundle nenhum.
7. **Ordenação por code unit, não `localeCompare`.** O bloco tem de ser idêntico em `LC_ALL=C` e em
   `pt_BR.UTF-8` (#1483).

## 4. Evidência

- Calibração contra o número medido à mão: #2132 → 3 arquivos, 20 edges, **SEM_BUMP=18, BUMP=2**.
- 32 testes vitest (`scripts/sonda-fan-out.test.ts`): núcleo puro com entradas montadas à mão +
  coletor com repo git DE MENTIRA em tmpdir (`git init`, base commitada, fatia na árvore ou
  commitada) + `main` na fixture via `chdir` e no repo real com fatia vazia. Nada lê a árvore real
  do repo — um teste assim mede o que alguém acabou de mudar, não a régua.
- `scripts/mutcheck.d/sonda-fan-out.mut`: 15 mutações `PEGA` (P1/P2 invertido, teste e mapa
  contando, fronteira de string, atribuição sem fecho, aviso engolido, git que falha virando
  "nada mudou", `removido` cego, `--head` lendo a árvore em dois eixos, `--head` cru, resumo que
  mente) + 1 `SOBREVIVE` declarada (largura do sha).

## 5. O que fica para depois (nomeado, não esquecido)

- **`--write` continua mudo** — o escopo desta entrega foi o modo gate e o CI. Imprimir o mesmo bloco
  ao regravar o mapa é uma linha; decidir se vale a pena é do founder.
- **`GITHUB_STEP_SUMMARY`**: o bloco hoje vive no log do passo. Se ninguém abrir o log, o sinal não
  chega — a fase N+1 é medir se alguém lê (query, não recado).
- **O `/fecho` consumir a lista `SEM_BUMP`** para montar a leva agrupada em vez de enumerar de novo.

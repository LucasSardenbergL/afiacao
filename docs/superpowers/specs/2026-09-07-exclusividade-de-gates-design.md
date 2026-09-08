# Contribuição exclusiva de gate: medir o benefício, já que o custo já é medido

**Data:** 2026-09-07 · **Estado:** aprovado pelo founder · **Origem:** parecer Codex (gpt-6-astra, reasoning max)

## O problema

O CI tem ~29 gates nomeados, e **15 dos comandos-gate entraram nas últimas 3 semanas**. O job
`gates-e-falsificacao` virou o gargalo (mediana 357s, 4,4× em 11 dias). Cada gate nasce de uma
lição real e cada um é defensável isoladamente — o que falta não é disciplina, é **denominador**:

> O custo de um gate é medido (segundos no log do CI, a cada PR, para sempre).
> O benefício não é medido em lugar nenhum.

Com um lado da conta visível e o outro não, "criar mais um gate" é sempre a escolha barata. Este
projeto mede o lado que falta.

## O que NÃO é este projeto

**Não é uma campanha de corte.** O parecer do Codex foi explícito em dois pontos onde o diagnóstico
inicial errava, e os dois viram restrição de desenho:

1. **Ausência de sinal não é veredito.** "Numa janela de 80 runs só 5 gates reprovaram algo" não
   condena os outros 24: `docs:links` tem dez links quebrados no seu próprio histórico. Uma janela
   curta não mede um gate raro. Por isso o veredito desta ferramenta **nunca** é "não pega nada" —
   é sempre relativo a um corpus nomeado, com o denominador impresso junto.
2. **`mutation-check` é informativo por desenho** (`.github/workflows/ci.yml:921`, fora de
   `validate.needs`, abre Issue desde #2344). Qualquer censo que o chame de bloqueante está errado.
   Esta medição **não** o promove a required.

## O objeto: matriz defeito × gate

Um **defeito** é uma sabotagem aplicada ao repositório **real** (não a uma raiz sintética — ver
"Achado" abaixo). Rodando os gates contra o repo sabotado obtém-se uma linha da matriz:

```
defeito d  →  gatesQueReprovaram(d) = { g₁, g₃ }
exclusivoDe(g) = { d ∈ corpus : gatesQueReprovaram(d) == {g} }
```

A **contribuição exclusiva** de `g` é `|exclusivoDe(g)|`. Zero significa, literalmente e apenas:
*neste corpus de N defeitos, tudo que `g` pega, outro gate também pega.* O relatório é obrigado a
imprimir N e a lista junto do veredito.

## Achado que corrige a premissa do corpus

As sabotagens `--falsificar` dos ~11 scripts rodam contra uma **raiz sintética** em `$TMP/raiz`
(`scripts/test-gates-frescura.sh:24,91,109`), não contra o repo. Sabotar um `package.json` de
mentira não dá a **nenhum outro gate** a chance de ver o defeito — que é justamente o que a matriz
precisa medir. Logo:

| fonte | reaproveitável como | por quê |
|---|---|---|
| `scripts/mutcheck.d/*.mut` (23) | **código, direto** | sabotam o arquivo de produção real (cópia+trap) |
| `--falsificar` (~11 scripts) | **especificação, traduzida** | vivem numa raiz sintética isolada |
| `docs/historico/` | especificação, escrita | defeitos que aconteceram de verdade |

## Componentes

| unidade | responsabilidade | depende de |
|---|---|---|
| `scripts/lib/exclusividade.ts` | lógica **pura**: parse do `.def`, quais gates bloqueiam PR, derivação da matriz, veredito, fingerprints | `gates-frescura-check.ts` (`inventarioCI`) |
| `scripts/exclusividade-medir.ts` | motor com efeitos: aplica sabotagem, roda gates, grava matriz | a lib + `mutcheck.sh` (disciplina) |
| `scripts/exclusividade-gate.ts` | gate barato do CI: lê a matriz, dá veredito | a lib |
| `scripts/exclusividade.d/*.def` | o corpus versionado | — |
| `scripts/exclusividade-matriz.json` | o artefato medido (o "carimbo") | — |

A fronteira: a lib não executa nada e não toca o disco além de ler; toda a sujeira (mutar arquivo,
rodar subprocesso, restaurar) vive no motor. É o que torna a derivação testável em vitest sem
rodar um único gate.

## Formato do corpus (`.def`)

Irmão do `.mut`, mesmo separador `|`:

```
# @origem: docs/historico/gates-textuais-cegos.md
# @suspeito: docs:indice
<ID> | <alvo> | <expressão perl -pe>
```

`@suspeito` é quem o **autor** acha que pega. **Nunca poda a medição** — entra no relatório como
"declarado × medido". O achado mais útil da ferramenta é justamente "o autor achava que só o dele
pegava; a medição mostrou outros três".

## Disciplina do motor (herdada do `mutcheck`, onde já foi pensada)

1. **Baseline**: repo limpo, todos os gates candidatos **verdes**. Um gate já vermelho torna todo
   resultado lixo — sempre-vermelha aprova tudo (`docs/historico/falsificacao-sem-linha-de-base.md`).
2. **Cópia + trap**: nunca deixa o repo mutado, nem em Ctrl-C.
3. **Guard anti-não-aplicação**: perl que não casou = INVÁLIDO, jamais um falso "ninguém pegou".
4. **Poda por custo, não por declaração**: roda os gates do mais barato ao mais caro e **para no 2º
   vermelho** — a exclusividade já está refutada. Só o defeito que fica com ≤1 vermelho paga a
   lista inteira. A poda não consulta `@suspeito`: declaração podaria a medição a favor de quem
   declara.

## As outras duas métricas exigidas pelo Codex

- **Duração**: por execução, por gate, gravada na matriz.
- **Falso positivo**, em dois eixos que não se confundem:
  - (a) gate vermelho no **baseline limpo** → ruído puro;
  - (b) gate vermelho em defeito **fora do seu domínio** → acoplamento suspeito.

## Onde roda, e o que bloqueia

Padrão `authz:carimbo`: medição cara fora do CI → artefato versionado com fingerprints → gate
barato no CI.

| situação | veredito | por quê |
|---|---|---|
| gate **novo** sem ≥1 linha exclusiva | **REPROVA** | é o objetivo: tornar a criação não-gratuita |
| fonte do gate mudou desde a medição | **avisa** | reprovar apodreceria a cada edição e viraria fricção que se contorna |
| exclusividade zero em gate existente | **relata** | o corte é decisão do founder, não da ferramenta |

## Não-redundância já provada entra como fato, não como hipótese

As quatro camadas de edge — `test:edges` (Deno) · `edges:typecheck` (a Deno não type-checa) ·
vitest (lê a edge como texto) · as DUAS sondas (`sonda:bump` = O QUE mudou, `sonda:fingerprint` =
QUE mudou) — já estão provadas em `docs/historico/ci-testes-edge-deno.md`. Entram na matriz como
declaração documentada. Re-medir o que já foi provado gasta o orçamento no lugar errado.

## Sub-achado: `inventarioCI` chama `mutcheck` de bloqueante

`gates-frescura-check.ts:172` filtra `continue-on-error` no **step**, mas `mutation-check` é um
**job** fora de `validate.needs`. A lib nova deriva "bloqueia PR?" de `validate.needs`
transitivamente, em vez de lista fixa — que é o que impede o censo de envelhecer.

## Escopo da primeira leva

Os 2 candidatos nomeados pelo Codex (`docs:indice`, duplicado entre o step do CI e
`scripts/docs-indice-gate-check.test.ts:265`; `test-verify-edge-pat.sh`, que testa com stub um
caminho indisponível neste setup) + os gates do job gargalo `gates-e-falsificacao`.

Nenhuma remoção é executada sem trazer o resultado ao founder primeiro.

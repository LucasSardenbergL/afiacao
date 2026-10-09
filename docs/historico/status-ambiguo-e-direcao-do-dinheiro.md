# Status ambíguo e a DIREÇÃO do dinheiro — o aberto canônico não serve às duas pontas do caixa previsto

> **A classe (decidida em 2026-09-10, entregue em 2026-10-08):** numa SOMA que alimenta decisão de caixa, um item de classificação
> ambígua não tem resposta neutra. Incluí-lo afirma um status que ninguém provou; excluí-lo fabrica
> zero para ele (ausente ≠ zero). "Precisão > recall" não se traduz em "exclua o ambíguo": numa
> soma as duas escolhas erram, e o que muda é o LADO do erro.
>
> A regra: **escolha o erro conservador pela DIREÇÃO do dinheiro.** Entrada prevista exige evidência
> positiva (o ambíguo fica fora); saída prevista conta na dúvida (o ambíguo fica dentro). Assim
> nenhum status ambíguo infla o caixa projetado. Havendo um canal visível na tela, o melhor ainda
> seria excluir E sinalizar; sem canal, a direção decide.

## O caso

`getFluxoCaixa` (`src/services/financeiroService.ts`) — o caixa PREVISTO por dia da aba "Fluxo de
Caixa" de /financeiro. Depois do #2458 (previsto pelo `saldo`, não pelo documento), a tarefa pedia
trocar a lista curta de status (`'A VENCER'`, `'ATRASADO'`, `'VENCE HOJE'`) pelo aberto canônico de
`isOpenTitleStatus` — os 6 que `somarSaldoAberto`, o DSO e os KPIs usam, com os fallbacks do ingest
`'ABERTO'`, `'VENCIDO'` e `'PARCIAL'`.

A 2ª opinião (Codex gpt-6-astra, reasoning max, 558 s) discordou com dois [P1]:

- `'ABERTO'` não prova obrigação aberta: é o que o ingest grava quando o Omie NÃO manda status — e é
  o DEFAULT da coluna. Um título cancelado sem status viraria entrada prevista.
- `'PARCIAL'` só tem remanescente confiável com a baixa gravada. Sem ela (#396: `valor_recebido = 0`
  em 100% das linhas), `saldo` = documento cheio, e a parte já recebida — que está no saldo âncora —
  entraria de novo. A justificativa da troca ("só é seguro por causa do #2458") dependia de um
  #2458 que ainda está DORMENTE.

O parecer olhou só as ENTRADAS. Na saída, excluir o título ambíguo é o erro OTIMISTA: a obrigação
some da projeção e o saldo projetado sobe. Aplicada na direção do dinheiro, a mesma regra de
precisão pede o contrário no CP.

**Decisão do founder:** assimétrico. CR com os 3 status nativos (`STATUS_ENTRADA_PREVISTA`, onde o
porquê está escrito); CP com o aberto canônico. O `'PARCIAL'` do CR volta à mesa quando o #396
gravar a baixa.

⇒ **Tell:** quando um parecer aplica "não mostre o ambíguo" a uma SOMA, pergunte em que direção cada
parcela move a decisão. Tirar uma parcela de uma soma também é afirmar um número.

## O piso zero, e por que é POR TÍTULO

`saldo < 0` num título ainda aberto (baixa maior que o documento: juros/multa na baixa, ou status
defasado) entrava como entrada NEGATIVA no CR e, no CP, como saída negativa que SOBE o acumulado. O
piso descarta a contribuição que inverteria a direção do título — sem afirmar que ele foi liquidado:
se é juros, erro de baixa ou compensação, a coluna não diz. Devolução ao cliente não passa por aí: o
Omie a lança como uma CP separada, que segue entrando. Por título e não por dia: no dia, o negativo
de um título comeria a entrada do vizinho — e é esse o cenário que o teste monta.

Com isso `somarSaldoAberto` e o fluxo convergem na COLUNA e, no CP, no filtro — não no número. Lá é a
soma dos saldos armazenados (o negativo abate o total) de todo título aberto; aqui é caixa futuro
por título, só na janela da tela e, na entrada, só com status nativo. São perguntas diferentes.

## Hoje o número não muda (e isso é medição)

psql-ro, 2026-10-08 08:54 BRT: 45.129 CR + 16.223 CP, zero com `saldo <> valor_documento`, zero com
`saldo < 0`, zero com status `'ABERTO'`/`'VENCIDO'`/`'PARCIAL'`. Na janela da tela, previsto velho =
novo nas 6 combinações lado × empresa (1.063 dias, 0 diferentes). É defesa para quando o ingest
mudar — o gatilho destes defeitos é o INGEST, não a tela.

## A suíte que aprovava sabotagem

Seis trocas passavam 17/17 (achado Codex no #2458): `saldo || valor_documento`, filtro de status
removido, só `'A VENCER'`, `ensureDay(dataInicio)`, `=` no lugar de `+=`, `saldo_previsto` zerado. A
mutação da 1ª rodada Codex (32 mutantes, 17 sobreviventes) apontou os outros buracos: empresa,
janela, `.order("id")`, centavos, status desconhecido e nulo. A suíte foi a 28 casos, e as
sabotagens viraram contrato versionado (`scripts/mutcheck.d/fluxo-caixa-previsto.mut`) —
falsificação que só roda à mão é ausência de dado.

Dois desenhos que deram dente:

- **Controle positivo em todo teste que espera "não entra".** Sem um título legítimo no mesmo
  cenário, uma sabotagem que zerasse o previsto inteiro também passaria.
- **Potências de 10 por status e magnitudes distintas por lado.** A mensagem do vitest
  (`expected 1111 to be 1`) diz QUAL status vazou e QUAL laço quebrou — a falsificação casa a
  mensagem exata, não "falhou alguma coisa".

`saldo_previsto` segue sem teste, de propósito (`SOBREVIVE` no contrato): não tem leitor em produção
e acumula previsto desde o início da janela, sem âncora — a classe do #2459 esperando um consumidor.
Removê-lo é decisão à parte.

## Registrado, fora do escopo

- ✅ **Corrigido** (2026-10-08, [ancora-nova-com-previsto-velho.md](ancora-nova-com-previsto-velho.md)):
  `syncAll` recarregava só o resumo — depois de "Sincronizar", a âncora era nova e o fluxo, velho, e um
  título que virou RECEBIDO já estava no saldo e seguia como entrada prevista. Acontecia HOJE, sem #396.
- O ingest compara o vencimento em UTC: das 21h à meia-noite (SP), um título sem status que vence
  AMANHÃ vira `'VENCIDO'`.
- ✅ **Corrigido** na mesma entrega: `loadFluxoCaixa` mantinha o fluxo anterior quando a carga falhava —
  trocar de empresa e falhar mostrava o fluxo da empresa anterior com a âncora da atual.
- `buscarTodasPaginas` não tem guard de página que nunca encolhe: sem `.range()`, o laço não termina.
- O contrato do #396 precisa separar baixa financeira de redução da obrigação: desconto concedido
  sem recebimento deixa o `saldo` no documento cheio.

# O total do pedido lia um desconto que não existe — e corrigir o NÍVEL cria um erro de COMPARAÇÃO

**2026-09-10** · `supabase/functions/_shared/omie-pedido.ts` (`apurarSubtotalPedido`) · money-path · continuação de [desconto-a-sonda-lia-campo-que-nao-existe.md](desconto-a-sonda-lia-campo-que-nao-existe.md) (#2386/#2412)

## O defeito

`sales_orders.subtotal`/`total` eram `Σ qtd·preço·(1 − prod.desconto/100)` em três escritores (o `sync_pedidos` e o `reparar_orfaos_itens` do `omie-vendas-sync`, e o `sync-reprocess`). `desconto` pelado não existe em `det.produto` da API do Omie — o trio real é `tipo_desconto`/`percentual_desconto`/`valor_desconto`. O `|| 0` zerava o fator e o total saía **bruto**.

Medido em prod (psql-ro): **31.315/31.315** pais Omie com `total == Σ qtd·unit_price` (a semântica gravada era 100% bruto), e o primeiro pedido com desconto que a régua apurou em `order_items` — oben `12183048572`, 1×460,25 a 5% e 2×584,50 a 10% — gravado a **1629,25** com líquido de **1489,34** (9,4% acima). Ativo, não latente.

## O que se decidiu, e por quê

- **Fórmula única** em `apurarSubtotalPedido`: `Σ (qtd·preço − descontoItemOmie(prod, qtd·preço))`, a mesma chamada que grava `order_items.desconto_valor`, sobre os itens que viram linha (com `codigo_produto`). Os três escritores passam a chamá-la. Sem desconto, o número é **bit a bit** o antigo — a reconciliação só reescreve quem tem desconto.
- **G5 de `criar_pedidos_com_itens` intocado, sem migration.** O domínio do G5 são só os órfãos (pai sem itens; G4 pula quem já tem). Medido: **1** órfão em 31.316, de 2026-06-10 (anterior à RPC atômica), `total 0` e `items []`; nenhum caminho cria órfão novo (G7 na RPC, a edição recusa lista vazia, a reconciliação exige ≥1 item válido, zero `.delete()` PostgREST em `order_items`). Com total 0, o veredito não depende da fórmula: bruto e líquido divergem igual (provado em PG17, F2b). E a trigger de coerência do agregado (ativa, **deferida**) já tornava o reparo desse órfão impossível: as linhas inseridas não bateriam com o `items []` no commit.
- **Desconto ilegível derruba o PEDIDO, não o item.** Quando a régua devolve `null`, as duas saídas "óbvias" fabricam: somar pelo bruto é o `null → 0` renascido; deixar só o item de fora publica uma soma parcial com cara de total — e, no órfão de total 0, faria o G5 **aprovar** o reparo (achado do Codex). O pedido não se publica: existente fica na revisão anterior, novo não entra, e o contador + a amostra de ids vão ao resultado (`fin_sync_log.results`; `metadata` + `error_message` no reprocess, que o watchdog lê). Medido: 0 ilegíveis nas 77 linhas apuradas desde a régua.

## A forma generalizável — o que a 2ª opinião trouxe

> **Corrigir o NÍVEL de uma coluna que tem leitores COMPARADORES cria um erro de comparação até o acervo convergir.** Um erro consistente compara certo; a verdade inconsistente compara errado. Antes, passado e presente eram ambos brutos e a variação mês a mês saía certa por acidente. Depois do fix, o presente é líquido e o passado bruto: um cliente com 10% de desconto ganha uma "queda" artificial de 10% em `faturamento_90d × prev_90d`.

Os leitores não precisam discordar da semântica para isso acontecer — aqui todos leem `total` como "valor do pedido". O que falta é **homogeneidade no tempo**. Duas saídas legítimas, e uma armadilha:

1. **base homogênea** — converter o acervo numa passada própria (backfill de `desconto_valor` + recompute do cabeçalho onde todas as linhas estão apuradas), idealmente colada ao deploy;
2. **discriminador** (versionar a semântica) — só ajuda se os comparadores o usarem; sozinho é rótulo;
3. a armadilha: coluna nova (`total_liquido`), o remédio do `desconto_valor`. Lá os leitores DISCORDAVAM da semântica, e a coluna nova comprou a liberdade de ordená-los. Aqui não há discordância, só defasagem no tempo, e forçar ~20 leitores a migrar resolveria o problema errado.

A distorção nasce perto de zero e cresce com o tempo, a menos que alguém converta parte da janela de uma vez: aqui o reprocess reconcilia os últimos 30 dias da oben logo após o deploy, então ~1/3 do `faturamento_90d` de um cliente oben com desconto vira líquido imediatamente.

## A falsificação usou o conserto REJEITADO como sabotagem

`db/test-desconto-valor-escritores.sh` §F prova as premissas do G5 intocado com as RPCs como estão em prod. O F5 sabota o G5 **aumentando a tolerância para além do desconto** — exatamente o conserto recusado ("duas portas de aprovação") — e exige que o órfão legado passe a ser **reparado sob cabeçalho bruto**. Ficou vermelho como devia. Quando uma alternativa foi descartada por abrir a porta errada, ela é a melhor sabotagem para provar que o assert fecha essa porta.

## Verde por cegueira, pego antes do CI

O teste "sem desconto, bit a bit o legado" tinha três fixtures, e **as três davam o mesmo número arredondando por linha ou no fim** (100,70 · 1629,25 · 252,55, conferido). Ele ficaria verde com a política de arredondamento trocada, que é justamente a troca que reescreveria centavos de pedido sem desconto na primeira passada do reprocess. A fixture 10 × 1,004 (10,00 × 10,04) separa as duas. Regra: **a fixture de um teste de política tem de produzir números diferentes sob as políticas que ele diz distinguir** — senão ele mede o nada, como o acervo de desconto-zero media.

## Evidência

- `supabase/functions/_shared/omie-pedido_test.ts` — 21 testes (o pedido real 1489,34; o discriminante 180/190; fail-closed nos 4 motivos da régua; universo; limite de ½ centavo por linha).
- `scripts/mutcheck.d/omie-pedido-subtotal.mut` — **10 mutações · 10 pegas · 0 sobreviventes · 0 inválidas · controle+ ✓**, em `LC_ALL=C` e `pt_BR.UTF-8`.
- `src/__tests__/edge-money-path-invariants.test.ts` — pin de forma e de FIAÇÃO nos três escritores; falsificado 9/9 com controle verde na mesma invocação.
- `db/test-desconto-valor-escritores.sh` §F — 35 ok, com F5 (tolerância) vermelho sob sabotagem.

## O que ficou aberto, de propósito

- **A passada no acervo** (o que fecha a distorção de comparação) — o backfill de `desconto_valor` está em curso noutra frente (#2467); falta o recompute do cabeçalho.
- **A reconciliação não carrega `desconto_valor`** por linha: desconto que muda sozinho no Omie deixa a linha velha sob o cabeçalho novo (lacuna do #2412, não desta entrega).
- **A edição do app** exige `discount = 0` e `p_total = Σ qtd·preço` — editar pelo app um pedido com desconto no ERP pode apagar o desconto comercial.
- **O cupom impresso** mostra os itens do items-jsonb (bruto) sob o total líquido, sem linha de desconto.
- **REVISÃO INDEPENDENTE PENDENTE** da revisão de código: a cota do Codex esgotou na 2ª rodada; o Caminho B (PG17 falsificável + mutcheck) cobre o intervalo.

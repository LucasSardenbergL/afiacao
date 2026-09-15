# O cupom somava linhas BRUTAS sob um total LÍQUIDO — e a quebra de desconto só vai ao papel quando a conta fecha

**2026-09-14** · `src/components/sales/print/descontoCupom.ts` (+ os dois renderizadores do cupom) · money-path · continuação de [total-liquido-do-pedido-e-a-base-que-compara.md](total-liquido-do-pedido-e-a-base-que-compara.md) (#2469)

## O defeito

O cupom impresso tem DOIS renderizadores — `buildSingleOrderHtml` (lote, `/sales/print`) e `openPrintOrder` (avulso, na listagem e no `/sales/print`) — e os dois montam as linhas do jsonb `sales_orders.items` (`quantidade × valor_unitario`, sem desconto) sob o "Subtotal"/"TOTAL" do cabeçalho. Desde o #2469 o cabeçalho é LÍQUIDO do desconto de item: no pedido real oben 12183048572 as linhas somam 1.629,25 e o total líquido é 1.489,34, sem nada no papel explicando os R$ 139,91. A linha "Desconto" que já existia lia `sales_orders.discount` (sempre 0) atrás de uma lista de 3 CNPJs — nunca apareceu.

A chave `desconto` do jsonb é legado (sempre 0) e não pode mudar sozinha: a trigger de coerência do agregado compara o jsonb com `order_items.discount`. O desconto real de cada linha só existe em `order_items.desconto_valor` (R$ da linha; NULL = não apurado).

## O que se decidiu

- **Casamento jsonb ↔ order_items pela identidade da trigger de coerência** — `(omie_codigo_produto, quantidade, preço)`, não por posição (as linhas vêm na ordem de `omie_codigo_item`). Linhas indistinguíveis com descontos DIFERENTES (duas cores da mesma base): nenhuma leva desconto, porque não há como saber qual item do papel levou qual.
- **A quebra só vai ao papel quando FECHA** (decisão do founder): Subtotal bruto − Desconto = TOTAL gravado, **em centavos**. Não fechou — cabeçalho ainda bruto, desconto apurado sem par no papel, item sem preço, total ausente — o cupom sai **como hoje** e a equipe recebe um aviso (toast). Nunca vai ao papel uma conta que não fecha.
- **Conferência exata, não "½ centavo por linha".** O edge arredonda o total UMA vez (`apurarSubtotalPedido`), então Σ bruto − Σ desconto já cai no centavo do total. Folga por linha aceitaria, num pedido de 40 linhas, um cabeçalho BRUTO com R$ 0,15 de desconto e imprimiria "Subtotal 400,00 / Desconto −0,15 / TOTAL 400,00". A fixture de 40 linhas existe para separar as duas políticas.
- **Sem desconto a explicar → como hoje, sem aviso** (decisão do founder): nenhuma linha apurada, desconto zero, pedido sem order_items (push do app), afiação. O backfill do #2486 vai apurar quase todo o acervo com zero, e o cupom de ninguém muda por isso.
- **Linha não apurada entre apuradas → "—"** no desconto e no total da linha (`receitaLiquidaItem` devolve `null`), e o rótulo passa a "Desconto (N de M itens)". O desconto que é conhecido soma; o não apurado fica fora da soma, nunca entra como 0.
- **Leitura de order_items que falhou → como hoje + aviso.** "Não consegui ler" não é "não há desconto". No `/sales/print` a leitura é em lote (`fetchAllPages`, lotes de 100 ids no `.in()`), e pedido que o lote não cobriu é `falhou`, nunca lista vazia. Na listagem, só a falha ASSINADA pelo `fetchAllPages` (`ehFalhaDePagina`) vira aviso; exceção de código sobe crua.
- **`receitaLiquidaItem` espelhado em `src/lib/pedido/desconto-item.ts`, sem tocar o edge.** A paridade é por COMPORTAMENTO: o teste importa as duas implementações (a de `_shared/desconto-omie.ts` e a de `src/`) e compara ~19,7 mil triplas de entradas. Editar o `_shared` (nem que fosse um marcador `MIRROR`) mudaria a fonte de toda edge que o importa, com sonda e deploy para nada.
- **Coluna `discount` e jsonb `items` intocados.** No caminho SEM quebra os dois renderizadores produzem o HTML de hoje byte a byte, incluída a linha legada por CNPJ; com quebra, a linha legada não duplica o "Desconto".

## Estado em produção no dia da entrega — por que o cupom AINDA não mostra a quebra

Medido (psql-ro, 2026-09-14): **5 pedidos** com desconto apurado > 0 e os 5 com cabeçalho **BRUTO** — inclusive o 12183048572, com `total` 1.629,25. `bun run pendencias:deploy` confirma a causa: `omie-vendas-sync` e `sync-reprocess` com deploy PENDENTE (prod v1.6 → main v1.7-subtotal-liquido-pela-regua). Até o deploy + reprocess do #2469 alcançarem esses pedidos, o cupom deles sai como hoje, com aviso à equipe. Converge sozinho, sem nova entrega.

**Sensor — quando medir é query, não recado.** Aproxima a régua do cupom pelo bruto de `order_items` (o cupom confere pelo jsonb, que a trigger de coerência mantém igual):

```sql
WITH linhas AS (
  SELECT sales_order_id, sum(quantity * unit_price) AS bruto, sum(desconto_valor) AS desconto
  FROM order_items GROUP BY 1
  HAVING count(*) FILTER (WHERE desconto_valor > 0) > 0
)
SELECT count(*) AS pedidos_com_desconto,
       count(*) FILTER (WHERE round(l.bruto - l.desconto, 2) =  round(so.total, 2)) AS cupom_com_quebra,
       count(*) FILTER (WHERE round(l.bruto - l.desconto, 2) <> round(so.total, 2)) AS cupom_sem_quebra_com_aviso
FROM linhas l JOIN sales_orders so ON so.id = l.sales_order_id;
```

2026-09-14: `5 | 0 | 5`. Depois do deploy + reprocess, `cupom_com_quebra` tem de subir; se não subir, o defeito está no cabeçalho, não no cupom.

## Evidência

- **RED antes do código de produção**, numa invocação só: 14 falharam e 50 passaram, todas por "falta a feature", menos uma. A contagem de colunas por `<th style=` era bug do TESTE, porque o `<th>Descrição</th>` não tem `style`. Virou `/<th[ >]/g`, e a contagem (6 × 7) foi provada nos HTML de antes, antes de a correção valer.
- `src/lib/pedido/__tests__/desconto-item.test.ts` — paridade diferencial src × `_shared` em 27³ = 19.683 triplas, com piso anti-grade-vácua (ramo nulo e ≥50 resultados distintos).
- `src/components/sales/print/__tests__/descontoCupom.test.ts` — o pedido real nos dois regimes do cabeçalho, a fixture de 40 linhas, ambiguidade, compensação entre grupos, excedente, arredondamento de 0,29, leitura que falhou e lote que não cobriu o pedido.
- `scripts/mutcheck.d/desconto-cupom.mut` — **11 mutações · 11 pegas · 0 sobreviventes**, com baseline verde, no job `mutation-check` do CI do #2502 (um locale só, o do CI).
- **Caracterização byte a byte do cupom sem quebra: 72/72 idênticos** — 2 pedidos × 3 empresas × 2 renderizadores × 6 leituras que devem imprimir como hoje (não se aplica, falhou, lida vazia, lida nula, desconto zero, cabeçalho bruto).

## Continuação — a mensagem de WhatsApp com a mesma régua

O compartilhar da listagem de pedidos (`handleShareOrder` → `shareOrderViaWhatsApp`) tinha o mesmo defeito, numa mensagem que vai ao CLIENTE: cada item saía `quantidade × preço` do jsonb bruto sob o "Total" líquido.

- **A régua é a do cupom, sem cópia.** `montarCompartilhamento` (`src/components/salesOrders/compartilhar.ts`) chama `resolverDescontoCupom` com a MESMA leitura do `printOrder` (`getDescontosItens`, mesmo cache). Com a quebra, cada linha vai LÍQUIDA (`receitaLiquidaItem`; "—" quando o desconto da linha não foi apurado) e a mensagem ganha **Subtotal / Desconto / Total, com os rótulos do cupom**. Sem a quebra, sai a mensagem de hoje, byte a byte.
- **Por que Subtotal, e não só a linha "Desconto"** (decisão do founder): sob linhas líquidas, que já somam o Total, um "Desconto: - R$ 139,91" solto se lê como desconto AINDA NÃO aplicado — a conta que o cliente vê (itens − desconto) não fecha. O rodapé mostra a conta que a régua conferiu (bruto − desconto = total), e ela continua fechando no caso parcial ("Desconto (1 de 2 itens)").
- **Fronteira de módulo.** `src/utils/whatsappShare.ts` é de `telefonia-whatsapp-rota` e não importa de vendas: recebe o total de cada linha (`lineTotal`: ausente = quantidade × preço, `null` = "—") e a `quebraDesconto` já conferidos, e só escreve.
- **O aviso da equipe fala da MENSAGEM.** O aviso da régua termina com a consequência no cupom ("o cupom saiu sem a coluna de desconto"). A mensagem reaproveita a CAUSA, com os dois valores, e troca a consequência: "a mensagem saiu sem as linhas de desconto". Leitura que falhou diz que não conseguiu ler — nunca "sem desconto". Um teste reprova se o aviso voltar a citar o cupom.

## O que ficou aberto, de propósito

- **O painel de detalhe do pedido** (`SalesOrderDetailSheet`) tem a mesma incoerência — itens brutos sob total líquido. Fora do escopo do cupom e da mensagem (o compartilhar por WhatsApp foi coberto na continuação acima).
- **A linha legada "Desconto" por CNPJ** (`cnpjsComDesconto`, com listas DIFERENTES nos dois renderizadores) lê `discount`, que é sempre 0: código morto, mantido para o caminho sem quebra ser byte a byte o de hoje.
- **O cabeçalho do acervo** (herdado do #2469): pedido antigo com desconto apurado pelo backfill e cabeçalho bruto sai sem quebra, com aviso, até a passada `pedido_total_liquido_converter` (já na main em `b4b9c8778`, com apply manual) convertê-lo. O cupom não precisa de nova entrega: a conversão usa a mesma conta da conferência daqui (`round(Σ(qtd·preço − desconto_valor), 2)`, arredondada uma vez), então a quebra aparece sozinha quando o total convertido fecha com as linhas.
- **REVISÃO INDEPENDENTE PENDENTE.** A 2ª opinião do Codex (`scripts/codex-async.sh -r max`) bateu em `COTA_ESGOTADA` em 2026-09-14 — plano declarado `prolite`, o assinado, janela reabre em 19/09 às 13:21. O intervalo foi coberto pelo Caminho B: mutação do `descontoCupom.ts`, caracterização byte a byte e auto-desafio das mesmas 6 perguntas do prompt. Isso cobre, mas não substitui, a revisão independente: rodar o Codex retroativo quando a cota voltar.

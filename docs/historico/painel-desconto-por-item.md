# O painel de detalhe somava linhas BRUTAS sob o total LÍQUIDO — a régua do cupom na tela, e a leitura que falhou avisa em vez de sumir

**2026-09-15** · `src/components/salesOrders/SalesOrderDetailSheet.tsx` (+ `descontosDoPainel.ts`, `useDescontosItensPedido.ts`) · money-path · continuação de [cupom-desconto-por-item.md](cupom-desconto-por-item.md) (#2502) e do compartilhar por WhatsApp (#2506)

## O defeito

O painel lateral do pedido de venda (`/sales` → clicar no card) montava cada item do jsonb `sales_orders.items` — `quantidade × valor_unitario` e `itemTotal(item)`, BRUTOS — sob o "Subtotal"/"Total" do cabeçalho, que é LÍQUIDO desde o #2469. No pedido real oben 12183048572 as linhas somam 1.629,25 sob um total de 1.489,34, e nada na tela explicava os R$ 139,91. O #2502 corrigiu o cupom impresso e o #2506 a mensagem de WhatsApp; o painel era a última das três superfícies.

## O que se decidiu

- **A régua é a do cupom, reusada — não reescrita.** `resolverDescontoCupom(order.items, leitura, order.total)` decide; o líquido da linha vem de `receitaLiquidaItem` (espelho do edge). Valem as decisões do founder no #2502: a quebra só aparece quando Subtotal bruto − Desconto fecha com o TOTAL em centavos; desconto zero não muda a tela; linha não apurada sai "—"; não fechou → a tela de hoje.
- **Desenho aprovado: "A + sublinha".** A linha com desconto ganha, na sublinha, `qtd × preço · desconto - R$ X` (não apurado: `· desconto —`), e o valor à direita passa a ser o LÍQUIDO da linha. Os totais viram Subtotal (bruto) / Desconto ou `Desconto (N de M itens)` / Total.
- **Linha com desconto ZERO dentro de uma quebra não ganha sufixo** (decisão desta entrega, sinalizada ao founder): a sublinha e o total dela ficam os de hoje. "Não apurado" continua explícito ("—"), então omitir o zero não apaga a distinção.
- **"Não consegui ler" não é "não há desconto".** A leitura de `order_items` virou query (`useDescontosItensPedido`) e o host passa a query INTEIRA — estado junto com o dado — ao painel. `descontosDoPainel` traduz para as 3 leituras da régua: sem dado → `falhou` (a tela de hoje) e, quando a causa é erro ou falta de rede, `<AvisoLeituraFalhou>` acima dos totais; `carregando` e `desabilitada` não avisam (transitório / pergunta não feita). Com cache em mãos e refetch que falhou, a quebra do cache fica e o aviso acompanha (`desatualizado`). Dado que não cobre ESTE pedido → `falhou` + aviso de erro. Afiação → não se aplica.
- **Chave compartilhada** (`descontosItensQueryKey`) entre o `useQuery` do painel e o `fetchQuery` do cupom e da mensagem: o hover da listagem aquece os três, sem fetch dobrado — o padrão de `orderDetailQueryKey`.
- **O painel não avisa quando a conta não fecha** (cabeçalho ainda bruto, desconto sem par no papel): por decisão, a tela fica a de hoje. Quem avisa a equipe nesse caso é o cupom e a mensagem, no toast de quem imprime ou compartilha.
- **Intocados:** o jsonb `items`, a coluna `discount`, `descontoCupom.ts` e `desconto-item.ts`.

## Estado em produção no dia da entrega

Medido no #2502 (psql-ro, 2026-09-14): 5 pedidos com desconto apurado > 0, os 5 com cabeçalho BRUTO (deploy de `omie-vendas-sync`/`sync-reprocess` v1.7 pendente). Nesses pedidos a conta não fecha e o painel mostra a tela de hoje, sem aviso. Converge sozinho com o deploy + reprocess; a query sensora de [cupom-desconto-por-item.md](cupom-desconto-por-item.md) (`cupom_com_quebra`) mede o painel também, porque a régua é a mesma.

## Evidência

- `src/components/salesOrders/__tests__/descontosDoPainel.test.ts` — os 11 estados da leitura (status × fetchStatus × dado × origem).
- `src/components/salesOrders/__tests__/useDescontosItensPedido.test.tsx` — lê o cache que o cupom aquece sem buscar de novo; afiação e painel sem pedido não perguntam.
- `src/components/salesOrders/__tests__/SalesOrderDetailSheet.test.tsx` — o pedido real na quebra, na parcial ("—" e "1 de 2 itens") e com linha de desconto zero; cache com refetch que falhou; leitura que falhou; sem rede; afiação. E o "como hoje" medido na MARCAÇÃO: sem quebra (cabeçalho bruto, desconto zero, nenhuma linha apurada, carregando, query desabilitada) o HTML do painel é o de um pedido sem desconto a explicar; com erro, sem rede ou dado que não cobre o pedido, é esse HTML mais o aviso e nada além.
- **TDD:** vermelho observado antes do código — os 9 testes novos do painel falharam pelo motivo esperado e os 2 módulos novos não existiam; os 15 testes de hoje e de caracterização passaram. Verde local: 25 arquivos / 240 testes (`salesOrders`, `sales/print`, `lib/pedido` + gates de manifesto, fronteiras e erro-colapsado-em-vazio), `typecheck:app` e eslint limpos.
- **Antes × depois:** a marcação do painel ANTES da mudança, gravada em 8 cenários sem quebra (tinta, cabeçalho bruto com linhas, líquido sem linhas, carregando, desconto zero, afiação, item sem preço, cancelado sem itens), é idêntica byte a byte à de DEPOIS.
- **Contratos de mutação:** [`desconto-painel-leitura.mut`](../../scripts/mutcheck.d/desconto-painel-leitura.mut) 7/7 e [`desconto-painel-tela.mut`](../../scripts/mutcheck.d/desconto-painel-tela.mut) 9/9 mortos, controle+ ✓. O compila-check da tela é o transpile SEM bundle (`@compile_cmd`): o padrão arrasta o grafo inteiro do componente só para conferir sintaxe; medido, o fonte válido sai 0 e uma cópia quebrada sai 1.
- **Arredondamento por linha** (herdado da régua do cupom): cada líquido de linha é arredondado ao centavo e o TOTAL uma vez só, então com quantidade fracionária ou preço de mais de 2 casas a soma das linhas poderia diferir do Total em centavos — a conta Subtotal − Desconto = Total segue fechando. Medido (psql-ro, 2026-09-15): nas 9 linhas dos 5 pedidos com desconto, 0 quantidades fracionárias, 0 preços com mais de 2 casas, 0 brutos com fração de centavo.

## Revisão independente — Caminho B

O Codex (`scripts/codex-async.sh -r max`) bateu em `COTA_ESGOTADA` em 2026-09-15 (plano declarado `prolite`, janela reabre em 19/09 às 13:21). Caminho B, com as 6 perguntas do prompt respondidas por mim:

1. **Régua recebendo leitura de outro pedido, ou `lida []` sem leitura** — descartado: painel e query saem do mesmo pedido selecionado; `leituraDoPedido` lê só o id do pedido (ausente → `falhou` + aviso); sem `placeholderData`; query desabilitada é "pergunta não feita" (tela de hoje, sem afirmar). RLS negada devolveria vazio, mas o SELECT de `order_items` foi conferido em produção para staff (psql-ro, 2026-09-14).
2. **Conta que não fecha na tela** — descartado para Subtotal − Desconto = Total (só existe com a quebra da régua); o arredondamento por linha está medido acima.
3. **Mapeamento de estados** — descartado: exaustivo sobre status × fetchStatus × dado; no react-query v5 um refetch sem dado volta a `pending` (erro zerado), então erro + fetching sem dado não ocorre; com dado, o aviso fica durante o retry.
4. **Chave compartilhada** — descartado: `fetchQuery` (cupom, mensagem) não tenta de novo por padrão e o `useQuery` do painel tenta 2 vezes; um prefetch que falhou deixa a query em erro e o painel, ao montar, refaz; o catch do cupom só converte a falha assinada pelo `fetchAllPages`.
5. **"Como hoje"** — descartado: marcação idêntica nos cenários sem quebra (testes permanentes) e antes × depois byte a byte em 8 cenários.
6. **Linha com zero sem sufixo e texto do aviso** — decisão de produto sinalizada ao founder; o aviso da plataforma fala do desconto dos itens, e itens e totais continuam os de hoje.

**REVISÃO INDEPENDENTE PENDENTE** — rodar o Codex retroativo quando a cota voltar, com as mesmas 6 perguntas.

## O que ficou aberto

- A revisão independente acima.
- Os 5 pedidos de produção com cabeçalho bruto (herdado do #2469): o painel deles mostra a tela de hoje até o deploy + reprocess.

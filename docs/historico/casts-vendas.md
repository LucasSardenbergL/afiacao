# Casts que desligam o tipo — módulo vendas (plano v2 · item 4 / I1 · PR 7)

2026-10-20. Sétimo PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md), depois de [casts-plataforma.md](casts-plataforma.md). Escopo: os arquivos não-teste do módulo ativo `vendas` (manifesto). Eram 48 ocorrências textuais de `as never`/`as unknown as`, das quais 46 em código. Restam só comentários.

## O que os casts escondiam

Conferido na PROD via `psql-ro` (`pg_get_function_arguments`, `pg_get_functiondef`, `pg_class`, distribuição de chaves e tipos do jsonb) antes de corrigir.

- **4 KPIs de `/vendas/ferramentas` contavam tabelas que NÃO EXISTEM na prod.** `sales_quotes`, `farmer_bundles`, `farmer_bundle_rules` e `sales_print_jobs` eram consultadas por um cliente `as unknown as { from: (t: string) => any }`, e o `safeQuery` engolia o erro e mostrava **0 para sempre**. É a classe M-06 (tela sobre objeto inexistente). O gate `objeto-existe` só conhecia `sales_print_jobs` (o único `.from()` literal); as outras três passavam por variável (`countOf(table)`) e eram invisíveis a ele. Saíram das baselines `objeto-existe` e `hoje-utc`, e a contagem de orçamentos entrou no registro do universo de pedidos como leitura de propósito. "Orçamentos Salvos" agora conta a mesma fonte da aba Orçamentos (`sales_orders` com `status = 'orcamento'`). Os outros três mostram "—" (ausente ≠ zero) até alguém decidir o que medem. **Decisão de produto pendente.**
- **Os comentários "não está nos tipos gerados" eram falsos de novo.** `registrar_exibicao_regua`, `registrar_aplicacao_regua`, `fin_regua_condicao_prazo`, `get_preco_cockpit`, `get_regua_preco`, `get_regua_preco_customer360`, `staff_get_sales_order_payload`, `farmer_recomendacoes_substituir` e a view `order_feed` estavam todos no `types.ts`.
- **As RPCs da régua e do cockpit devolvem `jsonb` (`Json`), e o tipo de chegada era só afirmado.** Duas bordas novas leem por forma, contra o `jsonb_build_object` de prod:
  - `src/lib/regua-preco/borda-rpc.ts` lê o pacote de 8 chaves e o 360. No 360, o descritor que a função OMITE por `hide_reason` vira `null`, e sem pacote os campos da régua ficam ausentes (o `Partial`).
  - `linhasCockpitDoJson`, em `usePrecoCockpit`, lê as 15 chaves do cockpit.
  - Nas duas, número mascarado sem capability chega NULL e continua NULL, nunca 0. Chave ausente ou tipo trocado lança. O cockpit é informativo e a régua isola por item (`allSettled`), então nenhuma derruba o carrinho.
- **O jsonb `sales_orders.items` era afirmado com tipos diferentes por tela.** Um deles, `QuoteItem.omie_codigo_produto?: string`, a prod desmente: em 72.589 itens o código é sempre NÚMERO. A borda `src/lib/pedido/itens-json.ts` (`itensPedidoDoJson`) lê por forma e lança com a origem (`sales_orders <id> item <i>`). Ela **preserva chaves desconhecidas**, porque a edição regrava o jsonb e descartá-las apagaria dado. Opcional ausente continua ausente: não vira chave com `undefined`. `valor_total` estava tipado obrigatório, mas falta em 72.543 dos 72.589 itens, e virou opcional. O painel de detalhe tem leitura própria (`itemDetalheDoJson`), só dos campos que mostra. Ela mantém o contrato revisado pelo Codex: `items` não-array vira `[]`, para o painel não quebrar.
- **`omie_payload`** (31.929 nulos, 26 objetos, todos com `cabecalho.codigo_parcela` texto) é lido por `omiePayloadDoJson`. O `codigo_cliente` da impressão agora exige número.
- **Impressão:** os pedidos de afiação (`orders`) eram vestidos de `SalesOrderRow` por cast. Por isso `customer_user_id` e `omie_numero_pedido` chegavam `undefined`. O mapeamento agora é explícito (`customer_user_id: user_id`, que é o que os consumidores já liam via `customer_user_id || user_id`).
- **`order_feed`** (view, toda coluna `| null` no gerador; 0 nulos nas colunas-chave em 31.955 linhas) passou a ter borda `feedRowDaLinha`, que exige as colunas-chave (`exigirColunas`) e estreita `origin`.
- **NULL semântico em arg de RPC:**
  - Com DEFAULT NULL (`p_prazo_dias`, `p_preco_referencia`, gaps): `?? undefined`.
  - Sem DEFAULT (`farmer_recomendacoes_substituir.p_geracao_vista`, NULL = nenhuma geração anterior): `comNulo`, do #3257.
- **Paginação:** `fetchAllPages`/`paginateAll` inferem a linha do builder, e os casts de `.range()` eram desnecessários. Os tipos locais mais largos (`number | string`) foram removidos.
- **Catálogo:**
  - `omie_products.estoque` é nullable. `SalesProducts` mostrava "Est: " vazio em vermelho, e agora mostra "—" neutro. `metadata.marca` é lido por forma.
  - O `OmieProduct` da edição deriva de `Tables<>`.

## O que ficou

- Testes novos: `src/lib/regua-preco/__tests__/borda-rpc.test.ts` e `src/lib/pedido/__tests__/itens-json.test.ts`.
- Gate `casts:stale`: baseline `{from: 21, rpc: 26}` → `{from: 20, rpc: 22}`; piso `castsLiterais` **47 → 42** = contagem real.
- Achado registrado e NÃO corrigido (fora do escopo de casts): o cupom lê `order.desconto`, mas o select do `/sales/print` traz `discount`, e a coluna `desconto` não existe. O desconto de cabeçalho do cupom é sempre 0. Desde o #2469 o desconto sai por linha (`order_items.desconto_valor`), então pode ser só código morto. Fica a conferir.
- `useCrossSellEngine` mantém um `order.items as SalesOrderItem[]` estreito, com o histórico de itens para afinidade. Não é `as never`/`as unknown as`, mas é da mesma família. Fica para quando o motor for revisitado.

## Lições

- **Cast em contagem com `catch → 0` é o pior par:** o cast esconde que a tabela não existe e o fallback esconde o erro. O card fica verde, mostrando 0, para sempre.
- **jsonb regravado exige borda que preserva o desconhecido.** Uma borda que só monta os campos tipados apaga dado na próxima edição.

## Decisão posterior: os 3 KPIs sem fonte (2026-10-21)

Delegada pelo founder. A regra é a mesma do card de orçamentos: **cada card conta a fonte da aba que ele resume**, na mesma página.

- **Bundles Ativos:** `farmer_bundle_recommendations` com `status = 'pendente'`, a geração VIGENTE (a substituição marca as anteriores como `expirado`). Na prod: 1 pendente, 12 expirados.
- **Regras de Associação:** `farmer_association_rules`, a tabela global que o motor de bundles usa (18 regras).
- **Impressões Hoje → "Pedidos p/ Imprimir Hoje":** o app não registra impressão (`sales_print_jobs` nunca existiu), então o card não tem como contar impressões. Passa a contar o que a aba Impressão LISTA para hoje: vendas do universo canônico + afiação não cancelada, com a mesma janela (`janelaQueryDiaCivil`) e o mesmo `pedidoNoDiaCivil` do `SalesPrintDashboard`, paginado.

Falha de leitura deixa o card em "—" (a query lança), nunca em 0.


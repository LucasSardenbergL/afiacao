# Casts que desligam o tipo — pedidos programados (plano v2 · item 4 / I1 · PR 1 de 2)

2026-10-18. Primeiro PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md): tirar os casts que cegam o typecheck nos **caminhos ativos**, começando pelo hook `src/hooks/usePedidosProgramados.ts` (módulo `vendas`, ativo). O módulo `tarefas` (congelado) fica de fora por desenho.

## O que havia

- Wrapper `t = (name) => supabase.from(name as never)` — cast sobre **variável**, invisível ao gate `casts:stale` (que só conta literal), mas com o mesmo efeito: coluna, argumento e retorno sem checagem em **todas** as 20 chamadas do arquivo.
- 15 `as never` em payloads de `insert`/`update`/`upsert` e 10 `as unknown as X` de retorno, com interfaces locais que divergiam do `types.ts` (ex.: `omie_products.ativo` é `boolean` no banco, `boolean | null` na interface; `status` de envio tinha 5 valores no banco e 4 no union do calendário).

## O que ficou

- `.from()` **tipado** em todo o arquivo; tipos de linha derivam de `Tables<'…'>`/`TablesUpdate<'…'>`; `ProdutoMapeado` é `Pick<Tables<'omie_products'>, …>`.
- `status` de pedido/envio viaja como `string` (é texto no banco; as telas indexam `Record<string, …>` e comparam por igualdade). O union `StatusEnvio` só é exigido pelo calendário, e lá a borda usa **guarda de tipo** (`ehStatusEnvio`), não cast — status desconhecido vira erro visível do react-query, nunca badge inventado.
- `'processando'` (claim transitório do edge, migration 20260704070000) entrou em `StatusEnvio` e ganhou classe de badge/dot no `CalendarioFaturamento` — antes passava pelo cast e renderizava sem classe.
- `sales_orders_map` (`Json`) é estreitado por forma (`objeto não-array` → `Object.values` filtrando `string`), sem cast.
- `config.account` fora de `oben`/`colacor` não entra (precisão > recall; a tabela tem UNIQUE(account) e 2 linhas).

## Lições

- **Select concatenado com `+` desliga a inferência** do supabase-js: o tipo cai em `GenericStringError` e todo acesso a coluna vira erro. O literal tem que ser **um só** (string longa numa linha).
- **Cast sobre variável não aparece no gate** — a contagem do `casts:stale` não muda neste PR. A baseline/piso descem no PR 2 (reposição), que remove casts literais.
- O typecheck, ao voltar a ver as colunas, não apontou coluna inexistente aqui — o custo real era a **divergência silenciosa** entre interface local e banco, que só o `Tables<>` elimina.

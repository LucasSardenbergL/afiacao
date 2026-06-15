# Cobertura de CMC no catálogo — sync de inventário com `cExibeTodos` — Design

> Spec de design. Data: 2026-06-06. Substrato: `supabase/functions/omie-analytics-sync` (`syncInventory`) → `inventory_position` → base de custo (CMC) da Reposição.
> Money-path (afeta o EOQ de toda a Reposição). Codex fora → validação rigorosa + Codex adversarial retroativo quando voltar.
>
> ⚠️ **ATUALIZAÇÃO (pós-merge):** o [#843](https://github.com/LucasSardenbergL/afiacao/pull/843) refatorou o `syncInventory` de N+1 para **bulk** enquanto este spec era escrito. O fix foi então implementado **parametrizando o `syncInventory` com `{exibeTodos}`** (reusa toda a lógica bulk + `product_costs`/`omie_products` + a semântica de ambiguidade de `product_id`) em vez de uma rotina nova duplicada `syncInventoryFull`. A premissa "o `syncInventory` é N+1" abaixo está **stale**; o cerne (`cExibeTodos:"S"` para cobrir o catálogo) permanece igual.

## 1. Problema (causa-raiz confirmada)

O `syncInventory` chama o Omie `ListarPosEstoque` **sem `cExibeTodos: "S"`** (`omie-analytics-sync/index.ts:705-709`). Sem esse parâmetro, o Omie devolve **apenas produtos com saldo no momento**. Resultado, medido em produção:

- `inventory_position` tem **~738 linhas** (conta `vendas`/OBEN), das quais **só 1 com saldo 0** — ou seja, a tabela é basicamente "o que tinha saldo no último sync".
- O catálogo OBEN tem **milhares** de produtos (~3,6 mil). Logo **a maior parte do catálogo não tem CMC** em `inventory_position`.
- Itens de **alto giro** zeram o estoque frequentemente (giram rápido, ficam zerados esperando reposição) → caem fora justamente os que mais importam (ex.: VERNIZ FO20.6717 / `8689783623`, R$10.775/180d, saldo 0).

**Impacto:** desde o #666, a Reposição usa o CMC como base de custo do EOQ (`v_sku_parametros_sugeridos.preco_item_eoq`). Com ~80% do catálogo sem CMC, esses itens caem no fallback `preco_venda × 0,55` (grosseiro) → **estoque máximo / ponto de pedido dimensionados com custo impreciso em quase todo o catálogo**. (E também deixa a Negociação Paralela v2 marcando esses itens como "custo a confirmar".)

## 2. Evidência

- `inventory_position` (vendas): total 738, saldo≤0 = **1**, e essa 1 tem **cmc > 0** → indício (n=1) de que o **CMC persiste com saldo 0** (consistente com ser custo médio contábil). **Gate de validação** definitivo na §6.
- Os 8 SKUs de alto giro investigados: 0 linhas em `inventory_position` (nenhuma conta) + `estoque_fisico = 0` em `sku_estoque_atual` (7/8; o 8º com sync stale de abril).
- Contraste: o `omie-sync-estoque` já usa `cExibeTodos: "S"` (`:220`) e cobre todos os habilitados — mas grava só saldo em `sku_estoque_atual`, **não o CMC**.

## 3. Objetivo

Popular `inventory_position` (e o `cmc`) para **o catálogo inteiro** — inclusive itens com saldo 0 — sem tornar pesado o sync de saldo de 30 min e sem estourar o budget/rate-limit do Omie.

## 4. Abordagem (caminho A, sub-decisão A2: separar saldo de CMC)

**Rotina nova dedicada `syncInventoryFull(db, account)`** no `omie-analytics-sync`, **diária**, com:

1. **`cExibeTodos: "S"`** no `ListarPosEstoque` → traz o catálogo inteiro (saldo 0 + CMC).
2. **Bulk (elimina o N+1 atual)**: o `syncInventory` faz hoje ~4-5 queries POR produto (select `omie_products` + upsert `inventory_position` + update `omie_products` + select/upsert `product_costs`). Em vez disso:
   - 1 leitura em massa de `omie_products` (account) → `Map<omie_codigo_produto, {id}>` (paginado via `.range` p/ furar o cap de 1000).
   - 1 leitura em massa de `product_costs` existentes → `Map<product_id, {id}>`.
   - Acumular as linhas em memória durante a paginação do Omie e fazer **upserts em lote** (chunks ~500) em `inventory_position` (`onConflict: omie_codigo_produto,account`) e `product_costs`.
3. **Background** (`EdgeRuntime.waitUntil`, já usado neste edge): responde 202 e processa em background — escapa do budget síncrono (padrão provado do `syncCustomers`, #438).
4. **Retry/backoff em `callOmie`** para o `ListarPosEstoque` (a API do Omie flaka — "SOAP broken response", lição #439).
5. **Paginação robusta**: parar na página vazia / respeitar `nTotPaginas`, sem o bug `totalPaginas=1` com `start_page>1` (lição #519 — aqui começa em 1, ok).
6. **Guard de concorrência**: como roda em background, não deixar dois runs simultâneos (lock leve via `sync_state` "running" + idade).

**Sync de 30 min (`sync_inventory`) fica INALTERADO** (saldo dos com-saldo, leve, estoque fresco). O CMC muda devagar → diário basta. Cron novo `sync-inventory-full-{conta}-daily`.

### Alternativas consideradas (rejeitadas)
- **A1 — adicionar `cExibeTodos:"S"` ao sync de 30 min existente.** Mais simples, mas processaria o catálogo inteiro a cada 30 min (48×/dia) → carga/rate-limit no Omie e re-gravação de CMC que não mudou. Desperdício.
- **A3 — fazer o `omie-sync-estoque` (que já pega todos) gravar o CMC.** Reusaria a varredura, mas ele agrega por local (CMC é por produto) e não está claro que o response dele traz `nCMC`; mexer no caminho de saldo é mais arriscado.

## 5. Escopo

- **Conta `vendas` (OBEN) primeiro** — é onde está o problema (Sayerlack) e onde validamos. `syncInventoryFull` é genérico por `account`; estender para `colacor_vendas`/`servicos` depois (cada conta = um cron diário próprio), medindo o volume.
- Não mexer na convenção `account` de `inventory_position` (vendas/oben coexistem; este fix grava a canônica `vendas` via analytics-sync).

## 6. Gate de validação (1º passo do plano, antes de refatorar)

Confirmar que o Omie retorna o **`nCMC` para item com saldo 0** — senão `cExibeTodos:"S"` traria os itens sem custo e o fix não resolveria. Duas formas:
- **Definitiva:** abrir o VERNIZ FO20.6717 (`8689783623`) no Omie e ver o **Custo Médio** preenchido.
- **No primeiro run real (probe):** após implementar, rodar `syncInventoryFull` para `vendas` e verificar se os 8 SKUs de alto giro passaram a ter `cmc > 0` em `inventory_position`. Se vierem com `cmc = 0`, **reverter** e reabrir o design (fonte alternativa de custo).

## 7. Degradação honesta / riscos

- **Volume**: ~738 → ~3,6 mil itens (5×). Mitigado por bulk (poucas queries) + background. **Medir** o nº de páginas/tempo no primeiro run.
- **Rate-limit Omie**: diário (não 30 min) + retry/backoff. Uma conta por vez.
- **`nCMC = 0`** em parte do catálogo (item nunca comprado / sem custo): grava saldo, deixa `cmc=0` → a view já trata `cmc>0` para `fonte='cmc'` (cai no fallback, honesto). Não fabricar custo.
- **`product_costs`**: manter o comportamento atual (só grava/atualiza quando `cmc>0`).

## 8. Não-objetivos (YAGNI)

- Não mexer no sync de saldo de 30 min (continua leve).
- Não refatorar o `omie-sync-estoque`.
- Não unificar as convenções `account` de `inventory_position`.
- Não cobrir colacor/servicos nesta primeira entrega (estender depois).

## 9. A confirmar na revisão

- Frequência do `syncInventoryFull`: diário (proposto) — ok?
- Estender já para as 3 contas, ou só `vendas` (OBEN) primeiro?

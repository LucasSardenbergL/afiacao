# Plano — Cor da tinta no detalhe do pedido + reforma de identidade do sync de vendas

> Status: **aguardando aprovação do founder**. Money-path (sync de pedidos de venda). Investigação + design (Codex) concluídos.

## Problema
A cor da tinta (`tint_nome_cor`) não aparece no detalhe do pedido de venda. O display (PR #676) está correto; o **dado** não está no jsonb `sales_orders.items`.

## Root cause (confirmado em prod)
- Na venda, a cor é gravada no jsonb local **e** no Omie como observação do item (`obs_item`/`dados_adicionais_item` = `"Cor: 1247 - AZUL RAL 5010 - QT"`).
- O sync de entrada (`omie-vendas-sync` → `sync_pedidos`, `ListarPedidos`, index.ts:1089-1101) remonta os itens com só `produto` e **descarta** `det.observacao`/`det.inf_adic` → jsonb sem a cor.
- O submit **não grava `hash_payload`**; o sync filtra por `hash = omie_{account}_{codigoPedido}` e não reconhece o pedido do wizard → cria um **registro paralelo seco**.

## Estado medido (prod, 2026-06-09)
- 2.603 registros / **2.431 pedidos distintos** por `(account, omie_pedido_id)`.
- **172 duplicados** (7%): par wizard (status local + cor) × sync (status Omie, sem cor).
- **0 registros sem `omie_pedido_id`** → chave canônica cobre 100%.
- Só **7** pedidos têm cor hoje (registros do wizard sobreviventes).
- FK → `sales_orders`: `order_items` **CASCADE**; `picking_tasks`/`farmer_calls`/`recommendation_log` **RESTRICT**; `production_orders`/`sales_price_history` **SET NULL**.

## Gate de viabilidade (Fase 0 — antes de codar)
**Probe no Omie** (read-only): confirmar que `ListarPedidos`/`ConsultarPedido` devolve `det.observacao.obs_item`/`det.inf_adic.dados_adicionais_item` com `"Cor: ..."` num pedido tintométrico tingido. A doc oficial do Omie (Codex) diz que sim; o probe elimina a incerteza antes do deploy. Se NÃO vier no list → cair pra `ConsultarPedido` por pedido (job rate-limited) no backfill.

## Fases (ordem de valor → risco crescente)

### Fase 1 — Cor no pipeline (BAIXO risco, valor pra frente)
- Helper puro TDD `parseCorObs(obs)` → extrai `{ tint_cor_id?, tint_nome_cor }` de `"Cor: X - Y - emb"` (parsing **conservador**: remove sufixo de embalagem conhecido primeiro; não quebra nome com hífen; guarda bruto).
- `sync_pedidos` (entrada) lê `det.observacao?.obs_item ?? det.inf_adic?.dados_adicionais_item`; se `"Cor: "`, popula `tint_nome_cor`/`tint_cor_id` no `itemsJson`. **Defensivo**: sem obs → comportamento atual (zero regressão).
- Estender `OrderItemPayload` com os campos tint.
- Drawer (`SalesOrderDetailSheet`): mostrar `{cor_id ? cor_id+' - ' : ''}{nome}` (não quebra com cor_id vazio).
- Deploy edge (Lovable) + Publish frontend.
- **Resultado:** pedidos novos/re-sincronizados passam a mostrar a cor. (Antigos: Fase 2.)

### Fase 2 — Backfill da cor nos existentes (MÉDIO risco, NÃO destrutivo)
- Action nova `backfill_tint_cor` (checkpointed + rate-limited): por pedido (com base tintométrica, sem cor), busca a obs no Omie e dá **UPDATE no jsonb** `items` por `omie_pedido_id` (sem mexer no hash, sem deletar nada).
- **Resultado:** os pedidos antigos com cor no Omie passam a mostrar. **Aqui o founder vê a cor em massa.**

### Fase 3 — Identidade canônica / upsert (MÉDIO risco)
- `sync_pedidos` passa a **upsert/merge por `(account, omie_pedido_id)`** em vez de skip-by-hash: encontra o existente, faz UPDATE (status/valores/cor), **preserva a cor local** quando o Omie não devolver.
- `hash_payload` deixa de ser identidade.
- Centralizar **um** mapa de status (resolver o conflito `sync_pedidos` 50=separacao × `sync-reprocess` 50=faturado).
- **Resultado:** o sync **para de criar novas duplicatas**.

### Fase 4 — Dedup dos 172 + unicidade (ALTO risco, DESTRUTIVO — por último, com validação)
- Migration de reparo: por par, escolher o canônico (merge: status mais avançado do sync + cor do wizard), **migrar referências** (`order_items`/`picking_tasks`/`farmer_calls`/`recommendation_log`/`production_orders`/`sales_price_history`) pro canônico, deletar o outro.
- Índice único parcial `(account, omie_pedido_id)`.
- **Dry-run + contagens antes/depois + backup**. Codex no design desta migration.

## Riscos transversais (Codex) — endereçar no caminho
- **OC elimina a cor no Omie**: `if (ordemCompra) ... else if (cor)` (index.ts:1364, 1819) são mutuamente exclusivos → pedido com ordem de compra **não** grava a cor no Omie. Gravar `numero_pedido_compra` **e** `Cor:` juntos (Fase 1 ou nota).
- **Idempotência**: `codigo_pedido_integracao` usa `Date.now()` → retry pode duplicar no Omie. Derivar do `salesOrderId` (separado).
- **Update local pós-Omie ignora erro**: Omie cria mas Supabase falha → órfão. Reconciliar (separado).

## Decisões em aberto (resolver com diagnóstico na hora)
- Fase 4: qual registro do par é o canônico (o que tem mais referências?) — medir antes.
- Fase 2 vs 3: se a Fase 3 (upsert) já recupera a cor num re-sync controlado, a Fase 2 pode virar parte dela. Decidir após a Fase 1.

## Não-objetivos
- Reescrever todo o sync. Tabela lateral de cor (opção C) descartada (chave colide com SKU repetido; mais infra).

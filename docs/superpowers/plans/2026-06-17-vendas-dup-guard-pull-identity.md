# Conserto da duplicata de pedidos Omie — guard de identidade do PULL

> **Origem:** Codex challenge 2026-06-17 (sub-projeto do cursor+lease de vendas, spec `2026-06-17-vendas-omie-cursor-lease-design.md`). Money-path: `sales_orders` → positivação/OTE/comissão (erro de 1 mês ≈ R$80k).
> **Estado:** diagnóstico fechado · design validado por `/codex consult` · guard provado em PG17 (`db/test-sales-orders-pull-identity-guard.sh`, verde + falsificado). Implementação do edge + limpeza = **sessão(ões) fresca(s)** com deploy manual e gate humano.

## 1. Diagnóstico (evidência psql-ro, prod, 2026-06-17)

Raiz única: `sales_orders.hash_payload` era usado como chave de dedup do PULL, mas é **mutável, nullable e multi-writer** (anti-padrão money-path). Duas causas de duplicata brotam disso:

- **Causa A — reprocess de-namespaceia.** `sync-reprocess/index.ts` L215/L251-257 faz `UPDATE ... hash_payload = hashObject({cab,itens})` (estrutural) ao detectar mudança → o Set de dedup do `sync_pedidos` (pré-carregado de `hash_payload`) não acha mais `omie_<account>_<cod>` → re-insere. **508 grupos oben** (+2 triplas).
- **Causa B — linhas hash-NULL invisíveis.** `omie-vendas-sync/index.ts` L943-961 pré-carrega o Set filtrando `hash_payload NOT NULL` → linhas pull legadas com hash NULL (formato `numero_pedido` zero-padded antigo) são invisíveis → re-inseridas a cada sync. **16 grupos oben + 6 colacor.**

Satura em 2 cópias porque o `.maybeSingle()` do reprocess (L227-232, casa por `omie_numero_pedido`) **quebra silenciosamente** em 2 linhas (erro ignorado) → para de reprocessar aquele pedido.

**Magnitude (por `(account, omie_pedido_id)` entre linhas PULL, `checkout_id IS NULL`):**
- oben: 524 grupos de 2 + 2 de 3 = **528 linhas excedentes**.
- colacor: **6 grupos de 2** (só Causa B — corrige o brief: colacor NÃO é totalmente limpo).
- 1 par push+pull legítimo (`omie_pedido_id=12103042337`): preservar.

**Discriminante durável push vs pull = `checkout_id`** (pull sempre NULL; push sempre NOT NULL — `idempotency.ts` insere com checkout_id, o pull não). O hash NÃO serve (mutável).

**Bug acoplado (FASE 2, NÃO corrigir agora):** mapa etapa→status divergente entre os edges (pull: etapa 60→`faturado`; reprocess: 60→`cancelado`). 504/510 pares divergem em status. A linha estrut (reprocessada) costuma virar `cancelado` e a omie_ `faturado` → **mascara por acidente** parte da inflação de receita (a cancelada é filtrada por `get_minha_positivacao`).

**Read-path inflado HOJE:** `get_minha_positivacao` (`20260525120000`) e `viewas_rpcs_for` somam `total` por LINHA; `melhorias_canal` conta `distinct sales_order_id`. Duplicata infla receita/contagem (modulado pelo filtro de status).

## 2. Design (validado por `/codex consult`, sessão 019ed7ef)

Parar de usar `hash_payload` como identidade. Usar `omie_pedido_id` (= `codigo_pedido` do Omie: estável, sempre setado no pull, nunca tocado pelo reprocess). Mata as DUAS causas (preservar `omie_` sozinho não pegaria a Causa B). Defense-in-depth:

1. **Guard de fronteira (DB) — PRONTO E PROVADO.** `uniq_sales_orders_pull_identity` = `UNIQUE (account, omie_pedido_id) WHERE checkout_id IS NULL AND omie_pedido_id IS NOT NULL`. Migration `20260617140000_sales_orders_pull_identity_guard.sql`. Barra 2 linhas pull/pedido; preserva push/pull (push excluído pelo predicado); sobrevive ao reprocess; contraparte do `sales_orders_checkout_account_uq`.
2. **Edge pull — sessão fresca.** Dedup por `omie_pedido_id` + backstop `23505`.
3. **Edge reprocess — sessão fresca.** Parar de corromper `hash_payload` + casar por `omie_pedido_id`.
4. **Limpeza — sessão dedicada, gate humano.** Manter `omie_`, quarentena, re-vínculo das FKs NO ACTION, merge de itens, deletar.

## 3. O que JÁ está pronto nesta sessão (read-only/local, nada aplicado em prod)

- `supabase/migrations/20260617140000_sales_orders_pull_identity_guard.sql` — o índice, com cabeçalho de pré-requisitos. **NÃO aplicar até a ordem do §5.**
- `db/test-sales-orders-pull-identity-guard.sh` — prova PG17: 10 asserts (P1-P5, N1a/N1b, N2) + falsificação (F1 predicado, F2 índice) + prova da ordem (CREATE falha com dups). Verde; meta-falsificação (furar o arquivo → vermelho) confirmou Lei #1.

## 4. Handoff — mudanças no edge (sessão fresca, deploy MANUAL verbatim da main)

**`supabase/functions/omie-vendas-sync/index.ts` (`sync_pedidos`):**
- L943-961: trocar `existingHashes` (Set de `hash_payload`) por `existingPullIds` (Set de `omie_pedido_id`), carregando `WHERE account=X AND checkout_id IS NULL AND omie_pedido_id IS NOT NULL`. **Remover** o filtro `.not('hash_payload','is',null)`.
- L1137-1141: dedup por `existingPullIds.has(codigoPedido)` (não `existingHashes.has(hashPayload)`). Manter o `hash_payload` no insert (compat de leitura), mas ele deixa de ser identidade.
- L1216-1253: tratar `23505` no batch/fallback como "já existe" (skip), não erro ruidoso — o índice novo pode disparar em corrida (risco que o Codex levantou).

**`supabase/functions/sync-reprocess/index.ts` (`reprocessOrders`):**
- L227-232: casar por `omie_pedido_id` (= `cab.codigo_pedido`) `+ account + checkout_id IS NULL`, não `omie_numero_pedido`. Com o índice, `.maybeSingle()` volta a ser seguro pós-limpeza.
- L251-257 e L283/L300: **parar de escrever `hash_payload`**; usar coluna dedicada `reprocess_content_hash` (sales_orders e order_items). Comparação de change-detection (L236/L283) passa a ler dessa coluna.
- **Status (fase 2):** o reprocess NÃO deve atualizar `status` enquanto o mapa etapa→status divergir (Codex). Interino: não tocar status (só `total`/itens/content_hash), ou corrigir o mapa numa única função canônica.

**Migration adicional (pré-requisito do reprocess consertado):** `ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS reprocess_content_hash text;` (idem `order_items` se mover o hash de item). Provar com prove-sql se acoplar lógica.

## 5. Ordem de operação (gate humano em cada escrita; money-path)

1. **Edges consertados + deploy manual** (pull dedup + reprocess sem corrupção). Sem isso, limpar agora → o pull re-duplica.
2. **Coluna `reprocess_content_hash`** (SQL Editor) antes do reprocess consertado rodar.
3. **Limpeza das duplicatas** (§6) — gate humano, idealmente RPC provada.
4. **Criar o índice** `20260617140000` (SQL Editor) — só após a limpeza (senão CREATE falha; fail-safe). `CREATE UNIQUE INDEX CONCURRENTLY` se rodar fora de transação; senão janela curta com crons de sync pausados.
5. Validar (query no rodapé da migration: `idx_1=1`, `dups_pull_restantes=0`).

## 6. Plano de limpeza (528 oben + 6 colacor) — sessão dedicada

Para cada grupo `(account, omie_pedido_id)` com >1 linha PULL (`checkout_id IS NULL`):
- **Canônica a manter:** a linha `hash_payload LIKE 'omie_%'` (a mais recente, se houver >1).
- **Antes de deletar as não-canônicas:**
  1. **Quarentena:** copiar linhas + `order_items` para tabelas de quarentena (auditoria/reversão).
  2. **Re-vínculo das FKs NO ACTION** (senão o DELETE dá 23503): `farmer_calls.linked_sales_order_id`, `picking_tasks.sales_order_id`, `recommendation_log.sales_order_id` → apontar para a canônica. (Re-vincular farmer_call é money-path: preserva o contato da positivação.)
  3. **`sales_price_history`** (SET NULL, 2079 filhos): re-vincular para a canônica para preservar o histórico de preço (senão vira NULL).
  4. **Merge de itens** (Codex: não descartar item real): inserir na canônica os `order_items` da não-canônica que faltam, casados por `omie_codigo_produto`. As linhas estrut têm mais itens (1084 vs 988).
  5. **Status:** manter o da canônica (pull); **NÃO** copiar o da estrut (contaminado). Mapa correto = fase 2.
- **Deletar** as não-canônicas (CASCADE leva os `order_items` remanescentes).

**Preflight de FK (todas as refs a sales_orders):** order_items=CASCADE; production_orders/sales_price_history=SET NULL; farmer_calls/picking_tasks/recommendation_log=**NO ACTION**.

## 7. Gates humanos / pendências
- Toda escrita em prod = founder cola no SQL Editor / deploy de edge pelo chat do Lovable.
- **Fase 2:** mapa etapa→status canônico (decidir qual edge está certo — provável que o reprocess marque etapa 60 errado); reconciliação por re-fetch do Omie.
- Revisão independente: `/codex consult` feito (validou o guard). A limpeza (quando virar RPC) pede `/codex challenge` + prove-sql próprios.

# Spec — Identidade Omie por conta, derivada/provada no servidor (P0-B)

> Money-path. Fecha os 4 resíduos do P0-A (PR #1194) + destrava a conversão de orçamento OBEN.
> Segue `docs/agent/money-path.md` (precisão>recall; fail-closed; guard na fronteira; prove-sql; Codex).
> **Base:** empilha sobre o P0-A depois que a **PR #1194 mergear na `main`** e este worktree rebasar.

## 1. Problema

Cada uma das 3 contas Omie (`oben`, `colacor`, `colacor_sc`) tem um **espaço de código de cliente próprio e independente**: o mesmo cliente real tem `codigo_cliente` (bigint) e `codigo_vendedor` DIFERENTES em cada conta, e os códigos podem **colidir numericamente** entre contas. Um PV (pedido de venda) criado na conta X com um `codigo_cliente` da conta Y cai no **cliente errado** — dinheiro cobrado na conta/cliente errado.

O P0-A (PR #1194, **aberta**, mergeia primeiro) adicionou um guard de **prova negativa** (`codeBelongsToWrongAccount`) no edge `omie-vendas-sync` + preflight na UI. Restam 4 resíduos, todos a mesma raiz — **falta de identidade Omie por conta, derivada/provada no servidor**:

1. **[P1]** O guard só prova NEGATIVO (código comprovadamente de outra conta), usando só as linhas de `omie_clientes` do `customer_user_id` do pedido. Um código de OUTRO user passa (não está nessas linhas). Falta **prova positiva** do código certo na conta alvo.
2. **[P1]** `useCustomerSelection.ts:207/:243` mapeiam `local_user_id` por `omie_codigo_cliente` **sem** `empresa_omie` → colisão anexa o `customer_user_id` errado.
3. **[P2]** `analyze-unified-order:262/:301` devolvem `codigo_cliente` de `omie_clientes` sem `empresa_omie`; `handleAICustomerSelect` confia no código antes do fallback filtrado.
4. **[P2]** O helper compara códigos com `Number()`; códigos Omie são bigint.

**Conversão OBEN bloqueada:** `submitQuote` grava `customer_user_id + account` mas **descarta** o código por-conta; `SalesQuotes.convertToOrder` recupera do espelho `omie_clientes` (**0 linhas oben** — espelho parcial: 6909 colacor, 0 oben/colacor_sc) → fail-closed → **toda conversão oben é bloqueada hoje**.

## 2. Fato de domínio (espelho parcial) e a fronteira

- `omie_clientes` (espelho): `(user_id, omie_codigo_cliente bigint, omie_codigo_vendedor bigint, empresa_omie)`. UNIQUE `(user_id, empresa_omie)` e `(omie_codigo_cliente, empresa_omie)`. **Prod hoje: 6909 colacor, 0 oben, 0 colacor_sc.** Códigos oben/colacor_sc vivem só na API Omie, não no espelho.
- `sales_orders`: tem `customer_user_id`, `account`, `omie_pedido_id`, `omie_payload`. **Não** guarda código por-conta.
- **Fronteira comum:** o edge `criar_pedido` (`omie-vendas-sync/index.ts:2184`) recebe `{sales_order_id, codigo_cliente, codigo_vendedor, account, items}` e **já lê a linha `sales_orders`** como âncora (rejeita se `account` do payload diverge do pedido). `criarPedidoVenda` (:1563) põe `codigo_cliente` no header Omie. `buscarClienteVendas(document, account, {throwOnTransient})` (:596) **já resolve** código+vendedor por documento na conta (1º match; `null`=ausência confirmada; lança em transitório).

## 3. Achado do Codex que reancora o design

Derivar de `customer_user_id` é inseguro: `submitQuote.ts:58` / `submitOrder` fazem `customer_user_id: customerUserId || user.id`. Quando o staff não resolve um user local, **`customer_user_id` vira o VENDEDOR**. Hoje o PV ainda vai ao cliente certo (usa o código que o cliente resolveu). Se o edge derivar de `customer_user_id` = vendedor, o override rotearia o PV pro **cliente-Omie do vendedor** — **regressão pior que o bug atual**.

> **Correção:** a âncora é o **documento** (CNPJ/CPF), não `customer_user_id`.

## 4. Design

### 4.1 Âncora = documento persistido
- **Migration:** `ALTER TABLE sales_orders ADD COLUMN customer_document text;` (nullable).
- `submitOrder`/`submitQuote` gravam `customer_document = customer.cnpj_cpf` (o documento do cliente **real**, capturado na seleção — imune ao fallback-vendedor).
- Pedidos legados (pré-migration) têm `customer_document` NULL → derivação cai no fallback `profiles.document(customer_user_id)` e o guard de divergência (4.3) protege.

### 4.2 Derivação na fronteira (`criar_pedido`, após a checagem de âncora existente)
Estende o `select` da linha para trazer `customer_user_id, account, customer_document`. Deriva `(codigo_cliente, codigo_vendedor)` **autoritativos** para `(documento, account)`:

```
doc = row.customer_document ?? profiles.document(row.customer_user_id)   // sem doc → FAIL-CLOSED
users = profiles WHERE document = doc                                    // usuários com esse documento

(a) ESPELHO:  omie_clientes WHERE user_id IN users AND empresa_omie = account
      • exatamente 1 código → usa (rápido; hoje só acerta colacor)
      • >1 código distinto  → ambíguo → tenta (b), senão FAIL-CLOSED
      • 0                    → (b)
(b) OMIE:     buscarClienteVendas(doc, account, {registros_por_pagina:2, throwOnTransient:true})
      • exatamente 1 match  → usa; BACKFILL (4.4)
      • >1 match            → duplicata-CNPJ → FAIL-CLOSED (não chuta)
      • 0 (ausência conf.)  → FAIL-CLOSED
      • transitório         → LANÇA (fail-closed por exceção; reenvio resolve)
```

Usa o derivado em `gateCredito` + `criarPedidoVenda`. **Guard bigint:** se o código derivado não for `Number.isSafeInteger` → FAIL-CLOSED.

### 4.3 Divergência = FAIL-CLOSED (não override)
Se o `codigo_cliente` que o cliente mandou existir e `!= derivado` → **bloqueia** o PV + log durável. (Veredito Codex: override manda PV errado se o espelho foi envenenado ou a duplicata-CNPJ divergir; a divergência é sinal de contradição, não ruído.) Isso substitui o guard de prova-negativa do P0-A por **prova positiva** e torna o `codeBelongsToWrongAccount` redundante nesta via (mantido só como comparação bigint-safe do log de divergência).

### 4.4 Backfill do espelho (auto-cura, gated)
Via **RPC `SECURITY DEFINER`** (invariante atômica, prove-sql-testável). Só roda quando a derivação (b) foi **inequívoca** E há `user_id` confiável (o `user_id` cujo `profiles.document = doc`; se `customer_user_id != esse user_id`, usa o correto — nunca chaveia no vendedor).

Invariante da RPC `omie_cliente_upsert_mapping(p_user_id, p_empresa, p_codigo, p_vendedor)`:
- sem linha `(user_id, empresa)` → INSERT → `'inserted'`;
- linha existe com **mesmo** código → no-op → `'noop'`;
- linha existe com código **diferente** → `'contested'` (NÃO overwrite);
- `(codigo, empresa)` já é de **outro** user → `'contested'`.
- `'contested'` → o edge **FAIL-CLOSA o PV** (identidade contestada; founder reconcilia).

### 4.5 `alterar_pedido` — verificar antes de editar (princípio 5, toda via)
A edição não injeta código (usa o cliente do PV via `ConsultarPedido`), mas pode mutar um PV historicamente mal-atribuído. Antes da fase destrutiva: derivar a identidade esperada de `(documento, account)` e comparar com `omieCodigoClienteEdit` (do `ConsultarPedido`). Divergência → FAIL-CLOSED.

### 4.6 Conversão OBEN destravada
`convertToOrder` **para** de ler o espelho e de mandar código: envia só `sales_order_id + account + items`; o edge deriva. Requer tornar `codigo_cliente` **opcional** no dispatcher (:2186). Remove o fail-closed por-espelho (a raiz do bloqueio oben).

### 4.7 Vias-cliente (itens 2/3/4) — defense-in-depth + correção de UI
Com o edge autoritativo, deixam de ser a proteção, mas conserto pra não poluir âncora/display:
- `useCustomerSelection` (:207/:243): filtro `empresa_omie` (*fail-safe*: 0 linhas oben → não mapeia, cai no match por documento);
- `analyze-unified-order` (:262/:301): **omitir o `codigo_cliente` cross-conta** (o edge deriva; o código é só display) — não devolver um código colacor rotulado como genérico;
- `handleAICustomerSelect`: **re-resolver por documento/conta**, não confiar no código recebido da IA;
- helper do P0-A: comparação **bigint-safe** (string decimal canônica ou rejeitar `!Number.isSafeInteger`).

## 5. Threat model (engine de decisão — money-path.md)

| Cenário | Prova | Ação | Default |
|---|---|---|---|
| Espelho tem 1 código p/ (doc, conta) | positiva (curado) | usa | — |
| Espelho vazio, Omie 1 match | positiva (Omie by doc) | usa + backfill | — |
| Omie >1 match (duplicata-CNPJ) | ambígua | **FAIL-CLOSED** | reject |
| Omie 0 match (ausência confirmada) | negativa | **FAIL-CLOSED** | reject |
| Omie transitório | indeterminada | **LANÇA** (fail-closed) | reject |
| Sem documento (legado + customer_user_id não confiável) | ausente | **FAIL-CLOSED** | reject |
| `supplied != derived` | contradição | **FAIL-CLOSED** | reject |
| Backfill contested (código diverge/roubado) | contestada | **FAIL-CLOSED** | reject |
| Código não `SafeInteger` | inválida | **FAIL-CLOSED** | reject |

**Cada default → um assert** no prove-sql (RPC) e no teste da decisão de derivação (edge). Doc×código não podem divergir.

## 6. Arquivos tocados

- **Migration (nova):** coluna `sales_orders.customer_document` + RPC `omie_cliente_upsert_mapping`. → `lovable-db-operator` + `prove-sql-money-path`.
- `supabase/functions/omie-vendas-sync/index.ts`: derivação em `criar_pedido`; `codigo_cliente` opcional; guard em `alterar_pedido`; backfill via RPC; guard bigint. (Deploy manual — `lovable-deploy-verify`.)
- `src/services/orderSubmission/submitQuote.ts` + `submitOrder.ts`: persistir `customer_document`.
- `src/pages/SalesQuotes.tsx`: `convertToOrder` simplificado (edge deriva).
- `src/hooks/unifiedOrder/useCustomerSelection.ts` (:207/:243), `src/hooks/useUnifiedOrder.ts` (`handleAICustomerSelect`), `supabase/functions/analyze-unified-order/index.ts` (:262/:301): filtro `empresa_omie`.
- `src/lib/omie/account-coherence.ts` (do P0-A): comparação bigint-safe.

## 7. Prova (money-path)

- **prove-sql-money-path** na RPC de backfill: aplica a migration REAL, semeia, asserts positivos E negativos (SQLSTATE + re-raise) para cada linha de 5 (inserted/noop/contested×2), e **falsifica** (sabota → exige vermelho).
- **Decisão de derivação** extraída como função pura testável (`{mirrorRows, profileDoc, omieMatches} → {codigo, vendedor} | fail`) com vitest cobrindo o threat-model; teste de integração do edge para o glue (mirror/Omie/backfill).
- **Codex adversarial (`/codex challenge --xhigh`)** no diff final (money-path).
- **`lovable-deploy-verify`** (edge + migration são deploys manuais do Lovable).

## 8. Escopo e follow-up

- **Neste PR (só money-path):** as vias que criam PV / convertem / anexam âncora (edge `criar_pedido`+`alterar_pedido`, `convertToOrder`, `submit*`, `useCustomerSelection`, `handleAICustomerSelect`, `analyze-unified-order`, helper bigint) + a migration.
- **Follow-up (issue/nota):** os ~13 outros consumidores de `omie_clientes` sem `empresa_omie` (customer360, farmer, printdash, compare-customer-process, e os 2 INSERTs `Auth.tsx:129`/`AdminApprovals.tsx:109` que não setam `empresa_omie`). Precisão>recall, YAGNI.

## 9. Riscos / decisões em aberto

- **Disponibilidade:** fail-closed na divergência bloqueia o pedido raro *staff sem user local E sem documento* (hoje ele vai, muitas vezes certo). Aceito (money-path: PV errado cobra no cliente errado). Mensagem acionável obrigatória.
- **Custo Omie:** 1 `ListarClientes` por PV oben até o backfill preencher; colacor bate no espelho (sem chamada). Sequencial no PV (baixo risco de rate-limit).
- **Legado:** quotes/orders pré-migration sem `customer_document` derivam por `profiles.document(customer_user_id)` + divergência fail-closed. Sem backfill retroativo de `customer_document` nesta fase (avaliar se necessário).

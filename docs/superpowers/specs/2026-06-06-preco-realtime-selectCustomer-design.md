# Preço em tempo real lento na seleção de cliente (`/sales/new`) — diagnóstico + plano faseado

**Data:** 2026-06-06 · **Status:** Etapa 1 (PR #656) + Etapa 2a entregues (frontend, só Publish); Etapa 2b-4 (backend/edge) aguardando deploy + Codex.
**Origem:** founder reportou "a atualização de preço em tempo real está demorando muito" ao selecionar cliente no Novo Pedido. **2 consults Codex** (gpt-5.5 xhigh) — direção confirmada e vários bugs money-path descobertos junto.

## Sintoma
Ao selecionar o cliente, os produtos só trocam do preço-tabela para o "Preço cliente" depois de ~2-4s. O badge é só `prices[product.omie_codigo_produto]` ([ProductItemForm.tsx:60](../../../src/components/unified-order/ProductItemForm.tsx:60)) — render instantâneo. Toda a latência é a cadeia de fetch em `selectCustomer` ([useCustomerSelection.ts](../../../src/hooks/unifiedOrder/useCustomerSelection.ts)).

## Causa-raiz (a lentidão é a ponta visível de um fluxo com bugs money-path)
Cadeia original, **toda em série**, com o preço aplicado só no fim:
1. `await resolveLocalUserId` — 1 query DB.
2. `await Promise.allSettled([7])` — 6 chamadas Omie + 1 DB, em paralelo, mas com **contenção por conta** (colacor dispara 3 ListarPedidos/ListarClientes simultâneos).
3. `await autoCreateInMissingAccounts` ← **bloqueava o preço**. Quando o lookup de cliente falha (toast "Falharam: cliente Afiação"), o código por-conta fica `null` e o auto-cadastro dispara um **WRITE no Omie** (~2s) — no caminho crítico do badge.
4. `await resolveLocalPricesByOmieCode` — 1 query DB.
5. `setCustomerPricesOben/Colacor` ← preço aparece.
6. (depois de tudo) `validar_vendedor` — spinner "Validando nos 3 Omies", até 9 chamadas Omie.

### Bugs money-path achados junto (Codex)
- **Preço Colacor com código ERRADO:** `buscar_precos_cliente`/`buscar_ultima_parcela` para `account:'colacor'` recebem `cust.codigo_cliente` (código **oben**). Código de cliente é por-conta → preço/parcela Colacor saem errados/vazios. ([useCustomerSelection.ts:408,414](../../../src/hooks/unifiedOrder/useCustomerSelection.ts:408))
- **Chamada `ListarPedidos` duplicada:** `buscar_precos_cliente` e `buscar_ultima_parcela` fazem a mesma chamada Omie (mesmos params) — 4 quando 2 bastam; as duplicadas ao mesmo método podem acionar o **retry de 5-15s** do edge.
- **Fan-out oculto:** a query react-query `customer-purchase-history` re-dispara quando `customerUserId` e o código Colacor mudam de key → até **5 ListarPedidos por conta** (`historico_produtos_cliente`), competindo com preço/parcela.
- **Corrida A→B:** seleção não cancela a anterior; preços/`customerUserId` do cliente antigo não eram limpos → trocar de cliente podia misturar dados.
- **Carrinho não re-precifica:** `useCart` captura `unit_price` e não atualiza quando o mapa chega ([useCart.ts:107](../../../src/hooks/unifiedOrder/useCart.ts:107)) → adicionar produto antes do preço resolver grava **preço-tabela no pedido**.
- **Submit faz fallback cross-account:** `codigo_cliente_colacor || codigo_cliente` e `codigo_cliente_afiacao || codigo_cliente` ([submitOrder.ts:198,326](../../../src/services/orderSubmission/submitOrder.ts:198)) → pedido pode ir pro **cliente errado** no Omie.
- **Duplicação de cliente:** no caminho Colacor, erro transitório do Omie vira `null` interpretado como "ausente" → `IncluirCliente` cria duplicado. (Na Afiação o risco é menor — o `catch` da criação não cria.)
- **Estado de preço binário:** falha de preço Omie vira mapa vazio, indistinguível de "cliente sem histórico" — money-path precisa de `ready-empty` vs `error`.
- `validar_vendedor` **não** deve começar no início (Codex corrigiu minha ideia): competiria com os lookups e poderia validar antes da criação (resultado stale). Se é gate, o submit deveria aguardá-lo (hoje não aguarda).
- `codigo_cliente_integracao` usa `Date.now()` ([omie-vendas-sync:1526](../../../supabase/functions/omie-vendas-sync/index.ts:1526)) → não-idempotente.

## Veredito do Codex (incorporado)
Preço sai do caminho crítico, **mas identidade por-conta vira pré-condição do submit, nunca fallback.** Desenho final: **ensure especulativo em background + join obrigatório no submit, por conta usada** (não fire-and-forget puro). Lookup tri-state (`found`/`absent`/`error`): só cria quando ausência **confirmada**; em `error`, criação e submit **bloqueados**.

## Plano faseado

### ✅ Etapa 1 — Frontend, fail-soft (entregue; só Publish, zero efeito externo)
Em `selectCustomer`:
- Limpa estado do cliente anterior no início (preços/parcelas/`customerUserId`/ranking).
- **Token de geração** (`selectionTokenRef`): conclusões de uma seleção vencida (A→B) são descartadas — guard `isStale()` antes de cada `setState`, no `finally` (só apaga loading se corrente) e antes do `validar_vendedor`.
- **Preço/parcela publicados ANTES do `autoCreateInMissingAccounts`** → o badge aparece logo após os lookups; o WRITE de cadastro sai do caminho crítico (segue awaited por ora).
- **Não** mexe no submit, **não** muda comportamento do auto-cadastro (ainda awaited), **não** bloqueia Add/Enviar. Risco money-path: nulo.

### ✅ Etapa 2a — Submit fail-closed (frontend; só Publish, sem deploy de edge)
Antecipada da Etapa 3 por ser frontend-only e o maior ganho de integridade (acaba com pedido na conta errada). **Não depende do edge.**
- **Preflight `missingAccountIdentities`** (helper puro TDD em `helpers.ts`): antes de QUALQUER insert, se uma conta COM itens não tem código de cliente próprio válido → bloqueia o envio **inteiro** com erro claro (`step:'validate_identity'`, surface em toast `'Erro ao criar pedido'`). Não envia pela metade num pedido multi-conta.
- **Removido o fallback cross-account de CLIENTE** no POST Colacor e no staffContext Afiação (`|| customer.codigo_cliente`) — preflight garante presença, usa `!`.
- **NÃO incluído (fica na 2b):** fallback de **vendedor** (`?? codigo_vendedor`) — exige checar se o `criarPedidoVenda` tolera vendedor nulo; risco de quebrar PV se removido às cegas.

### ⏳ Etapa 2b — Backend de integridade (precisa redeploy de edge via Lovable + aval)
- Lookups **tri-state** (`found`/`absent`/`error`) — fecha o buraco: `callOmieVendasApi` retorna `null` no transitório-esgotado ([omie-vendas-sync:249](../../../supabase/functions/omie-vendas-sync/index.ts:249)) e `buscar_cliente_por_documento` engole erro em `200/null` ([omie-sync:910](../../../supabase/functions/omie-sync/index.ts:910)) → erro vira "ausente" → duplica. Design opt-in `throwOnTransient` (default = comportamento atual → 26 callers intactos). Plano em [plans/2026-06-06-preco-realtime-etapa2-plan.md](../plans/2026-06-06-preco-realtime-etapa2-plan.md).
- Action `ensure_cliente` **idempotente** (código de integração determinístico, não `Date.now()`); guard "só cria em `absent`".
- Corrigir o **código Colacor** nas chamadas de preço/parcela + remover o fallback de **vendedor**.

### ⏳ Etapa 3 — Background seguro (money-path; aval)
- Auto-cadastro vira **promise retida** (não fire-and-forget); `ensure` só para contas no carrinho; submit **aguarda os ensures** (com o preflight da 2a já no lugar como rede).
- Re-precificar itens **não-editados** do carrinho quando o mapa de preço chega (ou bloquear Add até resolver) — decisão de UX do balcão.

### ⏳ Etapa 4 — Otimização (aval)
- Action consolidada preço+parcela (mesma `ListarPedidos` retorna ambos) → 4 chamadas viram 2; **aditiva** (não muda contratos antigos → rollback só no frontend).
- Suspender/deduplicar `historico_produtos_cliente` durante a seleção.

## Validação (preview do Lovable — SPA não renderiza headless, §5 CLAUDE.md)
- Slow 3G: cronometrar clique → 1º badge Oben (deve cair vs. hoje).
- Selecionar A, trocar rápido para B: nenhum estado final pode conter dados de A.
- Adicionar produto logo após selecionar: receber o preço correto (ou estar bloqueado).
- (Etapa 3) bloquear request `omie-sync`: pedido com Afiação deve falhar ANTES de qualquer insert; lookup com erro → zero criação e submit bloqueado; cliente ausente → exatamente 1 criação.

## Não-objetivos / decisões em aberto (founder)
- Bloquear o botão Add enquanto o preço não resolve = decisão de UX do operador de balcão (Codex recomenda; alternativa menos intrusiva = re-precificar item não-editado).
- Etapas 2-4 mexem em writes no Omie e exigem o ritual de deploy do Lovable → não tocadas sem aval.

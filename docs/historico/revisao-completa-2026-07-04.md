# Revisão completa de bugs — 2026-07-04

Varredura completa do app (11 subagentes por domínio + sweep transversal por assinaturas), baseline mecânico verde (typecheck/lint/4.344 testes) — **todos os bugs abaixo passam por CI verde**. Precisão > recall. Legenda: 🔬 verificado na fonte/banco · 📋 subagente (não reconfirmado).

## Corrigido nesta sessão (em prod ou PR)

| PR | Fix | Severidade |
|---|---|---|
| #1162 | Transcrição vazava entre chamadas de clientes (LGPD); fila offline apagava mutação no flush; preço 10× por vírgula pt-BR (`PriceInput`+`parseDecimalBR`); margem do farmer inflada por custo-zero; parser rejeita ambiguidade | P0/P1 (TDD+Codex) |
| #1164 | `is_approved` auto-aprovável por customer (UPDATE **e** INSERT) — trigger `BEFORE INSERT/UPDATE`, provado PG17 12/12 | P1 seg (live) |
| #1172 | `.or()` em UPDATE quebrava toda efetivação de NF-e (42703) → RPC SQL-pura atômica, PG17 8/8 | P1 (live) |
| #1174 | RPC de efetivação exposta a anon/authenticated (`REVOKE FROM PUBLIC` não basta no Supabase) → revoke por nome, PG17 7/7 | P1 seg (live) |
| #1176 | 2 KPIs sempre-zero do cockpit (aging>90d lia chave inexistente; sugeridos-prontos contava status inexistente) | P2 |
| #1161 | (já estava) idempotência de pedidos programados — claim `processando`+watchdog+UNIQUE | P1 |

**Lição durável** (já em `docs/agent/database.md`): RPC SECURITY DEFINER nova exige `REVOKE EXECUTE FROM anon, authenticated` por NOME; e o harness PG17 do gate tem que replicar o `ALTER DEFAULT PRIVILEGES` do Supabase, senão dá falso-verde (mordido no #1172, só pego na verificação pós-deploy via psql-ro).

---

## Backlog — NÃO corrigido (priorizado)

### 🔴 P0/P1 money-path / segurança

**Vendas/Pedidos**
- 🔬 `src/pages/SalesQuotes.tsx:106` (P0) — conversão orçamento→pedido não valida `empresa_omie` → PV no cliente/vendedor errado (códigos colidem entre contas).
- 🔬 `SalesQuotes.tsx:121` (P1) — status vira `rascunho` antes do envio, sem rollback → orçamento órfão sem reenvio se o edge falhar.
- 🔬 `SalesQuotes.tsx:146` (P1) — bloqueio de crédito (200 `{blocked:'credito'}`) vira toast "enviado com sucesso".
- 📋 `src/pages/UnifiedOrder.tsx:259` (P1) — `handleRestore` não trava o cliente do rascunho → PV com preços negociados de outro cliente.
- 📋 `src/hooks/useUnifiedOrder.ts:620` (P2) — `submitQuote` sem guard re-entrante → duplo clique = 2 orçamentos.
- 📋 `src/components/salesOrderEdit/useSalesOrderEdit.ts:267` (P2) — edição sincroniza fire-and-forget → local diverge do ERP em silêncio.

**Farmer/Scoring/Cockpit**
- 🔬 `src/hooks/useFarmerScoring.ts:133` (P1) — score sobre `sales_orders` sem paginação (cap 1.000) → cliente ativo vira churn≈100.
- 🔬 `src/hooks/dashboard/useVendasZone.ts:47` (P1) — "Faturado hoje" não filtra `account` → tile da empresa X mostra o grupo.
- 📋 `src/components/intelligence/IntelligenceStrategicTab.tsx:66` (P1) — "Gap de Margem" soma 100 linhas de log append-only → double-count.
- 📋 `src/pages/Customer360.tsx:72` (P1) — faturamento sem `isPedidoValido`/`deleted_at`; janela 12m por `created_at` (data do sync).
- 📋 `useFarmerScoring.ts:464` (P2) — scores sempre com DEFAULT_CONFIG (config async não re-dispara).

**Financeiro**
- 🔬 `src/services/financeiroService.ts:364` (P1) — `getFluxoCaixa` sem paginação (oben ~11-12k títulos).
- 🔬 `src/services/financeiroV2Service.ts:583` (P1) — DRE por categoria `.range()` sem `.order()`.
- 📋 `financeiroV2Service.ts:505` (P1) — `getAnaliseDimensional` sem paginação (cap 1.000 na RPC).
- 🔬 `src/components/financeiro/CockpitDrillDown.tsx:105` (P2) — "Total" soma só `.limit(500)`.
- 🔬 `src/services/financeiroService.ts:302` (P2) — `getAging*` engolem erro → tudo R$0 sem sinal.
- 📋 `FluxoCaixaTab.tsx:38` (P2) — "Acumulado" dupla-conta o realizado passado; `todayStr` UTC.

**Reposição**
- 🔬 `src/components/reposicao/pedidos/useDetalhesModal.ts:200` (P1) — "Aprovar e disparar" descarta `precoEdits` → dispara com preço NULL.
- 🔬 `src/components/reposicao/cicloHoje/PedidoRow.tsx:66` (P1) — editor de quantidade grava `num_skus`, não os itens → compra maior que a aprovada.
- 🔬 `src/components/reposicao/cicloHoje/useCicloHoje.ts:147` (P1) — rejeição em lote sem guard de status → cancela PO já disparado no Omie.
- 🔬 `src/components/reposicao/baixoGiro/useBaixoGiro.ts:33` (P2) — `account='oben'` mas o saldo vive em `account='vendas'` → capital parado subestimado.

**Estoque/Offline**
- 🔬 `src/pages/RecebimentoConferencia.tsx:259` (P0) — contagem offline enfileira valor absoluto stale → subcontagem permanente da conferência.
- 🔬 `RecebimentoConferencia.tsx:374` (P1) — `handleFinalize` não checa `data.modo` → "efetivada" mesmo em falha honesta.
- 🔬 `vite.config.ts:155` (P1) — SW cache não cobre `picking_task_items`/`nfe_lotes_escaneados` → sem itens offline.

**Auth/Infra**
- 🔬 `src/contexts/AuthContext.tsx` `signOut` (P1) — sem `queryClient.clear()` → PII entre usuários em device compartilhado.
- 🔬 `src/components/shell/ShortcutsRegistry.tsx:67` (P2) — `?` nunca abre o dialog de atalhos.
- 🔬 `src/hooks/useUrlState.ts:26` (P2 latente) — boolean default-`true` não persiste `false`; array vira `string[]`.

**Tintométrico/Telefonia**
- 🔬 `src/hooks/useDirectTintImport.ts:15` (P0 físico) — `parseBrDecimal` não trata milhar: `"3.600,00"`→3.6 → fórmula de tinta ~1000× errada; import sem transação (l.427).
- 📋 `src/contexts/WebRTCCallContext.tsx:487` (P1) — nova chamada sobrescreve sessão SIP sem `terminate()` → chamada fantasma.

**Edge (deploy manual)**
- 📋 `fin-funding:541`/`fin-cashflow-engine:1075` (P1) — filtram `status_titulo='ABERTO'` (morto) → antecipação sobre universo vazio.
- 📋 `fin-ic-reconcile:128` (P1) — CR/CP sem paginação (~29k) + delete-all antes do insert.
- 📋 ~8 loops de sync Omie param em `total_de_paginas` (`omie-sync-estoque:606`, `omie-analytics-sync:613`, `omie-sync-nfes-recebidas:457`, …).
- 📋 `generate-tactical-plan:274` (P2) — grava fallback do LLM como plano real; `generate-bundle-argument:22` (P2) — gate só `getUser` (customer queima créditos).

### 🟡 Temas sistêmicos (lotes)
- **Cap 1.000 do PostgREST** em telas que crescem + `.range()` sem `.order()` estável (`useRoutePanel:16`, `useCrossSellEngine:134`, `useRevisaoParametros:54`, `useClientesScope:61`).
- **Datas UTC como "hoje"** (usar `spBusinessDate`/`hojeSP`): `visitas/today.ts:3` (6 consumidores), `RotaPropostas:11`, `FluxoCaixaTab:22`, `RecebimentoConferencia:98`, `agruparPorMes:130`, `useKpisVisita`, `useNotificacoes:130`.
- **TTL 5min do lock de efetivação** (`omie-nfe-recebimento`) — race pré-existente (Codex #1172): runner travado >5min → 2º caller reclama. Mitigar com `AbortSignal` < TTL.
- **`process-recurring-orders`** — legado, 0 schedules; cursor fire-and-forget + insert sem idempotência. Só se voltar a ter schedules.

### Saiu limpo (não inflar)
Núcleo de auth/impersonação (fail-closed, write-guard 4 camadas); helpers `@/lib/postgrest`; pipeline do unified-order (fingerprint+priceGuard 4 camadas); helpers puros de financeiro/reposição. Os bugs concentram-se na camada de interação/UI e nos loops de sync.

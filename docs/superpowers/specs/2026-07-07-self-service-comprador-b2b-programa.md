# Programa: Self-service do comprador B2B — expor a maquinaria com a fronteira de autorização certa

> Origem: `benchmark-externo` (2026-07-07) contra o artigo BigCommerce *State of B2B Ecommerce* (https://www.bigcommerce.com/articles/b2b-ecommerce/). Priorização adversarial pelo Codex (gpt-5.5, reasoning high). Este doc é o **handoff para a sessão dedicada** — a Fase 0 é money-path pesado (RLS + views customer-facing) e não deve ser empilhada numa sessão de outra entrega. Evidência `arquivo:linha` da varredura de 2026-07-07.

## Achado central (o que orienta o programa)

O gap dominante do benchmark **não é "não existe", é "não está exposto ao comprador"**. A maquinaria de e-commerce B2B (carrinho, catálogo, cotação, recompra, cross-sell, histórico de compras) **já está construída no código**, fenceada atrás de `RequireStaff` / `isCustomerMode` — porque o modelo atual é **venda assistida pela vendedora**. O cliente de **afiação** já se auto-atende; o comprador de **produto** (tinta/material Oben/Colacor) não.

## Premissa desafiada pelo Codex (crítica — ler antes de atacar)

"Expor a maquinaria staff ao cliente é barato" é **meia-verdade**: barato no React, **não** no contrato comercial. A venda assistida existe por motivos reais — crédito, negociação de preço, substituição de item, estoque reservado p/ conta estratégica, pedido mínimo, frete, mediação por WhatsApp. **Não começar com "pedido direto".** Começar com *"comprador monta carrinho e solicita cotação/recompra"* (preserva o gate humano); liberar pedido direto só por **allowlist** de clientes confiáveis.

Risco central de autorização: **`isCustomerMode`/`RequireStaff` são gates de UX/auth, NÃO o modelo de autorização.** A fronteira real tem que ser RLS/RPC — `auth.uid()` → cliente → preço/pedido/estoque. **Nunca confiar em `cliente_id` vindo da URL ou do estado React.**

## Tabela de gaps (evidência real)

| # | Prática (benchmark) | Estado | Persona | Evidência (`arquivo:linha`) |
|---|---|---|---|---|
| 1 | Catálogo de produto self-service | 🔴 gap | cliente | `src/pages/SalesProducts.tsx:41-45` (redireciona não-staff) |
| 2 | Histórico de compras de produto ao comprador | 🔴 gap | cliente | `src/pages/Orders.tsx` só afiação; `sales_orders` não exposto; `useHistoricoCompras.ts` é ficha do vendedor |
| 3 | Hierarquia de conta multiusuário | 🔴 gap | cliente | `src/queries/useClienteGrupos.ts` só analítico staff (1 usuário = 1 CNPJ) |
| 4 | Aprovação de compra pelo gestor do comprador | 🔴 gap | cliente | só aprovação staff-side (`AdminApprovals.tsx` cadastro / `useExcecaoCredito.ts` crédito) |
| 5 | Backorders / ruptura na venda | 🔴 gap 🟥 | ambos | `src/pages/SalesProducts.tsx:262` (badge não bloqueia/reserva) |
| 6 | Carrinho abandonado (gatilho) | 🔴 gap | cliente | nenhum tracking |
| 7 | Multi-storefront | 🔴 gap | — | `src/contexts/CompanyContext.tsx` (3 contas hardcoded) |
| 8 | CPQ · punchout / eProcurement | 🔴 gap | cliente | não existe |
| 9 | Cotação online self-service | 🟡 parcial | staff↛cliente | `src/pages/SalesQuotes.tsx` (RequireStaff); cliente só aceita orçamento de afiação (`OrderDetail.tsx:120`) |
| 10 | Carrinho de produto | 🟡 parcial | staff↛cliente | `src/hooks/unifiedOrder/useCart.ts`; `isCustomerMode` só deixa afiação |
| 11 | Recompra 1-clique (reorder) | 🟡 parcial | staff↛cliente | `src/lib/pedido/replicar-pedido.ts` (gate `isStaff`); botão do cliente `OrderDetail.tsx:474` não pré-preenche |
| 12 | Cross-sell / recomendação ao comprador | 🟡 parcial | staff↛cliente | `useRecommendationEngine.ts`; painel só `!isCustomerMode` (`UnifiedOrder.tsx:448`) |
| 13 | Visibilidade de estoque ao cliente | 🟡 parcial | staff↛cliente | `src/pages/SalesProducts.tsx:262` (saldo só staff) |
| 14 | Segmentação p/ campanha | 🟡 parcial | staff | `src/hooks/useCustomerSegments.ts` (localStorage, TODO server-side) |
| 15 | E-mail marketing / gatilho de recompra | 🟡 parcial | cliente | `supabase/functions/monthly-report/index.ts` (transacional; sem campanha) |
| 16 | Precificação dinâmica · previsão de demanda | 🟡 parcial | staff | `src/lib/regua-preco/`; `param_auto_core.sql` (estatística, sem ML/forecast comercial) |
| 17 | Preço por cliente/contrato | 🟢 tem | sistema | `src/hooks/useClienteTier.ts` (`cliente_tier_preco`), `useReguaPreco.ts` |
| 18 | Integração ERP bidirecional (Omie) | 🟢 tem | sistema | ~30 edges `omie-*`; `disparar-pedidos-aprovados/index.ts` (outbound) |
| 19 | Analytics (padrões de pedido, AOV, churn) | 🟢 tem | staff | `customer_metrics_mv`; `calculate-scores/index.ts:508` (churn_risk); `/intelligence` |
| 20 | PWA/mobile · WhatsApp/telefonia | 🟢 tem | ambos | `vite.config.ts` (VitePWA); `whatsapp-send`, `nvoip-calls` |

**Placar:** 8 gap · 8 parcial · 4 tem. 6 dos 16 são "staff↛cliente" (maquinaria existe, falta expor).

## Programa em fases (Codex integrado)

**Sequência anti-retrabalho (Codex): criar as views/RPCs customer-facing PRIMEIRO, depois plugar as telas.** Plugar tela staff direto = reabrir tudo depois para corrigir autorização.

### Fase 0 — fundação de autorização (TRAVA tudo; money-path + auth) ← ponto de entrada da sessão dedicada
- **PR0.1** — Feature flag + allowlist de clientes p/ "produto self-service" (rollout controlado).
- **PR0.2** — Camada customer-facing: **views/RPCs dedicadas** escopadas por `auth.uid()`→cliente→empresa (preço/pedido/estoque/histórico). Não reaproveitar query staff. 🟥 `prove-sql-money-path` + Codex adversarial.
- **PR0.3** — Smoke adversarial de isolamento: cliente A não vê preço/pedido/carrinho/cotação/estoque/histórico de B — nem de outro CNPJ do mesmo grupo econômico, nem de outra empresa do Grupo Colacor.

### Fase 1 — read-only ao comprador (alto impacto, baixo risco)
- **PR1** — Catálogo de produto (só produtos elegíveis + preço do tier do cliente + disponibilidade *segura*, não saldo bruto). 🟥
- **PR2** — Histórico de compras de produto (`sales_orders` via view da Fase 0, read-only).
- **PR3** — Cross-sell/recomendação em modo comprador (`RecommendationsPanel` em `isCustomerMode`).
- **PR4** — Recompra = "montar carrinho a partir do pedido" **reprecificando no tier/contrato atual** (nunca clonar preço antigo), sem submeter.

### Fase 2 — self-service comercial controlado (money-path)
- **PR5** — Carrinho de produto do cliente como **draft**. 🟥
- **PR6** — "Solicitar cotação" de produto: fluxo cliente→staff→cliente (reaproveita `SalesQuotes`). 🟥
- **PR7** — Cliente aceita cotação de produto online. 🟥

### Fase 3 — dinheiro e operação (revisão adversarial pesada)
- **PR8** — Estoque *salable* vs bruto: regra de disponibilidade ao cliente (não vazar margem/ruptura). 🟥
- **PR9** — Backorder/reserva com TTL + idempotência. 🟥
- **PR10** — Pedido direto **só p/ allowlist** (crédito ok, condições ok) + Omie com rollback/estado visível. 🟥

### Fase 4 — crescimento/retenção
- **PR11** — Carrinho abandonado (tracking server-side + WhatsApp/e-mail, **sem desconto automático** no início).
- **PR12** — Segmentação server-side (mata o `localStorage` do `useCustomerSegments`).
- **PR13** — Gatilho de recompra por janela de consumo + campanhas por tier/grupo/comportamento. 🟥 (se incluir preço/link de recompra)

### Fase 5 — governança B2B (não antes do MVP)
- **PR14+** — Conta multiusuário (comprador/aprovador/financeiro) → budgets por usuário/departamento → aprovação interna do comprador. 🟥 + auth.
- Codex **discorda parcialmente do YAGNI aqui**: B2B real costuma ter comprador/aprovador/financeiro. Antecipar SÓ se os maiores clientes já têm múltiplos compradores por CNPJ e isso bloqueia adoção.

### Deferidos / YAGNI (Codex concorda)
Multi-storefront (`empresa_id` + tema leve resolve p/ 3 contas fixas), CPQ (produto é SKU/tinta com preço contratual), punchout/eProcurement (só se top contas pedirem Ariba/SAP), ML/forecast comercial (régua estatística resolve; não gastar antes de o self-service gerar dados), marketplace/B2B2C. Cada um passa por `/office-hours` antes.

## Dependências duras (Codex)
RLS/provas antes de qualquer rota cliente · catálogo+preço antes de carrinho · histórico antes de reorder · carrinho antes de cotação · cotação antes de aceite · disponibilidade de estoque antes de pedido direto · reserva/backorder antes de prometer prazo/quantidade · segmentos server-side antes de campanha · multiusuário antes de budgets/aprovação · feature flag antes de cada mutação nova.

## Riscos de autorização a provar no smoke (Codex)
Cliente ver preço/tier de outro cliente · histórico de outro CNPJ do mesmo grupo · pedido de outra empresa do grupo · inferir margem/ruptura por estoque detalhado demais · usar endpoint staff em modo "customer" · reorder clonar preço vencido · quote/pedido aceitar item fora do catálogo elegível · aprovação staff-side confundida com aprovação do comprador.

## Como retomar
Sessão dedicada → começar pela **Fase 0** (spec de design detalhada via `writing-plans`, depois execução PR a PR com `prove-sql-money-path` + `lovable-db-operator` para as views/RLS). A tabela acima é a fonte da verdade dos gaps; re-confirmar `arquivo:linha` se a `main` tiver andado muito.

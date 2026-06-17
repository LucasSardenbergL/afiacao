# Fase 2 — Rotina comercial atrelada às ligações (Fatia 1: Oferta viva na ligação) — Design

> **Pedido do founder (1ª mensagem da Fase 1):** *"rotina comercial atrelada às ligações das farmers para antever algo que elas possam oferecer no momento da ligação delas… o comercial tem que se retroalimentar."* A carteira já foi limpa de fornecedores (fase anterior). Esta feature é faseada em **2 fatias**; este spec cobre a **Fatia 1**.

## 1. Problema

A vendedora (farmer) liga pro cliente, mas **não tem a oferta certa na ponta da língua** na hora. Os motores de oferta (`useBundleEngine`, `useCrossSellEngine`) e um **plano tático rico** (com gancho de conversa, objeções, perguntas) **já existem** — mas o plano é gerado **sob demanda** (tela separada `/farmer/tactical-plan`, com gate de eficiência). Então no momento da ligação a oferta **não aparece sozinha**. A farmer abre a ligação "no escuro" ou tem que ir gerar o plano antes.

**Objetivo da Fatia 1:** quando a farmer abre o cliente pra ligar, a **oferta campeã + o gancho de introdução já estão na tela**, automaticamente, sem ela pedir.

## 2. Decisões (founder, 2026-06-15)

| Decisão | Escolha |
|---|---|
| Faseamento | Oferta primeiro (Fatia 1); captura/loop depois (Fatia 2) |
| Conteúdo na ligação | **Oferta campeã + gancho pronto** (não leque, não só oferta crua) |
| Como o gancho fica pronto | **Pré-gerado de madrugada** pros prioritários (não on-demand, não regra) |
| Volume por vendedora | **Top ~25** da agenda que passam no gate de R$/h |
| Registro do resultado | **Nenhum manual** — a captura do sinal é automática (IA da gravação) na **Fatia 2** |

## 3. Estado atual (o que já existe — reuso máximo)

- **`generate-tactical-plan`** (edge LLM): gera `strategic_objective`, `diagnostic_questions`, `implication_question`, **`offer_transition` (o gancho)**, `probable_objections`, `approach_strategy`. Persiste em `farmer_tactical_plans`.
- **`useTacticalPlan`** (`src/hooks/useTacticalPlan.ts`): `generatePlan` (monta contexto + invoca a edge), `checkEfficiency` (gate R$50/h via profit-per-hour), `getActivePlan(customerId)` (plano `'gerado'` mais recente), `recordResult`.
- **`useFarmerCopilot:118`**: **já chama** `getActivePlan(selectedCustomer)` quando o cliente é selecionado na ligação.
- **`ActivePlanCard`** (`src/components/farmer/copilot/`): **já renderiza** o plano ativo na ligação. Hoje mostra objetivo/HS/churn/`approachStrategy`/2 perguntas — **NÃO mostra** o bundle (oferta) nem o `offer_transition` (gancho), e vem colapsado.
- **`useBundleEngine` → `farmer_bundle_recommendations`**: bundle por cliente, barato, sempre disponível.
- **`useFarmerScoring` → agenda priorizada** (`priority_score`): define os "prioritários".
- **Gate de eficiência**: `estimatedProfitPerHour = (revenue_potential | avgSpend) × margin% × 0.1 / (15min/60)`; threshold R$50/h.

**Conclusão:** ~90% pronto. Falta só o plano **existir** quando a farmer abre o cliente + o card **destacar** a oferta/gancho.

## 4. Desenho

### 4.1 Pré-geração noturna — `tactical-plans-batch` (1 edge nova, o grosso)
- Cron ~03:00 (após `scoring`/`carteira-rebuild`). Auth via cron-secret (`authorizeCronOrStaff`).
- Pra cada farmer com agenda: seleciona **top ~25** por `priority_score` desc que passam no **gate** (`estimatedProfitPerHour ≥ threshold`) e pré-gera o plano (reusando a IA `generate-tactical-plan`).
- **Idempotente:** pula cliente que já tenha `farmer_tactical_plans` `'gerado'` com `created_at >= hoje 00:00`. Re-gera diariamente (frescor D-1).
- **Resiliente:** erro num cliente não derruba o batch (try/catch por cliente; loga e segue). Chunking + `waitUntil` se `N_farmers × 25` apertar o timeout.
- **Cron `net.http_post` com `timeout_milliseconds` explícito** (lição do projeto: default 5s mata silencioso).

### 4.2 Destacar a oferta no card (`ActivePlanCard`, ajuste pequeno)
No topo, **aberto por padrão**:
- **"Ofereça: [produtos do `top_bundle`]"** (nomes dos produtos).
- **O gancho:** `offer_transition`.
- **Números:** margem incremental (`bundleIncrementalMargin`) + probabilidade (`bundleProbability`).

A tática (`approachStrategy`, perguntas, objeções) recolhe pro "expandir". O `activePlan` já carrega `topBundle`/`offerTransition`/`bundleIncrementalMargin`/`bundleProbability` — é só renderizar campos existentes.

### 4.3 Cauda longa (sem plano pré-gerado)
Quando `getActivePlan` retorna `null` (cliente fora do top-25 ou abaixo do gate): mostrar a **oferta crua** = top de `farmer_bundle_recommendations` ("Ofereça: [bundle]" + margem, **sem** gancho de IA). Nenhuma ligação abre "no escuro".

## 5. Data flow

```
cron 03:00 → tactical-plans-batch → (por farmer × top-25 do gate) → generate-tactical-plan (LLM)
           → farmer_tactical_plans('gerado', hoje)
[manhã] farmer abre cliente em /farmer/calls → useFarmerCopilot.getActivePlan → ActivePlanCard (Oferta+Gancho)
        └─ se null → fallback lê farmer_bundle_recommendations → "Ofereça: [bundle]" (oferta crua)
```

## 6. Economia / custo
- ~25 LLM-calls por vendedora/noite → `25 × N_vendedoras`/noite (ex: 5 vendedoras = ~125/noite). Controlado pelo top-25 + gate.
- Modelo: o que o `generate-tactical-plan` já usa (confirmar na implementação; preferir `claude-sonnet-4-6` direto + prompt caching, padrão do projeto pra código novo).

## 7. Frescor / invalidação
- Plano é **D-1** (madrugada). Se o cliente compra durante o dia, o plano fica levemente stale até a próxima madrugada — **aceitável** (a oferta muda pouco em 1 dia). v1 **sem** invalidação on-purchase (YAGNI); a re-geração diária resolve.

## 8. Escopo — o que **NÃO** entra na Fatia 1
- Captura do sinal da gravação (preço/marca/produto/demanda) → **Fatia 2**.
- Registro manual de resultado pela farmer → **não** (captura é automática, Fatia 2).
- Mudar lógica de bundle/cross-sell/scoring → **não** (reuso).
- Preview da oferta na fila da agenda (`AgendaQueueCard`) → fora (YAGNI v1; o card na ligação basta).

## 9. Testes / verificação
- **Helper puro de seleção** (top-N + gate) extraído e testado por **vitest** (espelha o padrão da Fase 1: regra pura como oráculo).
- **Idempotência** do batch: rodar 2× no mesmo dia não re-gera nem duplica.
- **Card:** verificação visual no preview (oferta+gancho em destaque; tática recolhe; fallback de oferta crua).
- **Verificação de fumaça:** rodar o batch p/ 1 farmer, conferir `farmer_tactical_plans` populado; abrir a ligação e ver a oferta+gancho.

## 10. Rollout (Lovable, manual)
- **Migration:** provavelmente nenhuma tabela nova (`farmer_tactical_plans` já existe). Avaliar índice em `(farmer_id, customer_user_id, status, created_at)` p/ o `getActivePlan`/idempotência.
- **Edges:** deploy `tactical-plans-batch` (nova) + `generate-tactical-plan` (se ganhar o modo server-side, ver §12) via chat do Lovable.
- **Cron:** agendar `tactical-plans-batch` (~03:00) com `timeout_milliseconds` explícito.
- **Front:** Publish (`ActivePlanCard` + fallback).

## 11. Fatia 2 (esboço — próximo ciclo, spec própria)
A IA ouve a **gravação** (`farmer_calls.transcript`) e extrai sinais estruturados → `farmer_calls.entities_extracted`/`analyses`:
- 💰 **preço** (cliente paga / concorrente cobrou) · 🏷️ **marca/produto em uso** · 📦 **produto-gap** (ofertamos mas não temos) · 🆕 **demanda por produto novo**.

Fecha o loop: `entities_extracted` → `signal_modifiers` (via `scoring-recalc-client`, **já existe**) → próxima oferta/agenda. **Subproduto:** sinal de **compra/catálogo** (produto-gap + demanda = "o que o mercado pede que não temos"). Sem registro manual — a IA preenche.

## 12. Riscos abertos (resolver no plano)
1. **Montagem de contexto:** `generate-tactical-plan` hoje recebe o contexto montado pelo **front** (`useTacticalPlan.generatePlan`: score, profile, bundles, objeções históricas). O batch (Deno) precisa dessa montagem **server-side** → refator: mover a montagem pra a edge (modo `{ customerId, farmerId }` self-contained) e o front passa a chamar esse modo também (DRY). Confirmar antes de implementar.
2. **Identidade no gate:** `checkEfficiency` usa `user.id`; o batch roda como cron (service_role) → adaptar a checagem server-side por `farmer_id`.
3. **Custo LLM** `25 × N`/noite — monitorar; o gate + top-25 são os controles.

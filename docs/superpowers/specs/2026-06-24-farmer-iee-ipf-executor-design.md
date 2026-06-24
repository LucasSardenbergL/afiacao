# Spec — Reabertura D1: performance do farmer por EXECUTOR (IEE/IPF)

> **Status:** DESIGN RATIFICADO (Lucas, 2026-06-24) — não implementar ainda (aguarda gatilho). Conduzido `eu + /codex` (challenge, money-path).
> **Gatilho de execução:** (1) D1 (`farmer_tactical_plans.farmer_id` = DONO) mergeado em `main`; **e** (2) "medir performance por EXECUTOR" confirmado como requisito de negócio.
> **Estado hoje (psql-ro):** tudo latente — `farmer_tactical_plans`/`farmer_performance_scores`/`farmer_calls`/`farmer_copilot_sessions`/`carteira_coverage` = 0. `farmer_client_scores` = 6.400 (dono). `generated_by` não existe. O guard de [#1034](https://github.com/LucasSardenbergL/afiacao/pull/1034) suspende o cálculo sob cobertura até esta reabertura valer.

## 1. Problema

Após o D1, `farmer_tactical_plans.farmer_id` = DONO da carteira. `useFarmerPerformance.calculateScores(farmerId)` lê plans/client_scores por DONO mas calls/copilot por EXECUTOR — sob cobertura (#980, gestor G cobre a carteira de D) os índices misturam quem-trabalhou com quem-é-dono. Isso é money-path (avaliação/comissão).

## 2. Achado que redefine o escopo (codex)

`generated_by` resolve **autoria do plano**, não **atribuição da execução**. Se A gera o plano e B faz a call, a aderência/registro/margem são de **B**. Logo a reabertura honesta precisa de **duas** identidades de executor, não uma:

| Coluna | Semântica | Origem |
|---|---|---|
| `farmer_id` | DONO da carteira no momento da geração | D1 (existe) |
| `generated_by` | quem **gerou** o plano | **nova**, setada explícita no writer (F2) |
| `call_id` (FK → `farmer_calls`) | a call que executou o plano → **executor real** = `call.farmer_id` | **nova** — vincula margem canônica + janela (ratificado D-B) |

**F2 (confirmado):** `generated_by` setado EXPLÍCITO no writer — `DEFAULT auth.uid()` grava NULL nos inserts via `service_role` (cron `tactical-plans-batch` → `generate-tactical-plan`).

## 3. Escopo por métrica (eu + codex)

| Métrica | Mede | Escopo | Coluna |
|---|---|---|---|
| IEE `ptpl_usage` | usou plano na call | executor | vínculo `call_id` (uso real — ratificado D-C) |
| IEE `objective_adherence` | seguiu o plano na call | executor **real** | `call.farmer_id` via `call_id` (NÃO `generated_by`) |
| IEE `questions_usage` | usou copilot | executor | `farmer_copilot_sessions.farmer_id` |
| IEE `bundle_offered` | ofereceu bundle | executor | evento real de oferta; fallback fraco: `generated_by` |
| IEE `post_call_registration` | registrou pós-call | executor/registrador | `call.farmer_id` via `call_id` |
| IPF-exec `incremental_margin` | margem gerada na interação | executor **real** | margem canônica por `call_id`/`farmer_calls.farmer_id` — **sem somar duplicado** |
| IPF-exec `margin_per_hour` | eficiência da interação | executor **real** | mesma fonte + duração |
| IPF-cart `mix_expansion` | diversidade da carteira | dono | `farmer_client_scores.farmer_id` (idealmente snapshot) |
| IPF-cart `ltv_evolution` | gasto médio da carteira | dono | `farmer_client_scores.farmer_id` (idealmente snapshot) |
| IPF-cart `churn_reduction` | saúde anti-churn | dono | `farmer_client_scores.farmer_id` (idealmente snapshot) |

## 4. IPF deixa de ser índice único → **SPLIT** (codex Q2)

Um `ipf_total` que soma margem-executada-por-G com saúde-da-carteira-de-D é incoerente p/ comissão (metade ação, metade ativo sob posse). Reabrir com **dois placares**:
- **`IPF-execução`** = `incremental_margin` + `margin_per_hour` → atribuído ao **executor real**.
- **`IPF-carteira`** = `mix` + `ltv` + `churn` → atribuído ao **dono**.
- Um agregado gerencial, se desejado, recebe **outro nome explícito** — não "IPF".

## 5. Bugs latentes a corrigir JUNTO (codex Q3/Q4)

1. **Margem duplicada** — hoje `Σ plans.actual_margin + Σ calls.margin_generated` ([useFarmerPerformance.ts:271](../../../src/hooks/useFarmerPerformance.ts)); se as duas linhas representam a mesma interação, **duplica dinheiro**. Escolher UMA fonte canônica de margem (a call) e parar de somar.
2. **Janela temporal** — plans filtrados por `created_at`; margem deveria usar `completed_at`, calls a data da ligação.
3. **Reatribuição de carteira no período** — `farmer_client_scores` é snapshot ATUAL; não responde "quem era dono durante o período". P/ IPF-carteira histórico justo: snapshot por período ou `owner_at_*`.
4. **`getEffectivenessStats`** — `useTacticalPlan` filtra `farmer_id = effectiveUserId` ([useTacticalPlan.ts:553](../../../src/hooks/useTacticalPlan.ts)); com `farmer_id`=dono deixa de ser do executor → migrar p/ `completed_by`/`call.farmer_id`. `useDiagnosticQuestions` já é executor (`farmer_id: user.id`) — não misturar com dono.
5. **Double-count entre placares** é aceitável SÓ porque são índices separados (G leva IPF-execução pela venda; D leva IPF-carteira pela saúde). **Nunca** somar os dois num payout/ranking único — aí D ganharia crédito financeiro por trabalho de G.

## 6. Plano de execução (quando o gatilho valer)

1. **Migration** (lovable-db-operator + prove-sql): `generated_by uuid NOT NULL` + `call_id uuid NULL` FK → `farmer_calls` em `farmer_tactical_plans`. `generated_by` explícito no writer (F2). Forward-only (0 planos → sem backfill).
2. **Writers**: `useTacticalPlan.generatePlan` (client) e `generate-tactical-plan` (edge/cron) setam `generated_by` na geração; o registro pós-call (`recordResult`) vincula `call_id` = a call feita (→ executor real = `call.farmer_id`).
3. **`calculateScores`**: re-escopar cada métrica pela coluna da tabela §3; split do IPF (§4); corrigir margem duplicada + janelas (§5). Remover o guard de cobertura do #1034 (substituído pelo escopo correto).
4. **`getEffectivenessStats`** (×2): escopar por executor real.
5. **Doc**: anexar à entrada D1 em `bugs-resolvidos.md` (quando o D1 estiver na main).
6. **Provas**: prove-sql-money-path na migration; TDD no refactor; /codex review do diff.

## 7. Decisões ratificadas (Lucas, 2026-06-24)

- **D-A ✅ Split do IPF** em dois placares: `IPF-execução` (margem, executor real) × `IPF-carteira` (mix/ltv/churn, dono). Nunca somados num payout/ranking único.
- **D-B ✅ `call_id` FK → `farmer_calls`** como modelagem do executor-real (resolve atribuição + margem canônica/double-count + janela de uma vez).
- **D-C ✅ `ptpl_usage` mede "usou plano na call"** (via `call_id`), não "gerou plano".
- **D-D ✅ Snapshot ATUAL no MVP** p/ IPF-carteira (mais simples). Nota: injusto sob reatribuição de carteira dentro do período → evoluir p/ snapshot-por-período ou `owner_at_*` se virar dor real.

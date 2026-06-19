# Semântica de `farmer_id` no scoring de carteira — design

> Frente money-path (autorização/ownership). Diagnóstico provado em PROD via `psql-ro`; metodologia vetada por `/codex consult` (gpt-5.5, high). Branch `claude/compassionate-poitras-c9dc61`.

## Problema (o que o brief pediu vs o que os dados mostraram)

Brief: o trigger `enqueue_score_recalc_from_sinais` enfileira `NEW.farmer_id` = **ator** da ligação (não o dono da carteira); o drain passa pro `recalcOne`, que sobrescreve o `farmer_id` (dono) da linha de `farmer_client_scores` → score "muda de dono", poluindo a agenda do farmer errado.

**A diligência derrubou a causa-raiz suposta.** A frente bifurcou em DOIS bugs distintos:

### Bug A — trigger `from_sinais` (REAL, mas LATENTE)
- Regressão: a migration `20260616140941` (Fatia 2, 2026-06-16) criou `enqueue_score_recalc_from_sinais` espelhando a versão **pré-Opção-A** do sibling (enfileira `NEW.farmer_id` cru) em vez da versão corrigida.
- O sibling `enqueue_score_recalc_from_call` (migration `20260524180000`, Opção A) já resolve o dono: `COALESCE(v_owner, NEW.farmer_id)` via `carteira_assignments`.
- **PROD confirmou (psql-ro):** `from_sinais` enfileira ator; `from_call` resolve dono.
- **Impacto medido HOJE: ZERO.** Dos 1425 scores divergentes: `recalc_pos_fatia2 = 0`, `farmer_id_é_ator_de_call = 0`, `nunca_recalc_sinal = 1425`. O trigger ainda **não produziu** nenhuma linha divergente. Vai produzir quando um não-dono ligar pra cliente da carteira (hoje: 0 calls de não-dono em 30d).

### Bug B — drift de reatribuição de carteira (ATIVO, 22%)
- **1425/6389 scores (22%) têm `farmer_id` ≠ dono da carteira.** Causa PROVADA:
  - `carteira_assignments`: 6909 clientes, **3 donos**, **todas as 6909 linhas atualizadas hoje 07:30 UTC** → reimport de carteira em massa (reshuffle de território de 3 vendedores).
  - `farmer_client_scores`: 6389 linhas, **todas com `updated_at`/`calculated_at` = hoje 22:57 UTC** → `calculate-scores` rodou e **PRESERVOU** o `farmer_id` antigo.
  - **Todos os 1425 divergentes são INATIVOS** (0 com call <30d) → o batch noturno (só recobre call <30d) **nunca os cura**; ficam presos permanentemente.
- Raiz: **nada reconcilia `farmer_id` na reatribuição de cliente INATIVO.** `calculate-scores` preserva no UPDATE (por design, `20260524180000:8`); os triggers só reconciliam em ATIVIDADE; o batch só cobre ativos.

## Invariante (Opção A)
`farmer_client_scores` = 1 linha/cliente (`UNIQUE(customer_user_id)`), `farmer_id` = dono da carteira (`carteira_assignments.owner_user_id`, `customer_user_id` UNIQUE, `owner_user_id` NOT NULL). RLS `fcs_*_own_or_gestor`: `pode_ver_carteira_completa(uid) OR farmer_id=uid` → quem está em `farmer_id` recebe o cliente na agenda. `farmer_client_scores.farmer_id` é **NOT NULL**.

## Enumeração de writers (princípio 5 — fronteira que toda via cruza)
Writers de `score_recalc_queue.farmer_id`: `enqueue_score_recalc_from_call` (dono ✓) · **`enqueue_score_recalc_from_sinais` (ator ✗ — Bug A)** · `reverter_exclusao_fornecedor` (dono ✓, master-gated). Writers de `farmer_client_scores.farmer_id`: `calculate-scores`/`n` (seed=dono, update=preserva) · `scoring-recalc-client` (grava o passado) · migrations. Deleter: `aplicar_exclusao_fornecedores`. Fronteira única de recalc: `recalcOne` em `scoring-recalc-client`.

## Escopo — decisão (Claude + Codex + dados; founder delegou e escolheu o conservador)

### HOTFIX AGORA — 1 migration SQL, PG17-provável, NÃO toca `farmer_client_scores`/agenda
- **P0a** — `CREATE OR REPLACE` de `enqueue_score_recalc_from_sinais` espelhando o sibling (resolve dono + `COALESCE`), **mantendo os guards de sinais** (`status='extraido'`, `TG_OP=INSERT OR sinais_ligacao IS DISTINCT FROM OLD`, gatilho `AFTER INSERT OR UPDATE OF sinais_ligacao`). Fecha o Bug A latente.
- **P0c** — reconcile da FILA pendente (defensivo; Codex). Sem isso, deploy com fila não-vazia preserva item ator-errado via `ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING`. Fila vazia hoje → no-op seguro; referencia `carteira_assignments` ao vivo.

### DIFERIDO (cada um com design + /codex próprios)
- **B1 — reconcile dos 1425** (`UPDATE farmer_client_scores SET farmer_id=owner WHERE IS DISTINCT FROM`). **GATE: founder confirmar que o reimport de carteira de 07:30 é legítimo** antes de mover 22% das agendas. Não autocura.
- **B2 — `calculate-scores` reconciliar `farmer_id=dono` no UPDATE** (não só preservar). **Raiz durável do Bug B**: sem isso o próximo reimport re-dirfta. Toca o writer autoritativo (edge). Bônus: mascara o Bug A (corrige ≤24h) → torna P2 redundante.
- **P1 — filtro de calls → `customer_user_id` only** no `recalcOne` (remover `.eq('farmer_id',…)`). Latente (0 calls de não-dono em 30d); muda semântica "sinais do farmer→do cliente". PR testado à parte. Nota: `farmer_calls` não tem `company_id`; escopo é o cliente.
- **Leitores stale** — `generate-tactical-plan` (edge), `useTacticalPlan`, `useFarmerCopilot`, `useFarmerTacticalPlan`, `useFarmerExperiments` filtram score por `farmer_id=user.id` → vazio pra cliente de outro dono sob Opção A. Money-path-adjacente (Codex), não só UX. Frente separada.
- **P2 — boundary guard no `recalcOne`: DESCARTADO.** Codex provou defesa falsa sozinho (calculate-scores desfaz na corrida das 06:00 UTC). B2 cobre direito.

## SQL do hotfix

```sql
-- P0a: enqueue_score_recalc_from_sinais resolve o DONO (espelha o sibling enqueue_score_recalc_from_call)
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_sinais()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  IF NEW.sinais_ligacao IS NOT NULL
     AND (NEW.sinais_ligacao->>'status') = 'extraido'
     AND (TG_OP = 'INSERT' OR NEW.sinais_ligacao IS DISTINCT FROM OLD.sinais_ligacao)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner
      FROM public.carteira_assignments WHERE customer_user_id = NEW.customer_user_id;
    INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason, source_call_id)
    VALUES (NEW.customer_user_id, COALESCE(v_owner, NEW.farmer_id), 'sinais_extraidos', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- P0c: reconcile da fila pendente (defensivo; fila vazia hoje)
UPDATE public.score_recalc_queue q
SET farmer_id = a.owner_user_id
FROM public.carteira_assignments a
WHERE q.processed_at IS NULL
  AND q.customer_user_id = a.customer_user_id
  AND q.farmer_id IS DISTINCT FROM a.owner_user_id;
```

Pré-flight: o trigger `trg_farmer_calls_enqueue_recalc_sinais` segue apontando pra função (só o corpo muda; não recriar o trigger). PROD `pg_get_functiondef` já conferido = casa com o repo + a adição do `COALESCE`. **Esta migration deve ser a última a recriar `enqueue_score_recalc_from_sinais`** (sem migration paralela tocando a mesma função — a última a recriar vence).

## Prova (prove-sql-money-path, PG17 + falsificação) — ✅ VERDE 9/9
Harness: `db/test-fix-enqueue-sinais-owner.sh` (aplica a migration REAL; falsificável).
1. **A1** `status='extraido'`, call por ator≠dono, carteira com dono → fila com `farmer_id=DONO`. ✅
2. **A2** cliente sem `carteira_assignments` → fallback `farmer_id=NEW.farmer_id` (ator). ✅
3. **A3** `status != 'extraido'` → NÃO enfileira. ✅
4. **A4** UPDATE de `sinais_ligacao` com JSON idêntico (após marcar a anterior processada) → NÃO re-enfileira (guard `IS DISTINCT FROM OLD` preservado). ✅
5. **A4b** UPDATE diferente → re-enfileira o DONO (prova que o trigger não morreu). ✅
6. **C1** P0c: fila pendente com ator-errado → vira dono ao aplicar a migration. ✅
7. **C2** P0c idempotente: 2ª execução muda 0 linhas. ✅
8. **F1/F1r** falsificação: versão sem `COALESCE` enfileira o ATOR (A1 tem dente) → restaurada com `COALESCE` confirmado por `pg_get_functiondef`. ✅

Asserts de cascata (visit-queue não cresce com mudança só de `farmer_id`; trigger vivo com mudança de `signal_modifiers`) pertencem à frente **B1** (reconcile de `farmer_client_scores`), diferida — entram no harness daquela frente.

## Deploy (lovable-db-operator → SQL Editor; founder cola)
Migration custom não auto-aplica no Lovable. Gerar arquivo + bloco pro SQL Editor + query de validação pós-apply (`pg_get_functiondef` confirma `COALESCE`; fila reconciliada). Sem mudança de frontend/edge neste hotfix.

## Status
- ✅ **Hotfix P0a+P0c shipado** — [PR #960](https://github.com/LucasSardenbergL/afiacao/pull/960) (não-draft, auto-merge no CI verde). Migration `20260618230000`. Harness `db/test-fix-enqueue-sinais-owner.sh` (PG17 9/9 + falsificação). **Falta o founder colar o SQL no Lovable SQL Editor** (não está no banco até o Run + validação `✅|✅`).

## Registry das frentes diferidas
- [ ] **B1** reconcile dos 1425 — **GATE: confirmar o reimport de carteira de 2026-06-18 07:30** (real desbloqueio dos 22% visíveis).
- [ ] **B2b** (DECIDIDO: trigger invariante no banco, recomendado vs B2a/edge e B2c/batch — alinha o "invariant no banco" do Codex; SQL PG17-provável; instantâneo). Trigger `AFTER INSERT OR UPDATE OF owner_user_id ON carteira_assignments` → reconcilia `farmer_client_scores.farmer_id` da linha afetada (`WHEN owner mudou`). **Deploy split:** o trigger é ungated (governa só reassigns futuros, não toca o estado suspeito atual); o reconcile one-time (= B1) fica gated na confirmação do reimport. Também corrigir `farmer_id` stale em `health_score_history`/`priority_score_log` (carimbados de `client.farmer_id` em calculate-scores:459/472). **Resume:** /codex focado no B2b → PG17 + falsificação → migration (trigger + reconcile gated). Cuidado: trigger per-row dispara N× num reimport (aceitável, op única).
- [ ] **P1** calls filter customer-only (`recalcOne` remove `.eq('farmer_id',…)`) — latente (0 impacto hoje), PR testado à parte.
- [ ] **Leitores** (`generate-tactical-plan` edge + `useTacticalPlan`/`useFarmerCopilot`/`useFarmerTacticalPlan`/`useFarmerExperiments`) filtram score por `farmer_id=user.id` → vazio pra cliente de outro dono. Money-path-adjacente (Codex), frente separada.
- [ ] **P2 boundary guard no recalcOne — DESCARTADO** (Codex: defesa falsa sozinho; B2b cobre).

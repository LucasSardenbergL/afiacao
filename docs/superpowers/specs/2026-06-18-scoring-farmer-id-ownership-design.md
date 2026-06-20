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
- ✅ **B2b provado + revisado** — migration `20260619120000_trigger_reconcile_score_owner_carteira.sql` (trigger = **UPSERT**: provisiona faltante + reconcilia dono) + harness `db/test-reconcile-score-owner-from-carteira.sh` (PG17 **15/15** + 4 falsificações). **Gate cumprido:** (1) enumeração PROD ✅ (carteira_assignments sem trigger; único trigger de fcs é o de visit-recalc AFTER UPDATE, escreve na visit-queue não em carteira → sem cascata/colisão); (2) `/codex consult` adversarial (gpt, high) ✅ — 5 achados, 2 adotados no design, 3 diferidos (abaixo); (3) PG17 verde ✅. **Falta:** abrir PR (auto-merge) + founder colar o SQL no Lovable SQL Editor (não está no banco até o Run + `✅|✅`).

### Achados B2b (verificados-PROD + /codex, 2026-06-19)
- **Cascata: SEGURA (confirmado PROD).** Enumeração psql-ro: o ÚNICO trigger de `farmer_client_scores` é `trg_farmer_client_scores_enqueue_visit_recalc` (AFTER UPDATE → `enqueue_visit_score_recalc_from_client_score`), que só enfileira na `visit_score_recalc_queue` quando `priority_score/churn_risk/expansion_score/signal_modifiers` mudam e escreve **na fila, não em carteira_assignments**. O upsert mexe só em `farmer_id + updated_at` (caminho DO UPDATE) → guard FALSE → sem enqueue, sem recursão; o caminho INSERT não dispara nada (aquele trigger é AFTER UPDATE). Provado: R1b; F3 falsifica. `carteira_assignments` **não tem trigger** (sem colisão); sem colisão de nome de função.
- **Escopo do trigger = `farmer_client_scores` (UPSERT).** **/codex #2 ADOTADO:** o trigger não só reconcilia divergente — também **PROVISIONA** linha faltante (`INSERT … ON CONFLICT (customer_user_id) DO UPDATE … WHERE farmer_id IS DISTINCT FROM EXCLUDED`). Motivo: **518 clientes em carteira HOJE sem linha de score** (calculate-scores semeia de `omie_clientes`, não da carteira → invisíveis na agenda). fcs só tem 3 NOT NULL (id default + customer_user_id + farmer_id); demais colunas têm default (priority_score=0, health_class='critico', …) → INSERT enxuto é são (ordena no fim da agenda). Espelha o bloco 1 de `20260524180000` (UPDATE divergente + INSERT faltante) como invariante contínua.
- **Logs (history/priority_log): deferral CONFIRMADO por /codex (#4).** Sem leitor de agenda por `farmer_id` nos logs hoje (em código executável só há WRITES; `calculate-scores:532-534` os declara append-only audit, fonte = fcs). Futuros registros já saem certos (calculate-scores lê o fcs.farmer_id agora reconciliado). Há índices por farmer nos logs → **gatear qualquer leitor futuro por farmer atrás de view/RPC de posse ao vivo** (entra na frente de leitores). NÃO reescrever linhas antigas.
- **`updated_at = now()` — rationale corrigido (/codex #5):** NÃO é "recência de agenda" (agenda ordena por `priority_score`, `useMyCarteiraScores:53`; frescor = `calculated_at`). Mantido por consistência com o bloco 1 + carimbo honesto de "posse alterada em"; inócuo. Comentário da migration ajustado.
- **Refino de implementação:** sem `WHEN` (referenciar `OLD` é inválido num trigger combinado `INSERT OR UPDATE`); o guard de no-op é o `WHERE … IS DISTINCT FROM EXCLUDED` do upsert. `AFTER INSERT OR UPDATE OF owner_user_id` — o `OF` só no UPDATE; INSERT dispara sempre (cobre reimport DELETE+INSERT, R3).
- **B1 (conserto one-time, GATED no reimport de 07:30):** espelhar **verbatim** o bloco 1 de `20260524180000:21-34` — UPDATE divergente (1425) **+ INSERT faltante (518)**. Handoff SEPARADO.

## Registry das frentes diferidas
- [ ] **B1** conserto one-time — **GATE: confirmar o reimport de carteira de 2026-06-18 07:30**. Inclui UPDATE divergente (1425) **+ INSERT faltante (518)**, espelhando `20260524180000:21-34`. Real desbloqueio dos 22% visíveis + dos 518 invisíveis.
- [✅] **B2b** PROVADO + revisado — **[PR #966](https://github.com/LucasSardenbergL/afiacao/pull/966) MERGED**. Trigger UPSERT `AFTER INSERT OR UPDATE OF owner_user_id ON carteira_assignments` → provisiona+reconcilia `farmer_client_scores`. **Deploy split:** trigger ungated (futuro); conserto one-time (= B1) gated. Migration `20260619120000` + harness PG17 15/15. Falta: founder colar o SQL.
- [✅] **B2c + P1 shipados — [PR #969](https://github.com/LucasSardenbergL/afiacao/pull/969).** `recalcOne` (scoring-recalc-client) parou de gravar `farmer_id` (não re-stala cliente ativo reatribuído) **+** filtro de calls vira customer-only (conta calls de não-donos). EDGE — deploy pelo chat **DEPOIS** do trigger B2b vivo. `deno check` type-neutral.
- [ ] **DELETE de carteira — latente (/codex #3).** AFTER DELETE não tratado → farmer_id apontaria p/ não-dono se um cliente sair da carteira de vez (hoje `sem_carteira=0`, 0 impacto). AFTER DELETE ingênuo quebraria reimport delete+insert (perderia colunas ricas) → precisa decisão de produto (remoção permanente). Frente à parte.
- [✅] **P1 shipado** (junto no [PR #969](https://github.com/LucasSardenbergL/afiacao/pull/969)) — calls filter customer-only no `recalcOne`. Era a mesma família "ownership do recalcOne" que o B2c.
- [✅] **Leitores — núcleo RESOLVIDO** (enumeração completa por grep, não a lista stale do spec). Único bug real: edge `generate-tactical-plan` (cron) lia score por `farmer_id` → cliente reatribuído sem plano → **corrigido (PR readers, edge:65 → customer_user_id)**. Os demais reads PER-CLIENTE já liam por `customer_user_id` (checkEfficiency, generatePlan, useFarmerCopilot, customer360 [tem fallback], escopo-clientes); as LISTAS (useMyCarteiraScores, dropdowns, experiments) ficam certas pós-reconcile (B1/B2b); analytics (Intelligence/performance/engines/clusterMargin) são filtros intencionais.
- [ ] **Cobertura nos 3 dropdowns (enhancement, decisão de produto)** — `useFarmerTacticalPlan`/`useFarmerCopilot`/`useFarmerExperiments` listam só `farmer_id=effectiveUserId` (sem cobertura) → gestor não vê clientes cobertos no dropdown, ao contrário do `useMyCarteiraScores` (que usa `ownerIds=[user.id,...coveredIds]`). NÃO é o incidente de reatribuição; é consistência de cobertura + decide o founder (gestor deve gerar plano/copilot/experimento p/ cliente coberto?).
- [ ] **P2 boundary guard no recalcOne — DESCARTADO** (Codex: defesa falsa sozinho; B2b cobre).

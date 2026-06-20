-- 20260619120000_trigger_reconcile_score_owner_carteira.sql
-- B2b — RAIZ DURÁVEL do drift de posse de score por reatribuição de carteira (Bug B).
--
-- Invariante (Opção A): farmer_client_scores.farmer_id = DONO da carteira
-- (carteira_assignments.owner_user_id), 1 linha por cliente (UNIQUE customer_user_id).
-- Hoje NADA reconcilia esse farmer_id quando o cliente é REATRIBUÍDO e está INATIVO:
-- calculate-scores PRESERVA o farmer_id no UPDATE (lê a linha existente e regrava
-- client.farmer_id — calculate-scores:469), os triggers de atividade só reconciliam quem
-- liga/visita, e o batch noturno só recobre clientes com call <30d. Resultado medido
-- (psql-ro 2026-06): 1425/6391 scores (22%) presos no dono ANTIGO após o reimport de
-- carteira de 07:30 — todos inativos, logo nunca se curam sozinhos.
--
-- Além disso, há 518 clientes EM carteira SEM linha de score (calculate-scores semeia a
-- partir de omie_clientes, não da carteira → quem não está lá nunca é semeado e fica
-- INVISÍVEL na agenda, que lê farmer_client_scores por farmer_id). Achado /codex 2026-06-19.
--
-- Correção durável: um trigger em carteira_assignments que, ao mudar owner_user_id (ou no
-- INSERT), faz UPSERT na linha de farmer_client_scores do cliente — PROVISIONA se faltar
-- (com os defaults 0/'critico'/now() das colunas ricas; calculate-scores computa de verdade
-- em ≤24h) e RECONCILIA o dono se divergir. Espelha o bloco 1 de 20260524180000 (Opção A:
-- UPDATE divergente + INSERT faltante), agora como INVARIANTE CONTÍNUA em vez de one-time.
--
-- COBRE INSERT além de UPDATE: um reimport por DELETE+INSERT (replace) não dispararia
-- UPDATE; o AFTER INSERT garante a reconciliação/provisão nesse caminho também.
--
-- SEM CASCATA: o caminho DO UPDATE mexe só em farmer_id + updated_at. O único trigger de
-- farmer_client_scores (trg_farmer_client_scores_enqueue_visit_recalc, AFTER UPDATE →
-- enqueue_visit_score_recalc_from_client_score) só enfileira na visit_score_recalc_queue
-- quando priority_score/churn_risk/expansion_score/signal_modifiers mudam → guard FALSE aqui
-- → nada enfileirado, sem recursão (escreve na fila, não em carteira_assignments). O caminho
-- INSERT não dispara nada (aquele trigger é AFTER UPDATE). Provado no harness PG17 (R1b; F3).
--
-- updated_at = now() no DO UPDATE: NÃO é "recência de agenda" (a agenda ordena por
-- priority_score — useMyCarteiraScores:53; o frescor de recompute é calculated_at). É só o
-- carimbo honesto de "posse alterada em" — mantido por consistência com o bloco 1; inócuo.
--
-- ESCOPO DE DEPLOY: este arquivo é UNGATED — só governa carteira FUTURA, NÃO toca o estado
-- atual suspeito (os 1425 divergentes + 518 faltantes). O conserto ONE-TIME desses (= frente
-- B1) fica num handoff SEPARADO e GATED na confirmação do founder de que o reimport de 07:30
-- é legítimo (mesmo SET-BASED do bloco 1 de 20260524180000: UPDATE divergente + INSERT faltante).
--
-- NÃO fecha (frentes diferidas, /codex 2026-06-19):
--   • recalcOne (scoring-recalc-client:438) grava o farmer_id do payload da fila → pode
--     re-stalar transitoriamente um cliente ATIVO reatribuído mid-flight (a fila tem o dono
--     resolvido no ENQUEUE, antigo se reatribuído depois) até a passada noturna do
--     scoring-recalc-batch (que resolve o dono via ownerMap, :102) curar em ≤24h. Inativos
--     (os 1425) não têm linha de fila → não sofrem. Fix companheiro: recalcOne resolver o
--     dono em carteira_assignments no write (espelhar o enqueue). EDGE, deploy/teste à parte.
--   • DELETE de carteira_assignments deixa farmer_id apontando p/ não-dono (latente: hoje
--     sem_carteira=0). AFTER DELETE ingênuo quebraria o reimport delete+insert (perderia as
--     colunas ricas) → exige decisão de produto p/ remoção permanente. Frente à parte.
--
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS antes do CREATE TRIGGER.
-- Pré-flight PROD (psql-ro 2026-06-19): carteira_assignments sem trigger (sem colisão); único
-- trigger de fcs é o de visit-recalc (AFTER UPDATE); sem colisão de nome de função.

CREATE OR REPLACE FUNCTION public.reconcile_score_owner_from_carteira()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id)
  VALUES (NEW.customer_user_id, NEW.owner_user_id)
  ON CONFLICT (customer_user_id) DO UPDATE
    SET farmer_id = EXCLUDED.farmer_id,
        updated_at = now()
    WHERE public.farmer_client_scores.farmer_id IS DISTINCT FROM EXCLUDED.farmer_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_carteira_reconcile_score_owner ON public.carteira_assignments;
CREATE TRIGGER trg_carteira_reconcile_score_owner
  AFTER INSERT OR UPDATE OF owner_user_id ON public.carteira_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.reconcile_score_owner_from_carteira();

-- Validação (read-only): a função faz upsert resolvendo o dono e o trigger está nos 2 eventos.
SELECT
  CASE WHEN pg_get_functiondef('public.reconcile_score_owner_from_carteira'::regproc)
            ILIKE '%ON CONFLICT (customer_user_id) DO UPDATE%'
       AND  pg_get_functiondef('public.reconcile_score_owner_from_carteira'::regproc)
            ILIKE '%farmer_id = EXCLUDED.farmer_id%'
       THEN '✅ função upsert (provisiona+reconcilia dono)' ELSE '❌ função FALTANDO/errada' END AS func_ok,
  CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_carteira_reconcile_score_owner'
          AND tgrelid = 'public.carteira_assignments'::regclass
          AND NOT tgisinternal)
       THEN '✅ trigger ligado em carteira_assignments' ELSE '❌ trigger FALTANDO' END AS trig_ok;

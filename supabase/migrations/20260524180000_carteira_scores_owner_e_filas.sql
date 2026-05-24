-- 20260524180000_carteira_scores_owner_e_filas.sql
-- Sub-PR B (carteira-Omie, Opção A) — reconciliação de posse + filas por dono.
--
-- Pré-requisito: aplicar ANTES 20260524170000_scores_unique_por_cliente.sql
-- (que faz dedupe + UNIQUE(customer_user_id) nas 2 tabelas de score).
--
-- Decisões validadas por codex consult (2026-05-24):
--   1. calculate-scores só seeda em tabela VAZIA → NÃO reconcilia farmer_id em prod.
--      A reconciliação tem que ser SET-BASED aqui (preserva colunas ricas).
--   2. Triggers de fila enfileiravam pelo ATOR da atividade (caller/visited_by).
--      Sob UNIQUE(customer_user_id) isso sobrescreveria o dono. Agora resolvem o
--      dono via carteira_assignments (COALESCE com o ator como fallback).
--   3. Índice único parcial das filas vira (customer_user_id) — 1 score por cliente.
--
-- Idempotente: pode rerodar (UPDATE só toca divergências; INSERT ON CONFLICT DO NOTHING;
-- DROP INDEX IF EXISTS; CREATE OR REPLACE FUNCTION).

-- ============================================================
-- 1. Reconciliação de posse: farmer_id = dono da carteira
-- ============================================================
UPDATE public.farmer_client_scores f
SET farmer_id = a.owner_user_id, updated_at = now()
FROM public.carteira_assignments a
WHERE f.customer_user_id = a.customer_user_id
  AND f.farmer_id IS DISTINCT FROM a.owner_user_id;

-- Clientes da carteira ainda sem linha de score → cria com defaults (colunas ricas
-- ficam 0 até o processo que as popula rodar; calculate-scores recomputa health/priority).
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id)
SELECT a.customer_user_id, a.owner_user_id
FROM public.carteira_assignments a
LEFT JOIN public.farmer_client_scores f ON f.customer_user_id = a.customer_user_id
WHERE f.id IS NULL
ON CONFLICT (customer_user_id) DO NOTHING;

-- ============================================================
-- 2. Filas de recálculo: índice único parcial por cliente
-- ============================================================
-- Dedupe pendentes por cliente antes de trocar o índice (evita falha ao criar UNIQUE).
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY customer_user_id ORDER BY enqueued_at DESC) AS rn
  FROM public.score_recalc_queue WHERE processed_at IS NULL
)
DELETE FROM public.score_recalc_queue q USING ranked r WHERE q.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS public.uniq_score_recalc_queue_pending;
CREATE UNIQUE INDEX uniq_score_recalc_queue_pending
  ON public.score_recalc_queue (customer_user_id) WHERE processed_at IS NULL;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY customer_user_id ORDER BY enqueued_at DESC) AS rn
  FROM public.visit_score_recalc_queue WHERE processed_at IS NULL
)
DELETE FROM public.visit_score_recalc_queue q USING ranked r WHERE q.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS public.uniq_visit_score_queue_pending;
CREATE UNIQUE INDEX uniq_visit_score_queue_pending
  ON public.visit_score_recalc_queue (customer_user_id) WHERE processed_at IS NULL;

-- ============================================================
-- 3. Triggers de enfileiramento — enfileiram pelo DONO (não pelo ator)
-- ============================================================
-- ANTI-DRIFT: o dono do score vem SEMPRE de carteira_assignments. A atividade
-- (ligação/visita) é só o gatilho de "recalcular este cliente", nunca define posse.
-- Cobertura é visibilidade (leitura), não muda atribuição.

-- 3a. farmer_calls → score_recalc_queue
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_call()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  IF NEW.customer_user_id IS NOT NULL
     AND NEW.entities_extracted IS NOT NULL
     AND jsonb_typeof(NEW.entities_extracted) = 'array'
     AND jsonb_array_length(NEW.entities_extracted) > 0 THEN
    SELECT owner_user_id INTO v_owner
      FROM public.carteira_assignments WHERE customer_user_id = NEW.customer_user_id;
    INSERT INTO public.score_recalc_queue
      (customer_user_id, farmer_id, reason, source_call_id)
    VALUES
      (NEW.customer_user_id, COALESCE(v_owner, NEW.farmer_id), 'call_inserted', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- 3b. route_visits → visit_score_recalc_queue (mantém null-guard do P1 fix)
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_visit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF NEW.customer_user_id IS NOT NULL AND NEW.visited_by IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner
      FROM public.carteira_assignments WHERE customer_user_id = NEW.customer_user_id;
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason, source_event_id)
    VALUES
      (NEW.customer_user_id, COALESCE(v_owner, NEW.visited_by), 'visit_completed', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- 3c. farmer_client_scores → visit_score_recalc_queue
-- NEW.farmer_id já é o dono (após reconciliação). Só ajusta o ON CONFLICT pro novo índice.
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.priority_score    IS DISTINCT FROM OLD.priority_score
      OR NEW.churn_risk      IS DISTINCT FROM OLD.churn_risk
      OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score
      OR NEW.signal_modifiers IS DISTINCT FROM OLD.signal_modifiers)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 4. Validação
-- ============================================================
SELECT 'BLOCO CARTEIRA SCORES OWNER OK' AS status,
  (SELECT count(*) FROM public.farmer_client_scores) AS fcs_linhas,
  (SELECT count(DISTINCT customer_user_id) FROM public.farmer_client_scores) AS fcs_clientes,
  (SELECT count(*) FROM public.carteira_assignments) AS carteira,
  (SELECT count(*) FROM public.farmer_client_scores f
     JOIN public.carteira_assignments a ON a.customer_user_id = f.customer_user_id
     WHERE f.farmer_id = a.owner_user_id) AS fcs_com_dono_certo,
  (SELECT count(*) FROM pg_indexes WHERE indexname IN
     ('uniq_score_recalc_queue_pending','uniq_visit_score_queue_pending')) AS filas_uniq;

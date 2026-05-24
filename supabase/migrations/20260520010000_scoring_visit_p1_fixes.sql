-- PR-SCORING-V2.1 / VISIT-A.1 — fixes dos P1 do codex review.
--
-- ATENÇÃO: migration manual necessária (Lovable Cloud não aplica auto migrations
-- de PR externo). Colar no SQL Editor do Lovable → Run.
--
-- Fixes:
--   C) Null-guard no trigger de recálculo de visita disparado por route_visits.
--      route_visits.customer_user_id é NULLABLE (paradas sem cliente vinculado).
--      O trigger inseria NEW.customer_user_id/visited_by em visit_score_recalc_queue
--      (colunas NOT NULL) sem guard → INSERT falhava e ABORTAVA o save da própria
--      route_visits. Agora só enfileira quando ambos não são nulos.
--   B-complemento) O scoring-recalc passou a gravar SÓ signal_modifiers (não mais
--      priority_score/churn_risk/expansion_score). Logo o trigger de recálculo de
--      visita que observava só essas colunas-base não dispararia mais quando um
--      sinal novo chega. Adicionada a condição signal_modifiers IS DISTINCT FROM.

-- C) Trigger route_visits → fila de recálculo de visita, com null-guard.
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_visit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.customer_user_id IS NOT NULL AND NEW.visited_by IS NOT NULL THEN
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason, source_event_id)
    VALUES
      (NEW.customer_user_id, NEW.visited_by, 'visit_completed', NEW.id)
    ON CONFLICT (customer_user_id, farmer_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- B-complemento) Trigger farmer_client_scores → fila de recálculo de visita.
-- Agora também dispara quando signal_modifiers muda (scoring-recalc só grava isso).
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
    ON CONFLICT (customer_user_id, farmer_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

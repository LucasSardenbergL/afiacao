-- PR-VISIT-INTELLIGENCE Sub-PR A: visit scoring + 4 missões + queue + triggers

-- 1. Enum mission type
DO $$ BEGIN
  CREATE TYPE public.visit_mission AS ENUM (
    'recuperacao',
    'expansao',
    'relacionamento',
    'prospeccao'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Scores table
CREATE TABLE IF NOT EXISTS public.customer_visit_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,

  recuperacao_score numeric DEFAULT 0,
  expansao_score numeric DEFAULT 0,
  relacionamento_score numeric DEFAULT 0,
  prospeccao_score numeric DEFAULT 0,

  visit_score numeric DEFAULT 0,
  primary_mission visit_mission,

  city text,
  neighborhood text,
  state text,

  last_visit_at timestamptz,
  days_since_last_visit integer,

  score_breakdown jsonb DEFAULT '{}'::jsonb,

  calculated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (customer_user_id, farmer_id)
);

CREATE INDEX IF NOT EXISTS idx_visit_scores_farmer_priority
  ON public.customer_visit_scores (farmer_id, visit_score DESC);
CREATE INDEX IF NOT EXISTS idx_visit_scores_farmer_city
  ON public.customer_visit_scores (farmer_id, city, visit_score DESC);

-- 3. Recalc queue
CREATE TABLE IF NOT EXISTS public.visit_score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  reason text NOT NULL,
  source_event_id uuid,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS idx_visit_score_queue_pending
  ON public.visit_score_recalc_queue (enqueued_at) WHERE processed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_visit_score_queue_pending
  ON public.visit_score_recalc_queue (customer_user_id, farmer_id) WHERE processed_at IS NULL;

CREATE OR REPLACE VIEW public.visit_score_recalc_pending AS
SELECT q.* FROM public.visit_score_recalc_queue q
WHERE q.processed_at IS NULL ORDER BY q.enqueued_at;

-- 4. RLS — usando 'master' (enum app_role NÃO tem 'admin', lição do PR-SCORING-V2 fix PR #97)
ALTER TABLE public.customer_visit_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view their visit scores" ON public.customer_visit_scores;
CREATE POLICY "Staff can view their visit scores" ON public.customer_visit_scores FOR SELECT
  USING (
    has_role(auth.uid(), 'master'::app_role)
    OR (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid())
  );

DROP POLICY IF EXISTS "Staff can manage their visit scores" ON public.customer_visit_scores;
CREATE POLICY "Staff can manage their visit scores" ON public.customer_visit_scores FOR ALL
  USING (
    has_role(auth.uid(), 'master'::app_role)
    OR (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid())
  )
  WITH CHECK (
    has_role(auth.uid(), 'master'::app_role)
    OR (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid())
  );

ALTER TABLE public.visit_score_recalc_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view visit recalc queue" ON public.visit_score_recalc_queue;
CREATE POLICY "Staff can view visit recalc queue" ON public.visit_score_recalc_queue FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

DROP POLICY IF EXISTS "Staff can insert visit recalc queue" ON public.visit_score_recalc_queue;
CREATE POLICY "Staff can insert visit recalc queue" ON public.visit_score_recalc_queue FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

GRANT SELECT ON public.visit_score_recalc_pending TO authenticated, service_role;

-- 5. Triggers

CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_visit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.visit_score_recalc_queue
    (customer_user_id, farmer_id, reason, source_event_id)
  VALUES
    (NEW.customer_user_id, NEW.visited_by, 'visit_completed', NEW.id)
  ON CONFLICT (customer_user_id, farmer_id) WHERE processed_at IS NULL DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_visits_enqueue_visit_recalc ON public.route_visits;
CREATE TRIGGER trg_route_visits_enqueue_visit_recalc
  AFTER INSERT OR UPDATE OF check_out_at ON public.route_visits
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_visit();

CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.priority_score IS DISTINCT FROM OLD.priority_score
     OR NEW.churn_risk IS DISTINCT FROM OLD.churn_risk
     OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score THEN
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id, farmer_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_farmer_client_scores_enqueue_visit_recalc ON public.farmer_client_scores;
CREATE TRIGGER trg_farmer_client_scores_enqueue_visit_recalc
  AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();

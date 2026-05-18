-- PR-SCORING-V2: sinais do copilot modulando priority_score
-- Adiciona signal_modifiers (jsonb), fila de recálculo, trigger pós-call.

-- 1. Colunas novas em farmer_client_scores
ALTER TABLE public.farmer_client_scores
  ADD COLUMN IF NOT EXISTS signal_modifiers jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_signal_recalc_at timestamptz;

COMMENT ON COLUMN public.farmer_client_scores.signal_modifiers IS
  'Breakdown dos modifiers aplicados pelo copilot. Schema: { churn: { delta: number, reasons: [{kind, value, weight, decay}] }, expansion: {...}, health: {...}, eff: {...} }. Reset a cada recálculo.';
COMMENT ON COLUMN public.farmer_client_scores.last_signal_recalc_at IS
  'Última vez que scoring-recalc-client rodou pra esse (customer_user_id, farmer_id).';

-- 2. Fila de recálculo (drain async pelo edge function)
CREATE TABLE IF NOT EXISTS public.score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  reason text NOT NULL,             -- 'call_inserted' | 'manual' | 'cron'
  source_call_id uuid REFERENCES public.farmer_calls(id) ON DELETE SET NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  UNIQUE (customer_user_id, farmer_id, processed_at) -- dedup mas só de não-processados
);

CREATE INDEX IF NOT EXISTS idx_score_recalc_queue_pending
  ON public.score_recalc_queue (enqueued_at)
  WHERE processed_at IS NULL;

ALTER TABLE public.score_recalc_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view recalc queue" ON public.score_recalc_queue FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can insert recalc queue" ON public.score_recalc_queue FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Service role (edge functions) bypass via service_role usage; sem policy update/delete pra users.

-- 3. Trigger pós-call: quando insere/atualiza farmer_calls com entities_extracted,
--    enfileira recálculo do par (customer_user_id, farmer_id).
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_call()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só enfileira se a chamada tem cliente vinculado E entities_extracted (sinal real)
  IF NEW.customer_user_id IS NOT NULL
     AND NEW.entities_extracted IS NOT NULL
     AND jsonb_array_length(NEW.entities_extracted) > 0 THEN
    INSERT INTO public.score_recalc_queue
      (customer_user_id, farmer_id, reason, source_call_id)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'call_inserted', NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_farmer_calls_enqueue_recalc ON public.farmer_calls;
CREATE TRIGGER trg_farmer_calls_enqueue_recalc
  AFTER INSERT OR UPDATE OF entities_extracted ON public.farmer_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_score_recalc_from_call();

-- 4. View helper: pendentes (consumido pelo edge function)
CREATE OR REPLACE VIEW public.score_recalc_pending AS
SELECT q.*
FROM public.score_recalc_queue q
WHERE q.processed_at IS NULL
ORDER BY q.enqueued_at;

GRANT SELECT ON public.score_recalc_pending TO authenticated, service_role;

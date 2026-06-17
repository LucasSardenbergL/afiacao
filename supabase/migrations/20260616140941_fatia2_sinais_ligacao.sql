-- ============================================================
-- Fase 2 / Fatia 2 — captura inteligente
-- Coluna de sinais pós-call (1 writer = edge extrair-sinais-ligacao) + enqueue
-- (reusa a fila score_recalc_queue existente) + config de ativação por classe (shadow).
-- Tudo começa OFF: nenhum efeito no scoring até a config ser ligada (Fase C).
-- ============================================================

-- 1. Coluna dedicada (envelope com audit metadata). NÃO reusa entities_extracted (multi-writer).
ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS sinais_ligacao jsonb;

COMMENT ON COLUMN public.farmer_calls.sinais_ligacao IS
  'Envelope pós-call (1 writer = edge extrair-sinais-ligacao): { schema_version, extractor_model, prompt_version, source_transcript_hash, extracted_at, status, error, sinais: { precos[], marcas_em_uso[], produtos_gap[], demandas_novas[], houve_sinal } }';

-- 2. Índice parcial p/ a varredura (calls com transcript e sem extração).
CREATE INDEX IF NOT EXISTS idx_farmer_calls_sinais_pendentes
  ON public.farmer_calls (started_at)
  WHERE sinais_ligacao IS NULL;

-- 3. Trigger que enfileira recalc quando sinais_ligacao é gravado com sucesso.
--    Espelha enqueue_score_recalc_from_call (entities_extracted) e usa a MESMA fila.
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_sinais()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sinais_ligacao IS NOT NULL
     AND (NEW.sinais_ligacao->>'status') = 'extraido'
     AND (TG_OP = 'INSERT' OR NEW.sinais_ligacao IS DISTINCT FROM OLD.sinais_ligacao)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason, source_call_id)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'sinais_extraidos', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_farmer_calls_enqueue_recalc_sinais ON public.farmer_calls;
CREATE TRIGGER trg_farmer_calls_enqueue_recalc_sinais
  AFTER INSERT OR UPDATE OF sinais_ligacao ON public.farmer_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_score_recalc_from_sinais();

-- 4. Config de ativação por classe (shadow-mode: começa tudo OFF).
CREATE TABLE IF NOT EXISTS public.sinal_classe_config (
  classe text PRIMARY KEY,
  ativado boolean NOT NULL DEFAULT false,
  ativado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.sinal_classe_config (classe) VALUES ('preco'), ('marca'), ('demanda')
  ON CONFLICT (classe) DO NOTHING;

ALTER TABLE public.sinal_classe_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sinal_classe_config_select_staff" ON public.sinal_classe_config;
CREATE POLICY "sinal_classe_config_select_staff" ON public.sinal_classe_config
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid()
                   AND role IN ('employee'::public.app_role, 'master'::public.app_role)));

DROP POLICY IF EXISTS "sinal_classe_config_master_all" ON public.sinal_classe_config;
CREATE POLICY "sinal_classe_config_master_all" ON public.sinal_classe_config
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND role = 'master'::public.app_role))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles
                      WHERE user_id = auth.uid() AND role = 'master'::public.app_role));

DROP POLICY IF EXISTS "sinal_classe_config_service_all" ON public.sinal_classe_config;
CREATE POLICY "sinal_classe_config_service_all" ON public.sinal_classe_config
  FOR ALL
  USING (auth.role() = 'service_role');

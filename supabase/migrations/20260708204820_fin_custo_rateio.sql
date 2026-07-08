-- ============================================================
-- fin_custo_rateio — custo fixo compartilhado (folha da CSC rateada à operação da OBEN) — F3 v2.
-- O Ponto de Equilíbrio soma valor_mensal_brl (NORMALIZADO: anual÷12, c/ 13º/férias/encargos) ao
-- custos_fixos, DEPOIS da reconciliação (a folha não está no snapshot da OBEN → aditivo externo).
-- ⚠️ Lovable NÃO aplica automaticamente — o merge não toca o banco. Colar no SQL Editor e rodar.
-- Idempotável (re-colar 2× = no-op). RLS master-only + trigger de autor espelhados VERBATIM de
-- fin_dre_custo_tipo (20260705120000). Provado: db/test-fin-custo-rateio.sh (PG17 + falsificação).
-- Spec: docs/superpowers/specs/2026-07-08-f3-rateio-folha-compartilhada-design.md.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_custo_rateio (
  company          text        NOT NULL,   -- empresa DESTINO (arca no PE), ex 'oben'
  rotulo           text        NOT NULL,   -- item de custo compartilhado, ex 'folha'
  valor_mensal_brl numeric     NOT NULL CHECK (valor_mensal_brl >= 0),  -- custo mensal NORMALIZADO (>=0 permite "R$0 confirmado")
  origem_company   text        NOT NULL,   -- onde o custo é pago hoje, ex 'colacor_sc' (disclosure)
  observacao       text        NOT NULL CHECK (length(trim(observacao)) > 0),  -- justificativa/fonte OBRIGATÓRIA
  ativo            boolean     NOT NULL DEFAULT true,   -- false = não-lançado (volta a pendente); distinto de valor=0 confirmado
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, rotulo)
);

ALTER TABLE public.fin_custo_rateio ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_custo_rateio_select_master ON public.fin_custo_rateio;
CREATE POLICY fin_custo_rateio_select_master ON public.fin_custo_rateio
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'master'::app_role));

DROP POLICY IF EXISTS fin_custo_rateio_write_master ON public.fin_custo_rateio;
CREATE POLICY fin_custo_rateio_write_master ON public.fin_custo_rateio
  FOR ALL USING (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'master'::app_role))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'master'::app_role));

DROP POLICY IF EXISTS fin_custo_rateio_service_all ON public.fin_custo_rateio;
CREATE POLICY fin_custo_rateio_service_all ON public.fin_custo_rateio
  FOR ALL USING (auth.role() = 'service_role'::text);

CREATE OR REPLACE FUNCTION public.fin_custo_rateio_set_autor()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fin_custo_rateio_autor ON public.fin_custo_rateio;
CREATE TRIGGER trg_fin_custo_rateio_autor
  BEFORE INSERT OR UPDATE ON public.fin_custo_rateio
  FOR EACH ROW EXECUTE FUNCTION public.fin_custo_rateio_set_autor();

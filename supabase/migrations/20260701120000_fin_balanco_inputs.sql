-- ============================================================
-- fin_balanco_inputs — inputs de balanço (master-only) para a tipologia de Fleuriet/Braga
-- no Cockpit financeiro. Versionada por (company, data_ref): a classificação é as-of o
-- balancete, casando com o NCG do snapshot na mesma data. Só ANC/PNC/PL (contas permanentes);
-- CDG = (PL+PNC)−ANC é derivado no app, nunca persistido (evita staleness de sinal money-path).
-- RLS master-only, mesmo padrão de fin_valor_inputs. Spec: 2026-07-01-fleuriet-*.
-- Idempotente: pode ser colada e rodada mais de uma vez sem erro.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_balanco_inputs (
    company text NOT NULL,
    data_ref date NOT NULL,
    ativo_nao_circulante numeric(15,2) NOT NULL,
    passivo_nao_circulante numeric(15,2) NOT NULL,
    patrimonio_liquido numeric(15,2) NOT NULL,
    observacao text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT fin_balanco_inputs_pkey PRIMARY KEY (company, data_ref),
    CONSTRAINT fin_balanco_inputs_company_check
      CHECK ((company = ANY (ARRAY['oben'::text, 'colacor'::text, 'colacor_sc'::text])))
);

COMMENT ON TABLE public.fin_balanco_inputs IS
  'Inputs de balanço (ANC/PNC/PL) master-only, versionados por data_ref, para o selo de cobertura estrutural do giro (Fleuriet/Braga) no Cockpit. CDG derivado no app.';

ALTER TABLE public.fin_balanco_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_balanco_inputs_select_master ON public.fin_balanco_inputs;
CREATE POLICY fin_balanco_inputs_select_master ON public.fin_balanco_inputs
  FOR SELECT USING ((EXISTS ( SELECT 1
     FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))));

DROP POLICY IF EXISTS fin_balanco_inputs_write_master ON public.fin_balanco_inputs;
CREATE POLICY fin_balanco_inputs_write_master ON public.fin_balanco_inputs
  USING ((EXISTS ( SELECT 1
     FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))))
  WITH CHECK ((EXISTS ( SELECT 1
     FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))));

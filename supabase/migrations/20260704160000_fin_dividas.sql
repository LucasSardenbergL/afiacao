-- ============================================================
-- F1 Módulo de Endividamento — cadastro manual master-only.
-- Spec: docs/superpowers/specs/2026-07-04-endividamento-dscr-design.md
-- RLS master-only (padrão fin_balanco_inputs). Idempotente (pode re-colar).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_dividas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  credor text NOT NULL CHECK (btrim(credor) <> ''),
  tipo text NOT NULL CHECK (tipo IN ('capital_giro','financiamento','antecipacao_recorrente','outro')),
  principal_contratado numeric(15,2) NOT NULL CHECK (principal_contratado > 0),
  saldo_devedor_informado numeric(15,2) CHECK (saldo_devedor_informado IS NULL OR saldo_devedor_informado >= 0),
  saldo_devedor_data_base date,
  cp_inclusion_status text NOT NULL DEFAULT 'nao_sei' CHECK (cp_inclusion_status IN ('sim','nao','parcial','nao_sei')),
  cp_inclusion_ate date,
  data_contratacao date NOT NULL,
  cet_aa numeric(7,4) CHECK (cet_aa IS NULL OR cet_aa >= 0),
  indexador text,
  coobrigada_por text CHECK (coobrigada_por IS NULL OR coobrigada_por IN ('oben','colacor','colacor_sc')),
  garantias text,
  observacao text,
  ativo boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
COMMENT ON TABLE public.fin_dividas IS
  'Cadastro manual master-only de dívidas (F1). cp_inclusion_status decide overlay vs add-back no DSCR.';

CREATE TABLE IF NOT EXISTS public.fin_divida_parcelas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  divida_id uuid NOT NULL REFERENCES public.fin_dividas(id) ON DELETE CASCADE,
  numero_parcela int NOT NULL CHECK (numero_parcela > 0),
  data_vencimento date NOT NULL,
  valor_amortizacao numeric(15,2) NOT NULL CHECK (valor_amortizacao >= 0),
  valor_juros numeric(15,2) NOT NULL DEFAULT 0 CHECK (valor_juros >= 0),
  valor_total numeric(15,2) NOT NULL CHECK (valor_total > 0),
  estimado boolean NOT NULL DEFAULT false,
  pago boolean NOT NULL DEFAULT false,
  CONSTRAINT fin_divida_parcelas_uq UNIQUE (divida_id, numero_parcela)
);
CREATE INDEX IF NOT EXISTS idx_fin_divida_parcelas_venc ON public.fin_divida_parcelas(divida_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_fin_divida_parcelas_naopago ON public.fin_divida_parcelas(divida_id) WHERE pago = false;

CREATE TABLE IF NOT EXISTS public.fin_divida_completude (
  company text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  completo boolean NOT NULL DEFAULT false,
  validado_em timestamptz,
  validado_por uuid
);
COMMENT ON TABLE public.fin_divida_completude IS
  'Gate de completude por empresa: sem completo=true o DSCR não publica (denominador incompleto = índice falso).';

-- Trigger de autor/timestamp forçados no servidor (default auth.uid() é forjável — trava Fase 2 P1).
CREATE OR REPLACE FUNCTION public.fin_dividas_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN NEW.updated_by := auth.uid(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fin_dividas_autor ON public.fin_dividas;
CREATE TRIGGER trg_fin_dividas_autor BEFORE INSERT OR UPDATE ON public.fin_dividas
  FOR EACH ROW EXECUTE FUNCTION public.fin_dividas_forca_autor();

CREATE OR REPLACE FUNCTION public.fin_divida_completude_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN NEW.validado_por := auth.uid(); END IF;
  NEW.validado_em := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fin_divida_completude_autor ON public.fin_divida_completude;
CREATE TRIGGER trg_fin_divida_completude_autor BEFORE INSERT OR UPDATE ON public.fin_divida_completude
  FOR EACH ROW EXECUTE FUNCTION public.fin_divida_completude_forca_autor();

-- RLS master-only (padrão fin_balanco_inputs) para as 3 tabelas. auth.uid() envolto em
-- subquery força InitPlan 1x (evita reavaliação por-linha — database.md §4).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_dividas','fin_divida_parcelas','fin_divida_completude'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select_master ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_select_master ON public.%I FOR SELECT USING (
      (SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid()) AND role = 'master'::public.app_role)))$p$, t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write_master ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_write_master ON public.%I USING (
      (SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid()) AND role = 'master'::public.app_role)))
      WITH CHECK (
      (SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (SELECT auth.uid()) AND role = 'master'::public.app_role)))$p$, t, t);
  END LOOP;
END $$;

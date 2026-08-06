-- supabase/migrations/20260708120000_fin_antecipacoes.sql
-- F4 — Antecipação de recebíveis: registro MANUAL da operação (desconto de duplicata / linha rotativa).
-- Overlay analítico; NADA reescreve sync/DRE. Derivados (custo/taxa) moram no helper puro — a tabela
-- só guarda os fatos brutos. master-only (molde fin_dre_custo_tipo/fin_dividas). Idempotente (re-colável).
-- Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md (§2, §7, §8). Os 5 P1 no CHECK.

CREATE TABLE IF NOT EXISTS public.fin_antecipacoes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company            text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  banco              text,
  tipo               text NOT NULL CHECK (tipo IN ('duplicata','linha')),
  valor_bruto        numeric(15,2) NOT NULL,   -- FACE ANTECIPADA (suporta parcial — não a face total)
  custos_avulsos     numeric(15,2) NOT NULL DEFAULT 0,  -- IOF/tarifa FORA do líquido (P1-4)
  valor_liquido      numeric(15,2) NOT NULL,   -- o que efetivamente caiu na conta
  data_operacao      date NOT NULL,
  data_vencimento    date NOT NULL,
  operacao_origem_id uuid REFERENCES public.fin_antecipacoes(id) ON DELETE SET NULL, -- rollover (§7)
  referencia         text,                     -- contrato/banco (dedup manual)
  observacao         text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,              -- soft delete (preserva histórico de custo)
  CONSTRAINT fin_antecipacoes_valores_chk
    CHECK (valor_bruto > 0 AND valor_liquido > 0 AND custos_avulsos >= 0),
  -- P1-1: '=' é custo zero, VÁLIDO; inválido SÓ quando líquido > (bruto+avulsos).
  CONSTRAINT fin_antecipacoes_liquido_chk
    CHECK (valor_liquido <= valor_bruto + custos_avulsos),
  CONSTRAINT fin_antecipacoes_prazo_chk
    CHECK (data_vencimento > data_operacao)
);

COMMENT ON TABLE public.fin_antecipacoes IS
  'F4: operações de antecipação de recebíveis (registro manual master-only). Uma linha = uma operação = um vencimento (lote multi-venc → split). Derivados (custo/taxa) no helper puro; a tabela só guarda os fatos.';

-- Dedup: mesma referência não duplica (coalesce banco p/ deduplicar mesmo com banco nulo). Ignora soft-deleted.
CREATE UNIQUE INDEX IF NOT EXISTS fin_antecipacoes_ref_uq
  ON public.fin_antecipacoes (company, coalesce(banco, ''), referencia)
  WHERE referencia IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_antecipacoes_company_viva
  ON public.fin_antecipacoes (company, data_operacao) WHERE deleted_at IS NULL;

-- Trigger de autor/carimbo no servidor (SECURITY DEFINER + search_path='' — INVOKER quebra auth.uid(),
-- "permission denied for schema auth", pego pela prova PG17; molde fin_dre_custo_tipo).
CREATE OR REPLACE FUNCTION public.fin_antecipacoes_set_autor()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    NEW.created_at := now();
  END IF;
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fin_antecipacoes_autor ON public.fin_antecipacoes;
CREATE TRIGGER trg_fin_antecipacoes_autor
  BEFORE INSERT OR UPDATE ON public.fin_antecipacoes
  FOR EACH ROW EXECUTE FUNCTION public.fin_antecipacoes_set_autor();

-- RLS master-only (verbatim ao padrão proven de fin_dre_custo_tipo).
ALTER TABLE public.fin_antecipacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_antecipacoes_select_master ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_select_master ON public.fin_antecipacoes
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_antecipacoes_write_master ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_write_master ON public.fin_antecipacoes
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_antecipacoes_service_all ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_service_all ON public.fin_antecipacoes
  FOR ALL USING (auth.role() = 'service_role');

SELECT 'fin_antecipacoes OK' AS status,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_antecipacoes') AS policies;

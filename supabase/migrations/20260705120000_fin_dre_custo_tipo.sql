-- supabase/migrations/20260705120000_fin_dre_custo_tipo.sql
-- F3 — Classificação de comportamento de custo (fixo/variavel/misto/nao_operacional) das
-- categorias de despesa da DRE, para o ponto de equilíbrio operacional (PEGN erro 7).
-- TABELA master-only (mesmo padrão de fin_funding_inputs). Overlay: o helper pontoEquilibrio
-- lê esta classificação + o snapshot; NADA reescreve a DRE/edge.
-- Resolução no READ: company específico vence '_default' (permite o CMV industrial do colacor
-- divergir do OBEN). Idempotente.
-- Spec: docs/superpowers/specs/2026-07-04-ponto-equilibrio-dre-design.md (§3, delta-E2/E4).

CREATE TABLE IF NOT EXISTS public.fin_dre_custo_tipo (
  company          text NOT NULL DEFAULT '_default',
  categoria_codigo text NOT NULL,            -- omie_codigo (casa com as chaves de detalhamento.despesas)
  tipo             text NOT NULL,
  observacao       text,                      -- justificativa; OBRIGATÓRIA p/ nao_operacional (delta-E2/E4)
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, categoria_codigo),
  CONSTRAINT fin_dre_custo_tipo_tipo_chk
    CHECK (tipo IN ('fixo', 'variavel', 'misto', 'nao_operacional')),
  -- delta-E2/E4: nao_operacional (exclui do PE) exige justificativa documentada — anti-"balde de fuga".
  CONSTRAINT fin_dre_custo_tipo_obs_nao_op_chk
    CHECK (tipo <> 'nao_operacional' OR (observacao IS NOT NULL AND length(trim(observacao)) > 0))
);

COMMENT ON TABLE public.fin_dre_custo_tipo IS
  'F3: classificação de comportamento de custo por categoria omie (fixo/variavel/misto/nao_operacional) p/ o ponto de equilíbrio. master-only; nao_operacional exige observacao. company=_default é global; company específico sobrepõe no read.';

-- Trigger: força autor + carimbo de tempo no servidor (auditoria confiável — delta-E4; não confia no cliente).
-- SECURITY DEFINER: policies RLS avaliam auth.uid() com privilégio do DONO da tabela, mas um trigger
-- SECURITY INVOKER rodaria como `authenticated` → "permission denied for schema auth" ao chamar auth.uid()
-- (pego pela prova PG17). Roda como o dono (acessa o schema auth); auth.uid() lê o GUC do request, então
-- o autor continua sendo o chamador real. search_path travado; auth.uid() qualificado, now() é pg_catalog.
CREATE OR REPLACE FUNCTION public.fin_dre_custo_tipo_set_autor()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fin_dre_custo_tipo_autor ON public.fin_dre_custo_tipo;
CREATE TRIGGER trg_fin_dre_custo_tipo_autor
  BEFORE INSERT OR UPDATE ON public.fin_dre_custo_tipo
  FOR EACH ROW EXECUTE FUNCTION public.fin_dre_custo_tipo_set_autor();

-- RLS master-only (verbatim ao padrão proven de fin_funding_inputs).
ALTER TABLE public.fin_dre_custo_tipo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_dre_custo_tipo_select_master ON public.fin_dre_custo_tipo;
CREATE POLICY fin_dre_custo_tipo_select_master ON public.fin_dre_custo_tipo
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_dre_custo_tipo_write_master ON public.fin_dre_custo_tipo;
CREATE POLICY fin_dre_custo_tipo_write_master ON public.fin_dre_custo_tipo
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

-- Service role bypass (edge/cron, caso um dia recompute server-side).
DROP POLICY IF EXISTS fin_dre_custo_tipo_service_all ON public.fin_dre_custo_tipo;
CREATE POLICY fin_dre_custo_tipo_service_all ON public.fin_dre_custo_tipo
  FOR ALL USING (auth.role() = 'service_role');

SELECT 'fin_dre_custo_tipo OK' AS status,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_dre_custo_tipo') AS policies;

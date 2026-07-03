-- ============================================================
-- gov_iniciativas — Painel Iceberg de iniciativas (programa "back to basics")
-- Cadastro do portfólio de iniciativas de melhoria: ganho esperado (pipeline
-- maturando, "abaixo da linha d'água") × ganho recorrente comprovado ("acima").
-- Método: uma iniciativa só vira 'recorrente' COM evidência registrada.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.gov_iniciativas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL CHECK (empresa IN ('colacor', 'oben', 'colacor_sc')),
  titulo text NOT NULL,
  descricao text,
  alavanca text NOT NULL DEFAULT 'outro'
    CHECK (alavanca IN ('receita', 'margem', 'custo', 'caixa', 'risco', 'outro')),
  dono_id uuid REFERENCES auth.users(id),
  -- R$/mês. NULL = sem estimativa/sem comprovação (ausente ≠ zero — nunca gravar 0 no lugar).
  ganho_esperado_mensal numeric,
  ganho_recorrente_mensal numeric,
  status text NOT NULL DEFAULT 'ideia'
    CHECK (status IN ('ideia', 'em_execucao', 'maturando', 'recorrente', 'pausada', 'cancelada')),
  inicio_em date,
  recorrente_desde date,
  evidencia text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Método iceberg: marcar 'recorrente' exige a evidência do ganho registrada.
  CONSTRAINT gov_iniciativas_recorrente_exige_evidencia
    CHECK (status <> 'recorrente' OR (evidencia IS NOT NULL AND btrim(evidencia) <> ''))
);

CREATE INDEX IF NOT EXISTS idx_gov_iniciativas_empresa_status
  ON public.gov_iniciativas(empresa, status);

-- updated_at automático
CREATE OR REPLACE FUNCTION public.gov_iniciativas_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gov_iniciativas_updated_at ON public.gov_iniciativas;
CREATE TRIGGER trg_gov_iniciativas_updated_at
  BEFORE UPDATE ON public.gov_iniciativas
  FOR EACH ROW EXECUTE FUNCTION public.gov_iniciativas_set_updated_at();

-- RLS (obrigatória em tabela nova)
ALTER TABLE public.gov_iniciativas ENABLE ROW LEVEL SECURITY;

-- Staff lê (transparência interna: employee + master)
DROP POLICY IF EXISTS "gov_iniciativas_select_staff" ON public.gov_iniciativas;
CREATE POLICY "gov_iniciativas_select_staff"
  ON public.gov_iniciativas FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid())
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

-- Master cria
DROP POLICY IF EXISTS "gov_iniciativas_insert_master" ON public.gov_iniciativas;
CREATE POLICY "gov_iniciativas_insert_master"
  ON public.gov_iniciativas FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid())
              AND role = 'master'::public.app_role)
  );

-- Master OU o dono atualizam (o dono mantém status/evidência da própria iniciativa;
-- o WITH CHECK impede o dono de repassar a linha pra outro dono_id)
DROP POLICY IF EXISTS "gov_iniciativas_update_master_ou_dono" ON public.gov_iniciativas;
CREATE POLICY "gov_iniciativas_update_master_ou_dono"
  ON public.gov_iniciativas FOR UPDATE
  USING (
    dono_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
               WHERE user_id = (SELECT auth.uid())
                 AND role = 'master'::public.app_role)
  )
  WITH CHECK (
    dono_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
               WHERE user_id = (SELECT auth.uid())
                 AND role = 'master'::public.app_role)
  );

-- Master deleta
DROP POLICY IF EXISTS "gov_iniciativas_delete_master" ON public.gov_iniciativas;
CREATE POLICY "gov_iniciativas_delete_master"
  ON public.gov_iniciativas FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid())
              AND role = 'master'::public.app_role)
  );

-- Edge functions / cron
DROP POLICY IF EXISTS "gov_iniciativas_service_all" ON public.gov_iniciativas;
CREATE POLICY "gov_iniciativas_service_all"
  ON public.gov_iniciativas FOR ALL
  USING ((SELECT auth.role()) = 'service_role');

-- PR-P1: Processo produtivo do cliente
CREATE TABLE IF NOT EXISTS public.customer_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Texto livre como vendedor descreve
  descricao_livre text NOT NULL,

  -- Estruturado pela IA via Claude tool use
  etapas jsonb,                  -- array de { ordem, nome, tipo, produtos[], parametros, observacoes }
  segmento text,                  -- detectado pela IA: 'moveleiro', 'automotivo', 'industrial', 'marcenaria_pequena', etc
  porte text,                     -- 'pequeno', 'medio', 'grande' (detectado por volumes mencionados)
  tags text[] DEFAULT '{}',       -- ['pu_2k', 'cabine', 'lixamento_manual']

  -- Metadados da estruturação
  ia_confidence numeric,          -- 0-1 (quão confiante a IA está)
  ia_gaps text[],                 -- coisas que faltam pra análise completa
  ia_structured_at timestamptz,

  -- Versionamento simples
  version integer NOT NULL DEFAULT 1,
  parent_id uuid REFERENCES public.customer_processes(id) ON DELETE SET NULL,
  is_current boolean NOT NULL DEFAULT true,  -- só 1 current por customer

  -- Auditoria
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index garantindo 1 current por cliente
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_processes_one_current
  ON public.customer_processes (customer_user_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_customer_processes_customer
  ON public.customer_processes (customer_user_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_customer_processes_segmento
  ON public.customer_processes (segmento, porte)
  WHERE is_current = true;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_customer_processes_updated_at ON public.customer_processes;
CREATE TRIGGER trg_customer_processes_updated_at
  BEFORE UPDATE ON public.customer_processes
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

-- RLS
ALTER TABLE public.customer_processes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_processes_select_staff" ON public.customer_processes
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "customer_processes_insert_staff" ON public.customer_processes
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "customer_processes_update_staff" ON public.customer_processes
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "customer_processes_delete_master" ON public.customer_processes
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

COMMENT ON TABLE public.customer_processes IS 'Processo produtivo do cliente — texto livre + estrutura JSON via IA. Foundation pra comparação (PR-P3) + sugestões em tempo real (PR-P4).';

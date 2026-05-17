CREATE TABLE IF NOT EXISTS public.standard_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação
  name text NOT NULL,                            -- "Sayerlack PU 2K alto padrão moveleiro"
  slug text UNIQUE,                              -- "sayerlack-pu-2k-alto-padrao-moveleiro" (gerado client-side)
  description text,                              -- 1-2 frases descritivas

  -- Categorização (mesmos eixos de customer_processes pra match)
  segmento text NOT NULL,                        -- 'moveleiro', 'automotivo', 'industrial', 'marcenaria_pequena', etc
  porte_alvo text[],                             -- ['pequeno', 'medio'] — processos servem pra múltiplos portes
  tags text[] DEFAULT '{}',                      -- ['pu_2k', 'cabine_pressurizada', 'alto_padrao']

  -- Conteúdo
  etapas jsonb NOT NULL,                         -- array de StandardProcessEtapa (extende ProcessEtapa com produtos_kb)
  expected_outcomes text[],                      -- ["acabamento alto brilho", "resistência química superior", "secagem rápida"]
  target_audience text,                          -- "Marcenarias 50-500 peças/mês com foco em móveis altos"
  prerequisites text[],                          -- ["cabine simples", "compressor 1HP+", "lixadeira"]

  -- Workflow draft/approval
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'published', 'archived')),
  status_notes text,                             -- razão de archive, feedback do reviewer

  -- Versionamento
  version integer NOT NULL DEFAULT 1,
  parent_id uuid REFERENCES public.standard_processes(id) ON DELETE SET NULL,

  -- Auditoria
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_standard_processes_status_segmento
  ON public.standard_processes (status, segmento, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_standard_processes_published_segmento
  ON public.standard_processes (segmento)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_standard_processes_slug
  ON public.standard_processes (slug);

DROP TRIGGER IF EXISTS trg_standard_processes_updated_at ON public.standard_processes;
CREATE TRIGGER trg_standard_processes_updated_at
  BEFORE UPDATE ON public.standard_processes
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

ALTER TABLE public.standard_processes ENABLE ROW LEVEL SECURITY;

-- Staff lê published; criador vê seus drafts; master vê tudo
CREATE POLICY "standard_processes_select_visible" ON public.standard_processes
  FOR SELECT
  USING (
    status = 'published'
    OR created_by = auth.uid()
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Staff pode criar (sempre como draft)
CREATE POLICY "standard_processes_insert_staff" ON public.standard_processes
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Criador edita drafts próprios; master edita qualquer
CREATE POLICY "standard_processes_update_owner_or_master" ON public.standard_processes
  FOR UPDATE
  USING (
    (created_by = auth.uid() AND status IN ('draft', 'in_review'))
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Só master deleta
CREATE POLICY "standard_processes_delete_master" ON public.standard_processes
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

COMMENT ON TABLE public.standard_processes IS 'Processos modelo da fábrica. Workflow draft→in_review→published. Cada etapa referencia kb_product_specs.product_code. Usado em PR-P3 (comparação) e PR-P4 (sugestões em tempo real).';

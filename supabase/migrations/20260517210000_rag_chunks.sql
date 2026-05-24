CREATE TABLE IF NOT EXISTS public.rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação do source
  source_table text NOT NULL CHECK (source_table IN ('customer_processes', 'standard_processes', 'kb_documents')),
  source_id uuid NOT NULL,

  -- Conteúdo
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),                       -- OpenAI text-embedding-3-small

  -- Metadata pra filtragem e UI
  metadata jsonb DEFAULT '{}'::jsonb,           -- { customer_user_id, segmento, porte, tags[], status }

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_table, source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding
  ON public.rag_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_source
  ON public.rag_chunks (source_table, source_id);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_metadata_segmento
  ON public.rag_chunks ((metadata->>'segmento'))
  WHERE source_table IN ('customer_processes', 'standard_processes');

ALTER TABLE public.rag_chunks ENABLE ROW LEVEL SECURITY;

-- Staff lê tudo. Insert/update/delete só via service role (edge functions).
CREATE POLICY "rag_chunks_select_staff" ON public.rag_chunks
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

COMMENT ON TABLE public.rag_chunks IS 'Union de chunks vetorizados de múltiplas fontes (customer_processes, standard_processes, kb_documents). Edge functions rag-reindex + rag-search usam pra busca semântica.';

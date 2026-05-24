-- PR6a: Knowledge Base foundation
-- pgvector + kb_documents + kb_chunks + bucket Storage + RLS

-- 1. Habilita pgvector (idempotente no Supabase)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Tabela de documentos
CREATE TABLE IF NOT EXISTS public.kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  type text NOT NULL CHECK (type IN ('boletim_tecnico', 'case', 'comparativo', 'tutorial', 'msds', 'outro')),
  supplier text,                              -- ex: 'sayerlack', 'farben', 'vernit'
  product_code text,                          -- ex: 'FO20.6827.00' — solto, FK virá em PR6b com kb_product_specs
  file_url text NOT NULL,                     -- caminho no bucket (não URL pública)
  file_size_bytes integer,
  content_extracted text,                     -- texto puro extraído (pdf-parse)
  tags text[] DEFAULT '{}',
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'error', 'draft')),
  status_error text,                          -- mensagem de erro se status='error'
  version integer NOT NULL DEFAULT 1,
  parent_id uuid REFERENCES public.kb_documents(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Chunks vetorizados
CREATE TABLE IF NOT EXISTS public.kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),                     -- OpenAI text-embedding-3-small
  token_count integer,
  char_start integer,
  char_end integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

-- 4. Index pra busca vetorial (ivfflat com 100 lists — ajustar quando >100k chunks)
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding
  ON public.kb_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 5. Indexes de query comum
CREATE INDEX IF NOT EXISTS idx_kb_documents_status_type
  ON public.kb_documents (status, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_document
  ON public.kb_chunks (document_id, chunk_index);

-- 6. Trigger updated_at
CREATE OR REPLACE FUNCTION public.kb_documents_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kb_documents_updated_at ON public.kb_documents;
CREATE TRIGGER trg_kb_documents_updated_at
  BEFORE UPDATE ON public.kb_documents
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

-- 7. RLS
ALTER TABLE public.kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;

-- 7a. kb_documents
-- Staff (employee/master) lê tudo. Usa public.has_role() helper (pattern do projeto
-- pra evitar recursão de RLS). Role data está em user_roles, não em profiles.role.
CREATE POLICY "kb_documents_select_staff" ON public.kb_documents
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Master pode insert/update/delete; employee pode insert (cria como draft) + update do que criou
CREATE POLICY "kb_documents_insert_staff" ON public.kb_documents
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "kb_documents_update_master" ON public.kb_documents
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'master'::app_role)
    OR created_by = auth.uid()
  );

CREATE POLICY "kb_documents_delete_master" ON public.kb_documents
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- 7b. kb_chunks: staff lê tudo, edge function (service role) escreve
CREATE POLICY "kb_chunks_select_staff" ON public.kb_chunks
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- INSERT/DELETE de chunks só via edge function (service role bypassa RLS)

-- 8. Storage bucket (criar via SQL se possível; senão, manual no console)
INSERT INTO storage.buckets (id, name, public)
VALUES ('knowledge-base', 'knowledge-base', false)
ON CONFLICT (id) DO NOTHING;

-- 8a. Policies do bucket: staff pode upload e read; delete só master
CREATE POLICY "kb_bucket_select_staff" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'knowledge-base'
    AND (
      public.has_role(auth.uid(), 'employee'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role)
    )
  );

CREATE POLICY "kb_bucket_insert_staff" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'knowledge-base'
    AND (
      public.has_role(auth.uid(), 'employee'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role)
    )
  );

CREATE POLICY "kb_bucket_delete_master" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'knowledge-base'
    AND public.has_role(auth.uid(), 'master'::app_role)
  );

-- 9. Comentários
COMMENT ON TABLE public.kb_documents IS 'Knowledge base: boletins técnicos, cases, comparativos. Indexa em kb_chunks pra RAG.';
COMMENT ON TABLE public.kb_chunks IS 'Chunks vetorizados pra busca semântica. Geração via edge function kb-ingest-document.';
COMMENT ON COLUMN public.kb_chunks.embedding IS 'OpenAI text-embedding-3-small (1536 dims).';

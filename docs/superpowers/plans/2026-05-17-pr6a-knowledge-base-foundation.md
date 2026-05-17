# PR6a — Knowledge Base Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Foundation da base de conhecimento. Admin sobe PDF (boletim técnico, case, comparativo) → app extrai texto + quebra em chunks + gera embeddings via OpenAI + salva tudo em pgvector. UI mínima de upload + listagem em `/admin/knowledge-base`. **Não inclui** extração de specs estruturados (PR6b), calculadora (PR6c), nem integração RAG no copilot (PR6d).

**Architecture:**
- Migration: pgvector extension + 2 tabelas (`kb_documents`, `kb_chunks`) + Storage bucket `knowledge-base` + RLS + index ivfflat
- Edge function `kb-ingest-document` (Deno): download PDF do Storage → pdf-parse → chunking (~500 tokens com overlap 50) → OpenAI embeddings → bulk insert em kb_chunks → update document status
- Client: hook `useUploadKbDocument` (upload file → create document row em status=processing → invoca edge function), hook `useKnowledgeBaseList`, página `/admin/knowledge-base` (lista + form de upload), página `/admin/knowledge-base/:id` (view básica do documento)
- Storage: bucket privado, signed URL pra preview, write-only via service role

**Tech Stack:**
- pgvector (Supabase nativo, basta CREATE EXTENSION)
- Anthropic SDK não usado nesta etapa (somente OpenAI pra embeddings; Claude entra em PR6b/d)
- Deno `npm:pdf-parse@1.1.1` (extração de texto de PDF)
- Deno `npm:openai@^4.65.0` (embeddings — usado server-side só, NUNCA no client)
- React Hook Form + Zod (form de upload — pattern já usado no projeto)

**Não-objetivos (próximos PRs):**
- Extração estruturada de specs (PR6b): Claude lê PDF e propõe `rendimento_m2_por_litro`, `pot_life_h`, etc.
- Calculadora `<Calculator>` no painel de chamada (PR6c)
- RAG: copilot consulta KB antes de gerar análise (PR6d)
- Battle cards e team insights (PR8)
- Versionamento de boletins (campo `parent_id` existe na tabela mas sem UI nesta etapa)
- OCR pra PDFs escaneados (pdf-parse falha graciosamente; OCR via Tesseract fica pra PR posterior se necessário)
- Re-ingest automático ao re-upar (delete chunks + re-process — simplifica usuário deletar + criar novo)

---

## File Structure

**Criar:**
- `supabase/migrations/{timestamp}_kb_foundation.sql` — pgvector + 2 tabelas + bucket + RLS
- `supabase/functions/kb-ingest-document/index.ts` — Deno edge function
- `supabase/functions/kb-ingest-document/chunk-text.ts` — pure helper (chunking)
- `src/hooks/useKnowledgeBaseList.ts` — query React Query
- `src/hooks/__tests__/useKnowledgeBaseList.test.tsx`
- `src/hooks/useUploadKbDocument.ts` — mutation: upload Storage + insert + invoke edge
- `src/lib/knowledge-base/types.ts` — KbDocument, KbDocumentStatus, KbDocumentType, etc.
- `src/components/knowledge-base/KbDocumentForm.tsx` — form de upload (RHF + Zod)
- `src/components/knowledge-base/KbDocumentRow.tsx` — linha da lista
- `src/components/knowledge-base/KbStatusBadge.tsx` — badge processing/ready/error
- `src/pages/AdminKnowledgeBase.tsx` — `/admin/knowledge-base`
- `src/pages/AdminKnowledgeBaseDetail.tsx` — `/admin/knowledge-base/:id`

**Modificar:**
- `src/integrations/supabase/types.ts` — adicionar `kb_documents` + `kb_chunks` (manual; Lovable regenera)
- `src/App.tsx` — lazy import + 2 rotas
- `src/components/AppShell.tsx` — item de menu "Base de Conhecimento" (seção Gestão ou Vendas)

**Não modificar:**
- `claude-spin-analyze` edge function (RAG fica pra PR6d)
- `WebRTCCallContext` (sem integração nesta etapa)
- `farmer_calls` (knowledge base é independente)

---

## Pré-requisito do operador

Antes do PR mergeable de ser útil em prod:
1. **Nova secret no Lovable Cloud**: `OPENAI_API_KEY`
   - Obter em https://platform.openai.com/api-keys
   - Cadastrar cartão (sem cobrança até atingir crédito; embeddings são baratíssimos)
2. **Rodar migration SQL** no Lovable Cloud SQL Editor
3. **Criar bucket `knowledge-base` em Storage** (privado) — a migration tenta criar via `storage.create_bucket()` mas se falhar, criar manual:
   - Storage → New bucket → name: `knowledge-base`, public: false
4. **Regenerar types Supabase**

Sem OPENAI_API_KEY → ingest retorna erro, documento fica em status='error', upload continua mas chunks ficam vazios. Graceful degradation.

---

## Task 1: Migration SQL

**Files:** Create `supabase/migrations/{timestamp}_kb_foundation.sql`

- [ ] **Step 1: Criar migration**

```sql
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
-- Staff (employee/master) lê tudo
CREATE POLICY "kb_documents_select_staff" ON public.kb_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('employee', 'master')
    )
  );

-- Master pode insert/update/delete; employee pode insert (cria como draft) + update do que criou
CREATE POLICY "kb_documents_insert_staff" ON public.kb_documents
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('employee', 'master')
    )
  );

CREATE POLICY "kb_documents_update_master" ON public.kb_documents
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.role = 'master'
    )
    OR created_by = auth.uid()
  );

CREATE POLICY "kb_documents_delete_master" ON public.kb_documents
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.role = 'master'
    )
  );

-- 7b. kb_chunks: staff lê tudo, edge function (service role) escreve
CREATE POLICY "kb_chunks_select_staff" ON public.kb_chunks
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('employee', 'master')
    )
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
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('employee', 'master')
    )
  );

CREATE POLICY "kb_bucket_insert_staff" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'knowledge-base'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('employee', 'master')
    )
  );

CREATE POLICY "kb_bucket_delete_master" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'knowledge-base'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.role = 'master'
    )
  );

-- 9. Comentários
COMMENT ON TABLE public.kb_documents IS 'Knowledge base: boletins técnicos, cases, comparativos. Indexa em kb_chunks pra RAG.';
COMMENT ON TABLE public.kb_chunks IS 'Chunks vetorizados pra busca semântica. Geração via edge function kb-ingest-document.';
COMMENT ON COLUMN public.kb_chunks.embedding IS 'OpenAI text-embedding-3-small (1536 dims).';
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260517170000_kb_foundation.sql
git commit -m "feat(kb): migration — pgvector + kb_documents + kb_chunks + storage bucket + RLS"
```

---

## Task 2: Types Supabase + types do app

**Files:**
- Modify: `src/integrations/supabase/types.ts` — manual (Lovable regenera depois)
- Create: `src/lib/knowledge-base/types.ts` — types do domain

- [ ] **Step 1: Adicionar `kb_documents` e `kb_chunks` em supabase/types.ts**

Buscar onde `farmer_calls` está e adicionar 2 entries similares (Row, Insert, Update) com os campos das tabelas novas. Manter `embedding` como `unknown` (vector type não é JSON nativo do TS).

```ts
kb_documents: {
  Row: {
    id: string
    title: string
    type: string
    supplier: string | null
    product_code: string | null
    file_url: string
    file_size_bytes: number | null
    content_extracted: string | null
    tags: string[]
    status: string
    status_error: string | null
    version: number
    parent_id: string | null
    created_by: string
    created_at: string
    updated_at: string
  }
  Insert: { /* todos opcionais exceto title, type, file_url, created_by */ }
  Update: { /* todos opcionais */ }
  Relationships: []
}

kb_chunks: {
  Row: {
    id: string
    document_id: string
    chunk_index: number
    content: string
    embedding: unknown   // vector type
    token_count: number | null
    char_start: number | null
    char_end: number | null
    created_at: string
  }
  Insert: { /* document_id, chunk_index, content required */ }
  Update: { /* opcionais */ }
  Relationships: [{ foreignKeyName, columns: ["document_id"], referencedRelation: "kb_documents", referencedColumns: ["id"], isOneToOne: false }]
}
```

- [ ] **Step 2: Criar `src/lib/knowledge-base/types.ts`**

```ts
export type KbDocumentStatus = 'processing' | 'ready' | 'error' | 'draft';

export type KbDocumentType =
  | 'boletim_tecnico'
  | 'case'
  | 'comparativo'
  | 'tutorial'
  | 'msds'
  | 'outro';

export interface KbDocument {
  id: string;
  title: string;
  type: KbDocumentType;
  supplier: string | null;
  product_code: string | null;
  file_url: string;
  file_size_bytes: number | null;
  content_extracted: string | null;
  tags: string[];
  status: KbDocumentStatus;
  status_error: string | null;
  version: number;
  parent_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const KB_DOCUMENT_TYPE_LABEL: Record<KbDocumentType, string> = {
  boletim_tecnico: 'Boletim técnico',
  case: 'Case',
  comparativo: 'Comparativo',
  tutorial: 'Tutorial',
  msds: 'MSDS / FISPQ',
  outro: 'Outro',
};

export const KB_DOCUMENT_STATUS_LABEL: Record<KbDocumentStatus, string> = {
  processing: 'Processando',
  ready: 'Pronto',
  error: 'Erro',
  draft: 'Rascunho',
};
```

- [ ] **Step 3: Verificar + Commit**

```bash
bun run tsc --noEmit
git add src/integrations/supabase/types.ts src/lib/knowledge-base/types.ts
git commit -m "feat(kb): supabase types + domain types (KbDocument, KbDocumentStatus, etc.)"
```

---

## Task 3: Helper `chunkText` (TDD)

**Files:**
- Create: `supabase/functions/kb-ingest-document/chunk-text.ts`
- Create: `src/lib/knowledge-base/chunk-text.test.ts` (mesma implementação rodada client-side pra testar)
- Create: `src/lib/knowledge-base/chunk-text.ts` (re-export ou cópia pra testar via vitest)

> **Decisão**: como Deno e Vite não compartilham módulos diretamente, duplicar arquivo em ambos lados é aceitável (chunking é pure function, simples). Manter sincronizado é trivial. Edge function importa de `./chunk-text.ts` no próprio dir; cliente nunca usa (mas testes ficam mais simples no vitest).

**Comportamento:** dado texto + opções `{ maxTokens, overlap }`, retorna array de `{ content, charStart, charEnd, tokenEstimate }`. Tokenização aproximada via heurística (1 token ≈ 4 chars em PT-BR).

- [ ] **Step 1: Testes** em `src/lib/knowledge-base/chunk-text.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { chunkText, type Chunk } from './chunk-text';

describe('chunkText', () => {
  it('texto vazio retorna array vazio', () => {
    expect(chunkText('', { maxTokens: 500, overlap: 50 })).toEqual([]);
  });

  it('texto pequeno (< maxTokens) retorna 1 chunk só', () => {
    const text = 'Boletim técnico do produto Sayerlack PU 6827.';
    const chunks = chunkText(text, { maxTokens: 500, overlap: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(text.length);
  });

  it('texto grande quebra em múltiplos chunks com overlap', () => {
    // ~2000 chars = ~500 tokens, dois chunks com maxTokens=300 (~1200 chars cada)
    const text = 'a'.repeat(2000);
    const chunks = chunkText(text, { maxTokens: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Cada chunk respeita maxTokens (* 4 chars/token)
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(300);
    }
  });

  it('overlap: chunks consecutivos compartilham conteúdo no fim/início', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunkText(sentences, { maxTokens: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: fim do chunk[0] aparece no início do chunk[1]
    const lastTextOfFirst = chunks[0].content.slice(-20);
    expect(chunks[1].content.startsWith(lastTextOfFirst.slice(0, 10))
      || chunks[1].content.includes(lastTextOfFirst.slice(0, 10))).toBe(true);
  });

  it('charStart/charEnd corretos pra reconstruir o texto original', () => {
    const text = 'parte um. parte dois. parte tres. parte quatro.';
    const chunks = chunkText(text, { maxTokens: 5, overlap: 2 });
    for (const c of chunks) {
      // O conteúdo está dentro do range
      expect(text.slice(c.charStart, c.charEnd)).toContain(c.content.trim().slice(0, 5));
    }
  });

  it('chunks têm chunk_index implícito (ordem do array)', () => {
    const text = 'Sentence A. Sentence B. Sentence C. Sentence D. Sentence E.'.repeat(20);
    const chunks = chunkText(text, { maxTokens: 30, overlap: 5 });
    // Ordem preservada (sem assertion explícita de index — quem chama enumerate via array.map)
    expect(chunks.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Falha**

```bash
bun run vitest run src/lib/knowledge-base/chunk-text.test.ts
```

- [ ] **Step 3: Implementação** (mesma em ambos os arquivos)

```ts
// src/lib/knowledge-base/chunk-text.ts (e supabase/functions/kb-ingest-document/chunk-text.ts)

export interface Chunk {
  content: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlap: number;
}

const CHARS_PER_TOKEN = 4; // heurística PT-BR aproximada (1 token ≈ 4 chars)

/**
 * Quebra texto em chunks de ~maxTokens com overlap de N tokens entre chunks consecutivos.
 *
 * Estratégia: greedy por caractere (não por sentence boundary). Suficiente pra boletim
 * técnico onde texto é estruturado e qualquer corte preserva semântica razoável.
 * Se for processar texto narrativo longo (caso/case), iterar pra split por sentença
 * em versão futura (refinamento, não bloqueante).
 */
export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  if (!text || text.length === 0) return [];

  const maxChars = opts.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlap * CHARS_PER_TOKEN;
  const stepChars = Math.max(1, maxChars - overlapChars);

  // Caso pequeno: 1 chunk só
  if (text.length <= maxChars) {
    return [{
      content: text,
      charStart: 0,
      charEnd: text.length,
      tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
    }];
  }

  const chunks: Chunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    const content = text.slice(pos, end);
    chunks.push({
      content,
      charStart: pos,
      charEnd: end,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
    });
    if (end >= text.length) break;
    pos += stepChars;
  }

  return chunks;
}
```

Copiar o arquivo TAMBÉM em `supabase/functions/kb-ingest-document/chunk-text.ts` (idêntico — Deno usa local import).

- [ ] **Step 4: Pass + Commit**

```bash
bun run vitest run src/lib/knowledge-base/chunk-text.test.ts
git add src/lib/knowledge-base/chunk-text.ts src/lib/knowledge-base/chunk-text.test.ts supabase/functions/kb-ingest-document/chunk-text.ts
git commit -m "feat(kb): chunkText helper — greedy split with token overlap"
```

---

## Task 4: Edge Function `kb-ingest-document`

**Files:** Create `supabase/functions/kb-ingest-document/index.ts`

**Comportamento:**
1. Recebe `{ documentId }` no body. Auth via `authorizeCronOrStaff` (precisa employee/master).
2. Busca o document no Supabase (`status='processing'` esperado).
3. Download PDF do Storage usando o `file_url` do document.
4. Extrai texto via `pdf-parse`.
5. Quebra em chunks via `chunkText`.
6. Pra cada chunk: chama OpenAI Embeddings API (`text-embedding-3-small`).
7. Bulk insert em `kb_chunks` via service role client.
8. Update document: `content_extracted = fullText`, `status = 'ready'`.
9. Em qualquer erro: update document com `status='error'`, `status_error = err.message`. Sempre retorna 200 com `{ ok, chunks_count }` (o cliente não bloqueia UI).

- [ ] **Step 1: Criar arquivo**

```ts
// supabase/functions/kb-ingest-document/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import OpenAI from "npm:openai@^4.65.0";
import pdfParse from "npm:pdf-parse@1.1.1";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { chunkText } from "./chunk-text.ts";

interface IngestRequest {
  documentId: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const openai = new OpenAI({ apiKey: openaiKey });

  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!body.documentId) {
    return new Response(JSON.stringify({ error: "documentId required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Helper: marca status='error' e retorna response
  async function markError(msg: string, statusCode = 500): Promise<Response> {
    await supabase.from("kb_documents")
      .update({ status: "error", status_error: msg.slice(0, 500) })
      .eq("id", body.documentId);
    console.error("[kb-ingest]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Fetch document
    const { data: doc, error: docErr } = await supabase
      .from("kb_documents")
      .select("id, file_url, status")
      .eq("id", body.documentId)
      .single();

    if (docErr || !doc) return markError(`Document not found: ${body.documentId}`, 404);

    // 2. Download PDF from Storage
    const { data: file, error: fileErr } = await supabase.storage
      .from("knowledge-base")
      .download(doc.file_url);

    if (fileErr || !file) return markError(`Failed to download PDF: ${fileErr?.message}`);

    const arrayBuffer = await file.arrayBuffer();
    const pdfBuffer = new Uint8Array(arrayBuffer);

    // 3. Extract text
    let pdfData;
    try {
      pdfData = await pdfParse(pdfBuffer);
    } catch (err) {
      return markError(`PDF parse failed: ${err instanceof Error ? err.message : "unknown"}`);
    }

    const fullText = (pdfData.text || "").trim();
    if (fullText.length === 0) {
      return markError("PDF has no extractable text (scanned image?)", 422);
    }

    // 4. Chunking
    const chunks = chunkText(fullText, { maxTokens: 500, overlap: 50 });
    if (chunks.length === 0) {
      return markError("Chunking produced 0 chunks");
    }

    // 5. Embed all chunks (single OpenAI request — batch)
    const embedResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks.map((c) => c.content),
    });

    if (!embedResp.data || embedResp.data.length !== chunks.length) {
      return markError(`Embedding count mismatch: ${embedResp.data?.length} vs ${chunks.length}`);
    }

    // 6. Bulk insert chunks
    const chunkRows = chunks.map((c, i) => ({
      document_id: body.documentId,
      chunk_index: i,
      content: c.content,
      embedding: embedResp.data[i].embedding,
      token_count: c.tokenEstimate,
      char_start: c.charStart,
      char_end: c.charEnd,
    }));

    const { error: insErr } = await supabase.from("kb_chunks").insert(chunkRows);
    if (insErr) return markError(`Insert chunks failed: ${insErr.message}`);

    // 7. Update document: ready + content_extracted
    const { error: updErr } = await supabase.from("kb_documents")
      .update({
        status: "ready",
        content_extracted: fullText.slice(0, 100_000), // cap pra evitar row gigante
        status_error: null,
      })
      .eq("id", body.documentId);

    if (updErr) return markError(`Update document failed: ${updErr.message}`);

    return new Response(
      JSON.stringify({
        ok: true,
        chunks_count: chunks.length,
        text_length: fullText.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return markError(msg);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/kb-ingest-document/index.ts
git commit -m "feat(kb): edge function kb-ingest-document (pdf-parse + chunk + OpenAI embeddings)"
```

> **NOTA**: edge function precisa de `SUPABASE_SERVICE_ROLE_KEY` (já disponível em Lovable Cloud env por default) + `OPENAI_API_KEY` (precisa adicionar). Lovable Cloud Secrets.

---

## Task 5: Hook `useKnowledgeBaseList` (TDD)

**Files:**
- Create: `src/hooks/useKnowledgeBaseList.ts`
- Create: `src/hooks/__tests__/useKnowledgeBaseList.test.tsx`

React Query hook que lista documentos paginados por status/type opcional.

- [ ] **Step 1-3**: Testes + impl seguindo pattern de `useCustomerCalls` (PR5). Filtros: opcionalmente `{ status?, type?, supplier? }`. Default: `status IN ('ready', 'processing')` (skip 'error' e 'draft').

```ts
// useKnowledgeBaseList.ts (skeleton)
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbDocument } from '@/lib/knowledge-base/types';

interface Filters {
  status?: string[];
  type?: string;
  supplier?: string;
}

export function useKnowledgeBaseList(filters: Filters = {}) {
  return useQuery({
    queryKey: ['kb-documents', filters],
    staleTime: 30_000,
    queryFn: async (): Promise<KbDocument[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase.from('kb_documents') as any).select('*');
      const statusList = filters.status ?? ['ready', 'processing'];
      q = q.in('status', statusList);
      if (filters.type) q = q.eq('type', filters.type);
      if (filters.supplier) q = q.eq('supplier', filters.supplier);
      q = q.order('created_at', { ascending: false }).limit(100);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as KbDocument[];
    },
  });
}
```

- [ ] **Step 4**: Commit

```bash
git add src/hooks/useKnowledgeBaseList.ts src/hooks/__tests__/useKnowledgeBaseList.test.tsx
git commit -m "feat(kb): useKnowledgeBaseList hook"
```

---

## Task 6: Hook `useUploadKbDocument` (mutation)

**Files:** Create `src/hooks/useUploadKbDocument.ts`

Mutation que:
1. Upload PDF pro Storage `knowledge-base/{user_id}/{timestamp}_{filename}` (path único)
2. Insert em `kb_documents` (`status='processing'`, `file_url=path`)
3. Invoca edge function `kb-ingest-document` (fire-and-forget — UI mostra status='processing' até resolver)
4. Invalida query `['kb-documents']`

```ts
// useUploadKbDocument.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { KbDocumentType } from '@/lib/knowledge-base/types';

interface UploadInput {
  file: File;
  title: string;
  type: KbDocumentType;
  supplier?: string;
  product_code?: string;
  tags?: string[];
}

export function useUploadKbDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadInput) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      const safeName = input.file.name.replace(/[^\w.\-]/g, '_');
      const path = `${user.id}/${Date.now()}_${safeName}`;

      // 1. Upload pro Storage
      const { error: upErr } = await supabase.storage
        .from('knowledge-base')
        .upload(path, input.file, { contentType: input.file.type || 'application/pdf' });
      if (upErr) throw upErr;

      // 2. Insert document
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: doc, error: insErr } = await (supabase.from('kb_documents') as any)
        .insert({
          title: input.title,
          type: input.type,
          supplier: input.supplier ?? null,
          product_code: input.product_code ?? null,
          file_url: path,
          file_size_bytes: input.file.size,
          tags: input.tags ?? [],
          status: 'processing',
          created_by: user.id,
        })
        .select('id')
        .single();
      if (insErr) throw insErr;

      // 3. Invoca edge function (fire-and-forget — UI atualizada por polling do status)
      invokeFunction('kb-ingest-document', { documentId: doc.id }).catch((err) => {
        console.error('[useUploadKbDocument] ingest invoke failed:', err);
      });

      return doc.id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-documents'] });
      toast.success('Documento enviado', { description: 'Processando texto e embeddings…' });
    },
    onError: (err) => {
      toast.error('Erro no upload', { description: err instanceof Error ? err.message : '' });
    },
  });
}
```

- [ ] Commit: `feat(kb): useUploadKbDocument mutation`

---

## Task 7: Componentes UI (form + row + status badge)

**Files:**
- Create: `src/components/knowledge-base/KbStatusBadge.tsx`
- Create: `src/components/knowledge-base/KbDocumentRow.tsx`
- Create: `src/components/knowledge-base/KbDocumentForm.tsx`

KbStatusBadge: badge colorido por status (processing=blue, ready=green, error=red, draft=gray).

KbDocumentRow: linha clickável navegando pra `/admin/knowledge-base/:id`. Mostra title, type, supplier, status, data, tags.

KbDocumentForm: Form RHF + Zod:
- Field: file (input file, accept=".pdf")
- Field: title (text)
- Field: type (select com `KB_DOCUMENT_TYPE_LABEL`)
- Field: supplier (text opcional)
- Field: product_code (text opcional)
- Field: tags (text input → split por vírgula)
- Submit → `useUploadKbDocument`

```tsx
// KbStatusBadge
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import type { KbDocumentStatus } from '@/lib/knowledge-base/types';

const COLOR: Record<KbDocumentStatus, string> = {
  processing: 'border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300',
  ready: 'border-status-success text-status-success',
  error: 'border-status-error text-status-error',
  draft: 'border-muted-foreground/30 text-muted-foreground',
};

const LABEL: Record<KbDocumentStatus, string> = {
  processing: 'Processando',
  ready: 'Pronto',
  error: 'Erro',
  draft: 'Rascunho',
};

export function KbStatusBadge({ status }: { status: KbDocumentStatus }) {
  return (
    <Badge variant="outline" className={`text-2xs gap-1 ${COLOR[status]}`}>
      {status === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {LABEL[status]}
    </Badge>
  );
}
```

```tsx
// KbDocumentRow
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { KbStatusBadge } from './KbStatusBadge';
import { FileText } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { KB_DOCUMENT_TYPE_LABEL, type KbDocument } from '@/lib/knowledge-base/types';

export function KbDocumentRow({ doc }: { doc: KbDocument }) {
  return (
    <Link to={`/admin/knowledge-base/${doc.id}`}>
      <Card className="p-3 hover:bg-muted/40 transition-colors flex items-center gap-3">
        <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{doc.title}</span>
            <Badge variant="outline" className="text-2xs">{KB_DOCUMENT_TYPE_LABEL[doc.type]}</Badge>
            {doc.supplier && <Badge variant="outline" className="text-2xs">{doc.supplier}</Badge>}
            <KbStatusBadge status={doc.status} />
          </div>
          <div className="text-2xs text-muted-foreground mt-0.5">
            {doc.product_code && <>{doc.product_code} · </>}
            {formatDistanceToNow(new Date(doc.created_at), { locale: ptBR, addSuffix: true })}
            {doc.tags.length > 0 && <> · {doc.tags.join(', ')}</>}
          </div>
        </div>
      </Card>
    </Link>
  );
}
```

```tsx
// KbDocumentForm — form de upload
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUploadKbDocument } from '@/hooks/useUploadKbDocument';
import { KB_DOCUMENT_TYPE_LABEL, type KbDocumentType } from '@/lib/knowledge-base/types';
import { Upload, Loader2 } from 'lucide-react';

const schema = z.object({
  title: z.string().min(3, 'Título muito curto'),
  type: z.enum(['boletim_tecnico', 'case', 'comparativo', 'tutorial', 'msds', 'outro']),
  supplier: z.string().optional(),
  product_code: z.string().optional(),
  tags: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props { onUploaded?: () => void; }

export function KbDocumentForm({ onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useUploadKbDocument();
  const { register, handleSubmit, formState: { errors }, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'boletim_tecnico' },
  });

  const onSubmit = (values: FormValues) => {
    if (!file) return;
    upload.mutate(
      {
        file,
        title: values.title,
        type: values.type as KbDocumentType,
        supplier: values.supplier || undefined,
        product_code: values.product_code || undefined,
        tags: values.tags ? values.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      },
      {
        onSuccess: () => {
          setFile(null);
          reset();
          onUploaded?.();
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <div>
        <Label htmlFor="file">Arquivo PDF</Label>
        <Input id="file" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <div className="text-2xs text-muted-foreground mt-1">{file.name} · {(file.size / 1024).toFixed(0)} KB</div>}
      </div>
      <div>
        <Label htmlFor="title">Título</Label>
        <Input id="title" {...register('title')} placeholder="Ex: Verniz PU 6827 — Boletim técnico" />
        {errors.title && <div className="text-2xs text-status-error mt-1">{errors.title.message}</div>}
      </div>
      <div>
        <Label htmlFor="type">Tipo</Label>
        <Select defaultValue="boletim_tecnico" onValueChange={(v) => register('type').onChange({ target: { name: 'type', value: v } })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(KB_DOCUMENT_TYPE_LABEL).map(([k, label]) => (
              <SelectItem key={k} value={k}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="supplier">Fornecedor</Label>
          <Input id="supplier" {...register('supplier')} placeholder="sayerlack, farben…" />
        </div>
        <div>
          <Label htmlFor="product_code">Código produto</Label>
          <Input id="product_code" {...register('product_code')} placeholder="FO20.6827.00" />
        </div>
      </div>
      <div>
        <Label htmlFor="tags">Tags (separe por vírgula)</Label>
        <Input id="tags" {...register('tags')} placeholder="madeira, pu, fosco" />
      </div>
      <Button type="submit" disabled={!file || upload.isPending} className="w-full">
        {upload.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> : <Upload className="w-3.5 h-3.5 mr-2" />}
        Enviar e indexar
      </Button>
    </form>
  );
}
```

- [ ] Commit: `feat(kb): KbStatusBadge + KbDocumentRow + KbDocumentForm components`

---

## Task 8: Páginas `/admin/knowledge-base` + detail

**Files:**
- Create: `src/pages/AdminKnowledgeBase.tsx`
- Create: `src/pages/AdminKnowledgeBaseDetail.tsx`
- Modify: `src/App.tsx` — 2 lazy rotas
- Modify: `src/components/AppShell.tsx` — item de menu

```tsx
// AdminKnowledgeBase
import { useState } from 'react';
import { useKnowledgeBaseList } from '@/hooks/useKnowledgeBaseList';
import { KbDocumentRow } from '@/components/knowledge-base/KbDocumentRow';
import { KbDocumentForm } from '@/components/knowledge-base/KbDocumentForm';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus, Loader2, FileText } from 'lucide-react';

export default function AdminKnowledgeBase() {
  const { data, isLoading } = useKnowledgeBaseList();
  const [open, setOpen] = useState(false);

  return (
    <div className="container mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Base de conhecimento</h1>
          <p className="text-xs text-muted-foreground">
            Boletins técnicos, cases e comparativos. Usado pelo copilot pra consultar dados precisos durante chamadas.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><Plus className="w-3.5 h-3.5" />Novo documento</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Subir documento</DialogTitle></DialogHeader>
            <KbDocumentForm onUploaded={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : !data || data.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
          Nenhum documento ainda. Suba o primeiro pra começar.
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((doc) => <KbDocumentRow key={doc.id} doc={doc} />)}
        </div>
      )}
    </div>
  );
}
```

```tsx
// AdminKnowledgeBaseDetail
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { KbStatusBadge } from '@/components/knowledge-base/KbStatusBadge';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Loader2 } from 'lucide-react';
import type { KbDocument } from '@/lib/knowledge-base/types';

export default function AdminKnowledgeBaseDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['kb-document', id],
    enabled: !!id,
    queryFn: async (): Promise<KbDocument | null> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('kb_documents') as any)
        .select('*').eq('id', id!).single();
      if (error) throw error;
      return data as KbDocument;
    },
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 3000 : false), // polling enquanto processa
  });

  const { data: chunkCount } = useQuery({
    queryKey: ['kb-chunks-count', id],
    enabled: !!id,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase.from('kb_chunks') as any)
        .select('*', { count: 'exact', head: true })
        .eq('document_id', id);
      return count ?? 0;
    },
  });

  if (isLoading) return <div className="container mx-auto p-4 flex justify-center"><Loader2 className="animate-spin" /></div>;
  if (!data) return <div className="container mx-auto p-4 text-xs text-muted-foreground">Documento não encontrado</div>;

  return (
    <div className="container mx-auto p-4 space-y-3 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">{data.title}</h1>
        <KbStatusBadge status={data.status} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-2xs">{data.type}</Badge>
        {data.supplier && <Badge variant="outline" className="text-2xs">{data.supplier}</Badge>}
        {data.product_code && <Badge variant="outline" className="text-2xs">{data.product_code}</Badge>}
        {data.tags.map((t) => <Badge key={t} variant="outline" className="text-2xs">{t}</Badge>)}
      </div>
      <div className="text-2xs text-muted-foreground">
        Enviado {format(new Date(data.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
        {data.file_size_bytes && <> · {(data.file_size_bytes / 1024).toFixed(0)} KB</>}
        {chunkCount !== undefined && <> · {chunkCount} chunks indexados</>}
      </div>

      {data.status === 'error' && data.status_error && (
        <Card className="p-3 border-status-error bg-status-error-bg/50">
          <div className="text-xs font-medium text-status-error">Erro no processamento</div>
          <div className="text-2xs text-muted-foreground font-mono mt-1">{data.status_error}</div>
        </Card>
      )}

      {data.content_extracted && (
        <Card className="p-3">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground mb-2">Texto extraído</div>
          <pre className="text-xs whitespace-pre-wrap font-sans text-foreground/80 max-h-96 overflow-y-auto">
            {data.content_extracted}
          </pre>
        </Card>
      )}
    </div>
  );
}
```

App.tsx + AppShell: adicionar rotas + item de menu na seção Gestão.

- [ ] Commit: `feat(kb): AdminKnowledgeBase pages + routes + menu`

---

## Task 9: QA + PR

- [ ] `bun run vitest run` (espera +6 chunkText + 3 useKbList = +9 → ~234)
- [ ] `bun run tsc --noEmit` clean
- [ ] `bun run build` passa
- [ ] Push + PR

---

## Self-Review

**1. Spec coverage:**

| Spec | Task |
|---|---|
| pgvector + schema | Task 1 |
| Upload PDF + Storage | Tasks 1 (bucket), 6 |
| Extração texto + chunking | Tasks 3, 4 |
| Embeddings OpenAI | Task 4 |
| UI lista + upload | Tasks 7, 8 |
| Status processing/ready/error | Tasks 7 (badge), 8 (polling) |

**2. Placeholder scan:** Sem TBD.

**3. Type consistency:**
- `KbDocument`, `KbDocumentStatus`, `KbDocumentType` em Task 2 → consumidos em Tasks 5, 6, 7, 8
- `Chunk` em Task 3 → consumido em Task 4
- Edge function tem `chunk-text.ts` local; cliente tem em `src/lib/knowledge-base/chunk-text.ts` — duplicado conscientemente

**4. Riscos:**
- **pdf-parse no Deno**: pode falhar com PDFs complexos/escaneados. Mitigação: try/catch → marca status='error'. OCR fica pra PR posterior se necessário.
- **OpenAI embeddings rate limit**: 1 request por documento = N chunks num batch só. Tier-1 OpenAI permite 3000 RPM, suficiente. Documentos com 100+ chunks podem exceder per-request limit (max 2048 items por request) — chunk count típico de boletim é 5-20, OK.
- **Storage bucket criação via SQL**: pode falhar dependendo da versão do Supabase. Plan documenta criação manual como fallback.
- **`as any` no `from('kb_*')`**: temporário até Lovable regenerar types.
- **Polling de status no detail page**: refetch 3s enquanto processing — pode ficar pendurado se ingest travou. Aceita; em PR posterior adicionar timeout client-side com botão "Tentar novamente".

---

## Execution Handoff

Plan salvo em `docs/superpowers/plans/2026-05-17-pr6a-knowledge-base-foundation.md`.

Execução: **Subagent-Driven**. Task 1 (migration) sozinha. Tasks 2, 3, 5, 6 podem ir em paralelo (independentes). Task 4 (edge function) depende de 3. Tasks 7, 8 dependem de 5, 6, 2.

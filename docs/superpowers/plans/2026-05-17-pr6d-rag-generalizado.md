# PR6d — RAG Generalizado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Engine de busca semântica que unifica conhecimento de **3 fontes**:
1. **Chunks de PDFs** indexados em `kb_chunks` (PR6a — boletins técnicos)
2. **Processos de clientes** em `customer_processes` (PR-P1 — descricao_livre + etapas estruturadas)
3. **Processos padrão** em `standard_processes` (PR-P2 — etapas + outcomes + descricao)

Foundation pra:
- **PR-P3**: comparação cliente vs padrão (busca lookalikes)
- **PR-P4**: real-time "buscar caminho" durante chamada quando cliente diz "queria reduzir secagem em 50%"
- **PR9**: cross-sell ao vivo

**Architecture:**
- Nova tabela union `rag_chunks (source_table, source_id, chunk_index, content, embedding vector(1536), metadata jsonb)` + ivfflat index — independente de `kb_chunks` (que fica legacy pra PDFs)
- Edge fn `rag-reindex` que recebe `{ source_table, source_id }` → busca conteúdo na tabela origem → chunk (helper reusado do PR6a) → embed (OpenAI text-embedding-3-small) → bulk insert em rag_chunks
- Edge fn `rag-search` que recebe `{ query, top_k, sources?, filters? }` → embed query → ANN em rag_chunks + (opcional) `kb_chunks` → retorna top_k unidos por distance, com hydration de metadata
- Hooks: `useReindexRag` (mutation fire-and-forget), `useRagSearch` (query)
- Wire: chama `reindexRag` no `onSuccess` de `useSaveCustomerProcess` (PR-P1) e `useSaveStandardProcess` (PR-P2) e `useApproveStandardProcess` quando status passa pra `published`

**Não-objetivos:**
- UI de busca pelo usuário (PR-P3/P4)
- Re-indexação batch de dados antigos — só novos saves disparam reindex; admin pode rodar SQL manual depois pra backfill se quiser
- Hybrid search (BM25 + vector) — só vector
- Re-rank com Cohere/Voyage — só ANN cosine similarity
- Limit de tokens no embed — cap em 8000 chars por chunk (text-embedding-3-small limita 8191 tokens; ~32000 chars)

---

## File Structure

**Criar:**
- `supabase/migrations/{ts}_rag_chunks.sql`
- `supabase/functions/rag-reindex/index.ts`
- `supabase/functions/rag-search/index.ts`
- `supabase/functions/_shared/chunk-text.ts` (helper compartilhado entre rag-reindex e kb-ingest — código já existe duplicado, vou consolidar)
- `src/hooks/useReindexRag.ts`
- `src/hooks/useRagSearch.ts`
- `src/lib/rag/types.ts` — `RagChunk`, `RagSearchResult`, `RagSource`, etc

**Modificar:**
- `src/hooks/useCustomerProcess.ts` — useSaveCustomerProcess dispara reindex no onSuccess
- `src/hooks/useSaveStandardProcess.ts` — dispara reindex no onSuccess
- `src/hooks/useApproveStandardProcess.ts` — dispara reindex quando status=published
- `src/integrations/supabase/types.ts` (manual rag_chunks)

---

## Task 1: Migration `rag_chunks`

```sql
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
```

Commit: `feat(rag): migration rag_chunks union table + ivfflat index`

---

## Task 2: Helper `chunk-text` shared

Mover `supabase/functions/kb-ingest-document/chunk-text.ts` pra `supabase/functions/_shared/chunk-text.ts`. Update `kb-ingest-document/index.ts` import.

Por simplicidade no plan: criar arquivo novo `_shared/chunk-text.ts` (cópia do `kb-ingest-document/chunk-text.ts`); deixar legacy file existir até refactor futuro. Não bloqueia rollout.

Commit: `feat(rag): chunk-text helper compartilhado em _shared`

---

## Task 3: Edge function `rag-reindex`

**File:** `supabase/functions/rag-reindex/index.ts`

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import OpenAI from "npm:openai@^4.65.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { chunkText } from "../_shared/chunk-text.ts";

interface Req {
  source_table: 'customer_processes' | 'standard_processes' | 'kb_documents';
  source_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Req;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.source_table || !body.source_id) {
    return new Response(JSON.stringify({ error: "source_table + source_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Buscar conteúdo + metadata da source
    let content = "";
    let metadata: Record<string, unknown> = {};

    if (body.source_table === 'customer_processes') {
      const { data, error } = await supabase
        .from('customer_processes')
        .select('id, customer_user_id, descricao_livre, etapas, segmento, porte, tags')
        .eq('id', body.source_id)
        .single();
      if (error || !data) throw new Error(`customer_processes not found: ${body.source_id}`);
      content = formatCustomerProcessForRag(data);
      metadata = {
        customer_user_id: data.customer_user_id,
        segmento: data.segmento,
        porte: data.porte,
        tags: data.tags,
      };
    } else if (body.source_table === 'standard_processes') {
      const { data, error } = await supabase
        .from('standard_processes')
        .select('id, name, description, segmento, porte_alvo, tags, etapas, expected_outcomes, target_audience, prerequisites, status')
        .eq('id', body.source_id)
        .single();
      if (error || !data) throw new Error(`standard_processes not found: ${body.source_id}`);
      // Só indexa se publicado
      if (data.status !== 'published') {
        // Remove chunks antigos se virou unpublished
        await supabase.from('rag_chunks').delete()
          .eq('source_table', body.source_table)
          .eq('source_id', body.source_id);
        return new Response(JSON.stringify({ ok: true, skipped: 'not published', deleted: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      content = formatStandardProcessForRag(data);
      metadata = {
        segmento: data.segmento,
        porte_alvo: data.porte_alvo,
        tags: data.tags,
        name: data.name,
      };
    } else if (body.source_table === 'kb_documents') {
      const { data, error } = await supabase
        .from('kb_documents')
        .select('id, title, type, supplier, product_code, content_extracted, tags')
        .eq('id', body.source_id)
        .single();
      if (error || !data) throw new Error(`kb_documents not found: ${body.source_id}`);
      content = data.content_extracted ?? '';
      metadata = {
        title: data.title,
        type: data.type,
        supplier: data.supplier,
        product_code: data.product_code,
        tags: data.tags,
      };
    } else {
      throw new Error(`Unsupported source_table: ${body.source_table}`);
    }

    if (!content.trim()) {
      // Limpa chunks antigos se conteúdo ficou vazio
      await supabase.from('rag_chunks').delete()
        .eq('source_table', body.source_table)
        .eq('source_id', body.source_id);
      return new Response(JSON.stringify({ ok: true, skipped: 'empty content', deleted: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Chunk
    const chunks = chunkText(content, { maxTokens: 500, overlap: 50 });

    // 3. Embed (batch)
    const openai = new OpenAI({ apiKey: openaiKey });
    const embedResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks.map((c) => c.content),
    });

    if (!embedResp.data || embedResp.data.length !== chunks.length) {
      throw new Error(`Embedding mismatch: ${embedResp.data?.length} vs ${chunks.length}`);
    }

    // 4. Replace chunks antigos
    await supabase.from('rag_chunks').delete()
      .eq('source_table', body.source_table)
      .eq('source_id', body.source_id);

    const rows = chunks.map((c, i) => ({
      source_table: body.source_table,
      source_id: body.source_id,
      chunk_index: i,
      content: c.content,
      embedding: embedResp.data[i].embedding,
      metadata,
    }));

    const { error: insErr } = await supabase.from('rag_chunks').insert(rows);
    if (insErr) throw insErr;

    return new Response(JSON.stringify({
      ok: true,
      chunks_count: chunks.length,
      text_length: content.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[rag-reindex]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ─── Formatters: serializam estrutura → texto pra embedding ───────────────

interface CustomerProcessRow {
  id: string;
  customer_user_id: string;
  descricao_livre: string;
  etapas: unknown;
  segmento: string | null;
  porte: string | null;
  tags: string[];
}

interface StandardProcessRow {
  id: string;
  name: string;
  description: string | null;
  segmento: string;
  porte_alvo: string[];
  tags: string[];
  etapas: unknown;
  expected_outcomes: string[];
  target_audience: string | null;
  prerequisites: string[];
  status: string;
}

interface ProcessEtapa {
  ordem: number;
  nome: string;
  tipo: string;
  produtos: string[];
  parametros: Record<string, number | null | undefined>;
  equipamentos: string[];
  observacoes: string;
}

function formatEtapa(e: ProcessEtapa): string {
  const parts = [`Etapa ${e.ordem} — ${e.nome} (${e.tipo})`];
  if (e.produtos?.length) parts.push(`Produtos: ${e.produtos.join(', ')}`);
  if (e.equipamentos?.length) parts.push(`Equipamentos: ${e.equipamentos.join(', ')}`);
  const params: string[] = [];
  if (e.parametros?.tempo_minutos) params.push(`tempo ${e.parametros.tempo_minutos}min`);
  if (e.parametros?.temperatura_c) params.push(`${e.parametros.temperatura_c}°C`);
  if (e.parametros?.umidade_pct) params.push(`${e.parametros.umidade_pct}%UR`);
  if (params.length) parts.push(`Parâmetros: ${params.join(', ')}`);
  if (e.observacoes) parts.push(`Obs: ${e.observacoes}`);
  return parts.join('. ');
}

function formatCustomerProcessForRag(row: CustomerProcessRow): string {
  const parts = [
    `Processo do cliente — Segmento: ${row.segmento ?? 'não informado'}, Porte: ${row.porte ?? 'não informado'}.`,
    `Tags: ${row.tags?.join(', ') ?? '(nenhuma)'}.`,
    '',
    'Descrição livre do vendedor:',
    row.descricao_livre,
  ];

  const etapas = Array.isArray(row.etapas) ? (row.etapas as ProcessEtapa[]) : [];
  if (etapas.length > 0) {
    parts.push('', 'Etapas estruturadas:');
    etapas.forEach((e) => parts.push(formatEtapa(e)));
  }

  return parts.join('\n');
}

function formatStandardProcessForRag(row: StandardProcessRow): string {
  const parts = [
    `Processo padrão "${row.name}" — Segmento: ${row.segmento}.`,
    row.description ? `Descrição: ${row.description}` : '',
    row.target_audience ? `Público alvo: ${row.target_audience}` : '',
    `Portes: ${row.porte_alvo.join(', ')}.`,
    `Tags: ${row.tags.join(', ')}.`,
  ].filter(Boolean);

  if (row.expected_outcomes.length > 0) {
    parts.push(`Resultados esperados: ${row.expected_outcomes.join('; ')}.`);
  }
  if (row.prerequisites.length > 0) {
    parts.push(`Pré-requisitos: ${row.prerequisites.join('; ')}.`);
  }

  const etapas = Array.isArray(row.etapas) ? (row.etapas as ProcessEtapa[]) : [];
  if (etapas.length > 0) {
    parts.push('', 'Etapas:');
    etapas.forEach((e) => parts.push(formatEtapa(e)));
  }

  return parts.join('\n');
}
```

Commit: `feat(rag): edge function rag-reindex (multi-source → embed → rag_chunks)`

---

## Task 4: Edge function `rag-search`

**File:** `supabase/functions/rag-search/index.ts`

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import OpenAI from "npm:openai@^4.65.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

interface SearchReq {
  query: string;
  top_k?: number;
  sources?: Array<'customer_processes' | 'standard_processes' | 'kb_documents'>;
  filters?: {
    segmento?: string;
    customer_user_id_in?: string[];
    exclude_customer_user_id?: string;     // pra lookalikes: excluir o próprio cliente
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: SearchReq;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.query || typeof body.query !== 'string') {
    return new Response(JSON.stringify({ error: "query required (string)" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const topK = body.top_k ?? 5;

  try {
    // 1. Embed query
    const openai = new OpenAI({ apiKey: openaiKey });
    const embedResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: body.query.slice(0, 8000),
    });
    const queryEmbedding = embedResp.data[0].embedding;

    // 2. Search via RPC (pgvector). Como rag_chunks RLS é staff-only, service role bypassa.
    // Construir SQL dinâmico com filters
    const sources = body.sources ?? ['customer_processes', 'standard_processes', 'kb_documents'];

    // Para evitar criar uma RPC SQL function, usamos REST + ordenação cliente-side
    // (não ótimo pra grande escala, mas suficiente pra MVP).
    // Em produção com volume, criar function `match_rag_chunks(query_embedding, top_k, filters)`.
    let q = supabase
      .from('rag_chunks')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select('source_table, source_id, chunk_index, content, metadata, embedding') as any;

    q = q.in('source_table', sources);

    if (body.filters?.segmento) {
      q = q.eq('metadata->>segmento', body.filters.segmento);
    }
    if (body.filters?.customer_user_id_in?.length) {
      q = q.in('metadata->>customer_user_id', body.filters.customer_user_id_in);
    }
    if (body.filters?.exclude_customer_user_id) {
      q = q.neq('metadata->>customer_user_id', body.filters.exclude_customer_user_id);
    }

    q = q.limit(200);                              // candidate pool antes do rank cliente-side
    const { data, error } = await q;
    if (error) throw error;

    if (!data || data.length === 0) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Rank por cosine similarity (cliente-side fallback)
    function dot(a: number[], b: number[]) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
    function norm(a: number[]) { return Math.sqrt(dot(a, a)); }
    function cosine(a: number[], b: number[]) { return dot(a, b) / (norm(a) * norm(b) + 1e-9); }

    interface Row {
      source_table: string;
      source_id: string;
      chunk_index: number;
      content: string;
      metadata: Record<string, unknown>;
      embedding: number[] | string;
    }

    const scored = (data as Row[])
      .map((r) => {
        const emb = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
        return {
          source_table: r.source_table,
          source_id: r.source_id,
          chunk_index: r.chunk_index,
          content: r.content,
          metadata: r.metadata,
          similarity: cosine(queryEmbedding, emb as number[]),
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    return new Response(JSON.stringify({ results: scored }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[rag-search]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

> **Nota performance**: o rank cliente-side com pool de 200 candidatos é OK até ~10k chunks. Quando crescer, criar RPC SQL `match_rag_chunks` usando `embedding <-> query_embedding` ORDER BY no Postgres.

Commit: `feat(rag): edge function rag-search (embed query + cosine rank)`

---

## Task 5: Types domain + hooks

**File:** `src/lib/rag/types.ts`:

```ts
export type RagSource = 'customer_processes' | 'standard_processes' | 'kb_documents';

export interface RagSearchResult {
  source_table: RagSource;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface RagSearchOptions {
  top_k?: number;
  sources?: RagSource[];
  filters?: {
    segmento?: string;
    customer_user_id_in?: string[];
    exclude_customer_user_id?: string;
  };
}
```

**File:** `src/hooks/useReindexRag.ts`:

```ts
import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import type { RagSource } from '@/lib/rag/types';

interface ReindexInput {
  source_table: RagSource;
  source_id: string;
}

/**
 * Mutation fire-and-forget pra reindexar uma fonte no rag_chunks.
 * Hooks de save (useSaveCustomerProcess, useSaveStandardProcess) chamam isso
 * no onSuccess via `reindex.mutate(...)` sem await.
 *
 * Erros não interrompem o flow do save — logam console.error.
 */
export function useReindexRag() {
  return useMutation({
    mutationFn: async (input: ReindexInput): Promise<void> => {
      await invokeFunction('rag-reindex', input);
    },
    onError: (err, input) => {
      console.error('[useReindexRag] failed for', input, err);
    },
  });
}
```

**File:** `src/hooks/useRagSearch.ts`:

```ts
import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import type { RagSearchOptions, RagSearchResult } from '@/lib/rag/types';

interface SearchInput {
  query: string;
  options?: RagSearchOptions;
}

/**
 * Mutation (não query) pra busca semântica. Mutation porque cada busca
 * é uma ação discreta com payload variável; cache só faria sentido com
 * key estável, e o consumidor (PR-P3/P4) controla quando chamar.
 */
export function useRagSearch() {
  return useMutation({
    mutationFn: async ({ query, options }: SearchInput): Promise<RagSearchResult[]> => {
      const res = await invokeFunction<{ results: RagSearchResult[] }>('rag-search', {
        query,
        top_k: options?.top_k ?? 5,
        sources: options?.sources,
        filters: options?.filters,
      });
      return res.results;
    },
  });
}
```

Commit: `feat(rag): hooks useReindexRag (mutation) + useRagSearch + types`

---

## Task 6: Wire reindex nos saves de processo

**Files:**
- Modify: `src/hooks/useCustomerProcess.ts` — onSuccess do `useSaveCustomerProcess` dispara `reindexRag({ source_table: 'customer_processes', source_id: data.id })`
- Modify: `src/hooks/useSaveStandardProcess.ts` — idem pra `standard_processes`
- Modify: `src/hooks/useApproveStandardProcess.ts` — quando status=`published`, dispara reindex; quando volta pra `draft` ou `archived`, dispara reindex também (edge fn detecta status≠published e DELETE chunks)

Padrão de wire em cada hook (pseudo):

```ts
import { useReindexRag } from './useReindexRag';

export function useSaveCustomerProcess() {
  const reindex = useReindexRag();
  return useMutation({
    // ... existing logic ...
    onSuccess: (data, variables) => {
      qc.invalidateQueries(...);
      toast.success(...);
      reindex.mutate({ source_table: 'customer_processes', source_id: data.id });
    },
  });
}
```

Commit: `feat(rag): wire reindex no save/approve dos processos`

---

## Task 7: QA + PR

- tsc clean
- tests ainda passando (sem novos testes — edge fns são integration-tested manual)
- bun build passa
- Push + PR

---

## Pré-requisito do operador

1. Rodar migration SQL `rag_chunks` no Lovable Cloud
2. `OPENAI_API_KEY` já configurada
3. Regenerar types Supabase

## Self-Review

**Spec coverage:**
- Multi-source via `rag_chunks (source_table, source_id, ...)` → Task 1
- Indexação automática no save → Task 6
- Search com filtros (segmento, exclude_self) → Task 4
- Não-published standard_processes não são indexados → Task 3 (guard)

**Riscos:**
- Cosine rank cliente-side é O(candidates). Pool de 200 OK até ~10k chunks. Acima disso, criar RPC SQL.
- Fire-and-forget reindex: se OpenAI cair, save volta erro mas reindex falha silencioso. Aceito; manualmente re-roda depois.
- `metadata->>customer_user_id` filter exige índice expression; criamos só pra `segmento`. Volume baixo no MVP — OK.

---

## Execution Handoff

Plan salvo em `docs/superpowers/plans/2026-05-17-pr6d-rag-generalizado.md`.

Execução: **Subagent-Driven** com paralelismo. Tasks 1, 2, 3, 4, 5 podem ir em paralelo (independentes). Task 6 sequencial depois.

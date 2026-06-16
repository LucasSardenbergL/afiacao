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
    exclude_customer_user_id?: string;
  };
}

interface Row {
  source_table: string;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[] | string;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b) + 1e-9);
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
    const openai = new OpenAI({ apiKey: openaiKey });
    const embedResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: body.query.slice(0, 8000),
    });
    const queryEmbedding = embedResp.data[0].embedding;

    const sources = body.sources ?? ['customer_processes', 'standard_processes', 'kb_documents'];

    let q = supabase
      .from('rag_chunks')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- filtros JSON-path (metadata->>x) não existem nos tipos gerados; cast no boundary do PostgREST
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

    q = q.limit(200);
    const { data, error } = await q;
    if (error) throw error;

    if (!data || data.length === 0) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

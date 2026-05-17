import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import OpenAI from "npm:openai@^4.65.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { chunkText } from "../_shared/chunk-text.ts";

interface Req {
  source_table: 'customer_processes' | 'standard_processes' | 'kb_documents';
  source_id: string;
}

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
    let content = "";
    let metadata: Record<string, unknown> = {};

    if (body.source_table === 'customer_processes') {
      const { data, error } = await supabase
        .from('customer_processes')
        .select('id, customer_user_id, descricao_livre, etapas, segmento, porte, tags')
        .eq('id', body.source_id)
        .single();
      if (error || !data) throw new Error(`customer_processes not found: ${body.source_id}`);
      content = formatCustomerProcessForRag(data as CustomerProcessRow);
      metadata = {
        customer_user_id: (data as CustomerProcessRow).customer_user_id,
        segmento: (data as CustomerProcessRow).segmento,
        porte: (data as CustomerProcessRow).porte,
        tags: (data as CustomerProcessRow).tags,
      };
    } else if (body.source_table === 'standard_processes') {
      const { data, error } = await supabase
        .from('standard_processes')
        .select('id, name, description, segmento, porte_alvo, tags, etapas, expected_outcomes, target_audience, prerequisites, status')
        .eq('id', body.source_id)
        .single();
      if (error || !data) throw new Error(`standard_processes not found: ${body.source_id}`);
      const row = data as StandardProcessRow;
      if (row.status !== 'published') {
        await supabase.from('rag_chunks').delete()
          .eq('source_table', body.source_table)
          .eq('source_id', body.source_id);
        return new Response(JSON.stringify({ ok: true, skipped: 'not published', deleted: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      content = formatStandardProcessForRag(row);
      metadata = {
        segmento: row.segmento,
        porte_alvo: row.porte_alvo,
        tags: row.tags,
        name: row.name,
      };
    } else if (body.source_table === 'kb_documents') {
      const { data, error } = await supabase
        .from('kb_documents')
        .select('id, title, type, supplier, product_code, content_extracted, tags')
        .eq('id', body.source_id)
        .single();
      if (error || !data) throw new Error(`kb_documents not found: ${body.source_id}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = data as any;
      content = row.content_extracted ?? '';
      metadata = {
        title: row.title,
        type: row.type,
        supplier: row.supplier,
        product_code: row.product_code,
        tags: row.tags,
      };
    } else {
      throw new Error(`Unsupported source_table: ${body.source_table}`);
    }

    if (!content.trim()) {
      await supabase.from('rag_chunks').delete()
        .eq('source_table', body.source_table)
        .eq('source_id', body.source_id);
      return new Response(JSON.stringify({ ok: true, skipped: 'empty content', deleted: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const chunks = chunkText(content, { maxTokens: 500, overlap: 50 });

    const openai = new OpenAI({ apiKey: openaiKey });
    const embedResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks.map((c) => c.content),
    });

    if (!embedResp.data || embedResp.data.length !== chunks.length) {
      throw new Error(`Embedding mismatch: ${embedResp.data?.length} vs ${chunks.length}`);
    }

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

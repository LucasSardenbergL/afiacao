// supabase/functions/kb-ingest-document/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";
import OpenAI from "npm:openai@^4.65.0";
import pdfParse from "npm:pdf-parse@1.1.1";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { exigirDonoPelaRls } from "../_shared/dono-pela-rls.ts";
import { chunkText } from "./chunk-text.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

interface IngestRequest {
  documentId: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // SONDA DE VERSÃO — depois do gate (o cron a alcança pelo `x-cron-secret`) e ANTES de qualquer
  // credencial, leitura ou escrita. O corpo é lido UMA vez, aqui; `undefined` marca JSON inválido,
  // que segue respondendo 400 no ponto de sempre, mais abaixo.
  const corpoBruto: unknown = await req.json().catch(() => undefined);
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") {
    return new Response(JSON.stringify(respostaSonda(VERSAO)), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (decisaoSonda.tipo === "ambiguo") {
    return new Response(
      JSON.stringify({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (corpoBruto === undefined) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const body = (corpoBruto ?? {}) as IngestRequest;

  if (!body.documentId) {
    return new Response(JSON.stringify({ error: "documentId required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Gate de DONO (scanner Lovable, lote 5). Daqui para baixo tudo roda com service-role, que ignora
  // a RLS — inclusive o `markError`, que também escreve. Staff só passa se a policy de UPDATE de
  // `kb_documents` (master OU autor) deixa ESTE usuário alterar ESTE documento; quem responde é o
  // banco, com o JWT dele. cron e service_role não têm usuário e seguem como antes. A recusa sai
  // ANTES de o cliente service-role existir: nenhuma leitura, embedding ou escrita vem antes.
  const dono = await exigirDonoPelaRls(req, auth, "kb_documents", body.documentId);
  if (!dono.ok) return dono.response;

  const supabase = createClient(supabaseUrl, serviceKey);
  const openai = new OpenAI({ apiKey: openaiKey });

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

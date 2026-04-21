// Edge Function: promocao-extrair-via-vision
// Recebe PDF ou imagem de promoção de fornecedor OU de aviso de aumento de preços,
// extrai estrutura via Lovable AI Gateway (Gemini Pro Vision),
// grava campanha (promoção) ou registra aumento (RPC) conforme tipo_documento.
//
// Body:
// {
//   empresa: string,
//   fornecedor_nome: string,
//   arquivo_base64: string,
//   arquivo_tipo: 'pdf'|'image/jpeg'|'image/png',
//   tipo_documento?: 'campanha_sayerlack' | 'aumento',  // default 'campanha_sayerlack'
//   origem_email?: { remetente?: string, assunto?: string, data?: string },
//   criado_por?: string
// }
//
// Modo: best-effort. Sempre grava algo, mesmo quando incerto.
// Campos com baixa confiança são flagados em extracao_observacoes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const VISION_MODEL = "google/gemini-2.5-pro";

// Prompt de extração — calibrado para promoções Sayerlack no padrão DES
const EXTRACTION_PROMPT = `Você está analisando uma imagem ou PDF de promoção de produtos do fornecedor Sayerlack (programa DES - Distribuidores Exclusivos).

Extraia as informações estruturadas da promoção e retorne APENAS JSON válido, sem markdown, sem explicação, sem wrapper de código. O JSON deve seguir exatamente este schema:

{
  "nome": "string - nome descritivo da campanha (ex: 'DES Promo Abril 2ª Quinzena 2026')",
  "data_inicio": "YYYY-MM-DD",
  "data_fim": "YYYY-MM-DD",
  "fornecedor_nome": "string - nome do fornecedor se identificável",
  "items": [
    {
      "codigo_fornecedor": "string - código do produto (ex: 'DR.4403', 'FL.6269.02')",
      "descricao": "string ou null - descrição se visível",
      "desconto_perc": "number - percentual de desconto (ex: 20 para 20%)",
      "volume_minimo": "number ou null - quantidade mínima se houver condição de volume, senão null"
    }
  ],
  "confianca": "number entre 0 e 1 - seu nível de confiança geral na extração",
  "observacoes": "string - qualquer observação relevante, ambiguidade, texto não identificado, etc."
}

REGRAS IMPORTANTES:
1. Se a promoção menciona "1ª quinzena", data_inicio = dia 1 e data_fim = dia 15 do mês referência
2. Se "2ª quinzena", data_inicio = dia 16 e data_fim = último dia do mês
3. Se mencionar apenas "mês de X", considerar dia 1 ao último dia desse mês
4. Códigos de produto seguem padrões como DR.XXXX, FL.XXXX.XX, YL.XXXX.NTR, YLO4.XXXX.XX — mantenha EXATAMENTE como aparecem (case, pontos, números)
5. Se o ano não estiver claro, use o ano atual
6. Se não conseguir identificar algum campo obrigatório, use null e anote em observacoes
7. Ajuste confianca para baixo (< 0.7) se houver ambiguidade significativa
8. Retorne APENAS o JSON, nada mais`;

interface ExtractedPromo {
  nome: string;
  data_inicio: string;
  data_fim: string;
  fornecedor_nome: string;
  items: Array<{
    codigo_fornecedor: string;
    descricao: string | null;
    desconto_perc: number;
    volume_minimo: number | null;
  }>;
  confianca: number;
  observacoes: string;
}

// ============= AUMENTO =============
const AUMENTO_PROMPT = `Este documento anuncia reajustes de preços do fornecedor Renner Sayerlack. Extraia:
- Nome do anúncio / assunto
- Data em que o novo preço começa a valer (data_vigencia, formato YYYY-MM-DD)
- Data em que o anúncio foi feito (data_anuncio, se houver)
- Lista de categorias afetadas, com nome exato como no documento e percentual de aumento
- Se alguma categoria tem data de vigência específica diferente do geral, registre-a
- Confiança na extração (0-1)
- Observações sobre ambiguidades ou dados faltantes

Retorne APENAS JSON no formato exato:
{
  "nome": "...",
  "data_vigencia": "YYYY-MM-DD",
  "data_anuncio": "YYYY-MM-DD ou null",
  "categorias": [
    { "categoria_fornecedor": "...", "aumento_perc": 5.0, "data_vigencia_especifica": null }
  ],
  "confianca": 0.95,
  "observacoes": "..."
}`;

interface ExtractedAumento {
  nome: string;
  data_vigencia: string;
  data_anuncio: string | null;
  categorias: Array<{
    categoria_fornecedor: string;
    aumento_perc: number;
    data_vigencia_especifica: string | null;
  }>;
  confianca: number;
  observacoes: string;
}

function fallbackExtraction(reason: string, rawText = ""): ExtractedPromo {
  const today = new Date().toISOString().slice(0, 10);
  return {
    nome: `Promoção não identificada — ${today}`,
    data_inicio: today,
    data_fim: today,
    fornecedor_nome: "DESCONHECIDO",
    items: [],
    confianca: 0,
    observacoes:
      `${reason}` +
      (rawText ? ` Resposta bruta: ${rawText.slice(0, 500)}` : ""),
  };
}

function fallbackAumento(reason: string, rawText = ""): ExtractedAumento {
  const today = new Date().toISOString().slice(0, 10);
  return {
    nome: `Aumento não identificado — ${today}`,
    data_vigencia: today,
    data_anuncio: null,
    categorias: [],
    confianca: 0,
    observacoes:
      `${reason}` +
      (rawText ? ` Resposta bruta: ${rawText.slice(0, 500)}` : ""),
  };
}

async function callVisionRaw(
  fileBase64: string,
  fileType: string,
  prompt: string,
): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new Error("LOVABLE_API_KEY não configurada");

  // Normaliza media_type: pdf, image/jpeg, image/png, image/webp
  const normalizedType = fileType === "pdf" || fileType === "application/pdf"
    ? "application/pdf"
    : fileType;

  const dataUri = `data:${normalizedType};base64,${fileBase64}`;

  const response = await fetch(LOVABLE_AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUri } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 429) {
      throw new Error(
        `Lovable AI rate limit atingido (429). Tente novamente em alguns segundos.`,
      );
    }
    if (response.status === 402) {
      throw new Error(
        `Lovable AI sem créditos (402). Adicione créditos em Settings > Workspace > Usage.`,
      );
    }
    throw new Error(
      `Lovable AI erro ${response.status}: ${errText.slice(0, 300)}`,
    );
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function stripJsonFences(textResponse: string): string {
  let cleaned = textResponse.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

async function callVisionGateway(
  fileBase64: string,
  fileType: string,
): Promise<ExtractedPromo> {
  const textResponse = await callVisionRaw(fileBase64, fileType, EXTRACTION_PROMPT);
  const cleaned = stripJsonFences(textResponse);
  try {
    const parsed = JSON.parse(cleaned) as ExtractedPromo;
    if (!Array.isArray(parsed.items)) parsed.items = [];
    if (typeof parsed.confianca !== "number") parsed.confianca = 0;
    if (!parsed.observacoes) parsed.observacoes = "";
    return parsed;
  } catch (err) {
    return fallbackExtraction(
      `ERRO PARSING: ${String(err).slice(0, 200)}.`,
      textResponse,
    );
  }
}

async function callVisionGatewayAumento(
  fileBase64: string,
  fileType: string,
): Promise<ExtractedAumento> {
  const textResponse = await callVisionRaw(fileBase64, fileType, AUMENTO_PROMPT);
  const cleaned = stripJsonFences(textResponse);
  try {
    const parsed = JSON.parse(cleaned) as ExtractedAumento;
    if (!Array.isArray(parsed.categorias)) parsed.categorias = [];
    if (typeof parsed.confianca !== "number") parsed.confianca = 0;
    if (!parsed.observacoes) parsed.observacoes = "";
    if (!parsed.data_anuncio) parsed.data_anuncio = null;
    return parsed;
  } catch (err) {
    return fallbackAumento(
      `ERRO PARSING: ${String(err).slice(0, 200)}.`,
      textResponse,
    );
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "body inválido (JSON)" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const empresa = (body.empresa as string) ?? "OBEN";
  const fornecedorNomeFallback =
    (body.fornecedor_nome as string) ?? "RENNER SAYERLACK S/A";
  const arquivoBase64 = body.arquivo_base64 as string | undefined;
  const arquivoTipo = (body.arquivo_tipo as string) ?? "pdf";
  const origemEmail = body.origem_email as
    | { remetente?: string; assunto?: string; data?: string }
    | undefined;
  const criadoPor = (body.criado_por as string) ?? "extrator_vision";

  if (!arquivoBase64) {
    return new Response(
      JSON.stringify({ error: "arquivo_base64 obrigatório" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  console.log(
    `[promocao-extrair-via-vision] start empresa=${empresa} tipo=${arquivoTipo} bytes_b64=${arquivoBase64.length}`,
  );

  // 1. Chama Vision via Lovable AI Gateway
  let extracted: ExtractedPromo;
  try {
    extracted = await callVisionGateway(arquivoBase64, arquivoTipo);
  } catch (err) {
    const msg = String(err).slice(0, 300);
    console.error(`[promocao-extrair-via-vision] vision falhou: ${msg}`);
    return new Response(
      JSON.stringify({ error: `Vision falhou: ${msg}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // 2. Salva arquivo no Storage (bucket 'promocoes') para rastreabilidade
  const ext = arquivoTipo === "pdf" || arquivoTipo === "application/pdf"
    ? "pdf"
    : arquivoTipo === "image/png"
    ? "png"
    : arquivoTipo === "image/webp"
    ? "webp"
    : "jpg";
  const fileName = `${empresa}/${Date.now()}_${
    Math.random().toString(36).slice(2, 8)
  }.${ext}`;
  const fileBytes = Uint8Array.from(atob(arquivoBase64), (c) => c.charCodeAt(0));
  const contentType = arquivoTipo === "pdf" || arquivoTipo === "application/pdf"
    ? "application/pdf"
    : arquivoTipo;

  const { error: uploadErr } = await supabase.storage
    .from("promocoes")
    .upload(fileName, fileBytes, { contentType });
  if (uploadErr) {
    console.error(
      `[promocao-extrair-via-vision] upload falhou: ${uploadErr.message}`,
    );
  }
  const arquivoUrl = uploadErr ? null : fileName;

  // 3. Cria campanha em rascunho
  const { data: campanha, error: campErr } = await supabase
    .from("promocao_campanha")
    .insert({
      empresa,
      fornecedor_nome: extracted.fornecedor_nome || fornecedorNomeFallback,
      nome: extracted.nome,
      tipo_origem: "fornecedor_impoe",
      data_inicio: extracted.data_inicio,
      data_fim: extracted.data_fim,
      estado: "rascunho",
      origem_arquivo_url: arquivoUrl,
      origem_arquivo_tipo: arquivoTipo,
      origem_email_assunto: origemEmail?.assunto ?? null,
      origem_email_remetente: origemEmail?.remetente ?? null,
      origem_email_data: origemEmail?.data ?? null,
      extracao_confianca: extracted.confianca,
      extracao_observacoes: extracted.observacoes,
      extraido_em: new Date().toISOString(),
      criado_por: criadoPor,
    })
    .select()
    .single();

  if (campErr || !campanha) {
    console.error(
      `[promocao-extrair-via-vision] erro ao criar campanha: ${campErr?.message}`,
    );
    return new Response(
      JSON.stringify({
        error: `erro ao criar campanha: ${campErr?.message ?? "desconhecido"}`,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // 4. Cria itens — para cada um, tenta resolver SKU via função do banco
  const itensResults: Array<{
    codigo: string;
    inserido: boolean;
    erro: string | null;
    sku_omie: number | null;
    mapeamento: string;
  }> = [];

  for (const item of extracted.items) {
    const { data: resolucao, error: resolveErr } = await supabase.rpc(
      "resolver_sku_por_codigo_fornecedor",
      {
        p_empresa: empresa,
        p_codigo_fornecedor: item.codigo_fornecedor,
      },
    );

    if (resolveErr) {
      console.warn(
        `[promocao-extrair-via-vision] resolver falhou para ${item.codigo_fornecedor}: ${resolveErr.message}`,
      );
    }

    const r = resolucao as
      | {
          qualidade?: string;
          omie_codigo_produto?: number;
          candidatos?: unknown;
        }
      | null;
    const qualidade = r?.qualidade ?? "nao_encontrado";
    const skuOmie = qualidade === "unico" ? r?.omie_codigo_produto ?? null : null;
    const candidatos = qualidade === "ambiguo" ? r?.candidatos ?? null : null;

    const { error: itemErr } = await supabase
      .from("promocao_item")
      .insert({
        campanha_id: campanha.id,
        sku_codigo_fornecedor: item.codigo_fornecedor,
        descricao_produto_fornecedor: item.descricao,
        sku_codigo_omie: skuOmie,
        mapeamento_qualidade: qualidade,
        mapeamento_candidatos: candidatos,
        desconto_perc: item.desconto_perc,
        volume_minimo: item.volume_minimo,
        confirmado: false, // só humano confirma
      });

    itensResults.push({
      codigo: item.codigo_fornecedor,
      inserido: !itemErr,
      erro: itemErr?.message ?? null,
      sku_omie: skuOmie,
      mapeamento: qualidade,
    });
  }

  console.log(
    `[promocao-extrair-via-vision] OK campanha=${campanha.id} items=${extracted.items.length} confianca=${extracted.confianca}`,
  );

  return new Response(
    JSON.stringify({
      ok: true,
      campanha_id: campanha.id,
      extracao: {
        confianca: extracted.confianca,
        observacoes: extracted.observacoes,
        items_extraidos: extracted.items.length,
      },
      items: itensResults,
      arquivo_url: arquivoUrl,
      proximo_passo:
        `Revisar em /admin/reposicao/promocoes/${campanha.id}`,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    },
  );
});

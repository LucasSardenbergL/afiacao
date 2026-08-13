// Edge Function: promocao-extrair-via-vision
// Recebe PDF ou imagem de promoção de fornecedor OU de aviso de aumento de preços,
// extrai estrutura via Anthropic (claude-sonnet-4-6, vision + forced tool-use),
// grava campanha (promoção) ou registra aumento (RPC) conforme tipo_documento.
//
// Migrada do gateway Lovable/Gemini (LOVABLE_API_KEY) para a Anthropic direto:
// o gateway tem teto próprio de créditos ("AI features usage limit") que derruba
// a extração de promoção quando estoura. Contrato de request/response inalterado.
//
// Body:
// {
//   empresa: string,
//   fornecedor_nome: string,
//   arquivo_base64: string,
//   arquivo_tipo: 'pdf'|'image/jpeg'|'image/png'|'image/webp'|'image/gif',
//   tipo_documento?: 'campanha_sayerlack' | 'aumento',  // default 'campanha_sayerlack'
//   origem_email?: { remetente?: string, assunto?: string, data?: string },
//   criado_por?: string
// }
//
// Modo: best-effort. Sempre grava algo, mesmo quando incerto — campos de baixa
// confiança são flagados em extracao_observacoes para revisão humana.
// EXCEÇÃO money-path: resposta truncada (stop_reason=max_tokens) NÃO grava —
// lista parcial de descontos gravada como completa é pior que não gravar.

import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
// ⚠️ usar npm: (igual a kb-extract-specs/tarefa-extrair-voz/etc.). O esm.sh/@supabase/supabase-js
// falhava em resolver no boot do edge runtime → RUNTIME_ERROR sem linha/stack.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import {
  anotarRejeicoes,
  type BlocoAnexo,
  dataValida,
  montarBlocoAnexo,
  normalizarCategoriasAumento,
  normalizarConfianca,
  normalizarItensPromo,
} from "./vision-helpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MODELO = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;

// ============= PROMOÇÃO =============
const SYSTEM_PROMOCAO =
  `Você analisa imagens e PDFs de promoções de produtos do fornecedor Sayerlack (programa DES — Distribuidores Exclusivos) e extrai a estrutura da campanha.

REGRAS
1. "1ª quinzena" → data_inicio = dia 1, data_fim = dia 15 do mês de referência.
2. "2ª quinzena" → data_inicio = dia 16, data_fim = último dia do mês.
3. "mês de X" → dia 1 ao último dia desse mês.
4. Códigos de produto seguem padrões como DR.XXXX, FL.XXXX.XX, YL.XXXX.NTR, YLO4.XXXX.XX — copie EXATAMENTE como aparecem (caixa, pontos, números). Não normalize, não corrija.
5. Ano não explícito → use o ano corrente.
6. Campo que você não conseguir ler: omita o item ou use null, e explique em observacoes. NUNCA chute um percentual de desconto — desconto errado vira preço errado.
7. confianca < 0.7 quando houver ambiguidade relevante.

Use SEMPRE a tool registrar_promocao. Não responda em texto fora dela.`;

const TOOL_PROMOCAO = {
  name: "registrar_promocao",
  description:
    "Registra a campanha promocional extraída do documento do fornecedor.",
  input_schema: {
    type: "object" as const,
    properties: {
      nome: {
        type: "string",
        description:
          "Nome descritivo da campanha (ex: 'DES Promo Abril 2ª Quinzena 2026')",
      },
      data_inicio: { type: "string", description: "YYYY-MM-DD" },
      data_fim: { type: "string", description: "YYYY-MM-DD" },
      fornecedor_nome: {
        type: ["string", "null"],
        description: "Nome do fornecedor como aparece no documento",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            codigo_fornecedor: {
              type: "string",
              description: "Código do produto, verbatim (ex: 'DR.4403')",
            },
            descricao: { type: ["string", "null"] },
            desconto_perc: {
              type: "number",
              description:
                "Percentual de desconto (20 para 20%). Omita o item inteiro se não conseguir ler com certeza.",
            },
            volume_minimo: {
              type: ["number", "null"],
              description: "Quantidade mínima, se houver condição de volume",
            },
          },
          required: ["codigo_fornecedor", "desconto_perc"],
        },
      },
      confianca: { type: "number", minimum: 0, maximum: 1 },
      observacoes: {
        type: "string",
        description: "Ambiguidades, texto ilegível, itens omitidos e por quê",
      },
    },
    required: ["nome", "data_inicio", "data_fim", "items", "confianca", "observacoes"],
  },
};

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
const SYSTEM_AUMENTO =
  `Você analisa documentos que anunciam reajustes de preço do fornecedor Renner Sayerlack e extrai a estrutura do aumento.

REGRAS
1. data_vigencia é quando o NOVO preço passa a valer; data_anuncio é quando o comunicado foi emitido.
2. Nome da categoria: copie EXATAMENTE como aparece no documento.
3. Categoria com vigência própria diferente da geral → preencha data_vigencia_especifica.
4. Percentual que você não conseguir ler com certeza: omita a categoria e explique em observacoes. NUNCA chute — aumento errado vira preço errado.
5. confianca < 0.7 quando houver ambiguidade relevante.

Use SEMPRE a tool registrar_aumento. Não responda em texto fora dela.`;

const TOOL_AUMENTO = {
  name: "registrar_aumento",
  description:
    "Registra o reajuste de preços extraído do comunicado do fornecedor.",
  input_schema: {
    type: "object" as const,
    properties: {
      nome: { type: "string", description: "Nome/assunto do comunicado" },
      data_vigencia: { type: "string", description: "YYYY-MM-DD" },
      data_anuncio: { type: ["string", "null"], description: "YYYY-MM-DD ou null" },
      categorias: {
        type: "array",
        items: {
          type: "object",
          properties: {
            categoria_fornecedor: { type: "string" },
            aumento_perc: {
              type: "number",
              description:
                "Percentual de aumento (5 para 5%). Omita a categoria se não conseguir ler com certeza.",
            },
            data_vigencia_especifica: { type: ["string", "null"] },
          },
          required: ["categoria_fornecedor", "aumento_perc"],
        },
      },
      confianca: { type: "number", minimum: 0, maximum: 1 },
      observacoes: { type: "string" },
    },
    required: ["nome", "data_vigencia", "categorias", "confianca", "observacoes"],
  },
};

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

// ============= NORMALIZAÇÃO DE FORNECEDOR =============
// Consulta `fornecedor_mapeamento_extracao` para resolver aliases extraídos pela IA
// para o nome canônico (razão social) usado no resto do sistema.
// Fallback hardcoded para Sayerlack/Renner caso a tabela esteja indisponível.
async function normalizarFornecedor(
  supabase: SupabaseClient,
  extraido: string | null | undefined,
  _tipoDocumento: string,
): Promise<string> {
  const normalizado = (extraido ?? "").toLowerCase().trim();
  if (!normalizado) return "DESCONHECIDO";

  // 1) tenta match exato (case-insensitive) na tabela
  try {
    // `fornecedor_mapeamento_extracao` não está nos tipos gerados do Supabase;
    // sem a anotação o supabase-js infere `never` e o acesso ao campo não checa.
    const { data: exact } = (await supabase
      .from("fornecedor_mapeamento_extracao")
      .select("nome_canonico")
      .eq("ativo", true)
      .ilike("alias_extraido", normalizado)
      .maybeSingle()) as { data: { nome_canonico: string } | null };
    if (exact?.nome_canonico) return exact.nome_canonico;

    // 2) tenta match por substring — pega o alias mais longo que esteja contido no extraído
    const { data: aliases } = await supabase
      .from("fornecedor_mapeamento_extracao")
      .select("alias_extraido, nome_canonico")
      .eq("ativo", true)
      .returns<Array<{ alias_extraido: string | null; nome_canonico: string }>>();

    if (Array.isArray(aliases) && aliases.length > 0) {
      const ordenados = [...aliases].sort(
        (a, b) =>
          (b.alias_extraido?.length ?? 0) - (a.alias_extraido?.length ?? 0),
      );
      for (const a of ordenados) {
        const alias = (a.alias_extraido ?? "").toLowerCase().trim();
        if (alias && normalizado.includes(alias)) {
          return a.nome_canonico;
        }
      }
    }
  } catch (err) {
    console.warn(
      `[normalizarFornecedor] consulta tabela falhou, usando fallback: ${
        String(err).slice(0, 200)
      }`,
    );
  }

  // 3) Fallback hardcoded (caso a tabela esteja indisponível)
  if (normalizado.includes("sayerlack") || normalizado.includes("renner")) {
    return "RENNER SAYERLACK S/A";
  }

  return extraido?.trim() || "DESCONHECIDO";
}

function fallbackExtraction(reason: string): ExtractedPromo {
  const today = new Date().toISOString().slice(0, 10);
  return {
    nome: `Promoção não identificada — ${today}`,
    data_inicio: today,
    data_fim: today,
    fornecedor_nome: "DESCONHECIDO",
    items: [],
    confianca: 0,
    observacoes: reason,
  };
}

function fallbackAumento(reason: string): ExtractedAumento {
  const today = new Date().toISOString().slice(0, 10);
  return {
    nome: `Aumento não identificado — ${today}`,
    data_vigencia: today,
    data_anuncio: null,
    categorias: [],
    confianca: 0,
    observacoes: reason,
  };
}

/** Erro de truncamento — a extração veio parcial e NÃO pode ser gravada. */
class ExtracaoTruncada extends Error {}

/**
 * Chamada única à Anthropic com forced tool-use. Devolve o `input` da tool.
 * O system prompt leva `cache_control` — junto das tools ele é o prefixo estável
 * entre uploads (a mensagem do usuário, que carrega o anexo, vem depois).
 */
async function extrairViaTool(
  client: Anthropic,
  system: string,
  tool: typeof TOOL_PROMOCAO | typeof TOOL_AUMENTO,
  anexo: BlocoAnexo,
  instrucao: string,
): Promise<{ input: unknown; usage: Record<string, number> }> {
  const response = await client.messages.create({
    model: MODELO,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [
      {
        role: "user",
        content: [
          anexo,
          { type: "text", text: instrucao },
        ],
      },
    ],
  });

  // §8 money-path: teto que trunca fabrica completude. Uma lista de descontos
  // cortada ao meio é indistinguível de uma promoção curta para quem lê depois.
  if (response.stop_reason === "max_tokens") {
    throw new ExtracaoTruncada(
      `resposta truncada em ${MAX_TOKENS} tokens — extração parcial não é gravada. Envie o documento em partes menores.`,
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    const texto = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .slice(0, 300);
    throw new Error(
      `modelo não usou a tool ${tool.name} (stop_reason=${response.stop_reason}) ${texto}`,
    );
  }

  return {
    input: toolUse.input,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

function montarPromo(bruto: unknown): ExtractedPromo {
  const cru = (bruto ?? {}) as Record<string, unknown>;
  const { itens, rejeitados } = normalizarItensPromo(cru.items);

  const inicio = dataValida(cru.data_inicio);
  const fim = dataValida(cru.data_fim);
  const observacoesBase = typeof cru.observacoes === "string" ? cru.observacoes : "";

  if (!inicio || !fim) {
    // Sem período válido a campanha não pode ser aplicada. Grava rascunho com o
    // período sinalizado (nunca em silêncio) mas PRESERVA os itens já extraídos —
    // o revisor corrige a data em vez de pagar uma nova extração. O gate humano
    // segue intacto: estado 'rascunho' + confirmado=false por item.
    const base = fallbackExtraction(
      `PERÍODO NÃO IDENTIFICADO — datas abaixo são placeholder, corrija antes de ativar (data_inicio=${
        JSON.stringify(cru.data_inicio)
      }, data_fim=${JSON.stringify(cru.data_fim)}). ${observacoesBase}`.trim(),
    );
    return {
      ...base,
      items: itens,
      observacoes: anotarRejeicoes(base.observacoes, rejeitados),
    };
  }

  return {
    nome: typeof cru.nome === "string" && cru.nome.trim()
      ? cru.nome.trim()
      : `Promoção ${inicio}`,
    data_inicio: inicio,
    data_fim: fim,
    fornecedor_nome: typeof cru.fornecedor_nome === "string"
      ? cru.fornecedor_nome
      : "",
    items: itens,
    confianca: normalizarConfianca(cru.confianca),
    observacoes: anotarRejeicoes(observacoesBase, rejeitados),
  };
}

function montarAumento(bruto: unknown): ExtractedAumento {
  const cru = (bruto ?? {}) as Record<string, unknown>;
  const { categorias, rejeitadas } = normalizarCategoriasAumento(cru.categorias);

  const vigencia = dataValida(cru.data_vigencia);
  const observacoesBase = typeof cru.observacoes === "string" ? cru.observacoes : "";

  if (!vigencia) {
    // Idem promoção: sinaliza a vigência como placeholder e preserva as categorias.
    const base = fallbackAumento(
      `VIGÊNCIA NÃO IDENTIFICADA — data abaixo é placeholder, corrija antes de ativar (data_vigencia=${
        JSON.stringify(cru.data_vigencia)
      }). ${observacoesBase}`.trim(),
    );
    return {
      ...base,
      categorias,
      observacoes: anotarRejeicoes(base.observacoes, rejeitadas),
    };
  }

  return {
    nome: typeof cru.nome === "string" && cru.nome.trim()
      ? cru.nome.trim()
      : `Aumento ${vigencia}`,
    data_vigencia: vigencia,
    data_anuncio: dataValida(cru.data_anuncio),
    categorias,
    confianca: normalizarConfianca(cru.confianca),
    observacoes: anotarRejeicoes(observacoesBase, rejeitadas),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
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

  // CANÁRIA DE VERSÃO (docs/agent/deploy.md): no Lovable Cloud não há PAT, então o
  // deploy de edge não tem prova de VERSÃO — só "foi servida". Este probe é a prova:
  // `{ probe: true }` responde qual motor está no ar sem chamar o modelo (custo zero).
  //   curl -s -X POST <url> -H "Authorization: Bearer <jwt staff>" \
  //        -H 'content-type: application/json' -d '{"probe":true}'
  //   → {"ok":true,"motor":"anthropic",...}  = versão nova no ar
  //   → 400 "arquivo_base64 obrigatório"     = ainda a versão velha (gateway Lovable)
  if (body.probe === true) {
    return new Response(
      JSON.stringify({
        ok: true,
        motor: "anthropic",
        modelo: MODELO,
        tools: [TOOL_PROMOCAO.name, TOOL_AUMENTO.name],
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const empresa = (body.empresa as string) ?? "OBEN";
  const fornecedorNomeFallback =
    (body.fornecedor_nome as string) ?? "RENNER SAYERLACK S/A";
  const arquivoBase64 = body.arquivo_base64 as string | undefined;
  const arquivoTipo = (body.arquivo_tipo as string) ?? "pdf";
  const tipoDocumentoRaw = (body.tipo_documento as string) ?? "campanha_sayerlack";
  const tipoDocumento: "campanha_sayerlack" | "aumento" =
    tipoDocumentoRaw === "aumento" ? "aumento" : "campanha_sayerlack";
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

  // Valida o anexo ANTES do upload: tipo não suportado ou arquivo grande demais
  // falha aqui, sem deixar lixo no bucket nem gastar chamada de modelo.
  const anexo = montarBlocoAnexo(arquivoTipo, arquivoBase64);
  if (!anexo.ok) {
    return new Response(JSON.stringify({ error: anexo.erro }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log(
    `[promocao-extrair-via-vision] start empresa=${empresa} tipo_doc=${tipoDocumento} media=${anexo.mediaType} bytes_b64=${arquivoBase64.length}`,
  );

  // ===== Upload do arquivo no Storage (compartilhado entre fluxos) =====
  const fileName = `${empresa}/${Date.now()}_${
    Math.random().toString(36).slice(2, 8)
  }.${anexo.extensao}`;
  const fileBytes = Uint8Array.from(atob(arquivoBase64), (c) => c.charCodeAt(0));

  const { error: uploadErr } = await supabase.storage
    .from("promocoes")
    .upload(fileName, fileBytes, { contentType: anexo.mediaType });
  if (uploadErr) {
    console.error(
      `[promocao-extrair-via-vision] upload falhou: ${uploadErr.message}`,
    );
  }
  const arquivoUrl = uploadErr ? null : fileName;

  const client = new Anthropic({ apiKey });

  // ===== FLUXO AUMENTO =====
  if (tipoDocumento === "aumento") {
    let extractedAum: ExtractedAumento;
    let usageAum: Record<string, number>;
    try {
      const { input, usage } = await extrairViaTool(
        client,
        SYSTEM_AUMENTO,
        TOOL_AUMENTO,
        anexo.bloco,
        "Extraia o reajuste de preços deste comunicado usando a tool registrar_aumento.",
      );
      extractedAum = montarAumento(input);
      usageAum = usage;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[promocao-extrair-via-vision] vision aumento falhou: ${msg.slice(0, 300)}`,
      );
      return new Response(
        JSON.stringify({ error: `Vision falhou: ${msg.slice(0, 300)}` }),
        {
          status: err instanceof ExtracaoTruncada ? 422 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const fornecedorCanonicoAum = await normalizarFornecedor(
      supabase,
      fornecedorNomeFallback,
      "aumento",
    );

    const { data: aumentoRpc, error: rpcErr } = await supabase.rpc(
      "registrar_aumento_via_vision",
      {
        p_empresa: empresa,
        p_fornecedor_nome: fornecedorCanonicoAum,
        p_nome: extractedAum.nome,
        p_data_vigencia: extractedAum.data_vigencia,
        p_data_anuncio: extractedAum.data_anuncio,
        p_categorias: extractedAum.categorias,
        p_origem_arquivo_url: arquivoUrl,
        p_origem_email_remetente: origemEmail?.remetente ?? null,
        p_origem_email_assunto: origemEmail?.assunto ?? null,
        p_origem_email_data: origemEmail?.data ?? null,
        p_extracao_confianca: extractedAum.confianca,
        p_extracao_observacoes: extractedAum.observacoes,
      },
    );

    if (rpcErr) {
      console.error(
        `[promocao-extrair-via-vision] registrar_aumento_via_vision erro: ${rpcErr.message}`,
      );
      return new Response(
        JSON.stringify({
          error: `erro ao registrar aumento: ${rpcErr.message}`,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const aumentoId = typeof aumentoRpc === "string"
      ? aumentoRpc
      : (aumentoRpc as { id?: string } | null)?.id ?? aumentoRpc;

    console.log(
      `[promocao-extrair-via-vision] OK aumento_id=${aumentoId} categorias=${extractedAum.categorias.length} confianca=${extractedAum.confianca} tokens=${usageAum.input_tokens}/${usageAum.output_tokens} cache_read=${usageAum.cache_read_input_tokens}`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        tipo_documento: "aumento",
        aumento_id: aumentoId,
        extracao: {
          confianca: extractedAum.confianca,
          observacoes: extractedAum.observacoes,
          categorias_extraidas: extractedAum.categorias.length,
        },
        arquivo_url: arquivoUrl,
        proximo_passo: `Revisar aumento extraído na UI`,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  }

  // ===== FLUXO PROMOÇÃO (default — comportamento original) =====
  let extracted: ExtractedPromo;
  let usagePromo: Record<string, number>;
  try {
    const { input, usage } = await extrairViaTool(
      client,
      SYSTEM_PROMOCAO,
      TOOL_PROMOCAO,
      anexo.bloco,
      "Extraia a campanha promocional deste documento usando a tool registrar_promocao.",
    );
    extracted = montarPromo(input);
    usagePromo = usage;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[promocao-extrair-via-vision] vision falhou: ${msg.slice(0, 300)}`,
    );
    return new Response(
      JSON.stringify({ error: `Vision falhou: ${msg.slice(0, 300)}` }),
      {
        status: err instanceof ExtracaoTruncada ? 422 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const fornecedorCanonico = await normalizarFornecedor(
    supabase,
    extracted.fornecedor_nome || fornecedorNomeFallback,
    "campanha_sayerlack",
  );

  const { data: campanha, error: campErr } = await supabase
    .from("promocao_campanha")
    .insert({
      empresa,
      fornecedor_nome: fornecedorCanonico,
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
    `[promocao-extrair-via-vision] OK campanha=${campanha.id} items=${extracted.items.length} confianca=${extracted.confianca} tokens=${usagePromo.input_tokens}/${usagePromo.output_tokens} cache_read=${usagePromo.cache_read_input_tokens}`,
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
      proximo_passo: `Revisar em /admin/reposicao/promocoes/${campanha.id}`,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    },
  );
});

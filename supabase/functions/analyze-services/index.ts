import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import {
  extrairToolUseUnico,
  MODELO_PADRAO,
  objetoDaTool,
  statusDoErro,
  traduzirErroAnthropic,
} from "../_shared/anthropic.ts";
import { consumirCota, headersDeCota } from "../_shared/ia-cota.ts";
import { normalizarItens, TOOL_SERVICOS } from "./servico-tools.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface UserTool {
  id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories: {
    name: string;
  } | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Não autorizado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Token inválido" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { text, userTools } = await req.json();

    // Input validation
    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "Texto é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (text.length > 5000) {
      return new Response(
        JSON.stringify({ error: "Texto muito longo (máximo 5000 caracteres)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (userTools && (!Array.isArray(userTools) || userTools.length > 100)) {
      return new Response(
        JSON.stringify({ error: "Lista de ferramentas inválida (máximo 100)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // COTA — depois da validação (requisição malformada não queima cota) e antes
    // da Anthropic. Também poupa a consulta de serviços quando a cota já estourou.
    // O gate acima só exige JWT válido: sem isto, um cliente repetindo pedidos
    // com 100 ferramentas esgota o orçamento da ORGANIZAÇÃO — os limites da
    // Anthropic não são por usuário da aplicação.
    const cota = await consumirCota(supabase, user.id, "analyze-services", "análises de pedido");
    if (!cota.permitido) {
      return new Response(
        JSON.stringify({ error: cota.mensagem }),
        {
          status: cota.http,
          headers: { ...corsHeaders, ...headersDeCota(cota), "Content-Type": "application/json" },
        },
      );
    }

    // Buscar serviços disponíveis do banco
    const { data: servicos, error: dbError } = await supabase
      .from("omie_servicos")
      .select("omie_codigo_servico, descricao")
      .eq("inativo", false);

    if (dbError) {
      console.error("Erro ao buscar serviços:", dbError);
      throw new Error("Erro ao buscar serviços disponíveis");
    }

    const servicosLista = servicos?.map(s => `- ${s.omie_codigo_servico}: ${s.descricao}`).join("\n") || "";

    // Formatar lista de ferramentas do usuário
    const tools = userTools as UserTool[] || [];
    const ferramentasLista = tools.map(t => {
      const nome = t.generated_name || t.custom_name || t.tool_categories?.name || "Ferramenta";
      const categoria = t.tool_categories?.name || "";
      return `- ID: ${t.id} | Nome: ${nome} | Categoria: ${categoria} | Qtd cadastrada: ${t.quantity || 1}`;
    }).join("\n") || "Nenhuma ferramenta cadastrada";

    const systemPrompt = `Você é um assistente especializado em serviços de afiação de ferramentas industriais.

Sua tarefa é analisar o texto do cliente e identificar:
1. Quais FERRAMENTAS CADASTRADAS ele quer afiar
2. Qual SERVIÇO deve ser aplicado a cada ferramenta

FERRAMENTAS CADASTRADAS DO CLIENTE:
${ferramentasLista}

SERVIÇOS DISPONÍVEIS:
${servicosLista}

REGRAS IMPORTANTES:
1. PRIORIZE identificar as ferramentas cadastradas do cliente pelo nome ou categoria
2. Para cada ferramenta identificada, encontre o serviço compatível (a descrição do serviço deve conter o nome da CATEGORIA da ferramenta)
3. Se o cliente mencionar quantidade, use-a. Caso contrário, use a quantidade cadastrada ou 1
4. Se o cliente mencionar observações (danos, lascados, urgência), inclua no campo notes
5. Se não conseguir identificar nenhuma ferramenta ou serviço, retorne arrays vazios
6. Seja flexível com sinônimos e variações de nomes

EXEMPLOS:
- "quero afiar minhas serras" → identifique todas as ferramentas que tenham "serra" no nome ou categoria
- "afia a faca 250mm" → identifique a ferramenta específica com 250mm
- "preciso de afiação urgente da serra, está lascada" → notes: "urgente, lascada"

Responda SEMPRE usando a função suggest_services.`;

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO_PADRAO,
        max_tokens: 2000,
        system: systemPrompt,
        tools: [TOOL_SERVICOS],
        // `type:'tool'` sozinho não desliga chamada paralela: o modelo poderia
        // devolver um bloco por ferramenta e o consumo pegaria só o primeiro,
        // montando um pedido PARCIAL com cara de completo.
        tool_choice: { type: "tool", name: TOOL_SERVICOS.name, disable_parallel_tool_use: true },
        messages: [{ role: "user", content: text }],
      });
    } catch (e: unknown) {
      const status = statusDoErro(e);
      console.error("[analyze-services] erro na API da Anthropic:", status, e instanceof Error ? e.message : e);
      const mapeado = traduzirErroAnthropic(status);
      return new Response(
        JSON.stringify({ error: mapeado?.mensagem ?? "Erro ao processar com IA" }),
        { status: mapeado?.http ?? 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Truncou = lista de itens cortada no meio. O cliente confirmaria um pedido
    // com 2 de 5 ferramentas achando que pediu todas.
    if (resposta.stop_reason === "max_tokens") {
      console.error("[analyze-services] resposta truncada");
      return new Response(
        JSON.stringify({ error: "Pedido longo demais para analisar de uma vez. Divida em duas partes." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const extraido = extrairToolUseUnico(resposta.content);
    const result = extraido.ok ? objetoDaTool(extraido.input) : null;

    if (result === null) {
      return new Response(
        JSON.stringify({
          items: [],
          message: "Não consegui identificar ferramentas ou serviços. Por favor, seja mais específico ou selecione manualmente.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // O filtro por ferramenta REAL do cliente já existia; o que faltava era a
    // disciplina de TIPO — `quantity` multiplica o preço do serviço, e string ou
    // zero ali vira valor errado na nota.
    const idsValidos = new Set(tools.map((t) => t.id));
    const { itens, descartados } = normalizarItens(result.items, idsValidos);
    if (descartados > 0) {
      console.warn(`[analyze-services] ${descartados} item(ns) descartado(s) por dado inválido`);
    }

    const mensagem = typeof result.message === "string" && result.message.trim()
      ? result.message.trim()
      : `Identificado ${itens.length} item(s) para o pedido.`;

    return new Response(
      JSON.stringify({
        items: itens,
        message: descartados > 0
          ? `${mensagem} (${descartados} item(ns) não reconhecido(s) foram deixados de fora — confira antes de enviar.)`
          : mensagem,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Erro na função analyze-services:", error);
    return new Response(
      JSON.stringify({ error: "Erro ao processar solicitação" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

serve(async (req) => {
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

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Buscar serviços disponíveis do banco
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

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

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "suggest_services",
              description: "Retorna as ferramentas e serviços identificados no texto do cliente",
              parameters: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    description: "Lista de itens identificados (ferramenta + serviço)",
                    items: {
                      type: "object",
                      properties: {
                        userToolId: { type: "string", description: "ID da ferramenta cadastrada do usuário" },
                        omie_codigo_servico: { type: "number", description: "Código do serviço no Omie" },
                        servico_descricao: { type: "string", description: "Descrição do serviço" },
                        quantity: { type: "number", description: "Quantidade de itens (padrão 1)" },
                        notes: { type: "string", description: "Observações extraídas do texto (danos, urgência, etc)" },
                      },
                      required: ["userToolId", "omie_codigo_servico", "servico_descricao", "quantity"],
                    },
                  },
                  message: { type: "string", description: "Mensagem amigável para o cliente confirmando o que foi identificado" },
                },
                required: ["items", "message"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "suggest_services" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns segundos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos insuficientes. Entre em contato com o suporte." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error("Erro ao processar com IA");
    }

    const aiResponse = await response.json();
    console.log("AI Response:", JSON.stringify(aiResponse, null, 2));

    const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      return new Response(
        JSON.stringify({ 
          items: [], 
          message: "Não consegui identificar ferramentas ou serviços. Por favor, seja mais específico ou selecione manualmente." 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = JSON.parse(toolCall.function.arguments);

    const validItems = (result.items || []).filter((item: { userToolId: string }) => 
      tools.some(t => t.id === item.userToolId)
    );

    return new Response(
      JSON.stringify({
        items: validItems,
        message: result.message || `Identificado ${validItems.length} item(s) para o pedido.`,
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

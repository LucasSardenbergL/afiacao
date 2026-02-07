import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "Texto é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Buscar serviços disponíveis do banco
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
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

    const systemPrompt = `Você é um assistente especializado em serviços de afiação de ferramentas industriais.

Sua tarefa é analisar o texto do cliente e identificar quais serviços ele precisa.

SERVIÇOS DISPONÍVEIS:
${servicosLista}

REGRAS:
1. Analise o texto e identifique as ferramentas/serviços mencionados
2. Para cada ferramenta identificada, encontre o serviço mais adequado da lista
3. Se o cliente mencionar quantidade, use-a. Caso contrário, use 1
4. Se não conseguir identificar nenhum serviço, retorne um array vazio
5. Seja flexível com sinônimos (ex: "serra circular" = "serra circular de widea")

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
              description: "Retorna os serviços identificados no texto do cliente",
              parameters: {
                type: "object",
                properties: {
                  services: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        omie_codigo_servico: { 
                          type: "number", 
                          description: "Código do serviço no Omie" 
                        },
                        descricao: { 
                          type: "string", 
                          description: "Descrição do serviço" 
                        },
                        quantity: { 
                          type: "number", 
                          description: "Quantidade de itens (padrão 1)" 
                        },
                        notes: { 
                          type: "string", 
                          description: "Observações extraídas do texto (opcional)" 
                        },
                      },
                      required: ["omie_codigo_servico", "descricao", "quantity"],
                    },
                  },
                  message: {
                    type: "string",
                    description: "Mensagem amigável para o cliente confirmando o que foi identificado",
                  },
                },
                required: ["services", "message"],
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

    // Extrair resultado da tool call
    const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      return new Response(
        JSON.stringify({ 
          services: [], 
          message: "Não consegui identificar serviços específicos. Por favor, seja mais específico ou selecione manualmente." 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = JSON.parse(toolCall.function.arguments);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Erro na função analyze-services:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

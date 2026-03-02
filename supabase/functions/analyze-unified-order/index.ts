import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data, error: authError } = await supabaseAuth.auth.getClaims(token);
    if (authError || !data?.claims) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { text, imageBase64, products, userTools } = await req.json();

    if (!text && !imageBase64) {
      return new Response(JSON.stringify({ error: "Texto ou imagem é obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch services
    const { data: servicos } = await supabase
      .from("omie_servicos")
      .select("omie_codigo_servico, descricao")
      .eq("inativo", false);

    const servicosLista = (servicos || []).map(s => `- CódigoServiço:${s.omie_codigo_servico} | ${s.descricao}`).join("\n");

    // Format products list (top 200 by relevance)
    const prodList = (products || []).slice(0, 200);
    const produtosLista = prodList.map((p: any) =>
      `- ID:${p.id} | Código:${p.codigo} | ${p.descricao} | Conta:${p.account || 'oben'} | Preço:${p.valor_unitario} | Estoque:${p.estoque ?? 0}`
    ).join("\n");

    // Format user tools
    const tools = (userTools || []);
    const ferramentasLista = tools.length > 0
      ? tools.map((t: any) => {
          const nome = t.generated_name || t.custom_name || t.tool_categories?.name || "Ferramenta";
          return `- ToolID:${t.id} | Nome:${nome} | Categoria:${t.tool_categories?.name || ''} | Qtd:${t.quantity || 1}`;
        }).join("\n")
      : "Nenhuma ferramenta cadastrada";

    const systemPrompt = `Você é um assistente de pedidos para uma empresa de ferramentas industriais. 
O vendedor pode pedir PRODUTOS (Oben ou Colacor) e/ou SERVIÇOS DE AFIAÇÃO.

Sua tarefa: analisar o pedido (texto ou imagem) e identificar:
1. PRODUTOS do catálogo que o cliente quer comprar, com quantidades
2. FERRAMENTAS DO CLIENTE que precisam de SERVIÇO DE AFIAÇÃO

CATÁLOGO DE PRODUTOS:
${produtosLista || "Nenhum produto disponível"}

FERRAMENTAS CADASTRADAS DO CLIENTE (para afiação):
${ferramentasLista}

SERVIÇOS DE AFIAÇÃO DISPONÍVEIS:
${servicosLista || "Nenhum serviço disponível"}

REGRAS:
1. Para PRODUTOS: identifique pelo nome, código ou descrição. Use a quantidade mencionada ou 1.
2. Para AFIAÇÃO: identifique a ferramenta cadastrada e o serviço compatível (a descrição do serviço deve conter a categoria da ferramenta).
3. Priorize correspondências exatas de nome/código. Seja flexível com sinônimos.
4. Se o vendedor mencionar "afiar", "afiação", "serrar", "lâmina lascada" etc, trate como serviço.
5. Se mencionar "comprar", "preciso de", "X unidades de", trate como produto.
6. Extraia observações como danos, urgência, etc.
7. Se estiver analisando uma IMAGEM: identifique os produtos/ferramentas visíveis e sugira os itens correspondentes do catálogo.

Responda SEMPRE usando a função identify_order_items.`;

    const messages: any[] = [
      { role: "system", content: systemPrompt },
    ];

    if (imageBase64) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: text || "Identifique os produtos e ferramentas nesta imagem e sugira os itens para o pedido:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      });
    } else {
      messages.push({ role: "user", content: text });
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: imageBase64 ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview",
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "identify_order_items",
              description: "Retorna produtos e serviços identificados no pedido",
              parameters: {
                type: "object",
                properties: {
                  products: {
                    type: "array",
                    description: "Produtos do catálogo identificados",
                    items: {
                      type: "object",
                      properties: {
                        product_id: { type: "string", description: "ID UUID do produto" },
                        codigo: { type: "string", description: "Código do produto" },
                        descricao: { type: "string", description: "Descrição do produto" },
                        quantity: { type: "number", description: "Quantidade (padrão 1)" },
                        account: { type: "string", description: "Conta: oben ou colacor" },
                        notes: { type: "string", description: "Observações" },
                      },
                      required: ["product_id", "quantity", "account"],
                    },
                  },
                  services: {
                    type: "array",
                    description: "Serviços de afiação identificados",
                    items: {
                      type: "object",
                      properties: {
                        userToolId: { type: "string", description: "ID da ferramenta cadastrada" },
                        omie_codigo_servico: { type: "number", description: "Código do serviço Omie" },
                        servico_descricao: { type: "string", description: "Descrição do serviço" },
                        quantity: { type: "number", description: "Quantidade" },
                        notes: { type: "string", description: "Observações (danos, urgência, etc)" },
                      },
                      required: ["userToolId", "omie_codigo_servico", "servico_descricao", "quantity"],
                    },
                  },
                  message: { type: "string", description: "Mensagem amigável confirmando o que foi identificado" },
                },
                required: ["products", "services", "message"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "identify_order_items" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido. Tente novamente." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error("Erro ao processar com IA");
    }

    const aiResponse = await response.json();
    const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      return new Response(JSON.stringify({
        products: [], services: [],
        message: "Não consegui identificar itens. Seja mais específico ou selecione manualmente.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result = JSON.parse(toolCall.function.arguments);

    // Validate product IDs
    const validProductIds = new Set(prodList.map((p: any) => p.id));
    const validProducts = (result.products || []).filter((p: any) => validProductIds.has(p.product_id));

    // Validate tool IDs
    const validToolIds = new Set(tools.map((t: any) => t.id));
    const validServices = (result.services || []).filter((s: any) => validToolIds.has(s.userToolId));

    return new Response(JSON.stringify({
      products: validProducts,
      services: validServices,
      message: result.message || `Identificado ${validProducts.length} produto(s) e ${validServices.length} serviço(s).`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("analyze-unified-order error:", error);
    return new Response(JSON.stringify({ error: "Erro ao processar solicitação" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

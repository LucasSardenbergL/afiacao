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

    const { text, imageBase64, products, userTools, customerUserId } = await req.json();

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

    // Fetch customer purchase history for context
    let historicoCompras = "";
    if (customerUserId) {
      try {
        // Get recent sales orders with items for this customer
        const { data: recentItems } = await supabase
          .from("order_items")
          .select("product_id, quantity, unit_price, omie_products(descricao, codigo, account)")
          .eq("customer_user_id", customerUserId)
          .order("created_at", { ascending: false })
          .limit(50);

        // Get recent sharpening orders
        const { data: recentOrders } = await supabase
          .from("orders")
          .select("items, service_type, created_at")
          .eq("user_id", customerUserId)
          .order("created_at", { ascending: false })
          .limit(20);

        if (recentItems && recentItems.length > 0) {
          // Aggregate by product
          const productCounts: Record<string, { descricao: string; codigo: string; account: string; totalQty: number; count: number }> = {};
          for (const item of recentItems) {
            const prod = item.omie_products as any;
            if (!prod) continue;
            const key = item.product_id || prod.codigo;
            if (!productCounts[key]) {
              productCounts[key] = { descricao: prod.descricao, codigo: prod.codigo, account: prod.account || 'oben', totalQty: 0, count: 0 };
            }
            productCounts[key].totalQty += item.quantity;
            productCounts[key].count += 1;
          }
          const sorted = Object.values(productCounts).sort((a, b) => b.count - a.count).slice(0, 15);
          historicoCompras = "\n\nHISTÓRICO DE COMPRAS DO CLIENTE (produtos mais comprados):\n" +
            sorted.map(p => `- ${p.descricao} (${p.codigo}, ${p.account}) — pedido ${p.count}x, total ${p.totalQty} un`).join("\n");
        }

        if (recentOrders && recentOrders.length > 0) {
          const serviceTypes = new Set<string>();
          for (const order of recentOrders) {
            if (order.service_type) serviceTypes.add(order.service_type);
            if (order.items && Array.isArray(order.items)) {
              for (const item of order.items as any[]) {
                if (item.category) serviceTypes.add(item.category);
              }
            }
          }
          if (serviceTypes.size > 0) {
            historicoCompras += "\nServiços já utilizados: " + [...serviceTypes].join(", ");
          }
        }
      } catch (e) {
        console.error("Error fetching purchase history:", e);
      }
    }

    const systemPrompt = `Você é um assistente de pedidos para uma empresa que vende produtos industriais (serras, discos, lâminas, brocas, fresas, lixas, thinner, tintas, colas, abrasivos, EPIs, e QUALQUER outro produto do catálogo) e também presta serviços de afiação.
O vendedor pode pedir PRODUTOS (Oben ou Colacor) e/ou SERVIÇOS DE AFIAÇÃO.

Sua tarefa: analisar o pedido (texto ou imagem) e identificar:
1. PRODUTOS do catálogo que o cliente quer comprar, com quantidades
2. FERRAMENTAS DO CLIENTE que precisam de SERVIÇO DE AFIAÇÃO
3. SUGESTÕES quando não encontrar correspondência exata

CATÁLOGO DE PRODUTOS:
${produtosLista || "Nenhum produto disponível"}

FERRAMENTAS CADASTRADAS DO CLIENTE (para afiação):
${ferramentasLista}

SERVIÇOS DE AFIAÇÃO DISPONÍVEIS:
${servicosLista || "Nenhum serviço disponível"}
${historicoCompras}

REGRAS:
1. Para PRODUTOS: identifique pelo nome, código ou descrição parcial. Use a quantidade mencionada ou 1.
2. Para AFIAÇÃO: identifique a ferramenta cadastrada e o serviço compatível.
3. Priorize correspondências exatas de nome/código. Seja MUITO flexível com sinônimos, abreviações, erros de grafia (ex: "thiner" = "thinner", "disco 7" = "disco de corte 7 polegadas").
4. Se o vendedor mencionar "afiar", "afiação", "serrar", "lâmina lascada" etc, trate como serviço.
5. Se mencionar "comprar", "preciso de", "X unidades de", trate como produto.
6. Extraia observações como danos, urgência, etc.
7. Se estiver analisando uma IMAGEM: 
   - Pode ser uma FOTO de produto/ferramenta real OU uma foto de um PAPEL/NOTA/LISTA escrita à mão
   - Se a imagem contém TEXTO ESCRITO (em papel, quadro, bilhete, nota), LEIA O TEXTO e use-o como se fosse um pedido digitado
   - NÃO rejeite a imagem só porque não mostra uma ferramenta física. Texto escrito em papel é válido!
   - Identifique os itens mencionados no texto da imagem e busque no catálogo

REGRAS DE SUGESTÃO (MUITO IMPORTANTE - SEMPRE RETORNE SUGESTÕES):
8. Se NÃO encontrar correspondência exata no catálogo para algo mencionado ou visível na imagem, NÃO descarte. Em vez disso:
   a. Sugira os produtos MAIS SIMILARES do catálogo (por nome parcial, categoria, ou uso semelhante)
   b. Use o histórico de compras do cliente para sugerir produtos que ele costuma comprar e que possam ser relevantes
   c. Se identificar uma ferramenta na imagem mas ela não está cadastrada, sugira o serviço de afiação mais provável
   d. Quando o produto mencionado não existe no catálogo (ex: "Thiner 4403"), procure por produtos similares (ex: qualquer thinner/solvente do catálogo)
9. SEMPRE preencha o campo "suggestions" com pelo menos 1-3 itens quando:
   - Não há correspondência exata
   - O cliente pode precisar de itens complementares baseados no histórico
   - A imagem mostra algo que se aproxima de um produto mas sem certeza total
   - O texto menciona um produto que não existe exatamente no catálogo (sugira os mais próximos)
10. Para sugestões que NÃO têm product_id exato do catálogo, use product_id="" e preencha a descrição e o motivo

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
              description: "Retorna produtos e serviços identificados no pedido, e sugestões quando não há correspondência exata",
              parameters: {
                type: "object",
                properties: {
                  products: {
                    type: "array",
                    description: "Produtos do catálogo identificados com certeza",
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
                  suggestions: {
                    type: "array",
                    description: "Sugestões de produtos/serviços quando não há correspondência exata ou baseado no histórico",
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["product", "service"], description: "Tipo da sugestão" },
                        product_id: { type: "string", description: "ID UUID do produto sugerido (se type=product)" },
                        codigo: { type: "string", description: "Código do produto sugerido" },
                        descricao: { type: "string", description: "Descrição do item sugerido" },
                        quantity: { type: "number", description: "Quantidade sugerida" },
                        account: { type: "string", description: "Conta: oben ou colacor" },
                        reason: { type: "string", description: "Motivo da sugestão (ex: 'Similar ao que foi identificado na foto', 'Produto que o cliente costuma comprar')" },
                        userToolId: { type: "string", description: "ID da ferramenta (se type=service)" },
                        omie_codigo_servico: { type: "number", description: "Código do serviço (se type=service)" },
                        servico_descricao: { type: "string", description: "Descrição do serviço (se type=service)" },
                      },
                      required: ["type", "descricao", "reason"],
                    },
                  },
                  message: { type: "string", description: "Mensagem amigável explicando o que foi identificado e o que foi sugerido" },
                },
                required: ["products", "services", "suggestions", "message"],
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
        products: [], services: [], suggestions: [],
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

    // Validate suggestions - keep those with valid IDs OR text-only suggestions
    const validSuggestions = (result.suggestions || []).filter((s: any) => {
      if (s.type === 'product') {
        if (s.product_id && s.product_id !== '') return validProductIds.has(s.product_id);
        return true; // Allow text-only suggestions (no exact match)
      }
      if (s.type === 'service') {
        if (s.userToolId) return validToolIds.has(s.userToolId);
        return true;
      }
      return true;
    });

    return new Response(JSON.stringify({
      products: validProducts,
      services: validServices,
      suggestions: validSuggestions,
      message: result.message || `Identificado ${validProducts.length} produto(s) e ${validServices.length} serviço(s).`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("analyze-unified-order error:", error);
    return new Response(JSON.stringify({ error: "Erro ao processar solicitação" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

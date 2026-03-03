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

    const { text, imageBase64, imagesBase64, products, userTools, customerUserId, searchCustomer } = await req.json();

    // Support single image (imageBase64) or multiple images (imagesBase64)
    const allImages: string[] = [];
    if (imagesBase64 && Array.isArray(imagesBase64)) {
      allImages.push(...imagesBase64.slice(0, 5));
    } else if (imageBase64) {
      allImages.push(imageBase64);
    }

    if (!text && allImages.length === 0) {
      return new Response(JSON.stringify({ error: "Texto ou imagem é obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ─── Customer search ───
    let customerSection = "";
    let customerCandidates: any[] = [];

    if (searchCustomer && (text || allImages.length > 0)) {
      // Extract potential customer names/cities from text
      const searchText = text || "";
      
      // Search profiles by name fragments (at least 3 chars)
      const nameTerms = searchText
        .split(/[\s,;]+/)
        .map((t: string) => t.trim())
        .filter((t: string) => t.length >= 3);

      const candidateIds = new Set<string>();

      // When we have images but no text, load ALL approved profiles so the AI can match
      // customer names visible in photos against real database entries
      if (allImages.length > 0 && nameTerms.length === 0) {
        console.log("[analyze-unified-order] Image-only mode: loading all profiles for customer matching");
        try {
          const { data: allProfiles } = await supabase
            .from("profiles")
            .select("user_id, name, document, email, phone")
            .eq("is_approved", true)
            .limit(500);
          if (allProfiles) {
            // Batch fetch omie mappings
            const userIds = allProfiles.map(p => p.user_id);
            const { data: omieMappings } = await supabase
              .from("omie_clientes")
              .select("user_id, omie_codigo_cliente")
              .in("user_id", userIds);
            const omieMap = new Map((omieMappings || []).map(m => [m.user_id, m.omie_codigo_cliente]));

            for (const p of allProfiles) {
              candidateIds.add(p.user_id);
              customerCandidates.push({
                user_id: p.user_id,
                nome: p.name,
                nome_fantasia: p.name,
                documento: p.document,
                codigo_cliente: omieMap.get(p.user_id) || null,
              });
            }
          }
        } catch (e) {
          console.error("Error loading all profiles for image mode:", e);
        }
      } else {
        // Search in profiles for name matches (text mode)
        for (const term of nameTerms.slice(0, 5)) {
          try {
            const { data: profiles } = await supabase
              .from("profiles")
              .select("user_id, name, document, email, phone")
              .or(`name.ilike.%${term}%`)
              .eq("is_approved", true)
              .limit(10);
            if (profiles) {
              for (const p of profiles) {
                if (!candidateIds.has(p.user_id)) {
                  candidateIds.add(p.user_id);
                  const { data: omieMapping } = await supabase
                    .from("omie_clientes")
                    .select("omie_codigo_cliente")
                    .eq("user_id", p.user_id)
                    .limit(1)
                    .maybeSingle();
                  customerCandidates.push({
                    user_id: p.user_id,
                    nome: p.name,
                    documento: p.document,
                    codigo_cliente: omieMapping?.omie_codigo_cliente || null,
                  });
                }
              }
            }
          } catch (e) {
            console.error(`Error searching profiles for "${term}":`, e);
          }
        }
      }

      // Also try Omie API search for broader matching (nome_fantasia/razao_social)
      // We search Omie directly for terms >= 3 chars
      const omieSearchTerms = nameTerms.filter((t: string) => t.length >= 3).slice(0, 3);
      for (const term of omieSearchTerms) {
        try {
          const OMIE_APP_KEY = Deno.env.get("OMIE_VENDAS_APP_KEY");
          const OMIE_APP_SECRET = Deno.env.get("OMIE_VENDAS_APP_SECRET");
          if (OMIE_APP_KEY && OMIE_APP_SECRET) {
            const omieRes = await fetch("https://app.omie.com.br/api/v1/geral/clientes/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                call: "ListarClientes",
                app_key: OMIE_APP_KEY,
                app_secret: OMIE_APP_SECRET,
                param: [{ pagina: 1, registros_por_pagina: 10, clientesFiltro: { nome_fantasia: term } }],
              }),
            });
            if (omieRes.ok) {
              const omieData = await omieRes.json();
              if (omieData.clientes_cadastro) {
                for (const c of omieData.clientes_cadastro) {
                  const key = `omie_${c.codigo_cliente_omie}`;
                  if (!candidateIds.has(key)) {
                    candidateIds.add(key);
                    customerCandidates.push({
                      nome_fantasia: c.nome_fantasia || "",
                      razao_social: c.razao_social || "",
                      cnpj_cpf: c.cnpj_cpf || "",
                      cidade: c.cidade || "",
                      estado: c.estado || "",
                      codigo_cliente: c.codigo_cliente_omie,
                    });
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error(`Omie customer search error for "${term}":`, e);
        }
      }

      if (customerCandidates.length > 0) {
        customerSection = "\n\nCLIENTES ENCONTRADOS NA BASE (para identificação):\n" +
          customerCandidates.map((c: any, i: number) => {
            if (c.nome_fantasia !== undefined) {
              return `- [${i}] NomeFantasia:${c.nome_fantasia} | RazãoSocial:${c.razao_social} | CNPJ/CPF:${c.cnpj_cpf} | Cidade:${c.cidade || 'N/A'} | Estado:${c.estado || 'N/A'} | CódigoCliente:${c.codigo_cliente}`;
            }
            return `- [${i}] Nome:${c.nome} | Documento:${c.documento || 'N/A'} | CódigoCliente:${c.codigo_cliente || 'N/A'}`;
          }).join("\n");
      }
    }

    // ─── Products & Services ───
    // Fetch services
    const { data: servicos } = await supabase
      .from("omie_servicos")
      .select("omie_codigo_servico, descricao")
      .eq("inativo", false);

    const servicosLista = (servicos || []).map(s => `- CódigoServiço:${s.omie_codigo_servico} | ${s.descricao}`).join("\n");

    // Build product list
    let prodList: any[] = [];
    const prodIds = new Set<string>();

    if (allImages.length > 0 && !text) {
      const { data: allProducts } = await supabase
        .from("omie_products")
        .select("id, codigo, descricao, account, valor_unitario, estoque")
        .eq("ativo", true)
        .order("descricao")
        .limit(1000);
      if (allProducts) {
        prodList = allProducts;
        for (const p of allProducts) prodIds.add(p.id);
      }
    } else {
      prodList = (products || []).slice(0, 150);
      for (const p of prodList) prodIds.add(p.id);
    }

    // Extract search terms from text input
    const searchText = text || "";
    const searchTerms = searchText
      .split(/[\s,;]+/)
      .map((t: string) => t.trim())
      .filter((t: string) => t.length >= 3);

    if (searchTerms.length > 0) {
      for (const term of searchTerms.slice(0, 5)) {
        try {
          const { data: dbProducts } = await supabase
            .from("omie_products")
            .select("id, codigo, descricao, account, valor_unitario, estoque")
            .eq("ativo", true)
            .or(`descricao.ilike.%${term}%,codigo.ilike.%${term}%`)
            .limit(20);
          if (dbProducts) {
            for (const p of dbProducts) {
              if (!prodIds.has(p.id)) {
                prodList.push(p);
                prodIds.add(p.id);
              }
            }
          }
        } catch (e) {
          console.error(`Error searching products for term "${term}":`, e);
        }
      }
    }

    // Broad search for common product categories
    const broadTerms = ["thinner", "thiner", "cola", "lixa", "disco", "serra", "broca", "fresa", "lamina"];
    const inputLower = searchText.toLowerCase();
    for (const bt of broadTerms) {
      if (inputLower.includes(bt) || searchTerms.some((t: string) => t.toLowerCase().includes(bt))) {
        try {
          const { data: dbProducts } = await supabase
            .from("omie_products")
            .select("id, codigo, descricao, account, valor_unitario, estoque")
            .eq("ativo", true)
            .ilike("descricao", `%${bt}%`)
            .limit(20);
          if (dbProducts) {
            for (const p of dbProducts) {
              if (!prodIds.has(p.id)) {
                prodList.push(p);
                prodIds.add(p.id);
              }
            }
          }
        } catch (e) {
          console.error(`Error searching broad term "${bt}":`, e);
        }
      }
    }

    console.log(`[analyze-unified-order] Total products: ${prodList.length}, customer candidates: ${customerCandidates.length}, searchCustomer: ${searchCustomer}`);

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

    // Fetch customer purchase history
    let historicoCompras = "";
    if (customerUserId) {
      try {
        const { data: recentItems } = await supabase
          .from("order_items")
          .select("product_id, quantity, unit_price, omie_products(descricao, codigo, account)")
          .eq("customer_user_id", customerUserId)
          .order("created_at", { ascending: false })
          .limit(50);

        const { data: recentOrders } = await supabase
          .from("orders")
          .select("items, service_type, created_at")
          .eq("user_id", customerUserId)
          .order("created_at", { ascending: false })
          .limit(20);

        if (recentItems && recentItems.length > 0) {
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

    // ─── Build system prompt ───
    const customerIdentificationBlock = searchCustomer ? `
IDENTIFICAÇÃO DE CLIENTE:
Além de identificar produtos e serviços, você TAMBÉM deve identificar o CLIENTE mencionado no texto/áudio.
O vendedor pode mencionar o cliente pelo nome fantasia, razão social, ou cidade.
Use a lista de clientes abaixo para encontrar a melhor correspondência.
Se a pessoa mencionar a cidade, use isso para desambiguar entre clientes com nomes similares.
${customerSection || "\nNenhum cliente encontrado na base para os termos buscados."}
` : "";

    const systemPrompt = `Você é um assistente de pedidos para uma empresa que vende produtos industriais (serras, discos, lâminas, brocas, fresas, lixas, thinner, tintas, colas, abrasivos, EPIs, e QUALQUER outro produto do catálogo) e também presta serviços de afiação.
O vendedor pode pedir PRODUTOS que existem em DUAS empresas: Oben (revendedora) e Colacor (fabricante). SEMPRE considere produtos de AMBAS as contas ao identificar itens.
${customerIdentificationBlock}
Sua tarefa: analisar o pedido (texto ou imagem) e identificar:
${searchCustomer ? "0. O CLIENTE mencionado (se houver)" : ""}
1. PRODUTOS do catálogo que o cliente quer comprar, com quantidades — para CADA item, retorne TODAS as variantes encontradas (oben E colacor) se existirem ambas
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
   - EXTRAIA TODOS os códigos, números e nomes de produtos que aparecem no texto (ex: "4403", "Thiner 4403")
   - Use esses códigos para buscar no catálogo por correspondência parcial na descrição (ex: "4403" casa com "THINNER DR.4403LT")

REGRAS DE SUGESTÃO (MUITO IMPORTANTE - SEMPRE RETORNE SUGESTÕES):
8. Se NÃO encontrar correspondência exata, sugira os produtos MAIS SIMILARES do catálogo (por nome parcial, categoria, ou uso semelhante)
9. Use o histórico de compras para sugestões complementares
10. Para sugestões sem product_id exato, use product_id="" e preencha descrição e motivo

REGRAS DE BUSCA NO CATÁLOGO:
11. Ao buscar um produto, procure o termo EM QUALQUER PARTE da descrição. Ex: "4403" casa com "THINNER DR.4403LT" e "THINNER DR.4403L5".
12. Números e códigos parciais são válidos. "02 Thiner 4403" → quantidade=2, produto=Thiner 4403.
13. Se o texto contém quantidade + nome (ex: "02 Thiner 4403"), interprete como: quantidade=2, produto=Thiner 4403.

REGRAS DE EMBALAGEM → SUFIXO DO CÓDIGO DO PRODUTO (MUITO IMPORTANTE - SIGA RIGOROSAMENTE):
14. "lata" OU "18 litros" OU "18L" → sufixo "LT". Ex: "FC6975" + "18L" → "FC6975LT". "DR.4403" + "lata" → "DR.4403LT".
15. "quartinho" OU "900ml" OU "810ml" → sufixo "QT". Ex: "DR.4403QT". ATENÇÃO: "QT" é APENAS para 900ml/810ml, NUNCA para 18L!
16. "balde" OU "20L" OU "20 litros" → sufixo "BH". Ex: "DR.4403BH", "FO56717BH".
17. "galão" OU "3,6L" OU "3.6L" → sufixo "GL". Ex: "DR.4403GL".
18. "5L" OU "5 litros" → sufixo "L5". Ex: "DR.4403L5".
19. EXCEÇÃO ÚNICA produto 6269: "balde" OU "18L" com 6269 → sufixo "BD" (ex: "6269BD"). Esta exceção se aplica SOMENTE ao 6269.
20. RESUMO RÁPIDO: 18L/lata=LT | 900ml=QT | 20L/balde=BH | 3,6L=GL | 5L=L5 | 6269+balde/18L=BD
21. Ex: "3 latas de catalisador FC6975" → "FC6975LT" (18L=LT). NÃO USE QT para 18L!
22. Ex: "5 baldes de FO56717" → "FO56717BH" (balde=BH).
23. Ex: "2 baldes de 6269" → "6269BD" (exceção 6269).
${searchCustomer ? `
REGRAS DE IDENTIFICAÇÃO DE CLIENTE (CRÍTICAS):
21. Você SÓ pode retornar clientes que existam na lista de CLIENTES ENCONTRADOS NA BASE acima.
22. NÃO INVENTE clientes. Se nenhum cliente da lista corresponder, retorne customer como null.
23. Use nome_fantasia ou razao_social para correspondência. Use a CIDADE mencionada para desambiguar.
24. confidence: "high" se nome e cidade batem, "medium" se só nome bate, "low" se correspondência parcial.
25. O campo codigo_cliente DEVE ser um código que exista na lista de clientes fornecida.
` : ""}
Responda SEMPRE usando a função identify_order_items.`;

    const messages: any[] = [
      { role: "system", content: systemPrompt },
    ];

    if (allImages.length > 0) {
      const content: any[] = [
        { type: "text", text: text || "Identifique os produtos, ferramentas e cliente nestas imagens e sugira os itens para o pedido:" },
      ];
      for (const img of allImages) {
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } });
      }
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: "user", content: text });
    }

    // Build tool schema
    const toolProperties: any = {
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
            reason: { type: "string", description: "Motivo da sugestão" },
            userToolId: { type: "string", description: "ID da ferramenta (se type=service)" },
            omie_codigo_servico: { type: "number", description: "Código do serviço (se type=service)" },
            servico_descricao: { type: "string", description: "Descrição do serviço (se type=service)" },
          },
          required: ["type", "descricao", "reason"],
        },
      },
      message: { type: "string", description: "Mensagem amigável explicando o que foi identificado" },
    };

    const requiredFields = ["products", "services", "suggestions", "message"];

    if (searchCustomer) {
      toolProperties.customer = {
        type: ["object", "null"],
        description: "Cliente identificado no pedido. null se nenhum cliente foi mencionado.",
        properties: {
          nome_fantasia: { type: "string", description: "Nome fantasia do cliente" },
          razao_social: { type: "string", description: "Razão social do cliente" },
          cnpj_cpf: { type: "string", description: "CNPJ ou CPF do cliente" },
          cidade: { type: "string", description: "Cidade do cliente" },
          codigo_cliente: { type: "number", description: "Código do cliente no Omie (use 0 se não disponível)" },
          user_id: { type: "string", description: "user_id do cliente no sistema (se disponível na lista de candidatos)" },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "Nível de confiança na identificação" },
        },
        required: ["nome_fantasia", "confidence"],
      };
      requiredFields.push("customer");
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: allImages.length > 0 ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview",
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "identify_order_items",
              description: "Retorna produtos, serviços e cliente identificados no pedido",
              parameters: {
                type: "object",
                properties: toolProperties,
                required: requiredFields,
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
        products: [], services: [], suggestions: [], customer: null,
        message: "Não consegui identificar itens. Seja mais específico ou selecione manualmente.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result = JSON.parse(toolCall.function.arguments);

    // Validate product IDs
    const validProductIds = new Set(prodList.map((p: any) => p.id));
    let validProducts = (result.products || []).filter((p: any) => validProductIds.has(p.product_id));

    // ─── Multi-account optimization: for each product, find equivalent in both accounts ───
    // Pick the account with LESS stock (to clear smaller batches first)
    const prodMap = new Map(prodList.map((p: any) => [p.id, p]));
    const optimizedProducts: any[] = [];
    const processedCodes = new Set<string>();

    for (const vp of validProducts) {
      const prod = prodMap.get(vp.product_id);
      if (!prod) { optimizedProducts.push(vp); continue; }

      // Extract base code (remove account-specific parts)
      const baseCode = prod.codigo;
      const codeKey = `${baseCode}_${vp.quantity}`;
      if (processedCodes.has(codeKey)) continue; // skip duplicate from AI
      processedCodes.add(codeKey);

      // Find equivalent product in the other account by matching codigo
      const otherAccount = prod.account === 'oben' ? 'colacor' : 'oben';
      const equivalent = prodList.find((p: any) => 
        p.codigo === baseCode && p.account === otherAccount
      );

      if (equivalent) {
        const currentStock = prod.estoque ?? 0;
        const otherStock = equivalent.estoque ?? 0;
        
        // Pick the one with LESS stock (to clear inventory)
        // If equal, prefer current selection
        if (otherStock > 0 && otherStock < currentStock) {
          console.log(`[analyze-unified-order] Switching ${baseCode} from ${prod.account}(est:${currentStock}) to ${otherAccount}(est:${otherStock}) - less stock`);
          optimizedProducts.push({
            ...vp,
            product_id: equivalent.id,
            account: otherAccount,
            notes: (vp.notes || '') + ` (Origem otimizada: ${otherAccount}, est: ${otherStock})`,
          });
        } else {
          optimizedProducts.push(vp);
        }
      } else {
        optimizedProducts.push(vp);
      }
    }
    validProducts = optimizedProducts;

    // Validate tool IDs
    const validToolIds = new Set(tools.map((t: any) => t.id));
    const validServices = (result.services || []).filter((s: any) => validToolIds.has(s.userToolId));

    // Validate suggestions
    const validSuggestions = (result.suggestions || []).filter((s: any) => {
      if (s.type === 'product') {
        if (s.product_id && s.product_id !== '') return validProductIds.has(s.product_id);
        return true;
      }
      if (s.type === 'service') {
        if (s.userToolId) return validToolIds.has(s.userToolId);
        return true;
      }
      return true;
    });

    // Validate customer - MUST exist in our candidate list
    let validCustomer = null;
    if (searchCustomer && result.customer) {
      // Check if this customer actually exists in our candidates
      const matchedCandidate = customerCandidates.find((c: any) => {
        // Match by codigo_cliente
        if (c.codigo_cliente && result.customer.codigo_cliente && c.codigo_cliente === result.customer.codigo_cliente) return true;
        // Match by document
        if (c.documento && result.customer.cnpj_cpf) {
          const cDoc = (c.documento || '').replace(/\D/g, '');
          const rDoc = (result.customer.cnpj_cpf || '').replace(/\D/g, '');
          if (cDoc && rDoc && cDoc === rDoc) return true;
        }
        // Match by user_id
        if (c.user_id && result.customer.user_id && c.user_id === result.customer.user_id) return true;
        // Match by name (fuzzy - for image-only mode where profiles don't have codigo_cliente)
        const cName = (c.nome_fantasia || c.nome || '').toLowerCase().trim();
        const rName = (result.customer.nome_fantasia || '').toLowerCase().trim();
        if (cName && rName && cName.length > 3 && rName.length > 3) {
          if (cName.includes(rName) || rName.includes(cName)) return true;
          // Check if key words match
          const rWords = rName.split(/\s+/).filter((w: string) => w.length > 3);
          if (rWords.length > 0 && rWords.every((w: string) => cName.includes(w))) return true;
        }
        return false;
      });

      if (matchedCandidate) {
        validCustomer = {
          nome_fantasia: result.customer.nome_fantasia || matchedCandidate.nome_fantasia || matchedCandidate.nome || "",
          razao_social: result.customer.razao_social || matchedCandidate.razao_social || matchedCandidate.nome || "",
          cnpj_cpf: matchedCandidate.cnpj_cpf || matchedCandidate.documento || result.customer.cnpj_cpf || "",
          cidade: result.customer.cidade || matchedCandidate.cidade || "",
          codigo_cliente: matchedCandidate.codigo_cliente || result.customer.codigo_cliente || 0,
          confidence: result.customer.confidence || "medium",
          user_id: matchedCandidate.user_id || null,
        };
      } else if (result.customer.nome_fantasia) {
        console.log(`[analyze-unified-order] AI returned non-matched customer: ${result.customer.nome_fantasia}, trying broader name match`);
        // Broader fuzzy matching
        const aiName = (result.customer.nome_fantasia || '').toLowerCase();
        const bestMatch = customerCandidates.find((c: any) => {
          const name = (c.nome_fantasia || c.nome || '').toLowerCase();
          return name && aiName && (
            name.split(/\s+/).some((w: string) => w.length > 3 && aiName.includes(w)) ||
            aiName.split(/\s+/).some((w: string) => w.length > 3 && name.includes(w))
          );
        });
        if (bestMatch) {
          validCustomer = {
            nome_fantasia: bestMatch.nome_fantasia || bestMatch.nome || "",
            razao_social: bestMatch.razao_social || bestMatch.nome || "",
            cnpj_cpf: bestMatch.cnpj_cpf || bestMatch.documento || "",
            cidade: bestMatch.cidade || "",
            codigo_cliente: bestMatch.codigo_cliente || 0,
            confidence: "low",
            user_id: bestMatch.user_id || null,
          };
        }
      }
    }

    return new Response(JSON.stringify({
      products: validProducts,
      services: validServices,
      suggestions: validSuggestions,
      customer: validCustomer,
      message: result.message || `Identificado ${validProducts.length} produto(s) e ${validServices.length} serviço(s).`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("analyze-unified-order error:", error);
    return new Response(JSON.stringify({ error: "Erro ao processar solicitação" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

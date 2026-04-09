import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Strip diacritics/accents for fuzzy comparison
function stripAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

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
    const loggedInUserId = (data.claims as any).sub || "";

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
          // Load ALL profiles (including unapproved) — they are valid customers
          const { data: allProfiles } = await supabase
            .from("profiles")
            .select("user_id, name, document, email, phone")
            .limit(1000);
          if (allProfiles) {
            // Batch fetch omie mappings
            const userIds = allProfiles.map(p => p.user_id);
            const { data: omieMappings } = await supabase
              .from("omie_clientes")
              .select("user_id, omie_codigo_cliente")
              .in("user_id", userIds);
            const omieMap = new Map((omieMappings || []).map(m => [m.user_id, m.omie_codigo_cliente]));

            for (const p of allProfiles) {
              // Exclude the logged-in user — they are the seller, not the customer
              if (p.user_id === loggedInUserId) continue;
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
              .limit(20);
            if (profiles) {
              for (const p of profiles) {
                if (p.user_id === loggedInUserId) continue; // exclude seller
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

        // Fuzzy product code search - strip dots/dashes and search by numeric part
        // Handles cases like "FO56717" matching "FO05.6717"
        try {
          const numericPart = term.replace(/[^0-9]/g, '');
          if (numericPart.length >= 3) {
            // Search BOTH codigo AND descricao for numeric part
            const { data: fuzzyProducts } = await supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .or(`codigo.ilike.%${numericPart}%,descricao.ilike.%${numericPart}%`)
              .limit(30);
            if (fuzzyProducts) {
              for (const p of fuzzyProducts) {
                if (!prodIds.has(p.id)) {
                  prodList.push(p);
                  prodIds.add(p.id);
                }
              }
            }
            // Also try with just the last 4 digits if numericPart is longer (e.g., "56717" → "6717")
            if (numericPart.length >= 5) {
              const shortNumeric = numericPart.slice(-4);
              const { data: shortProducts } = await supabase
                .from("omie_products")
                .select("id, codigo, descricao, account, valor_unitario, estoque")
                .eq("ativo", true)
                .or(`descricao.ilike.%${shortNumeric}%,codigo.ilike.%${shortNumeric}%`)
                .limit(30);
              if (shortProducts) {
                for (const p of shortProducts) {
                  if (!prodIds.has(p.id)) {
                    prodList.push(p);
                    prodIds.add(p.id);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error(`Error fuzzy code search:`, e);
        }

        // Also try alphanumeric-stripped version (e.g., "FO56717" → search without dots)
        try {
          const stripped = term.replace(/[.\-\s]/g, '');
          if (stripped.length >= 4) {
            const { data: strippedProducts } = await supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .or(`descricao.ilike.%${stripped}%,codigo.ilike.%${stripped}%`)
              .limit(20);
            if (strippedProducts) {
              for (const p of strippedProducts) {
                if (!prodIds.has(p.id)) {
                  prodList.push(p);
                  prodIds.add(p.id);
                }
              }
            }
          }

          // Extract alpha prefix + numeric suffix for product code patterns like "FO56717" → search "FO" + "6717"
          const alphaMatch = term.match(/^([A-Za-z]{1,4})(\d{3,})/);
          if (alphaMatch) {
            const prefix = alphaMatch[1];
            const digits = alphaMatch[2];
            // Search descricao for prefix + digits (with any separator in between)
            const { data: prefixProducts } = await supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .ilike("descricao", `%${prefix}%${digits.slice(-4)}%`)
              .limit(20);
            if (prefixProducts) {
              for (const p of prefixProducts) {
                if (!prodIds.has(p.id)) {
                  prodList.push(p);
                  prodIds.add(p.id);
                }
              }
            }
          }
        } catch (e) {}
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
3. Priorize correspondências exatas de nome/código. Seja MUITO flexível com sinônimos, abreviações, erros de grafia (ex: "thiner" = "thinner", "disco 7" = "disco de corte 7 polegadas"). CÓDIGOS PODEM TER PONTOS, ZEROS OU DASHES NO MEIO QUE O VENDEDOR OMITE.
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

REGRAS CRÍTICAS DE CORRESPONDÊNCIA DE CÓDIGOS DE PRODUTO:
8. Ao ler um código da imagem/texto, REMOVA mentalmente todos os pontos, hifens, zeros intermediários e compare APENAS os dígitos significativos e as letras-prefixo.
9. EXEMPLOS OBRIGATÓRIOS:
   - "FO56717" na imagem → procure "6717" no catálogo → corresponde a "FO5.6717" ou "FO05.6717" ou "FO10.6717" ou "FO20.6717" (são variantes do mesmo produto base 6717)
   - "FC6975" na imagem → procure "6975" no catálogo → corresponde a "FC.6975" (CATALISADOR FC.6975LT, FC.6975QT, FC.6975L5)
   - "FC6902" NÃO é o mesmo que "FC6975" — são códigos DIFERENTES! NÃO confunda 6902 com 6975!
   - "4403" → corresponde a "DR.4403" (THINNER DR.4403LT)
10. O NÚMERO DO CÓDIGO (ex: 6717, 6975, 4403) é a IDENTIDADE do produto. O prefixo (FO, FC, DR) indica a LINHA. O sufixo (LT, QT, BH, GL, L5) indica a EMBALAGEM.
11. NUNCA substitua um código por outro diferente. "6975" NÃO é "6902". "6717" NÃO é "1480". Compare dígito por dígito.
12. Se o código lido da imagem for "FO56717", decomponha: prefixo=FO, número base=6717 (ignore o "5" intermediário que é parte da versão FO5.6717). Busque no catálogo por itens que contenham "FO" E "6717" na descrição.

REGRA CRÍTICA DE CÓDIGO COMPLETO:
12b. Códigos como "TY.1480.00BB" e "TY.1480.7191BG" são PRODUTOS DIFERENTES! Os dígitos APÓS o ponto decimal importam: ".00" é diferente de ".7191". Quando o vendedor escreve "TY.1480.00", NÃO escolha "TY.1480.7191". Compare o código INTEIRO, não apenas a parte "1480".
12c. Se houver múltiplos produtos com o mesmo prefixo numérico parcial (ex: vários produtos com "1480"), preste atenção ao RESTANTE do código para desambiguar. "BASE ACQUACOLOR TY.1480.00BB" ≠ "ACQUACOLOR CHAMPAGNHE SIER TY.1480.7191BG".

REGRAS DE SUGESTÃO (MUITO IMPORTANTE - SEMPRE RETORNE SUGESTÕES):
13. Se NÃO encontrar correspondência exata, sugira os produtos MAIS SIMILARES do catálogo (por nome parcial, categoria, ou uso semelhante)
14. Use o histórico de compras para sugestões complementares
15. Para sugestões sem product_id exato, use product_id="" e preencha descrição e motivo

REGRAS DE BUSCA NO CATÁLOGO:
16. Ao buscar um produto, procure o termo EM QUALQUER PARTE da descrição. Ex: "4403" casa com "THINNER DR.4403LT" e "THINNER DR.4403L5".
17. Números e códigos parciais são válidos. "02 Thiner 4403" → quantidade=2, produto=Thiner 4403.
18. Se o texto contém quantidade + nome (ex: "02 Thiner 4403"), interprete como: quantidade=2, produto=Thiner 4403.

REGRAS DE EMBALAGEM → SUFIXO DO CÓDIGO DO PRODUTO (MUITO IMPORTANTE - SIGA RIGOROSAMENTE):
19. "lata" OU "18 litros" OU "18L" → sufixo "LT". Ex: "FC6975" + "lata" → busque "FC.6975LT". "DR.4403" + "lata" → busque "DR.4403LT".
20. "quartinho" OU "900ml" OU "810ml" → sufixo "QT". Ex: "DR.4403QT". ATENÇÃO: "QT" é APENAS para 900ml/810ml, NUNCA para 18L!
21. "balde" OU "20L" OU "20 litros" → sufixo "BH". Ex: "DR.4403BH". "FO56717" + "balde" → busque "FO5.6717.00BH" ou "FO10.6717.00BH" (qualquer variante FO*.6717*BH).
22. "galão" OU "3,6L" OU "3.6L" → sufixo "GL". Ex: "DR.4403GL".
23. "5L" OU "5 litros" → sufixo "L5". Ex: "DR.4403L5".
24. EXCEÇÃO ÚNICA produto 6269: "balde" OU "18L" com 6269 → sufixo "BD" (ex: "6269BD"). Esta exceção se aplica SOMENTE ao 6269.
25. RESUMO RÁPIDO: 18L/lata=LT | 900ml=QT | 20L/balde=BH | 3,6L=GL | 5L=L5 | 6269+balde/18L=BD

REGRA CRÍTICA DE EMBALAGEM ÚNICA:
26. Quando a embalagem está ESPECIFICADA na imagem ou texto (ex: "18L", "lata", "balde", "5L", "galão", "quartinho"), retorne APENAS a variante correspondente àquela embalagem. NÃO retorne múltiplas variantes do mesmo produto com embalagens diferentes.
   Exemplo: "6673 18L" → retorne APENAS o produto com sufixo LT (18L). NÃO inclua a variante L5 (5L) nem qualquer outra embalagem.
   Exemplo: "4403 5L" → retorne APENAS o produto com sufixo L5. NÃO inclua LT, QT, BH ou GL.
27. Se a embalagem NÃO está especificada, retorne a variante mais comum (geralmente LT/18L) como produto principal e as outras como sugestões.
26. Ex: "3 latas de catalisador FC6975" → busque "CATALISADOR FC.6975LT" no catálogo (18L=LT).
27. Ex: "5 baldes de FO56717" → busque produtos com "6717" E "BH" na descrição → "VERNIZ PU FOSCO FO5.6717.00BH" ou "FO10.6717.00BH".
${searchCustomer ? `
REGRAS DE IDENTIFICAÇÃO DE CLIENTE (CRÍTICAS):
28. Você SÓ pode retornar clientes que existam na lista de CLIENTES ENCONTRADOS NA BASE acima.
29. NÃO INVENTE clientes. Se nenhum cliente da lista corresponder, retorne customer como null.
30. Use APENAS nome_fantasia ou razao_social para correspondência — NUNCA retorne um cliente só porque aparece primeiro na lista.
31. Compare o nome do cliente mencionado no pedido com CADA candidato na lista. Escolha o que tem nome MAIS SIMILAR.
32. confidence: "high" se nome e cidade batem, "medium" se só nome bate, "low" se correspondência parcial.
33. O campo user_id DEVE ser o user_id exato do candidato correspondente na lista. NÃO use o user_id de outro candidato.
34. Nomes podem conter ERROS DE GRAFIA. "Lorham" = "Lohan", "Metalurgica" = "Metalúrgica". Compare FONETICAMENTE.
35. Se o pedido menciona "Lorham Móveis" ou "Loham Moveis", procure na lista um nome como "LOHAN MOVEIS" — são o mesmo cliente com grafia diferente.
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
            unit_price: { type: "number", description: "Preço unitário do produto" },
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
            unit_price: { type: "number", description: "Último preço praticado para o cliente" },
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

    // Validate product IDs - rescue invalid ones by fuzzy matching
    const validProductIds = new Set(prodList.map((p: any) => p.id));
    const aiProducts = result.products || [];
    let validProducts: any[] = [];
    
    for (const ap of aiProducts) {
      if (validProductIds.has(ap.product_id)) {
        validProducts.push(ap);
      } else {
        // Try to rescue by matching codigo or descricao against prodList
        console.log(`[analyze-unified-order] Product ID not valid: ${ap.product_id}, trying rescue by codigo="${ap.codigo}" descricao="${ap.descricao}"`);
        
        let rescued = false;
        const apCodigo = (ap.codigo || '').replace(/[.\-\s]/g, '').toLowerCase();
        const apDesc = (ap.descricao || '').toLowerCase();
        const apDescStripped = apDesc.replace(/[.\-\s]/g, '');
        
        // Extract ALL numeric sequences (4+ digits) from both codigo and descricao
        const allNumericCodes = new Set<string>();
        for (const src of [ap.codigo || '', ap.descricao || '']) {
          const nums = src.match(/\d{3,}/g);
          if (nums) nums.forEach((n: string) => allNumericCodes.add(n));
          // Also extract last 4 digits from longer sequences (e.g., "56717" → "6717")
          if (nums) {
            for (const n of nums) {
              if (n.length >= 5) allNumericCodes.add(n.slice(-4));
            }
          }
        }

        // Extract alpha prefix from codigo (e.g., "FO" from "FO5.6717BH")
        const prefixFromCodigo = (ap.codigo || '').match(/^([A-Za-z]{2,3})/);
        const alphaPrefix = prefixFromCodigo ? prefixFromCodigo[1].toUpperCase() : null;

        // Extract suffix for packaging (BH, LT, QT, GL, L5, BD)
        const suffixMatch = (ap.codigo || '' + ' ' + ap.descricao || '').match(/(BH|LT|QT|GL|L5|BD)\b/i);
        const packSuffix = suffixMatch ? suffixMatch[1].toUpperCase() : null;

        // 1. Exact codigo match (stripped)
        if (apCodigo) {
          const match = prodList.find((p: any) => {
            const pDesc = p.descricao.replace(/[.\-\s]/g, '').toLowerCase();
            const pCodigo = p.codigo.replace(/[.\-\s]/g, '').toLowerCase();
            return pCodigo === apCodigo || pDesc.includes(apCodigo);
          });
          if (match) {
            console.log(`[analyze-unified-order] Rescued by codigo: ${ap.codigo} → ${match.descricao} (${match.id})`);
            validProducts.push({ ...ap, product_id: match.id, codigo: match.codigo, descricao: match.descricao, account: match.account, unit_price: ap.unit_price || match.valor_unitario });
            rescued = true;
          }
        }
        
        // 2. Search by numeric code + prefix + suffix (most precise)
        if (!rescued && allNumericCodes.size > 0) {
          for (const nc of allNumericCodes) {
            // Find all products containing this numeric code
            const candidates = prodList.filter((p: any) => p.descricao.includes(nc));
            if (candidates.length === 0) continue;
            
            // If we have prefix and suffix, find best match
            if (alphaPrefix && packSuffix) {
              const bestMatch = candidates.find((p: any) => {
                const desc = p.descricao.toUpperCase();
                return desc.includes(alphaPrefix) && desc.includes(packSuffix);
              });
              if (bestMatch) {
                console.log(`[analyze-unified-order] Rescued by prefix+numeric+suffix: ${ap.codigo}/${ap.descricao} → ${bestMatch.descricao}`);
                validProducts.push({ ...ap, product_id: bestMatch.id, codigo: bestMatch.codigo, descricao: bestMatch.descricao, account: bestMatch.account, unit_price: ap.unit_price || bestMatch.valor_unitario });
                rescued = true;
                break;
              }
            }
            // Try prefix only
            if (!rescued && alphaPrefix) {
              const prefixMatch = candidates.find((p: any) => p.descricao.toUpperCase().includes(alphaPrefix));
              if (prefixMatch) {
                console.log(`[analyze-unified-order] Rescued by prefix+numeric: ${ap.codigo}/${ap.descricao} → ${prefixMatch.descricao}`);
                validProducts.push({ ...ap, product_id: prefixMatch.id, codigo: prefixMatch.codigo, descricao: prefixMatch.descricao, account: prefixMatch.account, unit_price: ap.unit_price || prefixMatch.valor_unitario });
                rescued = true;
                break;
              }
            }
            // Try suffix only
            if (!rescued && packSuffix) {
              const suffMatch = candidates.find((p: any) => p.descricao.toUpperCase().includes(packSuffix));
              if (suffMatch) {
                console.log(`[analyze-unified-order] Rescued by numeric+suffix: ${ap.codigo}/${ap.descricao} → ${suffMatch.descricao}`);
                validProducts.push({ ...ap, product_id: suffMatch.id, codigo: suffMatch.codigo, descricao: suffMatch.descricao, account: suffMatch.account, unit_price: ap.unit_price || suffMatch.valor_unitario });
                rescued = true;
                break;
              }
            }
            // Fallback: first candidate with numeric match — but ONLY if there's exactly one candidate
            // If multiple candidates exist (e.g., 6673LT and 6673L5), do NOT auto-pick; move to suggestions
            if (!rescued) {
              if (candidates.length === 1) {
                const match = candidates[0];
                console.log(`[analyze-unified-order] Rescued by numeric (single match): ${ap.codigo}/${ap.descricao} → ${match.descricao}`);
                validProducts.push({ ...ap, product_id: match.id, codigo: match.codigo, descricao: match.descricao, account: match.account, unit_price: ap.unit_price || match.valor_unitario });
                rescued = true;
              } else {
                console.log(`[analyze-unified-order] Multiple candidates for ${nc}, not auto-picking. Moving to suggestions.`);
              }
              break;
            }
          }
        }
        
        // 3. Last resort: query DB directly for numeric codes not in prodList
        if (!rescued && allNumericCodes.size > 0) {
          for (const nc of allNumericCodes) {
            try {
              let query = supabase
                .from("omie_products")
                .select("id, codigo, descricao, account, valor_unitario, estoque")
                .eq("ativo", true)
                .ilike("descricao", `%${nc}%`);
              if (packSuffix) query = query.ilike("descricao", `%${packSuffix}%`);
              if (alphaPrefix) query = query.ilike("descricao", `%${alphaPrefix}%`);
              const { data: dbRescue } = await query.limit(5);
              if (dbRescue && dbRescue.length > 0) {
                const best = dbRescue[0];
                console.log(`[analyze-unified-order] Rescued from DB: ${ap.codigo}/${ap.descricao} → ${best.descricao}`);
                validProducts.push({ ...ap, product_id: best.id, codigo: best.codigo, descricao: best.descricao, account: best.account, unit_price: ap.unit_price || best.valor_unitario });
                rescued = true;
                break;
              }
            } catch (e) {
              console.error(`DB rescue error for ${nc}:`, e);
            }
          }
        }

        // 4. If still not rescued, move to suggestions
        if (!rescued) {
          console.log(`[analyze-unified-order] Could not rescue product, moving to suggestions: ${ap.descricao}`);
          result.suggestions = result.suggestions || [];
          result.suggestions.push({
            type: 'product',
            product_id: '',
            codigo: ap.codigo || '',
            descricao: ap.descricao || 'Produto não identificado',
            quantity: ap.quantity || 1,
            account: ap.account || 'oben',
            reason: `Produto "${ap.descricao || ap.codigo}" mencionado mas não encontrado no catálogo`,
          });
        }
      }
    }

    // ─── Variant dedup: if AI returned multiple packaging variants of same base product, keep only best match ───
    // e.g. if both 6673LT (18L) and 6673L5 (5L) are returned, keep only the one matching context
    const packingSuffixes = ['LT', 'L5', 'QT', 'GL', 'BH', 'BD'];
    const inputContext = (text || '').toUpperCase() + ' ' + (result.message || '').toUpperCase();
    
    // Group validProducts by their base numeric code (e.g., "6673")
    const variantGroups = new Map<string, any[]>();
    for (const vp of validProducts) {
      const prod = prodList.find((p: any) => p.id === vp.product_id);
      if (!prod) { continue; }
      // Extract numeric code from descricao (e.g., "6673" from "FL.6673.00LT")
      const numMatch = prod.descricao.match(/(\d{4,})/);
      if (!numMatch) { continue; }
      const baseNum = numMatch[1];
      // Check if descricao ends with a packing suffix
      const hasSuffix = packingSuffixes.some(s => prod.descricao.toUpperCase().includes(s));
      if (!hasSuffix) { continue; }
      
      if (!variantGroups.has(baseNum)) variantGroups.set(baseNum, []);
      variantGroups.get(baseNum)!.push({ vp, prod });
    }
    
    // For groups with >1 variant, pick the best match
    const removedProductIds = new Set<string>();
    for (const [baseNum, group] of variantGroups) {
      if (group.length <= 1) continue;
      
      console.log(`[analyze-unified-order] Variant dedup: ${baseNum} has ${group.length} variants: ${group.map((g: any) => g.prod.descricao).join(', ')}`);
      
      // Score each variant by context clues
      let bestIdx = 0;
      let bestScore = -1;
      for (let i = 0; i < group.length; i++) {
        const desc = group[i].prod.descricao.toUpperCase();
        let score = 0;
        // Exact suffix in input context
        if (desc.includes('LT') && (inputContext.includes('18L') || inputContext.includes('LATA') || inputContext.includes('18 L'))) score += 10;
        if (desc.includes('L5') && (inputContext.includes('5L') || inputContext.includes('5 L') || inputContext.includes('CINCO'))) score += 10;
        if (desc.includes('QT') && (inputContext.includes('900') || inputContext.includes('QUARTINHO') || inputContext.includes('810'))) score += 10;
        if (desc.includes('GL') && (inputContext.includes('GALÃO') || inputContext.includes('GALAO') || inputContext.includes('3,6') || inputContext.includes('3.6'))) score += 10;
        if (desc.includes('BH') && (inputContext.includes('BALDE') || inputContext.includes('20L') || inputContext.includes('20 L'))) score += 10;
        if (desc.includes('BD') && (inputContext.includes('BALDE') || inputContext.includes('18L') || inputContext.includes('18 L'))) score += 10;
        // If LT suffix and no specific size mentioned, prefer LT (most common)
        if (desc.includes('LT') && !inputContext.match(/\b(5L|5 L|900|QUARTINHO|810|GALÃO|GALAO|3[,.]6|BALDE|20L|20 L)\b/i)) score += 2;
        // Higher price = larger packaging = more likely if context says "18L"
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      
      // Remove all except best
      for (let i = 0; i < group.length; i++) {
        if (i !== bestIdx) {
          removedProductIds.add(group[i].vp.product_id);
          console.log(`[analyze-unified-order] Variant dedup: removing ${group[i].prod.descricao} in favor of ${group[bestIdx].prod.descricao}`);
        }
      }
    }
    
    if (removedProductIds.size > 0) {
      validProducts = validProducts.filter((vp: any) => !removedProductIds.has(vp.product_id));
    }

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

    // Validate suggestions — also DEDUP: remove suggestions that are already in validProducts
    const validProductIdSet = new Set(validProducts.map((vp: any) => vp.product_id));
    const validSuggestions = (result.suggestions || []).filter((s: any) => {
      if (s.type === 'product') {
        // Remove if this product is already in the confirmed products list
        if (s.product_id && s.product_id !== '' && validProductIdSet.has(s.product_id)) return false;
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
      console.log(`[analyze-unified-order] AI returned customer: "${result.customer.nome_fantasia}", candidates: ${customerCandidates.length}`);
      
      // Helper: check if two names share significant words
      // IMPORTANT: ignore common business suffixes that would cause false positives
      const STOP_WORDS = new Set(['ltda', 'eireli', 'epp', 'mei', 'sa', 'ss', 'me', 'comercio', 'industria', 'servicos', 'com', 'ind', 'serv', 'dos', 'das', 'para', 'que', 'the', 'and']);
      const shareWords = (name1: string, name2: string): boolean => {
        const w1 = stripAccents(name1.toLowerCase()).split(/\s+/).filter((w: string) => w.length >= 3 && !STOP_WORDS.has(w));
        const w2 = stripAccents(name2.toLowerCase()).split(/\s+/).filter((w: string) => w.length >= 3 && !STOP_WORDS.has(w));
        if (w1.length === 0 || w2.length === 0) return false;
        // Check direct word inclusion — require at least one SIGNIFICANT word match
        let significantMatches = 0;
        for (const w of w1) {
          if (w.length >= 4 && w2.some((w2w: string) => w2w.includes(w) || w.includes(w2w))) significantMatches++;
        }
        if (significantMatches >= 1) return true;
        // Edit distance for typos (Lorham→Lohan) — only for significant words (length >= 4)
        for (const a of w1) {
          if (a.length < 4) continue;
          for (const b of w2) {
            if (b.length < 4) continue;
            if (Math.abs(a.length - b.length) > 2) continue;
            let diffs = 0;
            const maxLen = Math.max(a.length, b.length);
            for (let i = 0; i < maxLen; i++) {
              if ((a[i] || '') !== (b[i] || '')) diffs++;
            }
            if (diffs <= 2) return true;
          }
        }
        return false;
      };

      // Check if this customer actually exists in our candidates
      // IMPORTANT: Do NOT trust AI's user_id — only match by name, document, or codigo_cliente
      const matchedCandidate = customerCandidates.find((c: any) => {
        // Match by codigo_cliente
        if (c.codigo_cliente && result.customer.codigo_cliente && c.codigo_cliente === result.customer.codigo_cliente) return true;
        // Match by document
        if (c.documento && result.customer.cnpj_cpf) {
          const cDoc = (c.documento || '').replace(/\D/g, '');
          const rDoc = (result.customer.cnpj_cpf || '').replace(/\D/g, '');
          if (cDoc && rDoc && cDoc === rDoc) return true;
        }
        // DO NOT match by user_id — AI often returns wrong user_id from the candidate list index
        // Match by name (fuzzy)
        const cName = stripAccents((c.nome_fantasia || c.nome || '').toLowerCase().trim());
        const rName = stripAccents((result.customer.nome_fantasia || '').toLowerCase().trim());
        if (cName && rName && cName.length > 2 && rName.length > 2) {
          if (cName.includes(rName) || rName.includes(cName)) return true;
          if (shareWords(cName, rName)) return true;
        }
        return false;
      });

      if (matchedCandidate) {
        console.log(`[analyze-unified-order] Customer matched: "${matchedCandidate.nome_fantasia || matchedCandidate.nome}" (user_id: ${matchedCandidate.user_id})`);
        validCustomer = {
          nome_fantasia: matchedCandidate.nome_fantasia || matchedCandidate.nome || result.customer.nome_fantasia || "",
          razao_social: matchedCandidate.razao_social || matchedCandidate.nome || "",
          cnpj_cpf: matchedCandidate.cnpj_cpf || matchedCandidate.documento || result.customer.cnpj_cpf || "",
          cidade: result.customer.cidade || matchedCandidate.cidade || "",
          codigo_cliente: matchedCandidate.codigo_cliente || result.customer.codigo_cliente || 0,
          confidence: result.customer.confidence || "medium",
          user_id: matchedCandidate.user_id || null,
        };
      } else if (result.customer.nome_fantasia) {
        console.log(`[analyze-unified-order] No direct match, trying broader search for: "${result.customer.nome_fantasia}"`);
        // Log all candidates for debugging
        for (const c of customerCandidates.slice(0, 10)) {
          const cn = c.nome_fantasia || c.nome || 'N/A';
          console.log(`[analyze-unified-order] Candidate: "${cn}"`);
        }
        
        const bestMatch = customerCandidates.find((c: any) => {
          const name = stripAccents((c.nome_fantasia || c.nome || '').toLowerCase());
          const aiName = stripAccents((result.customer.nome_fantasia || '').toLowerCase());
          if (!name || !aiName) return false;
          return shareWords(name, aiName);
        });
        
        if (bestMatch) {
          console.log(`[analyze-unified-order] Broader match found: "${bestMatch.nome_fantasia || bestMatch.nome}"`);
          validCustomer = {
            nome_fantasia: bestMatch.nome_fantasia || bestMatch.nome || "",
            razao_social: bestMatch.razao_social || bestMatch.nome || "",
            cnpj_cpf: bestMatch.cnpj_cpf || bestMatch.documento || "",
            cidade: bestMatch.cidade || "",
            codigo_cliente: bestMatch.codigo_cliente || 0,
            confidence: "low",
            user_id: bestMatch.user_id || null,
          };
        } else {
          console.log(`[analyze-unified-order] No customer match found at all`);
        }
      }
    }

    // Enrich products and suggestions with customer-specific last practiced prices
    if (validCustomer?.user_id || validCustomer?.codigo_cliente) {
      try {
        const priceMap: Record<string, number> = {};

        // 1) Local DB: order_items + sales_price_history
        if (validCustomer?.user_id) {
          const [orderItemsRes, salesPricesRes] = await Promise.all([
            supabase
              .from("order_items")
              .select("product_id, unit_price")
              .eq("customer_user_id", validCustomer.user_id)
              .order("created_at", { ascending: false })
              .limit(200),
            supabase
              .from("sales_price_history")
              .select("product_id, unit_price")
              .eq("customer_user_id", validCustomer.user_id)
              .order("created_at", { ascending: false })
              .limit(200),
          ]);

          if (orderItemsRes.data) {
            for (const ph of orderItemsRes.data) {
              if (ph.product_id && !priceMap[ph.product_id]) {
                priceMap[ph.product_id] = ph.unit_price;
              }
            }
          }
          if (salesPricesRes.data) {
            for (const sp of salesPricesRes.data) {
              if (!priceMap[sp.product_id]) {
                priceMap[sp.product_id] = sp.unit_price;
              }
            }
          }
        }

        // 2) Omie ERP: fetch last practiced prices from Omie orders (same as manual flow)
        if (validCustomer?.codigo_cliente && Number(validCustomer.codigo_cliente) > 0) {
          try {
            // Collect all product IDs we need prices for
            const allProductIds = [
              ...validProducts.map((vp: any) => vp.product_id),
              ...validSuggestions.filter((vs: any) => vs.product_id).map((vs: any) => vs.product_id),
            ].filter(Boolean);

            // Get omie_codigo_produto mapping for identified products
            let omieCodeMap: Record<number, string> = {}; // omie_codigo_produto → product_id
            if (allProductIds.length > 0) {
              const { data: productMappings } = await supabase
                .from("omie_products")
                .select("id, omie_codigo_produto")
                .in("id", allProductIds);
              if (productMappings) {
                for (const pm of productMappings) {
                  omieCodeMap[pm.omie_codigo_produto] = pm.id;
                }
              }
            }

            // Fetch prices from Omie for both accounts
            const OMIE_OBEN_KEY = Deno.env.get("OMIE_VENDAS_APP_KEY");
            const OMIE_OBEN_SECRET = Deno.env.get("OMIE_VENDAS_APP_SECRET");
            const OMIE_COLACOR_KEY = Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY");
            const OMIE_COLACOR_SECRET = Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET");

            const fetchOmiePrices = async (appKey: string, appSecret: string, codigoCliente: number): Promise<Record<number, number>> => {
              try {
                const omieRes = await fetch("https://app.omie.com.br/api/v1/produtos/pedido/", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    call: "ListarPedidos",
                    app_key: appKey,
                    app_secret: appSecret,
                    param: [{
                      pagina: 1,
                      registros_por_pagina: 50,
                      filtrar_por_cliente: codigoCliente,
                      filtrar_apenas_inclusao: "N",
                    }],
                  }),
                });
                const data = await omieRes.json();
                const precos: Record<number, number> = {};
                const pedidos = data.pedido_venda_produto || [];
                for (const pedido of pedidos) {
                  const itens = pedido.det || [];
                  for (const item of itens) {
                    const codigoProduto = item.produto?.codigo_produto;
                    const valorUnit = item.produto?.valor_unitario;
                    if (codigoProduto && valorUnit && !precos[codigoProduto]) {
                      precos[codigoProduto] = valorUnit;
                    }
                  }
                }
                return precos;
              } catch (e) {
                console.error("Error fetching Omie prices:", e);
                return {};
              }
            };

            // Fetch from both accounts in parallel
            const omiePricePromises: Promise<Record<number, number>>[] = [];
            if (OMIE_OBEN_KEY && OMIE_OBEN_SECRET) {
              omiePricePromises.push(fetchOmiePrices(OMIE_OBEN_KEY, OMIE_OBEN_SECRET, validCustomer.codigo_cliente));
            }
            if (OMIE_COLACOR_KEY && OMIE_COLACOR_SECRET) {
              // For colacor, we might need a different codigo_cliente; try the same one
              omiePricePromises.push(fetchOmiePrices(OMIE_COLACOR_KEY, OMIE_COLACOR_SECRET, validCustomer.codigo_cliente));
            }

            const omieResults = await Promise.all(omiePricePromises);
            
            // Merge Omie prices - Omie takes priority over local
            for (const omiePrices of omieResults) {
              for (const [omieCode, price] of Object.entries(omiePrices)) {
                const productId = omieCodeMap[Number(omieCode)];
                if (productId && price > 0) {
                  priceMap[productId] = price; // Omie overrides local
                }
              }
            }

            // Also build a broader omie code map for all products in catalog (for items not yet in omieCodeMap)
            if (Object.keys(omieResults.reduce((acc, r) => ({ ...acc, ...r }), {})).length > 0) {
              const allOmieCodes = omieResults.flatMap(r => Object.keys(r).map(Number));
              const missingCodes = allOmieCodes.filter(c => !omieCodeMap[c]);
              if (missingCodes.length > 0) {
                const { data: extraMappings } = await supabase
                  .from("omie_products")
                  .select("id, omie_codigo_produto")
                  .in("omie_codigo_produto", missingCodes);
                if (extraMappings) {
                  for (const pm of extraMappings) {
                    omieCodeMap[pm.omie_codigo_produto] = pm.id;
                  }
                  // Re-apply Omie prices with new mappings
                  for (const omiePrices of omieResults) {
                    for (const [omieCode, price] of Object.entries(omiePrices)) {
                      const productId = omieCodeMap[Number(omieCode)];
                      if (productId && price > 0) {
                        priceMap[productId] = price;
                      }
                    }
                  }
                }
              }
            }

            console.log(`[analyze-unified-order] Omie price enrichment: found ${Object.keys(priceMap).length} prices`);
          } catch (omieErr) {
            console.error("Error fetching Omie prices for AI response:", omieErr);
          }
        }

        // Apply prices to products
        for (const vp of validProducts) {
          if (priceMap[vp.product_id]) {
            vp.unit_price = priceMap[vp.product_id];
          }
        }

        // Apply prices to suggestions
        for (const vs of validSuggestions) {
          if (vs.product_id && priceMap[vs.product_id]) {
            vs.unit_price = priceMap[vs.product_id];
          }
        }
      } catch (e) {
        console.error("Error fetching customer prices for AI response:", e);
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

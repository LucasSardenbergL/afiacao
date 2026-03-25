import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type OmieAccount = "vendas" | "servicos";

function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return {
      key: Deno.env.get("OMIE_VENDAS_APP_KEY"),
      secret: Deno.env.get("OMIE_VENDAS_APP_SECRET"),
    };
  }
  return {
    key: Deno.env.get("OMIE_APP_KEY"),
    secret: Deno.env.get("OMIE_APP_SECRET"),
  };
}

async function callOmie(account: OmieAccount, endpoint: string, call: string, params: Record<string, unknown>) {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais Omie (${account}) não configuradas`);

  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };
  const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
  return result;
}

// ======== SYNC STATE HELPERS ========

async function getSyncState(db: ReturnType<typeof createClient>, entityType: string, account: string) {
  const { data } = await db
    .from("sync_state")
    .select("*")
    .eq("entity_type", entityType)
    .eq("account", account)
    .maybeSingle();
  return data;
}

async function updateSyncState(
  db: ReturnType<typeof createClient>,
  entityType: string,
  account: string,
  updates: Record<string, unknown>
) {
  await db.from("sync_state").upsert(
    { entity_type: entityType, account, ...updates, updated_at: new Date().toISOString() },
    { onConflict: "entity_type,account" }
  );
}

// ======== SYNC CUSTOMERS ========

async function syncCustomers(db: ReturnType<typeof createClient>, account: OmieAccount) {
  await updateSyncState(db, "customers", account, { status: "running", error_message: null });
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  try {
    while (pagina <= totalPaginas) {
      const result = await callOmie(account, "geral/clientes/", "ListarClientes", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
      }) as any;

      totalPaginas = result.total_de_paginas || 1;
      const clientes = result.clientes_cadastro || [];

      // We don't create a separate customers table - we enrich omie_clientes
      // and profiles where possible. Log the sync progress.
      for (const c of clientes) {
        const doc = (c.cnpj_cpf || "").replace(/\D/g, "");
        if (!doc) continue;

        // Check if this client is mapped to a user
        const { data: mapping } = await db
          .from("omie_clientes")
          .select("id, user_id")
          .eq("omie_codigo_cliente", c.codigo_cliente_omie)
          .maybeSingle();

        if (!mapping) {
          // Try to find by document in profiles
          const { data: profile } = await db
            .from("profiles")
            .select("user_id")
            .eq("document", doc)
            .maybeSingle();

          if (profile) {
            await db.from("omie_clientes").upsert({
              user_id: profile.user_id,
              omie_codigo_cliente: c.codigo_cliente_omie,
              omie_codigo_cliente_integracao: c.codigo_cliente_integracao || null,
              omie_codigo_vendedor: c.codigo_vendedor || null,
            }, { onConflict: "user_id" });
            totalSynced++;
          }
        } else {
          // Update vendedor if changed
          await db.from("omie_clientes")
            .update({ omie_codigo_vendedor: c.codigo_vendedor || null, updated_at: new Date().toISOString() })
            .eq("id", mapping.id);
          totalSynced++;
        }
      }

      console.log(`[Sync ${account}] Clientes página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await updateSyncState(db, "customers", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "customers", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== SYNC PRODUCTS ========

async function syncProducts(db: ReturnType<typeof createClient>, account: OmieAccount, startPage = 1, maxPages = 10) {
  await updateSyncState(db, "products", account, { status: "running", error_message: null });
  let pagina = startPage;
  let totalPaginas = startPage;
  let totalSynced = 0;
  let pagesProcessed = 0;

  try {
    while (pagina <= totalPaginas && pagesProcessed < maxPages) {
      const result = await callOmie(account, "geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      }) as any;

      totalPaginas = result.total_de_paginas || 1;
      const produtos = result.produto_servico_cadastro || [];

      if (account === "vendas") {
        // Upsert to omie_products (existing table)
        const rows = produtos
          .filter((p: any) => p.inativo !== "S")
          .map((p: any) => ({
            omie_codigo_produto: p.codigo_produto,
            omie_codigo_produto_integracao: p.codigo_produto_integracao || null,
            codigo: p.codigo || `PROD-${p.codigo_produto}`,
            descricao: p.descricao || "Sem descrição",
            unidade: p.unidade || "UN",
            ncm: p.ncm || null,
            valor_unitario: p.valor_unitario || 0,
            estoque: p.quantidade_estoque || 0,
            ativo: true,
            imagem_url: p.imagens?.[0]?.url_imagem || null,
            familia: p.descricao_familia || null,
            subfamilia: p.descricao_subfamilia || null,
            metadata: {
              marca: p.marca,
              modelo: p.modelo,
              peso_bruto: p.peso_bruto,
              peso_liq: p.peso_liq,
              descricao_familia: p.descricao_familia,
              cfop: p.cfop,
            },
            updated_at: new Date().toISOString(),
          }));

        if (rows.length > 0) {
          const { error } = await db.from("omie_products").upsert(rows, { onConflict: "omie_codigo_produto" });
          if (error) console.error(`[Sync] Erro upsert produtos p${pagina}:`, error);
          else totalSynced += rows.length;
        }
      }

      console.log(`[Sync ${account}] Produtos página ${pagina}/${totalPaginas}`);
      pagina++;
      pagesProcessed++;
    }

    await updateSyncState(db, "products", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    const complete = pagina > totalPaginas;
    await updateSyncState(db, "products", account, {
      status: complete ? "complete" : "partial",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: pagina - 1,
    });
    return { totalSynced, totalPages: totalPaginas, lastPage: pagina - 1, complete, nextPage: complete ? null : pagina };
  } catch (error) {
    await updateSyncState(db, "products", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== SYNC ORDERS (INCREMENTAL) ========

async function syncOrdersIncremental(db: ReturnType<typeof createClient>, account: OmieAccount) {
  await updateSyncState(db, "orders", account, { status: "running", error_message: null });

  const state = await getSyncState(db, "orders", account);
  // Janela de segurança: 24h antes do último sync
  const lastSync = state?.last_cursor
    ? new Date(new Date(state.last_cursor).getTime() - 24 * 60 * 60 * 1000)
    : new Date("2024-01-01");

  const formatOmieDate = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  try {
    while (pagina <= totalPaginas) {
      const params: Record<string, unknown> = {
        pagina,
        registros_por_pagina: 100,
        filtrar_apenas_inclusao: "N",
      };

      // Incremental filter by date
      if (lastSync) {
        params.filtrar_por_data_de = formatOmieDate(lastSync);
        params.filtrar_por_data_ate = formatOmieDate(new Date());
      }

      const result = await callOmie(account, "produtos/pedido/", "ListarPedidos", params) as any;
      totalPaginas = result.total_de_paginas || 1;
      const pedidos = result.pedido_venda_produto || [];

      for (const pedido of pedidos) {
        const cab = pedido.cabecalho || {};
        const codigoCliente = cab.codigo_cliente;
        const itens = pedido.det || [];

        // Find the customer_user_id from omie_clientes
        const { data: mapping } = await db
          .from("omie_clientes")
          .select("user_id")
          .eq("omie_codigo_cliente", codigoCliente)
          .maybeSingle();

        if (!mapping) continue; // Skip if customer not mapped

        // Normalize order items
        for (const item of itens) {
          const prod = item.produto || {};
          const codigoProduto = prod.codigo_produto;
          const quantidade = prod.quantidade || 1;
          const valorUnit = prod.valor_unitario || 0;

          // Find product_id
          const { data: product } = await db
            .from("omie_products")
            .select("id")
            .eq("omie_codigo_produto", codigoProduto)
            .maybeSingle();

          // Check if we already have this order in sales_orders
          const omieNumPedido = String(cab.numero_pedido || cab.codigo_pedido);
          const { data: existingOrder } = await db
            .from("sales_orders")
            .select("id")
            .eq("omie_numero_pedido", omieNumPedido)
            .maybeSingle();

          if (existingOrder) {
            // Upsert order_items for existing order
            await db.from("order_items").upsert({
              sales_order_id: existingOrder.id,
              customer_user_id: mapping.user_id,
              product_id: product?.id || null,
              omie_codigo_produto: codigoProduto,
              quantity: quantidade,
              unit_price: valorUnit,
            }, { onConflict: "sales_order_id,omie_codigo_produto" }).select();
            // Note: we'd need a unique index for this upsert to work perfectly
            // For now, just insert
          }

          // Also record in sales_price_history for the pricing engine
          if (product?.id && valorUnit > 0) {
            await db.from("sales_price_history").upsert({
              customer_user_id: mapping.user_id,
              product_id: product.id,
              unit_price: valorUnit,
              sales_order_id: existingOrder?.id || null,
            }, { ignoreDuplicates: true });
          }

          totalSynced++;
        }
      }

      console.log(`[Sync ${account}] Pedidos página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await updateSyncState(db, "orders", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_cursor: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "orders", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== SYNC INVENTORY ========

async function syncInventory(db: ReturnType<typeof createClient>, account: OmieAccount) {
  await updateSyncState(db, "inventory", account, { status: "running", error_message: null });
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  try {
    while (pagina <= totalPaginas) {
      const result = await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
      }) as any;

      totalPaginas = result.nTotPaginas || 1;
      const produtos = result.produtos || [];

      for (const prod of produtos) {
        const codProd = prod.nCodProd;
        if (!codProd) continue;

        const saldo = prod.nSaldo ?? 0;
        const cmc = prod.nCMC ?? 0;
        const precoMedio = prod.nPrecoMedio ?? 0;

        // Find product_id
        const { data: product } = await db
          .from("omie_products")
          .select("id")
          .eq("omie_codigo_produto", codProd)
          .maybeSingle();

        // Upsert inventory_position
        await db.from("inventory_position").upsert({
          omie_codigo_produto: codProd,
          product_id: product?.id || null,
          saldo,
          cmc,
          preco_medio: precoMedio,
          account,
          synced_at: new Date().toISOString(),
        }, { onConflict: "omie_codigo_produto,account" });

        // Update omie_products stock
        if (product?.id) {
          await db.from("omie_products")
            .update({ estoque: saldo, updated_at: new Date().toISOString() })
            .eq("id", product.id);
        }

        // Update product_costs with CMC if available
        if (product?.id && cmc > 0) {
          const { data: existingCost } = await db
            .from("product_costs")
            .select("id, cost_price")
            .eq("product_id", product.id)
            .maybeSingle();

          if (existingCost) {
            await db.from("product_costs")
              .update({ cmc, updated_at: new Date().toISOString() })
              .eq("id", existingCost.id);
          } else {
            await db.from("product_costs").insert({
              product_id: product.id,
              cost_price: cmc,
              cmc,
              cost_source: "CMC",
              cost_confidence: 0.7,
            });
          }
        }

        totalSynced++;
      }

      console.log(`[Sync ${account}] Estoque página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await updateSyncState(db, "inventory", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "inventory", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== COMPUTE COSTS (Fallback Engine) ========

async function computeCosts(db: ReturnType<typeof createClient>) {
  // Load config
  const { data: configs } = await db.from("recommendation_config").select("key, value");
  const cfg: Record<string, number> = {};
  for (const c of configs || []) cfg[c.key] = c.value;

  const margemDefault = cfg.margem_default_global ?? 0.35;
  const margemMin = cfg.margem_minima ?? 0.05;
  const margemMax = cfg.margem_maxima ?? 0.85;
  const divergenceThreshold = cfg.divergence_threshold ?? 0.20;

  // Get all products with their costs and inventory
  const { data: products } = await db.from("omie_products").select("id, valor_unitario, familia").eq("ativo", true);
  if (!products?.length) return { updated: 0 };

  // Get all product costs
  const { data: costs } = await db.from("product_costs").select("*");
  const costMap: Record<string, any> = {};
  for (const c of costs || []) costMap[c.product_id] = c;

  // Get inventory for CMC
  const { data: inventory } = await db.from("inventory_position").select("product_id, cmc, saldo");
  const invMap: Record<string, any> = {};
  for (const i of inventory || []) if (i.product_id) invMap[i.product_id] = i;

  // Compute family average margins
  const familyMargins: Record<string, { totalMargin: number; count: number }> = {};
  for (const p of products) {
    const fam = p.familia || "default";
    const c = costMap[p.id];
    if (c?.cost_price > 0 && p.valor_unitario > 0) {
      const margin = 1 - c.cost_price / p.valor_unitario;
      if (margin > margemMin && margin < margemMax) {
        if (!familyMargins[fam]) familyMargins[fam] = { totalMargin: 0, count: 0 };
        familyMargins[fam].totalMargin += margin;
        familyMargins[fam].count++;
      }
    }
  }

  let updated = 0;

  for (const product of products) {
    const price = product.valor_unitario;
    if (!price || price <= 0) continue;

    const existing = costMap[product.id];
    const inv = invMap[product.id];
    const costProduto = existing?.cost_price || 0;
    const cmc = inv?.cmc || existing?.cmc || 0;

    const sanityCheck = (c: number) =>
      c > 0 && c < price * (1 - margemMin) && c > price * (1 - margemMax);

    let costFinal = 0;
    let costSource = "UNKNOWN";
    let costConfidence = 0;

    // Priority 1: Product cost
    if (costProduto > 0 && sanityCheck(costProduto)) {
      costFinal = costProduto;
      costSource = "PRODUCT_COST";
      costConfidence = 0.95;

      // Check divergence with CMC
      if (cmc > 0 && sanityCheck(cmc)) {
        const divergence = Math.abs(costProduto - cmc) / Math.max(costProduto, cmc);
        if (divergence > divergenceThreshold) {
          // Heuristic: prefer CMC if has stock/recent movement
          if (inv?.saldo > 0) {
            costFinal = cmc;
            costSource = "CMC";
            costConfidence = 0.85;
          }
          // Otherwise keep product cost
        }
      }
    }
    // Priority 2: CMC
    else if (cmc > 0 && sanityCheck(cmc)) {
      costFinal = cmc;
      costSource = "CMC";
      costConfidence = 0.80;
    }
    // Priority 3: Family margin proxy
    else {
      const fam = product.familia || "default";
      const famData = familyMargins[fam];
      let targetMargin = margemDefault;

      if (famData && famData.count >= 3) {
        targetMargin = famData.totalMargin / famData.count;
        costSource = "FAMILY_MARGIN_PROXY";
        costConfidence = 0.50;
      } else {
        costSource = "DEFAULT_PROXY";
        costConfidence = 0.25;
      }

      costFinal = price * (1 - targetMargin);
    }

    // Upsert product_costs
    const upsertData: Record<string, unknown> = {
      product_id: product.id,
      cost_price: existing?.cost_price || costFinal,
      cmc: cmc || 0,
      cost_final: costFinal,
      cost_source: costSource,
      cost_confidence: costConfidence,
      family_category: product.familia || null,
      updated_at: new Date().toISOString(),
    };

    await db.from("product_costs").upsert(upsertData, { onConflict: "product_id" });
    updated++;
  }

  return { updated };
}

// ======== COMPUTE ASSOCIATION RULES (Apriori-like) ========

async function computeAssociationRules(db: ReturnType<typeof createClient>) {
  // Load config
  const { data: configs } = await db.from("recommendation_config").select("key, value");
  const cfg: Record<string, number> = {};
  for (const c of configs || []) cfg[c.key] = c.value;

  const minSupport = cfg.s_min ?? 0.01;
  const minLift = cfg.l_min ?? 1.2;
  const maxRules = cfg.max_association_rules ?? 500;

  // Load all order_items grouped by sales_order_id
  const { data: items } = await db
    .from("order_items")
    .select("sales_order_id, product_id")
    .not("product_id", "is", null);

  if (!items?.length) return { rules_generated: 0 };

  // Build transactions: Map<order_id, Set<product_id>>
  const transactions = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.product_id || !item.sales_order_id) continue;
    if (!transactions.has(item.sales_order_id)) transactions.set(item.sales_order_id, new Set());
    transactions.get(item.sales_order_id)!.add(item.product_id);
  }

  const totalTx = transactions.size;
  if (totalTx < 5) return { rules_generated: 0, reason: "Insufficient transactions" };

  // Count single item support
  const itemCounts = new Map<string, number>();
  for (const [, basket] of transactions) {
    for (const pid of basket) {
      itemCounts.set(pid, (itemCounts.get(pid) || 0) + 1);
    }
  }

  // Filter frequent items
  const frequentItems = new Map<string, number>();
  for (const [pid, count] of itemCounts) {
    if (count / totalTx >= minSupport) {
      frequentItems.set(pid, count);
    }
  }

  // Count pair co-occurrences
  const pairCounts = new Map<string, number>();
  for (const [, basket] of transactions) {
    const items = Array.from(basket).filter(p => frequentItems.has(p));
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const key = [items[i], items[j]].sort().join("|");
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  // Generate rules
  interface Rule {
    antecedent: string[];
    consequent: string[];
    support: number;
    confidence: number;
    lift: number;
  }

  const rules: Rule[] = [];

  for (const [pairKey, pairCount] of pairCounts) {
    const [a, b] = pairKey.split("|");
    const supportAB = pairCount / totalTx;
    if (supportAB < minSupport) continue;

    const supportA = (frequentItems.get(a) || 0) / totalTx;
    const supportB = (frequentItems.get(b) || 0) / totalTx;

    // Rule A→B
    const confAB = supportAB / supportA;
    const liftAB = confAB / supportB;
    if (liftAB >= minLift) {
      rules.push({ antecedent: [a], consequent: [b], support: supportAB, confidence: confAB, lift: liftAB });
    }

    // Rule B→A
    const confBA = supportAB / supportB;
    const liftBA = confBA / supportA;
    if (liftBA >= minLift) {
      rules.push({ antecedent: [b], consequent: [a], support: supportAB, confidence: confBA, lift: liftBA });
    }
  }

  // Sort by lift*confidence descending, take top N
  rules.sort((a, b) => (b.lift * b.confidence) - (a.lift * a.confidence));
  const topRules = rules.slice(0, maxRules);

  // Clear old rules and insert new ones
  await db.from("farmer_association_rules").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  let inserted = 0;
  for (const rule of topRules) {
    const { error } = await db.from("farmer_association_rules").insert({
      antecedent_product_ids: rule.antecedent,
      consequent_product_ids: rule.consequent,
      support: rule.support,
      confidence: rule.confidence,
      lift: rule.lift,
      rule_type: "association",
      sample_size: totalTx,
    });
    if (!error) inserted++;
  }

  console.log(`[AssocRules] Generated ${inserted} rules from ${totalTx} transactions`);
  return { rules_generated: inserted, total_transactions: totalTx, frequent_items: frequentItems.size };
}

// ======== MAIN HANDLER ========

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, account = "vendas", start_page } = await req.json();
    let result: unknown;

    switch (action) {
      case "sync_customers":
        result = await syncCustomers(supabaseAdmin, account);
        break;
      case "sync_products":
        result = await syncProducts(supabaseAdmin, account, start_page || 1);
        break;
      case "sync_orders":
        result = await syncOrdersIncremental(supabaseAdmin, account);
        break;
      case "sync_inventory":
        result = await syncInventory(supabaseAdmin, account);
        break;
      case "compute_costs":
        result = await computeCosts(supabaseAdmin);
        break;
      case "compute_association_rules":
        result = await computeAssociationRules(supabaseAdmin);
        break;
      case "sync_all": {
        const acct = account as OmieAccount;
        const customers = await syncCustomers(supabaseAdmin, acct);
        const products = await syncProducts(supabaseAdmin, acct);
        const orders = await syncOrdersIncremental(supabaseAdmin, acct);
        const inventory = await syncInventory(supabaseAdmin, acct);
        const costs = await computeCosts(supabaseAdmin);
        const assocRules = await computeAssociationRules(supabaseAdmin);
        result = { customers, products, orders, inventory, costs, assocRules };
        break;
      }
      case "get_sync_state": {
        const { data } = await supabaseAdmin.from("sync_state").select("*").order("entity_type");
        result = data;
        break;
      }
      default:
        return new Response(JSON.stringify({ error: "Ação desconhecida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Analytics Sync] Erro:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

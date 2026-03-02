import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type Account = "oben" | "colacor";

function getVendasCredentials(account: Account) {
  if (account === "colacor") {
    return {
      key: Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY"),
      secret: Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET"),
    };
  }
  return {
    key: Deno.env.get("OMIE_VENDAS_APP_KEY"),
    secret: Deno.env.get("OMIE_VENDAS_APP_SECRET"),
  };
}

async function callOmie(account: Account, endpoint: string, call: string, params: Record<string, unknown>) {
  const creds = getVendasCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais (${account}) não configuradas`);

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

// Simple hash for change detection
function hashObject(obj: unknown): string {
  const str = JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

function formatOmieDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// ======== LOAD CONFIG ========

async function loadReprocessConfig(db: ReturnType<typeof createClient>): Promise<Record<string, number>> {
  const { data } = await db.from("sync_reprocess_config").select("key, value");
  const cfg: Record<string, number> = {};
  for (const c of data || []) cfg[c.key] = c.value;
  return cfg;
}

// ======== LOG HELPERS ========

async function createReprocessLog(
  db: ReturnType<typeof createClient>,
  entityType: string,
  account: string,
  reprocessType: string,
  windowStart: Date,
  windowEnd: Date
): Promise<string> {
  const { data } = await db.from("sync_reprocess_log").insert({
    entity_type: entityType,
    account,
    reprocess_type: reprocessType,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    status: "running",
  }).select("id").single();
  return data!.id;
}

async function completeReprocessLog(
  db: ReturnType<typeof createClient>,
  logId: string,
  stats: {
    upserts_count: number;
    divergences_found: number;
    corrections_applied: number;
    duration_ms: number;
    metadata?: Record<string, unknown>;
    error_message?: string;
    status?: string;
  }
) {
  await db.from("sync_reprocess_log").update({
    status: stats.status || "complete",
    upserts_count: stats.upserts_count,
    divergences_found: stats.divergences_found,
    corrections_applied: stats.corrections_applied,
    duration_ms: stats.duration_ms,
    error_message: stats.error_message || null,
    metadata: stats.metadata || {},
  }).eq("id", logId);
}

// ======== REPROCESS ORDERS ========

async function reprocessOrders(
  db: ReturnType<typeof createClient>,
  account: Account,
  windowDays: number,
  reprocessType: string
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const logId = await createReprocessLog(db, "orders", account, reprocessType, windowStart, windowEnd);
  const startTime = Date.now();

  let upserts = 0;
  let divergences = 0;
  let corrections = 0;

  try {
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = await callOmie(account, "produtos/pedido/", "ListarPedidos", {
        pagina,
        registros_por_pagina: 100,
        filtrar_apenas_inclusao: "N",
        filtrar_por_data_de: formatOmieDate(windowStart),
        filtrar_por_data_ate: formatOmieDate(windowEnd),
      }) as any;

      totalPaginas = result.total_de_paginas || 1;
      const pedidos = result.pedido_venda_produto || [];

      for (const pedido of pedidos) {
        const cab = pedido.cabecalho || {};
        const codigoCliente = cab.codigo_cliente;
        const itens = pedido.det || [];
        const omieNumPedido = String(cab.numero_pedido || cab.codigo_pedido);
        const pedidoHash = hashObject({ cab, itens });

        // Find customer
        const { data: mapping } = await db
          .from("omie_clientes")
          .select("user_id")
          .eq("omie_codigo_cliente", codigoCliente)
          .maybeSingle();

        if (!mapping) continue;

        // Check existing order
        const { data: existingOrder } = await db
          .from("sales_orders")
          .select("id, hash_payload")
          .eq("omie_numero_pedido", omieNumPedido)
          .eq("account", account)
          .maybeSingle();

        if (existingOrder) {
          // Change detection via hash
          if (existingOrder.hash_payload === pedidoHash) continue;

          divergences++;

          // Update sales_order status/data
          const etapa = cab.etapa || "10";
          const statusMap: Record<string, string> = {
            "10": "rascunho", "20": "enviado", "50": "faturado", "60": "cancelado",
          };

          const totalPedido = itens.reduce((sum: number, i: any) => {
            const prod = i.produto || {};
            return sum + (prod.quantidade || 1) * (prod.valor_unitario || 0);
          }, 0);

          await db.from("sales_orders").update({
            status: statusMap[etapa] || "enviado",
            total: totalPedido,
            subtotal: totalPedido,
            hash_payload: pedidoHash,
            updated_at: new Date().toISOString(),
          }).eq("id", existingOrder.id);

          // Reprocess order items
          for (const item of itens) {
            const prod = item.produto || {};
            const codigoProduto = prod.codigo_produto;
            const quantidade = prod.quantidade || 1;
            const valorUnit = prod.valor_unitario || 0;
            const itemHash = hashObject(prod);

            const { data: product } = await db
              .from("omie_products")
              .select("id")
              .eq("omie_codigo_produto", codigoProduto)
              .eq("account", account)
              .maybeSingle();

            // Check existing item
            const { data: existingItem } = await db
              .from("order_items")
              .select("id, hash_payload")
              .eq("sales_order_id", existingOrder.id)
              .eq("omie_codigo_produto", codigoProduto)
              .maybeSingle();

            if (existingItem) {
              if (existingItem.hash_payload !== itemHash) {
                await db.from("order_items").update({
                  quantity: quantidade,
                  unit_price: valorUnit,
                  product_id: product?.id || null,
                  hash_payload: itemHash,
                }).eq("id", existingItem.id);
                corrections++;
              }
            } else {
              await db.from("order_items").insert({
                sales_order_id: existingOrder.id,
                customer_user_id: mapping.user_id,
                product_id: product?.id || null,
                omie_codigo_produto: codigoProduto,
                quantity: quantidade,
                unit_price: valorUnit,
                hash_payload: itemHash,
              });
              corrections++;
            }

            // Update price history
            if (product?.id && valorUnit > 0) {
              await db.from("sales_price_history").upsert({
                customer_user_id: mapping.user_id,
                product_id: product.id,
                unit_price: valorUnit,
                sales_order_id: existingOrder.id,
              }, { ignoreDuplicates: true });
            }
          }

          upserts++;
        }
      }

      console.log(`[Reprocess][${account}] Orders page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: corrections,
      duration_ms: Date.now() - startTime,
      metadata: { pages: totalPaginas, window_days: windowDays },
    });

    return { upserts, divergences, corrections, duration_ms: Date.now() - startTime };
  } catch (error) {
    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: corrections,
      duration_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
    throw error;
  }
}

// ======== REPROCESS PRODUCTS ========

async function reprocessProducts(
  db: ReturnType<typeof createClient>,
  account: Account,
  reprocessType: string
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 1 * 24 * 60 * 60 * 1000); // always full scan
  const logId = await createReprocessLog(db, "products", account, reprocessType, windowStart, windowEnd);
  const startTime = Date.now();

  let upserts = 0;
  let divergences = 0;

  try {
    const EXCLUDED_FAMILIES = ['imobilizado', 'uso e consumo', 'matérias primas para conversão de cintas', 'jumbos de lixa para discos', 'material para tingimix'];
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = await callOmie(account, "geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      }) as any;

      totalPaginas = result.total_de_paginas || 1;
      const produtos = result.produto_servico_cadastro || [];

      for (const prod of produtos) {
        if (prod.inativo === "S") continue;
        if (prod.tipo && prod.tipo.toUpperCase() === "K") continue;
        const familia = (prod.descricao_familia || '').toLowerCase().trim();
        if (EXCLUDED_FAMILIES.some(ex => familia.includes(ex)) || familia.startsWith('jumbo')) continue;

        const newHash = hashObject({
          codigo: prod.codigo,
          descricao: prod.descricao,
          valor_unitario: prod.valor_unitario,
          unidade: prod.unidade,
          familia: prod.descricao_familia,
        });

        // Check existing
        const { data: existing } = await db
          .from("omie_products")
          .select("id, descricao, valor_unitario")
          .eq("omie_codigo_produto", prod.codigo_produto)
          .eq("account", account)
          .maybeSingle();

        if (existing) {
          // Detect divergence
          if (existing.descricao !== (prod.descricao || "") ||
              existing.valor_unitario !== (prod.valor_unitario || 0)) {
            divergences++;
          }
        }

        const row = {
          omie_codigo_produto: prod.codigo_produto,
          omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
          codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
          descricao: prod.descricao || "Sem descrição",
          unidade: prod.unidade || "UN",
          ncm: prod.ncm || null,
          valor_unitario: prod.valor_unitario || 0,
          estoque: prod.quantidade_estoque || 0,
          ativo: true,
          familia: prod.descricao_familia || null,
          imagem_url: prod.imagens?.[0]?.url_imagem || null,
          metadata: {
            marca: prod.marca,
            modelo: prod.modelo,
            peso_bruto: prod.peso_bruto,
            peso_liq: prod.peso_liq,
            descricao_familia: prod.descricao_familia,
            cfop: prod.cfop,
          },
          account,
          updated_at: new Date().toISOString(),
        };

        const { error } = await db.from("omie_products").upsert(row, { onConflict: "omie_codigo_produto,account" });
        if (!error) upserts++;
      }

      console.log(`[Reprocess][${account}] Products page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // Inactivate products no longer in Omie
    // (handled by comparing existing products not updated in this run)

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: divergences,
      duration_ms: Date.now() - startTime,
    });

    return { upserts, divergences, duration_ms: Date.now() - startTime };
  } catch (error) {
    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: 0,
      duration_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
    throw error;
  }
}

// ======== REPROCESS INVENTORY ========

async function reprocessInventory(
  db: ReturnType<typeof createClient>,
  account: Account,
  reprocessType: string
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 1 * 24 * 60 * 60 * 1000);
  const logId = await createReprocessLog(db, "inventory", account, reprocessType, windowStart, windowEnd);
  const startTime = Date.now();

  let upserts = 0;
  let divergences = 0;

  try {
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: formatOmieDate(new Date()),
      }) as any;

      totalPaginas = result.nTotPaginas || 1;
      const produtos = result.produtos || [];

      for (const prod of produtos) {
        const codProd = prod.nCodProd;
        if (!codProd) continue;

        const saldo = prod.nSaldo ?? 0;
        const cmc = prod.nCMC ?? 0;
        const precoMedio = prod.nPrecoMedio ?? 0;

        // Check divergence with local
        const { data: existing } = await db
          .from("omie_products")
          .select("id, estoque")
          .eq("omie_codigo_produto", codProd)
          .eq("account", account)
          .maybeSingle();

        if (existing && existing.estoque !== saldo) {
          divergences++;
        }

        // Upsert inventory_position
        await db.from("inventory_position").upsert({
          omie_codigo_produto: codProd,
          product_id: existing?.id || null,
          saldo,
          cmc,
          preco_medio: precoMedio,
          account,
          synced_at: new Date().toISOString(),
        }, { onConflict: "omie_codigo_produto,account" });

        // Update omie_products stock
        if (existing?.id) {
          await db.from("omie_products")
            .update({ estoque: saldo, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
        }

        // Update product_costs CMC
        if (existing?.id && cmc > 0) {
          const { data: costRow } = await db
            .from("product_costs")
            .select("id")
            .eq("product_id", existing.id)
            .maybeSingle();

          if (costRow) {
            await db.from("product_costs")
              .update({ cmc, updated_at: new Date().toISOString() })
              .eq("id", costRow.id);
          } else {
            await db.from("product_costs").insert({
              product_id: existing.id,
              cost_price: cmc,
              cmc,
              cost_source: "CMC",
              cost_confidence: 0.7,
            });
          }
        }

        upserts++;
      }

      console.log(`[Reprocess][${account}] Inventory page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: divergences,
      duration_ms: Date.now() - startTime,
    });

    return { upserts, divergences, duration_ms: Date.now() - startTime };
  } catch (error) {
    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: 0,
      duration_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
    throw error;
  }
}

// ======== MAIN HANDLER ========

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { action, account = "oben" } = body;

    // Auth: either cron secret or user JWT
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret === Deno.env.get("CRON_SECRET");

    if (!isCron) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Não autorizado" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

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
    }

    const cfg = await loadReprocessConfig(supabaseAdmin);
    let result: unknown;

    console.log(`[Reprocess] Action: ${action}, Account: ${account}`);

    switch (action) {
      case "reprocess_operational": {
        if (!cfg.operational_enabled) {
          result = { skipped: true, reason: "Operational reprocessing disabled" };
          break;
        }
        const windowDays = cfg.operational_window_days || 7;
        const orders = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "operational");
        const inventory = await reprocessInventory(supabaseAdmin, account as Account, "operational");
        result = { orders, inventory, window_days: windowDays };
        break;
      }

      case "reprocess_strategic": {
        if (!cfg.strategic_enabled) {
          result = { skipped: true, reason: "Strategic reprocessing disabled" };
          break;
        }
        const windowDays = cfg.strategic_window_days || 30;
        const orders = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "strategic");
        const products = await reprocessProducts(supabaseAdmin, account as Account, "strategic");
        const inventory = await reprocessInventory(supabaseAdmin, account as Account, "strategic");
        result = { orders, products, inventory, window_days: windowDays };
        break;
      }

      case "reprocess_orders": {
        const windowDays = body.window_days || cfg.operational_window_days || 7;
        result = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "manual");
        break;
      }

      case "reprocess_products": {
        result = await reprocessProducts(supabaseAdmin, account as Account, "manual");
        break;
      }

      case "reprocess_inventory": {
        result = await reprocessInventory(supabaseAdmin, account as Account, "manual");
        break;
      }

      case "reprocess_all": {
        const windowDays = body.window_days || cfg.strategic_window_days || 30;
        const orders = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "manual");
        const products = await reprocessProducts(supabaseAdmin, account as Account, "manual");
        const inventory = await reprocessInventory(supabaseAdmin, account as Account, "manual");
        result = { orders, products, inventory, window_days: windowDays };
        break;
      }

      case "get_health": {
        // Return sync health data
        const { data: recentLogs } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);

        const { data: config } = await supabaseAdmin
          .from("sync_reprocess_config")
          .select("*");

        // Get last operational and strategic runs
        const { data: lastOp } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("*")
          .eq("reprocess_type", "operational")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const { data: lastStrat } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("*")
          .eq("reprocess_type", "strategic")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Get daily divergence summary for last 30 days
        const { data: divergenceLogs } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("entity_type, account, divergences_found, corrections_applied, window_start, window_end, status, created_at")
          .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false });

        result = {
          recent_logs: recentLogs || [],
          config: config || [],
          last_operational: lastOp,
          last_strategic: lastStrat,
          divergence_summary: divergenceLogs || [],
        };
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
    console.error("[Reprocess] Erro:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

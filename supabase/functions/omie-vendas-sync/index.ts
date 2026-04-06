import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type Account = "oben" | "colacor";

function getCredentials(account: Account) {
  if (account === "colacor") {
    const APP_KEY = Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY");
    const APP_SECRET = Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET");
    if (!APP_KEY || !APP_SECRET) throw new Error("Credenciais da Colacor (vendas) não configuradas");
    return { APP_KEY, APP_SECRET };
  }
  const APP_KEY = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const APP_SECRET = Deno.env.get("OMIE_VENDAS_APP_SECRET");
  if (!APP_KEY || !APP_SECRET) throw new Error("Credenciais da empresa de Vendas Omie não configuradas");
  return { APP_KEY, APP_SECRET };
}

async function callOmieVendasApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
  account: Account = "oben"
) {
  const { APP_KEY, APP_SECRET } = getCredentials(account);

  const body = {
    call,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    param: [params],
  };

  console.log(`[Omie Vendas][${account}] Chamando ${endpoint} - ${call}`);

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();

    if (result.faultstring) {
      const fs = String(result.faultstring);
      const isRateLimit = fs.includes("Já existe uma requisição desse método")
        || fs.includes("Consumo redundante")
        || fs.includes("REDUNDANT")
        || fs.includes("consumo redundante");
      if (isRateLimit) {
        if (attempt < maxRetries) {
          // Cap delay at 15s to stay well within 150s function timeout (3 retries × 15s = 45s max)
          const waitMatch = fs.match(/Aguarde (\d+) segundos/);
          const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
          const delay = Math.min(requestedDelay + 2, 15) * 1000;
          console.log(`[Omie Vendas][${account}] Rate limit, waiting ${delay/1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.log(`[Omie Vendas][${account}] Rate limit persists after ${maxRetries} retries, returning null`);
        return null;
      }
      throw new Error(`Erro Omie Vendas (${account}): ${fs}`);
    }

    return result;
  }
}

// Sincronizar todos os produtos da empresa de vendas
async function syncProducts(supabase: ReturnType<typeof createClient>, startPage = 1, maxPages = 12, account: Account = "oben") {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;

  while (pagina <= totalPaginas && pagesProcessed < maxPages) {
    const result = await callOmieVendasApi(
      "geral/produtos/",
      "ListarProdutos",
      {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      },
      account
    ) as any;

    if (!result) {
      console.log(`[Omie Vendas][${account}] Products sync interrupted by rate limit at page ${pagina}`);
      break;
    }

    totalPaginas = result.total_de_paginas || 1;
    const produtos = result.produto_servico_cadastro || [];

    const EXCLUDED_FAMILIES = ['imobilizado', 'uso e consumo', 'matérias primas para conversão de cintas', 'jumbos de lixa para discos', 'material para tingimix'];

    const rows = produtos
      .filter((prod: any) => {
        if (prod.inativo === "S") return false;
        // Excluir produtos do tipo Kit (apenas Simples)
        if (prod.tipo && prod.tipo.toUpperCase() === "K") return false;
        const familia = (prod.descricao_familia || '').toLowerCase().trim();
        if (EXCLUDED_FAMILIES.some(ex => familia.includes(ex)) || familia.startsWith('jumbo')) return false;
        return true;
      })
      .map((prod: any) => ({
        omie_codigo_produto: prod.codigo_produto,
        omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
        codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
        descricao: prod.descricao || prod.descricao_familia || "Produto sem descrição",
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
      }));

    if (rows.length > 0) {
      const { error } = await supabase.from("omie_products").upsert(rows, { onConflict: "omie_codigo_produto,account" });
      if (error) {
        console.error(`[Omie Vendas][${account}] Erro batch upsert página ${pagina}:`, error);
      } else {
        totalSynced += rows.length;
      }
    }

    console.log(`[Omie Vendas][${account}] Página ${pagina}/${totalPaginas} - ${produtos.length} produtos processados`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalSynced, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Sincronizar estoque real dos produtos via ListarPosEstoque (paginado)
async function syncEstoque(supabase: ReturnType<typeof createClient>, startPage = 1, maxPages = 10, account: Account = "oben") {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalUpdated = 0;
  let pagesProcessed = 0;

  while (pagina <= totalPaginas && pagesProcessed < maxPages) {
    const result = await callOmieVendasApi(
      "estoque/consulta/",
      "ListarPosEstoque",
      {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
      },
      account
    ) as any;

    // If rate-limited, stop pagination gracefully
    if (!result) {
      console.log(`[Omie Vendas][${account}] Estoque sync interrupted by rate limit at page ${pagina}`);
      break;
    }

    totalPaginas = result.nTotPaginas || 1;
    const produtos = result.produtos || [];

    for (const prod of produtos) {
      const codProd = prod.nCodProd;
      const saldo = prod.nSaldo ?? 0;

      if (codProd) {
        const { error } = await supabase
          .from("omie_products")
          .update({ estoque: saldo, updated_at: new Date().toISOString() })
          .eq("omie_codigo_produto", codProd)
          .eq("account", account);
        if (!error) totalUpdated++;
      }
    }

    console.log(`[Omie Vendas][${account}] Estoque página ${pagina}/${totalPaginas} - ${produtos.length} produtos`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalUpdated, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Buscar/listar clientes na empresa de vendas
async function listarClientesVendas(searchTerm: string, account: Account = "oben") {
  const results: Array<{
    codigo_cliente: number;
    razao_social: string;
    nome_fantasia: string;
    cnpj_cpf: string;
    codigo_vendedor: number | null;
  }> = [];

  // Try searching by name first
  try {
    const result = await callOmieVendasApi(
      "geral/clientes/",
      "ListarClientes",
      {
        pagina: 1,
        registros_por_pagina: 20,
        clientesFiltro: {
          razao_social: searchTerm,
        },
      },
      account
    ) as any;

    if (result.clientes_cadastro) {
      for (const c of result.clientes_cadastro) {
        results.push({
          codigo_cliente: c.codigo_cliente_omie,
          razao_social: c.razao_social || "",
          nome_fantasia: c.nome_fantasia || "",
          cnpj_cpf: c.cnpj_cpf || "",
          codigo_vendedor: c.recomendacoes?.codigo_vendedor || c.codigo_vendedor || null,
        });
      }
    }
  } catch (e) {
    console.log(`[Omie Vendas][${account}] Busca por razão social falhou:`, e);
  }

  // Also try by document if search looks like a number
  const cleanSearch = searchTerm.replace(/\D/g, "");
  if (cleanSearch.length >= 3 && results.length === 0) {
    try {
      const result = await callOmieVendasApi(
        "geral/clientes/",
        "ListarClientes",
        {
          pagina: 1,
          registros_por_pagina: 10,
          clientesFiltro: {
            cnpj_cpf: cleanSearch,
          },
        },
        account
      ) as any;

      if (result.clientes_cadastro) {
        for (const c of result.clientes_cadastro) {
          if (!results.find(r => r.codigo_cliente === c.codigo_cliente_omie)) {
            results.push({
              codigo_cliente: c.codigo_cliente_omie,
              razao_social: c.razao_social || "",
              nome_fantasia: c.nome_fantasia || "",
              cnpj_cpf: c.cnpj_cpf || "",
              codigo_vendedor: c.recomendacoes?.codigo_vendedor || c.codigo_vendedor || null,
            });
          }
        }
      }
    } catch (e) {
      console.log(`[Omie Vendas][${account}] Busca por documento falhou:`, e);
    }
  }

  return results;
}

// Buscar cliente na empresa de vendas pelo CPF/CNPJ
async function buscarClienteVendas(document: string, account: Account = "oben") {
  const documentClean = document.replace(/\D/g, "");

  const result = await callOmieVendasApi(
    "geral/clientes/",
    "ListarClientes",
    {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: documentClean },
    },
    account
  ) as any;

  if (!result || !result.clientes_cadastro?.[0]?.codigo_cliente_omie) {
    return null;
  }

  const cliente = result.clientes_cadastro[0];
  const codigoVendedor = cliente.recomendacoes?.codigo_vendedor || cliente.codigo_vendedor || null;
  console.log(`[Omie Vendas][${account}] Cliente ${cliente.codigo_cliente_omie} vendedor: recomendacoes=${cliente.recomendacoes?.codigo_vendedor}, root=${cliente.codigo_vendedor}, resolved=${codigoVendedor}`);
  return {
    codigo_cliente: cliente.codigo_cliente_omie,
    razao_social: cliente.razao_social,
    codigo_vendedor: codigoVendedor,
  };
}

// Buscar histórico de preços no Omie (pedidos anteriores do cliente)
async function buscarHistoricoPrecosOmie(codigoCliente: number, account: Account = "oben") {
  try {
    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      {
        pagina: 1,
        registros_por_pagina: 50,
        filtrar_por_cliente: codigoCliente,
        filtrar_apenas_inclusao: "N",
      },
      account
    ) as any;

    const precos: Record<number, number> = {};
    const pedidos = result.pedido_venda_produto || [];

    // Percorrer pedidos do mais recente ao mais antigo
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
  } catch (error) {
    console.error(`[Omie Vendas][${account}] Erro ao buscar histórico de preços:`, error);
    return {};
  }
}

// Listar formas de pagamento (parcelas) do Omie
async function listarFormasPagamento(account: Account = "oben") {
  // Common payment conditions used as hardcoded fallback
  const defaultFormas = [
    { codigo: "999", descricao: "A Vista" },
    { codigo: "000", descricao: "A Vista (faturamento)" },
    { codigo: "001", descricao: "30 dias" },
    { codigo: "002", descricao: "30/60 dias" },
    { codigo: "003", descricao: "30/60/90 dias" },
    { codigo: "030", descricao: "30dd" },
    { codigo: "A03", descricao: "30/60/90 DDL" },
    { codigo: "A04", descricao: "28/56/84 DDL" },
  ];

  try {
    // Try Omie API for parcelas
    const result = await callOmieVendasApi(
      "geral/parcelas/",
      "ListarParcelas",
      { pagina: 1, registros_por_pagina: 100 },
      account
    ) as any;

    const parcelas = result.cadastros || result.parcela_cadastro || result.lista_parcelas || [];
    console.log(`[Omie Vendas][${account}] ListarParcelas retornou ${parcelas.length} parcelas. Keys: ${JSON.stringify(Object.keys(result))}`);

    if (parcelas.length > 0) {
      return parcelas
        .filter((f: any) => f.cInativo !== "S")
        .map((f: any) => ({
          codigo: f.cCodigo || f.nCodigo?.toString() || '',
          descricao: f.cDescricao || f.cDescParcela || '',
        }))
        .filter((f: any) => f.codigo && f.descricao);
    }
  } catch (error) {
    console.error(`[Omie Vendas][${account}] Erro ao buscar parcelas:`, error);
  }

  // Fallback: return common payment conditions
  console.log(`[Omie Vendas][${account}] Usando formas de pagamento padrão (fallback)`);
  return defaultFormas;
}

// Buscar última forma de pagamento e ranking de parcelas do cliente
async function buscarUltimaParcela(codigoCliente: number, account: Account = "oben") {
  try {
    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      {
        pagina: 1,
        registros_por_pagina: 50,
        filtrar_por_cliente: codigoCliente,
        filtrar_apenas_inclusao: "N",
      },
      account
    ) as any;

    const pedidos = result.pedido_venda_produto || [];
    const parcelaCount: Record<string, number> = {};
    let ultimaParcela: string | null = null;

    for (const pedido of pedidos) {
      const parcela = pedido.cabecalho?.codigo_parcela;
      if (parcela) {
        if (!ultimaParcela) ultimaParcela = parcela;
        parcelaCount[parcela] = (parcelaCount[parcela] || 0) + 1;
      }
    }

    // Sort by frequency descending
    const parcelaRanking = Object.entries(parcelaCount)
      .sort((a, b) => b[1] - a[1])
      .map(([codigo, count]) => ({ codigo, count }));

    return { ultima_parcela: ultimaParcela, parcela_ranking: parcelaRanking };
  } catch (error) {
    console.error(`[Omie Vendas][${account}] Erro ao buscar última parcela:`, error);
    return { ultima_parcela: null, parcela_ranking: [] };
  }
}

// Sincronizar pedidos de venda do Omie para o banco local (OPTIMIZED)
async function syncPedidos(
  supabase: ReturnType<typeof createClient>,
  startPage = 1,
  maxPages = 10,
  account: Account = "oben",
  dateFrom?: string, // DD/MM/YYYY
  dateTo?: string,   // DD/MM/YYYY
) {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let totalItems = 0;
  let pagesProcessed = 0;
  let skippedNoClient = 0;
  let skippedExisting = 0;

  // ── Pre-load document -> user_id mapping from profiles ──
  const docToUserMap = new Map<string, string>();
  let cPage = 0;
  const pgSize = 1000;
  let hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('profiles')
      .select('user_id, document')
      .not('document', 'is', null)
      .range(cPage * pgSize, (cPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const p of batch) {
        if (p.document) {
          const cleanDoc = p.document.replace(/\D/g, '');
          if (cleanDoc.length >= 11) docToUserMap.set(cleanDoc, p.user_id);
        }
      }
      if (batch.length < pgSize) hasMore = false;
      cPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Document map: ${docToUserMap.size} profiles`);

  // ── Pre-load ALL existing hash_payloads for this account (skip duplicates in bulk) ──
  const existingHashes = new Set<string>();
  let hPage = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('sales_orders')
      .select('hash_payload')
      .eq('account', account)
      .not('hash_payload', 'is', null)
      .range(hPage * pgSize, (hPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const row of batch) if (row.hash_payload) existingHashes.add(row.hash_payload);
      if (batch.length < pgSize) hasMore = false;
      hPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Existing hashes: ${existingHashes.size}`);

  // ── Pre-load omie_clientes mapping (codigo_cliente -> user_id) to AVOID API calls ──
  const clientCache = new Map<number, string | null>();
  let ocPage = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('omie_clientes')
      .select('omie_codigo_cliente, user_id')
      .range(ocPage * pgSize, (ocPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const oc of batch) {
        clientCache.set(oc.omie_codigo_cliente, oc.user_id);
      }
      if (batch.length < pgSize) hasMore = false;
      ocPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Client cache from omie_clientes: ${clientCache.size}`);

  // ── Pre-load product mapping ──
  const productMap = new Map<number, string>();
  let pPage = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('omie_products')
      .select('id, omie_codigo_produto')
      .eq('account', account)
      .range(pPage * pgSize, (pPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const p of batch) productMap.set(p.omie_codigo_produto, p.id);
      if (batch.length < pgSize) hasMore = false;
      pPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Product map: ${productMap.size}`);

  // System user for created_by
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('is_employee', true)
    .limit(1)
    .single();
  const systemUserId = adminProfile?.user_id;
  if (!systemUserId) throw new Error('Nenhum funcionário encontrado para created_by');

  // Helper: resolve codigo_cliente -> user_id (cache-first, API fallback only for unknown)
  async function resolveClientUserId(codigoCliente: number): Promise<string | null> {
    if (clientCache.has(codigoCliente)) return clientCache.get(codigoCliente) || null;
    // Fallback: call Omie API only for clients NOT in omie_clientes table
    try {
      const result = await callOmieVendasApi(
        "geral/clientes/",
        "ConsultarCliente",
        { codigo_cliente_omie: codigoCliente },
        account
      ) as any;
      const doc = (result.cnpj_cpf || '').replace(/\D/g, '');
      if (doc.length >= 11) {
        const userId = docToUserMap.get(doc) || null;
        clientCache.set(codigoCliente, userId);
        return userId;
      }
    } catch (e) {
      console.warn(`[sync_pedidos][${account}] ConsultarCliente ${codigoCliente} falhou:`, (e as Error).message);
    }
    clientCache.set(codigoCliente, null);
    return null;
  }

  while (pagina <= totalPaginas && pagesProcessed < maxPages) {
    const listParams: Record<string, unknown> = { pagina, registros_por_pagina: 50, filtrar_apenas_inclusao: "N" };
    if (dateFrom) listParams.filtrar_por_data_de = dateFrom;
    if (dateTo) listParams.filtrar_por_data_ate = dateTo;

    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      listParams,
      account
    ) as any;

    if (!result) {
      console.log(`[sync_pedidos][${account}] Pedidos sync interrupted by rate limit at page ${pagina}`);
      break;
    }

    totalPaginas = result.total_de_paginas || 1;
    const pedidos = result.pedido_venda_produto || [];

    // Resolve only unknown client codes (most should be in cache from omie_clientes)
    const uniqueClientCodes = [...new Set(pedidos.map((p: any) => p.cabecalho?.codigo_cliente).filter(Boolean))] as number[];
    const unknownCodes = uniqueClientCodes.filter(c => !clientCache.has(c));
    if (unknownCodes.length > 0) {
      console.log(`[sync_pedidos][${account}] Resolving ${unknownCodes.length} unknown clients via API`);
      for (const code of unknownCodes) await resolveClientUserId(code);
    }

    // ── Prepare batch arrays ──
    const orderBatch: any[] = [];
    const orderMeta: Array<{ hashPayload: string; detalhes: any[]; customerUserId: string; createdAt: string }> = [];

    for (const pedido of pedidos) {
      const cab = pedido.cabecalho || {};
      const codigoCliente = cab.codigo_cliente;
      const codigoPedido = cab.codigo_pedido;
      const numeroPedido = cab.numero_pedido;
      if (!codigoCliente || !codigoPedido) continue;

      const customerUserId = clientCache.get(codigoCliente) || null;
      if (!customerUserId) { skippedNoClient++; continue; }

      const hashPayload = `omie_${account}_${codigoPedido}`;

      // Skip if already synced (in-memory check, no DB call)
      if (existingHashes.has(hashPayload)) { skippedExisting++; continue; }
      existingHashes.add(hashPayload); // prevent duplicates within same run

      const detalhes = pedido.det || [];
      const itemsJson: any[] = [];
      let subtotal = 0;

      for (const det of detalhes) {
        const prod = det.produto || {};
        const qty = prod.quantidade || 1;
        const price = prod.valor_unitario || 0;
        const desc = prod.desconto || 0;
        subtotal += qty * price * (1 - desc / 100);
        itemsJson.push({
          omie_codigo_produto: prod.codigo_produto,
          descricao: prod.descricao || '',
          quantidade: qty,
          valor_unitario: price,
          desconto: desc,
        });
      }

      let status = 'importado';
      const etapa = cab.etapa || '';
      if (etapa === '60' || etapa === '70') status = 'faturado';
      else if (etapa === '50') status = 'separacao';
      else if (etapa === '20') status = 'enviado';
      else if (etapa === '80') status = 'cancelado';

      let createdAt = new Date().toISOString();
      if (cab.data_previsao) {
        const parts = cab.data_previsao.split('/');
        if (parts.length === 3) createdAt = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).toISOString();
      }

      orderBatch.push({
        customer_user_id: customerUserId,
        created_by: systemUserId,
        items: itemsJson,
        subtotal: Math.round(subtotal * 100) / 100,
        discount: 0,
        total: Math.round(subtotal * 100) / 100,
        status,
        omie_pedido_id: codigoPedido,
        omie_numero_pedido: String(numeroPedido || codigoPedido),
        account,
        hash_payload: hashPayload,
        created_at: createdAt,
        notes: cab.observacoes_pedido || null,
      });
      orderMeta.push({ hashPayload, detalhes, customerUserId, createdAt });
    }

    // ── Batch insert orders ──
    if (orderBatch.length > 0) {
      const { data: insertedOrders, error: orderErr } = await supabase
        .from('sales_orders')
        .insert(orderBatch)
        .select('id, hash_payload');

      if (orderErr) {
        console.error(`[sync_pedidos][${account}] Batch insert error pág ${pagina}:`, orderErr.message);
        // Fallback: try one-by-one
        for (let idx = 0; idx < orderBatch.length; idx++) {
          const { data: single, error: singleErr } = await supabase
            .from('sales_orders')
            .insert(orderBatch[idx])
            .select('id')
            .single();
          if (!singleErr && single) {
            totalSynced++;
            // Insert items + prices for this order
            const meta = orderMeta[idx];
            const itemRows = meta.detalhes.map((det: any) => {
              const prod = det.produto || {};
              return {
                sales_order_id: single.id,
                customer_user_id: meta.customerUserId,
                product_id: productMap.get(prod.codigo_produto) || null,
                omie_codigo_produto: prod.codigo_produto || null,
                quantity: prod.quantidade || 1,
                unit_price: prod.valor_unitario || 0,
                discount: prod.desconto || 0,
                hash_payload: `${meta.hashPayload}_${prod.codigo_produto}`,
              };
            }).filter((i: any) => i.omie_codigo_produto);
            if (itemRows.length > 0) {
              await supabase.from('order_items').insert(itemRows);
              totalItems += itemRows.length;
            }
          }
        }
      } else if (insertedOrders) {
        totalSynced += insertedOrders.length;

        // Build hash -> id map for inserted orders
        const hashToId = new Map<string, string>();
        for (const o of insertedOrders) if (o.hash_payload) hashToId.set(o.hash_payload, o.id);

        // ── Batch insert order_items ──
        const allItemRows: any[] = [];
        const allPriceRows: any[] = [];

        for (const meta of orderMeta) {
          const orderId = hashToId.get(meta.hashPayload);
          if (!orderId) continue;

          for (const det of meta.detalhes) {
            const prod = det.produto || {};
            if (!prod.codigo_produto) continue;

            allItemRows.push({
              sales_order_id: orderId,
              customer_user_id: meta.customerUserId,
              product_id: productMap.get(prod.codigo_produto) || null,
              omie_codigo_produto: prod.codigo_produto,
              quantity: prod.quantidade || 1,
              unit_price: prod.valor_unitario || 0,
              discount: prod.desconto || 0,
              hash_payload: `${meta.hashPayload}_${prod.codigo_produto}`,
            });

            const productId = productMap.get(prod.codigo_produto);
            if (productId && prod.valor_unitario > 0) {
              allPriceRows.push({
                customer_user_id: meta.customerUserId,
                product_id: productId,
                unit_price: prod.valor_unitario,
                sales_order_id: orderId,
                created_at: meta.createdAt,
              });
            }
          }
        }

        // Insert items in batches of 200
        for (let i = 0; i < allItemRows.length; i += 200) {
          const batch = allItemRows.slice(i, i + 200);
          const { error: itemsErr } = await supabase.from('order_items').insert(batch);
          if (itemsErr) console.error(`[sync_pedidos][${account}] Items batch error:`, itemsErr.message);
          else totalItems += batch.length;
        }

        // Insert prices in batches of 200
        for (let i = 0; i < allPriceRows.length; i += 200) {
          const batch = allPriceRows.slice(i, i + 200);
          await supabase.from('sales_price_history').insert(batch);
        }
      }
    }

    console.log(`[sync_pedidos][${account}] Página ${pagina}/${totalPaginas} — ${orderBatch.length} novos, ${skippedExisting} existentes`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalSynced, totalItems, skippedNoClient, skippedExisting, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Config por empresa para criação de pedido
function getAccountConfig(account: Account) {
  if (account === "colacor") {
    return {
      codigo_categoria: "1.01.01",
      codigo_conta_corrente: 394054131,
      obs_prefix: "Pedido de venda via App Colacor",
    };
  }
  return {
    codigo_categoria: "1.01.01",
    codigo_conta_corrente: 8693825504,
    obs_prefix: `Pedido de venda via App ColaCor\n\nRECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL\nE-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA.\nTRANSPORTADORA: Transporte próprio: Oben Comercio\nDeclaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim no local indicado acima.\nCPF/CNPJ:___________________________________\nDATA DA ENTREGA:___/__/____\nNome/ASSINATURA:_________________________________________________`,
  };
}

// Criar pedido de venda no Omie
async function criarPedidoVenda(
  supabase: ReturnType<typeof createClient>,
  salesOrderId: string,
  codigoCliente: number,
  codigoVendedor: number | null,
  items: Array<{
    omie_codigo_produto: number;
    quantidade: number;
    valor_unitario: number;
    descricao?: string;
    tint_cor_id?: string;
    tint_nome_cor?: string;
  }>,
  observacao?: string,
  codigoParcela?: string,
  account: Account = "oben",
  quantidadeVolumes?: number,
  ordemCompra?: string
) {
  const cCodIntPed = `PV_${salesOrderId.substring(0, 8)}_${Date.now()}`;
  const config = getAccountConfig(account);

  const det = items.map((item, index) => {
    const entry: Record<string, unknown> = {
      ide: { codigo_item_integracao: `${cCodIntPed}_${index + 1}` },
      produto: {
        codigo_produto: item.omie_codigo_produto,
        quantidade: item.quantidade,
        valor_unitario: item.valor_unitario,
      },
    };
    // Add tint color info or ordem de compra to item observations + NF-e
    if (ordemCompra) {
      (entry as any).inf_adic = {
        dados_adicionais_item: ordemCompra,
        numero_pedido_compra: ordemCompra,
      };
    } else if (item.tint_cor_id && item.tint_nome_cor) {
      const corInfo = `Cor: ${item.tint_cor_id} - ${item.tint_nome_cor} - Qty: ${item.quantidade}`;
      (entry as any).inf_adic = {
        dados_adicionais_item: corInfo,
        numero_pedido_compra: corInfo,
      };
    }
    return entry;
  });

  const cabecalho: Record<string, unknown> = {
    codigo_pedido_integracao: cCodIntPed,
    codigo_cliente: codigoCliente,
    data_previsao: new Date().toISOString().split("T")[0].split("-").reverse().join("/"),
    etapa: "10",
    codigo_parcela: codigoParcela || "999",
  };

  const informacoes_adicionais: Record<string, unknown> = {
    codigo_categoria: config.codigo_categoria,
    codigo_conta_corrente: config.codigo_conta_corrente,
  };

  if (codigoVendedor && codigoVendedor > 0) {
    informacoes_adicionais.codVend = codigoVendedor;
  }

  const frete: Record<string, unknown> = {
    modalidade_frete: "0",
    especie_volumes: "VOL",
  };
  if (quantidadeVolumes && quantidadeVolumes > 0) {
    frete.quantidade_volumes = quantidadeVolumes;
  }

  const payload = {
    cabecalho,
    frete,
    det,
    observacoes: {
      obs_venda: observacao || config.obs_prefix,
    },
    informacoes_adicionais,
  };

  console.log(`[Omie Vendas][${account}] Payload PedidoVenda:`, JSON.stringify(payload, null, 2));

  const result = await callOmieVendasApi(
    "produtos/pedido/",
    "IncluirPedido",
    payload,
    account
  ) as any;

  const omie_pedido_id = result.codigo_pedido || null;
  const omie_numero_pedido = result.numero_pedido || cCodIntPed;

  // Atualizar sales_order com dados do Omie
  await supabase
    .from("sales_orders")
    .update({
      omie_pedido_id,
      omie_numero_pedido: String(omie_numero_pedido),
      omie_payload: payload,
      omie_response: result,
      status: "enviado",
    })
    .eq("id", salesOrderId);

  return { omie_pedido_id, omie_numero_pedido };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validar autenticação
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client (bypasses RLS) for DB operations
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // User client for auth validation
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    const { action, account: rawAccount, ...params } = await req.json();
    const account: Account = (rawAccount === "colacor") ? "colacor" : "oben";

    let result: unknown;

    switch (action) {
      case "sync_products": {
        const startPage = params.start_page || 1;
        const syncResult = await syncProducts(supabaseAdmin, startPage, 12, account);
        result = { success: true, ...syncResult };
        break;
      }

      case "sync_estoque": {
        const startPageEstoque = params.start_page || 1;
        const estoqueResult = await syncEstoque(supabaseAdmin, startPageEstoque, 10, account);
        result = { success: true, ...estoqueResult };
        break;
      }

      case "listar_clientes": {
        const { search } = params;
        if (!search || String(search).length < 2) throw new Error("Busca deve ter ao menos 2 caracteres");
        const clientes = await listarClientesVendas(String(search), account);
        result = { success: true, clientes };
        break;
      }

      case "buscar_cliente": {
        const { document } = params;
        if (!document) throw new Error("Documento é obrigatório");
        const cliente = await buscarClienteVendas(document, account);
        result = { success: true, cliente };
        break;
      }

      case "buscar_precos_cliente": {
        const { codigo_cliente } = params;
        if (!codigo_cliente) throw new Error("Código do cliente é obrigatório");
        const precos = await buscarHistoricoPrecosOmie(codigo_cliente, account);
        result = { success: true, precos };
        break;
      }

      case "criar_pedido": {
        const { sales_order_id, codigo_cliente, codigo_vendedor, items, observacao, codigo_parcela, quantidade_volumes, ordem_compra } = params;
        if (!sales_order_id || !codigo_cliente || !items?.length) {
          throw new Error("Dados insuficientes para criar pedido de venda");
        }
        const pedido = await criarPedidoVenda(
          supabaseAdmin,
          sales_order_id,
          codigo_cliente,
          codigo_vendedor,
          items,
          observacao,
          codigo_parcela,
          account,
          quantidade_volumes,
          ordem_compra
        );
        result = { success: true, ...pedido };
        break;
      }

      case "listar_formas_pagamento": {
        const formas = await listarFormasPagamento(account);
        result = { success: true, formas };
        break;
      }

      case "buscar_ultima_parcela": {
        const { codigo_cliente: codCli } = params;
        if (!codCli) throw new Error("Código do cliente é obrigatório");
        const parcelaData = await buscarUltimaParcela(codCli, account);
        result = { success: true, ...parcelaData };
        break;
      }

      case "excluir_pedido": {
        const { omie_pedido_id: pedidoId, sales_order_id: soId } = params;
        if (!soId) throw new Error("ID do pedido é obrigatório");

        // Determine the account of this order
        const { data: orderData } = await supabaseAdmin
          .from("sales_orders")
          .select("account")
          .eq("id", soId)
          .single();
        const orderAccount: Account = (orderData?.account === "colacor") ? "colacor" : "oben";

        // Try to cancel in Omie if it was synced
        if (pedidoId && Number(pedidoId) > 0) {
          try {
            await callOmieVendasApi(
              "produtos/pedido/",
              "CancelarPedido",
              { codigo_pedido: Number(pedidoId) },
              orderAccount
            );
            console.log(`[Omie Vendas][${orderAccount}] Pedido ${pedidoId} cancelado no Omie`);
          } catch (omieErr: any) {
            console.warn(`[Omie Vendas][${orderAccount}] Erro ao cancelar no Omie (continuando exclusão local):`, omieErr.message);
          }
        }

        // Delete locally
        const { error: delError } = await supabaseAdmin
          .from("sales_orders")
          .delete()
          .eq("id", soId);
        if (delError) throw delError;

        result = { success: true };
        break;
      }

      case "sync_pedidos": {
        const startPagePedidos = params.start_page || 1;
        const maxPagesPedidos = params.max_pages || 10;
        const dateFrom = params.date_from || undefined; // DD/MM/YYYY
        const dateTo = params.date_to || undefined;     // DD/MM/YYYY
        const syncPedidosResult = await syncPedidos(supabaseAdmin, startPagePedidos, maxPagesPedidos, account, dateFrom, dateTo);
        result = { success: true, ...syncPedidosResult };
        break;
      }

      default:
        throw new Error(`Ação desconhecida: ${action}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Omie Vendas] Erro:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erro desconhecido",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

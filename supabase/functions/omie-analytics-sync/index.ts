import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type OmieAccount = "vendas" | "servicos" | "colacor_vendas";

// ======== NÃO-VINCULADOS: helpers espelhados de src/lib/clientes-nao-vinculados/snapshot.ts ========
type Empresa = "oben" | "colacor" | "colacor_sc";

interface NaoVinculadoRow {
  empresa: Empresa;
  omie_codigo_cliente: number;
  cnpj_cpf: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
  synced_at: string;
}

function accountToEmpresa(account: OmieAccount): Empresa {
  switch (account) {
    case "vendas":
      return "oben";
    case "colacor_vendas":
      return "colacor";
    case "servicos":
      return "colacor_sc";
  }
}

function buildNaoVinculadoRow(
  c: OmieClienteCadastro,
  empresa: Empresa,
  syncedAtIso: string,
): NaoVinculadoRow {
  return {
    empresa,
    omie_codigo_cliente: c.codigo_cliente_omie ?? 0,
    cnpj_cpf: (c.cnpj_cpf ?? "").replace(/\D/g, ""),
    razao_social: c.razao_social?.trim() || null,
    nome_fantasia: c.nome_fantasia?.trim() || null,
    cidade: c.cidade?.trim() || null,
    uf: c.estado?.trim() || null,
    codigo_vendedor: c.codigo_vendedor ?? null,
    synced_at: syncedAtIso,
  };
}

interface OmieClienteCadastro {
  codigo_cliente_omie?: number;
  codigo_cliente_integracao?: string | null;
  codigo_vendedor?: number | null;
  cnpj_cpf?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cidade?: string;
  estado?: string;
}

interface OmieListarClientesResponse {
  clientes_cadastro?: OmieClienteCadastro[];
  total_de_paginas?: number;
  faultstring?: string;
}

interface OmieImagemProduto {
  url_imagem?: string;
}

interface OmieProdutoCadastro {
  codigo_produto?: number;
  codigo_produto_integracao?: string | null;
  codigo?: string;
  descricao?: string;
  unidade?: string;
  ncm?: string | null;
  valor_unitario?: number;
  quantidade_estoque?: number;
  inativo?: string;
  imagens?: OmieImagemProduto[];
  descricao_familia?: string | null;
  descricao_subfamilia?: string | null;
  marca?: string;
  modelo?: string;
  peso_bruto?: number;
  peso_liq?: number;
  cfop?: string;
}

interface OmieListarProdutosResponse {
  produto_servico_cadastro?: OmieProdutoCadastro[];
  total_de_paginas?: number;
  faultstring?: string;
}

interface OmiePedidoCabecalho {
  codigo_cliente?: number;
  numero_pedido?: string;
  codigo_pedido?: number;
}

interface OmiePedidoProduto {
  codigo_produto?: number;
  quantidade?: number;
  valor_unitario?: number;
}

interface OmiePedidoDet {
  produto?: OmiePedidoProduto;
}

interface OmiePedidoVendaProduto {
  cabecalho?: OmiePedidoCabecalho;
  det?: OmiePedidoDet[];
}

interface OmieListarPedidosResponse {
  pedido_venda_produto?: OmiePedidoVendaProduto[];
  total_de_paginas?: number;
  faultstring?: string;
}

interface OmieEstoqueProduto {
  nCodProd?: number;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}

interface OmieListarPosEstoqueResponse {
  produtos?: OmieEstoqueProduto[];
  nTotPaginas?: number;
  faultstring?: string;
}

interface OmieApiResponseBase {
  faultstring?: string;
  faultcode?: string;
}

interface ProductCostRow {
  id: string;
  product_id: string;
  cost_price?: number;
  cmc?: number;
}

interface InventoryPositionRow {
  product_id: string | null;
  cmc?: number;
  saldo?: number;
}

function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return {
      key: Deno.env.get("OMIE_OBEN_APP_KEY"),
      secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
    };
  }
  if (account === "colacor_vendas") {
    return {
      key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
      secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
    };
  }
  // servicos = afiação Colacor SC
  return {
    key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY"),
    secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET"),
  };
}

async function callOmie(account: OmieAccount, endpoint: string, call: string, params: Record<string, unknown>): Promise<OmieApiResponseBase> {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais Omie (${account}) não configuradas`);

  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };

  // Retry com backoff p/ erros TRANSITÓRIOS do Omie/rede (ex.: "SOAP-ERROR: Broken response from
  // Application Server" — flakiness intermitente do servidor do Omie que matava a enumeração de ~105
  // páginas). ListarClientes/ListarProdutos são leitura idempotente → seguro re-tentar. Erro PERMANENTE
  // (credencial/validação) falha rápido (não casa os marcadores transitórios). Backoff: 0.8s, 1.6s, 3.2s.
  const maxAttempts = 4;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await res.json()) as OmieApiResponseBase;
      if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
      return result;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message.toLowerCase();
      const transient = msg.includes("broken response") || msg.includes("soap-error") ||
        msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") ||
        msg.includes("connection") || msg.includes("fetch failed") ||
        msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("500");
      if (transient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Omie (${account}): falha após ${maxAttempts} tentativas`);
}

// ======== SYNC STATE HELPERS ========

async function getSyncState(db: SupabaseClient, entityType: string, account: string) {
  const { data } = await db
    .from("sync_state")
    .select("*")
    .eq("entity_type", entityType)
    .eq("account", account)
    .maybeSingle();
  return data;
}

async function updateSyncState(
  db: SupabaseClient,
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
// Mapas bulk (substituem o N+1 de ~2-3 queries POR cliente que estourava o budget e deixava o
// sync_state preso em 'running'). Mesmo padrão provado do syncNaoVinculados (#383): paginado p/
// furar o cap de 1000 do PostgREST.

// Map<omie_codigo_cliente, user_id> de omie_clientes (quem JÁ está vinculado).
async function fetchOmieClienteUserMap(db: SupabaseClient): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("omie_clientes")
      .select("omie_codigo_cliente, user_id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch omie_clientes map: ${error.message}`);
    const rows = (data ?? []) as { omie_codigo_cliente: number | null; user_id: string | null }[];
    for (const r of rows) {
      if (r.omie_codigo_cliente != null && r.user_id) map.set(Number(r.omie_codigo_cliente), r.user_id);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

// Map<documento_normalizado, user_id> de profiles (p/ vincular cliente novo via documento).
async function fetchProfileDocUserMap(db: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("profiles")
      .select("document, user_id")
      .not("document", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch profiles map: ${error.message}`);
    const rows = (data ?? []) as { document: string | null; user_id: string | null }[];
    for (const r of rows) {
      const d = (r.document ?? "").replace(/\D/g, "");
      if (d && r.user_id && !map.has(d)) map.set(d, r.user_id); // 1º documento vence (defensivo contra duplicado)
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

async function syncCustomers(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "customers", account, { status: "running", error_message: null });

  try {
    // 2 leituras em massa ANTES do laço (substitui o N+1: ~2-3 round-trips POR cliente × ~10k).
    const userByCodigo = await fetchOmieClienteUserMap(db);
    const userByDoc = await fetchProfileDocUserMap(db);

    // Enumera o Omie e resolve o user_id em MEMÓRIA. Dedup por user_id (last-wins) — a constraint
    // unique_user_omie é UNIQUE(user_id), então 2 linhas com o mesmo user_id no mesmo upsert dariam
    // "ON CONFLICT cannot affect row a second time".
    const upsertByUser = new Map<string, {
      user_id: string;
      omie_codigo_cliente: number;
      omie_codigo_cliente_integracao: string | null;
      omie_codigo_vendedor: number | null;
      updated_at: string;
    }>();
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "geral/clientes/", "ListarClientes", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
      })) as unknown as OmieListarClientesResponse;

      totalPaginas = result.total_de_paginas || 1;
      for (const c of result.clientes_cadastro || []) {
        const doc = (c.cnpj_cpf || "").replace(/\D/g, "");
        if (!doc || c.codigo_cliente_omie == null) continue;
        // mapeado por código (atualiza vendedor) OU vinculável por documento (cria vínculo).
        // Não-vinculado (sem código nem profile) é fora de escopo — é o syncNaoVinculados.
        const userId = userByCodigo.get(Number(c.codigo_cliente_omie)) ?? userByDoc.get(doc);
        if (!userId) continue;
        upsertByUser.set(userId, {
          user_id: userId,
          omie_codigo_cliente: c.codigo_cliente_omie,
          omie_codigo_cliente_integracao: c.codigo_cliente_integracao || null,
          omie_codigo_vendedor: c.codigo_vendedor || null,
          updated_at: new Date().toISOString(),
        });
      }

      console.log(`[Sync ${account}] Clientes página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // Bulk upsert em chunks (onConflict user_id = unique_user_omie). empresa_omie NÃO é setado
    // (preserva o default 'colacor' do comportamento anterior — fora do escopo deste fix).
    const rows = Array.from(upsertByUser.values());
    let totalSynced = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: upErr } = await db.from("omie_clientes").upsert(chunk, { onConflict: "user_id" });
      if (upErr) throw new Error(`upsert omie_clientes: ${upErr.message}`);
      totalSynced += chunk.length;
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

// ======== CLIENTES NÃO-VINCULADOS (rotina dedicada e eficiente) ========
// Desacoplada do linking: NÃO toca em omie_clientes. Faz 2 leituras em massa
// (conjuntos) + enumera o Omie + classifica em memória. Sem N+1.

// Espelhado VERBATIM de src/lib/clientes-nao-vinculados/snapshot.ts
type SnapshotClassification = "skip" | "linked" | "has_profile" | "unlinked";
function classifyClienteForSnapshot(
  c: OmieClienteCadastro,
  codigosVinculados: Set<number>,
  docsComProfile: Set<string>,
): SnapshotClassification {
  const doc = (c.cnpj_cpf ?? "").replace(/\D/g, "");
  if (!doc || c.codigo_cliente_omie == null) return "skip";
  if (codigosVinculados.has(Number(c.codigo_cliente_omie))) return "linked";
  if (docsComProfile.has(doc)) return "has_profile";
  return "unlinked";
}

// Lê TODOS os omie_codigo_cliente de omie_clientes (paginado p/ furar o cap de 1000 do PostgREST).
async function fetchAllOmieClienteCodigos(db: SupabaseClient): Promise<Set<number>> {
  const set = new Set<number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("omie_clientes")
      .select("omie_codigo_cliente")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch omie_clientes codigos: ${error.message}`);
    const rows = (data ?? []) as { omie_codigo_cliente: number | null }[];
    for (const r of rows) if (r.omie_codigo_cliente != null) set.add(Number(r.omie_codigo_cliente));
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return set;
}

// Lê TODOS os documentos de profiles (normalizados em memória — defensivo contra formatados).
async function fetchAllProfileDocs(db: SupabaseClient): Promise<Set<string>> {
  const set = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("profiles")
      .select("document")
      .not("document", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch profiles docs: ${error.message}`);
    const rows = (data ?? []) as { document: string | null }[];
    for (const r of rows) {
      const d = (r.document ?? "").replace(/\D/g, "");
      if (d) set.add(d);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return set;
}

async function syncNaoVinculados(db: SupabaseClient, account: OmieAccount) {
  const empresa = accountToEmpresa(account);
  const runTs = new Date().toISOString();
  await db.from("omie_nao_vinculados_state").upsert(
    { empresa, status: "running", current_run_ts: runTs, started_at: runTs, error_message: null, updated_at: runTs },
    { onConflict: "empresa" },
  );

  try {
    // 2 leituras em massa (sets) — substitui ~2 queries POR cliente do laço de linking.
    const codigosVinculados = await fetchAllOmieClienteCodigos(db);
    const docsComProfile = await fetchAllProfileDocs(db);

    const naoVinculados: NaoVinculadoRow[] = [];
    let pagina = 1;
    let totalPaginas = 1;
    let totalOmie = 0;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "geral/clientes/", "ListarClientes", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
      })) as unknown as OmieListarClientesResponse;

      totalPaginas = result.total_de_paginas || 1;
      const clientes = result.clientes_cadastro || [];
      for (const c of clientes) {
        totalOmie++;
        if (classifyClienteForSnapshot(c, codigosVinculados, docsComProfile) === "unlinked") {
          naoVinculados.push(buildNaoVinculadoRow(c, empresa, runTs));
        }
      }
      console.log(`[NaoVinc ${account}] página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // dedup por código, insere em chunks com o run_ts, finaliza atômico.
    const dedup = Array.from(new Map(naoVinculados.map((r) => [r.omie_codigo_cliente, r])).values());
    for (let i = 0; i < dedup.length; i += 1000) {
      const { error: insErr } = await db.from("omie_clientes_nao_vinculados").insert(dedup.slice(i, i + 1000));
      if (insErr) throw new Error(`insert nao_vinculados: ${insErr.message}`);
    }
    // INVARIANTE DE SEGURANÇA: finalize só após inserir o conjunto COMPLETO do runTs.
    // Um throw antes daqui (timeout/erro) pula o finalize → o run morto fica INVISÍVEL
    // na UI (que lê só last_complete_synced_at) em vez de virar relatório enganoso.
    const { error: finErr } = await db.rpc("finalize_nao_vinculados_snapshot", {
      p_empresa: empresa,
      p_run_ts: runTs,
      p_total: dedup.length,
    });
    if (finErr) throw new Error(`finalize nao_vinculados: ${finErr.message}`);
    console.log(`[NaoVinc ${account}] total_omie=${totalOmie} nao_vinculados=${dedup.length}`);
    return { totalOmie, naoVinculados: dedup.length };
  } catch (error) {
    await db.from("omie_nao_vinculados_state").update({
      status: "error",
      error_message: String(error),
      updated_at: new Date().toISOString(),
    }).eq("empresa", empresa);
    throw error;
  }
}

// ======== SYNC PRODUCTS ========

async function syncProducts(db: SupabaseClient, account: OmieAccount, startPage = 1, maxPages = 10) {
  await updateSyncState(db, "products", account, { status: "running", error_message: null });
  let pagina = startPage;
  let totalPaginas = startPage;
  let totalSynced = 0;
  let pagesProcessed = 0;

  try {
    while (pagina <= totalPaginas && pagesProcessed < maxPages) {
      const result = (await callOmie(account, "geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      })) as unknown as OmieListarProdutosResponse;

      totalPaginas = result.total_de_paginas || 1;
      const produtos = result.produto_servico_cadastro || [];

      if (account === "vendas" || account === "colacor_vendas") {
        // UPSERT — INCLUI inativos para refletir o flag `ativo` corretamente
        const acctValue = account === "colacor_vendas" ? "colacor" : "oben";
        const rows = produtos.map((p) => ({
          omie_codigo_produto: p.codigo_produto,
          omie_codigo_produto_integracao: p.codigo_produto_integracao || null,
          codigo: p.codigo || `PROD-${p.codigo_produto}`,
          descricao: p.descricao || "Sem descrição",
          unidade: p.unidade || "UN",
          ncm: p.ncm || null,
          valor_unitario: p.valor_unitario || 0,
          estoque: p.quantidade_estoque || 0,
          ativo: p.inativo !== "S",
          account: acctValue,
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
            inativo_omie: p.inativo,
          },
          updated_at: new Date().toISOString(),
        }));

        if (rows.length > 0) {
          const { error } = await db
            .from("omie_products")
            .upsert(rows, { onConflict: "omie_codigo_produto,account" });
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

async function syncOrdersIncremental(db: SupabaseClient, account: OmieAccount) {
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

      const result = (await callOmie(account, "produtos/pedido/", "ListarPedidos", params)) as unknown as OmieListarPedidosResponse;
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

async function syncInventory(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "inventory", account, { status: "running", error_message: null });
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  try {
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
      })) as unknown as OmieListarPosEstoqueResponse;

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

// ======== SYNC INVENTORY FULL (catálogo inteiro, p/ cobertura de CMC) ========
// Diferente do syncInventory (30 min, só itens COM saldo): usa cExibeTodos:"S" pra trazer
// o catálogo inteiro (inclusive saldo 0) e popular o cmc. Bulk (sem o N+1 do syncInventory)
// + roda em background (waitUntil) por causa do volume (~5x). Foco: inventory_position.cmc
// (fonte de custo do EOQ da Reposição). NÃO toca product_costs/omie_products (não-objetivo v1).
async function syncInventoryFull(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "inventory_full", account, { status: "running", error_message: null });
  try {
    // 1) Map omie_products: omie_codigo_produto -> id (bulk paginado, fura o cap de 1000 do PostgREST)
    const idMap = new Map<number, string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("omie_products")
        .select("id, omie_codigo_produto")
        .range(from, from + 999);
      if (error) throw error;
      const rows = data ?? [];
      for (const r of rows) idMap.set(Number(r.omie_codigo_produto), r.id as string);
      if (rows.length < 1000) break;
    }

    // 2) Paginar ListarPosEstoque com cExibeTodos:"S" (callOmie já tem retry/backoff p/ falha transitória)
    let pagina = 1;
    let totalPaginas = 1;
    let totalSynced = 0;
    const invRows: Array<{
      omie_codigo_produto: number;
      product_id: string | null;
      saldo: number;
      cmc: number;
      preco_medio: number;
      account: string;
      synced_at: string;
    }> = [];
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
        cExibeTodos: "S",
      })) as unknown as OmieListarPosEstoqueResponse;

      totalPaginas = result.nTotPaginas || 1;
      const now = new Date().toISOString();
      for (const prod of result.produtos || []) {
        const codProd = prod.nCodProd;
        if (!codProd) continue;
        invRows.push({
          omie_codigo_produto: codProd,
          product_id: idMap.get(codProd) ?? null,
          saldo: prod.nSaldo ?? 0,
          cmc: prod.nCMC ?? 0,
          preco_medio: prod.nPrecoMedio ?? 0,
          account,
          synced_at: now,
        });
        totalSynced++;
      }
      console.log(`[Sync ${account}] inventory_full página ${pagina}/${totalPaginas} — ${totalSynced} itens acumulados`);
      pagina++;
    }

    // 3) Upsert em lote (chunks de 500) — onConflict igual ao syncInventory
    const CHUNK = 500;
    for (let i = 0; i < invRows.length; i += CHUNK) {
      const slice = invRows.slice(i, i + CHUNK);
      const { error } = await db
        .from("inventory_position")
        .upsert(slice, { onConflict: "omie_codigo_produto,account" });
      if (error) throw error;
    }

    await updateSyncState(db, "inventory_full", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "inventory_full", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== COMPUTE COSTS (Fallback Engine) ========

async function computeCosts(db: SupabaseClient) {
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
  const { data: costsRaw } = await db.from("product_costs").select("*");
  const costs = (costsRaw ?? []) as unknown as ProductCostRow[];
  const costMap: Record<string, ProductCostRow> = {};
  for (const c of costs) costMap[c.product_id] = c;

  // Get inventory for CMC
  const { data: inventoryRaw } = await db.from("inventory_position").select("product_id, cmc, saldo");
  const inventory = (inventoryRaw ?? []) as unknown as InventoryPositionRow[];
  const invMap: Record<string, InventoryPositionRow> = {};
  for (const i of inventory) if (i.product_id) invMap[i.product_id] = i;

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

async function computeAssociationRules(db: SupabaseClient) {
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

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { action, account = "vendas", start_page, max_pages } = await req.json();
    let result: unknown;

    switch (action) {
      case "sync_customers": {
        // syncCustomers enumera ~10k clientes do Omie — pesado demais p/ o budget SÍNCRONO do request
        // (dava WORKER_RESOURCE_LIMIT e prendia sync_state.customers em 'running' indefinidamente).
        // Roda em BACKGROUND via EdgeRuntime.waitUntil (mesmo padrão do start_nao_vinculados, que
        // completa o MESMO volume): responde 202 na hora; o sync_state (running→complete) é a fonte
        // de progresso/verdade. O worker dedicado tem budget estendido p/ background.
        const bgTask = syncCustomers(supabaseAdmin, account as OmieAccount).catch((e) => {
          console.error("[sync_customers][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, background: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "sync_products":
        result = await syncProducts(supabaseAdmin, account, start_page || 1, max_pages || 10);
        break;
      case "sync_orders":
        result = await syncOrdersIncremental(supabaseAdmin, account);
        break;
      case "sync_inventory":
        result = await syncInventory(supabaseAdmin, account);
        break;
      case "sync_inventory_full": {
        // Guard de UX "já em andamento" (não duplica o trabalho de catálogo se um run ainda roda).
        const { data: stFull } = await supabaseAdmin
          .from("sync_state")
          .select("status, last_sync_at, updated_at")
          .eq("entity_type", "inventory_full")
          .eq("account", account)
          .maybeSingle();
        const startedAt = stFull?.updated_at ? new Date(stFull.updated_at).getTime() : 0;
        const running = stFull?.status === "running" && (Date.now() - startedAt) < 30 * 60 * 1000;
        if (running) {
          return new Response(JSON.stringify({ accepted: false, reason: "already_running" }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bgTask = syncInventoryFull(supabaseAdmin, account as OmieAccount).catch((e) => {
          console.error("[sync_inventory_full][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, background: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "compute_costs":
        result = await computeCosts(supabaseAdmin);
        break;
      case "compute_association_rules":
        result = await computeAssociationRules(supabaseAdmin);
        break;
      case "sync_all": {
        // customers SAIU do sync_all: agora tem cron dedicado (sync-customers-vendas-daily) que chama
        // a action sync_customers em BACKGROUND. Rodar customers síncrono aqui dava WORKER_RESOURCE_LIMIT
        // e RE-prendia sync_state.customers em 'running' a cada passada — clobberava o estado curado.
        const acct = account as OmieAccount;
        const products = await syncProducts(supabaseAdmin, acct);
        const orders = await syncOrdersIncremental(supabaseAdmin, acct);
        const inventory = await syncInventory(supabaseAdmin, acct);
        const costs = await computeCosts(supabaseAdmin);
        const assocRules = await computeAssociationRules(supabaseAdmin);
        result = { products, orders, inventory, costs, assocRules };
        break;
      }
      case "get_sync_state": {
        const { data } = await supabaseAdmin.from("sync_state").select("*").order("entity_type");
        result = data;
        break;
      }
      case "start_nao_vinculados": {
        // v1: só Oben.
        if (account !== "vendas") {
          return new Response(JSON.stringify({ error: "v1 suporta apenas account=vendas (Oben)" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Gate master/gestor server-side (authorizeCronOrStaff só garante staff).
        // Cron/service_role são confiáveis e passam direto.
        if (auth.via === "staff") {
          const { data: pode } = await supabaseAdmin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
          if (!pode) {
            return new Response(JSON.stringify({ error: "Forbidden: requer master ou gestor comercial" }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        // Guard de UX "já em andamento" (correção não depende disso; é só pra não duplicar trabalho).
        const { data: st } = await supabaseAdmin
          .from("omie_nao_vinculados_state")
          .select("status, started_at")
          .eq("empresa", "oben")
          .maybeSingle();
        const running = st?.status === "running" && st?.started_at &&
          (Date.now() - new Date(st.started_at as string).getTime() < 15 * 60 * 1000);
        if (running) {
          return new Response(JSON.stringify({ accepted: false, already_running: true }), {
            status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Dispara a rotina dedicada de não-vinculados em background; responde 202 na hora.
        const bgTask = syncNaoVinculados(supabaseAdmin, "vendas").catch((e) => {
          console.error("[nao-vinculados][async]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-ignore intencional: EdgeRuntime é global do Deno/Supabase Edge (pode não estar tipado); @ts-expect-error quebraria o deploy se estivesse tipado
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- idem acima
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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

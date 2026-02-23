import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

async function callOmieVendasApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>
) {
  const APP_KEY = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const APP_SECRET = Deno.env.get("OMIE_VENDAS_APP_SECRET");

  if (!APP_KEY || !APP_SECRET) {
    throw new Error("Credenciais da empresa de Vendas Omie não configuradas");
  }

  const body = {
    call,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    param: [params],
  };

  console.log(`[Omie Vendas] Chamando ${endpoint} - ${call}`);

  const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (result.faultstring) {
    throw new Error(`Erro Omie Vendas: ${result.faultstring}`);
  }

  return result;
}

// Sincronizar todos os produtos da empresa de vendas
async function syncProducts(supabase: ReturnType<typeof createClient>, startPage = 1, maxPages = 12) {
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
      }
    ) as any;

    totalPaginas = result.total_de_paginas || 1;
    const produtos = result.produto_servico_cadastro || [];

    const rows = produtos
      .filter((prod: any) => prod.inativo !== "S")
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
        imagem_url: prod.imagens?.[0]?.url_imagem || null,
        metadata: {
          marca: prod.marca,
          modelo: prod.modelo,
          peso_bruto: prod.peso_bruto,
          peso_liq: prod.peso_liq,
          descricao_familia: prod.descricao_familia,
          cfop: prod.cfop,
        },
        updated_at: new Date().toISOString(),
      }));

    if (rows.length > 0) {
      const { error } = await supabase.from("omie_products").upsert(rows, { onConflict: "omie_codigo_produto" });
      if (error) {
        console.error(`[Omie Vendas] Erro batch upsert página ${pagina}:`, error);
      } else {
        totalSynced += rows.length;
      }
    }

    console.log(`[Omie Vendas] Página ${pagina}/${totalPaginas} - ${produtos.length} produtos processados`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalSynced, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Sincronizar estoque real dos produtos via ListarPosEstoque (paginado)
async function syncEstoque(supabase: ReturnType<typeof createClient>, startPage = 1, maxPages = 10) {
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
      }
    ) as any;

    totalPaginas = result.nTotPaginas || 1;
    const produtos = result.produtos || [];

    for (const prod of produtos) {
      const codProd = prod.nCodProd;
      const saldo = prod.nSaldo ?? 0;

      if (codProd) {
        const { error } = await supabase
          .from("omie_products")
          .update({ estoque: saldo, updated_at: new Date().toISOString() })
          .eq("omie_codigo_produto", codProd);
        if (!error) totalUpdated++;
      }
    }

    console.log(`[Omie Vendas] Estoque página ${pagina}/${totalPaginas} - ${produtos.length} produtos`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalUpdated, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Buscar/listar clientes na empresa de vendas
async function listarClientesVendas(searchTerm: string) {
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
      }
    ) as any;

    if (result.clientes_cadastro) {
      for (const c of result.clientes_cadastro) {
        results.push({
          codigo_cliente: c.codigo_cliente_omie,
          razao_social: c.razao_social || "",
          nome_fantasia: c.nome_fantasia || "",
          cnpj_cpf: c.cnpj_cpf || "",
          codigo_vendedor: c.codigo_vendedor || null,
        });
      }
    }
  } catch (e) {
    console.log("[Omie Vendas] Busca por razão social falhou:", e);
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
        }
      ) as any;

      if (result.clientes_cadastro) {
        for (const c of result.clientes_cadastro) {
          if (!results.find(r => r.codigo_cliente === c.codigo_cliente_omie)) {
            results.push({
              codigo_cliente: c.codigo_cliente_omie,
              razao_social: c.razao_social || "",
              nome_fantasia: c.nome_fantasia || "",
              cnpj_cpf: c.cnpj_cpf || "",
              codigo_vendedor: c.codigo_vendedor || null,
            });
          }
        }
      }
    } catch (e) {
      console.log("[Omie Vendas] Busca por documento falhou:", e);
    }
  }

  return results;
}

// Buscar cliente na empresa de vendas pelo CPF/CNPJ
async function buscarClienteVendas(document: string) {
  const documentClean = document.replace(/\D/g, "");

  const result = await callOmieVendasApi(
    "geral/clientes/",
    "ListarClientes",
    {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: documentClean },
    }
  ) as any;

  if (!result.clientes_cadastro?.[0]?.codigo_cliente_omie) {
    return null;
  }

  const cliente = result.clientes_cadastro[0];
  return {
    codigo_cliente: cliente.codigo_cliente_omie,
    razao_social: cliente.razao_social,
    codigo_vendedor: cliente.codigo_vendedor || null,
  };
}

// Buscar histórico de preços no Omie (pedidos anteriores do cliente)
async function buscarHistoricoPrecosOmie(codigoCliente: number) {
  try {
    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      {
        pagina: 1,
        registros_por_pagina: 50,
        filtrar_por_cliente: codigoCliente,
        filtrar_apenas_inclusao: "N",
      }
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
    console.error("[Omie Vendas] Erro ao buscar histórico de preços:", error);
    return {};
  }
}

// Listar formas de pagamento do Omie
async function listarFormasPagamento() {
  const result = await callOmieVendasApi(
    "geral/formaspagamento/",
    "ListarFormasPagamento",
    { pagina: 1, registros_por_pagina: 100 }
  ) as any;

  const formas = result.forma_pagamento_cadastro || [];
  return formas
    .filter((f: any) => f.cInativo !== "S")
    .map((f: any) => ({
      codigo: f.cCodigo,
      descricao: f.cDescricao,
    }));
}

// Buscar última forma de pagamento usada pelo cliente
async function buscarUltimaParcela(codigoCliente: number) {
  try {
    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      {
        pagina: 1,
        registros_por_pagina: 5,
        filtrar_por_cliente: codigoCliente,
        filtrar_apenas_inclusao: "N",
      }
    ) as any;

    const pedidos = result.pedido_venda_produto || [];
    if (pedidos.length > 0) {
      const ultimoPedido = pedidos[0];
      return ultimoPedido.cabecalho?.codigo_parcela || null;
    }
    return null;
  } catch (error) {
    console.error("[Omie Vendas] Erro ao buscar última parcela:", error);
    return null;
  }
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
  }>,
  observacao?: string,
  codigoParcela?: string
) {
  const cCodIntPed = `PV_${salesOrderId.substring(0, 8)}_${Date.now()}`;

  const det = items.map((item, index) => ({
    ide: { codigo_item_integracao: `${cCodIntPed}_${index + 1}` },
    produto: {
      codigo_produto: item.omie_codigo_produto,
      quantidade: item.quantidade,
      valor_unitario: item.valor_unitario,
    },
  }));

  const cabecalho: Record<string, unknown> = {
    codigo_pedido_integracao: cCodIntPed,
    codigo_cliente: codigoCliente,
    data_previsao: new Date().toISOString().split("T")[0].split("-").reverse().join("/"),
    etapa: "10",
    codigo_parcela: codigoParcela || "999",
  };

  if (codigoVendedor && codigoVendedor > 0) {
    cabecalho.codigo_vendedor = codigoVendedor;
  }

  const payload = {
    cabecalho,
    det,
    observacoes: {
      obs_venda: observacao || `Pedido de venda via App ColaCor`,
    },
    informacoes_adicionais: {
      codigo_categoria: "1.01.01",
      codigo_conta_corrente: 8693825504, // Itaú Unibanco
    },
  };

  console.log("[Omie Vendas] Payload PedidoVenda:", JSON.stringify(payload, null, 2));

  const result = await callOmieVendasApi(
    "produtos/pedido/",
    "IncluirPedido",
    payload
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

    const { action, ...params } = await req.json();

    let result: unknown;

    switch (action) {
      case "sync_products": {
        const startPage = params.start_page || 1;
        const syncResult = await syncProducts(supabaseAdmin, startPage);
        result = { success: true, ...syncResult };
        break;
      }

      case "sync_estoque": {
        const startPageEstoque = params.start_page || 1;
        const estoqueResult = await syncEstoque(supabaseAdmin, startPageEstoque);
        result = { success: true, ...estoqueResult };
        break;
      }

      case "listar_clientes": {
        const { search } = params;
        if (!search || String(search).length < 2) throw new Error("Busca deve ter ao menos 2 caracteres");
        const clientes = await listarClientesVendas(String(search));
        result = { success: true, clientes };
        break;
      }

      case "buscar_cliente": {
        const { document } = params;
        if (!document) throw new Error("Documento é obrigatório");
        const cliente = await buscarClienteVendas(document);
        result = { success: true, cliente };
        break;
      }

      case "buscar_precos_cliente": {
        const { codigo_cliente } = params;
        if (!codigo_cliente) throw new Error("Código do cliente é obrigatório");
        const precos = await buscarHistoricoPrecosOmie(codigo_cliente);
        result = { success: true, precos };
        break;
      }

      case "criar_pedido": {
        const { sales_order_id, codigo_cliente, codigo_vendedor, items, observacao, codigo_parcela } = params;
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
          codigo_parcela
        );
        result = { success: true, ...pedido };
        break;
      }

      case "listar_formas_pagamento": {
        const formas = await listarFormasPagamento();
        result = { success: true, formas };
        break;
      }

      case "buscar_ultima_parcela": {
        const { codigo_cliente: codCli } = params;
        if (!codCli) throw new Error("Código do cliente é obrigatório");
        const ultimaParcela = await buscarUltimaParcela(codCli);
        result = { success: true, ultima_parcela: ultimaParcela };
        break;
      }

      case "excluir_pedido": {
        const { omie_pedido_id: pedidoId, sales_order_id: soId } = params;
        if (!soId) throw new Error("ID do pedido é obrigatório");

        // Try to cancel in Omie if it was synced
        if (pedidoId && Number(pedidoId) > 0) {
          try {
            await callOmieVendasApi(
              "produtos/pedido/",
              "CancelarPedido",
              { nCodPed: Number(pedidoId) }
            );
            console.log(`[Omie Vendas] Pedido ${pedidoId} cancelado no Omie`);
          } catch (omieErr: any) {
            console.warn(`[Omie Vendas] Erro ao cancelar no Omie (continuando exclusão local):`, omieErr.message);
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

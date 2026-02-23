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
async function syncProducts(supabase: ReturnType<typeof createClient>) {
  let pagina = 1;
  let totalPaginas = 1;
  let totalSynced = 0;

  while (pagina <= totalPaginas) {
    const result = await callOmieVendasApi(
      "geral/produtos/",
      "ListarProdutos",
      {
        pagina,
        registros_por_pagina: 500,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      }
    ) as any;

    totalPaginas = result.total_de_paginas || 1;
    const produtos = result.produto_servico_cadastro || [];

    for (const prod of produtos) {
      if (prod.inativo === "S") continue;

      const { error } = await supabase.from("omie_products").upsert(
        {
          omie_codigo_produto: prod.codigo_produto,
          omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
          codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
          descricao: prod.descricao || prod.descricao_familia || "Produto sem descrição",
          unidade: prod.unidade || "UN",
          ncm: prod.ncm || null,
          valor_unitario: prod.valor_unitario || 0,
          estoque: prod.quantidade_estoque || 0,
          ativo: prod.inativo !== "S",
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
        },
        { onConflict: "omie_codigo_produto" }
      );

      if (error) {
        console.error(`[Omie Vendas] Erro ao upsert produto ${prod.codigo_produto}:`, error);
      } else {
        totalSynced++;
      }
    }

    console.log(`[Omie Vendas] Página ${pagina}/${totalPaginas} - ${produtos.length} produtos processados`);
    pagina++;
  }

  // Marcar como inativos os produtos que não estão mais no Omie
  return totalSynced;
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
  observacao?: string
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
    etapa: "10", // 10 = Proposta/Orçamento
    codigo_parcela: "999", // A vista
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
      codigo_conta_corrente: 0, // Usar conta padrão
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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
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
        const totalSynced = await syncProducts(supabase);
        result = { success: true, totalSynced };
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
        const { sales_order_id, codigo_cliente, codigo_vendedor, items, observacao } = params;
        if (!sales_order_id || !codigo_cliente || !items?.length) {
          throw new Error("Dados insuficientes para criar pedido de venda");
        }
        const pedido = await criarPedidoVenda(
          supabase,
          sales_order_id,
          codigo_cliente,
          codigo_vendedor,
          items,
          observacao
        );
        result = { success: true, ...pedido };
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

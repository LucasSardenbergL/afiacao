import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

interface OmieResponse {
  faultstring?: string;
  faultcode?: string;
  nCodCli?: number;
  cCodIntCli?: string;
  nCodOS?: number;
  cNumOS?: string;
}

// Função para fazer chamadas à API do Omie
async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>
): Promise<OmieResponse> {
  const OMIE_APP_KEY = Deno.env.get("OMIE_APP_KEY");
  const OMIE_APP_SECRET = Deno.env.get("OMIE_APP_SECRET");

  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) {
    throw new Error("Credenciais do Omie não configuradas");
  }

  const body = {
    call,
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: [params],
  };

  console.log(`[Omie API] Chamando ${endpoint} - ${call}`);
  console.log(`[Omie API] Payload:`, JSON.stringify(body, null, 2));

  const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  console.log(`[Omie API] Resposta:`, JSON.stringify(result, null, 2));

  if (result.faultstring) {
    throw new Error(`Erro Omie: ${result.faultstring}`);
  }

  return result;
}

// Função para cadastrar ou buscar cliente no Omie
async function syncClienteOmie(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  profile: {
    name: string;
    email?: string;
    phone?: string;
    document?: string;
  },
  address?: {
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    state: string;
    zip_code: string;
  }
): Promise<number> {
  // VALIDAÇÃO: CPF/CNPJ é obrigatório
  if (!profile.document || profile.document.replace(/\D/g, "").length < 11) {
    throw new Error("CPF ou CNPJ é obrigatório para criar pedidos. Por favor, atualize seu perfil.");
  }

  const documentClean = profile.document.replace(/\D/g, "");

  // Verificar se já existe mapeamento local
  const { data: existingMapping } = await supabase
    .from("omie_clientes")
    .select("omie_codigo_cliente")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingMapping?.omie_codigo_cliente) {
    console.log(`[Omie] Cliente já mapeado localmente: ${existingMapping.omie_codigo_cliente}`);
    return existingMapping.omie_codigo_cliente;
  }

  // Buscar cliente existente no Omie pelo CPF/CNPJ
  console.log(`[Omie] Buscando cliente existente por CPF/CNPJ: ${documentClean}`);
  
  const searchResult = await callOmieApi(
    "geral/clientes/",
    "ListarClientes",
    { 
      pagina: 1, 
      registros_por_pagina: 1,
      clientesFiltro: {
        cnpj_cpf: documentClean
      }
    }
  ) as any;
  
  if (!searchResult.clientes_cadastro?.[0]?.codigo_cliente_omie) {
    // Cliente NÃO encontrado no Omie - não permitir criar pedido
    throw new Error(
      `Cliente não encontrado no Omie com o CPF/CNPJ informado (${documentClean}). ` +
      `Por favor, verifique se você está cadastrado como cliente ou entre em contato conosco.`
    );
  }

  // Cliente encontrado - criar mapeamento local
  const cliente = searchResult.clientes_cadastro[0];
  const omieCodigoCliente = cliente.codigo_cliente_omie;
  
  console.log(`[Omie] Cliente encontrado: ${omieCodigoCliente} - ${cliente.razao_social}`);
  
  await supabase.from("omie_clientes").insert({
    user_id: userId,
    omie_codigo_cliente: omieCodigoCliente,
    omie_codigo_cliente_integracao: cliente.codigo_cliente_integracao || null,
  });

  return omieCodigoCliente;
}

// Função para criar Ordem de Serviço no Omie
async function criarOrdemServicoOmie(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  omieCodigoCliente: number,
  order: {
    items: Array<{
      category: string;
      quantity: number;
      omie_codigo_servico?: number;
      brandModel?: string;
      notes?: string;
    }>;
    service_type: string;
    subtotal: number;
    delivery_fee: number;
    total: number;
    notes?: string;
  }
): Promise<{ nCodOS: number; cNumOS: string }> {
  const cCodIntOS = `OS_${orderId.substring(0, 8)}_${Date.now()}`;
  
  // Montar descrição dos itens
  const descricaoItens = order.items
    .map((item) => `${item.quantity}x ${item.category}${item.brandModel ? ` (${item.brandModel})` : ''}`)
    .join(", ");

  // Montar lista de serviços prestados a partir dos itens
  // Campos obrigatórios conforme documentação Omie API:
  // - cCodServLC116: Código LC 116 do serviço (ex: "7.07")
  // - cCodServMun: Código do serviço no município
  // - cDescServ: Descrição do serviço
  // - nQtde: Quantidade
  // - nValUnit: Valor unitário
  const servicosPrestados = order.items.map((item) => {
    // Quando o serviço já existe no Omie, a API espera o campo **nCodServico** (não nCodServ)
    // e pode receber apenas ele + quantidade.
    if (item.omie_codigo_servico && item.omie_codigo_servico > 0) {
      return {
        nCodServico: item.omie_codigo_servico,
        nQtde: item.quantity,
      } as Record<string, unknown>;
    }

    // Caso não exista serviço cadastrado, enviamos a estrutura completa do serviço prestado
    return {
      cCodServLC116: "14.01", // Código LC 116 padrão (ajuste conforme sua operação)
      cCodServMun: "01015", // Código do serviço no município (ajuste conforme sua operação)
      cDescServ: item.category,
      cDadosAdicItem: item.brandModel
        ? `Marca/Modelo: ${item.brandModel}${item.notes ? ` | Obs: ${item.notes}` : ""}`
        : item.notes || "",
      cRetemISS: "N",
      cTribServ: "01",
      nQtde: item.quantity,
      nValUnit: 0, // Valor a definir após triagem
      cTpDesconto: "V",
      nValorDesconto: 0,
    } as Record<string, unknown>;
  });

  const osParams: Record<string, unknown> = {
    Cabecalho: {
      cCodIntOS: cCodIntOS,
      nCodCli: omieCodigoCliente,
      cEtapa: "10", // 10 = Aberta
      nQtdeParc: 1,
    },
    InformacoesAdicionais: {
      cDadosAdicNF: `Pedido App - ${descricaoItens}`,
      cCodCateg: "1.01.03", // Categoria padrão
      nCodCC: 3543828789, // Conta Corrente: Omie.CASH
    },
    ServicosPrestados: servicosPrestados,
    Observacoes: {
      cObsOS: order.notes || `Pedido via App - ${descricaoItens}`,
    },
  };

  // Log do payload para debug
  console.log("[Omie] Payload OS:", JSON.stringify(osParams, null, 2));

  const result = await callOmieApi(
    "servicos/os/",
    "IncluirOS",
    osParams
  );

  const nCodOS = result.nCodOS!;
  const cNumOS = result.cNumOS || cCodIntOS;

  // Registrar OS no banco
  await supabase.from("omie_ordens_servico").insert({
    order_id: orderId,
    omie_numero_os: cNumOS,
    omie_codigo_os: nCodOS,
    status: "enviado",
    payload_enviado: osParams,
    resposta_omie: result,
  });

  console.log(`[Omie] OS criada com sucesso: ${cNumOS} (código: ${nCodOS})`);
  
  return { nCodOS, cNumOS };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verificar autenticação
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Não autorizado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Cliente com service role para operações internas
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    
    // Cliente autenticado para validar usuário
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getUser(token);
    
    if (claimsError || !claimsData?.user) {
      return new Response(
        JSON.stringify({ error: "Token inválido" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.user.id;
    const body = await req.json();
    const { action, orderId, orderData, profileData, addressData } = body;

    console.log(`[Omie Sync] Ação: ${action}, Usuário: ${userId}`);

    let result: Record<string, unknown> = {};

    switch (action) {
      case "sync_order": {
        if (!orderId || !orderData || !profileData) {
          return new Response(
            JSON.stringify({ error: "Dados incompletos para sincronização" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 1. Sincronizar cliente
        const omieCodigoCliente = await syncClienteOmie(
          supabaseAdmin,
          userId,
          profileData,
          addressData
        );

        // 2. Criar Ordem de Serviço
        const osResult = await criarOrdemServicoOmie(
          supabaseAdmin,
          orderId,
          omieCodigoCliente,
          orderData
        );

        result = {
          success: true,
          omie_cliente: omieCodigoCliente,
          omie_os: osResult,
        };
        break;
      }

      case "check_client": {
        const { data: mapping } = await supabaseAdmin
          .from("omie_clientes")
          .select("omie_codigo_cliente")
          .eq("user_id", userId)
          .maybeSingle();

        result = {
          exists: !!mapping,
          omie_codigo_cliente: mapping?.omie_codigo_cliente || null,
        };
        break;
      }

      case "list_services": {
        // Buscar serviços do Omie
        console.log("[Omie] Buscando serviços do Omie...");
        
        try {
          const omieResult = await callOmieApi(
            "servicos/servico/",
            "ListarCadastroServico",
            { 
              nPagina: 1, 
              nRegPorPagina: 100 
            }
          ) as any;

          const servicos = omieResult.cadastros || [];
          console.log(`[Omie] ${servicos.length} serviços encontrados`);

          // Formatar para o app
          const servicosFormatados = servicos.map((s: any) => ({
            omie_codigo_servico: s.intListar?.nCodServ || 0,
            omie_codigo_integracao: s.intListar?.cCodIntServ || "",
            descricao: s.descricao?.cDescricao || s.cabecalho?.cDescricao || "Sem descrição",
            codigo_lc116: s.cabecalho?.cIdTrib || "",
            codigo_servico_municipio: s.impostos?.nCodServ || "",
            valor_unitario: s.cabecalho?.nValorUnit || 0,
            unidade: s.cabecalho?.cUnidade || "UN",
          }));

          result = {
            success: true,
            servicos: servicosFormatados,
          };
        } catch (listError) {
          console.error("[Omie] Erro ao listar serviços:", listError);
          result = {
            success: false,
            error: listError instanceof Error ? listError.message : "Erro ao listar serviços",
            servicos: [],
          };
        }
        break;
      }

      case "list_contas_correntes": {
        // Buscar contas correntes do Omie para encontrar o nCodCC
        console.log("[Omie] Buscando contas correntes...");
        
        try {
          const omieResult = await callOmieApi(
            "geral/contacorrente/",
            "ListarContasCorrentes",
            { 
              pagina: 1, 
              registros_por_pagina: 50 
            }
          ) as any;

          const contas = omieResult.ListarContasCorrentes || omieResult.conta_corrente_lista || [];
          console.log(`[Omie] ${contas.length} contas correntes encontradas`);
          console.log("[Omie] Resposta completa:", JSON.stringify(omieResult, null, 2));

          // Formatar para o app
          const contasFormatadas = contas.map((c: any) => ({
            nCodCC: c.nCodCC,
            cDescricao: c.descricao || c.cDescricao || "Sem descrição",
            cCodCCInt: c.cCodCCInt || "",
            cNomeBanco: c.cNomeBanco || "",
            cAgencia: c.cAgencia || "",
            cNumeroConta: c.cNumeroConta || "",
            cTipo: c.tipo || c.cTipo || "",
          }));

          result = {
            success: true,
            contas_correntes: contasFormatadas,
            raw_response: omieResult, // para debug
          };
        } catch (listError) {
          console.error("[Omie] Erro ao listar contas correntes:", listError);
          result = {
            success: false,
            error: listError instanceof Error ? listError.message : "Erro ao listar contas correntes",
            contas_correntes: [],
          };
        }
        break;
      }

      case "list_clientes": {
        // Buscar clientes do Omie
        console.log("[Omie] Buscando clientes...");
        
        try {
          const omieResult = await callOmieApi(
            "geral/clientes/",
            "ListarClientes",
            { 
              pagina: 1, 
              registros_por_pagina: 20 
            }
          ) as any;

          const clientes = omieResult.clientes_cadastro || [];
          console.log(`[Omie] ${clientes.length} clientes encontrados`);

          // Formatar para o app
          const clientesFormatados = clientes.map((c: any) => ({
            codigo_cliente_omie: c.codigo_cliente_omie,
            razao_social: c.razao_social,
            nome_fantasia: c.nome_fantasia,
            cnpj_cpf: c.cnpj_cpf,
            email: c.email,
            telefone: c.telefone1_numero,
          }));

          result = {
            success: true,
            clientes: clientesFormatados,
          };
        } catch (listError) {
          console.error("[Omie] Erro ao listar clientes:", listError);
          result = {
            success: false,
            error: listError instanceof Error ? listError.message : "Erro ao listar clientes",
            clientes: [],
          };
        }
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: "Ação não reconhecida" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Omie Sync] Erro:", error);
    const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

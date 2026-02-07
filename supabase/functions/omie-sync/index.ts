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

// Interface para retorno do cliente com vendedor
interface ClienteOmieResult {
  omieCodigoCliente: number;
  omieCodigoVendedor?: number;
}

// Função para buscar cliente no Omie (apenas existentes)
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
): Promise<ClienteOmieResult> {
  // VALIDAÇÃO: CPF/CNPJ é obrigatório
  if (!profile.document || profile.document.replace(/\D/g, "").length < 11) {
    throw new Error("CPF ou CNPJ é obrigatório para criar pedidos. Por favor, atualize seu perfil.");
  }

  const documentClean = profile.document.replace(/\D/g, "");

  // Verificar se já existe mapeamento local
  const { data: existingMapping } = await supabase
    .from("omie_clientes")
    .select("omie_codigo_cliente, omie_codigo_vendedor")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingMapping?.omie_codigo_cliente) {
    console.log(`[Omie] Cliente já mapeado localmente: ${existingMapping.omie_codigo_cliente}, vendedor: ${existingMapping.omie_codigo_vendedor || 'N/A'}`);
    return {
      omieCodigoCliente: existingMapping.omie_codigo_cliente,
      omieCodigoVendedor: existingMapping.omie_codigo_vendedor || undefined,
    };
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

  // Cliente encontrado - extrair dados incluindo vendedor
  const cliente = searchResult.clientes_cadastro[0];
  const omieCodigoCliente = cliente.codigo_cliente_omie;
  const omieCodigoVendedor = cliente.codigo_vendedor || null;
  
  console.log(`[Omie] Cliente encontrado: ${omieCodigoCliente} - ${cliente.razao_social}`);
  console.log(`[Omie] Vendedor associado: ${omieCodigoVendedor || 'Nenhum'}`);
  
  // Criar mapeamento local incluindo o vendedor
  await supabase.from("omie_clientes").insert({
    user_id: userId,
    omie_codigo_cliente: omieCodigoCliente,
    omie_codigo_cliente_integracao: cliente.codigo_cliente_integracao || null,
    omie_codigo_vendedor: omieCodigoVendedor,
  });

  return {
    omieCodigoCliente,
    omieCodigoVendedor: omieCodigoVendedor || undefined,
  };
}

// Função para criar Ordem de Serviço no Omie
async function criarOrdemServicoOmie(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  omieCodigoCliente: number,
  omieCodigoVendedor: number | undefined,
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
  const servicosPrestados = order.items.map((item) => {
    if (item.omie_codigo_servico && item.omie_codigo_servico > 0) {
      return {
        nCodServico: item.omie_codigo_servico,
        nQtde: item.quantity,
      } as Record<string, unknown>;
    }

    return {
      cCodServLC116: "14.01",
      cCodServMun: "01015",
      cDescServ: item.category,
      cDadosAdicItem: item.brandModel
        ? `Marca/Modelo: ${item.brandModel}${item.notes ? ` | Obs: ${item.notes}` : ""}`
        : item.notes || "",
      cRetemISS: "N",
      cTribServ: "01",
      nQtde: item.quantity,
      nValUnit: 0,
      cTpDesconto: "V",
      nValorDesconto: 0,
    } as Record<string, unknown>;
  });

  // Montar cabeçalho com vendedor se existir
  const cabecalho: Record<string, unknown> = {
    cCodIntOS: cCodIntOS,
    nCodCli: omieCodigoCliente,
    cEtapa: "10", // 10 = Aberta
    nQtdeParc: 1,
  };

  // Adicionar vendedor se o cliente tiver um associado
  if (omieCodigoVendedor && omieCodigoVendedor > 0) {
    cabecalho.nCodVend = omieCodigoVendedor;
    console.log(`[Omie] Vendedor associado à OS: ${omieCodigoVendedor}`);
  }

  const osParams: Record<string, unknown> = {
    Cabecalho: cabecalho,
    InformacoesAdicionais: {
      cDadosAdicNF: `Pedido App - ${descricaoItens}`,
      cCodCateg: "1.01.03",
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

        // 1. Sincronizar cliente (busca existente no Omie)
        const clienteResult = await syncClienteOmie(
          supabaseAdmin,
          userId,
          profileData,
          addressData
        );

        // 2. Criar Ordem de Serviço (com vendedor se existir)
        const osResult = await criarOrdemServicoOmie(
          supabaseAdmin,
          orderId,
          clienteResult.omieCodigoCliente,
          clienteResult.omieCodigoVendedor,
          orderData
        );

        result = {
          success: true,
          omie_cliente: clienteResult.omieCodigoCliente,
          omie_vendedor: clienteResult.omieCodigoVendedor || null,
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

      case "sync_services": {
        // Sincronizar serviços do Omie com o banco local
        console.log("[Omie] Iniciando sincronização de serviços...");
        
        try {
          // 1. Buscar todos os serviços do Omie (ativos e inativos)
          const omieResult = await callOmieApi(
            "servicos/servico/",
            "ListarCadastroServico",
            { 
              nPagina: 1, 
              nRegPorPagina: 500 // Buscar mais para garantir todos
            }
          ) as any;

          const servicosOmie = omieResult.cadastros || [];
          console.log(`[Omie] ${servicosOmie.length} serviços encontrados no Omie`);

          // 2. Buscar serviços existentes no banco
          const { data: servicosLocais } = await supabaseAdmin
            .from("omie_servicos")
            .select("id, omie_codigo_servico, descricao, inativo");

          const servicosLocaisMap = new Map(
            (servicosLocais || []).map((s: any) => [s.omie_codigo_servico, s])
          );

          let adicionados = 0;
          let atualizados = 0;
          let inativados = 0;

          // 3. Processar serviços do Omie
          const codigosOmie = new Set<number>();
          
          for (const s of servicosOmie) {
            const codigoServico = s.intListar?.nCodServ;
            if (!codigoServico) continue;
            
            codigosOmie.add(codigoServico);
            
            const descricao = s.descricao?.cDescrCompleta || s.cabecalho?.cDescricao || "Sem descrição";
            const inativoOmie = s.info?.inativo === "S";
            const codigoIntegracao = s.intListar?.cCodIntServ || null;

            const servicoLocal = servicosLocaisMap.get(codigoServico);

            if (servicoLocal) {
              // Atualizar serviço existente
              const { error: updateError } = await supabaseAdmin
                .from("omie_servicos")
                .update({
                  descricao,
                  inativo: inativoOmie,
                  omie_codigo_integracao: codigoIntegracao,
                  updated_at: new Date().toISOString(),
                })
                .eq("omie_codigo_servico", codigoServico);

              if (!updateError) {
                if (servicoLocal.inativo !== inativoOmie || servicoLocal.descricao !== descricao) {
                  atualizados++;
                }
              }
            } else {
              // Adicionar novo serviço
              console.log(`[Omie] Inserindo serviço: ${codigoServico} - ${descricao}`);
              const { error: insertError } = await supabaseAdmin
                .from("omie_servicos")
                .insert({
                  omie_codigo_servico: codigoServico,
                  omie_codigo_integracao: codigoIntegracao,
                  descricao,
                  app_service_type: "afiacao", // Tipo padrão
                  inativo: inativoOmie,
                });

              if (insertError) {
                console.error(`[Omie] Erro ao inserir serviço ${codigoServico}:`, insertError);
              } else {
                adicionados++;
                console.log(`[Omie] Novo serviço adicionado: ${descricao}`);
              }
            }
          }

          // 4. Inativar serviços locais que não existem mais no Omie
          for (const [codigo, servicoLocal] of servicosLocaisMap) {
            if (!codigosOmie.has(codigo) && !servicoLocal.inativo) {
              await supabaseAdmin
                .from("omie_servicos")
                .update({ inativo: true, updated_at: new Date().toISOString() })
                .eq("omie_codigo_servico", codigo);
              
              inativados++;
              console.log(`[Omie] Serviço inativado (removido do Omie): ${servicoLocal.descricao}`);
            }
          }

          console.log(`[Omie] Sincronização concluída: ${adicionados} adicionados, ${atualizados} atualizados, ${inativados} inativados`);

          result = {
            success: true,
            adicionados,
            atualizados,
            inativados,
            total_omie: servicosOmie.length,
          };
        } catch (syncError) {
          console.error("[Omie] Erro ao sincronizar serviços:", syncError);
          result = {
            success: false,
            error: syncError instanceof Error ? syncError.message : "Erro ao sincronizar serviços",
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

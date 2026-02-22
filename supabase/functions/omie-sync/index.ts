import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

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

// Função para enviar notificação de novo pedido para administração
async function sendOrderNotificationEmail(
  profileData: { name: string; email?: string; phone?: string; document?: string },
  osNumber: string,
  orderItems: Array<{ category: string; quantity: number; toolName?: string }>
): Promise<void> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const ADMIN_EMAIL = "colacorcomercial@gmail.com";

  if (!RESEND_API_KEY) {
    console.log("[Notificação] RESEND_API_KEY não configurada, pulando envio de email");
    return;
  }

  try {
    const resend = new Resend(RESEND_API_KEY);

    // Formatar lista de itens
    const itemsList = orderItems
      .map(item => `• ${item.quantity}x ${item.toolName || item.category}`)
      .join("<br>");

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e; border-bottom: 2px solid #e94560; padding-bottom: 10px;">
          🔔 Novo Pedido Recebido
        </h2>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #16213e; margin-top: 0;">Ordem de Serviço: ${osNumber}</h3>
          
          <p><strong>Cliente:</strong> ${profileData.name}</p>
          ${profileData.email ? `<p><strong>Email:</strong> ${profileData.email}</p>` : ""}
          ${profileData.phone ? `<p><strong>Telefone:</strong> ${profileData.phone}</p>` : ""}
          ${profileData.document ? `<p><strong>Documento:</strong> ${profileData.document}</p>` : ""}
        </div>
        
        <div style="margin: 20px 0;">
          <h4 style="color: #16213e;">Itens do Pedido:</h4>
          <div style="background-color: #fff; border: 1px solid #ddd; padding: 15px; border-radius: 8px;">
            ${itemsList}
          </div>
        </div>
        
        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          Este é um email automático enviado pelo sistema ColaCor App.
        </p>
      </div>
    `;

    const emailResponse = await resend.emails.send({
      from: "ColaCor App <onboarding@resend.dev>",
      to: [ADMIN_EMAIL],
      subject: `Novo Pedido - OS ${osNumber} - ${profileData.name}`,
      html: emailHtml,
    });

    console.log("[Notificação] Email enviado com sucesso:", emailResponse);
  } catch (error) {
    // Não lançar erro para não afetar o fluxo principal do pedido
    console.error("[Notificação] Erro ao enviar email de notificação:", error);
  }
}
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
    payment_method?: string;
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

  // Calcular parcelas com base no método de pagamento
  const paymentMethod = order.payment_method || 'a_vista';
  
  const buildParcelas = (method: string): { parcelas: Array<Record<string, unknown>>; nQtdeParc: number } => {
    const hoje = new Date();
    const formatDate = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const addDays = (d: Date, days: number) => { const r = new Date(d); r.setDate(r.getDate() + days); return r; };
    
    const configs: Record<string, number[]> = {
      'a_vista': [0],
      '30dd': [30],
      '30_60dd': [30, 60],
      '30_60_90dd': [30, 60, 90],
      '28dd': [28],
      '28_56dd': [28, 56],
      '28_56_84dd': [28, 56, 84],
    };
    
    const dias = configs[method] || [0];
    const percentual = Math.round((100 / dias.length) * 100) / 100;
    
    return {
      nQtdeParc: dias.length,
      parcelas: dias.map((d, i) => {
        const parc: Record<string, unknown> = {
          nParcela: i + 1,
          dDtVenc: formatDate(addDays(hoje, d)),
          nPercentual: i === dias.length - 1 ? Math.round((100 - percentual * (dias.length - 1)) * 100) / 100 : percentual,
        };
        // Omie exige nValor > 0 se presente; omitir quando total é 0 (preço ainda não definido)
        return parc;
      }),
    };
  };
  
  const { parcelas, nQtdeParc } = buildParcelas(paymentMethod);
  console.log(`[Omie] Pagamento: ${paymentMethod}, ${nQtdeParc} parcela(s)`);

  // Montar cabeçalho com vendedor se existir
  const cabecalho: Record<string, unknown> = {
    cCodIntOS: cCodIntOS,
    nCodCli: omieCodigoCliente,
    cEtapa: "10", // 10 = Aberta
    nQtdeParc: nQtdeParc,
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

  // Só incluir Parcelas se o total for > 0 (Omie exige nValor > 0)
  if (order.total > 0) {
    const parcelasComValor = parcelas.map((p, i) => ({
      ...p,
      nValor: i === parcelas.length - 1
        ? Math.round((order.total - Math.floor(order.total / parcelas.length) * (parcelas.length - 1)) * 100) / 100
        : Math.floor(order.total / parcelas.length * 100) / 100,
    }));
    osParams.Parcelas = parcelasComValor;
  }

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

// Função para alterar Ordem de Serviço no Omie
async function alterarOrdemServicoOmie(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  order: {
    items: Array<{
      category: string;
      quantity: number;
      omie_codigo_servico?: number;
      brandModel?: string;
      notes?: string;
      unitPrice?: number;
    }>;
    subtotal: number;
    delivery_fee: number;
    total: number;
    notes?: string;
    status?: string;
  }
): Promise<{ success: boolean; nCodOS?: number; cNumOS?: string; error?: string }> {
  // Buscar a OS existente no banco
  const { data: osData, error: osError } = await supabase
    .from("omie_ordens_servico")
    .select("omie_codigo_os, omie_numero_os")
    .eq("order_id", orderId)
    .maybeSingle();

  if (osError || !osData?.omie_codigo_os) {
    console.log(`[Omie] OS não encontrada para o pedido ${orderId}`);
    return { success: false, error: "Ordem de Serviço não encontrada no Omie" };
  }

  const nCodOS = osData.omie_codigo_os;
  const cNumOS = osData.omie_numero_os;

  console.log(`[Omie] Alterando OS ${cNumOS} (código: ${nCodOS})`);

  // Montar lista de serviços prestados com preços atualizados
  const servicosPrestados = order.items.map((item) => {
    const baseService: Record<string, unknown> = {
      nQtde: item.quantity,
      nValUnit: item.unitPrice || 0,
    };

    if (item.omie_codigo_servico && item.omie_codigo_servico > 0) {
      baseService.nCodServico = item.omie_codigo_servico;
    } else {
      baseService.cCodServLC116 = "14.01";
      baseService.cCodServMun = "01015";
      baseService.cDescServ = item.category;
      baseService.cRetemISS = "N";
      baseService.cTribServ = "01";
      baseService.cTpDesconto = "V";
      baseService.nValorDesconto = 0;
    }

    if (item.brandModel || item.notes) {
      baseService.cDadosAdicItem = item.brandModel
        ? `Marca/Modelo: ${item.brandModel}${item.notes ? ` | Obs: ${item.notes}` : ""}`
        : item.notes || "";
    }

    return baseService;
  });

  // Mapear status do app para etapa do Omie
  const etapaOmie = (() => {
    switch (order.status) {
      case "pedido_recebido":
      case "aguardando_coleta":
        return "10"; // Aberta
      case "em_triagem":
      case "em_afiacao":
        return "20"; // Em andamento
      case "pronto_entrega":
      case "em_rota":
        return "30"; // Aguardando faturamento
      case "entregue":
        return "50"; // Faturada
      default:
        return "10";
    }
  })();

  const osParams: Record<string, unknown> = {
    Cabecalho: {
      nCodOS: nCodOS,
      cEtapa: etapaOmie,
    },
    InformacoesAdicionais: {
      cCodCateg: "1.01.03",
      nCodCC: 3543828789,
    },
    ServicosPrestados: servicosPrestados,
    Observacoes: {
      cObsOS: order.notes || `Pedido via App - Atualizado`,
    },
  };

  console.log("[Omie] Payload AlterarOS:", JSON.stringify(osParams, null, 2));

  try {
    const result = await callOmieApi(
      "servicos/os/",
      "AlterarOS",
      osParams
    );

    // Atualizar registro no banco
    await supabase
      .from("omie_ordens_servico")
      .update({
        status: "atualizado",
        payload_enviado: osParams,
        resposta_omie: result,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    console.log(`[Omie] OS ${cNumOS} alterada com sucesso`);

    return { success: true, nCodOS, cNumOS };
  } catch (alterError) {
    console.error(`[Omie] Erro ao alterar OS ${cNumOS}:`, alterError);
    
    // Registrar erro no banco
    await supabase
      .from("omie_ordens_servico")
      .update({
        status: "erro_atualizacao",
        resposta_omie: { error: alterError instanceof Error ? alterError.message : "Erro desconhecido" },
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    return { 
      success: false, 
      error: alterError instanceof Error ? alterError.message : "Erro ao alterar OS no Omie" 
    };
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Cliente com service role para operações internas
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action, orderId, orderData, profileData, addressData } = body;

    // Ações que não requerem autenticação (cron jobs, webhooks)
    const publicActions = ["sync_services"];
    
    let userId: string | null = null;
    
    if (!publicActions.includes(action)) {
      // Verificar autenticação para ações protegidas
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({ error: "Não autorizado" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
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

      userId = claimsData.user.id;
    }

    console.log(`[Omie Sync] Ação: ${action}, Usuário: ${userId || 'N/A (público)'}`);

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

        // 3. Enviar notificação por email para administração (não bloqueia o fluxo)
        try {
          await sendOrderNotificationEmail(
            profileData,
            osResult.cNumOS,
            orderData.items
          );
        } catch (notifyError) {
          console.error("[Omie Sync] Erro ao enviar notificação (não crítico):", notifyError);
        }

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

      case "update_order": {
        // Alterar OS existente no Omie
        const { orderId: updateOrderId, orderData: updateOrderData } = body;
        
        if (!updateOrderId || !updateOrderData) {
          return new Response(
            JSON.stringify({ error: "Dados incompletos para atualização" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Verificar se usuário é funcionário/admin
        const { data: roleData } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .maybeSingle();

        if (!roleData || (roleData.role !== "admin" && roleData.role !== "employee")) {
          return new Response(
            JSON.stringify({ error: "Apenas funcionários podem alterar pedidos" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        console.log(`[Omie] Funcionário ${userId} alterando pedido ${updateOrderId}`);

        const updateResult = await alterarOrdemServicoOmie(
          supabaseAdmin,
          updateOrderId,
          updateOrderData
        );

        result = updateResult;
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

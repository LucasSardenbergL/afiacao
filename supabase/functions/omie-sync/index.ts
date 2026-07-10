import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
// Resend usado via fetch direto à REST API (https://api.resend.com/emails) para evitar dep npm

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
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

interface OmieClienteCadastro {
  codigo_cliente_omie?: number;
  codigo_cliente_integracao?: string | null;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone1_numero?: string;
  codigo_vendedor?: number | null;
  recomendacoes?: { codigo_vendedor?: number | null };
}

interface OmieListarClientesResponse {
  clientes_cadastro?: OmieClienteCadastro[];
  total_de_paginas?: number;
  faultstring?: string;
}

interface OmieIncluirClienteResponse {
  codigo_cliente_omie?: number;
  nCodCli?: number;
  faultstring?: string;
}

interface OmieServicoCadastro {
  intListar?: { nCodServ?: number; cCodIntServ?: string };
  descricao?: { cDescricao?: string; cDescrCompleta?: string };
  cabecalho?: { cDescricao?: string; cIdTrib?: string; nValorUnit?: number; cUnidade?: string };
  impostos?: { nCodServ?: string };
  info?: { inativo?: string };
}

interface OmieListarServicosResponse {
  cadastros?: OmieServicoCadastro[];
  faultstring?: string;
}

interface OmieContaCorrente {
  nCodCC?: number;
  descricao?: string;
  cDescricao?: string;
  cCodCCInt?: string;
  cNomeBanco?: string;
  cAgencia?: string;
  cNumeroConta?: string;
  cTipo?: string;
  tipo?: string;
}

interface OmieListarContasCorrentesResponse {
  ListarContasCorrentes?: OmieContaCorrente[];
  conta_corrente_lista?: OmieContaCorrente[];
  faultstring?: string;
}

interface OmieConsultarOSResponse {
  nCodOS?: number;
  cNumOS?: string;
  faultstring?: string;
}

interface ServicoLocalRow {
  id: string;
  omie_codigo_servico: number;
  descricao: string;
  inativo: boolean;
}

// Função para fazer chamadas à API do Omie
async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>
): Promise<OmieResponse> {
  const OMIE_APP_KEY = Deno.env.get("OMIE_COLACOR_SC_APP_KEY");
  const OMIE_APP_SECRET = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET");

  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) {
    throw new Error("Credenciais do Omie (Colacor SC) não configuradas");
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

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "ColaCor App <onboarding@resend.dev>",
        to: [ADMIN_EMAIL],
        subject: `Novo Pedido - OS ${osNumber} - ${profileData.name}`,
        html: emailHtml,
      }),
    });

    const emailData = await emailResponse.json().catch(() => ({}));
    console.log("[Notificação] Email enviado com sucesso:", emailData);
  } catch (error) {
    // Não lançar erro para não afetar o fluxo principal do pedido
    console.error("[Notificação] Erro ao enviar email de notificação:", error);
  }
}
interface ClienteOmieResult {
  omieCodigoCliente: number;
  omieCodigoVendedor?: number;
}

// MIRROR-START omie-sync-identidade — espelhado verbatim de src/lib/omie/omie-sync-identidade.ts
// Decisão de identidade Omie do PEDIDO SELF-SERVICE (conta colacor_sc) — money-path P0-B-bis. PURA:
// recebe a linha da VIEW FRESCA account-correta (omie_customer_account_map_fresco) já buscada + os
// matches da API Omie (registros_por_pagina:2) e decide o código autoritativo OU fail-closed.
// Precisão>recall: doc-ambíguo (2+ códigos distintos), ausência confirmada, ou código bigint não
// representável = REJECT. NÃO lê o espelho poluído omie_clientes. A âncora (user_id, account) e o I/O
// (buscar a view, buscar a API, write-back) ficam no chamador; aqui só a decisão. Espelhado no edge
// (Deno não importa de src/); paridade textual no CI em src/__tests__/edge-money-path-invariants.test.ts.
interface MatchOmie { codigo_cliente: number; codigo_vendedor: number | null }
type IdentidadeSelfService =
  | { ok: true; codigo_cliente: number; codigo_vendedor: number | null }
  | { ok: false; needOmie: true }
  | { ok: false; erro: 'doc-ambíguo' | 'sem-vinculo' | 'codigo-inseguro' };

function decidirIdentidadeSelfService(args: {
  viewRow: MatchOmie | null;
  omieMatches: MatchOmie[] | null;
}): IdentidadeSelfService {
  const { viewRow, omieMatches } = args;

  let cand: MatchOmie;
  if (viewRow) {
    // View fresca já é account-correta (1 linha por (user_id, account)) — resolve sem API.
    cand = viewRow;
  } else {
    // Ausência na view → o chamador precisa buscar a API Omie por documento.
    if (omieMatches === null) return { ok: false, needOmie: true };
    // Dedup por código: 2+ códigos DISTINTOS no mesmo doc = ambíguo — chutar o 1º seria last-write-wins.
    const distintos = [...new Map(omieMatches.map((m) => [String(m.codigo_cliente), m])).values()];
    if (distintos.length > 1) return { ok: false, erro: 'doc-ambíguo' };
    if (distintos.length === 0) return { ok: false, erro: 'sem-vinculo' };
    cand = distintos[0];
  }

  // Segurança de representação (bigint): códigos Omie são bigint; Number perde precisão ≥ 2^53. Um código
  // truncado mandaria o pedido pro cliente errado — fail-closed em vez de arriscar (espelha o guard do
  // decideAccountIdentity). Vendedor é secundário (não é âncora de identidade) → passa como veio.
  if (!Number.isSafeInteger(cand.codigo_cliente) || cand.codigo_cliente <= 0) {
    return { ok: false, erro: 'codigo-inseguro' };
  }
  return { ok: true, codigo_cliente: cand.codigo_cliente, codigo_vendedor: cand.codigo_vendedor };
}
// MIRROR-END

// Função para buscar cliente no Omie (apenas existentes)
async function syncClienteOmie(
  supabase: SupabaseClient,
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

  // P0-B-bis: identidade Omie pela VIEW FRESCA account-correta (colacor_sc), NÃO o espelho poluído
  // omie_clientes (mix de contas, rótulo 'colacor' mentiroso). Ausência na view → fallback API
  // fail-closed (registros:2, rejeita doc-ambíguo — o :1 antigo era last-write-wins). Ver
  // docs/superpowers/specs/2026-07-09-omie-leituras-money-path-p0b-bis-design.md.
  const { data: viewRow } = await supabase
    .from("omie_customer_account_map_fresco")
    .select("omie_codigo_cliente, omie_codigo_vendedor")
    .eq("user_id", userId)
    .eq("account", "colacor_sc")
    .maybeSingle();

  const viaView = decidirIdentidadeSelfService({
    viewRow: viewRow?.omie_codigo_cliente
      ? { codigo_cliente: viewRow.omie_codigo_cliente, codigo_vendedor: viewRow.omie_codigo_vendedor ?? null }
      : null,
    omieMatches: null,
  });
  if (viaView.ok) {
    console.log(`[Omie] Cliente resolvido pela view fresca (colacor_sc): ${viaView.codigo_cliente}, vendedor: ${viaView.codigo_vendedor ?? 'N/A'}`);
    return {
      omieCodigoCliente: viaView.codigo_cliente,
      omieCodigoVendedor: viaView.codigo_vendedor ?? undefined,
    };
  }

  // Sem vínculo fresco na view (ausência ou código inseguro) → buscar no Omie por CPF/CNPJ com
  // registros_por_pagina:2 para detectar duplicata-CNPJ (o :1 antigo pegava só o 1º = last-write-wins).
  console.log(`[Omie] Sem vínculo fresco na view p/ colacor_sc; buscando no Omie por CPF/CNPJ: ${documentClean}`);
  const searchResult = await callOmieApi(
    "geral/clientes/",
    "ListarClientes",
    {
      pagina: 1,
      registros_por_pagina: 2,
      clientesFiltro: {
        cnpj_cpf: documentClean
      }
    }
  ) as unknown as OmieListarClientesResponse;

  const omieMatches: MatchOmie[] = (searchResult.clientes_cadastro ?? [])
    .filter((c) => c.codigo_cliente_omie)
    .map((c) => ({
      codigo_cliente: c.codigo_cliente_omie as number,
      codigo_vendedor: c.recomendacoes?.codigo_vendedor ?? c.codigo_vendedor ?? null,
    }));

  const viaOmie = decidirIdentidadeSelfService({ viewRow: null, omieMatches });
  if (!viaOmie.ok) {
    if ("erro" in viaOmie && viaOmie.erro === "doc-ambíguo") {
      // Fail-closed: 2+ cadastros DISTINTOS no mesmo CNPJ/CPF → não chuta (o 1º seria last-write-wins,
      // podendo mandar o pedido pro cliente errado). Precisão>recall no money-path.
      throw new Error(
        `CNPJ/CPF (${documentClean}) tem 2+ cadastros distintos na conta colacor_sc — cadastro ambíguo, ` +
        `pedido bloqueado por segurança. Entre em contato conosco para consolidar o cadastro.`
      );
    }
    // sem-vinculo | codigo-inseguro → cliente não utilizável para pedido.
    throw new Error(
      `Cliente não encontrado no Omie com o CPF/CNPJ informado (${documentClean}). ` +
      `Por favor, verifique se você está cadastrado como cliente ou entre em contato conosco.`
    );
  }

  const omieCodigoCliente = viaOmie.codigo_cliente;
  const omieCodigoVendedor = viaOmie.codigo_vendedor;
  // Cliente cru correspondente (há exatamente 1 match não-ambíguo aqui) — preserva o integração no write-back.
  const cliente = (searchResult.clientes_cadastro ?? []).find((c) => c.codigo_cliente_omie === omieCodigoCliente);

  console.log(`[Omie] Cliente encontrado no Omie: ${omieCodigoCliente} - ${cliente?.razao_social ?? ''}`);
  console.log(`[Omie] Vendedor associado: ${omieCodigoVendedor ?? 'Nenhum'}`);

  // TODO Fatia 4: este write-back é WRITER do espelho poluído omie_clientes (grava sem conta, rótulo
  // 'colacor' default) — será migrado/aposentado na Fatia 4. Mantido por ora: não corrompe leitor que
  // já lê a view fresca, e ainda serve o cache legado até todos os leitores migrarem.
  await supabase.from("omie_clientes").insert({
    user_id: userId,
    omie_codigo_cliente: omieCodigoCliente,
    omie_codigo_cliente_integracao: cliente?.codigo_cliente_integracao || null,
    omie_codigo_vendedor: omieCodigoVendedor,
  });

  return {
    omieCodigoCliente,
    omieCodigoVendedor: omieCodigoVendedor ?? undefined,
  };
}

// Função para criar Ordem de Serviço no Omie
async function criarOrdemServicoOmie(
  supabase: SupabaseClient,
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
      unitPrice?: number;
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
      const svc: Record<string, unknown> = {
        nCodServico: item.omie_codigo_servico,
        nQtde: item.quantity,
      };
      if (item.unitPrice && item.unitPrice > 0) {
        svc.nValUnit = item.unitPrice;
      }
      return svc;
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
  supabase: SupabaseClient,
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

// Espelho VERBATIM de src/lib/afiacao/os-etapa.ts (e da SQL mapear_status_etapa).
// 10 Aberta · 20 Em andamento · 30 Aguardando faturamento · null = mantém (não sincroniza).
function mapearStatusEtapa(status: string): string | null {
  switch (status) {
    case "pedido_recebido":
    case "aguardando_coleta":
    case "orcamento_enviado":
    case "aprovado":
      return "10";
    case "em_triagem":
    case "em_afiacao":
    case "controle_qualidade":
      return "20";
    case "pronto_entrega":
    case "em_rota":
      return "30";
    default:
      return null; // 'entregue' + desconhecido
  }
}

/**
 * AlterarOS status-only: troca SÓ a etapa da OS, sem reenviar serviços/preços do app
 * (preserva ajustes manuais feitos na OS dentro do Omie). Envia apenas o Cabecalho
 * (atualização parcial). NÃO reusa alterarOrdemServicoOmie (aquele remonta serviços).
 */
async function alterarEtapaOS(
  nCodOS: number,
  etapaAlvo: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await callOmieApi("servicos/os/", "AlterarOS", {
      Cabecalho: { nCodOS: nCodOS, cEtapa: etapaAlvo },
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro AlterarOS" };
  }
}

/**
 * Processa 1 item da fila de sync de etapa. Recalcula a etapa do status ATUAL
 * (não confia na fila velha), aplica idempotência e backoff. Devolve um resumo.
 */
async function processarItemFilaOsSync(
  supabaseAdmin: SupabaseClient,
  orderId: string,
  tentativas: number
): Promise<Record<string, unknown>> {
  const removerDaFila = () =>
    supabaseAdmin.from("afiacao_os_sync_fila").delete().eq("order_id", orderId);

  // 1) status atual do pedido
  const { data: ord, error: ordErr } = await supabaseAdmin
    .from("orders").select("status").eq("id", orderId).maybeSingle();
  if (ordErr) {
    // erro transitório de DB/PostgREST → recuperável: backoff, NÃO apaga da fila
    return await bumpRetryOsSync(supabaseAdmin, orderId, tentativas, `orders_read: ${ordErr.message}`);
  }
  if (!ord) {
    // pedido realmente não existe (sem erro) → sai da fila
    await removerDaFila();
    return { order_id: orderId, skip: "pedido_inexistente" };
  }
  const etapaAtual = mapearStatusEtapa(ord.status as string);

  // 2) etapa null (ex.: entregue) → noop, sai da fila
  if (etapaAtual === null) {
    await removerDaFila();
    return { order_id: orderId, noop: "sem_etapa" };
  }

  // 3) acha a OS no Omie. order_id pode ter +1 linha (schema sem unique; sync_order faz insert cru) →
  //    pega a mais recente; .limit(1) evita o 406 do .maybeSingle() com duplicata (poison-pill).
  const { data: os, error: osErr } = await supabaseAdmin
    .from("omie_ordens_servico")
    .select("omie_codigo_os, last_etapa_sincronizada")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (osErr || !os?.omie_codigo_os) {
    // erro transitório OU OS ainda sendo criada → recuperável (backoff), mantém na fila
    return await bumpRetryOsSync(
      supabaseAdmin, orderId, tentativas, osErr ? `os_read: ${osErr.message}` : "sem_os"
    );
  }

  // 4) idempotência
  if (etapaAtual === os.last_etapa_sincronizada) {
    await removerDaFila();
    return { order_id: orderId, noop: "ja_sincronizado" };
  }

  // 5) AlterarOS status-only
  const r = await alterarEtapaOS(os.omie_codigo_os as number, etapaAtual);
  if (r.success) {
    await supabaseAdmin.from("omie_ordens_servico").update({
      last_etapa_sincronizada: etapaAtual,
      last_status_sincronizado: ord.status,
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
      status: "atualizado",
      updated_at: new Date().toISOString(),
    }).eq("order_id", orderId);
    await removerDaFila();
    return { order_id: orderId, ok: etapaAtual };
  }
  return await bumpRetryOsSync(supabaseAdmin, orderId, tentativas, r.error || "erro_omie");
}

/** Backoff exponencial (teto 30min). 6 tentativas → desiste e marca erro persistente. */
async function bumpRetryOsSync(
  supabaseAdmin: SupabaseClient,
  orderId: string,
  tentativas: number,
  erro: string
): Promise<Record<string, unknown>> {
  const novasTent = (tentativas ?? 0) + 1;
  if (novasTent >= 6) {
    await supabaseAdmin.from("afiacao_os_sync_fila").delete().eq("order_id", orderId);
    await supabaseAdmin.from("omie_ordens_servico").update({
      last_sync_error: erro, status: "erro_atualizacao", updated_at: new Date().toISOString(),
    }).eq("order_id", orderId);
    return { order_id: orderId, erro_persistente: erro };
  }
  const backoffMin = Math.min(Math.pow(2, novasTent), 30);
  await supabaseAdmin.from("afiacao_os_sync_fila").update({
    tentativas: novasTent,
    next_retry_em: new Date(Date.now() + backoffMin * 60000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("order_id", orderId);
  await supabaseAdmin.from("omie_ordens_servico")
    .update({ last_sync_error: erro }).eq("order_id", orderId);
  return { order_id: orderId, retry: novasTent, em_min: backoffMin };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Cliente com service role para operações internas
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action, orderId, orderData, profileData, addressData, staffContext } = body;

    // userId preenchido apenas quando o caller é staff (JWT). Em chamadas
    // via cron/service_role, userId fica null (mesmo comportamento das
    // antigas "publicActions").
    const userId: string | null = auth.via === "staff" ? (auth.userId ?? null) : null;


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

        let clienteResult: ClienteOmieResult;

        // If staff is creating an order for a customer, use the customer's Omie code directly
        if (staffContext?.customerOmieCode) {
          console.log(`[Omie] Staff criando pedido para cliente Omie: ${staffContext.customerOmieCode}`);
          
          // Use vendedor passed from frontend if available (already resolved per-account)
          let omieCodigoVendedor: number | undefined = staffContext.customerCodigoVendedor || undefined;

          // P0-B-bis: fallback do vendedor pela VIEW FRESCA account-correta (colacor_sc), não o espelho
          // poluído omie_clientes (poderia devolver vendedor de OUTRA conta). Nota: colacor_sc hoje tem
          // omie_codigo_vendedor 100% NULL (psql-ro) → na prática cai no fallback API abaixo — que é mais
          // correto que herdar um vendedor de conta errada.
          if (!omieCodigoVendedor && staffContext.customerUserId) {
            const { data: mapping } = await supabaseAdmin
              .from("omie_customer_account_map_fresco")
              .select("omie_codigo_vendedor")
              .eq("user_id", staffContext.customerUserId)
              .eq("account", "colacor_sc")
              .maybeSingle();
            omieCodigoVendedor = mapping?.omie_codigo_vendedor || undefined;
          }

          // If still no vendor found, search in Omie
          if (!omieCodigoVendedor) {
            try {
              const searchResult = await callOmieApi(
                "geral/clientes/",
                "ListarClientes",
                {
                  pagina: 1,
                  registros_por_pagina: 1,
                  clientesFiltro: {
                    codigo_cliente_omie: staffContext.customerOmieCode,
                  },
                }
              ) as unknown as OmieListarClientesResponse;
              const clienteOmie = searchResult.clientes_cadastro?.[0];
              omieCodigoVendedor = clienteOmie?.recomendacoes?.codigo_vendedor || clienteOmie?.codigo_vendedor || undefined;
            } catch (e) {
              console.log("[Omie] Não foi possível buscar vendedor do cliente:", e);
            }
          }

          clienteResult = {
            omieCodigoCliente: staffContext.customerOmieCode,
            omieCodigoVendedor,
          };
        } else {
          // 1. Sincronizar cliente (busca existente no Omie) - fluxo normal do cliente
          clienteResult = await syncClienteOmie(
            supabaseAdmin,
            userId!,
            profileData,
            addressData
          );
        }

        // Determine the effective user_id for the orders table
        const orderUserId = staffContext?.customerUserId || userId;

        // 2. Criar Ordem de Serviço (com vendedor se existir)
        const osResult = await criarOrdemServicoOmie(
          supabaseAdmin,
          orderId,
          clienteResult.omieCodigoCliente,
          clienteResult.omieCodigoVendedor,
          orderData
        );

        // 3. Create the order record in the orders table
        const { error: orderInsertError } = await supabaseAdmin
          .from("orders")
          .insert({
            id: orderId,
            user_id: orderUserId,
            items: orderData.items,
            service_type: orderData.service_type || 'padrao',
            subtotal: orderData.subtotal || 0,
            delivery_fee: orderData.delivery_fee || 0,
            total: orderData.total || 0,
            delivery_option: 'retirada',
            notes: orderData.notes || null,
            status: 'pedido_recebido',
          });

        if (orderInsertError) {
          console.error("[Omie Sync] Erro ao inserir pedido na tabela orders:", orderInsertError);
        }

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

      case "buscar_cliente_por_documento": {
        const { document } = body;
        if (!document) {
          return new Response(
            JSON.stringify({ error: "Documento é obrigatório" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const documentClean = document.replace(/\D/g, "");
        try {
          const searchResult = await callOmieApi(
            "geral/clientes/",
            "ListarClientes",
            {
              pagina: 1,
              registros_por_pagina: 1,
              clientesFiltro: { cnpj_cpf: documentClean },
            }
          ) as unknown as OmieListarClientesResponse;
          const cliente = searchResult.clientes_cadastro?.[0];
          if (cliente) {
            result = {
              success: true,
              codigo_cliente: cliente.codigo_cliente_omie,
              codigo_vendedor: cliente.recomendacoes?.codigo_vendedor || cliente.codigo_vendedor || null,
            };
          } else {
            result = { success: true, codigo_cliente: null };
          }
        } catch (e) {
          console.log("[Omie] Erro ao buscar cliente por documento:", e);
          result = { success: true, codigo_cliente: null };
        }
        break;
      }

      case "criar_cliente_afiacao": {
        // Auto-create a client in the afiação Omie account using data from another account
        const { document: docCriar, razao_social, nome_fantasia, endereco, endereco_numero, bairro, cidade, estado, cep, telefone, contato } = body;
        if (!docCriar || !razao_social) {
          return new Response(
            JSON.stringify({ error: "Documento e razão social são obrigatórios" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const docClean = docCriar.replace(/\D/g, "");
        try {
          // First check if already exists
          const searchRes = await callOmieApi(
            "geral/clientes/",
            "ListarClientes",
            { pagina: 1, registros_por_pagina: 1, clientesFiltro: { cnpj_cpf: docClean } }
          ) as unknown as OmieListarClientesResponse;
          const existing = searchRes.clientes_cadastro?.[0];
          if (existing) {
            result = {
              success: true,
              codigo_cliente: existing.codigo_cliente_omie,
              codigo_vendedor: existing.recomendacoes?.codigo_vendedor || existing.codigo_vendedor || null,
              created: false,
            };
          } else {
            // Create the client
            const clienteParams: Record<string, unknown> = {
              codigo_cliente_integracao: `APP_${docClean}_${Date.now()}`,
              razao_social,
              nome_fantasia: nome_fantasia || razao_social,
              cnpj_cpf: docClean,
              pessoa_fisica: docClean.length <= 11 ? "S" : "N",
            };
            if (endereco) clienteParams.endereco = endereco;
            if (endereco_numero) clienteParams.endereco_numero = endereco_numero;
            if (bairro) clienteParams.bairro = bairro;
            if (cidade) clienteParams.cidade = cidade;
            if (estado) clienteParams.estado = estado;
            if (cep) clienteParams.cep = cep.replace(/\D/g, "");
            if (telefone) clienteParams.telefone1_numero = telefone;
            if (contato) clienteParams.contato = contato;

            console.log(`[Omie] Criando cliente na conta afiação: ${razao_social} (${docClean})`);
            const createResult = await callOmieApi(
              "geral/clientes/",
              "IncluirCliente",
              clienteParams
            ) as unknown as OmieIncluirClienteResponse;
            result = {
              success: true,
              codigo_cliente: createResult.codigo_cliente_omie || createResult.nCodCli,
              codigo_vendedor: null,
              created: true,
            };
          }
        } catch (e) {
          console.error("[Omie] Erro ao criar cliente na afiação:", e);
          result = { success: false, error: e instanceof Error ? e.message : "Erro ao criar cliente" };
        }
        break;
      }

      case "check_client": {
        // P0-B-bis: view fresca account-correta (colacor_sc), não o espelho poluído. Ausência → honesto
        // (exists:false); sem fallback API — não há consumidor money-path (o pedido resolve via
        // syncClienteOmie, que já tem fallback API fail-closed). exists sse há código na conta do fluxo.
        const { data: mapping } = await supabaseAdmin
          .from("omie_customer_account_map_fresco")
          .select("omie_codigo_cliente")
          .eq("user_id", userId)
          .eq("account", "colacor_sc")
          .maybeSingle();

        result = {
          exists: !!mapping?.omie_codigo_cliente,
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
          ) as unknown as OmieListarServicosResponse;

          const servicos = omieResult.cadastros || [];
          console.log(`[Omie] ${servicos.length} serviços encontrados`);

          // Formatar para o app
          const servicosFormatados = servicos.map((s) => ({
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
          ) as unknown as OmieListarContasCorrentesResponse;

          const contas = omieResult.ListarContasCorrentes || omieResult.conta_corrente_lista || [];
          console.log(`[Omie] ${contas.length} contas correntes encontradas`);
          console.log("[Omie] Resposta completa:", JSON.stringify(omieResult, null, 2));

          // Formatar para o app
          const contasFormatadas = contas.map((c) => ({
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
          ) as unknown as OmieListarClientesResponse;

          const clientes = omieResult.clientes_cadastro || [];
          console.log(`[Omie] ${clientes.length} clientes encontrados`);

          // Formatar para o app
          const clientesFormatados = clientes.map((c) => ({
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

        if (!roleData || (roleData.role !== "master" && roleData.role !== "employee")) {
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

      case "sync_os_status": {
        // Cron-only: drena a fila afiacao_os_sync_fila e sincroniza a etapa de cada OS.
        if (auth.via !== "cron" && auth.via !== "service_role") {
          return new Response(
            JSON.stringify({ error: "Apenas cron pode sincronizar etapas de OS" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data: fila } = await supabaseAdmin
          .from("afiacao_os_sync_fila")
          .select("order_id, tentativas")
          .lte("next_retry_em", new Date().toISOString())
          .order("criado_em", { ascending: true })
          .limit(25);

        const detalhes: Record<string, unknown>[] = [];
        for (const item of fila ?? []) {
          detalhes.push(
            await processarItemFilaOsSync(
              supabaseAdmin,
              item.order_id as string,
              (item.tentativas as number) ?? 0
            )
          );
        }

        result = { processados: detalhes.length, detalhes };
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
          ) as unknown as OmieListarServicosResponse;

          const servicosOmie = omieResult.cadastros || [];
          console.log(`[Omie] ${servicosOmie.length} serviços encontrados no Omie`);

          // 2. Buscar serviços existentes no banco
          const { data: servicosLocaisRaw } = await supabaseAdmin
            .from("omie_servicos")
            .select("id, omie_codigo_servico, descricao, inativo");

          const servicosLocais = (servicosLocaisRaw || []) as unknown as ServicoLocalRow[];

          const servicosLocaisMap = new Map<number, ServicoLocalRow>(
            servicosLocais.map((s) => [s.omie_codigo_servico, s])
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

      case "delete_order": {
        // Excluir OS no Omie e hard delete no banco
        const { orderId: deleteOrderId } = body;
        
        if (!deleteOrderId) {
          return new Response(
            JSON.stringify({ error: "orderId obrigatório" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Verificar se usuário é staff
        const { data: deleteRoleData } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .maybeSingle();

        if (!deleteRoleData || (deleteRoleData.role !== "master" && deleteRoleData.role !== "employee")) {
          return new Response(
            JSON.stringify({ error: "Apenas funcionários podem excluir pedidos" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Buscar OS vinculada
        const { data: osDelete } = await supabaseAdmin
          .from("omie_ordens_servico")
          .select("omie_codigo_os, omie_numero_os")
          .eq("order_id", deleteOrderId)
          .maybeSingle();

        // Tentar excluir no Omie se existir OS
        if (osDelete?.omie_codigo_os) {
          try {
            console.log(`[Omie] Excluindo OS ${osDelete.omie_numero_os} (código: ${osDelete.omie_codigo_os})`);
            await callOmieApi("servicos/os/", "ExcluirOS", {
              nCodOS: osDelete.omie_codigo_os,
            });
            console.log(`[Omie] OS ${osDelete.omie_numero_os} excluída com sucesso`);
          } catch (excluirError) {
            console.error(`[Omie] Erro ao excluir OS:`, excluirError);
            // Continue with local delete even if Omie fails
          }
        }

        // Hard delete: omie_ordens_servico, order_messages, order_reviews, loyalty_points, sending_quality_logs, then orders
        await supabaseAdmin.from("omie_ordens_servico").delete().eq("order_id", deleteOrderId);
        await supabaseAdmin.from("order_messages").delete().eq("order_id", deleteOrderId);
        await supabaseAdmin.from("order_reviews").delete().eq("order_id", deleteOrderId);
        await supabaseAdmin.from("loyalty_points").delete().eq("order_id", deleteOrderId);
        await supabaseAdmin.from("sending_quality_logs").delete().eq("order_id", deleteOrderId);
        const { error: deleteError } = await supabaseAdmin.from("orders").delete().eq("id", deleteOrderId);

        if (deleteError) {
          console.error("[Omie] Erro ao excluir pedido local:", deleteError);
          result = { success: false, error: deleteError.message };
        } else {
          console.log(`[Omie] Pedido ${deleteOrderId} excluído com sucesso`);
          result = { success: true };
        }
        break;
      }

      case "check_os_exists": {
        // Verificar se uma OS ainda existe no Omie
        const { orderId: checkOrderId } = body;
        
        if (!checkOrderId) {
          return new Response(
            JSON.stringify({ error: "orderId obrigatório" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data: osCheck } = await supabaseAdmin
          .from("omie_ordens_servico")
          .select("omie_codigo_os")
          .eq("order_id", checkOrderId)
          .maybeSingle();

        if (!osCheck?.omie_codigo_os) {
          result = { exists: true }; // No OS linked, assume exists locally
          break;
        }

        try {
          const consultaResult = await callOmieApi("servicos/os/", "ConsultarOS", {
            nCodOS: osCheck.omie_codigo_os,
          }) as unknown as OmieConsultarOSResponse;

          result = { exists: !consultaResult.faultstring };
        } catch {
          // If error contains "não encontrada" or similar, OS was deleted
          result = { exists: false };
        }
        break;
      }

      case "sync_deleted_orders": {
        // Cron job: check all orders with linked OS and verify they still exist in Omie
        console.log("[Omie] Verificando OS excluídas no Omie...");
        
        const { data: allOs } = await supabaseAdmin
          .from("omie_ordens_servico")
          .select("order_id, omie_codigo_os, omie_numero_os")
          .not("omie_codigo_os", "is", null);

        let deletedCount = 0;
        
        // Helper: deleta a OS de todas as 6 tabelas em paralelo (independentes)
        // Antes: 6 awaits sequenciais — O(6 round-trips) por OS. Agora: Promise.all =
        // 1 round-trip (6 paralelos), reduz tempo total ~6×.
        const deleteOrphanOs = async (orderId: string) => {
          await Promise.all([
            supabaseAdmin.from("omie_ordens_servico").delete().eq("order_id", orderId),
            supabaseAdmin.from("order_messages").delete().eq("order_id", orderId),
            supabaseAdmin.from("order_reviews").delete().eq("order_id", orderId),
            supabaseAdmin.from("loyalty_points").delete().eq("order_id", orderId),
            supabaseAdmin.from("sending_quality_logs").delete().eq("order_id", orderId),
            supabaseAdmin.from("orders").delete().eq("id", orderId),
          ]);
        };

        // Outer loop também paraleliza (chunks de 5) pra não floodar API Omie.
        // ConsultarOS chama API externa; manter concorrência conservadora.
        const CHUNK = 5;
        for (let i = 0; i < (allOs || []).length; i += CHUNK) {
          const chunk = (allOs || []).slice(i, i + CHUNK);
          await Promise.all(chunk.map(async (os) => {
            try {
              const consultaResult = await callOmieApi("servicos/os/", "ConsultarOS", {
                nCodOS: os.omie_codigo_os,
              }) as unknown as OmieConsultarOSResponse;

              if (consultaResult.faultstring) {
                console.log(`[Omie] OS ${os.omie_numero_os} não existe mais no Omie, excluindo localmente...`);
                await deleteOrphanOs(os.order_id);
                deletedCount++;
              }
            } catch {
              console.log(`[Omie] OS ${os.omie_numero_os} possivelmente excluída, removendo...`);
              await deleteOrphanOs(os.order_id);
              deletedCount++;
            }
          }));
        }

        console.log(`[Omie] Sincronização de exclusões concluída: ${deletedCount} pedidos removidos`);
        result = { success: true, deleted: deletedCount };
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

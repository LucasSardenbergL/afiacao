import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const RECEITA_API_URL = "https://receitaws.com.br/v1/cnpj";

const CNAES_INDUSTRIAIS = [
  "10", "13", "14", "15", "16", "25", "31", "47", "56", "96.02", "96.01",
];

interface OmieCliente {
  codigo_cliente?: number;
  codigo_cliente_omie?: number;
  codigo_cliente_integracao?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone1_numero?: string;
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pessoa_fisica?: string;
  inscricao_estadual?: string;
  tags?: Array<{ tag: string }>;
  codigo_vendedor?: number;
  recomendacoes?: {
    codigo_vendedor?: number;
    codigo_transportadora?: number;
    gerar_boletos?: string;
    tipo_assinante?: string;
  };
}

interface CNPJData {
  cnpj?: string;
  nome?: string;
  fantasia?: string;
  email?: string;
  telefone?: string;
  atividade_principal?: Array<{ code: string; text: string }>;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  status?: string;
  message?: string;
}

interface OmieListResponse {
  pagina?: number;
  total_de_paginas?: number;
  registros?: number;
  total_de_registros?: number;
  clientes_cadastro?: OmieCliente[];
  clientes_cadastro_resumido?: OmieCliente[];
  faultstring?: string;
  faultcode?: string;
}

async function callOmieApiWithCredentials(
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
  appKey: string,
  appSecret: string
): Promise<OmieListResponse> {
  const body = {
    call,
    app_key: appKey,
    app_secret: appSecret,
    param: [params],
  };

  const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return await response.json();
}

async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>
): Promise<OmieListResponse> {
  const OMIE_APP_KEY = Deno.env.get("OMIE_APP_KEY");
  const OMIE_APP_SECRET = Deno.env.get("OMIE_APP_SECRET");

  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) {
    throw new Error("Credenciais do Omie não configuradas");
  }

  return callOmieApiWithCredentials(endpoint, call, params, OMIE_APP_KEY, OMIE_APP_SECRET);
}

interface OmieAccountConfig {
  name: string;
  appKey: string;
  appSecret: string;
}

function getOmieAccounts(): OmieAccountConfig[] {
  const accounts: OmieAccountConfig[] = [];
  
  const colacorKey = Deno.env.get("OMIE_APP_KEY");
  const colacorSecret = Deno.env.get("OMIE_APP_SECRET");
  if (colacorKey && colacorSecret) {
    accounts.push({ name: "Colacor (Afiação)", appKey: colacorKey, appSecret: colacorSecret });
  }

  const obenKey = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_VENDAS_APP_SECRET");
  if (obenKey && obenSecret) {
    accounts.push({ name: "Oben (Vendas)", appKey: obenKey, appSecret: obenSecret });
  }

  const colacorVendasKey = Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY");
  const colacorVendasSecret = Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET");
  if (colacorVendasKey && colacorVendasSecret) {
    accounts.push({ name: "Colacor (Vendas)", appKey: colacorVendasKey, appSecret: colacorVendasSecret });
  }

  return accounts;
}

async function validarVendedorMultiOmie(cnpjCpf: string): Promise<{
  consistente: boolean;
  vendedores: Array<{ conta: string; codigo_vendedor: number | null; encontrado: boolean }>;
  divergencias: string[];
}> {
  const docLimpo = cnpjCpf.replace(/\D/g, "");
  const accounts = getOmieAccounts();
  
  const resultados = await Promise.all(
    accounts.map(async (account) => {
      try {
        const result = await callOmieApiWithCredentials(
          "geral/clientes/",
          "ListarClientes",
          { pagina: 1, registros_por_pagina: 1, clientesFiltro: { cnpj_cpf: docLimpo } },
          account.appKey,
          account.appSecret
        );

        if (result.faultstring) {
          return { conta: account.name, codigo_vendedor: null as number | null, encontrado: false };
        }

        const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido || [];
        if (clientes.length === 0) {
          return { conta: account.name, codigo_vendedor: null as number | null, encontrado: false };
        }

        const cliente = clientes[0];
        const codigoCliente = cliente.codigo_cliente_omie || cliente.codigo_cliente;
        
        // Get full details to retrieve vendedor from recomendacoes
        let vendedor: number | null = cliente.recomendacoes?.codigo_vendedor || cliente.codigo_vendedor || null;
        
        if (codigoCliente && !vendedor) {
          try {
            const detalhe = await callOmieApiWithCredentials(
              "geral/clientes/",
              "ConsultarCliente",
              { codigo_cliente_omie: codigoCliente },
              account.appKey,
              account.appSecret
            ) as unknown as OmieCliente;
            vendedor = detalhe?.recomendacoes?.codigo_vendedor || detalhe?.codigo_vendedor || null;
          } catch (e) {
            console.error(`[validarVendedor] Erro ao consultar detalhe em ${account.name}:`, e);
          }
        }

        return { conta: account.name, codigo_vendedor: vendedor, encontrado: true };
      } catch (error) {
        console.error(`[validarVendedor] Erro em ${account.name}:`, error);
        return { conta: account.name, codigo_vendedor: null as number | null, encontrado: false };
      }
    })
  );

  // Check consistency: only compare accounts where the customer was found
  const encontrados = resultados.filter(r => r.encontrado);
  const vendedoresUnicos = [...new Set(encontrados.map(r => r.codigo_vendedor))];
  const consistente = vendedoresUnicos.length <= 1;

  const divergencias: string[] = [];
  if (!consistente) {
    for (const r of encontrados) {
      divergencias.push(`${r.conta}: vendedor ${r.codigo_vendedor || 'não definido'}`);
    }
  }

  return { consistente, vendedores: resultados, divergencias };
}

function isIndustrialByCNAE(cnae: string): boolean {
  if (!cnae) return false;
  const cnaeCode = cnae.replace(/\D/g, '');
  return CNAES_INDUSTRIAIS.some(prefix => cnaeCode.startsWith(prefix.replace('.', '')));
}

async function consultarCNPJ(cnpj: string): Promise<CNPJData | null> {
  const cnpjLimpo = cnpj.replace(/\D/g, '');
  if (cnpjLimpo.length !== 14) return null;

  try {
    const response = await fetch(`${RECEITA_API_URL}/${cnpjLimpo}`, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await response.json();
    if (data.status === 'ERROR') return null;
    return data;
  } catch (error) {
    console.error('[ReceitaWS] Erro:', error);
    return null;
  }
}

function isEmployeeByTags(tags: Array<{ tag: string }> | undefined): boolean {
  if (!tags || !Array.isArray(tags)) return false;
  return tags.some(t => 
    t.tag?.toLowerCase().includes('funcionário') || 
    t.tag?.toLowerCase().includes('funcionario')
  );
}

async function buscarClientePorDocumento(documento: string): Promise<{ cliente: OmieCliente | null; cnpjData: CNPJData | null; isIndustrial: boolean; isEmployee: boolean }> {
  const docLimpo = documento.replace(/\D/g, "");
  
  if (docLimpo.length !== 11 && docLimpo.length !== 14) {
    throw new Error("Documento inválido. Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)");
  }

  let cnpjData: CNPJData | null = null;
  let isIndustrial = false;

  if (docLimpo.length === 14) {
    cnpjData = await consultarCNPJ(docLimpo);
    if (cnpjData?.atividade_principal?.[0]?.code) {
      isIndustrial = isIndustrialByCNAE(cnpjData.atividade_principal[0].code);
    }
  }

  try {
    const result = await callOmieApi("geral/clientes/", "ListarClientes", {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: docLimpo },
    });

    if (result.faultstring) {
      if (result.faultstring.includes("Nenhum registro") || result.faultstring.includes("não encontrado")) {
        return { cliente: null, cnpjData, isIndustrial, isEmployee: false };
      }
      throw new Error(`Erro Omie: ${result.faultstring}`);
    }

    const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido;
    if (!clientes || clientes.length === 0) {
      return { cliente: null, cnpjData, isIndustrial, isEmployee: false };
    }

    const clienteResumo = clientes[0];
    let clienteCompleto = clienteResumo;
    
    if (clienteResumo.codigo_cliente) {
      const detalheResult = await callOmieApi("geral/clientes/", "ConsultarCliente", {
        codigo_cliente: clienteResumo.codigo_cliente,
      }) as unknown as OmieCliente;
      clienteCompleto = detalheResult;
    }

    const isEmployee = isEmployeeByTags(clienteCompleto.tags);
    return { cliente: clienteCompleto, cnpjData, isIndustrial, isEmployee };
  } catch (error) {
    if (error instanceof Error && 
        (error.message.includes("Nenhum registro") || 
         error.message.includes("não encontrado") ||
         error.message.includes("não localizado"))) {
      return { cliente: null, cnpjData, isIndustrial, isEmployee: false };
    }
    throw error;
  }
}

async function pesquisarClientes(query: string, pagina: number = 1): Promise<{ clientes: OmieCliente[]; total: number }> {
  try {
    // Use ListarClientes (full) instead of ListarClientesResumido to get codigo_vendedor
    const result = await callOmieApi("geral/clientes/", "ListarClientes", {
      pagina,
      registros_por_pagina: 50,
      clientesFiltro: { nome_fantasia: query },
    });

    if (result.faultstring) {
      if (result.faultstring.includes("Nenhum registro") || result.faultstring.includes("não encontrado")) {
        return { clientes: [], total: 0 };
      }
      throw new Error(`Erro Omie: ${result.faultstring}`);
    }

    const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido || [];
    return { 
      clientes, 
      total: result.total_de_registros || clientes.length 
    };
  } catch (error) {
    if (error instanceof Error && 
        (error.message.includes("Nenhum registro") || 
         error.message.includes("não encontrado"))) {
      return { clientes: [], total: 0 };
    }
    throw error;
  }
}

async function consultarClienteCompleto(codigoCliente: number): Promise<OmieCliente | null> {
  try {
    const result = await callOmieApi("geral/clientes/", "ConsultarCliente", {
      codigo_cliente_omie: codigoCliente,
    }) as unknown as OmieCliente;
    return result;
  } catch (error) {
    console.error('[Omie] Erro ao consultar cliente:', error);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, documento, query, codigo_cliente } = body;

    // Input validation
    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ error: "Ação inválida" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // buscar_por_documento is allowed without auth (used during signup)
    // All other actions require authentication
    if (action !== "buscar_por_documento") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({ error: "Não autorizado" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Token inválido" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let result: Record<string, unknown> = {};

    switch (action) {
      case "buscar_por_documento": {
        if (!documento || typeof documento !== "string" || documento.length > 20) {
          return new Response(
            JSON.stringify({ error: "Documento inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { cliente, cnpjData, isIndustrial, isEmployee } = await buscarClientePorDocumento(documento);

        if (cliente) {
          result = {
            found: true,
            isIndustrial,
            isEmployee,
            cnae: cnpjData?.atividade_principal?.[0]?.code || null,
            cnaeDescricao: cnpjData?.atividade_principal?.[0]?.text || null,
            cliente: {
              codigo_cliente: cliente.codigo_cliente,
              razao_social: cliente.razao_social,
              nome_fantasia: cliente.nome_fantasia,
              cnpj_cpf: cliente.cnpj_cpf,
              email: cliente.email,
              telefone: cliente.telefone1_numero,
              endereco: cliente.endereco,
              endereco_numero: cliente.endereco_numero,
              complemento: cliente.complemento,
              bairro: cliente.bairro,
              cidade: cliente.cidade,
              estado: cliente.estado,
              cep: cliente.cep,
              pessoa_fisica: cliente.pessoa_fisica,
              inscricao_estadual: cliente.inscricao_estadual,
            },
          };
        } else if (cnpjData) {
          result = {
            found: false,
            isIndustrial,
            isEmployee: false,
            cnae: cnpjData.atividade_principal?.[0]?.code || null,
            cnaeDescricao: cnpjData.atividade_principal?.[0]?.text || null,
            cliente: {
              razao_social: cnpjData.nome,
              nome_fantasia: cnpjData.fantasia,
              email: cnpjData.email,
              telefone: cnpjData.telefone,
              endereco: cnpjData.logradouro,
              endereco_numero: cnpjData.numero,
              complemento: cnpjData.complemento,
              bairro: cnpjData.bairro,
              cidade: cnpjData.municipio,
              estado: cnpjData.uf,
              cep: cnpjData.cep,
            },
          };
        } else {
          result = {
            found: false,
            isIndustrial: false,
            isEmployee: false,
            cnae: null,
            cliente: null,
          };
        }
        break;
      }

      case "pesquisar_clientes": {
        if (!query || typeof query !== "string" || query.length < 3) {
          return new Response(
            JSON.stringify({ error: "Informe pelo menos 3 caracteres para pesquisar" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const searchResult = await pesquisarClientes(query);
        result = {
          clientes: searchResult.clientes.map(c => ({
            codigo_cliente: c.codigo_cliente_omie || c.codigo_cliente,
            razao_social: c.razao_social,
            nome_fantasia: c.nome_fantasia,
            cnpj_cpf: c.cnpj_cpf,
            email: c.email,
            telefone: c.telefone1_numero,
            cidade: c.cidade,
            estado: c.estado,
            codigo_vendedor: c.recomendacoes?.codigo_vendedor || c.codigo_vendedor || null,
          })),
          total: searchResult.total,
        };
        break;
      }

      case "consultar_cliente": {
        if (!codigo_cliente || typeof codigo_cliente !== "number") {
          return new Response(
            JSON.stringify({ error: "Código do cliente inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const clienteCompleto = await consultarClienteCompleto(codigo_cliente);
        if (clienteCompleto) {
          result = {
            found: true,
            cliente: {
              codigo_cliente: clienteCompleto.codigo_cliente,
              razao_social: clienteCompleto.razao_social,
              nome_fantasia: clienteCompleto.nome_fantasia,
              cnpj_cpf: clienteCompleto.cnpj_cpf,
              email: clienteCompleto.email,
              telefone: clienteCompleto.telefone1_numero,
              endereco: clienteCompleto.endereco,
              endereco_numero: clienteCompleto.endereco_numero,
              complemento: clienteCompleto.complemento,
              bairro: clienteCompleto.bairro,
              cidade: clienteCompleto.cidade,
              estado: clienteCompleto.estado,
              cep: clienteCompleto.cep,
              pessoa_fisica: clienteCompleto.pessoa_fisica,
              inscricao_estadual: clienteCompleto.inscricao_estadual,
              codigo_vendedor: clienteCompleto.recomendacoes?.codigo_vendedor || clienteCompleto.codigo_vendedor,
            },
          };
        } else {
          result = { found: false, cliente: null };
        }
        break;
      }

      case "criar_perfil_local": {
        const { cliente } = body;
        if (!cliente || !cliente.codigo_cliente) {
          return new Response(
            JSON.stringify({ error: "Dados do cliente inválidos" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);

        // Check if mapping already exists by omie_codigo_cliente
        const { data: existingMapping } = await adminClient
          .from("omie_clientes")
          .select("user_id")
          .eq("omie_codigo_cliente", cliente.codigo_cliente)
          .maybeSingle();

        if (existingMapping) {
          result = { user_id: existingMapping.user_id };
          break;
        }

        // Check if a profile with the same document (CPF/CNPJ) already exists
        if (cliente.cnpj_cpf) {
          const docLimpo = cliente.cnpj_cpf.replace(/\D/g, "");
          if (docLimpo.length >= 11) {
            const { data: existingProfiles } = await adminClient
              .from("profiles")
              .select("user_id, document")
              .not("document", "is", null);

            const matchedProfile = existingProfiles?.find(p => 
              p.document?.replace(/\D/g, "") === docLimpo
            );

            if (matchedProfile) {
              // Profile exists — just create the omie_clientes mapping
              console.log(`[criar_perfil_local] Found existing profile by document ${docLimpo}, linking to user ${matchedProfile.user_id}`);
              const { error: mappingError } = await adminClient
                .from("omie_clientes")
                .insert({
                  user_id: matchedProfile.user_id,
                  omie_codigo_cliente: cliente.codigo_cliente,
                  omie_codigo_vendedor: cliente.codigo_vendedor || null,
                });
              if (mappingError) {
                console.error("[criar_perfil_local] Mapping error:", mappingError);
              }
              result = { user_id: matchedProfile.user_id };
              break;
            }
          }
        }

        // Create a real auth user via admin API (with a placeholder email)
        const placeholderEmail = `omie_${cliente.codigo_cliente}@placeholder.local`;
        const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
          email: placeholderEmail,
          email_confirm: true,
          user_metadata: {
            omie_codigo_cliente: cliente.codigo_cliente,
            is_placeholder: true,
          },
        });

        if (authError) {
          console.error("[criar_perfil_local] Auth error:", authError);
          throw new Error("Erro ao criar usuário placeholder");
        }

        const newUserId = authData.user.id;

        // Create profile (trigger auto_assign_user_role will assign 'customer')
        const { error: profileError } = await adminClient
          .from("profiles")
          .insert({
            user_id: newUserId,
            name: cliente.nome_fantasia || cliente.razao_social || "Cliente",
            email: cliente.email || null,
            phone: cliente.telefone || null,
            document: cliente.cnpj_cpf || null,
          });

        if (profileError) {
          console.error("[criar_perfil_local] Profile error:", profileError);
          // Don't throw - user was created, profile might have partial issues
        }

        // Create omie_clientes mapping (including vendedor if available)
        const { error: mappingError } = await adminClient
          .from("omie_clientes")
          .insert({
            user_id: newUserId,
            omie_codigo_cliente: cliente.codigo_cliente,
            omie_codigo_vendedor: cliente.codigo_vendedor || null,  // Already extracted by frontend from recomendacoes
          });

        if (mappingError) {
          console.error("[criar_perfil_local] Mapping error:", mappingError);
        }

        result = { user_id: newUserId };
        break;
      }

      case "validar_vendedor": {
        const { cnpj_cpf } = body;
        if (!cnpj_cpf || typeof cnpj_cpf !== "string") {
          return new Response(
            JSON.stringify({ error: "CPF/CNPJ inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const validacao = await validarVendedorMultiOmie(cnpj_cpf);
        result = validacao;
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
    console.error("[Omie Cliente] Erro:", error);
    return new Response(
      JSON.stringify({ error: "Erro ao processar solicitação" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
